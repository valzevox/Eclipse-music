// src/renderer/modules/artist.js
// Artist profile, album detail, saved albums, and horizontal row helpers.

async function fetchArtistCardForSearch(query, token, searchTracks) {
  const container = document.getElementById('search-artist-card-container');
  if (!container) return;
  try {
    const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/artist?name=${encodeURIComponent(query)}`);
    const data = await res.json();
    if (state.searchToken !== token) return;
    if (!data.success || !data.artist || !data.artist.name) return;
    if (!data.artist.isKnownArtist) return;

    const artist = data.artist;
    const normQ = normalizeImportText(query);
    const normA = normalizeImportText(artist.name);

    const isExact = (normA === normQ);
    const isClose = (normA.startsWith(normQ) || normQ.startsWith(normA)) && Math.abs(normA.length - normQ.length) <= 3;
    if (!isExact && !isClose) return;

    if (Array.isArray(searchTracks) && searchTracks.length > 0) {
      const topTrackTitle = normalizeImportText(searchTracks[0].title || '');
      if (topTrackTitle === normQ && normA !== normQ) return;
    }

    const avatarUrl = artist.avatar || (searchTracks && searchTracks[0] ? searchTracks[0].thumbnail : '');
    container.innerHTML = `
      <div class="search-artist-card" role="button" tabindex="0">
        <div class="search-artist-avatar-wrap">
          ${avatarUrl ? `<img class="search-artist-avatar" src="${escapeHtml(avatarUrl)}" alt="${escapeHtml(artist.name)}" />` : '<div style="width:100%;height:100%;background:var(--md-sys-color-surface-container);"></div>'}
        </div>
        <div class="search-artist-info">
          <span class="search-artist-name">${escapeHtml(artist.name)}</span>
          <span class="search-artist-label">Artist</span>
        </div>
      </div>
    `;

    const card = container.querySelector('.search-artist-card');
    if (card) {
      const open = () => {
        if (typeof recordSearchArtist === 'function') recordSearchArtist(artist.name, avatarUrl, artist.isVerified);
        openArtistProfile(artist.name);
      };
      card.addEventListener('click', open);
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          openArtistProfile(artist.name);
        }
      });
    }
    if (typeof applySearchFilter === 'function') applySearchFilter(currentSearchFilter);
  } catch (e) {}
}

const albumResolved = new Map();

function normalizeMatchText(str) {
  if (!str) return '';
  return str
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function resolveAlbumTrack(album, t) {
  if (!album || !t) return null;
  if (t.url || t.platform === 'local') return t;
  const albumId = album.id || '';
  const trackNo = t.no != null ? t.no : 1;
  const cacheKey = `${albumId}:${trackNo}`;
  if (albumResolved.has(cacheKey)) {
    return albumResolved.get(cacheKey);
  }

  const query = `${t.artist || album.artist || ''} ${t.title || ''}`.trim();
  const platform = state.platform || 'youtube';
  let picked = null;
  try {
    const url = `http://127.0.0.1:${state.serverPort}/api/search?q=${encodeURIComponent(query)}&platform=${platform}&limit=5`;
    const res = await fetch(url);
    const data = await res.json();
    const results = (data && Array.isArray(data.tracks)) ? data.tracks.slice(0, 5) : [];
    if (results.length > 0) {
      const normAlbumTitle = normalizeMatchText(t.title);
      const matching = normAlbumTitle
        ? results.filter(cand => normalizeMatchText(cand.title).includes(normAlbumTitle))
        : results;
      const targetSec = t.durationMs ? t.durationMs / 1000 : null;

      if (matching.length > 0) {
        if (targetSec != null) {
          picked = matching.find(c => {
            const cSec = toSeconds(c.duration);
            return cSec > 0 && Math.abs(cSec - targetSec) <= 6;
          }) || matching[0];
        } else {
          picked = matching[0];
        }
      } else {
        picked = results[0];
      }
    }
  } catch (err) {
    console.warn('[albums] resolve error:', err);
  }

  if (picked) {
    albumResolved.set(cacheKey, picked);
  }
  return picked;
}

async function playAlbumFrom(album, tracks, startIndex = 0) {
  if (!album || !tracks || !tracks.length) return;
  const runId = ++currentAlbumPlayRunId;

  const startIdx = Math.max(0, Math.min(startIndex, tracks.length - 1));
  const firstResolved = await resolveAlbumTrack(album, tracks[startIdx]);

  if (currentAlbumPlayRunId !== runId) return;

  if (!firstResolved) {
    showToast('Track not found', 'warning');
    return;
  }

  playTrack(firstResolved, [firstResolved], 0, 'album');

  const hasBusy = typeof beginBusy === 'function';
  if (hasBusy) beginBusy('import');

  try {
    await new Promise(r => setTimeout(r, 600));
    const remaining = tracks.map((t, idx) => ({ t, idx })).filter(item => item.idx !== startIdx);
    const resolvedMap = new Map();
    let skippedCount = 0;

    await pool(remaining, 2, async (item) => {
      if (currentAlbumPlayRunId !== runId) return;
      const resTrack = await resolveAlbumTrack(album, item.t);
      if (currentAlbumPlayRunId !== runId) return;
      if (resTrack) {
        resolvedMap.set(item.idx, resTrack);
      } else {
        skippedCount++;
      }
    });

    if (currentAlbumPlayRunId !== runId) return;

    for (let i = 0; i < tracks.length; i++) {
      if (i === startIdx) continue;
      const cand = resolvedMap.get(i);
      if (!cand) continue;
      const alreadyInQueue = state.queue.some(q => isSameTrack(q, cand));
      if (!alreadyInQueue) {
        state.queue.push(cand);
      }
    }
    updateQueueBadge();
    if (state.currentView === 'queue') renderQueueView();

    if (skippedCount > 0) {
      showToast(`${skippedCount} tracks not found`, 'warning');
    }
  } finally {
    if (hasBusy) endBusy('import');
  }
}

let currentAlbumForFeedback = null;

function getMixFeedback() {
  const defaultVal = { likedArtists: [], dislikedArtists: [], likedTracks: [], dislikedTracks: [], ratingsByMix: {} };
  const val = safeJson('eclipse_mix_feedback', defaultVal);
  if (!val || typeof val !== 'object') return defaultVal;
  if (!Array.isArray(val.likedArtists)) val.likedArtists = [];
  if (!Array.isArray(val.dislikedArtists)) val.dislikedArtists = [];
  if (!Array.isArray(val.likedTracks)) val.likedTracks = [];
  if (!Array.isArray(val.dislikedTracks)) val.dislikedTracks = [];
  if (!val.ratingsByMix || typeof val.ratingsByMix !== 'object') val.ratingsByMix = {};
  return val;
}

function saveMixFeedback(data) {
  localStorage.setItem('eclipse_mix_feedback', JSON.stringify(data));
}

function handleDailyMixRating(isLike) {
  if (!currentAlbumForFeedback || !currentAlbumForFeedback.id) return;
  const album = currentAlbumForFeedback;
  const mixFeedbackEl = document.getElementById('daily-mix-feedback');
  const btnLike = document.getElementById('btn-dm-like');
  const btnDislike = document.getElementById('btn-dm-dislike');

  const clickedBtn = isLike ? btnLike : btnDislike;
  const otherBtn = isLike ? btnDislike : btnLike;
  if (clickedBtn) clickedBtn.classList.add('active');
  if (otherBtn) otherBtn.classList.remove('active');

  const feedback = getMixFeedback();
  feedback.ratingsByMix[album._rateKey || album.id] = isLike ? 'like' : 'dislike';

  const tracks = album.tracks || album._tracks || [];
  const artists = new Set();
  if (album.artist && album.artist !== 'Daily Mix') {
    album.artist.split(',').forEach(a => {
      const tr = a.trim();
      if (tr) artists.add(tr);
    });
  }

  tracks.forEach(t => {
    if (!t) return;
    if (t.artist) {
      const tr = t.artist.trim();
      if (tr) artists.add(tr);
    }
    const trackObj = {
      id: t.id || '',
      title: t.title || '',
      artist: t.artist || '',
      key: (typeof getTrackNormalizedKey === 'function' && t.artist && t.title) ? getTrackNormalizedKey(t.artist, t.title) : (t.id || '')
    };
    if (isLike) {
      if (!feedback.likedTracks.some(lt => (lt.id && lt.id === trackObj.id) || (lt.key && lt.key === trackObj.key))) {
        feedback.likedTracks.push(trackObj);
      }
    } else {
      if (!feedback.dislikedTracks.some(dt => (dt.id && dt.id === trackObj.id) || (dt.key && dt.key === trackObj.key))) {
        feedback.dislikedTracks.push(trackObj);
      }
      if (typeof recordWaveSkip === 'function') {
        recordWaveSkip(t);
      }
    }
  });

  artists.forEach(a => {
    if (isLike) {
      if (!feedback.likedArtists.includes(a)) {
        feedback.likedArtists.push(a);
      }
    } else {
      if (!feedback.dislikedArtists.includes(a)) {
        feedback.dislikedArtists.push(a);
      }
    }
  });

  saveMixFeedback(feedback);

  if (!isLike) {
    localStorage.removeItem('eclipse_my_wave_cache');
    localStorage.removeItem('eclipse_daily_mixes');
    setTimeout(() => {
      if (typeof generateDailyMixes === 'function') generateDailyMixes(true);
      if (typeof fetchPersonalVibe === 'function') fetchPersonalVibe(true);
    }, 300);
  }

  showToast(isLike ? 'Glad you like this mix!' : 'Feedback saved', 'info');

  setTimeout(() => {
    if (mixFeedbackEl) {
      mixFeedbackEl.classList.add('fading-out');
      setTimeout(() => {
        mixFeedbackEl.classList.add('hidden');
        mixFeedbackEl.classList.remove('fading-out');
      }, 280);
    }
  }, 350);
}

