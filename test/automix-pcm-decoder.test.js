// test/automix-pcm-decoder.test.js
// Real HTTP + WAV (22.05kHz & 44.1kHz) + MP3/M4A (faststart & moov-at-end) FFmpeg + Server Route integration tests.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const dns = require('node:dns');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { extractBoundedPcm, parseContentRange, decodeWithFfmpeg, DEFAULT_MAX_INPUT_BYTES, DEFAULT_MAX_AGGREGATE_INPUT_BYTES } = require('../src/server/pcm-extractor.js');
const { validateMediaTargetUrl } = require('../src/server/ssrf-guard.js');
const { TrackAnalyzer } = require('../src/renderer/automix/track-analyzer.js');
const { AnalysisCoordinator } = require('../src/renderer/automix/analysis-coordinator.js');
const { resolveTrackSourceUrl, computeQueueContextId } = require('../src/renderer/automix/source-resolver.js');
const { syncAutoMixSettings, resolveInitialAutoMixMode, registerAutoMixEventListeners } = require('../src/renderer/automix/settings-controller.js');
const { startServer, stopServer, getServerToken, handleAudioProxy } = require('../src/server/server.js');

function buildWavFixtureBuffer(bpm = 120, durationSec = 6, sampleRate = 22050) {
  const numSamples = Math.floor(durationSec * sampleRate);
  const dataBytes = numSamples * 2;
  const buf = Buffer.alloc(44 + dataBytes);

  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);

  const beatInterval = Math.round((60 / bpm) * sampleRate);
  const pulseLen = Math.floor(0.03 * sampleRate);
  const chordFreqs = [261.63, 329.63, 392.0, 523.25]; // C Major (8B)

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    let chord = 0;
    for (const f of chordFreqs) chord += Math.sin(2 * Math.PI * f * t);
    chord = (chord / chordFreqs.length) * 0.25;

    const beatOffset = i % beatInterval;
    let kick = 0;
    if (beatOffset < pulseLen) {
      const env = Math.exp(-beatOffset / (pulseLen * 0.25));
      kick = Math.sin(2 * Math.PI * 80 * (beatOffset / sampleRate)) * env * 0.7;
    }

    const val = Math.max(-1, Math.min(1, kick + chord));
    buf.writeInt16LE(Math.round(val * 32767), 44 + i * 2);
  }
  return buf;
}

function serveBufferWithRange(req, res, buf, contentType) {
  const total = buf.length;
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    const start = m ? Number(m[1]) : 0;
    const end = m && m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
    const slice = buf.subarray(start, end + 1);
    res.writeHead(206, {
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Content-Length': String(slice.length)
    });
    return res.end(slice);
  }
  res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': String(total) });
  return res.end(buf);
}

