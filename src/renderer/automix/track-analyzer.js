// src/renderer/automix/track-analyzer.js
// JavaScript / track-analyzer.js / Web & Node.js / Eclipse PC & Mobile
// Track Analyzer: authentic BPM/beat-grid, Krumhansl-Schmuckler chroma key detection, Camelot Wheel mapping,
// harmonic scoring, provenance tracking, and versioned LRU analysis cache.

const ANALYSIS_VERSION = 2;

// Krumhansl-Schmuckler pitch-class key profiles (C=0 .. B=11)
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

const PITCH_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Standard Camelot Wheel mapping
const CAMELOT_MAJOR = {
  'C': '8B', 'G': '9B', 'D': '10B', 'A': '11B', 'E': '12B', 'B': '1B',
  'F#': '2B', 'Gb': '2B', 'C#': '3B', 'Db': '3B', 'G#': '4B', 'Ab': '4B',
  'D#': '5B', 'Eb': '5B', 'A#': '6B', 'Bb': '6B', 'F': '7B'
};

const CAMELOT_MINOR = {
  'A': '8A', 'E': '9A', 'B': '10A', 'F#': '11A', 'Gb': '11A', 'C#': '12A', 'Db': '12A',
  'G#': '1A', 'Ab': '1A', 'D#': '2A', 'Eb': '2A', 'A#': '3A', 'Bb': '3A',
  'F': '4A', 'C': '5A', 'G': '6A', 'D': '7A'
};

function pearsonCorrelation(x, y) {
  const n = x.length;
  let sumX = 0, sumY = 0;
  for (let i = 0; i < n; i++) { sumX += x[i]; sumY += y[i]; }
  const meanX = sumX / n;
  const meanY = sumY / n;
  let num = 0, denX = 0, denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  const den = Math.sqrt(denX * denY);
  return den === 0 ? 0 : num / den;
}

class TrackAnalyzer {
  constructor(options = {}) {
    this.maxCacheEntries = options.maxCacheEntries || 500;
    this.cache = new Map(); // stableTrackId -> analysisRecord
  }

  getStableTrackId(track) {
    if (!track) return null;
    const provider = track.platform || track.source || 'default';
    const rawId = track.id || track.videoId || track.path || track.url;
    if (!rawId) return null;
    return `${provider}::${String(rawId)}`;
  }

  getCachedRecord(track) {
    const id = this.getStableTrackId(track);
    if (!id) return null;
    const rec = this.cache.get(id);
    if (!rec || rec.analysisVersion !== ANALYSIS_VERSION) return null;
    return rec;
  }

  invalidateTrack(track) {
    const id = this.getStableTrackId(track);
    if (!id) return false;
    return this.cache.delete(id);
  }

