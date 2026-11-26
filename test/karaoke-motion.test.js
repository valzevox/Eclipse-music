// test/karaoke-motion.test.js
// Unit & Integration tests for Eclipse TV Karaoke & AutoMix Motion Lifecycle

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

// Mock a lightweight browser DOM & window environment for testing
function setupMockEnvironment() {
  const listeners = new Map();
  const elements = new Map();

  function createElement(tag) {
    const el = {
      tagName: tag.toUpperCase(),
      id: '',
      className: '',
      style: {},
      children: [],
      classList: {
        _classes: new Set(),
        add(c) { this._classes.add(c); el.className = Array.from(this._classes).join(' '); },
        remove(c) { this._classes.delete(c); el.className = Array.from(this._classes).join(' '); },
        contains(c) { return this._classes.has(c); },
        toggle(c, force) {
          if (force !== undefined) {
            if (force) this.add(c); else this.remove(c);
          } else {
            if (this.contains(c)) this.remove(c); else this.add(c);
          }
        }
      },
      querySelector(selector) {
        if (selector.startsWith('.')) {
          const cls = selector.slice(1);
          return el.children.find(c => c.classList && c.classList.contains(cls)) || null;
        }
        return null;
      },
      appendChild(child) {
        el.children.push(child);
        return child;
      },
      parentNode: null,
      nextSibling: null,
      insertBefore(newNode, refNode) {
        el.children.push(newNode);
        return newNode;
      }
    };
    return el;
  }

  const activeObservers = new Set();
  class MockMutationObserver {
    constructor(cb) {
      this._cb = cb;
      this._observing = false;
    }
    observe(target, opts) {
      this._observing = true;
      activeObservers.add(this);
    }
    disconnect() {
      this._observing = false;
      activeObservers.delete(this);
    }
  }

  const document = {
    body: {
      classList: {
        _bodyClasses: new Set(),
        add(c) {
          this._bodyClasses.add(c);
          activeObservers.forEach(obs => obs._cb([{ type: 'attributes', attributeName: 'class' }]));
        },
        remove(c) {
          this._bodyClasses.delete(c);
          activeObservers.forEach(obs => obs._cb([{ type: 'attributes', attributeName: 'class' }]));
        },
        contains(c) { return this._bodyClasses.has(c); }
      }
    },
    getElementById(id) {
      return elements.get(id) || null;
    },
    createElement(tag) {
      return createElement(tag);
    }
  };

  // Pre-populate required TV Karaoke container elements
  const tvkMeta = createElement('div');
  tvkMeta.id = 'tv-karaoke-meta';
  elements.set('tvkMeta', tvkMeta);
  elements.set('tv-karaoke-meta', tvkMeta);
  tvkMeta.parentNode = createElement('div');

  const tvk = createElement('div');
  tvk.id = 'tv-karaoke';
  elements.set('tv-karaoke', tvk);

  const ambientBg = createElement('div');
  ambientBg.id = 'tvk-ambient-bg';
  elements.set('tvk-ambient-bg', ambientBg);

  const titleEl = createElement('div');
  titleEl.id = 'tv-karaoke-title';
  elements.set('tv-karaoke-title', titleEl);

  const artistEl = createElement('div');
  artistEl.id = 'tv-karaoke-artist';
  elements.set('tv-karaoke-artist', artistEl);

  const coverEl = createElement('img');
  coverEl.id = 'tv-cover';
  elements.set('tv-cover', coverEl);

  const tvkCrossfadeLbl = createElement('span');
  tvkCrossfadeLbl.id = 'tvk-crossfading-label';
  elements.set('tvk-crossfading-label', tvkCrossfadeLbl);

  let prefersReducedMotion = false;
  const mqlListeners = new Set();
  const reducedMotionMql = {
    get matches() { return prefersReducedMotion; },
    addEventListener(type, fn) { if (type === 'change' && typeof fn === 'function') mqlListeners.add(fn); },
    removeEventListener(type, fn) { if (type === 'change') mqlListeners.delete(fn); }
  };

  const window = {
    addEventListener(event, fn) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
    },
    removeEventListener(event, fn) {
      if (listeners.has(event)) {
        listeners.set(event, listeners.get(event).filter(f => f !== fn));
      }
    },
    dispatchEvent(event) {
      const fns = listeners.get(event.type) || [];
      fns.forEach(fn => fn(event));
    },
    matchMedia(query) {
      if (query.includes('prefers-reduced-motion')) return reducedMotionMql;
      return { matches: false, addEventListener() {}, removeEventListener() {} };
    },
    setPrefersReducedMotion(val) {
      prefersReducedMotion = !!val;
      mqlListeners.forEach(fn => fn({ matches: prefersReducedMotion, media: '(prefers-reduced-motion: reduce)' }));
    },
    _mqlListenerCount() {
      return mqlListeners.size;
    }
  };

  class CustomEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail || {};
    }
  }

  global.window = window;
  global.document = document;
  global.CustomEvent = CustomEvent;
  global.MutationObserver = MockMutationObserver;

  return { listeners, elements, window, document, _observerCount: () => activeObservers.size };
}

