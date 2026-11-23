// test/audio-graph-handover.test.js
// JavaScript / audio-graph-handover.test.js / Node.js test runner
// Mandatory P0 integration regression tests for AudioEngine dual-deck routing,
// initialization race conditions, terminal crossfade gains, and PlaybackHandover ownership.

const test = require('node:test');
const assert = require('node:assert');

// Load EclipseAudioEngine via eval/vm or global mock since audio.js attaches to global/window
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const AutoMixDJ = require('../src/renderer/automix-dj.js');
const { PlaybackHandover } = require('../src/renderer/automix/playback-handover.js');

function createMockAudioContext() {
  let nodeIdCounter = 0;
  const mediaSourceCreations = new Map(); // element -> count

  class MockAudioParam {
    constructor(initial = 0) {
      this.value = initial;
      this.history = [];
    }
    setValueAtTime(val, time) {
      this.value = val;
      this.history.push({ op: 'setValueAtTime', val, time });
    }
    linearRampToValueAtTime(val, time) {
      this.value = val;
      this.history.push({ op: 'linearRampToValueAtTime', val, time });
    }
    setTargetAtTime(val, time, tc) {
      this.value = val;
      this.history.push({ op: 'setTargetAtTime', val, time, tc });
    }
    cancelScheduledValues(time) {
      this.history.push({ op: 'cancelScheduledValues', time });
    }
  }

  class MockAudioNode {
    constructor(type) {
      this._id = `${type}_${++nodeIdCounter}`;
      this.type = type;
      this.connections = new Set();
    }
    connect(dest) {
      this.connections.add(dest);
      return dest;
    }
    disconnect(dest) {
      if (dest) {
        this.connections.delete(dest);
      } else {
        this.connections.clear();
      }
    }
  }

  class MockAudioContext {
    constructor() {
      this.currentTime = 0;
      this.sampleRate = 44100;
      this.state = 'running';
      this.destination = new MockAudioNode('destination');
    }
    resume() { return Promise.resolve(); }
    suspend() { return Promise.resolve(); }
    createMediaElementSource(el) {
      const prev = mediaSourceCreations.get(el) || 0;
      if (prev > 0) {
        throw new Error('InvalidStateError: HTMLMediaElement already connected to a MediaElementAudioSourceNode');
      }
      mediaSourceCreations.set(el, prev + 1);
      const node = new MockAudioNode('MediaElementSource');
      node.mediaElement = el;
      return node;
    }
    createGain() {
      const node = new MockAudioNode('GainNode');
      node.gain = new MockAudioParam(1.0);
      return node;
    }
    createBiquadFilter() {
      const node = new MockAudioNode('BiquadFilterNode');
      node.frequency = new MockAudioParam(350);
      node.Q = new MockAudioParam(1);
      node.gain = new MockAudioParam(0);
      return node;
    }
    createDynamicsCompressor() {
      const node = new MockAudioNode('DynamicsCompressorNode');
      node.threshold = new MockAudioParam(-24);
      node.knee = new MockAudioParam(30);
      node.ratio = new MockAudioParam(12);
      node.attack = new MockAudioParam(0.003);
      node.release = new MockAudioParam(0.25);
      return node;
    }
    createWaveShaper() {
      return new MockAudioNode('WaveShaperNode');
    }
    createDelay() {
      const node = new MockAudioNode('DelayNode');
      node.delayTime = new MockAudioParam(0);
      return node;
    }
    createConvolver() {
      return new MockAudioNode('ConvolverNode');
    }
    createBuffer(channels, len, rate) {
      return {
        getChannelData: () => new Float32Array(len)
      };
    }
    createAnalyser() {
      const node = new MockAudioNode('AnalyserNode');
      node.fftSize = 128;
      node.smoothingTimeConstant = 0.8;
      return node;
    }
    createPanner() {
      const node = new MockAudioNode('PannerNode');
      node.positionX = new MockAudioParam(0);
      node.positionY = new MockAudioParam(0);
      node.positionZ = new MockAudioParam(1);
      return node;
    }
  }

  return { MockAudioContext, mediaSourceCreations };
}

function loadAudioEngineClass(MockAudioContext) {
  const eventsDispatched = [];
  const sandbox = {
    window: {
      AudioContext: MockAudioContext,
      dispatchEvent: (ev) => eventsDispatched.push(ev)
    },
    CustomEvent: class CustomEvent {
      constructor(type, init) {
        this.type = type;
        this.detail = init?.detail;
      }
    },
    console,
    Float32Array,
    Uint8Array,
    Math,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval
  };
  sandbox.global = sandbox;
  sandbox.self = sandbox.window;

  const audioSrc = fs.readFileSync(path.join(__dirname, '../src/renderer/audio.js'), 'utf8');
  vm.runInNewContext(audioSrc, sandbox);
  return { EclipseAudioEngine: sandbox.EclipseAudioEngine || sandbox.window.EclipseAudioEngine, eventsDispatched, sandbox };
}

