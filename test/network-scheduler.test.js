// test/network-scheduler.test.js
// Unit tests for NetworkPriorityScheduler: priority ordering, concurrency, dedup, generation, AbortSignal accounting
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { NetworkPriorityScheduler, Priority } = require('../src/server/network-scheduler');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('NetworkPriorityScheduler: executes higher priority tasks before lower priority tasks', async () => {
  const scheduler = new NetworkPriorityScheduler({ profile: 'constrained', autoCacheEnabled: true });
  // constrained maxConcurrent = 2; occupy both slots first
  const order = [];
  let releaseSlots;
  const gate = new Promise((r) => { releaseSlots = r; });

  const p1 = scheduler.schedule({ priority: Priority.PLAYBACK_AUDIO, fn: () => gate });
  const p2 = scheduler.schedule({ priority: Priority.PLAYBACK_AUDIO, fn: () => gate });

  const low = scheduler.schedule({ priority: Priority.BACKGROUND_DOWNLOAD, explicitOptIn: true, fn: async () => { order.push('bg'); } });
  const mid = scheduler.schedule({ priority: Priority.VISIBLE_ARTWORK_LYRICS, fn: async () => { order.push('art'); } });
  const high = scheduler.schedule({ priority: Priority.PLAYBACK_SEEK, fn: async () => { order.push('seek'); } });

  releaseSlots();
  await Promise.all([p1, p2, low, mid, high]);
  assert.deepEqual(order, ['seek', 'art', 'bg']);
});

test('NetworkPriorityScheduler: keeps active accounting until aborted task actually exits', async () => {
  const scheduler = new NetworkPriorityScheduler({ profile: 'normal', autoCacheEnabled: true });
  let taskExited = false;
  let activeDuringAbort = 0;

  const bgTask = scheduler.schedule({
    priority: Priority.SPECULATIVE_PRELOAD,
    fn: (signal) => new Promise((resolve) => {
      signal.addEventListener('abort', async () => {
        activeDuringAbort = scheduler.getStats().activeCount;
        await sleep(30);
        taskExited = true;
        resolve('aborted_cleanly');
      }, { once: true });
    })
  });

  await sleep(10);
  scheduler.setPlaybackBuffering(true);
  assert.equal(activeDuringAbort, 1, 'Active task must remain in accounting until underlying operation exits');
  assert.equal(taskExited, false);
  assert.equal(await bgTask, 'aborted_cleanly');
  assert.equal(scheduler.getStats().activeCount, 0);
});

test('NetworkPriorityScheduler: generation invalidation rejects stale queued NEXT_TRACK_PREP tasks', async () => {
  const scheduler = new NetworkPriorityScheduler({ profile: 'constrained', autoCacheEnabled: true });
  let release;
  const gate = new Promise((r) => { release = r; });
  const s1 = scheduler.schedule({ priority: Priority.PLAYBACK_AUDIO, fn: () => gate });
  const s2 = scheduler.schedule({ priority: Priority.PLAYBACK_AUDIO, fn: () => gate });

  const gen0 = scheduler.generation;
  const stalePrep = scheduler.schedule({
    priority: Priority.NEXT_TRACK_PREP,
    generation: gen0,
    fn: async () => 'should_not_run'
  });

  scheduler.bumpGeneration();
  release();
  await Promise.all([s1, s2]);
  await assert.rejects(stalePrep, (err) => err && err.code === 'STALE_GENERATION');
});

test('NetworkPriorityScheduler: queued background download obeys profile switch to constrained before drain', async () => {
  const scheduler = new NetworkPriorityScheduler({ profile: 'normal', autoCacheEnabled: true });
  // normal maxConcurrent = 4; occupy all 4 slots
  let release;
  const gate = new Promise((r) => { release = r; });
  const blockers = [
    scheduler.schedule({ priority: Priority.PLAYBACK_AUDIO, fn: () => gate }),
    scheduler.schedule({ priority: Priority.PLAYBACK_AUDIO, fn: () => gate }),
    scheduler.schedule({ priority: Priority.PLAYBACK_AUDIO, fn: () => gate }),
    scheduler.schedule({ priority: Priority.PLAYBACK_AUDIO, fn: () => gate })
  ];

  let bgRan = false;
  const bgQueued = scheduler.schedule({
    priority: Priority.BACKGROUND_DOWNLOAD,
    explicitOptIn: false,
    fn: async () => { bgRan = true; }
  });

  // Switch to constrained before queued background task drains
  scheduler.setProfile('constrained');
  release();
  await Promise.all(blockers);
  await sleep(20);
  assert.equal(bgRan, false, 'Queued background download without explicitOptIn must not run after switching to constrained');
  assert.equal(scheduler.getStats().queuedCount, 1);
  // Clean up by switching back to normal
  scheduler.setProfile('normal');
  await bgQueued;
});

test('NetworkPriorityScheduler: playback buffering aborts active NEXT_TRACK_PREP and VISIBLE_ARTWORK_LYRICS', async () => {
  const scheduler = new NetworkPriorityScheduler({ profile: 'normal', autoCacheEnabled: true });
  let prepAborted = false;
  let artAborted = false;

  const prep = scheduler.schedule({
    priority: Priority.NEXT_TRACK_PREP,
    fn: (signal) => new Promise((resolve) => {
      signal.addEventListener('abort', () => { prepAborted = true; resolve('aborted'); }, { once: true });
    })
  });
  const art = scheduler.schedule({
    priority: Priority.VISIBLE_ARTWORK_LYRICS,
    fn: (signal) => new Promise((resolve) => {
      signal.addEventListener('abort', () => { artAborted = true; resolve('aborted'); }, { once: true });
    })
  });

  await sleep(10);
  scheduler.setPlaybackBuffering(true);
  await Promise.all([prep, art]);
  assert.equal(prepAborted, true);
  assert.equal(artAborted, true);
});
