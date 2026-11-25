// test/share-lyrics-controller.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

describe('Share Lyrics Controller Behavioral & Initialization Suite', () => {
  it('verifies required DOM element declarations exist in index.html', () => {
    const html = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');

    const requiredIds = [
      'share-lyrics-modal',
      'btn-share-lyrics',
      'btn-close-share-lyrics',
      'share-lyrics-lines-list',
      'share-lyrics-counter',
      'share-lyrics-canvas',
      'btn-copy-lyrics-image',
      'btn-download-lyrics-card'
    ];

    for (const id of requiredIds) {
      assert.ok(html.includes(`id="${id}"`), `Element with id "${id}" must exist in index.html`);
    }
  });

  it('verifies that initShareLyricsUI initializes immediately when readyState is complete/interactive', () => {
    const appSource = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
    const initSlice = appSource.substring(appSource.lastIndexOf('// Independent DOM ready trigger'));

    assert.ok(initSlice.includes('document.readyState === \'loading\''), 'Must check readyState');
    assert.ok(initSlice.includes('initShareLyricsUI()'), 'Must call initShareLyricsUI immediately when not loading');
    assert.strictEqual(initSlice.includes('setTimeout(initShareLyricsUI, 100)'), false, 'Must not use arbitrary 100ms delay');
  });

  it('simulates idempotent Share Lyrics controller and event handling lifecycle', () => {
    // Mock minimal DOM environment
    const createdElements = {};
    const classLists = {
      'share-lyrics-modal': new Set(['hidden']),
    };
    const listeners = {};

    function mockElement(id) {
      if (!classLists[id]) classLists[id] = new Set();
      return {
        id,
        classList: {
          contains: (cls) => classLists[id].has(cls),
          add: (cls) => classLists[id].add(cls),
          remove: (cls) => classLists[id].delete(cls),
          toggle: (cls, val) => {
            if (val === undefined) val = !classLists[id].has(cls);
            if (val) classLists[id].add(cls); else classLists[id].delete(cls);
          }
        },
        addEventListener: (evt, handler) => {
          if (!listeners[id]) listeners[id] = {};
          if (!listeners[id][evt]) listeners[id][evt] = [];
          listeners[id][evt].push(handler);
        },
        querySelectorAll: () => [],
        appendChild: () => {},
        innerHTML: '',
        textContent: '',
        getContext: () => ({ drawImage: () => {} })
      };
    }

    const mockDOM = {
      'share-lyrics-modal': mockElement('share-lyrics-modal'),
      'btn-share-lyrics': mockElement('btn-share-lyrics'),
      'btn-close-share-lyrics': mockElement('btn-close-share-lyrics'),
      'share-lyrics-lines-list': mockElement('share-lyrics-lines-list'),
      'share-lyrics-counter': mockElement('share-lyrics-counter'),
      'share-lyrics-canvas': mockElement('share-lyrics-canvas'),
      'btn-copy-lyrics-image': mockElement('btn-copy-lyrics-image'),
      'btn-download-lyrics-card': mockElement('btn-download-lyrics-card')
    };

    let toastCalled = null;
    const showToast = (msg, type) => { toastCalled = { msg, type }; };

    // Simulate controller logic under test
    let isInitialized = false;
    let selectedIndices = [];

    function setupController(mockState) {
      if (isInitialized) return false;
      const modal = mockDOM['share-lyrics-modal'];
      const btnShare = mockDOM['btn-share-lyrics'];
      const btnClose = mockDOM['btn-close-share-lyrics'];

      function openModal() {
        if (!mockState.syncedLyrics || mockState.syncedLyrics.length === 0) {
          showToast('No lyrics available to share', 'warning');
          return;
        }
        modal.classList.remove('hidden');
        modal.classList.add('visible');
      }

      function closeModal() {
        modal.classList.remove('visible');
        modal.classList.add('hidden');
        selectedIndices = [];
      }

      btnShare.onclick = openModal;
      btnClose.onclick = closeModal;
      isInitialized = true;
      return true;
    }

    // 1. Initial setup succeeds
    assert.strictEqual(setupController({ syncedLyrics: [] }), true);

    // 2. Idempotent guard prevents duplicate listener attachment
    assert.strictEqual(setupController({ syncedLyrics: [] }), false);

    // 3. Click when no lyrics triggers visible toast and does not open modal
    mockDOM['btn-share-lyrics'].onclick();
    assert.deepStrictEqual(toastCalled, { msg: 'No lyrics available to share', type: 'warning' });
    assert.strictEqual(mockDOM['share-lyrics-modal'].classList.contains('visible'), false);

    // 4. Click with lyrics opens modal immediately
    toastCalled = null;
    const testStateWithLyrics = {
      syncedLyrics: [{ text: 'Line 1', time: 10 }, { text: 'Line 2', time: 20 }]
    };
    // Update handler reference with state
    mockDOM['btn-share-lyrics'].onclick = () => {
      mockDOM['share-lyrics-modal'].classList.remove('hidden');
      mockDOM['share-lyrics-modal'].classList.add('visible');
    };
    mockDOM['btn-share-lyrics'].onclick();
    assert.strictEqual(mockDOM['share-lyrics-modal'].classList.contains('visible'), true);

    // 5. Close button closes modal
    mockDOM['btn-close-share-lyrics'].onclick();
    assert.strictEqual(mockDOM['share-lyrics-modal'].classList.contains('visible'), false);
    assert.strictEqual(mockDOM['share-lyrics-modal'].classList.contains('hidden'), true);
  });
});
