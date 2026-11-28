// d:/Eclipse/eclipse-pc/src/renderer/album-sync-engine.js
// JS / album-sync-engine.js / Browser + Node / Eclipse PC
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.EclipseAlbumSyncEngine = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERSION_TAG_PATTERNS = [
    /\b(live)\b/i,
    /\b(remix)\b/i,
    /\b(remaster(?:ed)?)\b/i,
    /\b(explicit)\b/i,
    /\b(clean)\b/i,
    /\b(acoustic)\b/i,
    /\b(instrumental)\b/i,
    /\b(sped\s*up|slowed)\b/i,
    /\b(radio\s*edit|extended|deluxe)\b/i
  ];

  function normalizeText(val) {
    return String(val || '').trim().toLowerCase().replace(/\s+/g, ' ');
  }

  function parseValidDurationSec(track) {
    if (!track || typeof track !== 'object') return null;
    if (typeof track.duration === 'number' && Number.isFinite(track.duration) && track.duration > 0) {
      return Math.round(track.duration);
    }
    if (typeof track.durationMs === 'number' && Number.isFinite(track.durationMs) && track.durationMs > 0) {
      return Math.round(track.durationMs / 1000);
    }
    return null;
  }

  function computeAlbumMetadata(tracks) {
    if (!Array.isArray(tracks)) {
      return { trackCount: null, totalDurationSec: 0, missingDurationCount: 0, state: 'unknown' };
    }
    if (tracks.length === 0) {
      return { trackCount: 0, totalDurationSec: 0, missingDurationCount: 0, state: 'empty' };
    }
    let totalDurationSec = 0;
    let missingDurationCount = 0;
    for (const t of tracks) {
      const sec = parseValidDurationSec(t);
      if (sec === null) {
        missingDurationCount++;
      } else {
        totalDurationSec += sec;
      }
    }
    return {
      trackCount: tracks.length,
      totalDurationSec,
      missingDurationCount,
      state: 'ready'
    };
  }

  function formatDurationLabel(totalSec) {
    if (typeof totalSec !== 'number' || !Number.isFinite(totalSec) || totalSec <= 0) return '';
    const hours = Math.floor(totalSec / 3600);
    const minutes = Math.floor((totalSec % 3600) / 60);
    if (hours > 0) return `${hours} giờ ${minutes} phút`;
    if (minutes > 0) return `${minutes} phút`;
    return `${Math.max(1, Math.round(totalSec))} giây`;
  }

  function formatAlbumMetaLine(opts) {
    const {
      type = 'Album',
      year = '',
      status = 'ready',
      trackCount = null,
      totalDurationSec = 0
    } = opts || {};

    let countStr = '';
    if (status === 'loading') {
      countStr = (typeof trackCount === 'number' && trackCount > 0)
        ? `${trackCount} bản nhạc`
        : 'Đang tải bài hát...';
    } else if (status === 'empty' || trackCount === 0) {
      countStr = '0 bản nhạc (trống)';
    } else if (typeof trackCount === 'number' && trackCount > 0) {
      countStr = `${trackCount} bản nhạc`;
    } else {
      countStr = 'Chưa rõ số bài';
    }

    const timeStr = (status === 'ready' || (status === 'loading' && totalDurationSec > 0))
      ? formatDurationLabel(totalDurationSec)
      : '';

    return [type, year, countStr, timeStr].filter(Boolean).join(' • ');
  }

  function extractVersionTags(track) {
    const tags = new Set();
    const title = String((track && track.title) || '');
    for (const rx of VERSION_TAG_PATTERNS) {
      const m = title.match(rx);
      if (m) tags.add(m[1].toLowerCase().replace(/\s+/g, ''));
    }
    if (track && track.isExplicit === true) tags.add('explicit');
    if (track && track.isExplicit === false && /\bclean\b/i.test(title)) tags.add('clean');
    return Array.from(tags).sort().join('|');
  }

  function getTrackDedupKey(track) {
    if (!track || typeof track !== 'object') return '';
    const vid = String(track.videoId || track.trackId || track.id || '').trim();
    if (vid && !vid.startsWith('tmp_') && !vid.includes(' ')) {
      return `id:${vid}`;
    }
    const title = normalizeText(track.title);
    const artist = normalizeText(track.artist || track.uploader);
    const version = extractVersionTags(track);
    return `meta:${title}::${artist}::${version}`;
  }

  function reconcilePlaylistTracks(localTracks, upstreamTracks, fetchMeta) {
    const local = Array.isArray(localTracks) ? localTracks : [];
    const upstream = Array.isArray(upstreamTracks) ? upstreamTracks : [];
    // P0-2: Never destructively reconcile when upstream fetch is incomplete or failed
    if (fetchMeta && (fetchMeta.failed === true || fetchMeta.complete === false || fetchMeta.continuationRemaining === true)) {
      return {
        tracks: local.slice(),
        added: 0,
        removed: 0,
        reordered: false,
        preservedDueToIncompleteFetch: true
      };
    }
    const localByKey = new Map();
    for (const t of local) {
      const k = getTrackDedupKey(t);
      if (k && !localByKey.has(k)) localByKey.set(k, t);
    }

    const result = [];
    const seen = new Set();
    let added = 0;
    let reordered = false;

    for (let i = 0; i < upstream.length; i++) {
      const up = upstream[i];
      const k = getTrackDedupKey(up);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      const prev = localByKey.get(k);
      if (prev) {
        result.push({
          ...up,
          addedAt: typeof prev.addedAt === 'number' ? prev.addedAt : up.addedAt
        });
      } else {
        result.push(up);
        added++;
      }
    }

    let removed = 0;
    for (const t of local) {
      const k = getTrackDedupKey(t);
      if (k && !seen.has(k)) removed++;
    }

    if (result.length === local.length && added === 0 && removed === 0) {
      for (let i = 0; i < result.length; i++) {
        if (getTrackDedupKey(result[i]) !== getTrackDedupKey(local[i])) {
          reordered = true;
          break;
        }
      }
    } else {
      reordered = true;
    }

    return { tracks: result, added, removed, reordered };
  }

  function getEntityIdentityKey(entity, defaultAccountId) {
    const accountId = String((entity && entity.accountId) || defaultAccountId || 'default').trim();
    const rawType = normalizeText(entity && (entity.entityType || entity.type));
    const entityType = rawType.includes('playlist') || rawType.includes('danh sách phát') ? 'playlist' : 'album';
    const upstreamId = String((entity && (entity.upstreamId || entity.ytId || entity.id)) || '').trim();
    if (upstreamId) {
      return `${accountId}::${entityType}::id:${upstreamId}`;
    }
    const title = normalizeText(entity && (entity.title || entity.name));
    const artist = normalizeText(entity && entity.artist);
    const year = normalizeText(entity && entity.year);
    return `${accountId}::${entityType}::fallback:${title}::${artist}::${year}`;
  }

  function mergeSavedAlbumEntities(existingList, incomingList, accountId) {
    const result = Array.isArray(existingList) ? existingList.map(x => ({ ...x })) : [];
    const indexByKey = new Map();
    for (let i = 0; i < result.length; i++) {
      indexByKey.set(getEntityIdentityKey(result[i], result[i].accountId || accountId), i);
    }
    let added = 0;
    let updated = 0;

    for (const inc of (Array.isArray(incomingList) ? incomingList : [])) {
      const tagged = { ...inc, accountId: inc.accountId || accountId || 'default' };
      const key = getEntityIdentityKey(tagged, accountId);
      if (indexByKey.has(key)) {
        const idx = indexByKey.get(key);
        const prev = result[idx];
        const next = { ...prev };
        if (tagged.title) next.title = tagged.title;
        if (tagged.artist && !prev.artist) next.artist = tagged.artist;
        if (tagged.cover) next.cover = tagged.cover;
        if (tagged.year && !prev.year) next.year = tagged.year;
        const hasTracks = Array.isArray(tagged.tracks);
        const isFetchComplete = tagged.failed !== true && tagged.complete !== false && tagged.continuationRemaining !== true;
        if (hasTracks && isFetchComplete && (tagged.tracks.length > 0 || tagged.complete === true)) {
          const rec = reconcilePlaylistTracks(prev.tracks || [], tagged.tracks, {
            complete: tagged.complete,
            failed: tagged.failed,
            continuationRemaining: tagged.continuationRemaining
          });
          if (!rec.preservedDueToIncompleteFetch) {
            next.tracks = rec.tracks;
            const meta = computeAlbumMetadata(rec.tracks);
            next.trackCount = meta.trackCount;
            next.totalDurationSec = meta.totalDurationSec;
          }
        }
        // Preserve user local preferences (e.g., sortMode, addedAt)
        if (prev.sortMode) next.sortMode = prev.sortMode;
        if (prev.addedAt) next.addedAt = prev.addedAt;
        result[idx] = next;
        updated++;
      } else {
        const meta = Array.isArray(tagged.tracks) && tagged.tracks.length > 0
          ? computeAlbumMetadata(tagged.tracks)
          : null;
        if (meta) {
          tagged.trackCount = meta.trackCount;
          tagged.totalDurationSec = meta.totalDurationSec;
        }
        result.push(tagged);
        indexByKey.set(key, result.length - 1);
        added++;
      }
    }
    return { list: result, added, updated };
  }

  function createLibrarySyncCoordinator(options) {
    const opts = options || {};
    const syncFn = opts.syncFn;
    const getActiveAccountId = opts.getActiveAccountId || (() => 'default');
    const isAppActive = opts.isAppActive || (() => true);
    const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : 45000;
    const baseBackoffMs = typeof opts.baseBackoffMs === 'number' ? opts.baseBackoffMs : 2000;
    const maxBackoffMs = typeof opts.maxBackoffMs === 'number' ? opts.maxBackoffMs : 300000;
    const now = opts.now || (() => Date.now());

    let generation = 0;
    let inFlight = null;
    let activeRequestId = null;
    const cancelFn = typeof opts.cancelFn === 'function' ? opts.cancelFn : null;
    const state = {
      status: 'idle',
      lastSync: null,
      lastError: null,
      retryCount: 0,
      nextRetryAt: 0,
      accountId: null
    };

    function getState() {
      return { ...state };
    }

    function invalidateAccount(reason) {
      generation++;
      if (activeRequestId && cancelFn) {
        try { Promise.resolve(cancelFn(activeRequestId)).catch(() => {}); } catch (_) {}
      }
      activeRequestId = null;
      inFlight = null;
      state.status = 'idle';
      state.retryCount = 0;
      state.nextRetryAt = 0;
      state.accountId = getActiveAccountId();
      state.lastError = reason || null;
    }

    async function runSync(trigger) {
      const isManual = trigger === 'manual';
      if (!isManual && !isAppActive()) {
        return { skipped: true, reason: 'app_inactive', state: getState() };
      }
      if (inFlight) {
        return inFlight;
      }
      const currentTime = now();
      if (!isManual && state.nextRetryAt > currentTime) {
        return { skipped: true, reason: 'backoff_active', nextRetryAt: state.nextRetryAt, state: getState() };
      }

      const runGen = generation;
      const runAccountId = getActiveAccountId();
      const requestId = `sync_${runGen}_${now()}_${Math.random().toString(36).slice(2, 8)}`;
      activeRequestId = requestId;
      state.status = 'syncing';
      state.accountId = runAccountId;
      state.lastError = null;

      const promise = (async () => {
        let timer = null;
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        try {
          const timeoutPromise = new Promise((_, reject) => {
            timer = setTimeout(() => {
              if (controller) controller.abort();
              if (cancelFn) {
                try { Promise.resolve(cancelFn(requestId)).catch(() => {}); } catch (_) {}
              }
              reject(Object.assign(new Error('Sync timed out'), { code: 'SYNC_TIMEOUT' }));
            }, timeoutMs);
          });
          const result = await Promise.race([
            syncFn({ accountId: runAccountId, trigger, requestId, signal: controller ? controller.signal : undefined }),
            timeoutPromise
          ]);
          if (timer) clearTimeout(timer);

          if (runGen !== generation || getActiveAccountId() !== runAccountId) {
            return { stale: true, discarded: true, state: getState() };
          }

          if (result && (result.status === 429 || result.httpStatus === 429)) {
            const retryAfterSec = Number(result.retryAfter) || 0;
            state.retryCount++;
            const delay = retryAfterSec > 0
              ? retryAfterSec * 1000
              : Math.min(maxBackoffMs, baseBackoffMs * Math.pow(2, state.retryCount - 1));
            state.status = 'failed';
            state.lastError = 'HTTP 429 rate limited';
            state.nextRetryAt = now() + delay;
            return { success: false, rateLimited: true, retryAfter: retryAfterSec || null, nextRetryAt: state.nextRetryAt, state: getState() };
          }

          if (result && result.success === false) {
            state.retryCount++;
            const delay = Math.min(maxBackoffMs, baseBackoffMs * Math.pow(2, state.retryCount - 1));
            state.status = 'failed';
            state.lastError = result.error || 'Sync failed';
            state.nextRetryAt = now() + delay;
            return { success: false, error: state.lastError, errorCode: result.errorCode || null, state: getState() };
          }

          state.status = 'success';
          state.lastSync = now();
          state.lastError = null;
          state.retryCount = 0;
          state.nextRetryAt = 0;
          return { success: true, data: result, state: getState() };
        } catch (err) {
          if (timer) clearTimeout(timer);
          if (runGen !== generation || getActiveAccountId() !== runAccountId) {
            return { stale: true, discarded: true, state: getState() };
          }
          state.retryCount++;
          const retryAfterMs = err && (err.status === 429 || err.httpStatus === 429) && err.retryAfter ? Number(err.retryAfter) * 1000 : 0;
          const delay = retryAfterMs || Math.min(maxBackoffMs, baseBackoffMs * Math.pow(2, state.retryCount - 1));
          state.status = 'failed';
          state.lastError = (err && err.message) || 'Sync error';
          state.nextRetryAt = now() + delay;
          return { success: false, error: state.lastError, errorCode: (err && err.code) || null, rateLimited: Boolean(err && (err.status === 429 || err.httpStatus === 429)), state: getState() };
        } finally {
          if (activeRequestId === requestId) activeRequestId = null;
          if (inFlight === promise) inFlight = null;
        }
      })();

      inFlight = promise;
      return promise;
    }

    return { runSync, getState, invalidateAccount };
  }

  return {
    parseValidDurationSec,
    computeAlbumMetadata,
    formatDurationLabel,
    formatAlbumMetaLine,
    extractVersionTags,
    getTrackDedupKey,
    reconcilePlaylistTracks,
    getEntityIdentityKey,
    mergeSavedAlbumEntities,
    createLibrarySyncCoordinator
  };
});
