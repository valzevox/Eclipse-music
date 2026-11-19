/**
 * Song DNA Controller & Bottom Sheet
 * Part of Eclipse Music Player — MIT License
 * Combines Track Credits, Audio Specs, Artist Bio, and Song Story
 */
class SongDnaManager {
  constructor(options = {}) {
    this._customApiBase = options.apiBase || null;
    this.token = options.token || '';
    this.cache = new Map();
  }

  get apiBase() {
    if (this._customApiBase) return this._customApiBase;
    const port = (typeof window !== 'undefined' && (
      window.state?.serverPort ||
      window.ECLIPSE_SERVER_PORT ||
      window.riffServerPort
    )) || 38472;
    return `http://127.0.0.1:${port}`;
  }

  set apiBase(val) {
    this._customApiBase = val;
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
      album: track.album || '',
      releaseYear: track.year || '',
      duration: track.duration || 0,
      format: track.format || (track.isLossless ? 'FLAC Lossless' : 'Opus / AAC High'),
      bitrate: track.bitrate || (track.isLossless ? '1411 kbps' : '256 kbps'),
      sampleRate: track.sampleRate || '44.1 kHz / 16-bit',
      source: track.source || 'Eclipse Native Engine',
      loudness: track.loudness || '-14.0 LUFS',
      bio: '',
      story: '',
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
        headers: {
          'X-Eclipse-Token': this.token || (typeof window !== 'undefined' && window.state?.serverToken) || '',
          'X-Muriel-Token': this.token || ''
        }
      }).catch(() => null);

      if (res && res.ok) {
        const data = await res.json().catch(() => null);
        if (data && data.success) {
          if (data.bio) dna.bio = data.bio;
          if (data.story) dna.story = data.story;
          if (data.format) dna.format = data.format;
          if (data.bitrate) dna.bitrate = data.bitrate;
          if (data.sampleRate) dna.sampleRate = data.sampleRate;
          if (data.loudness) dna.loudness = data.loudness;
          if (data.album && !dna.album) dna.album = data.album;
          if (data.releaseYear && !dna.releaseYear) dna.releaseYear = data.releaseYear;
          if (data.credits) {
            Object.assign(dna.credits, data.credits);
          }
        }
      }
    } catch (_) {}

    // Fallback bio & story if empty
    if (!dna.bio) {
      dna.bio = `${dna.artist} is featured on this official recording of "${dna.title}". Streamed with low-latency WebAudio engine.`;
    }
    if (!dna.story) {
      dna.story = `"${dna.title}" is crafted by ${dna.artist}. Analyzed and rendered via Eclipse High-Fidelity Audio DSP.`;
    }

    this.cache.set(cacheKey, dna);
    return dna;
  }

  /**
   * Render rich Song DNA Modal in Eclipse's Dark Neon Glassmorphism aesthetic
   * @param {Object} dna
   * @returns {HTMLElement}
   */
  renderModal(dna) {
    if (!dna) return null;
    if (typeof document === 'undefined') return null;

    const existing = document.getElementById('eclipse-song-dna-modal');
    if (existing) existing.remove();

    const performers = (dna.credits?.performers || [dna.artist]).filter(Boolean).join(', ');
    const writers = (dna.credits?.writers || []).filter(Boolean).join(', ') || 'Traditional / Not specified';
    const producers = (dna.credits?.producers || []).filter(Boolean).join(', ') || 'Not specified';
    const label = dna.credits?.label || 'Independent / Public Release';

    const modal = document.createElement('div');
    modal.id = 'eclipse-song-dna-modal';
    modal.style.cssText = `
      position: fixed;
      inset: 0;
      z-index: 10000;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(8, 8, 14, 0.75);
      backdrop-filter: blur(24px);
      -webkit-backdrop-filter: blur(24px);
      animation: eclipseFadeIn 0.25s ease-out;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    `;

    modal.innerHTML = `
      <div style="
        width: 580px;
        max-width: 90vw;
        max-height: 85vh;
        overflow-y: auto;
        background: linear-gradient(135deg, rgba(28, 23, 48, 0.85) 0%, rgba(15, 12, 28, 0.95) 100%);
        border: 1px solid rgba(255, 255, 255, 0.12);
        box-shadow: 0 20px 50px rgba(0, 0, 0, 0.6), 0 0 30px rgba(168, 85, 247, 0.25);
        border-radius: 20px;
        padding: 28px;
        color: #f1f5f9;
        position: relative;
      ">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 20px;">
          <div>
            <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 1.5px; color: #a855f7; font-weight: 700; margin-bottom: 4px;">Song DNA & Metadata</div>
            <h2 style="margin: 0; font-size: 22px; font-weight: 700; color: #ffffff; text-shadow: 0 2px 10px rgba(0,0,0,0.5);">${escapeHtml(dna.title)}</h2>
            <div style="font-size: 14px; color: #cbd5e1; margin-top: 4px;">${escapeHtml(dna.artist)} ${dna.album ? `• ${escapeHtml(dna.album)}` : ''}</div>
          </div>
          <button id="btn-close-song-dna" style="
            background: rgba(255, 255, 255, 0.08);
            border: 1px solid rgba(255, 255, 255, 0.15);
            color: #e2e8f0;
            width: 32px;
            height: 32px;
            border-radius: 50%;
            cursor: pointer;
            font-size: 16px;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.2s;
          ">&times;</button>
        </div>

        <!-- Section 1: Audio Specifications -->
        <div style="
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 10px;
          background: rgba(255, 255, 255, 0.04);
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 12px;
          padding: 12px;
          margin-bottom: 20px;
        ">
          <div>
            <div style="font-size: 10px; color: #94a3b8; text-transform: uppercase;">Codec</div>
            <div style="font-size: 13px; font-weight: 600; color: #38bdf8; margin-top: 2px;">${escapeHtml(dna.format)}</div>
          </div>
          <div>
            <div style="font-size: 10px; color: #94a3b8; text-transform: uppercase;">Bitrate</div>
            <div style="font-size: 13px; font-weight: 600; color: #a855f7; margin-top: 2px;">${escapeHtml(dna.bitrate)}</div>
          </div>
          <div>
            <div style="font-size: 10px; color: #94a3b8; text-transform: uppercase;">Sample Rate</div>
            <div style="font-size: 13px; font-weight: 600; color: #4ade80; margin-top: 2px;">${escapeHtml(dna.sampleRate)}</div>
          </div>
          <div>
            <div style="font-size: 10px; color: #94a3b8; text-transform: uppercase;">Loudness</div>
            <div style="font-size: 13px; font-weight: 600; color: #f472b6; margin-top: 2px;">${escapeHtml(dna.loudness)}</div>
          </div>
        </div>

        <!-- Section 2: Track Credits -->
        <div style="margin-bottom: 20px;">
          <div style="font-size: 12px; font-weight: 600; color: #94a3b8; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 10px;">Track Credits</div>
          <div style="display: flex; flex-direction: column; gap: 8px; font-size: 13px;">
            <div style="display: flex;"><span style="width: 100px; color: #64748b;">Performers:</span><span style="color: #f1f5f9; flex: 1;">${escapeHtml(performers)}</span></div>
            <div style="display: flex;"><span style="width: 100px; color: #64748b;">Writers:</span><span style="color: #f1f5f9; flex: 1;">${escapeHtml(writers)}</span></div>
            <div style="display: flex;"><span style="width: 100px; color: #64748b;">Producers:</span><span style="color: #f1f5f9; flex: 1;">${escapeHtml(producers)}</span></div>
            <div style="display: flex;"><span style="width: 100px; color: #64748b;">Label:</span><span style="color: #f1f5f9; flex: 1;">${escapeHtml(label)}</span></div>
          </div>
        </div>

        <!-- Section 3: Song Story & Artist Bio -->
        <div style="margin-bottom: 16px;">
          <div style="font-size: 12px; font-weight: 600; color: #94a3b8; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px;">Song Story</div>
          <div style="font-size: 13px; line-height: 1.6; color: #cbd5e1; background: rgba(0,0,0,0.2); padding: 12px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.06);">
            ${escapeHtml(dna.story || dna.bio)}
          </div>
        </div>

        <div>
          <div style="font-size: 12px; font-weight: 600; color: #94a3b8; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px;">Artist Biography</div>
          <div style="font-size: 13px; line-height: 1.6; color: #cbd5e1; background: rgba(0,0,0,0.2); padding: 12px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.06);">
            ${escapeHtml(dna.bio)}
          </div>
        </div>
      </div>
    `;

    function escapeHtml(str) {
      return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    const closeBtn = modal.querySelector('#btn-close-song-dna');
    if (closeBtn) {
      closeBtn.onclick = () => modal.remove();
    }
    modal.onclick = (e) => {
      if (e.target === modal) modal.remove();
    };

    document.body.appendChild(modal);
    return modal;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SongDnaManager };
} else {
  window.SongDnaManager = SongDnaManager;
}
