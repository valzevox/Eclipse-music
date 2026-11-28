// src/renderer/modules/import.js
// Playlist/library import, track matching, browser login & extension pairing, and account/playlist export.

function createWavyProgress(container) {
  const W = 240, H = 12, WL = 16; let d = `M0 ${H/2}`;
  for (let x = 0; x < W; x += WL) d += ` q ${WL/4} ${-H/2} ${WL/2} 0 t ${WL/2} 0`;
  container.innerHTML = `<svg class="wavy" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><path class="wavy-track" pathLength="100" d="${d}"/><path class="wavy-fill" pathLength="100" d="${d}"/></svg>`;
  const fill = container.querySelector('.wavy-fill'); fill.style.strokeDasharray = '100'; fill.style.strokeDashoffset = '100';
  return { set(p) { fill.style.strokeDashoffset = String(100 - Math.max(0, Math.min(100, p))); } };
}
window.createWavyProgress = createWavyProgress;

async function pool(items, n, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const cur = idx++;
      results[cur] = await fn(items[cur], cur);
    }
  }
  const workers = Array.from({ length: Math.min(n, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

function normalizeImportText(str) {
  if (!str) return '';
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s*[\(\[](?:feat|ft)\.?\s+[^)\]]+[)\]]/gi, '')
    .replace(/\s*-\s*remaster(?:ed)?\b.*/gi, '')
    .replace(/[\(\[][^)\]]*remaster(?:ed)?[^)\]]*[)\]]/gi, '')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function toSeconds(dur) {
  if (typeof dur === 'string') {
    const trimmed = dur.trim();
    if (/^\d+(:\d{1,2}){1,2}$/.test(trimmed)) {
      return trimmed.split(':').map(Number).reduce((acc, n) => acc * 60 + n, 0);
    }
    const num = Number(trimmed);
    if (!Number.isNaN(num) && num > 0) {
      return num > 1000 ? Math.round(num / 1000) : Math.round(num);
    }
    return 0;
  }
  if (typeof dur === 'number' && dur > 0) {
    return dur > 1000 ? Math.round(dur / 1000) : Math.round(dur);
  }
  return 0;
}

function splitArtists(artistStr) {
  if (!artistStr) return [];
  const clean = String(artistStr).replace(/\u00a0/g, ' ');
  return clean
    .split(/[,;&]|(?:\bfeat\.?\b)|(?:\bft\.?\b)|(?:\s+[xX]\s+)/i)
    .map(a => normalizeImportText(a))
    .filter(Boolean);
}

const CYR = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya', і: 'i', ї: 'yi', є: 'ye', ґ: 'g' };
function normalizeForMatch(s) {
  return String(s || '').toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/\b(feat|ft|remaster(ed)?|remix|version|official|audio|video|lyrics?)\b.*$/g, ' ')
    .split('').map((c) => (CYR[c] !== undefined ? CYR[c] : c)).join('')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function tokenSimilarity(a, b) {
  const A = new Set(normalizeForMatch(a).split(' ').filter(Boolean));
  const B = new Set(normalizeForMatch(b).split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  let hit = 0;
  A.forEach((t) => { if (B.has(t)) hit++; });
  return hit / Math.max(A.size, B.size);
}
function pickBestMatch(sp, results) {
  let best = null;
  let bestScore = 0;
  for (const r of results) {
    const text = tokenSimilarity(`${sp.title} ${sp.artist}`, `${r.title} ${r.artist}`);
    const titleSim = tokenSimilarity(sp.title, r.title);
    const dDiff = sp.duration && r.duration ? Math.abs(sp.duration - r.duration) : 99;
    const durationOk = dDiff <= 3;
    const score = text + (durationOk ? 0.6 : 0) + titleSim * 0.3;
    const accept = (durationOk && text >= 0.2) || titleSim >= 0.6 || text >= 0.55;
    if (accept && score > bestScore) { best = r; bestScore = score; }
  }
  return best;
}

let activeImportToast = null;

function showImportSpinnerToast(msg = 'Importing playlist...') {
  const container = document.getElementById('toast-container');
  if (!container) return null;
  if (activeImportToast && activeImportToast.parentNode === container) {
    const textSpan = activeImportToast.querySelector('.toast-text');
    if (textSpan) textSpan.textContent = msg;
    return activeImportToast;
  }
  const toast = document.createElement('div');
  const spinnerSvg = '<svg class="g-spinner" style="width:18px;height:18px;" viewBox="0 0 48 48"><circle cx="24" cy="24" r="20"/></svg>';
  toast.className = 'eclipse-toast info wide';
  toast.innerHTML = `<span class="toast-icon">${spinnerSvg}</span><span class="toast-text">${escapeHtml(msg)}</span>`;
  container.appendChild(toast);
  activeImportToast = toast;
  return toast;
}

function dismissImportSpinnerToast() {
  if (activeImportToast && activeImportToast.parentNode) {
    activeImportToast.remove();
  }
  activeImportToast = null;
}

function hydrateMissingPlaylistCovers() {}

async function matchSpotifyTracks(rawTracks, playlistName = 'Playlist', onProgress, options = {}) {
  if (el && el.linkImportModal) closeModal(el.linkImportModal);
  if (typeof playlistName === 'function') {
    const origProg = playlistName;
    if (typeof onProgress === 'object' && onProgress !== null) {
      options = onProgress;
    }
    onProgress = origProg;
    playlistName = options.playlistName || options.name || 'Playlist';
  } else if (typeof playlistName === 'object' && playlistName !== null) {
    options = playlistName;
    playlistName = options.playlistName || options.name || 'Playlist';
  }
  if (!options || typeof options !== 'object') options = {};
  if (!playlistName || typeof playlistName !== 'string') playlistName = options.playlistName || options.name || 'Playlist';

  const list = Array.isArray(rawTracks) ? rawTracks : [];
  const total = list.length;

  const container = document.getElementById('toast-container');
  let toast = null;
  let textSpan = null;
  let iconSpan = null;
  const spinnerSvg = '<svg class="g-spinner" style="width:18px;height:18px;" viewBox="0 0 48 48"><circle cx="24" cy="24" r="20"/></svg>';
  const checkmarkSvg = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><polyline points="5 12.5 10 17.5 19 7.5"/></svg>';

  if (activeImportToast && activeImportToast.parentNode === container) {
    toast = activeImportToast;
    textSpan = toast.querySelector('.toast-text');
    iconSpan = toast.querySelector('.toast-icon');
    if (textSpan) textSpan.textContent = `Importing ${escapeHtml(playlistName)}... (0/${total})`;
  } else if (container) {
    toast = document.createElement('div');
    toast.className = 'eclipse-toast info wide';
    toast.innerHTML = `<span class="toast-icon">${spinnerSvg}</span><span class="toast-text">Importing ${escapeHtml(playlistName)}... (0/${total})</span>`;
    container.appendChild(toast);
    textSpan = toast.querySelector('.toast-text');
    iconSpan = toast.querySelector('.toast-icon');
    activeImportToast = toast;
  }

  const chunkSize = 15;
  const converted = [];
  let processed = 0;

  for (let i = 0; i < total; i += chunkSize) {
    const chunk = list.slice(i, i + chunkSize);
    const batchToMatch = [];

    for (const rt of chunk) {
      if (!rt) continue;
      const title = String(rt.title || rt.name || '').trim();
      const artist = String(rt.artist || rt.artists || 'Unknown Artist').trim();
      const thumb = String(
        rt.thumbnail || rt.cover || rt.image || rt.artwork ||
        rt.album?.images?.[0]?.url || rt.albumCover ||
        (rt.id && !/^(cand_|dz_|it_|sp_|ym_)/i.test(rt.id) ? 'https://i.ytimg.com/vi/' + rt.id + '/hqdefault.jpg' : '') ||
        ''
      ).trim();

      const srcPlat = (rt.platform === 'youtube' || rt.platform === 'ytmusic' || rt.platform === 'soundcloud')
        ? rt.platform
        : (options.sourcePlatform === 'youtube' || options.sourcePlatform === 'ytmusic' || options.sourcePlatform === 'soundcloud' ? options.sourcePlatform : '');

      if (srcPlat) {
        converted.push({
          id: rt.id ? String(rt.id) : ('cand_' + Math.random().toString(36).slice(2, 10)),
          title,
          artist,
          duration: Number(rt.duration) || 0,
          thumbnail: thumb,
          cover: thumb,
          url: rt.url || '',
          searchQuery: `${artist} - ${title}`,
          platform: srcPlat,
          addedAt: Date.now()
        });
      } else {
        batchToMatch.push({
          id: rt.id ? String(rt.id) : ('sp_' + Math.random().toString(36).slice(2, 10)),
          title,
          artist,
          duration: Number(rt.duration) || 0,
          thumbnail: thumb,
          cover: thumb
        });
      }
    }

    if (batchToMatch.length > 0) {
      try {
        const matchRes = await fetch(`http://127.0.0.1:${state.serverPort}/api/batch-match-tracks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tracks: batchToMatch, autoLyrics: true })
        });
        const matchData = await matchRes.json().catch(() => null);
        const matchedList = (matchData && Array.isArray(matchData.tracks)) ? matchData.tracks : batchToMatch;
        for (const m of matchedList) {
          converted.push({
            id: m.id || ('sp_' + Math.random().toString(36).slice(2, 10)),
            title: m.title,
            artist: m.artist,
            duration: Number(m.duration) || 0,
            thumbnail: m.thumbnail || m.cover || '',
            cover: m.cover || m.thumbnail || '',
            url: m.url || (m.id && /^[a-zA-Z0-9_-]{11}$/.test(m.id) ? `https://www.youtube.com/watch?v=${m.id}` : ''),
            searchQuery: `${m.artist} - ${m.title}`,
            platform: m.platform || 'ytmusic',
            hasSyncedLyrics: !!m.hasSyncedLyrics,
            addedAt: Date.now()
          });
        }
      } catch (_) {
        for (const item of batchToMatch) {
          converted.push({
            ...item,
            searchQuery: `${item.artist} - ${item.title}`,
            platform: 'ytmusic',
            addedAt: Date.now()
          });
        }
      }
    }

    processed = Math.min(i + chunkSize, total);
    if (textSpan) {
      textSpan.textContent = `Matching & Importing ${playlistName}... (${processed}/${total})`;
    }
    if (typeof onProgress === 'function') {
      onProgress(processed, total);
    }
    if (total > chunkSize) {
      await new Promise(r => setTimeout(r, 0));
    }
  }
  const validTracks = converted.filter(t => t && t.title);
  const failedCount = total - validTracks.length;
  validTracks.failStats = {
    errors: 0,
    nomatch: failedCount,
    commonError: ''
  };

  if (toast) {
    toast.className = 'eclipse-toast success wide';
    if (iconSpan) iconSpan.innerHTML = checkmarkSvg;
    if (textSpan) textSpan.textContent = `Imported ${validTracks.length} tracks${failedCount > 0 ? ' (' + failedCount + ' not found)' : ''}`;
    if (activeImportToast === toast) activeImportToast = null;
    setTimeout(() => {
      toast.classList.add('leaving');
      setTimeout(() => { if (toast.parentNode) toast.remove(); }, 320);
    }, 4500);
  }

  return validTracks;
}

const spotifyModal = document.getElementById('spotify-import-modal');
const btnOpenSpotifyImport = document.getElementById('btn-open-spotify-import');
const btnCancelSpotifyImport = document.getElementById('btn-cancel-spotify-import');
const btnConfirmSpotifyImport = document.getElementById('btn-confirm-spotify-import');
const spotifyImportUrl = document.getElementById('spotify-import-url');
const spotifyImportTarget = document.getElementById('spotify-import-target');
const spotifyTargetDropdown = document.getElementById('spotify-target-dropdown');
const spotifyTargetTrigger = document.getElementById('spotify-target-trigger');
const spotifyTargetLabel = document.getElementById('spotify-target-label');
const spotifyTargetMenu = document.getElementById('spotify-target-menu');
const spotifyProgressWrap = document.getElementById('spotify-import-progress-wrap');
const spotifyWavyContainer = document.getElementById('spotify-import-wavy-container');
const spotifyProgressLabel = document.getElementById('spotify-import-progress-label');
const spotifyStatus = document.getElementById('spotify-import-status');
const spotifyLinkError = document.getElementById('spotify-link-error');
const spotifyBtnIcon = document.getElementById('spotify-import-btn-icon');
const spotifyBtnText = document.getElementById('spotify-import-btn-text');

const spModesContainer = document.getElementById('sp-modes');
const btnSpPickFiles = document.getElementById('btn-sp-pick-files');
const spFileInput = document.getElementById('sp-file-input');
const spFileInfo = document.getElementById('sp-file-info');
const spChkLikes = document.getElementById('sp-chk-likes');
const spChkPlaylists = document.getElementById('sp-chk-playlists');
const spClientIdInput = document.getElementById('sp-client-id');
const btnSpLogin = document.getElementById('btn-sp-login');
const spRedirectUri = document.getElementById('sp-redirect-uri');
const spLoginStatus = document.getElementById('sp-login-status');
const spChkLikes2 = document.getElementById('sp-chk-likes-2');
const spChkPlaylists2 = document.getElementById('sp-chk-playlists-2');
let currentSpotifyImportMode = 'link';
let parsedSpotifyExport = { likes: [], playlists: [] };
let spLoginPollTimer = null;
let spotifyConnected = false;
function getSpotifyHeaders() {
  const tok = (window.electronAPI && window.electronAPI.serverToken) || (state && state.serverToken) || '';
  return { 'X-Eclipse-Token': tok };
}
const spotifyHeaders = getSpotifyHeaders();

async function checkSpotifyAuthStatus() {
  try {
    const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/spotify-status`, { headers: getSpotifyHeaders() });
    const data = await res.json();
    spotifyConnected = !!data.connected;
    if (spLoginStatus) {
      if (spotifyConnected) {
        spLoginStatus.textContent = data.error ? `Connected · ${data.error}` : 'Connected';
        spLoginStatus.style.color = 'var(--md-sys-color-primary, #6750A4)';
      } else if (data.error) {
        spLoginStatus.textContent = data.error;
        spLoginStatus.style.color = 'var(--md-sys-color-error, #ba1a1a)';
      } else {
        spLoginStatus.textContent = 'Not connected';
        spLoginStatus.style.color = 'var(--md-sys-color-outline)';
      }
    }
    if (currentSpotifyImportMode === 'login' && btnConfirmSpotifyImport && btnConfirmSpotifyImport.dataset.action !== 'done') {
      btnConfirmSpotifyImport.disabled = !spotifyConnected;
    }
  } catch (e) {}
}

function classifyImportError(provider, statusOrError, body) {
  let status = typeof statusOrError === 'number' ? statusOrError : 0;
  let rawMsg = '';
  if (statusOrError instanceof Error) {
    rawMsg = statusOrError.message || String(statusOrError);
  }
  if (typeof body === 'string') {
    rawMsg = rawMsg ? `${rawMsg} ${body}` : body;
  } else if (body && typeof body === 'object') {
    if (body.status && !status) status = Number(body.status);
    if (body.error) rawMsg = rawMsg ? `${rawMsg} ${body.error}` : String(body.error);
  }
  const msg = (rawMsg || '').toLowerCase();

  const lockIcon = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;
  const searchIcon = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`;
  const clockIcon = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;
  const networkIcon = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/><path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/><path d="M10.71 5.05A16 16 0 0 1 22.58 9"/><path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>`;
  const restrictedIcon = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>`;
  const unknownIcon = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;

  if (body && typeof body === 'object') {
    if (body.code === 'spotify_forbidden' || (provider === 'spotify' && status === 403)) {
      return { code: 'spotify_forbidden', title: 'Spotify refused the request from your network (403). Try again later, use a VPN, or use the Export files tab.', hint: '', icon: restrictedIcon };
    }
    if (body.code === 'spotify_rate_limited' || (provider === 'spotify' && status === 429)) {
      return { code: 'spotify_rate_limited', title: 'Spotify is rate limiting requests. Wait a minute and try again.', hint: '', icon: clockIcon };
    }
    if (body.code === 'spotify_not_found' || (provider === 'spotify' && status === 404)) {
      return { code: 'spotify_not_found', title: 'Playlist not found. Is it public?', hint: '', icon: searchIcon };
    }
  }

  if (!navigator.onLine || msg.includes('network') || msg.includes('fetch') || msg.includes('dns') || msg.includes('econnrefused') || msg.includes('timeout') || msg.includes('offline') || msg.includes('etimedout')) {
    return { code: 'network', title: "Can't reach the service", hint: 'Check your connection', icon: networkIcon };
  }
  if (status === 429 || msg.includes('429') || msg.includes('too many requests')) {
    let hint = 'Try again in a minute';
    const mRetry = msg.match(/retry-after:?\s*(\d+)/i) || msg.match(/try again in\s*(\d+)/i);
    if (mRetry) hint = `Try again in ${mRetry[1]}s`;
    return { code: 'rate_limit', title: 'Too many requests', hint, icon: clockIcon };
  }
  if (status === 404 || msg.includes('404') || msg.includes('not found') || msg.includes('deleted') || msg.includes('does not exist') || msg.includes('incomplete youtube id') || msg.includes('unsupported link') || msg.includes('invalid spotify playlist url') || msg.includes('invalid apple music playlist url')) {
    return { code: 'not_found', title: 'Playlist not found', hint: 'Check the link', icon: searchIcon };
  }
  if (msg.includes('private') || msg.includes('isprivate') || msg.includes('sign in') || msg.includes('signin') || status === 401 || (provider !== 'spotify' && (status === 403 || msg.includes('403')))) {
    return { code: 'private', title: 'Your playlist is private', hint: 'Make it public and try again', icon: lockIcon };
  }
  if (status === 403 || msg.includes('403') || msg.includes('forbidden') || msg.includes('restricted') || msg.includes('refused')) {
    return { code: 'restricted', title: "Spotify doesn't allow reading this playlist", hint: 'Try the Export files method', icon: restrictedIcon };
  }
  return { code: 'unknown', title: "Couldn't read this playlist", hint: (provider === 'spotify' || provider === 'apple') ? 'Try the Export files method' : 'Check the link', icon: unknownIcon };
}

function showImportError(containerEl, errInfo) {
  if (!containerEl) return;
  containerEl.innerHTML = `
    <div class="import-error-icon">${errInfo.icon}</div>
    <div class="import-error-content">
      <div class="import-error-title">${escapeHtml(errInfo.title)}</div>
      <div class="import-error-hint">${escapeHtml(errInfo.hint)}</div>
    </div>
  `;
  containerEl.classList.remove('hidden');
}

function clearImportError(containerEl) {
  if (!containerEl) return;
  containerEl.innerHTML = '';
  containerEl.classList.add('hidden');
}

function setSpotifyImportMode(mode) {
  currentSpotifyImportMode = mode || 'link';
  if (spModesContainer) {
    spModesContainer.querySelectorAll('button').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === currentSpotifyImportMode);
    });
  }
  clearImportError(spotifyLinkError);
  if (spotifyModal) {
    spotifyModal.querySelectorAll('.sp-pane').forEach(pane => {
      pane.classList.toggle('hidden', pane.dataset.mode !== currentSpotifyImportMode);
    });
  }
  if (spotifyStatus) {
    spotifyStatus.classList.add('hidden');
    spotifyStatus.textContent = '';
    spotifyStatus.style.color = '';
  }
  if (currentSpotifyImportMode === 'login') {
    checkSpotifyAuthStatus();
  } else {
    if (btnConfirmSpotifyImport && btnConfirmSpotifyImport.dataset.action !== 'done') {
      btnConfirmSpotifyImport.disabled = false;
    }
  }
}

