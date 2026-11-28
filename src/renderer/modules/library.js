// src/renderer/modules/library.js
// Queue, track context menu, top moments, stream prefetch, offline mode, local library, favorites, history, and playlists.

function addTrackToQueue(track) {
  if (!track) return;
  const cloned = Object.assign({}, track);
  if (!state.currentTrack || state.queue.length === 0) {
    state.queue = [cloned];
    state.queueIndex = 0;
    if (el.queueCount) el.queueCount.textContent = '1';
    playTrack(cloned, 0);
    showToast(typeof t === 'function' ? t('Added to queue') : 'Added to queue', 'success');
    return;
  }
  state.queue.push(cloned);
  updateQueueBadge();
  if (state.currentView === 'queue' && typeof renderQueueView === 'function') {
    renderQueueView();
  } else if (state.currentView === 'queue' && el.queueTracksList) {
    el.queueTracksList.querySelector('.empty-hint')?.remove();
    const qIdx = state.queue.length - 1;
    el.queueTracksList.appendChild(createTrackRow(cloned, qIdx, () => playTrack(cloned, qIdx)));
  }
  showToast(typeof t === 'function' ? t('Added to queue') : 'Added to queue', 'success');
}
window.addTrackToQueue = addTrackToQueue;

function isTrackFavorited(track) {
  if (!track) return false;
  return state.favorites.some(f => (f.id && f.id === track.id) || (f.title === track.title && f.artist === track.artist));
}

function toggleFavorite(track) {
  if (typeof toggleFavoriteTrack === 'function') toggleFavoriteTrack(track);
}

function openDownloadModalForTrack(track, initialTab = 'download') {
  if (typeof openDownloadModal === 'function') openDownloadModal(track, initialTab);
}

function openTrimModalForTrack(track) {
  openDownloadModalForTrack(track, 'trim');
}

function openRenameTrackModal(track) {
  if (!track) return;
  state.renamingTrack = track;
  const titleInput = el.renameTitleInput || el.inputRenameTitle;
  const artistInput = el.renameArtistInput || el.inputRenameArtist;
  if (titleInput) titleInput.value = track.title || '';
  if (artistInput) artistInput.value = track.artist || '';
  if (el.renameTrackModal) openModal(el.renameTrackModal);
  if (titleInput) titleInput.focus();
}

let ctxMenuEl = null;
let ctxMenuOpenedAt = 0;
let tgTipEl = null;
let tgTipHideTimer = null;
let tgTipDwellTimer = null;
let tgTipCountTimer = null;
let lastCountedTipTs = 0;
let lastCountedTrackKey = '';

function getCtxTipCount() {
  const raw = parseInt(localStorage.getItem('eclipse_ctx_tip_v2') || '0', 10);
  return Number.isFinite(raw) ? raw : 0;
}

function setCtxTipCount(val) {
  try { localStorage.setItem('eclipse_ctx_tip_v2', String(val)); } catch (_) {}
}

function ensureTrackHoverTipEl() {
  if (!tgTipEl) {
    tgTipEl = document.createElement('div');
    tgTipEl.className = 'riff-tg-tip';
    document.body.appendChild(tgTipEl);
  }
  tgTipEl.textContent = typeof t === 'function' ? t('Tip: press right mouse button to see more features') : 'Tip: press right mouse button to see more features';
  return tgTipEl;
}

function bindTrackHoverTip(row, track) {
  if (!row) return;
  let lastClientX = 0;

  row.addEventListener('pointermove', (e) => {
    lastClientX = e.clientX;
  }, { passive: true });

  row.addEventListener('mouseenter', (e) => {
    lastClientX = e.clientX;
    if (getCtxTipCount() >= 3) return;
    if (ctxMenuEl && ctxMenuEl.classList.contains('open')) return;

    if (tgTipDwellTimer) clearTimeout(tgTipDwellTimer);
    if (tgTipCountTimer) clearTimeout(tgTipCountTimer);
    if (tgTipHideTimer) clearTimeout(tgTipHideTimer);

    tgTipDwellTimer = setTimeout(() => {
      if (getCtxTipCount() >= 3) return;
      if (ctxMenuEl && ctxMenuEl.classList.contains('open')) return;

      const tip = ensureTrackHoverTipEl();
      const r = row.getBoundingClientRect();
      const x = Math.min(window.innerWidth - 300, Math.max(16, (lastClientX || r.left + 80) + 12));
      const y = Math.max(12, r.top - 32);
      tip.style.left = `${x}px`;
      tip.style.top = `${y}px`;
      tip.classList.add('visible');

      const trackKey = String(track?.id || '') + '::' + String(track?.title || '');
      tgTipCountTimer = setTimeout(() => {
        const now = Date.now();
        if (trackKey !== lastCountedTrackKey && (now - lastCountedTipTs > 3500)) {
          lastCountedTrackKey = trackKey;
          lastCountedTipTs = now;
          setCtxTipCount(getCtxTipCount() + 1);
        }
      }, 800);

      tgTipHideTimer = setTimeout(() => {
        tip.classList.remove('visible');
      }, 2800);
    }, 420);
  });

  row.addEventListener('mouseleave', () => {
    if (tgTipDwellTimer) { clearTimeout(tgTipDwellTimer); tgTipDwellTimer = null; }
    if (tgTipCountTimer) { clearTimeout(tgTipCountTimer); tgTipCountTimer = null; }
    if (tgTipHideTimer) { clearTimeout(tgTipHideTimer); tgTipHideTimer = null; }
    if (tgTipEl) tgTipEl.classList.remove('visible');
  });
}

function closeTrackContextMenu() {
  if (ctxMenuEl) ctxMenuEl.classList.remove('open');
}

window.addEventListener('contextmenu', (ev) => {
  if (ctxMenuEl && ctxMenuEl.classList.contains('open')) {
    ev.preventDefault();
    ev.stopPropagation();
    closeTrackContextMenu();
    return;
  }
}, true);

// Reset track audio source
async function resetTrackAudioSource(track) {
  if (!track) return;
  const oldSourceId = track.resolvedYtId || (track.id && !String(track.id).startsWith('eclipse-') ? track.id : null) || track.url;

  try {
    let blockedSources = JSON.parse(localStorage.getItem('eclipse_blocked_audio_sources') || '[]');
    if (oldSourceId && !blockedSources.includes(oldSourceId)) {
      blockedSources.push(oldSourceId);
      localStorage.setItem('eclipse_blocked_audio_sources', JSON.stringify(blockedSources));
    }
  } catch (_) {}

  delete track._preloadedStreamUrl;
  delete track._preloadedStreamQuality;
  delete track._preloadedAt;
  delete track.streamUrl;
  delete track.resolvedYtId;
  track.isCached = false;
  if (typeof cachedTrackIds !== 'undefined' && cachedTrackIds instanceof Set) {
    if (track.id) cachedTrackIds.delete(track.id);
    if (oldSourceId) cachedTrackIds.delete(oldSourceId);
  }

  if (track.id) {
    fetch(`http://127.0.0.1:${state.serverPort}/api/offline-delete?id=${encodeURIComponent(track.id)}`, { method: 'POST' }).catch(() => {});
  }
  if (oldSourceId && oldSourceId !== track.id) {
    fetch(`http://127.0.0.1:${state.serverPort}/api/offline-delete?id=${encodeURIComponent(oldSourceId)}`, { method: 'POST' }).catch(() => {});
  }

  showToast(typeof t === 'function' ? t('Searching new audio source...') : 'Searching new audio source...');

  try {
    const q = `${track.artist ? track.artist + ' ' : ''}${track.title || ''}`.trim();
    let searchRes = await fetch(`http://127.0.0.1:${state.serverPort}/api/search?q=${encodeURIComponent(q)}&platform=ytmusic`);
    let searchData = await searchRes.json().catch(() => ({}));
    let results = (searchData && (searchData.tracks || searchData.results)) || [];
    if (!results.length) {
      searchRes = await fetch(`http://127.0.0.1:${state.serverPort}/api/search?q=${encodeURIComponent(q)}&platform=youtube`);
      searchData = await searchRes.json().catch(() => ({}));
      results = (searchData && (searchData.tracks || searchData.results)) || [];
    }

    let blockedList = [];
    try { blockedList = JSON.parse(localStorage.getItem('eclipse_blocked_audio_sources') || '[]'); } catch (_) {}

    const candidate = results.find(c => {
      const cid = c.id || c.videoId || c.url;
      return cid && cid !== oldSourceId && !blockedList.includes(cid);
    });

    if (candidate) {
      track.resolvedYtId = candidate.id || candidate.videoId;
      if (candidate.url) track.url = candidate.url;
      if (candidate.duration && (!track.duration || track._hadNoDurationOnImport)) {
        track.duration = candidate.duration;
      }
      showToast(typeof t === 'function' ? t('Audio source updated!') : 'Audio source updated!');
      if (state.currentTrack && isSameTrack(state.currentTrack, track)) {
        playTrack(track, state.queue, state.queueIndex, state.currentTrackContext);
      }
    } else {
      showToast(typeof t === 'function' ? t('No alternative audio source found') : 'No alternative audio source found', 'warn');
    }
  } catch (err) {
    showToast((typeof t === 'function' ? t('Failed to search new audio source') : 'Failed to search new audio source') + ': ' + err.message, 'error');
  }
}

// Top moment pin
function getTopMomentsMap() {
  try {
    return JSON.parse(localStorage.getItem('eclipse_top_moments') || '{}');
  } catch (_) {
    return {};
  }
}

function getTopMoment(track) {
  if (!track) return null;
  const map = getTopMomentsMap();
  if (typeof track === 'string' || typeof track === 'number') {
    const v = map[String(track)];
    return (typeof v === 'number' && Number.isFinite(v)) ? v : null;
  }
  const cid = (typeof getTrackCanonicalId === 'function' ? getTrackCanonicalId(track) : '') || track.id;
  if (cid && typeof map[cid] === 'number') return map[cid];
  if (track.id && typeof map[track.id] === 'number') return map[track.id];
  const norm = (track.artist && track.title) ? `${track.artist.trim().toLowerCase()} - ${track.title.trim().toLowerCase()}` : '';
  if (norm && typeof map[norm] === 'number') return map[norm];
  return null;
}

