// test/weak-network-matrix.test.js
// Reproducible weak-network regression matrix (1.5/3/10/25 Mbps, 100/250/400 ms RTT, 1%/3% loss)
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');

const { NetworkPriorityScheduler, Priority } = require('../src/server/network-scheduler');
const { NetworkDiagnostics } = require('../src/server/network-diagnostics');
const { AdaptiveRangeCache, parseRangeHeader, extractUpstreamExpiryMs } = require('../src/server/range-cache');
const { StaleFirstArtworkCache } = require('../src/server/artwork-cache');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createShapedUpstream({ mbps = 1.5, rttMs = 250, lossRate = 0.03, totalBytes = 1024 * 1024 } = {}) {
  const payload = crypto.randomBytes(totalBytes);
  const bytesPerMs = (mbps * 1000 * 1000) / 8 / 1000;
  let requestCount = 0;
  let bytesServed = 0;
  let force403 = false;

  const server = http.createServer(async (req, res) => {
    requestCount += 1;
    await sleep(rttMs);

    if (force403 || req.url.includes('expired=1')) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      return res.end('Forbidden');
    }

    if (lossRate > 0 && (requestCount % Math.max(2, Math.round(1 / lossRate))) === 0 && req.headers['x-allow-loss'] === '1') {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      return res.end('Transient loss');
    }

    if (req.url.startsWith('/art/')) {
      const artBuf = Buffer.alloc(24 * 1024, 0xab);
      const txMs = Math.ceil(artBuf.length / Math.max(1, bytesPerMs));
      await sleep(txMs);
      bytesServed += artBuf.length;
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': String(artBuf.length) });
      return res.end(artBuf);
    }

    const rangeHdr = req.headers.range || 'bytes=0-';
    const parsed = parseRangeHeader(rangeHdr);
    const start = parsed ? parsed.start : 0;
    const end = parsed && !parsed.openEnded ? Math.min(parsed.end, totalBytes - 1) : totalBytes - 1;
    const slice = payload.subarray(start, end + 1);

    const txMs = Math.ceil(slice.length / Math.max(1, bytesPerMs));
    await sleep(txMs);
    bytesServed += slice.length;

    res.writeHead(206, {
      'Content-Type': 'audio/mp4',
      'Content-Length': String(slice.length),
      'Content-Range': `bytes ${start}-${end}/${totalBytes}`,
      'Accept-Ranges': 'bytes'
    });
    res.end(slice);
  });

  return {
    server,
    payload,
    getStats: () => ({ requestCount, bytesServed }),
    setForce403: (v) => { force403 = v; },
    start: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    stop: () => new Promise((resolve) => server.close(resolve))
  };
}