if (spModesContainer) {
  spModesContainer.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      setSpotifyImportMode(btn.dataset.mode);
    });
  });
}

if (spClientIdInput) {
  const savedId = localStorage.getItem('eclipse_spotify_client_id') || '';
  spClientIdInput.value = savedId;
  if (btnSpLogin) {
    btnSpLogin.disabled = !/^[a-f0-9]{32}$/i.test(savedId.trim());
  }
  spClientIdInput.addEventListener('input', () => {
    const val = spClientIdInput.value.trim();
    localStorage.setItem('eclipse_spotify_client_id', val);
    if (btnSpLogin) {
      btnSpLogin.disabled = !/^[a-f0-9]{32}$/i.test(val);
    }
  });
}

if (btnSpLogin) {
  btnSpLogin.addEventListener('click', async () => {
    const clientId = spClientIdInput ? spClientIdInput.value.trim() : '';
    if (!/^[a-f0-9]{32}$/i.test(clientId)) {
      if (spLoginStatus) {
        spLoginStatus.textContent = 'Invalid Client ID';
        spLoginStatus.style.color = 'var(--md-sys-color-error, #ba1a1a)';
      }
      return;
    }

    if (spLoginStatus) {
      spLoginStatus.textContent = 'Starting login...';
      spLoginStatus.style.color = 'var(--md-sys-color-on-surface-variant)';
    }

    try {
      const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/spotify-auth-start?clientId=${encodeURIComponent(clientId)}`, { headers: getSpotifyHeaders() });
      const data = await res.json();
      if (!data.success) {
        if (spLoginStatus) {
          spLoginStatus.textContent = data.error || 'Failed to start auth';
          spLoginStatus.style.color = 'var(--md-sys-color-error, #ba1a1a)';
        }
        return;
      }

      if (spRedirectUri && data.redirectUri) {
        spRedirectUri.textContent = data.redirectUri;
      }

      if (window.electronAPI && typeof window.electronAPI.openExternal === 'function') {
        window.electronAPI.openExternal(data.url);
      } else {
        window.open(data.url, '_blank');
      }

      if (spLoginStatus) {
        spLoginStatus.textContent = 'Waiting for login in browser...';
        spLoginStatus.style.color = 'var(--md-sys-color-on-surface-variant)';
      }

      if (spLoginPollTimer) clearInterval(spLoginPollTimer);
      let elapsed = 0;
      spLoginPollTimer = setInterval(async () => {
        elapsed += 2000;
        if (elapsed > 180000) {
          clearInterval(spLoginPollTimer);
          spLoginPollTimer = null;
          if (spLoginStatus) {
            spLoginStatus.textContent = 'Login timed out';
            spLoginStatus.style.color = 'var(--md-sys-color-error, #ba1a1a)';
          }
          return;
        }
        try {
          const sRes = await fetch(`http://127.0.0.1:${state.serverPort}/api/spotify-status`, { headers: getSpotifyHeaders() });
          const sData = await sRes.json();
          if (sData.connected) {
            clearInterval(spLoginPollTimer);
            spLoginPollTimer = null;
            spotifyConnected = true;
            if (spLoginStatus) {
              spLoginStatus.textContent = sData.error ? `Connected · ${sData.error}` : 'Connected';
              spLoginStatus.style.color = 'var(--md-sys-color-primary, #6750A4)';
            }
            if (currentSpotifyImportMode === 'login' && btnConfirmSpotifyImport) {
              btnConfirmSpotifyImport.disabled = false;
            }
          } else if (sData.error) {
            clearInterval(spLoginPollTimer);
            spLoginPollTimer = null;
            if (spLoginStatus) {
              spLoginStatus.textContent = sData.error;
              spLoginStatus.style.color = 'var(--md-sys-color-error, #ba1a1a)';
            }
            return;
          }
        } catch (e) {}
      }, 2000);
    } catch (err) {
      if (spLoginStatus) {
        spLoginStatus.textContent = err.message || 'Error connecting to server';
        spLoginStatus.style.color = 'var(--md-sys-color-error, #ba1a1a)';
      }
    }
  });
}

if (btnSpPickFiles && spFileInput) {
  btnSpPickFiles.addEventListener('click', () => spFileInput.click());
  spFileInput.addEventListener('change', async () => {
    parsedSpotifyExport = { likes: [], playlists: [] };
    const files = Array.from(spFileInput.files || []);
    if (!files.length) {
      if (spFileInfo) spFileInfo.textContent = 'No files selected';
      return;
    }
    const names = [];
    for (const file of files) {
      names.push(file.name);
      try {
        const text = await file.text();
        const json = JSON.parse(text);
        const rawTracks = Array.isArray(json?.tracks) ? json.tracks : (Array.isArray(json) ? json : null);
        if (rawTracks) {
          for (const item of rawTracks) {
            const title = item.track || item.trackName;
            const artist = item.artist || item.artistName;
            const durMs = item.durationMs || item.duration_ms || item.msPlayed;
            const duration = durMs ? Math.round(durMs / 1000) : undefined;
            if (title && artist) {
              parsedSpotifyExport.likes.push({ title: String(title).trim(), artist: String(artist).trim(), duration });
            }
          }
        }
        const rawPlaylists = Array.isArray(json?.playlists) ? json.playlists : (Array.isArray(json) && json[0]?.items ? json : null);
        if (rawPlaylists) {
          for (const pl of rawPlaylists) {
            const plName = pl.name || 'Imported Playlist';
            const plTracks = [];
            const items = Array.isArray(pl.items) ? pl.items : [];
            for (const it of items) {
              if (!it || !it.track) continue;
              const title = it.track.trackName || it.track.track;
              const artist = it.track.artistName || it.track.artist;
              const durMs = it.track.durationMs || it.track.duration_ms;
              const duration = durMs ? Math.round(durMs / 1000) : undefined;
              if (title && artist) {
                plTracks.push({ title: String(title).trim(), artist: String(artist).trim(), duration });
              }
            }
            if (plTracks.length) {
              parsedSpotifyExport.playlists.push({ name: plName, tracks: plTracks });
            }
          }
        }
      } catch (e) {}
    }
    if (spFileInfo) spFileInfo.textContent = names.join(', ');
  });
}

if (spotifyTargetTrigger && spotifyTargetDropdown) {
  spotifyTargetTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    spotifyTargetDropdown.classList.toggle('open');
  });
  document.addEventListener('click', () => {
    spotifyTargetDropdown.classList.remove('open');
  });
}

function openSpotifyImportModal() {
  if (!spotifyModal) return;
  if (spLoginPollTimer) { clearInterval(spLoginPollTimer); spLoginPollTimer = null; }
  setSpotifyImportMode('link');
  parsedSpotifyExport = { likes: [], playlists: [] };
  if (spFileInput) spFileInput.value = '';
  if (spFileInfo) spFileInfo.textContent = 'No files selected';
  if (spChkLikes) { spChkLikes.checked = true; spChkLikes.disabled = false; }
  if (spChkPlaylists) { spChkPlaylists.checked = true; spChkPlaylists.disabled = false; }
  if (spChkLikes2) { spChkLikes2.checked = true; spChkLikes2.disabled = false; }
  if (spChkPlaylists2) { spChkPlaylists2.checked = true; spChkPlaylists2.disabled = false; }
  if (btnSpPickFiles) btnSpPickFiles.disabled = false;
  const savedId = localStorage.getItem('eclipse_spotify_client_id') || '';
  if (spClientIdInput) spClientIdInput.value = savedId;
  if (btnSpLogin) btnSpLogin.disabled = !/^[a-f0-9]{32}$/i.test(savedId.trim());
  if (spRedirectUri) spRedirectUri.textContent = `http://127.0.0.1:${state.serverPort || 38472}/api/spotify-callback`;
  if (spotifyImportUrl) {
    spotifyImportUrl.value = '';
    spotifyImportUrl.disabled = false;
  }
  clearImportError(spotifyLinkError);
  if (spotifyTargetTrigger) spotifyTargetTrigger.disabled = false;
  if (spotifyImportTarget) {
    spotifyImportTarget.disabled = false;
    spotifyImportTarget.innerHTML = '<option value="new">New playlist (Spotify name)</option><option value="__favorites__">Add directly to Favorites</option>';
    state.playlists.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `Merge into: ${p.name || 'untitled'}`;
      spotifyImportTarget.appendChild(opt);
    });
    spotifyImportTarget.value = 'new';
  }
  if (spotifyTargetMenu) {
    spotifyTargetMenu.innerHTML = '<button class="m3-dropdown-option selected" data-value="new" type="button">New playlist (Spotify name)</button><button class="m3-dropdown-option" data-value="__favorites__" type="button">Add directly to Favorites</button>';
    if (spotifyTargetLabel) spotifyTargetLabel.textContent = 'New playlist (Spotify name)';
    state.playlists.forEach(p => {
      const opt = document.createElement('button');
      opt.type = 'button';
      opt.className = 'm3-dropdown-option';
      opt.dataset.value = p.id;
      opt.textContent = `Merge into: ${p.name || 'untitled'}`;
      spotifyTargetMenu.appendChild(opt);
    });
    spotifyTargetMenu.querySelectorAll('.m3-dropdown-option').forEach(opt => {
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        const val = opt.dataset.value;
        if (spotifyImportTarget) spotifyImportTarget.value = val;
        if (spotifyTargetLabel) spotifyTargetLabel.textContent = opt.textContent;
        spotifyTargetMenu.querySelectorAll('.m3-dropdown-option').forEach(o => o.classList.remove('selected'));
        opt.classList.add('selected');
        if (spotifyTargetDropdown) spotifyTargetDropdown.classList.remove('open');
      });
    });
  }
  if (spotifyProgressWrap) spotifyProgressWrap.classList.add('hidden');
  if (spotifyWavyContainer) spotifyWavyContainer.innerHTML = '';
  if (spotifyStatus) {
    spotifyStatus.classList.add('hidden');
    spotifyStatus.textContent = '';
    spotifyStatus.style.color = '';
  }
  if (btnConfirmSpotifyImport) {
    btnConfirmSpotifyImport.disabled = false;
    if (spotifyBtnIcon) spotifyBtnIcon.classList.remove('hidden');
    if (spotifyBtnText) spotifyBtnText.textContent = 'Import from Spotify';
    btnConfirmSpotifyImport.dataset.action = 'import';
  }
  if (btnCancelSpotifyImport) btnCancelSpotifyImport.disabled = false;
  openModal(spotifyModal);
  if (spotifyImportUrl) spotifyImportUrl.focus();
}

function closeSpotifyImportModal() {
  if (spLoginPollTimer) { clearInterval(spLoginPollTimer); spLoginPollTimer = null; }
  if (spotifyModal) closeModal(spotifyModal);
}

async function runSpotifyImport({ likes = [], playlists = [], skippedPlaylists = [] }) {
  const likesToImport = likes || [];
  const playlistsToImport = playlists || [];
  const totalItemsCount = likesToImport.length + playlistsToImport.reduce((acc, p) => acc + (p.tracks ? p.tracks.length : 0), 0);

  if (totalItemsCount === 0) {
    if (spotifyStatus) {
      spotifyStatus.textContent = 'No tracks found to import';
      spotifyStatus.style.color = 'var(--md-sys-color-error, #ba1a1a)';
      spotifyStatus.classList.remove('hidden');
    }
    return;
  }

  closeSpotifyImportModal();
  showImportSpinnerToast('Importing Spotify library...');

  const hasBusy = typeof beginBusy === 'function';
  if (hasBusy) beginBusy('import');

  let globalCompleted = 0;
  let totalFoundCount = 0;
  try {
    if (likesToImport.length > 0) {
      const foundLikes = await matchSpotifyTracks(likesToImport, 'Liked Songs');
      globalCompleted += likesToImport.length;
      totalFoundCount += foundLikes.length;
      let addedFav = false;
      for (const track of foundLikes) {
        if (!state.favorites.some(f => isSameTrack(f, track))) {
          state.favorites.push(stampAddedAt(track));
          addedFav = true;
        }
      }
      if (addedFav) {
        localStorage.setItem('devsize_favorites', JSON.stringify(state.favorites.map(sanitizeTrackForStorage)));
        updateFavoritesBadge();
        updateFavoriteIcon();
        if (state.currentView === 'favorites') renderFavoritesView();
        hydrateMissingPlaylistCovers(state.favorites);
      }
    }

    if (playlistsToImport.length > 0) {
      for (const pl of playlistsToImport) {
        const found = await matchSpotifyTracks(pl.tracks || [], pl.name || 'Playlist');
        globalCompleted += (pl.tracks || []).length;
        totalFoundCount += found.length;
        createPlaylist(pl.name, found, pl.cover || '');
      }
    }
  } catch (err) {
    dismissImportSpinnerToast();
    showToast(err.message || 'Failed to import tracks', 'error');
  } finally {
    if (btnConfirmSpotifyImport) btnConfirmSpotifyImport.disabled = false;
    if (btnCancelSpotifyImport) btnCancelSpotifyImport.disabled = false;
    if (btnSpPickFiles) btnSpPickFiles.disabled = false;
    if (btnSpLogin && spClientIdInput) btnSpLogin.disabled = !/^[a-f0-9]{32}$/i.test(spClientIdInput.value.trim());
    if (spChkLikes) spChkLikes.disabled = false;
    if (spChkPlaylists) spChkPlaylists.disabled = false;
    if (spChkLikes2) spChkLikes2.disabled = false;
    if (spChkPlaylists2) spChkPlaylists2.disabled = false;
    if (hasBusy && typeof endBusy === 'function') endBusy('import');
  }
}

async function handleSpotifyFileImport() {
  const doLikes = !!(spChkLikes && spChkLikes.checked);
  const doPlaylists = !!(spChkPlaylists && spChkPlaylists.checked);

  if (!doLikes && !doPlaylists) {
    if (spotifyStatus) {
      spotifyStatus.textContent = 'Select at least Liked songs or Playlists';
      spotifyStatus.style.color = 'var(--md-sys-color-error, #ba1a1a)';
      spotifyStatus.classList.remove('hidden');
    }
    return;
  }

  const likesToImport = doLikes ? (parsedSpotifyExport.likes || []) : [];
  const playlistsToImport = doPlaylists ? (parsedSpotifyExport.playlists || []) : [];
  if (!likesToImport.length && !playlistsToImport.length) {
    if (spotifyStatus) {
      spotifyStatus.textContent = 'No tracks found in the selected files';
      spotifyStatus.style.color = 'var(--md-sys-color-error, #ba1a1a)';
      spotifyStatus.classList.remove('hidden');
    }
    return;
  }
  await runSpotifyImport({ likes: likesToImport, playlists: playlistsToImport });
}

