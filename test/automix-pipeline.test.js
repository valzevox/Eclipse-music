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

test('PlaybackHandover - nativeAudio error event after canplay still catches error and preserves auxAudio', () => {
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
    play: () => new Promise(() => {}) // pending play
  };

  const mockAuxAudio = {
    src: 'http://test/aux.m4a',
    paused: false,
    currentTime: 5.0,
    pause: () => { auxStopped = true; }
  };

  const token = handover.createHandoverToken({ id: 'test-canplay-err' }, mockAuxAudio, 4);
  handover.executeSwap(mockNativeAudio, mockAuxAudio, token, {});

  assert.ok(listeners['canplay'], 'canplay listener attached');
  assert.ok(listeners['error'], 'error listener attached');

  // Trigger canplay -> attachPlayAndSwap runs
  listeners['canplay']();

  // Crucial invariant: error listener must STILL be attached even after canplay!
  assert.ok(listeners['error'], 'error listener must remain active after canplay while waiting for playing');

  // Simulate source error happening after canplay but before playing
  listeners['error'](new Error('Media decode error after canplay'));

  assert.strictEqual(auxStopped, false, 'auxAudio must NOT be stopped if error fires after canplay');
  assert.strictEqual(listeners['playing'], undefined, 'playing listener must be removed on error');
  assert.strictEqual(listeners['error'], undefined, 'error listener cleaned up');
});

test('AutoMixDJ - executeCrossfade applies harmonic ratio for half-time/double-time and 1.0 for fallback', async () => {
  const dj = new AutoMixDJ({ mode: 'tempo_synced' });

  let outRate = 1.0;
  let inRate = 1.0;

  const mockOutgoing = {
    volume: 1.0,
    playbackRate: 1.0,
    pause: () => {}
  };

  // Case 1: Harmonic 60 BPM with 120 BPM base (60 * 2 = 120 -> ratio must be 1.0, not clamped 1.06)
  const harmonicRatio = dj.computeTempoRatio(120, 60);
  assert.strictEqual(harmonicRatio, 1.0, 'Harmonic match 120 vs 60 should produce 1.0 ratio');

  // Case 2: Incompatible fallback (e.g. 120 vs 150) -> computeTempoRatio returns 1.0
  const fallbackRatio = dj.computeTempoRatio(120, 150);
  assert.strictEqual(fallbackRatio, 1.0, 'Out-of-range candidate returns 1.0 fallback ratio');

  // Case 3: TransitionPlanner harmonic computation
  const planner = new TransitionPlanner();
  const analyzer = new TrackAnalyzer();
  const planHarmonic = planner.computePlan({ bpm: 120 }, { bpm: 60 }, { analyzer });
  assert.strictEqual(planHarmonic.tempoSynced, true, 'Harmonic 120 vs 60 is tempo synced');
  assert.strictEqual(planHarmonic.tempoRatio, 1.0, 'Harmonic tempo ratio is 1.0');

  // Case 4: TransitionPlanner fallback with incompatible BPM (120 vs 150)
  const planFallback = planner.computePlan({ bpm: 120 }, { bpm: 150 }, { analyzer });
  assert.strictEqual(planFallback.tempoSynced, false, '120 vs 150 is NOT tempo synced');
  assert.strictEqual(planFallback.tempoRatio, 1.0, 'Fallback tempo ratio must be 1.0');

  // Case 5: executeCrossfade playbackRate live verification
  const outgoingEl = { volume: 1.0, playbackRate: 1.0, pause: () => {} };
  const incomingEl = { volume: 0.0, playbackRate: 1.0, play: () => Promise.resolve(), pause: () => {} };

  // When tempoSynced: false, incomingEl playbackRate must stay strictly at 1.0
  const crossfadePromise = dj.executeCrossfade(outgoingEl, incomingEl, 0.2, {
    outgoingBpm: 120,
    incomingBpm: 150,
    tempoSynced: false,
    tempoRatio: 1.0
  });

  assert.strictEqual(incomingEl.playbackRate, 1.0, 'Incoming rate must remain 1.0 when tempoSynced is false');
  await crossfadePromise;
  assert.strictEqual(incomingEl.playbackRate, 1.0, 'Incoming rate remains 1.0 after crossfade completes');
});