function setTopMoment(track, timestamp) {
  if (!track || typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return;
  const map = getTopMomentsMap();
  const val = Math.max(0, Math.round(timestamp * 100) / 100);
  const cid = (typeof getTrackCanonicalId === 'function' ? getTrackCanonicalId(track) : '') || track.id;
  if (cid) map[cid] = val;
  if (track.id) map[track.id] = val;
  const norm = (track.artist && track.title) ? `${track.artist.trim().toLowerCase()} - ${track.title.trim().toLowerCase()}` : '';
  if (norm) map[norm] = val;
  localStorage.setItem('eclipse_top_moments', JSON.stringify(map));
  updateTopMomentPin();
}

function removeTopMoment(track) {
  if (!track) return;
  const map = getTopMomentsMap();
  const cid = (typeof getTrackCanonicalId === 'function' ? getTrackCanonicalId(track) : '') || track.id;
  if (cid) delete map[cid];
  if (track.id) delete map[track.id];
  const norm = (track.artist && track.title) ? `${track.artist.trim().toLowerCase()} - ${track.title.trim().toLowerCase()}` : '';
  if (norm) delete map[norm];
  localStorage.setItem('eclipse_top_moments', JSON.stringify(map));
  updateTopMomentPin();
}

function getTopMomentIconHtml() {
  const iconType = localStorage.getItem('eclipse_top_moment_icon') || 'heart';
  if (iconType === 'minecraft') {
    const mcSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 9 9" shape-rendering="crispEdges" width="18" height="18" style="display:block;image-rendering:pixelated;"><rect x="2" y="0" width="1" height="1" fill="#000000"/><rect x="3" y="0" width="1" height="1" fill="#000000"/><rect x="5" y="0" width="1" height="1" fill="#000000"/><rect x="6" y="0" width="1" height="1" fill="#000000"/><rect x="1" y="1" width="1" height="1" fill="#000000"/><rect x="2" y="1" width="1" height="1" fill="#ff1313"/><rect x="3" y="1" width="1" height="1" fill="#ff1313"/><rect x="4" y="1" width="1" height="1" fill="#000000"/><rect x="5" y="1" width="1" height="1" fill="#ff1313"/><rect x="6" y="1" width="1" height="1" fill="#ff1313"/><rect x="7" y="1" width="1" height="1" fill="#000000"/><rect x="0" y="2" width="1" height="1" fill="#000000"/><rect x="1" y="2" width="1" height="1" fill="#ff1313"/><rect x="2" y="2" width="1" height="1" fill="#ffc8c8"/><rect x="3" y="2" width="1" height="1" fill="#ff1313"/><rect x="4" y="2" width="1" height="1" fill="#ff1313"/><rect x="5" y="2" width="1" height="1" fill="#ff1313"/><rect x="6" y="2" width="1" height="1" fill="#ff1313"/><rect x="7" y="2" width="1" height="1" fill="#ff1313"/><rect x="8" y="2" width="1" height="1" fill="#000000"/><rect x="0" y="3" width="1" height="1" fill="#000000"/><rect x="1" y="3" width="1" height="1" fill="#ff1313"/><rect x="2" y="3" width="1" height="1" fill="#ff1313"/><rect x="3" y="3" width="1" height="1" fill="#ff1313"/><rect x="4" y="3" width="1" height="1" fill="#ff1313"/><rect x="5" y="3" width="1" height="1" fill="#ff1313"/><rect x="6" y="3" width="1" height="1" fill="#ff1313"/><rect x="7" y="3" width="1" height="1" fill="#ff1313"/><rect x="8" y="3" width="1" height="1" fill="#000000"/><rect x="0" y="4" width="1" height="1" fill="#000000"/><rect x="1" y="4" width="1" height="1" fill="#bb1313"/><rect x="2" y="4" width="1" height="1" fill="#ff1313"/><rect x="3" y="4" width="1" height="1" fill="#ff1313"/><rect x="4" y="4" width="1" height="1" fill="#ff1313"/><rect x="5" y="4" width="1" height="1" fill="#ff1313"/><rect x="6" y="4" width="1" height="1" fill="#ff1313"/><rect x="7" y="4" width="1" height="1" fill="#bb1313"/><rect x="8" y="4" width="1" height="1" fill="#000000"/><rect x="1" y="5" width="1" height="1" fill="#000000"/><rect x="2" y="5" width="1" height="1" fill="#bb1313"/><rect x="3" y="5" width="1" height="1" fill="#ff1313"/><rect x="4" y="5" width="1" height="1" fill="#ff1313"/><rect x="5" y="5" width="1" height="1" fill="#ff1313"/><rect x="6" y="5" width="1" height="1" fill="#bb1313"/><rect x="7" y="5" width="1" height="1" fill="#000000"/><rect x="2" y="6" width="1" height="1" fill="#000000"/><rect x="3" y="6" width="1" height="1" fill="#bb1313"/><rect x="4" y="6" width="1" height="1" fill="#ff1313"/><rect x="5" y="6" width="1" height="1" fill="#bb1313"/><rect x="6" y="6" width="1" height="1" fill="#000000"/><rect x="3" y="7" width="1" height="1" fill="#000000"/><rect x="4" y="7" width="1" height="1" fill="#bb1313"/><rect x="5" y="7" width="1" height="1" fill="#000000"/><rect x="4" y="8" width="1" height="1" fill="#000000"/></svg>';
    return `<div class="top-moment-inner top-moment-mc" style="width:18px;height:18px;position:relative;background:none !important;border-radius:0 !important;mask:none !important;-webkit-mask:none !important;filter:drop-shadow(0 1px 2px rgba(0,0,0,0.5));">
      <div style="position:absolute;inset:0;opacity:0.42;pointer-events:none;">${mcSvg}</div>
      <div style="position:absolute;inset:0;clip-path:inset(0 calc(100% - var(--fill-pct, 0%)) 0 0);pointer-events:none;">${mcSvg}</div>
    </div>`;
  }
  let maskUrl = '';
  if (iconType === 'honey') {
    maskUrl = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#000" stroke="#000" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" d="M12 3.5c-.38 0-.73.16-1 .44L6.44 8.7C4.9 10.3 4 12.44 4 14.7 4 19.12 7.58 22.7 12 22.7s8-3.58 8-8c0-2.26-.9-4.4-2.44-6l-4.56-4.76c-.27-.28-.62-.44-1-.44z"/></svg>');
  } else if (iconType === 'star') {
    maskUrl = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#000" stroke="#000" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" d="m12 17.27 4.15 2.51c.76.46 1.69-.22 1.49-1.08l-1.1-4.73 3.67-3.18c.67-.58.31-1.68-.57-1.75l-4.83-.41-1.89-4.46c-.34-.81-1.5-.81-1.84 0L9.19 8.63l-4.83.41c-.88.07-1.24 1.17-.57 1.75l3.67 3.18-1.1 4.73c-.2.86.73 1.54 1.49 1.08l4.15-2.5z"/></svg>');
  } else if (iconType === 'fire') {
    maskUrl = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#000" stroke="#000" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" d="M13.5 1.5s.74 2.3.74 4.17c0 1.8-.9 3.25-2.7 3.25-1.8 0-3.15-1.45-3.15-3.25l.03-.31C6.2 7.36 5 9.8 5 13c0 4.1 3.13 7.5 7 7.5s7-3.4 7-7.5c0-4.7-2.25-8.9-5.5-11.5z"/></svg>');
  } else {
    maskUrl = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#000" stroke="#000" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round" d="M12 20.4c-.38 0-.74-.15-1.02-.42-1.3-1.18-2.61-2.29-3.8-3.32C4.1 14.01 2 11.75 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.25-2.1 5.51-5.18 8.16-1.19 1.03-2.5 2.14-3.8 3.32-.28.27-.64.42-1.02.42z"/></svg>');
  }
  return `<div class="top-moment-inner" style="-webkit-mask-image: url('${maskUrl}'); mask-image: url('${maskUrl}'); border-radius: 6px;"></div>`;
}

function updateTopMomentPin() {
  const track = state.currentTrack;
  if (!track) return;
  const momentTime = getTopMoment(track);
  const dur = typeof getReliableTrackDuration === 'function' ? getReliableTrackDuration() : (track.duration || 0);

  ['scrubber-track', 'tvk-scrubber-track'].forEach(containerId => {
    const container = document.getElementById(containerId);
    if (!container) return;
    let pin = container.querySelector('.top-moment-pin');
    if (momentTime === null || dur <= 0 || momentTime > dur) {
      if (pin) {
        pin.classList.remove('visible');
        setTimeout(() => { if (pin && !pin.classList.contains('visible')) pin.style.display = 'none'; }, 240);
      }
      return;
    }
    const isNewPin = !pin;
    if (!pin) {
      pin = document.createElement('div');
      pin.className = 'top-moment-pin';
      pin.id = containerId === 'scrubber-track' ? 'top-moment-pin' : 'tvk-top-moment-pin';
      container.appendChild(pin);
    }

    const currentIconType = localStorage.getItem('eclipse_top_moment_icon') || 'heart';
    if (!pin.firstElementChild || pin.dataset.iconType !== currentIconType) {
      pin.innerHTML = getTopMomentIconHtml();
      pin.dataset.iconType = currentIconType;
    }

    const ratio = Math.max(0, Math.min(1, momentTime / dur));
    let targetLeft = '';
    if (containerId === 'tvk-scrubber-track') {
      const rowW = container.clientWidth || (typeof cachedTvkProgWidth !== 'undefined' ? cachedTvkProgWidth : 240);
      const pad = 10;
      const px = pad + ratio * Math.max(0, rowW - 2 * pad);
      targetLeft = px + 'px';
    } else {
      targetLeft = `calc(5.5px + (100% - 11px) * ${ratio.toFixed(4)})`;
    }

    const wasVisible = !isNewPin && pin.classList.contains('visible');
    pin.style.display = 'flex';

    if (!wasVisible) {
      pin.style.transition = 'none';
      pin.style.left = targetLeft;
      void pin.offsetWidth;
      pin.style.transition = '';
      requestAnimationFrame(() => pin.classList.add('visible'));
    } else {
      pin.classList.add('visible');
      pin.style.left = targetLeft;
    }

    pin.title = `${typeof t === 'function' ? t('Top moment') : 'Top moment'}: ${formatDuration(momentTime)} (click to jump, right click to remove)`;

    pin.onclick = (e) => {
      e.stopPropagation();
      if (el.nativeAudio && Number.isFinite(momentTime)) {
        el.nativeAudio.currentTime = momentTime;
        if (typeof updateMediaPositionState === 'function') updateMediaPositionState();
      }
    };
    pin.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      removeTopMoment(track);
      showToast(typeof t === 'function' ? t('Top moment removed') : 'Top moment removed');
    };
  });
}

// Stream prefetch & zero delay queue
const streamPrefetchQueue = [];
let streamPrefetchActive = 0;
const STREAM_PREFETCH_MAX = 2;
const prefetchedTrackKeys = new Set();

function pumpStreamPrefetch() {
  while (streamPrefetchActive < STREAM_PREFETCH_MAX && streamPrefetchQueue.length) {
    const { run } = streamPrefetchQueue.shift();
    streamPrefetchActive++;
    run().finally(() => { streamPrefetchActive--; pumpStreamPrefetch(); });
  }
}

function enqueueStreamPrefetch(track) {
  if (!track || track.platform === 'local' || (typeof isStaticTikTokTrack === 'function' && isStaticTikTokTrack(track))) return;
  const quality = getConfiguredAudioQuality();
  if (isTrackPreloadValid(track, quality)) return;
  const key = `${String(track.platform || state.platform || 'ytmusic').toLowerCase()}:${(typeof getTrackCanonicalId === 'function' ? getTrackCanonicalId(track) : '') || (track.id || track.url || (track.artist + '_' + track.title))}:${quality}`;
  if (!key || prefetchedTrackKeys.has(key)) return;
  prefetchedTrackKeys.add(key);
  streamPrefetchQueue.push({ key, run: () => {
    const qQuality = encodeURIComponent(quality);
    const qSearch = encodeURIComponent(track.searchQuery || ((track.artist ? track.artist + ' - ' : '') + (track.title || '')));
    const u = `http://127.0.0.1:${state.serverPort}/api/stream-info?url=${encodeURIComponent(track.url || '')}&id=${encodeURIComponent(track.id || '')}&platform=${track.platform || state.platform}&title=${encodeURIComponent(track.title || '')}&artist=${encodeURIComponent(track.artist || '')}&duration=${encodeURIComponent(track.duration || 0)}&thumbnail=${encodeURIComponent(track.thumbnail || '')}&quality=${qQuality}&q=${qSearch}`;
    return fetch(u)
      .then((r) => r.json())
      .then((d) => {
        if (d && d.success && d.streamUrl) {
          track._preloadedStreamUrl = d.proxyUrl || d.streamUrl;
          track._preloadedStreamQuality = (d.resolvedQuality ? String(d.resolvedQuality).trim().toLowerCase() : quality);
          track._preloadedStreamPlatform = String(track.platform || state.platform || 'ytmusic').trim().toLowerCase();
          track._preloadedStreamUrlExpires = Date.now() + 3600 * 1000;
        } else {
          prefetchedTrackKeys.delete(key);
        }
      })
      .catch(() => { prefetchedTrackKeys.delete(key); });
  } });
  pumpStreamPrefetch();
}

function prefetchUpcomingQueueStreams() {
  if (!state.queue || state.queueIndex < 0) return;
  if (typeof preloadNextTrackStream === 'function') preloadNextTrackStream();
}

// Offline mode
function setOfflineBannerVisible(offline) {
  const banner = document.getElementById('offline-top-banner');
  if (banner) {
    banner.classList.toggle('hidden', !offline);
  }
}
window.setOfflineBannerVisible = setOfflineBannerVisible;

async function checkAndShowOfflineMode(isStartup = false) {
  const modal = document.getElementById('offline-mode-modal');
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    setOfflineBannerVisible(true);
    if (modal && typeof openModal === 'function') openModal(modal);
    return;
  }
  try {
    const port = state.serverPort || 38472;
    const res = await fetch(`http://127.0.0.1:${port}/api/net-check`);
    const data = await res.json();
    if (data && data.online === false) {
      setOfflineBannerVisible(true);
      if (modal && typeof openModal === 'function') openModal(modal);
    } else if (data && data.online) {
      setOfflineBannerVisible(false);
    }
  } catch (_) {
    if (!isStartup) {
      setOfflineBannerVisible(true);
      if (modal && typeof openModal === 'function') openModal(modal);
    }
  }
}

function initOfflineMode() {
  const modal = document.getElementById('offline-mode-modal');
  const btnOk = document.getElementById('btn-offline-ok');
  const btnRetry = document.getElementById('btn-offline-retry');
  const btnTopRetry = document.getElementById('btn-offline-top-retry');

  if (btnOk && modal) {
    btnOk.addEventListener('click', () => {
      if (typeof closeModal === 'function') closeModal(modal);
      if (typeof switchView === 'function') switchView('local');
    });
  }

  const doRetry = async (btn) => {
    if (btn) btn.disabled = true;
    try {
      const port = state.serverPort || 38472;
      const res = await fetch(`http://127.0.0.1:${port}/api/net-check`);
      const data = await res.json();
      if (data && data.online) {
        setOfflineBannerVisible(false);
        if (modal && typeof closeModal === 'function') closeModal(modal);
        if (typeof goHome === 'function') goHome();
      } else {
        setOfflineBannerVisible(true);
        showToast(typeof t === 'function' ? t('Still offline') : 'Still offline', 'warning');
      }
    } catch (_) {
      setOfflineBannerVisible(true);
      showToast(typeof t === 'function' ? t('Still offline') : 'Still offline', 'warning');
    } finally {
      if (btn) btn.disabled = false;
    }
  };

  if (btnRetry) btnRetry.addEventListener('click', () => doRetry(btnRetry));
  if (btnTopRetry) btnTopRetry.addEventListener('click', () => doRetry(btnTopRetry));

  window.addEventListener('offline', () => {
    setOfflineBannerVisible(true);
    if (modal && typeof openModal === 'function') openModal(modal);
  });
  window.addEventListener('online', () => {
    setOfflineBannerVisible(false);
  });
}

