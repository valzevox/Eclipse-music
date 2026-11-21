// JavaScript / automix-dj.js / Smart Crossfade & Beat-Aligned Mixing Engine
// Part of Eclipse Music Player — MIT License

class AutoMixDJ {
  constructor(options = {}) {
    this.enabled = options.enabled ?? false;
    this.durationSec = options.durationSec || 6.0; // 4 to 12 seconds
    this.mode = options.mode || 'equal_power'; // 'equal_power' | 'linear' | 'tempo_synced'
    this.djFilter = options.djFilter !== false;
    this.autoDuration = !!options.autoDuration;
    this.bpm = options.bpm || 120;
    this._onsetTimes = [];
    this._lastBassEnergy = 0;
    this._lastOnsetMs = 0;
    this.targetLufs = options.targetLufs || -14.0;
    this.isCrossfading = false;
    this._currentFade = null;
  }

  configure(config = {}) {
    if (typeof config.enabled === 'boolean') this.enabled = config.enabled;
    if (typeof config.durationSec === 'number') this.durationSec = Math.max(1, Math.min(15, config.durationSec));
    if (config.mode) this.mode = config.mode;
    if (typeof config.djFilter === 'boolean') this.djFilter = config.djFilter;
    if (typeof config.autoDuration === 'boolean') this.autoDuration = config.autoDuration;
    if (typeof config.bpm === 'number') this.bpm = Math.max(60, Math.min(200, config.bpm));
    if (typeof config.targetLufs === 'number') this.targetLufs = config.targetLufs;
    return this.getConfig();
  }

  getConfig() {
    return {
      enabled: this.enabled,
      durationSec: this.durationSec,
      mode: this.mode,
      bpm: this.bpm,
      targetLufs: this.targetLufs,
      isCrossfading: this.isCrossfading
    };
  }

  /**
   * Determine whether crossfade should be skipped for current/next track context
   * @param {Object} currentTrack
   * @param {Object} nextTrack
   * @param {Object} context
   * @returns {{ skip: boolean, reason?: string }}
   */
  shouldSkipCrossfade(currentTrack = {}, nextTrack = {}, context = {}) {
    const curDur = Number(currentTrack?.duration) || 0;
    const nextDur = Number(nextTrack?.duration) || 0;

    // 1. Duration < 20s
    if ((curDur > 0 && curDur < 20) || (nextDur > 0 && nextDur < 20)) {
      return { skip: true, reason: 'duration_too_short' };
    }

    // 2. Either track is a Live Broadcast
    if (currentTrack?.isLive === true || nextTrack?.isLive === true) {
      return { skip: true, reason: 'live_broadcast' };
    }

    // 3. Repeat One enabled
    if (context.isRepeatOne || context.isRepeat) {
      return { skip: true, reason: 'repeat_one_active' };
    }

    // 4. MV Video mode active
    if (context.isVideoMode) {
      return { skip: true, reason: 'video_mode_active' };
    }

    // 5. Eclipse Sync Room active
    if (context.inSyncRoom) {
      return { skip: true, reason: 'sync_room_active' };
    }

    // 6. Continuous gapless same-album playback
    if (context.gaplessSameAlbum && currentTrack?.album && nextTrack?.album && currentTrack.album === nextTrack.album) {
      return { skip: true, reason: 'gapless_same_album' };
    }

    return { skip: false };
  }