  setCachedRecord(track, record) {
    const id = this.getStableTrackId(track);
    if (!id || !record) return;
    if (this.cache.size >= this.maxCacheEntries && !this.cache.has(id)) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }
    this.cache.set(id, {
      ...record,
      trackId: id,
      analysisVersion: ANALYSIS_VERSION,
      analyzedAt: Date.now()
    });
  }

  toCamelot(tonic, mode) {
    if (!tonic || !mode) return null;
    const m = String(mode).toLowerCase();
    const map = m === 'major' ? CAMELOT_MAJOR : (m === 'minor' ? CAMELOT_MINOR : null);
    return map ? (map[tonic] || null) : null;
  }

  parseCamelot(code) {
    if (!code || typeof code !== 'string') return null;
    const m = /^(\d{1,2})([AB])$/i.exec(code.trim());
    if (!m) return null;
    const num = parseInt(m[1], 10);
    const letter = m[2].toUpperCase();
    if (num < 1 || num > 12) return null;
    return { num, letter };
  }

  /**
   * Compute harmonic compatibility score between two Camelot keys (0.0 to 1.0).
   */
  scoreHarmonicCompatibility(camelotA, camelotB) {
    const a = this.parseCamelot(camelotA);
    const b = this.parseCamelot(camelotB);
    if (!a || !b) {
      return { score: 0, relationship: 'unknown', compatible: false };
    }

    if (a.num === b.num && a.letter === b.letter) {
      return { score: 1.0, relationship: 'same_key', compatible: true };
    }
    if (a.num === b.num && a.letter !== b.letter) {
      return { score: 0.9, relationship: 'relative_major_minor', compatible: true };
    }
    const diff = Math.min(Math.abs(a.num - b.num), 12 - Math.abs(a.num - b.num));
    if (diff === 1 && a.letter === b.letter) {
      return { score: 0.85, relationship: 'adjacent_camelot', compatible: true };
    }
    if (diff === 2 && a.letter === b.letter) {
      return { score: 0.65, relationship: 'energy_boost', compatible: true };
    }
    return { score: 0.1, relationship: 'incompatible', compatible: false };
  }

  /**
   * Estimate BPM from a mono PCM Float32Array via energy onset envelope + autocorrelation.
   * Returns { bpm: number|null, beatPeriodMs: number|null, confidence: number, halfDoubleTimeCandidates: number[] }
   */
  analyzeBpmFromPcm(samples, sampleRate = 44100) {
    if (!samples || samples.length < sampleRate * 2) {
      return { bpm: null, beatPeriodMs: null, confidence: 0, halfDoubleTimeCandidates: [] };
    }

    const frameSize = 1024;
    const hopSize = 512;
    const numFrames = Math.floor((samples.length - frameSize) / hopSize);
    if (numFrames < 32) {
      return { bpm: null, beatPeriodMs: null, confidence: 0, halfDoubleTimeCandidates: [] };
    }

    // 1. Compute frame RMS energy envelope
    const energies = new Float32Array(numFrames);
    let maxEnergy = 0;
    for (let f = 0; f < numFrames; f++) {
      let sumSq = 0;
      const offset = f * hopSize;
      for (let i = 0; i < frameSize; i++) {
        const s = samples[offset + i];
        sumSq += s * s;
      }
      const rms = Math.sqrt(sumSq / frameSize);
      energies[f] = rms;
      if (rms > maxEnergy) maxEnergy = rms;
    }

    // Silence check
    if (maxEnergy < 0.005) {
      return { bpm: null, beatPeriodMs: null, confidence: 0, halfDoubleTimeCandidates: [] };
    }

    // 2. Half-wave rectified first-order difference (onset strength envelope)
    const onsetEnv = new Float32Array(numFrames);
    let onsetSum = 0;
    for (let f = 1; f < numFrames; f++) {
      const diff = energies[f] - energies[f - 1];
      if (diff > 0) {
        onsetEnv[f] = diff;
        onsetSum += diff;
      }
    }
    if (onsetSum === 0) {
      return { bpm: null, beatPeriodMs: null, confidence: 0, halfDoubleTimeCandidates: [] };
    }

    // 3. Autocorrelation over tempo range 65 BPM to 180 BPM
    const framesPerSec = sampleRate / hopSize;
    const minLag = Math.max(1, Math.floor((60 / 180) * framesPerSec));
    const maxLag = Math.min(numFrames - 1, Math.ceil((60 / 65) * framesPerSec));

    let bestLag = -1;
    let bestCorr = -Infinity;
    let sumCorr = 0;
    let lagCount = 0;

    for (let lag = minLag; lag <= maxLag; lag++) {
      let corr = 0;
      const limit = numFrames - lag;
      for (let i = 0; i < limit; i++) {
        corr += onsetEnv[i] * onsetEnv[i + lag];
      }
      corr /= limit;
      sumCorr += corr;
      lagCount++;
      if (corr > bestCorr) {
        bestCorr = corr;
        bestLag = lag;
      }
    }

    if (bestLag <= 0 || bestCorr <= 0) {
      return { bpm: null, beatPeriodMs: null, confidence: 0, halfDoubleTimeCandidates: [] };
    }

    const avgCorr = sumCorr / Math.max(1, lagCount);
    const peakToAvg = avgCorr > 0 ? bestCorr / avgCorr : 0;

    // Confidence derived from peak clarity over background autocorrelation
    const confidence = Math.round(Math.min(0.95, Math.max(0, (peakToAvg - 1.2) / 3.0)) * 100) / 100;
    if (confidence < 0.25) {
      return { bpm: null, beatPeriodMs: null, confidence, halfDoubleTimeCandidates: [] };
    }

    const bpm = Math.round((60 * framesPerSec) / bestLag);
    const beatPeriodMs = Math.round((60000 / bpm) * 10) / 10;

    return {
      bpm,
      beatPeriodMs,
      confidence,
      halfDoubleTimeCandidates: [Math.round(bpm / 2), bpm, bpm * 2]
    };
  }

  /**
   * Estimate Musical Key (Tonic + Major/Minor + Camelot) from mono PCM Float32Array
   * using Goertzel pitch-class chroma energy + Krumhansl-Schmuckler correlation.
   */
  analyzeKeyFromPcm(samples, sampleRate = 44100) {
    if (!samples || samples.length < sampleRate * 1.5) {
      return { tonic: null, mode: null, camelot: null, confidence: 0, alternatives: [] };
    }

    // Check signal RMS
    let sumSq = 0;
    const step = Math.max(1, Math.floor(samples.length / 44100));
    let count = 0;
    for (let i = 0; i < samples.length; i += step) {
      sumSq += samples[i] * samples[i];
      count++;
    }
    if (Math.sqrt(sumSq / Math.max(1, count)) < 0.005) {
      return { tonic: null, mode: null, camelot: null, confidence: 0, alternatives: [] };
    }

    // Compute 12-bin chromagram across octaves 2..5 (MIDI 36..83) using Goertzel filter
    const chroma = new Float64Array(12);
    const maxSamples = Math.min(samples.length, sampleRate * 8); // up to 8 seconds
    const windowSize = 4096;
    const hop = 4096;
    const numWindows = Math.max(1, Math.floor((maxSamples - windowSize) / hop));

    for (let midi = 36; midi <= 83; midi++) {
      const freq = 440 * Math.pow(2, (midi - 69) / 12);
      const pc = midi % 12;
      const k = Math.round((windowSize * freq) / sampleRate);
      const omega = (2 * Math.PI * k) / windowSize;
      const coeff = 2 * Math.cos(omega);

      let noteEnergy = 0;
      for (let w = 0; w < numWindows; w++) {
        const offset = w * hop;
        let sPrev = 0;
        let sPrev2 = 0;
        for (let i = 0; i < windowSize; i++) {
          const s = samples[offset + i] + coeff * sPrev - sPrev2;
          sPrev2 = sPrev;
          sPrev = s;
        }
        const power = sPrev2 * sPrev2 + sPrev * sPrev - coeff * sPrev * sPrev2;
        noteEnergy += Math.max(0, power);
      }
      chroma[pc] += Math.sqrt(noteEnergy / numWindows);
    }

    let chromaTotal = 0;
    for (let i = 0; i < 12; i++) chromaTotal += chroma[i];
    if (chromaTotal <= 0) {
      return { tonic: null, mode: null, camelot: null, confidence: 0, alternatives: [] };
    }

    // Correlate rotated chroma against Major & Minor Krumhansl-Schmuckler profiles
    const candidates = [];
    for (let shift = 0; shift < 12; shift++) {
      const rotated = new Array(12);
      for (let i = 0; i < 12; i++) rotated[i] = chroma[(i + shift) % 12];

      const corrMaj = pearsonCorrelation(rotated, MAJOR_PROFILE);
      const corrMin = pearsonCorrelation(rotated, MINOR_PROFILE);
      candidates.push({ tonic: PITCH_NAMES[shift], mode: 'major', corr: corrMaj });
      candidates.push({ tonic: PITCH_NAMES[shift], mode: 'minor', corr: corrMin });
    }

    candidates.sort((a, b) => b.corr - a.corr);
    const best = candidates[0];
    const second = candidates[1];

    // Confidence based on correlation strength & margin over runner-up
    const margin = Math.max(0, best.corr - second.corr);
    const rawConf = Math.max(0, Math.min(0.95, best.corr * 0.75 + margin * 1.5));
    const confidence = Math.round(rawConf * 100) / 100;

    if (best.corr < 0.35 || confidence < 0.3) {
      return { tonic: null, mode: null, camelot: null, confidence, alternatives: [] };
    }

    return {
      tonic: best.tonic,
      mode: best.mode,
      camelot: this.toCamelot(best.tonic, best.mode),
      confidence,
      alternatives: candidates.slice(1, 3).map(c => ({
        tonic: c.tonic,
        mode: c.mode,
        camelot: this.toCamelot(c.tonic, c.mode),
        corr: Math.round(c.corr * 100) / 100
      }))
    };
  }

  /**
   * Compute energy / RMS envelope and beat-grid phase estimate from mono PCM samples.
   */
  computeEnergyProfile(samples, sampleRate = 44100, windowMs = 50) {
    if (!samples || samples.length === 0) return { rms: 0, envelope: [], beatPhaseSec: 0 };
    const windowSize = Math.max(64, Math.floor((windowMs / 1000) * sampleRate));
    const numWindows = Math.floor(samples.length / windowSize);
    const envelope = [];
    let totalSq = 0;
    let maxWinEnergy = 0;
    let maxWinIdx = 0;

    for (let w = 0; w < numWindows; w++) {
      let winSq = 0;
      const offset = w * windowSize;
      for (let i = 0; i < windowSize; i++) {
        const s = samples[offset + i];
        winSq += s * s;
      }
      const winRms = Math.sqrt(winSq / windowSize);
      envelope.push(Math.round(winRms * 1000) / 1000);
      totalSq += winSq;
      if (winRms > maxWinEnergy) {
        maxWinEnergy = winRms;
        maxWinIdx = w;
      }
    }

    const overallRms = Math.sqrt(totalSq / Math.max(1, samples.length));
    const beatPhaseSec = (maxWinIdx * windowSize) / sampleRate;

    return {
      rms: Math.round(overallRms * 1000) / 1000,
      envelope: envelope.slice(0, 40), // compact representative envelope
      beatPhaseSec: Math.round(beatPhaseSec * 1000) / 1000
    };
  }

  /**
   * Build or retrieve a unified Track Analysis Record from metadata and/or PCM.
   */
  analyzeTrack(track, pcmBuffer = null, sampleRate = 44100) {
    if (!track) return null;
    const cached = this.getCachedRecord(track);
    if (cached && !pcmBuffer) return cached;

    const record = {
      trackId: this.getStableTrackId(track),
      source: 'metadata',
      analysisVersion: ANALYSIS_VERSION,
      analyzedAt: Date.now(),
      durationSec: Number(track.duration) || null,
      tempo: {
        bpm: null,
        beatPeriodMs: null,
        confidence: 0,
        halfDoubleTimeCandidates: []
      },
      key: {
        tonic: null,
        mode: null,
        camelot: null,
        confidence: 0,
        alternatives: []
      },
      energy: {
        rms: 0,
        beatPhaseSec: 0,
        envelope: []
      },
      status: 'unknown'
    };

    // 1. Read verified metadata if present
    if (typeof track.bpm === 'number' && track.bpm > 0) {
      record.tempo.bpm = track.bpm;
      record.tempo.beatPeriodMs = Math.round((60000 / track.bpm) * 10) / 10;
      record.tempo.confidence = 0.85;
      record.tempo.halfDoubleTimeCandidates = [Math.round(track.bpm / 2), track.bpm, track.bpm * 2];
      record.status = 'metadata';
    } else if (typeof track._detectedBpm === 'number' && track._detectedBpm > 0 && (track._bpmConfidence || 0) >= 0.4) {
      record.tempo.bpm = track._detectedBpm;
      record.tempo.beatPeriodMs = Math.round((60000 / track._detectedBpm) * 10) / 10;
      record.tempo.confidence = track._bpmConfidence;
      record.tempo.halfDoubleTimeCandidates = [Math.round(track._detectedBpm / 2), track._detectedBpm, track._detectedBpm * 2];
      record.source = 'live-analysis';
      record.status = 'partial';
    }

    if (track.key && typeof track.key === 'string') {
      const m = /^([A-G][#b]?)\s*(major|minor|maj|min|m)?$/i.exec(track.key.trim());
      if (m) {
        const tonic = m[1].charAt(0).toUpperCase() + m[1].slice(1);
        const modeRaw = (m[2] || 'major').toLowerCase();
        const mode = (modeRaw === 'm' || modeRaw === 'min' || modeRaw === 'minor') ? 'minor' : 'major';
        record.key = {
          tonic,
          mode,
          camelot: this.toCamelot(tonic, mode),
          confidence: 0.8,
          alternatives: []
        };
      }
    }

    // 2. If PCM samples are provided, run authentic audio analysis
    if (pcmBuffer && pcmBuffer.length > 0) {
      const bpmRes = this.analyzeBpmFromPcm(pcmBuffer, sampleRate);
      if (bpmRes.bpm && bpmRes.confidence > record.tempo.confidence) {
        record.tempo = bpmRes;
        record.source = 'audio-analysis';
      }
      const keyRes = this.analyzeKeyFromPcm(pcmBuffer, sampleRate);
      if (keyRes.tonic && keyRes.confidence > record.key.confidence) {
        record.key = keyRes;
        record.source = 'audio-analysis';
      }
      record.energy = this.computeEnergyProfile(pcmBuffer, sampleRate);
      record.status = (record.tempo.bpm || record.key.tonic) ? 'analyzed' : 'partial';
    }

    this.setCachedRecord(track, record);
    return record;
  }

  getConfidence(track) {
    if (!track) return 0;
    const rec = this.getCachedRecord(track);
    if (rec && rec.tempo.confidence > 0) return rec.tempo.confidence;
    if (typeof track._detectedBpm === 'number' && track._detectedBpm > 0 && (track._bpmConfidence || 0) >= 0.4) {
      return track._bpmConfidence;
    }
    if (typeof track.bpm === 'number' && track.bpm > 0) return 0.85;
    return 0; // Zero confidence for unverified/missing BPM
  }

  getEffectiveBpm(track) {
    if (!track) return null;
    const rec = this.getCachedRecord(track);
    if (rec && rec.tempo.bpm && rec.tempo.confidence >= 0.4) return rec.tempo.bpm;
    if (typeof track._detectedBpm === 'number' && track._detectedBpm > 0 && (track._bpmConfidence || 0) >= 0.4) {
      return track._detectedBpm;
    }
    if (typeof track.bpm === 'number' && track.bpm > 0) return track.bpm;
    return null; // Never fabricate BPM
  }

  findHarmonicMatch(sourceBpm, targetBpm, maxDeviation = 0.06) {
    if (!sourceBpm || !targetBpm || sourceBpm <= 0 || targetBpm <= 0) {
      return { ratio: 1.0, matchedTargetBpm: targetBpm, compatible: false };
    }

    const candidates = [targetBpm, targetBpm * 2, targetBpm * 0.5];
    let bestCandidate = targetBpm;
    let minDiff = Infinity;

    for (const c of candidates) {
      const diff = Math.abs(sourceBpm - c) / c;
      if (diff < minDiff) {
        minDiff = diff;
        bestCandidate = c;
      }
    }

    const rawRatio = sourceBpm / bestCandidate;
    const isCompatible = Math.abs(rawRatio - 1.0) <= maxDeviation;
    const clampedRatio = Math.max(1.0 - maxDeviation, Math.min(1.0 + maxDeviation, rawRatio));

    return {
      ratio: isCompatible ? clampedRatio : 1.0,
      matchedTargetBpm: bestCandidate,
      compatible: isCompatible
    };
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { TrackAnalyzer, ANALYSIS_VERSION, CAMELOT_MAJOR, CAMELOT_MINOR };
}
if (typeof window !== 'undefined') {
  window.TrackAnalyzer = TrackAnalyzer;
}
