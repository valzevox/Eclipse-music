// JavaScript / auto-eq.js / AutoEQ Database & Headphone Equalizer Engine
// Part of Eclipse Music Player — MIT License

const EQ_FREQS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

// Curated profiles for the world's most popular headphones & IEMs based on AutoEQ Harman 2019 / Harman In-Ear Target
const POPULAR_HEADPHONES = [
  {
    id: 'sony-wh1000xm4',
    name: 'Sony WH-1000XM4',
    brand: 'Sony',
    type: 'over-ear',
    preamp: -5.2,
    bands: [-3.2, -4.5, -2.8, -1.0, 1.2, 2.5, -1.8, 3.2, 1.5, -2.0]
  },
  {
    id: 'sony-wh1000xm5',
    name: 'Sony WH-1000XM5',
    brand: 'Sony',
    type: 'over-ear',
    preamp: -4.8,
    bands: [-2.5, -3.8, -1.5, 0.5, 1.8, 1.2, -2.4, 2.8, 0.8, -1.5]
  },
  {
    id: 'sony-wf1000xm4',
    name: 'Sony WF-1000XM4',
    brand: 'Sony',
    type: 'in-ear',
    preamp: -4.1,
    bands: [-1.8, -2.5, -0.8, 1.2, 2.0, 0.5, -1.2, 2.1, 1.0, -1.8]
  },
  {
    id: 'apple-airpods-pro-2',
    name: 'Apple AirPods Pro 2',
    brand: 'Apple',
    type: 'in-ear',
    preamp: -3.0,
    bands: [0.5, 1.2, 0.8, -0.5, -1.0, 1.5, 2.8, -1.5, 2.0, -0.8]
  },
  {
    id: 'apple-airpods-max',
    name: 'Apple AirPods Max',
    brand: 'Apple',
    type: 'over-ear',
    preamp: -3.5,
    bands: [-1.2, -0.5, 0.8, 1.5, -0.8, -1.2, 2.4, 1.8, -1.0, 0.5]
  },
  {
    id: 'sennheiser-hd600',
    name: 'Sennheiser HD 600',
    brand: 'Sennheiser',
    type: 'over-ear',
    preamp: -6.5,
    bands: [6.2, 4.8, 2.5, 0.5, -0.8, -1.5, 1.2, -2.4, 1.0, -1.2]
  },
  {
    id: 'sennheiser-hd650',
    name: 'Sennheiser HD 650 / HD 6XX',
    brand: 'Sennheiser',
    type: 'over-ear',
    preamp: -6.8,
    bands: [6.8, 5.2, 2.8, 0.2, -1.2, -1.8, 1.5, -1.8, 0.8, -1.5]
  },
  {
    id: 'sennheiser-hd560s',
    name: 'Sennheiser HD 560S',
    brand: 'Sennheiser',
    type: 'over-ear',
    preamp: -4.5,
    bands: [4.2, 2.8, 1.0, -0.5, -0.8, 0.5, -1.8, -2.5, 1.2, 0.2]
  },
  {
    id: 'audio-technica-ath-m50x',
    name: 'Audio-Technica ATH-M50x',
    brand: 'Audio-Technica',
    type: 'over-ear',
    preamp: -5.0,
    bands: [-3.8, -4.2, -1.5, 0.8, 1.5, -0.5, -3.2, 2.5, -1.8, 1.2]
  },
  {
    id: 'bose-quietcomfort-45',
    name: 'Bose QuietComfort 45 / QC SE',
    brand: 'Bose',
    type: 'over-ear',
    preamp: -4.2,
    bands: [1.5, -1.0, -2.5, -1.8, 0.5, 1.2, -4.2, 1.8, 2.5, -3.0]
  },
  {
    id: 'samsung-galaxy-buds2-pro',
    name: 'Samsung Galaxy Buds2 Pro',
    brand: 'Samsung',
    type: 'in-ear',
    preamp: -3.2,
    bands: [0.8, 1.0, -0.5, -1.2, 0.2, 1.8, -1.5, 2.0, 1.2, -0.5]
  },
  {
    id: 'moondrop-aria',
    name: 'Moondrop Aria / Kato',
    brand: 'Moondrop',
    type: 'in-ear',
    preamp: -3.8,
    bands: [1.2, 0.8, -0.5, -1.0, 0.5, 1.2, -2.1, 1.5, 0.8, -1.0]
  },
  {
    id: 'moondrop-chu-2',
    name: 'Moondrop Chu II',
    brand: 'Moondrop',
    type: 'in-ear',
    preamp: -4.0,
    bands: [-1.5, -2.0, -0.5, 0.8, 1.2, 0.5, -2.8, 1.8, 1.0, -1.2]
  },
  {
    id: 'tangzu-wan-er',
    name: 'TANGZU Wan\'er S.G',
    brand: 'TANGZU',
    type: 'in-ear',
    preamp: -3.5,
    bands: [0.5, -0.8, -1.2, 0.2, 0.8, 1.5, -2.2, 1.0, 0.5, -1.5]
  },
  {
    id: '7hz-zero',
    name: '7Hz Salnotes Zero / Zero:2',
    brand: '7Hz',
    type: 'in-ear',
    preamp: -3.0,
    bands: [1.0, 0.5, -0.2, -0.8, 0.2, 1.0, -1.5, 1.2, 0.8, -0.5]
  },
  {
    id: 'beyerdynamic-dt770-80',
    name: 'Beyerdynamic DT 770 Pro (80 Ohm)',
    brand: 'Beyerdynamic',
    type: 'over-ear',
    preamp: -6.0,
    bands: [-2.0, -1.5, 1.2, 2.5, 0.5, -1.0, -2.5, -5.8, -3.2, 2.0]
  },
  {
    id: 'beyerdynamic-dt990-250',
    name: 'Beyerdynamic DT 990 Pro (250 Ohm)',
    brand: 'Beyerdynamic',
    type: 'over-ear',
    preamp: -6.5,
    bands: [4.5, 2.5, 0.5, -0.5, -1.2, 0.2, -3.5, -7.2, -4.5, 1.5]
  }
];