async function handleSpotifyLoginImport() {
  const doLikes = !!(spChkLikes2 && spChkLikes2.checked);
  const doPlaylists = !!(spChkPlaylists2 && spChkPlaylists2.checked);

  if (!doLikes && !doPlaylists) {
    if (spotifyStatus) {
      spotifyStatus.textContent = 'Select at least Liked songs or Playlists';
      spotifyStatus.style.color = 'var(--md-sys-color-error, #ba1a1a)';
      spotifyStatus.classList.remove('hidden');
    }
    return;
  }

  closeSpotifyImportModal();
  showImportSpinnerToast('Fetching Spotify library...');

  try {
    const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/spotify-library?likes=${doLikes ? 1 : 0}&playlists=${doPlaylists ? 1 : 0}`, { headers: getSpotifyHeaders() });
    const data = await res.json();
    if (!data.success) {
      dismissImportSpinnerToast();
      showToast(data.error || 'Failed to fetch Spotify library', 'error');
      return;
    }

    if (Array.isArray(data.skippedPlaylists) && data.skippedPlaylists.length > 0) {
      const names = data.skippedPlaylists.map(p => `${p.name}: ${p.error}`).join('\n');
      const proceed = window.confirm(`Some playlists could not be loaded:\n\n${names}\n\nDo you want to continue importing the rest of your library?`);
      if (!proceed) {
        dismissImportSpinnerToast();
        if (btnConfirmSpotifyImport) btnConfirmSpotifyImport.disabled = false;
        return;
      }
    }

    if (!(data.likes?.length || data.playlists?.some(pl => pl.tracks?.length))) {
      dismissImportSpinnerToast();
      showToast('No tracks found in your Spotify library', 'warning');
      return;
    }
    await runSpotifyImport({ likes: data.likes || [], playlists: data.playlists || [], skippedPlaylists: data.skippedPlaylists || [] });
  } catch (err) {
    dismissImportSpinnerToast();
    showToast(err.message || 'Failed to fetch Spotify library', 'error');
  }
}

async function handleSpotifyImportAction() {
  if (currentSpotifyImportMode === 'file') {
    return handleSpotifyFileImport();
  }

  if (currentSpotifyImportMode === 'login') {
    return handleSpotifyLoginImport();
  }

  const url = spotifyImportUrl ? spotifyImportUrl.value.trim() : '';
  if (!url) {
    const errInfo = classifyImportError('spotify', 404, 'invalid spotify playlist url');
    showImportError(spotifyLinkError, errInfo);
    return;
  }

  clearImportError(spotifyLinkError);
  const targetVal = spotifyImportTarget ? spotifyImportTarget.value : 'new';
  closeSpotifyImportModal();
  showImportSpinnerToast('Importing playlist...');

  try {
    const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/spotify-import?url=${encodeURIComponent(url)}`, { headers: getSpotifyHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success || !Array.isArray(data.tracks) || data.tracks.length === 0) {
      dismissImportSpinnerToast();
      const errInfo = classifyImportError('spotify', res.status, data);
      showToast(errInfo.userMessage || 'Failed to import Spotify playlist', 'error');
      return;
    }

    const tracks = data.tracks;
    const foundTracks = await matchSpotifyTracks(tracks, data.name || 'Spotify Playlist', null, { playlistCover: '' });

    if (targetVal === '__favorites__') {
      const existingMap = new Set(state.favorites.map(f => getTrackCanonicalId(f) || f.id));
      const newFavs = foundTracks.filter(t => !existingMap.has(getTrackCanonicalId(t) || t.id));
      state.favorites.push(...newFavs.map(stampAddedAt));
      localStorage.setItem('devsize_favorites', JSON.stringify(state.favorites.map(sanitizeTrackForStorage)));
      if (typeof updateFavoritesBadge === 'function') updateFavoritesBadge();
      if (typeof updateFavoriteIcon === 'function') updateFavoriteIcon();
      if (state.currentView === 'favorites' && typeof renderFavoritesView === 'function') renderFavoritesView();
      hydrateMissingPlaylistCovers(state.favorites);
    } else if (targetVal !== 'new' && targetVal !== '__new__') {
      const pl = state.playlists.find(p => p.id === targetVal);
      if (pl) {
        if (!pl.cover && data.cover) pl.cover = data.cover;
        const existingIds = new Set(pl.tracks.map(t => t.id));
        const newTracks = foundTracks.filter(t => !existingIds.has(t.id));
        pl.tracks.push(...newTracks.map(stampAddedAt));
        localStorage.setItem('devsize_playlists', JSON.stringify(state.playlists));
        renderPlaylistsList();
        if (state.currentView === 'playlist-detail' && state.currentPlaylistId === targetVal) {
          openPlaylistDetail(targetVal);
        }
        hydrateMissingPlaylistCovers(pl);
      } else {
        createPlaylist(data.name || 'Spotify Playlist', foundTracks, data.cover || '');
      }
    } else {
      createPlaylist(data.name || 'Spotify Playlist', foundTracks, data.cover || '');
    }
  } catch (err) {
    dismissImportSpinnerToast();
    const errInfo = classifyImportError('spotify', err, err.message);
    showToast(errInfo.userMessage || 'Failed to import Spotify playlist', 'error');
  }
}

if (btnOpenSpotifyImport) btnOpenSpotifyImport.addEventListener('click', openSpotifyImportModal);
const btnCpmSpotify = document.getElementById('btn-cpm-spotify');
if (btnCpmSpotify) btnCpmSpotify.addEventListener('click', () => {
  document.getElementById('create-playlist-modal')?.classList.add('hidden');
  openSpotifyImportModal();
});
const btnCpmApple = document.getElementById('btn-cpm-apple');
if (btnCpmApple) btnCpmApple.addEventListener('click', () => {
  document.getElementById('create-playlist-modal')?.classList.add('hidden');
  openAppleImportModal();
});
if (btnCancelSpotifyImport) btnCancelSpotifyImport.addEventListener('click', closeSpotifyImportModal);
if (btnConfirmSpotifyImport) btnConfirmSpotifyImport.addEventListener('click', handleSpotifyImportAction);
if (spotifyImportUrl) {
  spotifyImportUrl.addEventListener('input', () => clearImportError(spotifyLinkError));
  spotifyImportUrl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSpotifyImportAction();
    }
  });
}

const appleModal = document.getElementById('apple-import-modal');
const btnOpenAppleImport = document.getElementById('btn-open-apple-import');
const btnCancelAppleImport = document.getElementById('btn-cancel-apple-import');
const btnConfirmAppleImport = document.getElementById('btn-confirm-apple-import');
const appleImportUrl = document.getElementById('apple-import-url');
const appleLinkError = document.getElementById('apple-link-error');
const appleImportTarget = document.getElementById('apple-import-target');
const appleTargetDropdown = document.getElementById('apple-target-dropdown');
const appleTargetTrigger = document.getElementById('apple-target-trigger');
const appleTargetLabel = document.getElementById('apple-target-label');
const appleTargetMenu = document.getElementById('apple-target-menu');
const appleModesContainer = document.getElementById('apple-modes');
const btnApplePickFiles = document.getElementById('btn-apple-pick-files');
const appleFileInput = document.getElementById('apple-file-input');
const appleFileInfo = document.getElementById('apple-file-info');
const appleChkContainer = document.getElementById('apple-chk-container');
const appleChkLikes = document.getElementById('apple-chk-likes');
const appleChkPlaylists = document.getElementById('apple-chk-playlists');
const appleFileSummary = document.getElementById('apple-file-summary');
const appleProgressWrap = document.getElementById('apple-import-progress-wrap');
const appleWavyContainer = document.getElementById('apple-import-wavy-container');
const appleProgressLabel = document.getElementById('apple-import-progress-label');
const appleStatus = document.getElementById('apple-import-status');
const appleBtnIcon = document.getElementById('apple-import-btn-icon');
const appleBtnText = document.getElementById('apple-import-btn-text');

let currentAppleImportMode = 'link';
let parsedAppleExport = { likes: [], playlists: [] };

function parseAppleDuration(val) {
  if (val == null) return undefined;
  const s = String(val).trim();
  if (!s) return undefined;
  if (s.includes(':')) {
    const parts = s.split(':').map(Number);
    if (parts.some(isNaN)) return undefined;
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  const n = Number(s);
  if (!isNaN(n)) return n > 1000 ? Math.round(n / 1000) : Math.round(n);
  return undefined;
}

function parseAppleCSV(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return { headers: [], rows: [] };
  const delim = lines[0].includes('\t') ? '\t' : (lines[0].includes(';') && !lines[0].includes(',') ? ';' : ',');
  function splitRow(row) {
    const res = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < row.length; i++) {
      const c = row[i];
      if (c === '"') {
        if (inQuotes && row[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = !inQuotes;
      } else if (c === delim && !inQuotes) {
        res.push(cur.trim());
        cur = '';
      } else cur += c;
    }
    res.push(cur.trim());
    return res;
  }
  const headers = splitRow(lines[0]).map(h => h.toLowerCase().replace(/['"]/g, ''));
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitRow(lines[i]);
    const row = {};
    for (let j = 0; j < headers.length; j++) row[headers[j]] = cols[j] || '';
    rows.push(row);
  }
  return { headers, rows };
}

function parseAppleExportCSV(text) {
  const { headers, rows } = parseAppleCSV(text);
  const titleCol = headers.find(h => /^(title|name|track\s*name|song(\s*name)?|track\s*description)$/i.test(h)) || headers.find(h => /(title|song|track)/i.test(h));
  const artistCol = headers.find(h => /^(artist(\s*name)?|artist\(s\)|creator|uploader)$/i.test(h)) || headers.find(h => /artist/i.test(h));
  const durCol = headers.find(h => /(duration|time|length)/i.test(h));
  const plCol = headers.find(h => /(playlist(\s*name)?|container(\s*description|\s*name)?)/i.test(h));

  const likes = [];
  const playlistsMap = new Map();

  for (const r of rows) {
    const title = titleCol ? r[titleCol] : '';
    const artist = artistCol ? r[artistCol] : '';
    if (!title || !artist) continue;
    const dur = durCol ? parseAppleDuration(r[durCol]) : undefined;
    const pl = plCol ? r[plCol].trim() : '';
    const track = { title: title.trim(), artist: artist.trim(), duration: dur };
    if (pl) {
      if (!playlistsMap.has(pl)) playlistsMap.set(pl, []);
      playlistsMap.get(pl).push(track);
    } else {
      likes.push(track);
    }
  }
  const playlists = [];
  for (const [name, tracks] of playlistsMap.entries()) playlists.push({ name, tracks });
  return { likes, playlists };
}

function parseAppleExportJSON(json) {
  const likes = [];
  const playlistsMap = new Map();

  function walk(node, currentPl = '') {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, currentPl);
      return;
    }

    let pl = currentPl;
    if (node.playlistName || node.playlist || node['playlist name']) {
      pl = node.playlistName || node.playlist || node['playlist name'];
    }

    if (Array.isArray(node.tracks) && (node.name || node.title)) {
      const pName = node.name || node.title;
      for (const t of node.tracks) walk(t, pName);
      return;
    }
    if (Array.isArray(node.items) && (node.name || node.title)) {
      const pName = node.name || node.title;
      for (const t of node.items) walk(t, pName);
      return;
    }

    const title = String(node.title || node.name || node.trackName || node.song || node['track name'] || node['song name'] || '').trim();
    const artist = String(node.artistName || node.artist || node.artist_name || node['artist name'] || '').trim();
    const durRaw = node.durationInMillis || node.duration || node.duration_ms || node.time || node.trackDuration;
    const duration = parseAppleDuration(durRaw);

    if (title && artist && (node.type === 'song' || node.type === 'songs' || duration || pl || node.contentDescriptor)) {
      const track = { title, artist, duration };
      if (pl) {
        if (!playlistsMap.has(pl)) playlistsMap.set(pl, []);
        playlistsMap.get(pl).push(track);
      } else {
        likes.push(track);
      }
      return;
    }

    for (const k of Object.keys(node)) {
      walk(node[k], pl);
    }
  }

  walk(json);
  const playlists = [];
  for (const [name, tracks] of playlistsMap.entries()) playlists.push({ name, tracks });
  return { likes, playlists };
}

function setAppleImportMode(mode) {
  currentAppleImportMode = mode || 'link';
  if (appleModesContainer) {
    appleModesContainer.querySelectorAll('button').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === currentAppleImportMode);
    });
  }
  clearImportError(appleLinkError);
  if (appleModal) {
    appleModal.querySelectorAll('.sp-pane').forEach(pane => {
      pane.classList.toggle('hidden', pane.dataset.mode !== currentAppleImportMode);
    });
  }
  if (appleStatus) {
    appleStatus.classList.add('hidden');
    appleStatus.textContent = '';
    appleStatus.style.color = '';
  }
  if (btnConfirmAppleImport && btnConfirmAppleImport.dataset.action !== 'done') {
    btnConfirmAppleImport.disabled = false;
  }
}

if (appleModesContainer) {
  appleModesContainer.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      setAppleImportMode(btn.dataset.mode);
    });
  });
}

if (btnApplePickFiles && appleFileInput) {
  btnApplePickFiles.addEventListener('click', () => {
    appleFileInput.click();
  });

  appleFileInput.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    parsedAppleExport = { likes: [], playlists: [] };
    const names = [];
    for (const file of files) {
      names.push(file.name);
      try {
        const text = await file.text();
        if (file.name.toLowerCase().endsWith('.json')) {
          const json = JSON.parse(text);
          const res = parseAppleExportJSON(json);
          parsedAppleExport.likes.push(...res.likes);
          parsedAppleExport.playlists.push(...res.playlists);
        } else {
          const res = parseAppleExportCSV(text);
          parsedAppleExport.likes.push(...res.likes);
          parsedAppleExport.playlists.push(...res.playlists);
        }
      } catch (err) {}
    }
    if (appleFileInfo) appleFileInfo.textContent = names.join(', ');

    const hasLikes = parsedAppleExport.likes.length > 0;
    const hasPlaylists = parsedAppleExport.playlists.length > 0;

    if (hasLikes && hasPlaylists) {
      if (appleChkContainer) appleChkContainer.classList.remove('hidden');
      if (appleChkLikes) { appleChkLikes.checked = true; appleChkLikes.disabled = false; }
      if (appleChkPlaylists) { appleChkPlaylists.checked = true; appleChkPlaylists.disabled = false; }
      if (appleFileSummary) {
        appleFileSummary.classList.remove('hidden');
        appleFileSummary.textContent = `Found ${parsedAppleExport.likes.length} liked songs and ${parsedAppleExport.playlists.length} playlists`;
      }
    } else {
      if (appleChkContainer) appleChkContainer.classList.add('hidden');
      if (appleFileSummary) {
        appleFileSummary.classList.remove('hidden');
        if (hasPlaylists) {
          const totalTracks = parsedAppleExport.playlists.reduce((acc, p) => acc + (p.tracks ? p.tracks.length : 0), 0);
          appleFileSummary.textContent = `Found ${parsedAppleExport.playlists.length} playlists (${totalTracks} tracks)`;
        } else if (hasLikes) {
          appleFileSummary.textContent = `Found ${parsedAppleExport.likes.length} liked tracks`;
        } else {
          appleFileSummary.textContent = 'No tracks found in selected files';
        }
      }
    }
  });
}

if (appleTargetTrigger && appleTargetDropdown) {
  appleTargetTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    appleTargetDropdown.classList.toggle('open');
  });
  document.addEventListener('click', () => {
    appleTargetDropdown.classList.remove('open');
  });
}

function openAppleImportModal() {
  if (!appleModal) return;
  setAppleImportMode('link');
  parsedAppleExport = { likes: [], playlists: [] };
  if (appleFileInput) appleFileInput.value = '';
  if (appleFileInfo) appleFileInfo.textContent = 'No files selected';
  if (appleChkContainer) appleChkContainer.classList.add('hidden');
  if (appleChkLikes) { appleChkLikes.checked = true; appleChkLikes.disabled = false; }
  if (appleChkPlaylists) { appleChkPlaylists.checked = true; appleChkPlaylists.disabled = false; }
  if (appleFileSummary) { appleFileSummary.classList.add('hidden'); appleFileSummary.textContent = ''; }
  if (btnApplePickFiles) btnApplePickFiles.disabled = false;
  if (appleImportUrl) {
    appleImportUrl.value = '';
    appleImportUrl.disabled = false;
  }
  clearImportError(appleLinkError);
  if (appleTargetTrigger) appleTargetTrigger.disabled = false;
  if (appleImportTarget) {
    appleImportTarget.disabled = false;
    appleImportTarget.innerHTML = '<option value="new">New playlist (Apple Music name)</option>';
    state.playlists.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      appleImportTarget.appendChild(opt);
    });
    appleImportTarget.value = 'new';
  }
  if (appleTargetMenu) {
    appleTargetMenu.innerHTML = '<button class="m3-dropdown-option selected" data-value="new" type="button">New playlist (Apple Music name)</button>';
    if (appleTargetLabel) appleTargetLabel.textContent = 'New playlist (Apple Music name)';
    state.playlists.forEach(p => {
      const opt = document.createElement('button');
      opt.type = 'button';
      opt.className = 'm3-dropdown-option';
      opt.dataset.value = p.id;
      opt.textContent = p.name || 'untitled';
      appleTargetMenu.appendChild(opt);
    });
    appleTargetMenu.querySelectorAll('.m3-dropdown-option').forEach(opt => {
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        const val = opt.dataset.value;
        if (appleImportTarget) appleImportTarget.value = val;
        if (appleTargetLabel) appleTargetLabel.textContent = opt.textContent;
        appleTargetMenu.querySelectorAll('.m3-dropdown-option').forEach(o => o.classList.remove('selected'));
        opt.classList.add('selected');
        if (appleTargetDropdown) appleTargetDropdown.classList.remove('open');
      });
    });
  }
  if (appleProgressWrap) appleProgressWrap.classList.add('hidden');
  if (appleWavyContainer) appleWavyContainer.innerHTML = '';
  if (appleStatus) {
    appleStatus.classList.add('hidden');
    appleStatus.textContent = '';
    appleStatus.style.color = '';
  }
  if (btnConfirmAppleImport) {
    btnConfirmAppleImport.disabled = false;
    if (appleBtnIcon) appleBtnIcon.classList.remove('hidden');
    if (appleBtnText) appleBtnText.textContent = 'Import from Apple Music';
    btnConfirmAppleImport.dataset.action = 'import';
  }
  if (btnCancelAppleImport) btnCancelAppleImport.disabled = false;
  openModal(appleModal);
  if (appleImportUrl) appleImportUrl.focus();
}

function closeAppleImportModal() {
  if (appleModal) closeModal(appleModal);
}

