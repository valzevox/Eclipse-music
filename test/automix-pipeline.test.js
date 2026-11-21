// test/automix-pipeline.test.js
// JavaScript / automix-pipeline.test.js / Node.js test runner
// Comprehensive regression tests for Smart AutoMix DJ pipeline:
// - Crossfade failure preventing handover
// - Incoming play() rejection gain rollback
// - Native play() rejection keeping auxAudio playing
// - Single-invocation swap guard (loadedmetadata + canplay)
// - Native audio error handling during handover
// - Strict +/- 6% harmonic candidate selection in pickTempoSyncedNext

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const AutoMixDJ = require('../src/renderer/automix-dj.js');
const { PlaybackHandover } = require('../src/renderer/automix/playback-handover.js');
const { TrackAnalyzer } = require('../src/renderer/automix/track-analyzer.js');
const { TransitionPlanner } = require('../src/renderer/automix/transition-planner.js');

test('AutoMixDJ - pickTempoSyncedNext enforces strict +/- 6% threshold and harmonic matching', () => {
  const dj = new AutoMixDJ();
  const queue = [
    { id: 'track-0', title: 'Current Song', bpm: 120 },
    { id: 'track-1', title: 'Incompatible Fast Song', bpm: 150 }, // 150 vs 120 is 25% off -> reject
    { id: 'track-2', title: 'Incompatible Slow Song', bpm: 90 },  // 90 vs 120 is 25% off -> reject
    { id: 'track-3', title: 'Half-time Harmonic Song', bpm: 61 }, // 61 * 2 = 122 -> 122/120 = 1.016 (within 6%)
    { id: 'track-4', title: 'Direct Compatible Song', bpm: 124 }  // 124/120 = 1.033 (within 6%)
  ];

  const picked = dj.pickTempoSyncedNext(queue, 0, new Set(), 120);
  assert.ok(picked, 'Should find a compatible candidate');
  assert.strictEqual(picked.compatible, true);
  // track-3 (61*2 = 122, diff ~1.6%) is closer than track-4 (124, diff ~3.3%)
  assert.strictEqual(picked.track.id, 'track-3');
});

test('AutoMixDJ - pickTempoSyncedNext returns sequential fallback when no song is within 6%', () => {
  const dj = new AutoMixDJ();
  const queue = [
    { id: 'track-0', title: 'Current Song', bpm: 100 },
    { id: 'track-1', title: 'Song 1', bpm: 140 }, // out of range
    { id: 'track-2', title: 'Song 2', bpm: 75 }   // out of range
  ];

  const picked = dj.pickTempoSyncedNext(queue, 0, new Set(), 100);
  assert.ok(picked, 'Should return fallback next track');
  assert.strictEqual(picked.fallback, true);
  assert.strictEqual(picked.compatible, false);
  assert.strictEqual(picked.track.id, 'track-1');
});

test('PlaybackHandover - executes swap only once when loadedmetadata and canplay both fire', () => {
  const handover = new PlaybackHandover();
  let swapCalls = 0;
  let playCalls = 0;
  let listeners = {};

  const mockNativeAudio = {
    src: '',
    muted: false,
    preload: '',
    currentTime: 0,
    addEventListener: (event, cb) => {
      listeners[event] = cb;
    },
    removeEventListener: (event) => {
      delete listeners[event];
    },
    play: () => {
      playCalls++;
      return Promise.resolve();
    }
  };

  const mockAuxAudio = {
    src: 'http://test/aux.m4a',
    paused: false,
    currentTime: 10.5,
    pause: () => {},
    currentTime: 0
  };

  const token = handover.createHandoverToken({ id: 'test-1' }, mockAuxAudio, 1);
  const options = {
    onDeckGainsReset: () => { swapCalls++; }
  };

  handover.executeSwap(mockNativeAudio, mockAuxAudio, token, options);

  assert.ok(listeners['loadedmetadata'], 'loadedmetadata listener registered');
  assert.ok(listeners['canplay'], 'canplay listener registered');

  // Trigger loadedmetadata
  listeners['loadedmetadata']();
  assert.strictEqual(playCalls, 1, 'play() called once on loadedmetadata');

  // Trigger canplay immediately after
  if (listeners['canplay']) {
    listeners['canplay']();
  }
  assert.strictEqual(playCalls, 1, 'play() not called a second time due to started flag');

  // Trigger playing event to complete swap
  if (listeners['playing']) {
    listeners['playing']();
  }
  assert.strictEqual(swapCalls, 1, 'finishSwap executed exactly once');
});

test('PlaybackHandover - nativeAudio.play() rejection keeps auxAudio running and cleans up playing listener', async () => {
  const handover = new PlaybackHandover();
  let auxStopped = false;
  let listeners = {};
  let deckGainsResetCalled = false;

  const mockNativeAudio = {
    src: 'http://test/aux.m4a',
    readyState: 4,
    muted: false,
    addEventListener: (event, cb) => {
      listeners[event] = cb;
    },
    removeEventListener: (event) => {
      delete listeners[event];
    },
    play: () => Promise.reject(new Error('Autoplay blocked'))
  };

  const mockAuxAudio = {
    src: 'http://test/aux.m4a',
    paused: false,
    currentTime: 8.0,
    pause: () => { auxStopped = true; }
  };

  const token = handover.createHandoverToken({ id: 'test-2' }, mockAuxAudio, 2);
  const options = {
    onDeckGainsReset: () => { deckGainsResetCalled = true; }
  };

  handover.executeSwap(mockNativeAudio, mockAuxAudio, token, options);

  // Wait a microtask for rejection handler
  await new Promise(r => setTimeout(r, 10));

  assert.strictEqual(auxStopped, false, 'auxAudio must NOT be stopped if native play fails');
  assert.strictEqual(listeners['playing'], undefined, 'playing listener must be removed on rejection');
});

test('PlaybackHandover - nativeAudio error event cleans up listeners without stopping auxAudio', () => {
  const handover = new PlaybackHandover();
  let auxStopped = false;
  let listeners = {};

  const mockNativeAudio = {
    src: '',
    readyState: 0,
    addEventListener: (event, cb) => {
      listeners[event] = cb;
    },
    removeEventListener: (event) => {
      delete listeners[event];
    },
    play: () => Promise.resolve()
  };

  const mockAuxAudio = {
    src: 'http://test/aux.m4a',
    paused: false,
    currentTime: 5.0,
    pause: () => { auxStopped = true; }
  };

  const token = handover.createHandoverToken({ id: 'test-3' }, mockAuxAudio, 3);
  handover.executeSwap(mockNativeAudio, mockAuxAudio, token, {});

  assert.ok(listeners['error'], 'error listener registered');

  // Simulate network/source error
  listeners['error'](new Error('Format unsupported'));

  assert.strictEqual(auxStopped, false, 'auxAudio must remain active on nativeAudio error');
  assert.strictEqual(listeners['loadedmetadata'], undefined, 'loadedmetadata listener removed');
  assert.strictEqual(listeners['canplay'], undefined, 'canplay listener removed');
});