function createMockAudioElement(id = 'audio') {
  const listeners = new Map();
  return {
    id,
    src: '',
    paused: false,
    muted: false,
    volume: 1.0,
    playbackRate: 1.0,
    currentTime: 0,
    readyState: 4,
    addEventListener(ev, cb) { listeners.set(ev, cb); },
    removeEventListener(ev) { listeners.delete(ev); },
    emit(ev, payload) { const cb = listeners.get(ev); if (cb) cb(payload); },
    hasListener(ev) { return listeners.has(ev); },
    play() { this.paused = false; return Promise.resolve(); },
    pause() { this.paused = true; }
  };
}

test('P0-1 & P0-2 & P0-3 & P0-8: attachAuxAudio() before init() defers cleanly, connects to final deckBGain, no duplicate MediaElementSource, dispatches audio-engine-ready', () => {
  const { MockAudioContext, mediaSourceCreations } = createMockAudioContext();
  const { EclipseAudioEngine, eventsDispatched } = loadAudioEngineClass(MockAudioContext);

  const engine = new EclipseAudioEngine();
  const nativeEl = createMockAudioElement('native-audio');
  const auxEl = createMockAudioElement('eclipse-aux-audio');

  // 1. Call attachAuxAudio BEFORE init()
  const attached = engine.attachAuxAudio(auxEl);
  assert.strictEqual(attached, true);
  assert.strictEqual(engine.graphInitialized, false, 'Graph must not be initialized yet');
  assert.strictEqual(engine.auxMediaSource, null, 'MediaElementSource must be deferred until init()');
  assert.strictEqual(engine.deckBGain, null, 'deckBGain must not be created prematurely');
  assert.strictEqual(mediaSourceCreations.get(auxEl) || 0, 0, 'No MediaElementSource created before init()');

  // 2. Now initialize primary graph with nativeEl
  engine.init(nativeEl);
  assert.strictEqual(engine.graphInitialized, true);
  assert.ok(engine.deckAGain, 'deckAGain created');
  assert.ok(engine.deckBGain, 'deckBGain created');
  assert.ok(engine.auxMediaSource, 'auxMediaSource created during init()');

  // Verify exact node identity and live connection graph: auxMediaSource -> deckBGain -> eqPreGain
  assert.strictEqual(engine.auxMediaSource.connections.has(engine.deckBGain), true, 'auxMediaSource MUST be connected to final deckBGain');
  assert.strictEqual(engine.deckBGain.connections.has(engine.eqPreGain), true, 'deckBGain MUST be connected to eqPreGain');
  assert.strictEqual(mediaSourceCreations.get(auxEl), 1, 'Exactly one MediaElementSource created for auxEl');

  // Verify explicit audio-engine-ready event was dispatched
  assert.ok(eventsDispatched.some(e => e.type === 'audio-engine-ready'), 'audio-engine-ready event must be dispatched on init');

  // 3. Re-calling attachAuxAudio(auxEl) after init() must NOT create a duplicate MediaElementSource
  const reattached = engine.attachAuxAudio(auxEl);
  assert.strictEqual(reattached, true);
  assert.strictEqual(mediaSourceCreations.get(auxEl), 1, 'Must NOT create duplicate MediaElementAudioSourceNode');
  assert.strictEqual(engine.auxMediaSource.connections.has(engine.deckBGain), true, 'Still connected to exact deckBGain');

  // 4. Deck B gain changes reflect directly on the connected deckBGain node
  engine.setDeckGains({ deckA: 0.2, deckB: 0.8, rampMs: 0 });
  assert.strictEqual(engine.deckAGain.gain.value, 0.2);
  assert.strictEqual(engine.deckBGain.gain.value, 0.8);
});

