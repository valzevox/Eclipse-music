// src/renderer/automix/preload-manager.js
// JavaScript / preload-manager.js / Web / Eclipse PC & Mobile
// Queue-aware track preloader: resolves stream URLs, warms audio buffers, and pre-fetches SponsorBlock segments

class PreloadManager {
  constructor(options = {}) {
    this.apiBase = options.apiBase || 'http://127.0.0.1:38472';
    this.token = options.token || '';
    this.currentPreloadTrackId = null;
    this.abortController = null;
    this._generation = 0;
    this.preloadedStreams = new Map(); // `${platform}:${trackId}:${quality}` -> { url, quality, platform, trackId, expires, readyState, timestamp }
    this.preloadStages = new Map(); // trackId -> { stage, updatedAt, error }
  }

  getCacheKey(track, quality = 'medium') {
    if (!track) return '';
    const trackId = String(track.id || track.videoId || track.url || `${track.artist || ''}_${track.title || ''}`).trim().toLowerCase();
    const platform = String(track.platform || 'ytmusic').trim().toLowerCase();
    const q = String(quality || 'medium').trim().toLowerCase();
    return `${platform}:${trackId}:${q}`;
  }

  setPreloadStage(trackId, stage, error = null) {
    if (!trackId) return;
    this.preloadStages.set(trackId, { stage, updatedAt: Date.now(), error });
  }

  getPreloadStage(trackId) {
    if (!trackId) return { stage: 'idle', updatedAt: 0, error: null };
    return this.preloadStages.get(trackId) || { stage: 'idle', updatedAt: 0, error: null };
  }

  setCredentials(apiBase, token) {
    if (apiBase) this.apiBase = apiBase;
    if (token) this.token = token;
  }

  cancelPreload(reason = 'queue_changed') {
    this._generation += 1;
    if (this.abortController) {
      try { this.abortController.abort(reason); } catch (_) {}
      this.abortController = null;
    }
    this.currentPreloadTrackId = null;
  }

  async resolveStreamUrl(track, quality = 'medium') {
    if (!track) return '';
    const trackId = track.id || track.videoId || '';
    const platform = String(track.platform || 'ytmusic').trim().toLowerCase();
    const reqQuality = String(quality || 'medium').trim().toLowerCase();
    const cacheKey = this.getCacheKey(track, reqQuality);
    const myGen = this._generation;

    if (
      track._preloadedStreamUrl &&
      track._preloadedStreamQuality === reqQuality &&
      (!track._preloadedStreamPlatform || track._preloadedStreamPlatform === platform) &&
      (!track._preloadedStreamUrlExpires || Date.now() < track._preloadedStreamUrlExpires)
    ) {
      return track._preloadedStreamUrl;
    }

    if (cacheKey && this.preloadedStreams.has(cacheKey)) {
      const cached = this.preloadedStreams.get(cacheKey);
      if (cached && cached.url && cached.quality === reqQuality && (!cached.expires || Date.now() < cached.expires)) {
        track._preloadedStreamUrl = cached.url;
        track._preloadedStreamQuality = reqQuality;
        track._preloadedStreamPlatform = platform;
        track._preloadedStreamUrlExpires = cached.expires;
        return cached.url;
      }
      this.preloadedStreams.delete(cacheKey);
    }

    // Reuse shared EclipsePreloadManager cache to avoid duplicate stream-info & warm-up
    const sharedMgr = typeof globalThis !== 'undefined' ? globalThis.__eclipsePreloadManager : null;
    if (sharedMgr && typeof sharedMgr.getCached === 'function') {
      const shared = sharedMgr.getCached(track, reqQuality);
      const sharedUrl = shared && (shared.proxyUrl || shared.streamUrl);
      if (sharedUrl) {
        const expires = Date.now() + 3600 * 1000;
        track._preloadedStreamUrl = sharedUrl;
        track._preloadedStreamQuality = reqQuality;
        track._preloadedStreamPlatform = platform;
        track._preloadedStreamUrlExpires = expires;
        this.warmUpBuffer(sharedUrl);
        return sharedUrl;
      }
    }

    const qFallback = encodeURIComponent(track.searchQuery || ((track.artist ? track.artist + ' - ' : '') + (track.title || '')));
    const tkn = this.token || (typeof window !== 'undefined' && window.electronAPI?.serverToken) || '';
    const url = `${this.apiBase}/api/stream-info?id=${encodeURIComponent(trackId)}&url=${encodeURIComponent(track.url || '')}&platform=${encodeURIComponent(platform)}&title=${encodeURIComponent(track.title || '')}&artist=${encodeURIComponent(track.artist || '')}&duration=${encodeURIComponent(track.duration || 0)}&q=${qFallback}&quality=${encodeURIComponent(reqQuality)}&prefetch=1&token=${encodeURIComponent(tkn)}&t=${encodeURIComponent(tkn)}`;

    try {
      const signal = this.abortController ? this.abortController.signal : undefined;
      const res = await fetch(url, {
        headers: { 'X-Eclipse-Token': tkn, 'X-Muriel-Token': tkn },
        signal
      });
      const data = await res.json();
      if (myGen !== this._generation || (signal && signal.aborted)) return '';
      if (data && data.success && (data.proxyUrl || data.streamUrl)) {
        const streamUrl = data.proxyUrl || data.streamUrl;
        const expires = Date.now() + 3600 * 1000;
        track._preloadedStreamUrl = streamUrl;
        track._preloadedStreamQuality = reqQuality;
        track._preloadedStreamPlatform = platform;
        track._preloadedStreamUrlExpires = expires;
        if (cacheKey) {
          this.preloadedStreams.set(cacheKey, {
            url: streamUrl,
            quality: reqQuality,
            platform,
            trackId,
            expires,
            timestamp: Date.now()
          });
        }
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
    if (!streamUrl || typeof streamUrl !== 'string' || streamUrl.includes('.m3u8')) return Promise.resolve(false);
    const state = (globalThis.__eclipseWarmedState = globalThis.__eclipseWarmedState || {
      inflight: new Map(),
      verified: new Map()
    });
    const prev = state.verified.get(streamUrl);
    if (prev && Date.now() - prev.ts < 30 * 60 * 1000) return Promise.resolve(true);
    if (state.inflight.has(streamUrl)) return state.inflight.get(streamUrl);

    let warmBytes = 262144;
    if (typeof navigator !== 'undefined' && navigator.connection) {
      const conn = navigator.connection;
      if (conn.saveData || conn.effectiveType === 'slow-2g' || conn.effectiveType === '2g' || conn.effectiveType === '3g' || (Number.isFinite(conn.downlink) && conn.downlink > 0 && conn.downlink < 5)) {
        warmBytes = 65536;
      }
    }
    const signal = this.abortController ? this.abortController.signal : undefined;
    const endByte = warmBytes - 1;
    const p = (async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (signal && signal.aborted) return false;
        try {
          const res = await fetch(streamUrl, {
            headers: { 'Range': `bytes=0-${endByte}`, 'X-Eclipse-Prefetch': '1' },
            signal
          });
          if (!res || res.status !== 206) {
            if (res && res.body && typeof res.body.cancel === 'function') {
              res.body.cancel().catch(() => {});
            }
            if (res && (res.status === 403 || res.status === 410 || res.status === 200)) return false;
            continue;
          }
          const contentRange = res.headers && typeof res.headers.get === 'function' ? (res.headers.get('content-range') || '') : '';
          const crMatch = /^bytes\s+0-(\d+)\/(\d+|\*)$/i.exec(contentRange.trim());
          if (!crMatch || Number(crMatch[1]) > endByte) {
            if (res.body && typeof res.body.cancel === 'function') {
              res.body.cancel().catch(() => {});
            }
            return false;
          }
          let totalRead = 0;
          if (res.body && typeof res.body.getReader === 'function') {
            const reader = res.body.getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (value) {
                totalRead += value.byteLength;
                if (totalRead > warmBytes) {
                  await reader.cancel().catch(() => {});
                  return false;
                }
              }
            }
          } else {
            const buf = await res.arrayBuffer();
            totalRead = buf ? buf.byteLength : 0;
            if (totalRead > warmBytes) return false;
          }
          if (totalRead === 0) continue;
          state.verified.set(streamUrl, { ts: Date.now(), bytes: totalRead });
          if (state.verified.size > 64) state.verified.delete(state.verified.keys().next().value);
          return true;
        } catch (err) {
          if (err && err.name === 'AbortError') return false;
        }
      }
      return false;
    })().finally(() => {
      state.inflight.delete(streamUrl);
    });

