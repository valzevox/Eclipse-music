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
    const finishSwap = () => {
      if (swapped) return;
      swapped = true;
      nativeAudio.muted = !!options.isMuted;
      stopAux();
      if (typeof options.onDeckGainsReset === 'function') {
        options.onDeckGainsReset();
      }
      setTimeout(() => {
        if (typeof window !== 'undefined') window._autoMixSuppressVolumeSync = false;
      }, 80);
      if (typeof options.applySettings === 'function') {
        options.applySettings();
      }
    };

    const attachPlayAndSwap = () => {
      const liveTime = (auxAudio && !auxAudio.paused && Number.isFinite(auxAudio.currentTime))
        ? auxAudio.currentTime + 0.04
        : (handover.currentTime || 0);

      try { nativeAudio.currentTime = liveTime; } catch (_) {}

      nativeAudio.addEventListener('playing', finishSwap, { once: true });
      const p = nativeAudio.play();
      if (p && typeof p.catch === 'function') {
        p.catch((playErr) => {
          console.warn('[PlaybackHandover] nativeAudio.play() rejected; keeping auxAudio running to prevent silence:', playErr?.message || playErr);
          // Critical P0: DO NOT stop auxAudio if nativeAudio fails to play!
          if (typeof window !== 'undefined') {
            window._autoMixSuppressVolumeSync = false;
          }
          if (typeof options.onDeckGainsReset === 'function') {
            // Keep Deck B active
            if (window.audioEngine && typeof window.audioEngine.setDeckGains === 'function') {
              window.audioEngine.setDeckGains({ deckA: 0.0, deckB: 1.0, rampMs: 20 });
            }
          }
        });
      }
    };

    if (nativeAudio.src !== handover.src) {
      nativeAudio.src = handover.src;
      nativeAudio.addEventListener('loadedmetadata', attachPlayAndSwap, { once: true });
      nativeAudio.addEventListener('canplay', attachPlayAndSwap, { once: true });
    } else {
      if (nativeAudio.readyState >= 2) {
        attachPlayAndSwap();
      } else {
        nativeAudio.addEventListener('canplay', attachPlayAndSwap, { once: true });
      }
    }
    return true;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PlaybackHandover };
}
if (typeof window !== 'undefined') {
  window.PlaybackHandover = PlaybackHandover;
}