const btnDMLike = document.getElementById('btn-dm-like');
const btnDMDislike = document.getElementById('btn-dm-dislike');
if (btnDMLike) {
  btnDMLike.addEventListener('click', () => handleDailyMixRating(true));
}
if (btnDMDislike) {
  btnDMDislike.addEventListener('click', () => handleDailyMixRating(false));
}

let cachedSavedAlbums = null;

function getSavedAlbums() {
  if (Array.isArray(cachedSavedAlbums)) return cachedSavedAlbums;
  try {
    const raw = (localStorage.getItem('eclipse_saved_albums') || localStorage.getItem('eclipse_saved_albums'));
    const parsed = raw ? JSON.parse(raw) : [];
    cachedSavedAlbums = Array.isArray(parsed) ? parsed : [];
    return cachedSavedAlbums;
  } catch (_) {
    cachedSavedAlbums = [];
    return cachedSavedAlbums;
  }
}

function setSavedAlbums(list) {
  cachedSavedAlbums = Array.isArray(list) ? list : [];
  try {
    localStorage.setItem('eclipse_saved_albums', JSON.stringify(cachedSavedAlbums));
  } catch (_) {}
  if (window.electronAPI && window.electronAPI.libraryDb && typeof window.electronAPI.libraryDb.saveAlbums === 'function') {
    window.electronAPI.libraryDb.saveAlbums(cachedSavedAlbums, 'default').catch(() => {});
  }
  updateAlbumsCount();
}

function updateAlbumsCount() {
  setNavCount(document.getElementById('albums-count'), getSavedAlbums().length);
}

let __albumSelectMode = false;
const __selectedAlbumKeys = new Set();

function renderSavedAlbums() {
  const container = document.getElementById('saved-albums-grid');
  if (!container) return;
  const albums = getSavedAlbums();
  if (albums.length === 0) {
    __albumSelectMode = false;
    __selectedAlbumKeys.clear();
    container.innerHTML = '<div class="empty-hint" style="padding: 48px 0; text-align: center; width: 100%;">No saved albums yet. Save albums from the album view.</div>';
    return;
  }

  const getAlbKey = (a, i) => String(a.id || a.title || i);
  const toolbarHtml = `
    <div style="width:100%;display:flex;align-items:center;gap:8px;margin-bottom:12px;padding:4px 0;">
      <button id="btn-albums-sync-now" class="btn-outline-pill" style="font-size:13px;height:34px;padding:0 12px;display:inline-flex;align-items:center;gap:6px;cursor:pointer;">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
        <span>Đồng bộ thư viện</span>
      </button>
      <button id="btn-albums-select-toggle" class="btn-text" style="font-size:13px;padding:6px 12px;border-radius:10px;background:rgba(255,255,255,0.06);cursor:pointer;">
        ${__albumSelectMode ? 'Hủy' : 'Chọn nhiều'}
      </button>
      ${__albumSelectMode ? `
        <button id="btn-albums-select-all" class="btn-text" style="font-size:13px;padding:6px 12px;border-radius:10px;background:rgba(255,255,255,0.06);cursor:pointer;">
          ${albums.every((a, i) => __selectedAlbumKeys.has(getAlbKey(a, i))) ? 'Bỏ chọn tất cả' : 'Chọn tất cả'}
        </button>
        <button id="btn-albums-delete-selected" class="btn-text" style="font-size:13px;padding:6px 14px;border-radius:10px;background:rgba(239,68,68,0.2);color:#f87171;font-weight:600;cursor:pointer;" ${__selectedAlbumKeys.size === 0 ? 'disabled' : ''}>
          Xóa đã chọn (${__selectedAlbumKeys.size})
        </button>
      ` : ''}
    </div>
  `;

  container.innerHTML = toolbarHtml + albums.map((album, idx) => {
    const sub = [album.type || 'Album', album.artist || ''].filter(Boolean).join(' · ');
    const key = getAlbKey(album, idx);
    const checked = __selectedAlbumKeys.has(key);
    return `
      <div class="search-album-card" role="button" tabindex="0" style="position:relative;">
        ${__albumSelectMode ? `<input type="checkbox" class="album-select-cb" data-idx="${idx}" ${checked ? 'checked' : ''} style="position:absolute;top:8px;right:8px;z-index:5;width:18px;height:18px;accent-color:#a855f7;cursor:pointer;" />` : ''}
        ${album.cover ? `<img class="search-album-cover" src="${escapeHtml(album.cover)}" alt="${escapeHtml(album.title || '')}" loading="lazy" onerror="this.style.display='none'" />` : '<div class="search-album-cover" style="display:flex;align-items:center;justify-content:center;background:var(--md-sys-color-surface-container-high);"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--md-sys-color-outline);"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg></div>'}
        <div class="search-album-info">
          <span class="search-album-title" title="${escapeHtml(album.title || '')}">${escapeHtml(album.title || '')}</span>
          <span class="search-album-sub" title="${escapeHtml(sub)}">${escapeHtml(sub)}</span>
        </div>
      </div>
    `;
  }).join('');

  const btnSyncNow = document.getElementById('btn-albums-sync-now');
  if (btnSyncNow) {
    btnSyncNow.onclick = (e) => {
      e.stopPropagation();
      if (typeof autoSyncYtmLibraryOnLogin === 'function') {
        autoSyncYtmLibraryOnLogin();
      }
    };
  }
  const btnToggle = document.getElementById('btn-albums-select-toggle');
  if (btnToggle) {
    btnToggle.onclick = () => {
      __albumSelectMode = !__albumSelectMode;
      if (!__albumSelectMode) __selectedAlbumKeys.clear();
      renderSavedAlbums();
    };
  }
  const btnAll = document.getElementById('btn-albums-select-all');
  if (btnAll) {
    btnAll.onclick = () => {
      const allSel = albums.every((a, i) => __selectedAlbumKeys.has(getAlbKey(a, i)));
      if (allSel) __selectedAlbumKeys.clear();
      else albums.forEach((a, i) => __selectedAlbumKeys.add(getAlbKey(a, i)));
      renderSavedAlbums();
    };
  }
  const btnDel = document.getElementById('btn-albums-delete-selected');
  if (btnDel) {
    btnDel.onclick = () => {
      if (__selectedAlbumKeys.size === 0) return;
      const remaining = albums.filter((a, i) => !__selectedAlbumKeys.has(getAlbKey(a, i)));
      setSavedAlbums(remaining);
      __selectedAlbumKeys.clear();
      __albumSelectMode = false;
      updateAlbumsCount();
      renderSavedAlbums();
      if (typeof showToast === 'function') showToast('Đã xóa các album đã chọn', 'success');
    };
  }

  const cards = container.querySelectorAll('.search-album-card');
  cards.forEach((card, idx) => {
    const alb = albums[idx];
    if (!alb) return;
    const key = getAlbKey(alb, idx);
    card.addEventListener('click', (e) => {
      if (__albumSelectMode) {
        e.preventDefault();
        if (__selectedAlbumKeys.has(key)) __selectedAlbumKeys.delete(key);
        else __selectedAlbumKeys.add(key);
        renderSavedAlbums();
        return;
      }
      openAlbum(alb);
    });
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (__albumSelectMode) {
          if (__selectedAlbumKeys.has(key)) __selectedAlbumKeys.delete(key);
          else __selectedAlbumKeys.add(key);
          renderSavedAlbums();
        } else {
          openAlbum(alb);
        }
      }
    });
  });
}

