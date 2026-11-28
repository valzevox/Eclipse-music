// JavaScript / top-moments.js / Browser & Node / Top Moment Seekbar Markers
// Part of Eclipse Music Player — MIT License

(function () {
  const STORAGE_KEY = 'eclipse_top_moments';
  const LEGACY_STORAGE_KEY = 'eclipse_top_moments_v1';
  let migrated = false;

  function migrateLegacy(store) {
    if (migrated || !store) return;
    migrated = true;
    try {
      const legacyRaw = store.getItem(LEGACY_STORAGE_KEY);
      if (!legacyRaw) return;
      const legacy = JSON.parse(legacyRaw);
      if (legacy && typeof legacy === 'object') {
        const currentRaw = store.getItem(STORAGE_KEY);
        const current = currentRaw ? JSON.parse(currentRaw) : {};
        const merged = (current && typeof current === 'object') ? { ...current } : {};
        for (const [k, v] of Object.entries(legacy)) {
          if (merged[k] === undefined) {
            merged[k] = v;
          } else if (typeof merged[k] === 'number' && Array.isArray(v)) {
            const pinSec = merged[k];
            const hasPin = v.some((m) => m && Math.abs(Number(m.timeSec) - pinSec) < 0.2);
            merged[k] = hasPin ? v : [{ id: `tm_pin_${Date.now()}`, timeSec: pinSec, label: 'Top Moment' }, ...v];
          }
        }
        store.setItem(STORAGE_KEY, JSON.stringify(merged));
      }
      store.removeItem(LEGACY_STORAGE_KEY);
    } catch (_) {}
  }

  function getTrackKey(track) {
    if (!track) return '';
    if (track.id) return String(track.id);
    return `${String(track.artist || '').toLowerCase().trim()}::${String(track.title || '').toLowerCase().trim()}`;
  }

  function readAll(storage) {
    const store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    if (!store) return {};
    migrateLegacy(store);
    try {
      const raw = store.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  function writeAll(data, storage) {
    const store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    if (!store) return;
    try {
      store.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (_) {}
  }

  function getMoments(track, storage) {
    const key = getTrackKey(track);
    if (!key) return [];
    const all = readAll(storage);
    const val = all[key];
    if (Array.isArray(val)) return val;
    if (typeof val === 'number' && Number.isFinite(val)) {
      return [{ id: 'tm_pin', timeSec: val, label: 'Top Moment' }];
    }
    return [];
  }

  function addMoment(track, { timeSec, label = 'Top Moment' } = {}, storage) {
    const key = getTrackKey(track);
    if (!key || !Number.isFinite(timeSec) || timeSec < 0) return null;
    const all = readAll(storage);
    const existing = all[key];
    const list = Array.isArray(existing)
      ? [...existing]
      : (typeof existing === 'number' && Number.isFinite(existing)
        ? [{ id: 'tm_pin', timeSec: existing, label: 'Top Moment' }]
        : []);
    const entry = {
      id: `tm_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      timeSec: Math.round(timeSec * 10) / 10,
      label: String(label || 'Top Moment').slice(0, 40)
    };
    list.push(entry);
    list.sort((a, b) => a.timeSec - b.timeSec);
    all[key] = list;
    writeAll(all, storage);
    return entry;
  }

  function removeMoment(track, momentId, storage) {
    const key = getTrackKey(track);
    if (!key || !momentId) return false;
    const all = readAll(storage);
    const list = Array.isArray(all[key]) ? all[key] : [];
    const next = list.filter((m) => m.id !== momentId);
    if (next.length === list.length) return false;
    all[key] = next;
    writeAll(all, storage);
    return true;
  }

  function renderMarkers(track, durationSec, containerEl, onSeek) {
    if (!containerEl || typeof document === 'undefined') return;
    containerEl.querySelectorAll('.eclipse-top-moment-pin').forEach((n) => n.remove());
    if (!Number.isFinite(durationSec) || durationSec <= 0) return;
    const moments = getMoments(track);
    for (const m of moments) {
      const pct = Math.max(0, Math.min(100, (m.timeSec / durationSec) * 100));
      const pin = document.createElement('button');
      pin.type = 'button';
      pin.className = 'eclipse-top-moment-pin';
      pin.title = `${m.label} (${Math.floor(m.timeSec / 60)}:${String(Math.floor(m.timeSec % 60)).padStart(2, '0')})`;
      pin.style.cssText = `position:absolute;left:${pct}%;top:-4px;width:8px;height:8px;border-radius:50%;background:#a855f7;border:1px solid #fff;transform:translateX(-50%);cursor:pointer;z-index:5;padding:0;`;
      pin.onclick = (e) => {
        e.stopPropagation();
        if (typeof onSeek === 'function') onSeek(m.timeSec);
      };
      containerEl.appendChild(pin);
    }
  }

  function promptAddMoment(track) {
    if (!track || typeof window === 'undefined') return;
    const audio = document.getElementById('native-audio') || document.querySelector('audio');
    const timeSec = audio ? audio.currentTime : 0;
    const entry = addMoment(track, { timeSec, label: 'Top Moment' });
    if (entry && typeof window.showToast === 'function') {
      window.showToast(`Marked Top Moment at ${Math.floor(timeSec)}s`, 'success');
    }
    const bar = document.getElementById('progress-bar') || document.querySelector('.progress-bar-container');
    if (bar && audio && Number.isFinite(audio.duration)) {
      renderMarkers(track, audio.duration, bar, (sec) => { audio.currentTime = sec; });
    }
  }

  const api = {
    STORAGE_KEY,
    getTrackKey,
    getMoments,
    addMoment,
    removeMoment,
    renderMarkers,
    promptAddMoment
  };

  if (typeof module !== 'undefined') {
    module.exports = api;
  } else {
    window.EclipseTopMoments = api;
  }
})();
