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
const { VolumeSyncSuppressionManager, volumeSyncSuppression } = require('../src/renderer/automix/suppression-controller.js');

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

  // Stale token check: old currentToken (999) does not match appState.loadToken (42) -> returns status 'stale', does NOT consume token or execute swap
  const staleHandled = handover.handlePlayTrackHandover({
    state: appState,
    track: nextTrack,
    currentToken: 999, // Stale token!
    nativeAudio: mockNativeAudio,
    auxAudio: mockAuxAudio,
    options
  });
  assert.strictEqual(staleHandled.status, 'stale', 'Stale token must return status stale');
  assert.strictEqual(nativePlayCalls, 0, 'Stale token must not invoke nativeAudio.play()');
  assert.ok(appState._autoMixHandover, 'Handover token preserved across stale play attempt');

  // Active currentToken (42) matches loadToken (42) -> returns status 'handled', executes swap and consumes token
  const handled = handover.handlePlayTrackHandover({
    state: appState,
    track: nextTrack,
    currentToken: 42,
    nativeAudio: mockNativeAudio,
    auxAudio: mockAuxAudio,
    options
  });
  assert.strictEqual(handled.status, 'handled', 'Matching loadToken must trigger handover successfully');
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

  // Step 9: Race condition test: newer load arrives while native audio is waiting for 'playing' -> older swap must abort and not finish swap
  const raceAppState = {
    loadToken: 100,
    _autoMixHandover: handover.createHandoverToken(nextTrack, mockAuxAudio, 4),
    isMuted: false
  };
  let raceNativeGain = 0.0;
  let raceAuxStopped = false;
  let raceListeners = {};
  const raceNativeAudio = {
    src: 'http://test/initial.mp3',
    readyState: 0,
    muted: false,
    currentTime: 0,
    addEventListener: (ev, fn) => { raceListeners[ev] = fn; },
    removeEventListener: (ev) => { delete raceListeners[ev]; },
    play: () => Promise.resolve()
  };
  const raceAuxAudio = {
    src: 'http://test/next-track.m4a',
    paused: false,
    currentTime: 20,
    pause: () => { raceAuxStopped = true; }
  };

  const raceResult = handover.handlePlayTrackHandover({
    state: raceAppState,
    track: nextTrack,
    currentToken: 100,
    nativeAudio: raceNativeAudio,
    auxAudio: raceAuxAudio,
    options: {
      onDeckGainsReset: () => { raceNativeGain = 1.0; }
    }
  });
  assert.strictEqual(raceResult.status, 'handled');
  // loadedmetadata fires and calls attachPlayAndSwap
  raceListeners['loadedmetadata']();
  assert.ok(raceListeners['playing'], 'Waiting for playing event');

  // Before playing fires, a newer track load increments loadToken to 101!
  raceAppState.loadToken = 101;

  // Now stale playing event fires -> finishSwap must check isOwnerInvocation() and abort without resetting gains or stopping aux
  raceListeners['playing']();
  assert.strictEqual(raceAuxStopped, false, 'Older swap must not stop auxAudio if newer loadToken took over');
  assert.strictEqual(raceNativeGain, 0.0, 'Older swap must not reset deck gains if newer loadToken took over');
});