let currentAlbumRunId = 0;

async function openAlbum(album) {
  if (!album || !album.id) return;
  const runId = ++currentAlbumRunId;

  state.previousView = state.currentView;
  switchView('album');

  currentAlbumForFeedback = album;
  state.currentAlbum = album;
  const albumView = document.getElementById('view-album');
  const isDailyMix = album.type === 'Daily Mix' || !!album.isDailyMix || String(album.id || '').startsWith('daily-mix') || String(album.id || '').startsWith('dm_');
  if (albumView) {
    albumView.classList.toggle('is-daily-mix', isDailyMix);
  }
  const feedback = getMixFeedback();
  const mixRateKey = isDailyMix
    ? `${album.id || 'mix'}_${getLocalDateString()}_${(album.tracks && album.tracks[0] && (album.tracks[0].id || album.tracks[0].title)) || ''}`
    : '';
  if (isDailyMix) album._rateKey = mixRateKey;
  const currentRating = isDailyMix && feedback.ratingsByMix ? (feedback.ratingsByMix[mixRateKey] || feedback.ratingsByMix[album.id]) : null;

  const bLike = document.getElementById('btn-dm-like');
  const bDislike = document.getElementById('btn-dm-dislike');
  if (bLike && bDislike) {
    if (isDailyMix) {
      bLike.style.display = 'inline-flex';
      bDislike.style.display = 'inline-flex';
      bLike.classList.toggle('active', currentRating === 'like');
      bDislike.classList.toggle('active', currentRating === 'dislike');
      bLike.onclick = (e) => { e.preventDefault(); e.stopPropagation(); handleDailyMixRating(true); };
      bDislike.onclick = (e) => { e.preventDefault(); e.stopPropagation(); handleDailyMixRating(false); };
    } else {
      bLike.style.display = 'none';
      bDislike.style.display = 'none';
    }
  }

  const mixFeedbackEl = document.getElementById('daily-mix-feedback');
  if (mixFeedbackEl) {
    if (isDailyMix) {
      mixFeedbackEl.classList.remove('hidden', 'fading-out');
    } else {
      mixFeedbackEl.classList.add('hidden');
      mixFeedbackEl.classList.remove('fading-out');
    }
  }

  const btnSaveAlbum = document.getElementById('btn-save-album');
  if (btnSaveAlbum) {
    if (isDailyMix) {
      btnSaveAlbum.style.display = 'none';
    } else {
      btnSaveAlbum.style.display = '';
      const updateBtnState = () => {
        const list = getSavedAlbums();
        const isSaved = list.some(a => (album.id && a.id === album.id) || (album.title && a.title === album.title && a.artist === album.artist));
        const svg = btnSaveAlbum.querySelector('svg');
        if (svg) svg.setAttribute('fill', isSaved ? 'currentColor' : 'none');
        btnSaveAlbum.classList.toggle('active', isSaved);
        btnSaveAlbum.title = isSaved ? 'Remove from saved albums' : 'Save album';
      };
      updateBtnState();
      btnSaveAlbum.onclick = (e) => {
        e.stopPropagation();
        let list = getSavedAlbums();
        const idx = list.findIndex(a => (album.id && a.id === album.id) || (album.title && a.title === album.title && a.artist === album.artist));
        if (idx >= 0) {
          list.splice(idx, 1);
        } else {
          list.unshift({
            id: album.id,
            title: album.title || '',
            artist: album.artist || '',
            cover: album.cover || '',
            type: album.type || 'Album',
            year: album.year || '',
            trackCount: album.trackCount || (album._tracks ? album._tracks.length : 0)
          });
          if (localStorage.getItem('eclipse_like_album_tracks') === 'true' && album._tracks && Array.isArray(album._tracks)) {
            let favAdded = false;
            album._tracks.forEach(tr => {
              if (tr && !state.favorites.some(f => isSameTrack(f, tr))) {
                state.favorites.unshift(typeof stampAddedAt === 'function' ? stampAddedAt(tr) : tr);
                favAdded = true;
              }
            });
            if (favAdded) {
              localStorage.setItem('devsize_favorites', JSON.stringify(state.favorites.map(sanitizeTrackForStorage)));
              if (typeof updateFavoritesBadge === 'function') updateFavoritesBadge();
              if (typeof updateFavoriteIcon === 'function') updateFavoriteIcon();
              if (state.currentView === 'favorites' && typeof renderFavoritesView === 'function') renderFavoritesView();
            }
          }
        }
        setSavedAlbums(list);
        updateBtnState();
        if (state.currentView === 'albums') {
          renderSavedAlbums();
        }
      };
    }
  }

  const resolvedAlbumCover = Array.isArray(album.cover)
    ? (album.cover.find(u => typeof u === 'string' && u.trim()) || '')
    : (typeof album.cover === 'string' ? album.cover.trim() : '');
  const coverEl = document.getElementById('album-detail-cover');
  if (coverEl) {
    if (album.gridCovers && Array.isArray(album.gridCovers) && album.gridCovers.length >= 4) {
      coverEl.innerHTML = `
        <div class="sp-grid-cover" style="width:100%;height:100%;aspect-ratio:1;border-radius:20px;overflow:hidden;gap:3px;padding:3px;background:var(--md-sys-color-surface-container);">
          ${album.gridCovers.slice(0, 4).map(c => `<img src="${escapeHtml(c)}" style="border-radius:8px;" />`).join('')}
        </div>
      `;
    } else {
      coverEl.innerHTML = resolvedAlbumCover
        ? `<img src="${escapeHtml(resolvedAlbumCover)}" alt="${escapeHtml(album.title)}" style="width:100%;height:100%;aspect-ratio:1;border-radius:20px;object-fit:cover;box-shadow:none;" />`
        : '<div style="width:100%;height:100%;aspect-ratio:1;border-radius:20px;background:var(--md-sys-color-surface-container);"></div>';
    }
    if (typeof bindCoverHoldZoom === 'function') bindCoverHoldZoom(coverEl);
  }

  const titleEl = document.getElementById('album-detail-title');
  if (titleEl) titleEl.textContent = album.title || 'Untitled album';

  const artistBtn = document.getElementById('album-detail-artist');
  if (artistBtn) {
    if (isDailyMix) {
      artistBtn.textContent = '';
      artistBtn.style.display = 'none';
    } else {
      artistBtn.style.display = '';
      const artistName = album.artist || '';
      renderClickableArtists(artistBtn, artistName);
      artistBtn.title = `View ${artistName}`;
    }
    artistBtn.onclick = null;
  }

  const syncEngine = window.EclipseAlbumSyncEngine || null;
  const countEl = document.getElementById('album-detail-count');
  const initialMeta = syncEngine
    ? syncEngine.formatAlbumMetaLine({
        type: album.type || 'Album',
        year: album.year || '',
        status: 'loading',
        trackCount: (typeof album.trackCount === 'number' && album.trackCount > 0) ? album.trackCount : null,
        totalDurationSec: (typeof album.totalDurationSec === 'number' && album.totalDurationSec > 0) ? album.totalDurationSec : 0
      })
    : [album.type || 'Album', album.year, album.trackCount ? `${album.trackCount} bản nhạc` : 'Đang tải bài hát...'].filter(Boolean).join(' • ');
  if (countEl) countEl.textContent = initialMeta;

  const albumHeroFx = document.getElementById('album-hero-fx');
  if (albumHeroFx) {
    albumHeroFx.style.backgroundImage = resolvedAlbumCover ? `url("${resolvedAlbumCover}")` : '';
  }
  const colorCover = resolvedAlbumCover || (album.gridCovers && album.gridCovers[0]) || '';
  if (colorCover) {
    getCoverDominantColors(colorCover).then(([domColor]) => {
      if (state.currentView === 'album' && currentAlbumRunId === runId) {
        if (albumView) albumView.style.setProperty('--playlist-accent-color', domColor);
        if (albumHeroFx) albumHeroFx.style.setProperty('--playlist-accent-color', domColor);
        document.documentElement.style.setProperty('--playlist-accent-color', domColor);
      }
    });
  } else {
    if (albumView) albumView.style.removeProperty('--playlist-accent-color');
    if (albumHeroFx) albumHeroFx.style.removeProperty('--playlist-accent-color');
    document.documentElement.style.removeProperty('--playlist-accent-color');
  }

  const listEl = document.getElementById('album-tracks-list');
  if (listEl) {
    listEl.innerHTML = `<div class="m3-loader-container" style="display: flex; justify-content: center; align-items: center; padding: 64px 0; width: 100%;">
      <svg class="g-spinner" viewBox="0 0 48 48"><circle cx="24" cy="24" r="20"/></svg>
    </div>`;
  }

  try {
    let tracks = (album.tracks && Array.isArray(album.tracks) && album.tracks.length > 0) ? album.tracks : null;
    let albumArtist = album.artist || '';
    let albumYear = album.year || '';

    let ytmFetchMeta = null;
    if (!tracks && window.electronAPI && window.electronAPI.fetchYouTubeAlbumTracks && (album.platform === 'ytmusic' || String(album.id).startsWith('MPREb_') || String(album.id).startsWith('VL') || String(album.id).startsWith('PL'))) {
      try {
        const ytRes = await window.electronAPI.fetchYouTubeAlbumTracks(album.id, { accountId: activeYtmAccountId !== 'default' ? activeYtmAccountId : null });
        ytmFetchMeta = ytRes;
        if (ytRes && ytRes.success && !ytRes.failed && Array.isArray(ytRes.tracks)) {
          if (ytRes.tracks.length > 0 || ytRes.complete === true) {
            tracks = ytRes.tracks;
          }
        }
      } catch (_) {}
    }

    const isYtmEntity = album.platform === 'ytmusic' || String(album.id).startsWith('MPREb_') || String(album.id).startsWith('VL') || String(album.id).startsWith('PL') || (album.type && album.type.toLowerCase().includes('playlist'));
    if (!tracks && !isYtmEntity) {
      const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/albums/tracks?id=${encodeURIComponent(album.id)}&title=${encodeURIComponent(album.title || '')}&artist=${encodeURIComponent(album.artist || '')}`);
      const data = await res.json();
      if (currentAlbumRunId !== runId) return;

      if (!data || !data.success || !Array.isArray(data.tracks) || data.tracks.length === 0) {
        throw new Error(data && data.error ? data.error : 'Failed to load album tracks');
      }

      tracks = data.tracks;
      if (data.album && data.album.artist) albumArtist = data.album.artist;
      if (data.album && data.album.year) albumYear = data.album.year;
    } else if (!tracks && isYtmEntity) {
      throw new Error('Không thể tải danh sách bài hát từ YouTube Music. Vui lòng kiểm tra lại kết nối hoặc tài khoản.');
    }

    if (artistBtn && albumArtist) {
      if (album.type !== 'Daily Mix') {
        renderClickableArtists(artistBtn, albumArtist);
      } else {
        artistBtn.textContent = albumArtist;
      }
      artistBtn.title = `View ${albumArtist}`;
      artistBtn.onclick = null;
    }

    const computedMeta = syncEngine
      ? syncEngine.computeAlbumMetadata(tracks)
      : {
          trackCount: tracks.length,
          totalDurationSec: tracks.reduce((acc, t) => acc + ((typeof t.duration === 'number' && t.duration > 0) ? t.duration : (typeof t.durationMs === 'number' && t.durationMs > 0 ? Math.round(t.durationMs / 1000) : 0)), 0),
          state: tracks.length > 0 ? 'ready' : 'empty'
        };

    if (countEl) {
      countEl.textContent = syncEngine
        ? syncEngine.formatAlbumMetaLine({
            type: album.type || 'Danh sách phát',
            year: albumYear,
            status: computedMeta.state,
            trackCount: computedMeta.trackCount,
            totalDurationSec: computedMeta.totalDurationSec
          })
        : [album.type || 'Danh sách phát', albumYear, `${tracks.length} bản nhạc`].filter(Boolean).join(' • ');
    }

    album._tracks = tracks;
    album.trackCount = computedMeta.trackCount;
    album.totalDurationSec = computedMeta.totalDurationSec;

    // Persist hydrated metadata (trackCount, totalDurationSec, year, artist) only on complete/non-failed fetch
    const allowMetadataPersist = !ytmFetchMeta || (ytmFetchMeta.failed !== true && ytmFetchMeta.complete !== false);
    if (allowMetadataPersist) {
      try {
        const savedAlbs = getSavedAlbums();
        const albumKey = syncEngine ? syncEngine.getEntityIdentityKey(album, album.accountId || activeYtmAccountId) : null;
        const savedIdx = savedAlbs.findIndex(a => {
          if (albumKey && syncEngine) {
            return syncEngine.getEntityIdentityKey(a, a.accountId || activeYtmAccountId) === albumKey;
          }
          return (album.id && a.id === album.id && (!a.accountId || !album.accountId || a.accountId === album.accountId));
        });
        if (savedIdx >= 0) {
          savedAlbs[savedIdx].trackCount = computedMeta.trackCount;
          savedAlbs[savedIdx].totalDurationSec = computedMeta.totalDurationSec;
          if (albumYear && !savedAlbs[savedIdx].year) savedAlbs[savedIdx].year = albumYear;
          if (albumArtist && !savedAlbs[savedIdx].artist) savedAlbs[savedIdx].artist = albumArtist;
          setSavedAlbums(savedAlbs);
        }
      } catch (_) {}
    }

    const renderAlbumTrackRows = (trackList) => {
      if (!listEl) return;
      listEl.innerHTML = '';
      const currentCanonicalId = state.currentTrack ? getTrackCanonicalId(state.currentTrack) : '';
      trackList.forEach((t, idx) => {
        const trackItem = {
          id: t.id || `${album.id}_${t.disc || 1}_${t.no || (idx + 1)}`,
          title: t.title,
          artist: t.artist || albumArtist,
          albumArtist: albumArtist,
          duration: t.duration || Math.round((t.durationMs || 0) / 1000),
          durationMs: t.durationMs || (t.duration ? t.duration * 1000 : 0),
          cover: t.cover || t.thumbnail || album.cover,
          thumbnail: t.thumbnail || t.cover || album.cover,
          url: t.url || '',
          platform: t.platform || 'youtube',
          no: t.no || (idx + 1),
          disc: t.disc || 1,
          isExplicit: t.isExplicit
        };
        const row = createTrackRow(trackItem, idx, currentCanonicalId, 'album', trackList, listEl);
        row.addEventListener('click', (e) => {
          if (e.target.closest('.track-row-actions')) return;
          if (e.target.classList.contains('track-row-artist')) {
            e.stopPropagation();
            openArtistProfile(trackItem.artist);
            return;
          }
          e.stopImmediatePropagation();
          if (trackItem.url || trackItem.platform === 'local' || album.type === 'Daily Mix') {
            playTrack(trackItem, trackList, idx, 'album');
          } else if (typeof playAlbumFrom === 'function') {
            playAlbumFrom(album, trackList, idx);
          }
        }, true);
        listEl.appendChild(row);
      });
      highlightPlayingRow();
      const albumTracksCol = document.querySelector('#view-album .album-tracks-col');
      if (albumTracksCol) {
        albumTracksCol.scrollTop = 0;
        updateFade(albumTracksCol);
        if (!albumTracksCol._fadeBound) {
          albumTracksCol._fadeBound = true;
          albumTracksCol.addEventListener('scroll', () => updateFade(albumTracksCol), { passive: true });
        }
      }
    };

    // Set up sorting
    const albumSortEl = document.getElementById('album-sort');
    let currentDisplayTracks = sortTracksFor('album', tracks);
    renderAlbumTrackRows(currentDisplayTracks);

    if (albumSortEl) {
      albumSortEl.value = getTrackSortMode('album');
      albumSortEl.onchange = () => {
        setTrackSortMode('album', albumSortEl.value);
        currentDisplayTracks = sortTracksFor('album', tracks);
        renderAlbumTrackRows(currentDisplayTracks);
      };
      if (typeof setupSortDropdown === 'function') {
        setupSortDropdown('album-sort-dropdown', 'album-sort-trigger', 'album-sort-menu', 'album-sort-label', albumSortEl);
      }
    }

    // Set up Play, Shuffle, Download buttons
    const btnAlbumPlay = document.getElementById('btn-album-play');
    if (btnAlbumPlay) {
      btnAlbumPlay.onclick = (e) => {
        e.stopPropagation();
        if (currentDisplayTracks.length > 0) {
          const firstTrack = currentDisplayTracks[0];
          if (firstTrack.url || firstTrack.platform === 'local' || album.type === 'Daily Mix') {
            playTrack(firstTrack, currentDisplayTracks, 0, 'album');
          } else if (typeof playAlbumFrom === 'function') {
            playAlbumFrom(album, currentDisplayTracks, 0);
          }
        }
      };
    }

    const btnAlbumShuffle = document.getElementById('btn-album-shuffle');
    if (btnAlbumShuffle) {
      btnAlbumShuffle.onclick = (e) => {
        e.stopPropagation();
        if (currentDisplayTracks.length > 0) {
          const shuffled = currentDisplayTracks.slice().sort(() => Math.random() - 0.5);
          const firstTrack = shuffled[0];
          if (firstTrack.url || firstTrack.platform === 'local' || album.type === 'Daily Mix') {
            playTrack(firstTrack, shuffled, 0, 'album');
          } else if (typeof playAlbumFrom === 'function') {
            playAlbumFrom(album, shuffled, 0);
          }
        }
      };
    }

    const btnAlbumDownload = document.getElementById('btn-album-download');
    if (btnAlbumDownload) {
      btnAlbumDownload.onclick = (e) => {
        e.stopPropagation();
        if (typeof openDownloadAllModal === 'function') {
          openDownloadAllModal({ name: album.title || 'Album', tracks: currentDisplayTracks });
        }
      };
    }
  } catch (err) {
    if (currentAlbumRunId !== runId) return;
    if (listEl) {
      listEl.innerHTML = `<div class="empty-hint" style="color: var(--md-sys-color-error, #ba1a1a);">Failed to load album: ${escapeHtml(err.message)}</div>`;
    }
  }
}
window.openAlbum = openAlbum;

function updateRowFade(row) {
  if (!row) return;
  const maxScroll = row.scrollWidth - row.clientWidth;
  if (maxScroll <= 0) {
    row.classList.remove('fade-left', 'fade-right');
    return;
  }
  row.classList.toggle('fade-left', row.scrollLeft > 4);
  row.classList.toggle('fade-right', row.scrollLeft < maxScroll - 4);
}
window.updateRowFade = updateRowFade;

function bindHorizontalWheel(row) {
  if (!row || row._wheelBound) return;
  row._wheelBound = true;
  row.addEventListener('wheel', (e) => {
    if (row.scrollWidth <= row.clientWidth) return;
    const isHorizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey;
    if (!isHorizontal) return;
    const delta = e.shiftKey && Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    if ((delta < 0 && row.scrollLeft > 0) || (delta > 0 && row.scrollLeft < row.scrollWidth - row.clientWidth - 1)) {
      e.preventDefault();
      row.scrollBy({ left: delta, behavior: 'smooth' });
    }
  }, { passive: false });

  let isDown = false;
  let startX = 0;
  let scrollStart = 0;
  let dragged = false;

  row.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    isDown = true;
    dragged = false;
    startX = e.pageX - row.offsetLeft;
    scrollStart = row.scrollLeft;
  });
  window.addEventListener('mouseup', () => {
    isDown = false;
    setTimeout(() => { dragged = false; }, 40);
  });
  row.addEventListener('mousemove', (e) => {
    if (!isDown) return;
    const x = e.pageX - row.offsetLeft;
    const walk = (x - startX) * 1.5;
    if (Math.abs(walk) > 10) {
      dragged = true;
      row.scrollLeft = scrollStart - walk;
    }
  });
  row.addEventListener('click', (e) => {
    if (dragged) {
      e.preventDefault();
      e.stopImmediatePropagation();
      dragged = false;
    }
  }, true);

  row.addEventListener('scroll', () => updateRowFade(row), { passive: true });
  window.addEventListener('resize', () => updateRowFade(row), { passive: true });
  updateRowFade(row);
}
window.bindHorizontalWheel = bindHorizontalWheel;

const artistBioCache = new Map();

function formatCount(num) {
  if (!num || isNaN(num) || num <= 0) return '';
  if (num >= 1000000) {
    const v = (num / 1000000).toFixed(2);
    return (v.endsWith('.00') ? v.slice(0, -3) : v.endsWith('0') ? v.slice(0, -1) : v) + 'M';
  }
  if (num >= 1000) {
    return Math.round(num / 1000) + 'K';
  }
  return String(num);
}

const MULTI_ARTIST_EXCEPTIONS = new Set([
  'simon & garfunkel', 'hall & oates', 'brooks & dunn', 'tegan and sara',
  'earth, wind & fire', 'crosby, stills & nash', 'crosby, stills, nash & young',
  'mumford & sons', 'florence + the machine', 'florence & the machine',
  'belle & sebastian', 'belle and sebastian', 'emerson, lake & palmer',
  'kc & the sunshine band', 'kool & the gang', 'sly & the family stone',
  'echo & the bunnymen', 'coheed and cambria', 'angus & julia stone',
  'above & beyond', 'chase & status', 'gnarls barkley',
  'twenty one pilots', 'ac/dc', 't.a.t.u.', 'tylerthecreator', 'tyler, the creator'
]);
const FEAT_BRACKET_RE = new RegExp('\\s*[\\(\\[]\\s*(?:feat\\.?|ft\\.?|featuring|prod\\.?\\s*by)\\s+([^\\)\\]]+)[\\)\\]]', 'gi');
const ARTIST_SEP_RE = new RegExp('(\\s+(?:feat\\.?|ft\\.?|featuring|with|vs\\.?|\\u00d7|x)\\s+|\\s*(?:&|,|;|\\/|\\+)\\s*)', 'gi');

function splitArtistTokens(rawArtist) {
  rawArtist = stripYoutubeTopic(rawArtist);
  const str = String(rawArtist || '').trim();
  if (!str) return [{ type: 'artist', value: 'Unknown artist' }];
  if (MULTI_ARTIST_EXCEPTIONS.has(str.toLowerCase())) return [{ type: 'artist', value: str }];
  const cleanStr = str.replace(FEAT_BRACKET_RE, ' feat. $1');
  const parts = cleanStr.split(ARTIST_SEP_RE).filter(Boolean);
  if (parts.length <= 1) return [{ type: 'artist', value: str }];
  const tokens = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    ARTIST_SEP_RE.lastIndex = 0;
    if (ARTIST_SEP_RE.test(p)) {
      ARTIST_SEP_RE.lastIndex = 0;
      tokens.push({ type: 'sep', value: p });
    } else {
      const trimmed = p.trim();
      if (trimmed) tokens.push({ type: 'artist', value: trimmed });
    }
  }
  return tokens.length ? tokens : [{ type: 'artist', value: str }];
}

function renderClickableArtists(container, rawArtist) {
  rawArtist = stripYoutubeTopic(rawArtist);
  if (!container) return;
  container.innerHTML = '';
  splitArtistTokens(rawArtist).forEach((tok) => {
    if (tok.type === 'sep') {
      const sep = document.createElement('span');
      sep.className = 'artist-sep';
      sep.textContent = tok.value;
      container.appendChild(sep);
    } else {
      const span = document.createElement('span');
      span.className = 'artist-link-part';
      span.textContent = tok.value;
      span.dataset.artist = tok.value;
      span.addEventListener('click', (e) => {
        e.stopPropagation();
        if (tok.value && tok.value.toLowerCase() !== 'unknown artist') {
          if (el.tvKaraoke && !el.tvKaraoke.classList.contains('hidden') && typeof closeTvKaraoke === 'function') closeTvKaraoke();
          openArtistProfile(tok.value);
        }
      });
      container.appendChild(span);
    }
  });
}

let favArtistsCurrentList = [];

function isArtistFollowed(artistName) {
  if (!artistName) return false;
  const lower = artistName.trim().toLowerCase();
  const favs = safeArray('eclipse_favorite_artists');
  return favs.some(x => (typeof x === 'string' ? x : x.name || '').toLowerCase().trim() === lower);
}

function getFavoriteArtistsList() {
  const favsRaw = safeArray('eclipse_favorite_artists');
  if (!favsRaw || favsRaw.length === 0) return [];

  const unfollowedList = safeArray('eclipse_unfollowed_artists');
  const unfollowed = new Set(unfollowedList.map(a => (typeof a === 'string' ? a : a.name || '').toLowerCase().trim()));
  const metaCache = safeJson('eclipse_artist_meta_cache', {});

  const result = [];
  const seen = new Set();

  favsRaw.forEach(item => {
    const name = (typeof item === 'string' ? item : item.name || '').trim();
    if (!name) return;
    const lower = name.toLowerCase();
    if (unfollowed.has(lower) || seen.has(lower)) return;
    seen.add(lower);

    const cached = metaCache[lower] || {};
    result.push({
      name: name,
      avatar: (typeof item === 'object' && item.avatar) || cached.avatar || '',
      fans: (typeof item === 'object' && item.fans) || cached.fans || 0,
      plays: (typeof item === 'object' && item.plays) || 0,
      followed: true
    });
  });

  return result;
}

function toggleFollowArtist(artistName, meta = {}) {
  if (!artistName || !artistName.trim()) return false;
  const cleanName = artistName.trim();
  const lower = cleanName.toLowerCase();

  let favs = safeArray('eclipse_favorite_artists');
  let unfollowed = safeArray('eclipse_unfollowed_artists');
  const metaCache = safeJson('eclipse_artist_meta_cache', {});

  const isFav = favs.some(x => (typeof x === 'string' ? x : x.name || '').toLowerCase().trim() === lower);

  if (isFav) {
    favs = favs.filter(x => (typeof x === 'string' ? x : x.name || '').toLowerCase().trim() !== lower);
    if (!unfollowed.some(x => (typeof x === 'string' ? x : x.name || '').toLowerCase().trim() === lower)) {
      unfollowed.push(cleanName);
    }
  } else {
    unfollowed = unfollowed.filter(x => (typeof x === 'string' ? x : x.name || '').toLowerCase().trim() !== lower);
    const existingObj = favs.find(x => (typeof x === 'string' ? x : x.name || '').toLowerCase().trim() === lower);
    const obj = (typeof existingObj === 'object' && existingObj) ? existingObj : {
      name: cleanName,
      avatar: meta.avatar || metaCache[lower]?.avatar || '',
      fans: meta.fans || metaCache[lower]?.fans || 0
    };
    if (meta.avatar) obj.avatar = meta.avatar;
    if (meta.fans) obj.fans = meta.fans;
    favs.push(obj);
  }

  if (meta && (meta.avatar || meta.fans)) {
    metaCache[lower] = { ...(metaCache[lower] || {}), ...meta };
    localStorage.setItem('eclipse_artist_meta_cache', JSON.stringify(metaCache));
  }

  localStorage.setItem('eclipse_favorite_artists', JSON.stringify(favs));
  localStorage.setItem('eclipse_unfollowed_artists', JSON.stringify(unfollowed));

  const followed = !isFav;
  const btnFollow = document.getElementById('btn-artist-follow');
  const profName = document.getElementById('artist-profile-name');
  if (btnFollow && profName && profName.textContent.trim().toLowerCase() === lower) {
    btnFollow.classList.toggle('following', followed);
    tSet(btnFollow, followed ? 'Following' : 'Follow');
  }

  if (typeof renderSpotifyHome === 'function') renderSpotifyHome();
  if (homeMode === 'artists' && typeof renderHomeCarousel === 'function') renderHomeCarousel('artists');

  return followed;
}

function fetchFavArtistMeta(artistObj, card) {
  if (!artistObj || !artistObj.name) return Promise.resolve();
  const lower = (artistObj.name || '').toLowerCase();
  return fetch(`http://127.0.0.1:${state.serverPort}/api/artist?name=${encodeURIComponent(artistObj.name)}`)
    .then(r => r.json())
    .then(data => {
      if (data && data.success && data.artist) {
        const newAvatar = data.artist.avatar || data.artist.banner || '';
        const newFans = data.artist.fans || data.artist.nb_fan || 0;
        if (newAvatar) {
          if (card) {
            const img = card.querySelector('.fav-artist-img');
            if (img) img.src = newAvatar;
          }
          artistObj.avatar = newAvatar;
        }
        if (newFans) {
          artistObj.fans = newFans;
          if (!artistObj.plays || artistObj.plays <= 0) {
            if (card) {
              const badgeSpan = card.querySelector('.fav-artist-plays span');
              if (badgeSpan) badgeSpan.textContent = `${formatCount(newFans)} fans`;
            }
          }
        }
        const cache = safeJson('eclipse_artist_meta_cache', {});
        cache[lower] = {
          avatar: artistObj.avatar || '',
          fans: artistObj.fans || 0,
          plays: artistObj.plays || 0
        };
        localStorage.setItem('eclipse_artist_meta_cache', JSON.stringify(cache));
      }
    })
    .catch(() => {});
}

function buildFavArtistCircleCard(artistObj, forCarousel = false, idx = 0, autoFetch = true) {
  const card = document.createElement('div');
  if (forCarousel) {
    card.className = 'my-wave-track-card fav-artist-carousel-card';
    if (typeof idx === 'number') card.dataset.index = String(idx);
  } else {
    card.className = 'fav-artist-card';
  }

  const metaCache = safeJson('eclipse_artist_meta_cache', {});
  const lower = (artistObj.name || '').toLowerCase();
  const cached = metaCache[lower];

  let avatar = artistObj.avatar || (cached && cached.avatar) || '';
  let fans = artistObj.fans || (cached && cached.fans) || 0;
  let plays = artistObj.plays || (cached && cached.plays) || 0;
  artistObj.avatar = avatar;
  artistObj.fans = fans;
  artistObj.plays = plays;

  const playText = plays > 0
    ? `${formatCount(plays)} play${plays === 1 ? '' : 's'}`
    : (fans > 0 ? `${formatCount(fans)} fans` : '0 plays');

  const circleHtml = `
    <div class="fav-artist-circle">
      <img class="fav-artist-img" src="${escapeHtml(avatar)}" alt="${escapeHtml(artistObj.name)}" onerror="this.src='data:image/svg+xml;utf8,<svg xmlns=\\'http://www.w3.org/2000/svg\\' width=\\'152\\' height=\\'152\\' fill=\\'%23333\\'><circle cx=\\'76\\' cy=\\'76\\' r=\\'76\\' fill=\\'%232a2a2a\\'/></svg>'">
      <div class="fav-artist-plays"><svg viewBox="0 0 24 24"><polygon points="6 4 20 12 6 20 6 4"/></svg><span>${escapeHtml(playText)}</span></div>
      <div class="fav-artist-hover">
        <button type="button" class="fav-artist-action-btn primary btn-play-fav" title="Play ${escapeHtml(artistObj.name)}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
          <span>Play</span>
        </button>
        <button type="button" class="fav-artist-action-btn btn-view-fav" title="View profile">Profile</button>
      </div>
    </div>
  `;

  if (forCarousel) {
    card.innerHTML = circleHtml;
  } else {
    card.innerHTML = `
      ${circleHtml}
      <div class="fav-artist-name" title="${escapeHtml(artistObj.name)}">${escapeHtml(artistObj.name)}</div>
    `;
  }

  if (autoFetch && (!avatar || !fans)) {
    fetchFavArtistMeta(artistObj, card);
  }

  const btnPlay = card.querySelector('.btn-play-fav');
  if (btnPlay) {
    btnPlay.addEventListener('click', (e) => {
      e.stopPropagation();
      openArtistProfile(artistObj.name).then(() => {
        const btnPlayTracks = document.getElementById('btn-play-artist-tracks');
        if (btnPlayTracks) btnPlayTracks.click();
      }).catch(() => {});
    });
  }

  const btnView = card.querySelector('.btn-view-fav');
  if (btnView) {
    btnView.addEventListener('click', (e) => {
      e.stopPropagation();
      openArtistProfile(artistObj.name);
    });
  }

  const nameEl = card.querySelector('.fav-artist-name');
  if (nameEl) {
    nameEl.addEventListener('click', (e) => {
      e.stopPropagation();
      openArtistProfile(artistObj.name);
    });
  }

  if (forCarousel) {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.fav-artist-hover')) return;
      const row = document.getElementById('home-vibe-grid');
      const focusedIndex = (row && typeof row._focusedIndex === 'number') ? row._focusedIndex : 0;
      if (idx === focusedIndex) {
        openArtistProfile(artistObj.name);
      } else if (row) {
        scrollCarouselTo(row, idx);
      }
    });
  } else {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.fav-artist-hover')) return;
      openArtistProfile(artistObj.name);
    });
  }

  return card;
}

