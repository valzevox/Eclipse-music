// test/automix-pcm-decoder.test.js
// Real HTTP + WAV fixture integration tests for bounded server-side PCM extraction.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { extractBoundedPcm } = require('../src/server/pcm-extractor.js');
const { TrackAnalyzer } = require('../src/renderer/automix/track-analyzer.js');
const { AnalysisCoordinator } = require('../src/renderer/automix/analysis-coordinator.js');

/**
 * Build a real 16-bit mono RIFF/WAVE binary buffer containing a 120 BPM kick + C Major chord.
 */
function buildWavFixtureBuffer(bpm = 120, durationSec = 6, sampleRate = 22050) {
  const numSamples = Math.floor(durationSec * sampleRate);
  const dataBytes = numSamples * 2;
  const buf = Buffer.alloc(44 + dataBytes);

  // RIFF/WAVE header
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // PCM chunk size
  buf.writeUInt16LE(1, 20);  // PCM int16
  buf.writeUInt16LE(1, 22);  // Mono
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

describe('P1.3 — Real Audio Fixture & Bounded HTTP Range PCM Decoder', () => {
  let server;
  let baseUrl;
  let wavFixture;

  before(async () => {
    wavFixture = buildWavFixtureBuffer(120, 6, 22050); // ~264 KB real WAV

    server = http.createServer((req, res) => {
      if (req.url === '/fixture.wav') {
        const total = wavFixture.length;
        const range = req.headers.range;
        if (range) {
          const m = /bytes=(\d+)-(\d*)/.exec(range);
          const start = m ? Number(m[1]) : 0;
          const end = m && m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
          const slice = wavFixture.subarray(start, end + 1);
          res.writeHead(206, {
            'Content-Type': 'audio/wav',
            'Accept-Ranges': 'bytes',
            'Content-Range': `bytes ${start}-${end}/${total}`,
            'Content-Length': String(slice.length)
          });
          return res.end(slice);
        }
        res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': String(total) });
        return res.end(wavFixture);
      }

      if (req.url === '/missing') {
        res.writeHead(404);
        return res.end('Not Found');
      }

      if (req.url === '/live.m3u8' || req.url === '/hls-header') {
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
        return res.end('#EXTM3U\n#EXT-X-VERSION:3\n');
      }

      if (req.url === '/truncated') {
        res.writeHead(206, {
          'Content-Type': 'audio/wav',
          'Content-Range': 'bytes 0-127/128',
          'Content-Length': '128'
        });
        return res.end(Buffer.alloc(128));
      }

      if (req.url === '/oversized-200') {
        // Server ignores Range and advertises a 50 MB file
        res.writeHead(200, {
          'Content-Type': 'audio/mpeg',
          'Content-Length': String(50 * 1024 * 1024)
        });
        return res.end();
      }

      if (req.url === '/slow') {
        res.writeHead(206, {
          'Content-Type': 'audio/wav',
          'Content-Range': `bytes 0-${wavFixture.length - 1}/${wavFixture.length}`,
          'Content-Length': String(wavFixture.length)
        });
        res.write(wavFixture.subarray(0, 2048));
        // Hold connection open until aborted
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
  });

  it('extracts mono Float32Array PCM via HTTP Range 206 within byte bound and detects 120 BPM + C Major (8B)', async () => {
    const maxInputBytes = 300000;
    const res = await extractBoundedPcm(`${baseUrl}/fixture.wav`, { maxInputBytes });

    assert.equal(res.statusCode, 206);
    assert.equal(res.rangeSupported, true);
    assert.equal(res.decoder, 'wav');
    assert.equal(res.sampleRate, 22050);
    assert.ok(res.bytesRead <= maxInputBytes, `bytesRead ${res.bytesRead} exceeded cap ${maxInputBytes}`);
    assert.ok(res.samples instanceof Float32Array && res.samples.length > 22050 * 4);

    const analyzer = new TrackAnalyzer();
    const record = analyzer.analyzeTrack({ id: 'wav-1' }, res.samples, res.sampleRate);
    assert.equal(record.source, 'audio-analysis');
    assert.equal(record.status, 'analyzed');
    assert.ok(Math.abs(record.tempo.bpm - 120) <= 3, `Expected ~120 BPM, got ${record.tempo.bpm}`);
    assert.equal(record.key.camelot, '8B');
  });

  it('rejects HTTP 404, HLS (.m3u8 & header), truncated payload, and oversized 200 OK', async () => {
    await assert.rejects(extractBoundedPcm(`${baseUrl}/missing`), /HTTP 404/);
    await assert.rejects(extractBoundedPcm(`${baseUrl}/live.m3u8`), /HLS/);
    await assert.rejects(extractBoundedPcm(`${baseUrl}/hls-header`), /HLS/);
    await assert.rejects(extractBoundedPcm(`${baseUrl}/truncated`), /Truncated/);
    await assert.rejects(extractBoundedPcm(`${baseUrl}/oversized-200`, { maxInputBytes: 65536 }), /exceeds safe bound/);
  });

  it('aborts in-flight fetch cleanly via AbortController', async () => {
    const ac = new AbortController();
    const p = extractBoundedPcm(`${baseUrl}/slow`, { signal: ac.signal, timeoutMs: 5000 });
    setTimeout(() => ac.abort(), 30);
    await assert.rejects(p, /Aborted/);
  });

  it('AnalysisCoordinator reports accurate partial/error/ready counts with real HTTP WAV decoder', async () => {
    const analyzer = new TrackAnalyzer();
    const coordinator = new AnalysisCoordinator({
      analyzer,
      concurrency: 2,
      decodeAudio: async (track, signal) => extractBoundedPcm(track.url, { signal, maxInputBytes: 300000 })
    });

    const mixedStatus = await coordinator.scanCollection([
      { id: 'ok-wav', url: `${baseUrl}/fixture.wav` },
      { id: 'bad-404', url: `${baseUrl}/missing` }
    ], 'mixed-pl');

    assert.equal(mixedStatus.state, 'partial');
    assert.equal(mixedStatus.pcmAnalyzed, 1);
    assert.equal(mixedStatus.failed, 1);
    assert.equal(mixedStatus.metadataOnly, 0);
  });
});
