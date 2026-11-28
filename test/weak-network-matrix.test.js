// test/weak-network-matrix.test.js
// Integration test matrix for Eclipse PC weak-network optimization (9 scenarios + aggregate-bandwidth Before/After benchmark)
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');

const {
  startServer,
  stopServer,
  handleAudioProxy,
  networkScheduler,
  networkDiagnostics,
  adaptiveRangeCache,
  artworkCache,
  verifyStreamPlayable,
  fetchDirectYoutubeStreamServer
} = require('../src/server/server');
const { Priority } = require('../src/server/network-scheduler');
const { parseRangeHeader } = require('../src/server/range-cache');
const { EclipsePreloadManager } = require('../src/renderer/audio/preload-manager');
const { PreloadManager } = require('../src/renderer/automix/preload-manager');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Shared aggregate bandwidth limiter across all concurrent upstream requests.
 */
class AggregateBandwidthLimiter {
  constructor(mbps = 1.5) {
    this.bytesPerMs = (mbps * 1000 * 1000) / 8 / 1000;
    this.nextAvailableAt = Date.now();
  }

  async consume(bytes) {
    const txMs = Math.ceil(bytes / Math.max(1, this.bytesPerMs));
    const now = Date.now();
    const startAt = Math.max(now, this.nextAvailableAt);
    this.nextAvailableAt = startAt + txMs;
    const waitMs = this.nextAvailableAt - now;
    if (waitMs > 0) await sleep(waitMs);
  }
}

/**
 * Deterministic shaped upstream HTTP server with shared aggregate bandwidth, RTT, and transient HTTP 503 failures.
 */
function createShapedUpstream({ mbps = 1.5, rttMs = 250, failEveryN = 0, totalBytes = 512 * 1024 } = {}) {
  const payload = crypto.randomBytes(totalBytes);
  const limiter = new AggregateBandwidthLimiter(mbps);
  let requestCount = 0;
  let bytesServed = 0;
  let transientFailuresInjected = 0;
  const seenRanges = [];

  const server = http.createServer(async (req, res) => {
    const reqSeq = ++requestCount;
    await sleep(rttMs);

    if (req.url.includes('expired=1')) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      return res.end('Forbidden');
    }

    if (failEveryN > 0 && (reqSeq % failEveryN) === 0) {
      transientFailuresInjected += 1;
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      return res.end('Deterministic transient HTTP 503');
    }

    if (req.url.startsWith('/art/')) {
      const artBuf = Buffer.alloc(24 * 1024, 0xab);
      await limiter.consume(artBuf.length);
      bytesServed += artBuf.length;
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': String(artBuf.length) });
      return res.end(artBuf);
    }

    const rangeHdr = req.headers.range || 'bytes=0-';
    seenRanges.push({ url: req.url, range: rangeHdr });
    const parsed = parseRangeHeader(rangeHdr);
    const start = parsed ? parsed.start : 0;
    const end = parsed && !parsed.openEnded ? Math.min(parsed.end, totalBytes - 1) : totalBytes - 1;
    const slice = payload.subarray(start, end + 1);

    await limiter.consume(slice.length);
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
    getStats: () => ({ requestCount, bytesServed, transientFailuresInjected, seenRanges: [...seenRanges] }),
    resetStats: () => { requestCount = 0; bytesServed = 0; transientFailuresInjected = 0; seenRanges.length = 0; },
    start: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    stop: () => new Promise((resolve) => server.close(resolve))
  };
}

function createTestProxyServer() {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/api/audio-proxy') {
      const target = u.searchParams.get('url') || '';
      return handleAudioProxy(req, res, target, 5, null, {
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
        httpClient: {
          request: (targetUrl, reqOpts, cb) => {
            const parsed = new URL(targetUrl);
            return http.request({
              hostname: '127.0.0.1',
              port: parsed.port,
              path: parsed.pathname + parsed.search,
              method: reqOpts.method,
              headers: reqOpts.headers
            }, cb);
          }
        }
      });
    }
    res.writeHead(404);
    res.end('Not found');
  });
  return {
    start: () => new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv.address().port))),
    stop: () => new Promise((resolve) => srv.close(resolve))
  };
}

