// src/renderer/automix/preload-manager.js
// JavaScript / preload-manager.js / Web / Eclipse PC & Mobile
// Queue-aware track preloader: resolves stream URLs, warms audio buffers, and pre-fetches SponsorBlock segments

class PreloadManager {
  constructor(options = {}) {
    this.apiBase = options.apiBase || 'http://127.0.0.1:38472';
    this.token = options.token || '';
    this.currentPreloadTrackId = null;
    this.abortController = null;
    this.preloadedStreams = new Map(); // trackId -> { url, expires, readyState, timestamp }
  }

  setCredentials(apiBase, token) {
    if (apiBase) this.apiBase = apiBase;
    if (token) this.token = token;
  }

  cancelPreload(reason = 'queue_changed') {
    if (this.abortController) {
      try { this.abortController.abort(reason); } catch (_) {}
      this.abortController = null;
    }
    this.currentPreloadTrackId = null;
  }

  async resolveStreamUrl(track, quality = 'medium') {
    if (!track) return '';
    const trackId = track.id || track.videoId || '';
    if (track._preloadedStreamUrl) return track._preloadedStreamUrl;

    if (this.preloadedStreams.has(trackId)) {
      const cached = this.preloadedStreams.get(trackId);
      if (cached && cached.url && (!cached.expires || Date.now() < cached.expires)) {
        track._preloadedStreamUrl = cached.url;
        return cached.url;
      }
    }

    const qFallback = encodeURIComponent(track.searchQuery || ((track.artist ? track.artist + ' - ' : '') + (track.title || '')));
    const tkn = this.token || (typeof window !== 'undefined' && window.electronAPI?.serverToken) || '';
    const url = `${this.apiBase}/api/stream-info?id=${encodeURIComponent(trackId)}&url=${encodeURIComponent(track.url || '')}&platform=${encodeURIComponent(track.platform || 'ytmusic')}&title=${encodeURIComponent(track.title || '')}&artist=${encodeURIComponent(track.artist || '')}&duration=${encodeURIComponent(track.duration || 0)}&q=${qFallback}&quality=${encodeURIComponent(quality)}&token=${encodeURIComponent(tkn)}&t=${encodeURIComponent(tkn)}`;

    try {
      const res = await fetch(url, {
        headers: { 'X-Eclipse-Token': tkn, 'X-Muriel-Token': tkn },
        signal: this.abortController ? this.abortController.signal : undefined
      });
      const data = await res.json();
      if (data && data.success && (data.proxyUrl || data.streamUrl)) {
        const streamUrl = data.proxyUrl || data.streamUrl;
        track._preloadedStreamUrl = streamUrl;
        this.preloadedStreams.set(trackId, {
          url: streamUrl,
          expires: Date.now() + 3600 * 1000,
          timestamp: Date.now()
        });
        // Warm up buffer with initial range
        this.warmUpBuffer(streamUrl);
        return streamUrl;
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.warn('[PreloadManager] resolveStreamUrl failed:', err.message);
      }
    }
    return '';
  }

  warmUpBuffer(streamUrl) {
    if (!streamUrl || typeof streamUrl !== 'string' || streamUrl.includes('.m3u8')) return;
    try {
      fetch(streamUrl, {
        headers: { 'Range': 'bytes=0-262143' },
        signal: this.abortController ? this.abortController.signal : undefined
      }).catch(() => {});
    } catch (_) {}
  }

  async fetchSponsorSegments(track) {
    if (!track || Array.isArray(track.sponsorSegments)) return track?.sponsorSegments || [];
    const vid = track.id || track.videoId || '';
    if (typeof vid !== 'string' || vid.length !== 11) return [];

    try {
      const tkn = this.token || '';
      const res = await fetch(`${this.apiBase}/api/sponsorblock?videoId=${encodeURIComponent(vid)}&token=${encodeURIComponent(tkn)}`, {
        signal: this.abortController ? this.abortController.signal : undefined
      });
      const data = await res.json();
      if (data && data.success && Array.isArray(data.segments)) {
        track.sponsorSegments = data.segments;
        return data.segments;
      }
    } catch (_) {}
    return [];
  }

  async prepareNextTrack(nextTrack, auxAudioElement, quality = 'medium') {
    if (!nextTrack) return { ready: false, streamUrl: '' };
    this.cancelPreload('new_track');
    this.abortController = new AbortController();
    const trackId = nextTrack.id || nextTrack.videoId;
    this.currentPreloadTrackId = trackId;

    const [streamUrl] = await Promise.all([
      this.resolveStreamUrl(nextTrack, quality),
      this.fetchSponsorSegments(nextTrack)
    ]);

    if (!streamUrl || this.currentPreloadTrackId !== trackId) {
      return { ready: false, streamUrl: '' };
    }

    if (auxAudioElement) {
      if (auxAudioElement.src !== streamUrl) {
        auxAudioElement.preload = 'auto';
        auxAudioElement.src = streamUrl;
      }
      const isReady = await this.waitForElementReadiness(auxAudioElement, 2, 2000);
      return { ready: isReady, streamUrl };
    }

    return { ready: true, streamUrl };
  }

  waitForElementReadiness(audioEl, minReadyState = 2, timeoutMs = 1500) {
    if (!audioEl) return Promise.resolve(false);
    if (audioEl.readyState >= minReadyState) return Promise.resolve(true);

    return new Promise(resolve => {
      let settled = false;
      const onReady = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(true);
      };
      const onError = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(false);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(audioEl.readyState >= minReadyState);
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        audioEl.removeEventListener('canplay', onReady);
        audioEl.removeEventListener('loadeddata', onReady);
        audioEl.removeEventListener('error', onError);
      };

      audioEl.addEventListener('canplay', onReady);
      audioEl.addEventListener('loadeddata', onReady);
      audioEl.addEventListener('error', onError);
    });
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PreloadManager };
}
if (typeof window !== 'undefined') {
  window.PreloadManager = PreloadManager;
}