test('P0-4 & P0-5 & P0-6 & P0-7 & P0-9: Full crossfade ends at Deck A=0, Deck B=1; aux stays audible until native playing; error/reject keeps Deck B=1', async () => {
  const { MockAudioContext, mediaSourceCreations } = createMockAudioContext();
  const { EclipseAudioEngine } = loadAudioEngineClass(MockAudioContext);

  const engine = new EclipseAudioEngine();
  const nativeEl = createMockAudioElement('native-audio');
  const auxEl = createMockAudioElement('eclipse-aux-audio');
  auxEl.src = 'http://127.0.0.1/stream/next.m4a';

  engine.attachAuxAudio(auxEl);
  engine.init(nativeEl);

  // Wire global window.audioEngine for AutoMixDJ & PlaybackHandover
  const prevWindow = global.window;
  global.window = {
    audioEngine: engine,
    AudioContext: MockAudioContext,
    dispatchEvent: () => {},
    _autoMixSuppressVolumeSync: false
  };

  try {
    const dj = new AutoMixDJ({ enabled: true, durationSec: 0.15, djFilter: true });
    const handover = new PlaybackHandover();

    // Run crossfade
    const crossfadeOk = await dj.executeCrossfade(nativeEl, auxEl, 0.15, {
      outgoingBpm: 120,
      incomingBpm: 120,
      tempoSynced: false
    });

    assert.strictEqual(crossfadeOk, true, 'Crossfade should succeed');
    // Crucial P0-4: Terminal gain state after crossfade MUST be Deck A = 0.0, Deck B = 1.0
    assert.strictEqual(engine.deckAGain.gain.value, 0.0, 'After crossfade, Deck A must be 0.0');
    assert.strictEqual(engine.deckBGain.gain.value, 1.0, 'After crossfade, Deck B must remain 1.0');
    assert.strictEqual(auxEl.paused, false, 'Aux audio MUST remain playing after crossfade');
    assert.strictEqual(mediaSourceCreations.get(auxEl), 1, 'AutoMixDJ DJ filter MUST reuse existing auxMediaSource without duplicating');

    // Now test Handover lifecycle:
    // Case A: Native audio loads (loadedmetadata & canplay) -> Deck B MUST STILL BE 1.0 until 'playing'
    const token = handover.createHandoverToken({ id: 'next-1' }, auxEl, 1);
    nativeEl.src = '';
    nativeEl.readyState = 0;

    handover.executeSwap(nativeEl, auxEl, token, {
      isMuted: false,
      onDeckGainsReset: () => engine.setDeckGains({ deckA: 1.0, deckB: 0.0, rampMs: 0 })
    });

    // Fire loadedmetadata & canplay
    nativeEl.emit('loadedmetadata');
    nativeEl.emit('canplay');

    // Before 'playing' fires: Deck A = 0, Deck B = 1, aux still playing
    assert.strictEqual(engine.deckAGain.gain.value, 0.0, 'Deck A stays 0.0 before native playing');
    assert.strictEqual(engine.deckBGain.gain.value, 1.0, 'Deck B stays 1.0 before native playing');
    assert.strictEqual(auxEl.paused, false, 'Aux remains audible while waiting for native playing');

    // Now native emits 'playing' -> final deck swap occurs!
    nativeEl.emit('playing');
    assert.strictEqual(engine.deckAGain.gain.value, 1.0, 'Deck A switches to 1.0 on native playing');
    assert.strictEqual(engine.deckBGain.gain.value, 0.0, 'Deck B switches to 0.0 on native playing');
    assert.strictEqual(auxEl.paused, true, 'Aux stops only after native playing confirms');

    // Case B: Native play() rejection preserves Deck B = 1.0 and keeps aux playing
    engine.setDeckGains({ deckA: 0.0, deckB: 1.0, rampMs: 0 });
    auxEl.paused = false;
    const rejectNativeEl = createMockAudioElement('native-reject');
    rejectNativeEl.src = auxEl.src;
    rejectNativeEl.readyState = 4;
    rejectNativeEl.play = () => Promise.reject(new Error('NotAllowedError'));

    handover.executeSwap(rejectNativeEl, auxEl, token, {
      onDeckGainsReset: () => engine.setDeckGains({ deckA: 1.0, deckB: 0.0, rampMs: 0 })
    });

    await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(engine.deckAGain.gain.value, 0.0, 'Deck A stays 0.0 on play() rejection');
    assert.strictEqual(engine.deckBGain.gain.value, 1.0, 'Deck B preserved at 1.0 on play() rejection');
    assert.strictEqual(auxEl.paused, false, 'Aux continues playing on play() rejection');
    assert.strictEqual(rejectNativeEl.muted, false, 'nativeAudio unmuted on play() rejection');

    // Test playing timeout restores mute and preserves aux
    const timeoutNativeEl = createMockAudioElement('native-timeout');
    timeoutNativeEl.src = auxEl.src;
    timeoutNativeEl.readyState = 4;
    timeoutNativeEl.play = () => new Promise(() => {}); // never resolves or fires playing
    handover.executeSwap(timeoutNativeEl, auxEl, token, {
      onDeckGainsReset: () => engine.setDeckGains({ deckA: 1.0, deckB: 0.0, rampMs: 0 })
    });
    // advance clock past playingTimeout (3500ms)
    await new Promise(r => setTimeout(r, 3600));
    assert.strictEqual(timeoutNativeEl.muted, false, 'nativeAudio unmuted on playing timeout');
    assert.strictEqual(engine.deckBGain.gain.value, 1.0, 'Deck B preserved on playing timeout');
  } finally {
    global.window = prevWindow;
  }
});
