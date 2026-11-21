// src/renderer/automix/audio-graph.js
// JavaScript / audio-graph.js / Web / Eclipse PC & Mobile
// Audio Graph Manager: ensures Deck A and Deck B pass through shared DSP, EQ, limiter, and spatial audio

class AudioGraphManager {
  constructor(audioEngine = null) {
    this.audioEngine = audioEngine;
  }

  setAudioEngine(engine) {
    this.audioEngine = engine;
  }

  ensureDualDeckRouting(nativeAudio, auxAudio) {
    if (!this.audioEngine) return false;
    if (nativeAudio && typeof this.audioEngine.init === 'function') {
      this.audioEngine.init(nativeAudio);
    }
    if (auxAudio && typeof this.audioEngine.attachAuxAudio === 'function') {
      return this.audioEngine.attachAuxAudio(auxAudio);
    }
    return false;
  }

  setDeckGains(deckAGain = 1.0, deckBGain = 0.0, rampMs = 30) {
    if (this.audioEngine && typeof this.audioEngine.setDeckGains === 'function') {
      this.audioEngine.setDeckGains({ deckA: deckAGain, deckB: deckBGain, rampMs });
      return true;
    }
    return false;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { AudioGraphManager };
}
if (typeof window !== 'undefined') {
  window.AudioGraphManager = AudioGraphManager;
}