  /**
   * Calculate Beat-aligned transition duration based on tempo
   * Aligns crossfade to 2 bars (8 beats) or 4 bars (16 beats)
   */
  getSmartTransitionOffsets(durationOrTrack = 0, pcmEnergyEnvelopeOrChorus = null, nextIntroSec = null) {
    let duration = 0;
    let pcmEnvelope = null;
    let chorusOutroSec = null;

    if (typeof durationOrTrack === 'object' && durationOrTrack !== null) {
      duration = Number(durationOrTrack.duration) || 0;
      pcmEnvelope = (Array.isArray(pcmEnergyEnvelopeOrChorus) || ArrayBuffer.isView(pcmEnergyEnvelopeOrChorus)) ? pcmEnergyEnvelopeOrChorus : null;
    } else {
      duration = Number(durationOrTrack) || 0;
      if (Array.isArray(pcmEnergyEnvelopeOrChorus) || ArrayBuffer.isView(pcmEnergyEnvelopeOrChorus)) {
        pcmEnvelope = pcmEnergyEnvelopeOrChorus;
      } else {
        chorusOutroSec = typeof pcmEnergyEnvelopeOrChorus === 'number' ? pcmEnergyEnvelopeOrChorus : null;
      }
    }

    let introEndSec = 0;
    let lastChorusEndSec = null;
    let outroStartSec = null;

    if (pcmEnvelope && (Array.isArray(pcmEnvelope) || ArrayBuffer.isView(pcmEnvelope)) && pcmEnvelope.length >= 8) {
      const len = pcmEnvelope.length;
      const secPerPoint = duration > 0 ? duration / len : 1.0;
      let maxEnergy = 0;
      let totalEnergy = 0;
      for (let i = 0; i < len; i++) {
        const val = Number(pcmEnvelope[i]) || 0;
        if (val > maxEnergy) maxEnergy = val;
        totalEnergy += val;
      }
      const avgEnergy = totalEnergy / len;
      const energyThresh = avgEnergy * 0.7;

      // 1. Detect Intro End: First sustained rise in energy above threshold
      for (let i = 0; i < Math.floor(len * 0.3); i++) {
        if ((pcmEnvelope[i] || 0) >= energyThresh) {
          introEndSec = Math.round(i * secPerPoint * 10) / 10;
          break;
        }
      }

      // 2. Detect Outro Start: Energy drop in final 35% of the song
      const tailStartIndex = Math.floor(len * 0.65);
      for (let i = len - 2; i >= tailStartIndex; i--) {
        if ((pcmEnvelope[i] || 0) >= energyThresh) {
          outroStartSec = Math.round((i + 1) * secPerPoint * 10) / 10;
          lastChorusEndSec = outroStartSec;
          break;
        }
      }
    }

    if (!outroStartSec && typeof chorusOutroSec === 'number' && chorusOutroSec > 0) {
      outroStartSec = chorusOutroSec;
      lastChorusEndSec = chorusOutroSec;
    }

    // Fallback heuristic if no envelope or drop detected
    if (!outroStartSec) {
      outroStartSec = Math.max(0, duration - this.durationSec);
    }
    if (typeof nextIntroSec === 'number' && nextIntroSec > 0) {
      introEndSec = nextIntroSec;
    }

    const fadeOutStart = outroStartSec;
    const fadeInSkip = Math.min(introEndSec, 15);

    return {
      fadeOutStart,
      fadeInSkip,
      introEndSec,
      lastChorusEndSec: lastChorusEndSec || fadeOutStart,
      outroStartSec,
      crossfadeDuration: this.durationSec
    };
  }

  getBeatAlignedDuration(bpm = this.bpm) {
    const beatSec = 60 / bpm;
    const barSec = beatSec * 4;
    // Aim for ~6-8 seconds: 2 bars or 4 bars depending on tempo
    const twoBars = barSec * 2;
    if (twoBars >= 4 && twoBars <= 10) return Math.round(twoBars * 10) / 10;
    return Math.round(barSec * 10) / 10;
  }

  /**
   * Compute Equal-Power or Linear Gain curves
   * Equal-power prevents mid-point volume dip:
   * outGain = cos(t * PI/2), inGain = sin(t * PI/2)
   */
  computeGainValues(progress, mode = this.mode) {
    const p = Math.max(0, Math.min(1, progress));
    if (mode === 'linear') {
      return {
        fadeOutGain: 1.0 - p,
        fadeInGain: p
      };
    }
    // Default: Equal-power (constant sound pressure level)
    return {
      fadeOutGain: Math.cos(p * 0.5 * Math.PI),
      fadeInGain: Math.sin(p * 0.5 * Math.PI)
    };
  }

