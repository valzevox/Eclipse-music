// JavaScript / automix-dj.js / Smart Crossfade & Beat-Aligned Mixing Engine
// Part of Eclipse Music Player — MIT License

const { getVolumeSyncSuppression } = (typeof module !== 'undefined' && module.exports)
  ? (function() {
      try { return require('./automix/suppression-controller'); }
      catch (_) { return { getVolumeSyncSuppression: () => null }; }
    })()
  : { getVolumeSyncSuppression: () => (typeof window !== 'undefined' && window.volumeSyncSuppression ? window.volumeSyncSuppression : null) };

function _getDJSuppressionManager() {
  if (typeof window !== 'undefined' && window.volumeSyncSuppression) {
    return window.volumeSyncSuppression;
  }
  return getVolumeSyncSuppression();
}

class AutoMixDJ {
  constructor(options = {}) {
    this.enabled = options.enabled ?? false;
    this.durationSec = options.durationSec || 6.0; // 4 to 12 seconds
    this.mode = options.mode || 'equal_power'; // 'equal_power' | 'linear' | 'tempo_synced' | 'dj_mix' | 'gapless_album'
    this.djFilter = options.djFilter !== false;
    this.autoDuration = !!options.autoDuration;
    this.keepAlbumContinuous = options.keepAlbumContinuous ?? true;
    this.bpm = options.bpm || null;
    this._detectedBpm = null;
    this._bpmConfidence = 0;
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
    if (typeof config.keepAlbumContinuous === 'boolean') this.keepAlbumContinuous = config.keepAlbumContinuous;
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

    // 6. Continuous gapless same-album playback (using stable albumId if available, falling back to album + artist)
    if (context.gaplessSameAlbum) {
      const sameId = !!(currentTrack?.albumId && nextTrack?.albumId && currentTrack.albumId === nextTrack.albumId);
      const sameNameAndArtist = !!(
        !currentTrack?.albumId && !nextTrack?.albumId &&
        currentTrack?.album && nextTrack?.album &&
        currentTrack.album === nextTrack.album &&
        (!currentTrack.artist || !nextTrack.artist || currentTrack.artist === nextTrack.artist)
      );
      if (sameId || sameNameAndArtist) {
        return { skip: true, reason: 'gapless_same_album' };
      }
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
   * Sample bass-band onset energy from WebAudio AnalyserNode to estimate live BPM (70-175).
   * Calculates exact frequency bin indices from sampleRate and fftSize rather than hardcoded indices.
   * Returns { bpm: number|null, confidence: number, source: 'live-analysis' }.
   * Never fabricates a default 120 BPM when no reliable onsets are detected.
   */
  sampleLiveBpm(analyserNode) {
    if (!analyserNode || typeof analyserNode.getByteFrequencyData !== 'function') {
      return { bpm: null, confidence: 0, source: 'live-analysis' };
    }
    const binCount = analyserNode.frequencyBinCount || 0;
    if (binCount <= 0) return { bpm: null, confidence: 0, source: 'live-analysis' };

    if (!this._freqBuf || this._freqBuf.length !== binCount) {
      this._freqBuf = new Uint8Array(binCount);
    }
    analyserNode.getByteFrequencyData(this._freqBuf);

    // Exact Hz-to-bin mapping for kick/bass band (40Hz - 180Hz)
    const sampleRate = (analyserNode.context && analyserNode.context.sampleRate) || 44100;
    const fftSize = analyserNode.fftSize || (binCount * 2);
    const binHz = sampleRate / fftSize;

    const startBin = Math.max(0, Math.floor(40 / binHz));
    const endBin = Math.min(binCount - 1, Math.max(startBin, Math.ceil(180 / binHz)));

    let bass = 0;
    let count = 0;
    for (let i = startBin; i <= endBin; i++) {
      bass += this._freqBuf[i];
      count++;
    }
    bass /= Math.max(1, count);

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

          // Compute variance-based confidence (tighter intervals = higher confidence)
          let varianceSum = 0;
          for (const dt of intervals) {
            const relErr = Math.abs(dt - medianMs) / medianMs;
            varianceSum += relErr;
          }
          const avgRelErr = varianceSum / intervals.length;
          const sampleFactor = Math.min(1.0, intervals.length / 12);
          const stabilityFactor = Math.max(0, 1.0 - avgRelErr * 3.0);
          const confidence = Math.round(Math.min(0.85, sampleFactor * stabilityFactor * 0.85) * 100) / 100;

          if (confidence >= 0.4) {
            this._detectedBpm = this._detectedBpm
              ? Math.round(this._detectedBpm * 0.7 + est * 0.3)
              : est;
            this._bpmConfidence = confidence;
            this.bpm = this._detectedBpm;
          }
        }
      }
    }
    this._lastBassEnergy = this._lastBassEnergy * 0.75 + bass * 0.25;
    return {
      bpm: this._detectedBpm,
      confidence: this._bpmConfidence,
      source: 'live-analysis'
    };
  }

  resetLiveBpm() {
    this._onsetTimes = [];
    this._lastBassEnergy = 0;
    this._lastOnsetMs = 0;
    this._detectedBpm = null;
    this._bpmConfidence = 0;
    this.bpm = null;
  }

  /**
   * Pick the closest BPM + harmonic key unplayed track in queue for Tempo Synced / DJ Mix mode.
   * Enforces strict +/-6% BPM compatibility; incorporates Camelot harmonic scoring when available.
   * Returns fallback sequential track if no verified BPM match is found.
   */
  pickTempoSyncedNext(queue, currentIndex, playedIds, currentBpm = this.bpm, options = {}) {
    if (!Array.isArray(queue) || queue.length <= 1) return null;
    const played = playedIds instanceof Set ? playedIds : new Set();
    const analyzer = options.analyzer || null;
    const currentTrack = queue[currentIndex] || null;

    // Keep albums continuous: if keepAlbumContinuous is enabled and next track belongs to the same album,
    // preserve sequential album progression rather than jumping to an arbitrary candidate
    if (this.keepAlbumContinuous && currentTrack && currentIndex + 1 < queue.length) {
      const nextSequential = queue[currentIndex + 1];
      const sameAlbum = (
        (currentTrack.albumId && nextSequential.albumId && currentTrack.albumId === nextSequential.albumId) ||
        (currentTrack.album && nextSequential.album && currentTrack.album === nextSequential.album && currentTrack.artist === nextSequential.artist)
      );
      if (sameAlbum) {
        return {
          track: nextSequential,
          index: currentIndex + 1,
          targetBpm: currentBpm || null,
          gaplessAlbum: true,
          compatible: true,
          reason: 'keep_album_continuous'
        };
      }
    }

    const currentRecord = (analyzer && currentTrack && typeof analyzer.getCachedRecord === 'function') ? analyzer.getCachedRecord(currentTrack) : null;
    const currentCamelot = options.currentCamelot || (currentRecord && currentRecord.key && currentRecord.key.camelot) || (currentTrack && currentTrack._camelot) || null;

    let best = null;
    let bestScore = -Infinity;

    const validCurrentBpm = (typeof currentBpm === 'number' && currentBpm > 0)
      ? currentBpm
      : ((currentRecord && currentRecord.tempo && typeof currentRecord.tempo.bpm === 'number' && currentRecord.tempo.bpm > 0 && (currentRecord.tempo.confidence || 0) >= 0.4)
        ? currentRecord.tempo.bpm
        : null);

    if (validCurrentBpm) {
      for (let i = 0; i < queue.length; i++) {
        if (i === currentIndex) continue;
        const t = queue[i];
        if (!t) continue;
        const tid = t.id || t.videoId;
        if (tid && played.has(tid)) continue;

        const rec = (analyzer && typeof analyzer.getCachedRecord === 'function') ? analyzer.getCachedRecord(t) : null;

        // Read BPM strictly from TrackAnalyzer record.tempo.bpm (with confidence >= 0.4),
        // verified live _detectedBpm, or explicit track.bpm metadata. Never fabricate BPM.
        const recBpm = (rec && rec.tempo && typeof rec.tempo.bpm === 'number' && rec.tempo.bpm > 0 && (rec.tempo.confidence || 0) >= 0.4)
          ? rec.tempo.bpm
          : null;
        const tBpm = recBpm
          || ((typeof t._detectedBpm === 'number' && t._detectedBpm > 0)
            ? t._detectedBpm
            : ((typeof t.bpm === 'number' && t.bpm > 0) ? t.bpm : null));

        if (!tBpm) continue;

        // Check direct, half-time, and double-time compatibility within strict +/- 6% threshold
        const candidates = [tBpm, tBpm * 2, tBpm * 0.5];
        for (const cand of candidates) {
          const ratio = validCurrentBpm / cand;
          const diffRatio = Math.abs(ratio - 1.0);
          if (diffRatio <= 0.06) {
            // BPM proximity score: 1.0 at exact match, 0.0 at 6% edge
            const bpmScore = 1.0 - (diffRatio / 0.06);

            // Harmonic compatibility score when Camelot keys exist on both tracks (record.key.camelot)
            const candCamelot = (rec && rec.key && rec.key.camelot) || t._camelot || null;
            let harmonic = { score: 0.5, relationship: 'unknown' };
            if (currentCamelot && candCamelot && analyzer && typeof analyzer.scoreHarmonicCompatibility === 'function') {
              harmonic = analyzer.scoreHarmonicCompatibility(currentCamelot, candCamelot);
            }

            // Energy continuity score: reward similar energy profiles (+- 30%)
            const curEnergy = currentRecord && currentRecord.energy && typeof currentRecord.energy.rms === 'number' ? currentRecord.energy.rms : null;
            const candEnergy = rec && rec.energy && typeof rec.energy.rms === 'number' ? rec.energy.rms : null;
            let energyScore = null;
            if (curEnergy && candEnergy && curEnergy > 0) {
              const energyDiff = Math.abs(curEnergy - candEnergy) / curEnergy;
              energyScore = Math.max(0, 1.0 - energyDiff);
            }

            let combinedScore = bpmScore;
            if (currentCamelot && candCamelot && energyScore !== null) {
              combinedScore = bpmScore * 0.55 + harmonic.score * 0.35 + energyScore * 0.10;
            } else if (currentCamelot && candCamelot) {
              combinedScore = bpmScore * 0.65 + harmonic.score * 0.35;
            } else if (energyScore !== null) {
              combinedScore = bpmScore * 0.85 + energyScore * 0.15;
            }

            if (combinedScore > bestScore) {
              bestScore = combinedScore;
              best = {
                track: t,
                index: i,
                targetBpm: cand,
                baseBpm: tBpm,
                compatible: true,
                harmonicScore: harmonic.score,
                harmonicReason: harmonic.relationship,
                camelot: candCamelot,
                energyScore: energyScore !== null ? Math.round(energyScore * 100) / 100 : null
              };
            }
          }
        }
      }
    }

    // Fallback: if no track has verified BPM or matches within 6%, pick next sequential unplayed track without forcing fake tempo sync
    if (!best && currentIndex + 1 < queue.length) {
      return { track: queue[currentIndex + 1], index: currentIndex + 1, targetBpm: validCurrentBpm || null, fallback: true, compatible: false };
    }
    return best;
  }

  /**
   * Compute safe tempo-match playbackRate ratio (clamped to +-6% so pitch stays natural)
   */
  computeTempoRatio(sourceBpm, targetBpm, maxDeviation = 0.06) {
    if (!sourceBpm || !targetBpm || sourceBpm <= 0 || targetBpm <= 0) return 1.0;
    const candidates = [targetBpm, targetBpm * 2, targetBpm * 0.5];
    let best = targetBpm;
    let minDiff = Infinity;
    for (const c of candidates) {
      const diff = Math.abs(sourceBpm - c) / c;
      if (diff < minDiff) {
        minDiff = diff;
        best = c;
      }
    }
    const ratio = sourceBpm / best;
    if (Math.abs(ratio - 1.0) > maxDeviation) return 1.0;
    return Math.max(1.0 - maxDeviation, Math.min(1.0 + maxDeviation, ratio));
  }

  /**
   * Abort active crossfade immediately (Pause, Seek, Skip)
   * Commits immediately to the target track, resets gains, cleans up DJ filter
   * @param {string} reason 'pause' | 'seek' | 'skip' | 'manual'
   */
  abortCrossfade(reason = 'manual') {
    if (!this.isCrossfading && !this._currentFade) return false;

    const fade = this._currentFade;
    const suppressToken = (fade && fade.suppressToken) || this._crossfadeSuppressToken;
    this.isCrossfading = false;
    this._currentFade = null;
    this._crossfadeSuppressToken = null;

    if (fade && fade.interval) {
      clearInterval(fade.interval);
      fade.interval = null;
    }

    const { outgoingAudio, incomingAudio, inFilter, outFilter, initialUserVol, useDeckGains, audioEngine } = fade || {};

    try {
      if (useDeckGains && audioEngine && typeof audioEngine.setDeckGains === 'function') {
        audioEngine.setDeckGains({ deckA: 1.0, deckB: 0.0, rampMs: 30 });
      } else if (audioEngine && audioEngine.fadeGain && audioEngine.ctx) {
        audioEngine.fadeGain.gain.setValueAtTime(1.0, audioEngine.ctx.currentTime);
      }

      if (outgoingAudio) {
        outgoingAudio.volume = initialUserVol;
        outgoingAudio.playbackRate = 1.0;
        if (reason === 'skip' || reason === 'pause' || reason === 'queue_replaced') {
          outgoingAudio.pause();
        }
        // In 'seek' or 'mode_change': do NOT pause outgoingAudio; keep previous playback intent running smoothly
      }

      if (incomingAudio) {
        incomingAudio.volume = 0;
        incomingAudio.playbackRate = 1.0;
        try {
          incomingAudio.pause();
          incomingAudio.currentTime = 0;
        } catch (_) {}
      }

      if (inFilter && inFilter.context) {
        inFilter.frequency.setValueAtTime(20, inFilter.context.currentTime);
        if (audioEngine && audioEngine.auxMediaSource && audioEngine.deckBGain) {
          try {
            audioEngine.auxMediaSource.disconnect();
            audioEngine.auxMediaSource.connect(audioEngine.deckBGain);
          } catch (_) {}
        }
      }
      if (outFilter && outFilter.context) {
        outFilter.frequency.setValueAtTime(20000, outFilter.context.currentTime);
        const primarySource = audioEngine && (audioEngine.mediaSource || audioEngine.source);
        if (primarySource && audioEngine.deckAGain) {
          try {
            primarySource.disconnect();
            primarySource.connect(audioEngine.deckAGain);
          } catch (_) {}
        }
      }
    } catch (_) {}

    const suppressionMgr = _getDJSuppressionManager();
    if (typeof window !== 'undefined') {
      setTimeout(() => {
        if (suppressionMgr && suppressToken !== null) {
          suppressionMgr.release(suppressToken);
        }
      }, 80);
      window.dispatchEvent(new CustomEvent('eclipse:automix-state', {
        detail: { active: false, aborted: true, reason }
      }));
    } else if (suppressionMgr && suppressToken !== null) {
      setTimeout(() => {
        suppressionMgr.release(suppressToken);
      }, 80);
    }

    if (fade && typeof fade.reject === 'function') {
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
    const suppressionMgr = _getDJSuppressionManager();
    const suppressToken = suppressionMgr ? suppressionMgr.acquire('AutoMixDJ') : null;
    this._crossfadeSuppressToken = suppressToken;
    const startTime = Date.now();
    const durationMs = Math.max(200, duration * 1000);
    const initialUserVol = Number.isFinite(outgoingAudio.volume) ? Math.max(0, Math.min(1, outgoingAudio.volume)) : 1.0;

    const audioEngine = (typeof window !== 'undefined' && window.audioEngine) ? window.audioEngine : null;
    const useDeckGains = !!(audioEngine && typeof audioEngine.setDeckGains === 'function');
    const useFadeGainNode = !useDeckGains && !!(audioEngine && audioEngine.fadeGain && audioEngine.ctx);

    const isTempoMode = (this.mode === 'tempo_synced' || this.mode === 'dj_mix');
    const startInRate = (isTempoMode && options.tempoSynced !== false)
      ? (typeof options.tempoRatio === 'number' && Number.isFinite(options.tempoRatio)
          ? options.tempoRatio
          : this.computeTempoRatio(options.outgoingBpm || this.bpm, options.incomingBpm || this.bpm))
      : 1.0;

    // Optional WebAudio DJ-Style Filter sweep:
    // - Incoming HPF: 1400Hz -> 20Hz on Deck B
    // - Outgoing LPF: 18000Hz -> 400Hz on Deck A
    // Reuse existing DSP sources from AudioEngine; NEVER create a duplicate MediaElementAudioSourceNode
    let inFilter = null;
    let outFilter = null;
    if (this.djFilter && typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext)) {
      try {
        const ctx = (audioEngine && audioEngine.ctx) || null;
        if (ctx && audioEngine.auxMediaSource && audioEngine.deckBGain) {
          if (ctx.state === 'suspended') ctx.resume().catch(() => {});
          if (!incomingAudio._eclipseMixFilter) {
            incomingAudio._eclipseMixFilter = ctx.createBiquadFilter();
            incomingAudio._eclipseMixFilter.type = 'highpass';
            incomingAudio._eclipseMixFilter.Q.value = 0.7;
          }
          inFilter = incomingAudio._eclipseMixFilter;
          inFilter.frequency.setValueAtTime(1400, ctx.currentTime);
          try {
            audioEngine.auxMediaSource.disconnect();
            audioEngine.auxMediaSource.connect(inFilter);
            inFilter.connect(audioEngine.deckBGain);
          } catch (routeErr) {
            console.warn('[AutoMixDJ] Failed to route DJ filter through Deck B graph, restoring direct Deck B connection:', routeErr?.message || routeErr);
            try { audioEngine.auxMediaSource.connect(audioEngine.deckBGain); } catch (_) {}
            inFilter = null;
          }
        } else {
          // AudioEngine does not own an initialized auxiliary source yet — disable DJ filter cleanly rather than creating a duplicate MediaElementSource
          inFilter = null;
        }

        const primarySource = audioEngine.mediaSource || audioEngine.source;
        if (ctx && primarySource && audioEngine.deckAGain) {
          if (!outgoingAudio._eclipseOutMixFilter) {
            outgoingAudio._eclipseOutMixFilter = ctx.createBiquadFilter();
            outgoingAudio._eclipseOutMixFilter.type = 'lowpass';
            outgoingAudio._eclipseOutMixFilter.Q.value = 0.7;
          }
          outFilter = outgoingAudio._eclipseOutMixFilter;
          outFilter.frequency.setValueAtTime(18000, ctx.currentTime);
          try {
            primarySource.disconnect();
            primarySource.connect(outFilter);
            outFilter.connect(audioEngine.deckAGain);
          } catch (outRouteErr) {
            console.warn('[AutoMixDJ] Failed to route outgoing LPF filter, restoring direct Deck A connection:', outRouteErr?.message || outRouteErr);
            try { primarySource.connect(audioEngine.deckAGain); } catch (_) {}
            outFilter = null;
          }
        }
      } catch (filterErr) {
        console.warn('[AutoMixDJ] DJ filter setup disabled:', filterErr?.message || filterErr);
        inFilter = null;
        outFilter = null;
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
        setTimeout(() => {
          if (suppressionMgr && suppressToken !== null) {
            suppressionMgr.release(suppressToken);
          }
        }, 50);
      } else if (suppressionMgr && suppressToken !== null) {
        setTimeout(() => {
          suppressionMgr.release(suppressToken);
        }, 50);
      }
      this._crossfadeSuppressToken = null;
      // Rollback gains and filters immediately to prevent fading outgoing into silence or muffled LPF
      if (outFilter && outFilter.context) {
        try { outFilter.frequency.setValueAtTime(20000, outFilter.context.currentTime); } catch (_) {}
      }
      if (inFilter && inFilter.context) {
        try { inFilter.frequency.setValueAtTime(20, inFilter.context.currentTime); } catch (_) {}
      }
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
        outFilter,
        initialUserVol,
        useDeckGains,
        useFadeGainNode,
        audioEngine,
        suppressToken,
        interval: null,
        resolve,
        reject
      };
      this._currentFade = fadeState;

      fadeState.interval = setInterval(() => {
        const elapsed = Date.now() - startTime;
        const progress = Math.min(1.0, elapsed / durationMs);

        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('eclipse:automix-progress', {
            detail: { progress, elapsedMs: elapsed, durationMs }
          }));
        }

        if (progress >= 1.0) {
          clearInterval(fadeState.interval);
          fadeState.interval = null;
          this.isCrossfading = false;
          this._currentFade = null;
          try {
            outgoingAudio.pause();
            // Required terminal state after successful crossfade: Deck A = 0.0, Deck B = 1.0
            // Incoming aux audio MUST remain audible through Deck B until PlaybackHandover completes on native 'playing'
            if (useDeckGains) {
              audioEngine.setDeckGains({ deckA: 0.0, deckB: 1.0, rampMs: 30 });
            } else if (useFadeGainNode) {
              audioEngine.fadeGain.gain.setValueAtTime(0.0, audioEngine.ctx.currentTime);
            } else {
              outgoingAudio.volume = 0;
            }
            outgoingAudio.playbackRate = 1.0;
            incomingAudio.volume = initialUserVol;
            incomingAudio.playbackRate = 1.0;
            if (inFilter && inFilter.context) {
              inFilter.frequency.setValueAtTime(20, inFilter.context.currentTime);
              if (audioEngine && audioEngine.auxMediaSource && audioEngine.deckBGain) {
                try {
                  audioEngine.auxMediaSource.disconnect();
                  audioEngine.auxMediaSource.connect(audioEngine.deckBGain);
                } catch (_) {}
              }
            }
            if (outFilter && outFilter.context) {
              outFilter.frequency.setValueAtTime(20000, outFilter.context.currentTime);
              const primarySource = audioEngine && (audioEngine.mediaSource || audioEngine.source);
              if (primarySource && audioEngine.deckAGain) {
                try {
                  primarySource.disconnect();
                  primarySource.connect(audioEngine.deckAGain);
                } catch (_) {}
              }
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
        if (outFilter && outFilter.context) {
          // Logarithmic LPF sweep from 18000Hz down to 400Hz
          const outFreq = 18000 * Math.pow(400 / 18000, Math.min(1, progress));
          outFilter.frequency.setValueAtTime(Math.max(400, outFreq), outFilter.context.currentTime);
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

          if (isTempoMode && options.tempoSynced !== false && startInRate !== 1.0) {
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
