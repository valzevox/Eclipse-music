/**
 * EclipsePreloadManager — Spec-compliant resource-aware instant audio preload manager
 * Supports:
 * - Priority queue: HOVER > TRENDING_SEQUENTIAL
 * - Bounded concurrency: max 1 speculative request active at any time
 * - Debounced hover/focus triggers (~200ms)
 * - 256 KiB audio range warm-up
 * - Cancellation on view change, track selection, or higher priority task
 * - Offline / Data Saver guards
 * - Deduplication and LRU caching
 */

class EclipsePreloadManager {
  constructor(options = {}) {
    this.serverPort = options.serverPort || 38472;
    this.getServerToken = options.getServerToken || (() => '');
    this.isOffline = options.isOffline || (() => typeof navigator !== 'undefined' && navigator.onLine === false);
    this.isDataSaver = options.isDataSaver || (() => {
      if (typeof localStorage !== 'undefined' && localStorage.getItem('eclipse_perf_mode') === '1') return true;
      if (typeof navigator !== 'undefined' && navigator.connection && navigator.connection.saveData === true) return true;
      return false;
    });
    this.getIsPlaying = options.getIsPlaying || (() => false);
    this.getCurrentTrackId = options.getCurrentTrackId || (() => null);

    this.debounceMs = options.debounceMs || 200;
    this.maxCacheEntries = options.maxCacheEntries || 30;
    this.cacheTtlMs = options.cacheTtlMs || 30 * 60 * 1000; // 30 minutes
    this.rangeWarmUpBytes = options.rangeWarmUpBytes || 262144; // 256 KiB

    this.cache = new Map(); // key -> { resolvedId, streamUrl, proxyUrl, isWarm, timestamp }
    this.hoverTimers = new Map(); // trackKey -> timerId
    this.activeTask = null; // { type, trackKey, abortController, promise }
    this.trendingQueue = []; // Array of track objects
    this.isProcessingQueue = false;
  }

  getConfiguredQuality() {
    return (typeof localStorage !== 'undefined' && localStorage.getItem('eclipse_audio_quality')) || 'medium';
  }

  getTrackKey(track) {
    if (!track) return '';
    return String(track.id || track.videoId || track.url || `${track.artist}_${track.title}`).trim().toLowerCase();
  }

  getCacheKey(track, quality = null) {
    const base = this.getTrackKey(track);
    if (!base) return '';
    const platform = String((track && track.platform) || 'ytmusic').trim().toLowerCase();
    const q = String(quality || this.getConfiguredQuality()).trim().toLowerCase();
    return `${platform}:${base}:${q}`;
  }

  hasCached(track, quality = null) {
    const q = String(quality || this.getConfiguredQuality()).trim().toLowerCase();
    const key = this.getCacheKey(track, q);
    if (!key || !this.cache.has(key)) return false;
    const item = this.cache.get(key);
    if (Date.now() - item.timestamp > this.cacheTtlMs || item.quality !== q) {
      this.cache.delete(key);
      return false;
    }
    return true;
  }

  getCached(track, quality = null) {
    const q = String(quality || this.getConfiguredQuality()).trim().toLowerCase();
    const key = this.getCacheKey(track, q);
    if (!key) return null;
    const item = this.cache.get(key);
    if (!item) return null;
    if (Date.now() - item.timestamp > this.cacheTtlMs || item.quality !== q) {
      this.cache.delete(key);
      return null;
    }
    return item;
  }

