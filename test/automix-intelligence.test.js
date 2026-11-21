// test/automix-intelligence.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const AutoMixDJ = require('../src/renderer/automix-dj.js');
const { TrackAnalyzer } = require('../src/renderer/automix/track-analyzer.js');
const { AnalysisCoordinator } = require('../src/renderer/automix/analysis-coordinator.js');

/**
 * Generate a synthetic PCM click track at exact BPM.
 */
function makeClickTrackPcm(bpm, durationSec = 10, sampleRate = 22050) {
  const totalSamples = Math.floor(durationSec * sampleRate);
  const samples = new Float32Array(totalSamples);
  const beatIntervalSamples = Math.round((60 / bpm) * sampleRate);
  const pulseLen = Math.floor(0.03 * sampleRate); // 30ms kick-like burst

  for (let pos = 0; pos < totalSamples; pos += beatIntervalSamples) {
    for (let j = 0; j < pulseLen && pos + j < totalSamples; j++) {
      const env = Math.exp(-j / (pulseLen * 0.25));
      samples[pos + j] += Math.sin(2 * Math.PI * 80 * (j / sampleRate)) * env;
    }
  }
  return samples;
}

/**
 * Generate a synthetic harmonic triad chord PCM buffer (e.g. C Major or A Minor).
 */
function makeChordPcm(freqsHz, durationSec = 4, sampleRate = 22050) {
  const totalSamples = Math.floor(durationSec * sampleRate);
  const samples = new Float32Array(totalSamples);
  const amp = 0.8 / freqsHz.length;
  for (let i = 0; i < totalSamples; i++) {
    const t = i / sampleRate;
    let sum = 0;
    for (const f of freqsHz) {
      sum += Math.sin(2 * Math.PI * f * t);
    }
    samples[i] = sum * amp;
  }
  return samples;
}

describe('Phase A — Live BPM Sampler & Gapless Album Correctness', () => {
  it('never fabricates 120 BPM on silence or uninitialized state', () => {
    const dj = new AutoMixDJ();
    assert.equal(dj.bpm, null);

    const silentAnalyser = {
      frequencyBinCount: 64,
      fftSize: 128,
      context: { sampleRate: 44100 },
      getByteFrequencyData(buf) {
        buf.fill(0);
      }
    };

    const res = dj.sampleLiveBpm(silentAnalyser);
    assert.equal(res.bpm, null);
    assert.equal(res.confidence, 0);
    assert.equal(res.source, 'live-analysis');
    assert.equal(dj.bpm, null);
  });

  it('resets live BPM state completely on track change via resetLiveBpm()', () => {
    const dj = new AutoMixDJ();
    dj._detectedBpm = 128;
    dj._bpmConfidence = 0.72;
    dj.bpm = 128;
    dj._onsetTimes = [1000, 1500, 2000];

    dj.resetLiveBpm();
    assert.equal(dj._detectedBpm, null);
    assert.equal(dj._bpmConfidence, 0);
    assert.equal(dj.bpm, null);
    assert.equal(dj._onsetTimes.length, 0);
  });

  it('shouldSkipCrossfade uses stable albumId when present and avoids false positive on same album title', () => {
    const dj = new AutoMixDJ({ enabled: true, mode: 'tempo_synced', gaplessSameAlbum: true });

    const a1 = { id: 't1', albumId: 'alb-1', album: 'Greatest Hits', artist: 'Artist A' };
    const a2 = { id: 't2', albumId: 'alb-1', album: 'Greatest Hits', artist: 'Artist A' };
    const b1 = { id: 't3', albumId: 'alb-2', album: 'Greatest Hits', artist: 'Artist A' };

    assert.equal(dj.shouldSkipCrossfade(a1, a2, { gaplessSameAlbum: true }).skip, true);
    assert.equal(dj.shouldSkipCrossfade(a1, b1, { gaplessSameAlbum: true }).skip, false);
  });
});

