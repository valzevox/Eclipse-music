// src/renderer/automix/source-resolver.js
// Pure, testable track source URL resolver and queue fingerprint generator for Smart AutoMix DJ.
(function (root) {
  'use strict';

  function extractSafeFilename(track) {
    const raw = track.downloadedName || track.filename || track.fileName || track.localPath || '';
    if (!raw || typeof raw !== 'string') return '';
    // Extract basename safely across POSIX and Windows separators without exposing directory paths
    const parts = raw.split(/[\\/]/);
    return parts[parts.length - 1] || '';
  }

  /**
   * Resolve a track object to its real, validated Eclipse server endpoint URL.
   *
   * Routing priority:
   * 1. PreloadManager cached URL (`track._preloadedStreamUrl`)
   * 2. Local Library index items (`/api/library` returns `{ id, platform: 'local' }` without `libraryFileId`) -> `/api/library-file?id=...`
   * 3. Downloaded tracks -> `/api/downloaded-track?name=<basename>` (never `?id=<track.id>`)
   * 4. Cached offline stream tracks (`/api/offline-library` returns `{ id, cleanId, ... }`) -> `/api/local-track?id=<cleanId|id>`
   * 5. Streaming tracks -> `/api/stream-info?id=...&platform=...` -> `proxyUrl`
   */
  async function resolveTrackSourceUrl(track, options = {}) {
    const { apiBase = '', token = '', signal = undefined, fetchImpl = (typeof fetch === 'function' ? fetch : null) } = options;
    if (!track || (signal && signal.aborted)) return null;

    const tokQ = token ? `&token=${encodeURIComponent(token)}` : '';

    // 1. Prefer already-resolved PreloadManager URL
    if (track._preloadedStreamUrl && typeof track._preloadedStreamUrl === 'string') {
      return track._preloadedStreamUrl;
    }

    if (!apiBase) return null;

    // 2. Local Library items (explicit libraryFileId OR /api/library shape: platform === 'local' with id)
    if (track.libraryFileId) {
      return `${apiBase}/api/library-file?id=${encodeURIComponent(track.libraryFileId)}${tokQ}`;
    }
    if ((track.platform === 'local' || track.source === 'local' || track.isLibrary) && track.id && !track.cleanId && !track.isCached) {
      return `${apiBase}/api/library-file?id=${encodeURIComponent(track.id)}${tokQ}`;
    }

    // 3. Downloaded tracks -> /api/downloaded-track?name=<filename>
    if (track.isDownloaded || track.downloadedName || track.filename || track.fileName) {
      const safeName = extractSafeFilename(track);
      if (safeName) {
        return `${apiBase}/api/downloaded-track?name=${encodeURIComponent(safeName)}${tokQ}`;
      }
    }

    // 4. Offline cached stream tracks (/api/offline-library shape) -> /api/local-track?id=<cleanId|id>
    if (track.cleanId || track.isCached || track.offline) {
      const cacheId = track.cleanId || track.id;
      if (cacheId) {
        return `${apiBase}/api/local-track?id=${encodeURIComponent(cacheId)}${tokQ}`;
      }
    }

    // 5. Streaming tracks (YouTube / YTM / SoundCloud / imported pseudo-IDs) -> /api/stream-info -> proxyUrl
    const trackId = track.id || track.videoId;
    if (trackId && fetchImpl) {
      const params = new URLSearchParams();
      params.set('id', String(trackId));
      params.set('platform', String(track.platform || track.source || 'youtube'));
      if (track.url) params.set('url', String(track.url));
      if (track.title) params.set('title', String(track.title));
      if (track.artist) params.set('artist', String(track.artist));
      if (typeof track.duration === 'number' && track.duration > 0) params.set('duration', String(track.duration));
      if (track.thumbnail) params.set('thumbnail', String(track.thumbnail));
      if (track.q) params.set('q', String(track.q));
      else if (track.title && track.artist) params.set('q', `${track.artist} - ${track.title}`);
      if (token) params.set('token', String(token));

      const infoUrl = `${apiBase}/api/stream-info?${params.toString()}`;
      const resp = await fetchImpl(infoUrl, { signal });
      if (!resp || !resp.ok || (signal && signal.aborted)) return null;
      const data = await resp.json();
      if (data && typeof data.proxyUrl === 'string' && data.proxyUrl) {
        return data.proxyUrl;
      }
      if (data && typeof data.streamUrl === 'string' && data.streamUrl && !/googlevideo\.com/i.test(data.streamUrl)) {
        return data.streamUrl;
      }
    }

    return null;
  }

  /**
   * Compute a stable ordered fingerprint of the active analysis lookahead window
   * starting at queueIndex (default 6 items matching AnalysisCoordinator maxTracks).
   * Works for arbitrarily long queues (> 32 tracks) and detects any replacement
   * within the active lookahead window even when length, first item, and queueIndex stay identical.
   */
  function computeQueueContextId(queue, queueIndex = 0, windowSize = 6) {
    if (!Array.isArray(queue) || queue.length === 0) return 'empty@0';
    const start = Math.max(0, Math.min(Number(queueIndex) || 0, queue.length - 1));
    const limit = Math.min(queue.length, Math.max(1, Number(windowSize) || 6));
    const ids = [];
    for (let offset = 0; offset < limit; offset++) {
      const idx = (start + offset) % queue.length;
      const t = queue[idx];
      ids.push(t ? String(t.id || t.videoId || t.libraryFileId || t.title || idx) : '');
    }
    return `${queue.length}@${start}:${ids.join(',')}`;
  }

  const exported = { resolveTrackSourceUrl, computeQueueContextId, extractSafeFilename };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  }
  if (root) {
    root.EclipseAutoMixSourceResolver = exported;
  }
})(typeof window !== 'undefined' ? window : globalThis);