test('PlaybackHandover - _autoMixSuppressVolumeSync ownership generation token prevents stale clearance (Cases A, B, C, D, E)', async () => {
  const handover = new PlaybackHandover();

  // Setup global mock window
  const originalWindow = global.window;
  global.window = {
    _autoMixSuppressVolumeSync: false,
    _autoMixSuppressOwnerToken: null,
    audioEngine: {
      setDeckGains: () => {}
    }
  };

  try {
    const createMockNative = (opts = {}) => {
      let listeners = {};
      return {
        src: opts.src || 'http://test/init.mp3',
        readyState: opts.readyState || 0,
        muted: false,
        currentTime: 0,
        listeners,
        addEventListener: (ev, cb) => { listeners[ev] = cb; },
        removeEventListener: (ev) => { delete listeners[ev]; },
        play: opts.play || (() => Promise.resolve())
      };
    };

    const createMockAux = () => ({
      src: 'http://test/aux.m4a',
      paused: false,
      currentTime: 10,
      pause: () => {}
    });

    // Case E: Normal completion clears suppression cleanly without leaving it stuck true
    {
      const nativeE = createMockNative();
      const auxE = createMockAux();
      const tokenE = handover.createHandoverToken({ id: 'track-e' }, auxE, 1);
      handover.executeSwap(nativeE, auxE, tokenE, {});
      assert.strictEqual(global.window._autoMixSuppressVolumeSync, true, 'Suppression enabled on start');
      const ownerE = global.window._autoMixSuppressOwnerToken;
      assert.ok(ownerE, 'Owner token assigned');

      nativeE.listeners['loadedmetadata']();
      assert.ok(nativeE.listeners['playing']);
      nativeE.listeners['playing'](); // finishSwap

      // Wait 100ms for delayed 80ms cleanup
      await new Promise(r => setTimeout(r, 100));
      assert.strictEqual(global.window._autoMixSuppressVolumeSync, false, 'Suppression cleared after normal completion');
      assert.strictEqual(global.window._autoMixSuppressOwnerToken, null, 'Owner token reset after normal completion');
    }

    // Case A: Stale playing callback does not clear B's suppression
    {
      const nativeA = createMockNative();
      const auxA = createMockAux();
      const stateA = { loadToken: 1 };
      const tokenA = handover.createHandoverToken({ id: 'track-a' }, auxA, 1);
      handover.executeSwap(nativeA, auxA, tokenA, { currentToken: 1, state: stateA });
      nativeA.listeners['loadedmetadata']();
      const stalePlayingCallbackA = nativeA.listeners['playing'];

      // Handover B starts
      const nativeB = createMockNative();
      const auxB = createMockAux();
      const stateB = { loadToken: 2 };
      stateA.loadToken = 2; // invalidate A
      const tokenB = handover.createHandoverToken({ id: 'track-b' }, auxB, 2);
      handover.executeSwap(nativeB, auxB, tokenB, { currentToken: 2, state: stateB });
      const ownerB = global.window._autoMixSuppressOwnerToken;
      assert.strictEqual(global.window._autoMixSuppressVolumeSync, true, 'B active and suppressing');

      // Stale callback A fires
      stalePlayingCallbackA();
      assert.strictEqual(global.window._autoMixSuppressVolumeSync, true, 'Stale A must not clear B suppression');
      assert.strictEqual(global.window._autoMixSuppressOwnerToken, ownerB, 'Owner token remains B');
    }

    // Case B: Stale error callback does not clear B's suppression or alter B's gain
    {
      const nativeA = createMockNative();
      const auxA = createMockAux();
      const stateA = { loadToken: 10 };
      const tokenA = handover.createHandoverToken({ id: 'track-a-err' }, auxA, 1);
      handover.executeSwap(nativeA, auxA, tokenA, { currentToken: 10, state: stateA });
      const staleErrorCallbackA = nativeA.listeners['error'];

      // Handover B starts
      const nativeB = createMockNative();
      const auxB = createMockAux();
      const stateB = { loadToken: 20 };
      stateA.loadToken = 20; // invalidate A
      const tokenB = handover.createHandoverToken({ id: 'track-b-err' }, auxB, 2);
      let bGainAltered = false;
      handover.executeSwap(nativeB, auxB, tokenB, {
        currentToken: 20,
        state: stateB,
        onDeckGainsReset: () => { bGainAltered = true; }
      });
      const ownerB = global.window._autoMixSuppressOwnerToken;

      // Stale error from A fires
      staleErrorCallbackA(new Error('Stale decode error A'));
      assert.strictEqual(global.window._autoMixSuppressVolumeSync, true, 'Stale error A must not clear B suppression');
      assert.strictEqual(global.window._autoMixSuppressOwnerToken, ownerB, 'Owner token remains B');
      assert.strictEqual(bGainAltered, false, 'Stale error A must not trigger gain changes for B');
    }

    // Case C: Stale play() Promise rejection does not clear B's suppression
    {
      let rejectPlayA;
      const nativeA = createMockNative({
        play: () => new Promise((_, rej) => { rejectPlayA = rej; })
      });
      const auxA = createMockAux();
      const stateA = { loadToken: 100 };
      const tokenA = handover.createHandoverToken({ id: 'track-a-rej' }, auxA, 1);
      handover.executeSwap(nativeA, auxA, tokenA, { currentToken: 100, state: stateA });
      nativeA.listeners['loadedmetadata']();

      // Handover B starts
      const nativeB = createMockNative();
      const auxB = createMockAux();
      const stateB = { loadToken: 200 };
      stateA.loadToken = 200; // invalidate A
      const tokenB = handover.createHandoverToken({ id: 'track-b-rej' }, auxB, 2);
      handover.executeSwap(nativeB, auxB, tokenB, { currentToken: 200, state: stateB });
      const ownerB = global.window._autoMixSuppressOwnerToken;

      // Delayed rejection for A occurs
      rejectPlayA(new Error('Audio policy reject A'));
      await new Promise(r => setTimeout(r, 10));

      assert.strictEqual(global.window._autoMixSuppressVolumeSync, true, 'Stale play rejection A must not clear B suppression');
      assert.strictEqual(global.window._autoMixSuppressOwnerToken, ownerB, 'Owner token remains B');
    }

    // Case D: Delayed 80ms timeout scheduled by A does not clear B's suppression if B started before timeout fired
    {
      const nativeA = createMockNative();
      const auxA = createMockAux();
      const stateA = { loadToken: 300 };
      const tokenA = handover.createHandoverToken({ id: 'track-a-delay' }, auxA, 1);
      handover.executeSwap(nativeA, auxA, tokenA, { currentToken: 300, state: stateA });
      nativeA.listeners['loadedmetadata']();
      nativeA.listeners['playing'](); // Schedules 80ms timeout to clear suppression

      // Immediately before 80ms passes, Handover B starts and acquires suppression
      const nativeB = createMockNative();
      const auxB = createMockAux();
      const stateB = { loadToken: 400 };
      const tokenB = handover.createHandoverToken({ id: 'track-b-delay' }, auxB, 2);
      handover.executeSwap(nativeB, auxB, tokenB, { currentToken: 400, state: stateB });
      const ownerB = global.window._autoMixSuppressOwnerToken;

      // Wait 120ms so A's 80ms timeout fires
      await new Promise(r => setTimeout(r, 120));

      assert.strictEqual(global.window._autoMixSuppressVolumeSync, true, 'A 80ms timeout must not clear B suppression');
      assert.strictEqual(global.window._autoMixSuppressOwnerToken, ownerB, 'Owner token remains B');
    }
  } finally {
    global.window = originalWindow;
  }
});

