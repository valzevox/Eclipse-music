// src/renderer/automix/settings-controller.js
// JavaScript / settings-controller.js / Web / Eclipse PC & Mobile
// Centralized settings synchronization controller for Smart AutoMix DJ modes and options.

(function (root) {
  'use strict';

  const VALID_AUTOMIX_MODES = new Set([
    'equal_power',
    'tempo_synced'
  ]);

  function normalizeAutoMixMode(mode) {
    if (mode === 'tempo_synced' || mode === 'dj_mix' || mode === 'smart') {
      return 'tempo_synced';
    }
    return 'equal_power';
  }

  /**
   * Synchronize AutoMix DJ settings into localStorage, dispatch mode change events,
   * configure the AutoMixDJ instance, and trigger/cancel background collection scans.
   *
   * @param {object} opts
   * @param {boolean} [opts.enabled]
   * @param {string} [opts.mode]
   * @param {boolean} [opts.djFilter]
   * @param {boolean} [opts.autoDuration]
   * @param {number} [opts.durationSec]
   * @param {boolean} [opts.keepAlbumContinuous]
   * @param {object} [context] - Context with window, localStorage, and djInstance overrides
   * @returns {object} updated config or instance status
   */
  function syncAutoMixSettings(opts = {}, context = {}) {
    const win = context.window || (typeof window !== 'undefined' ? window : null);
    const storage = context.localStorage || (typeof localStorage !== 'undefined' ? localStorage : null);
    const dj = context.djInstance || (win ? win.autoMixDjInstance : null);

    const cfg = {};
    if (typeof opts.enabled === 'boolean') {
      cfg.enabled = opts.enabled;
      if (storage) {
        try { storage.setItem('eclipse_automix', opts.enabled ? '1' : '0'); } catch (_) {}
      }
    }
    if (typeof opts.djFilter === 'boolean') {
      cfg.djFilter = opts.djFilter;
      if (storage) {
        try { storage.setItem('eclipse_automix_dj_filter', opts.djFilter ? '1' : '0'); } catch (_) {}
      }
    }
    if (typeof opts.autoDuration === 'boolean') {
      cfg.autoDuration = opts.autoDuration;
      if (storage) {
        try { storage.setItem('eclipse_automix_auto', opts.autoDuration ? '1' : '0'); } catch (_) {}
      }
    }
    if (typeof opts.durationSec === 'number' && Number.isFinite(opts.durationSec)) {
      const rawSec = Math.max(0, Math.min(15, opts.durationSec));
      if (storage) {
        try { storage.setItem('eclipse_crossfade', String(rawSec)); } catch (_) {}
      }
      if (rawSec > 0) {
        cfg.durationSec = Math.max(1, rawSec);
      } else if (typeof opts.enabled !== 'boolean') {
        cfg.enabled = false;
        if (storage) {
          try { storage.setItem('eclipse_automix', '0'); } catch (_) {}
        }
      }
    }
    if (typeof opts.keepAlbumContinuous === 'boolean') {
      cfg.keepAlbumContinuous = opts.keepAlbumContinuous;
      if (storage) {
        try { storage.setItem('eclipse_automix_skip_album', opts.keepAlbumContinuous ? '1' : '0'); } catch (_) {}
      }
    } else if (storage && storage.getItem('eclipse_automix_skip_album') !== null) {
      cfg.keepAlbumContinuous = storage.getItem('eclipse_automix_skip_album') !== '0';
    }

    if (opts.mode) {
      const normalizedMode = normalizeAutoMixMode(opts.mode);
      const prevMode = dj ? dj.mode : null;
      if (prevMode && prevMode !== normalizedMode) {
        if (win && typeof win.dispatchEvent === 'function') {
          try {
            const detail = { previousMode: prevMode, newMode: normalizedMode };
            const evt = (typeof CustomEvent !== 'undefined')
              ? new CustomEvent('eclipse:automix-mode-changed', { detail })
              : { type: 'eclipse:automix-mode-changed', detail };
            win.dispatchEvent(evt);
          } catch (_) {}
        }
      }
      cfg.mode = normalizedMode;
      if (storage) {
        try { storage.setItem('eclipse_automix_mode', normalizedMode); } catch (_) {}
      }
    }

    if (dj && typeof dj.configure === 'function') {
      dj.configure(cfg);
      const curMode = dj.mode;
      if (!dj.enabled || curMode === 'equal_power') {
        if (win && win._analysisCoordinatorInstance && typeof win._analysisCoordinatorInstance.cancel === 'function') {
          win._analysisCoordinatorInstance.cancel();
        }
      } else if (curMode === 'tempo_synced' && win && typeof win._triggerAutoMixCollectionScan === 'function') {
        win._triggerAutoMixCollectionScan(false);
      }
      return typeof dj.getStatus === 'function' ? dj.getStatus() : cfg;
    }
    return cfg;
  }

  function resolveInitialAutoMixMode(storedMode) {
    return normalizeAutoMixMode(storedMode);
  }

  /**
   * Register unified AutoMix event listeners on nativeAudio and window.
   * Centralizes cancellation (seek, pause, track switch, error, queue replacement, mode change).
   *
   * @param {object} params
   * @param {HTMLAudioElement} params.nativeAudio - Native player audio element
   * @param {Window} [params.win] - Window or global event target
   * @param {Function} [params.getCoreState] - Function returning player state
   * @param {object} [params.djInstance] - AutoMixDJ instance override
   * @returns {Function} cleanup function to unregister listeners
   */
  function registerAutoMixEventListeners({ nativeAudio, win = (typeof window !== 'undefined' ? window : null), getCoreState, djInstance }) {
    if (!win) return () => {};
    const abortActive = (reason) => {
      const dj = djInstance || (win ? win.autoMixDjInstance : null);
      if (dj && typeof dj.abortCrossfade === 'function') {
        dj.abortCrossfade(reason);
      }
    };

    const onPause = () => {
      const st = typeof getCoreState === 'function' ? getCoreState() : null;
      if (st && !st.isPlaying) abortActive('pause');
    };
    const onSeeking = () => abortActive('seek');
    const onError = () => abortActive('error');
    const onQueueReplaced = () => abortActive('queue_replaced');
    const onModeChanged = () => abortActive('mode_change');

    if (nativeAudio && typeof nativeAudio.addEventListener === 'function') {
      nativeAudio.addEventListener('pause', onPause);
      nativeAudio.addEventListener('seeking', onSeeking);
      nativeAudio.addEventListener('error', onError);
    }
    if (typeof win.addEventListener === 'function') {
      win.addEventListener('eclipse:queue-replaced', onQueueReplaced);
      win.addEventListener('eclipse:automix-mode-changed', onModeChanged);
    }

    return () => {
      if (nativeAudio && typeof nativeAudio.removeEventListener === 'function') {
        nativeAudio.removeEventListener('pause', onPause);
        nativeAudio.removeEventListener('seeking', onSeeking);
        nativeAudio.removeEventListener('error', onError);
      }
      if (typeof win.removeEventListener === 'function') {
        win.removeEventListener('eclipse:queue-replaced', onQueueReplaced);
        win.removeEventListener('eclipse:automix-mode-changed', onModeChanged);
      }
    };
  }

  const exportObj = {
    VALID_AUTOMIX_MODES,
    normalizeAutoMixMode,
    syncAutoMixSettings,
    resolveInitialAutoMixMode,
    registerAutoMixEventListeners
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exportObj;
  }
  if (root) {
    root.AutoMixSettingsController = exportObj;
    root.syncAutoMixSettings = syncAutoMixSettings;
  }
})(typeof window !== 'undefined' ? window : globalThis);