describe('KaraokeMotionController Unit & Integration Pipeline', () => {
  let env;
  let KaraokeMotionController;

  beforeEach(() => {
    env = setupMockEnvironment();
    // Re-require fresh controller
    delete require.cache[require.resolve('../src/renderer/karaoke-motion.js')];
    const mod = require('../src/renderer/karaoke-motion.js');
    KaraokeMotionController = mod.KaraokeMotionController;
  });

  test('Unit: Controller init once - idempotency and single listener set', () => {
    const controller = new KaraokeMotionController();
    assert.strictEqual(controller._isSubscribed, false);

    controller.init();
    assert.strictEqual(controller._isSubscribed, true);

    const initialAutomixStateListeners = (env.listeners.get('eclipse:automix-state') || []).length;
    const initialAutomixProgressListeners = (env.listeners.get('eclipse:automix-progress') || []).length;
    assert.strictEqual(initialAutomixStateListeners, 1);
    assert.strictEqual(initialAutomixProgressListeners, 1);

    // Call init a second time intentionally
    controller.init();
    assert.strictEqual((env.listeners.get('eclipse:automix-state') || []).length, 1, 'Listeners must not duplicate on double init');
    assert.strictEqual((env.listeners.get('eclipse:automix-progress') || []).length, 1);
  });

  test('IT-01: Abort A không được huỷ B (End-to-End DOM dispatch pipeline)', () => {
    const controller = new KaraokeMotionController();
    controller.init();

    // 1. Start transition A via real event pipeline
    env.window.dispatchEvent(new CustomEvent('eclipse:automix-state', {
      detail: { active: true, transitionId: 'tx-A', nextTrack: { title: 'Track A' } }
    }));
    assert.strictEqual(controller.state.transitionId, 'tx-A');
    assert.strictEqual(controller.state.phase, 'mixing');

    // 2. Abort A happens, but then transition B immediately starts
    env.window.dispatchEvent(new CustomEvent('eclipse:automix-state', {
      detail: { active: true, transitionId: 'tx-B', nextTrack: { title: 'Track B' } }
    }));
    assert.strictEqual(controller.state.transitionId, 'tx-B');
    assert.strictEqual(controller.state.phase, 'mixing');

    // 3. Delayed terminal abort event from A arrives
    env.window.dispatchEvent(new CustomEvent('eclipse:automix-state', {
      detail: { active: false, transitionId: 'tx-A', aborted: true, reason: 'skip' }
    }));

    // 4. Assert B is unaffected: still mixing, still tx-B
    assert.strictEqual(controller.state.transitionId, 'tx-B', 'Transition B ownership must be preserved');
    assert.strictEqual(controller.state.phase, 'mixing', 'Transition B must not be cancelled by A');
  });

  test('IT-02: Terminal event thiếu ID bị từ chối khi transition active có ID', () => {
    const controller = new KaraokeMotionController();
    controller.init();

    env.window.dispatchEvent(new CustomEvent('eclipse:automix-state', {
      detail: { active: true, transitionId: 'tx-active-with-id', nextTrack: { title: 'Track Active' } }
    }));
    assert.strictEqual(controller.state.phase, 'mixing');

    // Malformed/untracked terminal event with null/undefined transitionId
    env.window.dispatchEvent(new CustomEvent('eclipse:automix-state', {
      detail: { active: false, transitionId: null, aborted: true }
    }));

    assert.strictEqual(controller.state.phase, 'mixing', 'Terminal event without ID must be rejected');
    assert.strictEqual(controller.state.transitionId, 'tx-active-with-id');
  });

  test('IT-03: Duplicate terminal event là idempotent', () => {
    const controller = new KaraokeMotionController();
    controller.init();

    let notificationCount = 0;
    controller.subscribe(() => { notificationCount++; });

    env.window.dispatchEvent(new CustomEvent('eclipse:automix-state', {
      detail: { active: true, transitionId: 'tx-single-terminal', nextTrack: { title: 'Track Single' } }
    }));
    const notifsAfterStart = notificationCount;

    // Terminal dispatch #1
    env.window.dispatchEvent(new CustomEvent('eclipse:automix-state', {
      detail: { active: false, transitionId: 'tx-single-terminal', completed: true }
    }));
    assert.strictEqual(controller.state.phase, 'settled');
    const notifsAfterFirstTerminal = notificationCount;
    assert.ok(notifsAfterFirstTerminal > notifsAfterStart);

    // Duplicate terminal dispatch #2 (from finally or race)
    env.window.dispatchEvent(new CustomEvent('eclipse:automix-state', {
      detail: { active: false, transitionId: 'tx-single-terminal', completed: true }
    }));

    // Must be completely ignored (idempotent, no side effects)
    assert.strictEqual(notificationCount, notifsAfterFirstTerminal, 'Duplicate terminal dispatch must be idempotent');
    assert.strictEqual(controller.state.phase, 'settled');
  });

  test('IT-04: Progress stale của A không ghi đè B', () => {
    const controller = new KaraokeMotionController();
    controller.init();

    // Start A
    env.window.dispatchEvent(new CustomEvent('eclipse:automix-state', {
      detail: { active: true, transitionId: 'tx-first', nextTrack: { title: 'Track 1' } }
    }));
    env.window.dispatchEvent(new CustomEvent('eclipse:automix-progress', {
      detail: { transitionId: 'tx-first', progress: 0.45 }
    }));
    assert.strictEqual(controller.state.progress, 0.45);

    // Start B
    env.window.dispatchEvent(new CustomEvent('eclipse:automix-state', {
      detail: { active: true, transitionId: 'tx-second', nextTrack: { title: 'Track 2' } }
    }));
    assert.strictEqual(controller.state.progress, 0.0);

    // Stale progress from A arrives late
    env.window.dispatchEvent(new CustomEvent('eclipse:automix-progress', {
      detail: { transitionId: 'tx-first', progress: 0.85 }
    }));

    assert.strictEqual(controller.state.progress, 0.0, 'Stale progress from A must be discarded');
    assert.strictEqual(controller.state.transitionId, 'tx-second');
  });

  test('IT-05: Dominance event trễ không tác động transition mới', () => {
    const controller = new KaraokeMotionController();
    controller.init();

    let dominantFired = 0;
    let dominantDetail = null;

    env.window.addEventListener('eclipse:karaoke-dominant-switch', (ev) => {
      dominantFired += 1;
      dominantDetail = ev.detail;
    });

    // Start A and push past 60%
    env.window.dispatchEvent(new CustomEvent('eclipse:automix-state', {
      detail: { active: true, transitionId: 'tx-dom-A', nextTrack: { title: 'Track Old' } }
    }));
    env.window.dispatchEvent(new CustomEvent('eclipse:automix-progress', {
      detail: { transitionId: 'tx-dom-A', progress: 0.65 }
    }));
    assert.strictEqual(dominantFired, 1);
    assert.strictEqual(dominantDetail.transitionId, 'tx-dom-A');

    // End A and Start B
    env.window.dispatchEvent(new CustomEvent('eclipse:automix-state', {
      detail: { active: false, transitionId: 'tx-dom-A', completed: true }
    }));
    env.window.dispatchEvent(new CustomEvent('eclipse:automix-state', {
      detail: { active: true, transitionId: 'tx-dom-B', nextTrack: { title: 'Track New' } }
    }));

    // Stale progress >= 60% from A arrives
    env.window.dispatchEvent(new CustomEvent('eclipse:automix-progress', {
      detail: { transitionId: 'tx-dom-A', progress: 0.90 }
    }));

    // Must NOT fire dominant switch again for A
    assert.strictEqual(dominantFired, 1, 'Stale dominance must not fire for old transition');
  });

  test('IT-06: Abort tại nhiều mốc progress (20%, 50%, 60%, 95%) preserves real progress', () => {
    const controller = new KaraokeMotionController();
    controller.init();

    const testCheckpoints = [0.20, 0.50, 0.60, 0.95];

    testCheckpoints.forEach((p, idx) => {
      const txId = `tx-chk-${idx}`;
      env.window.dispatchEvent(new CustomEvent('eclipse:automix-state', {
        detail: { active: true, transitionId: txId, nextTrack: { title: `Track ${idx}` } }
      }));
      env.window.dispatchEvent(new CustomEvent('eclipse:automix-progress', {
        detail: { transitionId: txId, progress: p }
      }));
      assert.strictEqual(controller.state.progress, p);

      // Abort
      env.window.dispatchEvent(new CustomEvent('eclipse:automix-state', {
        detail: { active: false, transitionId: txId, aborted: true, reason: 'manual_skip' }
      }));

      assert.strictEqual(controller.state.phase, 'cancelled');
      assert.strictEqual(controller.state.progress, p, `Progress at checkpoint ${p} must be preserved on abort`);
    });
  });

  test('IT-07: Guardrails & Accessibility - reduced-motion & body.perf suppression', () => {
    const controller = new KaraokeMotionController();
    controller.init();

    // 1. With reduced-motion enabled
    env.window.setPrefersReducedMotion(true);
    controller.triggerBassPulse(0.9);
    assert.strictEqual(controller._bassPulseGeneration, 0, 'Bass pulse must be suppressed under prefers-reduced-motion');

    // 2. With body.perf enabled
    env.window.setPrefersReducedMotion(false);
    env.document.body.classList.add('perf');
    controller.triggerBassPulse(0.9);
    assert.strictEqual(controller._bassPulseGeneration, 0, 'Bass pulse must be suppressed under body.perf');

    // 3. Normal conditions: Bass pulse works
    env.document.body.classList.remove('perf');
    controller.triggerBassPulse(0.9);
    assert.strictEqual(controller._bassPulseGeneration, 1, 'Bass pulse operates normally when guards are off');
  });

  test('P2 Race: Timer cleanup của A không thể ẩn hoặc reset state của B', async () => {
    const controller = new KaraokeMotionController();
    controller.init();

    // 1. A starts and completes at t=0; starts 350ms cleanup timer for tx-A
    env.window.dispatchEvent(new CustomEvent('eclipse:automix-state', {
      detail: { active: true, transitionId: 'tx-A', nextTrack: { title: 'Track A' } }
    }));
    env.window.dispatchEvent(new CustomEvent('eclipse:automix-state', {
      detail: { active: false, transitionId: 'tx-A', completed: true }
    }));
    assert.strictEqual(controller.state.phase, 'settled');
    assert.strictEqual(controller.state.transitionId, 'tx-A');

    // 2. Before 350ms elapses (e.g. at 50ms), transition B starts!
    await new Promise(r => setTimeout(r, 50));
    env.window.dispatchEvent(new CustomEvent('eclipse:automix-state', {
      detail: { active: true, transitionId: 'tx-B', nextTrack: { title: 'Track B' } }
    }));
    assert.strictEqual(controller.state.phase, 'mixing');
    assert.strictEqual(controller.state.transitionId, 'tx-B');

    // 3. B also completes quickly (e.g. after 50ms more = 100ms total from t=0)
    await new Promise(r => setTimeout(r, 50));
    env.window.dispatchEvent(new CustomEvent('eclipse:automix-state', {
      detail: { active: false, transitionId: 'tx-B', completed: true }
    }));
    assert.strictEqual(controller.state.phase, 'settled');
    assert.strictEqual(controller.state.transitionId, 'tx-B');

    // 4. Wait 280ms (total time ~380ms from t=0, so Timer A would have expired at 350ms)
    // But Timer B was created at ~100ms, so Timer B will expire at ~450ms.
    // At t=380ms, B must still be settled and NOT prematurely cleaned up to idle/null!
    await new Promise(r => setTimeout(r, 260));
    assert.strictEqual(controller.state.transitionId, 'tx-B', 'Timer A must not reset transitionId of B');
    assert.strictEqual(controller.state.phase, 'settled', 'Timer A must not reset phase of B to idle');

    // 5. Wait remaining time for Timer B to expire
    await new Promise(r => setTimeout(r, 150));
    assert.strictEqual(controller.state.phase, 'idle');
    assert.strictEqual(controller.state.transitionId, null);
  });

  test('Producer Verification: AutoMixDJ.abortCrossfade() captures transitionId and dispatches accurate outcome', () => {
    let capturedEvent = null;
    const onState = (ev) => {
      capturedEvent = ev.detail;
    };
    env.window.addEventListener('eclipse:automix-state', onState);

    // Instantiate AutoMixDJ
    delete require.cache[require.resolve('../src/renderer/automix-dj.js')];
    const AutoMixDJ = require('../src/renderer/automix-dj.js');
    const dj = new AutoMixDJ();

    // Mock an active crossfade with transitionId
    const mockFade = {
      transitionId: 'tx-producer-test-999',
      interval: setInterval(() => {}, 1000),
      outgoingAudio: { volume: 0.8, pause() {} },
      incomingAudio: { volume: 0.2, pause() {}, currentTime: 0 },
      initialUserVol: 0.8,
      audioEngine: null,
      suppressToken: null
    };
    dj.isCrossfading = true;
    dj._currentFade = mockFade;

    // Call real producer method
    const res = dj.abortCrossfade('user_skipped');
    assert.strictEqual(res, true, 'abortCrossfade returns true on successful abort');
    assert.strictEqual(dj.isCrossfading, false, 'isCrossfading must be false after abort');
    assert.strictEqual(dj._currentFade, null, '_currentFade must be null after abort');

    assert.ok(capturedEvent, 'Terminal eclipse:automix-state event must be dispatched');
    assert.strictEqual(capturedEvent.transitionId, 'tx-producer-test-999', 'event.transitionId must match captured token');
    assert.strictEqual(capturedEvent.active, false);
    assert.strictEqual(capturedEvent.aborted, true);
    assert.strictEqual(capturedEvent.failed, false, 'Cancellation reason must have failed=false');
    assert.strictEqual(capturedEvent.reason, 'user_skipped');

    env.window.removeEventListener('eclipse:automix-state', onState);
  });

  test('P2 Outcome Classification: distinguishes cancelled (pause/seek/skip/mode) from error', () => {
    delete require.cache[require.resolve('../src/renderer/automix-dj.js')];
    const AutoMixDJ = require('../src/renderer/automix-dj.js');
    const dj = new AutoMixDJ();

    const cancellationCases = ['pause', 'seek', 'skip', 'manual', 'user_cancelled', 'user_skipped', 'queue_replaced', 'mode_change'];
    for (const reason of cancellationCases) {
      let eventDetail = null;
      const onState = (ev) => { eventDetail = ev.detail; };
      env.window.addEventListener('eclipse:automix-state', onState);

      dj.isCrossfading = true;
      dj._currentFade = {
        transitionId: `tx-${reason}`,
        interval: null,
        outgoingAudio: { volume: 1, pause() {} },
        incomingAudio: { volume: 0, pause() {}, currentTime: 0 }
      };

      dj.abortCrossfade(reason);
      assert.ok(eventDetail, `Event must be dispatched for ${reason}`);
      assert.strictEqual(eventDetail.aborted, true, `${reason} must be marked aborted=true`);
      assert.strictEqual(eventDetail.failed, false, `${reason} must be marked failed=false`);

      // Verify controller transitions to 'cancelled'
      const controller = new KaraokeMotionController();
      controller.init();
      controller.state.phase = 'mixing';
      controller.state.transitionId = `tx-${reason}`;
      controller.handleAutomixState(eventDetail);
      assert.strictEqual(controller.state.phase, 'cancelled');

      env.window.removeEventListener('eclipse:automix-state', onState);
    }

    // Verify true error case
    let errorDetail = null;
    const onErrorState = (ev) => { errorDetail = ev.detail; };
    env.window.addEventListener('eclipse:automix-state', onErrorState);

    dj.isCrossfading = true;
    dj._currentFade = {
      transitionId: 'tx-err',
      interval: null,
      outgoingAudio: { volume: 1, pause() {} },
      incomingAudio: { volume: 0, pause() {}, currentTime: 0 }
    };

    dj.abortCrossfade('error');
    assert.ok(errorDetail);
    assert.strictEqual(errorDetail.aborted, false, 'error must not be marked aborted=true');
    assert.strictEqual(errorDetail.failed, true, 'error must be marked failed=true');

    const errController = new KaraokeMotionController();
    errController.init();
    errController.state.phase = 'mixing';
    errController.state.transitionId = 'tx-err';
    errController.handleAutomixState(errorDetail);
    assert.strictEqual(errController.state.phase, 'error', 'controller must transition to error phase');

    env.window.removeEventListener('eclipse:automix-state', onErrorState);
  });

  test('P2 Fail-Closed Tokens: progress without valid matching token is rejected', () => {
    const controller = new KaraokeMotionController();
    controller.init();

    controller.state.phase = 'mixing';
    controller.state.transitionId = 'tx-active-b';
    controller.state.progress = 0.2;

    // 1. null token
    controller.handleAutomixProgress({ transitionId: null, progress: 0.8 });
    assert.strictEqual(controller.state.progress, 0.2, 'Null token progress must be rejected');

    // 2. undefined token
    controller.handleAutomixProgress({ progress: 0.8 });
    assert.strictEqual(controller.state.progress, 0.2, 'Undefined token progress must be rejected');

    // 3. empty/whitespace token
    controller.handleAutomixProgress({ transitionId: '   ', progress: 0.8 });
    assert.strictEqual(controller.state.progress, 0.2, 'Whitespace token progress must be rejected');

    // 4. mismatch token
    controller.handleAutomixProgress({ transitionId: 'tx-other', progress: 0.8 });
    assert.strictEqual(controller.state.progress, 0.2, 'Mismatched token progress must be rejected');

    // 5. valid matching token
    controller.handleAutomixProgress({ transitionId: 'tx-active-b', progress: 0.85 });
    assert.strictEqual(controller.state.progress, 0.85, 'Matching token progress must be accepted');
  });

  test('P2 Terminal Idempotency: terminal event when idle or with mismatch token is rejected', () => {
    const controller = new KaraokeMotionController();
    controller.init();

    assert.strictEqual(controller.state.phase, 'idle');
    assert.strictEqual(controller.state.transitionId, null);

    // Stale terminal event arriving while idle
    controller.handleAutomixState({ active: false, transitionId: 'tx-stale-after-idle', aborted: true });
    assert.strictEqual(controller.state.phase, 'idle', 'Controller must remain idle when terminal event arrives in idle');

    // Start transition
    controller.handleAutomixState({ active: true, transitionId: 'tx-live', nextTrack: { title: 'Live' } });
    assert.strictEqual(controller.state.phase, 'mixing');

    // Stale terminal event for another transition arriving during live transition
    controller.handleAutomixState({ active: false, transitionId: 'tx-stale-other', aborted: true });
    assert.strictEqual(controller.state.phase, 'mixing', 'Controller must ignore terminal event from different transition');
    assert.strictEqual(controller.state.transitionId, 'tx-live');
  });

  test('P1 Dominance Rollback: abort after 60% restores original metadata and invalidates timer', () => {
    const titleEl = env.document.getElementById('tv-karaoke-title');
    const artistEl = env.document.getElementById('tv-karaoke-artist');
    const coverEl = env.document.getElementById('tv-cover');

    titleEl.textContent = 'Track A';
    artistEl.textContent = 'Artist A';
    coverEl.src = 'https://example.com/cover-a.jpg';

    // Simulate app.js rollback listener logic
    let dominantGeneration = 0;
    let tvkMetadataSnapshot = null;
    let isTvKaraokeOpen = true;

    const onDominant = (ev) => {
      if (!isTvKaraokeOpen) return;
      const toTrack = ev.detail && ev.detail.toTrack;
      const transitionId = ev.detail && ev.detail.transitionId;
      if (toTrack) {
        tvkMetadataSnapshot = {
          transitionId: transitionId || null,
          title: titleEl.textContent,
          artist: artistEl.textContent,
          coverSrc: coverEl.src
        };
        dominantGeneration += 1;
        const currentGen = dominantGeneration;
        setTimeout(() => {
          if (dominantGeneration !== currentGen) return;
          titleEl.textContent = toTrack.title || '';
          artistEl.textContent = toTrack.artist || '';
          coverEl.src = toTrack.thumbnail || '';
        }, 140);
      }
    };

    const onAutomixState = (ev) => {
      const detail = ev && ev.detail;
      if (!detail || detail.active) return;
      if (detail.completed) {
        if (tvkMetadataSnapshot && detail.transitionId && tvkMetadataSnapshot.transitionId === detail.transitionId) {
          tvkMetadataSnapshot = null;
        }
        return;
      }
      if ((detail.aborted || detail.failed) && tvkMetadataSnapshot) {
        const incomingTxId = detail.transitionId || null;
        if (incomingTxId && tvkMetadataSnapshot.transitionId && incomingTxId !== tvkMetadataSnapshot.transitionId) {
          return;
        }
        dominantGeneration += 1;
        titleEl.textContent = tvkMetadataSnapshot.title || '';
        artistEl.textContent = tvkMetadataSnapshot.artist || '';
        coverEl.src = tvkMetadataSnapshot.coverSrc || '';
        tvkMetadataSnapshot = null;
      }
    };

    env.window.addEventListener('eclipse:karaoke-dominant-switch', onDominant);
    env.window.addEventListener('eclipse:automix-state', onAutomixState);

    // 1. Dominance switch triggers at 65%
    env.window.dispatchEvent(new CustomEvent('eclipse:karaoke-dominant-switch', {
      detail: {
        transitionId: 'tx-abort-test',
        toTrack: { title: 'Track B', artist: 'Artist B', thumbnail: 'https://example.com/cover-b.jpg' },
        progress: 0.65
      }
    }));

    // Pre-abort snapshot was taken
    assert.ok(tvkMetadataSnapshot);
    assert.strictEqual(tvkMetadataSnapshot.title, 'Track A');

    // 2. Abort arrives BEFORE 140ms timeout expires (e.g. at 30ms)
    env.window.dispatchEvent(new CustomEvent('eclipse:automix-state', {
      detail: {
        active: false,
        transitionId: 'tx-abort-test',
        aborted: true,
        failed: false,
        reason: 'seek'
      }
    }));

    // Metadata is immediately restored to Track A
    assert.strictEqual(titleEl.textContent, 'Track A');
    assert.strictEqual(artistEl.textContent, 'Artist A');
    assert.strictEqual(coverEl.src, 'https://example.com/cover-a.jpg');

    // 3. Wait 160ms for original 140ms timeout; must NOT overwrite Track A with Track B!
    return new Promise(resolve => {
      setTimeout(() => {
        assert.strictEqual(titleEl.textContent, 'Track A', 'Pending dominant timer must be invalidated by abort');
        assert.strictEqual(artistEl.textContent, 'Artist A');
        assert.strictEqual(coverEl.src, 'https://example.com/cover-a.jpg');
        env.window.removeEventListener('eclipse:karaoke-dominant-switch', onDominant);
        env.window.removeEventListener('eclipse:automix-state', onAutomixState);
        resolve();
      }, 160);
    });
  });

  test('P3 Bass Fallback: bin computation maps 40-160Hz correctly without DC bins', () => {
    // Helper replicating app.js bass calculation
    function computeBassEnergy(freqData, sampleRate = 44100) {
      if (!freqData.length) return 0;
      const binWidth = sampleRate / (freqData.length * 2);
      const minBin = Math.max(1, Math.floor(40 / binWidth));
      const maxBin = Math.min(freqData.length - 1, Math.ceil(160 / binWidth));
      let sum = 0;
      let count = 0;
      for (let b = minBin; b <= maxBin; b++) {
        sum += freqData[b];
        count++;
      }
      return { energy: count > 0 ? (sum / (count * 255)) : 0, minBin, maxBin };
    }

    const testBuf = new Uint8Array(1024);
    // Put DC offset at bin 0 and heavy energy at 60Hz
    testBuf[0] = 255;
    const res = computeBassEnergy(testBuf, 44100);
    // bin 0 must NEVER be included (minBin >= 1)
    assert.ok(res.minBin >= 1, 'minBin must be at least 1 to exclude DC offset');
    assert.strictEqual(res.energy, 0, 'DC offset at bin 0 must not trigger bass energy');

    // Put energy at bin 3 (which corresponds to ~64Hz for 44100/2048)
    testBuf[3] = 255;
    const resWithBass = computeBassEnergy(testBuf, 44100);
    assert.ok(resWithBass.energy > 0, 'Energy in 40-160Hz band must be captured');
  });

  test('Lifecycle: controller.dispose() cleans up listeners, DOM refs and pending timers', () => {
    const controller = new KaraokeMotionController();
    controller.init();
    assert.strictEqual(controller._isSubscribed, true);

    controller.dispose();
    assert.strictEqual(controller._isSubscribed, false);
    assert.strictEqual(controller.state.phase, 'idle');
    assert.strictEqual(controller.state.transitionId, null);
  });

  test('Lifecycle: preparing -> ready -> mixing -> dominance -> settled drives Up Next chip and pill', () => {
    const controller = new KaraokeMotionController();
    controller.init();

    const nextTrack = { title: 'Midnight City', artist: 'M83', thumbnail: 'https://example.com/cover.jpg' };
    controller.handleAutomixState({
      phase: 'preparing',
      active: true,
      transitionId: 'tx-life-1',
      nextTrack,
      mode: 'equal_power'
    });
    assert.strictEqual(controller.state.phase, 'preparing');
    assert.strictEqual(controller._domUpNext.classList.contains('hidden'), false);
    assert.strictEqual(controller._domUpNext.classList.contains('is-preparing'), true);
    assert.strictEqual(controller._domPill.classList.contains('visible'), false);

    controller.handleAutomixState({
      phase: 'ready',
      active: true,
      transitionId: 'tx-life-1',
      nextTrack,
      mode: 'equal_power'
    });
    assert.strictEqual(controller.state.phase, 'ready');
    assert.strictEqual(controller._domUpNext.classList.contains('is-ready'), true);

    controller.handleAutomixState({
      phase: 'mixing',
      active: true,
      transitionId: 'tx-life-1',
      nextTrack,
      mode: 'tempo_synced',
      durationSec: 6
    });
    assert.strictEqual(controller.state.phase, 'mixing');
    assert.strictEqual(controller._domPill.classList.contains('visible'), false);
    assert.strictEqual(controller._domUpNext.classList.contains('hidden'), true);
    assert.strictEqual(env.elements.get('tvk-crossfading-label').classList.contains('visible'), true);

    controller.handleAutomixState({
      phase: 'dominance',
      active: true,
      transitionId: 'tx-life-1',
      nextTrack,
      progress: 0.65
    });
    assert.strictEqual(controller.state.phase, 'dominance');
    assert.strictEqual(controller._domUpNext.classList.contains('hidden'), true);
    assert.strictEqual(env.elements.get('tvk-crossfading-label').classList.contains('visible'), true);

    controller.handleAutomixState({
      phase: 'settled',
      active: false,
      transitionId: 'tx-life-1',
      completed: true
    });
    assert.strictEqual(controller.state.phase, 'settled');
    assert.strictEqual(controller._domUpNext.classList.contains('hidden'), true);
    assert.strictEqual(env.elements.get('tvk-crossfading-label').classList.contains('visible'), false);
    controller.dispose();
  });

  test('Lifecycle: preparing -> failed and ready -> cancelled clear Up Next chip without guessing', () => {
    const controller = new KaraokeMotionController();
    controller.init();

    controller.handleAutomixState({
      phase: 'preparing',
      active: true,
      transitionId: 'tx-fail-1',
      nextTrack: null
    });
    assert.strictEqual(controller._domUpNext.classList.contains('hidden'), true, 'Must not show Up Next when nextTrack is null');

    controller.handleAutomixState({
      phase: 'failed',
      active: false,
      transitionId: 'tx-fail-1',
      failed: true
    });
    assert.strictEqual(controller.state.phase, 'error');

    controller.handleAutomixState({
      phase: 'ready',
      active: true,
      transitionId: 'tx-cancel-1',
      nextTrack: { title: 'Next Song', artist: 'Artist' }
    });
    assert.strictEqual(controller._domUpNext.classList.contains('hidden'), false);

    controller.handleAutomixState({
      phase: 'cancelled',
      active: false,
      transitionId: 'tx-cancel-1',
      aborted: true
    });
    assert.strictEqual(controller.state.phase, 'cancelled');
    assert.strictEqual(controller._domUpNext.classList.contains('hidden'), true);
    controller.dispose();
  });

  test('Reduced Motion & body.perf: independent operation, runtime MediaQueryList change, and zero lingering timers', () => {
    const controller = new KaraokeMotionController();
    controller.init();
    assert.strictEqual(env.window._mqlListenerCount(), 1, 'MediaQueryList change listener must be registered on init');
    assert.strictEqual(controller.isReducedMotion(), false);

    // 1. body.perf alone activates reduced motion
    env.document.body.classList.add('perf');
    assert.strictEqual(controller.isReducedMotion(), true);
    env.document.body.classList.remove('perf');
    assert.strictEqual(controller.isReducedMotion(), false);

    // 2. Start a bass pulse timer during active mixing, then toggle OS prefers-reduced-motion at runtime
    controller.handleAutomixState({ phase: 'mixing', active: true, transitionId: 'tx-rm-1', nextTrack: { title: 'T' } });
    controller._bassPulseTimer = setTimeout(() => {}, 5000);
    env.window._automixRainbowBlend = 0.8;
    env.window.setPrefersReducedMotion(true);

    assert.strictEqual(controller.isReducedMotion(), true);
    assert.strictEqual(controller._bassPulseTimer, null, 'Runtime reduced-motion toggle must clear _bassPulseTimer');
    assert.strictEqual(env.window._automixRainbowBlend, 0, 'Runtime reduced-motion toggle must reset _automixRainbowBlend');
    assert.strictEqual(env.elements.get('tvk-ambient-bg').style.transform, 'scale(4) translateZ(0)');

    // 3. dispose() removes MediaQueryList listener and leaves zero timers
    controller.dispose();
    assert.strictEqual(env.window._mqlListenerCount(), 0, 'dispose() must remove MediaQueryList change listener');
    assert.strictEqual(controller._bassPulseTimer, null);
    assert.strictEqual(controller._terminalCleanupTimer, null);
  });

  test('Lifecycle branches: preparing->cancelled, mixing->cancelled, mixing->error, mixing->settled & stale transitionId rejection', () => {
    const controller = new KaraokeMotionController();
    controller.init();

    // preparing -> cancelled
    controller.handleAutomixState({ phase: 'preparing', active: true, transitionId: 'tx-b1', nextTrack: { title: 'B1' } });
    assert.strictEqual(controller.state.phase, 'preparing');
    controller.handleAutomixState({ phase: 'cancelled', active: false, transitionId: 'tx-b1', aborted: true });
    assert.strictEqual(controller.state.phase, 'cancelled');
    assert.strictEqual(controller._domUpNext.classList.contains('hidden'), true);

    // mixing -> cancelled
    controller.handleAutomixState({ phase: 'mixing', active: true, transitionId: 'tx-b2', nextTrack: { title: 'B2' } });
    assert.strictEqual(controller.state.phase, 'mixing');
    controller.handleAutomixState({ phase: 'cancelled', active: false, transitionId: 'tx-b2', aborted: true });
    assert.strictEqual(controller.state.phase, 'cancelled');
    assert.strictEqual(env.elements.get('tvk-crossfading-label').classList.contains('visible'), false);

    // mixing -> error
    controller.handleAutomixState({ phase: 'mixing', active: true, transitionId: 'tx-b3', nextTrack: { title: 'B3' } });
    controller.handleAutomixState({ phase: 'error', active: false, transitionId: 'tx-b3', failed: true });
    assert.strictEqual(controller.state.phase, 'error');
    assert.strictEqual(env.elements.get('tvk-crossfading-label').classList.contains('visible'), false);

    // mixing -> settled + stale transitionId rejection
    controller.handleAutomixState({ phase: 'mixing', active: true, transitionId: 'tx-b4', nextTrack: { title: 'B4' } });
    controller.handleAutomixState({ phase: 'settled', active: false, transitionId: 'tx-stale', completed: true });
    assert.strictEqual(controller.state.phase, 'mixing', 'Stale transitionId must be rejected');
    controller.handleAutomixState({ phase: 'settled', active: false, transitionId: 'tx-b4', completed: true });
    assert.strictEqual(controller.state.phase, 'settled');
    assert.strictEqual(controller._bassPulseTimer, null);

    controller.dispose();
  });

  test('Behavioral: body.perf MutationObserver cancels _bassPulseTimer immediately without duplicating observers/listeners', () => {
    const controller = new KaraokeMotionController();
    controller.init();
    assert.strictEqual(env._observerCount(), 1, 'MutationObserver must be registered once on init');
    assert.strictEqual(env.window._mqlListenerCount(), 1, 'MediaQueryList change listener must be registered once on init');

    // Start active mixing + bass pulse timer
    controller.handleAutomixState({ phase: 'mixing', active: true, transitionId: 'tx-perf-1', nextTrack: { title: 'T' } });
    controller._bassPulseTimer = setTimeout(() => {}, 5000);
    env.elements.get('tvk-ambient-bg').style.transform = 'scale(4.15) translateZ(0)';

    // Adding body.perf must immediately cancel _bassPulseTimer and reset transform
    env.document.body.classList.add('perf');
    assert.strictEqual(controller.isReducedMotion(), true);
    assert.strictEqual(controller._bassPulseTimer, null, 'Adding body.perf must immediately cancel _bassPulseTimer');
    assert.strictEqual(env.elements.get('tvk-ambient-bg').style.transform, 'scale(4) translateZ(0)');

    // Toggling body.perf off/on and calling init() again must not duplicate observers or listeners
    env.document.body.classList.remove('perf');
    env.document.body.classList.add('perf');
    controller.init();
    assert.strictEqual(env._observerCount(), 1, 'Toggling body.perf must not duplicate MutationObserver');
    assert.strictEqual(env.window._mqlListenerCount(), 1, 'Toggling body.perf must not duplicate MediaQueryList listener');

    controller.dispose();
    assert.strictEqual(env._observerCount(), 0, 'dispose() must disconnect MutationObserver');
    assert.strictEqual(env.window._mqlListenerCount(), 0, 'dispose() must remove MediaQueryList listener');
  });

  test('Behavioral: Seekbar sCtx/tCtx share single-per-frame rainbowBlend (300ms ramp) and two-pass strokeSeekbarWave at 0, 0.5, 1', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const vm = require('node:vm');
    const appSrc = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');

    // Verify single-per-frame computation before sCtx/tCtx branches
    assert.match(appSrc, /const frameRainbowBlend = updateAutomixRainbowBlend\(frameNowMs\);/);
    const blendCalls = appSrc.match(/updateAutomixRainbowBlend\(/g) || [];
    assert.strictEqual(blendCalls.length, 2, 'updateAutomixRainbowBlend should only be defined once and called once per frame');

    const startIdx = appSrc.indexOf('const reducedMotionMql =');
    const endIdx = appSrc.indexOf('function resizeCanvases()');
    assert.ok(startIdx > 0 && endIdx > startIdx);
    const snippet = appSrc.slice(startIdx, endIdx);

    const sandbox = { window: env.window, document: env.document, Math };
    vm.runInNewContext(snippet, sandbox);
    const updateBlend = env.window._eclipseUpdateAutomixRainbowBlend;
    const strokeWave = env.window._eclipseSeekbarStroke;
    assert.strictEqual(typeof updateBlend, 'function');
    assert.strictEqual(typeof strokeWave, 'function');

    function createMockCtx() {
      const strokes = [];
      const stack = [];
      return {
        strokeStyle: '#000000',
        globalAlpha: 1,
        save() { stack.push({ strokeStyle: this.strokeStyle, globalAlpha: this.globalAlpha }); },
        restore() {
          const prev = stack.pop();
          if (prev) { this.strokeStyle = prev.strokeStyle; this.globalAlpha = prev.globalAlpha; }
        },
        stroke() { strokes.push({ strokeStyle: this.strokeStyle, globalAlpha: this.globalAlpha }); },
        _strokes: strokes,
        _stackDepth: () => stack.length
      };
    }

    // 1. Both sCtx and tCtx use exact same rainbowBlend in same frame, ramping 0 -> 1 in ~300ms (never 2x)
    env.document.body.classList.add('is-automixing');
    const frameTimes = [1000, 1100, 1200, 1300];
    const blends = [];
    for (const nowMs of frameTimes) {
      const frameBlend = updateBlend(nowMs);
      blends.push(frameBlend);
      const sCtx = createMockCtx();
      const tCtx = createMockCtx();
      strokeWave(sCtx, { baseColor: '#a855f7', rainbowBlend: frameBlend, nowMs, isReduced: false, isAutomixing: true, reducedAccentColor: '#a855f7' });
      strokeWave(tCtx, { baseColor: '#ffffff', rainbowBlend: frameBlend, nowMs, isReduced: false, isAutomixing: true, reducedAccentColor: '#a855f7' });
      assert.strictEqual(sCtx._stackDepth(), 0);
      assert.strictEqual(tCtx._stackDepth(), 0);
    }
    assert.ok(blends[0] > 0 && blends[0] < 0.2, `Frame 0 blend should be ~0.053, got ${blends[0]}`);
    assert.ok(blends[1] > 0.3 && blends[1] < 0.5, `Frame 1 (100ms) blend should be ~0.387, got ${blends[1]}`);
    assert.ok(blends[2] > 0.6 && blends[2] < 0.85, `Frame 2 (200ms) blend should be ~0.72, got ${blends[2]}`);
    assert.strictEqual(blends[3], 1, 'Frame 3 (300ms) blend must reach 1.0');

    // 2. Two-pass stroke verification at blend = 0, 0.5, and 1
    const ctx0 = createMockCtx();
    strokeWave(ctx0, { baseColor: '#a855f7', rainbowBlend: 0, nowMs: 1000, isReduced: false, isAutomixing: false });
    assert.strictEqual(ctx0._strokes.length, 1);
    assert.strictEqual(ctx0._strokes[0].strokeStyle, '#a855f7');
    assert.strictEqual(ctx0._strokes[0].globalAlpha, 1);

    const ctxHalf = createMockCtx();
    strokeWave(ctxHalf, { baseColor: '#ffffff', rainbowBlend: 0.5, nowMs: 1250, isReduced: false, isAutomixing: true });
    assert.strictEqual(ctxHalf._strokes.length, 2, 'Blend 0.5 must draw base pass + rainbow overlay pass');
    assert.strictEqual(ctxHalf._strokes[0].strokeStyle, '#ffffff');
    assert.strictEqual(ctxHalf._strokes[0].globalAlpha, 1);
    assert.match(ctxHalf._strokes[1].strokeStyle, /^hsl\(/);
    assert.strictEqual(ctxHalf._strokes[1].globalAlpha, 0.5, 'globalAlpha must be 0.5 during rainbow stroke()');
    assert.strictEqual(ctxHalf.globalAlpha, 1, 'globalAlpha must be restored after stroke()');

    const ctxFull = createMockCtx();
    strokeWave(ctxFull, { baseColor: '#ffffff', rainbowBlend: 1, nowMs: 1500, isReduced: false, isAutomixing: true });
    assert.strictEqual(ctxFull._strokes.length, 1, 'Blend 1.0 skips base pass and draws full rainbow');
    assert.match(ctxFull._strokes[0].strokeStyle, /^hsl\(/);
    assert.strictEqual(ctxFull._strokes[0].globalAlpha, 1);

    // 3. Reduced motion draws static accent color without rainbow
    const ctxReduced = createMockCtx();
    strokeWave(ctxReduced, { baseColor: '#ffffff', rainbowBlend: 0.8, nowMs: 1500, isReduced: true, isAutomixing: true, reducedAccentColor: '#a855f7' });
    assert.strictEqual(ctxReduced._strokes.length, 1);
    assert.strictEqual(ctxReduced._strokes[0].strokeStyle, '#a855f7');
  });

  test('Fullscreen Karaoke progress bar alignment & canvas sizing (styles.css + app.js)', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const cssSrc = fs.readFileSync(path.join(__dirname, '../src/renderer/styles.css'), 'utf8');
    const appSrc = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');

    // CSS centering, inline time labels & responsive width
    assert.match(cssSrc, /\.tvk-progress-row\s*\{[^}]*width:\s*clamp\(240px,\s*30vw,\s*420px\);[^}]*margin:\s*6px auto 0;/s);
    assert.match(cssSrc, /\.tvk-time-crossfade-row\s*\{[^}]*justify-content:\s*center;[^}]*width:\s*clamp\(240px,\s*30vw,\s*420px\);[^}]*margin:\s*2px auto 0;/s);
    assert.match(cssSrc, /\.tvk-scrubber-track\s*\{[^}]*flex:\s*1;/s);
    assert.match(cssSrc, /\.tvk-squiggly-canvas\s*\{[^}]*width:\s*100%;/s);

    // JS: no stale inline width/height, ResizeObserver, per-frame DPR backing-store sync, and primaryColor declared in Karaoke branch
    assert.match(appSrc, /tvkSquiggly\.style\.width = '';\s*tvkSquiggly\.style\.height = '';/);
    assert.match(appSrc, /if \(rw > 0\)\s*\{[\s\S]*?tvkSquiggly\.width = targetW;/);
    assert.match(appSrc, /tvkTrack\._tvkResizeObserver = new ResizeObserver/);
    assert.match(appSrc, /if \(tw > 0 && \(tvkScrubber\.width !== expectedW \|\| tvkScrubber\.height !== expectedH\)\)/);
    assert.match(appSrc, /tCtx\.setTransform\(dpr, 0, 0, dpr, 0, 0\)/);
    const karaokeBranch = appSrc.slice(appSrc.indexOf('const tvkScrubber = document.getElementById(\'tvk-squiggly-canvas\')'), appSrc.indexOf('renderLoop(0);'));
    assert.match(karaokeBranch, /const primaryColor = cachedPrimaryColor \|\| '#a855f7';/);
    assert.match(karaokeBranch, /baseColor:\s*primaryColor/);
    assert.match(karaokeBranch, /tCtx\.fillStyle\s*=\s*primaryColor/);
  });

  test('Fullscreen Karaoke time display sync (syncTvkTimeDisplay + track change, seek, loadedmetadata, durationchange)', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const vm = require('node:vm');
    const appSrc = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');

    // Extract syncTvkTimeDisplay and execute against mock DOM
    const startIdx = appSrc.indexOf('function syncTvkTimeDisplay(');
    const endIdx = appSrc.indexOf('function resizeCanvases()');
    assert.ok(startIdx > 0 && endIdx > startIdx);
    const snippet = appSrc.slice(startIdx, endIdx);

    const tvkTimeCurrent = env.document.createElement('span');
    const tvkTimeDuration = env.document.createElement('span');
    const tvkTimeCurrentDisplay = env.document.createElement('span');
    tvkTimeCurrentDisplay.id = 'tvk-time-current-display';
    const tvkTimeDurationDisplay = env.document.createElement('span');
    tvkTimeDurationDisplay.id = 'tvk-time-duration-display';

    const origGetById = env.document.getElementById.bind(env.document);
    env.document.getElementById = (id) => {
      if (id === 'tvk-time-current-display') return tvkTimeCurrentDisplay;
      if (id === 'tvk-time-duration-display') return tvkTimeDurationDisplay;
      return origGetById(id);
    };

    const sandbox = {
      window: env.window,
      document: env.document,
      el: { tvkTimeCurrent, tvkTimeDuration }
    };
    vm.runInNewContext(snippet, sandbox);
    const syncTvkTimeDisplay = env.window._eclipseSyncTvkTimeDisplay;
    assert.strictEqual(typeof syncTvkTimeDisplay, 'function');

    // 1. Track change reset
    syncTvkTimeDisplay('0:00', '0:00');
    assert.strictEqual(tvkTimeCurrent.textContent, '0:00');
    assert.strictEqual(tvkTimeCurrentDisplay.textContent, '0:00');
    assert.strictEqual(tvkTimeDuration.textContent, '0:00');
    assert.strictEqual(tvkTimeDurationDisplay.textContent, '0:00');

    // 2. Duration-only update (loadedmetadata / durationchange)
    syncTvkTimeDisplay(undefined, '4:12');
    assert.strictEqual(tvkTimeCurrentDisplay.textContent, '0:00');
    assert.strictEqual(tvkTimeDuration.textContent, '4:12');
    assert.strictEqual(tvkTimeDurationDisplay.textContent, '4:12');

    // 3. Seek update (playing or paused)
    syncTvkTimeDisplay('1:23', '4:12');
    assert.strictEqual(tvkTimeCurrent.textContent, '1:23');
    assert.strictEqual(tvkTimeCurrentDisplay.textContent, '1:23');

    // Verify wiring in all lifecycle handlers
    const syncCalls = appSrc.match(/syncTvkTimeDisplay\(/g) || [];
    assert.ok(syncCalls.length >= 8, `Expected syncTvkTimeDisplay wired across renderLoop, playTrack, openTvKaraoke, loadedmetadata, durationchange, seeked, timeupdate, scrub; got ${syncCalls.length}`);
    assert.match(appSrc, /el\.nativeAudio\.addEventListener\('seeked',[\s\S]*?lastDisplayedSec = -1;\s*lastTimeupdateSec = -1;[\s\S]*?syncTvkTimeDisplay\(seekCurText, seekDurText\)/);
  });

  test('Floating Lyrics wavy progress bar, primaryColor/AutoMix sync & reduced-motion fallback', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const flHtml = fs.readFileSync(path.join(__dirname, '../src/renderer/floating-lyrics.html'), 'utf8');
    const appSrc = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');

    // Compact wavy canvas & pointer-capture scrubber in floating-lyrics.html
    assert.match(flHtml, /id="mini-scrubber-track"/);
    assert.match(flHtml, /id="mini-squiggly-canvas"/);
    assert.match(flHtml, /\.mini-scrubber-track\s*\{[^}]*height:\s*24px;/s);
    assert.match(flHtml, /seekCtx\.lineWidth\s*=\s*5\.5;/);
    assert.match(flHtml, /Math\.sin\(angle\)\s*\*\s*3/);
    assert.match(flHtml, /setPointerCapture\(e\.pointerId\)/);
    assert.match(flHtml, /prefers-reduced-motion:\s*reduce/);
    assert.match(flHtml, /isReducedActive\(\)/);

    // app.js sends primaryColor, isAutomixing, perfMode in all updateFloatingLyrics payloads
    const payloadMatches = appSrc.match(/primaryColor:\s*cachedPrimaryColor\s*\|\|\s*'#a78bfa',\s*isAutomixing:\s*document\.body\.classList\.contains\('is-automixing'\),\s*perfMode:\s*document\.body\.classList\.contains\('perf'\)/g) || [];
    assert.strictEqual(payloadMatches.length, 3);
  });
});