async function handleAppleImportAction() {
  if (currentAppleImportMode === 'file') {
    const hasLikes = parsedAppleExport.likes.length > 0;
    const hasPlaylists = parsedAppleExport.playlists.length > 0;
    let likesToImport = [];
    let playlistsToImport = [];

    if (hasLikes && hasPlaylists) {
      if (appleChkLikes && appleChkLikes.checked) likesToImport = parsedAppleExport.likes;
      if (appleChkPlaylists && appleChkPlaylists.checked) playlistsToImport = parsedAppleExport.playlists;
    } else if (hasPlaylists) {
      playlistsToImport = parsedAppleExport.playlists;
    } else if (hasLikes) {
      likesToImport = parsedAppleExport.likes;
    }

    const totalItemsCount = likesToImport.length + playlistsToImport.reduce((acc, p) => acc + (p.tracks ? p.tracks.length : 0), 0);
    if (totalItemsCount === 0) {
      if (appleStatus) {
        appleStatus.textContent = 'No tracks selected or found to import';
        appleStatus.style.color = 'var(--md-sys-color-error, #ba1a1a)';
        appleStatus.classList.remove('hidden');
      }
      return;
    }

    closeAppleImportModal();
    showImportSpinnerToast('Importing Apple Music files...');

    const hasBusy = typeof beginBusy === 'function';
    if (hasBusy) beginBusy('import');

    try {
      if (likesToImport.length > 0) {
        const foundLikes = await matchSpotifyTracks(likesToImport, 'Liked Songs');
        let addedFav = false;
        for (const track of foundLikes) {
          if (!state.favorites.some(f => isSameTrack(f, track))) {
            state.favorites.push(stampAddedAt(track));
            addedFav = true;
          }
        }
        if (addedFav) {
          localStorage.setItem('devsize_favorites', JSON.stringify(state.favorites.map(sanitizeTrackForStorage)));
          updateFavoritesBadge();
          updateFavoriteIcon();
          if (state.currentView === 'favorites') renderFavoritesView();
          hydrateMissingPlaylistCovers(state.favorites);
        }
      }

      if (playlistsToImport.length > 0) {
        for (const pl of playlistsToImport) {
          const found = await matchSpotifyTracks(pl.tracks || [], pl.name || 'Playlist');
          createPlaylist(pl.name, found, pl.cover || '');
        }
      }
    } catch (err) {
      dismissImportSpinnerToast();
      showToast(err.message || 'Failed to import tracks', 'error');
    } finally {
      if (btnConfirmAppleImport) btnConfirmAppleImport.disabled = false;
      if (btnCancelAppleImport) btnCancelAppleImport.disabled = false;
      if (btnApplePickFiles) btnApplePickFiles.disabled = false;
      if (appleChkLikes) appleChkLikes.disabled = false;
      if (appleChkPlaylists) appleChkPlaylists.disabled = false;
      if (hasBusy && typeof endBusy === 'function') endBusy('import');
    }
    return;
  }

  const url = appleImportUrl ? appleImportUrl.value.trim() : '';
  if (!url) {
    const errInfo = classifyImportError('apple', 404, 'invalid apple music playlist url');
    showImportError(appleLinkError, errInfo);
    return;
  }

  clearImportError(appleLinkError);
  const targetVal = appleImportTarget ? appleImportTarget.value : 'new';
  closeAppleImportModal();
  showImportSpinnerToast('Importing playlist...');

  try {
    const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/apple-import?url=${encodeURIComponent(url)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success || !Array.isArray(data.tracks) || data.tracks.length === 0) {
      dismissImportSpinnerToast();
      const errInfo = classifyImportError('apple', res.status, data);
      showToast(errInfo.userMessage || 'Failed to import Apple Music playlist', 'error');
      return;
    }

    const tracks = data.tracks;
    const foundTracks = await matchSpotifyTracks(tracks, data.name || 'Apple Music Playlist', null, { playlistCover: '' });

    if (targetVal === 'new') {
      createPlaylist(data.name || 'Apple Music Playlist', foundTracks, data.cover || '');
    } else {
      const pl = state.playlists.find(p => p.id === targetVal);
      if (pl) {
        if (!pl.cover && data.cover) pl.cover = data.cover;
        const existingIds = new Set(pl.tracks.map(t => t.id));
        const newTracks = foundTracks.filter(t => !existingIds.has(t.id));
        pl.tracks.push(...newTracks.map(stampAddedAt));
        localStorage.setItem('devsize_playlists', JSON.stringify(state.playlists));
        renderPlaylistsList();
        hydrateMissingPlaylistCovers(pl);
      }
    }
  } catch (err) {
    dismissImportSpinnerToast();
    const errInfo = classifyImportError('apple', err, err.message);
    showToast(errInfo.userMessage || 'Failed to import Apple Music playlist', 'error');
  }
}

if (btnOpenAppleImport) btnOpenAppleImport.addEventListener('click', openAppleImportModal);
if (btnCancelAppleImport) btnCancelAppleImport.addEventListener('click', closeAppleImportModal);
if (btnConfirmAppleImport) btnConfirmAppleImport.addEventListener('click', handleAppleImportAction);
if (appleImportUrl) {
  appleImportUrl.addEventListener('input', () => clearImportError(appleLinkError));
  appleImportUrl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAppleImportAction();
    }
  });
}

const linkImportModal = document.getElementById('link-import-modal');
const btnOpenLinkImport = document.getElementById('btn-open-link-import');
const btnCancelLinkImport = document.getElementById('btn-cancel-link-import');
const btnConfirmLinkImport = document.getElementById('btn-confirm-link-import');
const linkImportUrl = document.getElementById('link-import-url');
const linkImportStatus = document.getElementById('link-import-status');
const linkImportError = document.getElementById('link-import-error');

let googleConnected = false;
let currentLinkImportMode = 'link';
let currentLinkImportPlatform = 'youtube';

const linkModesContainer = document.getElementById('link-modes');
const btnGoogleLogin = document.getElementById('btn-google-login');
const btnSettingsConnectYtm = document.getElementById('btn-settings-connect-ytm');
const settingsYtmAccountStatus = document.getElementById('settings-ytm-account-status');
const btnGoogleLogout = document.getElementById('btn-google-logout');
const googleLoginStatus = document.getElementById('google-login-status');
const googleChkLikes = document.getElementById('google-chk-likes');
const googleChkPlaylists = document.getElementById('google-chk-playlists');
const linkImportProgressWrap = document.getElementById('link-import-progress-wrap');
const linkImportProgressLabel = document.getElementById('link-import-progress-label');
const linkImportWavyContainer = document.getElementById('link-import-wavy-container');
const linkImportBtnText = document.getElementById('link-import-btn-text');

async function checkGoogleAuthStatus() {
  try {
    if (window.electronAPI && window.electronAPI.googleAuthStatus) {
      const res = await window.electronAPI.googleAuthStatus();
      googleConnected = !!(res && res.loggedIn);
    } else {
      googleConnected = false;
    }
  } catch (e) {
    googleConnected = false;
  }
  updateGoogleAuthUI();
  if (googleConnected && typeof getSavedAlbums === 'function' && getSavedAlbums().length === 0 && !window.__eclipseAutoSyncedAlbums && !window.__eclipseAutoSyncing) {
    window.__eclipseAutoSyncing = true;
    setTimeout(async () => {
      try {
        if (typeof autoSyncYtmLibraryOnLogin === 'function') {
          await autoSyncYtmLibraryOnLogin(null, { trigger: 'background' });
          window.__eclipseAutoSyncedAlbums = true;
        }
      } catch (err) {
        console.warn('[auto-sync] error:', err);
      } finally {
        window.__eclipseAutoSyncing = false;
      }
    }, 1500);
  }
}

function updateGoogleAuthUI() {
  if (googleLoginStatus) {
    if (googleConnected) {
      const lbl = typeof t === 'function' ? t('Connected') : 'Connected';
      googleLoginStatus.textContent = (lbl === 'Connected' || !lbl) ? 'Đã kết nối' : lbl;
      googleLoginStatus.style.color = '#4caf50';
    } else {
      const lbl = typeof t === 'function' ? t('Not connected') : 'Not connected';
      googleLoginStatus.textContent = (lbl === 'Not connected' || !lbl) ? 'Chưa kết nối' : lbl;
      googleLoginStatus.style.color = 'var(--md-sys-color-outline)';
    }
  }
  if (settingsYtmAccountStatus) {
    if (googleConnected) {
      settingsYtmAccountStatus.textContent = typeof t === 'function' ? t('Connected') : 'Connected';
      settingsYtmAccountStatus.style.color = '#4caf50';
    } else {
      settingsYtmAccountStatus.textContent = typeof t === 'function' ? t('Not connected') : 'Not connected';
      settingsYtmAccountStatus.style.color = 'var(--md-sys-color-outline)';
    }
  }
  if (btnSettingsConnectYtm) {
    btnSettingsConnectYtm.textContent = googleConnected ? (typeof t === 'function' ? t('Manage') : 'Manage') : (typeof t === 'function' ? t('Connect') : 'Connect');
    btnSettingsConnectYtm.disabled = false;
  }
  const inappYtmStatus = document.getElementById('inapp-ytm-status');
  const btnInappYtmSignin = document.getElementById('btn-inapp-ytm-signin');
  const btnInappYtmLogout = document.getElementById('btn-inapp-ytm-logout');
  if (inappYtmStatus) {
    inappYtmStatus.textContent = googleConnected ? (typeof t === 'function' ? t('Connected') : 'Connected') : (typeof t === 'function' ? t('Not connected') : 'Not connected');
    inappYtmStatus.style.color = googleConnected ? '#4caf50' : 'var(--md-sys-color-outline)';
  }
  if (btnInappYtmSignin) {
    btnInappYtmSignin.textContent = googleConnected ? 'Switch Account' : 'Sign in with Google';
  }
  if (btnInappYtmLogout) {
    btnInappYtmLogout.classList.toggle('hidden', !googleConnected);
  }
  if (btnGoogleLogin) {
    btnGoogleLogin.classList.toggle('hidden', !!googleConnected);
  }
  if (btnGoogleLogout) {
    btnGoogleLogout.classList.toggle('hidden', !googleConnected);
  }
  if (currentLinkImportMode === 'login' && btnConfirmLinkImport && btnConfirmLinkImport.dataset.action !== 'done') {
    btnConfirmLinkImport.disabled = !googleConnected;
  }
}

function setLinkImportMode(mode) {
  currentLinkImportMode = mode || 'link';
  if (linkModesContainer) {
    linkModesContainer.querySelectorAll('button').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === currentLinkImportMode);
    });
  }
  clearImportError(linkImportError);
  if (linkImportModal) {
    linkImportModal.querySelectorAll('.link-pane').forEach(pane => {
      pane.classList.toggle('hidden', pane.dataset.mode !== currentLinkImportMode);
    });
  }
  if (linkImportStatus) {
    linkImportStatus.classList.add('hidden');
    linkImportStatus.textContent = '';
    linkImportStatus.style.color = '';
  }
  if (btnConfirmLinkImport && btnConfirmLinkImport.dataset.action !== 'done') {
    btnConfirmLinkImport.disabled = currentLinkImportMode === 'login' ? !googleConnected : false;
    if (linkImportBtnText) linkImportBtnText.textContent = 'Import';
  }
  if (currentLinkImportMode === 'login') {
    checkGoogleAuthStatus();
  }
}

function populateTargetDropdown(selectId, triggerId, dropdownId, menuId, labelId, defaultText) {
  const sel = document.getElementById(selectId);
  const trig = document.getElementById(triggerId);
  const drop = document.getElementById(dropdownId);
  const menu = document.getElementById(menuId);
  const lbl = document.getElementById(labelId);
  if (!sel || !menu) return;

  sel.innerHTML = `<option value="new">${defaultText}</option>`;
  menu.innerHTML = `<button class="m3-dropdown-option selected" data-value="new" type="button">${defaultText}</button>`;
  if (lbl) lbl.textContent = defaultText;

  (state.playlists || []).forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name || 'untitled';
    sel.appendChild(opt);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'm3-dropdown-option';
    btn.dataset.value = p.id;
    btn.textContent = p.name || 'untitled';
    menu.appendChild(btn);
  });

  if (trig && drop && !trig._dropdownBound) {
    trig._dropdownBound = true;
    trig.addEventListener('click', (e) => {
      e.stopPropagation();
      drop.classList.toggle('open');
    });
    document.addEventListener('click', () => {
      drop.classList.remove('open');
    });
  }

  menu.querySelectorAll('.m3-dropdown-option').forEach(opt => {
    opt.addEventListener('click', (e) => {
      e.stopPropagation();
      const val = opt.dataset.value;
      sel.value = val;
      if (lbl) lbl.textContent = opt.textContent;
      menu.querySelectorAll('.m3-dropdown-option').forEach(o => o.classList.remove('selected'));
      opt.classList.add('selected');
      if (drop) drop.classList.remove('open');
    });
  });
}

if (linkModesContainer) {
  linkModesContainer.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      setLinkImportMode(btn.dataset.mode);
    });
  });
}

// Browser Login & Extension Pairing Dialog (Native Architecture)
const browserLoginDialog = document.getElementById('browser-login-dialog');
const btnCloseBrowserLogin = document.getElementById('btn-close-browser-login');
const btnRefreshBrowserProfiles = document.getElementById('btn-refresh-browser-profiles');
const browserProfilesList = document.getElementById('browser-profiles-list');

// Stage 1 Elements
const btnExportExtension = document.getElementById('btn-export-extension');
const btnOpenExtensionFolder = document.getElementById('btn-open-extension-folder');
const btnReexportExtension = document.getElementById('btn-reexport-extension');
const extensionSavedPathBox = document.getElementById('extension-saved-path-box');
const extensionSavedPath = document.getElementById('extension-saved-path');

// Stage 2 Elements
const btnOpenChromeExt = document.getElementById('btn-open-chrome-ext');
const btnOpenEdgeExt = document.getElementById('btn-open-edge-ext');
const btnOpenBraveExt = document.getElementById('btn-open-brave-ext');
const chkExtExtracted = document.getElementById('chk-ext-extracted');
const chkExtLoaded = document.getElementById('chk-ext-loaded');
const chkExtPinned = document.getElementById('chk-ext-pinned');

// Stage 3 Elements
const chkYtmSignedin = document.getElementById('chk-ytm-signedin');
const btnStartExtensionPairing = document.getElementById('btn-start-extension-pairing');
const btnCancelExtensionPairing = document.getElementById('btn-cancel-extension-pairing');
const extensionPairingInfo = document.getElementById('extension-pairing-info');
const extensionPairingBadge = document.getElementById('extension-pairing-badge');
const pairingPortVal = document.getElementById('pairing-port-val');
const pairingNonceVal = document.getElementById('pairing-nonce-val');
const btnCopyPairingPort = document.getElementById('btn-copy-pairing-port');
const btnCopyPairingNonce = document.getElementById('btn-copy-pairing-nonce');
const btnCopyAllDetails = document.getElementById('btn-copy-all-details');
const pairingCountdownVal = document.getElementById('pairing-countdown-val');

const browserLoginError = document.getElementById('browser-login-error');
const browserLoginModes = document.getElementById('browser-login-modes');
const tabLoginInapp = document.getElementById('tab-login-inapp');
const tabLoginProfiles = document.getElementById('tab-login-profiles');
const tabLoginExtension = document.getElementById('tab-login-extension');
const tabLoginCookie = document.getElementById('tab-login-cookie');
const paneLoginInapp = document.getElementById('pane-login-inapp');
const paneLoginProfiles = document.getElementById('pane-login-profiles');
const paneLoginExtension = document.getElementById('pane-login-extension');
const paneLoginCookie = document.getElementById('pane-login-cookie');

let extensionSavedFilePath = '';
let pairingCountdownInterval = null;
let activePairingExpiresAt = null;

if (!browserLoginDialog) {
  console.error('[BrowserLogin] Critical initialization error: #browser-login-dialog not found in DOM');
}

function switchBrowserLoginTab(mode) {
  const targetMode = mode || 'inapp';
  if (browserLoginModes) {
    browserLoginModes.querySelectorAll('button[data-mode]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mode === targetMode);
    });
  }
  if (browserLoginDialog) {
    browserLoginDialog.querySelectorAll('.browser-login-pane[data-mode]').forEach((pane) => {
      pane.classList.toggle('hidden', pane.dataset.mode !== targetMode);
    });
  }
  if (browserLoginError) {
    browserLoginError.classList.add('hidden');
  }
  if (targetMode === 'profiles') {
    refreshBrowserProfilesUI();
  }
}

if (tabLoginInapp) tabLoginInapp.addEventListener('click', () => switchBrowserLoginTab('inapp'));
if (tabLoginProfiles) tabLoginProfiles.addEventListener('click', () => switchBrowserLoginTab('profiles'));
if (tabLoginExtension) tabLoginExtension.addEventListener('click', () => switchBrowserLoginTab('extension'));
if (tabLoginCookie) tabLoginCookie.addEventListener('click', () => switchBrowserLoginTab('cookie'));

function openBrowserLoginModal(initialMode = 'inapp') {
  if (!browserLoginDialog) {
    console.error('[BrowserLogin] Cannot open Browser Login modal: #browser-login-dialog element is missing');
    if (typeof showToast === 'function') {
      showToast('Browser Login dialog markup is missing or failed to initialize', 'error');
    }
    return;
  }
  browserLoginDialog.classList.remove('hidden');
  browserLoginDialog.classList.add('visible');
  switchBrowserLoginTab(initialMode);
  updateGoogleAuthUI();
}

function closeBrowserLoginModal() {
  if (!browserLoginDialog) return;
  browserLoginDialog.classList.remove('visible');
  browserLoginDialog.classList.add('hidden');
  stopPairingCountdown();
  if (window.electronAPI && window.electronAPI.browserLoginCancelPairing) {
    window.electronAPI.browserLoginCancelPairing().catch(() => {});
  }
  resetPairingUI();
}

function stopPairingCountdown() {
  if (pairingCountdownInterval) {
    clearInterval(pairingCountdownInterval);
    pairingCountdownInterval = null;
  }
  activePairingExpiresAt = null;
}

function updateStartPairingState() {
  const isStage2Confirmed = !!(chkExtExtracted && chkExtExtracted.checked && chkExtLoaded && chkExtLoaded.checked && chkExtPinned && chkExtPinned.checked);
  const isStage3Ready = !!(chkYtmSignedin && chkYtmSignedin.checked);
  const canStart = isStage2Confirmed && isStage3Ready;
  if (btnStartExtensionPairing && !pairingCountdownInterval) {
    btnStartExtensionPairing.disabled = !canStart;
  }
}

[chkExtExtracted, chkExtLoaded, chkExtPinned, chkYtmSignedin].forEach((chk) => {
  if (chk) chk.addEventListener('change', updateStartPairingState);
});

function resetPairingUI() {
  stopPairingCountdown();
  if (extensionPairingInfo) extensionPairingInfo.classList.add('hidden');
  if (btnStartExtensionPairing) {
    btnStartExtensionPairing.classList.remove('hidden');
    updateStartPairingState();
  }
  if (btnCancelExtensionPairing) btnCancelExtensionPairing.classList.add('hidden');
  if (extensionPairingBadge) {
    extensionPairingBadge.textContent = 'Ready';
    extensionPairingBadge.className = 'pairing-badge';
  }
  if (pairingPortVal) pairingPortVal.textContent = '--';
  if (pairingNonceVal) {
    pairingNonceVal.textContent = '--';
    pairingNonceVal.title = '';
  }
  if (pairingCountdownVal) pairingCountdownVal.textContent = '120';
  if (browserLoginError) {
    browserLoginError.textContent = '';
    browserLoginError.classList.add('hidden');
  }
}

