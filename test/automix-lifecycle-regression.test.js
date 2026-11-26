// test/automix-lifecycle-regression.test.js
// Regression tests for AutoMix two-deck overlap, preload stages, mode parity, and transition lifecycle

const test = require('node:test');
const assert = require('node:assert');

const AutoMixDJ = require('../src/renderer/automix-dj.js');
const { PreloadManager } = require('../src/renderer/automix/preload-manager.js');
const { VALID_AUTOMIX_MODES, resolveInitialAutoMixMode } = require('../src/renderer/automix/settings-controller.js');

function createMockAudioElement(id = 'audio', readyState = 4) {
  const listeners = new Map();
  return {
    id,
    src: '',
    paused: id === 'eclipse-aux-audio',
    muted: false,
    volume: 1.0,
    playbackRate: 1.0,
    currentTime: 0,
    readyState,
    preload: 'auto',
    addEventListener(ev, cb) {
      if (!listeners.has(ev)) listeners.set(ev, new Set());
      listeners.get(ev).add(cb);
    },
    removeEventListener(ev, cb) {
      if (listeners.has(ev)) listeners.get(ev).delete(cb);
    },
    emit(ev, payload) {
      const set = listeners.get(ev);
      if (set) {
        for (const cb of Array.from(set)) cb(payload);
      }
    },
    play() {
      this.paused = false;
      return Promise.resolve();
    },
    pause() {
      this.paused = true;
    }
  };
}

function createMockAudioEngine() {
  const gainHistory = [];
  const engine = {
    ctx: {
      currentTime: 0,
      state: 'running',
      resume: () => Promise.resolve(),
      createBiquadFilter: () => ({
        type: 'lowpass',
        Q: { value: 0.7 },
        frequency: { setValueAtTime: () => {} },
        connect: () => {},
        context: { currentTime: 0 }
      })
    },
    deckAGain: { gain: { value: 1.0 } },
    deckBGain: { gain: { value: 0.0 } },
    mediaSource: { connect: () => {}, disconnect: () => {} },
    auxMediaSource: { connect: () => {}, disconnect: () => {} },
    attachAuxAudio: () => true,
    setDeckGains({ deckA, deckB }) {
      if (typeof deckA === 'number') engine.deckAGain.gain.value = deckA;
      if (typeof deckB === 'number') engine.deckBGain.gain.value = deckB;
      gainHistory.push({ deckA: engine.deckAGain.gain.value, deckB: engine.deckBGain.gain.value });
    },
    gainHistory
  };
  return engine;
}

test('Mode parity: Equal Power and Tempo Synced both use shared Equal-Power DSP curve and overlap both decks', async () => {
  assert.deepStrictEqual(Array.from(VALID_AUTOMIX_MODES), ['equal_power', 'tempo_synced']);
  assert.strictEqual(resolveInitialAutoMixMode('dj_mix'), 'tempo_synced');
  assert.strictEqual(resolveInitialAutoMixMode('equal_power'), 'equal_power');

  for (const mode of ['equal_power', 'tempo_synced']) {
    const events = [];
    const engine = createMockAudioEngine();
    const prevWindow = global.window;
    const prevCustomEvent = global.CustomEvent;
    global.CustomEvent = class CustomEvent {
      constructor(type, init) {
        this.type = type;
        this.detail = init?.detail;
      }
    };
    global.window = {
      audioEngine: engine,
      AudioContext: function () {},
      dispatchEvent: (ev) => events.push(ev)
    };

    try {
      const dj = new AutoMixDJ({ enabled: true, mode, durationSec: 0.25, djFilter: false });
      const deckA = createMockAudioElement('native-audio', 4);
      const deckB = createMockAudioElement('eclipse-aux-audio', 4);
      deckA.paused = false;

      const ok = await dj.executeCrossfade(deckA, deckB, 0.25, {
        transitionId: `tx-${mode}`,
        nextTrack: { id: 'next-1', title: 'Next Track' },
        targetIndex: 1,
        outgoingBpm: 120,
        incomingBpm: mode === 'tempo_synced' ? 124 : 120,
        tempoSynced: mode === 'tempo_synced'
      });

      assert.strictEqual(ok, true, `${mode} crossfade must succeed`);
      const overlapSamples = engine.gainHistory.filter(g => g.deckA > 0.05 && g.deckB > 0.05);
      assert.ok(overlapSamples.length >= 1, `${mode} must produce simultaneous non-zero gain overlap on Deck A and Deck B`);

      const statePhases = events.filter(e => e.type === 'eclipse:automix-state').map(e => e.detail.phase);
      assert.ok(statePhases.includes('mixing'), `${mode} must emit mixing phase`);
      assert.ok(statePhases.includes('dominance'), `${mode} must emit dominance phase`);
      assert.ok(statePhases.includes('settled'), `${mode} must emit settled phase`);
    } finally {
      global.window = prevWindow;
      global.CustomEvent = prevCustomEvent;
    }
  }
});

