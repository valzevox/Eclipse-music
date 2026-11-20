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
    this.targetLufs = options.targetLufs || -14.0;
    this.isCrossfading = false;
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

    // 3. MV Video mode active
    if (context.isVideoMode) {
      return { skip: true, reason: 'video_mode_active' };
    }

    // 4. Eclipse Sync Room active
    if (context.inSyncRoom) {
      return { skip: true, reason: 'sync_room_active' };
    }

    // 5. Continuous gapless same-album playback
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
   * Compute safe tempo-match playbackRate ratio (clamped to +-6% so pitch stays natural)
   */
  computeTempoRatio(sourceBpm, targetBpm) {
    if (!sourceBpm || !targetBpm || sourceBpm <= 0 || targetBpm <= 0) return 1.0;
    const ratio = sourceBpm / targetBpm;
    return Math.max(0.94, Math.min(1.06, ratio));
  }

  /**
   * Execute programmatic crossfade between outgoing audio node/element and incoming one
   */
  async executeCrossfade(outgoingAudio, incomingAudio, duration = this.durationSec, options = {}) {
    if (!outgoingAudio || !incomingAudio || this.isCrossfading) return false;

    this.isCrossfading = true;
    const startTime = Date.now();
    const durationMs = duration * 1000;
    const startInRate = this.mode === 'tempo_synced'
      ? this.computeTempoRatio(options.outgoingBpm || this.bpm, options.incomingBpm || this.bpm)
      : 1.0;

    // Optional WebAudio DJ-Style Filter sweep (HPF 1400Hz -> 20Hz on incoming)
    let inFilter = null;
    if (this.djFilter && typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext)) {
      try {
        const ctx = (window.audioEngine && window.audioEngine.ctx) || this._mixCtx || (this._mixCtx = new (window.AudioContext || window.webkitAudioContext)());
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

    // Start incoming audio at 0 volume and matched tempo
    try {
      incomingAudio.volume = 0;
      incomingAudio.playbackRate = startInRate;
      await incomingAudio.play();
    } catch (_) {}

    return new Promise((resolve) => {
      const interval = setInterval(() => {
        const elapsed = Date.now() - startTime;
        const progress = elapsed / durationMs;

        if (progress >= 1.0) {
          clearInterval(interval);
          this.isCrossfading = false;
          try {
            outgoingAudio.pause();
            const getSafeUserVol = () => {
      if (typeof window !== 'undefined' && window.EclipseCore && window.EclipseCore.state && window.EclipseCore.state.volume != null) {
        return Math.max(0, Math.min(1, Number(window.EclipseCore.state.volume)));
      }
      try {
        const v = localStorage.getItem('riff_volume');
        if (v !== null) return Math.max(0, Math.min(1, parseFloat(v)));
      } catch (_) {}
      return 1.0;
    };
            const targetMaxVol = getSafeUserVol();
            outgoingAudio.volume = targetMaxVol;
            outgoingAudio.playbackRate = 1.0;
            incomingAudio.volume = targetMaxVol;
            incomingAudio.playbackRate = 1.0;
            if (inFilter && inFilter.context) {
              inFilter.frequency.setValueAtTime(20, inFilter.context.currentTime);
            }
          } catch (_) {}
          resolve(true);
          return;
        }

        const gains = this.computeGainValues(progress);
        if (inFilter && inFilter.context) {
          // Logarithmic HPF sweep from 1400Hz down to 20Hz
          const freq = 1400 * Math.pow(20 / 1400, Math.min(1, progress));
          inFilter.frequency.setValueAtTime(Math.max(20, freq), inFilter.context.currentTime);
        }
        const getSafeUserVol = () => {
      if (typeof window !== 'undefined' && window.EclipseCore && window.EclipseCore.state && window.EclipseCore.state.volume != null) {
        return Math.max(0, Math.min(1, Number(window.EclipseCore.state.volume)));
      }
      try {
        const v = localStorage.getItem('riff_volume');
        if (v !== null) return Math.max(0, Math.min(1, parseFloat(v)));
      } catch (_) {}
      return 1.0;
    };
        const userVol = getSafeUserVol();
        try {
          outgoingAudio.volume = Math.max(0, Math.min(userVol, gains.fadeOutGain * userVol));
          incomingAudio.volume = Math.max(0, Math.min(userVol, gains.fadeInGain * userVol));
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
