const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const { NextTrackCoordinator } = require('../src/renderer/audio/next-track-coordinator.js');
const AutoMixDJ = require('../src/renderer/automix/automix-dj.js');
const { PreloadManager } = require('../src/renderer/automix/preload-manager.js');

function makeQueue() {
  return [
    { id: 'A', title: 'Track A', artist: 'Art 1', album: 'Alb 1', platform: 'ytmusic', _detectedBpm: 120 },
    { id: 'B', title: 'Track B', artist: 'Art 2', album: 'Alb 2', platform: 'ytmusic', _detectedBpm: 90 },
    { id: 'C', title: 'Track C', artist: 'Art 3', album: 'Alb 3', platform: 'ytmusic', _detectedBpm: 140 },
    { id: 'D', title: 'Track D', artist: 'Art 4', album: 'Alb 4', platform: 'ytmusic', _detectedBpm: 121 }
  ];
}

describe('NextTrackCoordinator — Shuffle, AutoMix DJ & Fast-Start Unified Selection', () => {
  test('1. Shuffle provider picks D when queueIndex+1 is B: preload and playback both use D with single provider call', async () => {
    const queue = makeQueue();
    const state = { queue, queueIndex: 0, currentTrack: queue[0], isShuffle: true, isAutoRemix: false, queueHistory: [0], repeatMode: 'off' };
    let providerCalls = 0;
    const provider = {
      fn: async () => {
        providerCalls += 1;
        return queue[3]; // D
      }
    };

    const coord = new NextTrackCoordinator({
      getState: () => state,
      getShuffleProvider: () => provider
    });

    const preloadPlan = await coord.reserve();
    const playPlan = await coord.reserve();
    const committed = coord.commit(playPlan.token);

    assert.strictEqual(providerCalls, 1, 'Shuffle provider must only be called once');
    assert.strictEqual(preloadPlan.trackId, 'D');
    assert.strictEqual(committed.trackId, 'D');
    assert.strictEqual(preloadPlan.trackId, committed.trackId);
    assert.strictEqual(coord.peek(), null, 'Reservation consumed after commit');
  });

  test('2. Shuffle fallback random: preload and playback use exact same selection without re-rolling', async () => {
    const queue = makeQueue();
    const state = { queue, queueIndex: 0, currentTrack: queue[0], isShuffle: true, isAutoRemix: false, queueHistory: [0], repeatMode: 'off' };
    const coord = new NextTrackCoordinator({ getState: () => state });

    const preloadPlan = await coord.reserve();
    const committed = coord.commit();

    assert.ok(preloadPlan && committed);
    assert.strictEqual(preloadPlan.policy, 'shuffle');
    assert.strictEqual(preloadPlan.trackId, committed.trackId);
    assert.strictEqual(preloadPlan.targetIndex, committed.targetIndex);
  });

  test('3. Better Shuffle Smart mode: provider reserve/commit/cancel adapter preserves candidate even if provider would return new recommendation', async () => {
    const queue = makeQueue();
    const state = { queue, queueIndex: 0, currentTrack: queue[0], isShuffle: true, isAutoRemix: false, queueHistory: [0], repeatMode: 'off' };
    let callIdx = 0;
    let committedTrack = null;
    let cancelledReason = null;
    const smartProvider = {
      reserve: async () => {
        callIdx += 1;
        return callIdx === 1 ? queue[3] : queue[2];
      },
      commit: (track) => { committedTrack = track; },
      cancel: (reason) => { cancelledReason = reason; }
    };

    const coord = new NextTrackCoordinator({
      getState: () => state,
      getShuffleProvider: () => smartProvider
    });

    const p1 = await coord.reserve();
    const p2 = await coord.reserve();
    assert.strictEqual(p1.trackId, 'D');
    assert.strictEqual(p2.trackId, 'D');
    assert.strictEqual(callIdx, 1);

    const c = coord.commit(p1.token);
    assert.strictEqual(c.trackId, 'D');
    assert.strictEqual(committedTrack.id, 'D');

    // Next reservation after cancel notifies provider.cancel
    await coord.reserve();
    coord.cancel('mode_changed');
    assert.strictEqual(cancelledReason, 'mode_changed');
  });

  test('4. AutoMix Equal Power: preloads sequential target (skipping blocked tracks)', async () => {
    const queue = makeQueue();
    const state = { queue, queueIndex: 0, currentTrack: queue[0], isShuffle: false, isAutoRemix: true, repeatMode: 'off' };
    const am = new AutoMixDJ({ enabled: true, mode: 'equal_power' });
    const coord = new NextTrackCoordinator({
      getState: () => state,
      getAutoMix: () => am,
      isTrackBlocked: (t) => t.id === 'B'
    });

    const plan = await coord.reserve();
    assert.strictEqual(plan.policy, 'normal');
    assert.strictEqual(plan.trackId, 'C');
    assert.strictEqual(plan.targetIndex, 2);
  });

  test('5. AutoMix Tempo Synced picks D: preload D, crossfade D, handover D with single pickTempoSyncedNext call', async () => {
    const queue = makeQueue();
    const state = { queue, queueIndex: 0, currentTrack: queue[0], isShuffle: false, isAutoRemix: true, autoMixPlayedIds: new Set(['A']), repeatMode: 'off' };
    const am = new AutoMixDJ({ enabled: true, mode: 'tempo_synced' });
    let pickCalls = 0;
    const origPick = am.pickTempoSyncedNext.bind(am);
    am.pickTempoSyncedNext = (...args) => {
      pickCalls += 1;
      return origPick(...args);
    };

    const coord = new NextTrackCoordinator({
      getState: () => state,
      getAutoMix: () => am
    });

    const preloadPlan = await coord.reserve();
    const triggerPlan = await coord.reserve();
    const handoverPlan = coord.commit(triggerPlan.token);

    assert.strictEqual(pickCalls, 1, 'pickTempoSyncedNext must only be called once');
    assert.strictEqual(preloadPlan.trackId, 'D');
    assert.strictEqual(triggerPlan.trackId, 'D');
    assert.strictEqual(handoverPlan.trackId, 'D');
    assert.strictEqual(handoverPlan.targetIndex, 3);
  });

  test('6. keepAlbumContinuous: same album selects sequential next track', async () => {
    const queue = [
      { id: 'A1', title: 'A1', album: 'SameAlbum', platform: 'ytmusic', _detectedBpm: 120 },
      { id: 'A2', title: 'A2', album: 'SameAlbum', platform: 'ytmusic', _detectedBpm: 85 },
      { id: 'D1', title: 'D1', album: 'OtherAlbum', platform: 'ytmusic', _detectedBpm: 120 }
    ];
    const state = { queue, queueIndex: 0, currentTrack: queue[0], isShuffle: false, isAutoRemix: true, autoMixPlayedIds: new Set(['A1']), repeatMode: 'off' };
    const am = new AutoMixDJ({ enabled: true, mode: 'tempo_synced' });
    const coord = new NextTrackCoordinator({
      getState: () => state,
      getAutoMix: () => am
    });

    const plan = await coord.reserve();
    assert.strictEqual(plan.trackId, 'A2');
    assert.strictEqual(plan.targetIndex, 1);
  });

  test('7. Queue reorder during preload cancels stale candidate', async () => {
    const queue = makeQueue();
    const state = { queue, queueIndex: 0, currentTrack: queue[0], isShuffle: true, isAutoRemix: false, repeatMode: 'off' };
    let resolveSlow;
    const slowProvider = {
      fn: () => new Promise(r => { resolveSlow = r; })
    };
    const coord = new NextTrackCoordinator({
      getState: () => state,
      getShuffleProvider: () => slowProvider
    });

    const pStale = coord.reserve();
    coord.cancel('queue_reordered');
    resolveSlow(queue[3]);
    const staleResult = await pStale;

    assert.strictEqual(staleResult, null, 'Stale reservation must be discarded after cancel');
    assert.strictEqual(coord.peek(), null);
  });

  test('8. Manual Next while preload is in-flight commits immediately without waiting for preload', async () => {
    const queue = makeQueue();
    const state = { queue, queueIndex: 0, currentTrack: queue[0], isShuffle: false, isAutoRemix: false, repeatMode: 'off' };
    const coord = new NextTrackCoordinator({ getState: () => state });

    const plan = await coord.reserve();
    // Simulate slow preload in-flight (never awaited by commit)
    let preloadFinished = false;
    const slowPreload = new Promise(r => setTimeout(() => { preloadFinished = true; r(); }, 200));

    const committed = coord.commit(plan.token);
    assert.strictEqual(committed.trackId, 'B');
    assert.strictEqual(preloadFinished, false, 'Manual Next must not wait for in-flight preload');
    await slowPreload;
  });

  test('9. Missing BPM/key: Tempo Synced falls back to Shuffle if enabled, else Normal Queue without blocking', async () => {
    const queue = [
      { id: 'A', title: 'A', platform: 'ytmusic' },
      { id: 'B', title: 'B', platform: 'ytmusic' },
      { id: 'C', title: 'C', platform: 'ytmusic' }
    ];
    const state = { queue, queueIndex: 0, currentTrack: queue[0], isShuffle: true, isAutoRemix: true, autoMixPlayedIds: new Set(['A']), repeatMode: 'off' };
    const am = new AutoMixDJ({ enabled: true, mode: 'tempo_synced' });
    const coord = new NextTrackCoordinator({
      getState: () => state,
      getAutoMix: () => am,
      getShuffleProvider: () => ({ fn: async () => queue[2] })
    });

    const plan = await coord.reserve();
    assert.strictEqual(plan.policy, 'shuffle');
    assert.strictEqual(plan.trackId, 'C');
  });

  test('10. Toggling AutoMix and Shuffle invalidates old reservation and switches policy cleanly', async () => {
    const queue = makeQueue();
    const state = { queue, queueIndex: 0, currentTrack: queue[0], isShuffle: true, isAutoRemix: false, autoMixPlayedIds: new Set(['A']), repeatMode: 'off' };
    const am = new AutoMixDJ({ enabled: false, mode: 'tempo_synced' });
    const coord = new NextTrackCoordinator({
      getState: () => state,
      getAutoMix: () => am,
      getShuffleProvider: () => ({ fn: async () => queue[2] })
    });

    const shufflePlan = await coord.reserve();
    assert.strictEqual(shufflePlan.trackId, 'C');

    // Toggle to AutoMix Tempo Synced
    state.isShuffle = false;
    state.isAutoRemix = true;
    am.enabled = true;
    coord.cancel('automix_mode_changed');

    const amPlan = await coord.reserve();
    assert.strictEqual(amPlan.policy, 'tempo_synced');
    assert.strictEqual(amPlan.trackId, 'D');
  });

  test('11. First track Fast-Start Low + Coordinator next candidate preloaded at Max/High', async () => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname === '/api/stream-info') {
        const id = u.searchParams.get('id');
        const quality = u.searchParams.get('quality');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: true,
          streamUrl: `http://127.0.0.1:${server.address().port}/audio/${id}_${quality}.m4a`,
          proxyUrl: `http://127.0.0.1:${server.address().port}/audio/${id}_${quality}.m4a`
        }));
      }
      res.writeHead(206);
      res.end();
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    try {
      const queue = makeQueue();
      const state = { queue, queueIndex: 0, currentTrack: queue[0], isShuffle: true, isAutoRemix: false, repeatMode: 'off' };
      const coord = new NextTrackCoordinator({
        getState: () => state,
        getShuffleProvider: () => ({ fn: async () => queue[3] })
      });
      const pm = new PreloadManager({ apiBase: `http://127.0.0.1:${port}` });

      const firstUrl = await pm.resolveStreamUrl(queue[0], 'low');
      assert.ok(firstUrl.includes('A_low.m4a'));

      const nextPlan = await coord.reserve();
      const nextUrl = await pm.resolveStreamUrl(nextPlan.track, 'max');
      assert.strictEqual(nextPlan.trackId, 'D');
      assert.ok(nextUrl.includes('D_max.m4a'));
      assert.strictEqual(coord.commit(nextPlan.token).trackId, 'D');
    } finally {
      server.close();
    }
  });

  test('12. Wiring check: app.js and integration-bridge.js share NextTrackCoordinator without duplicate selection', () => {
    const appSrc = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
    const bridgeSrc = fs.readFileSync(path.join(__dirname, '../src/renderer/ui/integration-bridge.js'), 'utf8');

    assert.match(appSrc, /window\._eclipseNextTrackCoordinator = nextTrackCoordinator/);
    assert.match(appSrc, /const plan = await nextTrackCoordinator\.reserve\(\);\s*const committed = plan \? nextTrackCoordinator\.commit\(plan\.token\) : null;/);
    assert.match(bridgeSrc, /const coord = window\._eclipseNextTrackCoordinator;/);
    assert.match(bridgeSrc, /reservationToken:\s*reservedPlanToken/);
  });
});