async function handleExportExtension() {
  if (!window.electronAPI || !window.electronAPI.browserLoginExportExtension) {
    showBrowserLoginError('Export extension IPC not supported in this runtime');
    return;
  }
  if (btnExportExtension) btnExportExtension.disabled = true;
  try {
    const res = await window.electronAPI.browserLoginExportExtension();
    if (res && res.success && res.filePath) {
      extensionSavedFilePath = res.filePath;
      if (extensionSavedPath) {
        extensionSavedPath.textContent = res.filePath;
        extensionSavedPath.title = res.filePath;
      }
      if (extensionSavedPathBox) extensionSavedPathBox.classList.remove('hidden');
      if (btnExportExtension) btnExportExtension.classList.add('hidden');
      if (btnOpenExtensionFolder) btnOpenExtensionFolder.classList.remove('hidden');
      if (btnReexportExtension) btnReexportExtension.classList.remove('hidden');
      if (typeof showToast === 'function') {
        showToast('Companion extension package saved', 'success');
      }
    } else if (res && res.canceled) {
      // user canceled save dialog
    } else {
      showBrowserLoginError((res && res.error) || 'Failed to export companion extension');
    }
  } catch (err) {
    showBrowserLoginError(err.message || 'Error exporting companion extension');
  } finally {
    if (btnExportExtension) btnExportExtension.disabled = false;
  }
}

if (btnExportExtension) btnExportExtension.addEventListener('click', handleExportExtension);
if (btnReexportExtension) btnReexportExtension.addEventListener('click', handleExportExtension);
if (btnOpenExtensionFolder) {
  btnOpenExtensionFolder.addEventListener('click', async () => {
    if (window.electronAPI && window.electronAPI.browserLoginRevealExportedExtension) {
      const res = await window.electronAPI.browserLoginRevealExportedExtension();
      if (res && !res.success) {
        showBrowserLoginError(res.error || 'Exported extension file no longer exists. Please download it again.');
        if (typeof showToast === 'function') {
          showToast(res.error || 'Exported extension file no longer exists. Please download it again.', 'error');
        }
      }
    } else if (window.electronAPI && window.electronAPI.showItemInFolder && extensionSavedFilePath) {
      window.electronAPI.showItemInFolder(extensionSavedFilePath);
    }
  });
}

async function openExtensionManager(browserType) {
  if (window.electronAPI && window.electronAPI.browserLoginOpenExtensionManager) {
    const res = await window.electronAPI.browserLoginOpenExtensionManager(browserType);
    if (res && !res.success && res.error) {
      showBrowserLoginError(res.error);
    }
  } else if (window.electronAPI && window.electronAPI.openExternal) {
    const urls = {
      chrome: 'chrome://extensions',
      edge: 'edge://extensions',
      brave: 'brave://extensions'
    };
    window.electronAPI.openExternal(urls[browserType] || 'chrome://extensions');
  }
}

if (btnOpenChromeExt) btnOpenChromeExt.addEventListener('click', () => openExtensionManager('chrome'));
if (btnOpenEdgeExt) btnOpenEdgeExt.addEventListener('click', () => openExtensionManager('edge'));
if (btnOpenBraveExt) btnOpenBraveExt.addEventListener('click', () => openExtensionManager('brave'));

async function refreshBrowserProfilesUI() {
  if (!browserProfilesList) return;
  browserProfilesList.innerHTML = '<div class="browser-profiles-empty">Discovering browser profiles...</div>';
  try {
    if (window.electronAPI && window.electronAPI.browserLoginGetProfiles) {
      const res = await window.electronAPI.browserLoginGetProfiles();
      if (res && res.success && Array.isArray(res.profiles) && res.profiles.length > 0) {
        browserProfilesList.innerHTML = '';
        for (const p of res.profiles) {
          const card = document.createElement('div');
          card.className = 'browser-profile-item';
          const info = document.createElement('div');
          const statusClass = p.status === 'COOKIES_FOUND' ? 'browser-profile-status found' : 'browser-profile-status muted';
          const statusText = p.requiresExtension ? 'Extension pairing available' : (p.status === 'COOKIES_FOUND' ? 'YouTube session detected' : p.status);
          info.innerHTML = `<div class="browser-profile-name">${p.browser} <span class="browser-profile-sub">(${p.profileName})</span></div>
            <div class="${statusClass}">${statusText}</div>`;
          card.appendChild(info);

          const btnConnect = document.createElement('button');
          btnConnect.className = 'btn-outline-pill';
          btnConnect.style.cssText = 'padding: 5px 12px; font-size: 11px;';
          btnConnect.textContent = p.requiresExtension ? 'Pair via Extension' : 'Connect';
          btnConnect.addEventListener('click', async () => {
            if (p.requiresExtension) {
              switchBrowserLoginTab('extension');
              if (typeof showToast === 'function') {
                showToast('Please complete the installation steps and confirm all prerequisites before pairing.', 'info');
              }
              const stageSetup = document.getElementById('stage-browser-setup');
              if (stageSetup) {
                const prefersReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
                try {
                  stageSetup.scrollIntoView({ behavior: prefersReduced ? 'auto' : 'smooth', block: 'center' });
                } catch (_) {}
                stageSetup.classList.add('stage-highlight');
                setTimeout(() => {
                  stageSetup.classList.remove('stage-highlight');
                }, 1800);
              }
            } else {
              btnConnect.disabled = true;
              btnConnect.textContent = 'Connecting...';
              try {
                const impRes = await window.electronAPI.browserLoginImportProfile(p);
                if (impRes && impRes.success) {
                  onLoginSuccess(impRes.account);
                } else {
                  showBrowserLoginError(impRes.error || 'Failed to import session from profile');
                  btnConnect.disabled = false;
                  btnConnect.textContent = 'Connect';
                }
              } catch (e) {
                showBrowserLoginError(e.message);
                btnConnect.disabled = false;
                btnConnect.textContent = 'Connect';
              }
            }
          });
          card.appendChild(btnConnect);
          browserProfilesList.appendChild(card);
        }
      } else {
        browserProfilesList.innerHTML = '<div class="browser-profiles-empty">No Gecko profiles (Firefox/Zen) found. Switch to the <strong>Extension Pairing</strong> tab for Chrome, Edge, and Brave.</div>';
      }
    }
  } catch (e) {
    browserProfilesList.innerHTML = `<div class="browser-login-error-box">Discovery error: ${e.message}</div>`;
  }
}

function startPairingTimer(expiresAt) {
  stopPairingCountdown();
  activePairingExpiresAt = typeof expiresAt === 'number' && expiresAt > Date.now() ? expiresAt : (Date.now() + 120000);
  const update = () => {
    const now = Date.now();
    const remainingSeconds = Math.max(0, Math.ceil((activePairingExpiresAt - now) / 1000));
    if (pairingCountdownVal) {
      pairingCountdownVal.textContent = remainingSeconds;
    }
    if (remainingSeconds <= 0) {
      stopPairingCountdown();
      if (extensionPairingBadge) {
        extensionPairingBadge.textContent = 'Expired';
        extensionPairingBadge.className = 'pairing-badge expired';
      }
      if (btnStartExtensionPairing) {
        btnStartExtensionPairing.classList.remove('hidden');
        updateStartPairingState();
      }
      if (btnCancelExtensionPairing) {
        btnCancelExtensionPairing.classList.add('hidden');
      }
      showBrowserLoginError('Pairing session expired after 120s. Please start pairing again.');
      if (window.electronAPI && window.electronAPI.browserLoginCancelPairing) {
        window.electronAPI.browserLoginCancelPairing().catch(() => {});
      }
    }
  };
  update();
  pairingCountdownInterval = setInterval(update, 1000);
}

async function startExtensionPairingFlow() {
  // Re-validate all four prerequisites at every entry point
  const isStage2Confirmed = !!(chkExtExtracted && chkExtExtracted.checked && chkExtLoaded && chkExtLoaded.checked && chkExtPinned && chkExtPinned.checked);
  const isStage3Ready = !!(chkYtmSignedin && chkYtmSignedin.checked);
  if (!isStage2Confirmed || !isStage3Ready) {
    switchBrowserLoginTab('extension');
    const missingMsg = !isStage2Confirmed
      ? 'Please extract, load, and pin Eclipse Connect, then check all confirmations in Stage 2.'
      : 'Please sign into YouTube Music in your browser profile and check the confirmation in Stage 3.';
    showBrowserLoginError(missingMsg);
    if (typeof showToast === 'function') {
      showToast(missingMsg, 'warning');
    }
    updateStartPairingState();
    return;
  }

  resetPairingUI();
  if (btnStartExtensionPairing) {
    btnStartExtensionPairing.disabled = true;
    btnStartExtensionPairing.classList.add('hidden');
  }
  if (btnCancelExtensionPairing) btnCancelExtensionPairing.classList.remove('hidden');

  try {
    if (window.electronAPI && window.electronAPI.browserLoginStartPairing) {
      const res = await window.electronAPI.browserLoginStartPairing();
      if (res && res.success) {
        // Show Listening badge only after server starts successfully
        if (extensionPairingBadge) {
          extensionPairingBadge.textContent = 'Listening...';
          extensionPairingBadge.className = 'pairing-badge listening';
        }
        if (pairingPortVal) pairingPortVal.textContent = res.port;
        if (pairingNonceVal) {
          pairingNonceVal.textContent = res.nonce;
          pairingNonceVal.title = res.nonce;
        }
        if (extensionPairingInfo) extensionPairingInfo.classList.remove('hidden');
        startPairingTimer(res.expiresAt);
      } else {
        showBrowserLoginError(res.error || 'Could not start pairing server');
        resetPairingUI();
      }
    }
  } catch (e) {
    showBrowserLoginError(e.message);
    resetPairingUI();
  }
}

function showBrowserLoginError(msg, details = null) {
  if (!browserLoginError) return;
  browserLoginError.innerHTML = '';

  const msgEl = document.createElement('div');
  msgEl.className = 'browser-login-error-msg';
  msgEl.textContent = msg;
  browserLoginError.appendChild(msgEl);

  if (details && typeof details === 'object') {
    const diagEl = document.createElement('div');
    diagEl.className = 'browser-login-error-diagnostics';
    diagEl.style.marginTop = '8px';
    diagEl.style.padding = '8px';
    diagEl.style.background = 'rgba(0, 0, 0, 0.4)';
    diagEl.style.borderRadius = '6px';
    diagEl.style.fontSize = '11px';
    diagEl.style.fontFamily = 'monospace';
    diagEl.style.wordBreak = 'break-all';

    const summaryParts = [];
    if (details.upstreamStatus) summaryParts.push('Status: ' + details.upstreamStatus);
    if (details.upstreamDiagnostic) {
      if (details.upstreamDiagnostic.code) summaryParts.push('Code: ' + details.upstreamDiagnostic.code);
      if (details.upstreamDiagnostic.status) summaryParts.push('StatusText: ' + details.upstreamDiagnostic.status);
      if (details.upstreamDiagnostic.reason) summaryParts.push('Reason: ' + details.upstreamDiagnostic.reason);
      if (Array.isArray(details.upstreamDiagnostic.reasons) && details.upstreamDiagnostic.reasons.length > 0) {
        const r0 = details.upstreamDiagnostic.reasons[0];
        summaryParts.push('Reason: ' + (r0.reason || 'unknown') + (r0.location ? ' (' + r0.location + ')' : ''));
      }
      if (details.upstreamDiagnostic.message) summaryParts.push('Msg: ' + details.upstreamDiagnostic.message);
    }
    if (details.requestFingerprint) {
      const fp = details.requestFingerprint;
      summaryParts.push('Cred: ' + (fp.selectedCredentialName || 'NONE') + '@' + (fp.selectedCredentialDomain || 'UNKNOWN') + ' (' + (fp.selectedCredentialScope || 'unknown') + ')');
      summaryParts.push('ExactInCookie: ' + Boolean(fp.isCredentialInCookieHeader));
      summaryParts.push('YtSapisidPresent: ' + Boolean(fp.hasYouTubeSapisidInCookieHeader));
      summaryParts.push('ClientVer: ' + (fp.clientVersion || 'unknown'));
      summaryParts.push('OutgoingCookies: [' + (fp.outgoingCookieNames || []).join(', ') + ']');
    }
    if (details.diagnosticReadError) summaryParts.push('DiagReadErr: ' + details.diagnosticReadError);
    diagEl.textContent = summaryParts.join(' | ') || JSON.stringify(details);
    browserLoginError.appendChild(diagEl);
  }

  browserLoginError.classList.remove('hidden');
}


let activeYtmAccountId = 'default';

const globalPreloadManager = (window.EclipsePreloadManager && typeof window.EclipsePreloadManager === 'function')
  ? new window.EclipsePreloadManager({
      serverPort: (typeof state !== 'undefined' && state.serverPort) || 38472,
      getServerToken: () => (window.electronAPI && window.electronAPI.serverToken) || (state && state.serverToken) || '',
      isOffline: () => typeof navigator !== 'undefined' && navigator.onLine === false,
      isDataSaver: () => {
        if (localStorage.getItem('eclipse_perf_mode') === '1') return true;
        if (typeof navigator !== 'undefined' && navigator.connection && navigator.connection.saveData === true) return true;
        return false;
      },
      getIsPlaying: () => Boolean(state && state.isPlaying),
      getCurrentTrackId: () => {
        const t = state && state.currentTrack;
        return t ? String(t.id || t.videoId || t.url || `${t.artist}_${t.title}`).trim().toLowerCase() : null;
      }
    })
  : null;
if (typeof window !== 'undefined' && globalPreloadManager) {
  window.__eclipsePreloadManager = globalPreloadManager;
}

const librarySyncCoordinator = (window.EclipseAlbumSyncEngine && typeof window.EclipseAlbumSyncEngine.createLibrarySyncCoordinator === 'function')
  ? window.EclipseAlbumSyncEngine.createLibrarySyncCoordinator({
      getActiveAccountId: () => activeYtmAccountId,
      isAppActive: () => typeof document === 'undefined' || !document.hidden,
      timeoutMs: 45000,
      cancelFn: async (requestId) => {
        if (window.electronAPI && typeof window.electronAPI.cancelLibrarySync === 'function') {
          return window.electronAPI.cancelLibrarySync(requestId);
        }
      },
      syncFn: async ({ accountId, requestId }) => window.electronAPI.googleImportLibrary({
        platform: 'ytmusic',
        doLikes: true,
        doPlaylists: true,
        doAlbums: true,
        accountId: accountId && accountId !== 'default' ? accountId : null,
        requestId
      })
    })
  : null;
if (typeof window !== 'undefined' && librarySyncCoordinator) {
  window.__eclipseLibrarySyncCoordinator = librarySyncCoordinator;
}

