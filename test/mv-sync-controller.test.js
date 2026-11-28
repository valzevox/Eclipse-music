const test = require('node:test');
const assert = require('node:assert/strict');

const MvSyncController = require('../src/renderer/mv-sync-controller');
const { IFrameEngine } = require('../src/renderer/mv-player');

function createMockAudio({ paused = false, currentTime = 10 } = {}) {
  return {
    paused,
    currentTime,
    pauseCalls: 0,
    playCalls: 0,
    pause() {
      this.paused = true;
      this.pauseCalls++;
    },
    play() {
      this.paused = false;
      this.playCalls++;
      return Promise.resolve();
    }
  };
}

function createMockEngine({ autoConfirm = true } = {}) {
  const listeners = new Map();
  let state = 'IDLE';
  let pos = 0;
  let muted = false;
  let volume = 1;
  let disposed = false;
  const calls = [];

  return {
    calls,
    get muted() { return muted; },
    get volume() { return volume; },
    get disposed() { return disposed; },
    on(ev, fn) {
      if (!listeners.has(ev)) listeners.set(ev, new Set());
      listeners.get(ev).add(fn);
      return () => listeners.get(ev).delete(fn);
    },
    emit(ev, payload) {
      for (const fn of Array.from(listeners.get(ev) || [])) fn(payload);
    },
    async load(source, startSec) {
      calls.push(['load', source, startSec]);
      pos = startSec || 0;
      state = 'LOADING';
    },
    async play() {
      calls.push(['play']);
      if (autoConfirm) {
        state = 'PLAYING';
        this.emit('stateChange', 'PLAYING');
        pos += 0.25;
        this.emit('timeupdate', pos);
      }
    },
    pause() {
      calls.push(['pause']);
      state = 'PAUSED';
      this.emit('stateChange', 'PAUSED');
    },
    seek(sec) {
      calls.push(['seek', sec]);
      pos = sec;
    },
    setVolume(v) {
      volume = Math.max(0, Math.min(1, v));
    },
    setMuted(m) {
      muted = Boolean(m);
      calls.push(['setMuted', muted]);
    },
    getPosition() { return pos; },
    getState() { return state; },
    dispose() {
      disposed = true;
      listeners.clear();
    }
  };
}

test('Phase A2: handoff confirms PLAYING + progress, seeks songTimeMs + offsetMs, pauses Song, unmutes Video, aborts AutoMix as mv_active', async () => {
  const audio = createMockAudio({ paused: false, currentTime: 12 });
  const engine = createMockEngine({ autoConfirm: true });
  const abortedReasons = [];

  const ctrl = new MvSyncController({
    audioElement: audio,
    engine,
    resolveMv: async () => ({ found: true, videoId: 'vid12345678', offsetMs: 1500 }),
    onAbortAutoMix: (r) => abortedReasons.push(r)
  });

  await ctrl.setTrack({ id: 'song-1', title: 'Test' });
  await ctrl.switchToVideo();

  assert.equal(ctrl.isMvActive(), true);
  assert.equal(ctrl.preferredMode, 'video');
  assert.equal(audio.paused, true);
  assert.equal(engine.muted, false);
  assert.deepEqual(abortedReasons, ['mv_active']);

  // Verify seek used songTimeMs (12000) + offsetMs (1500) = 13.5s
  const seekCall = engine.calls.find((c) => c[0] === 'seek');
  assert.ok(seekCall);
  assert.equal(seekCall[1], 13.5);

  // Switch back to Song -> songTimeMs = videoTimeMs - offsetMs
  ctrl.switchToSong();
  assert.equal(ctrl.isMvActive(), false);
  assert.equal(ctrl.preferredMode, 'song');
  assert.equal(audio.paused, false);
  assert.equal(audio.currentTime, 12);
});

