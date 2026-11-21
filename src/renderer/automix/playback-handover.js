// src/renderer/automix/playback-handover.js
// JavaScript / playback-handover.js / Web / Eclipse PC & Mobile
// Seamless dual-deck handover: preserves currentTime, synchronizes live decks, prevents premature cut

class PlaybackHandover {
  constructor(options = {}) {
    this.telemetry = options.telemetry || null;
  }

  createHandoverToken(track, auxAudio, targetIndex) {
    if (!track || !auxAudio) return null;
    return {
      trackId: track.id || track.videoId,
      src: auxAudio.src || track._preloadedStreamUrl || '',
      auxAudio,
      currentTime: (auxAudio && !isNaN(auxAudio.currentTime)) ? auxAudio.currentTime : 0,
      targetIndex: typeof targetIndex === 'number' ? targetIndex : -1,
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

    const stopAux = () => {
      try {
        if (auxAudio) {
          auxAudio.pause();
          auxAudio.currentTime = 0;
        }
      } catch (_) {}
    };

    if (typeof window !== 'undefined') {
      window._autoMixSuppressVolumeSync = true;
    }
    nativeAudio.muted = true;
    nativeAudio.preload = 'auto';

    let swapped = false;
    let started = false;

    const cleanupReadinessListeners = () => {
      nativeAudio.removeEventListener('loadedmetadata', onReady);
      nativeAudio.removeEventListener('canplay', onReady);
    };

    const finishSwap = () => {
      if (swapped) return;
      swapped = true;
      cleanupReadinessListeners();
      nativeAudio.removeEventListener('error', onNativeError);
      nativeAudio.removeEventListener('playing', finishSwap);
      nativeAudio.muted = !!options.isMuted;
      if (typeof options.onDeckGainsReset === 'function') {
        options.onDeckGainsReset();
      } else if (typeof window !== 'undefined' && window.audioEngine && typeof window.audioEngine.setDeckGains === 'function') {
        window.audioEngine.setDeckGains({ deckA: 1.0, deckB: 0.0, rampMs: 25 });
      }
      stopAux();
      setTimeout(() => {
        if (typeof window !== 'undefined') window._autoMixSuppressVolumeSync = false;
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
      if (typeof window !== 'undefined') {
        window._autoMixSuppressVolumeSync = false;
      }
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
      // Keep 'error' listener active during playback attempt until playing or explicit error

      const liveTime = (auxAudio && !auxAudio.paused && Number.isFinite(auxAudio.currentTime))
        ? auxAudio.currentTime + 0.04
        : (handover.currentTime || 0);

      try { nativeAudio.currentTime = liveTime; } catch (_) {}

      nativeAudio.addEventListener('playing', finishSwap, { once: true });
      const p = nativeAudio.play();
      if (p && typeof p.catch === 'function') {
        p.catch((playErr) => {
          console.warn('[PlaybackHandover] nativeAudio.play() rejected; keeping auxAudio running to prevent silence:', playErr?.message || playErr);
          // Critical P0: clean up listeners so subsequent plays don't trigger finishSwap and kill auxAudio
          nativeAudio.removeEventListener('playing', finishSwap);
          nativeAudio.removeEventListener('error', onNativeError);
          if (typeof window !== 'undefined') {
            window._autoMixSuppressVolumeSync = false;
          }
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
   * Consumes state._autoMixHandover token once, validates loadToken, delegates swap,
   * and prevents premature clearing of nativeAudio source.
   *
   * @param {object} params
   * @param {object} params.state - Player state
   * @param {object} params.track - Track to be played
   * @param {number} params.currentToken - Captured loadToken for the current play call
   * @param {HTMLAudioElement} params.nativeAudio - Native player audio element
   * @param {HTMLAudioElement} [params.auxAudio] - Optional fallback aux element
   * @param {object} [params.options] - Swap options (isMuted, onDeckGainsReset, applySettings)
   * @returns {boolean} true if handover was handled and caller should return early
   */
  handlePlayTrackHandover({ state, track, currentToken, nativeAudio, auxAudio, options = {} }) {
    if (!state || !track) return false;
    const handoverToken = state._autoMixHandover;
    const isHandover = !!(
      this.isHandoverTarget(state, track) ||
      (handoverToken && (
        track.id === handoverToken.trackId ||
        (track.videoId && track.videoId === handoverToken.trackId) ||
        (track._matchedYtId && track._matchedYtId === handoverToken.trackId)
      ))
    );

    if (isHandover && handoverToken) {
      if (currentToken !== state.loadToken) {
        // Stale load token: do not consume handover token and do not swap
        return false;
      }
      state._autoMixHandover = null; // Consumed exactly once
      const auxEl = handoverToken.auxAudio || auxAudio || (typeof document !== 'undefined' ? document.getElementById('eclipse-aux-audio') : null);
      return this.executeSwap(nativeAudio, auxEl, handoverToken, options);
    }
    return false;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PlaybackHandover };
}
if (typeof window !== 'undefined') {
  window.PlaybackHandover = PlaybackHandover;
}
