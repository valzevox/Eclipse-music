// src/renderer/automix/playback-handover.js
// JavaScript / playback-handover.js / Web / Eclipse PC & Mobile
// Seamless dual-deck handover: preserves currentTime, synchronizes live decks, prevents premature cut

(function (root) {
  'use strict';

  const _suppressionMod = (typeof module !== 'undefined' && module.exports)
    ? (function() {
        try { return require('./suppression-controller'); }
        catch (_) { return { getVolumeSyncSuppression: () => null }; }
      })()
    : { getVolumeSyncSuppression: () => (typeof window !== 'undefined' && window.volumeSyncSuppression ? window.volumeSyncSuppression : null) };

  function _getHandoverSuppressionManager() {
    if (typeof window !== 'undefined' && window.volumeSyncSuppression) {
      return window.volumeSyncSuppression;
    }
    return _suppressionMod.getVolumeSyncSuppression();
  }

class PlaybackHandover {
  constructor(options = {}) {
    this.telemetry = options.telemetry || null;
  }

  createHandoverToken(track, auxAudio, targetIndex, meta = {}) {
    if (!track || !auxAudio) return null;
    return {
      trackId: track.id || track.videoId,
      track,
      src: auxAudio.src || track._preloadedStreamUrl || '',
      auxAudio,
      currentTime: (auxAudio && !isNaN(auxAudio.currentTime)) ? auxAudio.currentTime : 0,
      targetIndex: typeof targetIndex === 'number' ? targetIndex : -1,
      transitionId: meta.transitionId || null,
      mode: meta.mode || null,
      durationSec: meta.durationSec || 0,
      timestamp: Date.now()
    };
  }

  isHandoverTarget(state, track) {
    if (!state || !state._autoMixHandover || !track) return false;
    const h = state._autoMixHandover;
    const tId = track.id || track.videoId;
    return !!(tId === h.trackId || (track._matchedYtId && track._matchedYtId === h.trackId));
  }

  executeSwap(nativeAudio, auxAudio, handover, options = {}) {
    if (!nativeAudio || !handover) return false;

    const targetLoadToken = options.currentToken;
    const isOwnerInvocation = () => {
      if (typeof targetLoadToken === 'undefined') return true;
      if (options.state && typeof options.state.loadToken !== 'undefined') {
        return options.state.loadToken === targetLoadToken;
      }
      return true;
    };

    const stopAux = () => {
      try {
        if (auxAudio) {
          auxAudio.pause();
          auxAudio.currentTime = 0;
        }
      } catch (_) {}
    };

    const suppressionMgr = _getHandoverSuppressionManager();
    const suppressToken = suppressionMgr ? suppressionMgr.acquire('PlaybackHandover') : null;

    const releaseSuppression = () => {
      if (suppressionMgr && suppressToken !== null) {
        suppressionMgr.release(suppressToken);
      }
    };

    nativeAudio.muted = true;
    nativeAudio.preload = 'auto';

    let swapped = false;
    let started = false;

    let readinessTimeout = null;
    let playingTimeout = null;

    const cleanupReadinessListeners = () => {
      if (readinessTimeout) {
        clearTimeout(readinessTimeout);
        readinessTimeout = null;
      }
      if (playingTimeout) {
        clearTimeout(playingTimeout);
        playingTimeout = null;
      }
      nativeAudio.removeEventListener('loadedmetadata', onReady);
      nativeAudio.removeEventListener('canplay', onReady);
    };

    const finishSwap = () => {
      if (swapped) return;
      swapped = true;
      cleanupReadinessListeners();
      nativeAudio.removeEventListener('error', onNativeError);
      nativeAudio.removeEventListener('playing', finishSwap);

      // Guard: if a newer load has taken over while waiting for playing, abort swap to protect new playback
      if (!isOwnerInvocation()) {
        nativeAudio.muted = !!options.isMuted;
        releaseSuppression();
        return;
      }

      nativeAudio.muted = !!options.isMuted;
      if (typeof options.onDeckGainsReset === 'function') {
        options.onDeckGainsReset();
      } else if (typeof window !== 'undefined' && window.audioEngine && typeof window.audioEngine.setDeckGains === 'function') {
        window.audioEngine.setDeckGains({ deckA: 1.0, deckB: 0.0, rampMs: 25 });
      }
      stopAux();
      if (handover.transitionId && typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
        try {
          window.dispatchEvent(new CustomEvent('eclipse:automix-state', {
            detail: {
              phase: 'settled',
              active: false,
              transitionId: handover.transitionId,
              nextTrack: handover.track || null,
              targetIndex: handover.targetIndex,
              durationSec: handover.durationSec || 0,
              mode: handover.mode || 'equal_power',
              progress: 1.0,
              completed: true,
              aborted: false,
              failed: false,
              reason: 'completed'
            }
          }));
        } catch (_) {}
      }
      setTimeout(() => {
        releaseSuppression();
      }, 80);
      if (typeof options.applySettings === 'function') {
        options.applySettings();
      }
    };

    const onNativeError = (err) => {
      console.warn('[PlaybackHandover] nativeAudio source error during handover; keeping auxAudio running:', err);
      cleanupReadinessListeners();
      nativeAudio.removeEventListener('error', onNativeError);
      nativeAudio.removeEventListener('playing', finishSwap);
      nativeAudio.muted = !!options.isMuted;
      releaseSuppression();
      if (!isOwnerInvocation()) return;
      if (typeof options.onDeckGainsReset === 'function') {
        if (typeof window !== 'undefined' && window.audioEngine && typeof window.audioEngine.setDeckGains === 'function') {
          window.audioEngine.setDeckGains({ deckA: 0.0, deckB: 1.0, rampMs: 20 });
        }
      }
    };

    const attachPlayAndSwap = () => {
      if (started) return;
      started = true;
      cleanupReadinessListeners();

      // Guard: if loadToken changed while waiting for loadedmetadata/canplay, abort and do not play
      if (!isOwnerInvocation()) {
        nativeAudio.removeEventListener('error', onNativeError);
        nativeAudio.muted = !!options.isMuted;
        releaseSuppression();
        return;
      }

      const liveTime = (auxAudio && !auxAudio.paused && Number.isFinite(auxAudio.currentTime))
        ? auxAudio.currentTime + 0.04
        : (handover.currentTime || 0);

      try { nativeAudio.currentTime = liveTime; } catch (_) {}

      nativeAudio.addEventListener('playing', finishSwap, { once: true });

      // Timeout for playing event after play() is initiated (3500ms)
      playingTimeout = setTimeout(() => {
        if (!swapped) {
          console.warn('[PlaybackHandover] nativeAudio playing timeout (3500ms); aborting handover to keep auxAudio playing');
          cleanupReadinessListeners();
          nativeAudio.removeEventListener('playing', finishSwap);
          nativeAudio.removeEventListener('error', onNativeError);
          nativeAudio.muted = !!options.isMuted;
          releaseSuppression();
          if (isOwnerInvocation() && typeof options.onDeckGainsReset === 'function') {
            if (typeof window !== 'undefined' && window.audioEngine && typeof window.audioEngine.setDeckGains === 'function') {
              window.audioEngine.setDeckGains({ deckA: 0.0, deckB: 1.0, rampMs: 20 });
            }
          }
        }
      }, 3500);

      const p = nativeAudio.play();
      if (p && typeof p.catch === 'function') {
        p.catch((playErr) => {
          console.warn('[PlaybackHandover] nativeAudio.play() rejected; keeping auxAudio running to prevent silence:', playErr?.message || playErr);
          // Critical P0: clean up listeners and restore mute so subsequent plays don't trigger finishSwap and kill auxAudio
          cleanupReadinessListeners();
          nativeAudio.removeEventListener('playing', finishSwap);
          nativeAudio.removeEventListener('error', onNativeError);
          nativeAudio.muted = !!options.isMuted;
          releaseSuppression();
          if (!isOwnerInvocation()) return;
          if (typeof options.onDeckGainsReset === 'function') {
            // Keep Deck B active
            if (typeof window !== 'undefined' && window.audioEngine && typeof window.audioEngine.setDeckGains === 'function') {
              window.audioEngine.setDeckGains({ deckA: 0.0, deckB: 1.0, rampMs: 20 });
            }
          }
        });
      }
    };

    const onReady = () => {
      attachPlayAndSwap();
    };

    nativeAudio.addEventListener('error', onNativeError, { once: true });

    readinessTimeout = setTimeout(() => {
      if (!started && !swapped) {
        console.warn('[PlaybackHandover] nativeAudio readiness timeout (4000ms); aborting handover to keep auxAudio playing');
        cleanupReadinessListeners();
        nativeAudio.removeEventListener('error', onNativeError);
        nativeAudio.muted = !!options.isMuted;
        releaseSuppression();
        if (isOwnerInvocation() && typeof options.onDeckGainsReset === 'function') {
          if (typeof window !== 'undefined' && window.audioEngine && typeof window.audioEngine.setDeckGains === 'function') {
            window.audioEngine.setDeckGains({ deckA: 0.0, deckB: 1.0, rampMs: 20 });
          }
        }
      }
    }, 4000);

    if (nativeAudio.src !== handover.src) {
      nativeAudio.src = handover.src;
      nativeAudio.addEventListener('loadedmetadata', onReady, { once: true });
      nativeAudio.addEventListener('canplay', onReady, { once: true });
    } else {
      if (nativeAudio.readyState >= 2) {
        attachPlayAndSwap();
      } else {
        nativeAudio.addEventListener('canplay', onReady, { once: true });
      }
    }
    return true;
  }

  /**
   * Production helper used by playTrack() to handle zero-gap dual-deck handover.
   * Distinguishes three terminal states:
   * - status: 'handled' (handover processed, caller returns early)
   * - status: 'stale' (currentToken !== state.loadToken, caller returns early without normal load)
   * - status: 'not-handover' (not a handover target, caller proceeds with normal playTrack)
   *
   * @param {object} params
   * @param {object} params.state - Player state
   * @param {object} params.track - Track to be played
   * @param {number} params.currentToken - Captured loadToken for the current play call
   * @param {HTMLAudioElement} params.nativeAudio - Native player audio element
   * @param {HTMLAudioElement} [params.auxAudio] - Optional fallback aux element
   * @param {object} [params.options] - Swap options (isMuted, onDeckGainsReset, applySettings)
   * @returns {{ status: 'handled'|'stale'|'not-handover', executed?: boolean }}
   */
  handlePlayTrackHandover({ state, track, currentToken, nativeAudio, auxAudio, options = {} }) {
    if (!state || !track) return { status: 'not-handover' };
    const handoverToken = state._autoMixHandover;
    const isHandover = !!(
      this.isHandoverTarget(state, track) ||
      (handoverToken && (
        track.id === handoverToken.trackId ||
        (track.videoId && track.videoId === handoverToken.trackId) ||
        (track._matchedYtId && track._matchedYtId === handoverToken.trackId)
      ))
    );

    if (!isHandover || !handoverToken) {
      return { status: 'not-handover' };
    }

    if (currentToken !== state.loadToken) {
      // Stale load token: caller must abort immediately and not corrupt newer playback
      return { status: 'stale' };
    }

    state._autoMixHandover = null; // Consumed exactly once
    const auxEl = handoverToken.auxAudio || auxAudio || (typeof document !== 'undefined' ? document.getElementById('eclipse-aux-audio') : null);
    const swapOptions = { ...options, currentToken, state };
    const executed = this.executeSwap(nativeAudio, auxEl, handoverToken, swapOptions);
    return { status: 'handled', executed };
  }
}

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { PlaybackHandover };
  }
  if (typeof window !== 'undefined') {
    window.PlaybackHandover = PlaybackHandover;
  }
})(typeof window !== 'undefined' ? window : globalThis);