test('AutoMixDJ & PlaybackHandover - unified VolumeSyncSuppression ownership (Cases F, G, H, I)', async () => {
  const originalWindow = global.window;
  const suppressionMgr = new VolumeSyncSuppressionManager();

  global.window = {
    _autoMixSuppressVolumeSync: false,
    _autoMixSuppressOwnerToken: null,
    _autoMixSuppressOwner: null,
    volumeSyncSuppression: suppressionMgr,
    VolumeSyncSuppressionManager,
    dispatchEvent: () => {},
    audioEngine: {
      setDeckGains: () => {},
      fadeGain: { gain: { setValueAtTime: () => {} } },
      ctx: { currentTime: 0 }
    }
  };

  const createMockAudio = (opts = {}) => ({
    volume: opts.volume ?? 1.0,
    playbackRate: 1.0,
    paused: false,
    currentTime: opts.currentTime || 0,
    play: opts.play || (() => Promise.resolve()),
    pause: () => {}
  });

  const createMockNative = (opts = {}) => {
    let listeners = {};
    return {
      src: opts.src || 'http://test/init.mp3',
      readyState: opts.readyState || 0,
      muted: false,
      currentTime: 0,
      listeners,
      addEventListener: (ev, cb) => { listeners[ev] = cb; },
      removeEventListener: (ev) => { delete listeners[ev]; },
      play: opts.play || (() => Promise.resolve())
    };
  };

  try {
    // Case F: AutoMixDJ abort timeout (80ms) vs PlaybackHandover token acquisition
    // Crossfade starts and aborts. Before 80ms timeout fires, PlaybackHandover acquires a new token.
    // When the 80ms timeout fires, it must NOT clear suppression or overwrite Handover's owner token.
    {
      suppressionMgr.reset();
      const dj = new AutoMixDJ({ enabled: true, durationSec: 4.0 });
      const outAudio = createMockAudio({ volume: 1.0 });
      const inAudio = createMockAudio({ volume: 0 });

      const fadePromise = dj.executeCrossfade(outAudio, inAudio, 4.0);
      assert.strictEqual(global.window._autoMixSuppressVolumeSync, true, 'AutoMixDJ acquired suppression');
      const djToken = global.window._autoMixSuppressOwnerToken;
      assert.ok(djToken, 'DJ token exists');

      // Abort crossfade (triggers 80ms timeout)
      dj.abortCrossfade('skip');
      await fadePromise.catch(() => {});

      // Immediately, PlaybackHandover acquires ownership
      const handover = new PlaybackHandover();
      const nativeAudio = createMockNative();
      const auxAudio = createMockAudio({ currentTime: 15 });
      const handoverToken = handover.createHandoverToken({ id: 'track-handover-f' }, auxAudio, 1);
      handover.executeSwap(nativeAudio, auxAudio, handoverToken, {});

      const handoverTokenId = global.window._autoMixSuppressOwnerToken;
      assert.notStrictEqual(handoverTokenId, djToken, 'PlaybackHandover acquired a newer token');
      assert.strictEqual(global.window._autoMixSuppressVolumeSync, true, 'Suppression remains active for Handover');

      // Wait 120ms for AutoMixDJ 80ms timeout to fire
      await new Promise(r => setTimeout(r, 120));

      assert.strictEqual(global.window._autoMixSuppressVolumeSync, true, 'DJ abort 80ms timeout must NOT clear Handover suppression');
      assert.strictEqual(global.window._autoMixSuppressOwnerToken, handoverTokenId, 'Owner token must remain Handover');
    }

    // Case G: AutoMixDJ play rejection timeout (50ms) vs PlaybackHandover
    // Incoming audio play() rejects and schedules 50ms cleanup.
    // PlaybackHandover starts before the 50ms expires.
    // When the 50ms timeout fires, suppression must remain active under Handover's ownership.
    {
      suppressionMgr.reset();
      const dj = new AutoMixDJ({ enabled: true, durationSec: 4.0 });
      const outAudio = createMockAudio({ volume: 1.0 });
      const inAudio = createMockAudio({
        volume: 0,
        play: () => Promise.reject(new Error('Audio policy blocked'))
      });

      let djTokenBeforeReject = null;
      try {
        const p = dj.executeCrossfade(outAudio, inAudio, 4.0);
        djTokenBeforeReject = global.window._autoMixSuppressOwnerToken;
        await p;
      } catch (_) {}

      // PlaybackHandover immediately takes over
      const handover = new PlaybackHandover();
      const nativeAudio = createMockNative();
      const auxAudio = createMockAudio({ currentTime: 20 });
      const handoverToken = handover.createHandoverToken({ id: 'track-handover-g' }, auxAudio, 2);
      handover.executeSwap(nativeAudio, auxAudio, handoverToken, {});

      const handoverTokenId = global.window._autoMixSuppressOwnerToken;
      assert.notStrictEqual(handoverTokenId, djTokenBeforeReject, 'Handover has a fresh token');
      assert.strictEqual(global.window._autoMixSuppressVolumeSync, true, 'Suppression enabled by Handover');

      // Wait 100ms for AutoMixDJ 50ms timeout to fire
      await new Promise(r => setTimeout(r, 100));

      assert.strictEqual(global.window._autoMixSuppressVolumeSync, true, 'DJ play rejection 50ms timeout must NOT clear Handover suppression');
      assert.strictEqual(global.window._autoMixSuppressOwnerToken, handoverTokenId, 'Owner token remains Handover');
    }

    // Case H: Crossfade succeeds, handover acquires token, old AutoMixDJ cleanup does not clear suppression,
    // and handover releases its own token upon completion.
    {
      suppressionMgr.reset();
      const dj = new AutoMixDJ({ enabled: true, durationSec: 0.2 });
      const outAudio = createMockAudio({ volume: 1.0 });
      const inAudio = createMockAudio({ volume: 0 });

      // Short crossfade
      const fadePromise = dj.executeCrossfade(outAudio, inAudio, 0.2);
      const djToken = global.window._autoMixSuppressOwnerToken;
      assert.strictEqual(global.window._autoMixSuppressVolumeSync, true, 'AutoMixDJ suppression started');

      await fadePromise;

      // Handover begins seamlessly
      const handover = new PlaybackHandover();
      const nativeAudio = createMockNative();
      const auxAudio = inAudio;
      const handoverToken = handover.createHandoverToken({ id: 'track-handover-h' }, auxAudio, 3);
      handover.executeSwap(nativeAudio, auxAudio, handoverToken, {});

      const handoverTokenId = global.window._autoMixSuppressOwnerToken;
      assert.ok(handoverTokenId > djToken, 'Handover acquired newer generation token');
      assert.strictEqual(global.window._autoMixSuppressVolumeSync, true, 'Suppression kept active across handover transition');

      // Native audio gets loadedmetadata and playing event
      nativeAudio.listeners['loadedmetadata']();
      assert.ok(nativeAudio.listeners['playing'], 'Playing listener registered');
      nativeAudio.listeners['playing'](); // triggers finishSwap

      // Wait 120ms for Handover's 80ms delayed release
      await new Promise(r => setTimeout(r, 120));

      assert.strictEqual(global.window._autoMixSuppressVolumeSync, false, 'Handover releases suppression upon full completion');
      assert.strictEqual(global.window._autoMixSuppressOwnerToken, null, 'Owner token cleared');
    }

    // Case I: AutoMixDJ abort without subsequent handover cleans up suppression to false and null
    {
      suppressionMgr.reset();
      const dj = new AutoMixDJ({ enabled: true, durationSec: 5.0 });
      const outAudio = createMockAudio({ volume: 1.0 });
      const inAudio = createMockAudio({ volume: 0 });

      const fadePromise = dj.executeCrossfade(outAudio, inAudio, 5.0);
      assert.strictEqual(global.window._autoMixSuppressVolumeSync, true, 'Suppression enabled during fade');
      assert.ok(global.window._autoMixSuppressOwnerToken, 'Token assigned to DJ');

      dj.abortCrossfade('manual');
      await fadePromise.catch(() => {});

      // Wait 120ms for the 80ms abort timeout to fire
      await new Promise(r => setTimeout(r, 120));

      assert.strictEqual(global.window._autoMixSuppressVolumeSync, false, 'Suppression cleanly disabled when no handover took over');
      assert.strictEqual(global.window._autoMixSuppressOwnerToken, null, 'Owner token reset to null');
      assert.strictEqual(suppressionMgr.getCurrentToken(), null, 'Manager currentToken is null');
    }
  } finally {
    global.window = originalWindow;
  }
});