function renderM3Loader(container, size = 52) {
  if (!container) return;
  container.innerHTML = `
    <div class="m3-loader-container" style="display:flex;justify-content:center;align-items:center;padding:48px 0;width:100%;">
      <svg class="m3-search-loader" width="${size}" height="${size}" viewBox="-180 -180 360 360">
        <path fill="var(--md-sys-color-primary)"/>
      </svg>
    </div>
  `;
  const svg = container.querySelector('.m3-search-loader');
  const path = svg ? svg.querySelector('path') : null;
  if (!svg || !path) return;
  const S = window.RiffShapes;
  if (!S || !S.ready()) {
    container.innerHTML = `<div class="m3-loader-container" style="display:flex;justify-content:center;align-items:center;padding:48px 0;width:100%;"><svg class="g-spinner" viewBox="0 0 48 48"><circle cx="24" cy="24" r="20"/></svg></div>`;
    return;
  }
  let fromIdx = 0, toIdx = S.next(0), start = performance.now();
  const K = S.K;
  function frame(now) {
    if (!svg.isConnected) return;
    if (now - start >= 2000) { fromIdx = toIdx; toIdx = S.next(fromIdx); start = now; }
    const e = S.ease(Math.min(1, (now - start) / 1200));
    const a = S.profile(fromIdx), b = S.profile(toIdx);
    const rot = ((now % 6000) / 6000) * Math.PI * 2;
    let d = '';
    for (let k = 0; k < K; k += 3) {
      const th = -Math.PI + (Math.PI * 2 * k) / K + rot;
      const r = a[k] + (b[k] - a[k]) * e;
      d += `${k === 0 ? 'M' : 'L'}${(Math.cos(th) * r).toFixed(1)},${(Math.sin(th) * r).toFixed(1)}`;
    }
    path.setAttribute('d', d + 'Z');
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

async function openArtistProfile(artistName, hintTrack = null) {
  if (!artistName || !artistName.trim()) return;
  const cleanName = artistName.replace(/ - Topic|VEVO|Official|Records/gi, '').trim();

  state.previousView = state.currentView;
  switchView('artist');

  const hero = document.getElementById('artist-hero');
  if (hero) {
    hero.style.removeProperty('--artist-accent-color');
    document.documentElement.style.removeProperty('--artist-accent-color');
  }

  const aboutCard = document.getElementById('artist-about-card');
  const btnBioMore = document.getElementById('btn-artist-bio-more');
  if (aboutCard) aboutCard.classList.add('hidden');
  if (btnBioMore) btnBioMore.classList.add('hidden');

  const horizTabs = document.getElementById('artist-horiz-tabs');
  const tabTracks = document.getElementById('artist-tab-tracks');
  const tabAlbums = document.getElementById('artist-tab-albums');
  const paneTracks = document.getElementById('artist-pane-tracks');
  const paneAlbums = document.getElementById('artist-pane-albums');
  const albumsGrid = document.getElementById('artist-albums-grid');

  if (horizTabs) horizTabs.style.display = 'none';

  if (tabTracks && tabAlbums && paneTracks && paneAlbums) {
    tabTracks.classList.add('active');
    tabAlbums.classList.remove('active');
    paneTracks.classList.remove('hidden');
    paneTracks.classList.add('active');
    paneAlbums.classList.add('hidden');
    paneAlbums.classList.remove('active');

    tabTracks.onclick = () => {
      tabTracks.classList.add('active');
      tabAlbums.classList.remove('active');
      paneTracks.classList.remove('hidden');
      paneTracks.classList.add('active');
      paneTracks.style.animation = 'none';
      void paneTracks.offsetWidth;
      paneTracks.style.animation = '';
      paneAlbums.classList.add('hidden');
      paneAlbums.classList.remove('active');
    };
    tabAlbums.onclick = () => {
      tabAlbums.classList.add('active');
      tabTracks.classList.remove('active');
      paneAlbums.classList.remove('hidden');
      paneAlbums.classList.add('active');
      paneAlbums.style.animation = 'none';
      void paneAlbums.offsetWidth;
      paneAlbums.style.animation = '';
      paneTracks.classList.add('hidden');
      paneTracks.classList.remove('active');
    };
  }
  if (albumsGrid) {
    renderM3Loader(albumsGrid);
  }

  let artistTracksExpanded = false;
  const btnTracksToggle = document.getElementById('btn-artist-tracks-toggle');
  if (btnTracksToggle) {
    btnTracksToggle.textContent = 'Show all';
    btnTracksToggle.classList.add('hidden');
  }

  if (el.artistProfileName) el.artistProfileName.textContent = cleanName;
  const btnFollow = document.getElementById('btn-artist-follow');
  if (btnFollow) {
    const isFollowed = isArtistFollowed(cleanName);
    btnFollow.classList.toggle('following', isFollowed);
    tSet(btnFollow, isFollowed ? 'Following' : 'Follow');
    btnFollow.onclick = () => {
      const meta = {
        avatar: (state.currentArtistData && (state.currentArtistData.avatar || state.currentArtistData.banner)) || '',
        fans: (state.currentArtistData && (state.currentArtistData.fans || state.currentArtistData.nb_fan)) || 0
      };
      const nowFollowed = toggleFollowArtist(cleanName, meta);
      showToast(nowFollowed ? `Following ${cleanName}` : `Unfollowed ${cleanName}`, 'info');
    };
  }
  const btnBlock = document.getElementById('btn-artist-block');
  if (btnBlock) {
    const isBlocked = isArtistBlocked(cleanName);
    btnBlock.classList.toggle('blocked', isBlocked);
    btnBlock.textContent = isBlocked ? 'Blocked' : 'Block';
    btnBlock.onclick = () => {
      const nowBlocked = toggleBlockArtist(cleanName);
      btnBlock.classList.toggle('blocked', nowBlocked);
      btnBlock.textContent = nowBlocked ? 'Blocked' : 'Block';
    };
  }
  if (el.artistProfileBio) {
    el.artistProfileBio.textContent = '';
    el.artistProfileBio.classList.remove('fade-end');
  }
  if (el.artistTracksCount) el.artistTracksCount.textContent = 'Searching...';
  if (el.artistHeroImg) {
    el.artistHeroImg.src = '';
    el.artistHeroImg.style.display = 'none';
  }
  if (el.artistFansLine) {
    el.artistFansLine.textContent = '';
    el.artistFansLine.style.display = 'none';
  }
  if (el.artistVerifiedBadge) el.artistVerifiedBadge.classList.add('hidden');
  if (el.artistTracksList) renderM3Loader(el.artistTracksList);

  const bioCacheKey = cleanName.toLowerCase();
  let bioFromCache = false;
  if (artistBioCache.has(bioCacheKey)) {
    const cached = artistBioCache.get(bioCacheKey);
    if (cached && el.artistProfileBio) {
      bioFromCache = true;
      el.artistProfileBio.textContent = cached;
      if (aboutCard) aboutCard.classList.remove('hidden');
      requestAnimationFrame(() => {
        const isOverflowing = el.artistProfileBio.scrollHeight > el.artistProfileBio.clientHeight + 1;
        el.artistProfileBio.classList.toggle('fade-end', isOverflowing);
        if (btnBioMore) btnBioMore.classList.toggle('hidden', !isOverflowing);
      });
    }
  }

  const bioController = new AbortController();
  const bioTimeout = setTimeout(() => bioController.abort(), 8000);

  try {
    const hint = (hintTrack && hintTrack.title) || (state.currentTrack && state.currentTrack.title) || '';
    const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/artist?name=${encodeURIComponent(cleanName)}&hintTrack=${encodeURIComponent(hint)}`, { signal: bioController.signal });
    clearTimeout(bioTimeout);
    const data = await res.json();

    if (!data.success || !data.artist) throw new Error('Artist not found');

    state.currentArtistData = data.artist;
    if (el.artistProfileName) el.artistProfileName.textContent = data.artist.name;
    if (btnFollow) {
      btnFollow.onclick = () => {
        const meta = {
          avatar: (data.artist && (data.artist.avatar || data.artist.banner)) || '',
          fans: (data.artist && (data.artist.fans || data.artist.nb_fan)) || 0
        };
        const nowFollowed = toggleFollowArtist(cleanName, meta);
        showToast(nowFollowed ? `Following ${cleanName}` : `Unfollowed ${cleanName}`, 'info');
      };
    }
    if (data.artist) {
      const lower = cleanName.toLowerCase();
      const cache = safeJson('eclipse_artist_meta_cache', {});
      cache[lower] = {
        avatar: data.artist.avatar || data.artist.banner || (cache[lower] && cache[lower].avatar) || '',
        fans: data.artist.fans || data.artist.nb_fan || (cache[lower] && cache[lower].fans) || 0,
        plays: (cache[lower] && cache[lower].plays) || 0
      };
      localStorage.setItem('eclipse_artist_meta_cache', JSON.stringify(cache));
    }

    if (!bioFromCache) {
      const rawBio = (data.artist && data.artist.bio) ? data.artist.bio : '';
      const cleanBio = rawBio.replace(/<[^>]*>/g, '').trim();
      if (cleanBio) {
        artistBioCache.set(bioCacheKey, cleanBio);
        boundMap(artistBioCache, 20);
        if (el.artistProfileBio) {
          el.artistProfileBio.textContent = cleanBio;
          if (aboutCard) aboutCard.classList.remove('hidden');
          requestAnimationFrame(() => {
            const isOverflowing = el.artistProfileBio.scrollHeight > el.artistProfileBio.clientHeight + 1;
            el.artistProfileBio.classList.toggle('fade-end', isOverflowing);
            if (btnBioMore) btnBioMore.classList.toggle('hidden', !isOverflowing);
          });
        }
      } else {
        artistBioCache.set(bioCacheKey, '');
        boundMap(artistBioCache, 20);
        if (aboutCard) aboutCard.classList.add('hidden');
        if (el.artistProfileBio) {
          el.artistProfileBio.textContent = '';
          el.artistProfileBio.classList.remove('fade-end');
        }
      }
    }

    if (el.artistVerifiedBadge) el.artistVerifiedBadge.classList.toggle('hidden', !data.artist.isVerified);

    const fans = data.artist.fans || data.artist.nb_fan || 0;
    const rawListeners = data.artist.monthlyListeners || (fans > 0 ? `${formatCount(fans)} monthly listeners` : '');
    if (el.artistFansLine) {
      if (rawListeners) {
        tSet(el.artistFansLine, rawListeners);
        el.artistFansLine.style.display = 'block';
      } else {
        el.artistFansLine.textContent = '';
        el.artistFansLine.style.display = 'none';
      }
    }

    const banner = data.artist.banner || data.artist.avatar || '';
    const avatar = data.artist.avatar || '';

    if (el.artistHeroImg) {
      if (banner) {
        el.artistHeroImg.src = banner;
        el.artistHeroImg.style.display = 'block';
        el.artistHeroImg.onerror = () => {
          if (avatar && el.artistHeroImg.src !== avatar) {
            el.artistHeroImg.src = avatar;
          } else {
            el.artistHeroImg.style.display = 'none';
          }
        };
      } else {
        el.artistHeroImg.src = '';
        el.artistHeroImg.style.display = 'none';
      }
    }

    const heroColorImg = banner || avatar;
    if (heroColorImg) {
      getCoverDominantColors(heroColorImg).then(([domColor]) => {
        if (state.currentView === 'artist' && hero) {
          const c = domColor || 'var(--md-sys-color-primary-container)';
          hero.style.setProperty('--artist-accent-color', c);
          document.documentElement.style.setProperty('--artist-accent-color', c);
        }
      }).catch(() => {
        if (hero) {
          hero.style.setProperty('--artist-accent-color', 'var(--md-sys-color-primary-container)');
          document.documentElement.style.setProperty('--artist-accent-color', 'var(--md-sys-color-primary-container)');
        }
      });
    } else {
      if (hero) hero.style.setProperty('--artist-accent-color', 'var(--md-sys-color-primary-container)');
    }

    if (el.artistTracksCount) el.artistTracksCount.textContent = `${data.artist.tracks.length} tracks`;

    const allTracks = data.artist.tracks || [];
    state.artistTracks = allTracks;
    if (btnTracksToggle) {
      btnTracksToggle.textContent = 'Show all';
      btnTracksToggle.classList.toggle('hidden', allTracks.length <= 5);
      btnTracksToggle.onclick = () => {
        artistTracksExpanded = !artistTracksExpanded;
        btnTracksToggle.textContent = artistTracksExpanded ? 'Show less' : 'Show all';
        renderArtistTracks();
      };
    }

    function renderArtistTracks() {
      const count = artistTracksExpanded ? allTracks.length : Math.min(5, allTracks.length);
      const visibleTracks = allTracks.slice(0, count);
      if (el.artistTracksList) renderTracks(el.artistTracksList, visibleTracks, 'artist');
    }

    requestAnimationFrame(() => {
      renderArtistTracks();
    });

    async function renderArtistAlbums() {
      if (!albumsGrid) return;
      const validAlbums = (Array.isArray(data?.artist?.albums) ? data.artist.albums : []).filter(a => a && a.title && a.artist && a.artist.toLowerCase().trim() === cleanName.toLowerCase().trim());

      if (validAlbums.length === 0) {
        if (horizTabs) horizTabs.style.display = 'none';
        if (paneTracks) paneTracks.classList.remove('hidden');
        if (paneAlbums) paneAlbums.classList.add('hidden');
        albumsGrid.innerHTML = '';
        return;
      }

      if (horizTabs) horizTabs.style.display = 'flex';
      albumsGrid.innerHTML = validAlbums.map(alb => {
        const sub = alb.year ? `${escapeHtml(alb.artist || cleanName)} · ${escapeHtml(alb.year)}` : escapeHtml(alb.artist || cleanName);
        return `
          <div class="search-album-card" role="button" tabindex="0">
            ${alb.cover ? `<img class="search-album-cover" src="${escapeHtml(alb.cover)}" alt="${escapeHtml(alb.title || '')}" loading="lazy" onerror="this.style.display='none'" />` : '<div class="search-album-cover" style="display:flex;align-items:center;justify-content:center;background:var(--md-sys-color-surface-container-high);"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--md-sys-color-outline);"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg></div>'}
            <div class="search-album-info">
              <span class="search-album-title" title="${escapeHtml(alb.title || '')}">${escapeHtml(alb.title || '')}</span>
              <span class="search-album-sub" title="${sub}">${sub}</span>
            </div>
          </div>
        `;
      }).join('');

      const cards = albumsGrid.querySelectorAll('.search-album-card');
      cards.forEach((card, idx) => {
        const alb = validAlbums[idx];
        if (!alb) return;
        card.addEventListener('click', () => openAlbum(alb));
        card.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            openAlbum(alb);
          }
        });
      });
    }

    renderArtistAlbums();
  } catch (e) {
    clearTimeout(bioTimeout);
    console.warn('Artist load error:', e);
    if (horizTabs) horizTabs.style.display = 'none';
    if (paneAlbums) paneAlbums.classList.add('hidden');
    if (paneTracks) paneTracks.classList.remove('hidden');
    if (el.artistHeroImg) {
      el.artistHeroImg.src = '';
      el.artistHeroImg.style.display = 'none';
    }
    if (hero) hero.style.setProperty('--artist-accent-color', 'var(--md-sys-color-primary-container)');
    if (aboutCard && !bioFromCache) aboutCard.classList.add('hidden');
    if (btnTracksToggle) btnTracksToggle.classList.add('hidden');
    if (el.artistProfileBio && !bioFromCache) {
      el.artistProfileBio.textContent = '';
      el.artistProfileBio.classList.remove('fade-end');
    }
    if (el.artistTracksList) el.artistTracksList.innerHTML = '<div class="empty-hint">No tracks found for this artist.</div>';
    if (albumsGrid) albumsGrid.innerHTML = '';
  }
}

const btnArtistBioMore = document.getElementById('btn-artist-bio-more');
const artistBioModal = document.getElementById('artist-bio-modal');
const btnCloseArtistBio = document.getElementById('btn-close-artist-bio');
if (btnArtistBioMore) {
  btnArtistBioMore.addEventListener('click', () => {
    const modalTitle = document.getElementById('artist-bio-modal-title');
    const modalBody = document.getElementById('artist-bio-modal-body');
    if (modalTitle) modalTitle.textContent = state.currentArtistData?.name || el.artistProfileName?.textContent || 'Artist';
    if (modalBody) modalBody.textContent = (el.artistProfileBio ? el.artistProfileBio.textContent : '');
    if (artistBioModal) openModal(artistBioModal);
  });
}
if (btnCloseArtistBio) {
  btnCloseArtistBio.addEventListener('click', () => {
    if (artistBioModal) closeModal(artistBioModal);
  });
}
if (artistBioModal) {
  artistBioModal.addEventListener('click', (e) => {
    if (e.target === artistBioModal) closeModal(artistBioModal);
  });
}

if (typeof el !== 'undefined' && el.btnBackArtist) {
  el.btnBackArtist.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const target = (state.previousView && state.previousView !== 'artist') ? state.previousView : 'discover';
    switchView(target);
  };
}

if (typeof el !== 'undefined' && el.btnBackAlbum) {
  el.btnBackAlbum.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const target = (state.previousView && state.previousView !== 'album') ? state.previousView : 'discover';
    switchView(target);
  };
}

if (typeof el !== 'undefined' && el.playbarArtist) {
  el.playbarArtist.addEventListener('click', (e) => {
    e.stopPropagation();
    if (state.currentTrack && state.currentTrack.artist) {
      openArtistProfile(state.currentTrack.artist);
    }
  });
}

if (typeof el !== 'undefined' && el.rightPanelArtist) {
  el.rightPanelArtist.addEventListener('click', (e) => {
    e.stopPropagation();
    if (state.currentTrack && state.currentTrack.artist) {
      openArtistProfile(state.currentTrack.artist);
    }
  });
}
