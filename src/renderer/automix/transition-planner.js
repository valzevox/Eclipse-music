// src/renderer/automix/transition-planner.js
// JavaScript / transition-planner.js / Web / Eclipse PC & Mobile
// Transition Planner: computes adaptive fade duration, beat-grid alignment, 50% outro/intro rules, and tempo ratios

class TransitionPlanner {
  constructor(options = {}) {
    this.defaultDurationSec = options.defaultDurationSec || 6.0;
    this.autoDuration = options.autoDuration !== false;
    this.maxTempoRatio = options.maxTempoRatio || 0.06; // +/- 6%
  }

  getBeatAlignedDuration(bpm = 120) {
    const validBpm = (typeof bpm === 'number' && bpm > 0) ? bpm : 120;
    const beatSec = 60 / validBpm;
    const barSec = beatSec * 4;
    // Aim for 2 bars (8 beats) or 4 bars (16 beats) ~ 4s to 10s
    const twoBars = barSec * 2;
    if (twoBars >= 4 && twoBars <= 10) return Math.round(twoBars * 10) / 10;
    return Math.round(barSec * 10) / 10;
  }

  computePlan(currentTrack, nextTrack, options = {}) {
    const dur = Number(currentTrack?.duration) || 0;
    const currentBpm = (options.analyzer && typeof options.analyzer.getEffectiveBpm === 'function')
      ? options.analyzer.getEffectiveBpm(currentTrack)
      : ((typeof currentTrack?._detectedBpm === 'number' && currentTrack._detectedBpm > 0) ? currentTrack._detectedBpm : (currentTrack?.bpm || 120));
    const nextBpm = (options.analyzer && typeof options.analyzer.getEffectiveBpm === 'function')
      ? options.analyzer.getEffectiveBpm(nextTrack)
      : ((typeof nextTrack?._detectedBpm === 'number' && nextTrack._detectedBpm > 0) ? nextTrack._detectedBpm : (nextTrack?.bpm || 120));

    // 1. Detect Outro via SponsorBlock or heuristics
    let rawOutroStartSec = null;
    let lastChorusEndSec = null;

    const sponsorSegs = Array.isArray(currentTrack?.sponsorSegments) ? currentTrack.sponsorSegments : [];
    if (sponsorSegs.length > 0) {
      const outroSeg = sponsorSegs.find(s => {
        if (!s || typeof s.start !== 'number' || s.start <= 0) return false;
        const cat = String(s.category || '').toLowerCase();
        const isOutroCat = cat === 'outro' || cat === 'music_offtopic' || cat === 'filler' || cat === 'preview';
        return isOutroCat && (dur <= 0 || s.start >= dur * 0.45);
      });
      if (outroSeg) {
        rawOutroStartSec = Math.round(outroSeg.start * 10) / 10;
        lastChorusEndSec = rawOutroStartSec;
      }
    }

    if (!rawOutroStartSec) {
      const lyrics = currentTrack?.syncedLyrics;
      if (Array.isArray(lyrics) && lyrics.length > 0) {
        const timedLines = lyrics.filter(l => typeof l.time === 'number' && l.time > 0);
        const lastLine = timedLines[timedLines.length - 1];
        if (lastLine && lastLine.time > dur * 0.65 && lastLine.time < dur - 2) {
          rawOutroStartSec = Math.min(dur - 2, Math.max(dur * 0.7, lastLine.time + 2.5));
          lastChorusEndSec = rawOutroStartSec;
        }
      }
    }

    if (!rawOutroStartSec) {
      const naturalOutroLength = dur > 60 ? Math.min(24, Math.max(12, dur * 0.08)) : this.defaultDurationSec;
      rawOutroStartSec = Math.max(0, dur - naturalOutroLength);
    }

    // 50% Outro Rule: Play first 50% naturally, crossfade second 50%
    const outroDuration = Math.max(3.0, dur - rawOutroStartSec);
    const halfOutroDuration = outroDuration / 2;
    const fadeOutStart = Math.round((rawOutroStartSec + halfOutroDuration) * 10) / 10;

    // 2. Detect Intro of next song (50% Intro Rule)
    let nextIntroDuration = 0;
    const nextSbSegs = Array.isArray(nextTrack?.sponsorSegments) ? nextTrack.sponsorSegments : [];
    if (nextSbSegs.length > 0) {
      const introSeg = nextSbSegs.find(s => {
        if (!s || typeof s.end !== 'number' || s.end <= 0) return false;
        const cat = String(s.category || '').toLowerCase();
        return (cat === 'intro' || cat === 'music_offtopic') && s.start <= 2 && s.end < 45;
      });
      if (introSeg) {
        nextIntroDuration = Math.round(introSeg.end * 10) / 10;
      }
    }
    if (!nextIntroDuration && typeof nextTrack?.introSec === 'number' && nextTrack.introSec > 0) {
      nextIntroDuration = nextTrack.introSec;
    }
    if (!nextIntroDuration) {
      const nextLyrics = nextTrack?.syncedLyrics;
      if (Array.isArray(nextLyrics) && nextLyrics.length > 0) {
        const firstTimed = nextLyrics.find(l => typeof l.time === 'number' && l.time > 0);
        if (firstTimed && firstTimed.time > 2 && firstTimed.time < 35) {
          nextIntroDuration = firstTimed.time;
        }
      }
    }
    const fadeInSkip = nextIntroDuration > 3 ? Math.round((nextIntroDuration / 2) * 10) / 10 : 0;

    // 3. Tempo matching ratio calculation (clamped to +/- 6%)
    let tempoRatio = 1.0;
    let tempoSynced = false;
    if (options.analyzer && typeof options.analyzer.findHarmonicMatch === 'function') {
      const match = options.analyzer.findHarmonicMatch(currentBpm, nextBpm, this.maxTempoRatio);
      tempoRatio = match.ratio;
      tempoSynced = match.compatible;
    } else if (currentBpm > 0 && nextBpm > 0) {
      const raw = currentBpm / nextBpm;
      if (Math.abs(raw - 1.0) <= this.maxTempoRatio) {
        tempoRatio = Math.max(1.0 - this.maxTempoRatio, Math.min(1.0 + this.maxTempoRatio, raw));
        tempoSynced = true;
      }
    }

    const beatAlignedDur = this.getBeatAlignedDuration(currentBpm);
    const fadeDuration = this.autoDuration
      ? Math.max(2.0, Math.min(15.0, Math.min(halfOutroDuration, beatAlignedDur)))
      : this.defaultDurationSec;

    return {
      fadeOutStart,
      fadeInSkip,
      fadeDuration,
      introEndSec: nextIntroDuration,
      outroStartSec: rawOutroStartSec,
      lastChorusEndSec: lastChorusEndSec || rawOutroStartSec,
      halfOutroDuration,
      currentBpm,
      nextBpm,
      tempoRatio,
      tempoSynced
    };
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { TransitionPlanner };
}
if (typeof window !== 'undefined') {
  window.TransitionPlanner = TransitionPlanner;
}