async function autoSyncYtmLibraryOnLogin(account, opts) {
  if (!window.electronAPI || typeof window.electronAPI.googleImportLibrary !== 'function') return;
  const trigger = (opts && opts.trigger) || 'manual';
  if (account && (account.id || account.pageId || account.name)) {
    const nextAccId = String(account.id || account.pageId || account.name);
    if (nextAccId !== activeYtmAccountId) {
      activeYtmAccountId = nextAccId;
      if (librarySyncCoordinator) librarySyncCoordinator.invalidateAccount('account_changed');
    }
  }
  try {
    if (trigger === 'manual' && typeof showToast === 'function') {
      showToast('Đang đồng bộ thư viện YouTube Music...', 'info');
    }
    let res;
    if (librarySyncCoordinator) {
      const outcome = await librarySyncCoordinator.runSync(trigger);
      if (outcome.skipped) {
        if (trigger === 'manual' && typeof showToast === 'function') {
          showToast('Đồng bộ đang tạm hoãn, vui lòng thử lại sau.', 'info');
        }
        return outcome;
      }
      if (outcome.discarded) return outcome;
      if (!outcome.success) {
        const safeMsg = outcome.rateLimited
          ? 'YouTube Music đang giới hạn tốc độ (HTTP 429). Vui lòng thử lại sau.'
          : (outcome.error || 'Đồng bộ thư viện thất bại');
        console.warn('[autoSyncYtmLibraryOnLogin] sync failed:', safeMsg);
        if (trigger === 'manual' && typeof showToast === 'function') {
          showToast(safeMsg, 'error');
        }
        return outcome;
      }
      res = outcome.data;
    } else {
      res = await window.electronAPI.googleImportLibrary({ platform: 'ytmusic', doLikes: true, doPlaylists: true, doAlbums: true });
    }
    if (!res || !res.success) {
      const errMsg = (res && res.error) || 'Đồng bộ thư viện thất bại';
      console.warn('[autoSyncYtmLibraryOnLogin] auto sync failed:', errMsg);
      if (trigger === 'manual' && typeof showToast === 'function') {
        showToast(errMsg, 'error');
      }
      return;
    }
    if (res.accountId && activeYtmAccountId === 'default') {
      activeYtmAccountId = String(res.accountId);
    }
    const syncEngine = window.EclipseAlbumSyncEngine || null;
    const likes = res.likes || [];
    const playlists = res.playlists || [];
    const rawAlbums = res.albums || [];
    let addedTracks = 0;
    let addedPlaylists = 0;
    let addedFav = false;

    if (likes.length > 0) {
      const favKeys = new Set(state.favorites.map(f => syncEngine ? syncEngine.getTrackDedupKey(f) : getTrackCanonicalId(f)));
      for (const track of likes) {
        const key = syncEngine ? syncEngine.getTrackDedupKey(track) : getTrackCanonicalId(track);
        if (key && !favKeys.has(key)) {
          state.favorites.push(stampAddedAt(track));
          favKeys.add(key);
          addedFav = true;
          addedTracks++;
        }
      }
      if (addedFav) {
        localStorage.setItem('devsize_favorites', JSON.stringify(state.favorites.map(sanitizeTrackForStorage)));
        if (typeof updateFavoritesBadge === 'function') updateFavoritesBadge();
        if (typeof updateFavoriteIcon === 'function') updateFavoriteIcon();
        if (state.currentView === 'favorites' && typeof renderFavoritesView === 'function') renderFavoritesView();
      }
      if (typeof hydrateMissingPlaylistCovers === 'function') hydrateMissingPlaylistCovers(state.favorites);
    }

    if (playlists.length > 0) {
      const normPlId = (raw) => (syncEngine && typeof syncEngine.normalizeUpstreamId === 'function')
        ? syncEngine.normalizeUpstreamId(raw)
        : String(raw || '').trim().replace(/^VL(?=(?:PL|LM|OLAK|RDCLAK|UU|FL))/i, '');
      for (const pl of playlists) {
        const rawPlTracks = pl.tracks || [];
        const plTracks = (syncEngine && typeof syncEngine.deduplicateTracks === 'function')
          ? syncEngine.deduplicateTracks(rawPlTracks)
          : rawPlTracks;
        const plYtId = normPlId(pl.id);
        const normName = (pl.name || '').trim().toLowerCase();
        // P1-2: Match by normalized upstream ID (migrating 'default' -> activeYtmAccountId) or fallback name
        const existingPl = state.playlists.find(p => {
          const pAcc = p.accountId || 'default';
          const accMatch = pAcc === activeYtmAccountId || pAcc === 'default';
          const pYtId = normPlId(p.ytId);
          if (plYtId && pYtId && pYtId === plYtId && accMatch) return true;
          if ((!plYtId || !pYtId) && accMatch && normName && (p.name || '').trim().toLowerCase() === normName) return true;
          return false;
        });
        if (existingPl) {
          if (plYtId) existingPl.ytId = plYtId;
          existingPl.accountId = activeYtmAccountId;
          if (pl.cover) existingPl.cover = pl.cover;
          if (syncEngine) {
            const rec = syncEngine.reconcilePlaylistTracks(
              existingPl.tracks || [],
              plTracks.map(t => stampAddedAt(t)),
              { complete: pl.complete, failed: pl.failed, continuationRemaining: pl.continuationRemaining }
            );
            if (!rec.preservedDueToIncompleteFetch) {
              existingPl.tracks = rec.tracks;
              addedTracks += rec.added;
            }
          } else {
            const existingIds = new Set((existingPl.tracks || []).map(t => t.id || t.url || t.title));
            for (const t of plTracks) {
              const key = t.id || t.url || t.title;
              if (!existingIds.has(key)) {
                existingPl.tracks.push(stampAddedAt(t));
                existingIds.add(key);
                addedTracks++;
              }
            }
          }
        } else {
          const created = typeof createPlaylist === 'function' ? createPlaylist(pl.name, plTracks, pl.cover || '') : null;
          if (created) {
            if (plYtId) created.ytId = plYtId;
            created.accountId = activeYtmAccountId;
          }
          addedPlaylists++;
          addedTracks += plTracks.length;
        }
      }
      if (typeof deduplicateLibraryData === 'function') deduplicateLibraryData({ silent: true });
      localStorage.setItem('devsize_playlists', JSON.stringify(state.playlists));
      if (typeof renderPlaylistsList === 'function') renderPlaylistsList();
    }

    if (typeof getSavedAlbums === 'function' && typeof setSavedAlbums === 'function') {
      try {
        const currentSaved = getSavedAlbums();
        const incomingEntities = [];
        if (Array.isArray(rawAlbums)) {
          for (const alb of rawAlbums) {
            incomingEntities.push({
              id: alb.id,
              title: alb.title,
              artist: alb.artist || '',
              cover: alb.cover || '',
              type: 'Album',
              entityType: 'album',
              platform: 'ytmusic',
              accountId: activeYtmAccountId,
              addedAt: Date.now()
            });
          }
        }
        if (Array.isArray(playlists)) {
          for (const pl of playlists) {
            incomingEntities.push({
              id: pl.id,
              title: pl.name,
              artist: 'Danh sách phát',
              cover: pl.cover || '',
              type: 'Danh sách phát',
              entityType: 'playlist',
              platform: 'ytmusic',
              accountId: activeYtmAccountId,
              tracks: Array.isArray(pl.tracks) ? pl.tracks : [],
              complete: pl.complete,
              failed: pl.failed,
              continuationRemaining: pl.continuationRemaining,
              addedAt: Date.now()
            });
          }
        }
        let addedAlbumsCount = 0;
        let updatedAlbumsCount = 0;
        if (incomingEntities.length > 0 && syncEngine) {
          const merged = syncEngine.mergeSavedAlbumEntities(currentSaved, incomingEntities, activeYtmAccountId);
          addedAlbumsCount = merged.added;
          updatedAlbumsCount = merged.updated;
          if (merged.added > 0 || merged.updated > 0) {
            setSavedAlbums(merged.list);
            if (state.currentView === 'albums' && typeof renderSavedAlbums === 'function') renderSavedAlbums();
            if (typeof updateAlbumsCount === 'function') updateAlbumsCount();
          }
        }
        if (trigger === 'manual' && typeof showToast === 'function') {
          const totalChanges = addedTracks + addedPlaylists + addedAlbumsCount + updatedAlbumsCount;
          if (totalChanges > 0) {
            showToast(`Đã đồng bộ: +${addedTracks} bài hát, +${addedPlaylists} playlist, +${addedAlbumsCount} mới / ${updatedAlbumsCount} cập nhật`, 'success');
          } else {
            showToast('Thư viện đã được cập nhật mới nhất (không có thay đổi).', 'info');
          }
        }
      } catch (_) {}
    }
  } catch (syncErr) {
    console.warn('[autoSyncYtmLibraryOnLogin] error during sync:', syncErr);
    if (trigger === 'manual' && typeof showToast === 'function') {
      showToast(`Lỗi đồng bộ thư viện: ${(syncErr && syncErr.message) || 'Unknown error'}`, 'error');
    }
  }
}

function onLoginSuccess(account) {
  stopPairingCountdown();
  googleConnected = true;
  updateGoogleAuthUI();
  if (googleLoginStatus) {
    googleLoginStatus.textContent = account && account.name ? `Connected: ${account.name}` : 'Connected';
  }
  if (settingsYtmAccountStatus) {
    settingsYtmAccountStatus.textContent = account && account.name ? `Connected: ${account.name}` : 'Connected';
    settingsYtmAccountStatus.style.color = '#4caf50';
  }
  if (typeof showToast === 'function') {
    showToast(account && account.name ? `Đã kết nối YouTube Music: ${account.name}` : 'Đã kết nối YouTube Music', 'success');
  }
  closeBrowserLoginModal();
  // Fetch user library metadata without auto-confirming or clicking import
  autoSyncYtmLibraryOnLogin(account);
  if (state.serverPort) {
    fetch(`http://127.0.0.1:${state.serverPort}/api/ytm/library`).catch(() => {});
  }
}

// Expose pairing controller for automated test verification
if (typeof window !== 'undefined') {
  window.__eclipsePairingController = {
    updateStartPairingState,
    startPairingTimer,
    stopPairingCountdown,
    resetPairingUI
  };
}

if (btnCloseBrowserLogin) btnCloseBrowserLogin.addEventListener('click', closeBrowserLoginModal);
if (browserLoginDialog) {
  browserLoginDialog.addEventListener('click', (e) => {
    if (e.target === browserLoginDialog) closeBrowserLoginModal();
  });
}
if (btnRefreshBrowserProfiles) btnRefreshBrowserProfiles.addEventListener('click', refreshBrowserProfilesUI);
if (btnStartExtensionPairing) btnStartExtensionPairing.addEventListener('click', startExtensionPairingFlow);
if (btnCancelExtensionPairing) btnCancelExtensionPairing.addEventListener('click', () => {
  stopPairingCountdown();
  if (window.electronAPI && window.electronAPI.browserLoginCancelPairing) {
    window.electronAPI.browserLoginCancelPairing().catch(() => {});
  }
  resetPairingUI();
});

if (btnCopyPairingPort && pairingPortVal) {
  btnCopyPairingPort.addEventListener('click', () => {
    const port = pairingPortVal.textContent;
    if (port && port !== '--') {
      navigator.clipboard.writeText(port).then(() => {
        btnCopyPairingPort.textContent = 'Copied!';
        if (typeof showToast === 'function') showToast('Pairing Port copied to clipboard', 'success');
        setTimeout(() => { btnCopyPairingPort.textContent = 'Copy Port'; }, 2000);
      }).catch(() => {});
    }
  });
}

if (btnCopyPairingNonce && pairingNonceVal) {
  btnCopyPairingNonce.addEventListener('click', () => {
    const nonce = pairingNonceVal.textContent;
    if (nonce && nonce !== '--') {
      navigator.clipboard.writeText(nonce).then(() => {
        btnCopyPairingNonce.textContent = 'Copied!';
        if (typeof showToast === 'function') showToast('Pairing Nonce copied to clipboard', 'success');
        setTimeout(() => { btnCopyPairingNonce.textContent = 'Copy Nonce'; }, 2000);
      }).catch(() => {});
    }
  });
}

if (btnCopyAllDetails && pairingPortVal && pairingNonceVal) {
  btnCopyAllDetails.addEventListener('click', () => {
    const port = pairingPortVal.textContent;
    const nonce = pairingNonceVal.textContent;
    if (port && port !== '--' && nonce && nonce !== '--') {
      const text = `Port: ${port}\nNonce: ${nonce}`;
      navigator.clipboard.writeText(text).then(() => {
        btnCopyAllDetails.textContent = 'All Details Copied!';
        if (typeof showToast === 'function') showToast('Pairing Port & Nonce copied to clipboard', 'success');
        setTimeout(() => { btnCopyAllDetails.textContent = 'Copy All Details'; }, 2000);
      }).catch(() => {});
    }
  });
}