function openTrackContextMenu(e, track, options = {}) {
  const capturedCurTime = (typeof options.timestamp === "number" && Number.isFinite(options.timestamp))
    ? options.timestamp
    : ((state.currentTrack && isSameTrack(state.currentTrack, track) && el.nativeAudio) ? el.nativeAudio.currentTime : 0);
  if (ctxMenuEl && ctxMenuEl.classList.contains('open')) {
    closeTrackContextMenu();
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  if (!track) return;
  ctxMenuOpenedAt = performance.now();
  setCtxTipCount(3);
  if (tgTipEl) tgTipEl.classList.remove('visible');

  if (!ctxMenuEl) {
    ctxMenuEl = document.createElement('div');
    ctxMenuEl.className = 'riff-ctx-menu';
    document.body.appendChild(ctxMenuEl);
    document.addEventListener('pointerdown', (ev) => {
      if (!ctxMenuEl || !ctxMenuEl.classList.contains('open')) return;
      if (performance.now() - ctxMenuOpenedAt < 180) return;
      if (ctxMenuEl.contains(ev.target)) return;
      closeTrackContextMenu();
    });
    window.addEventListener('wheel', (ev) => {
      if (!ctxMenuEl || !ctxMenuEl.classList.contains('open')) return;
      if (ctxMenuEl.contains(ev.target) || ctxMenuEl.matches(':hover')) return;
      closeTrackContextMenu();
    }, { passive: true });
    window.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') closeTrackContextMenu();
    });
  }

  const isFav = typeof isTrackFavorited === 'function'
    ? isTrackFavorited(track)
    : state.favorites.some(f => (f.id && f.id === track.id) || (f.title === track.title && f.artist === track.artist));

  const ANIMATED_IMAGES_SVG = '<svg viewBox="0 -960 960 960" fill="currentColor"><path d="m460-380 280-180-280-180v360ZM320-240q-33 0-56.5-23.5T240-320v-480q0-33 23.5-56.5T320-880h480q33 0 56.5 23.5T880-800v480q0 33-23.5 56.5T800-240H320Zm0-80h480v-480H320v480ZM160-80q-33 0-56.5-23.5T80-160v-560h80v560h560v80H160Zm160-720v480-480Z"/></svg>';

  const items = [
    {
      id: 'fav',
      active: isFav,
      label: isFav ? 'Remove from Favorites' : 'Favorite',
      icon: isFav
        ? '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>'
        : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>',
      action: () => {
        const favBtn = options.row ? options.row.querySelector('.btn-fav, .btn-fav-track') : null;
        if (favBtn) favBtn.click();
        else if (typeof toggleFavorite === 'function') toggleFavorite(track);
      }
    },
    {
      id: 'playlist',
      label: 'Add to playlist',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
      action: () => {
        if (typeof openAddToPlaylistModal === 'function') openAddToPlaylistModal(track);
      }
    },
    {
      id: 'queue',
      label: 'Add to queue',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="16" y2="18"/><polygon points="3 6 3 10 6 8 3 6"/><line x1="19" y1="15" x2="19" y2="21"/><line x1="16" y1="18" x2="22" y2="18"/></svg>',
      action: () => addTrackToQueue(track)
    },
    {
      id: 'radio',
      label: 'Start Radio',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49m-8.48-.01a6 6 0 0 1 0-8.49m11.31-2.82a10 10 0 0 1 0 14.14m-14.14 0a10 10 0 0 1 0-14.14"/></svg>',
      action: () => {
        if (typeof startRadioForTrack === 'function') startRadioForTrack(track);
      }
    },
    {
      id: 'share',
      label: 'Share link',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 14 20 9 15 4"/><path d="M4 20v-7a4 4 0 0 1 4-4h12"/></svg>',
      action: () => {
        if (typeof executeCopyShareLink === 'function') executeCopyShareLink(track);
      }
    },
    {
      id: 'change-source',
      label: 'Change audio source',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>',
      action: () => {
        if (window.EclipseTrackSourceUI && typeof window.EclipseTrackSourceUI.openChangeAudioSourceModal === 'function') {
          window.EclipseTrackSourceUI.openChangeAudioSourceModal(track);
        }
      }
    },
    {
      id: 'top-moment',
      label: 'Mark Top Moment',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
      action: () => {
        if (window.EclipseTopMoments && typeof window.EclipseTopMoments.promptAddMoment === 'function') {
          window.EclipseTopMoments.promptAddMoment(track);
        }
      }
    },
    {
      id: 'trim',
      label: 'Trim best part',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></svg>',
      action: () => {
        if (typeof openTrimModalForTrack === 'function') openTrimModalForTrack(track);
        else openDownloadModalForTrack(track, 'trim');
      }
    },
    {
      id: 'download',
      label: 'Download',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
      action: () => {
        if (typeof openDownloadModalForTrack === 'function') openDownloadModalForTrack(track);
        else {
          const dlBtn = options.row ? options.row.querySelector('.btn-download, [title*="Download"]') : null;
          if (dlBtn) dlBtn.click();
        }
      }
    },
    {
      id: 'banner',
      label: 'Change banner',
      icon: ANIMATED_IMAGES_SVG,
      action: () => {
        if (typeof openTrackArtModal === 'function') openTrackArtModal(track);
      }
    },
    {
      id: 'rename',
      label: 'Rename track',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>',
      action: () => {
        if (typeof openRenameTrackModal === 'function') openRenameTrackModal(track);
        else if (el.renameTrackModal) {
          state.renamingTrack = track;
          if (el.renameTitleInput) el.renameTitleInput.value = track.title || '';
          if (el.renameArtistInput) el.renameArtistInput.value = track.artist || '';
          openModal(el.renameTrackModal);
        }
      }
    }
  ];

  if (state.currentView === 'playlist-detail' && state.currentPlaylist) {
    items.push({ divider: true });
    items.push({
      id: 'remove-pl',
      danger: true,
      label: 'Remove from playlist',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>',
      action: () => {
        const delBtn = options.row ? options.row.querySelector('.btn-delete, .btn-remove') : null;
        if (delBtn) delBtn.click();
      }
    });
  } else if (state.currentView === 'queue' && typeof options.index === 'number') {
    items.push({ divider: true });
    items.push({
      id: 'remove-q',
      danger: true,
      label: 'Remove from queue',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
      action: () => {
        state.queue.splice(options.index, 1);
        if (options.index < state.queueIndex) state.queueIndex--;
        if (el.queueCount) el.queueCount.textContent = String(state.queue.length);
        if (typeof renderQueueView === 'function') renderQueueView();
      }
    });
  } else if (state.currentView === 'local') {
    items.push({ divider: true });
    items.push({
      id: 'remove-local',
      danger: true,
      label: 'Remove from Eclipse',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>',
      action: () => {
        removeTracksFromLocalLibrary([track]);
      }
    });
  }

  items.push({ divider: true });
  const trackBlocked = isTrackBlocked(track);
  items.push({
    id: 'block-track',
    danger: true,
    label: trackBlocked ? 'Unblock track' : 'Block track',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>',
    action: () => {
      toggleBlockTrack(track);
    }
  });
  if (track.artist) {
    const artistBlocked = isArtistBlocked(track.artist);
    items.push({
      id: 'block-artist',
      danger: true,
      label: artistBlocked ? 'Unblock artist' : 'Block artist',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="18" y1="8" x2="23" y2="13"/><line x1="23" y1="8" x2="18" y2="13"/></svg>',
      action: () => {
        toggleBlockArtist(track.artist);
      }
    });
  }

  ctxMenuEl.innerHTML = '';
  items.forEach((it) => {
    if (it.divider) {
      const div = document.createElement('div');
      div.className = 'riff-ctx-divider';
      ctxMenuEl.appendChild(div);
      return;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'riff-ctx-item' + (it.active ? ' is-active' : '') + (it.danger ? ' danger' : '');
    const lbl = typeof t === 'function' ? t(it.label) : it.label;
    btn.innerHTML = `${it.icon}<span>${lbl}</span>`;
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      closeTrackContextMenu();
      it.action();
    });
    ctxMenuEl.appendChild(btn);
  });

  ctxMenuEl.classList.remove('open');
  ctxMenuEl.style.left = '0px';
  ctxMenuEl.style.top = '0px';
  const rect = ctxMenuEl.getBoundingClientRect();
  const posX = (e.clientX + rect.width + 12 > window.innerWidth) ? (e.clientX - rect.width) : e.clientX;
  const posY = (e.clientY + rect.height + 12 > window.innerHeight) ? (e.clientY - rect.height) : e.clientY;
  ctxMenuEl.style.left = `${Math.max(8, posX)}px`;
  ctxMenuEl.style.top = `${Math.max(8, posY)}px`;
  requestAnimationFrame(() => {
    if (ctxMenuEl) ctxMenuEl.classList.add('open');
  });
}
window.openTrackContextMenu = openTrackContextMenu;

const playbarLeftEl = document.querySelector('#playbar .playbar-left') || document.querySelector('.playbar-left');
if (playbarLeftEl) {
  playbarLeftEl.addEventListener('contextmenu', (e) => {
    if (state.currentTrack) {
      openTrackContextMenu(e, state.currentTrack, { row: playbarLeftEl, index: state.queueIndex });
    }
  });
}

function getTrackSelectionKey(t) {
  if (!t) return '';
  return String(t.path || t.id || ((t.artist || '') + '::' + (t.title || ''))).trim();
}
window.getTrackSelectionKey = getTrackSelectionKey;

function getLocalTracksArray() {
  if (Array.isArray(state.localTracks) && state.localTracks.length > 0) return state.localTracks;
  if (Array.isArray(state.localFiles) && state.localFiles.length > 0) return state.localFiles;
  return state.localTracks || state.localFiles || [];
}
window.getLocalTracksArray = getLocalTracksArray;

function saveLocalTracks() {
  try {
    const updated = state.localTracks || state.localFiles || [];
    const serialized = JSON.stringify(updated);
    localStorage.setItem('devsize_local_tracks', serialized);
    localStorage.setItem('eclipse_local_tracks', serialized);
    localStorage.setItem('devsize_local_files', serialized);
    localStorage.setItem('eclipse_local_files', serialized);
  } catch (_) {}
}
window.saveLocalTracks = saveLocalTracks;

function removeTracksFromLocalLibrary(tracksToRemove) {
  if (!Array.isArray(tracksToRemove) || tracksToRemove.length === 0) return;
  const keysToRemove = new Set(tracksToRemove.map(t => getTrackSelectionKey(t)).filter(Boolean));
  const pathsToRemove = new Set(tracksToRemove.map(t => String(t?.path || t?.filePath || t?.url || '')).filter(Boolean));
  const idsToRemove = new Set(tracksToRemove.map(t => String(t?.id || '')).filter(Boolean));

  const shouldKeep = (t) => {
    if (!t) return false;
    if (keysToRemove.has(getTrackSelectionKey(t))) return false;
    if (t.id && idsToRemove.has(String(t.id))) return false;
    const p = String(t.path || t.filePath || t.url || '');
    if (p && pathsToRemove.has(p)) return false;
    return true;
  };

  if (Array.isArray(state.localTracks)) {
    state.localTracks = state.localTracks.filter(shouldKeep);
  }
  if (Array.isArray(state.localFiles)) {
    state.localFiles = state.localFiles.filter(shouldKeep);
  }
  const updated = state.localTracks || state.localFiles || [];

  fetch('http://127.0.0.1:' + state.serverPort + '/api/library-remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: tracksToRemove.map(t => t?.id).filter(Boolean), clearAll: (state.localFiles || []).length === 0 }) }).catch(() => {});

  try {
    const removedBlacklist = safeJson('eclipse_removed_local_paths', []);
    const mergedBlacklist = Array.from(new Set([...removedBlacklist, ...pathsToRemove, ...idsToRemove]));
    localStorage.setItem('eclipse_removed_local_paths', JSON.stringify(mergedBlacklist));
    const serialized = JSON.stringify(updated);
    localStorage.setItem('devsize_local_tracks', serialized);
    localStorage.setItem('eclipse_local_tracks', serialized);
    localStorage.setItem('devsize_local_files', serialized);
    localStorage.setItem('eclipse_local_files', serialized);
    if (typeof saveLocalTracks === 'function') saveLocalTracks();
  } catch (_) {}

  if (el.localCount) el.localCount.textContent = String(updated.length);
  if (typeof updateLocalBadge === 'function') updateLocalBadge();
  if (typeof renderLocalTracks === 'function') renderLocalTracks();
  if (typeof renderLocalFiles === 'function') renderLocalFiles();
}
window.removeTracksFromLocalLibrary = removeTracksFromLocalLibrary;

function getActiveViewTracksArray() {
  switch (state.currentView) {
    case 'playlist-detail':
      return (state.currentPlaylist && state.currentPlaylist.tracks) || (state.playlists && state.playlists.find(p => p.id === state.currentPlaylistId)?.tracks) || [];
    case 'favorites':
      return state.favorites || [];
    case 'local':
      return getLocalTracksArray();
    case 'queue':
      return state.queue || [];
    case 'artist':
      return state.artistTracks || (state.currentArtistData && state.currentArtistData.tracks) || [];
    case 'album':
      return (state.currentAlbum && state.currentAlbum.tracks) || (currentAlbumForFeedback && currentAlbumForFeedback.tracks) || [];
    case 'history':
      return state.history || [];
    case 'discover':
      return state.searchResults || Array.from(document.querySelectorAll('#search-tracks-list .track-row')).map(r => r._trackData).filter(Boolean);
    default:
      return Array.from(document.querySelectorAll('.track-row')).map(r => r._trackData).filter(Boolean);
  }
}
window.getActiveViewTracksArray = getActiveViewTracksArray;

function clearTrackSelection() {
  if (state.selectedTracks) {
    state.selectedTracks.clear();
  }
  document.querySelectorAll('.track-row.track-selected').forEach(row => {
    row.classList.remove('track-selected');
  });
  state.lastClickedTrackRow = null;
  if (document.body) document.body.classList.remove('track-selection-mode');
  updateBulkSelectBar();
}
window.clearTrackSelection = clearTrackSelection;

function updateBulkSelectBar() {
  const bar = document.getElementById('bulk-select-bar');
  const countEl = document.getElementById('bulk-select-count');
  const btnRemove = document.getElementById('btn-bulk-remove');
  const count = (state.selectedTracks && state.selectedTracks.size) || 0;
  if (document.body) document.body.classList.toggle('track-selection-mode', count > 0);
  if (!bar) return;
  if (count > 0) {
    bar.classList.remove('hidden');
    if (countEl) countEl.textContent = `${count} selected`;
    if (btnRemove) {
      const canRemove = state.currentView === 'playlist-detail' || state.currentView === 'queue' || state.currentView === 'local';
      btnRemove.style.display = canRemove ? '' : 'none';
    }
  } else {
    bar.classList.add('hidden');
  }
}

let btnBulkSelectAll = document.getElementById('btn-bulk-select-all');
if (!btnBulkSelectAll) {
  const bar = document.getElementById('bulk-select-bar');
  const countEl = document.getElementById('bulk-select-count');
  if (bar) {
    btnBulkSelectAll = document.createElement('button');
    btnBulkSelectAll.type = 'button';
    btnBulkSelectAll.className = 'btn-outline-pill';
    btnBulkSelectAll.id = 'btn-bulk-select-all';
    btnBulkSelectAll.style.cssText = 'height: 32px; padding: 0 14px; font-size: 12px;';
    btnBulkSelectAll.textContent = 'Select all';
    if (countEl && countEl.nextSibling) {
      bar.insertBefore(btnBulkSelectAll, countEl.nextSibling);
    } else {
      bar.appendChild(btnBulkSelectAll);
    }
  }
}
if (btnBulkSelectAll) {
  btnBulkSelectAll.addEventListener('click', () => {
    const activeTracks = getActiveViewTracksArray();
    if (!activeTracks || activeTracks.length === 0) return;
    if (!state.selectedTracks) state.selectedTracks = new Map();

    const allSelected = activeTracks.every(t => {
      const k = getTrackSelectionKey(t);
      return k && state.selectedTracks.has(k);
    });

    if (allSelected) {
      clearTrackSelection();
    } else {
      activeTracks.forEach(t => {
        const k = getTrackSelectionKey(t);
        if (k) state.selectedTracks.set(k, t);
      });
      document.querySelectorAll('.track-row').forEach(row => {
        if (row._trackData) {
          const k = getTrackSelectionKey(row._trackData);
          if (state.selectedTracks.has(k)) {
            row.classList.add('track-selected');
          }
        } else {
          row.classList.add('track-selected');
        }
      });
      updateBulkSelectBar();
    }
  });
}

const btnBulkAddPlaylist = document.getElementById('btn-bulk-add-playlist');
if (btnBulkAddPlaylist) {
  btnBulkAddPlaylist.addEventListener('click', () => {
    if (!state.selectedTracks || state.selectedTracks.size === 0) return;
    const selected = Array.from(state.selectedTracks.values());
    openAddToPlaylistModal(selected);
  });
}

const btnBulkAddFav = document.getElementById('btn-bulk-add-fav');
if (btnBulkAddFav) {
  btnBulkAddFav.addEventListener('click', () => {
    if (!state.selectedTracks || state.selectedTracks.size === 0) return;
    const selected = Array.from(state.selectedTracks.values());
    let added = 0;
    selected.forEach(track => {
      if (!state.favorites.some(f => isSameTrack(f, track))) {
        state.favorites.unshift(stampAddedAt(track));
        added++;
      }
    });
    localStorage.setItem('devsize_favorites', JSON.stringify(state.favorites.map(sanitizeTrackForStorage)));
    updateFavoritesBadge();
    updateFavoriteIcon();
    if (state.currentView === 'favorites' && typeof renderFavoritesView === 'function') renderFavoritesView();
    document.querySelectorAll('.track-row.track-selected .btn-row-fav svg').forEach(svg => {
      svg.setAttribute('fill', 'currentColor');
    });
    showToast(typeof t === 'function' ? t(`Added ${selected.length} tracks to favorites`) : `Added ${selected.length} tracks to favorites`, 'success');
    clearTrackSelection();
  });
}

const btnBulkRemove = document.getElementById('btn-bulk-remove');
if (btnBulkRemove) {
  btnBulkRemove.addEventListener('click', () => {
    if (!state.selectedTracks || state.selectedTracks.size === 0) return;
    const selected = Array.from(state.selectedTracks.values());
    if (state.currentView === 'local') {
      removeTracksFromLocalLibrary(Array.from(state.selectedTracks.values()));
      state.selectedTracks.clear();
      if (document.body) document.body.classList.remove('track-selection-mode');
      const bulkBar = document.getElementById('bulk-select-bar');
      if (bulkBar) bulkBar.classList.add('hidden');
      clearTrackSelection();
      showToast('Removed from Local Files');
      return;
    }
    if (state.currentView === 'playlist-detail') {
      const pl = state.playlists.find(p => p.id === state.currentPlaylistId);
      if (pl && Array.isArray(pl.tracks)) {
        const selKeys = new Set(Array.from(state.selectedTracks.keys()));
        pl.tracks = pl.tracks.filter(t => !selKeys.has(getTrackSelectionKey(t)));
        localStorage.setItem('devsize_playlists', JSON.stringify(state.playlists));
        openPlaylistDetail(state.currentPlaylistId);
        showToast(`Removed ${selected.length} track${selected.length === 1 ? '' : 's'}`);
      }
    } else if (state.currentView === 'queue') {
      const selKeys = new Set(Array.from(state.selectedTracks.keys()));
      state.queue = state.queue.filter(t => !selKeys.has(getTrackSelectionKey(t)));
      if (state.queueIndex >= state.queue.length) {
        state.queueIndex = Math.max(0, state.queue.length - 1);
      }
      const qCount = document.getElementById('queue-count');
      if (qCount) qCount.textContent = String(state.queue.length);
      if (el.queueCount) el.queueCount.textContent = String(state.queue.length);
      updateQueueBadge();
      renderQueueView();
      showToast(`Removed tracks from queue`);
    }
    clearTrackSelection();
  });
}

const btnBulkClear = document.getElementById('btn-bulk-clear');
if (btnBulkClear) {
  btnBulkClear.addEventListener('click', clearTrackSelection);
}

['btn-playlist-select', 'btn-album-select'].forEach(btnId => {
  const selBtn = document.getElementById(btnId);
  if (!selBtn) return;
  selBtn.addEventListener('click', () => {
    if (document.body && document.body.classList.contains('track-selection-mode')) {
      clearTrackSelection();
    } else {
      const activeTracks = getActiveViewTracksArray();
      if (!activeTracks || activeTracks.length === 0) return;
      if (!state.selectedTracks) state.selectedTracks = new Map();
      const first = activeTracks[0];
      const k = getTrackSelectionKey(first);
      if (k) state.selectedTracks.set(k, first);
      document.querySelectorAll('.track-row').forEach(row => {
        if (row._trackData && getTrackSelectionKey(row._trackData) === k) {
          row.classList.add('track-selected');
        }
      });
      updateBulkSelectBar();
    }
  });
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.selectedTracks && state.selectedTracks.size > 0) {
    clearTrackSelection();
  }
});

