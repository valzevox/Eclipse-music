const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { handleAudioProxy } = require('../src/server/server');

function createWavBuffer(durationSec = 0.5, sampleRate = 8000) {
    const numSamples = Math.floor(durationSec * sampleRate);
    const dataSize = numSamples * 2;
    const buf = Buffer.alloc(44 + dataSize);
    buf.write('RIFF', 0);
    buf.writeUInt32LE(36 + dataSize, 4);
    buf.write('WAVE', 8);
    buf.write('fmt ', 12);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(sampleRate, 24);
    buf.writeUInt32LE(sampleRate * 2, 28);
    buf.writeUInt16LE(2, 32);
    buf.writeUInt16LE(16, 34);
    buf.write('data', 36);
    buf.writeUInt32LE(dataSize, 40);
    for (let i = 0; i < numSamples; i++) {
        const sample = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 8000);
        buf.writeInt16LE(sample, 44 + i * 2);
    }
    return buf;
}

test('Electron HTMLAudioElement: real decodable WAV playback through handleAudioProxy emits playing', async (t) => {
    let electronPath = null;
    try {
        electronPath = require('electron');
    } catch (_) {
        electronPath = null;
    }
    if (!electronPath || typeof electronPath !== 'string' || !fs.existsSync(electronPath)) {
        t.skip('Electron binary not available in this environment');
        return;
    }
    if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
        t.skip('Headless Linux CI without display server');
        return;
    }

    const wav = createWavBuffer(0.6, 8000);
    const upstream = http.createServer((req, res) => {
        const range = req.headers.range;
        if (range) {
            const m = /bytes=(\d+)-(\d*)/.exec(range);
            const start = m ? Number(m[1]) : 0;
            const end = m && m[2] ? Math.min(Number(m[2]), wav.length - 1) : wav.length - 1;
            const slice = wav.subarray(start, end + 1);
            res.writeHead(206, {
                'Content-Type': 'audio/wav',
                'Content-Range': `bytes ${start}-${end}/${wav.length}`,
                'Content-Length': String(slice.length),
                'Accept-Ranges': 'bytes',
            });
            res.end(slice);
            return;
        }
        res.writeHead(200, {
            'Content-Type': 'audio/wav',
            'Content-Length': String(wav.length),
            'Accept-Ranges': 'bytes',
        });
        res.end(wav);
    });

    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamPort = upstream.address().port;

    const proxyServer = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://127.0.0.1');
        if (u.pathname === '/player.html') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`<!doctype html><html><body><audio id="a" preload="auto"></audio><script>
                const a = document.getElementById('a');
                const t0 = performance.now();
                a.muted = true;
                a.addEventListener('playing', () => {
                    console.log('ECLIPSE_AUDIO_PLAYING:' + Math.round(performance.now() - t0));
                }, { once: true });
                a.addEventListener('error', () => {
                    console.log('ECLIPSE_AUDIO_ERROR:' + (a.error ? a.error.code : 'unknown'));
                }, { once: true });
                a.src = '/api/audio-proxy?url=' + encodeURIComponent('http://media.example.com:${upstreamPort}/test.wav');
                a.play().catch((err) => {
                    console.log('ECLIPSE_AUDIO_PLAY_REJECT:' + (err && err.message ? err.message : String(err)));
                });
            </script></body></html>`);
            return;
        }
        if (u.pathname === '/api/audio-proxy') {
            handleAudioProxy(req, res, u.searchParams.get('url'), 5, null, {
                lookup: async () => [{ address: '93.184.216.34', family: 4 }],
                httpClient: {
                    request(urlOrOpts, optsOrCb, maybeCb) {
                        const hasUrl = typeof urlOrOpts === 'string' || urlOrOpts instanceof URL;
                        const opts = hasUrl ? (optsOrCb || {}) : (urlOrOpts || {});
                        const cb = hasUrl ? maybeCb : optsOrCb;
                        const parsedTarget = hasUrl ? new URL(String(urlOrOpts)) : null;
                        return http.request({
                            hostname: '127.0.0.1',
                            port: upstreamPort,
                            path: parsedTarget ? (parsedTarget.pathname + parsedTarget.search) : opts.path,
                            method: opts.method || 'GET',
                            headers: opts.headers,
                        }, cb);
                    },
                },
            });
            return;
        }
        res.writeHead(404);
        res.end();
    });

    await new Promise((resolve) => proxyServer.listen(0, '127.0.0.1', resolve));
    const proxyPort = proxyServer.address().port;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eclipse-audio-test-'));
    const mainScript = path.join(tmpDir, 'main.js');
    fs.writeFileSync(mainScript, `
const { app, BrowserWindow } = require('electron');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('mute-audio');
app.whenReady().then(() => {
    const win = new BrowserWindow({
        show: false,
        webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    win.webContents.on('console-message', (_e, _level, message) => {
        if (message.startsWith('ECLIPSE_AUDIO_')) {
            process.stdout.write(message + '\\n');
            app.exit(message.startsWith('ECLIPSE_AUDIO_PLAYING:') ? 0 : 1);
        }
    });
    win.loadURL('http://127.0.0.1:${proxyPort}/player.html');
    setTimeout(() => {
        process.stdout.write('ECLIPSE_AUDIO_TIMEOUT\\n');
        app.exit(2);
    }, 10000);
});
`);

    try {
        const result = await new Promise((resolve, reject) => {
            const child = spawn(electronPath, [mainScript], {
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
            });
            let stdout = '';
            let stderr = '';
            child.stdout.on('data', (d) => { stdout += d.toString(); });
            child.stderr.on('data', (d) => { stderr += d.toString(); });
            child.on('error', reject);
            child.on('close', (code) => resolve({ code, stdout, stderr }));
        });

        const match = /ECLIPSE_AUDIO_PLAYING:(\d+)/.exec(result.stdout);
        assert.equal(result.code, 0, `Electron audio test failed (code=${result.code}): stdout=${result.stdout} stderr=${result.stderr}`);
        assert.ok(match, `Expected ECLIPSE_AUDIO_PLAYING marker, got: ${result.stdout}`);
        const firstPlayingMs = Number(match[1]);
        assert.ok(Number.isFinite(firstPlayingMs) && firstPlayingMs >= 0);
        console.log(JSON.stringify({ electronRealAudioPlayback: { firstPlayingMs } }));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        await new Promise((resolve) => proxyServer.close(resolve));
        await new Promise((resolve) => upstream.close(resolve));
    }
});