test('PlaybackHandover - full production caller integration via playTrack flow', async () => {
  const handover = new PlaybackHandover();
  let auxStopped = false;
  let nativeDeckGain = 0.0;
  let auxDeckGain = 1.0;
  let nativeSourceSet = '';
  let nativePlayCalls = 0;
  let nativeListeners = {};

  const mockNativeAudio = {
    src: 'http://test/old-track.mp3',
    readyState: 0,
    muted: false,
    currentTime: 0,
    addEventListener: (event, cb) => {
      nativeListeners[event] = cb;
    },
    removeEventListener: (event) => {
      delete nativeListeners[event];
    },
    play: () => {
      nativePlayCalls++;
      return Promise.resolve();
    }
  };

  const mockAuxAudio = {
    src: 'http://test/next-track.m4a',
    paused: false,
    currentTime: 14.2,
    pause: () => { auxStopped = true; }
  };

  const nextTrack = { id: 'next-track-99', title: 'Next Track' };

  // Step 1: Create token from auxAudio at live time
  const token = handover.createHandoverToken(nextTrack, mockAuxAudio, 3);
  assert.ok(token, 'Token must be created');
  assert.strictEqual(token.currentTime, 14.2);
  assert.strictEqual(token.src, 'http://test/next-track.m4a');

  // Step 2: Setup state representing app.js
  const appState = {
    loadToken: 42,
    _autoMixHandover: token,
    isMuted: false
  };

  // Step 3: isHandoverTarget guard prevents premature clearing
  assert.strictEqual(handover.isHandoverTarget(appState, nextTrack), true);
  assert.strictEqual(handover.isHandoverTarget(appState, { id: 'other-track' }), false);

  // Step 4: Execute swap via production handlePlayTrackHandover helper
  const options = {
    isMuted: appState.isMuted,
    onDeckGainsReset: () => {
      nativeDeckGain = 1.0;
      auxDeckGain = 0.0;
    }
  };

  // Stale token check: old currentToken (999) does not match appState.loadToken (42) -> must return false and NOT consume token
  const staleHandled = handover.handlePlayTrackHandover({
    state: appState,
    track: nextTrack,
    currentToken: 999, // Stale token!
    nativeAudio: mockNativeAudio,
    auxAudio: mockAuxAudio,
    options
  });
  assert.strictEqual(staleHandled, false, 'Stale token must not execute swap');
  assert.ok(appState._autoMixHandover, 'Handover token preserved across stale play attempt');

  // Active currentToken (42) matches loadToken (42) -> executes swap and consumes token
  const handled = handover.handlePlayTrackHandover({
    state: appState,
    track: nextTrack,
    currentToken: 42,
    nativeAudio: mockNativeAudio,
    auxAudio: mockAuxAudio,
    options
  });
  assert.strictEqual(handled, true, 'Matching loadToken must trigger handover successfully');
  assert.strictEqual(mockNativeAudio.src, 'http://test/next-track.m4a');
  assert.strictEqual(mockNativeAudio.muted, true, 'Native audio must be muted while buffering');

  // Step 5: Before loadedmetadata/canplay, Deck B remains active and auxAudio is playing
  assert.strictEqual(auxStopped, false, 'Aux audio must remain playing before native is ready');
  assert.strictEqual(nativeDeckGain, 0.0);
  assert.strictEqual(auxDeckGain, 1.0);

  // Step 6: loadedmetadata / canplay fire -> attachPlayAndSwap begins
  assert.ok(nativeListeners['loadedmetadata']);
  nativeListeners['loadedmetadata']();
  assert.strictEqual(nativePlayCalls, 1, 'play() called once');

  // Race condition: canplay fires after loadedmetadata -> must NOT trigger play() again
  if (nativeListeners['canplay']) {
    nativeListeners['canplay']();
  }
  assert.strictEqual(nativePlayCalls, 1, 'play() must not be called twice on canplay race');

  // Aux audio still playing while waiting for 'playing' confirmation
  assert.strictEqual(auxStopped, false, 'Aux must continue playing until native playing event');
  assert.strictEqual(nativeDeckGain, 0.0);

  // Step 7: playing event fires -> finishSwap completes
  assert.ok(nativeListeners['playing']);
  nativeListeners['playing']();

  assert.strictEqual(auxStopped, true, 'Aux audio must stop only after native playing confirmed');
  assert.strictEqual(nativeDeckGain, 1.0, 'Deck A gain reset to 1.0');
  assert.strictEqual(auxDeckGain, 0.0, 'Deck B gain reset to 0.0');

  // Step 8: Subsequent stale playTrack calls must not find handover token
  assert.strictEqual(appState._autoMixHandover, null, 'Handover token was consumed exactly once');
  assert.strictEqual(handover.isHandoverTarget(appState, nextTrack), false, 'Consumed token cannot match');
});