function createTrackRow(track, idx, currentCanonicalId, context, tracks, container) {
  if (track && track.artist) track.artist = stripYoutubeTopic(track.artist);
  if (typeof normalizeTrackMeta === 'function') normalizeTrackMeta(track);
  applyTrackRenames(track);
  const row = document.createElement('div');
  row.className = 'track-row';
  row._trackData = track;
  row.tabIndex = 0;
  const selKey = getTrackSelectionKey(track);
  if (state.selectedTracks && state.selectedTracks.has(selKey)) {
    row.classList.add('track-selected');
  }
  const canonicalId = getTrackCanonicalId(track);
  row.dataset.canonicalId = canonicalId;
  row.dataset.trackIndex = String(idx);
  row.dataset.trackId = track.id || '';
  row.dataset.trackTitle = track.title || '';
  row.dataset.trackArtist = track.artist || '';

  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      row.click();
    }
  });

  const isMatch = currentCanonicalId && canonicalId === currentCanonicalId;
  if (isMatch) {
    if (state.currentTrackContext === context && state.currentTrackIndexInContext >= 0) {
      if (state.currentTrackIndexInContext === idx) {
        row.classList.add('playing');
      }
    } else {
      row.classList.add('playing');
    }
  }

  const isFav = state.favorites.some(f => isSameTrack(f, track));
  const rowThumb = getTrackThumbUrl(track);
  const isAlbum = context === 'album';
  const index = (isAlbum && track.no) ? (Number(track.no) - 1) : idx;
  const albumArtist = (track.albumArtist || '').trim().toLowerCase();
  const trackArtist = (track.artist || '').trim().toLowerCase();
  const showArtist = isAlbum ? (Boolean(trackArtist) && Boolean(albumArtist) && trackArtist !== albumArtist) : true;
  const explicitTag = isTrackExplicit(track) ? '<span class="explicit-badge" title="Explicit">E</span>' : '';

  row.innerHTML = `
    <div class="track-row-num"><span class="track-num-text">${index + 1}</span><span class="tg-select-check"><svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg></span></div>
    ${!isAlbum ? `
    <div class="track-row-thumb-wrap">
      <svg class="track-row-fallback-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>
      ${rowThumb ? `<img class="track-row-thumb" src="${escapeHtml(rowThumb)}" alt="" onerror="this.style.display='none'">` : ''}
    </div>` : ''}
    <div class="track-row-info">
    <span class="track-row-title">${escapeHtml(track.title || 'untitled')}</span>
    <div class="track-row-artist-wrap">${explicitTag}${showArtist ? `<span class="track-row-artist" title="view artist profile">${escapeHtml(track.artist || 'unknown artist')}</span>` : ''}</div>
    </div>
    <span class="track-row-duration">${formatDuration(track.duration)}</span>
    <div class="track-row-actions">
    <button class="btn-icon-pill eclipse-share-action-btn btn-row-share" title="Copy share link" aria-label="Copy share link">
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 14 20 9 15 4"></polyline><path d="M4 20v-7a4 4 0 0 1 4-4h12"></path></svg>
    </button>
    <button class="btn-icon-pill btn-row-fav btn-fav btn-fav-track" title="favorite">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="${isFav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"></path></svg>
    </button>
    <button class="btn-icon-pill btn-row-trim" title="Trim best part">
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></svg>
    </button>
    <button class="btn-icon-pill btn-row-art" title="Customize cover & banner">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>
    </button>
    <button class="btn-icon-pill btn-row-add-playlist" title="add to playlist">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
    </button>
    ${(context === 'local' || track.platform === 'local') ? `
    <button class="btn-icon-pill btn-row-remove-local btn-remove-local delete-btn" title="Remove from library">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
    </button>` : `
    <button class="btn-icon-pill btn-row-more" title="download & options">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="2"></circle><circle cx="19" cy="12" r="2"></circle><circle cx="5" cy="12" r="2"></circle></svg>
    </button>`}
    ${context === 'playlist' ? `
      <button class="btn-icon-pill btn-row-remove-playlist delete-btn btn-delete btn-remove" title="remove from playlist">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
      </button>` : ''}
    ${context === 'queue' ? `
      <button class="btn-icon-pill btn-remove-from-queue delete-btn" title="Remove from queue" aria-label="Remove from queue">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
      </button>` : ''}
    </div>
  `;

  const artistEl = row.querySelector('.track-row-artist');
  if (artistEl) renderClickableArtists(artistEl, track.artist);

  let prefetchTimer = null;
  row.addEventListener('mouseenter', () => {
    if (track.url && track.platform !== 'local') {
      prefetchTimer = setTimeout(() => {
        fetch(`http://127.0.0.1:${state.serverPort}/api/prefetch?url=${encodeURIComponent(track.url)}&id=${encodeURIComponent(track.id)}&platform=${track.platform || state.platform}`).catch(() => {});
      }, 120);
    }
  });
  row.addEventListener('mouseleave', () => {
    if (prefetchTimer) {
      clearTimeout(prefetchTimer);
      prefetchTimer = null;
    }
  });

  row.addEventListener('click', (e) => {
    if (e.target.closest('.track-row-actions') || e.target.closest('.artist-link-part')) return;
    if (e.target.classList.contains('track-row-artist')) {
      e.stopPropagation();
      openArtistProfile(track.artist);
      return;
    }
    if (e.shiftKey || e.ctrlKey || e.metaKey || e.target.closest('.tg-select-check')) {
      e.preventDefault();
      e.stopPropagation();
      if (!state.selectedTracks) state.selectedTracks = new Map();
      if (e.shiftKey && state.lastClickedTrackRow && state.lastClickedTrackRow.parentElement && state.lastClickedTrackRow.parentElement === row.parentElement) {
        const siblings = Array.from(row.parentElement.querySelectorAll('.track-row'));
        const idxA = siblings.indexOf(state.lastClickedTrackRow);
        const idxB = siblings.indexOf(row);
        if (idxA !== -1 && idxB !== -1) {
          const [start, end] = idxA < idxB ? [idxA, idxB] : [idxB, idxA];
          for (let i = start; i <= end; i++) {
            const r = siblings[i];
            r.classList.add('track-selected');
            if (r._trackData) state.selectedTracks.set(getTrackSelectionKey(r._trackData), r._trackData);
          }
        }
      } else {
        const key = getTrackSelectionKey(track);
        if (state.selectedTracks.has(key)) {
          state.selectedTracks.delete(key);
          row.classList.remove('track-selected');
        } else {
          state.selectedTracks.set(key, track);
          row.classList.add('track-selected');
        }
      }
      state.lastClickedTrackRow = row;
      updateBulkSelectBar();
      return;
    }
    state.lastClickedTrackRow = row;
    if (typeof currentCanonicalId === 'function') {
      currentCanonicalId(track, idx);
      row.blur();
      return;
    }
    if (context === 'search') {
      state.isRadioQueue = false;
      state.queue = [...tracks];
      if (typeof recordSearchTrack === 'function') recordSearchTrack(track);
      playTrack(track, tracks, idx, 'search');
      row.blur();
      return;
    }
    let clickIndex = idx;
    let currentList = tracks;
    if (context === 'favorites') {
      currentList = sortTracksFor('favorites', state.favorites);
      clickIndex = currentList.findIndex(t => isSameTrack(t, track));
    } else if (context === 'playlist') {
      const pl = state.playlists.find(p => p.id === state.currentPlaylistId);
      if (pl && pl.tracks) {
        currentList = sortTracksFor('playlist', pl.tracks);
        clickIndex = currentList.findIndex(t => isSameTrack(t, track));
      }
    } else if (context === 'artist') {
      const artistTracks = (state.currentArtistData && state.currentArtistData.tracks) || tracks;
      if (artistTracks) {
        currentList = artistTracks;
        clickIndex = artistTracks.findIndex(t => isSameTrack(t, track));
      }
    } else if (context === 'queue') {
      currentList = state.queue;
      clickIndex = idx;
    }
    playTrack(track, currentList, clickIndex >= 0 ? clickIndex : idx, context);
    row.blur();
  });

  const btnShare = row.querySelector('.btn-row-share');
  if (btnShare) {
    btnShare.addEventListener('click', (e) => {
      e.stopPropagation();
      executeCopyShareLink(track);
    });
  }

  const btnTrim = row.querySelector('.btn-row-trim');
  if (btnTrim) {
    btnTrim.addEventListener('click', (e) => {
      e.stopPropagation();
      openTrimModalForTrack(track);
    });
  }

  const btnFav = row.querySelector('.btn-row-fav');
  if (btnFav) {
    btnFav.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFavoriteTrack(track);
      const isFavNow = state.favorites.some(f => isSameTrack(f, track));
      const svg = btnFav.querySelector('svg');
      if (svg) svg.setAttribute('fill', isFavNow ? 'currentColor' : 'none');
    });
  }

  const btnArt = row.querySelector('.btn-row-art');
  if (btnArt) {
    btnArt.addEventListener('click', (e) => {
      e.stopPropagation();
      openTrackArtModal(track, btnArt);
    });
  }

  const btnMore = row.querySelector('.btn-row-more');
  if (btnMore) {
    btnMore.addEventListener('click', (e) => {
      e.stopPropagation();
      openTrackContextMenu(e, track, { row });
    });
  }

  const btnAddPl = row.querySelector('.btn-row-add-playlist');
  if (btnAddPl) {
    btnAddPl.addEventListener('click', (e) => {
      e.stopPropagation();
      openAddToPlaylistModal(track);
    });
  }

  const btnRemPl = row.querySelector('.btn-row-remove-playlist');
  if (btnRemPl) {
    btnRemPl.addEventListener('click', (e) => {
      e.stopPropagation();
      removeTrackFromCurrentPlaylist(track.id);
    });
  }

  const btnRemLocal = row.querySelector('.btn-row-remove-local, .btn-remove-local');
  if (btnRemLocal) {
    btnRemLocal.addEventListener('click', (e) => {
      e.stopPropagation();
      removeTracksFromLocalLibrary([track]);
    });
  }

  const btnRemQueue = row.querySelector('.btn-remove-from-queue');
  if (btnRemQueue) {
    btnRemQueue.addEventListener('click', (e) => {
      e.stopPropagation();
      const targetIdx = typeof row.dataset.trackIndex !== 'undefined' ? parseInt(row.dataset.trackIndex, 10) : idx;
      removeTrackFromQueue(Number.isNaN(targetIdx) ? idx : targetIdx);
    });
  }

  bindTrackHoverTip(row, track);
  row.addEventListener('contextmenu', (e) => {
    const currentIndex = typeof row.dataset.trackIndex !== 'undefined' ? parseInt(row.dataset.trackIndex, 10) : idx;
    openTrackContextMenu(e, track, { row, index: Number.isNaN(currentIndex) ? idx : currentIndex });
  });

  return row;
}

function renderTracks(container, tracks, context = 'search') {
  if (!container) return;

  const scrollParent = document.querySelector('.main-content');
  if (container._vScrollHandler && scrollParent) {
    scrollParent.removeEventListener('scroll', container._vScrollHandler);
  }

  container.innerHTML = '';

  if (!tracks || tracks.length === 0) {
    container.style.paddingTop = '0px';
    container.style.paddingBottom = '0px';
    const emptyMessages = {
      search: 'No matching tracks. Try a different search',
      favorites: 'No favourites yet. Use the heart on a track to save it',
      playlist: 'This playlist is empty',
      local: 'Your library is empty. Add some music to get started'
    };
    container.innerHTML = `<div class="empty-hint">${emptyMessages[context] || 'No tracks to show'}</div>`;
    return;
  }

  const itemHeight = 64;
  const overscan = 15;

  function renderChunk() {
    if (!scrollParent || container._isDraggingReorder) return;
    const parentRect = scrollParent.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const relativeTop = containerRect.top - parentRect.top + scrollParent.scrollTop;

    const visibleTop = Math.max(0, scrollParent.scrollTop - relativeTop);
    let startIndex = Math.floor(visibleTop / itemHeight) - overscan;
    let endIndex = Math.ceil((visibleTop + scrollParent.clientHeight) / itemHeight) + overscan;

    startIndex = Math.floor(startIndex / 5) * 5;
    endIndex = Math.ceil(endIndex / 5) * 5;

    startIndex = Math.max(0, startIndex);
    endIndex = Math.min(tracks.length, endIndex);

    if (container._lastStartIndex === startIndex && container._lastEndIndex === endIndex) return;
    container._lastStartIndex = startIndex;
    container._lastEndIndex = endIndex;

    const currentCanonicalId = state.currentTrack ? getTrackCanonicalId(state.currentTrack) : '';
    const fragment = document.createDocumentFragment();
    for (let idx = startIndex; idx < endIndex; idx++) {
      const track = tracks[idx];
      const row = createTrackRow(track, idx, currentCanonicalId, context, tracks, container);
      if (container._hasInitialRendered) row.style.animation = 'none';
      fragment.appendChild(row);
    }

    container.innerHTML = '';
    container.style.paddingTop = `${startIndex * itemHeight}px`;
    container.style.paddingBottom = `${(tracks.length - endIndex) * itemHeight}px`;
    container.appendChild(fragment);
    container._hasInitialRendered = true;
    highlightPlayingRow();
  }

  container._vScrollHandler = () => {
    if (!container._ticking) {
      window.requestAnimationFrame(() => {
        renderChunk();
        container._ticking = false;
      });
      container._ticking = true;
    }
  };

  if (scrollParent) {
    scrollParent.addEventListener('scroll', container._vScrollHandler, { passive: true });
  }

  container._hasInitialRendered = false;
  container._lastStartIndex = -1;
  container._lastEndIndex = -1;
  renderChunk();
}

