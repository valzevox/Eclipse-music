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
    this._energyHistory = [];
    this._silenceDetectedSec = null;
    this._lastEnergyCheckMs = 0;
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

  resetTrackEnergy() {
    this._energyHistory = [];
    this._silenceDetectedSec = null;
    this._lastEnergyCheckMs = 0;
  }

  /**
   * Real-time audio energy & outro silence detector via AnalyserNode
   * Samples RMS energy and detects natural fade-out or dead air in the last 30s.
   * Applies the 50% Outro Rule: if silence/drop starts at T_drop, transition fires at midpoint.
   */
  detectOutroEnergyDrop(analyserNode, currentTime, duration) {
    if (!analyserNode || !currentTime || !duration || duration < 25) return null;
    if (currentTime < duration - 30) {
      if (this._energyHistory.length > 0 && currentTime < 10) this.resetTrackEnergy();
      return null;
    }

    const now = Date.now();
    if (now - this._lastEnergyCheckMs < 150) return this._silenceDetectedSec;
    this._lastEnergyCheckMs = now;

    if (!this._energyTimeBuf || this._energyTimeBuf.length !== analyserNode.frequencyBinCount) {
      this._energyTimeBuf = new Uint8Array(analyserNode.frequencyBinCount);
    }
    analyserNode.getByteTimeDomainData(this._energyTimeBuf);

    let sumSquares = 0;
    const len = this._energyTimeBuf.length;
    for (let i = 0; i < len; i++) {
      const norm = (this._energyTimeBuf[i] - 128) / 128;
      sumSquares += norm * norm;
    }
    const currentRms = Math.sqrt(sumSquares / len);

    this._energyHistory.push(currentRms);
    if (this._energyHistory.length > 60) this._energyHistory.shift();

    if (this._energyHistory.length < 8) return null;

    let totalRms = 0;
    for (let i = 0; i < this._energyHistory.length; i++) totalRms += this._energyHistory[i];
    const avgRms = totalRms / this._energyHistory.length;

    // Outro silence threshold: RMS < 0.018 (silence) or sustained drop below 22% of song average
    const isQuiet = currentRms < 0.018 || (avgRms > 0.06 && currentRms < avgRms * 0.22);
    if (isQuiet) {
      if (this._silenceDetectedSec === null) {
        // Compute 50% point of remaining duration
        const outroTailSec = Math.max(2.0, duration - currentTime);
        this._silenceDetectedSec = currentTime + (outroTailSec / 2);
      }
    } else {
      // Audio is still actively rocking
      this._silenceDetectedSec = null;
    }
    return this._silenceDetectedSec;
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
    let currentTrackObj = null;

    if (typeof durationOrTrack === 'object' && durationOrTrack !== null) {
      currentTrackObj = durationOrTrack;
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
    let rawOutroStartSec = null;

    // 0. Detect Outro via SponsorBlock segments (music_offtopic, outro, filler)
    const sponsorSegs = (currentTrackObj && Array.isArray(currentTrackObj.sponsorSegments))
      ? currentTrackObj.sponsorSegments
      : (Array.isArray(pcmEnergyEnvelopeOrChorus) && pcmEnergyEnvelopeOrChorus.length > 0 && typeof pcmEnergyEnvelopeOrChorus[0] === 'object' && 'category' in pcmEnergyEnvelopeOrChorus[0]
        ? pcmEnergyEnvelopeOrChorus
        : (typeof window !== 'undefined' && window.EclipseCore && typeof window.EclipseCore.getCurrentSponsorSegments === 'function'
          ? window.EclipseCore.getCurrentSponsorSegments()
          : null));

    if (Array.isArray(sponsorSegs) && sponsorSegs.length > 0) {
      const outroSeg = sponsorSegs.find(s => {
        if (!s || typeof s.start !== 'number' || s.start <= 0) return false;
        const cat = String(s.category || '').toLowerCase();
        const isOutroCat = cat === 'outro' || cat === 'music_offtopic' || cat === 'filler' || cat === 'preview';
        return isOutroCat && (duration <= 0 || s.start >= duration * 0.45);
      });
      if (outroSeg) {
        rawOutroStartSec = Math.round(outroSeg.start * 10) / 10;
        lastChorusEndSec = rawOutroStartSec;
      }
    }

    if (!rawOutroStartSec && pcmEnvelope && (Array.isArray(pcmEnvelope) || ArrayBuffer.isView(pcmEnvelope)) && pcmEnvelope.length >= 8) {
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
          rawOutroStartSec = Math.round((i + 1) * secPerPoint * 10) / 10;
          lastChorusEndSec = rawOutroStartSec;
          break;
        }
      }
    }

    if (!rawOutroStartSec && typeof chorusOutroSec === 'number' && chorusOutroSec > 0) {
      rawOutroStartSec = chorusOutroSec;
      lastChorusEndSec = chorusOutroSec;
    }

    // 3. Detect Outro from synced lyrics timing: last vocal phrase end + natural 2.5s tail
    if (!rawOutroStartSec) {
      const lyrics = currentTrackObj?.syncedLyrics || (typeof window !== 'undefined' && window.EclipseCore?.state?.syncedLyrics);
      if (Array.isArray(lyrics) && lyrics.length > 0) {
        const timedLines = lyrics.filter(l => typeof l.time === 'number' && l.time > 0);
        const lastLine = timedLines[timedLines.length - 1];
        if (lastLine && lastLine.time > duration * 0.65 && lastLine.time < duration - 2) {
          rawOutroStartSec = Math.min(duration - 2, Math.max(duration * 0.7, lastLine.time + 2.5));
          lastChorusEndSec = rawOutroStartSec;
        }
      }
    }

    // 4. Default natural outro fallback (if no envelope or lyrics: last 12s-16s of a full song)
    if (!rawOutroStartSec) {
      const naturalOutroLength = duration > 60 ? Math.min(24, Math.max(12, duration * 0.08)) : this.durationSec;
      rawOutroStartSec = Math.max(0, duration - naturalOutroLength);
    }

    // 50% Outro Rule: Let the first 50% of the outro play naturally, then start crossfade on the remaining 50%
    const outroDuration = Math.max(3.0, duration - rawOutroStartSec);
    const halfOutroDuration = outroDuration / 2;
    const fadeOutStart = Math.round((rawOutroStartSec + halfOutroDuration) * 10) / 10;

    // Detect Intro of next song: check SponsorBlock intro segment first, then synced lyrics / metadata
    let nextIntroDuration = 0;
    if (typeof nextIntroSec === 'number' && nextIntroSec > 0) {
      nextIntroDuration = nextIntroSec;
    } else if (typeof nextIntroSec === 'object' && nextIntroSec !== null) {
      const nextSbSegs = Array.isArray(nextIntroSec.sponsorSegments) ? nextIntroSec.sponsorSegments : null;
      if (nextSbSegs && nextSbSegs.length > 0) {
        const introSeg = nextSbSegs.find(s => {
          if (!s || typeof s.end !== 'number' || s.end <= 0) return false;
          const cat = String(s.category || '').toLowerCase();
          return (cat === 'intro' || cat === 'music_offtopic') && s.start <= 2 && s.end < 45;
        });
        if (introSeg) {
          nextIntroDuration = Math.round(introSeg.end * 10) / 10;
        }
      }
      if (!nextIntroDuration && typeof nextIntroSec.introSec === 'number' && nextIntroSec.introSec > 0) {
        nextIntroDuration = nextIntroSec.introSec;
      }
      if (!nextIntroDuration) {
        const nextLyrics = nextIntroSec.syncedLyrics;
        if (Array.isArray(nextLyrics) && nextLyrics.length > 0) {
          const firstTimed = nextLyrics.find(l => typeof l.time === 'number' && l.time > 0);
          if (firstTimed && firstTimed.time > 2 && firstTimed.time < 35) {
            nextIntroDuration = firstTimed.time;
          }
        }
      }
    }
    // 50% Intro Rule: Start the incoming track at the midpoint of its intro (skip dead intro silence/intro build-up)
    const fadeInSkip = nextIntroDuration > 3 ? Math.round((nextIntroDuration / 2) * 10) / 10 : 0;
    const effectiveCrossfadeSec = Math.max(2.0, Math.min(15.0, halfOutroDuration));

    return {
      fadeOutStart,
      fadeInSkip,
      introEndSec: nextIntroDuration,
      lastChorusEndSec: lastChorusEndSec || rawOutroStartSec,
      outroStartSec: rawOutroStartSec,
      outroDuration,
      halfOutroDuration,
      crossfadeDuration: this.autoDuration ? effectiveCrossfadeSec : this.durationSec
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

      // Only trust verified detected BPM or metadata BPM (>0); do NOT fake BPM from duration
      const tBpm = (typeof t._detectedBpm === 'number' && t._detectedBpm > 0)
        ? t._detectedBpm
        : ((typeof t.bpm === 'number' && t.bpm > 0) ? t.bpm : null);

      if (!tBpm || !currentBpm || currentBpm <= 0) continue;

      // Check direct, half-time, and double-time compatibility
      const candidates = [tBpm, tBpm * 2, tBpm * 0.5];
      for (const cand of candidates) {
        const diff = Math.abs(cand - currentBpm);
        if (diff < bestDiff) {
          bestDiff = diff;
          best = { track: t, index: i, targetBpm: cand, baseBpm: tBpm };
        }
      }
    }
    // Fallback: if no track has verified BPM, pick next sequential track in queue without forcing fake tempo sync
    if (!best && currentIndex + 1 < queue.length) {
      return { track: queue[currentIndex + 1], index: currentIndex + 1, targetBpm: currentBpm, fallback: true };
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
    } catch (playErr) {
      console.warn('[AutoMixDJ] incomingAudio.play() rejected; aborting crossfade and restoring outgoing volume:', playErr?.message || playErr);
      if (typeof window !== 'undefined') {
        setTimeout(() => { window._autoMixSuppressVolumeSync = false; }, 50);
      }
      // Rollback gains immediately to prevent fading outgoing into silence
      if (useDeckGains) {
        audioEngine.setDeckGains({ deckA: 1.0, deckB: 0.0, rampMs: 20 });
      } else if (useFadeGainNode) {
        audioEngine.fadeGain.gain.setValueAtTime(1.0, audioEngine.ctx.currentTime);
      } else {
        outgoingAudio.volume = initialUserVol;
      }
      this.isCrossfading = false;
      this._activeCrossfade = null;
      throw new Error(`Incoming audio play failed: ${playErr?.message || 'Playback blocked'}`);
    }

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
              audioEngine.setDeckGains({ deckA: 1.0, deckB: 0.0, rampMs: 30 });
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
