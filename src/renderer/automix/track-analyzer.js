// src/renderer/automix/track-analyzer.js
// JavaScript / track-analyzer.js / Web / Eclipse PC & Mobile
// Track Analyzer: extracts BPM, beat-grid confidence, half-time/double-time equivalence, and SponsorBlock segments

class TrackAnalyzer {
  constructor() {
    this.bpmCache = new Map();
  }

  getConfidence(track) {
    if (!track) return 0;
    if (typeof track._detectedBpm === 'number' && track._detectedBpm > 0) return 0.9;
    if (typeof track.bpm === 'number' && track.bpm > 0) return 0.85;
    return 0; // Zero confidence for fake/unverified BPM
  }

  getEffectiveBpm(track) {
    if (!track) return null;
    if (typeof track._detectedBpm === 'number' && track._detectedBpm > 0) return track._detectedBpm;
    if (typeof track.bpm === 'number' && track.bpm > 0) return track.bpm;
    return null; // Do NOT generate simulated fake BPM from track duration
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
  module.exports = { TrackAnalyzer };
}
if (typeof window !== 'undefined') {
  window.TrackAnalyzer = TrackAnalyzer;
}