if (window.electronAPI && window.electronAPI.onBrowserLoginPairingResult) {
  window.electronAPI.onBrowserLoginPairingResult((result) => {
    if (result && result.success) {
      onLoginSuccess(result.account);
    } else if (result && result.details && Array.isArray(result.details.candidates) && result.details.candidates.length > 1) {
      showCandidateSelectionModal(result.details.candidates, result.details.pendingToken);
    } else {
      showBrowserLoginError(result.error || result.reason || 'Pairing was rejected or timed out', result.details || null);
      resetPairingUI();
    }
  });

function showCandidateSelectionModal(candidates, pendingToken) {
  if (!browserLoginError) return;
  browserLoginError.innerHTML = '';

  const titleEl = document.createElement('div');
  titleEl.className = 'browser-login-candidate-title';
  titleEl.style.fontWeight = 'bold';
  titleEl.style.marginBottom = '8px';
  titleEl.textContent = 'Phát hiện nhiều tài khoản. Vui lòng chọn tài khoản muốn kết nối:';
  browserLoginError.appendChild(titleEl);

  const listEl = document.createElement('div');
  listEl.className = 'browser-login-candidate-list';
  listEl.style.display = 'flex';
  listEl.style.flexDirection = 'column';
  listEl.style.gap = '6px';

  for (const c of candidates) {
    const itemBtn = document.createElement('button');
    itemBtn.type = 'button';
    itemBtn.className = 'btn-candidate-select';
    itemBtn.style.display = 'flex';
    itemBtn.style.alignItems = 'center';
    itemBtn.style.gap = '8px';
    itemBtn.style.padding = '8px 12px';
    itemBtn.style.background = 'rgba(255, 255, 255, 0.08)';
    itemBtn.style.border = '1px solid rgba(255, 255, 255, 0.15)';
    itemBtn.style.borderRadius = '8px';
    itemBtn.style.color = '#fff';
    itemBtn.style.cursor = 'pointer';
    itemBtn.style.textAlign = 'left';

    if (c.avatarUrl) {
      const img = document.createElement('img');
      img.src = c.avatarUrl;
      img.style.width = '24px';
      img.style.height = '24px';
      img.style.borderRadius = '50%';
      itemBtn.appendChild(img);
    }

    const infoSpan = document.createElement('span');
    infoSpan.textContent = (c.name || 'User') + (c.handle ? ' (' + c.handle + ')' : '') + (c.pageId ? ' [Channel]' : ' [Google Account]');
    itemBtn.appendChild(infoSpan);

    itemBtn.addEventListener('click', async () => {
      itemBtn.disabled = true;
      itemBtn.style.opacity = '0.5';

      // Secure confirmation via single-use pending selection session
      if (pendingToken && window.electronAPI && typeof window.electronAPI.browserLoginConfirmCandidate === 'function') {
        try {
          const confirmRes = await window.electronAPI.browserLoginConfirmCandidate(pendingToken, c.index);
          if (confirmRes && confirmRes.success && confirmRes.account) {
            onLoginSuccess(confirmRes.account);
            return;
          } else {
            showBrowserLoginError(confirmRes?.error || 'Lựa chọn tài khoản thất bại', null);
            return;
          }
        } catch (err) {
          showBrowserLoginError(err.message || 'Lỗi kết nối xác nhận tài khoản', null);
          return;
        }
      }

      // Direct backend call fallback if electronAPI helper unavailable
      if (pendingToken && state.serverPort) {
        try {
          const resp = await fetch(`http://127.0.0.1:${state.serverPort}/api/ytm/confirm-candidate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pendingToken, candidateIndex: c.index })
          });
          const data = await resp.json();
          if (data && data.success && data.account) {
            onLoginSuccess(data.account);
            return;
          } else {
            showBrowserLoginError(data?.error || 'Lựa chọn tài khoản thất bại', null);
            return;
          }
        } catch (err) {
          showBrowserLoginError(err.message || 'Lỗi kết nối xác nhận tài khoản', null);
          return;
        }
      }

      showBrowserLoginError('Không tìm thấy phiên lựa chọn tài khoản hợp lệ. Vui lòng thử lại.', null);
    });

    listEl.appendChild(itemBtn);
  }

  browserLoginError.appendChild(listEl);
  browserLoginError.classList.remove('hidden');
}
}

if (btnGoogleLogin) {
  btnGoogleLogin.addEventListener('click', () => {
    openBrowserLoginModal();
  });
}

if (btnSettingsConnectYtm) {
  btnSettingsConnectYtm.addEventListener('click', () => {
    openBrowserLoginModal('inapp');
  });
}

const btnInappYtmSignin = document.getElementById('btn-inapp-ytm-signin');
const btnInappYtmBrowserFallback = document.getElementById('btn-inapp-ytm-browser-fallback');
const btnInappYtmLogout = document.getElementById('btn-inapp-ytm-logout');
const modalYtmCookieInput = document.getElementById('modal-ytm-cookie-input');
const btnModalYtmCookieApply = document.getElementById('btn-modal-ytm-cookie-apply');
const modalYtmCookieMsg = document.getElementById('modal-ytm-cookie-msg');

if (btnInappYtmSignin) {
  btnInappYtmSignin.addEventListener('click', async () => {
    if (!window.electronAPI || typeof window.electronAPI.googleLogin !== 'function') {
      showBrowserLoginError('In-app sign-in is unavailable in this environment.');
      return;
    }
    btnInappYtmSignin.disabled = true;
    const prevText = btnInappYtmSignin.textContent;
    btnInappYtmSignin.textContent = 'Signing in...';
    try {
      const res = await window.electronAPI.googleLogin();
      if (res && res.success) {
        onLoginSuccess(res.user || res.account || null);
      } else if (res && !res.cancelled) {
        showBrowserLoginError((res && res.error) || 'Google sign-in did not complete.');
      }
    } catch (err) {
      showBrowserLoginError((err && err.message) || 'Google sign-in failed.');
    } finally {
      btnInappYtmSignin.disabled = false;
      btnInappYtmSignin.textContent = prevText;
      updateGoogleAuthUI();
    }
  });
}

if (btnInappYtmBrowserFallback) {
  btnInappYtmBrowserFallback.addEventListener('click', () => {
    const url = 'https://accounts.google.com/ServiceLogin?service=youtube&continue=https://music.youtube.com';
    if (window.electronAPI && typeof window.electronAPI.openExternal === 'function') {
      window.electronAPI.openExternal(url);
    } else {
      window.open(url, '_blank');
    }
    if (typeof showToast === 'function') showToast('Opened Google sign-in in your browser.', 'info');
  });
}

if (btnInappYtmLogout) {
  btnInappYtmLogout.addEventListener('click', async () => {
    if (!window.electronAPI || typeof window.electronAPI.googleLogout !== 'function') return;
    btnInappYtmLogout.disabled = true;
    try {
      await window.electronAPI.googleLogout();
      googleConnected = false;
      updateGoogleAuthUI();
      if (typeof showToast === 'function') showToast('Disconnected YouTube Music account.', 'info');
    } catch (_) {} finally {
      btnInappYtmLogout.disabled = false;
    }
  });
}

if (btnModalYtmCookieApply && modalYtmCookieInput) {
  btnModalYtmCookieApply.addEventListener('click', async () => {
    const val = (modalYtmCookieInput.value || '').trim();
    if (!val) {
      if (modalYtmCookieMsg) {
        modalYtmCookieMsg.textContent = 'Please paste a cookie header first.';
        modalYtmCookieMsg.style.color = 'var(--md-sys-color-error, #ba1a1a)';
      }
      return;
    }
    if (modalYtmCookieMsg) {
      modalYtmCookieMsg.textContent = 'Verifying cookie...';
      modalYtmCookieMsg.style.color = 'var(--md-sys-color-outline)';
    }
    btnModalYtmCookieApply.disabled = true;
    try {
      if (window.electronAPI && typeof window.electronAPI.googleImportCookieText === 'function') {
        const res = await window.electronAPI.googleImportCookieText(val);
        if (res && res.success && res.loggedIn) {
          modalYtmCookieInput.value = '';
          if (modalYtmCookieMsg) {
            modalYtmCookieMsg.textContent = 'Connected!';
            modalYtmCookieMsg.style.color = '#4caf50';
          }
          onLoginSuccess(res.user || res.account || null);
        } else {
          if (modalYtmCookieMsg) {
            modalYtmCookieMsg.textContent = (res && res.error) || 'Invalid cookie (missing SAPISID).';
            modalYtmCookieMsg.style.color = 'var(--md-sys-color-error, #ba1a1a)';
          }
        }
      }
    } catch (err) {
      if (modalYtmCookieMsg) {
        modalYtmCookieMsg.textContent = (err && err.message) || 'Failed to apply cookie.';
        modalYtmCookieMsg.style.color = 'var(--md-sys-color-error, #ba1a1a)';
      }
    } finally {
      btnModalYtmCookieApply.disabled = false;
    }
  });
}

const btnGoogleCookieToggle = document.getElementById("btn-google-cookie-toggle");
const googleCookieBox = document.getElementById("google-cookie-box");
const googleCookieInput = document.getElementById("google-cookie-input");
const btnGoogleCookieApply = document.getElementById("btn-google-cookie-apply");
const googleCookieMsg = document.getElementById("google-cookie-msg");

if (btnGoogleCookieToggle && googleCookieBox) {
  btnGoogleCookieToggle.addEventListener("click", () => {
    googleCookieBox.classList.toggle("hidden");
    if (!googleCookieBox.classList.contains("hidden") && googleCookieInput) {
      googleCookieInput.focus();
    }
  });
}

if (btnGoogleCookieApply && googleCookieInput) {
  btnGoogleCookieApply.addEventListener("click", async () => {
    const val = (googleCookieInput.value || "").trim();
    if (!val) {
      if (googleCookieMsg) { googleCookieMsg.textContent = "Vui lòng dán cookie"; googleCookieMsg.style.color = "var(--md-sys-color-error, #ba1a1a)"; }
      return;
    }
    if (googleCookieMsg) { googleCookieMsg.textContent = "Đang kiểm tra..."; googleCookieMsg.style.color = "var(--md-sys-color-outline)"; }
    btnGoogleCookieApply.disabled = true;
    try {
      if (window.electronAPI && window.electronAPI.googleImportCookieText) {
        const res = await window.electronAPI.googleImportCookieText(val);
        if (res && res.success && res.loggedIn) {
          googleConnected = true;
          if (googleCookieMsg) { googleCookieMsg.textContent = "Đã kết nối thành công!"; googleCookieMsg.style.color = "var(--md-sys-color-primary, #6750A4)"; }
          if (googleCookieBox) googleCookieBox.classList.add("hidden");
          googleCookieInput.value = "";
        } else {
          if (googleCookieMsg) { googleCookieMsg.textContent = (res && res.error) || "Cookie không hợp lệ (thiếu SAPISID)"; googleCookieMsg.style.color = "var(--md-sys-color-error, #ba1a1a)"; }
        }
      }
    } catch (err) {
      if (googleCookieMsg) { googleCookieMsg.textContent = err.message || "Lỗi xử lý cookie"; googleCookieMsg.style.color = "var(--md-sys-color-error, #ba1a1a)"; }
    } finally {
      btnGoogleCookieApply.disabled = false;
      updateGoogleAuthUI();
    if (googleConnected && state.serverPort) {
      try {
        const accRes = await fetch(`http://127.0.0.1:${state.serverPort}/api/ytm/accounts`);
        const accData = await accRes.json();
        const active = accData && accData.activeAccount;
        if (active && active.name && googleLoginStatus) {
          googleLoginStatus.textContent = `Connected: ${active.name}`;
        }
        if (typeof showToast === 'function') {
          showToast(active && active.name ? `Đã kết nối YouTube Music: ${active.name}` : 'Đã kết nối YouTube Music', 'success');
        }
        fetch(`http://127.0.0.1:${state.serverPort}/api/ytm/library`).catch(() => {});
      } catch (_) {}
    }
    }
  });
}

if (btnGoogleLogout) {
  btnGoogleLogout.addEventListener('click', async () => {
    try {
      if (window.electronAPI && window.electronAPI.googleLogout) {
        await window.electronAPI.googleLogout();
      }
    } catch (e) {}
    googleConnected = false;
    activeYtmAccountId = 'default';
    if (librarySyncCoordinator) librarySyncCoordinator.invalidateAccount('logout');
    updateGoogleAuthUI();
    if (googleLoginStatus) {
      googleLoginStatus.textContent = 'Chưa kết nối';
      googleLoginStatus.style.color = 'var(--md-sys-color-outline)';
    }
    if (typeof showToast === 'function') {
      showToast('Đã đăng xuất YouTube Music', 'info');
    }
  });
}

function openLinkImportModal(platform = '') {
  if (!linkImportModal) return;
  currentLinkImportPlatform = platform || 'youtube';
  clearImportError(linkImportError);

  const titleEl = document.getElementById('link-import-title');
  if (titleEl) {
    if (platform === 'youtube') titleEl.textContent = 'Import from YouTube';
    else if (platform === 'ytmusic') titleEl.textContent = 'Import from YouTube Music';
    else if (platform === 'soundcloud') titleEl.textContent = 'Import from SoundCloud';
    else if (platform === 'yandex') titleEl.textContent = 'Import from Yandex Music';
    else titleEl.textContent = 'Import from link';
  }

  if (linkModesContainer) {
    if (platform === 'soundcloud' || platform === 'yandex') {
      linkModesContainer.classList.add('hidden');
    } else {
      linkModesContainer.classList.remove('hidden');
    }
  }

  setLinkImportMode('link');

  if (linkImportUrl) {
    linkImportUrl.value = '';
    linkImportUrl.disabled = false;
    if (platform === 'youtube') {
      linkImportUrl.placeholder = 'Paste a YouTube playlist or video link';
    } else if (platform === 'ytmusic') {
      linkImportUrl.placeholder = 'Paste a YouTube Music link';
    } else if (platform === 'soundcloud') {
      linkImportUrl.placeholder = 'Paste a SoundCloud playlist or track link';
    } else if (platform === 'yandex') {
      linkImportUrl.placeholder = 'Paste a Yandex Music playlist link';
    } else {
      linkImportUrl.placeholder = 'Paste a YouTube, YouTube Music, SoundCloud or Yandex Music link';
    }
  }

  const linkTargetSelect = document.getElementById('link-import-target');
  if (linkTargetSelect) {
    linkTargetSelect.innerHTML = [
      '<option value="__new__">Create new playlist</option>',
      '<option value="__favorites__">Add directly to Favorites</option>',
      ...(state.playlists || []).map(pl => `<option value="${escapeHtml(pl.id)}">Merge into: ${escapeHtml(pl.name || 'untitled')}</option>`)
    ].join('');
    linkTargetSelect.value = '__new__';
  }
  populateTargetDropdown('google-import-target', 'google-target-trigger', 'google-target-dropdown', 'google-target-menu', 'google-target-label', 'Separate playlists');

  if (linkImportProgressWrap) linkImportProgressWrap.classList.add('hidden');
  if (linkImportWavyContainer) linkImportWavyContainer.innerHTML = '';

  if (linkImportStatus) {
    linkImportStatus.classList.add('hidden');
    linkImportStatus.textContent = '';
    linkImportStatus.style.color = '';
  }

  if (btnConfirmLinkImport) {
    btnConfirmLinkImport.disabled = false;
    btnConfirmLinkImport.dataset.action = 'import';
    if (linkImportBtnText) linkImportBtnText.textContent = 'Import';
  }
  if (btnCancelLinkImport) btnCancelLinkImport.disabled = false;

  checkGoogleAuthStatus();
  openModal(linkImportModal);
  if (linkImportUrl) linkImportUrl.focus();
}

function closeLinkImportModal() {
  if (linkImportModal) closeModal(linkImportModal);
}

async function handleLinkImportAction() {
  if (btnConfirmLinkImport && btnConfirmLinkImport.dataset.action === 'done') {
    closeLinkImportModal();
    return;
  }

  if (currentLinkImportMode === 'login') {
    await handleGoogleLoginImport();
    return;
  }

  clearImportError(linkImportError);
  const url = linkImportUrl ? linkImportUrl.value.trim() : '';
  if (!url) {
    const errInfo = classifyImportError('link', 404, 'unsupported link');
    showImportError(linkImportError, errInfo);
    return;
  }

  closeLinkImportModal();
  showImportSpinnerToast('Importing playlist...');

  if (currentLinkImportPlatform === 'yandex' || url.includes('music.yandex.') || url.includes('yandex.')) {
    const hasBusy = typeof beginBusy === 'function';
    if (hasBusy) beginBusy('import');

    try {
      const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/yandex-import?url=${encodeURIComponent(url)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success || !Array.isArray(data.tracks) || data.tracks.length === 0) {
        dismissImportSpinnerToast();
        const errInfo = classifyImportError('link', res.status, data);
        showToast(errInfo.userMessage || 'Failed to import playlist', 'error');
        return;
      }

      const tracks = data.tracks;
      const total = tracks.length;

      const foundTracks = await matchSpotifyTracks(tracks, data.name || 'Yandex Music Playlist', null, { playlistCover: '' });

      const targetSel = document.getElementById('link-import-target');
      const targetPlId = targetSel ? targetSel.value : '__new__';
      if (targetPlId === '__favorites__') {
        const existingMap = new Set(state.favorites.map(f => getTrackCanonicalId(f) || f.id));
        const newFavs = foundTracks.filter(t => !existingMap.has(getTrackCanonicalId(t) || t.id));
        state.favorites.push(...newFavs.map(stampAddedAt));
        localStorage.setItem('devsize_favorites', JSON.stringify(state.favorites.map(sanitizeTrackForStorage)));
        if (typeof updateFavoritesBadge === 'function') updateFavoritesBadge();
        if (typeof updateFavoriteIcon === 'function') updateFavoriteIcon();
        if (state.currentView === 'favorites' && typeof renderFavoritesView === 'function') renderFavoritesView();
        hydrateMissingPlaylistCovers(state.favorites);
      } else if (targetPlId !== '__new__' && targetPlId !== 'new') {
        const targetPl = state.playlists.find(p => p.id === targetPlId);
        if (targetPl) {
          if (!targetPl.cover && data.cover) targetPl.cover = data.cover;
          const existingIds = new Set(targetPl.tracks.map(t => t.id));
          const newTracks = foundTracks.filter(t => !existingIds.has(t.id));
          targetPl.tracks.push(...newTracks.map(stampAddedAt));
          localStorage.setItem('devsize_playlists', JSON.stringify(state.playlists));
          renderPlaylistsList();
          if (state.currentView === 'playlist-detail' && state.currentPlaylistId === targetPlId) {
            openPlaylistDetail(targetPlId);
          }
          hydrateMissingPlaylistCovers(targetPl);
        } else {
          createPlaylist(data.name || 'Yandex Music Playlist', foundTracks, data.cover || '');
        }
      } else {
        createPlaylist(data.name || 'Yandex Music Playlist', foundTracks, data.cover || '');
      }
    } catch (err) {
      dismissImportSpinnerToast();
      const errInfo = classifyImportError('link', err, err.message);
      showToast(errInfo.userMessage || 'Failed to import playlist', 'error');
    } finally {
      if (hasBusy && typeof endBusy === 'function') {
        endBusy('import');
      }
    }
    return;
  }

  if (url.includes('soundcloud.com')) setPlatform('soundcloud', false);
  else if (url.includes('music.youtube.com')) setPlatform('ytmusic', false);
  else if (url.includes('youtube.com') || url.includes('youtu.be')) setPlatform('youtube', false);

  const hasBusy = typeof beginBusy === 'function';
  if (hasBusy) beginBusy('import');
  try {
    const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/playlist-import?url=${encodeURIComponent(url)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data || !data.success || !Array.isArray(data.tracks) || data.tracks.length === 0) {
      dismissImportSpinnerToast();
      const errInfo = classifyImportError('link', res.status, data);
      showToast(errInfo.userMessage || 'Failed to import playlist', 'error');
      return;
    }

    const targetSel = document.getElementById('link-import-target');
    const targetPlId = targetSel ? targetSel.value : '__new__';
    const foundTracks = await matchSpotifyTracks(data.tracks || [], data.name || 'Playlist', null, { playlistCover: '' });
    if (targetPlId === '__favorites__') {
      const existingMap = new Set(state.favorites.map(f => getTrackCanonicalId(f) || f.id));
      const newFavs = foundTracks.filter(t => !existingMap.has(getTrackCanonicalId(t) || t.id));
      state.favorites.push(...newFavs.map(stampAddedAt));
      localStorage.setItem('devsize_favorites', JSON.stringify(state.favorites.map(sanitizeTrackForStorage)));
      if (typeof updateFavoritesBadge === 'function') updateFavoritesBadge();
      if (typeof updateFavoriteIcon === 'function') updateFavoriteIcon();
      if (state.currentView === 'favorites' && typeof renderFavoritesView === 'function') renderFavoritesView();
      hydrateMissingPlaylistCovers(state.favorites);
    } else if (targetPlId !== '__new__' && targetPlId !== 'new') {
      const targetPl = state.playlists.find(p => p.id === targetPlId);
      if (targetPl) {
        if (!targetPl.cover && data.cover) targetPl.cover = data.cover;
        const existingIds = new Set(targetPl.tracks.map(t => t.id));
        const newTracks = foundTracks.filter(t => !existingIds.has(t.id));
        targetPl.tracks.push(...newTracks.map(stampAddedAt));
        localStorage.setItem('devsize_playlists', JSON.stringify(state.playlists));
        renderPlaylistsList();
        if (state.currentView === 'playlist-detail' && state.currentPlaylistId === targetPlId) {
          openPlaylistDetail(targetPlId);
        }
        hydrateMissingPlaylistCovers(targetPl);
      } else {
        createPlaylist(data.name || 'Playlist', foundTracks, data.cover || '');
      }
    } else {
      createPlaylist(data.name || 'Playlist', foundTracks, data.cover || '');
    }
  } catch (err) {
    dismissImportSpinnerToast();
    const errInfo = classifyImportError('link', err, err.message);
    showToast(errInfo.userMessage || 'Failed to import playlist', 'error');
  } finally {
    if (hasBusy && typeof endBusy === 'function') {
      endBusy('import');
    }
  }
}

async function handleGoogleLoginImport() {
  clearImportError(linkImportError);
  const doLikes = !!(googleChkLikes && googleChkLikes.checked);
  const doPlaylists = !!(googleChkPlaylists && googleChkPlaylists.checked);

  if (!doLikes && !doPlaylists) {
    if (linkImportStatus) {
      linkImportStatus.textContent = 'Select at least Liked songs or Playlists';
      linkImportStatus.style.color = 'var(--md-sys-color-error, #ba1a1a)';
      linkImportStatus.classList.remove('hidden');
    }
    return;
  }

  closeLinkImportModal();
  showImportSpinnerToast('Fetching Google library...');

  const hasBusy = typeof beginBusy === 'function';
  if (hasBusy) beginBusy('import');

  try {
    const res = await window.electronAPI.googleImportLibrary({
      platform: currentLinkImportPlatform,
      doLikes,
      doPlaylists
    });

    if (!res || !res.success) {
      dismissImportSpinnerToast();
      const errInfo = classifyImportError(currentLinkImportPlatform, 403, res || {});
      showToast(errInfo.userMessage || errInfo.title || 'Failed to import Google library', 'error');
      return;
    }

    const likes = res.likes || [];
    const playlists = res.playlists || [];
    const rawAlbums = res.albums || [];
    const totalTracks = likes.length + playlists.reduce((acc, p) => acc + (p.tracks ? p.tracks.length : 0), 0);

    if (totalTracks === 0 && rawAlbums.length === 0) {
      dismissImportSpinnerToast();
      showToast('Không tìm thấy bài hát hay album nào để nhập', 'warning');
      return;
    }

    showImportSpinnerToast(`Importing Google library... (0/${totalTracks})`);

    const targetSel = document.getElementById('google-import-target');
    const targetPlId = targetSel ? targetSel.value : 'new';

    let importedCount = 0;
    const updateProgress = (count) => {
      if (activeImportToast) {
        const textSpan = activeImportToast.querySelector('.toast-text');
        if (textSpan) textSpan.textContent = `Importing Google library... (${count}/${totalTracks})`;
      }
    };

    if (likes.length > 0) {
      let addedFav = false;
      for (const track of likes) {
        if (!state.favorites.some(f => isSameTrack(f, track))) {
          state.favorites.push(stampAddedAt(track));
          addedFav = true;
        }
        importedCount++;
        updateProgress(importedCount);
      }
      if (addedFav) {
        localStorage.setItem('devsize_favorites', JSON.stringify(state.favorites.map(sanitizeTrackForStorage)));
        updateFavoritesBadge();
        updateFavoriteIcon();
        if (state.currentView === 'favorites') renderFavoritesView();
      }
      hydrateMissingPlaylistCovers(state.favorites);
    }

    if (playlists.length > 0) {
      const syncEngine = window.EclipseAlbumSyncEngine || null;
      const normPlId = (raw) => (syncEngine && typeof syncEngine.normalizeUpstreamId === 'function')
        ? syncEngine.normalizeUpstreamId(raw)
        : String(raw || '').trim().replace(/^VL(?=(?:PL|LM|OLAK|RDCLAK|UU|FL))/i, '');
      for (const pl of playlists) {
        const rawPlTracks = pl.tracks || [];
        const plTracks = (syncEngine && typeof syncEngine.deduplicateTracks === 'function')
          ? syncEngine.deduplicateTracks(rawPlTracks)
          : rawPlTracks;
        if (targetPlId !== 'new') {
          const targetPl = state.playlists.find(p => p.id === targetPlId);
          if (targetPl) {
            const existingKeys = new Set((targetPl.tracks || []).map(t => syncEngine ? syncEngine.getTrackDedupKey(t) : (t.id || t.url || t.title)));
            for (const t of plTracks) {
              const k = syncEngine ? syncEngine.getTrackDedupKey(t) : (t.id || t.url || t.title);
              if (k && existingKeys.has(k)) continue;
              if (k) existingKeys.add(k);
              targetPl.tracks.push(stampAddedAt(t));
              importedCount++;
              updateProgress(importedCount);
            }
            localStorage.setItem('devsize_playlists', JSON.stringify(state.playlists));
            renderPlaylistsList();
            if (state.currentView === 'playlist-detail' && state.currentPlaylistId === targetPlId) {
              openPlaylistDetail(targetPlId);
            }
            hydrateMissingPlaylistCovers(targetPl);
          }
        } else {
          const plYtId = normPlId(pl.id);
          const normName = (pl.name || '').trim().toLowerCase();
          const accId = (res && res.accountId) ? String(res.accountId) : activeYtmAccountId;
          const existingPl = state.playlists.find(p => {
            const pAcc = p.accountId || 'default';
            const accMatch = pAcc === accId || pAcc === 'default';
            const pYtId = normPlId(p.ytId);
            if (plYtId && pYtId && pYtId === plYtId && accMatch) return true;
            if ((!plYtId || !pYtId) && accMatch && normName && (p.name || '').trim().toLowerCase() === normName) return true;
            return false;
          });
          if (existingPl) {
            if (plYtId) existingPl.ytId = plYtId;
            existingPl.accountId = accId;
            if (pl.cover && !existingPl.cover) existingPl.cover = pl.cover;
            if (syncEngine && typeof syncEngine.reconcilePlaylistTracks === 'function') {
              const rec = syncEngine.reconcilePlaylistTracks(
                existingPl.tracks || [],
                plTracks.map(t => stampAddedAt(t)),
                pl.fetchMeta || { complete: true, failed: false }
              );
              existingPl.tracks = rec.tracks;
              importedCount += rec.added;
            } else {
              const existingIds = new Set((existingPl.tracks || []).map(t => t.id || t.url || t.title));
              let addedToExisting = 0;
              for (const t of plTracks) {
                const key = t.id || t.url || t.title;
                if (!existingIds.has(key)) {
                  existingPl.tracks.push(stampAddedAt(t));
                  existingIds.add(key);
                  addedToExisting++;
                }
              }
              importedCount += addedToExisting;
            }
            updateProgress(importedCount);
            localStorage.setItem('devsize_playlists', JSON.stringify(state.playlists));
            renderPlaylistsList();
          } else {
            const created = createPlaylist(pl.name, plTracks, pl.cover || '');
            if (created) {
              if (plYtId) created.ytId = plYtId;
              created.accountId = accId;
              localStorage.setItem('devsize_playlists', JSON.stringify(state.playlists));
            }
            importedCount += plTracks.length;
            updateProgress(importedCount);
          }
        }
      }
    }

    // Save imported YouTube Music albums & playlists to Saved Albums (eclipse_saved_albums)
    try {
      const syncEngine = window.EclipseAlbumSyncEngine;
      const accId = (res && res.accountId) ? String(res.accountId) : activeYtmAccountId;
      if (res && res.accountId && activeYtmAccountId === 'default') {
        activeYtmAccountId = String(res.accountId);
      }
      const currentSaved = getSavedAlbums();
      const incomingEntities = [];
      for (const alb of rawAlbums) {
        incomingEntities.push({
          id: alb.id,
          title: alb.title,
          artist: alb.artist || '',
          cover: alb.cover || '',
          year: alb.year || '',
          type: 'Album',
          platform: 'ytmusic',
          accountId: accId,
          addedAt: Date.now()
        });
      }
      for (const pl of playlists) {
        incomingEntities.push({
          id: pl.id,
          title: pl.name,
          artist: 'YouTube Music Playlist',
          cover: pl.cover || '',
          type: 'Playlist',
          platform: 'ytmusic',
          accountId: accId,
          tracks: Array.isArray(pl.tracks) ? pl.tracks : [],
          fetchMeta: pl.fetchMeta || { complete: true, failed: false },
          addedAt: Date.now()
        });
      }
      if (syncEngine && typeof syncEngine.mergeSavedAlbumEntities === 'function') {
        const merged = syncEngine.mergeSavedAlbumEntities(currentSaved, incomingEntities, accId);
        if (merged.added > 0 || merged.updated > 0) {
          setSavedAlbums(merged.list);
          if (state.currentView === 'albums') renderSavedAlbums();
          updateAlbumsCount();
        }
      }
      if (typeof deduplicateLibraryData === 'function') deduplicateLibraryData({ silent: true });
    } catch (errSaveAlbums) {
      console.warn('[handleGoogleLoginImport] failed saving albums:', errSaveAlbums);
    }

    const finishMsg = `Imported ${totalTracks} tracks`;
    if (activeImportToast) {
      const toast = activeImportToast;
      const iconSpan = toast.querySelector('.toast-icon');
      const textSpan = toast.querySelector('.toast-text');
      const checkmarkSvg = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><polyline points="5 12.5 10 17.5 19 7.5"/></svg>';
      toast.className = 'eclipse-toast success wide';
      if (iconSpan) iconSpan.innerHTML = checkmarkSvg;
      if (textSpan) textSpan.textContent = finishMsg;
      activeImportToast = null;
      setTimeout(() => {
        toast.classList.add('leaving');
        setTimeout(() => { if (toast.parentNode) toast.remove(); }, 4000);
      }, 4000);
    } else {
      showToast(finishMsg, 'success');
    }
  } catch (err) {
    dismissImportSpinnerToast();
    const errInfo = classifyImportError(currentLinkImportPlatform, err, err.message);
    showToast(errInfo.userMessage || errInfo.title || 'Failed to import Google library', 'error');
  } finally {
    if (hasBusy && typeof endBusy === 'function') endBusy('import');
  }
}

function formatTrackForExport(t) {
  if (!t) return null;
  const isLocal = t.platform === 'local' || t.source === 'local' || (typeof t.id === 'string' && t.id.startsWith('local_')) || (typeof t.url === 'string' && t.url.startsWith('file:'));
  function toBasename(val) {
    if (!val || typeof val !== 'string') return '';
    const clean = val.replace(/^file:\/\//i, '').replace(/\\/g, '/');
    const parts = clean.split('/').filter(Boolean);
    return parts.length ? parts[parts.length - 1] : val;
  }
  const id = isLocal ? toBasename(t.id) : String(t.id || '');
  const url = isLocal ? toBasename(t.url) : String(t.url || '');
  let cover = String(t.cover || t.thumbnail || t.image || t.artworkUrl || '');
  if (cover.startsWith('file:') || cover.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(cover)) {
    cover = toBasename(cover);
  }
  return {
    title: t.title || '',
    artist: t.artist || '',
    album: t.album || '',
    duration: (typeof t.duration === 'number' && Number.isFinite(t.duration))
      ? t.duration
      : (t.duration ? Number(t.duration) : (t.durationMs ? Math.round(t.durationMs / 1000) : null)),
    source: t.source || t.platform || (isLocal ? 'local' : 'unknown'),
    id,
    url,
    cover
  };
}

async function exportPlaylistsAsJson(playlistsList, defaultFilename = 'playlists.json') {
  const list = Array.isArray(playlistsList) ? playlistsList : [playlistsList];
  const valid = list.filter(Boolean);
  if (!valid.length) {
    if (typeof showToast === 'function') showToast('No playlists to export', 'error');
    return;
  }
  let appVer = '43.1.0';
  try {
    if (window.electronAPI && window.electronAPI.getAppVersion) {
      const v = await window.electronAPI.getAppVersion();
      if (v) appVer = v;
    }
  } catch (e) {}

  const payload = {
    app: 'Eclipse',
    appVersion: appVer,
    exportedAt: new Date().toISOString(),
    playlists: valid.map(pl => ({
      name: pl.name || 'untitled',
      description: pl.description || '',
      tracks: Array.isArray(pl.tracks) ? pl.tracks.map(formatTrackForExport).filter(Boolean) : []
    }))
  };

  if (window.electronAPI && window.electronAPI.savePlaylistsJson) {
    const res = await window.electronAPI.savePlaylistsJson({
      content: JSON.stringify(payload, null, 2),
      defaultName: defaultFilename
    });
    if (res && res.success) {
      const count = valid.length;
      if (typeof showToast === 'function') {
        showToast(`Exported ${count} playlist${count === 1 ? '' : 's'}`, 'success');
      }
    }
  }
}

async function exportSinglePlaylist(playlistId) {
  const pl = state.playlists.find(p => p.id === playlistId);
  if (!pl) return;
  const safeName = (pl.name || 'playlist').replace(/[/\\?%*:|"<>]/g, '_');
  await exportPlaylistsAsJson([pl], `${safeName}.json`);
}

async function exportAllPlaylists() {
  await exportPlaylistsAsJson(state.playlists, 'eclipse-playlists.json');
}

const btnExportPl = document.getElementById('btn-export-playlist');
if (btnExportPl) {
  btnExportPl.addEventListener('click', () => {
    if (state.currentPlaylistId) {
      exportSinglePlaylist(state.currentPlaylistId);
    }
  });
}

const btnExportAllPl = document.getElementById('btn-export-all-playlists');
if (btnExportAllPl) {
  btnExportAllPl.addEventListener('click', () => {
    exportAllPlaylists();
  });
}

function parseJsonPlaylists(text) {
  if (!text || typeof text !== 'string') return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return [];
  }
  const result = [];
  if (!parsed) return result;

  let rawList = [];
  if (Array.isArray(parsed)) {
    if (parsed.length > 0 && (parsed[0].tracks || parsed[0].name)) {
      rawList = parsed;
    } else if (parsed.length > 0 && (parsed[0].title || parsed[0].id)) {
      rawList = [{ name: 'Imported Playlist', tracks: parsed }];
    }
  } else if (typeof parsed === 'object') {
    if (Array.isArray(parsed.playlists)) {
      rawList = parsed.playlists;
    } else if (Array.isArray(parsed.tracks)) {
      rawList = [{ name: parsed.name || 'Imported Playlist', tracks: parsed.tracks, cover: parsed.cover || '' }];
    } else if (parsed.name) {
      rawList = [parsed];
    }
  }

  for (const item of rawList) {
    if (!item || typeof item !== 'object') continue;
    const name = (item.name || item.title || 'Imported Playlist').trim();
    const rawTracks = Array.isArray(item.tracks) ? item.tracks : [];
    const tracks = rawTracks.map(t => {
      if (!t || typeof t !== 'object') return null;
      return {
        id: t.id || ('track_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
        title: t.title || '',
        artist: t.artist || '',
        album: t.album || '',
        duration: Number(t.duration) || 0,
        url: t.url || '',
        cover: t.cover || t.thumbnail || '',
        source: t.source || t.platform || 'youtube'
      };
    }).filter(Boolean);
    const cover = item.cover || '';
    result.push({ name, tracks, cover });
  }

  return result;
}

function triggerJsonPlaylistImport() {
  const input = document.getElementById('json-playlist-file-input');
  if (!input) return;
  input.value = '';
  input.click();
}

const jsonFileInput = document.getElementById('json-playlist-file-input');
if (jsonFileInput) {
  jsonFileInput.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    let totalCreated = 0;
    let totalTracks = 0;
    for (const file of files) {
      try {
        const text = file.text ? await file.text() : await new Promise(res => {
          const fr = new FileReader();
          fr.onload = () => res(fr.result);
          fr.readAsText(file);
        });
        const playlists = parseJsonPlaylists(text);
        for (const pl of playlists) {
          createPlaylist(pl.name, pl.tracks, pl.cover);
          totalCreated++;
          totalTracks += pl.tracks.length;
        }
      } catch (err) {
        console.error('Error importing JSON playlist:', err);
      }
    }
    if (totalCreated > 0) {
      if (typeof showToast === 'function') {
        if (playlists && playlists.length > 0 && typeof getSavedAlbums === 'function' && typeof setSavedAlbums === 'function') {
          const existingAlbums = getSavedAlbums();
          let addedAlb = false;
          for (const pl of playlists) {
            const albId = pl.id || pl.browseId || ('yt_' + (pl.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '_'));
            if (!existingAlbums.some(a => a.id === albId || a.title === pl.title)) {
              existingAlbums.push({
                id: albId,
                title: pl.title || 'YouTube Playlist',
                artist: (pl.tracks && pl.tracks[0] && pl.tracks[0].artist) || 'YouTube Music',
                cover: pl.cover || (pl.tracks && pl.tracks[0] && pl.tracks[0].cover) || '',
                type: 'YouTube Playlist',
                tracks: (pl.tracks || []).map(t => ({ ...t }))
              });
              addedAlb = true;
            }
          }
          if (addedAlb) {
            setSavedAlbums(existingAlbums);
            if (typeof renderSavedAlbums === 'function') renderSavedAlbums();
          }
        }
        showToast(`Imported ${totalCreated} playlist${totalCreated === 1 ? '' : 's'} (${totalTracks} tracks)`, 'success');
      }
      document.getElementById('create-playlist-modal')?.classList.add('hidden');
    } else {
      if (typeof showToast === 'function') {
        showToast('No valid playlists found in file', 'error');
      }
    }
    jsonFileInput.value = '';
  });
}

const btnOpenJsonImport = document.getElementById('btn-open-json-import');
if (btnOpenJsonImport) {
  btnOpenJsonImport.addEventListener('click', triggerJsonPlaylistImport);
}

const btnCpmJson = document.getElementById('btn-cpm-json');
if (btnCpmJson) {
  btnCpmJson.addEventListener('click', () => {
    document.getElementById('create-playlist-modal')?.classList.add('hidden');
    triggerJsonPlaylistImport();
  });
}

const btnImportJsonPlaylists = document.getElementById('btn-import-json-playlists');
if (btnImportJsonPlaylists) {
  btnImportJsonPlaylists.addEventListener('click', triggerJsonPlaylistImport);
}

function confirmChain({ title = 'Import Eclipse account', message = 'Importing an account will replace your existing playlists, favorites, custom styles, and settings. Eclipse will restart immediately.', confirmLabel = 'Import & Restart', seconds = 3 } = {}) {
  return new Promise((resolve) => {
    let modal = document.getElementById('confirm-chain-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'confirm-chain-modal';
      modal.className = 'modal-backdrop hidden';
      document.body.appendChild(modal);
    }
    let count = seconds;
    modal.innerHTML = `
      <div class="dialog-card" style="max-width: 420px;">
        <h3 style="margin-top: 0;">${escapeHtml(title)}</h3>
        <p style="margin: 8px 0 18px; color: var(--md-sys-color-on-surface-variant); font-size: calc(13px * var(--font-scale, 1)); line-height: 1.45;">${escapeHtml(message)}</p>
        <div class="dialog-actions" style="display: flex; justify-content: flex-end; gap: 10px;">
          <button type="button" class="btn-outline-pill" id="btn-confirm-chain-cancel">Cancel</button>
          <button type="button" class="btn-pill-primary" id="btn-confirm-chain-action" disabled style="opacity: 0.55; cursor: not-allowed;">${escapeHtml(confirmLabel)} (${count})</button>
        </div>
      </div>
    `;
    openModal(modal);

    const btnCancel = modal.querySelector('#btn-confirm-chain-cancel');
    const btnAction = modal.querySelector('#btn-confirm-chain-action');
    let timer = null;

    const cleanup = () => {
      if (timer) clearInterval(timer);
      closeModal(modal);
    };

    btnCancel.onclick = () => {
      cleanup();
      resolve(false);
    };

    timer = setInterval(() => {
      count--;
      if (count > 0) {
        btnAction.textContent = `${confirmLabel} (${count})`;
      } else {
        clearInterval(timer);
        timer = null;
        btnAction.disabled = false;
        btnAction.style.opacity = '1';
        btnAction.style.cursor = 'pointer';
        btnAction.textContent = confirmLabel;
      }
    }, 1000);

    btnAction.onclick = () => {
      if (btnAction.disabled) return;
      cleanup();
      resolve(true);
    };
  });
}
window.confirmChain = confirmChain;

const btnExportAccount = document.getElementById('btn-export-account');
if (btnExportAccount) {
  btnExportAccount.addEventListener('click', async () => {
    const dump = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k) dump[k] = localStorage.getItem(k);
      }
    } catch (_) {}
    const payload = {
      app: 'Eclipse',
      version: '1.0',
      exportedAt: Date.now(),
      localStorage: dump
    };
    if (window.electronAPI && window.electronAPI.accountExport) {
      const res = await window.electronAPI.accountExport(payload);
      if (res && res.success) {
        showToast('Account exported successfully', 'success');
      } else if (res && !res.canceled) {
        showToast(res.error || 'Account export failed', 'error');
      }
    }
  });
}

