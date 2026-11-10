// JavaScript / automix-dj.js / Smart Crossfade & Beat-Aligned Mixing Engine
// Part of Eclipse Music Player — MIT License

class AutoMixDJ {
  constructor(options = {}) {
    this.enabled = options.enabled ?? false;
    this.durationSec = options.durationSec || 6.0; // 4 to 12 seconds
    this.mode = options.mode || 'equal_power'; // 'equal_power' | 'linear' | 'tempo_synced'
    this.bpm = options.bpm || 120;
    this.targetLufs = options.targetLufs || -14.0;
    this.isCrossfading = false;
  }

  configure(config = {}) {
    if (typeof config.enabled === 'boolean') this.enabled = config.enabled;
    if (typeof config.durationSec === 'number') this.durationSec = Math.max(1, Math.min(15, config.durationSec));
    if (config.mode) this.mode = config.mode;
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
   * Calculate Beat-aligned transition duration based on tempo
   * Aligns crossfade to 2 bars (8 beats) or 4 bars (16 beats)
   */
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
            outgoingAudio.volume = 1.0;
            outgoingAudio.playbackRate = 1.0;
            incomingAudio.volume = 1.0;
            incomingAudio.playbackRate = 1.0;
          } catch (_) {}
          resolve(true);
          return;
        }

        const gains = this.computeGainValues(progress);
        try {
          outgoingAudio.volume = Math.max(0, Math.min(1, gains.fadeOutGain));
          incomingAudio.volume = Math.max(0, Math.min(1, gains.fadeInGain));
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
