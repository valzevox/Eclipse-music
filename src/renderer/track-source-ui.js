// JavaScript / track-source-ui.js / Browser & Node / Audio Source Picker & Bulk Re-search
// Part of Eclipse Music Player — MIT License

(function () {
  function getApiConfig() {
    const port = (typeof window !== 'undefined' && window.state && window.state.serverPort) || 3000;
    const token = (typeof window !== 'undefined' && ((window.electronAPI && window.electronAPI.serverToken) || (window.state && window.state.serverToken))) || '';
    return {
      apiBase: `http://127.0.0.1:${port}`,
      token
    };
  }

  function authHeaders(token) {
    return token ? { 'X-Eclipse-Token': token } : {};
  }

  function isLocalTrack(track) {
    if (!track) return true;
    return Boolean(track.isLocal || track.platform === 'local' || track.path || track.filePath);
  }

  function pickBestCandidate(candidates, track) {
    if (!Array.isArray(candidates) || candidates.length === 0) return null;
    const targetTitle = String(track.title || '').toLowerCase().trim();
    const targetArtist = String(track.artist || '').toLowerCase().trim();
    let best = candidates[0];
    let bestScore = -1;
    for (const c of candidates) {
      const ct = String(c.title || '').toLowerCase();
      const ca = String(c.artist || '').toLowerCase();
      let score = 0;
      if (targetTitle && ct.includes(targetTitle)) score += 2;
      if (targetArtist && ca.includes(targetArtist)) score += 2;
      if (/\b(karaoke|cover|sped up|slowed)\b/i.test(ct) && !/\b(karaoke|cover|sped up|slowed)\b/i.test(targetTitle)) {
        score -= 2;
      }
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    return best;
  }

  async function bulkResearchPlaylistTracks(tracks, options = {}) {
    if (!Array.isArray(tracks) || tracks.length === 0) {
      return { total: 0, updated: 0, skipped: 0, failed: 0 };
    }
    const concurrency = Math.max(1, Math.min(5, Number(options.concurrency) || 3));
    const platform = options.platform || 'ytmusic';
    const fetchFn = options.fetchFn || (typeof fetch === 'function' ? fetch : null);
    if (!fetchFn) throw new Error('fetch is unavailable');

    const { apiBase, token } = options.apiBase ? { apiBase: options.apiBase, token: options.token || '' } : getApiConfig();
    const currentTrackId = options.currentTrackId || null;

    const targets = tracks.filter((t) => t && !isLocalTrack(t));
    const skipped = tracks.length - targets.length;
    let updated = 0;
    let failed = 0;
    let cursor = 0;

    async function worker() {
      while (cursor < targets.length) {
        const idx = cursor++;
        const track = targets[idx];
        const q = `${track.artist || ''} ${track.title || ''}`.trim();
        if (!q) {
          failed++;
          continue;
        }
        try {
          const searchUrl = `${apiBase}/api/search?q=${encodeURIComponent(q)}&platform=${encodeURIComponent(platform)}`;
          const resp = await fetchFn(searchUrl, { headers: authHeaders(token) });
          const data = await resp.json();
          const list = Array.isArray(data?.results) ? data.results : (Array.isArray(data) ? data : []);
          const best = pickBestCandidate(list, track);
          if (!best || !best.id) {
            failed++;
            continue;
          }

          // Preserve currently playing track identity if it matches
          const isCurrent = currentTrackId && (track.id === currentTrackId);
          if (!isCurrent) {
            track.id = best.id;
            track.platform = best.platform || platform;
            track.url = best.url || `https://www.youtube.com/watch?v=${best.id}`;
            if (best.thumbnail) track.thumbnail = best.thumbnail;
            delete track._preloadedStreamUrl;
            delete track._preloadedStreamQuality;
            delete track._preloadedStreamUrlExpires;
          }

          await fetchFn(`${apiBase}/api/track-source`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
            body: JSON.stringify({
              artist: track.artist || '',
              title: track.title || '',
              provider: best.platform || platform,
              sourceId: best.id,
              canonicalUrl: best.url || `https://www.youtube.com/watch?v=${best.id}`,
              sourceMeta: {
                title: best.title || track.title || '',
                artist: best.artist || track.artist || '',
                thumbnail: best.thumbnail || track.thumbnail || ''
              },
              selection: 'auto'
            })
          });
          updated++;
        } catch (_) {
          failed++;
        }
        if (typeof options.onProgress === 'function') {
          options.onProgress({ done: updated + failed, total: targets.length, updated, failed });
        }
      }
    }

    const workers = Array.from({ length: Math.min(concurrency, targets.length) }, () => worker());
    await Promise.all(workers);

    if (typeof options.onComplete === 'function') {
      options.onComplete({ total: targets.length, updated, skipped, failed });
    }
    return { total: targets.length, updated, skipped, failed };
  }

  async function openChangeAudioSourceModal(track) {
    if (!track || typeof document === 'undefined') return;
    const { apiBase, token } = getApiConfig();
    const q = `${track.artist || ''} ${track.title || ''}`.trim();

    let modal = document.getElementById('eclipse-track-source-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'eclipse-track-source-modal';
      modal.style.cssText = 'position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.6);backdrop-filter:blur(8px);';
      document.body.appendChild(modal);
    }

    const card = document.createElement('div');
    card.style.cssText = 'width:440px;max-width:92vw;max-height:75vh;overflow:auto;padding:18px;border-radius:18px;background:rgba(20,20,32,0.94);backdrop-filter:blur(20px);border:1px solid rgba(255,255,255,0.12);color:#fff;';
    card.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;"><strong style="font-size:15px;">Change Audio Source</strong><button id="ts-close-btn" style="background:none;border:none;color:#fff;font-size:20px;cursor:pointer;">×</button></div><div id="ts-list" style="font-size:13px;opacity:0.8;">Searching alternative sources...</div>';
    modal.innerHTML = '';
    modal.appendChild(card);
    modal.style.display = 'flex';

    card.querySelector('#ts-close-btn').onclick = () => { modal.style.display = 'none'; };

    try {
      const resp = await fetch(`${apiBase}/api/search?q=${encodeURIComponent(q)}&platform=${encodeURIComponent(track.platform || 'ytmusic')}`, {
        headers: authHeaders(token)
      });
      const data = await resp.json();
      const list = (Array.isArray(data?.results) ? data.results : (Array.isArray(data) ? data : [])).slice(0, 8);
      const listEl = card.querySelector('#ts-list');
      listEl.innerHTML = '';

      const resetBtn = document.createElement('button');
      resetBtn.textContent = 'Reset to Auto Source';
      resetBtn.style.cssText = 'width:100%;padding:8px 12px;margin-bottom:10px;border-radius:10px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.14);color:#fff;cursor:pointer;font-size:12px;';
      resetBtn.onclick = async () => {
        await fetch(`${apiBase}/api/track-source/reset`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
          body: JSON.stringify({ artist: track.artist || '', title: track.title || '' })
        });
        delete track._preloadedStreamUrl;
        delete track._preloadedStreamQuality;
        modal.style.display = 'none';
        if (typeof window.showToast === 'function') window.showToast('Audio source reset to auto', 'info');
      };
      listEl.appendChild(resetBtn);

      for (const cand of list) {
        const row = document.createElement('button');
        row.style.cssText = 'display:flex;flex-direction:column;align-items:flex-start;width:100%;text-align:left;padding:9px 11px;margin-bottom:6px;border-radius:10px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);color:#fff;cursor:pointer;';
        const t = document.createElement('span');
        t.style.cssText = 'font-size:13px;font-weight:600;';
        t.textContent = cand.title || cand.id;
        const sub = document.createElement('span');
        sub.style.cssText = 'font-size:11px;opacity:0.7;';
        sub.textContent = `${cand.artist || ''} • ${cand.platform || 'youtube'}`;
        row.appendChild(t);
        row.appendChild(sub);
        row.onclick = async () => {
          if (track.id && track.id !== cand.id) {
            await fetch(`${apiBase}/api/track-source/block`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
              body: JSON.stringify({ artist: track.artist || '', title: track.title || '', sourceId: track.id })
            }).catch(() => {});
          }
          await fetch(`${apiBase}/api/track-source`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
            body: JSON.stringify({
              artist: track.artist || '',
              title: track.title || '',
              provider: cand.platform || 'youtube',
              sourceId: cand.id,
              canonicalUrl: cand.url || `https://www.youtube.com/watch?v=${cand.id}`,
              sourceMeta: { title: cand.title || track.title, artist: cand.artist || track.artist, thumbnail: cand.thumbnail || '' },
              selection: 'manual'
            })
          });
          track.id = cand.id;
          track.platform = cand.platform || 'youtube';
          track.url = cand.url || `https://www.youtube.com/watch?v=${cand.id}`;
          delete track._preloadedStreamUrl;
          delete track._preloadedStreamQuality;
          delete track._preloadedStreamUrlExpires;
          modal.style.display = 'none';
          if (typeof window.showToast === 'function') window.showToast('Audio source updated', 'success');
          if (window.state && window.state.currentTrack && window.state.currentTrack.title === track.title && typeof window.playTrack === 'function') {
            const resumeAt = window.el?.nativeAudio?.currentTime || 0;
            window.playTrack(track, { resumeTime: resumeAt });
          }
        };
        listEl.appendChild(row);
      }
    } catch (err) {
      const listEl = card.querySelector('#ts-list');
      if (listEl) listEl.textContent = 'Failed to load alternative sources.';
    }
  }

  const api = {
    isLocalTrack,
    pickBestCandidate,
    bulkResearchPlaylistTracks,
    openChangeAudioSourceModal
  };

  if (typeof module !== 'undefined') {
    module.exports = api;
  } else {
    window.EclipseTrackSourceUI = api;
  }
})();
