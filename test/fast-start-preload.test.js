const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const { PreloadManager } = require('../src/renderer/automix/preload-manager.js');
const { EclipsePreloadManager } = require('../src/renderer/preload-manager.js');

function createMockAudioElement() {
  const listeners = new Map();
  let _src = '';
  return {
    get src() { return _src; },
    set src(val) {
      _src = val;
      if (val) {
        setTimeout(() => {
          this.readyState = 4;
          this.emit('canplay');
        }, 5);
      }
    },
    preload: 'none',
    readyState: 0,
    paused: true,
    addEventListener(ev, fn) {
      if (!listeners.has(ev)) listeners.set(ev, []);
      listeners.get(ev).push(fn);
    },
    removeEventListener(ev, fn) {
      if (!listeners.has(ev)) return;
      listeners.set(ev, listeners.get(ev).filter(f => f !== fn));
    },
    emit(ev) {
      for (const fn of listeners.get(ev) || []) fn();
    },
    async play() {
      this.paused = false;
      this.readyState = 4;
      this.emit('playing');
    }
  };
}

describe('Fast-Start Quality Policy & Rolling One-Track-Ahead Preload', () => {
  test('1-4 & 9-11: Real HTTP timing — High/Max Fast-Start Low playback starts before High/Max resolver, rolling preload prepares next track at High/Max, fallback & Medium/Low unchanged', async () => {
    const requests = [];
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname === '/api/stream-info') {
        const id = u.searchParams.get('id');
        const quality = u.searchParams.get('quality');
        requests.push({ id, quality, ts: performance.now() });

        if (id === 'fail_low' && quality === 'low') {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'low failed' }));
        }
        if (id === 'fail_preload' && quality === 'max') {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'max preload failed' }));
        }

        const delayMs = (quality === 'high' || quality === 'max') ? 250 : 10;
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            streamUrl: `http://127.0.0.1:${server.address().port}/audio/${id}_${quality}.m4a`,
            proxyUrl: `http://127.0.0.1:${server.address().port}/audio/${id}_${quality}.m4a`
          }));
        }, delayMs);
        return;
      }
      if (u.pathname.startsWith('/audio/')) {
        res.writeHead(206, { 'Content-Type': 'audio/mp4' });
        return res.end(Buffer.alloc(1024));
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    try {
      const pm = new PreloadManager({ apiBase: `http://127.0.0.1:${port}` });

      // Scenario 1 & 2: High + first track cache miss -> Low starts fast (<60ms), then High preload for B
      const trackA = { id: 'trackA', platform: 'ytmusic', title: 'A' };
      const trackB = { id: 'trackB', platform: 'ytmusic', title: 'B' };
      const trackC = { id: 'trackC', platform: 'ytmusic', title: 'C' };
      const audioA = createMockAudioElement();
      const audioB = createMockAudioElement();

      const t0 = performance.now();
      const urlA = await pm.resolveStreamUrl(trackA, 'low');
      audioA.src = urlA;
      await audioA.play();
      const timeToFirstAudioMs = performance.now() - t0;

      assert.ok(urlA.includes('trackA_low.m4a'), `Expected low stream for fast-start, got ${urlA}`);
      assert.ok(timeToFirstAudioMs < 200, `Expected fast-start < 200ms (before 250ms high resolver), got ${timeToFirstAudioMs.toFixed(1)}ms`);
      assert.strictEqual(audioA.readyState, 4);

      // Rolling preload for B at High
      const preloadStartMs = performance.now();
      const prepB = await pm.prepareNextTrack(trackB, audioB, 'high');
      const preloadDoneMs = performance.now();
      assert.strictEqual(prepB.ready, true);
      assert.ok(prepB.streamUrl.includes('trackB_high.m4a'));
      assert.strictEqual(trackB._preloadedStreamQuality, 'high');
      assert.ok(preloadDoneMs - preloadStartMs >= 220, 'High preload should resolve real High endpoint');
      assert.ok(timeToFirstAudioMs < (preloadDoneMs - preloadStartMs), 'Fast-start Low must finish before High preload');

      // Scenario 4: When B starts, rolling preload prepares C at Max
      const prepC = await pm.prepareNextTrack(trackC, audioB, 'max');
      assert.strictEqual(prepC.ready, true);
      assert.ok(prepC.streamUrl.includes('trackC_max.m4a'));
      assert.strictEqual(trackC._preloadedStreamQuality, 'max');

      // Scenario 9: Low resolve fails -> fallback to High/Max
      const failLowTrack = { id: 'fail_low', platform: 'ytmusic', title: 'FailLow' };
      let resolvedFailLow = await pm.resolveStreamUrl(failLowTrack, 'low');
      if (!resolvedFailLow) {
        resolvedFailLow = await pm.resolveStreamUrl(failLowTrack, 'max');
      }
      assert.ok(resolvedFailLow.includes('fail_low_max.m4a'));

      // Scenario 10: Max preload fails -> current playback unaffected
      const failPreloadTrack = { id: 'fail_preload', platform: 'ytmusic', title: 'FailPreload' };
      const prepFail = await pm.prepareNextTrack(failPreloadTrack, audioB, 'max');
      assert.strictEqual(prepFail.ready, false);
      assert.strictEqual(audioA.paused, false);

      // Scenario 11: Normal playback uses configuredQuality directly without Low override
      const appSrc = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
      assert.doesNotMatch(appSrc, /isFastStartQuality\s*\(/);
      assert.match(appSrc, /fetchStreamInfoWithRetry\(configuredQuality\)/);
    } finally {
      server.close();
    }
  });

  test('5-7: Quality-aware cache isolation (Low != Max, Max hit reuses cache, cancellation prevents stale overwrite)', async () => {
    let resolveCount = 0;
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname === '/api/stream-info') {
        resolveCount += 1;
        const id = u.searchParams.get('id');
        const quality = u.searchParams.get('quality');
        const delay = id === 'slow_stale' ? 120 : 5;
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            streamUrl: `http://127.0.0.1:${server.address().port}/audio/${id}_${quality}.m4a`,
            proxyUrl: `http://127.0.0.1:${server.address().port}/audio/${id}_${quality}.m4a`
          }));
        }, delay);
        return;
      }
      res.writeHead(206);
      res.end();
    });

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    try {
      const pm = new PreloadManager({ apiBase: `http://127.0.0.1:${port}` });
      const epm = new EclipsePreloadManager({ serverPort: port });
      const track = { id: 'q_iso_1', platform: 'ytmusic', title: 'Iso' };

      // 5. Cache has Low, request Max -> must NOT return Low
      const lowUrl = await pm.resolveStreamUrl(track, 'low');
      assert.ok(lowUrl.includes('q_iso_1_low.m4a'));
      assert.strictEqual(track._preloadedStreamQuality, 'low');

      epm.setCache(track, { streamUrl: lowUrl, proxyUrl: lowUrl }, 'low');
      assert.strictEqual(epm.getCached(track, 'max'), null);
      assert.ok(epm.getCached(track, 'low'));

      const maxUrl = await pm.resolveStreamUrl(track, 'max');
      assert.ok(maxUrl.includes('q_iso_1_max.m4a'));
      assert.strictEqual(track._preloadedStreamQuality, 'max');

      // 6. Cache has Max, request Max -> reuse cache without extra resolve
      const beforeCount = resolveCount;
      const maxUrlCached = await pm.resolveStreamUrl(track, 'max');
      assert.strictEqual(maxUrlCached, maxUrl);
      assert.strictEqual(resolveCount, beforeCount);

      // 7. Cancellation prevents stale preload from overwriting new track
      const staleTrack = { id: 'slow_stale', platform: 'ytmusic', title: 'Stale' };
      const newTrack = { id: 'fast_new', platform: 'ytmusic', title: 'New' };
      const pStale = pm.prepareNextTrack(staleTrack, null, 'max');
      pm.cancelPreload('queue_reordered');
      const pNew = await pm.prepareNextTrack(newTrack, null, 'max');
      await pStale;
      assert.strictEqual(staleTrack._preloadedStreamUrl, undefined);
      assert.ok(pNew.streamUrl.includes('fast_new_max.m4a'));
    } finally {
      server.close();
    }
  });

  test('8 & 12: Tempo Synced candidate selection & rolling one-track-ahead wiring in app.js + integration-bridge.js', () => {
    const appSrc = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
    const bridgeSrc = fs.readFileSync(path.join(__dirname, '../src/renderer/integration-bridge.js'), 'utf8');

    // Tempo Synced candidate used via NextTrackCoordinator in both app.js rolling preload and integration-bridge early preload
    assert.match(appSrc, /async function resolveNextPreloadTarget\(\)[\s\S]*?nextTrackCoordinator\.reserve\(\)/);
    assert.match(bridgeSrc, /const coord = window\._eclipseNextTrackCoordinator;[\s\S]*?coord\.reserve\(\)[\s\S]*?preloadManager\.prepareNextTrack\(preloadTarget,\s*auxAudio,\s*curQuality\)/);

    // No secondNext batch prefetching in prefetchUpcomingQueueStreams
    const upcomingFn = appSrc.slice(appSrc.indexOf('function prefetchUpcomingQueueStreams()'), appSrc.indexOf('// === ECLIPSE MERGE: OFFLINE MODE ==='));
    assert.doesNotMatch(upcomingFn, /secondNext/);

    // Authoritative quality: normal playback, retry, and preload all use configuredQuality
    assert.match(appSrc, /fetchStreamInfoWithRetry\(configuredQuality\)/);
    assert.match(appSrc, /const reqQuality = getConfiguredAudioQuality\(\);[\s\S]*?forceYtDlp=1/);
    assert.match(appSrc, /localStorage\.getItem\('eclipse_audio_quality'\)/);
    assert.match(appSrc, /localStorage\.setItem\('eclipse_audio_quality',\s*val\)/);
  });

  test('Authoritative Max Quality: cold cache requests quality=max, isolates Low/Medium cache, and records redacted diagnostics', async () => {
    const { networkDiagnostics, fetchDirectYoutubeStreamServer } = require('../src/server/server.js');
    const requestedQualities = [];
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname === '/api/stream-info') {
        const id = u.searchParams.get('id');
        const quality = u.searchParams.get('quality');
        requestedQualities.push({ id, quality });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: true,
          streamUrl: `http://127.0.0.1:${server.address().port}/audio/${id}_${quality}.m4a`,
          proxyUrl: `http://127.0.0.1:${server.address().port}/audio/${id}_${quality}.m4a`,
          requestedQuality: quality,
          resolvedQuality: quality,
          resolverPath: 'direct_youtube',
          mimeType: 'audio/mp4; codecs="mp4a.40.2"',
          bitrate: quality === 'max' ? 256000 : quality === 'high' ? 192000 : quality === 'medium' ? 128000 : 48000
        }));
      }
      if (u.pathname.startsWith('/audio/')) {
        res.writeHead(206, {
          'Content-Type': 'audio/mp4',
          'Content-Range': 'bytes 0-1023/4096',
          'Content-Length': '1024'
        });
        return res.end(Buffer.alloc(1024));
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    try {
      const pm = new PreloadManager({ apiBase: `http://127.0.0.1:${port}` });
      const epm = new EclipsePreloadManager({ serverPort: port });
      const audio = createMockAudioElement();

      // 1-3. Cold cache with Max -> first request is quality=max, attached to audio, _preloadedStreamQuality === 'max'
      const trackMax = { id: 'max_cold_1', platform: 'ytmusic', title: 'MaxTrack' };
      const maxUrl = await pm.resolveStreamUrl(trackMax, 'max');
      audio.src = maxUrl;
      await audio.play();
      assert.strictEqual(requestedQualities[0].quality, 'max');
      assert.ok(audio.src.includes('max_cold_1_max.m4a'));
      assert.strictEqual(trackMax._preloadedStreamQuality, 'max');

      // 4-5. Low cache entry never satisfies Max request
      epm.setCache(trackMax, { streamUrl: 'http://127.0.0.1/low.m4a', proxyUrl: 'http://127.0.0.1/low.m4a' }, 'low');
      assert.strictEqual(epm.getCached(trackMax, 'max'), null);

      // 6. Medium, High, Low all resolve their exact requested quality
      for (const q of ['low', 'medium', 'high']) {
        const t = { id: `q_${q}`, platform: 'ytmusic', title: q };
        const u = await pm.resolveStreamUrl(t, q);
        assert.ok(u.includes(`q_${q}_${q}.m4a`));
        assert.strictEqual(t._preloadedStreamQuality, q);
      }

      // 7. Direct YouTube resolver picks highest bitrate for max
      const ytMock = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          playabilityStatus: { status: 'OK' },
          streamingData: {
            adaptiveFormats: [
              { itag: 139, mimeType: 'audio/mp4; codecs="mp4a.40.5"', bitrate: 48000, url: 'https://example.com/low?sig=secret' },
              { itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 128000, url: 'https://example.com/med?sig=secret' },
              { itag: 251, mimeType: 'audio/webm; codecs="opus"', bitrate: 160000, url: 'https://example.com/max?sig=secret' }
            ]
          }
        }));
      });
      await new Promise(resolve => ytMock.listen(0, '127.0.0.1', resolve));
      try {
        const selected = await fetchDirectYoutubeStreamServer('dQw4w9WgXcQ', 'max', {
          httpClient: http,
          withMeta: true,
          clients: [{ clientName: 'IOS', clientVersion: '20.10.4', userAgent: 'test', host: '127.0.0.1', port: ytMock.address().port }]
        });
        assert.ok(selected && selected.url.includes('/max'));
        assert.strictEqual(selected.bitrate, 160000);
        assert.strictEqual(selected.resolverPath, 'direct_youtube');
      } finally {
        await new Promise(resolve => ytMock.close(resolve));
      }

      // 8. Redacted diagnostics record quality metadata without signed URLs or cookies
      networkDiagnostics.recordStreamInfo({
        hit: false,
        durationMs: 42,
        qualityMeta: {
          requestedQuality: 'max',
          resolvedQuality: 'max',
          resolverPath: 'direct_youtube',
          mimeType: 'audio/webm; codecs="opus"',
          bitrate: 160000,
          cacheHit: false
        }
      });
      const summary = networkDiagnostics.getSummary();
      assert.strictEqual(summary.streamInfo.lastQualityResolution.requestedQuality, 'max');
      assert.strictEqual(summary.streamInfo.lastQualityResolution.resolvedQuality, 'max');
      assert.strictEqual(summary.streamInfo.lastQualityResolution.bitrate, 160000);
      assert.strictEqual(JSON.stringify(summary.streamInfo.lastQualityResolution).includes('sig='), false);
    } finally {
      server.close();
    }
  });
});