  setCache(track, data, quality = null) {
    const q = String(quality || (data && data.quality) || this.getConfiguredQuality()).trim().toLowerCase();
    const key = this.getCacheKey(track, q);
    if (!key) return;
    if (this.cache.size >= this.maxCacheEntries) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }
    this.cache.set(key, {
      ...data,
      quality: q,
      platform: String((track && track.platform) || 'ytmusic').trim().toLowerCase(),
      timestamp: Date.now()
    });
  }

  cancelActive(reason = 'preempted') {
    if (this.activeTask && this.activeTask.abortController) {
      try {
        this.activeTask.abortController.abort(new Error(reason));
      } catch (_) {}
      this.activeTask = null;
    }
  }

  clearTrendingQueue() {
    this.trendingQueue = [];
    if (this.activeTask && this.activeTask.type === 'trending') {
      this.cancelActive('view_changed');
    }
  }

  queueTrendingSequential(tracks) {
    if (this.isOffline() || this.isDataSaver()) return;
    if (!Array.isArray(tracks) || tracks.length === 0) return;

    // Take at most first 3 trending tracks
    const candidates = tracks.slice(0, 3).filter(t => {
      const key = this.getTrackKey(t);
      if (!key) return false;
      if (this.hasCached(t)) return false;
      if (this.getCurrentTrackId() === key) return false;
      return true;
    });

    this.trendingQueue = candidates;
    this._processNextTrending();
  }

  async _processNextTrending() {
    if (this.isProcessingQueue) return;
    if (this.trendingQueue.length === 0) return;
    if (this.activeTask && this.activeTask.type === 'hover') return; // Hover has higher priority
    if (this.isOffline() || this.isDataSaver()) {
      this.trendingQueue = [];
      return;
    }

    this.isProcessingQueue = true;
    const track = this.trendingQueue.shift();
    if (!track) {
      this.isProcessingQueue = false;
      return;
    }

    try {
      await this._executePreload(track, 'trending');
    } catch (_) {
      // Failure should not break normal playback or next task
    } finally {
      this.isProcessingQueue = false;
      // Continue next trending task after a slight pause to yield CPU/network
      if (this.trendingQueue.length > 0 && (!this.activeTask || this.activeTask.type !== 'hover')) {
        setTimeout(() => this._processNextTrending(), 150);
      }
    }
  }

  onTrackHover(track) {
    if (!track || this.isOffline() || this.isDataSaver()) return;
    const key = this.getTrackKey(track);
    if (!key || this.hasCached(track) || this.getCurrentTrackId() === key) return;

    if (this.hoverTimers.has(key)) {
      clearTimeout(this.hoverTimers.get(key));
    }

    const timer = setTimeout(() => {
      this.hoverTimers.delete(key);
      this._triggerHoverPreload(track);
    }, this.debounceMs);

    this.hoverTimers.set(key, timer);
  }

  onTrackLeave(track) {
    const key = this.getTrackKey(track);
    if (!key) return;
    if (this.hoverTimers.has(key)) {
      clearTimeout(this.hoverTimers.get(key));
      this.hoverTimers.delete(key);
    }
  }

  async _triggerHoverPreload(track) {
    if (this.isOffline() || this.isDataSaver()) return;
    const key = this.getTrackKey(track);
    if (!key || this.hasCached(track)) return;

    // Hover preempts any active speculative trending task
    if (this.activeTask && this.activeTask.type === 'trending') {
      this.cancelActive('hover_preempted');
    }

    try {
      await this._executePreload(track, 'hover');
    } catch (_) {}
  }

  async _executePreload(track, type) {
    const curQuality = this.getConfiguredQuality();
    const key = this.getTrackKey(track);
    if (!key || this.hasCached(track, curQuality)) return;

    const controller = new AbortController();
    this.activeTask = {
      type,
      trackKey: key,
      abortController: controller
    };

    try {
      // 1. Resolve stream URL
      const streamData = await this._resolveStreamInfo(track, controller.signal, curQuality);
      if (!streamData || !streamData.streamUrl || controller.signal.aborted) return;

      // 2. Audio range warm-up (first 256 KiB)
      const targetWarmUrl = streamData.proxyUrl || streamData.streamUrl;
      await this._warmUpRange(targetWarmUrl, controller.signal);
      if (controller.signal.aborted) return;

      // 3. Mark in cache
      this.setCache(track, {
        resolvedId: streamData.resolvedId || track.id,
        streamUrl: streamData.streamUrl,
        proxyUrl: streamData.proxyUrl,
        quality: curQuality,
        isWarm: true
      }, curQuality);
    } finally {
      if (this.activeTask && this.activeTask.trackKey === key) {
        this.activeTask = null;
      }
    }
  }

  async _resolveStreamInfo(track, signal, qualityOverride = null) {
    const cleanId = String(track.id || track.videoId || '').trim();
    const isRealYtId = /^[a-zA-Z0-9_-]{11}$/.test(cleanId) && !/^(cand_|dz_|it_|sp_|ym_|alb_|local_|track_)/i.test(cleanId);
    let resolvedUrl = track.url || '';
    if (!resolvedUrl && isRealYtId) {
      resolvedUrl = `https://www.youtube.com/watch?v=${cleanId}`;
    }

    const curQuality = qualityOverride || this.getConfiguredQuality();
    const qFallback = ((track.artist ? track.artist + ' - ' : '') + (track.title || '')).trim();
    const token = this.getServerToken();

    const fetchUrl = `http://127.0.0.1:${this.serverPort}/api/stream-info?id=${encodeURIComponent(cleanId)}&url=${encodeURIComponent(resolvedUrl)}&platform=${encodeURIComponent(track.platform || 'ytmusic')}&title=${encodeURIComponent(track.title || '')}&artist=${encodeURIComponent(track.artist || '')}&duration=${encodeURIComponent(track.duration || 0)}&q=${encodeURIComponent(qFallback)}&quality=${encodeURIComponent(curQuality)}&prefetch=1&token=${encodeURIComponent(token)}`;

    const res = await fetch(fetchUrl, { signal });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !data.success || !data.streamUrl) return null;
    return data;
  }

  _getAdaptiveWarmUpBytes() {
    if (typeof navigator !== 'undefined' && navigator.connection) {
      const conn = navigator.connection;
      if (conn.saveData || conn.effectiveType === 'slow-2g' || conn.effectiveType === '2g' || conn.effectiveType === '3g' || (Number.isFinite(conn.downlink) && conn.downlink > 0 && conn.downlink < 5)) {
        return 65536; // 64 KiB on constrained Wi-Fi
      }
    }
    return this.rangeWarmUpBytes || 262144;
  }

  async _warmUpRange(url, signal) {
    if (!url || typeof url !== 'string' || url.includes('.m3u8')) return false;
    const state = (globalThis.__eclipseWarmedState = globalThis.__eclipseWarmedState || {
      inflight: new Map(),
      verified: new Map()
    });
    const prev = state.verified.get(url);
    if (prev && Date.now() - prev.ts < this.cacheTtlMs) return true;
    if (state.inflight.has(url)) {
      return state.inflight.get(url);
    }

    const warmBytes = this._getAdaptiveWarmUpBytes();
    const endByte = warmBytes - 1;
    const p = (async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (signal && signal.aborted) return false;
        try {
          const res = await fetch(url, {
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
          const declaredSpan = crMatch ? (Number(crMatch[1]) + 1) : 0;
          if (!crMatch || declaredSpan <= 0 || declaredSpan > warmBytes) {
            if (res.body && typeof res.body.cancel === 'function') {
              res.body.cancel().catch(() => {});
            }
            return false;
          }
          if (!res.body || typeof res.body.getReader !== 'function') {
            if (res.body && typeof res.body.cancel === 'function') {
              res.body.cancel().catch(() => {});
            }
            return false;
          }
          let totalRead = 0;
          const reader = res.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              totalRead += value.byteLength;
              if (totalRead > warmBytes || totalRead > declaredSpan) {
                await reader.cancel().catch(() => {});
                return false;
              }
            }
          }
          if (totalRead === 0 || totalRead !== declaredSpan) continue;
          state.verified.set(url, { ts: Date.now(), bytes: totalRead });
          if (state.verified.size > 64) state.verified.delete(state.verified.keys().next().value);
          return true;
        } catch (err) {
          if (err && err.name === 'AbortError') return false;
        }
      }
      return false;
    })().finally(() => {
      state.inflight.delete(url);
    });

    state.inflight.set(url, p);
    return p;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { EclipsePreloadManager };
}
if (typeof window !== 'undefined') {
  window.EclipsePreloadManager = EclipsePreloadManager;
}