test('Phase A2: Track A found:false keeps preferredMode=video so Track B auto-enters Video', async () => {
  const audio = createMockAudio({ paused: false, currentTime: 5 });
  const engine = createMockEngine({ autoConfirm: true });

  const ctrl = new MvSyncController({
    audioElement: audio,
    engine,
    resolveMv: async (track) => {
      if (track.id === 'A') return { found: false, reason: 'LOW_CONFIDENCE', candidates: [] };
      return { found: true, videoId: 'vidB1234567', offsetMs: 0 };
    }
  });

  await ctrl.setTrack({ id: 'A' });
  await ctrl.switchToVideo();
  assert.equal(ctrl.isMvActive(), false);
  assert.equal(ctrl.preferredMode, 'video');
  assert.equal(audio.paused, false); // Song kept playing

  await ctrl.setTrack({ id: 'B' });
  assert.equal(ctrl.isMvActive(), true);
  assert.equal(ctrl.currentVideoId, 'vidB1234567');
});

test('Phase A2: rapid Next/Prev stops old MV first and generation guard discards stale resolve', async () => {
  const audio = createMockAudio({ paused: false, currentTime: 3 });
  const engine = createMockEngine({ autoConfirm: true });
  let resolveFirst;

  const ctrl = new MvSyncController({
    audioElement: audio,
    engine,
    resolveMv: (track) => {
      if (track.id === 'slow') {
        return new Promise((r) => { resolveFirst = r; });
      }
      return Promise.resolve({ found: true, videoId: 'fast1234567', offsetMs: 0 });
    }
  });

  ctrl.preferredMode = 'video';
  const p1 = ctrl.setTrack({ id: 'slow' });
  const p2 = ctrl.setTrack({ id: 'fast' });
  await p2;

  // Now resolve the stale first track
  resolveFirst({ found: true, videoId: 'stale123456', offsetMs: 0 });
  await p1;

  assert.equal(ctrl.currentVideoId, 'fast1234567');
  assert.equal(ctrl.isMvActive(), true);
});

test('Phase A2: respects Pause state when switching to Video', async () => {
  const audio = createMockAudio({ paused: true, currentTime: 20 });
  const engine = createMockEngine({ autoConfirm: true });

  const ctrl = new MvSyncController({
    audioElement: audio,
    engine,
    resolveMv: async () => ({ found: true, videoId: 'vidPause123', offsetMs: 0 })
  });

  await ctrl.setTrack({ id: 'paused-track' });
  await ctrl.switchToVideo();

  assert.equal(ctrl.isMvActive(), true);
  assert.equal(audio.playCalls, 0);
  assert.equal(engine.getState(), 'PAUSED');
});

test('Phase A2: MV ended advances queue once directly; error 100 invalidates, 101/150 keeps mapping', async () => {
  const audio = createMockAudio({ paused: false, currentTime: 0 });
  const engine = createMockEngine({ autoConfirm: true });
  let advanceCount = 0;
  const invalidated = [];

  const ctrl = new MvSyncController({
    audioElement: audio,
    engine,
    resolveMv: async () => ({ found: true, videoId: 'vidEnd12345', offsetMs: 0 }),
    invalidateMapping: async (songId, reason) => invalidated.push([songId, reason]),
    onAdvanceQueue: () => { advanceCount++; }
  });

  await ctrl.setTrack({ id: 't1' });
  await ctrl.switchToVideo();

  engine.emit('ended');
  engine.emit('ended'); // duplicate must be ignored
  assert.equal(advanceCount, 1);

  // Error 101 must NOT invalidate mapping
  engine.emit('error', 101);
  assert.equal(invalidated.length, 0);
  assert.equal(ctrl.isMvActive(), false);

  // Re-enter video and emit error 100 -> MUST invalidate mapping
  await ctrl.switchToVideo();
  engine.emit('error', 100);
  assert.deepEqual(invalidated, [['t1', 'error_100']]);
});

test('Phase A2: IFrameEngine on() returns unsubscribe and dispose() is idempotent', () => {
  const eng = new IFrameEngine();
  let count = 0;
  const unsub = eng.on('stateChange', () => { count++; });
  eng._emit('stateChange', 'PLAYING');
  assert.equal(count, 1);
  unsub();
  eng._emit('stateChange', 'PAUSED');
  assert.equal(count, 1);

  eng.dispose();
  eng.dispose(); // idempotent
  assert.equal(eng.getState(), 'IDLE');
});
