const test = require('node:test');
const assert = require('node:assert');
const { EclipsePreloadManager } = require('../src/renderer/preload-manager');

test('EclipsePreloadManager: Trending Sequential Preload queues at most top 3 tracks', async () => {
  const executed = [];
  const manager = new EclipsePreloadManager({
    isOffline: () => false,
    isDataSaver: () => false
  });

  // Mock execution
  manager._executePreload = async (track, type) => {
    executed.push({ id: track.id, type });
  };

  const sampleTracks = [
    { id: 'track_1', title: 'Song 1' },
    { id: 'track_2', title: 'Song 2' },
    { id: 'track_3', title: 'Song 3' },
    { id: 'track_4', title: 'Song 4' },
    { id: 'track_5', title: 'Song 5' }
  ];

  manager.queueTrendingSequential(sampleTracks);
  assert.strictEqual(manager.trendingQueue.length, 2); // 1st started immediately, 2 remaining in queue
  await new Promise(r => setTimeout(r, 400));

  assert.strictEqual(executed.length, 3);
  assert.deepStrictEqual(executed.map(x => x.id), ['track_1', 'track_2', 'track_3']);
  assert.strictEqual(executed[0].type, 'trending');
});

test('EclipsePreloadManager: Hover Preload preempts active trending preload and executes first', async () => {
  const logs = [];
  let abortCalled = false;

  const manager = new EclipsePreloadManager({
    debounceMs: 50,
    isOffline: () => false,
    isDataSaver: () => false
  });

  manager._resolveStreamInfo = async (track, signal) => {
    signal.addEventListener('abort', () => { abortCalled = true; });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => resolve({ streamUrl: 'http://test/audio.mp3', proxyUrl: 'http://test/proxy' }), 100);
      signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); });
    });
    return { streamUrl: 'http://test/audio.mp3', proxyUrl: 'http://test/proxy' };
  };
  manager._warmUpRange = async () => {};

  // Start trending task
  manager._executePreload({ id: 'trending_long', title: 'Trending' }, 'trending').catch(() => {});
  assert.strictEqual(manager.activeTask.type, 'trending');

  // User hovers on a different card
  manager.onTrackHover({ id: 'hover_urgent', title: 'Hovered Song' });
  await new Promise(r => setTimeout(r, 70)); // wait debounce

  assert.strictEqual(abortCalled, true);
  assert.strictEqual(manager.activeTask.trackKey, 'hover_urgent');
  assert.strictEqual(manager.activeTask.type, 'hover');
});

test('EclipsePreloadManager: Hover debounce cancels if mouse leaves before debounce timer', async () => {
  let executed = false;
  const manager = new EclipsePreloadManager({
    debounceMs: 100,
    isOffline: () => false,
    isDataSaver: () => false
  });
  manager._executePreload = async () => { executed = true; };

  const track = { id: 'hover_fast', title: 'Flick' };
  manager.onTrackHover(track);
  assert.strictEqual(manager.hoverTimers.size, 1);

  // Mouse leaves within 30ms (< 100ms debounce)
  await new Promise(r => setTimeout(r, 30));
  manager.onTrackLeave(track);
  assert.strictEqual(manager.hoverTimers.size, 0);

  await new Promise(r => setTimeout(r, 120));
  assert.strictEqual(executed, false);
});

test('EclipsePreloadManager: Data Saver and Offline states prevent speculative preload', async () => {
  let executed = false;
  let offline = true;

  const manager = new EclipsePreloadManager({
    isOffline: () => offline,
    isDataSaver: () => false
  });
  manager._executePreload = async () => { executed = true; };

  manager.queueTrendingSequential([{ id: 'trend_off', title: 'Song' }]);
  manager.onTrackHover({ id: 'hover_off', title: 'Song' });
  await new Promise(r => setTimeout(r, 250));

  assert.strictEqual(executed, false);
  assert.strictEqual(manager.trendingQueue.length, 0);
});

test('EclipsePreloadManager: LRU Caching deduplicates repeated preload requests', async () => {
  let callCount = 0;
  const manager = new EclipsePreloadManager({
    debounceMs: 10,
    isOffline: () => false,
    isDataSaver: () => false
  });

  manager._resolveStreamInfo = async () => {
    callCount++;
    return { streamUrl: 'http://test/stream.m4a', proxyUrl: 'http://test/proxy' };
  };
  manager._warmUpRange = async () => {};

  const track = { id: 'repeat_track', title: 'Repeat Me' };
  manager.onTrackHover(track);
  await new Promise(r => setTimeout(r, 30));
  assert.strictEqual(callCount, 1);
  assert.strictEqual(manager.hasCached(track), true);

  // Hover again
  manager.onTrackHover(track);
  await new Promise(r => setTimeout(r, 30));
  assert.strictEqual(callCount, 1); // Not called again, served from cache
});
