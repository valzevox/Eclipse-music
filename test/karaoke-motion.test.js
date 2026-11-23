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

  const document = {
    body: {
      classList: {
        _bodyClasses: new Set(),
        add(c) { this._bodyClasses.add(c); },
        remove(c) { this._bodyClasses.delete(c); },
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

  let prefersReducedMotion = false;

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
      return {
        matches: query.includes('prefers-reduced-motion') ? prefersReducedMotion : false
      };
    },
    setPrefersReducedMotion(val) {
      prefersReducedMotion = val;
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

  return { listeners, elements, window, document };
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
});