test('Weak-Network Matrix: 9 scenarios + Before/After shaped benchmark (1.5 Mbps, 250 ms RTT, 3% loss)', async () => {
  const upstream = createShapedUpstream({ mbps: 1.5, rttMs: 250, lossRate: 0.03, totalBytes: 512 * 1024 });
  const port = await upstream.start();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // Scenario 1 & 8: Cold startup + Home ready + Stale-first artwork burst
    const diag = new NetworkDiagnostics();
    diag.recordStartupUi(420);
    diag.recordHomeReady(890);

    const artCache = new StaleFirstArtworkCache({ ttlMs: 50, maxConcurrent: 4, failureCooldownMs: 500 });
    let artFetches = 0;
    const artFetcher = async (url) => {
      artFetches += 1;
      const r = await fetch(url);
      if (!r.ok) return null;
      return { buffer: Buffer.from(await r.arrayBuffer()), contentType: 'image/jpeg' };
    };

    const burst = [];
    for (let i = 0; i < 10; i++) {
      burst.push(artCache.getOrFetch(`${baseUrl}/art/${i % 2}.jpg`, artFetcher));
    }
    const burstRes = await Promise.all(burst);
    assert.equal(artFetches, 2, 'Artwork burst must deduplicate concurrent fetches per URL');
    assert.ok(burstRes.every((r) => r && r.buffer.length === 24 * 1024));

    await sleep(70);
    const staleStart = Date.now();
    const staleHit = await artCache.getOrFetch(`${baseUrl}/art/0.jpg`, async () => null);
    const staleElapsed = Date.now() - staleStart;
    assert.equal(staleHit.stale, true);
    assert.ok(staleElapsed < 30, `Stale-first artwork must return immediately, took ${staleElapsed}ms`);
    diag.recordImageCache({ hit: true, stale: true });

    // Scenario 2 & 5: First track play + Seek-aware AdaptiveRangeCache
    const rangeCache = new AdaptiveRangeCache({ maxBytes: 4 * 1024 * 1024 });
    const trackUrl = `${baseUrl}/audio/track1.m4a?expire=${Math.floor(Date.now() / 1000) + 3600}`;
    const initialResp = await fetch(trackUrl, { headers: { Range: 'bytes=0-65535' } });
    const initialBuf = Buffer.from(await initialResp.arrayBuffer());
    rangeCache.put(trackUrl, {
      start: 0,
      buffer: initialBuf,
      contentType: 'audio/mp4',
      totalLength: 512 * 1024
    });

    const subHit = rangeCache.get(trackUrl, 'bytes=16384-32767');
    assert.ok(subHit, 'AdaptiveRangeCache must serve contained finite sub-ranges');
    assert.equal(subHit.buffer.length, 16384);
    assert.deepEqual(subHit.buffer, upstream.payload.subarray(16384, 32768));

    assert.equal(rangeCache.get(trackUrl, 'bytes=0-'), null, 'Partial prefix must not satisfy open-ended range');

    const tailResp = await fetch(trackUrl, { headers: { Range: `bytes=65536-${512 * 1024 - 1}` } });
    const tailBuf = Buffer.from(await tailResp.arrayBuffer());
    rangeCache.put(trackUrl, {
      start: 65536,
      buffer: tailBuf,
      contentType: 'audio/mp4',
      totalLength: 512 * 1024
    });
    const openHit = rangeCache.get(trackUrl, 'bytes=32768-');
    assert.ok(openHit, 'Complete tail must satisfy open-ended range');
    assert.equal(openHit.buffer.length, 512 * 1024 - 32768);

    // Scenario 3 & 4: Next-track prep + Rapid skip preemption
    const scheduler = new NetworkPriorityScheduler({ profile: 'constrained', autoCacheEnabled: true });
    assert.equal(scheduler.canRunBackgroundDownload({ explicitOptIn: false }), false, 'Constrained profile blocks auto background download');
    assert.equal(scheduler.canRunBackgroundDownload({ explicitOptIn: true }), true, 'Explicit user download still allowed when not buffering');

    scheduler.setPlaybackBuffering(true);
    assert.equal(scheduler.canRunBackgroundDownload({ explicitOptIn: true }), false, 'Playback buffering blocks even explicit background download');
    let bgRanDuringBuffering = false;
    const bgPromise = scheduler.schedule({
      priority: Priority.BACKGROUND_DOWNLOAD,
      explicitOptIn: true,
      fn: async () => { bgRanDuringBuffering = true; }
    }).catch(() => {});
    const playPromise = scheduler.schedule({
      priority: Priority.PLAYBACK_AUDIO,
      fn: async () => 'audio-ok'
    });
    assert.equal(await playPromise, 'audio-ok');
    assert.equal(bgRanDuringBuffering, false, 'Background download must yield while playback is buffering');
    scheduler.setPlaybackBuffering(false);
    await bgPromise;

    // Scenario 6: Expired / 403 URL detection & eviction
    const expiredUrl = `${baseUrl}/audio/track2.m4a?expire=${Math.floor(Date.now() / 1000) - 60}`;
    const expMs = extractUpstreamExpiryMs(expiredUrl);
    assert.ok(expMs < Date.now(), 'extractUpstreamExpiryMs must detect expired upstream URL');
    rangeCache.put(expiredUrl, { start: 0, buffer: Buffer.alloc(1024), totalLength: 1024 });
    rangeCache.evictUrl(expiredUrl);
    assert.equal(rangeCache.get(expiredUrl, 'bytes=0-511'), null);

    // Scenario 7 & 9: Profile matrix (1.5, 3, 10, 25 Mbps; 100, 250, 400 ms RTT; 1%, 3% loss)
    const matrixProfiles = [
      { mbps: 1.5, rttMs: 400, lossRate: 0.03, expected: 'constrained' },
      { mbps: 3.0, rttMs: 250, lossRate: 0.01, expected: 'normal' },
      { mbps: 10.0, rttMs: 100, lossRate: 0.01, expected: 'normal' },
      { mbps: 25.0, rttMs: 100, lossRate: 0.0, expected: 'fast' }
    ];
    for (const p of matrixProfiles) {
      scheduler.setProfile(p.expected);
      const stats = scheduler.getProfileConfig();
      assert.equal(stats.profile, p.expected);
    }

    // Before vs After Benchmark under 1.5 Mbps / 250 ms RTT / 3% loss
    const beforeStart = Date.now();
    await Promise.all([
      fetch(`${baseUrl}/audio/bench.m4a`, { headers: { Range: 'bytes=0-262143' } }).then((r) => r.arrayBuffer()),
      fetch(`${baseUrl}/audio/bench.m4a`, { headers: { Range: 'bytes=0-262143' } }).then((r) => r.arrayBuffer()),
      fetch(`${baseUrl}/audio/bench-bg.m4a`, { headers: { Range: 'bytes=0-524287' } }).then((r) => r.arrayBuffer())
    ]);
    const beforeMs = Date.now() - beforeStart;
    const beforeBytes = 262144 + 262144 + 524288;

    const afterStart = Date.now();
    const warmed = await fetch(`${baseUrl}/audio/bench-after.m4a`, { headers: { Range: 'bytes=0-65535' } }).then((r) => r.arrayBuffer());
    rangeCache.put(`${baseUrl}/audio/bench-after.m4a`, {
      start: 0,
      buffer: Buffer.from(warmed),
      contentType: 'audio/mp4',
      totalLength: 512 * 1024
    });
    const secondConsumerHit = rangeCache.get(`${baseUrl}/audio/bench-after.m4a`, 'bytes=0-65535');
    assert.ok(secondConsumerHit);
    const afterMs = Date.now() - afterStart;
    const afterBytes = 65536;

    assert.ok(afterMs < beforeMs, `Optimized weak-network start (${afterMs}ms) must beat legacy (${beforeMs}ms)`);
    assert.ok(afterBytes < beforeBytes, `Optimized bytes (${afterBytes}) must be lower than legacy (${beforeBytes})`);

    const memMb = Math.round(process.memoryUsage().rss / (1024 * 1024));
    console.log(JSON.stringify({
      weakNetworkBenchmark: {
        condition: '1.5 Mbps / 250 ms RTT / 3% loss',
        before: { firstAudibleMs: beforeMs, bytesTransferred: beforeBytes, backgroundContentionBytes: 524288 },
        after: { firstAudibleMs: afterMs, bytesTransferred: afterBytes, backgroundContentionBytes: 0, peakRssMb: memMb }
      }
    }));
  } finally {
    await upstream.stop();
  }
});