class AutoEqManager {
  constructor() {
    this.profiles = [...POPULAR_HEADPHONES];
    this.activeProfile = null;
    this.bassBoostDb = 0; // 0 to 6 dB
  }

  /**
   * List all available headphone profiles
   */
  listProfiles() {
    return this.profiles;
  }

  /**
   * Search available headphone models
   */
  search(query = '') {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return this.profiles.slice(0, 20);
    return this.profiles.filter(p => 
      p.name.toLowerCase().includes(q) || 
      p.brand.toLowerCase().includes(q)
    );
  }

  /**
   * Get profile by id
   */
  getProfile(id) {
    return this.profiles.find(p => p.id === id) || null;
  }

  /**
   * Compute final 10-band gains with optional Bass Boost
   */
  computeBands(profileId, bassBoost = 0) {
    const profile = this.getProfile(profileId);
    if (!profile) return [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

    const boost = Math.max(0, Math.min(8, Number(bassBoost) || 0));
    // Apply bass boost primarily to sub-bass and bass (32Hz, 64Hz, 125Hz)
    return profile.bands.map((gain, idx) => {
      let add = 0;
      if (idx === 0) add = boost * 1.0;
      else if (idx === 1) add = boost * 0.8;
      else if (idx === 2) add = boost * 0.4;
      return Math.round((gain + add) * 10) / 10;
    });
  }

  /**
   * Apply profile to an audio engine instance
   */
  applyToAudioEngine(audioEngine, profileId, bassBoost = 0) {
    const profile = this.getProfile(profileId);
    if (!profile || !audioEngine) return false;

    this.activeProfile = profile;
    this.bassBoostDb = bassBoost;
    const computed = this.computeBands(profileId, bassBoost);

    if (typeof audioEngine.updateAudioSettings === 'function') {
      audioEngine.updateAudioSettings({
        eqBands: computed
      });
      return true;
    }

    return false;
  }
}

if (typeof module !== 'undefined') {
  module.exports = {
    EQ_FREQS,
    POPULAR_HEADPHONES,
    AutoEqManager
  };
} else {
  window.AutoEqManager = AutoEqManager;
}