describe('P1/P2 — Routing, Queue Fingerprint, WAV (22k/44.1k), FFmpeg MP3/M4A & Server Routes', () => {
  let server;
  let baseUrl;
  let tmpDir;
  let wav22k;
  let wav44k;
  let mp3Buf = null;
  let m4aFastBuf = null;
  let m4aMoovEndBuf = null;
  let m4aLargeMoovEndBuf = null;
  let largeM4aBytesServed = 0;
  let hasFfmpeg = false;

  before(async () => {
    wav22k = buildWavFixtureBuffer(120, 6, 22050);
    wav44k = buildWavFixtureBuffer(120, 6, 44100);

    // Generate real MP3, faststart M4A, moov-at-end M4A, and >512KB moov-at-end M4A fixtures via ffmpeg
    const probe = spawnSync('ffmpeg', ['-version'], { windowsHide: true });
    hasFfmpeg = probe.status === 0;
    if (hasFfmpeg) {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eclipse-pcm-test-'));
      const wavPath = path.join(tmpDir, 'src.wav');
      const wavLongPath = path.join(tmpDir, 'src-long.wav');
      const mp3Path = path.join(tmpDir, 'fixture.mp3');
      const m4aFastPath = path.join(tmpDir, 'fixture-fast.m4a');
      const m4aEndPath = path.join(tmpDir, 'fixture-moov-end.m4a');
      const m4aLargeEndPath = path.join(tmpDir, 'fixture-large-moov-end.m4a');
      fs.writeFileSync(wavPath, wav44k);
      fs.writeFileSync(wavLongPath, buildWavFixtureBuffer(120, 38, 44100));

      spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', wavPath, '-c:a', 'libmp3lame', '-b:a', '128k', mp3Path], { windowsHide: true });
      spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', wavPath, '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', m4aFastPath], { windowsHide: true });
      spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', wavPath, '-c:a', 'aac', '-b:a', '128k', m4aEndPath], { windowsHide: true });
      spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', wavLongPath, '-c:a', 'aac', '-b:a', '128k', m4aLargeEndPath], { windowsHide: true });

      if (fs.existsSync(mp3Path)) mp3Buf = fs.readFileSync(mp3Path);
      if (fs.existsSync(m4aFastPath)) m4aFastBuf = fs.readFileSync(m4aFastPath);
      if (fs.existsSync(m4aEndPath)) m4aMoovEndBuf = fs.readFileSync(m4aEndPath);
      if (fs.existsSync(m4aLargeEndPath)) m4aLargeMoovEndBuf = fs.readFileSync(m4aLargeEndPath);
    }

    server = http.createServer((req, res) => {
      if (req.url === '/fixture-22k.wav') return serveBufferWithRange(req, res, wav22k, 'audio/wav');
      if (req.url === '/fixture-44k.wav') return serveBufferWithRange(req, res, wav44k, 'audio/wav');
      if (req.url === '/fixture.mp3' && mp3Buf) return serveBufferWithRange(req, res, mp3Buf, 'audio/mpeg');
      if (req.url === '/fixture-fast.m4a' && m4aFastBuf) return serveBufferWithRange(req, res, m4aFastBuf, 'audio/mp4');
      if (req.url === '/fixture-moov-end.m4a' && m4aMoovEndBuf) return serveBufferWithRange(req, res, m4aMoovEndBuf, 'audio/mp4');
      if (req.url === '/fixture-large-moov-end.m4a' && m4aLargeMoovEndBuf) {
        const origEnd = res.end.bind(res);
        res.end = (chunk, ...rest) => {
          if (chunk) largeM4aBytesServed += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
          return origEnd(chunk, ...rest);
        };
        return serveBufferWithRange(req, res, m4aLargeMoovEndBuf, 'audio/mp4');
      }

      if (req.url === '/missing') { res.writeHead(404); return res.end('Not Found'); }
      if (req.url === '/live.m3u8' || req.url === '/hls-header') {
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
        return res.end('#EXTM3U\n#EXT-X-VERSION:3\n');
      }
      if (req.url === '/truncated-small') {
        res.writeHead(206, { 'Content-Type': 'audio/wav', 'Content-Range': 'bytes 0-127/128', 'Content-Length': '128' });
        return res.end(Buffer.alloc(128));
      }
      if (req.url === '/truncated-mid') {
        // Declares 8000 bytes but aborts connection after 2048 bytes (> 1 KB)
        res.writeHead(206, { 'Content-Type': 'audio/wav', 'Content-Range': 'bytes 0-7999/16000', 'Content-Length': '8000' });
        res.write(Buffer.alloc(2048));
        res.destroy();
        return;
      }
      if (req.url === '/bad-range-missing') {
        res.writeHead(206, { 'Content-Type': 'audio/wav', 'Content-Length': '4096' });
        return res.end(Buffer.alloc(4096));
      }
      if (req.url === '/bad-range-offset') {
        res.writeHead(206, { 'Content-Type': 'audio/wav', 'Content-Range': 'bytes 100-4195/10000', 'Content-Length': '4096' });
        return res.end(Buffer.alloc(4096));
      }
      if (req.url === '/bad-range-length') {
        res.writeHead(206, { 'Content-Type': 'audio/wav', 'Content-Range': 'bytes 0-4095/10000', 'Content-Length': '2048' });
        return res.end(Buffer.alloc(2048));
      }
      if (req.url === '/oversized-200') {
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': String(50 * 1024 * 1024) });
        return res.end();
      }
      if (req.url === '/no-cl-200') {
        // 200 OK without Content-Length streaming wav22k -> must still respect hard byte cap
        res.writeHead(200, { 'Content-Type': 'audio/wav' });
        return res.end(wav22k);
      }
      if (req.url === '/slow') {
        res.writeHead(206, {
          'Content-Type': 'audio/wav',
          'Content-Range': `bytes 0-${wav22k.length - 1}/${wav22k.length}`,
          'Content-Length': String(wav22k.length)
        });
        res.write(wav22k.subarray(0, 2048));
        return;
      }

      res.writeHead(404);
      res.end();
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('P1 Routing & stream-info metadata: /api/library, downloaded ?name=, cache /api/local-track, and pseudo-ID metadata', async () => {
    const apiBase = 'http://127.0.0.1:3000';
    const token = 'tok123';

    // Exact /api/library object shape: id + platform: 'local', NO libraryFileId
    const libTrack = { id: 'lib-abc', platform: 'local', title: 'Local Song' };
    const libUrl = await resolveTrackSourceUrl(libTrack, { apiBase, token });
    assert.equal(libUrl, `${apiBase}/api/library-file?id=lib-abc&token=tok123`);

    // Downloaded track shape -> MUST use ?name= with safe basename, NOT ?id=
    const dlTrack = { id: 'dl-99', isDownloaded: true, filename: 'C:\\Music\\My Track.mp3' };
    const dlUrl = await resolveTrackSourceUrl(dlTrack, { apiBase, token });
    assert.equal(dlUrl, `${apiBase}/api/downloaded-track?name=My%20Track.mp3&token=tok123`);

    // Offline cache shape (/api/offline-library) -> /api/local-track?id=<cleanId>
    const cacheTrack = { id: 'yt-1', cleanId: 'yt_1_clean', platform: 'youtube' };
    const cacheUrl = await resolveTrackSourceUrl(cacheTrack, { apiBase, token });
    assert.equal(cacheUrl, `${apiBase}/api/local-track?id=yt_1_clean&token=tok123`);

    // PreloadManager URL takes top priority
    const preloaded = { id: 'yt-2', _preloadedStreamUrl: `${apiBase}/api/audio-proxy?url=abc` };
    assert.equal(await resolveTrackSourceUrl(preloaded, { apiBase, token }), preloaded._preloadedStreamUrl);

    // Non-YouTube / pseudo-ID track passes full metadata (url, title, artist, duration, q) to /api/stream-info
    let capturedInfoUrl = '';
    const pseudoTrack = {
      id: 'sc_pseudo_1',
      platform: 'soundcloud',
      title: 'Midnight',
      artist: 'Nova',
      url: 'https://soundcloud.com/nova/midnight',
      duration: 210
    };
    const resolvedPseudo = await resolveTrackSourceUrl(pseudoTrack, {
      apiBase,
      token,
      fetchImpl: async (u) => {
        capturedInfoUrl = u;
        return { ok: true, json: async () => ({ proxyUrl: `${apiBase}/api/audio-proxy?url=resolved` }) };
      }
    });
    assert.equal(resolvedPseudo, `${apiBase}/api/audio-proxy?url=resolved`);
    const parsedInfo = new URL(capturedInfoUrl);
    assert.equal(parsedInfo.pathname, '/api/stream-info');
    assert.equal(parsedInfo.searchParams.get('id'), 'sc_pseudo_1');
    assert.equal(parsedInfo.searchParams.get('title'), 'Midnight');
    assert.equal(parsedInfo.searchParams.get('artist'), 'Nova');
    assert.equal(parsedInfo.searchParams.get('url'), 'https://soundcloud.com/nova/midnight');
    assert.equal(parsedInfo.searchParams.get('duration'), '210');
    assert.equal(parsedInfo.searchParams.get('q'), 'Nova - Midnight');
  });

  it('P2 Queue Invalidation: detects replacement in 6-track lookahead window even in queues > 32 tracks', () => {
    const q1 = Array.from({ length: 40 }, (_, i) => ({ id: `t-${i}` }));
    const q2 = q1.map((t, i) => (i === 33 ? { id: 't-replaced' } : t));
    assert.notEqual(computeQueueContextId(q1, 30), computeQueueContextId(q2, 30));
  });

  it('WAV Fixtures (22.05kHz & 44.1kHz): extracts bounded PCM via HTTP 206 and detects 120 BPM + C Major (8B)', async () => {
    const analyzer = new TrackAnalyzer();

    const r22 = await extractBoundedPcm(`${baseUrl}/fixture-22k.wav`, { maxInputBytes: 300000 });
    assert.equal(r22.statusCode, 206);
    assert.equal(r22.rangeSupported, true);
    assert.equal(r22.sampleRate, 22050);
    assert.equal(r22.decoder, 'wav');
    const rec22 = analyzer.analyzeTrack({ id: 'w22' }, r22.samples, r22.sampleRate);
    assert.ok(Math.abs(rec22.tempo.bpm - 120) <= 3);
    assert.equal(rec22.key.camelot, '8B');

    const r44 = await extractBoundedPcm(`${baseUrl}/fixture-44k.wav`, { maxInputBytes: 524288 });
    assert.equal(r44.sampleRate, 44100);
    assert.equal(r44.decoder, 'wav');
    const rec44 = analyzer.analyzeTrack({ id: 'w44' }, r44.samples, r44.sampleRate);
    assert.ok(Math.abs(rec44.tempo.bpm - 120) <= 3);
    assert.equal(rec44.key.camelot, '8B');
  });

  it('Real FFmpeg MP3 & M4A (faststart + moov-at-end) with strict aggregate byte budget enforcement', async () => {
    assert.ok(hasFfmpeg && mp3Buf && m4aFastBuf && m4aMoovEndBuf, 'FFmpeg must be installed and fixtures generated (no silent skip)');
    const analyzer = new TrackAnalyzer();

    // 1. Direct decodeWithFfmpeg() on MP3
    const directMp3 = await decodeWithFfmpeg(mp3Buf, { targetSampleRate: 22050, maxDurationSec: 6 });
    assert.equal(directMp3.sampleRate, 22050);
    assert.ok(directMp3.samples instanceof Float32Array && directMp3.samples.length > 22050 * 4);

    // 2. Full HTTP Range extractBoundedPcm on MP3
    const httpMp3 = await extractBoundedPcm(`${baseUrl}/fixture.mp3`, { maxInputBytes: 524288 });
    assert.equal(httpMp3.decoder, 'ffmpeg');
    assert.equal(httpMp3.sampleRate, 22050);
    const recMp3 = analyzer.analyzeTrack({ id: 'mp3-1' }, httpMp3.samples, httpMp3.sampleRate);
    assert.ok(Math.abs(recMp3.tempo.bpm - 120) <= 3, `MP3 BPM mismatch: ${recMp3.tempo.bpm}`);
    assert.equal(recMp3.key.camelot, '8B');

    // 3. Faststart M4A + TrackAnalyzer BPM/Key verification
    const httpM4aFast = await extractBoundedPcm(`${baseUrl}/fixture-fast.m4a`, {
      maxInputBytes: DEFAULT_MAX_INPUT_BYTES,
      maxAggregateInputBytes: DEFAULT_MAX_AGGREGATE_INPUT_BYTES
    });
    assert.equal(httpM4aFast.sampleRate, 22050);
    assert.ok(httpM4aFast.samples.length > 22050 * 4);
    const recM4aFast = analyzer.analyzeTrack({ id: 'm4a-fast' }, httpM4aFast.samples, httpM4aFast.sampleRate);
    assert.ok(Math.abs(recM4aFast.tempo.bpm - 120) <= 3, `Faststart M4A BPM mismatch: ${recM4aFast.tempo.bpm}`);
    assert.equal(recM4aFast.key.camelot, '8B');
    assert.ok(recM4aFast.tempo.confidence >= 0.4, `Faststart M4A low tempo confidence: ${recM4aFast.tempo.confidence}`);

    // 4. Production-equivalent moov-at-EOF M4A (> 512 KB) with EXACT /api/analyze-pcm production options
    assert.ok(m4aLargeMoovEndBuf && m4aLargeMoovEndBuf.length > DEFAULT_MAX_INPUT_BYTES, 'Large moov-at-EOF M4A fixture must exceed 512 KB');
    largeM4aBytesServed = 0;
    const httpM4aLarge = await extractBoundedPcm(`${baseUrl}/fixture-large-moov-end.m4a`, {
      maxInputBytes: DEFAULT_MAX_INPUT_BYTES,
      maxAggregateInputBytes: DEFAULT_MAX_AGGREGATE_INPUT_BYTES
    });
    assert.equal(httpM4aLarge.decoder, 'ffmpeg-seek');
    assert.equal(httpM4aLarge.sampleRate, 22050);
    assert.ok(httpM4aLarge.samples.length > 22050 * 4);
    assert.ok(httpM4aLarge.bytesRead > DEFAULT_MAX_INPUT_BYTES, 'Aggregate bytesRead must include seek requests beyond 512 KB initial probe');
    assert.ok(httpM4aLarge.bytesRead <= DEFAULT_MAX_AGGREGATE_INPUT_BYTES, `Aggregate bytesRead ${httpM4aLarge.bytesRead} exceeded production budget`);
    assert.ok(largeM4aBytesServed > DEFAULT_MAX_INPUT_BYTES, 'Independent fixture server byte counter must confirm seek requests');
    assert.ok(largeM4aBytesServed <= DEFAULT_MAX_AGGREGATE_INPUT_BYTES + 65536, `Independent server bytes served (${largeM4aBytesServed}) exceeded bounded budget`);

    const recM4aLarge = analyzer.analyzeTrack({ id: 'm4a-moov-end' }, httpM4aLarge.samples, httpM4aLarge.sampleRate);
    assert.ok(Math.abs(recM4aLarge.tempo.bpm - 120) <= 3, `moov-at-EOF M4A BPM mismatch: ${recM4aLarge.tempo.bpm}`);
    assert.equal(recM4aLarge.key.camelot, '8B');
    assert.ok(recM4aLarge.tempo.confidence >= 0.4, `moov-at-EOF M4A low tempo confidence: ${recM4aLarge.tempo.confidence}`);

    // 5. Production-equivalent moov-at-EOF M4A with deliberately too-small aggregate budget MUST fail cleanly
    await assert.rejects(
      extractBoundedPcm(`${baseUrl}/fixture-large-moov-end.m4a`, {
        maxInputBytes: DEFAULT_MAX_INPUT_BYTES,
        maxAggregateInputBytes: 540000
      }),
      /Aggregate input byte budget exceeded/
    );
  });

  it('P2 Content-Range validation & edge cases: rejects invalid/missing/offset/length/truncated/HLS/404 and caps 200 OK', async () => {
    assert.equal(parseContentRange('bytes 0-1023/2048').expectedLength, 1024);
    assert.equal(parseContentRange('invalid'), null);
    assert.equal(parseContentRange('bytes 500-100/2048'), null);

    await assert.rejects(extractBoundedPcm(`${baseUrl}/missing`), /HTTP 404/);
    await assert.rejects(extractBoundedPcm(`${baseUrl}/live.m3u8`), /HLS/);
    await assert.rejects(extractBoundedPcm(`${baseUrl}/hls-header`), /HLS/);
    await assert.rejects(extractBoundedPcm(`${baseUrl}/truncated-small`), /Truncated/);
    await assert.rejects(extractBoundedPcm(`${baseUrl}/truncated-mid`), /Truncated|aborted|hang up|ECONNRESET/i);
    await assert.rejects(extractBoundedPcm(`${baseUrl}/bad-range-missing`), /Invalid or missing Content-Range/);
    await assert.rejects(extractBoundedPcm(`${baseUrl}/bad-range-offset`), /start offset/);
    await assert.rejects(extractBoundedPcm(`${baseUrl}/bad-range-length`), /Inconsistent Content-Length/);
    await assert.rejects(extractBoundedPcm(`${baseUrl}/oversized-200`, { maxInputBytes: 65536 }), /exceeds safe bound/);

    // 200 OK without Content-Length is still hard-capped at maxInputBytes
    const capped = await extractBoundedPcm(`${baseUrl}/no-cl-200`, { maxInputBytes: 65536 });
    assert.equal(capped.bytesRead, 65536);
    assert.equal(capped.rangeSupported, false);
  });

  it('AbortController cancels in-flight fetch cleanly', async () => {
    const ac = new AbortController();
    const p = extractBoundedPcm(`${baseUrl}/slow`, { signal: ac.signal, timeoutMs: 5000 });
    setTimeout(() => ac.abort(), 30);
    await assert.rejects(p, /Aborted/);
  });

  it('Actual server routes /api/analyze-pcm & /api/audio-proxy: enforces auth, shared SSRF guard (nested proxy/IPv6/DNS) & positive local media analysis', async () => {
    // 0. Unit checks on shared validateMediaTargetUrl (IPv6 ULA, link-local, IPv4-mapped IPv6, DNS-to-private)
    assert.equal((await validateMediaTargetUrl('http://[fc00::1]/a.mp3', { allowSelfMedia: false })).ok, false);
    assert.equal((await validateMediaTargetUrl('http://[fe80::1]/a.mp3', { allowSelfMedia: false })).ok, false);
    assert.equal((await validateMediaTargetUrl('http://[::ffff:127.0.0.1]/a.mp3', { allowSelfMedia: false })).ok, false);
    assert.equal((await validateMediaTargetUrl('http://100.64.0.1/a.mp3', { allowSelfMedia: false })).ok, false);
    const dnsPrivate = await validateMediaTargetUrl('http://internal.example.test/a.mp3', {
      allowSelfMedia: false,
      lookup: async () => [{ address: '10.1.2.3', family: 4 }]
    });
    assert.equal(dnsPrivate.ok, false);
    assert.match(dnsPrivate.reason, /DNS resolved to private\/reserved IP: 10\.1\.2\.3/);

    const port = await startServer(0);
    const { resolveDownloadDir } = require('../src/shared/platform.js');
    const dlDir = resolveDownloadDir() || path.join(os.homedir(), 'Downloads');
    const tmpName = `__eclipse_test_pcm_${Date.now()}.wav`;
    const tmpPath = path.join(dlDir, tmpName);
    let createdTmp = false;
    try {
      const apiBase = `http://127.0.0.1:${port}`;
      const token = getServerToken();

      // 1. Unauthenticated /api/analyze-pcm must be rejected (401/403)
      const unauth = await fetch(`${apiBase}/api/analyze-pcm?url=${encodeURIComponent(`${baseUrl}/fixture-22k.wav`)}`);
      assert.ok(unauth.status === 401 || unauth.status === 403, `Expected 401/403, got ${unauth.status}`);

      // 2. Arbitrary loopback, link-local & nested /api/audio-proxy -> private IP MUST be rejected with 403
      const ssrfLoopback = await fetch(`${apiBase}/api/analyze-pcm?url=${encodeURIComponent(`${baseUrl}/fixture-22k.wav`)}&token=${encodeURIComponent(token)}`);
      assert.equal(ssrfLoopback.status, 403);

      const ssrfMetadata = await fetch(`${apiBase}/api/analyze-pcm?url=${encodeURIComponent('http://169.254.169.254/latest/meta-data/')}&token=${encodeURIComponent(token)}`);
      assert.equal(ssrfMetadata.status, 403);

      const nestedProxyPrivate = `${apiBase}/api/audio-proxy?url=${encodeURIComponent('http://10.0.0.1/secret.mp3')}&token=${encodeURIComponent(token)}`;
      const ssrfNested = await fetch(`${apiBase}/api/analyze-pcm?url=${encodeURIComponent(nestedProxyPrivate)}&token=${encodeURIComponent(token)}`);
      assert.equal(ssrfNested.status, 403);

      // 3. /api/audio-proxy enforces SSRF protection (403 on loopback & RFC1918 & IPv6 ULA)
      const proxyResp = await fetch(`${apiBase}/api/audio-proxy?url=${encodeURIComponent(`${baseUrl}/fixture-22k.wav`)}&token=${encodeURIComponent(token)}`, {
        headers: { Range: 'bytes=0-4095' }
      });
      assert.equal(proxyResp.status, 403);

      const proxyIpv6 = await fetch(`${apiBase}/api/audio-proxy?url=${encodeURIComponent('http://[fc00::1]/secret.mp3')}&token=${encodeURIComponent(token)}`);
      assert.equal(proxyIpv6.status, 403);

      // 4. Positive end-to-end check: approved local Eclipse media route (/api/downloaded-track) -> /api/analyze-pcm
      fs.mkdirSync(dlDir, { recursive: true });
      fs.writeFileSync(tmpPath, wav22k);
      createdTmp = true;

      const dlUrl = `${apiBase}/api/downloaded-track?name=${encodeURIComponent(tmpName)}&token=${encodeURIComponent(token)}`;
      const rangeResp = await fetch(dlUrl, { headers: { Range: 'bytes=0-1023' } });
      assert.equal(rangeResp.status, 206);

      const pcmResp = await fetch(`${apiBase}/api/analyze-pcm?url=${encodeURIComponent(dlUrl)}&token=${encodeURIComponent(token)}`);
      assert.equal(pcmResp.status, 200);
      assert.equal(Number(pcmResp.headers.get('x-pcm-sample-rate')), 22050);
      assert.equal(pcmResp.headers.get('x-pcm-decoder'), 'wav');
      const pcmBuf = await pcmResp.arrayBuffer();
      assert.ok(pcmBuf.byteLength > 22050 * 4 * 4, 'Positive /api/analyze-pcm must return real Float32Array PCM payload');

      // 5. P1 DNS Socket Pinning Integration: handleAudioProxy connects directly to pinnedAddress and preserves Host header
      const stream = require('node:stream');
      let upstreamReceivedHost = null;
      let upstreamReceivedPath = null;
      let upstreamRequestCount = 0;
      let secondHopSocketCount = 0;
      const mockAudioServer = http.createServer((req, res) => {
        upstreamRequestCount++;
        upstreamReceivedHost = req.headers.host;
        upstreamReceivedPath = req.url;
        if (req.url === '/redirect-private') {
          res.writeHead(302, {
            'Location': 'http://evil.internal.test/secret.mp3'
          });
          return res.end();
        }
        res.writeHead(200, {
          'Content-Type': 'audio/mpeg',
          'Content-Length': '12',
          'Accept-Ranges': 'bytes'
        });
        res.end('audio-sample');
      });
      await new Promise(r => mockAudioServer.listen(0, '127.0.0.1', r));
      const mockPort = mockAudioServer.address().port;

      try {
        let lookupCallCount = 0;
        const requestedLookupHostnames = [];
        const customPinLookup = async (hostname) => {
          lookupCallCount++;
          requestedLookupHostnames.push(hostname);
          if (hostname === 'cdn.eclipsestream.org') {
            return [{ address: '93.184.216.34', family: 4 }];
          }
          if (hostname === 'evil.internal.test') {
            return [{ address: '10.0.0.1', family: 4 }];
          }
          return dns.promises.lookup(hostname, { all: true });
        };

        // Custom httpClient adapter tracking requests and asserting requestOptions.lookup pins address
        // Routes local mock socket while preserving requestOptions.headers and verifying pinned lookup
        let clientRequestCount = 0;
        const clientRequestedUrls = [];
        const customHttpClient = {
          request: (targetUrl, requestOpts, callback) => {
            clientRequestCount++;
            clientRequestedUrls.push(targetUrl);
            const parsedTarget = new URL(targetUrl);
            if (parsedTarget.hostname === 'evil.internal.test') {
              secondHopSocketCount++;
            }
            assert.ok(requestOpts.lookup, 'requestOptions.lookup must be defined for pinned target');
            let providedLookupIp = null;
            requestOpts.lookup(parsedTarget.hostname, {}, (err, addr) => {
              providedLookupIp = addr;
            });
            assert.equal(providedLookupIp, '93.184.216.34', 'requestOptions.lookup must resolve to verified pinned IP');

            return http.request({
              ...requestOpts,
              host: '127.0.0.1',
              port: mockPort,
              path: parsedTarget.pathname + parsedTarget.search
            }, callback);
          }
        };

        const createClientReq = () => {
          const r = new stream.PassThrough();
          r.method = 'GET';
          r.headers = { range: 'bytes=0-10' };
          r.end();
          return r;
        };

        // Test A: Direct hop to cdn.eclipsestream.org with DNS Pinning
        let directStatusCode = null;
        let directData = '';
        const mockDirectRes = new stream.PassThrough();
        mockDirectRes.writeHead = (code) => { directStatusCode = code; };
        mockDirectRes.on('data', (chunk) => { directData += chunk.toString(); });

        const directDonePromise = new Promise((resolve) => {
          mockDirectRes.on('finish', resolve);
          mockDirectRes.on('end', resolve);
          mockDirectRes.on('close', resolve);
        });

        await handleAudioProxy(
          createClientReq(),
          mockDirectRes,
          `http://cdn.eclipsestream.org:${mockPort}/stream.mp3`,
          3,
          null,
          { lookup: customPinLookup, httpClient: customHttpClient }
        );

        await directDonePromise;

        assert.equal(directStatusCode, 200);
        assert.equal(directData, 'audio-sample');
        assert.equal(upstreamReceivedHost, `cdn.eclipsestream.org:${mockPort}`, 'Host header must retain original hostname during pinned connection');
        assert.equal(upstreamReceivedPath, '/stream.mp3');
        assert.equal(clientRequestCount, 1, 'Only one upstream request should be executed');

        // Test B: Upstream redirects to evil.internal.test -> SSRF guard re-checks hop 2 and blocks with 403
        let redirectStatusCode = null;
        let redirectData = '';
        const mockRedirectRes = new stream.PassThrough();
        mockRedirectRes.writeHead = (code) => { redirectStatusCode = code; };
        mockRedirectRes.on('data', (chunk) => { redirectData += chunk.toString(); });

        const redirectDonePromise = new Promise((resolve) => {
          mockRedirectRes.on('finish', resolve);
          mockRedirectRes.on('end', resolve);
          mockRedirectRes.on('close', resolve);
        });

        await handleAudioProxy(
          createClientReq(),
          mockRedirectRes,
          `http://cdn.eclipsestream.org:${mockPort}/redirect-private`,
          3,
          null,
          { lookup: customPinLookup, httpClient: customHttpClient }
        );

        await redirectDonePromise;

        assert.equal(redirectStatusCode, 403, 'handleAudioProxy must block redirect to private IP with 403 on second hop');
        assert.equal(secondHopSocketCount, 0, 'No socket or HTTP request must ever be opened to private target');
        assert.ok(requestedLookupHostnames.includes('cdn.eclipsestream.org'), 'First hop hostname must be looked up');
        assert.ok(requestedLookupHostnames.includes('evil.internal.test'), 'Second hop redirect hostname must be validated via lookup');

        // Test C: Direct private target block
        let directPrivateStatus = null;
        const mockDirectPrivateRes = new stream.PassThrough();
        mockDirectPrivateRes.writeHead = (code) => { directPrivateStatus = code; };
        const directPrivateDonePromise = new Promise((resolve) => {
          mockDirectPrivateRes.on('finish', resolve);
          mockDirectPrivateRes.on('end', resolve);
          mockDirectPrivateRes.on('close', resolve);
        });

        await handleAudioProxy(
          createClientReq(),
          mockDirectPrivateRes,
          'http://evil.internal.test/secret.mp3',
          3,
          null,
          { lookup: customPinLookup, httpClient: customHttpClient }
        );

        await directPrivateDonePromise;
        assert.equal(directPrivateStatus, 403, 'Direct call to private target must be rejected with 403');
      } finally {
        await new Promise(r => mockAudioServer.close(r));
      }
    } finally {
      if (createdTmp) {
        try { fs.unlinkSync(tmpPath); } catch (_) {}
      }
      await stopServer();
    }
  });

  it('AnalysisCoordinator reports accurate partial counts with real HTTP WAV decoder', async () => {
    const analyzer = new TrackAnalyzer();
    const coordinator = new AnalysisCoordinator({
      analyzer,
      concurrency: 2,
      decodeAudio: async (track, signal) => extractBoundedPcm(track.url, { signal, maxInputBytes: 300000 })
    });

    const mixedStatus = await coordinator.scanCollection([
      { id: 'ok-wav', url: `${baseUrl}/fixture-22k.wav` },
      { id: 'bad-404', url: `${baseUrl}/missing` }
    ], 'mixed-pl');

    assert.equal(mixedStatus.state, 'partial');
    assert.equal(mixedStatus.pcmAnalyzed, 1);
    assert.equal(mixedStatus.failed, 1);
    assert.equal(mixedStatus.metadataOnly, 0);

    // Verify energy envelope was generated on real analyzed PCM
    const rec = analyzer.getCachedRecord({ id: 'ok-wav' });
    assert.ok(rec && rec.energy && rec.energy.rms > 0);
  });

  it('P0/P1 Full Cancellation Semantics: verifies seek, pause, skip, mode_change, queue_replaced, and error', () => {
    const AutoMixDJ = require('../src/renderer/automix/automix-dj.js');
    const dj = new AutoMixDJ();
    dj.configure({ mode: 'dj_mix', keepAlbumContinuous: true });

    const createFadeSetup = () => {
      let deckA = 0.5, deckB = 0.5;
      let primaryReconnected = false;
      let outPaused = false, inPaused = false;
      const engine = {
        mediaSource: { disconnect: () => {}, connect: () => { primaryReconnected = true; } },
        auxMediaSource: { disconnect: () => {}, connect: () => {} },
        deckAGain: {},
        deckBGain: {},
        setDeckGains: ({ deckA: a, deckB: b }) => { deckA = a; deckB = b; }
      };
      const outAudio = { volume: 0.8, playbackRate: 1.0, pause: () => { outPaused = true; } };
      const inAudio = { volume: 0.8, playbackRate: 1.0, currentTime: 5, pause: () => { inPaused = true; } };

      dj.isCrossfading = true;
      dj._currentFade = {
        outgoingAudio: outAudio,
        incomingAudio: inAudio,
        inFilter: { frequency: { setValueAtTime: () => {} }, context: {} },
        outFilter: { frequency: { setValueAtTime: () => {} }, context: {} },
        initialUserVol: 0.8,
        useDeckGains: true,
        audioEngine: engine
      };

      return {
        getGains: () => ({ deckA, deckB }),
        wasPrimaryReconnected: () => primaryReconnected,
        wasOutPaused: () => outPaused,
        wasInPaused: () => inPaused,
        inAudio
      };
    };

    // 1. Seek: Deck A not paused; Deck B paused & reset; Deck A=1, B=0
    const s1 = createFadeSetup();
    assert.equal(dj.abortCrossfade('seek'), true);
    assert.equal(s1.wasOutPaused(), false, 'seek must not pause outgoing deck');
    assert.equal(s1.wasInPaused(), true, 'seek must pause incoming deck');
    assert.equal(s1.inAudio.currentTime, 0, 'incoming currentTime must be reset to 0');
    assert.equal(s1.getGains().deckA, 1.0);
    assert.equal(s1.getGains().deckB, 0.0);
    assert.equal(s1.wasPrimaryReconnected(), true);

    // 2. Mode Change: Deck A not paused; Deck B paused & reset
    const s2 = createFadeSetup();
    assert.equal(dj.abortCrossfade('mode_change'), true);
    assert.equal(s2.wasOutPaused(), false, 'mode_change must not pause outgoing deck');
    assert.equal(s2.wasInPaused(), true);
    assert.equal(s2.getGains().deckA, 1.0);

    // 3. Pause: both decks paused
    const s3 = createFadeSetup();
    assert.equal(dj.abortCrossfade('pause'), true);
    assert.equal(s3.wasOutPaused(), true, 'pause must pause outgoing deck');
    assert.equal(s3.wasInPaused(), true, 'pause must pause incoming deck');

    // 4. Skip: both decks paused
    const s4 = createFadeSetup();
    assert.equal(dj.abortCrossfade('skip'), true);
    assert.equal(s4.wasOutPaused(), true);
    assert.equal(s4.wasInPaused(), true);

    // 5. Queue Replaced: both decks paused
    const s5 = createFadeSetup();
    assert.equal(dj.abortCrossfade('queue_replaced'), true);
    assert.equal(s5.wasOutPaused(), true);
    assert.equal(s5.wasInPaused(), true);

    // 6. Error: Deck B stopped & reset, Deck A not paused, gains A=1 B=0, DSP reconnected
    const s6 = createFadeSetup();
    assert.equal(dj.abortCrossfade('error'), true);
    assert.equal(s6.wasOutPaused(), false, 'error must not pause outgoing deck');
    assert.equal(s6.wasInPaused(), true, 'error must pause incoming deck');
    assert.equal(s6.inAudio.currentTime, 0);
    assert.equal(s6.getGains().deckA, 1.0);
    assert.equal(s6.getGains().deckB, 0.0);
    assert.equal(s6.wasPrimaryReconnected(), true);

    // 7. Idempotence: subsequent call when not crossfading returns false without error
    assert.equal(dj.abortCrossfade('manual'), false);
  });

  it('P1 Full Collection Bounded Scan: scanAll processes entire collection with concurrency limit and respects cancellation', async () => {
    const analyzer = new TrackAnalyzer();
    let activeWorkers = 0;
    let maxObservedWorkers = 0;
    const coordinator = new AnalysisCoordinator({
      analyzer,
      concurrency: 2,
      decodeAudio: async (track, signal) => {
        activeWorkers++;
        if (activeWorkers > maxObservedWorkers) maxObservedWorkers = activeWorkers;
        await new Promise(r => setTimeout(r, 15));
        activeWorkers--;
        return extractBoundedPcm(track.url, { signal, maxInputBytes: 300000 });
      }
    });

    const fullQueue = [
      { id: 'track-0', url: `${baseUrl}/fixture-22k.wav` },
      { id: 'track-1', url: `${baseUrl}/fixture-22k.wav` },
      { id: 'track-2', url: `${baseUrl}/fixture-22k.wav` },
      { id: 'track-3', url: `${baseUrl}/fixture-22k.wav` },
      { id: 'track-4', url: `${baseUrl}/fixture-22k.wav` }
    ];

    const status = await coordinator.scanCollection(fullQueue, 'full-q-1', {
      currentIndex: 2,
      scanAll: true
    });

    assert.equal(status.total, 5, 'scanAll must queue all 5 tracks');
    assert.equal(status.completed, 5, 'All 5 tracks must complete');
    assert.equal(status.pcmAnalyzed, 5);
    assert.ok(maxObservedWorkers <= 2, `Concurrency must not exceed 2 (observed: ${maxObservedWorkers})`);
    assert.equal(status.state, 'ready');

    // Cancellation test: active workers must receive abort signal, stop immediately, and report 'cancelled'
    let slowDecodesStarted = 0;
    let abortEventsReceived = 0;
    let workersWithSignalAborted = 0;
    const slowQueue = [
      { id: 'slow-0', url: `${baseUrl}/slow-pcm` },
      { id: 'slow-1', url: `${baseUrl}/slow-pcm` },
      { id: 'slow-2', url: `${baseUrl}/slow-pcm` },
      { id: 'slow-3', url: `${baseUrl}/slow-pcm` }
    ];

    const cancelCoordinator = new AnalysisCoordinator({
      analyzer: new TrackAnalyzer(),
      concurrency: 2,
      decodeAudio: async (track, signal) => {
        slowDecodesStarted++;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve(null), 1000);
          if (signal) {
            signal.addEventListener('abort', () => {
              abortEventsReceived++;
              if (signal.aborted === true) {
                workersWithSignalAborted++;
              }
              clearTimeout(timer);
              reject(new Error('Aborted'));
            });
          }
        });
      }
    });

    const scanPromise = cancelCoordinator.scanCollection(slowQueue, 'cancel-q', { scanAll: true });
    await new Promise(r => setTimeout(r, 20));
    cancelCoordinator.cancel();
    const cancelStatus = await scanPromise;
    assert.equal(cancelStatus.state, 'cancelled', 'Final state must be cancelled and not overwritten by ready');
    assert.equal(slowDecodesStarted, 2, 'Worker count started must equal concurrency limit (2)');
    assert.equal(abortEventsReceived, 2, 'Active workers must both receive abort event');
    assert.equal(workersWithSignalAborted, 2, 'signal.aborted must be strictly true for all active workers');
    assert.equal(cancelStatus.completed, 0, 'Cancelled workers must not increment completed count');
  });

  it('P0 syncAutoMixSettings: dispatches eclipse:automix-mode-changed once, preserves 5 modes, and suppresses unneeded aborts', () => {
    const AutoMixDJ = require('../src/renderer/automix/automix-dj.js');

    // Setup mock browser environment (localStorage + window event dispatch)
    const store = new Map();
    const mockLocalStorage = {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k)
    };

    const dispatchedEvents = [];
    let abortCalls = [];
    const mockDjInstance = new AutoMixDJ({ enabled: true, mode: 'tempo_synced' });
    mockDjInstance.abortCrossfade = (reason) => {
      abortCalls.push(reason);
      return true;
    };

    const listeners = {};
    const mockWindow = {
      autoMixDjInstance: mockDjInstance,
      dispatchEvent: (evt) => {
        dispatchedEvents.push(evt);
        if (listeners[evt.type]) {
          listeners[evt.type].forEach(fn => fn(evt));
        }
      },
      addEventListener: (type, fn) => {
        if (!listeners[type]) listeners[type] = [];
        listeners[type].push(fn);
      },
      removeEventListener: (type, fn) => {
        if (listeners[type]) {
          listeners[type] = listeners[type].filter(cb => cb !== fn);
        }
      }
    };

    const mockNativeAudio = {
      addEventListener: (type, fn) => {
        if (!listeners[type]) listeners[type] = [];
        listeners[type].push(fn);
      },
      removeEventListener: (type, fn) => {
        if (listeners[type]) {
          listeners[type] = listeners[type].filter(cb => cb !== fn);
        }
      }
    };

    // Production listener registration via shared controller
    registerAutoMixEventListeners({
      nativeAudio: mockNativeAudio,
      win: mockWindow,
      getCoreState: () => ({ isPlaying: false }),
      djInstance: mockDjInstance
    });

    const context = {
      window: mockWindow,
      localStorage: mockLocalStorage,
      djInstance: mockDjInstance
    };

    // 1. Changing mode from tempo_synced -> equal_power dispatches event once and aborts once
    assert.equal(mockDjInstance.mode, 'tempo_synced');
    syncAutoMixSettings({ mode: 'equal_power' }, context);
    assert.equal(mockDjInstance.mode, 'equal_power');
    assert.equal(dispatchedEvents.length, 1);
    assert.equal(dispatchedEvents[0].type, 'eclipse:automix-mode-changed');
    assert.deepEqual(dispatchedEvents[0].detail, { previousMode: 'tempo_synced', newMode: 'equal_power' });
    assert.equal(abortCalls.length, 1);
    assert.equal(abortCalls[0], 'mode_change');
    assert.equal(mockLocalStorage.getItem('eclipse_automix_mode'), 'equal_power');

    // 2. Selecting the SAME mode (equal_power) does not dispatch and does not abort
    syncAutoMixSettings({ mode: 'equal_power' }, context);
    assert.equal(dispatchedEvents.length, 1, 'Same mode must not dispatch duplicate event');
    assert.equal(abortCalls.length, 1, 'Same mode must not abort');

    // 3. Updating non-mode settings does not dispatch or abort
    syncAutoMixSettings({ keepAlbumContinuous: true, djFilter: false, durationSec: 8 }, context);
    assert.equal(dispatchedEvents.length, 1, 'Non-mode setting change must not dispatch mode-changed');
    assert.equal(abortCalls.length, 1, 'Non-mode setting change must not abort');
    assert.equal(mockLocalStorage.getItem('eclipse_automix_skip_album'), '1');
    assert.equal(mockLocalStorage.getItem('eclipse_automix_dj_filter'), '0');
    assert.equal(mockLocalStorage.getItem('eclipse_crossfade'), '8');

    // 4. Verify user-facing modes persist in localStorage and legacy modes normalize cleanly
    const userModes = ['equal_power', 'tempo_synced'];
    for (const m of userModes) {
      syncAutoMixSettings({ mode: m }, context);
      assert.equal(mockDjInstance.mode, m);
      assert.equal(mockLocalStorage.getItem('eclipse_automix_mode'), m);
    }
    syncAutoMixSettings({ mode: 'dj_mix' }, context);
    assert.equal(mockDjInstance.mode, 'tempo_synced');
    syncAutoMixSettings({ mode: 'quick_crossfade' }, context);
    assert.equal(mockDjInstance.mode, 'equal_power');

    // 5. Simulate restart: read back saved mode using production resolveInitialAutoMixMode helper
    for (const m of userModes) {
      mockLocalStorage.setItem('eclipse_automix_mode', m);
      const stored = mockLocalStorage.getItem('eclipse_automix_mode');
      const resolved = resolveInitialAutoMixMode(stored);
      assert.equal(resolved, m, `Mode ${m} must survive restart resolution`);
    }
    assert.equal(resolveInitialAutoMixMode('dj_mix'), 'tempo_synced');
    assert.equal(resolveInitialAutoMixMode('gapless_album'), 'equal_power');
  });
});
