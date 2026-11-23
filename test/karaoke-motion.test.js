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
        contains(cls) { return false; }
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
      return { matches: false };
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

describe('KaraokeMotionController Lifecycle & Guardrails', () => {
  let env;
  let KaraokeMotionController;

  beforeEach(() => {
    env = setupMockEnvironment();
    // Re-require fresh controller
    delete require.cache[require.resolve('../src/renderer/karaoke-motion.js')];
    const mod = require('../src/renderer/karaoke-motion.js');
    KaraokeMotionController = mod.KaraokeMotionController;
  });

  test('Test Case 1: Controller init once - idempotency and single listener set', () => {
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

  test('Test Case 2: Progress ownership - ignores stale transitionId', () => {
    const controller = new KaraokeMotionController();
    controller.init();

    // Start transition 1
    controller.handleAutomixState({
      active: true,
      transitionId: 'tx-001',
      nextTrack: { title: 'Track A', artist: 'Artist A' },
      durationSec: 6.0,
      bpm: 124
    });

    assert.strictEqual(controller.state.phase, 'mixing');
    assert.strictEqual(controller.state.transitionId, 'tx-001');

    // Send valid progress for tx-001
    controller.handleAutomixProgress({
      transitionId: 'tx-001',
      progress: 0.35
    });
    assert.strictEqual(controller.state.progress, 0.35);

    // Start transition 2 (new track incoming)
    controller.handleAutomixState({
      active: true,
      transitionId: 'tx-002',
      nextTrack: { title: 'Track B', artist: 'Artist B' },
      durationSec: 8.0,
      bpm: 128
    });
    assert.strictEqual(controller.state.transitionId, 'tx-002');
    assert.strictEqual(controller.state.progress, 0.0);

    // Stale progress from tx-001 arrives delayed
    controller.handleAutomixProgress({
      transitionId: 'tx-001',
      progress: 0.95
    });

    // Verify stale progress was ignored and didn't trigger dominance or overwrite
    assert.strictEqual(controller.state.progress, 0.0, 'Stale progress must be discarded');
    assert.strictEqual(controller.state.phase, 'mixing');
  });

  test('Test Case 3: Abort outcomes - cancelled vs error vs settled', () => {
    const controller = new KaraokeMotionController();
    controller.init();

    // 1. Abort scenario (user skipped / crossfade cancelled)
    controller.handleAutomixState({
      active: true,
      transitionId: 'tx-cancel',
      nextTrack: { title: 'Track C' }
    });
    controller.handleAutomixProgress({
      transitionId: 'tx-cancel',
      progress: 0.42
    });

    controller.handleAutomixState({
      active: false,
      transitionId: 'tx-cancel',
      aborted: true,
      reason: 'user_skipped'
    });

    assert.strictEqual(controller.state.phase, 'cancelled', 'Aborted transition must have phase cancelled');
    assert.strictEqual(controller.state.progress, 0.42, 'Progress must not be forced to 1.0 on cancel');

    // 2. Failure scenario (decode error)
    controller.handleAutomixState({
      active: true,
      transitionId: 'tx-err',
      nextTrack: { title: 'Track D' }
    });
    controller.handleAutomixState({
      active: false,
      transitionId: 'tx-err',
      failed: true,
      reason: 'decode_error'
    });
    assert.strictEqual(controller.state.phase, 'error', 'Failed transition must have phase error');

    // 3. Normal settled completion
    controller.handleAutomixState({
      active: true,
      transitionId: 'tx-ok',
      nextTrack: { title: 'Track E' }
    });
    controller.handleAutomixState({
      active: false,
      transitionId: 'tx-ok',
      completed: true
    });
    assert.strictEqual(controller.state.phase, 'settled', 'Completed transition must settle');
    assert.strictEqual(controller.state.progress, 1.0);
  });

  test('Test Case 4: Dominant switch dispatches at >= 60% with transitionId', () => {
    const controller = new KaraokeMotionController();
    controller.init();

    let dominantFired = 0;
    let dominantDetail = null;

    env.window.addEventListener('eclipse:karaoke-dominant-switch', (ev) => {
      dominantFired += 1;
      dominantDetail = ev.detail;
    });

    controller.handleAutomixState({
      active: true,
      transitionId: 'tx-dom-test',
      nextTrack: { title: 'Dominant Song', artist: 'Artist X' }
    });

    // 50% progress - dominance should not trigger yet
    controller.handleAutomixProgress({
      transitionId: 'tx-dom-test',
      progress: 0.50
    });
    assert.strictEqual(dominantFired, 0);
    assert.strictEqual(controller.state.phase, 'mixing');

    // 60% progress - triggers dominance switch once
    controller.handleAutomixProgress({
      transitionId: 'tx-dom-test',
      progress: 0.60
    });
    assert.strictEqual(dominantFired, 1);
    assert.strictEqual(controller.state.phase, 'dominance');
    assert.strictEqual(dominantDetail.transitionId, 'tx-dom-test');
    assert.strictEqual(dominantDetail.toTrack.title, 'Dominant Song');

    // 70% progress - does not re-dispatch dominance
    controller.handleAutomixProgress({
      transitionId: 'tx-dom-test',
      progress: 0.70
    });
    assert.strictEqual(dominantFired, 1, 'Dominance switch must only fire once per transition');
  });

  test('Test Case 5: Bass Pulse timer generation protects overlapping pulses', async () => {
    const controller = new KaraokeMotionController();
    controller.init();

    const ambientBg = env.elements.get('tvk-ambient-bg');
    assert.ok(ambientBg);

    // Initial pulse A (energy = 0.8)
    controller.triggerBassPulse(0.8);
    const genA = controller._bassPulseGeneration;
    assert.strictEqual(genA, 1);
    assert.ok(controller._bassPulseTimer !== null);
    assert.ok(ambientBg.style.transform.includes('scale'));

    // Wait 145ms (passes the 140ms gate but before 160ms decay of pulse A)
    await new Promise(r => setTimeout(r, 145));

    // Pulse B triggers
    controller.triggerBassPulse(0.9);
    const genB = controller._bassPulseGeneration;
    assert.strictEqual(genB, 2, 'New pulse increments generation');

    // Wait 25ms so that 145 + 25 = 170ms elapsed from pulse A
    // (if pulse A timer was not cleared or checked generation, it would reset transform)
    await new Promise(r => setTimeout(r, 25));

    // At 170ms, pulse A expired, but pulse B is only 25ms old and should still be active
    assert.strictEqual(controller._bassPulseGeneration, 2);

    // Wait for pulse B timer to finish (150ms more)
    await new Promise(r => setTimeout(r, 150));
    assert.strictEqual(ambientBg.style.transform, 'scale(4) translateZ(0)', 'Reset applied cleanly after pulse B');
  });
});
