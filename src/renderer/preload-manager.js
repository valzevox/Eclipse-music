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

  getTrackKey(track) {
    if (!track) return '';
    return String(track.id || track.videoId || track.url || `${track.artist}_${track.title}`).trim().toLowerCase();
  }

  hasCached(track) {
    const key = this.getTrackKey(track);
    if (!key || !this.cache.has(key)) return false;
    const item = this.cache.get(key);
    if (Date.now() - item.timestamp > this.cacheTtlMs) {
      this.cache.delete(key);
      return false;
    }
    return true;
  }

  getCached(track) {
    const key = this.getTrackKey(track);
    if (!key) return null;
    const item = this.cache.get(key);
    if (!item) return null;
    if (Date.now() - item.timestamp > this.cacheTtlMs) {
      this.cache.delete(key);
      return null;
    }
    return item;
  }

  setCache(track, data) {
    const key = this.getTrackKey(track);
    if (!key) return;
    if (this.cache.size >= this.maxCacheEntries) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }
    this.cache.set(key, {
      ...data,
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
    const key = this.getTrackKey(track);
    if (!key || this.hasCached(track)) return;

    const controller = new AbortController();
    this.activeTask = {
      type,
      trackKey: key,
      abortController: controller
    };

    try {
      // 1. Resolve stream URL
      const streamData = await this._resolveStreamInfo(track, controller.signal);
      if (!streamData || !streamData.streamUrl) return;

      // 2. Audio range warm-up (first 256 KiB)
      const targetWarmUrl = streamData.proxyUrl || streamData.streamUrl;
      await this._warmUpRange(targetWarmUrl, controller.signal);

      // 3. Mark in cache
      this.setCache(track, {
        resolvedId: streamData.resolvedId || track.id,
        streamUrl: streamData.streamUrl,
        proxyUrl: streamData.proxyUrl,
        isWarm: true
      });
    } finally {
      if (this.activeTask && this.activeTask.trackKey === key) {
        this.activeTask = null;
      }
    }
  }

  async _resolveStreamInfo(track, signal) {
    const cleanId = String(track.id || track.videoId || '').trim();
    const isRealYtId = /^[a-zA-Z0-9_-]{11}$/.test(cleanId) && !/^(cand_|dz_|it_|sp_|ym_|alb_|local_|track_)/i.test(cleanId);
    let resolvedUrl = track.url || '';
    if (!resolvedUrl && isRealYtId) {
      resolvedUrl = `https://www.youtube.com/watch?v=${cleanId}`;
    }

    const curQuality = (typeof localStorage !== 'undefined' && localStorage.getItem('eclipse_audio_quality')) || 'medium';
    const qFallback = ((track.artist ? track.artist + ' - ' : '') + (track.title || '')).trim();
    const token = this.getServerToken();

    const fetchUrl = `http://127.0.0.1:${this.serverPort}/api/stream-info?id=${encodeURIComponent(cleanId)}&url=${encodeURIComponent(resolvedUrl)}&platform=${encodeURIComponent(track.platform || 'ytmusic')}&title=${encodeURIComponent(track.title || '')}&artist=${encodeURIComponent(track.artist || '')}&duration=${encodeURIComponent(track.duration || 0)}&q=${encodeURIComponent(qFallback)}&quality=${encodeURIComponent(curQuality)}&token=${encodeURIComponent(token)}`;

    const res = await fetch(fetchUrl, { signal });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !data.success || !data.streamUrl) return null;
    return data;
  }

  async _warmUpRange(url, signal) {
    if (!url || typeof url !== 'string' || url.includes('.m3u8')) return;
    try {
      // Warm up first 256 KiB
      const endByte = this.rangeWarmUpBytes - 1;
      await fetch(url, {
        headers: { 'Range': `bytes=0-${endByte}` },
        signal
      });
    } catch (_) {}
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { EclipsePreloadManager };
}
if (typeof window !== 'undefined') {
  window.EclipsePreloadManager = EclipsePreloadManager;
}