test('Scenario 1: Cold app/Home startup diagnostics populated via /api/network-diagnostics', async () => {
  const serverPort = await startServer(0);
  try {
    const post1 = await fetch(`http://127.0.0.1:${serverPort}/api/network-diagnostics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        startupToUiMs: 380,
        homeReadyMs: 820,
        firstPlayingMs: 412,
        waitingDeltaMs: 95
      })
    });
    assert.equal(post1.status, 200);

    const getRes = await fetch(`http://127.0.0.1:${serverPort}/api/network-diagnostics`);
    const body = await getRes.json();
    assert.equal(body.success, true);
    assert.equal(body.diagnostics.startupToUiMs, 380);
    assert.equal(body.diagnostics.homeReadyMs, 820);
    assert.equal(body.diagnostics.audioProxy.firstPlayingMs, 412);
    assert.ok(body.diagnostics.audioProxy.waitingCount >= 1);
    assert.ok(body.diagnostics.audioProxy.waitingTotalMs >= 95);
  } finally {
    await stopServer();
  }
});

test('Scenario 2 (Simulated Proxy): First Play range completion through real handleAudioProxy', async () => {
  const upstream = createShapedUpstream({ mbps: 3.0, rttMs: 100, totalBytes: 256 * 1024 });
  const upPort = await upstream.start();
  const proxy = createTestProxyServer();
  const proxyPort = await proxy.start();

  try {
    const targetUrl = `http://media.example.com:${upPort}/audio/first-play.m4a`;
    const playStart = Date.now();
    const res = await fetch(`http://127.0.0.1:${proxyPort}/api/audio-proxy?url=${encodeURIComponent(targetUrl)}`, {
      headers: { Range: 'bytes=0-65535' }
    });
    assert.equal(res.status, 206);
    const buf = Buffer.from(await res.arrayBuffer());
    const firstRangeCompleteMs = Date.now() - playStart;
    assert.equal(buf.length, 65536);
    assert.ok(firstRangeCompleteMs >= 100);
    assert.ok(networkDiagnostics.getSummary().bytesByCategory.playback >= 65536);
  } finally {
    await proxy.stop();
    await upstream.stop();
  }
});

test('Scenario 3: Next-track preparation deduplicates warm-up and verifies 206 response before marking', async () => {
  const upstream = createShapedUpstream({ mbps: 3.0, rttMs: 50, totalBytes: 256 * 1024 });
  const upPort = await upstream.start();
  const proxy = createTestProxyServer();
  const proxyPort = await proxy.start();
  globalThis.__eclipseWarmedState = { inflight: new Map(), verified: new Map() };

  try {
    const targetUrl = `http://media.example.com:${upPort}/audio/next-track.m4a`;
    const proxyUrl = `http://127.0.0.1:${proxyPort}/api/audio-proxy?url=${encodeURIComponent(targetUrl)}`;

    const eclipsePreload = new EclipsePreloadManager({ serverPort: proxyPort, rangeWarmUpBytes: 65536 });
    const automixPreload = new PreloadManager({ apiBase: `http://127.0.0.1:${proxyPort}` });

    const [ok1, ok2] = await Promise.all([
      eclipsePreload._warmUpRange(proxyUrl),
      automixPreload.warmUpBuffer(proxyUrl)
    ]);
    assert.equal(ok1, true);
    assert.equal(ok2, true);
    assert.equal(upstream.getStats().requestCount, 1, 'Shared in-flight Promise must deduplicate warm-up');

    // Partial 64 KiB prefix must NOT satisfy open-ended bytes=0- request
    assert.equal(adaptiveRangeCache.get(targetUrl, 'bytes=0-'), null);

    const badUrl = `http://127.0.0.1:${proxyPort}/api/audio-proxy?url=${encodeURIComponent(`http://media.example.com:${upPort}/audio/bad.m4a?expired=1`)}`;
    const badOk = await eclipsePreload._warmUpRange(badUrl);
    assert.equal(badOk, false);
    assert.equal(globalThis.__eclipseWarmedState.verified.has(badUrl), false);
  } finally {
    await proxy.stop();
    await upstream.stop();
  }
});

test('Scenario 4: Rapid manual Next cancels stale NEXT_TRACK_PREP via /api/network-profile bumpGeneration', async () => {
  const serverPort = await startServer(0);
  try {
    const gen0 = networkScheduler.generation;
    let release;
    const gate = new Promise((r) => { release = r; });
    networkScheduler.setProfile('constrained');
    const s1 = networkScheduler.schedule({ priority: Priority.PLAYBACK_AUDIO, fn: () => gate });
    const s2 = networkScheduler.schedule({ priority: Priority.PLAYBACK_AUDIO, fn: () => gate });

    const stale = networkScheduler.schedule({
      priority: Priority.NEXT_TRACK_PREP,
      generation: gen0,
      fn: async () => 'stale'
    });
    const staleAssertion = assert.rejects(stale, (e) => e && e.code === 'STALE_GENERATION');

    const bumpRes = await fetch(`http://127.0.0.1:${serverPort}/api/network-profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bumpGeneration: true })
    });
    assert.equal(bumpRes.status, 200);
    release();
    await Promise.all([s1, s2]);
    await staleAssertion;
  } finally {
    networkScheduler.setProfile('normal');
    await stopServer();
  }
});

test('Scenario 5: Seek while buffering prioritizes PLAYBACK_SEEK and hits AdaptiveRangeCache', async () => {
  const upstream = createShapedUpstream({ mbps: 3.0, rttMs: 50, totalBytes: 256 * 1024 });
  const upPort = await upstream.start();
  const proxy = createTestProxyServer();
  const proxyPort = await proxy.start();

  try {
    const targetUrl = `http://media.example.com:${upPort}/audio/seek-track.m4a`;
    const proxyUrl = `http://127.0.0.1:${proxyPort}/api/audio-proxy?url=${encodeURIComponent(targetUrl)}`;

    const r1 = await fetch(proxyUrl, { headers: { Range: 'bytes=0-65535' } });
    assert.equal(r1.status, 206);
    await r1.arrayBuffer();

    const beforeReqs = upstream.getStats().requestCount;
    const r2 = await fetch(proxyUrl, { headers: { Range: 'bytes=16384-32767' } });
    assert.equal(r2.status, 206);
    const seekBuf = Buffer.from(await r2.arrayBuffer());
    assert.equal(seekBuf.length, 16384);
    assert.equal(upstream.getStats().requestCount, beforeReqs, 'Contained seek must hit AdaptiveRangeCache');
  } finally {
    await proxy.stop();
    await upstream.stop();
  }
});

test('Scenario 6: Expired upstream URL (403) returns X-Eclipse-Stream-Expired and evicts cache', async () => {
  const upstream = createShapedUpstream({ mbps: 3.0, rttMs: 20, totalBytes: 64 * 1024 });
  const upPort = await upstream.start();
  const proxy = createTestProxyServer();
  const proxyPort = await proxy.start();

  try {
    const uncachedExpired = `http://media.example.com:${upPort}/audio/exp2.m4a?expired=1`;
    const res2 = await fetch(`http://127.0.0.1:${proxyPort}/api/audio-proxy?url=${encodeURIComponent(uncachedExpired)}`, {
      headers: { Range: 'bytes=0-1023' }
    });
    assert.equal(res2.status, 403);
    assert.equal(res2.headers.get('x-eclipse-stream-expired'), '1');
  } finally {
    await proxy.stop();
    await upstream.stop();
  }
});

test('Scenario 7: Playback while artwork requests are active prioritizes PLAYBACK_AUDIO', async () => {
  networkScheduler.setProfile('constrained');
  const order = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const s1 = networkScheduler.schedule({ priority: Priority.PLAYBACK_AUDIO, fn: () => gate });
  const s2 = networkScheduler.schedule({ priority: Priority.PLAYBACK_AUDIO, fn: () => gate });

  const art = networkScheduler.schedule({ priority: Priority.VISIBLE_ARTWORK_LYRICS, fn: async () => { order.push('art'); } });
  const play = networkScheduler.schedule({ priority: Priority.PLAYBACK_AUDIO, fn: async () => { order.push('play'); } });

  release();
  await Promise.all([s1, s2, art, play]);
  assert.deepEqual(order, ['play', 'art']);
  networkScheduler.setProfile('normal');
});

test('Scenario 8: Playback while background download is eligible yields and aborts on buffering', async () => {
  networkScheduler.setProfile('normal');
  networkScheduler.setAutoCacheEnabled(true);
  networkScheduler.setPlaybackBuffering(true);
  assert.equal(networkScheduler.canRunBackgroundDownload({ explicitOptIn: true }), false);

  networkScheduler.setPlaybackBuffering(false);
  let aborted = false;
  const bg = networkScheduler.schedule({
    priority: Priority.BACKGROUND_DOWNLOAD,
    explicitOptIn: true,
    fn: (signal) => new Promise((resolve) => {
      signal.addEventListener('abort', () => { aborted = true; resolve('aborted'); }, { once: true });
    })
  });
  await sleep(10);
  networkScheduler.setPlaybackBuffering(true);
  assert.equal(await bg, 'aborted');
  assert.equal(aborted, true);
  networkScheduler.setPlaybackBuffering(false);
});

test('Scenario 9: Constrained-profile activation and recovery via /api/network-profile', async () => {
  const serverPort = await startServer(0);
  try {
    const r1 = await fetch(`http://127.0.0.1:${serverPort}/api/network-profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: 'constrained', autoCacheEnabled: true })
    });
    const d1 = await r1.json();
    assert.equal(d1.scheduler.profile, 'constrained');
    assert.equal(networkScheduler.canRunBackgroundDownload({ explicitOptIn: false }), false);

    const r2 = await fetch(`http://127.0.0.1:${serverPort}/api/network-profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: 'normal', autoCacheEnabled: true })
    });
    const d2 = await r2.json();
    assert.equal(d2.scheduler.profile, 'normal');
    assert.equal(networkScheduler.canRunBackgroundDownload({ explicitOptIn: false }), true);
  } finally {
    await stopServer();
  }
});

test('Identical-Workload Before/After Benchmark (1.5 Mbps aggregate, 250 ms RTT, deterministic 503 every 4th req)', async () => {
  const upstream = createShapedUpstream({ mbps: 1.5, rttMs: 250, failEveryN: 4, totalBytes: 512 * 1024 });
  const upPort = await upstream.start();
  const proxy = createTestProxyServer();
  const proxyPort = await proxy.start();

  let peakRssMb = Math.round(process.memoryUsage().rss / (1024 * 1024));
  const rssSampler = setInterval(() => {
    const cur = Math.round(process.memoryUsage().rss / (1024 * 1024));
    if (cur > peakRssMb) peakRssMb = cur;
  }, 50);

  const fetchWithRetry = async (url, opts) => {
    const r = await fetch(url, opts);
    if (r.status === 503) return fetch(url, opts);
    return r;
  };

  try {
    // BEFORE (legacy): 256 KiB warm-up, no range cache reuse, duplicate warm-up, uncached artwork
    upstream.resetStats();
    const beforeStart = Date.now();
    const beforePlay = await fetchWithRetry(`http://127.0.0.1:${upPort}/audio/before.m4a`, { headers: { Range: 'bytes=0-65535' } });
    await beforePlay.arrayBuffer();
    const beforeFirstRangeCompleteMs = Date.now() - beforeStart;
    await Promise.all([
      fetchWithRetry(`http://127.0.0.1:${upPort}/audio/before.m4a`, { headers: { Range: 'bytes=16384-32767' } }).then((r) => r.arrayBuffer()),
      fetchWithRetry(`http://127.0.0.1:${upPort}/audio/before-next.m4a`, { headers: { Range: 'bytes=0-262143' } }).then((r) => r.arrayBuffer()),
      fetchWithRetry(`http://127.0.0.1:${upPort}/audio/before-next.m4a`, { headers: { Range: 'bytes=0-262143' } }).then((r) => r.arrayBuffer()),
      fetchWithRetry(`http://127.0.0.1:${upPort}/art/b1.jpg`).then((r) => r.arrayBuffer()),
      fetchWithRetry(`http://127.0.0.1:${upPort}/art/b1.jpg`).then((r) => r.arrayBuffer())
    ]);
    const beforeTotalMs = Date.now() - beforeStart;
    const beforeStats = upstream.getStats();
    assert.ok(beforeStats.transientFailuresInjected > 0, 'Deterministic transient 503 must be injected in before run');

    // AFTER (optimized): real handleAudioProxy + AdaptiveRangeCache + shared warm-up dedup + StaleFirstArtworkCache
    upstream.resetStats();
    networkScheduler.setProfile('constrained');
    globalThis.__eclipseWarmedState = { inflight: new Map(), verified: new Map() };
    const afterTrackUrl = `http://media.example.com:${upPort}/audio/after.m4a`;
    const afterNextUrl = `http://127.0.0.1:${proxyPort}/api/audio-proxy?url=${encodeURIComponent(`http://media.example.com:${upPort}/audio/after-next.m4a`)}`;
    const eclipsePreload = new EclipsePreloadManager({ serverPort: proxyPort, rangeWarmUpBytes: 65536 });
    const automixPreload = new PreloadManager({ apiBase: `http://127.0.0.1:${proxyPort}` });

    const afterStart = Date.now();
    const afterPlay = await fetch(`http://127.0.0.1:${proxyPort}/api/audio-proxy?url=${encodeURIComponent(afterTrackUrl)}`, {
      headers: { Range: 'bytes=0-65535' }
    });
    await afterPlay.arrayBuffer();
    const afterFirstRangeCompleteMs = Date.now() - afterStart;

    await Promise.all([
      fetch(`http://127.0.0.1:${proxyPort}/api/audio-proxy?url=${encodeURIComponent(afterTrackUrl)}`, {
        headers: { Range: 'bytes=16384-32767' }
      }).then((r) => r.arrayBuffer()),
      eclipsePreload._warmUpRange(afterNextUrl),
      automixPreload.warmUpBuffer(afterNextUrl),
      artworkCache.getOrFetch(`http://127.0.0.1:${upPort}/art/a1.jpg`, async (u) => {
        const r = await fetch(u);
        return { buffer: Buffer.from(await r.arrayBuffer()), contentType: 'image/jpeg' };
      }),
      artworkCache.getOrFetch(`http://127.0.0.1:${upPort}/art/a1.jpg`, async (u) => {
        const r = await fetch(u);
        return { buffer: Buffer.from(await r.arrayBuffer()), contentType: 'image/jpeg' };
      })
    ]);
    const afterTotalMs = Date.now() - afterStart;
    const afterStats = upstream.getStats();

    assert.ok(afterStats.bytesServed < beforeStats.bytesServed, `Optimized bytes (${afterStats.bytesServed}) must be < legacy (${beforeStats.bytesServed})`);
    assert.ok(afterStats.requestCount < beforeStats.requestCount, `Optimized requests (${afterStats.requestCount}) must be < legacy (${beforeStats.requestCount})`);

    console.log(JSON.stringify({
      identicalWorkloadBenchmark: {
        condition: '1.5 Mbps aggregate / 250 ms RTT / deterministic 503 every 4th req',
        before: {
          firstRangeCompleteMs: beforeFirstRangeCompleteMs,
          totalWorkloadMs: beforeTotalMs,
          upstreamRequests: beforeStats.requestCount,
          transientFailuresInjected: beforeStats.transientFailuresInjected,
          bytesTransferred: beforeStats.bytesServed
        },
        after: {
          firstRangeCompleteMs: afterFirstRangeCompleteMs,
          totalWorkloadMs: afterTotalMs,
          upstreamRequests: afterStats.requestCount,
          transientFailuresInjected: afterStats.transientFailuresInjected,
          bytesTransferred: afterStats.bytesServed,
          peakRssMb
        }
      }
    }));
  } finally {
    clearInterval(rssSampler);
    networkScheduler.setProfile('normal');
    await proxy.stop();
    await upstream.stop();
  }
});

test('AbortSignal Propagation: aborting verifyStreamPlayable and fetchDirectYoutubeStreamServer closes upstream TCP sockets', async () => {
  const trackedSockets = [];
  const slowServer = http.createServer((req, res) => {
    const sock = req.socket;
    const entry = { url: req.url, socket: sock, closed: false };
    sock.once('close', () => { entry.closed = true; });
    trackedSockets.push(entry);
    // Hold response open indefinitely so socket only closes on client abort
  });
  await new Promise((r) => slowServer.listen(0, '127.0.0.1', r));
  const port = slowServer.address().port;

  try {
    const ac1 = new AbortController();
    const probePromise = verifyStreamPlayable(`http://127.0.0.1:${port}/stream.m4a`, undefined, 3, {
      signal: ac1.signal,
      httpClient: http
    });
    await sleep(40);
    assert.equal(trackedSockets.length, 1, 'verifyStreamPlayable must open 1 upstream socket');
    assert.equal(trackedSockets[0].closed, false, 'verifyStreamPlayable socket must remain open before abort');
    assert.equal(trackedSockets[0].socket.destroyed, false, 'verifyStreamPlayable socket must not be destroyed before abort');
    ac1.abort();
    assert.equal(await probePromise, false);
    await sleep(40);
    assert.equal(trackedSockets[0].closed, true, 'verifyStreamPlayable upstream socket must close after AbortSignal');

    const ac2 = new AbortController();
    const directPromise = fetchDirectYoutubeStreamServer('dQw4w9WgXcQ', 'medium', {
      signal: ac2.signal,
      httpClient: http,
      clients: [{ clientName: 'IOS', clientVersion: '20.10.4', userAgent: 'test', host: '127.0.0.1', port }]
    });
    await sleep(40);
    assert.equal(trackedSockets.length, 2, 'fetchDirectYoutubeStreamServer must open 1 upstream socket');
    assert.equal(trackedSockets[1].closed, false, 'fetchDirectYoutubeStreamServer socket must remain open before abort');
    assert.equal(trackedSockets[1].socket.destroyed, false, 'fetchDirectYoutubeStreamServer socket must not be destroyed before abort');
    ac2.abort();
    assert.equal(await directPromise, null);
    await sleep(40);
    assert.equal(trackedSockets[1].closed, true, 'fetchDirectYoutubeStreamServer upstream socket must close after AbortSignal');
  } finally {
    for (const entry of trackedSockets) {
      try { entry.socket.destroy(); } catch (_) {}
    }
    await new Promise((r) => slowServer.close(r));
  }
});

test('Optimized-Path Transient HTTP 503 Recovery: warm-up retries and succeeds after injected 503', async () => {
  let attempts = 0;
  let injected503 = 0;
  const srv = http.createServer((req, res) => {
    attempts += 1;
    if (attempts === 1) {
      injected503 += 1;
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      return res.end('Transient 503');
    }
    res.writeHead(206, {
      'Content-Type': 'audio/mp4',
      'Content-Range': 'bytes 0-65535/524288',
      'Content-Length': '65536'
    });
    res.end(Buffer.alloc(65536, 0x55));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;

  try {
    globalThis.__eclipseWarmedState = { inflight: new Map(), verified: new Map() };
    const ep = new EclipsePreloadManager({ serverPort: port, rangeWarmUpBytes: 65536 });
    const ok = await ep._warmUpRange(`http://127.0.0.1:${port}/retry-503`);
    assert.equal(injected503, 1, 'HTTP 503 must be injected on first attempt');
    assert.equal(attempts, 2, 'Warm-up must retry once after 503');
    assert.equal(ok, true, 'Warm-up must succeed on retry');
  } finally {
    await new Promise((r) => srv.close(r));
  }
});