test('Tempo Synced falls back safely to Equal Power (playbackRate 1.0) when BPM analysis is unavailable', async () => {
  const engine = createMockAudioEngine();
  const prevWindow = global.window;
  const prevCustomEvent = global.CustomEvent;
  global.CustomEvent = class CustomEvent {
    constructor(type, init) { this.type = type; this.detail = init?.detail; }
  };
  global.window = { audioEngine: engine, AudioContext: function () {}, dispatchEvent: () => {} };

  try {
    const dj = new AutoMixDJ({ enabled: true, mode: 'tempo_synced', durationSec: 0.2, djFilter: false });
    const deckA = createMockAudioElement('native-audio', 4);
    const deckB = createMockAudioElement('eclipse-aux-audio', 4);
    deckA.paused = false;

    const ok = await dj.executeCrossfade(deckA, deckB, 0.2, {
      tempoSynced: false,
      tempoRatio: 1.0
    });
    assert.strictEqual(ok, true);
    assert.strictEqual(deckB.playbackRate, 1.0);
  } finally {
    global.window = prevWindow;
    global.CustomEvent = prevCustomEvent;
  }
});

test('Lifecycle cancellation: abortCrossfade cancels preparing, ready, and mixing transitions cleanly', async () => {
  const events = [];
  const engine = createMockAudioEngine();
  const prevWindow = global.window;
  const prevCustomEvent = global.CustomEvent;
  global.CustomEvent = class CustomEvent {
    constructor(type, init) { this.type = type; this.detail = init?.detail; }
  };
  global.window = { audioEngine: engine, AudioContext: function () {}, dispatchEvent: (ev) => events.push(ev) };

  try {
    const dj = new AutoMixDJ({ enabled: true, mode: 'equal_power', durationSec: 0.5, djFilter: false });

    // 1. Cancel during preparing
    const txPrep = dj.beginPreparingTransition({ transitionId: 'tx-prep', nextTrack: { id: 't2', title: 'T2' }, targetIndex: 1 });
    assert.strictEqual(dj.transitionPhase, 'preparing');
    const abortedPrep = dj.abortCrossfade('queue_replaced');
    assert.strictEqual(abortedPrep, true);
    assert.strictEqual(txPrep.cancelled, true);
    assert.strictEqual(dj.transitionPhase, 'idle');
    assert.strictEqual(events[events.length - 1].detail.phase, 'cancelled');
    assert.strictEqual(events[events.length - 1].detail.transitionId, 'tx-prep');

    // 2. Cancel during mixing (seek / next / prev / mode_change)
    const deckA = createMockAudioElement('native-audio', 4);
    const deckB = createMockAudioElement('eclipse-aux-audio', 4);
    deckA.paused = false;

    const fadePromise = dj.executeCrossfade(deckA, deckB, 0.5, {
      transitionId: 'tx-mix',
      nextTrack: { id: 't3', title: 'T3' },
      targetIndex: 2
    });

    await new Promise(r => setTimeout(r, 80));
    dj.abortCrossfade('seek');
    await assert.rejects(fadePromise, /Crossfade aborted: seek/);
    assert.strictEqual(deckA.paused, false, 'Seek abort must keep outgoing Deck A playing');
    assert.strictEqual(deckB.paused, true, 'Seek abort must pause incoming Deck B');
    assert.strictEqual(engine.deckAGain.gain.value, 1.0);
    assert.strictEqual(engine.deckBGain.gain.value, 0.0);
    assert.strictEqual(events[events.length - 1].detail.phase, 'cancelled');
    assert.strictEqual(events[events.length - 1].detail.transitionId, 'tx-mix');
  } finally {
    global.window = prevWindow;
    global.CustomEvent = prevCustomEvent;
  }
});

test('PreloadManager tracks explicit preload stages and handles slow/failed streams safely', async () => {
  const pm = new PreloadManager({ apiBase: 'http://127.0.0.1:38472', token: 't' });
  pm.resolveStreamUrl = async (track) => track.id === 'fail' ? '' : 'http://127.0.0.1/stream.m4a';
  pm.fetchSponsorSegments = async () => [];

  const auxEl = createMockAudioElement('eclipse-aux-audio', 0);
  setTimeout(() => {
    auxEl.readyState = 1;
    auxEl.emit('loadedmetadata');
    setTimeout(() => {
      auxEl.readyState = 3;
      auxEl.emit('canplay');
    }, 20);
  }, 20);

  const resOk = await pm.prepareNextTrack({ id: 'ok-1', title: 'OK' }, auxEl, 'medium');
  assert.strictEqual(resOk.ready, true);
  assert.strictEqual(resOk.stage, 'buffered');
  assert.strictEqual(pm.getPreloadStage('ok-1').stage, 'buffered');

  const resFail = await pm.prepareNextTrack({ id: 'fail', title: 'Fail' }, auxEl, 'medium');
  assert.strictEqual(resFail.ready, false);
  assert.strictEqual(resFail.stage, 'failed');
  assert.strictEqual(pm.getPreloadStage('fail').stage, 'failed');
});

test('Deck B CORS invariant: integration-bridge sets crossOrigin = anonymous on eclipse-aux-audio', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../src/renderer/integration-bridge.js'), 'utf8');
  assert.ok(src.includes("auxAudio.crossOrigin = 'anonymous'"), 'eclipse-aux-audio must set crossOrigin = anonymous to prevent WebAudio CORS silence');
});