const btnImportAccount = document.getElementById('btn-import-account');
if (btnImportAccount) {
  btnImportAccount.onclick = async () => {
    const confirmed = await confirmChain({
      title: 'Import Eclipse account',
      message: 'Importing an account will replace your existing playlists, favorites, custom styles, and settings. Eclipse will restart immediately.',
      confirmLabel: 'Import & Restart',
      seconds: 3
    });
    if (!confirmed) return;

    if (!window.electronAPI || !window.electronAPI.accountImport) return;
    const res = await window.electronAPI.accountImport();
    if (res && res.canceled) return;
    if (!res || !res.success || !res.data) {
      showToast((res && res.error) || 'Failed to read account file', 'error');
      return;
    }
    const data = res.data;
    const store = data.localStorage || data;
    if (typeof store === 'object' && store !== null) {
      try { localStorage.clear(); } catch (_) {}
      for (const [key, val] of Object.entries(store)) {
        if (val !== undefined && val !== null) {
          try {
            localStorage.setItem(key, typeof val === 'string' ? val : JSON.stringify(val));
          } catch (_) {}
        }
      }
      if (window.electronAPI.storageSaveSync && window.__RIFF_STORAGE_MAP__) {
        try { window.electronAPI.storageSaveSync(window.__RIFF_STORAGE_MAP__); } catch (_) {}
      }
    }
    showToast('Account imported! Restarting...', 'success');
    setTimeout(() => {
      if (window.electronAPI && window.electronAPI.restartApp) {
        window.electronAPI.restartApp();
      } else {
        window.location.reload();
      }
    }, 350);
  };
}

const linkImportBtns = document.querySelectorAll('.btn-open-link-import, #btn-open-link-import');
linkImportBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    document.getElementById('create-playlist-modal')?.classList.add('hidden');
    if (btn.dataset.platform) setPlatform(btn.dataset.platform, false);
    openLinkImportModal(btn.dataset.platform || '');
  });
});
if (btnCancelLinkImport) btnCancelLinkImport.addEventListener('click', closeLinkImportModal);
if (btnConfirmLinkImport) btnConfirmLinkImport.addEventListener('click', handleLinkImportAction);
if (linkImportUrl) {
  linkImportUrl.addEventListener('input', () => clearImportError(linkImportError));
  linkImportUrl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleLinkImportAction();
    }
  });
}