  /**
   * Sample bass-band onset energy from WebAudio AnalyserNode to estimate live BPM (70-175)
   */
  sampleLiveBpm(analyserNode) {
    if (!analyserNode || typeof analyserNode.getByteFrequencyData !== 'function') return this.bpm;
    if (!this._freqBuf || this._freqBuf.length !== analyserNode.frequencyBinCount) {
      this._freqBuf = new Uint8Array(analyserNode.frequencyBinCount);
    }
    analyserNode.getByteFrequencyData(this._freqBuf);
    // Low-end kick/bass bins (approx 40-180 Hz)
    const endBin = Math.min(12, this._freqBuf.length);
    let bass = 0;
    for (let i = 1; i < endBin; i++) bass += this._freqBuf[i];
    bass /= Math.max(1, endBin - 1);

    const now = Date.now();
    if (bass > 145 && bass > this._lastBassEnergy * 1.18 && (now - this._lastOnsetMs) > 280) {
      this._lastOnsetMs = now;
      this._onsetTimes.push(now);
      if (this._onsetTimes.length > 24) this._onsetTimes.shift();
      if (this._onsetTimes.length >= 6) {
        const intervals = [];
        for (let i = 1; i < this._onsetTimes.length; i++) {
          const dt = this._onsetTimes[i] - this._onsetTimes[i - 1];
          if (dt >= 300 && dt <= 1000) intervals.push(dt);
        }
        if (intervals.length >= 4) {
          intervals.sort((a, b) => a - b);
          const medianMs = intervals[Math.floor(intervals.length / 2)];
          let est = Math.round(60000 / medianMs);
          while (est < 75) est *= 2;
          while (est > 175) est = Math.round(est / 2);
          this.bpm = Math.round(this.bpm * 0.7 + est * 0.3);
        }
      }
    }
    this._lastBassEnergy = this._lastBassEnergy * 0.75 + bass * 0.25;
    return this.bpm;
  }

  resetLiveBpm() {
    this._onsetTimes = [];
    this._lastBassEnergy = 0;
    this._lastOnsetMs = 0;
  }