function highlightPlayingRow() {
  const currentCanonicalId = state.currentTrack ? getTrackCanonicalId(state.currentTrack) : '';
  const rows = document.querySelectorAll('.track-row');

  if (!currentCanonicalId) {
    rows.forEach(r => r.classList.remove('playing'));
    return;
  }

  const containers = new Set();
  rows.forEach(r => {
    r.classList.remove('playing');
    if (r.parentElement) containers.add(r.parentElement);
  });

  containers.forEach(container => {
    const matches = Array.from(container.querySelectorAll('.track-row')).filter(r => r.dataset.canonicalId === currentCanonicalId);
    if (matches.length === 1) {
      matches[0].classList.add('playing');
    } else if (matches.length > 1) {
      const targetIdx = String(state.currentTrackIndexInContext);
      const exact = matches.find(r => r.dataset.trackIndex === targetIdx);
      if (exact) {
        exact.classList.add('playing');
      } else {
        matches[0].classList.add('playing');
      }
    }
  });
}

function toggleFavoriteTrack(track) {
  if (!track) return;
  const exists = state.favorites.some(f => isSameTrack(f, track));

  if (exists) {
    state.favorites = state.favorites.filter(f => !isSameTrack(f, track));
  } else {
    state.favorites.unshift(stampAddedAt(track));
  }

  localStorage.setItem('devsize_favorites', JSON.stringify(state.favorites.map(sanitizeTrackForStorage)));
  updateFavoritesBadge();
  updateFavoriteIcon();
  if (state.currentView === 'favorites') renderFavoritesView();
}

function updateFavoriteIcon() {
  if (!el.favIcon) return;
  if (!state.currentTrack) {
    el.favIcon.setAttribute('fill', 'none');
    return;
  }
  const isFav = state.favorites.some(f => isSameTrack(f, state.currentTrack));
  el.favIcon.setAttribute('fill', isFav ? 'currentColor' : 'none');
}

function setNavCount(node, count) {
  if (!node) return;
  node.textContent = count;
  const nav = node.closest('.nav-item');
  node.hidden = !count || !!(nav && nav.classList.contains('active'));
}

function updateFavoritesBadge() {
  setNavCount(el.favoritesCount, state.favorites.length);
}

const TRACK_SORT_KEYS = { favorites: 'eclipse_favorites_sort', playlist: 'eclipse_playlist_sort', album: 'eclipse_album_sort' };

function getTrackSortMode(kind) {
  const stored = localStorage.getItem(TRACK_SORT_KEYS[kind]);
  return TRACK_SORT_MODES.includes(stored) ? stored : 'manual';
}

function setTrackSortMode(kind, mode) {
  localStorage.setItem(TRACK_SORT_KEYS[kind], TRACK_SORT_MODES.includes(mode) ? mode : 'manual');
}

function sortTracksFor(kind, tracks) {
  return sortTracks(tracks, getTrackSortMode(kind));
}

function sanitizeTrackForStorage(track) {
  if (!track || typeof track !== 'object') return track;
  const clone = { ...track };
  delete clone._preloadedStreamUrl;
  delete clone._preloadedStreamUrlExpires;
  delete clone._errorRetryStage;
  return clone;
}

function stampAddedAt(track) {
  return sanitizeTrackForStorage({ ...track, addedAt: Date.now() });
}

function renderFavoritesView() {
  if (Array.isArray(state.favorites)) {
    let favChanged = false;
    state.favorites.forEach(t => {
      if (!t) return;
      const ot = t.title;
      const oa = t.artist;
      normalizeTrackMeta(t);
      if (t.title !== ot || t.artist !== oa) favChanged = true;
    });
    if (favChanged) {
      try { localStorage.setItem('devsize_favorites', JSON.stringify(state.favorites.map(sanitizeTrackForStorage))); } catch (_) {}
    }
  }
  const query = el.favoritesSearchInput ? el.favoritesSearchInput.value.trim().toLowerCase() : '';
  let filtered = state.favorites;
  if (query) {
    filtered = state.favorites.filter(t =>
      (t.title && t.title.toLowerCase().includes(query)) ||
      (t.artist && t.artist.toLowerCase().includes(query))
    );
  }
  filtered = sortTracksFor('favorites', filtered);
  if (typeof el !== 'undefined' && el.favoritesSort) {
    el.favoritesSort.value = getTrackSortMode('favorites');
    const favLabel = document.getElementById('favorites-sort-label');
    const favMenu = document.getElementById('favorites-sort-menu');
    if (favMenu) {
      favMenu.querySelectorAll('.m3-dropdown-option').forEach(opt => {
        const isSel = opt.dataset.value === el.favoritesSort.value;
        opt.classList.toggle('selected', isSel);
        if (isSel && favLabel) favLabel.textContent = opt.textContent;
      });
    }
  }
  if (el.favoritesSubtitle) el.favoritesSubtitle.textContent = query ? `${filtered.length} of ${state.favorites.length} tracks` : `${state.favorites.length} tracks saved`;
  if (el.favoritesTracksList) renderTracks(el.favoritesTracksList, filtered, 'favorites');
}

function setupSortDropdown(dropdownId, triggerId, menuId, labelId, selectEl) {
  const dropdown = document.getElementById(dropdownId);
  const trigger = document.getElementById(triggerId);
  const menu = document.getElementById(menuId);
  const label = document.getElementById(labelId);
  if (!dropdown || !trigger || !menu || !selectEl) return;

  function syncUI() {
    const val = selectEl.value;
    const opts = menu.querySelectorAll('.m3-dropdown-option');
    opts.forEach(opt => {
      const isSel = opt.dataset.value === val;
      opt.classList.toggle('selected', isSel);
      if (isSel && label) label.textContent = opt.textContent;
    });
  }

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.classList.toggle('open');
  });

  document.addEventListener('click', () => {
    dropdown.classList.remove('open');
  });

  menu.querySelectorAll('.m3-dropdown-option').forEach(opt => {
    opt.addEventListener('click', (e) => {
      e.stopPropagation();
      const val = opt.dataset.value;
      dropdown.classList.remove('open');
      if (selectEl.value !== val) {
        selectEl.value = val;
        selectEl.dispatchEvent(new Event('change'));
      }
      syncUI();
    });
  });

  selectEl.addEventListener('change', syncUI);
  syncUI();
}

if (typeof el !== 'undefined' && el.favoritesSearchInput) {
  el.favoritesSearchInput.addEventListener('input', () => renderFavoritesView());
}

if (typeof el !== 'undefined' && el.favoritesSort) {
  el.favoritesSort.addEventListener('change', () => {
    setTrackSortMode('favorites', el.favoritesSort.value);
    renderFavoritesView();
  });
  setupSortDropdown('favorites-sort-dropdown', 'favorites-sort-trigger', 'favorites-sort-menu', 'favorites-sort-label', el.favoritesSort);
}

function updateHistoryBadge() {
  setNavCount(el.historyCount, state.history.length);
}

function renderHistoryView() {
  updateHistoryBadge();
  if (el.historyTracksList) renderTracks(el.historyTracksList, state.history, 'history');
}

function updateQueueBadge() {
  if (nextTrackCoordinator) nextTrackCoordinator.cancel('queue_updated');
  setNavCount(el.queueCount, state.queue.length);
  try { window.dispatchEvent(new CustomEvent('queueupdated', { detail: { length: state.queue.length } })); } catch (_) {}
}

function removeTrackFromQueue(qIdx) {
  if (typeof qIdx !== 'number' || qIdx < 0 || qIdx >= state.queue.length) return;
  state.queue.splice(qIdx, 1);
  if (qIdx < state.queueIndex) state.queueIndex--;
  else if (qIdx === state.queueIndex && state.queue.length > 0) {
    state.queueIndex = Math.min(state.queueIndex, state.queue.length - 1);
  }
  const qCount = document.getElementById('queue-count');
  if (qCount) qCount.textContent = String(state.queue.length);
  if (el.queueCount) el.queueCount.textContent = String(state.queue.length);
  updateQueueBadge();
  renderQueueView();
}
const renderQueue = renderQueueView;
window.renderQueue = renderQueue;
window.removeTrackFromQueue = removeTrackFromQueue;

function renderQueueView() {
  updateQueueBadge();
  if (!el.queueTracksList) return;
  renderTracks(el.queueTracksList, state.queue, 'queue');

  el.queueTracksList.querySelectorAll('.track-row').forEach((row, idx) => {
    const actions = row.querySelector('.track-row-actions');
    if (actions && !actions.querySelector('.btn-remove-from-queue')) {
      const btnRem = document.createElement('button');
      btnRem.type = 'button';
      btnRem.className = 'btn-icon-pill btn-remove-from-queue delete-btn';
      btnRem.title = typeof t === 'function' ? t('Remove from queue') : 'Remove from queue';
      btnRem.setAttribute('aria-label', 'Remove from queue');
      btnRem.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
      btnRem.addEventListener('click', (e) => {
        e.stopPropagation();
        const targetIdx = typeof row.dataset.trackIndex !== 'undefined' ? parseInt(row.dataset.trackIndex, 10) : idx;
        removeTrackFromQueue(Number.isNaN(targetIdx) ? idx : targetIdx);
      });
      actions.appendChild(btnRem);
    }
  });

  if (!el.queueTracksList._sortEnabled) {
    el.queueTracksList._sortEnabled = true;
    const sortFn = (typeof enableTrackSort === 'function')
      ? enableTrackSort
      : ((typeof window !== 'undefined' && (window.enableTrackSort || (window.TrackSort && window.TrackSort.enableTrackSort))) || null);
    if (typeof sortFn === 'function') {
      sortFn(el.queueTracksList, (fromIdx, toIdx) => {
        if (fromIdx === toIdx || fromIdx < 0 || toIdx < 0 || fromIdx >= state.queue.length || toIdx >= state.queue.length) return;
        const [moved] = state.queue.splice(fromIdx, 1);
        state.queue.splice(toIdx, 0, moved);
        if (state.queueIndex === fromIdx) {
          state.queueIndex = toIdx;
        } else if (fromIdx < state.queueIndex && toIdx >= state.queueIndex) {
          state.queueIndex--;
        } else if (fromIdx > state.queueIndex && toIdx <= state.queueIndex) {
          state.queueIndex++;
        }
        renderQueueView();
      });
    }
  }
}
window.renderQueueView = renderQueueView;

function updateLocalBadge() {
  setNavCount(el.localCount, (state.localTracks && state.localTracks.length) || 0);
}

function refreshNavBadges() {
  updateFavoritesBadge();
  updateAlbumsCount();
  updateLocalBadge();
  updateHistoryBadge();
  updateQueueBadge();
}

function mergeLocalFiles(newTracks) {
  if (!Array.isArray(newTracks) || newTracks.length === 0) return;
  if (!Array.isArray(state.localFiles)) state.localFiles = [];
  if (!Array.isArray(state.localTracks)) state.localTracks = [];

  // Remove explicitly added tracks from removed local paths blacklist
  try {
    const removedBlacklist = safeJson('eclipse_removed_local_paths', []);
    if (Array.isArray(removedBlacklist) && removedBlacklist.length > 0) {
      const addedSet = new Set();
      for (const t of newTracks) {
        if (!t) continue;
        if (t.path) addedSet.add(String(t.path));
        if (t.filePath) addedSet.add(String(t.filePath));
        if (t.url) addedSet.add(String(t.url));
        if (t.id) addedSet.add(String(t.id));
      }
      const updatedBlacklist = removedBlacklist.filter(p => !addedSet.has(String(p)));
      localStorage.setItem('eclipse_removed_local_paths', JSON.stringify(updatedBlacklist));
    }
  } catch (_) {}

  const existingPaths = new Set(
    [...(state.localFiles || []), ...(state.localTracks || [])]
      .map(t => t.path || t.filePath || t.url)
      .filter(Boolean)
  );
  let added = 0;
  for (const track of newTracks) {
    const p = track && (track.path || track.filePath || track.url);
    if (track && p && !existingPaths.has(p)) {
      state.localFiles.push(track);
      existingPaths.add(p);
      added++;
    }
  }
  state.localTracks = state.localFiles;
  const serialized = JSON.stringify(state.localFiles);
  try {
    localStorage.setItem('eclipse_local_files', serialized);
    localStorage.setItem('devsize_local_files', serialized);
    localStorage.setItem('eclipse_local_tracks', serialized);
    localStorage.setItem('devsize_local_tracks', serialized);
    if (typeof saveLocalTracks === 'function') saveLocalTracks();
  } catch (_) {}
  renderLocalFiles();
  if (added > 0) {
    showToast(`Added ${added} track${added === 1 ? '' : 's'}`);
  }
}

async function addLocalFolder() {
  if (!window.electronAPI || !window.electronAPI.pickLocalFolder) return;
  try {
    const tracks = await window.electronAPI.pickLocalFolder();
    if (tracks && tracks.length > 0) {
      mergeLocalFiles(tracks);
    }
  } catch (e) {
    console.warn('Pick local folder error:', e);
  }
}

async function addLocalFiles() {
  if (window.electronAPI && window.electronAPI.pickLocalFiles) {
    try {
      const tracks = await window.electronAPI.pickLocalFiles();
      if (tracks && tracks.length > 0) {
        mergeLocalFiles(tracks);
      }
    } catch (e) {
      console.warn('Pick local files error:', e);
    }
  }
}

let localRescanDone = false;

