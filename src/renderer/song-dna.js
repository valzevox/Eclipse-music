/**
 * Song DNA Controller & Bottom Sheet (EchoMusic v1.4.7 Parity)
 * Combines Artist Bio, Credits (Writers/Producers/Label), and Audio Spec
 */
class SongDnaManager {
  constructor(options = {}) {
    this.apiBase = options.apiBase || 'http://127.0.0.1:3000';
    this.token = options.token || '';
    this.cache = new Map();
  }

  async fetchSongDna(track) {
    if (!track) return null;
    const cacheKey = `${track.id || ''}:${track.title || ''}:${track.artist || ''}`;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    const dna = {
      title: track.title || 'Unknown Title',
      artist: track.artist || 'Unknown Artist',
      id: track.id || '',
      format: track.format || (track.isLossless ? 'FLAC Lossless' : 'Opus / AAC High'),
      bitrate: track.bitrate || (track.isLossless ? '1411 kbps' : '256 kbps'),
      sampleRate: track.sampleRate || '44.1 kHz / 16-bit',
      source: track.source || (track.platform || 'YouTube Music'),
      bio: '',
      credits: {
        performers: [track.artist || 'Unknown Artist'],
        writers: [],
        producers: [],
        label: ''
      }
    };

    try {
      const q = encodeURIComponent(`${track.artist || ''} - ${track.title || ''}`);
      const res = await fetch(`${this.apiBase}/api/ytm/song-info?id=${encodeURIComponent(track.id || '')}&q=${q}`, {
        headers: { 'X-Eclipse-Token': this.token, 'X-Muriel-Token': this.token }
      }).catch(() => null);

      if (res && res.ok) {
        const data = await res.json().catch(() => null);
        if (data && data.success) {
          if (data.bio) dna.bio = data.bio;
          if (data.credits) {
            Object.assign(dna.credits, data.credits);
          }
        }
      }
    } catch (_) {}

    // Fallback bio from title/artist pattern
    if (!dna.bio) {
      dna.bio = `${dna.artist} is featured on this official recording of "${dna.title}". Streamed with low-latency WebAudio engine.`;
    }

    this.cache.set(cacheKey, dna);
    return dna;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SongDnaManager };
} else {
  window.SongDnaManager = SongDnaManager;
}