    state.inflight.set(streamUrl, p);
    return p;
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
    if (!nextTrack) return { ready: false, stage: 'failed', streamUrl: '' };
    this.cancelPreload('new_track');
    this.abortController = new AbortController();
    const trackId = nextTrack.id || nextTrack.videoId;
    this.currentPreloadTrackId = trackId;
    this.setPreloadStage(trackId, 'requested');

    const [streamUrl] = await Promise.all([
      this.resolveStreamUrl(nextTrack, quality),
      this.fetchSponsorSegments(nextTrack)
    ]);

    if (!streamUrl || this.currentPreloadTrackId !== trackId) {
      this.setPreloadStage(trackId, 'failed', 'stream_resolve_failed');
      return { ready: false, stage: 'failed', streamUrl: '' };
    }
    this.setPreloadStage(trackId, 'url_resolved');

    if (auxAudioElement) {
      if (auxAudioElement.src !== streamUrl) {
        auxAudioElement.preload = 'auto';
        auxAudioElement.src = streamUrl;
      }
      this.setPreloadStage(trackId, 'source_attached');

      const hasMetadata = await this.waitForElementReadiness(auxAudioElement, 1, 1500);
      if (!hasMetadata || this.currentPreloadTrackId !== trackId) {
        this.setPreloadStage(trackId, 'failed', 'metadata_timeout');
        return { ready: false, stage: 'failed', streamUrl };
      }
      this.setPreloadStage(trackId, 'metadata_loaded');

      const isReady = await this.waitForElementReadiness(auxAudioElement, 2, 2000);
      if (!isReady || this.currentPreloadTrackId !== trackId) {
        this.setPreloadStage(trackId, 'failed', 'buffer_timeout');
        return { ready: false, stage: 'failed', streamUrl };
      }
      this.setPreloadStage(trackId, 'buffered');
      return { ready: true, stage: 'buffered', streamUrl };
    }

    this.setPreloadStage(trackId, 'buffered');
    return { ready: true, stage: 'buffered', streamUrl };
  }

  waitForElementReadiness(audioEl, minReadyState = 2, timeoutMs = 1500) {
    if (!audioEl) return Promise.resolve(false);
    if (audioEl.readyState >= minReadyState) return Promise.resolve(true);

    return new Promise(resolve => {
      let settled = false;
      const onReady = () => {
        if (settled) return;
        if (audioEl.readyState < minReadyState) return;
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
        audioEl.removeEventListener('loadedmetadata', onReady);
        audioEl.removeEventListener('error', onError);
      };

      audioEl.addEventListener('canplay', onReady);
      audioEl.addEventListener('loadeddata', onReady);
      if (minReadyState <= 1) {
        audioEl.addEventListener('loadedmetadata', onReady);
      }
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