describe('Phase C — Authentic PCM BPM, Key Detection & Camelot Wheel', () => {
  it('detects 120 BPM from synthetic click track PCM and returns null on silence', () => {
    const analyzer = new TrackAnalyzer();
    const pcm120 = makeClickTrackPcm(120, 10, 22050);
    const res = analyzer.analyzeBpmFromPcm(pcm120, 22050);

    assert.ok(res.bpm !== null, 'Expected non-null BPM for 120 BPM click track');
    assert.ok(Math.abs(res.bpm - 120) <= 3, `Expected ~120 BPM, got ${res.bpm}`);
    assert.ok(res.confidence >= 0.4, `Expected confidence >= 0.4, got ${res.confidence}`);

    const silence = new Float32Array(22050 * 4);
    const silentRes = analyzer.analyzeBpmFromPcm(silence, 22050);
    assert.equal(silentRes.bpm, null);
    assert.equal(silentRes.confidence, 0);
  });

  it('detects C Major (8B) and A Minor (8A) from synthetic triad PCM and null on silence', () => {
    const analyzer = new TrackAnalyzer();

    // C Major triad: C4 (261.63), E4 (329.63), G4 (392.00), C5 (523.25)
    const cMajPcm = makeChordPcm([261.63, 329.63, 392.0, 523.25], 3, 22050);
    const cMaj = analyzer.analyzeKeyFromPcm(cMajPcm, 22050);
    assert.equal(cMaj.tonic, 'C');
    assert.equal(cMaj.mode, 'major');
    assert.equal(cMaj.camelot, '8B');
    assert.ok(cMaj.confidence > 0);

    // A Minor triad: A3 (220.0), C4 (261.63), E4 (329.63), A4 (440.0)
    const aMinPcm = makeChordPcm([220.0, 261.63, 329.63, 440.0], 3, 22050);
    const aMin = analyzer.analyzeKeyFromPcm(aMinPcm, 22050);
    assert.equal(aMin.tonic, 'A');
    assert.equal(aMin.mode, 'minor');
    assert.equal(aMin.camelot, '8A');
    assert.ok(aMin.confidence > 0);

    // Silence
    const silentKey = analyzer.analyzeKeyFromPcm(new Float32Array(22050 * 2), 22050);
    assert.equal(silentKey.tonic, null);
    assert.equal(silentKey.camelot, null);
    assert.equal(silentKey.confidence, 0);
  });

  it('scores Camelot Wheel harmonic compatibility accurately', () => {
    const analyzer = new TrackAnalyzer();
    assert.equal(analyzer.scoreHarmonicCompatibility('8B', '8B').score, 1.0);
    assert.equal(analyzer.scoreHarmonicCompatibility('8B', '8A').relationship, 'relative_major_minor');
    assert.equal(analyzer.scoreHarmonicCompatibility('8B', '9B').relationship, 'adjacent_camelot');
    assert.equal(analyzer.scoreHarmonicCompatibility('12A', '1A').relationship, 'adjacent_camelot');
    assert.equal(analyzer.scoreHarmonicCompatibility('8B', '2B').relationship, 'incompatible');
    assert.equal(analyzer.scoreHarmonicCompatibility('8B', null).relationship, 'unknown');
  });
});

describe('Phase B — AnalysisCoordinator Concurrency, Cancellation & Error Isolation', () => {
  it('enforces bounded concurrency and isolates single-track decode errors', async () => {
    const analyzer = new TrackAnalyzer();
    let inFlight = 0;
    let maxInFlight = 0;

    const coordinator = new AnalysisCoordinator({
      analyzer,
      concurrency: 2,
      decodeAudio: async (track) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise(r => setTimeout(r, 15));
        inFlight--;
        if (track.id === 'bad') throw new Error('Decode failed');
        return { samples: makeClickTrackPcm(120, 4, 22050), sampleRate: 22050 };
      }
    });

    const tracks = [
      { id: 't1', title: 'Track 1' },
      { id: 'bad', title: 'Bad Track' },
      { id: 't2', title: 'Track 2' },
      { id: 't3', title: 'Track 3' },
    ];

    const finalStatus = await coordinator.scanCollection(tracks, 'pl-1');
    assert.ok(maxInFlight <= 2, `Concurrency exceeded limit: ${maxInFlight}`);
    assert.equal(finalStatus.state, 'partial');
    assert.equal(finalStatus.total, 4);
    assert.equal(finalStatus.completed, 4);
    assert.equal(finalStatus.failed, 1);
    assert.ok(analyzer.getCachedRecord(tracks[0]).bpm !== null);
  });

  it('cancels active scan cleanly when cancel() is called', async () => {
    const analyzer = new TrackAnalyzer();
    const coordinator = new AnalysisCoordinator({
      analyzer,
      concurrency: 1,
      decodeAudio: async (_track, signal) => {
        await new Promise((resolve) => {
          const t = setTimeout(resolve, 100);
          if (signal) signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
        });
        return null;
      }
    });

    const tracks = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const scanPromise = coordinator.scanCollection(tracks, 'pl-cancel');
    await new Promise(r => setTimeout(r, 20));
    coordinator.cancel();
    const status = await scanPromise;
    assert.equal(status.state, 'cancelled');
  });
});

describe('Phase D — Harmonic-Aware Candidate Ranking', () => {
  it('prefers harmonically compatible track when BPM is equal', () => {
    const analyzer = new TrackAnalyzer();
    const dj = new AutoMixDJ({ enabled: true, mode: 'tempo_synced' });

    const current = { id: 'curr', bpm: 124, _camelot: '8B' };
    const clash = { id: 'clash', bpm: 124, _camelot: '2B' };   // incompatible
    const harmonic = { id: 'harm', bpm: 124, _camelot: '9B' }; // adjacent Camelot

    const picked = dj.pickTempoSyncedNext([current, clash, harmonic], 0, new Set(), 124, { analyzer });
    assert.ok(picked !== null);
    assert.equal(picked.track.id, 'harm');
    assert.equal(picked.compatible, true);
    assert.equal(picked.harmonicReason, 'adjacent_camelot');
  });
});