  /**
   * Pick the closest BPM/energy unplayed track in queue for Tempo Synced mode
   */
  pickTempoSyncedNext(queue, currentIndex, playedIds, currentBpm = this.bpm) {
    if (!Array.isArray(queue) || queue.length <= 1) return null;
    const played = playedIds instanceof Set ? playedIds : new Set();
    let best = null;
    let bestDiff = Infinity;

    for (let i = 0; i < queue.length; i++) {
      if (i === currentIndex) continue;
      const t = queue[i];
      if (!t) continue;
      const tid = t.id || t.videoId;
      if (tid && played.has(tid)) continue;

      const tBpm = (typeof t._detectedBpm === 'number' && t._detectedBpm > 0)
        ? t._detectedBpm
        : ((typeof t.bpm === 'number' && t.bpm > 0) ? t.bpm : (95 + ((Number(t.duration) || 180) % 45)));
      const diff = Math.abs(tBpm - currentBpm);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = { track: t, index: i, targetBpm: tBpm };
      }
    }
    return best;
  }

  /**
   * Compute safe tempo-match playbackRate ratio (clamped to +-6% so pitch stays natural)
   */
  computeTempoRatio(sourceBpm, targetBpm) {
    if (!sourceBpm || !targetBpm || sourceBpm <= 0 || targetBpm <= 0) return 1.0;
    const ratio = sourceBpm / targetBpm;
    return Math.max(0.94, Math.min(1.06, ratio));
  }

  /**
   * Abort active crossfade immediately (Pause, Seek, Skip)
   * Commits immediately to the target track, resets gains, cleans up DJ filter
   * @param {string} reason 'pause' | 'seek' | 'skip' | 'manual'
   */
  abortCrossfade(reason = 'manual') {
    if (!this.isCrossfading || !this._currentFade) return false;

    const fade = this._currentFade;
    this.isCrossfading = false;
    this._currentFade = null;

    if (fade.interval) {
      clearInterval(fade.interval);
      fade.interval = null;
    }

    const { outgoingAudio, incomingAudio, inFilter, initialUserVol, useDeckGains, audioEngine } = fade;

    try {
      if (useDeckGains && audioEngine && typeof audioEngine.setDeckGains === 'function') {
        audioEngine.setDeckGains({ deckA: 1.0, deckB: 0.0, rampMs: 30 });
      } else if (audioEngine && audioEngine.fadeGain && audioEngine.ctx) {
        audioEngine.fadeGain.gain.setValueAtTime(1.0, audioEngine.ctx.currentTime);
      }

      if (outgoingAudio) {
        outgoingAudio.volume = initialUserVol;
        outgoingAudio.playbackRate = 1.0;
        if (reason === 'skip' || reason === 'seek' || reason === 'pause') {
          outgoingAudio.pause();
        }
      }

      if (incomingAudio) {
        incomingAudio.volume = initialUserVol;
        incomingAudio.playbackRate = 1.0;
        if (reason === 'pause') {
          incomingAudio.pause();
        }
      }

      if (inFilter && inFilter.context) {
        inFilter.frequency.setValueAtTime(20, inFilter.context.currentTime);
      }
    } catch (_) {}

    if (typeof window !== 'undefined') {
      setTimeout(() => { window._autoMixSuppressVolumeSync = false; }, 80);
      window.dispatchEvent(new CustomEvent('eclipse:automix-state', {
        detail: { active: false, aborted: true, reason }
      }));
    }

    if (typeof fade.reject === 'function') {
      fade.reject(new Error(`Crossfade aborted: ${reason}`));
    }
    return true;
  }

  /**
   * Execute programmatic crossfade between outgoing audio node/element and incoming one
   */
  async executeCrossfade(outgoingAudio, incomingAudio, duration = this.durationSec, options = {}) {
    if (!outgoingAudio || !incomingAudio || this.isCrossfading) return false;

    this.isCrossfading = true;
    if (typeof window !== 'undefined') window._autoMixSuppressVolumeSync = true;
    const startTime = Date.now();
    const durationMs = Math.max(200, duration * 1000);
    const initialUserVol = Number.isFinite(outgoingAudio.volume) ? Math.max(0, Math.min(1, outgoingAudio.volume)) : 1.0;

    const audioEngine = (typeof window !== 'undefined' && window.audioEngine) ? window.audioEngine : null;
    const useDeckGains = !!(audioEngine && typeof audioEngine.setDeckGains === 'function');
    const useFadeGainNode = !useDeckGains && !!(audioEngine && audioEngine.fadeGain && audioEngine.ctx);

    const startInRate = this.mode === 'tempo_synced'
      ? this.computeTempoRatio(options.outgoingBpm || this.bpm, options.incomingBpm || this.bpm)
      : 1.0;

    // Optional WebAudio DJ-Style Filter sweep (HPF 1400Hz -> 20Hz on incoming)
    let inFilter = null;
    if (this.djFilter && typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext)) {
      try {
        const ctx = (audioEngine && audioEngine.ctx) || this._mixCtx || (this._mixCtx = new (window.AudioContext || window.webkitAudioContext)());
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});
        if (!incomingAudio._eclipseMixSource) {
          incomingAudio._eclipseMixSource = ctx.createMediaElementSource(incomingAudio);
          incomingAudio._eclipseMixFilter = ctx.createBiquadFilter();
          incomingAudio._eclipseMixFilter.type = 'highpass';
          incomingAudio._eclipseMixFilter.Q.value = 0.7;
          incomingAudio._eclipseMixSource.connect(incomingAudio._eclipseMixFilter);
          incomingAudio._eclipseMixFilter.connect(ctx.destination);
        }
        inFilter = incomingAudio._eclipseMixFilter;
        inFilter.frequency.setValueAtTime(1400, ctx.currentTime);
      } catch (_) {
        inFilter = null;
      }
    }

    // Initialize gains
    if (useDeckGains) {
      audioEngine.setDeckGains({ deckA: 1.0, deckB: 0.0, rampMs: 0 });
    } else if (useFadeGainNode) {
      audioEngine.fadeGain.gain.setValueAtTime(1.0, audioEngine.ctx.currentTime);
    } else {
      outgoingAudio.volume = initialUserVol;
    }

    // Start incoming audio at 0 volume and matched tempo
    try {
      if (!useDeckGains) {
        incomingAudio.volume = 0;
      } else {
        incomingAudio.volume = initialUserVol;
      }
      incomingAudio.playbackRate = startInRate;
      await incomingAudio.play();
    } catch (_) {}

    return new Promise((resolve, reject) => {
      const fadeState = {
        outgoingAudio,
        incomingAudio,
        inFilter,
        initialUserVol,
        useDeckGains,
        useFadeGainNode,
        audioEngine,
        interval: null,
        resolve,
        reject
      };
      this._currentFade = fadeState;

      fadeState.interval = setInterval(() => {
        const elapsed = Date.now() - startTime;
        const progress = elapsed / durationMs;

        if (progress >= 1.0) {
          clearInterval(fadeState.interval);
          fadeState.interval = null;
          this.isCrossfading = false;
          this._currentFade = null;
          try {
            outgoingAudio.pause();
            if (useDeckGains) {
              audioEngine.setDeckGains({ deckA: 0.0, deckB: 1.0, rampMs: 30 });
            } else if (useFadeGainNode) {
              audioEngine.fadeGain.gain.setValueAtTime(1.0, audioEngine.ctx.currentTime);
            } else {
              outgoingAudio.volume = initialUserVol;
            }
            outgoingAudio.playbackRate = 1.0;
            incomingAudio.volume = initialUserVol;
            incomingAudio.playbackRate = 1.0;
            if (inFilter && inFilter.context) {
              inFilter.frequency.setValueAtTime(20, inFilter.context.currentTime);
            }
          } catch (_) {}
          if (typeof window !== 'undefined') {
            setTimeout(() => { window._autoMixSuppressVolumeSync = false; }, 100);
          }
          resolve(true);
          return;
        }

        const gains = this.computeGainValues(progress);
        if (inFilter && inFilter.context) {
          // Logarithmic HPF sweep from 1400Hz down to 20Hz
          const freq = 1400 * Math.pow(20 / 1400, Math.min(1, progress));
          inFilter.frequency.setValueAtTime(Math.max(20, freq), inFilter.context.currentTime);
        }
        try {
          if (useDeckGains) {
            audioEngine.setDeckGains({
              deckA: Math.max(0, Math.min(1, gains.fadeOutGain)),
              deckB: Math.max(0, Math.min(1, gains.fadeInGain)),
              rampMs: 50
            });
          } else if (useFadeGainNode) {
            audioEngine.fadeGain.gain.setValueAtTime(Math.max(0, Math.min(1, gains.fadeOutGain)), audioEngine.ctx.currentTime);
            incomingAudio.volume = Math.max(0, Math.min(initialUserVol, gains.fadeInGain * initialUserVol));
          } else {
            outgoingAudio.volume = Math.max(0, Math.min(initialUserVol, gains.fadeOutGain * initialUserVol));
            incomingAudio.volume = Math.max(0, Math.min(initialUserVol, gains.fadeInGain * initialUserVol));
          }

          if (this.mode === 'tempo_synced' && startInRate !== 1.0) {
            incomingAudio.playbackRate = 1.0 + (startInRate - 1.0) * (1.0 - progress);
          }
        } catch (_) {}
      }, 50);
    });
  }
}

if (typeof module !== 'undefined') {
  module.exports = AutoMixDJ;
} else {
  window.AutoMixDJ = AutoMixDJ;
}
