// JavaScript / auto-eq.js / AutoEQ Database & Headphone Equalizer Engine
// Part of Eclipse Music Player — MIT License

const EQ_FREQS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

// Curated profiles for 42 popular studio & consumer headphones & IEMs based on Harman target curves
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
    id: 'sony-wf1000xm5',
    name: 'Sony WF-1000XM5',
    brand: 'Sony',
    type: 'in-ear',
    preamp: -3.9,
    bands: [-1.5, -2.1, -0.6, 0.9, 1.6, 0.8, -1.0, 2.3, 1.2, -1.4]
  },
  {
    id: 'sony-mdr7506',
    name: 'Sony MDR-7506',
    brand: 'Sony',
    type: 'over-ear',
    preamp: -5.5,
    bands: [4.2, 1.8, -1.2, -0.8, 0.4, -1.5, -3.8, -4.5, 1.2, 0.5]
  },
  {
    id: 'sony-ier-m9',
    name: 'Sony IER-M9',
    brand: 'Sony',
    type: 'in-ear',
    preamp: -3.2,
    bands: [0.8, 0.4, -0.6, -1.1, 0.3, 1.4, 2.2, 1.8, -0.9, 0.6]
  },
  {
    id: 'apple-airpods-pro-2',
    name: 'AirPods Pro 2',
    brand: 'Apple',
    type: 'in-ear',
    preamp: -3.0,
    bands: [0.5, 1.2, 0.8, -0.5, -1.0, 1.5, 2.8, -1.5, 2.0, -0.8]
  },
  {
    id: 'apple-airpods-pro-1',
    name: 'AirPods Pro (1st Gen)',
    brand: 'Apple',
    type: 'in-ear',
    preamp: -3.6,
    bands: [1.8, 1.5, 0.4, -0.9, -1.2, 1.0, 2.4, -1.8, 1.5, -1.0]
  },
  {
    id: 'apple-airpods-max',
    name: 'AirPods Max',
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
    id: 'sennheiser-hd800s',
    name: 'Sennheiser HD 800 S',
    brand: 'Sennheiser',
    type: 'over-ear',
    preamp: -6.2,
    bands: [5.8, 4.2, 1.8, 0.4, 0.9, 1.6, 2.1, -1.2, -4.8, -1.5]
  },
  {
    id: 'sennheiser-momentum-4',
    name: 'Sennheiser Momentum 4 Wireless',
    brand: 'Sennheiser',
    type: 'over-ear',
    preamp: -4.6,
    bands: [-4.2, -3.5, -1.8, 0.4, 1.2, 1.8, -1.2, 1.5, -0.8, -1.4]
  },
  {
    id: 'sennheiser-ie200',
    name: 'Sennheiser IE 200',
    brand: 'Sennheiser',
    type: 'in-ear',
    preamp: -3.8,
    bands: [0.6, 0.2, -0.8, -0.5, 0.7, 1.8, 1.2, -1.6, -2.4, 0.8]
  },
  {
    id: 'sennheiser-ie600',
    name: 'Sennheiser IE 600',
    brand: 'Sennheiser',
    type: 'in-ear',
    preamp: -4.2,
    bands: [-1.4, -1.2, -0.4, 0.5, 1.1, 0.8, -0.9, -2.8, -3.5, 0.4]
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
    id: 'audio-technica-ath-m40x',
    name: 'Audio-Technica ATH-M40x',
    brand: 'Audio-Technica',
    type: 'over-ear',
    preamp: -4.7,
    bands: [1.5, -2.4, -2.8, 0.4, 1.6, 0.8, -2.2, 1.4, -2.0, 0.8]
  },
  {
    id: 'audio-technica-ath-r70x',
    name: 'Audio-Technica ATH-R70x',
    brand: 'Audio-Technica',
    type: 'over-ear',
    preamp: -5.4,
    bands: [5.2, 3.6, 1.2, -0.6, -1.0, 0.4, 1.8, 1.2, -0.5, -1.2]
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
    id: 'bose-qc-ultra',
    name: 'Bose QuietComfort Ultra',
    brand: 'Bose',
    type: 'over-ear',
    preamp: -4.4,
    bands: [-2.8, -3.2, -1.6, 0.2, 1.1, 1.4, -2.0, 1.6, -1.2, -1.8]
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
    id: 'samsung-galaxy-buds-fe',
    name: 'Samsung Galaxy Buds FE',
    brand: 'Samsung',
    type: 'in-ear',
    preamp: -3.5,
    bands: [-1.2, -1.6, -0.4, 0.6, 1.0, 0.4, -1.2, 1.8, 0.8, -1.1]
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
    id: 'moondrop-blessing-3',
    name: 'Moondrop Blessing 3',
    brand: 'Moondrop',
    type: 'in-ear',
    preamp: -3.6,
    bands: [2.4, 1.8, 0.5, -0.6, -0.4, 0.2, -1.8, -1.2, 0.8, -0.6]
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
    id: '7hz-timeless',
    name: '7Hz Timeless Planar',
    brand: '7Hz',
    type: 'in-ear',
    preamp: -4.2,
    bands: [-1.2, -1.8, -1.0, 0.4, 1.2, 1.6, -2.6, 0.8, -3.2, 1.0]
  },
  {
    id: 'truthear-hexa',
    name: 'Truthear HEXA',
    brand: 'Truthear',
    type: 'in-ear',
    preamp: -3.4,
    bands: [2.0, 1.4, 0.2, -0.6, -0.2, 0.6, -0.8, -1.4, 0.6, -0.8]
  },
  {
    id: 'truthear-zero-red',
    name: 'Truthear x Crinacle ZERO:RED',
    brand: 'Truthear',
    type: 'in-ear',
    preamp: -3.1,
    bands: [1.2, 0.8, 0.0, -0.4, 0.2, 0.8, -1.0, 0.6, 0.4, -0.6]
  },
  {
    id: 'simgot-ew200',
    name: 'SIMGOT EW200 / EM6L',
    brand: 'SIMGOT',
    type: 'in-ear',
    preamp: -3.8,
    bands: [0.6, 0.0, -0.8, -0.4, 0.6, 0.4, -2.4, -1.8, 0.5, -1.0]
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
  },
  {
    id: 'beyerdynamic-dt1990-pro',
    name: 'Beyerdynamic DT 1990 Pro',
    brand: 'Beyerdynamic',
    type: 'over-ear',
    preamp: -5.8,
    bands: [3.2, 1.8, 0.4, -0.6, -0.2, 0.8, -1.5, -6.4, -2.8, 0.8]
  },
  {
    id: 'akg-k371',
    name: 'AKG K371',
    brand: 'AKG',
    type: 'over-ear',
    preamp: -2.8,
    bands: [-0.8, -0.4, 0.4, 0.6, -0.2, 0.5, 1.2, -1.4, 0.8, -0.6]
  },
  {
    id: 'akg-k702',
    name: 'AKG K702',
    brand: 'AKG',
    type: 'over-ear',
    preamp: -6.4,
    bands: [6.4, 4.8, 2.2, 0.4, -0.8, 1.2, -2.8, 1.6, -1.2, -0.8]
  },
  {
    id: 'hifiman-sundara',
    name: 'HIFIMAN Sundara',
    brand: 'HIFIMAN',
    type: 'over-ear',
    preamp: -5.5,
    bands: [5.4, 3.8, 1.5, 0.2, 0.8, 1.6, -0.8, -1.6, -2.0, 0.5]
  },
  {
    id: 'hifiman-edition-xs',
    name: 'HIFIMAN Edition XS',
    brand: 'HIFIMAN',
    type: 'over-ear',
    preamp: -5.2,
    bands: [4.2, 2.8, 1.0, 0.0, 0.6, 2.4, -1.2, -2.2, -1.8, 0.6]
  },
  {
    id: 'shure-se215',
    name: 'Shure SE215',
    brand: 'Shure',
    type: 'in-ear',
    preamp: -5.0,
    bands: [-0.8, -1.8, -2.4, -1.2, 0.6, 1.8, 3.8, 4.6, 2.4, 1.2]
  },
  {
    id: 'nothing-ear-2',
    name: 'Nothing Ear (2) / Ear',
    brand: 'Nothing',
    type: 'in-ear',
    preamp: -3.6,
    bands: [-1.0, -1.4, -0.2, 0.6, 0.8, 0.4, -1.6, 2.2, -1.4, 0.6]
  },
  {
    id: 'anker-soundcore-q45',
    name: 'Soundcore Space Q45',
    brand: 'Anker',
    type: 'over-ear',
    preamp: -4.8,
    bands: [-3.4, -4.0, -1.2, 1.4, 2.0, -1.2, -3.0, 2.4, -1.6, 0.8]
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
   * Instant search/filter across headphone profiles by model name, brand, id, or type
   */
  searchProfiles(query = '') {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [...this.profiles];
    return this.profiles.filter(p =>
      p.name.toLowerCase().includes(q) ||
      p.brand.toLowerCase().includes(q) ||
      p.id.toLowerCase().includes(q) ||
      (p.type && p.type.toLowerCase().includes(q))
    );
  }

  /**
   * Alias for searchProfiles
   */
  search(query = '') {
    return this.searchProfiles(query);
  }

  /**
   * Get profile by id or return valid profile object
   */
  getProfile(idOrProfile) {
    if (!idOrProfile) return null;
    if (typeof idOrProfile === 'object' && Array.isArray(idOrProfile.bands)) {
      return idOrProfile;
    }
    return this.profiles.find(p => p.id === idOrProfile) || null;
  }

  /**
   * Compute final 10-band gains with optional Bass Boost
   */
  computeBands(profileIdOrObj, bassBoost = 0) {
    const profile = this.getProfile(profileIdOrObj);
    if (!profile || !Array.isArray(profile.bands)) return [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

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
  applyToAudioEngine(audioEngine, profileIdOrObj, bassBoost = 0) {
    const profile = this.getProfile(profileIdOrObj);
    if (!profile || !audioEngine) return false;

    this.activeProfile = profile;
    this.bassBoostDb = bassBoost;
    const computed = this.computeBands(profile, bassBoost);

    let applied = false;
    if (typeof audioEngine.setEqBands === 'function') {
      audioEngine.setEqBands(computed);
      applied = true;
    }
    if (typeof audioEngine.setAudioSettings === 'function') {
      audioEngine.setAudioSettings({
        eqBands: computed
      });
      applied = true;
    } else if (typeof audioEngine.updateAudioSettings === 'function') {
      audioEngine.updateAudioSettings({
        eqBands: computed
      });
      applied = true;
    }

    return applied;
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