async function renderLocalFiles(forceFetch = false) {
  if (!Array.isArray(state.localFiles)) {
    state.localFiles = safeArray('eclipse_local_files');
  }

  const removedBlacklist = new Set(safeJson('eclipse_removed_local_paths', []).map(String));
  const shouldKeepLocal = (t) => {
    if (!t) return false;
    const p = String(t.path || t.filePath || t.url || '');
    const id = String(t.id || '');
    return (!p || !removedBlacklist.has(p)) && (!id || !removedBlacklist.has(id));
  };

  if (removedBlacklist.size > 0) {
    if (Array.isArray(state.localFiles)) state.localFiles = state.localFiles.filter(shouldKeepLocal);
    if (Array.isArray(state.localTracks)) state.localTracks = state.localTracks.filter(shouldKeepLocal);
  }

  if (state.localFiles.length > 0) {
    state.localTracks = state.localFiles;
  } else if (Array.isArray(state.localTracks) && state.localTracks.length > 0) {
    state.localFiles = state.localTracks;
  }

  if (!localRescanDone && window.electronAPI && window.electronAPI.rescanLocalMetadata && state.localFiles.length > 0 && state.localFiles.length <= 150) {
    localRescanDone = true;
    const needRescan = state.localFiles.filter(t => t.path && (!t.thumbnail || t.artist === 'Unknown Artist')).slice(0, 60);
    if (needRescan.length > 0) {
      const paths = needRescan.map(t => t.path);
      window.electronAPI.rescanLocalMetadata(paths).then(rescannedTracks => {
        if (Array.isArray(rescannedTracks) && rescannedTracks.length > 0) {
          const map = new Map(rescannedTracks.filter(shouldKeepLocal).map(t => [t.path, t]));
          let updated = false;
          state.localFiles.forEach((t, i) => {
            if (t.path && map.has(t.path)) {
              const fresh = map.get(t.path);
              state.localFiles[i] = { ...t, ...fresh };
              updated = true;
            }
          });
          if (updated) {
            const serialized = JSON.stringify(state.localFiles);
            localStorage.setItem('eclipse_local_files', serialized);
            localStorage.setItem('devsize_local_files', serialized);
            localStorage.setItem('eclipse_local_tracks', serialized);
            localStorage.setItem('devsize_local_tracks', serialized);
            state.localTracks = state.localFiles;
            if (state.currentView === 'local') {
              renderLocalFiles();
            }
          }
        }
      }).catch(err => console.warn('Rescan local metadata error:', err));
    }
  }

  const localAlbumsRow = el.localAlbumsRow || document.getElementById('local-albums-row');
  if (localAlbumsRow) {
    const albumMap = new Map();
    (state.localFiles || []).forEach(t => {
      const albName = (t.album || '').trim();
      if (!albName) return;
      if (!albumMap.has(albName)) {
        albumMap.set(albName, {
          name: albName,
          artist: t.artist || '',
          cover: t.cover || t.thumbnail || '',
          tracks: []
        });
      }
      const albObj = albumMap.get(albName);
      if (!albObj.cover && (t.cover || t.thumbnail)) {
        albObj.cover = t.cover || t.thumbnail;
      }
      albObj.tracks.push(t);
    });

    for (const [key, alb] of Array.from(albumMap.entries())) {
      if (!(alb.tracks.length >= 2 || alb.cover)) {
        albumMap.delete(key);
      }
    }

    if (albumMap.size > 0) {
      localAlbumsRow.style.display = 'flex';
      localAlbumsRow.innerHTML = Array.from(albumMap.values()).slice(0, 30).map(alb => {
        const count = alb.tracks.length;
        const sub = alb.artist ? `${escapeHtml(alb.artist)} · ${count} track${count === 1 ? '' : 's'}` : `${count} track${count === 1 ? '' : 's'}`;
        return `
          <div class="search-album-card" role="button" tabindex="0" data-album="${escapeHtml(alb.name)}">
            ${alb.cover ? `<img class="search-album-cover" src="${escapeHtml(alb.cover)}" alt="${escapeHtml(alb.name)}" loading="lazy" onerror="this.style.display='none'" />` : '<div class="search-album-cover" style="display:flex;align-items:center;justify-content:center;background:var(--md-sys-color-surface-container-high);"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--md-sys-color-outline);"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg></div>'}
            <div class="search-album-info">
              <span class="search-album-title" title="${escapeHtml(alb.name)}">${escapeHtml(alb.name)}</span>
              <span class="search-album-sub" title="${sub}">${sub}</span>
            </div>
          </div>
        `;
      }).join('');

      localAlbumsRow.querySelectorAll('.search-album-card').forEach(card => {
        const albName = card.dataset.album;
        const alb = albumMap.get(albName);
        if (!alb) return;
        const openThisAlbum = () => {
          const sortedTracks = [...alb.tracks].sort((a, b) => (a.trackNumber || 0) - (b.trackNumber || 0));
          openAlbum({
            id: 'local_alb_' + alb.name,
            title: alb.name,
            artist: alb.artist,
            cover: alb.cover,
            tracks: sortedTracks,
            type: 'Local Album'
          });
        };
        card.addEventListener('click', openThisAlbum);
        card.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            openThisAlbum();
          }
        });
      });
    } else {
      localAlbumsRow.style.display = 'none';
      localAlbumsRow.innerHTML = '';
    }
  }

  updateLocalBadge();
  const query = el.localSearchInput ? el.localSearchInput.value.trim().toLowerCase() : '';
  const allTracks = (state.localFiles && state.localFiles.length > 0) ? state.localFiles : (state.localTracks || []);
  let filtered = allTracks;
  if (query) {
    filtered = filtered.filter(t =>
      (t.title && t.title.toLowerCase().includes(query)) ||
      (t.artist && t.artist.toLowerCase().includes(query)) ||
      (t.album && t.album.toLowerCase().includes(query))
    );
  }
  const localSortEl = el.localSort || document.getElementById('local-sort');
  if (localSortEl) {
    const localSortMode = localStorage.getItem('eclipse_local_sort') || 'manual';
    if (localSortMode === 'title-asc') {
      filtered = [...filtered].sort((a, b) => (a.title || '').localeCompare(b.title || ''));
    } else if (localSortMode === 'added-desc') {
      filtered = [...filtered].reverse();
    } else if (localSortMode === 'added-asc') {
      filtered = [...filtered];
    }
    localSortEl.value = localSortMode;
    const localLabel = document.getElementById('local-sort-label');
    const localMenu = document.getElementById('local-sort-menu');
    if (localMenu) {
      localMenu.querySelectorAll('.m3-dropdown-option').forEach(opt => {
        const isSel = opt.dataset.value === localSortMode;
        opt.classList.toggle('selected', isSel);
        if (isSel && localLabel) localLabel.textContent = opt.textContent;
      });
    }
  }
  if (el.localSubtitle) {
    el.localSubtitle.textContent = query
      ? `${filtered.length} of ${allTracks.length} tracks`
      : `${allTracks.length} tracks in library`;
  }
  if (el.localTracksList) {
    if (allTracks.length === 0) {
      el.localTracksList.style.paddingTop = '0px';
      el.localTracksList.style.paddingBottom = '0px';
      el.localTracksList.innerHTML = `
        <div class="empty-hint" style="display:flex;flex-direction:column;align-items:center;gap:12px;">
          <span>No local tracks in library yet.</span>
          <div style="display:inline-flex;align-items:center;gap:10px;">
            <button class="btn-pill-primary" id="btn-add-local-files-empty">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
              Add files
            </button>
            <button class="btn-outline-pill" id="btn-add-local-folder-empty" type="button" style="display:inline-flex;align-items:center;gap:6px;"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg><span>Add folder</span></button>
          </div>
        </div>`;
      const emptyBtn = el.localTracksList.querySelector('#btn-add-local-files-empty');
      if (emptyBtn) emptyBtn.addEventListener('click', addLocalFiles);
      const emptyFolderBtn = el.localTracksList.querySelector('#btn-add-local-folder-empty');
      if (emptyFolderBtn) emptyFolderBtn.addEventListener('click', addLocalFolder);
    } else {
      renderTracks(el.localTracksList, filtered, 'local');
    }
  }
}

const renderLocalTracks = renderLocalFiles;
window.renderLocalTracks = renderLocalTracks;
const renderLocalView = renderLocalFiles;
window.renderLocalFiles = renderLocalFiles;
window.renderLocalView = renderLocalView;

if (typeof el !== 'undefined' && el.localSearchInput) {
  el.localSearchInput.addEventListener('input', () => renderLocalView(false));
}

const localSortSelect = document.getElementById('local-sort');
if (localSortSelect) {
  localSortSelect.value = localStorage.getItem('eclipse_local_sort') || 'manual';
  localSortSelect.addEventListener('change', () => {
    localStorage.setItem('eclipse_local_sort', localSortSelect.value);
    renderLocalFiles(false);
  });
  if (typeof setupSortDropdown === 'function') {
    setupSortDropdown('local-sort-dropdown', 'local-sort-trigger', 'local-sort-menu', 'local-sort-label', localSortSelect);
  }
}

async function importLocalFiles() {
  if (!window.electronAPI || !window.electronAPI.importAudioFiles) return;
  try {
    const items = await window.electronAPI.importAudioFiles();
    if (!items || items.length === 0) return;

    await fetch(`http://127.0.0.1:${state.serverPort}/api/library-add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items })
    });

    if (state.currentView === 'local') renderLocalView(true);

    let idx = 0;
    async function worker() {
      while (idx < items.length) {
        const item = items[idx++];
        if (!item || !item.id) continue;
        await new Promise(resolve => {
          const url = `http://127.0.0.1:${state.serverPort}/api/library-file?id=${encodeURIComponent(item.id)}`;
          const a = new Audio(url);
          a.preload = 'metadata';
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            a.src = '';
            resolve();
          };
          a.onloadedmetadata = async () => {
            const dur = Math.round(a.duration || 0);
            if (dur > 0) {
              try {
                await fetch(`http://127.0.0.1:${state.serverPort}/api/library-update`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ id: item.id, duration: dur })
                });
              } catch (e) {}
            }
            finish();
          };
          a.onerror = () => finish();
          setTimeout(finish, 5000);
        });
      }
    }
    await Promise.all([worker(), worker()]);

    await renderLocalView(true);
    showToast(`Added ${items.length} tracks`);
  } catch (e) {
    console.warn('Import audio files error:', e);
  }
}

function proxiedThumb(src) {
  if (!src || typeof src !== 'string') return '';
  return src;
}

function getTrackThumbUrl(track) {
  if (!track) return '';
  const o = getTrackArt(track).cover;
  if (o) return proxiedThumb(o, track);
  if (track.localThumbnail) return track.localThumbnail;
  const base = track.thumbnail || track.cover || track.image || track.artworkUrl || '';
  if (base) return proxiedThumb(base, track);
  if (track.id && /^[a-zA-Z0-9_-]{11}$/.test(track.id)) {
    return `https://i.ytimg.com/vi/${track.id}/hqdefault.jpg`;
  }
  return '';
}

function renderPlaylistCover(container, playlist, size = 64) {
  if (!container) return;
  container.innerHTML = '';
  container.classList.add('playlist-cover-art');

  function renderFallback() {
    container.innerHTML = '';
    container.classList.remove('cover-single', 'cover-empty');
    const tracks = (playlist && playlist.tracks) ? playlist.tracks : [];
    let firstThumb = null;
    for (const t of tracks) {
      const src = getTrackThumbUrl(t);
      if (src) {
        firstThumb = src;
        break;
      }
    }

    if (firstThumb) {
      container.classList.add('cover-single');
      const img = document.createElement('img');
      img.className = 'cover-single-img';
      img.src = firstThumb;
      img.alt = '';
      img.loading = 'lazy';
      img.style.objectFit = 'cover';
      img.onerror = () => {
        container.classList.remove('cover-single');
        container.classList.add('cover-empty');
        container.innerHTML = `<svg width="${Math.round(size * 0.45)}" height="${Math.round(size * 0.45)}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>`;
      };
      container.appendChild(img);
    } else {
      container.classList.add('cover-empty');
      container.innerHTML = `
        <svg width="${Math.round(size * 0.45)}" height="${Math.round(size * 0.45)}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M9 18V5l12-2v13"></path>
          <circle cx="6" cy="18" r="3"></circle>
          <circle cx="18" cy="16" r="3"></circle>
        </svg>
      `;
    }
  }

  if (playlist && playlist.cover && typeof playlist.cover === 'string' && playlist.cover.trim()) {
    container.classList.add('cover-single');
    const img = document.createElement('img');
    img.className = 'cover-single-img';
    img.src = playlist.cover.trim();
    img.alt = '';
    img.loading = 'lazy';
    img.style.objectFit = 'cover';
    img.onerror = () => {
      renderFallback();
    };
    container.appendChild(img);
    return;
  }

  renderFallback();
}

let __playlistSelectMode = false;
const __selectedPlaylistIds = new Set();

function renderPlaylistsList() {
  if (!el.playlistsList) return;
  el.playlistsList.innerHTML = '';
  if (!state.playlists || state.playlists.length === 0) {
    __playlistSelectMode = false;
    __selectedPlaylistIds.clear();
    const emptyMsg = document.createElement('div');
    emptyMsg.className = 'playlists-empty-note';
    emptyMsg.style.cssText = 'padding: 24px 12px; text-align: center; color: var(--md-sys-color-on-surface-variant); font-size: calc(13px * var(--font-scale, 1));';
    emptyMsg.textContent = 'No playlists yet';
    el.playlistsList.appendChild(emptyMsg);
    return;
  }

  const toolbar = document.createElement('div');
  toolbar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:6px;padding:4px 8px 8px;';
  const btnToggleSelect = document.createElement('button');
  btnToggleSelect.className = 'btn-text';
  btnToggleSelect.style.cssText = 'font-size:12px;padding:4px 8px;border-radius:8px;cursor:pointer;';
  btnToggleSelect.textContent = __playlistSelectMode ? 'Hủy' : 'Chọn nhiều';
  btnToggleSelect.onclick = () => {
    __playlistSelectMode = !__playlistSelectMode;
    if (!__playlistSelectMode) __selectedPlaylistIds.clear();
    renderPlaylistsList();
  };
  toolbar.appendChild(btnToggleSelect);

  if (__playlistSelectMode) {
    const btnSelectAll = document.createElement('button');
    btnSelectAll.className = 'btn-text';
    btnSelectAll.style.cssText = 'font-size:12px;padding:4px 8px;border-radius:8px;cursor:pointer;';
    const allSelected = state.playlists.every(p => __selectedPlaylistIds.has(p.id));
    btnSelectAll.textContent = allSelected ? 'Bỏ chọn' : 'Tất cả';
    btnSelectAll.onclick = () => {
      if (allSelected) __selectedPlaylistIds.clear();
      else state.playlists.forEach(p => __selectedPlaylistIds.add(p.id));
      renderPlaylistsList();
    };
    toolbar.appendChild(btnSelectAll);

    const btnDeleteSel = document.createElement('button');
    btnDeleteSel.className = 'btn-text';
    btnDeleteSel.style.cssText = 'font-size:12px;padding:4px 10px;border-radius:8px;background:rgba(239,68,68,0.18);color:#f87171;cursor:pointer;font-weight:600;';
    btnDeleteSel.textContent = `Xóa (${__selectedPlaylistIds.size})`;
    btnDeleteSel.disabled = __selectedPlaylistIds.size === 0;
    btnDeleteSel.onclick = () => {
      if (__selectedPlaylistIds.size === 0) return;
      state.playlists = state.playlists.filter(p => !__selectedPlaylistIds.has(p.id));
      localStorage.setItem('devsize_playlists', JSON.stringify(state.playlists));
      if (state.currentView === 'playlist-detail' && __selectedPlaylistIds.has(state.currentPlaylistId)) {
        switchView('home');
      }
      __selectedPlaylistIds.clear();
      __playlistSelectMode = false;
      renderPlaylistsList();
      if (typeof showToast === 'function') showToast('Đã xóa các playlist đã chọn', 'success');
    };
    toolbar.appendChild(btnDeleteSel);
  }
  el.playlistsList.appendChild(toolbar);

  state.playlists.forEach(pl => {
    const item = document.createElement('div');
    item.className = 'playlist-item';
    item.dataset.playlistId = pl.id;
    if (state.currentView === 'playlist-detail' && state.currentPlaylistId === pl.id && !__playlistSelectMode) {
      item.classList.add('active');
    }

    if (__playlistSelectMode) {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = __selectedPlaylistIds.has(pl.id);
      cb.style.cssText = 'margin-right:8px;accent-color:#a855f7;width:16px;height:16px;flex-shrink:0;cursor:pointer;';
      cb.onclick = (e) => {
        e.stopPropagation();
        if (cb.checked) __selectedPlaylistIds.add(pl.id);
        else __selectedPlaylistIds.delete(pl.id);
        renderPlaylistsList();
      };
      item.appendChild(cb);
    }

    const thumbEl = document.createElement('div');
    thumbEl.className = 'playlist-item-thumb';
    renderPlaylistCover(thumbEl, pl, 44);

    const infoEl = document.createElement('div');
    infoEl.className = 'playlist-item-info';
    const trackCount = (pl.tracks || []).length;
    infoEl.innerHTML = `
      <span class="playlist-item-name">${escapeHtml(pl.name || 'untitled')}</span>
      <span class="playlist-item-count">${trackCount} track${trackCount === 1 ? '' : 's'}</span>
    `;

    item.appendChild(thumbEl);
    item.appendChild(infoEl);

    item.addEventListener('click', () => {
      if (__playlistSelectMode) {
        if (__selectedPlaylistIds.has(pl.id)) __selectedPlaylistIds.delete(pl.id);
        else __selectedPlaylistIds.add(pl.id);
        renderPlaylistsList();
        return;
      }
      openPlaylistDetail(pl.id);
    });
    item.addEventListener('contextmenu', async (e) => {
      e.preventDefault();
      if (window.electronAPI && window.electronAPI.showPlaylistContextMenu) {
        const act = await window.electronAPI.showPlaylistContextMenu(pl.id);
        if (act === 'export') {
          exportSinglePlaylist(pl.id);
        }
      }
    });
    el.playlistsList.appendChild(item);
  });
}

function initListReordering({ container, itemSelector, setOrder, canDragItem, isFilterActive }) {
  if (!container) return;

  let draggedItem = null;
  let startX = 0;
  let startY = 0;
  let activePointerId = null;
  let isDragging = false;
  let pressTimer = null;
  let autoScrollTimer = null;
  let suppressClick = false;
  let startIndex = -1;
  let targetIndex = -1;
  let itemMetrics = [];
  let items = [];
  let draggedHeight = 0;
  let draggedStartTop = 0;

  const scrollParent = container.closest('.main-content, .rail-drawer') || container;

  window.addEventListener('click', (e) => {
    if (suppressClick) {
      e.stopImmediatePropagation();
      e.preventDefault();
      suppressClick = false;
    }
  }, true);

  const startDrag = () => {
    if (!draggedItem || isDragging) return;
    isDragging = true;
    suppressClick = true;
    container._isDraggingReorder = true;
    try {
      if (activePointerId !== null && draggedItem.setPointerCapture) {
        draggedItem.setPointerCapture(activePointerId);
      }
    } catch (e) {}

    container.style.userSelect = 'none';
    draggedItem.classList.add('is-dragging');

    items = Array.from(container.querySelectorAll(itemSelector)).filter(el => !canDragItem || canDragItem(el));
    startIndex = items.indexOf(draggedItem);
    targetIndex = startIndex;
    draggedHeight = draggedItem.offsetHeight;
    draggedStartTop = draggedItem.offsetTop;

    itemMetrics = items.map((el, i) => ({
      el,
      index: i,
      top: el.offsetTop,
      height: el.offsetHeight
    }));
  };

  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    if (isFilterActive && isFilterActive()) return;

    const item = e.target.closest(itemSelector);
    if (!item || item.parentElement !== container) return;
    if (canDragItem && !canDragItem(item)) return;

    if (e.target.closest('button, input, select, textarea, .btn-icon-pill, .track-fav, .track-download-btn, .btn-rename-p, .btn-delete-p')) return;

    draggedItem = item;
    startX = e.clientX;
    startY = e.clientY;
    activePointerId = e.pointerId;
    isDragging = false;

    pressTimer = setTimeout(() => {
      startDrag();
    }, 250);

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
  };

  const onPointerMove = (e) => {
    if (!draggedItem) return;

    if (!isDragging) {
      const dist = Math.hypot(e.clientX - startX, e.clientY - startY);
      if (dist > 7) {
        clearTimeout(pressTimer);
        startDrag();
      } else {
        return;
      }
    }

    const dy = e.clientY - startY;

    if (scrollParent) {
      const scRect = scrollParent.getBoundingClientRect();
      clearInterval(autoScrollTimer);
      if (e.clientY < scRect.top + 40) {
        autoScrollTimer = setInterval(() => { scrollParent.scrollTop -= 8; }, 16);
      } else if (e.clientY > scRect.bottom - 40) {
        autoScrollTimer = setInterval(() => { scrollParent.scrollTop += 8; }, 16);
      }
    }

    draggedItem.style.setProperty('transform', `translate3d(0, ${dy}px, 0) scale(1.02)`, 'important');

    if (itemMetrics.length <= 1) return;

    const currentCenter = draggedStartTop + (draggedHeight / 2) + dy;
    let newTarget = 0;
    for (let i = 0; i < itemMetrics.length; i++) {
      const m = itemMetrics[i];
      const mid = m.top + (m.height / 2);
      if (currentCenter > mid) {
        newTarget = i;
      }
    }
    newTarget = Math.max(0, Math.min(newTarget, itemMetrics.length - 1));

    if (newTarget !== targetIndex) {
      targetIndex = newTarget;
      const shiftDistance = (itemMetrics.length > 1 && Math.abs(itemMetrics[1].top - itemMetrics[0].top) > 0)
        ? Math.abs(itemMetrics[1].top - itemMetrics[0].top)
        : draggedHeight;

      itemMetrics.forEach(metric => {
        if (metric.el === draggedItem) return;
        if (startIndex < targetIndex) {
          if (metric.index > startIndex && metric.index <= targetIndex) {
            metric.el.style.setProperty('transform', `translate3d(0, -${shiftDistance}px, 0)`, 'important');
            metric.el.style.transition = 'transform 180ms cubic-bezier(0.2, 0, 0, 1)';
          } else {
            metric.el.style.removeProperty('transform');
            metric.el.style.transition = 'transform 180ms cubic-bezier(0.2, 0, 0, 1)';
          }
        } else if (startIndex > targetIndex) {
          if (metric.index >= targetIndex && metric.index < startIndex) {
            metric.el.style.setProperty('transform', `translate3d(0, ${shiftDistance}px, 0)`, 'important');
            metric.el.style.transition = 'transform 180ms cubic-bezier(0.2, 0, 0, 1)';
          } else {
            metric.el.style.removeProperty('transform');
            metric.el.style.transition = 'transform 180ms cubic-bezier(0.2, 0, 0, 1)';
          }
        } else {
          metric.el.style.removeProperty('transform');
          metric.el.style.transition = 'transform 180ms cubic-bezier(0.2, 0, 0, 1)';
        }
      });
    }
  };

  const onPointerUp = () => {
    clearTimeout(pressTimer);
    clearInterval(autoScrollTimer);
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);

    if (!draggedItem) return;

    const item = draggedItem;
    const currentActiveId = activePointerId;
    draggedItem = null;
    activePointerId = null;

    try {
      if (currentActiveId !== null && item.hasPointerCapture && item.hasPointerCapture(currentActiveId)) {
        item.releasePointerCapture(currentActiveId);
      }
    } catch (e) {}

    if (isDragging) {
      let targetSlotDy = 0;
      if (targetIndex >= 0 && targetIndex < itemMetrics.length && targetIndex !== startIndex) {
        targetSlotDy = itemMetrics[targetIndex].top - draggedStartTop;
      }

      item.style.transition = 'transform 160ms cubic-bezier(0.2, 0, 0, 1)';
      item.style.setProperty('transform', `translate3d(0, ${targetSlotDy}px, 0) scale(1)`, 'important');

      setTimeout(() => {
        if (targetIndex !== startIndex && targetIndex >= 0 && targetIndex < items.length) {
          const targetItem = items[targetIndex];
          if (targetIndex > startIndex) {
            targetItem.after(item);
          } else {
            targetItem.before(item);
          }
        }

        item.classList.remove('is-dragging');
        item.style.removeProperty('transform');
        item.style.transition = '';
        item.style.willChange = '';

        items.forEach(el => {
          el.style.removeProperty('transform');
          el.style.transition = '';
        });

        container.style.userSelect = '';
        container.classList.add('no-enter-anim');

        container.querySelectorAll('.track-row').forEach((r, i) => {
          r.dataset.trackIndex = String(i);
          const num = r.querySelector('.track-num-text') || r.querySelector('.track-row-index');
          if (num) num.textContent = String(i + 1);
        });

        if (startIndex !== -1 && targetIndex !== -1 && startIndex !== targetIndex) {
          setOrder(startIndex, targetIndex);
        }

        container._isDraggingReorder = false;
        setTimeout(() => { suppressClick = false; }, 80);
      }, 160);
    } else {
      suppressClick = false;
    }
  };

  container.addEventListener('pointerdown', onPointerDown);
}

function initLibraryReordering() {
initListReordering({
  container: el.playlistsList,
  itemSelector: '.playlist-item',
  setOrder: (fromIdx, toIdx) => {
    const [moved] = state.playlists.splice(fromIdx, 1);
    state.playlists.splice(toIdx, 0, moved);
    localStorage.setItem('devsize_playlists', JSON.stringify(state.playlists));
  }
});

initListReordering({
  container: el.presetsContainer,
  itemSelector: '.preset-chip',
  canDragItem: (chip) => chip.dataset.isCustom === 'true',
  setOrder: (fromIdx, toIdx) => {
    const [moved] = state.customPresets.splice(fromIdx, 1);
    state.customPresets.splice(toIdx, 0, moved);
    localStorage.setItem('devsize_custom_presets', JSON.stringify(state.customPresets));
  }
});

enableTrackSort({
  container: el.favoritesTracksList,
  isFilterActive: () => Boolean(el.favoritesSearchInput && el.favoritesSearchInput.value.trim()),
  onReorder: (fromIdx, toIdx) => {
    if (el.favoritesSort && el.favoritesSort.value !== 'manual') {
      el.favoritesSort.value = 'manual';
      setTrackSortMode('favorites', 'manual');
      const favLabel = document.getElementById('favorites-sort-label');
      if (favLabel) favLabel.textContent = 'Manual order';
      const favMenu = document.getElementById('favorites-sort-menu');
      if (favMenu) {
        favMenu.querySelectorAll('.m3-dropdown-option').forEach(opt => {
          opt.classList.toggle('selected', opt.dataset.value === 'manual');
        });
      }
    }
    const savedScroll = el.mainContent ? el.mainContent.scrollTop : 0;
    const [moved] = state.favorites.splice(fromIdx, 1);
    state.favorites.splice(toIdx, 0, moved);
    localStorage.setItem('devsize_favorites', JSON.stringify(state.favorites.map(sanitizeTrackForStorage)));
    if (el.favoritesSubtitle) {
      el.favoritesSubtitle.textContent = `${state.favorites.length} tracks saved`;
    }
    if (el.mainContent) el.mainContent.scrollTop = savedScroll;
  }
});

enableTrackSort({
  container: el.playlistTracksList,
  isFilterActive: () => Boolean(el.playlistSearchInput && el.playlistSearchInput.value.trim()),
  onReorder: (fromIdx, toIdx) => {
    if (el.playlistSort && el.playlistSort.value !== 'manual') {
      el.playlistSort.value = 'manual';
      setTrackSortMode('playlist', 'manual');
      const plLabel = document.getElementById('playlist-sort-label');
      if (plLabel) plLabel.textContent = 'Manual order';
      const plMenu = document.getElementById('playlist-sort-menu');
      if (plMenu) {
        plMenu.querySelectorAll('.m3-dropdown-option').forEach(opt => {
          opt.classList.toggle('selected', opt.dataset.value === 'manual');
        });
      }
    }
    const savedScroll = el.mainContent ? el.mainContent.scrollTop : 0;
    const pl = state.currentPlaylist || (state.playlists || []).find(p => p.id === state.currentPlaylistId);
    if (pl && pl.tracks) {
      const [moved] = pl.tracks.splice(fromIdx, 1);
      pl.tracks.splice(toIdx, 0, moved);
      localStorage.setItem('devsize_playlists', JSON.stringify(state.playlists));
    }
    if (el.mainContent) el.mainContent.scrollTop = savedScroll;
  }
});
}

function createPlaylist(name, initialTracks = [], cover = '') {
  if (!name || !name.trim()) return;
  const syncEngine = window.EclipseAlbumSyncEngine || null;
  const rawTracks = Array.isArray(initialTracks)
    ? initialTracks.map(t => (t && typeof t.addedAt === 'number') ? t : stampAddedAt(t))
    : [];
  const dedupedTracks = (syncEngine && typeof syncEngine.deduplicateTracks === 'function')
    ? syncEngine.deduplicateTracks(rawTracks)
    : rawTracks;
  const newPl = {
    id: 'pl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    name: name.trim(),
    tracks: dedupedTracks
  };
  if (cover && typeof cover === 'string' && cover.trim()) {
    newPl.cover = cover.trim();
  }
  state.playlists.push(newPl);
  localStorage.setItem('devsize_playlists', JSON.stringify(state.playlists));
  renderPlaylistsList();
  openPlaylistDetail(newPl.id);
  if (typeof hydrateMissingPlaylistCovers === 'function') {
    hydrateMissingPlaylistCovers(newPl);
  }
  return newPl;
}

function openPlaylistDetail(playlistId) {
  const pl = state.playlists.find(p => p.id === playlistId);
  if (!pl) return;
  if (Array.isArray(pl.tracks)) {
    let changed = false;
    pl.tracks.forEach(t => {
      if (!t) return;
      const ot = t.title;
      const oa = t.artist;
      normalizeTrackMeta(t);
      if (t.title !== ot || t.artist !== oa) changed = true;
    });
    if (changed) {
      try { localStorage.setItem('devsize_playlists', JSON.stringify(state.playlists)); } catch (_) {}
    }
  }
  state.currentPlaylistId = playlistId;
  state.currentPlaylist = pl;
  const provBadge = document.getElementById('playlist-provenance-badge');
  if (provBadge) {
    const src = pl.importSource || pl.importedFrom || '';
    const syncedAt = pl.lastSyncedAt || pl.importedAt || null;
    if (src) {
      const dateStr = syncedAt ? ` • ${new Date(syncedAt).toLocaleDateString()}` : '';
      provBadge.textContent = `Imported from ${src}${dateStr}`;
      provBadge.classList.remove('hidden');
    } else {
      provBadge.textContent = '';
      provBadge.classList.add('hidden');
    }
  }
  const addLocalPlBtn = document.getElementById('btn-playlist-add-local');
  if (addLocalPlBtn) {
    addLocalPlBtn.onclick = async () => {
      if (!window.electronAPI || !window.electronAPI.pickLocalFiles) return;
      const picked = await window.electronAPI.pickLocalFiles();
      if (!Array.isArray(picked) || picked.length === 0) return;
      if (typeof mergeLocalFiles === 'function') mergeLocalFiles(picked);
      if (!Array.isArray(pl.tracks)) pl.tracks = [];
      const existingKeys = new Set(pl.tracks.map((t) => String(t.path || t.id || `${t.artist}::${t.title}`)));
      let added = 0;
      for (const t of picked) {
        const k = String(t.path || t.id || `${t.artist}::${t.title}`);
        if (!existingKeys.has(k)) {
          pl.tracks.push(t);
          existingKeys.add(k);
          added++;
        }
      }
      try { localStorage.setItem('devsize_playlists', JSON.stringify(state.playlists)); } catch (_) {}
      if (typeof showToast === 'function') showToast(`Added ${added} local track(s) to playlist`, 'success');
      openPlaylistDetail(pl.id);
    };
  }
  const researchPlBtn = document.getElementById('btn-playlist-research');
  if (researchPlBtn) {
    researchPlBtn.onclick = async () => {
      if (!window.EclipseTrackSourceUI || !Array.isArray(pl.tracks)) return;
      researchPlBtn.disabled = true;
      try {
        const res = await window.EclipseTrackSourceUI.bulkResearchPlaylistTracks(pl.tracks, {
          platform: state.platform || 'ytmusic',
          currentTrackId: state.currentTrack?.id || null
        });
        try { localStorage.setItem('devsize_playlists', JSON.stringify(state.playlists)); } catch (_) {}
        if (typeof showToast === 'function') showToast(`Re-searched ${res.updated}/${res.total} tracks`, 'success');
        openPlaylistDetail(pl.id);
      } finally {
        researchPlBtn.disabled = false;
      }
    };
  }
  if (el.playlistDetailTitle) {
    el.playlistDetailTitle.textContent = pl.name || 'Untitled';
    el.playlistDetailTitle.contentEditable = 'plaintext-only';
    el.playlistDetailTitle.classList.add('playlist-inline-editable');
    el.playlistDetailTitle.onkeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        el.playlistDetailTitle.blur();
      }
    };
    el.playlistDetailTitle.onblur = () => {
      const newName = el.playlistDetailTitle.textContent.trim() || pl.name || 'Untitled';
      if (pl.name !== newName) {
        pl.name = newName;
        localStorage.setItem('devsize_playlists', JSON.stringify(state.playlists));
        renderPlaylistsList();
      }
      el.playlistDetailTitle.textContent = pl.name;
    };
  }
  const descEl = document.getElementById('playlist-detail-desc');
  if (descEl) {
    descEl.textContent = pl.description || '';
    descEl.contentEditable = 'plaintext-only';
    descEl.classList.add('playlist-inline-editable');
    descEl.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        descEl.blur();
      }
    };
    descEl.onblur = () => {
      const newDesc = descEl.textContent.trim();
      if ((pl.description || '') !== newDesc) {
        pl.description = newDesc;
        localStorage.setItem('devsize_playlists', JSON.stringify(state.playlists));
      }
      descEl.textContent = pl.description || '';
    };
  }
  const query = el.playlistSearchInput ? el.playlistSearchInput.value.trim().toLowerCase() : '';
  let filtered = pl.tracks;
  if (query) {
    filtered = pl.tracks.filter(t =>
      (t.title && t.title.toLowerCase().includes(query)) ||
      (t.artist && t.artist.toLowerCase().includes(query))
    );
  }
  filtered = sortTracksFor('playlist', filtered);
  if (typeof el !== 'undefined' && el.playlistSort) {
    el.playlistSort.value = getTrackSortMode('playlist');
    const plLabel = document.getElementById('playlist-sort-label');
    const plMenu = document.getElementById('playlist-sort-menu');
    if (plMenu) {
      plMenu.querySelectorAll('.m3-dropdown-option').forEach(opt => {
        const isSel = opt.dataset.value === el.playlistSort.value;
        opt.classList.toggle('selected', isSel);
        if (isSel && plLabel) plLabel.textContent = opt.textContent;
      });
    }
  }
  const totalSec = (pl.tracks || []).reduce((acc, t) => acc + (t.duration || 0), 0);
  const durStr = totalSec > 0 ? ` • ${formatDuration(totalSec)}` : '';
  if (el.playlistDetailCount) el.playlistDetailCount.textContent = (query ? `${filtered.length} of ${pl.tracks.length} tracks` : `${pl.tracks.length} tracks`) + durStr;
  const detailCover = document.getElementById('playlist-detail-cover');
  if (detailCover) {
    renderPlaylistCover(detailCover, pl, 160);
    detailCover.style.cursor = 'pointer';
    detailCover.onclick = async () => {
      if (detailCover._zoomedFlag) return;
      if (window.electronAPI && window.electronAPI.pickMedia) {
        const url = await window.electronAPI.pickMedia();
        if (url) {
          pl.cover = url;
          localStorage.setItem('devsize_playlists', JSON.stringify(state.playlists));
          openPlaylistDetail(playlistId);
        }
      }
    };
    if (typeof bindCoverHoldZoom === 'function') bindCoverHoldZoom(detailCover);
  }
  const coverSrc = (pl && pl.cover) ? proxiedThumb(pl.cover) : ((pl.tracks && pl.tracks[0]) ? getTrackThumbUrl(pl.tracks[0]) : '');
  const plHeroFx = document.getElementById('playlist-hero-fx');
  if (plHeroFx) {
    plHeroFx.style.backgroundImage = coverSrc ? `url("${coverSrc}")` : '';
  }
  const headerEl = document.querySelector('.playlist-detail-header');
  if (headerEl) {
    if (coverSrc) {
      getCoverDominantColors(coverSrc).then(([domColor]) => {
        if (state.currentPlaylistId === playlistId) {
          headerEl.style.setProperty('--playlist-accent-color', domColor);
          document.documentElement.style.setProperty('--playlist-accent-color', domColor);
        }
      });
    } else {
      headerEl.style.removeProperty('--playlist-accent-color');
      document.documentElement.style.removeProperty('--playlist-accent-color');
    }
  }
  if (el.playlistTracksList) renderTracks(el.playlistTracksList, filtered, 'playlist');
  switchView('playlist-detail');
  renderPlaylistsList();
}

if (typeof el !== 'undefined' && el.playlistSort) {
  el.playlistSort.addEventListener('change', () => {
    setTrackSortMode('playlist', el.playlistSort.value);
    if (state.currentPlaylistId) openPlaylistDetail(state.currentPlaylistId);
  });
  setupSortDropdown('playlist-sort-dropdown', 'playlist-sort-trigger', 'playlist-sort-menu', 'playlist-sort-label', el.playlistSort);
}

function removeTrackFromCurrentPlaylist(trackId) {
  const pl = state.playlists.find(p => p.id === state.currentPlaylistId);
  if (!pl) return;
  pl.tracks = pl.tracks.filter(t => t.id !== trackId);
  localStorage.setItem('devsize_playlists', JSON.stringify(state.playlists));
  openPlaylistDetail(state.currentPlaylistId);
}

function deleteCurrentPlaylist() {
  if (!state.currentPlaylistId) return;
  state.playlists = state.playlists.filter(p => p.id !== state.currentPlaylistId);
  localStorage.setItem('devsize_playlists', JSON.stringify(state.playlists));
  state.currentPlaylistId = null;
  renderPlaylistsList();
  switchView('discover');
}

let trackToAddToPlaylist = null;
function openAddToPlaylistModal(track) {
  trackToAddToPlaylist = track;
  if (!el.playlistPickList) return;

  const trackPreviewEl = document.getElementById('add-playlist-track-preview');
  if (trackPreviewEl) {
    if (Array.isArray(track)) {
      trackPreviewEl.innerHTML = `
        <div class="add-playlist-track-preview-thumb" style="width: 40px; height: 40px; flex: 0 0 40px; display: flex; align-items: center; justify-content: center; background: var(--md-sys-color-surface-container-high); border-radius: 8px;">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>
        </div>
        <div class="add-playlist-track-preview-info">
          <span class="add-playlist-track-preview-title">${track.length} tracks selected</span>
          <span class="add-playlist-track-preview-artist">Bulk add to playlist</span>
        </div>
      `;
      trackPreviewEl.style.display = 'flex';
    } else if (track) {
      const thumb = getTrackThumbUrl(track) || '';
      trackPreviewEl.innerHTML = '';
      if (thumb) {
        const previewImg = document.createElement('img');
        previewImg.className = 'add-playlist-track-preview-thumb';
        previewImg.src = thumb;
        previewImg.alt = '';
        previewImg.style.width = '40px';
        previewImg.style.height = '40px';
        previewImg.style.flex = '0 0 40px';
        previewImg.onerror = () => { previewImg.style.visibility = 'hidden'; };
        trackPreviewEl.appendChild(previewImg);
      } else {
        const previewPlaceholder = document.createElement('div');
        previewPlaceholder.className = 'add-playlist-track-preview-thumb';
        previewPlaceholder.style.width = '40px';
        previewPlaceholder.style.height = '40px';
        previewPlaceholder.style.flex = '0 0 40px';
        previewPlaceholder.style.display = 'flex';
        previewPlaceholder.style.alignItems = 'center';
        previewPlaceholder.style.justifyContent = 'center';
        previewPlaceholder.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>';
        trackPreviewEl.appendChild(previewPlaceholder);
      }

      const previewInfo = document.createElement('div');
      previewInfo.className = 'add-playlist-track-preview-info';

      const previewTitle = document.createElement('span');
      previewTitle.className = 'add-playlist-track-preview-title';
      previewTitle.textContent = track.title || 'untitled';

      const previewArtist = document.createElement('span');
      previewArtist.className = 'add-playlist-track-preview-artist';
      previewArtist.textContent = track.artist || 'unknown artist';

      previewInfo.appendChild(previewTitle);
      previewInfo.appendChild(previewArtist);
      trackPreviewEl.appendChild(previewInfo);
      trackPreviewEl.style.display = 'flex';
    } else {
      trackPreviewEl.style.display = 'none';
      trackPreviewEl.innerHTML = '';
    }
  }

  el.playlistPickList.innerHTML = '';
  if (state.playlists.length === 0) {
    el.playlistPickList.innerHTML = '<div class="empty-hint" style="padding: 24px 0; text-align: center; color: var(--md-sys-color-outline);">No playlists yet. Create one first.</div>';
  } else {
    state.playlists.forEach((pl, idx) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'playlist-pick-item';
      item.style.animationDelay = `${idx * 25}ms`;

      const isAlreadyAdded = !Array.isArray(track) && track && (pl.tracks || []).some(t => t.id === track.id);
      if (isAlreadyAdded) item.classList.add('already-added');

      const thumbEl = document.createElement('div');
      thumbEl.className = 'playlist-pick-thumb';
      thumbEl.style.width = '44px';
      thumbEl.style.height = '44px';
      thumbEl.style.flex = '0 0 44px';
      renderPlaylistCover(thumbEl, pl, 44);
      const coverImg = thumbEl.querySelector('img');
      if (coverImg) {
        coverImg.style.width = '44px';
        coverImg.style.height = '44px';
        coverImg.style.objectFit = 'cover';
      }

      const infoEl = document.createElement('div');
      infoEl.className = 'playlist-pick-info';
      const trackCount = (pl.tracks || []).length;

      const nameEl = document.createElement('span');
      nameEl.className = 'playlist-pick-name';
      nameEl.textContent = pl.name || 'untitled';

      const countEl = document.createElement('span');
      countEl.className = 'playlist-pick-count';
      countEl.textContent = `${trackCount} track${trackCount === 1 ? '' : 's'}`;

      infoEl.appendChild(nameEl);
      infoEl.appendChild(countEl);

      const actionEl = document.createElement('div');
      if (isAlreadyAdded) {
        actionEl.className = 'playlist-pick-badge in-playlist';
        actionEl.innerHTML = `
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>
          Added
        `;
      } else {
        actionEl.className = 'playlist-pick-action-btn';
        actionEl.innerHTML = `
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
        `;
      }

      item.appendChild(thumbEl);
      item.appendChild(infoEl);
      item.appendChild(actionEl);

      item.addEventListener('click', () => {
        if (Array.isArray(track)) {
          let addedCount = 0;
          if (!Array.isArray(pl.tracks)) pl.tracks = [];
          track.forEach(t => {
            if (!pl.tracks.some(existing => existing.id === t.id)) {
              pl.tracks.push(stampAddedAt(t));
              addedCount++;
            }
          });
          localStorage.setItem('devsize_playlists', JSON.stringify(state.playlists));
          renderPlaylistsList();
          if (state.currentView === 'playlist-detail' && state.currentPlaylistId === pl.id) {
            openPlaylistDetail(pl.id);
          }
          showToast(`Added ${addedCount} tracks to "${pl.name}"`, 'success');
          clearTrackSelection();
        } else if (track) {
          if (!pl.tracks.some(t => t.id === track.id)) {
            pl.tracks.push(stampAddedAt(track));
            localStorage.setItem('devsize_playlists', JSON.stringify(state.playlists));
            renderPlaylistsList();
            if (state.currentView === 'playlist-detail' && state.currentPlaylistId === pl.id) {
              openPlaylistDetail(pl.id);
            }
            showToast(`Added to "${pl.name}"`, 'success');
          } else {
            showToast(`Already in "${pl.name}"`, 'info');
          }
        }
        if (el.addToPlaylistModal) closeModal(el.addToPlaylistModal);
      });

      el.playlistPickList.appendChild(item);
    });
  }
  if (el.addToPlaylistModal) openModal(el.addToPlaylistModal);
}

function deduplicateLibraryData({ silent = true } = {}) {
  const syncEngine = window.EclipseAlbumSyncEngine || null;
  if (!syncEngine) return { playlistsChanged: false, favoritesChanged: false, albumsChanged: false };

  let playlistsChanged = false;
  let favoritesChanged = false;
  let albumsChanged = false;

  if (Array.isArray(state.favorites) && typeof syncEngine.deduplicateTracks === 'function') {
    const dedupFavs = syncEngine.deduplicateTracks(state.favorites);
    if (dedupFavs.length !== state.favorites.length) {
      state.favorites = dedupFavs;
      favoritesChanged = true;
      try {
        localStorage.setItem('devsize_favorites', JSON.stringify(state.favorites.map(sanitizeTrackForStorage)));
      } catch (_) {}
      if (typeof updateFavoritesBadge === 'function') updateFavoritesBadge();
      if (typeof updateFavoriteIcon === 'function') updateFavoriteIcon();
      if (state.currentView === 'favorites' && typeof renderFavoritesView === 'function') renderFavoritesView();
    }
  }

  if (Array.isArray(state.playlists) && typeof syncEngine.deduplicatePlaylists === 'function') {
    const accId = typeof activeYtmAccountId !== 'undefined' ? activeYtmAccountId : 'default';
    const res = syncEngine.deduplicatePlaylists(state.playlists, accId);
    if (res.changed) {
      state.playlists = res.playlists;
      playlistsChanged = true;
      try { localStorage.setItem('devsize_playlists', JSON.stringify(state.playlists)); } catch (_) {}
      if (typeof renderPlaylistsList === 'function') renderPlaylistsList();
      if (state.currentView === 'playlist-detail' && state.currentPlaylistId && typeof openPlaylistDetail === 'function') {
        openPlaylistDetail(state.currentPlaylistId);
      }
    }
  }

  if (typeof getSavedAlbums === 'function' && typeof setSavedAlbums === 'function' && typeof syncEngine.mergeSavedAlbumEntities === 'function') {
    const currentAlbums = getSavedAlbums();
    if (Array.isArray(currentAlbums) && currentAlbums.length > 0) {
      const accId = typeof activeYtmAccountId !== 'undefined' ? activeYtmAccountId : 'default';
      const merged = syncEngine.mergeSavedAlbumEntities(currentAlbums, [], accId);
      const trackCountChanged = merged.list.some((a, i) => {
        const prev = currentAlbums[i];
        return !prev || (Array.isArray(a.tracks) && Array.isArray(prev.tracks) && a.tracks.length !== prev.tracks.length);
      });
      if (merged.list.length !== currentAlbums.length || trackCountChanged) {
        setSavedAlbums(merged.list);
        albumsChanged = true;
        if (state.currentView === 'albums' && typeof renderSavedAlbums === 'function') renderSavedAlbums();
      }
    }
  }

  if (!silent && (playlistsChanged || favoritesChanged || albumsChanged) && typeof showToast === 'function') {
    showToast('Cleaned up duplicate tracks, playlists, and albums.', 'success');
  }
  return { playlistsChanged, favoritesChanged, albumsChanged };
}

if (typeof window !== 'undefined') {
  window.deduplicateLibraryData = deduplicateLibraryData;
  setTimeout(() => {
    try { deduplicateLibraryData({ silent: true }); } catch (_) {}
  }, 800);
}
