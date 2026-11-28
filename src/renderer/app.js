try { Object.keys(localStorage).forEach(function(k) { if (k.indexOf('riff_') === 0) { var nk = 'eclipse_' + k.slice(5); if (localStorage.getItem(nk) === null) { localStorage.setItem(nk, localStorage.getItem(k)); } localStorage.removeItem(k); } }); } catch (_) {}
(function initEclipseDiskStorageDaemon() {
if (!window.electronAPI || typeof window.electronAPI.storageInitSync !== 'function') return;
const origGet = Storage.prototype.getItem;
const origSet = Storage.prototype.setItem;
const origRemove = Storage.prototype.removeItem;
const origClear = Storage.prototype.clear;
const origKey = Storage.prototype.key;

let diskMap = window.electronAPI.storageInitSync();
let migrated = false;

if (!diskMap || typeof diskMap !== 'object' || Object.keys(diskMap).length === 0) {
diskMap = {};
try {
const len = window.localStorage.length;
for (let i = 0; i < len; i++) {
const k = origKey.call(window.localStorage, i);
if (k) diskMap[k] = origGet.call(window.localStorage, k);
}
if (Object.keys(diskMap).length > 0) migrated = true;
} catch (_) {}
} else {
try {
const len = window.localStorage.length;
for (let i = 0; i < len; i++) {
const k = origKey.call(window.localStorage, i);
if (k && !Object.prototype.hasOwnProperty.call(diskMap, k)) {
diskMap[k] = origGet.call(window.localStorage, k);
migrated = true;
}
}
} catch (_) {}
}

try { origClear.call(window.localStorage); } catch (_) {}
window.__RIFF_STORAGE_MAP__ = diskMap;

try {
  for (const k of Object.keys(diskMap)) {
    if (k.indexOf('riff_') === 0) {
      const nk = 'eclipse_' + k.slice(5);
      if (!Object.prototype.hasOwnProperty.call(diskMap, nk)) {
        diskMap[nk] = diskMap[k];
        migrated = true;
      }
    }
  }
} catch (_) {}

if (migrated) {
window.electronAPI.storageSaveSync(diskMap);
}

function flushAsync(key, val) {
window.electronAPI.storageSaveBatch(diskMap);
if (window.electronAPI && window.electronAPI.libraryDb) {
  try {
    if (key === 'devsize_playlists' && typeof window.electronAPI.libraryDb.savePlaylists === 'function') {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) window.electronAPI.libraryDb.savePlaylists(parsed, 'default').catch(() => {});
    } else if (key === 'devsize_favorites' && typeof window.electronAPI.libraryDb.saveFavorites === 'function') {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) window.electronAPI.libraryDb.saveFavorites(parsed, 'default').catch(() => {});
    } else if (key === 'eclipse_saved_albums' && typeof window.electronAPI.libraryDb.saveAlbums === 'function') {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) window.electronAPI.libraryDb.saveAlbums(parsed, 'default').catch(() => {});
    }
  } catch (_) {}
}
}

Storage.prototype.getItem = function(key) {
if (this === window.localStorage) {
const k = String(key);
return Object.prototype.hasOwnProperty.call(diskMap, k) ? diskMap[k] : null;
}
return origGet.call(this, key);
};

Storage.prototype.setItem = function(key, val) {
if (this === window.localStorage) {
const k = String(key);
const v = String(val);
if (diskMap[k] === v) return;
diskMap[k] = v;
flushAsync(k, v);
return;
}
origSet.call(this, key, val);
};

Storage.prototype.removeItem = function(key) {
if (this === window.localStorage) {
const k = String(key);
if (Object.prototype.hasOwnProperty.call(diskMap, k)) {
delete diskMap[k];
flushAsync();
}
return;
}
origRemove.call(this, key);
};

Storage.prototype.clear = function() {
if (this === window.localStorage) {
diskMap = {};
window.__RIFF_STORAGE_MAP__ = diskMap;
flushAsync();
return;
}
origClear.call(this);
};

Storage.prototype.key = function(index) {
if (this === window.localStorage) {
const keys = Object.keys(diskMap);
return keys[index] !== undefined ? keys[index] : null;
}
return origKey.call(this, index);
};

try {
Object.defineProperty(Storage.prototype, 'length', {
configurable: true,
get: function() {
if (this === window.localStorage) return Object.keys(diskMap).length;
return 0;
}
});
} catch (_) {}

window.addEventListener('beforeunload', () => {
try { window.electronAPI.storageSaveSync(diskMap); } catch (_) {}
});
})();

(() => {
  try {
    if (typeof window === 'undefined' || window.__eclipseFetchPatched) return;
    const origFetch = window.fetch ? window.fetch.bind(window) : null;
    if (!origFetch) return;
    window.__eclipseFetchPatched = true;
    window.fetch = function (input, init) {
      try {
        const raw = typeof input === 'string' ? input : (input && input.url) || '';
        if (raw.indexOf('/api/') !== -1) {
          const activeToken = (window.electronAPI && window.electronAPI.serverToken) || (typeof state !== 'undefined' && state && state.serverToken) || '';
          const opts = Object.assign({}, init || {});
          const headers = new Headers(opts.headers || (input && input.headers) || undefined);
          if (activeToken) {
            headers.set('X-Eclipse-Token', activeToken);
          }
          opts.headers = headers;
          return origFetch(input, opts);
        }
      } catch (e) {}
      return origFetch(input, init);
    };
  } catch (e) {}
})();

(() => {
  let lastErrLogReset = Date.now();
  let errLogCount = 0;
  function reportError(level, message, stack) {
    if (!window.electronAPI || typeof window.electronAPI.logError !== 'function') return;
    const now = Date.now();
    if (now - lastErrLogReset > 60000) {
      lastErrLogReset = now;
      errLogCount = 0;
    }
    if (errLogCount < 20) {
      errLogCount++;
      window.electronAPI.logError(level, message, stack);
    }
  }
  window.__eclipseLogError = reportError;
  window.addEventListener('error', (e) => {
    reportError('ERROR', e.message || String(e), e.error ? e.error.stack : null);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason;
    const msg = (reason && reason.message) ? reason.message : String(reason);
    const stack = (reason && reason.stack) ? reason.stack : null;
    reportError('ERROR', msg, stack);
  });
})();

(function runEclipseSplash() {
  const splash = document.getElementById('splash');
  if (!splash) return;
  const perf = /^(1|true)$/.test(localStorage.getItem('eclipse_perf_mode') || '');
  const reduced = localStorage.getItem('eclipse_adv_reduce_motion') === 'true' || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  if (perf || reduced) { splash.remove(); return; }
  const finish = () => {
    if (!splash.isConnected || splash.classList.contains('hide')) return;
    splash.classList.add('hide');
    setTimeout(() => splash.remove(), 480);
  };
  setTimeout(finish, 1150);
})();

function stripYoutubeTopic(artist) {
  if (!artist || typeof artist !== 'string') return artist || '';
  return artist.endsWith(' - Topic') ? artist.slice(0, -8).trim() : artist;
}

document.addEventListener('DOMContentLoaded', async () => {
  try { localStorage.removeItem('eclipse_stats'); } catch (e) {}
  const detectNetworkProfile = () => {
    try {
      if (localStorage.getItem('eclipse_perf_mode') === '1') return 'constrained';
    } catch (_) {}
    const conn = (typeof navigator !== 'undefined' && navigator.connection) ? navigator.connection : null;
    if (!conn) return 'normal';
    if (conn.saveData === true) return 'constrained';
    const eff = String(conn.effectiveType || '').toLowerCase();
    if (eff === 'slow-2g' || eff === '2g' || eff === '3g') return 'constrained';
    if (Number.isFinite(conn.downlink) && conn.downlink > 0 && conn.downlink < 2.5) return 'constrained';
    if (Number.isFinite(conn.rtt) && conn.rtt >= 300) return 'constrained';
    if (Number.isFinite(conn.downlink) && conn.downlink >= 15 && (!Number.isFinite(conn.rtt) || conn.rtt < 100)) return 'fast';
    return 'normal';
  };
  const syncNetworkProfileToServer = () => {
    const port = (typeof state !== 'undefined' && state && state.serverPort) || (window.electronAPI && window.electronAPI.serverPort);
    if (!port) return;
    let autoCacheEnabled = true;
    try {
      if (localStorage.getItem('eclipse_auto_cache') === '0') autoCacheEnabled = false;
    } catch (_) {}
    const profile = detectNetworkProfile();
    fetch(`http://127.0.0.1:${port}/api/network-profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile, autoCacheEnabled })
    }).catch(() => {});
  };
  setTimeout(() => {
    syncNetworkProfileToServer();
    const port = (typeof state !== 'undefined' && state && state.serverPort) || (window.electronAPI && window.electronAPI.serverPort);
    if (port) {
      const startupMs = (typeof performance !== 'undefined' && performance.now) ? Math.round(performance.now()) : 0;
      fetch(`http://127.0.0.1:${port}/api/network-diagnostics`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ startupToUiMs: startupMs })
      }).catch(() => {});
    }
  }, 800);
  if (typeof navigator !== 'undefined' && navigator.connection && typeof navigator.connection.addEventListener === 'function') {
    navigator.connection.addEventListener('change', syncNetworkProfileToServer);
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('online', syncNetworkProfileToServer);
  }
  var lyricsScrollRaf = 0;
  var gradientRaf = 0;
  var cacheRafId = 0;
  var cacheModal = null;
  var syncState = { active: false, track: null, lines: [], currentIndex: 0 };
  var isDraggingTvkSeek = false;
  var m3c = { canvas: null, ctx: null, img: new Image(), imgReady: false, from: 0, to: 0, start: 0, raf: 0, last: 0, phase: 0, hoverProgress: 0, isHovered: false, rotation: 0, rotRate: 0.25, targetRate: 0.25 };

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  const LiquidMotion = {
    setAnchor(element, triggerEl, axis = 'x') {
      if (!element) return;
      if (triggerEl) {
        const rect = triggerEl.getBoundingClientRect();
        const parentRect = element.parentElement ? element.parentElement.getBoundingClientRect() : { top: 0, left: 0 };
        if (axis === 'x') {
          const anchorY = (rect.top + rect.height / 2) - parentRect.top;
          element.style.setProperty('--liquid-anchor-y', `${anchorY}px`);
          element.style.setProperty('--liquid-anchor-x', '0px');
          element.style.transformOrigin = `0px ${anchorY}px`;
        } else {
          const anchorX = (rect.left + rect.width / 2) - parentRect.left;
          element.style.setProperty('--liquid-anchor-x', `${anchorX}px`);
          element.style.setProperty('--liquid-anchor-y', '0px');
          element.style.transformOrigin = `${anchorX}px 0px`;
        }
      } else {
        if (axis === 'x') {
          element.style.setProperty('--liquid-anchor-y', '50%');
          element.style.setProperty('--liquid-anchor-x', '0px');
          element.style.transformOrigin = '0px 50%';
        } else {
          element.style.setProperty('--liquid-anchor-x', '50%');
          element.style.setProperty('--liquid-anchor-y', '0px');
          element.style.transformOrigin = '50% 0px';
        }
      }
    },
    open(element, triggerEl, axis = 'x', onDone) {
      if (!element) return;
      this.setAnchor(element, triggerEl, axis);
      element.classList.remove('liquid-closing');
      element.classList.add('liquid-surface', `liquid-${axis}`, 'liquid-open');
      if (onDone) setTimeout(onDone, 480);
    },
    close(element, onDone) {
      if (!element) return;
      element.classList.add('liquid-closing');
      element.classList.remove('liquid-open');
      setTimeout(() => {
        element.classList.remove('liquid-closing', 'liquid-open');
        if (onDone) onDone();
      }, 300);
    }
  };
  window.LiquidMotion = LiquidMotion;


  function injectM3Shapes() {
    const defs = document.getElementById('m3-dynamic-defs');
    if (!defs) return;

    const formulas = {
      'm3-cookie-4': (a) => 40 + 6 * Math.cos(4 * a),
                          'm3-diamond-puffy': (a) => 36 + 10 * Math.cos(4 * a),
                          'm3-flower': (a) => 28 + 18 * Math.abs(Math.cos(4 * a)),
                          'm3-poly-6': (a) => {
                            let t = a % (2 * Math.PI / 6);
                            if (t < 0) t += 2 * Math.PI / 6;
                            return 36 / Math.cos(t - Math.PI / 6);
                          },
                          'm3-leaf-4': (a) => 40 + 6 * Math.cos(4 * a)
    };

    let html = '';
    for (const [id, formula] of Object.entries(formulas)) {
      let path = '';
      const res = 120;
      for (let i = 0; i <= res; i++) {
        const angle = (i / res) * 2 * Math.PI;
        const r = formula(angle);
        const x = 0.5 + (r * Math.cos(angle)) / 100;
        const y = 0.5 + (r * Math.sin(angle)) / 100;
        path += `${i === 0 ? 'M' : 'L'} ${x.toFixed(4)},${y.toFixed(4)} `;
      }
      path += 'Z';
      html += `<clipPath id="${id}" clipPathUnits="objectBoundingBox"><path d="${path}" /></clipPath>`;
    }
    if (!defs.querySelector('#m3-hero-shape')) {
      html += '<clipPath id="m3-hero-shape" clipPathUnits="objectBoundingBox"><path id="m3-hero-shape-path" d=""/></clipPath>';
    }
    defs.insertAdjacentHTML('beforeend', html);
  }
  injectM3Shapes();

  const i18nSessionMap = new Map();

  function loadCachedI18nDict(lang) {
    if (!lang || lang === 'en') return null;
    if (i18nSessionMap.has(lang) && i18nSessionMap.get(lang).size > 0) {
      return i18nSessionMap.get(lang);
    }
    let dictObj = null;
    try {
      const raw = localStorage.getItem('eclipse_i18n_cache_' + lang) || localStorage.getItem('eclipse_i18n_cache_' + lang);
      if (raw) dictObj = JSON.parse(raw);
    } catch (_) {}

    if ((!dictObj || Object.keys(dictObj).length === 0) && window.electronAPI && typeof window.electronAPI.getI18nDictSync === 'function') {
      try {
        dictObj = window.electronAPI.getI18nDictSync(lang);
      } catch (_) {}
    }

    if (dictObj && typeof dictObj === 'object') {
      const map = new Map(Object.entries(dictObj));
      i18nSessionMap.set(lang, map);
      try {
        localStorage.setItem('eclipse_i18n_cache_' + lang, JSON.stringify(dictObj));
      } catch (_) {}
      return map;
    }
    return null;
  }

  function saveI18nCache(lang) {
    if (!lang || lang === 'en') return;
    const dict = i18nSessionMap.get(lang);
    if (!dict) return;
    const obj = {};
    for (const [k, v] of dict.entries()) {
      obj[k] = v;
    }
    try {
      localStorage.setItem('eclipse_i18n_cache_' + lang, JSON.stringify(obj));
    } catch (_) {}
  }

  const initialSavedLang = localStorage.getItem('eclipse_ui_lang') || localStorage.getItem('eclipse_ui_lang') || 'en';
  if (initialSavedLang !== 'en') {
    loadCachedI18nDict(initialSavedLang);
  }

  function t(str) {
    if (!str || typeof str !== 'string') return str;
    const lang = localStorage.getItem('eclipse_ui_lang') || localStorage.getItem('eclipse_ui_lang') || 'en';
    if (lang === 'en') return str;
    let dict = i18nSessionMap.get(lang);
    if (!dict || dict.size === 0) {
      dict = loadCachedI18nDict(lang);
    }
    if (dict && dict.has(str)) return dict.get(str);
    if (typeof state !== 'undefined' && state && state.serverPort) {
      const token = (window.electronAPI && window.electronAPI.serverToken) || (state && state.serverToken) || '';
      fetch(`http://127.0.0.1:${state.serverPort}/api/i18n-batch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Eclipse-Token': token
        },
        body: JSON.stringify({ target: lang, texts: [str] })
      }).then(r => r.json()).then(data => {
        if (data && data.success && data.translations && data.translations[0]) {
          if (!i18nSessionMap.has(lang)) i18nSessionMap.set(lang, new Map());
          i18nSessionMap.get(lang).set(str, data.translations[0]);
          saveI18nCache(lang);
        }
      }).catch(() => {});
    }
    return str;
  }
  window.t = t;

  function tSet(el, str) {
    if (!el) return;
    el.textContent = t(str);
    const lang = localStorage.getItem('eclipse_ui_lang') || localStorage.getItem('eclipse_ui_lang') || 'en';
    if (lang === 'en') return;
    const dict = i18nSessionMap.get(lang);
    if (dict && dict.has(str)) return;
    setTimeout(() => {
      const d = i18nSessionMap.get(lang);
      if (d && d.has(str) && el.isConnected) el.textContent = d.get(str);
    }, 1500);
  }

  const toastQueue = [];
  const MAX_QUEUED_TOASTS = 10;
  let isToastActive = false;

  function showToast(message, type = 'info', duration = null) {
    if (!message) return;
    message = t(message);
    if (toastQueue.length >= MAX_QUEUED_TOASTS) {
      toastQueue.shift();
    }
    toastQueue.push({ message, type, duration });
    if (!isToastActive) {
      processToastQueue();
    }
  }

  function processToastQueue() {
    if (toastQueue.length === 0) {
      isToastActive = false;
      return;
    }
    isToastActive = true;
    const container = document.getElementById('toast-container');
    if (!container) {
      toastQueue.length = 0;
      isToastActive = false;
      return;
    }
    const { message, type, duration } = toastQueue.shift();

    const toast = document.createElement('div');
    toast.className = `eclipse-toast ${type}${duration ? ' wide' : ''}`;

    let iconSvg = '';
    if (type === 'error') {
      iconSvg = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="14"/><line x1="12" y1="19" x2="12.01" y2="19"/></svg>';
    } else if (type === 'success') {
      iconSvg = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><polyline points="5 12.5 10 17.5 19 7.5"/></svg>';
    } else if (type === 'warning') {
      iconSvg = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
    } else {
      iconSvg = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>';
    }

    const cleanMessage = String(message).charAt(0).toUpperCase() + String(message).slice(1);

    toast.innerHTML = `
      ${iconSvg ? `<span class="toast-icon">${iconSvg}</span>` : ''}
      <span class="toast-text">${escapeHtml(cleanMessage)}</span>
    `;

    container.appendChild(toast);

    let dismissed = false;
    let timer = null;
    let remaining = duration || 3500;
    let startTimestamp = Date.now();

    const dismiss = () => {
      if (dismissed) return;
      dismissed = true;
      if (timer) clearTimeout(timer);
      toast.classList.add('leaving');
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        toast.remove();
        processToastQueue();
      };
      toast.addEventListener('animationend', finish, { once: true });
      setTimeout(finish, 320);
    };

    const startTimer = (dur) => {
      startTimestamp = Date.now();
      timer = setTimeout(dismiss, dur);
    };

    toast.addEventListener('mouseenter', () => {
      if (timer) clearTimeout(timer);
      remaining -= (Date.now() - startTimestamp);
      if (remaining < 500) remaining = 500;
    });

    toast.addEventListener('mouseleave', () => {
      if (!dismissed) {
        startTimer(remaining);
      }
    });

    toast.addEventListener('click', dismiss);

    startTimer(remaining);
  }

  if (localStorage.getItem('eclipse_scale_rebased_v2') !== '1') {
    localStorage.setItem('eclipse_scale_rebased_v2', '1');
    if (localStorage.getItem('devsize_ui_scale') === '90') {
      localStorage.removeItem('devsize_ui_scale');
    }
    if (localStorage.getItem('eclipse_font_scale') === '95') {
      localStorage.removeItem('eclipse_font_scale');
    }
  }

  const savedScale = parseFloat(localStorage.getItem('devsize_ui_scale') || '100');
  applyScale(savedScale);

  function applyScale(scalePercent) {
    const factor = (scalePercent / 100) * 0.90;
    document.documentElement.style.setProperty('--app-scale', factor.toString());
    if (window.electronAPI && window.electronAPI.setZoomFactor) {
      window.electronAPI.setZoomFactor(factor);
    } else {
      document.body.style.zoom = factor;
    }
  }

  window.addEventListener('scroll', () => {
    if (window.scrollY !== 0 || window.scrollX !== 0) {
      window.scrollTo(0, 0);
    }
  }, { passive: true });

  function openModal(elModal) {
    if (!elModal) return;
    if (elModal._closeTimer) { clearTimeout(elModal._closeTimer); elModal._closeTimer = null; }
    elModal.classList.remove('hidden');
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        elModal.classList.add('visible');
      });
    });
  }

  let closingSyncModal = false;
  function closeModal(elModal) {
    if (!elModal) return;
    if (elModal.id === 'tools-install-modal' && (!state || !state.toolsReady)) return;
    if (typeof el !== 'undefined' && el && elModal === el.syncModeOverlay) {
      if (!closingSyncModal && syncState && syncState.active) {
        closingSyncModal = true;
        try {
          closeSyncMode();
        } finally {
          closingSyncModal = false;
        }
      }
    }
    elModal.classList.remove('visible');
    if (elModal._closeTimer) clearTimeout(elModal._closeTimer);
    elModal._closeTimer = setTimeout(() => {
      elModal._closeTimer = null;
      elModal.classList.add('hidden');
    }, 200);
  }

  const defaultPresets = [
    { id: 'p_default', name: 'Default', settings: { speed: 1.0, speedPitch: 1.0, pitch: 0, reverb: 0, distortion: 0, volume: 1.0, echo: 0, eq: { low: 0, mid: 0, high: 0 }, eqBands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] } },
    { id: 'p_speedup', name: 'Speed up (orig pitch)', settings: { speed: 1.35, speedPitch: 1.0, pitch: 0, reverb: 0, distortion: 0, volume: 1.0, echo: 0, eq: { low: 0, mid: 0, high: 0 }, eqBands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] } },
    { id: 'p_speedup_pitch', name: 'Speed up', settings: { speed: 1.0, speedPitch: 1.30, pitch: 0, reverb: 0, distortion: 0, volume: 1.0, echo: 0, eq: { low: 0, mid: 0, high: 0 }, eqBands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] } },
    { id: 'p_slowed', name: 'Slowed + reverb', settings: { speed: 1.0, speedPitch: 0.82, pitch: 0, reverb: 65, distortion: 0, volume: 1.0, echo: 15, eq: { low: 0, mid: 0, high: 0 }, eqBands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] } },
    { id: 'p_nightcore', name: 'Nightcore', settings: { speed: 1.0, speedPitch: 1.25, pitch: 0, reverb: 20, distortion: 0, volume: 1.0, echo: 0, eq: { low: 0, mid: 0, high: 0 }, eqBands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] } },
    { id: 'p_distortion', name: 'Distortion', settings: { speed: 1.0, speedPitch: 1.0, pitch: 0, reverb: 0, distortion: 75, volume: 1.25, echo: 0, eq: { low: 0, mid: 0, high: 0 }, eqBands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] } }
  ];

  const defaultVfx = {
    ambientGlow: true,
    bassPulse: false,
    vinylSpin: false,
    soundwaveRings: false,
    borderGlow: false,
    particles: false,
    backdropBlur: false,
    crt: false,
    grain: false,
    lyricsSpotlight: false
  };

  function normalizePreset(p) {
    if (!p) return null;
    const s = p.settings || p.values || {};
    const eq = s.eq || {};
    return {
      id: p.id,
      name: p.name || 'preset',
      settings: {
        speed: typeof s.speed === 'number' ? s.speed : 1.0,
        speedPitch: typeof s.speedPitch === 'number' ? s.speedPitch : 1.0,
        pitch: typeof s.pitch === 'number' ? s.pitch : (typeof s.pitchSemitones === 'number' ? s.pitchSemitones : 0),
                          reverb: typeof s.reverb === 'number' ? s.reverb : 0,
                          distortion: typeof s.distortion === 'number' ? s.distortion : 0,
                          volume: typeof s.volume === 'number' ? s.volume : (typeof s.gain === 'number' ? s.gain : 1.0),
                          echo: typeof s.echo === 'number' ? s.echo : 0,
                          eq: {
                            low: typeof eq.low === 'number' ? eq.low : 0,
                            mid: typeof eq.mid === 'number' ? eq.mid : 0,
                            high: typeof eq.high === 'number' ? eq.high : 0
                          },
                          eqBands: Array.isArray(s.eqBands) && s.eqBands.length === 10 ? s.eqBands.map(v => typeof v === 'number' ? v : 0) : [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
      }
    };
  }

  function safeJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }

  function safeArray(key) {
    const value = safeJson(key, []);
    return Array.isArray(value) ? value : [];
  }

  const rawCustomPresets = safeArray('devsize_custom_presets');
  const normalizedCustomPresets = rawCustomPresets.map(normalizePreset).filter(Boolean);

  const savedVolumeRaw = parseFloat(localStorage.getItem('eclipse_volume'));
  const savedVolume = Number.isFinite(savedVolumeRaw) ? Math.max(0, Math.min(1, savedVolumeRaw)) : 0.85;

  const DEFAULT_AUDIO_SETTINGS = { speed: 1.0, speedPitch: 1.0, pitch: 0, reverb: 0, distortion: 0, volume: 1.0, echo: 0, eq: { low: 0, mid: 0, high: 0 }, eqBands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] };
  const DEFAULT_HQ_SETTINGS = { engine: 'hqmusic-3', preset: 'studio', vocal: 0, air: 0, bass: 0 };
  let soundPersistenceEnabled = localStorage.getItem('eclipse_persist_sound_settings') === '1';

  function loadSoundSettings() {
    if (!soundPersistenceEnabled) {
      return {
        audioSettings: { ...DEFAULT_AUDIO_SETTINGS, eq: { ...DEFAULT_AUDIO_SETTINGS.eq }, eqBands: [...DEFAULT_AUDIO_SETTINGS.eqBands] },
        hqEnabled: false,
        hqSettings: { ...DEFAULT_HQ_SETTINGS }
      };
    }
    const savedAudio = safeJson('eclipse_audio_settings', null);
    const savedHq = safeJson('eclipse_hq_settings', null);
    const audioObj = savedAudio && typeof savedAudio === 'object' ? savedAudio : {};
    const hqObj = savedHq && typeof savedHq === 'object' ? savedHq : {};
    return {
      audioSettings: {
        ...DEFAULT_AUDIO_SETTINGS,
        ...audioObj,
        eq: { ...DEFAULT_AUDIO_SETTINGS.eq, ...(audioObj.eq && typeof audioObj.eq === 'object' ? audioObj.eq : {}) },
        eqBands: Array.isArray(audioObj.eqBands) && audioObj.eqBands.length === 10 ? audioObj.eqBands.map(v => typeof v === 'number' ? v : 0) : [...DEFAULT_AUDIO_SETTINGS.eqBands]
      },
      hqEnabled: localStorage.getItem('eclipse_hq_enabled') === '1',
      hqSettings: { ...DEFAULT_HQ_SETTINGS, ...hqObj }
    };
  }

  const savedSound = loadSoundSettings();

  const SF_FONT_STACK = `-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Helvetica Neue", sans-serif`;

  function ensureSfFontLoaded() {
    if (!document.getElementById('font-sf-pro')) {
      const link = document.createElement('link');
      link.id = 'font-sf-pro';
      link.rel = 'stylesheet';
      link.href = 'https://fonts.cdnfonts.com/css/sf-pro-display';
      document.head.appendChild(link);
    }
  }

  function applyFont(font) {
    const f = (typeof font === 'string' && font) ? font : (localStorage.getItem('eclipse_font') || 'google');
    if (typeof state !== 'undefined' && state) {
      state.riffFont = f;
    }
    if (f === 'sf') {
      ensureSfFontLoaded();
      document.documentElement.style.setProperty('--font-family', SF_FONT_STACK);
    } else if (f === 'system') {
      document.documentElement.style.setProperty('--font-family', 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif');
    } else {
      document.documentElement.style.removeProperty('--font-family');
    }
    const fontOptGoogle = document.getElementById('font-opt-google');
    const fontOptSf = document.getElementById('font-opt-sf');
    const fontOptSystem = document.getElementById('font-opt-system');
    if (fontOptGoogle) fontOptGoogle.classList.toggle('active', f === 'google');
    if (fontOptSf) fontOptSf.classList.toggle('active', f === 'sf');
    if (fontOptSystem) fontOptSystem.classList.toggle('active', f === 'system');
  }

  const state = {
    selectedTracks: new Map(),
    lastClickedTrackRow: null,
    platform: localStorage.getItem('eclipse_platform') || 'ytmusic',
    currentView: 'discover',
    previousView: 'discover',
    currentPlaylistId: null,
    currentArtistData: null,
    searchQuery: '',
    searchResults: [],
    queue: [],
    queueIndex: -1,
    queueHistory: [],
    currentTrack: null,
    currentTrackContext: null,
    currentTrackIndexInContext: -1,
    isPlaying: false,
    toolsReady: false,
    isMuted: localStorage.getItem('eclipse_muted') === '1',
    volume: savedVolume,
    repeatMode: localStorage.getItem('eclipse_repeat_mode') || (localStorage.getItem('eclipse_repeat') === '1' ? 'one' : 'off'),
    get isRepeat() { return this.repeatMode === 'one'; },
    set isRepeat(v) { this.repeatMode = v ? 'one' : 'off'; },
    isShuffle: localStorage.getItem('eclipse_shuffle') === '1',
    isAutoRemix: localStorage.getItem('eclipse_automix') === '1',
    autoMixPlayedIds: new Set(),
    findAutoMixNextTrack() {
      if (!this.isAutoRemix || !Array.isArray(this.queue) || this.queue.length <= 1) return null;
      const cur = this.currentTrack;
      const curBpm = (cur && typeof cur.bpm === 'number' && cur.bpm > 0) ? cur.bpm : (window.autoMixDjInstance ? window.autoMixDjInstance.bpm : 120);
      
      // Look for unplayed tracks in current queue matching tempo and melody
      const unplayed = this.queue.filter((t, idx) => {
        if (idx === this.queueIndex) return false;
        const tid = t.id || t.videoId;
        return tid && !this.autoMixPlayedIds.has(tid) && !isTrackBlocked(t) && !isArtistBlocked(t.artist);
      });

      if (unplayed.length === 0) {
        // If all played, reset history so album can continue without getting stuck
        this.autoMixPlayedIds.clear();
        if (cur && (cur.id || cur.videoId)) this.autoMixPlayedIds.add(cur.id || cur.videoId);
        return null;
      }

      // Rank by BPM proximity
      unplayed.sort((a, b) => {
        const bpmA = (typeof a.bpm === 'number' && a.bpm > 0) ? a.bpm : 120;
        const bpmB = (typeof b.bpm === 'number' && b.bpm > 0) ? b.bpm : 120;
        const diffA = Math.abs(bpmA - curBpm);
        const diffB = Math.abs(bpmB - curBpm);
        return diffA - diffB;
      });

      const chosen = unplayed[0];
      const chosenId = chosen.id || chosen.videoId;
      if (chosenId) this.autoMixPlayedIds.add(chosenId);
      return chosen;
    },
    myWaveActive: false,
    isRadioQueue: false,
    _waveReplenishBusy: false,
    vibeTracks: [],
    _isNaturalEnding: false,
    _skipRecordedFor: null,
    isRightPanelOpen: true,
    lyricsMode: 'word',
    uiScale: savedScale,
    activePresetId: soundPersistenceEnabled ? (localStorage.getItem('eclipse_active_preset') || 'p_default') : 'p_default',
    themeMode: localStorage.getItem('eclipse_theme_mode') || 'dark',
    paletteStyle: localStorage.getItem('eclipse_palette_style') || 'classic',
    meshBrightness: parseInt(localStorage.getItem('eclipse_mesh_brightness') || '100', 10),
    themeAccent: localStorage.getItem('eclipse_theme_accent') || '#6750A4',
    themeIntensity: parseInt(localStorage.getItem('eclipse_theme_intensity') || '0'),
    themeBrightness: parseInt(localStorage.getItem('eclipse_theme_brightness') || '0'),
    trEnabled: localStorage.getItem('eclipse_tr_enabled') === 'true',
    trLang: localStorage.getItem('eclipse_tr_lang') || 'en',
    lyricsTranslationLang: localStorage.getItem('eclipse_tr_lang') || 'en',
    trAuto: localStorage.getItem('eclipse_tr_auto') === 'true',
    trActive: (localStorage.getItem('eclipse_tr_enabled') === 'true' && (localStorage.getItem('eclipse_tr_active') === 'true' || localStorage.getItem('eclipse_tr_auto') === 'true')),
    currentTranslations: null,
    isTvKaraokeOpen: false,
    isFloatingLyricsOpen: false,
                          audioSettings: savedSound.audioSettings,
                          hqEnabled: savedSound.hqEnabled,
                          hqSettings: savedSound.hqSettings,
                          vfx: { ...defaultVfx, ...safeJson('devsize_vfx', {}), bassPulse: false, particles: false, soundwaveRings: false, borderGlow: false, backdropBlur: false, crt: false, grain: false, lyricsSpotlight: false },
                          favorites: safeArray('devsize_favorites'),
                          history: safeArray('devsize_history'),
                          playlists: safeArray('devsize_playlists'),
                          customPresets: normalizedCustomPresets,
                          localTracks: (safeArray('eclipse_local_tracks').length > 0 ? safeArray('eclipse_local_tracks') : safeArray('devsize_local_tracks')).filter(t => {
                            const b = safeJson('eclipse_removed_local_paths', []);
                            const p = String(t?.path || t?.filePath || t?.url || '');
                            const id = String(t?.id || '');
                            return (!p || !b.includes(p)) && (!id || !b.includes(id));
                          }),
                          localFiles: (safeArray('eclipse_local_files').length > 0 ? safeArray('eclipse_local_files') : safeArray('devsize_local_files')).filter(t => {
                            const b = safeJson('eclipse_removed_local_paths', []);
                            const p = String(t?.path || t?.filePath || t?.url || '');
                            const id = String(t?.id || '');
                            return (!p || !b.includes(p)) && (!id || !b.includes(id));
                          }),
                          syncedLyrics: [],
                          glitchTimes: [],
                          lastGlitchedIndex: -1,
                          isGlitching: false,
                          isWindowVisible: true,
                          loadToken: 0,
                          audioDurationStale: false,
                          currentAbortController: null,
                          presetToRenameId: null,
                          serverPort: 38472,
                          discordRpcEnabled: safeJson('devsize_discord_rpc', true),
                          lastBroadcastStateKey: null,
                          syncTimeout: null,
                          scrubberDragTargetTime: undefined,
                          riffFont: localStorage.getItem('eclipse_font') || 'google'
  };

  function migrateAddedAt() {
    const favorites = backfillAddedAt(state.favorites, true);
    if (favorites !== state.favorites) {
      state.favorites = favorites;
      localStorage.setItem('devsize_favorites', JSON.stringify(state.favorites.map(sanitizeTrackForStorage)));
    }
    let playlistsChanged = false;
    for (const pl of state.playlists) {
      if (!pl || !Array.isArray(pl.tracks)) continue;
      const tracks = backfillAddedAt(pl.tracks, false);
      if (tracks !== pl.tracks) {
        pl.tracks = tracks;
        playlistsChanged = true;
      }
    }
    if (playlistsChanged) localStorage.setItem('devsize_playlists', JSON.stringify(state.playlists));
  }

  
  
  
  function parseSmartArtistAndTitle(rawTitle, rawArtist) {
  let title = String(rawTitle || '').trim();
  let artist = String(rawArtist || '')
    .replace(/\s*-\s*Topic$/i, '')
    .replace(/\bVEVO$/i, '')
    .replace(/\s+Official$/i, '')
    .trim();

  // 1. Strip common video badges / wrappers from raw title
  const stripBadges = (str) => {
    return str
      .replace(/\s*\|\s*(?:official\s*(?:music\s*)?(?:video|audio|lyrics?\s*video)|lyrics?\s*video|official\s*m\/?v|mv|visualizer|oxo\s*\(ep\)|ep|"[^"]+"\s*ep).*$/gi, '')
      .replace(/\s*-\s*(?:official\s*(?:music\s*)?(?:video|audio|lyric\s*video)|lyric\s*video|official\s*video).*$/gi, '')
      .replace(/\s*[\(\[]\s*(?:official\s*(?:music\s*)?(?:video|audio|lyric\s*video|visualizer|mv)|lyrics?\s*video|lyrics?|visualizer|hd|hq|4k|remastered\s*\d*|mv|clip\s*officiel|audio|official\s*video|official)\s*[\)\]]/gi, '')
      .trim();
  };

  title = stripBadges(title);
  artist = stripBadges(artist);

  // 2. Comprehensive Known Artists Lexicon
  const KNOWN_ARTISTS = [
    'mck', 'rdm mck', 'hoo', 'notchaos', 'w/n', 'lowkid', 'cupid', 'kiddi', 'thanhluan', 'thanh luan',
    'sơn tùng m-tp', 'đen', 'vũ', 'tlinh', 'hieuthuhai', 'wrxdie', 'wxrdie', 'gill',
    'b ray', 'masew', 'soobin hoàng sơn', 'soobin', 'mono', 'justatee', 'rhymastic',
    'dangrangto', 'eren', 'drzey', 'drzey 洲', 'honlieu', 'stormie', 'fishy', 'nguyên', 'nguyên.',
    'kidsai', 'bbynascar', '2pillz', 'younghao', 'left hand', 'lil liem', 'taki',
    'xoxad', 'shiki', 'tyronee', 'typbee', 'clare', 'wicper', 'par sg', 'long lự',
    'frontiniz', 'puppy', 'teuyungboy', 'vstra', 'hngle', 'bảo anh', 'vcc left hand',
    'dmean', 'sivan', 'kai đinh', 'kai dinh', 'jasmine', 'wren evans', 'sixtyuptown',
    'prettyxix', 'kewwi', 'itsnk'
  ];

  const matchesKnownArtist = (s) => {
    if (!s) return false;
    const norm = s.toLowerCase().replace(/\s+official$/i, '').trim();
    return KNOWN_ARTISTS.some(a => norm === a || norm.startsWith(a + ' ') || norm.endsWith(' ' + a) || norm.includes(' ' + a + ' ') || norm.includes(a + ',') || norm.includes(a + ' ft') || norm.includes(a + ' feat') || norm.includes(a + ' x ') || norm.includes(' x ' + a));
  };

  const isFeaturing = (s) => /\b(ft\.?|feat\.?|featuring|prod\.?|x)\b/i.test(s) || /,\s*[a-zA-Z0-9_\s]{2,}/.test(s);
  const featPattern = /(?:[\(\[]\s*|\s+)(?:ft\.?|feat\.?|featuring|prod\.?)\s*([^\)\]]+)[\)\]]?/i;

  // Inverted check first: if title is known artist and artist is NOT known artist (e.g. title: MCK, artist: Mot Cai Om)
  if (matchesKnownArtist(title) && artist && artist !== 'unknown artist') {
    const featInArtist = artist.match(featPattern);
    if (featInArtist) {
      const featStr = stripBadges(featInArtist[0]).replace(/^[\(\[\s]+/, '').replace(/[\)\]\s]+$/, '');
      const cleanSongTitle = stripBadges(artist.replace(featInArtist[0], '')).trim();
      artist = `${title} (${featStr})`;
      title = cleanSongTitle;
    } else if (!matchesKnownArtist(artist)) {
      const temp = title;
      title = artist;
      artist = temp;
    }
  }

  // 3. Separator splitting: ' - ', ' – ', ' — ', ' // '
  const sepMatch = title.match(/^(.+?)\s+(?:[-–—]|\/\/)\s+(.+)$/);
  if (sepMatch) {
    let left = sepMatch[1].trim();
    let right = sepMatch[2].trim();
    const normLeft = left.toLowerCase();
    const normRight = right.toLowerCase();
    const normA = artist.toLowerCase().replace(/\s+official$/i, '').trim();

    const leftIsArtist = matchesKnownArtist(left) || (normA && (normLeft === normA || normLeft.startsWith(normA) || normA.startsWith(normLeft)));
    const rightIsArtist = matchesKnownArtist(right) || (normA && (normRight === normA || normRight.startsWith(normA) || normA.startsWith(normRight)));

    if (rightIsArtist && !leftIsArtist) {
      artist = right;
      title = left;
    } else if (leftIsArtist && !rightIsArtist) {
      artist = left;
      title = right;
    } else if (rightIsArtist && leftIsArtist) {
      if (normA && (normRight === normA || normRight.startsWith(normA))) {
        artist = right;
        title = left;
      } else {
        artist = left;
        title = right;
      }
    } else {
      artist = left;
      title = right;
    }
  }

  // Strip badges after separator split as well
  title = stripBadges(title);
  artist = stripBadges(artist);

  // 4. Extract featuring / prod artist from title into artist if title contains it
  const featMatch = title.match(featPattern);
  if (featMatch) {
    const featStr = stripBadges(featMatch[0]).replace(/^[\(\[\s]+/, '').replace(/[\)\]\s]+$/, '');
    const cleanT = stripBadges(title.replace(featMatch[0], '')).trim();
    if (cleanT.length >= 2) {
      title = cleanT;
      if (!artist.toLowerCase().includes(featStr.toLowerCase())) {
        artist = artist ? `${artist} (${featStr})` : featStr;
      }
    }
  }

  // Clean quotes wrapping title
  title = title.replace(/^['"“‘]+|['"”’]+$/g, '').trim();
  title = stripBadges(title);
  artist = stripBadges(artist);

  // 5. Check if title and artist need to be swapped
  const titleLooksArtist = matchesKnownArtist(title) || isFeaturing(title);
  const artistLooksArtist = matchesKnownArtist(artist) || isFeaturing(artist);

  if (titleLooksArtist && !artistLooksArtist && artist && artist !== 'unknown artist') {
    const temp = title;
    title = artist;
    artist = temp;
  }

  artist = artist.replace(/\s+Official$/i, '').trim();

  return { title: title || 'untitled', artist: artist || 'unknown artist' };
}


  function normalizeTrackMeta(t) {
    if (!t) return t;
    const res = parseSmartArtistAndTitle(t.title, t.artist);
    t.title = res.title;
    t.artist = res.artist;
    return t;
  }

  function migrateTrackMetadata() {
    let favChanged = false;
    for (const t of (state.favorites || [])) {
      if (!t) continue;
      const oldT = t.title;
      const oldA = t.artist;
      normalizeTrackMeta(t);
      if (t.title !== oldT || t.artist !== oldA) favChanged = true;
    }
    if (favChanged) localStorage.setItem('devsize_favorites', JSON.stringify(state.favorites.map(sanitizeTrackForStorage)));

    let plChanged = false;
    for (const pl of (state.playlists || [])) {
      if (!pl || !Array.isArray(pl.tracks)) continue;
      for (const t of pl.tracks) {
        if (!t) continue;
        const oldT = t.title;
        const oldA = t.artist;
        normalizeTrackMeta(t);
        if (t.title !== oldT || t.artist !== oldA) plChanged = true;
      }
    }
    if (plChanged) localStorage.setItem('devsize_playlists', JSON.stringify(state.playlists));
  }

  migrateAddedAt();
  migrateTrackMetadata();

  applyFont(state.riffFont);

  if (window.electronAPI && window.electronAPI.getServerPort) {
    try {
      state.serverPort = await window.electronAPI.getServerPort();
      const currentLang = localStorage.getItem('eclipse_ui_lang') || localStorage.getItem('eclipse_ui_lang') || 'en';
      if (currentLang !== 'en') {
        if (typeof applyI18n === 'function') applyI18n(currentLang).catch(() => {});
      }
    } catch (e) {
      console.warn('Failed to get server port:', e);
    }
  }

  checkToolsStatus(true);

  if (window.electronAPI && window.electronAPI.discordRpcSetEnabled) {
    window.electronAPI.discordRpcSetEnabled(state.discordRpcEnabled);
  }

  function sendDiscordRpcUpdate(track, isPlaying) {
    if (window.electronAPI && window.electronAPI.updateThumbar) {
      window.electronAPI.updateThumbar(!!isPlaying);
    }
    if (!window.electronAPI || !window.electronAPI.discordRpcUpdate) return;
    const showPaused = localStorage.getItem('eclipse_discord_show_paused') !== '0';
    if (!track || (!isPlaying && !showPaused)) {
      if (window.electronAPI.discordRpcClear) window.electronAPI.discordRpcClear();
      return;
    }
    track.artist = stripYoutubeTopic(track.artist);
    applyTrackRenames(track);
    const customArt = typeof getTrackArt === 'function' ? getTrackArt(track) : null;
    const isHttpUrl = (u) => typeof u === 'string' && (u.startsWith('http://') || u.startsWith('https://')) && !u.includes('127.0.0.1');
    let rpcThumb = '';
    if (customArt && isHttpUrl(customArt.cover)) rpcThumb = customArt.cover;
    else if (isHttpUrl(track.thumbnail)) rpcThumb = track.thumbnail;
    else if (isHttpUrl(track.cover)) rpcThumb = track.cover;
    const shareTrackUrl = (track.url || (track.id ? ('https://www.youtube.com/watch?v=' + track.id) : ''));
    const shareUrl = buildRiffShareUrl(track, '', shareTrackUrl, 512);
    const curPos = (el.nativeAudio && Number.isFinite(el.nativeAudio.currentTime)) ? el.nativeAudio.currentTime : 0;
    const nowSec = Math.floor(Date.now() / 1000);
    window.electronAPI.discordRpcUpdate({
      title: track.title || 'Unknown Track',
      artist: track.artist || 'Unknown Artist',
      artistInStatus: localStorage.getItem('eclipse_discord_artist_status') !== '0',
      isPaused: !isPlaying,
      showPaused: showPaused,
      showTime: localStorage.getItem('eclipse_discord_show_time') !== '0',
      showButton: localStorage.getItem('eclipse_discord_show_button') !== '0',
      position: curPos,
      duration: track.duration || 0,
      thumbnail: rpcThumb,
      url: shareUrl,
      platform: track.platform || state.platform,
      startTimestamp: Math.max(0, nowSec - Math.floor(curPos))
    });
  }

  function sendStateToServer(currentWordText = '', wordIndex = -1, lineIndex = -1) {
    if (!state.currentTrack) return;
    fetch(`http://127.0.0.1:${state.serverPort}/api/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: state.currentTrack.title,
        artist: state.currentTrack.artist,
        isPlaying: state.isPlaying,
        word: currentWordText,
        wordIndex: wordIndex,
        lineIndex: lineIndex
      })
    }).catch(() => {});
  }

  function getMediaArtwork(thumb) {
    if (!thumb || typeof thumb !== 'string') return [];
    let trimmed = thumb.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(trimmed)) {
      trimmed = 'file://' + (trimmed.startsWith('/') ? '' : '/') + trimmed.replace(/\\/g, '/');
    }
    if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://') && !trimmed.startsWith('file://') && !trimmed.startsWith('data:')) {
      return [];
    }
    let type = 'image/jpeg';
    if (trimmed.startsWith('data:image/png') || /\.png(\?|$)/i.test(trimmed)) type = 'image/png';
    else if (trimmed.startsWith('data:image/webp') || /\.webp(\?|$)/i.test(trimmed)) type = 'image/webp';
    else if (trimmed.startsWith('data:image/gif') || /\.gif(\?|$)/i.test(trimmed)) type = 'image/gif';
    return [
      { src: trimmed, sizes: '256x256', type },
      { src: trimmed, sizes: '512x512', type }
    ];
  }

  function updateMediaPositionState() {
    if (!('mediaSession' in navigator) || typeof navigator.mediaSession.setPositionState !== 'function') return;
    try {
      const audio = (state.secondaryAudio && !state.secondaryAudio.paused) ? state.secondaryAudio : el.nativeAudio;
      let duration = (audio && Number.isFinite(audio.duration) && audio.duration > 0)
        ? audio.duration
        : (state.currentTrack && Number.isFinite(state.currentTrack.duration) && state.currentTrack.duration > 0 ? state.currentTrack.duration : 0);
      let position = (audio && Number.isFinite(audio.currentTime) && audio.currentTime >= 0) ? audio.currentTime : 0;
      let playbackRate = (audio && Number.isFinite(audio.playbackRate) && audio.playbackRate > 0) ? audio.playbackRate : 1.0;
      if (duration > 0) {
        if (position > duration) position = duration;
        navigator.mediaSession.setPositionState({
          duration,
          playbackRate,
          position
        });
      } else {
        navigator.mediaSession.setPositionState();
      }
    } catch (_) {}
  }

  function updateMediaSession(track) {
    if (!('mediaSession' in navigator)) return;
    const current = track || state.currentTrack;
    if (current) {
      const rawTitle = (typeof current.title === 'string' ? current.title.trim() : '');
      const rawArtist = (typeof current.artist === 'string' ? current.artist.trim() : '');
      const title = rawTitle || 'Unknown track';
      const artist = rawArtist || 'Unknown artist';
      const album = current.album || 'Eclipse';
      const thumb = (typeof getTrackThumbUrl === 'function' ? getTrackThumbUrl(current) : '') || current.thumbnail || current.cover || '';
      const artwork = getMediaArtwork(thumb);
      navigator.mediaSession.metadata = new MediaMetadata({
        title,
        artist,
        album,
        artwork
      });
      updateMediaPositionState();
    } else {
      navigator.mediaSession.metadata = null;
    }
    navigator.mediaSession.playbackState = state.isPlaying ? 'playing' : 'paused';
  }

  const MEDIA_GROUP = { toggle: 'pp', playpause: 'pp', play: 'pp', pause: 'pp', next: 'next', prev: 'prev', stop: 'stop' };
  let lastMedia = { g: '', t: 0 };
  let hasNotifiedMediaKeysActive = false;
  function handleMediaCommand(cmd, src) {
    if (cmd && typeof cmd === 'object' && cmd.type === 'seek-percent') {
      const dur = getReliableTrackDuration();
      if (dur > 0 && el.nativeAudio) {
        el.nativeAudio.currentTime = Math.max(0, Math.min(1, cmd.percent)) * dur;
        updateMediaPositionState();
      }
      return;
    }
    if (cmd === 'favorite') {
      if (state.currentTrack && typeof toggleFavoriteTrack === 'function') {
        toggleFavoriteTrack(state.currentTrack);
        if (typeof sendFloatingLyricsUpdate === 'function') sendFloatingLyricsUpdate();
      }
      return;
    }
    if (cmd === 'mute') {
      state.isMuted = !state.isMuted;
      if (el.volumeIcon) el.volumeIcon.classList.toggle('hidden', state.isMuted);
      if (el.volumeMutedIcon) el.volumeMutedIcon.classList.toggle('hidden', !state.isMuted);
      persistVolumeState();
      applyAudioSettings();
      if (typeof sendFloatingLyricsUpdate === 'function') sendFloatingLyricsUpdate();
      return;
    }
    const g = MEDIA_GROUP[cmd];
    if (!g) return;
    const now = performance.now();
    if (lastMedia.g === g && now - lastMedia.t < 350) return;
    lastMedia = { g, t: now };
    if (cmd === 'toggle' || cmd === 'playpause') togglePlayPause();
    else if (cmd === 'play') { if (!state.isPlaying) playSmooth(); }
    else if (cmd === 'pause') { if (state.isPlaying) pauseSmooth(); }
    else if (cmd === 'next') playNext();
    else if (cmd === 'prev') playPrev();
    else if (cmd === 'stop') { if (state.isPlaying) pauseSmooth(); }
  }

  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.setActionHandler('play', () => handleMediaCommand('play', 'session'));
      navigator.mediaSession.setActionHandler('pause', () => handleMediaCommand('pause', 'session'));
      navigator.mediaSession.setActionHandler('previoustrack', () => handleMediaCommand('prev', 'session'));
      navigator.mediaSession.setActionHandler('nexttrack', () => handleMediaCommand('next', 'session'));
      navigator.mediaSession.setActionHandler('stop', () => handleMediaCommand('stop', 'session'));
      navigator.mediaSession.setActionHandler('seekbackward', () => handleMediaCommand('prev', 'session'));
      navigator.mediaSession.setActionHandler('seekforward', () => handleMediaCommand('next', 'session'));
      navigator.mediaSession.setActionHandler('seekto', (details) => {
        if (details.seekTime !== undefined && details.seekTime !== null) {
          const audio = (state.secondaryAudio && !state.secondaryAudio.paused) ? state.secondaryAudio : el.nativeAudio;
          if (audio) audio.currentTime = details.seekTime;
          if (typeof updateSyncedLyricsHighlight === 'function') {
            updateSyncedLyricsHighlight(details.seekTime);
          }
          updateMediaPositionState();
        }
      });
    } catch (_) {}
  }

  const el = {
    btnMinimize: document.getElementById('btn-minimize'),
                          btnMaximize: document.getElementById('btn-maximize'),
                          btnClose: document.getElementById('btn-close'),

                          searchInput: document.getElementById('search-input'),
                          searchClearBtn: document.getElementById('search-clear-btn'),
                          searchIconBtn: document.getElementById('search-icon-btn'),
                          platformYt: document.getElementById('platform-yt'),
                          platformYtm: document.getElementById('platform-ytm'),
                          platformSc: document.getElementById('platform-sc'),

                          navActiveIndicator: document.getElementById('nav-active-indicator'),
                          navDiscover: document.getElementById('nav-discover'),
                          navFavorites: document.getElementById('nav-favorites'),
                          navAlbums: document.getElementById('nav-albums'),
                          navLocal: document.getElementById('nav-local'),
                          navHistory: document.getElementById('nav-history'),
                          navQueue: document.getElementById('nav-queue'),
                          navSettings: document.getElementById('nav-settings'),
                          favoritesCount: document.getElementById('favorites-count'),
                          albumsCount: document.getElementById('albums-count'),
                          localCount: document.getElementById('local-count'),
                          queueCount: document.getElementById('queue-count'),
                          historyCount: document.getElementById('history-count'),

                          presetsContainer: document.getElementById('presets-container'),
                          btnSavePresetDialog: document.getElementById('btn-save-preset-dialog'),
                          savePresetModal: document.getElementById('save-preset-modal'),
                          newPresetName: document.getElementById('new-preset-name'),
                          btnCancelPreset: document.getElementById('btn-cancel-preset'),
                          btnConfirmSavePreset: document.getElementById('btn-confirm-save-preset'),

                          renamePresetModal: document.getElementById('rename-preset-modal'),
                          renamePresetName: document.getElementById('rename-preset-name'),
                          btnCancelRenamePreset: document.getElementById('btn-cancel-rename-preset'),
                          btnConfirmRenamePreset: document.getElementById('btn-confirm-rename-preset'),

                          playlistsList: document.getElementById('playlists-list'),
                          btnNewPlaylist: document.getElementById('btn-new-playlist'),

                          viewDiscover: document.getElementById('view-discover'),
                          viewFavorites: document.getElementById('view-favorites'),
                          viewAlbums: document.getElementById('view-albums'),
                          savedAlbumsGrid: document.getElementById('saved-albums-grid'),
                          viewLocal: document.getElementById('view-local'),
                          viewHistory: document.getElementById('view-history'),
                          viewQueue: document.getElementById('view-queue'),
                          viewPlaylistDetail: document.getElementById('view-playlist-detail'),
                          viewAlbum: document.getElementById('view-album'),
                          viewArtist: document.getElementById('view-artist'),
                          viewSettings: document.getElementById('view-settings'),

                          btnBackAlbum: document.getElementById('btn-back-album'),
                          btnSaveAlbum: document.getElementById('btn-save-album'),
                          albumDetailCover: document.getElementById('album-detail-cover'),
                          albumDetailTitle: document.getElementById('album-detail-title'),
                          albumDetailArtist: document.getElementById('album-detail-artist'),
                          albumDetailCount: document.getElementById('album-detail-count'),
                          btnPlayAlbum: document.getElementById('btn-play-album'),
                          albumTracksList: document.getElementById('album-tracks-list'),

                          btnBackArtist: document.getElementById('btn-back-artist'),
                          artistHeroImg: document.getElementById('artist-hero-img'),
                          artistFansLine: document.getElementById('artist-fans-line'),
                          artistVerifiedBadge: document.getElementById('artist-verified-badge'),
                          artistProfileName: document.getElementById('artist-profile-name'),
                          artistProfileBio: document.getElementById('artist-profile-bio'),
                          btnPlayArtistTracks: document.getElementById('btn-play-artist-tracks'),
                          artistTracksCount: document.getElementById('artist-tracks-count'),
                          artistTracksList: document.getElementById('artist-tracks-list'),

                          discoverEmpty: document.getElementById('discover-empty'),
                          discoverHome: document.getElementById('discover-home'),
                          searchResultsContainer: document.getElementById('search-results-container'),
                          searchResults: document.getElementById('search-results-container'),
                          searchTracksList: document.getElementById('search-tracks-list'),
                          mainContent: document.getElementById('main-content') || document.querySelector('.main-content'),
                          suggestionChips: document.getElementById('suggestion-chips'),

                          favoritesTracksList: document.getElementById('favorites-tracks-list'),
                          favoritesSearchInput: document.getElementById('favorites-search-input'),
                          favoritesSort: document.getElementById('favorites-sort'),
                          playlistSearchInput: document.getElementById('playlist-search-input'),
                          playlistSort: document.getElementById('playlist-sort'),
                          favoritesSubtitle: document.getElementById('favorites-subtitle'),
                          localTracksList: document.getElementById('local-tracks-list'),
                          localSearchInput: document.getElementById('local-search-input'),
                          localSubtitle: document.getElementById('local-subtitle'),
                          btnAddLocal: document.getElementById('btn-add-local') || document.getElementById('btn-add-local-files'),
                          btnAddLocalFiles: document.getElementById('btn-add-local') || document.getElementById('btn-add-local-files'),
                          btnAddLocalFolder: document.getElementById('btn-add-local-folder'),
                          btnAddLocalFilesEmpty: document.getElementById('btn-add-local-files-empty'),
                          localAlbumsRow: document.getElementById('local-albums-row'),
                          historyTracksList: document.getElementById('history-tracks-list'),
                          btnClearHistory: document.getElementById('btn-clear-history'),
                          queueTracksList: document.getElementById('queue-tracks-list'),
                          btnClearQueue: document.getElementById('btn-clear-queue'),
                          playlistTracksList: document.getElementById('playlist-tracks-list'),
                          playlistDetailTitle: document.getElementById('playlist-detail-title'),
                          playlistDetailCount: document.getElementById('playlist-detail-count'),
                          btnBackPlaylists: document.getElementById('btn-back-playlists'),
                          btnPlayPlaylist: document.getElementById('btn-play-playlist'),
                          btnDeletePlaylist: document.getElementById('btn-delete-playlist'),

                          rightPanel: document.getElementById('right-panel'),
                          btnCloseRightPanel: document.getElementById('btn-close-right-panel'),
                          btnToggleLyricsPanel: document.getElementById('btn-toggle-lyrics-panel'),
                          btnLyricsMode: document.getElementById('btn-lyrics-mode'),
                          btnAvSong: document.getElementById('btn-av-song'),
                          btnAvVideo: document.getElementById('btn-av-video'),
                          mvPlayerWrapper: document.getElementById('mv-player-wrapper'),
                          mvVideo: document.getElementById('mv-video'),
                          mvLoadingOverlay: document.getElementById('mv-loading-overlay'),
                          btnMvPopout: document.getElementById('btn-mv-popout'),
                          btnToggleMv: document.getElementById('btn-toggle-mv'),
                          coverContainer: document.getElementById('cover-container'),
                          rightPanelArtworkBox: document.getElementById('right-panel-artwork-box'),
                          rightPanelCover: document.getElementById('right-panel-cover'),
                          rightPanelFallback: document.getElementById('right-panel-fallback'),
                          rightPanelTitle: document.getElementById('right-panel-title'),
                          rightPanelArtist: document.getElementById('right-panel-artist'),
                          lyricsStatus: document.getElementById('lyrics-status'),
                          lyricsContainer: document.getElementById('lyrics-container'),
                          lyricsHint: document.getElementById('lyrics-hint'),
                          btnTranslateLyrics: document.getElementById('btn-translate-lyrics'),
                          btnRomanizeLyrics: document.getElementById('btn-romanize-lyrics'),
                          btnTrEnabled: document.getElementById('btn-tr-enabled'),
                          selectTrLang: document.getElementById('select-tr-lang'),
                          btnTrAuto: document.getElementById('btn-tr-auto'),
                          btnTvKaraoke: document.getElementById('btn-tv-karaoke'),
                          tvKaraoke: document.getElementById('tv-karaoke'),
                          tvBg: document.getElementById('tv-bg'),
                          tvCover: document.getElementById('tv-cover'),
                          tvKaraokeContent: document.getElementById('tv-karaoke-content'),
                          tvKaraokeClose: document.getElementById('btn-close-tv-karaoke'),
                          tvKaraokeTitle: document.getElementById('tv-karaoke-title'),
                          tvKaraokeArtist: document.getElementById('tv-karaoke-artist'),
                          tvkTimeCurrent: document.getElementById('tvk-time-current'),
                          tvkTimeDuration: document.getElementById('tvk-time-duration'),
                          tvkSeekSlider: document.getElementById('tvk-seek-slider'),

                          playbar: document.getElementById('playbar'),
                          playbarArtwork: document.getElementById('playbar-artwork'),
                          artworkFallback: document.getElementById('artwork-fallback'),
                          playbarTitle: document.getElementById('playbar-title'),
                          playbarArtist: document.getElementById('playbar-artist'),
                          scrubberLoadingBar: document.getElementById('scrubber-loading-bar'),
                          audioLoadingPill: document.getElementById('audio-loading-pill'),
                          audioLoadingText: document.getElementById('audio-loading-text'),
                          btnToggleFav: document.getElementById('btn-toggle-fav'),
                          btnPlaybarTrim: document.getElementById('btn-playbar-trim'),
                          favIcon: document.getElementById('fav-icon'),
                          btnShuffle: document.getElementById('btn-shuffle'),
                          btnPrev: document.getElementById('btn-prev'),
                          btnPlayPause: document.getElementById('btn-play-pause'),
                          playIcon: document.getElementById('play-icon'),
                          pauseIcon: document.getElementById('pause-icon'),
                          playbarSpinner: document.getElementById('playbar-spinner'),
                          btnNext: document.getElementById('btn-next'),
                          btnRepeat: document.getElementById('btn-repeat'),
                          btnAutoRemix: document.getElementById('btn-auto-remix'),

                          timeCurrent: document.getElementById('time-current'),
                          timeDuration: document.getElementById('time-duration'),
                          scrubberTrack: document.getElementById('scrubber-track'),

                          visualizerCanvas: document.getElementById('visualizer-canvas'),
                          btnOpenSettings: document.getElementById('btn-open-settings'),
                          btnOpenVisualSettings: document.getElementById('btn-open-visual-settings'),
                          settingsModifiedDot: document.getElementById('settings-modified-dot'),
                          btnVolumeMute: document.getElementById('btn-volume-mute'),
                          volumeIcon: document.getElementById('volume-icon'),
                          volumeMutedIcon: document.getElementById('volume-muted-icon'),
                          volumeSlider: document.getElementById('volume-slider'),

                          downloadModal: document.getElementById('download-modal'),
                          btnCloseDownloadModal: document.getElementById('btn-close-download-modal'),
                          btnCancelDownload: document.getElementById('btn-cancel-download'),
                          btnConfirmDownload: document.getElementById('btn-confirm-download'),
                          downloadSpinner: document.getElementById('download-spinner'),
                          downloadBtnText: document.getElementById('download-btn-text'),
                          downloadPreviewThumb: document.getElementById('download-preview-thumb'),
                          downloadPreviewFallback: document.getElementById('download-preview-fallback'),
                          downloadPreviewTitle: document.getElementById('download-preview-title'),
                          downloadPreviewArtist: document.getElementById('download-preview-artist'),
                          btnPlaybarMore: document.getElementById('btn-playbar-more'),
                          btnPlaybarShare: document.getElementById('btn-playbar-share'),

                          audioSettingsModal: document.getElementById('audio-settings-modal'),
                          btnCloseSettings: document.getElementById('btn-close-settings'),
                          sleepTimerStatus: document.getElementById('sleep-timer-status'),

                          btnToggleHqAudio: document.getElementById('toggle-hq-audio'),
                          hqEnhancerCard: document.querySelector('.hq-enhancer-card'),
                          hqPanelWrapper: document.getElementById('hq-panel-wrapper'),
                          hqEngineSelect: document.getElementById('hq-engine-select'),
                          sliderHqVocal: document.getElementById('slider-hq-vocal'),
                          valHqVocal: document.getElementById('val-hq-vocal'),
                          sliderHqAir: document.getElementById('slider-hq-air'),
                          valHqAir: document.getElementById('val-hq-air'),
                          sliderHqBass: document.getElementById('slider-hq-bass'),
                          valHqBass: document.getElementById('val-hq-bass'),
                          hqPresetChips: document.querySelectorAll('.hq-preset-chip'),

                          sliderSpeed: document.getElementById('slider-speed'),
                          valSpeed: document.getElementById('val-speed'),
                          sliderSpeedPitch: document.getElementById('slider-speed-pitch'),
                          valSpeedPitch: document.getElementById('val-speed-pitch'),
                          sliderPitch: document.getElementById('slider-pitch'),
                          valPitch: document.getElementById('val-pitch'),
                          sliderReverb: document.getElementById('slider-reverb'),
                          valReverb: document.getElementById('val-reverb'),
                          sliderDistortion: document.getElementById('slider-distortion'),
                          valDistortion: document.getElementById('val-distortion'),
                          sliderGain: document.getElementById('slider-gain'),
                          valGain: document.getElementById('val-gain'),
                          sliderEcho: document.getElementById('slider-echo'),
                          valEcho: document.getElementById('val-echo'),
                          sliderEqLow: document.getElementById('slider-eq-low'),
                          valEqLow: document.getElementById('val-eq-low'),
                          sliderEqMid: document.getElementById('slider-eq-mid'),
                          valEqMid: document.getElementById('val-eq-mid'),
                          sliderEqHigh: document.getElementById('slider-eq-high'),
                          valEqHigh: document.getElementById('val-eq-high'),
                          eqBands: document.getElementById('eq-bands'),
                          btnResetEqBands: document.getElementById('btn-reset-eq-bands'),

                          sliderScale: document.getElementById('settings-slider-scale') || document.getElementById('slider-scale'),
                          valScale: document.getElementById('settings-val-scale') || document.getElementById('val-scale'),
                          sliderFontScale: document.getElementById('slider-font-scale'),
                          valFontScale: document.getElementById('val-font-scale'),
                          sliderCornerRadius: document.getElementById('slider-corner-radius'),
                          valCornerRadius: document.getElementById('val-corner-radius'),
                          sliderUiAlpha: document.getElementById('slider-ui-alpha'),
                          valUiAlpha: document.getElementById('val-ui-alpha'),
                          btnResetUiAlpha: document.getElementById('btn-reset-ui-alpha'),
                          sliderTextAlpha: document.getElementById('slider-text-alpha'),
                          valTextAlpha: document.getElementById('val-text-alpha'),
                          btnResetTextAlpha: document.getElementById('btn-reset-text-alpha'),
                          themeModeBtns: document.querySelectorAll('.theme-mode-btn'),
                          themeSwatches: document.querySelectorAll('.theme-swatch'),
                          customColorInput: document.getElementById('settings-custom-color-input'),
                          sliderHue: document.getElementById('slider-theme-hue'),
                          valHue: document.getElementById('val-theme-hue'),
                          sliderIntensity: document.getElementById('slider-theme-intensity'),
                          valIntensity: document.getElementById('val-theme-intensity'),
                          sliderBrightness: document.getElementById('slider-theme-brightness'),
                          valBrightness: document.getElementById('val-theme-brightness'),

                          visualSettingsModal: document.getElementById('visual-settings-modal'),
                          btnCloseVisualSettings: document.getElementById('btn-close-visual-settings'),
                          btnResetVfx: document.getElementById('btn-reset-vfx'),

                          createPlaylistModal: document.getElementById('create-playlist-modal'),
                          newPlaylistInput: document.getElementById('new-playlist-input'),
                          btnCancelNewPlaylist: document.getElementById('btn-cancel-new-playlist'),
                          btnConfirmNewPlaylist: document.getElementById('btn-confirm-new-playlist'),

                          addToPlaylistModal: document.getElementById('add-to-playlist-modal'),
                          playlistPickList: document.getElementById('playlist-pick-list'),
                          btnCancelAddPlaylist: document.getElementById('btn-cancel-add-playlist'),
                          linkImportModal: document.getElementById('link-import-modal'),

                          nativeAudio: document.getElementById('native-audio'),
                          trackLoadingOverlay: document.getElementById('track-loading-overlay'),
                          trackLoadingTitle: document.getElementById('track-loading-title'),
                          trackLoadingSub: document.getElementById('track-loading-sub'),

                          btnAddCustomLyrics: document.getElementById('btn-add-custom-lyrics'),
                          btnSyncLyrics: document.getElementById('btn-sync-lyrics'),
                          customLyricsModal: document.getElementById('custom-lyrics-modal'),
                          customLyricsTextarea: document.getElementById('custom-lyrics-textarea'),
                          customLyricsTrackTitle: document.getElementById('custom-lyrics-track-title'),
                          customLyricsTrackArtist: document.getElementById('custom-lyrics-track-artist'),
                          btnCloseCustomLyrics: document.getElementById('btn-close-custom-lyrics'),
                          btnCancelCustomLyrics: document.getElementById('btn-cancel-custom-lyrics'),
                          btnSaveCustomLyrics: document.getElementById('btn-save-custom-lyrics'),
                          syncModeOverlay: document.getElementById('sync-mode-overlay'),
                          syncModeLyrics: document.getElementById('sync-mode-lyrics'),
                          syncProgressText: document.getElementById('sync-progress-text'),
                          btnRestartSync: document.getElementById('btn-restart-sync'),
                          btnSaveSync: document.getElementById('btn-save-sync'),
                          btnCancelSync: document.getElementById('btn-cancel-sync'),

                          btnEditCurrentTrack: document.getElementById('btn-edit-current-track'),
                          renameTrackModal: document.getElementById('rename-track-modal'),
                          inputRenameTitle: document.getElementById('rename-track-title'),
                          inputRenameArtist: document.getElementById('rename-track-artist'),
                          renameTitleInput: document.getElementById('rename-track-title'),
                          renameArtistInput: document.getElementById('rename-track-artist'),
                          btnCancelRenameTrack: document.getElementById('btn-cancel-rename-track'),
                          btnConfirmRenameTrack: document.getElementById('btn-confirm-rename-track'),

                          btnRefreshVibe: document.getElementById('btn-refresh-vibe')
  };
  if (el.nativeAudio) el.nativeAudio.preload = 'auto';

  if (el.mainContent && !el.mainContent.parentElement.classList.contains('main-content-wrap')) {
    const mcWrap = document.createElement('div');
    mcWrap.className = 'main-content-wrap';
    el.mainContent.parentNode.insertBefore(mcWrap, el.mainContent);
    mcWrap.appendChild(el.mainContent);
  }

  if (el.mainContent) {
    el.mainContent.addEventListener('scroll', () => updateFade(el.mainContent), { passive: true });
    window.addEventListener('resize', () => updateFade(el.mainContent), { passive: true });
    if (window.ResizeObserver) {
      new ResizeObserver(() => updateFade(el.mainContent)).observe(el.mainContent);
    }
    updateFade(el.mainContent);
  }

  var TRANSLATION_LANGUAGES = [
    { code: 'romaji', name: 'Romanized (Romaji / Pinyin / Romaja)', flag: '🔤' },
    { code: 'af', name: 'Afrikaans', flag: '🇿🇦' },
    { code: 'sq', name: 'Albanian', flag: '🇦🇱' },
    { code: 'am', name: 'Amharic', flag: '🇪🇹' },
    { code: 'ar', name: 'Arabic', flag: '🇸🇦' },
    { code: 'hy', name: 'Armenian', flag: '🇦🇲' },
    { code: 'as', name: 'Assamese', flag: '🇮🇳' },
    { code: 'ay', name: 'Aymara', flag: '🇧🇴' },
    { code: 'az', name: 'Azerbaijani', flag: '🇦🇿' },
    { code: 'bm', name: 'Bambara', flag: '🇲🇱' },
    { code: 'eu', name: 'Basque', flag: '🇪🇸' },
    { code: 'be', name: 'Belarusian', flag: '🇧🇾' },
    { code: 'bn', name: 'Bengali', flag: '🇧🇩' },
    { code: 'bho', name: 'Bhojpuri', flag: '🇮🇳' },
    { code: 'bs', name: 'Bosnian', flag: '🇧🇦' },
    { code: 'bg', name: 'Bulgarian', flag: '🇧🇬' },
    { code: 'ca', name: 'Catalan', flag: '🇪🇸' },
    { code: 'ceb', name: 'Cebuano', flag: '🇵🇭' },
    { code: 'ny', name: 'Chichewa', flag: '🇲🇼' },
    { code: 'zh-CN', name: 'Chinese (Simplified)', flag: '🇨🇳' },
    { code: 'zh-TW', name: 'Chinese (Traditional)', flag: '🇹🇼' },
    { code: 'co', name: 'Corsican', flag: '🇫🇷' },
    { code: 'hr', name: 'Croatian', flag: '🇭🇷' },
    { code: 'cs', name: 'Czech', flag: '🇨🇿' },
    { code: 'da', name: 'Danish', flag: '🇩🇰' },
    { code: 'dv', name: 'Dhivehi', flag: '🇲🇻' },
    { code: 'doi', name: 'Dogri', flag: '🇮🇳' },
    { code: 'nl', name: 'Dutch', flag: '🇳🇱' },
    { code: 'en', name: 'English', flag: '🇺🇸' },
    { code: 'eo', name: 'Esperanto', flag: '🌐' },
    { code: 'et', name: 'Estonian', flag: '🇪🇪' },
    { code: 'ee', name: 'Ewe', flag: '🇬🇭' },
    { code: 'tl', name: 'Filipino', flag: '🇵🇭' },
    { code: 'fi', name: 'Finnish', flag: '🇫🇮' },
    { code: 'fr', name: 'French', flag: '🇫🇷' },
    { code: 'fy', name: 'Frisian', flag: '🇳🇱' },
    { code: 'gl', name: 'Galician', flag: '🇪🇸' },
    { code: 'ka', name: 'Georgian', flag: '🇬🇪' },
    { code: 'de', name: 'German', flag: '🇩🇪' },
    { code: 'el', name: 'Greek', flag: '🇬🇷' },
    { code: 'gn', name: 'Guarani', flag: '🇵🇾' },
    { code: 'gu', name: 'Gujarati', flag: '🇮🇳' },
    { code: 'ht', name: 'Haitian Creole', flag: '🇭🇹' },
    { code: 'ha', name: 'Hausa', flag: '🇳🇬' },
    { code: 'haw', name: 'Hawaiian', flag: '🇺🇸' },
    { code: 'he', name: 'Hebrew', flag: '🇮🇱' },
    { code: 'hi', name: 'Hindi', flag: '🇮🇳' },
    { code: 'hmn', name: 'Hmong', flag: '🇱🇦' },
    { code: 'hu', name: 'Hungarian', flag: '🇭🇺' },
    { code: 'is', name: 'Icelandic', flag: '🇮🇸' },
    { code: 'ig', name: 'Igbo', flag: '🇳🇬' },
    { code: 'ilo', name: 'Ilocano', flag: '🇵🇭' },
    { code: 'id', name: 'Indonesian', flag: '🇮🇩' },
    { code: 'ga', name: 'Irish', flag: '🇮🇪' },
    { code: 'it', name: 'Italian', flag: '🇮🇹' },
    { code: 'ja', name: 'Japanese', flag: '🇯🇵' },
    { code: 'jw', name: 'Javanese', flag: '🇮🇩' },
    { code: 'kn', name: 'Kannada', flag: '🇮🇳' },
    { code: 'kk', name: 'Kazakh', flag: '🇰🇿' },
    { code: 'km', name: 'Khmer', flag: '🇰🇭' },
    { code: 'rw', name: 'Kinyarwanda', flag: '🇷🇼' },
    { code: 'gom', name: 'Konkani', flag: '🇮🇳' },
    { code: 'ko', name: 'Korean', flag: '🇰🇷' },
    { code: 'kri', name: 'Krio', flag: '🇸🇱' },
    { code: 'ku', name: 'Kurdish (Kurmanji)', flag: '🇹🇷' },
    { code: 'ckb', name: 'Kurdish (Sorani)', flag: '🇮🇶' },
    { code: 'ky', name: 'Kyrgyz', flag: '🇰🇬' },
    { code: 'lo', name: 'Lao', flag: '🇱🇦' },
    { code: 'la', name: 'Latin', flag: '🏛️' },
    { code: 'lv', name: 'Latvian', flag: '🇱🇻' },
    { code: 'ln', name: 'Lingala', flag: '🇨🇩' },
    { code: 'lt', name: 'Lithuanian', flag: '🇱🇹' },
    { code: 'lg', name: 'Luganda', flag: '🇺🇬' },
    { code: 'lb', name: 'Luxembourgish', flag: '🇱🇺' },
    { code: 'mk', name: 'Macedonian', flag: '🇲🇰' },
    { code: 'mai', name: 'Maithili', flag: '🇮🇳' },
    { code: 'mg', name: 'Malagasy', flag: '🇲🇬' },
    { code: 'ms', name: 'Malay', flag: '🇲🇾' },
    { code: 'ml', name: 'Malayalam', flag: '🇮🇳' },
    { code: 'mt', name: 'Maltese', flag: '🇲🇹' },
    { code: 'mi', name: 'Maori', flag: '🇳🇿' },
    { code: 'mr', name: 'Marathi', flag: '🇮🇳' },
    { code: 'mni-Mtei', name: 'Meiteilon (Manipuri)', flag: '🇮🇳' },
    { code: 'lus', name: 'Mizo', flag: '🇮🇳' },
    { code: 'mn', name: 'Mongolian', flag: '🇲🇳' },
    { code: 'my', name: 'Myanmar (Burmese)', flag: '🇲🇲' },
    { code: 'ne', name: 'Nepali', flag: '🇳🇵' },
    { code: 'no', name: 'Norwegian', flag: '🇳🇴' },
    { code: 'or', name: 'Odia (Oriya)', flag: '🇮🇳' },
    { code: 'om', name: 'Oromo', flag: '🇪🇹' },
    { code: 'ps', name: 'Pashto', flag: '🇦🇫' },
    { code: 'fa', name: 'Persian (فارسی)', flag: '🇮🇷' },
    { code: 'pl', name: 'Polish', flag: '🇵🇱' },
    { code: 'pt', name: 'Portuguese', flag: '🇵🇹' },
    { code: 'pa', name: 'Punjabi', flag: '🇮🇳' },
    { code: 'qu', name: 'Quechua', flag: '🇵🇪' },
    { code: 'ro', name: 'Romanian', flag: '🇷🇴' },
    { code: 'ru', name: 'Russian', flag: '🇷🇺' },
    { code: 'sm', name: 'Samoan', flag: '🇼🇸' },
    { code: 'sa', name: 'Sanskrit', flag: '🇮🇳' },
    { code: 'gd', name: 'Scots Gaelic', flag: '🏴󠁧󠁢󠁳󠁣󠁴󠁿' },
    { code: 'sr', name: 'Serbian', flag: '🇷🇸' },
    { code: 'st', name: 'Sesotho', flag: '🇱🇸' },
    { code: 'sn', name: 'Shona', flag: '🇿🇼' },
    { code: 'sd', name: 'Sindhi', flag: '🇵🇰' },
    { code: 'si', name: 'Sinhala', flag: '🇱🇰' },
    { code: 'sk', name: 'Slovak', flag: '🇸🇰' },
    { code: 'sl', name: 'Slovenian', flag: '🇸🇮' },
    { code: 'so', name: 'Somali', flag: '🇸🇴' },
    { code: 'es', name: 'Spanish', flag: '🇪🇸' },
    { code: 'su', name: 'Sundanese', flag: '🇮🇩' },
    { code: 'sw', name: 'Swahili', flag: '🇰🇪' },
    { code: 'sv', name: 'Swedish', flag: '🇸🇪' },
    { code: 'tg', name: 'Tajik', flag: '🇹🇯' },
    { code: 'ta', name: 'Tamil', flag: '🇮🇳' },
    { code: 'tt', name: 'Tatar', flag: '🇷🇺' },
    { code: 'te', name: 'Telugu', flag: '🇮🇳' },
    { code: 'th', name: 'Thai', flag: '🇹🇭' },
    { code: 'ti', name: 'Tigrinya', flag: '🇪🇷' },
    { code: 'ts', name: 'Tsonga', flag: '🇿🇦' },
    { code: 'tr', name: 'Turkish', flag: '🇹🇷' },
    { code: 'tk', name: 'Turkmen', flag: '🇹🇲' },
    { code: 'ak', name: 'Twi (Akan)', flag: '🇬🇭' },
    { code: 'uk', name: 'Ukrainian', flag: '🇺🇦' },
    { code: 'ur', name: 'Urdu', flag: '🇵🇰' },
    { code: 'ug', name: 'Uyghur', flag: '🇨🇳' },
    { code: 'uz', name: 'Uzbek', flag: '🇺🇿' },
    { code: 'vi', name: 'Vietnamese', flag: '🇻🇳' },
    { code: 'cy', name: 'Welsh', flag: '🏴󠁧󠁢󠁷󠁬󠁳󠁿' },
    { code: 'xh', name: 'Xhosa', flag: '🇿🇦' },
    { code: 'yi', name: 'Yiddish', flag: '🇮🇱' },
    { code: 'yo', name: 'Yoruba', flag: '🇳🇬' },
    { code: 'zu', name: 'Zulu', flag: '🇿🇦' }
  ];
  window.TRANSLATION_LANGUAGES = TRANSLATION_LANGUAGES;

  var RTL_UI_LANGS = new Set(['ar', 'fa', 'per', 'fas', 'prs', 'pes', 'farsi', 'persian', 'he', 'iw', 'ur', 'ps', 'ckb', 'sd', 'ug', 'yi']);
  ['Vocal', 'Air', 'Bass'].forEach(type => {
    const slider = el[`sliderHq${type}`];
    if (slider) {
      slider.min = -50;
      slider.max = 50;
      slider.value = state.hqSettings[type.toLowerCase()];
    }
  });

  if (el.sliderScale) el.sliderScale.value = state.uiScale;
  if (el.valScale) el.valScale.textContent = `${state.uiScale}%`;

  const savedFontScale = localStorage.getItem('eclipse_font_scale') || '100';
  const fontVal = parseInt(savedFontScale, 10) || 100;
  if (el.sliderFontScale) el.sliderFontScale.value = fontVal.toString();
  if (el.valFontScale) el.valFontScale.textContent = `${fontVal}%`;
  document.documentElement.style.setProperty('--font-scale', ((fontVal / 100) * 0.95 * 1.25).toString());

  const savedRadius = localStorage.getItem('eclipse_corner_radius') || '16';
  if (el.sliderCornerRadius) el.sliderCornerRadius.value = savedRadius;
  if (el.valCornerRadius) el.valCornerRadius.textContent = savedRadius === '16' ? 'Default' : `${savedRadius}px`;
  document.documentElement.style.setProperty('--md-shape-corner-l', `${savedRadius}px`);
  document.documentElement.style.setProperty('--md-shape-corner-m', `${Math.max(0, parseInt(savedRadius) - 4)}px`);

  applyReducedMotionSetting();
  document.body.classList.toggle('hide-titlebar', !!getAdv('hide_titlebar', false));
  document.body.classList.toggle('keep-bar-timestamps', !getAdv('autohide_timestamps', true));
  document.body.classList.toggle('classic-sidebar', !!getAdv('classic_sidebar', false));

  window.addEventListener('pointermove', (e) => {
    if (!document.body.classList.contains('hide-titlebar')) {
      if (document.body.classList.contains('titlebar-peek')) {
        document.body.classList.remove('titlebar-peek');
      }
      return;
    }
    if (e.clientY <= 12) {
      document.body.classList.add('titlebar-peek');
    } else if (e.clientY > 46) {
      document.body.classList.remove('titlebar-peek');
    }
  });

  let titlebarRevealHideTimer = null;
  window.addEventListener('mousemove', (e) => {
    if (!document.body.classList.contains('hide-titlebar')) {
      document.body.classList.remove('titlebar-reveal');
      return;
    }
    if (e.clientY <= 2) {
      if (titlebarRevealHideTimer) { clearTimeout(titlebarRevealHideTimer); titlebarRevealHideTimer = null; }
      document.body.classList.add('titlebar-reveal');
    } else if (document.body.classList.contains('titlebar-reveal') && e.clientY > 48) {
      if (!titlebarRevealHideTimer) {
        titlebarRevealHideTimer = setTimeout(() => {
          document.body.classList.remove('titlebar-reveal');
          titlebarRevealHideTimer = null;
        }, 400);
      }
    }
  });
  document.addEventListener('mouseleave', () => {
    document.body.classList.remove('titlebar-reveal');
    document.body.classList.remove('titlebar-peek');
    if (titlebarRevealHideTimer) { clearTimeout(titlebarRevealHideTimer); titlebarRevealHideTimer = null; }
  });

  const savedBannerBlur = parseInt(localStorage.getItem('eclipse_banner_blur') || '3', 10);
  const savedBannerOpacity = parseInt(localStorage.getItem('eclipse_banner_opacity') || '100', 10);
  const savedBannerFade = parseInt(localStorage.getItem('eclipse_banner_fade') || '100', 10);
  const savedBannerFit = localStorage.getItem('eclipse_banner_fit') || 'zoom';

  document.documentElement.style.setProperty('--banner-blur', `${savedBannerBlur}px`);
  document.documentElement.style.setProperty('--banner-opacity', `${savedBannerOpacity / 100}`);
  document.documentElement.style.setProperty('--banner-fade-base', `${savedBannerFade}%`);
  document.documentElement.style.setProperty('--banner-fade-end', `${savedBannerFade}%`);
  applyBannerFit(savedBannerFit);

  function applyUiOpacity() {
    const rawUi = parseInt(localStorage.getItem('eclipse_ui_alpha') || '20', 10);
    const rawText = parseInt(localStorage.getItem('eclipse_text_alpha') || '100', 10);
    const uiAlpha = Math.max(20, Math.min(100, isNaN(rawUi) ? 100 : rawUi));
    const textAlpha = Math.max(1, Math.min(100, isNaN(rawText) ? 100 : rawText));

    document.documentElement.style.setProperty('--ui-alpha', `${uiAlpha}%`);
    document.documentElement.style.setProperty('--text-alpha', `${textAlpha}%`);

    if (el.sliderUiAlpha) el.sliderUiAlpha.value = uiAlpha;
    if (el.valUiAlpha) el.valUiAlpha.textContent = `${uiAlpha}%`;
    if (el.sliderTextAlpha) el.sliderTextAlpha.value = textAlpha;
    if (el.valTextAlpha) el.valTextAlpha.textContent = `${textAlpha}%`;
  }

  applyUiOpacity();

  window.state = state;
  window.el = el;
  updateThemeFromState();

  if (state.themeMode !== 'auto') {
    if (el.sliderIntensity) el.sliderIntensity.value = state.themeIntensity;
    if (el.valIntensity) el.valIntensity.textContent = state.themeIntensity + '%';
    if (el.sliderBrightness) el.sliderBrightness.value = state.themeBrightness;
    if (el.valBrightness) el.valBrightness.textContent = state.themeBrightness + '%';
  }

  const railDrawer = document.getElementById('rail-drawer');
  const sidebarEl = document.querySelector('.sidebar');
  const btnTogglePresets = document.getElementById('btn-toggle-presets-drawer');
  const btnTogglePlaylists = document.getElementById('btn-toggle-playlists-drawer');
  const btnCloseDrawer = document.getElementById('btn-close-rail-drawer');
  const sectionPresets = document.getElementById('drawer-section-presets');
  const sectionPlaylists = document.getElementById('drawer-section-playlists');
  const drawerTitle = document.getElementById('rail-drawer-title');

  let openDrawerState = null;
  let activeDrawerMode = null;
  let railDrawerCloseTimeout = null;

  function applyDrawerState(triggerBtn) {
    if (!railDrawer) return;

    if (!openDrawerState) {
      if (activeDrawerMode !== null) {
        if (sidebarEl) sidebarEl.classList.remove('has-drawer-open');
        if (btnTogglePresets) btnTogglePresets.classList.remove('active');
        if (btnTogglePlaylists) btnTogglePlaylists.classList.remove('active');
        activeDrawerMode = null;
        if (railDrawerCloseTimeout) {
          clearTimeout(railDrawerCloseTimeout);
          railDrawerCloseTimeout = null;
        }
        railDrawer.classList.remove('open');
        railDrawerCloseTimeout = setTimeout(() => {
          railDrawer.classList.add('hidden');
          railDrawerCloseTimeout = null;
        }, 200);
      }
    } else {
      const isPresets = openDrawerState === 'presets';
      const trigger = triggerBtn || (isPresets ? btnTogglePresets : btnTogglePlaylists);

      if (btnTogglePresets) btnTogglePresets.classList.toggle('active', isPresets);
      if (btnTogglePlaylists) btnTogglePlaylists.classList.toggle('active', !isPresets);
      railDrawer.classList.toggle('drawer-presets-mode', isPresets);

      if (activeDrawerMode === null) {
        activeDrawerMode = openDrawerState;
        if (railDrawerCloseTimeout) {
          clearTimeout(railDrawerCloseTimeout);
          railDrawerCloseTimeout = null;
        }
        railDrawer.classList.remove('hidden');
        void railDrawer.offsetWidth;
        railDrawer.classList.add('open');
        if (sectionPresets) sectionPresets.style.display = isPresets ? 'flex' : 'none';
        if (sectionPlaylists) sectionPlaylists.style.display = isPresets ? 'none' : 'flex';
        if (drawerTitle) drawerTitle.textContent = isPresets ? 'Presets' : 'Playlists';
        if (el.btnSavePresetDialog) el.btnSavePresetDialog.style.display = isPresets ? 'inline-flex' : 'none';
        if (el.btnNewPlaylist) el.btnNewPlaylist.style.display = isPresets ? 'none' : 'inline-flex';
        if (sidebarEl) sidebarEl.classList.add('has-drawer-open');
        if (isPresets) {
          renderPresets();
          requestAnimationFrame(updatePresetsFade);
        } else {
          renderPlaylistsList();
        }
      } else if (activeDrawerMode !== openDrawerState) {
        activeDrawerMode = openDrawerState;
        const outgoing = isPresets ? sectionPlaylists : sectionPresets;
        const incoming = isPresets ? sectionPresets : sectionPlaylists;

        if (outgoing) outgoing.classList.add('section-switching-out');
        setTimeout(() => {
          if (outgoing) {
            outgoing.style.display = 'none';
            outgoing.classList.remove('section-switching-out');
          }
          if (drawerTitle) drawerTitle.textContent = isPresets ? 'Presets' : 'Playlists';
          railDrawer.classList.toggle('drawer-presets-mode', isPresets);
          if (el.btnSavePresetDialog) el.btnSavePresetDialog.style.display = isPresets ? 'inline-flex' : 'none';
          if (el.btnNewPlaylist) el.btnNewPlaylist.style.display = isPresets ? 'none' : 'inline-flex';
          if (incoming) {
            incoming.style.display = 'flex';
            incoming.classList.add('section-switching-in');
            setTimeout(() => incoming.classList.remove('section-switching-in'), 200);
            if (isPresets) {
              renderPresets();
              requestAnimationFrame(updatePresetsFade);
            } else {
              renderPlaylistsList();
            }
          }
        }, 120);
      }
    }
  }

  function openDrawer(mode, triggerBtn) {
    openDrawerState = mode;
    applyDrawerState(triggerBtn);
  }

  function closeDrawer() {
    openDrawerState = null;
    applyDrawerState();
  }

  if (btnTogglePresets) {
    btnTogglePresets.addEventListener('click', (e) => {
      e.stopPropagation();
      openDrawerState = openDrawerState === 'presets' ? null : 'presets';
      applyDrawerState(btnTogglePresets);
    });
  }

  if (btnTogglePlaylists) {
    btnTogglePlaylists.addEventListener('click', (e) => {
      e.stopPropagation();
      openDrawerState = openDrawerState === 'playlists' ? null : 'playlists';
      applyDrawerState(btnTogglePlaylists);
    });
  }

  if (btnCloseDrawer) {
    btnCloseDrawer.addEventListener('click', () => closeDrawer());
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openDrawerState) closeDrawer();
  });

  const resumeAudioOnce = () => {
    initAudioContext();
    document.removeEventListener('click', resumeAudioOnce);
    document.removeEventListener('keydown', resumeAudioOnce);
  };
  document.addEventListener('click', resumeAudioOnce);
  document.addEventListener('keydown', resumeAudioOnce);

  document.addEventListener('click', (e) => {
    if (openDrawerState && railDrawer) {
      if (!railDrawer.contains(e.target) &&
        (!btnTogglePresets || !btnTogglePresets.contains(e.target)) &&
        (!btnTogglePlaylists || !btnTogglePlaylists.contains(e.target))) {
        closeDrawer();
      }
    }
  });

  const PRESS_MIN = 180;
  document.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('button, .chip-btn, .mix-card, .track-row, .rail-icon-btn, .preset-chip');
    if (!el) return;
    el.classList.add('pressed');
    const t0 = performance.now();
    const release = () => {
      document.removeEventListener('pointerup', release, true);
      document.removeEventListener('pointercancel', release, true);
      setTimeout(() => el.classList.remove('pressed'), Math.max(0, PRESS_MIN - (performance.now() - t0)));
    };
    document.addEventListener('pointerup', release, true);
    document.addEventListener('pointercancel', release, true);
  }, true);

  const RIPPLE_SEL = '.btn-pill-primary, .btn-outline-pill, .btn-icon-pill, .chip-btn, .control-btn, .rail-icon-btn, .preset-chip, .theme-mode-btn, .nav-item, .settings-nav-btn, .audio-tab, .titlebar-btn, .mix-card, .track-row';
  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || document.body.classList.contains('perf')) return;
    const el = e.target.closest(RIPPLE_SEL);
    if (!el || el.disabled) return;
    let host = el.querySelector(':scope > .ripple-host');
    if (!host) {
      if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
      host = document.createElement('span'); host.className = 'ripple-host'; el.appendChild(host);
    }
    const r = el.getBoundingClientRect();
    const size = Math.hypot(Math.max(e.clientX - r.left, r.right - e.clientX), Math.max(e.clientY - r.top, r.bottom - e.clientY)) * 2;
    const d = document.createElement('span'); d.className = 'ripple';
    d.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - r.left - size / 2}px;top:${e.clientY - r.top - size / 2}px`;
    host.appendChild(d);
    d.addEventListener('animationend', () => d.remove());
  }, true);

  function openTrackRenameDialog() {
    const currentTitle = state.currentTrack?.title || '';
    const currentArtist = state.currentTrack?.artist || '';

    if (el.inputRenameTitle) el.inputRenameTitle.value = currentTitle;
    if (el.inputRenameArtist) el.inputRenameArtist.value = currentArtist;
    if (el.renameTrackModal) openModal(el.renameTrackModal);
    if (el.inputRenameTitle) el.inputRenameTitle.focus();
  }

  if (el.btnEditCurrentTrack) el.btnEditCurrentTrack.addEventListener('click', openTrackRenameDialog);
  if (el.btnCancelRenameTrack) el.btnCancelRenameTrack.addEventListener('click', () => {
    state.renamingTrack = null;
    closeModal(el.renameTrackModal);
  });

  if (el.btnConfirmRenameTrack) {
    el.btnConfirmRenameTrack.addEventListener('click', () => {
      const newTitle = el.inputRenameTitle ? el.inputRenameTitle.value.trim() || 'Untitled track' : 'Untitled track';
      const newArtist = el.inputRenameArtist ? el.inputRenameArtist.value.trim() || 'Unknown artist' : 'Unknown artist';

      const targetTrack = state.renamingTrack || state.currentTrack;
      if (targetTrack) {
        saveTrackRename(getTrackCanonicalId(targetTrack), newTitle, newArtist);
        targetTrack.title = newTitle;
        targetTrack.artist = newArtist;
      }

      if (state.currentTrack && targetTrack && (state.currentTrack === targetTrack || isSameTrack(state.currentTrack, targetTrack))) {
        state.currentTrack.title = newTitle;
        state.currentTrack.artist = newArtist;
        updateNowPlayingUI(state.currentTrack);
      }

      const updateArr = (arr) => {
        let updated = false;
        if (!Array.isArray(arr)) return false;
        const curCid = targetTrack ? getTrackCanonicalId(targetTrack) : '';
        arr.forEach(t => {
          if ((targetTrack?.id && t.id === targetTrack.id) || (curCid && getTrackCanonicalId(t) === curCid)) {
            t.title = newTitle;
            t.artist = newArtist;
            updated = true;
          }
        });
        return updated;
      };

      if (updateArr(state.history)) localStorage.setItem('devsize_history', JSON.stringify(state.history));
      if (updateArr(state.favorites)) localStorage.setItem('devsize_favorites', JSON.stringify(state.favorites.map(sanitizeTrackForStorage)));
      if (updateArr(state.queue)) renderQueueView();

      if (Array.isArray(state.playlists)) {
        let plChanged = false;
        state.playlists.forEach(pl => {
          if (Array.isArray(pl.tracks) && updateArr(pl.tracks)) plChanged = true;
        });
        if (plChanged) localStorage.setItem('devsize_playlists', JSON.stringify(state.playlists));
      }

      sendStateToServer();
      sendDiscordRpcUpdate(state.currentTrack, state.isPlaying);
      updateMediaSession();

      if (el.renameTrackModal) closeModal(el.renameTrackModal);
      state.renamingTrack = null;
      showToast('Track info updated', 'info');
    });
  }

  const audioEngine = new window.EclipseAudioEngine();
  window.audioEngine = audioEngine;
  window.state = state;
  window.el = el;
  window.showToast = showToast;
  window.t = t;
  window.safeJson = safeJson;
  window.safeArray = safeArray;
  window.openModal = openModal;
  window.closeModal = closeModal;
  window.playTrack = playTrack;
  window.switchView = switchView;
  window.formatDuration = formatDuration;
  window.normalizeTrackMeta = normalizeTrackMeta;
  window.getTrackCanonicalId = getTrackCanonicalId;
  window.isSameTrack = isSameTrack;
  window.getConfiguredAudioQuality = getConfiguredAudioQuality;
  window.abortAutoMixIfActive = abortAutoMixIfActive;
  window.pauseSmooth = pauseSmooth;
  window.playSmooth = playSmooth;
  window.playNext = playNext;
  window.playPrev = playPrev;
  window.updateNowPlayingUI = updateNowPlayingUI;
  window.syncSettingsSlidersToState = syncSettingsSlidersToState;
  window.applyI18n = applyI18n;
  window.escapeHtml = escapeHtml;
  window.tSet = tSet;
  window.normalizePreset = normalizePreset;
  window.ensureSfFontLoaded = ensureSfFontLoaded;
  window.sendStateToServer = sendStateToServer;
  window.updateMediaPositionState = updateMediaPositionState;
  window.handleMediaCommand = handleMediaCommand;
  window.getTrackTrim = getTrackTrim;
  window.getTrackArt = getTrackArt;
  window.applyTrackRenames = applyTrackRenames;
  window.isTrackPreloadValid = isTrackPreloadValid;
  window.preloadNextTrackStream = preloadNextTrackStream;
  window.togglePlayPause = togglePlayPause;
  window.recordSearchTrack = recordSearchTrack;
  window.recordSearchArtist = recordSearchArtist;
  window.refreshStacks = refreshStacks;
  window.setPlayPauseState = setPlayPauseState;
  window.updatePlayPauseButton = updatePlayPauseButton;
  window.goHome = goHome;
  window.setPlatform = setPlatform;
  window.getTrackLyricsOffsetSec = getTrackLyricsOffsetSec;
  window.syncLyricsOffsetUI = syncLyricsOffsetUI;
  window.openDownloadModal = openDownloadModal;
  window.openDownloadAllModal = openDownloadAllModal;
  window.getTrackNormalizedKey = getTrackNormalizedKey;
  window.recordWaveSkip = recordWaveSkip;
  window.isArtistBlocked = isArtistBlocked;
  window.isTrackBlocked = isTrackBlocked;
  window.toggleBlockArtist = toggleBlockArtist;
  window.toggleBlockTrack = toggleBlockTrack;
  window.getCoverDominantColors = getCoverDominantColors;
  window.scrollCarouselTo = scrollCarouselTo;
  window.renderHomeCarousel = renderHomeCarousel;
  window.fetchPersonalVibe = fetchPersonalVibe;
  window.getLocalDateString = getLocalDateString;
  window.generateDailyMixes = generateDailyMixes;
  window.renderSpotifyHome = renderSpotifyHome;
  window.applySearchFilter = applySearchFilter;
  window.updateNavIndicator = updateNavIndicator;
  window.getReliableTrackDuration = getReliableTrackDuration;
  window.defaultPresets = defaultPresets;
  window.SF_FONT_STACK = SF_FONT_STACK;
  window.RTL_UI_LANGS = RTL_UI_LANGS;
  [
    ['soundPersistenceEnabled', () => soundPersistenceEnabled, v => { soundPersistenceEnabled = v; }],
    ['isDraggingScrubber', () => isDraggingScrubber, v => { isDraggingScrubber = v; }],
    ['isDraggingTvkSeek', () => isDraggingTvkSeek, v => { isDraggingTvkSeek = v; }],
    ['isPauseFading', () => isPauseFading, v => { isPauseFading = v; }],
    ['frozenCurTime', () => frozenCurTime, v => { frozenCurTime = v; }],
    ['lyricsScrollRaf', () => lyricsScrollRaf, v => { lyricsScrollRaf = v; }],
    ['gradientRaf', () => gradientRaf, v => { gradientRaf = v; }],
    ['currentAlbumPlayRunId', () => currentAlbumPlayRunId, v => { currentAlbumPlayRunId = v; }],
    ['homeMode', () => homeMode, v => { homeMode = v; }],
    ['currentSearchFilter', () => currentSearchFilter, v => { currentSearchFilter = v; }],
    ['trackToDownload', () => trackToDownload, v => { trackToDownload = v; }],
    ['trimDraft', () => trimDraft, v => { trimDraft = v; }],
    ['EQ_BAND_LABELS', () => EQ_BAND_LABELS, null],
    ['LYRICS_SOURCE_NAMES', () => LYRICS_SOURCE_NAMES, null],
    ['ICON_PACKS', () => ICON_PACKS, null],
    ['nextTrackCoordinator', () => nextTrackCoordinator, null],
    ['m3c', () => m3c, v => { m3c = v; }],
    ['syncState', () => syncState, v => { syncState = v; }]
  ].forEach(([k, get, set]) => {
    if (!Object.prototype.hasOwnProperty.call(window, k)) {
      const safeGet = () => { try { return get(); } catch (_) { return undefined; } };
      Object.defineProperty(window, k, set ? { get: safeGet, set, configurable: true } : { get: safeGet, configurable: true });
    }
  });
  if (typeof initLibraryReordering === 'function') initLibraryReordering();
  let hlsInstance = null;
  animationFrameId = null;

  syncSettingsSlidersToState();
  updateHqRouting();
  renderPresets();


  if (reducedMotionMql) {
    const onReducedChange = (ev) => {
      prefersReducedMotion = !!(ev && ev.matches);
      if (isReducedMotionActive()) {
        window._automixRainbowBlend = 0;
        window._automixRainbowLastMs = 0;
      }
    };
    if (typeof reducedMotionMql.addEventListener === 'function') {
      reducedMotionMql.addEventListener('change', onReducedChange);
    } else if (typeof reducedMotionMql.addListener === 'function') {
      reducedMotionMql.addListener(onReducedChange);
    }
  }
  window.addEventListener('resize', resizeCanvases);
  setTimeout(resizeCanvases, 100);

  document.addEventListener('visibilitychange', () => {
    handleVisibilityChange(!document.hidden);
  });

  if (window.electronAPI && window.electronAPI.onWindowVisibility) {
    window.electronAPI.onWindowVisibility(visible => handleVisibilityChange(visible));
  }

  const setUnfocused = (unfocused) => {
    if (unfocused === document.body.classList.contains('unfocused')) return;
    document.body.classList.toggle('unfocused', unfocused);
  };
  window.addEventListener('blur', () => setUnfocused(true));
  window.addEventListener('focus', () => setUnfocused(false));

  setInterval(() => {
    window.electronAPI?.clearWebFrameCache?.();
  }, 3 * 60 * 1000);

  const EQ_BAND_LABELS = ['32', '64', '125', '250', '500', '1k', '2k', '4k', '8k', '16k'];

  function syncSettingsSlidersToState() {
    const s = state.audioSettings;
    const updateWrap = (input) => {
      if (!input) return;
      const wrap = input.closest('.sl');
      if (wrap) {
        const min = input.min === '' ? 0 : parseFloat(input.min);
        const max = input.max === '' ? 100 : parseFloat(input.max);
        const rawRatio = max > min ? (parseFloat(input.value) - min) / (max - min) : 0;
        wrap.style.setProperty('--v', rawRatio);
      }
    };

    if (el.sliderSpeed) { el.sliderSpeed.value = s.speed; updateWrap(el.sliderSpeed); }
    if (el.valSpeed) el.valSpeed.textContent = `${s.speed.toFixed(2)}x`;

    if (el.sliderSpeedPitch) { el.sliderSpeedPitch.value = s.speedPitch; updateWrap(el.sliderSpeedPitch); }
    if (el.valSpeedPitch) el.valSpeedPitch.textContent = `${s.speedPitch.toFixed(2)}x`;

    if (el.sliderPitch) { el.sliderPitch.value = s.pitch; updateWrap(el.sliderPitch); }
    if (el.valPitch) el.valPitch.textContent = `${s.pitch > 0 ? '+' : ''}${s.pitch} st`;

    if (el.sliderReverb) { el.sliderReverb.value = s.reverb; updateWrap(el.sliderReverb); }
    if (el.valReverb) el.valReverb.textContent = `${s.reverb}%`;

    if (el.sliderDistortion) { el.sliderDistortion.value = s.distortion; updateWrap(el.sliderDistortion); }
    if (el.valDistortion) el.valDistortion.textContent = `${s.distortion}%`;

    if (el.sliderGain) { el.sliderGain.value = Math.round(s.volume * 100); updateWrap(el.sliderGain); }
    if (el.valGain) el.valGain.textContent = `${Math.round(s.volume * 100)}%`;

    if (el.sliderEcho) { el.sliderEcho.value = s.echo; updateWrap(el.sliderEcho); }
    if (el.valEcho) el.valEcho.textContent = `${s.echo}%`;

    const eq = s.eq || { low: 0, mid: 0, high: 0 };
    if (el.sliderEqLow) { el.sliderEqLow.value = eq.low; updateWrap(el.sliderEqLow); }
    if (el.valEqLow) el.valEqLow.textContent = `${eq.low > 0 ? '+' : ''}${eq.low} dB`;
    if (el.sliderEqMid) { el.sliderEqMid.value = eq.mid; updateWrap(el.sliderEqMid); }
    if (el.valEqMid) el.valEqMid.textContent = `${eq.mid > 0 ? '+' : ''}${eq.mid} dB`;
    if (el.sliderEqHigh) { el.sliderEqHigh.value = eq.high; updateWrap(el.sliderEqHigh); }
    if (el.valEqHigh) el.valEqHigh.textContent = `${eq.high > 0 ? '+' : ''}${eq.high} dB`;

    const bands = s.eqBands || [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    if (el.eqBands) {
      const inputs = el.eqBands.querySelectorAll('.eq-band-range');
      const valLabels = el.eqBands.querySelectorAll('.eq-band-val');
      inputs.forEach((input, i) => {
        const v = bands[i] !== undefined ? bands[i] : 0;
        input.value = v;
        updateWrap(input);
        if (valLabels[i]) valLabels[i].textContent = `${v > 0 ? '+' : ''}${v} dB`;
      });
    }

    if (state.hqSettings) {
      if (el.sliderHqVocal) { el.sliderHqVocal.value = state.hqSettings.vocal; updateWrap(el.sliderHqVocal); if (el.valHqVocal) el.valHqVocal.textContent = `${state.hqSettings.vocal > 0 ? '+' : ''}${state.hqSettings.vocal}%`; }
      if (el.sliderHqAir) { el.sliderHqAir.value = state.hqSettings.air; updateWrap(el.sliderHqAir); if (el.valHqAir) el.valHqAir.textContent = `${state.hqSettings.air > 0 ? '+' : ''}${state.hqSettings.air}%`; }
      if (el.sliderHqBass) { el.sliderHqBass.value = state.hqSettings.bass; updateWrap(el.sliderHqBass); if (el.valHqBass) el.valHqBass.textContent = `${state.hqSettings.bass > 0 ? '+' : ''}${state.hqSettings.bass}%`; }
      if (el.hqPresetChips) el.hqPresetChips.forEach(c => c.classList.toggle('active', c.dataset.preset === state.hqSettings.preset));
    }
  }

  let _lastUiQueueIndex = -1;
  let _lastUiTrackId = null;
  function updateNowPlayingUI(track) {
    const curIdx = typeof state.queueIndex === 'number' ? state.queueIndex : -1;
    const curId = track && (track.videoId || track.id || track.title) || null;
    const isTrackChanged = curId && curId !== _lastUiTrackId;
    const idxDelta = (_lastUiQueueIndex >= 0 && curIdx >= 0) ? (curIdx - _lastUiQueueIndex) : 0;
    const isAdjacent = Math.abs(idxDelta) === 1;
    _lastUiQueueIndex = curIdx;
    _lastUiTrackId = curId;
    if (isTrackChanged && el.coverContainer && isAdjacent && !document.body.classList.contains('perf')) {
      el.coverContainer.classList.remove('np-slide-next', 'np-slide-prev');
      void el.coverContainer.offsetWidth;
      el.coverContainer.classList.add(idxDelta > 0 ? 'np-slide-next' : 'np-slide-prev');
    }
    if (isTrackChanged && document.body.classList.contains('mini') && !document.body.classList.contains('perf')) {
      const metaEl = document.querySelector('.playbar-left .track-meta');
      if (metaEl) {
        metaEl.classList.remove('mini-track-enter');
        void metaEl.offsetWidth;
        metaEl.classList.add('mini-track-enter');
      }
    }
    if (el.playbarTitle) {
      el.playbarTitle.textContent = track.title || 'Untitled';
      el.playbarTitle.dataset.origTitle = track.title || '';
    }
    if (el.playbarArtist) {
      renderClickableArtists(el.playbarArtist, track.artist);
      if (typeof isTrackExplicit === 'function' && isTrackExplicit(track)) {
        const badge = document.createElement('span');
        badge.className = 'explicit-badge';
        badge.title = 'Explicit';
        badge.textContent = 'E';
        el.playbarArtist.prepend(badge);
      }
    }

    const thumb = getTrackThumbUrl(track);
    if (thumb) {
      if (el.playbarArtwork) {
        el.playbarArtwork.onload = () => {
          if (state.currentTrack && 'mediaSession' in navigator && navigator.mediaSession.metadata) {
            const curThumb = (typeof getTrackThumbUrl === 'function' ? getTrackThumbUrl(state.currentTrack) : '') || state.currentTrack.thumbnail || '';
            const art = getMediaArtwork(curThumb);
            if (art.length > 0) {
              navigator.mediaSession.metadata.artwork = art;
            }
          }
        };
        const isArtReduced = document.body.classList.contains('perf') || (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
        if (el.playbarArtwork.src !== thumb && !isArtReduced) {
          el.playbarArtwork.classList.add('artwork-fading');
          requestAnimationFrame(() => {
            el.playbarArtwork.src = thumb;
            if (typeof m3cSetImage === 'function') m3cSetImage(thumb);
            el.playbarArtwork.style.display = 'block';
            requestAnimationFrame(() => el.playbarArtwork.classList.remove('artwork-fading'));
          });
        } else {
          el.playbarArtwork.src = thumb;
          if (typeof m3cSetImage === 'function') m3cSetImage(thumb);
          el.playbarArtwork.style.display = 'block';
        }
        el.playbarArtwork.onerror = () => {
          if (state.currentTrack && getTrackArt(state.currentTrack).cover) {
            setTrackArt(state.currentTrack, { cover: undefined });
            const defThumb = state.currentTrack.thumbnail || '';
            el.playbarArtwork.src = defThumb;
            if (typeof m3cSetImage === 'function') m3cSetImage(defThumb);
            if (el.rightPanelCover) el.rightPanelCover.src = defThumb;
            updateRightPanelBanner(defThumb);
            updateThemeFromState();
            return;
          }
          el.playbarArtwork.style.display = 'none';
          if (el.artworkFallback) el.artworkFallback.style.display = 'flex';
        };
      }
      if (el.artworkFallback) el.artworkFallback.style.display = 'none';
      if (el.rightPanelCover) {
        el.rightPanelCover.src = thumb;
        el.rightPanelCover.style.display = 'block';
        el.rightPanelCover.onerror = () => {
          if (state.currentTrack && getTrackArt(state.currentTrack).cover) {
            setTrackArt(state.currentTrack, { cover: undefined });
            const defThumb = state.currentTrack.thumbnail || '';
            el.rightPanelCover.src = defThumb;
            if (el.playbarArtwork) {
              el.playbarArtwork.src = defThumb;
              if (typeof m3cSetImage === 'function') m3cSetImage(defThumb);
            }
            updateRightPanelBanner(defThumb);
            updateThemeFromState();
            return;
          }
          el.rightPanelCover.style.display = 'none';
          if (el.rightPanelFallback) el.rightPanelFallback.style.display = 'flex';
        };
      }
      if (el.rightPanelFallback) el.rightPanelFallback.style.display = 'none';
    } else {
      if (el.playbarArtwork) el.playbarArtwork.style.display = 'none';
      if (typeof m3cSetImage === 'function') m3cSetImage('');
      if (el.artworkFallback) el.artworkFallback.style.display = 'flex';
      if (el.rightPanelCover) el.rightPanelCover.style.display = 'none';
      if (el.rightPanelFallback) el.rightPanelFallback.style.display = 'flex';
    }

    if (el.rightPanelTitle) el.rightPanelTitle.textContent = track.title || 'Untitled';
    if (el.rightPanelArtist) {
      renderClickableArtists(el.rightPanelArtist, track.artist);
      if (typeof isTrackExplicit === 'function' && isTrackExplicit(track)) {
        const badge = document.createElement('span');
        badge.className = 'explicit-badge';
        badge.title = 'Explicit';
        badge.textContent = 'E';
        el.rightPanelArtist.prepend(badge);
      }
    }

    if (el.btnPlaybarMore) el.btnPlaybarMore.style.display = track.platform === 'local' ? 'none' : '';
    if (el.timeDuration && track && track.duration) el.timeDuration.textContent = formatDuration(track.duration);

    updateRightPanelBanner(thumb);
    refreshMeshCover();
    setCoverBg(thumb);
    syncTvkAmbientBg();
    updateFavoriteIcon();
    applyVisualEffects();
    highlightPlayingRow();
    updateThemeFromState();
    updateMediaSession();
    if (state.isTvKaraokeOpen) updateTvKaraokeMeta();
  }

  function updateRightPanelBanner(thumbUrl) {
    const banner = document.getElementById('right-panel-banner');
    if (!banner) return;
    if (!getAdv('banners', true) || !getAdv('track_banners', true)) {
      banner.style.display = 'none';
      if (state.isTvKaraokeOpen) syncTvBanner();
      return;
    }
    banner.style.display = '';
    const bannerImg = banner.querySelector('.banner-image') || banner;
    const trackArt = state.currentTrack ? getTrackArt(state.currentTrack) : {};
    const trackBanner = trackArt.banner || null;
    const globalMedia = localStorage.getItem('eclipse_banner_media');
    const mediaToUse = trackBanner || globalMedia || thumbUrl;

    const hasCustomFx = !!(trackArt.bannerCustomFx || (trackArt.bannerFx && trackArt.bannerFx.enabled));
    if (hasCustomFx) {
      const isPerf = document.body.classList.contains('perf');
      const bBlur = isPerf ? 0 : (trackArt.bannerBlur !== undefined ? trackArt.bannerBlur : (trackArt.bannerFx && trackArt.bannerFx.blur !== undefined ? trackArt.bannerFx.blur : 3));
      const bOpacity = trackArt.bannerOpacity !== undefined ? (trackArt.bannerOpacity / 100) : (trackArt.bannerFx && trackArt.bannerFx.opacity !== undefined ? (trackArt.bannerFx.opacity / 100) : 1);
      const bFade = trackArt.bannerFade !== undefined ? trackArt.bannerFade : (trackArt.bannerFx && trackArt.bannerFx.fade !== undefined ? trackArt.bannerFx.fade : 100);
      banner.style.setProperty('--banner-blur', `${bBlur}px`);
      banner.style.setProperty('--banner-opacity', `${bOpacity}`);
      banner.style.setProperty('--banner-fade-base', `${bFade}%`);
      banner.style.setProperty('--banner-fade-end', `${bFade}%`);
    } else {
      banner.style.removeProperty('--banner-blur');
      banner.style.removeProperty('--banner-opacity');
      banner.style.removeProperty('--banner-fade-base');
      banner.style.removeProperty('--banner-fade-end');
    }

    if (!mediaToUse) {
      banner.classList.add('fading-out');
      setTimeout(() => {
        bannerImg.style.backgroundImage = 'none';
        const vid = banner.querySelector('video.banner-video');
        if (vid) vid.remove();
        banner.style.opacity = '0';
        banner.classList.remove('fading-out');
        if (state.isTvKaraokeOpen) syncTvBanner();
      }, 300);
      if (state.isTvKaraokeOpen) syncTvBanner();
      return;
    }

    const isVideo = /\.(mp4|webm)($|\?)/i.test(mediaToUse);
    if (isVideo) {
      bannerImg.style.backgroundImage = 'none';
      let vid = banner.querySelector('video.banner-video');
      if (!vid) {
        vid = document.createElement('video');
        vid.className = 'banner-video';
        vid.autoplay = true;
        vid.loop = true;
        vid.muted = true;
        vid.playsInline = true;
        banner.appendChild(vid);
      }
      vid.onerror = () => {
        if (trackBanner && state.currentTrack) {
          setTrackArt(state.currentTrack, { banner: undefined });
          updateRightPanelBanner(thumbUrl);
        } else {
          banner.style.opacity = '0';
          if (state.isTvKaraokeOpen) syncTvBanner();
        }
      };
      if (vid.src !== mediaToUse) {
        vid.src = mediaToUse;
        vid.play().catch(() => {});
      }
      banner.style.opacity = '1';
      if (state.isTvKaraokeOpen) syncTvBanner();
      return;
    }

    const vid = banner.querySelector('video.banner-video');
    if (vid) vid.remove();

    const img = new Image();
    img.src = mediaToUse;
    img.onload = () => {
      banner.classList.add('fading-out');
      setTimeout(() => {
        bannerImg.style.backgroundImage = `url("${mediaToUse}")`;
        banner.classList.remove('fading-out');
        banner.style.opacity = '1';
        if (state.isTvKaraokeOpen) syncTvBanner();
      }, 150);
    };
    img.onerror = () => {
      if (trackBanner && state.currentTrack) {
        setTrackArt(state.currentTrack, { banner: undefined });
        updateRightPanelBanner(thumbUrl);
      } else {
        banner.style.opacity = '0';
        if (state.isTvKaraokeOpen) syncTvBanner();
      }
    };
    if (state.isTvKaraokeOpen) syncTvBanner();
  }

  function updatePlaylistDetailBanner(thumbUrl) {
    const banner = document.getElementById('playlist-header-banner');
    if (!banner) return;
    if (!getAdv('banners', true)) {
      banner.style.display = 'none';
      return;
    }
    banner.style.display = '';
    const bannerImg = banner.querySelector('.banner-image') || banner;
    const globalMedia = localStorage.getItem('eclipse_banner_media');
    const mediaToUse = globalMedia || thumbUrl;

    if (!mediaToUse) {
      banner.style.opacity = '0';
      bannerImg.style.backgroundImage = 'none';
      const vid = banner.querySelector('video.banner-video');
      if (vid) vid.remove();
      return;
    }

    const isVideo = /\.(mp4|webm)($|\?)/i.test(mediaToUse);
    if (isVideo) {
      bannerImg.style.backgroundImage = 'none';
      let vid = banner.querySelector('video.banner-video');
      if (!vid) {
        vid = document.createElement('video');
        vid.className = 'banner-video';
        vid.autoplay = true;
        vid.loop = true;
        vid.muted = true;
        vid.playsInline = true;
        banner.appendChild(vid);
      }
      if (vid.src !== mediaToUse) {
        vid.src = mediaToUse;
        vid.play().catch(() => {});
      }
      banner.style.opacity = '1';
      return;
    }

    const vid = banner.querySelector('video.banner-video');
    if (vid) vid.remove();

    const img = new Image();
    img.src = mediaToUse;
    img.onload = () => {
      bannerImg.style.backgroundImage = `url("${mediaToUse}")`;
      banner.style.opacity = '1';
    };
    img.onerror = () => {
      banner.style.opacity = '0';
    };
  }

  function getTrackCanonicalId(track) {
    if (!track) return '';
    const platform = track.platform || state.platform || 'yt';
    if (track.id) return `${platform}:${track.id}`;
    if (track.url || track.videoId) return `${platform}:${track.url || track.videoId}`;
    const t = (track.title || '').trim().toLowerCase();
    const a = (track.artist || '').trim().toLowerCase();
    const d = Math.round(Number(track.duration) || 0);
    return `${platform}:${t}|${a}|${d}`;
  }

  function isSameTrack(a, b) {
    if (!a || !b) return false;
    return getTrackCanonicalId(a) === getTrackCanonicalId(b);
  }

  function getTrackTrims() { return safeJson('eclipse_track_trims', {}); }
  function getTrackTrim(track) {
    if (!track) return null;
    const cid = getTrackCanonicalId(track);
    return cid ? (getTrackTrims()[cid] || null) : null;
  }
  function saveTrackTrim(track, startSec, endSec, totalDur) {
    if (!track) return;
    const cid = getTrackCanonicalId(track);
    if (!cid) return;
    const all = getTrackTrims();
    if (startSec <= 0.15 && (!endSec || endSec >= totalDur - 0.25)) {
      delete all[cid];
    } else {
      all[cid] = { start: Math.round(startSec * 10) / 10, end: Math.round(endSec * 10) / 10, updatedAt: Date.now() };
    }
    try { localStorage.setItem('eclipse_track_trims', JSON.stringify(all)); } catch (_) {}
  }

  function getTrackArt(t) {
    try {
      return JSON.parse(localStorage.getItem('eclipse_track_art') || '{}')[getTrackCanonicalId(t)] || {};
    } catch (e) {
      return {};
    }
  }

  function setTrackArt(t, patch) {
    let all = {};
    try {
      all = JSON.parse(localStorage.getItem('eclipse_track_art') || '{}');
    } catch (e) {}
    const id = getTrackCanonicalId(t);
    if (!id) return;
    const cur = { ...(all[id] || {}), ...patch };
    for (const k in cur) if (cur[k] === undefined || cur[k] === null || cur[k] === '') delete cur[k];
    if (Object.keys(cur).length) all[id] = cur; else delete all[id];
    localStorage.setItem('eclipse_track_art', JSON.stringify(all));
  }

  function getTrackRenames() { return safeJson('eclipse_track_renames', {}); }
  function saveTrackRename(canonicalId, title, artist) {
    if (!canonicalId) return;
    const all = getTrackRenames();
    all[canonicalId] = { title, artist, updatedAt: Date.now() };
    try { localStorage.setItem('eclipse_track_renames', JSON.stringify(all)); } catch (_) {}
  }
  function applyTrackRenames(t) {
    if (!t) return t;
    const cid = getTrackCanonicalId(t);
    const r = getTrackRenames()[cid];
    if (r) { if (r.title) t.title = r.title; if (r.artist) t.artist = r.artist; }
    return t;
  }
  function getShareBaseUrl() {
    const custom = (localStorage.getItem('eclipse_share_base_url') || '').trim();
    if (custom) return custom.endsWith('/') ? custom : (custom + '/');
    return 'https://eclipse-player.vercel.app/share/';
  }

  function buildRiffShareUrl(track, directStream = '', resolvedUrl = '', maxLen = 0) {
    const baseUrl = getShareBaseUrl();
    if (!track) return baseUrl;
    applyTrackRenames(track);
    const isHttpUrl = (u) => typeof u === 'string' && (u.startsWith('http://') || u.startsWith('https://')) && !u.includes('127.0.0.1');
    const title = track.title || 'Untitled';
    const artist = track.artist || '';
    const fallbackYt = (track.id && track.platform !== 'soundcloud' && track.platform !== 'local') ? ('https://www.youtube.com/watch?v=' + track.id) : '';
    const trackUrl = resolvedUrl || (isHttpUrl(track.url) ? track.url : fallbackYt);
    const customArt = typeof getTrackArt === 'function' ? getTrackArt(track) : null;
    const rawThumb = (customArt && isHttpUrl(customArt.cover))
      ? customArt.cover
      : (track.thumbnail || track.cover || (typeof getTrackThumbUrl === 'function' ? getTrackThumbUrl(track) : '') || '');
    const params = new URLSearchParams();
    params.set('t', 'music');
    if (title) params.set('n', title);
    if (artist) params.set('a', artist);
    if (isHttpUrl(trackUrl)) params.set('url', trackUrl);
    if (directStream && isHttpUrl(directStream) && !directStream.includes('.m3u8')) params.set('stream', directStream);
    if (isHttpUrl(rawThumb)) params.set('img', rawThumb);
    if (track.duration) params.set('dur', String(Math.round(Number(track.duration))));
    let full = baseUrl + '?' + params.toString();
    if (maxLen > 0 && full.length > maxLen) {
      params.delete('stream');
      full = baseUrl + '?' + params.toString();
    }
    if (maxLen > 0 && full.length > maxLen) {
      params.delete('img');
      full = baseUrl + '?' + params.toString();
    }
    return maxLen > 0 ? full.slice(0, maxLen) : full;
  }

  let crossfadeTriggered = false;
  let crossfadeFadeInPending = false;
  let currentAlbumPlayRunId = 0;

  function pushPlayHistory(track) {
    if (!track) return;
    const h = state.playHistory || (state.playHistory = []);
    if (h.length && h[h.length - 1].id === track.id) return;
    h.push(track);
    if (h.length > 100) h.shift();
  }
  let navigatingBack = false;

  const lastfmState = {
    enabled: localStorage.getItem('eclipse_lastfm_enabled') !== 'false',
    sessionKey: localStorage.getItem('eclipse_lastfm_sk') || '',
    username: localStorage.getItem('eclipse_lastfm_user') || '',
    apiKey: localStorage.getItem('eclipse_lastfm_apikey') || '',
    apiSecret: localStorage.getItem('eclipse_lastfm_apisecret') || '',
    currentTrackKey: '',
    startedAtUnix: 0,
    playedSeconds: 0,
    lastTickTime: 0,
    scrobbled: false,
    nowPlayingSent: false,
    npTimer: null,
    pollTimer: null
  };

  function cleanLastFmMeta(track) {
    if (!track) return { artist: '', title: '', album: '' };
    if (typeof applyTrackRenames === 'function') applyTrackRenames(track);
    let title = String(track.title || '').trim();
    let artist = String(track.artist || '').replace(/VEVO$/i, '').trim();
    artist = stripYoutubeTopic(artist);
    const noiseRe = new RegExp('\\s*[\\(\\[]\\s*(?:official\\s*(?:music\\s*)?(?:video|audio|lyric\\s*video|visualizer)|lyrics?|audio|hd|hq|4k|remastered|explicit|clean|visualizer|mv|clip\\s*officiel|slowed(?:\\s*\\+\\s*reverb)?|sped\\s*up|nightcore)\\s*[\\)\\]]', 'gi');
    title = title.replace(noiseRe, '').trim();
    if (title.includes(' - ')) {
      const parts = title.split(' - ');
      const left = parts[0].trim();
      const right = parts.slice(1).join(' - ').trim();
      if (left && right && (!artist || artist.toLowerCase() === 'unknown artist' || !artist.toLowerCase().includes(left.toLowerCase()))) {
        artist = left;
        title = right;
      }
    }
    artist = stripYoutubeTopic(artist);
    if (typeof splitArtistTokens === 'function') {
      const toks = splitArtistTokens(artist).filter(t => t.type === 'artist');
      if (toks.length > 0 && toks[0].value) artist = toks[0].value;
    }
    return { artist: artist || 'Unknown Artist', title: title || 'Untitled', album: String(track.album || '').trim() };
  }

  function syncLastFmUI() {
    const statusEl = document.getElementById('lastfm-status-label');
    const toggleBtn = document.getElementById('btn-lastfm-toggle');
    const openBtn = document.getElementById('btn-lastfm-open-modal');
    const connBox = document.getElementById('lastfm-modal-connected-box');
    const authBox = document.getElementById('lastfm-modal-auth-box');
    const userEl = document.getElementById('lastfm-modal-user');
    const connected = !!(lastfmState.sessionKey && lastfmState.username);
    if (statusEl) {
      statusEl.textContent = connected
        ? (lastfmState.enabled ? ('Scrobbling as @' + lastfmState.username) : ('Paused (@' + lastfmState.username + ')'))
        : 'Not connected';
    }
    if (toggleBtn) toggleBtn.classList.toggle('active', connected && lastfmState.enabled);
    if (openBtn) openBtn.textContent = connected ? 'Account' : 'Connect';
    if (connBox) connBox.classList.toggle('hidden', !connected);
    if (authBox) authBox.style.display = connected ? 'none' : 'flex';
    if (userEl && connected) userEl.textContent = '@' + lastfmState.username;
  }

  async function sendLastFmNowPlaying(track) {
    if (!lastfmState.enabled || !lastfmState.sessionKey || !track) return;
    const meta = cleanLastFmMeta(track);
    if (!meta.title || !meta.artist) return;
    const dur = typeof getReliableTrackDuration === 'function' ? getReliableTrackDuration() : (track.duration || 0);
    try {
      const r = await fetch('http://127.0.0.1:' + (state.serverPort || 38472) + '/api/lastfm/now-playing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sk: lastfmState.sessionKey,
          apiKey: lastfmState.apiKey,
          apiSecret: lastfmState.apiSecret,
          artist: meta.artist,
          track: meta.title,
          album: meta.album,
          duration: dur
        })
      });
      const d = await r.json();
      if (d && d.success) {
        const statusEl = document.getElementById('lastfm-status-label');
        if (statusEl) statusEl.textContent = `Now playing: ${meta.artist} — ${meta.title} (@${lastfmState.username})`;
      }
    } catch (_) {}
  }

  async function sendLastFmScrobble(track, timestamp) {
    if (!lastfmState.enabled || !lastfmState.sessionKey || !track) return;
    const meta = cleanLastFmMeta(track);
    if (!meta.title || !meta.artist) return;
    const dur = typeof getReliableTrackDuration === 'function' ? getReliableTrackDuration() : (track.duration || 0);
    try {
      const r = await fetch('http://127.0.0.1:' + (state.serverPort || 38472) + '/api/lastfm/scrobble', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sk: lastfmState.sessionKey,
          apiKey: lastfmState.apiKey,
          apiSecret: lastfmState.apiSecret,
          artist: meta.artist,
          track: meta.title,
          album: meta.album,
          duration: dur,
          timestamp: timestamp || Math.floor(Date.now() / 1000)
        })
      });
      const d = await r.json();
      if (d && d.success) {
        const statusEl = document.getElementById('lastfm-status-label');
        if (statusEl) statusEl.textContent = `Scrobbled: ${meta.artist} — ${meta.title} (@${lastfmState.username})`;
      }
    } catch (_) {}
  }

  function onLastFmTrackStart(track) {
    if (!track) return;
    const key = (track.id || '') + '::' + (track.title || '') + '::' + (track.artist || '');
    if (lastfmState.currentTrackKey !== key) {
      lastfmState.currentTrackKey = key;
      lastfmState.startedAtUnix = Math.floor(Date.now() / 1000);
      lastfmState.playedSeconds = 0;
      lastfmState.scrobbled = false;
      lastfmState.nowPlayingSent = false;
    }
    lastfmState.lastTickTime = performance.now();
    if (lastfmState.npTimer) clearTimeout(lastfmState.npTimer);
    lastfmState.npTimer = setTimeout(() => {
      if (state.currentTrack && !el.nativeAudio?.paused && !lastfmState.nowPlayingSent) {
        lastfmState.nowPlayingSent = true;
        sendLastFmNowPlaying(state.currentTrack);
      }
    }, 1500);
  }

  function onLastFmTimeUpdate() {
    if (!lastfmState.enabled || !lastfmState.sessionKey || !state.currentTrack || !el.nativeAudio || el.nativeAudio.paused) {
      lastfmState.lastTickTime = performance.now();
      return;
    }
    if (!lastfmState.nowPlayingSent && el.nativeAudio.currentTime > 1.0) {
      lastfmState.nowPlayingSent = true;
      sendLastFmNowPlaying(state.currentTrack);
    }
    const now = performance.now();
    const dt = (now - (lastfmState.lastTickTime || now)) / 1000;
    lastfmState.lastTickTime = now;
    if (dt > 0 && dt < 2.5) {
      lastfmState.playedSeconds += dt;
    }
    if (lastfmState.scrobbled) {
      if (el.nativeAudio.currentTime < 3 && lastfmState.playedSeconds > 25) {
        lastfmState.currentTrackKey = '';
        onLastFmTrackStart(state.currentTrack);
      }
      return;
    }
    const dur = typeof getReliableTrackDuration === 'function' ? getReliableTrackDuration() : (state.currentTrack.duration || 0);
    const effDur = dur > 0 ? dur : 180;
    if (effDur < 25) return;
    const targetSeconds = Math.min(240, Math.max(25, effDur * 0.5));
    if (lastfmState.playedSeconds >= targetSeconds) {
      lastfmState.scrobbled = true;
      sendLastFmScrobble(state.currentTrack, lastfmState.startedAtUnix);
    }
  }

  let preloadedTrack10sFired = false;
  function warmUpNextAudioBuffer(streamUrl) {
    if (!streamUrl || typeof streamUrl !== 'string' || streamUrl.includes('.m3u8')) return;
    fetch(streamUrl, { headers: { 'Range': 'bytes=0-262143' } }).catch(() => {});
  }

  let _nextPreloadGeneration = 0;
  let _nextPreloadAbortController = null;

  function getConfiguredAudioQuality() {
    return (typeof localStorage !== 'undefined' && localStorage.getItem('eclipse_audio_quality')) || 'medium';
  }

  function isTrackPreloadValid(track, requestedQuality) {
    if (!track || !track._preloadedStreamUrl) return false;
    if (track._preloadedStreamUrlExpires && Date.now() >= track._preloadedStreamUrlExpires) return false;
    const reqQ = String(requestedQuality || getConfiguredAudioQuality()).trim().toLowerCase();
    if (track._preloadedStreamQuality !== reqQ) return false;
    const trackPlat = String(track.platform || 'ytmusic').trim().toLowerCase();
    if (track._preloadedStreamPlatform && track._preloadedStreamPlatform !== trackPlat) return false;
    return true;
  }

  function cancelActiveNextPreload(reason = 'queue_changed') {
    _nextPreloadGeneration += 1;
    if (_nextPreloadAbortController) {
      try { _nextPreloadAbortController.abort(reason); } catch (_) {}
      _nextPreloadAbortController = null;
    }
  }

  const nextTrackCoordinator = (typeof window !== 'undefined' && typeof window.NextTrackCoordinator === 'function')
    ? new window.NextTrackCoordinator({
        getState: () => state,
        getAutoMix: () => window.autoMixDjInstance || null,
        getTrackAnalyzer: () => window._eclipseTrackAnalyzer || null,
        getShuffleProvider: () => shuffleProvider,
        isTrackBlocked: (t) => typeof isTrackBlocked === 'function' ? isTrackBlocked(t) : false,
        isArtistBlocked: (a) => typeof isArtistBlocked === 'function' ? isArtistBlocked(a) : false,
        isSameTrack: (a, b) => typeof isSameTrack === 'function' ? isSameTrack(a, b) : !!(a && b && a.id === b.id),
        onCancel: (reason) => cancelActiveNextPreload(reason)
      })
    : null;
  if (typeof window !== 'undefined' && nextTrackCoordinator) {
    window._eclipseNextTrackCoordinator = nextTrackCoordinator;
  }

  async function resolveNextPreloadTarget() {
    if (!state.queue || state.queueIndex < 0) return null;
    if (nextTrackCoordinator) {
      const plan = await nextTrackCoordinator.reserve();
      return plan ? plan.track : null;
    }
    return state.queue[state.queueIndex + 1] || null;
  }

  async function preloadNextTrackStream(overrideTrack = null) {
    if (!state.queue || state.queueIndex < 0) return;
    const nextTrack = overrideTrack || await resolveNextPreloadTarget();
    if (!nextTrack || nextTrack.isCached || nextTrack.platform === 'local') return;
    const curQuality = getConfiguredAudioQuality();
    if (isTrackPreloadValid(nextTrack, curQuality)) {
      warmUpNextAudioBuffer(nextTrack._preloadedStreamUrl);
      return;
    }
    cancelActiveNextPreload('superseded');
    const myGen = _nextPreloadGeneration;
    const coordGen = nextTrackCoordinator ? nextTrackCoordinator.generation : 0;
    const controller = new AbortController();
    _nextPreloadAbortController = controller;
    try {
      const rawId = String(nextTrack.id || '').trim();
      const isRealYtId = /^[a-zA-Z0-9_-]{11}$/.test(rawId) && !/^(cand_|dz_|it_|sp_|ym_|alb_|local_|track_)/i.test(rawId);
      if (!isRealYtId && nextTrack.platform !== 'soundcloud' && (nextTrack.title || nextTrack.artist)) {
        const q = ((nextTrack.artist ? nextTrack.artist + ' - ' : '') + (nextTrack.title || '')).trim();
        if (q) {
          const sRes = await fetch(`http://127.0.0.1:${state.serverPort}/api/search?q=${encodeURIComponent(q)}&platform=ytmusic&limit=1`, { signal: controller.signal });
          const sData = await sRes.json();
          if (myGen !== _nextPreloadGeneration || (nextTrackCoordinator && nextTrackCoordinator.generation !== coordGen) || controller.signal.aborted) return;
          const hit = sData && Array.isArray(sData.tracks) && sData.tracks[0];
          if (hit && hit.id && /^[a-zA-Z0-9_-]{11}$/.test(hit.id)) {
            nextTrack.id = hit.id;
            nextTrack.url = hit.url || `https://www.youtube.com/watch?v=${hit.id}`;
            if (!nextTrack.thumbnail && hit.thumbnail) nextTrack.thumbnail = hit.thumbnail;
          }
        }
      }
      const qQuality = encodeURIComponent(curQuality);
      const qFallback = encodeURIComponent(nextTrack.searchQuery || ((nextTrack.artist ? nextTrack.artist + ' - ' : '') + (nextTrack.title || '')));
      const tokenParam = (window.electronAPI && window.electronAPI.serverToken) || (state && state.serverToken) || '';
      const fetchUrl = `http://127.0.0.1:${state.serverPort}/api/stream-info?id=${encodeURIComponent(nextTrack.id || '')}&url=${encodeURIComponent(nextTrack.url || '')}&platform=${encodeURIComponent(nextTrack.platform || 'ytmusic')}&title=${encodeURIComponent(nextTrack.title || '')}&artist=${encodeURIComponent(nextTrack.artist || '')}&duration=${encodeURIComponent(nextTrack.duration || 0)}&q=${qFallback}&quality=${qQuality}&prefetch=1&token=${encodeURIComponent(tokenParam)}`;
      const res = await fetch(fetchUrl, { signal: controller.signal });
      const data = await res.json();
      if (myGen !== _nextPreloadGeneration || (nextTrackCoordinator && nextTrackCoordinator.generation !== coordGen) || controller.signal.aborted) return;
      if (data && data.success && (data.proxyUrl || data.streamUrl)) {
        const chosenUrl = data.proxyUrl || data.streamUrl;
        nextTrack._preloadedStreamUrl = chosenUrl;
        nextTrack._preloadedStreamQuality = (data.resolvedQuality ? String(data.resolvedQuality).trim().toLowerCase() : curQuality);
        nextTrack._preloadedStreamPlatform = String(nextTrack.platform || 'ytmusic').trim().toLowerCase();
        nextTrack._preloadedStreamUrlExpires = Date.now() + 3600 * 1000;
        warmUpNextAudioBuffer(chosenUrl);
      }
    } catch (_) {
    } finally {
      if (_nextPreloadAbortController === controller) {
        _nextPreloadAbortController = null;
      }
    }
  }

  
  let currentTrackSponsorSegments = [];
  let lastSkippedSegmentEnd = -1;

    async function loadCanvasForTrack(track) {
    const vidEl = document.getElementById('canvas-video-bg');
    if (!vidEl) return;
    if (localStorage.getItem('eclipse_canvas_enabled') === '0' || !track) {
      vidEl.classList.remove('active');
      vidEl.classList.add('hidden');
      try { vidEl.pause(); vidEl.removeAttribute('src'); vidEl.load(); } catch (_) {}
      return;
    }
    const vid = track.id || track.videoId || '';
    const title = track.title || '';
    const artist = track.artist || '';
    try {
      const origin = typeof state !== 'undefined' && state.serverPort ? `http://127.0.0.1:${state.serverPort}` : (window.location && window.location.origin ? window.location.origin : 'http://127.0.0.1:3000');
      const res = await fetch(`${origin}/api/canvas?videoId=${encodeURIComponent(vid)}&title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}`);
      const data = await res.json();
      if (data && data.success && data.canvasUrl && data.isVideo) {
        if (vidEl.src !== data.canvasUrl) {
          vidEl.src = data.canvasUrl;
        }
        vidEl.classList.remove('hidden');
        vidEl.classList.add('active');
        vidEl.play().catch(() => {});
      } else {
        vidEl.classList.remove('active');
        vidEl.classList.add('hidden');
        try { vidEl.pause(); } catch (_) {}
      }
    } catch (_) {
      vidEl.classList.remove('active');
      vidEl.classList.add('hidden');
    }
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      const vidEl = document.getElementById('canvas-video-bg');
      if (!vidEl || !vidEl.src) return;
      if (document.hidden) {
        try { vidEl.pause(); } catch (_) {}
      } else if (vidEl.classList.contains('active')) {
        vidEl.play().catch(() => {});
      }
    });
  }

  async function loadSponsorBlockSegments(track) {
    currentTrackSponsorSegments = [];
    lastSkippedSegmentEnd = -1;
    if (localStorage.getItem('eclipse_sponsorblock_enabled') === '0') return;
    if (!track) return;
    const vid = track.id || track.videoId || '';
    if (typeof vid !== 'string' || vid.length !== 11) return;
    try {
      const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/sponsorblock?videoId=${encodeURIComponent(vid)}`);
      const data = await res.json();
      if (data && data.success && Array.isArray(data.segments)) {
        currentTrackSponsorSegments = data.segments;
        if (currentTrackSponsorSegments.length > 0) {
          console.log('[SponsorBlock] Loaded segments for track:', currentTrackSponsorSegments.length);
        }
      }
    } catch (_) {}
  }

  let audioLoadingTimer1 = null;
  let audioLoadingTimer2 = null;

  function showAudioLoadingState(track, msg = 'Đang kết nối luồng nhạc...') {
    state._isLoadingAudio = true;
    state._loadingTrackId = track ? track.id : null;

    if (audioLoadingTimer1) { clearTimeout(audioLoadingTimer1); audioLoadingTimer1 = null; }
    if (audioLoadingTimer2) { clearTimeout(audioLoadingTimer2); audioLoadingTimer2 = null; }

    const scrub = (el && el.scrubberLoadingBar) || document.getElementById('scrubber-loading-bar');
    const pill = (el && el.audioLoadingPill) || document.getElementById('audio-loading-pill');
    const txt = (el && el.audioLoadingText) || document.getElementById('audio-loading-text');
    const artist = (el && el.playbarArtist) || document.getElementById('playbar-artist');
    const bar = (el && el.playbar) || document.getElementById('playbar');

    if (scrub) scrub.classList.remove('hidden');
    if (pill) {
      if (txt) txt.textContent = msg;
      pill.classList.remove('hidden');
    }
    if (artist) artist.classList.add('hidden');
    if (bar) bar.classList.add('is-buffering-track');

    try {
      document.querySelectorAll('.track-row.is-loading-track').forEach(r => r.classList.remove('is-loading-track'));
      if (track && track.id) {
        const row = document.querySelector(`.track-row[data-track-id="${track.id}"]`);
        if (row) row.classList.add('is-loading-track');
      }
    } catch (_) {}

    audioLoadingTimer1 = setTimeout(() => {
      if (state._isLoadingAudio && txt) {
        txt.textContent = 'Đang tìm kiếm luồng phát tối ưu...';
      }
    }, 3200);

    audioLoadingTimer2 = setTimeout(() => {
      if (state._isLoadingAudio && txt) {
        txt.textContent = 'Đang tải bộ đệm âm thanh...';
      }
    }, 7000);
  }

  function hideAudioLoadingState() {
    state._isLoadingAudio = false;
    state._loadingTrackId = null;

    if (audioLoadingTimer1) { clearTimeout(audioLoadingTimer1); audioLoadingTimer1 = null; }
    if (audioLoadingTimer2) { clearTimeout(audioLoadingTimer2); audioLoadingTimer2 = null; }

    const scrub = (el && el.scrubberLoadingBar) || document.getElementById('scrubber-loading-bar');
    const pill = (el && el.audioLoadingPill) || document.getElementById('audio-loading-pill');
    const artist = (el && el.playbarArtist) || document.getElementById('playbar-artist');
    const bar = (el && el.playbar) || document.getElementById('playbar');

    if (scrub) scrub.classList.add('hidden');
    if (pill) pill.classList.add('hidden');
    if (artist) artist.classList.remove('hidden');
    if (bar) bar.classList.remove('is-buffering-track');

    try {
      document.querySelectorAll('.track-row.is-loading-track').forEach(r => r.classList.remove('is-loading-track'));
    } catch (_) {}
  }

async function playTrack(track, queueList = null, startIndex = -1, context = null) {
  try { checkDonatePromptMilestone(); } catch (_) {}
    if (track) {
      track._errorRetryStage = 0;
      track._playStartPerfMs = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      track._firstPlayingRecorded = false;
      track._firstBufferedRecorded = false;
      state._waitingStartedPerfMs = 0;
    }
    if (track && track.artist) track.artist = stripYoutubeTopic(track.artist);
    preloadedTrack10sFired = false;
    lastDisplayedSec = -1;
    if (typeof lastTimeupdateSec !== 'undefined') lastTimeupdateSec = -1;
    if (syncState && syncState.active) {
      const overlay = document.getElementById('sync-mode-overlay');
      if (!overlay || overlay.classList.contains('hidden') || !overlay.classList.contains('visible')) {
        syncState.active = false;
      } else {
        return;
      }
    }
    applyTrackRenames(track);
    if (typeof queueList === "number") { startIndex = queueList; queueList = state.queue; }
    if (!track || !el.nativeAudio) return;
    if (el.nativeAudio && !el.nativeAudio.paused) {
      try { el.nativeAudio.pause(); } catch (_) {}
    }
    resetLevelWatcher();
    vizPrev = null;
    if (state.currentTrack && state.currentTrack.id !== track.id && !navigatingBack) pushPlayHistory(state.currentTrack);

    if (!state._isNaturalEnding && state.myWaveActive && state.currentTrack && !isSameTrack(state.currentTrack, track)) {
      const curId = (typeof getTrackCanonicalId === 'function' ? getTrackCanonicalId(state.currentTrack) : '') || state.currentTrack.id;
      if (state._skipRecordedFor !== curId) {
        const cur = (el.nativeAudio && typeof el.nativeAudio.currentTime === 'number') ? el.nativeAudio.currentTime : 0;
        if (cur < 12 && typeof recordWaveSkip === 'function') {
          recordWaveSkip(state.currentTrack);
        }
      }
    }
    state._skipRecordedFor = null;

    if (context !== 'album') currentAlbumPlayRunId++;
    state._streamRecoverCount = 0;
    if (context === 'album' || context === 'playlist' || (track && track.platform === 'local')) {
      state.isRadioQueue = false;
    }
    crossfadeTriggered = false;
    state.nextTrackPrefetched = false;
    initAudioContext();
    el.nativeAudio.preload = 'auto';

    // Zero-Gap Handover Guard: do not clear Deck A audio prematurely if autoMix handover is active
    const isHandoverTarget = !!(
      (typeof window.PlaybackHandover !== 'undefined' && window._playbackHandoverInstance && window._playbackHandoverInstance.isHandoverTarget(state, track)) ||
      (state._autoMixHandover && (
        track.id === state._autoMixHandover.trackId ||
        (track.videoId && track.videoId === state._autoMixHandover.trackId) ||
        (track._matchedYtId && track._matchedYtId === state._autoMixHandover.trackId)
      ))
    );

    if (!isHandoverTarget) {
      try {
        el.nativeAudio.pause();
        el.nativeAudio.removeAttribute('src');
        el.nativeAudio.load();
      } catch (e) {}

      if (hlsInstance) {
        try { hlsInstance.destroy(); } catch (e) {}
        hlsInstance = null;
      }
    }

    state.isPlaying = false;
    updatePlayPauseButton(false, true);
    showAudioLoadingState(track);
    sendStateToServer();

    if (el.lyricsContainer) el.lyricsContainer.scrollTop = 0;
    if (typeof lyricsScrollRaf !== 'undefined' && lyricsScrollRaf) {
      cancelAnimationFrame(lyricsScrollRaf);
      lyricsScrollRaf = 0;
    }
    state.lastActiveLyricIdx = -1;
    state.forceLyricsScroll = true;
    state.forceSnapLyrics = true;

    lastDisplayedSec = -1;
    lastTimeupdateSec = -1;
    const initDurText = formatDuration(track.duration || 0);
    if (el.timeCurrent) el.timeCurrent.textContent = '0:00';
    if (el.timeDuration) el.timeDuration.textContent = initDurText;
    syncTvkTimeDisplay('0:00', initDurText);
    if (el.tvkSeekSlider) el.tvkSeekSlider.value = 0;
    scrubPrevKnobX = null;
    scrubProgress = 0;

    if (el.trackLoadingOverlay) {
      if (el.trackLoadingTitle) el.trackLoadingTitle.textContent = track.title || 'loading track...';
      if (el.trackLoadingSub) el.trackLoadingSub.textContent = track.artist ? `${track.artist} • buffering stream` : 'buffering audio stream';
      el.trackLoadingOverlay.classList.remove('hidden');
    }

    state.loadToken++;
    const currentToken = state.loadToken;

    if (state.currentAbortController) {
      state.currentAbortController.abort();
    }
    state.currentAbortController = new AbortController();
    const signal = state.currentAbortController.signal;
    const fetchAbortTimeout = setTimeout(() => {
      try { state.currentAbortController?.abort(); } catch (_) {}
    }, 40000);

    state.currentTrack = track;
    try { mvController.onTrackChanged(track); } catch (_) {}
    if (typeof window.updateEclipseMvTrack === 'function') { try { window.updateEclipseMvTrack(track); } catch (_) {} }
    try { window.dispatchEvent(new CustomEvent('trackchanged', { detail: { track } })); } catch (_) {}
    emitPluginEvent('trackchange', track);
    state.currentTrackContext = context;
    state.currentTrackIndexInContext = startIndex;

    if (queueList) {
      abortAutoMixIfActive('queue_replaced');
      state.queue = [...queueList];
      try { window.dispatchEvent(new CustomEvent('queuechanged', { detail: { length: state.queue.length } })); } catch (_) {}
      if (startIndex >= 0 && startIndex < state.queue.length && isSameTrack(state.queue[startIndex], track)) {
        state.queueIndex = startIndex;
      } else {
        state.queueIndex = state.queue.findIndex(t => isSameTrack(t, track));
      }
      if (state.queueIndex === -1) {
        state.queue.unshift(track);
        state.queueIndex = 0;
      }
      recordPlayedIndex(state.queueIndex);
    } else {
      const existingIndex = state.queue.findIndex(t => isSameTrack(t, track));
      if (existingIndex === -1) {
        state.queue.push(track);
        state.queueIndex = state.queue.length - 1;
      } else {
        state.queueIndex = existingIndex;
      }
      recordPlayedIndex(state.queueIndex);
    }
    updateQueueBadge();
    if (state.currentView === 'queue') renderQueueView();

    track.playedAt = Date.now();
    state.history = state.history.filter(t => !isSameTrack(t, track));
    state.history.unshift(track);
    if (state.history.length > 100) state.history.pop();
    localStorage.setItem('devsize_history', JSON.stringify(state.history));
    updateHistoryBadge();
    if (state.currentView === 'history') renderHistoryView();

    updateNowPlayingUI(track);
    updatePlayPauseButton(false, true);

    if (!track.thumbnail && track.platform !== 'local') {
      fetch(`http://127.0.0.1:${state.serverPort}/api/track-cover?artist=${encodeURIComponent(track.artist || '')}&title=${encodeURIComponent(track.title || '')}`)
        .then(res => res.ok ? res.json() : null)
        .then(data => {
          if (data && data.cover) {
            track.thumbnail = data.cover;
            if (!state.currentTrack || state.currentTrack === track || state.currentTrack.id === track.id) {
              updateNowPlayingUI(track);
            }
          }
        })
        .catch(() => {});
    }

    loadSyncedLyrics(track.title, track.artist, currentToken);
    loadSponsorBlockSegments(track);
    loadCanvasForTrack(track);

    // Zero-Gap Dual-Deck Handover: keep auxAudio playing while nativeAudio buffers, then swap cleanly at live millisecond
    if (window._playbackHandoverInstance && typeof window._playbackHandoverInstance.handlePlayTrackHandover === 'function') {
      const handoverResult = window._playbackHandoverInstance.handlePlayTrackHandover({
        state,
        track,
        currentToken,
        nativeAudio: el.nativeAudio,
        auxAudio: document.getElementById('eclipse-aux-audio'),
        options: {
          isMuted: state.isMuted,
          onDeckGainsReset: () => {
            if (window.audioEngine && typeof window.audioEngine.setDeckGains === 'function') {
              window.audioEngine.setDeckGains({ deckA: 1.0, deckB: 0.0, rampMs: 20 });
            }
          },
          applySettings: () => applyAudioSettings()
        }
      });

      if (handoverResult && handoverResult.status === 'handled') {
        if (hlsInstance) { try { hlsInstance.destroy(); } catch (_) {} hlsInstance = null; }
        return;
      }
      if (handoverResult && handoverResult.status === 'stale') {
        // Stale invocation has lost ownership: return early without mutating resources owned by newer invocation
        return;
      }
    }

    try {
      if (nextTrackCoordinator) nextTrackCoordinator.cancel('track_changed');
      else cancelActiveNextPreload('track_changed');
      const configuredQuality = getConfiguredAudioQuality();
      if (!isTrackPreloadValid(track, configuredQuality) && globalPreloadManager) {
        const cachedPreload = globalPreloadManager.getCached(track, configuredQuality);
        if (cachedPreload && (cachedPreload.proxyUrl || cachedPreload.streamUrl) && cachedPreload.quality === configuredQuality) {
          track._preloadedStreamUrl = cachedPreload.proxyUrl || cachedPreload.streamUrl;
          track._preloadedStreamQuality = configuredQuality;
          track._preloadedStreamPlatform = String(track.platform || 'ytmusic').trim().toLowerCase();
          if (cachedPreload.resolvedId) track._matchedYtId = cachedPreload.resolvedId;
        }
      }

      if (isTrackPreloadValid(track, configuredQuality)) {
        if (currentToken !== state.loadToken) return;
        if (hlsInstance) {
          try { hlsInstance.destroy(); } catch (_) {}
          hlsInstance = null;
        }
        el.nativeAudio.preload = 'auto';
        if (track._preloadedStreamUrl.includes('.m3u8') && window.Hls && Hls.isSupported()) {
          hlsInstance = new Hls({ enableWorker: true, lowLatencyMode: true, maxBufferLength: 30, maxMaxBufferLength: 60, maxBufferSize: 30 * 1000 * 1000 });
          hlsInstance.on(Hls.Events.ERROR, (_, errData) => {
            if (errData && errData.fatal) {
              if (errData.type === Hls.ErrorTypes.NETWORK_ERROR) hlsInstance.startLoad();
              else if (errData.type === Hls.ErrorTypes.MEDIA_ERROR) hlsInstance.recoverMediaError();
            }
          });
          hlsInstance.loadSource(track._preloadedStreamUrl);
          hlsInstance.attachMedia(el.nativeAudio);
          hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
            if (currentToken === state.loadToken) {
              playSmooth();
            }
          });
        } else {
          el.nativeAudio.src = track._preloadedStreamUrl;
          playSmooth();
        }
        applyAudioSettings();
        return;
      }

      if (track.platform === 'local') {
        const streamUrl = track.url || (track.path ? (track.path.startsWith('file:') ? track.path : 'file://' + encodeURI(track.path)) : `http://127.0.0.1:${state.serverPort}/api/library-file?id=${encodeURIComponent(track.id)}`);
        if (currentToken !== state.loadToken) return;
        el.nativeAudio.preload = 'auto';
        el.nativeAudio.src = streamUrl;
        playSmooth();
        applyAudioSettings();
        return;
      }

      let resolvedUrl = track.url;
      let resolvedId = track._matchedYtId || track.id;
      if (!resolvedUrl && track._matchedYtId) {
        resolvedUrl = 'https://www.youtube.com/watch?v=' + track._matchedYtId;
      }

      const qSearch = encodeURIComponent(track.searchQuery || ((track.artist ? track.artist + ' - ' : '') + track.title));
      const streamInfoPlatform = (state.platform === 'soundcloud' && (!track.url || !track.url.includes('youtube.com'))) ? 'soundcloud' : (track.platform || state.platform || 'ytmusic');
      const buildStreamInfoUrl = (qVal) => `http://127.0.0.1:${state.serverPort}/api/stream-info?url=${encodeURIComponent(resolvedUrl || '')}&id=${encodeURIComponent(resolvedId || '')}&platform=${encodeURIComponent(streamInfoPlatform)}&title=${encodeURIComponent(track.title || '')}&artist=${encodeURIComponent(track.artist || '')}&duration=${encodeURIComponent(track.duration || 0)}&thumbnail=${encodeURIComponent(track.thumbnail || '')}&quality=${encodeURIComponent(qVal)}&q=${qSearch}&token=${encodeURIComponent((window.electronAPI && window.electronAPI.serverToken) || (state && state.serverToken) || '')}`;

      const fetchStreamInfoWithRetry = async (qVal) => {
        const url = buildStreamInfoUrl(qVal);
        let r;
        try {
          r = await fetch(url, { signal });
        } catch (fetchErr) {
          if (fetchErr instanceof TypeError) {
            await new Promise(resolve => setTimeout(resolve, 600));
            r = await fetch(url, { signal });
          } else {
            throw fetchErr;
          }
        }
        return r.json();
      };

      let data = null;
      try {
        data = await fetchStreamInfoWithRetry(configuredQuality);
      } catch (err) {
        if (err && err.name === 'AbortError') throw err;
        data = null;
      }

      if (currentToken !== state.loadToken) return;

      if (!data || !data.success || !data.streamUrl) {
        if (!navigator.onLine) {
          showToast('Offline: this track is not available in local cache');
          throw new Error('Offline: track not cached locally');
        }
        throw new Error((data && data.error) || 'Failed to extract audio stream');
      }

      const resolvedQuality = (data && data.resolvedQuality) ? String(data.resolvedQuality).trim().toLowerCase() : configuredQuality;
      if (resolvedQuality !== configuredQuality) {
        showToast(`Requested ${configuredQuality} quality unavailable; playing ${resolvedQuality}`, 'warning');
      }

      track._preloadedStreamUrl = data.proxyUrl || data.streamUrl;
      track._preloadedStreamQuality = resolvedQuality;
      track._preloadedStreamPlatform = String(streamInfoPlatform || 'ytmusic').trim().toLowerCase();
      track._preloadedStreamUrlExpires = Date.now() + 3600 * 1000;
      if (data.resolvedId && /^[a-zA-Z0-9_-]{11}$/.test(data.resolvedId)) {
        track._matchedYtId = data.resolvedId;
      }

      if (hlsInstance) {
        hlsInstance.destroy();
        hlsInstance = null;
      }

      el.nativeAudio.preload = 'auto';

      if (data.isHls && window.Hls && Hls.isSupported()) {
        hlsInstance = new Hls({ enableWorker: true, lowLatencyMode: true, maxBufferLength: 30, maxMaxBufferLength: 60, maxBufferSize: 30 * 1000 * 1000 });
        hlsInstance.on(Hls.Events.ERROR, (_, errData) => {
          if (errData && errData.fatal) {
            if (errData.type === Hls.ErrorTypes.NETWORK_ERROR) hlsInstance.startLoad();
            else if (errData.type === Hls.ErrorTypes.MEDIA_ERROR) hlsInstance.recoverMediaError();
          }
        });
        hlsInstance.loadSource(data.streamUrl);
        hlsInstance.attachMedia(el.nativeAudio);
        hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
          if (currentToken === state.loadToken) {
            playSmooth();
          }
        });
      } else {
        el.nativeAudio.src = data.proxyUrl || data.streamUrl;
        playSmooth();
      }

      applyAudioSettings();
    } catch (err) {
      hideAudioLoadingState();
      if (err.name === 'AbortError') return;
      if (currentToken === state.loadToken) {
        console.warn('Track playback notice:', err);
        updatePlayPauseButton(false, false);
        if (el.trackLoadingOverlay) el.trackLoadingOverlay.classList.add('hidden');
        showToast(err.message || 'Could not load audio stream', 'error');
      }
    } finally {
      clearTimeout(fetchAbortTimeout);
    }
    if (state.isRadioQueue && state.queue.length - 1 - state.queueIndex <= 3) ensureInfiniteWaveQueue();
  }

  function flipAnimate(elements, mutateFn, duration = 380) {
    const validElements = (elements || []).filter(item => item && item.getBoundingClientRect);
    const firstRects = new Map();
    validElements.forEach(item => {
      firstRects.set(item, item.getBoundingClientRect());
    });

    validElements.forEach(item => {
      item.style.transition = 'none';
      item.style.transform = 'none';
    });

    if (typeof mutateFn === 'function') {
      mutateFn();
    }

    const animatingElements = [];
    validElements.forEach(item => {
      const first = firstRects.get(item);
      const last = item.getBoundingClientRect();
      if (!first || !last) return;
      if ((first.width === 0 && first.height === 0) || (last.width === 0 && last.height === 0)) return;

      const dx = first.left - last.left;
      const dy = first.top - last.top;

      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
        item.style.transform = `translate(${dx}px, ${dy}px)`;
        animatingElements.push(item);
      } else {
        item.style.transform = '';
        item.style.transition = '';
      }
    });

    if (animatingElements.length === 0) return;

    animatingElements.forEach(item => item.offsetHeight);

    requestAnimationFrame(() => {
      animatingElements.forEach(item => {
        item.style.transition = `transform ${duration}ms cubic-bezier(0.2, 0, 0, 1)`;
        item.style.transform = '';

        let cleaned = false;
        const cleanUp = () => {
          if (cleaned) return;
          cleaned = true;
          item.removeEventListener('transitionend', onEnd);
          item.style.transition = '';
          item.style.transform = '';
        };
        const onEnd = (e) => {
          if (e.target !== item || e.propertyName !== 'transform') return;
          cleanUp();
        };
        item.addEventListener('transitionend', onEnd);
        setTimeout(cleanUp, duration + 50);
      });
    });
  }

  window.addEventListener('resize', () => {
    updateLyricsPadding();
    state.forceLyricsScroll = true;
    state.forceSnapLyrics = true;
    state.lastActiveLyricIdx = -1;
    if (el.nativeAudio) updateSyncedLyricsHighlight(el.nativeAudio.currentTime || 0);
  });
  if (window.ResizeObserver && el.lyricsContainer) {
    let lastObservedH = 0;
    new ResizeObserver((entries) => {
      const h = Math.round(entries[0]?.contentRect?.height || el.lyricsContainer.clientHeight || 0);
      if (h <= 0) {
        lastObservedH = 0;
        return;
      }
      if (Math.abs(h - lastObservedH) > 4) {
        lastObservedH = h;
        updateLyricsPadding();
        state.forceLyricsScroll = true;
        state.forceSnapLyrics = true;
        state.lastActiveLyricIdx = -1;
        if (el.nativeAudio) updateSyncedLyricsHighlight(el.nativeAudio.currentTime || 0);
      }
    }).observe(el.lyricsContainer);
  }

  function isDynamicNode(el) {
    if (!el || !(el instanceof Element)) return true;
    if (el.closest('#donate-modal') || el.id === 'donate-modal') return true;
    if (el.closest('#player-bar') ||
        el.closest('#right-panel-header') ||
        el.closest('#right-panel-title') ||
        el.closest('#right-panel-artist') ||
        el.id === 'right-panel-title' ||
        el.id === 'right-panel-artist' ||
        el.id === 'playbar-title' ||
        el.id === 'playbar-artist' ||
        el.id === 'playlist-detail-title' ||
        el.id === 'playlist-detail-count' ||
        el.id === 'playlist-detail-desc' ||
        el.id === 'album-title' ||
        el.id === 'album-artist' ||
        el.id === 'album-track-count' ||
        el.id === 'album-detail-count' ||
        el.closest('#album-detail-count') ||
        el.id === 'album-detail-title' ||
        el.id === 'album-detail-artist' ||
        el.id === 'artist-header-name' ||
        el.closest('#playlist-track-list') ||
        el.closest('#album-track-list') ||
        el.closest('#queue-list') ||
        el.closest('.tracks-list') ||
        el.closest('.track-row') ||
        el.closest('.lyrics-lines-container') ||
        el.classList.contains('track-title') ||
        el.classList.contains('track-artist') ||
        el.classList.contains('track-row-title') ||
        el.classList.contains('track-row-artist') ||
        (el.classList.contains('setting-value') && /^[\+\-]?\d/.test((el.textContent || '').trim()))) {
      return true;
    }
    return false;
  }

  const AUTO_I18N_SELECTORS = [
    '[data-i18n]',
    '.setting-name',
    '.setting-hint',
    '.settings-section-title',
    '.rail-drawer-title',
    '.home-pane-label',
    '.view-header h2',
    '.dialog-header h3',
    '.modal-title',
    '.btn-pill-primary > span',
    '.btn-outline-pill > span',
    '.custom-lyrics-tip > span',
    '.empty-hint',
    'button.btn-pill-primary:not(:has(*))',
    'button.btn-outline-pill:not(:has(*))',
    'button.btn-text:not(:has(*))',
    'button.btn-text-error:not(:has(*))',
    'button.theme-mode-btn:not(:has(*))',
    'label:not(:has(*))',
    '.setting-item-top > span:not([class])',
    '.setting-hints > span:not([class])',
    '.setting-item > div:not([class]):not(:has(*))',
    '.setting-value',
    '.m3-dropdown-label',
    '.m3-dropdown-option',
    '.m3-dropdown-trigger > span:not([class])',
    '.sp-modes button',
    '.audio-tab > span:not([class])',
    '.artist-horiz-tab > span:not([class])',
    '.lyrics-action-btn > span:not([class])',
    '.lyrics-mode-btn > span:not([class])',
    '.cache-stat-label > span:not([class])',
    '.playlist-type-badge',
    '.artist-about-title',
    '.sleep-timer-hint',
    '.hq-label',
    '.sync-mode-badge',
    '.sync-tip-pill',
    '.sync-progress-text',
    '.cpm-import-label',
    '.download-section-label',
    '.download-preview-title',
    '.download-preview-artist',
    '.download-caption-path',
    '.css-editor-title',
    '.css-editor-hint',
    '.tvk-label',
    '.tvk-pill-btn',
    '.tvk-actions button',
    '.right-panel-artist',
    '.dialog-card span:not([class])'
  ].join(', ');

  const savedUiLang = localStorage.getItem('eclipse_ui_lang') || localStorage.getItem('eclipse_ui_lang') || 'en';
  syncDocumentDirection(savedUiLang);
  if (savedUiLang !== 'en') {
    applyI18n(savedUiLang);
    setTimeout(() => {
      const current = localStorage.getItem('eclipse_ui_lang') || localStorage.getItem('eclipse_ui_lang') || 'en';
      if (current !== 'en') applyI18n(current).catch(() => {});
    }, 1200);
  }

  function collectI18n() {
    const list = new Set();
    document.querySelectorAll(AUTO_I18N_SELECTORS).forEach(elNode => {
      if (isDynamicNode(elNode)) return;
      if (elNode.children && elNode.children.length > 0 && !elNode.hasAttribute('data-i18n')) {
        return;
      }
      if (!elNode.dataset.i18nOrig) {
        elNode.dataset.i18nOrig = elNode.textContent.trim();
      }
      if (!elNode.dataset.origText) {
        elNode.dataset.origText = elNode.dataset.i18nOrig;
      }
      const val = elNode.dataset.i18nOrig || elNode.dataset.origText;
      if (val) list.add(val);
    });
    document.querySelectorAll('input[placeholder], textarea[placeholder]').forEach(input => {
      if (!input.dataset.origPlaceholder) {
        input.dataset.origPlaceholder = input.placeholder;
      }
      if (input.dataset.origPlaceholder) list.add(input.dataset.origPlaceholder);
    });
    document.querySelectorAll('[data-i18n-attr]').forEach(el => {
      const attr = el.getAttribute('data-i18n-attr') || 'placeholder';
      if (!el._i18n_orig_attrs) el._i18n_orig_attrs = {};
      if (!el._i18n_orig_attrs[attr]) {
        el._i18n_orig_attrs[attr] = el.getAttribute(attr) || '';
      }
      if (el._i18n_orig_attrs[attr]) list.add(el._i18n_orig_attrs[attr]);
    });
    document.querySelectorAll('.nav-item[title]').forEach(el => {
      if (!el.dataset.origTitle) el.dataset.origTitle = el.getAttribute('title') || '';
      if (el.dataset.origTitle) list.add(el.dataset.origTitle);
    });
    return Array.from(list);
  }

  async function applyI18n(lang) {
    lang = lang || localStorage.getItem('eclipse_ui_lang') || localStorage.getItem('eclipse_ui_lang') || 'en';
    localStorage.setItem('eclipse_ui_lang', lang);
    localStorage.setItem('eclipse_ui_lang', lang);
    if (window.electronAPI && window.electronAPI.storageSaveSync && window.__RIFF_STORAGE_MAP__) {
      window.__RIFF_STORAGE_MAP__['eclipse_ui_lang'] = lang;
      window.__RIFF_STORAGE_MAP__['eclipse_ui_lang'] = lang;
      try { window.electronAPI.storageSaveSync(window.__RIFF_STORAGE_MAP__); } catch (_) {}
    }
    syncDocumentDirection(lang);

    const found = TRANSLATION_LANGUAGES.find(l => l.code === lang);
    const uiLangLabel = document.getElementById('ui-lang-label');
    if (uiLangLabel && found) {
      uiLangLabel.textContent = `${found.flag} ${found.name} (${found.code})`;
    }
    const uiLangMenu = document.getElementById('ui-lang-menu');
    if (uiLangMenu) {
      uiLangMenu.querySelectorAll('.m3-dropdown-option').forEach(o => {
        o.classList.toggle('selected', o.dataset.value === lang);
      });
    }

    if (lang === 'en') {
      document.querySelectorAll(AUTO_I18N_SELECTORS).forEach(elNode => {
        if (isDynamicNode(elNode)) return;
        if (elNode.dataset.i18nOrig) {
          elNode.textContent = elNode.dataset.i18nOrig;
          elNode.dataset.i18nShown = elNode.textContent;
        } else if (elNode.dataset.origText) {
          elNode.textContent = elNode.dataset.origText;
          elNode.dataset.i18nShown = elNode.textContent;
        } else if (elNode._i18n_orig) elNode.textContent = elNode._i18n_orig;
      });
      document.querySelectorAll('input[placeholder], textarea[placeholder]').forEach(input => {
        if (input.dataset.origPlaceholder) input.placeholder = input.dataset.origPlaceholder;
      });
      document.querySelectorAll('[data-i18n-attr]').forEach(el => {
        const attr = el.getAttribute('data-i18n-attr') || 'placeholder';
        if (el._i18n_orig_attrs && el._i18n_orig_attrs[attr]) {
          el.setAttribute(attr, el._i18n_orig_attrs[attr]);
        }
      });
      document.querySelectorAll('.nav-item[title]').forEach(el => {
        if (el.dataset.origTitle) el.setAttribute('title', el.dataset.origTitle);
      });
      return;
    }

    let dict = i18nSessionMap.get(lang);
    if (!dict || dict.size === 0) {
      dict = loadCachedI18nDict(lang) || new Map();
      i18nSessionMap.set(lang, dict);
    }

    function updateDOMWithDict() {
      const translations = {};
      for (const [k, v] of dict.entries()) {
        translations[k] = v;
      }

      document.querySelectorAll(AUTO_I18N_SELECTORS).forEach(elNode => {
        if (isDynamicNode(elNode)) return;
        if (elNode.children && elNode.children.length > 0 && !elNode.hasAttribute('data-i18n')) {
          return;
        }
        if (!elNode.dataset.i18nOrig) elNode.dataset.i18nOrig = elNode.textContent.trim();
        if (!elNode.dataset.origText) elNode.dataset.origText = elNode.dataset.i18nOrig;
        const key = elNode.dataset.i18nOrig || elNode.dataset.origText;
        if (!key) return;
        const next = translations[key];
        if (next && elNode.textContent !== next) {
          elNode.textContent = next;
          elNode.dataset.i18nShown = next;
        }
      });

      document.querySelectorAll('input[placeholder], textarea[placeholder]').forEach(input => {
        if (!input.dataset.origPlaceholder) input.dataset.origPlaceholder = input.placeholder;
        if (input.dataset.origPlaceholder) {
          const next = translations[input.dataset.origPlaceholder];
          if (next && input.placeholder !== next) input.placeholder = next;
        }
      });

      document.querySelectorAll('[data-i18n-attr]').forEach(el => {
        const attr = el.getAttribute('data-i18n-attr') || 'placeholder';
        if (!el._i18n_orig_attrs) el._i18n_orig_attrs = {};
        if (!el._i18n_orig_attrs[attr]) el._i18n_orig_attrs[attr] = el.getAttribute(attr) || '';
        const origVal = el._i18n_orig_attrs[attr];
        if (origVal && translations[origVal]) {
          el.setAttribute(attr, translations[origVal]);
        }
      });

      document.querySelectorAll('.nav-item[title]').forEach(el => {
        if (!el.dataset.origTitle) el.dataset.origTitle = el.getAttribute('title') || '';
        const orig = el.dataset.origTitle;
        if (orig && translations[orig]) el.setAttribute('title', translations[orig]);
      });
    }

    updateDOMWithDict();

    const texts = collectI18n();
    const commonToasts = [
      'Save at least 5 tracks to tune For you',
      'Playing For you',
      'Track added to favorites',
      'Track removed from favorites',
      'Copied to clipboard',
      'Downloaded track',
      'Download failed',
      'Playlist created',
      'Playlist deleted'
    ];
    for (const ct of commonToasts) {
      if (!texts.includes(ct)) texts.push(ct);
    }

    const missing = texts.filter(s => typeof s === 'string' && s.trim() && !dict.has(s));
    if (missing.length > 0) {
      try {
        const port = (typeof state !== 'undefined' && state && state.serverPort) || (window.electronAPI && window.electronAPI.getServerPort ? await window.electronAPI.getServerPort() : 38472);
        if (port) {
          const token = (window.electronAPI && window.electronAPI.serverToken) || (typeof state !== 'undefined' && state && state.serverToken) || '';
          const res = await fetch(`http://127.0.0.1:${port}/api/i18n-batch`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Eclipse-Token': token
            },
            body: JSON.stringify({ target: lang, texts: missing })
          });
          if (!res.ok) {
            console.warn(`i18n request failed: HTTP ${res.status}`);
          }
          const data = await res.json();
          if (data && data.success && Array.isArray(data.translations)) {
            let hasNew = false;
            missing.forEach((str, i) => {
              if (data.translations[i]) {
                dict.set(str, data.translations[i]);
                hasNew = true;
              }
            });
            if (hasNew) {
              saveI18nCache(lang);
              updateDOMWithDict();
            }
          }
        }
      } catch (e) {
        console.warn('applyI18n fetch error:', e);
      }
    }
  }
  window.collectI18n = collectI18n;
  window.applyI18n = applyI18n;
  if (typeof initLibraryReordering === 'function') initLibraryReordering();

  setTimeout(() => {
    const cur = localStorage.getItem('eclipse_ui_lang') || localStorage.getItem('eclipse_ui_lang') || 'en';
    if (cur !== 'en') applyI18n(cur).catch(() => {});
  }, 4000);

  let i18nApplyTimer = null;
  function scheduleI18nApply() {
    const lang = localStorage.getItem('eclipse_ui_lang') || localStorage.getItem('eclipse_ui_lang') || 'en';
    if (lang === 'en') return;
    if (i18nApplyTimer) clearTimeout(i18nApplyTimer);
    i18nApplyTimer = setTimeout(() => {
      i18nApplyTimer = null;
      applyI18n(lang).catch(() => {});
    }, 600);
  }
  new MutationObserver(scheduleI18nApply).observe(document.body, { childList: true, subtree: true });

  if (el.btnLyricsMode) {
    updateLyricsModeButton();
    el.btnLyricsMode.addEventListener('click', () => {
      if (!getAdv('karaoke_words', true)) {
        state.lyricsMode = 'line';
        updateLyricsModeButton();
        return;
      }
      state.lyricsMode = state.lyricsMode === 'line' ? 'word' : 'line';
      updateLyricsModeButton();
      renderLyricsView();
      if (el.nativeAudio) updateSyncedLyricsHighlight(el.nativeAudio.currentTime || 0);
    });
  }

  if (el.btnRomanizeLyrics) {
    el.btnRomanizeLyrics.addEventListener("click", () => {
      if (!state.syncedLyrics || state.syncedLyrics.length === 0) return;
      state.romActive = !state.romActive;
      updateLyricsTranslationUI();
      if (state.romActive) {
        fetchAndApplyRomanize();
      } else {
        state.currentRomanized = null;
        renderLyricsView();
        if (el.nativeAudio) updateSyncedLyricsHighlight(el.nativeAudio.currentTime || 0);
      }
    });
  }
  if (el.btnTranslateLyrics) {
    el.btnTranslateLyrics.addEventListener('click', () => {
      state.trActive = !state.trActive;
      localStorage.setItem('eclipse_tr_active', String(state.trActive));
      updateLyricsTranslationUI();
      if (state.trActive) {
        fetchAndApplyTranslation();
      } else {
        state.currentTranslations = null;
        renderLyricsView();
        if (el.nativeAudio) updateSyncedLyricsHighlight(el.nativeAudio.currentTime || 0);
      }
    });
  }

  if (el.btnTvKaraoke) {
    el.btnTvKaraoke.addEventListener('click', openTvKaraoke);
  }
  if (el.tvKaraokeClose) {
    el.tvKaraokeClose.addEventListener('click', closeTvKaraoke);
  }

  // TV Karaoke Lyrics Offset Capsule Controls
  const btnTvkOffsetToggle = document.getElementById('btn-tvk-offset-toggle');
  const tvkOffsetCtrl = document.getElementById('tvk-offset-control');
  if (btnTvkOffsetToggle && tvkOffsetCtrl) {
    btnTvkOffsetToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      tvkOffsetCtrl.classList.toggle('expanded');
    });
  }
  const btnTvkOffsetMinus = document.getElementById('btn-tvk-offset-minus');
  if (btnTvkOffsetMinus) {
    btnTvkOffsetMinus.addEventListener('click', (e) => {
      e.stopPropagation();
      setTrackLyricsOffsetSec(getTrackLyricsOffsetSec() - 0.2);
    });
  }
  const btnTvkOffsetPlus = document.getElementById('btn-tvk-offset-plus');
  if (btnTvkOffsetPlus) {
    btnTvkOffsetPlus.addEventListener('click', (e) => {
      e.stopPropagation();
      setTrackLyricsOffsetSec(getTrackLyricsOffsetSec() + 0.2);
    });
  }
  const btnTvkOffsetBadge = document.getElementById('btn-tvk-offset-badge');
  if (btnTvkOffsetBadge) {
    btnTvkOffsetBadge.addEventListener('click', (e) => {
      e.stopPropagation();
      setTrackLyricsOffsetSec(0);
    });
  }

  // Pure View / Zen Mode Controller
  const btnTvkZen = document.getElementById('btn-tvk-zen');
  if (btnTvkZen) {
    btnTvkZen.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleTvkZenMode();
    });
  }

  // PiP Mini Player Button from TV Karaoke
  const btnTvkPip = document.getElementById('btn-tvk-pip');
  if (btnTvkPip) {
    btnTvkPip.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (typeof closeTvKaraoke === 'function') closeTvKaraoke();
      if (window.electronAPI && window.electronAPI.toggleFloatingLyrics) {
        const isOpen = await window.electronAPI.toggleFloatingLyrics();
        state.isFloatingLyricsOpen = !!isOpen;
        const btnFloat = document.getElementById('btn-floating-lyrics');
        if (btnFloat) btnFloat.classList.toggle('active', !!isOpen);
        if (isOpen && typeof sendFloatingLyricsUpdate === 'function') sendFloatingLyricsUpdate();
      }
    });
  }

  // Auto-Zen on idle (4s) Setting
  const btnTvkAutoZen = document.getElementById('btn-tvk-auto-zen');
  if (btnTvkAutoZen) {
    const autoZenStored = localStorage.getItem('eclipse_tvk_auto_zen') === '1';
    btnTvkAutoZen.classList.toggle('active', autoZenStored);
    btnTvkAutoZen.addEventListener('click', () => {
      const next = !btnTvkAutoZen.classList.contains('active');
      btnTvkAutoZen.classList.toggle('active', next);
      localStorage.setItem('eclipse_tvk_auto_zen', next ? '1' : '0');
    });
  }
  if (el.tvKaraoke) {
    el.tvKaraoke.addEventListener('mousemove', resetTvIdleTimer);
  }

  const btnTvkPrev = document.getElementById('btn-tvk-prev');
  const btnTvkPlay = document.getElementById('btn-tvk-play');
  const btnTvkNext = document.getElementById('btn-tvk-next');
  if (btnTvkPrev) btnTvkPrev.addEventListener('click', () => playPrev());
  if (btnTvkNext) btnTvkNext.addEventListener('click', () => playNext());
  if (btnTvkPlay) btnTvkPlay.addEventListener('click', () => togglePlayPause());

  const tvkSeekSlider = el.tvkSeekSlider || document.getElementById('tvk-seek-slider');
  const tvkTimeCur = el.tvkTimeCurrent || document.getElementById('tvk-time-current');
  if (tvkSeekSlider) {
    const onTvkSeekInput = () => {
      abortAutoMixIfActive('seek');
      const dur = getReliableTrackDuration();
      const frac = Math.max(0, Math.min(1, Number(tvkSeekSlider.value) / 1000));
      const targetTime = frac * dur;
      if (tvkTimeCur) tvkTimeCur.textContent = formatDuration(targetTime);
      const tvkCurDisp = document.getElementById('tvk-time-current-display'); if (tvkCurDisp) tvkCurDisp.textContent = formatDuration(targetTime);
      if (el.timeCurrent) el.timeCurrent.textContent = formatDuration(targetTime);
      if (el.nativeAudio && Number.isFinite(targetTime) && dur > 0) {
        el.nativeAudio.currentTime = targetTime;
        updateMediaPositionState();
      }
    };
    tvkSeekSlider.addEventListener('pointerdown', () => { isDraggingTvkSeek = true; });
    tvkSeekSlider.addEventListener('input', onTvkSeekInput);
    const stopTvkSeek = () => { isDraggingTvkSeek = false; };
    tvkSeekSlider.addEventListener('pointerup', stopTvkSeek);
    tvkSeekSlider.addEventListener('change', stopTvkSeek);
  }

  if (navigator.mediaDevices && typeof navigator.mediaDevices.addEventListener === 'function') {
    navigator.mediaDevices.addEventListener('devicechange', () => {
      updateTvkOutput();
    });
  }

  if (el.btnAddCustomLyrics) el.btnAddCustomLyrics.addEventListener('click', openCustomLyricsEditor);
  if (el.btnCloseCustomLyrics) el.btnCloseCustomLyrics.addEventListener('click', closeCustomLyricsEditor);
  if (el.btnCancelCustomLyrics) el.btnCancelCustomLyrics.addEventListener('click', closeCustomLyricsEditor);
  if (el.btnSaveCustomLyrics) el.btnSaveCustomLyrics.addEventListener('click', saveCustomLyrics);

  if (el.customLyricsModal) {
    el.customLyricsModal.addEventListener('click', (e) => {
      if (e.target === el.customLyricsModal) closeCustomLyricsEditor();
    });
  }

  if (el.btnSyncLyrics) el.btnSyncLyrics.addEventListener('click', openSyncMode);
  if (el.btnRestartSync) el.btnRestartSync.addEventListener('click', restartSync);
  if (el.btnSaveSync) el.btnSaveSync.addEventListener('click', saveSyncAndExit);
  if (el.btnCancelSync) el.btnCancelSync.addEventListener('click', closeSyncMode);

  if (el.syncModeOverlay) {
    el.syncModeOverlay.addEventListener('click', (e) => {
      if (e.target === el.syncModeOverlay) closeSyncMode();
    });
  }

  let isPauseFading = false;
  let frozenCurTime = 0;
  let smoothFadeToken = 0;
  let isAppClosing = false;
  window.addEventListener('beforeunload', () => { isAppClosing = true; });

  function abortAutoMixIfActive(reason = 'manual') {
    if (window.autoMixDjInstance && typeof window.autoMixDjInstance.abortCrossfade === 'function') {
      window.autoMixDjInstance.abortCrossfade(reason);
    }
  }

  function pauseSmooth() {
    abortAutoMixIfActive('pause');
    const curToken = ++smoothFadeToken;
    isPauseFading = true;
    frozenCurTime = (el.nativeAudio && Number.isFinite(el.nativeAudio.currentTime)) ? el.nativeAudio.currentTime : 0;
    state.isPlaying = false;
    document.body.classList.remove('is-playing');
    setPlayPauseState(false, true);
    if (el.btnPlayPause) el.btnPlayPause.classList.remove('buffering');
    if (el.playbarSpinner) el.playbarSpinner.classList.add('hidden');
    if (el.playIcon) el.playIcon.classList.remove('hidden');
    if (el.pauseIcon) el.pauseIcon.classList.remove('hidden');
    stopVisualizers();
    if (el.coverContainer) el.coverContainer.classList.remove('spinning');
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = state.isPlaying ? 'playing' : 'paused';
    }
    sendDiscordRpcUpdate(state.currentTrack, false);
    sendStateToServer();
    updateMediaSession();

    const audio = el.nativeAudio;
    if (isAppClosing || !audio || audio.paused) {
      isPauseFading = false;
      if (audioEngine && audioEngine.fadeGain && audioEngine.ctx) {
        try {
          audioEngine.fadeGain.gain.cancelScheduledValues(audioEngine.ctx.currentTime);
          audioEngine.fadeGain.gain.setValueAtTime(0, audioEngine.ctx.currentTime);
        } catch (e) {}
      }
      if (audio) {
        try { audio.pause(); } catch (e) {}
      }
      if (state.secondaryAudio) {
        try { state.secondaryAudio.pause(); } catch (e) {}
      }
      if (audioEngine && audioEngine.flushEffects) {
        audioEngine.flushEffects();
      }
      return;
    }

    if (audioEngine && audioEngine.fadeGain && audioEngine.ctx) {
      try {
        const ct = audioEngine.ctx.currentTime;
        audioEngine.fadeGain.gain.cancelScheduledValues(ct);
        audioEngine.fadeGain.gain.setTargetAtTime(0, ct, 0.035);
      } catch (e) {}
    }

    setTimeout(() => {
      if (curToken !== smoothFadeToken) return;
      if (audio) {
        try { audio.pause(); } catch (e) {}
      }
      if (state.secondaryAudio) {
        try { state.secondaryAudio.pause(); } catch (e) {}
      }
      if (audioEngine && audioEngine.flushEffects) {
        audioEngine.flushEffects();
      }
    }, 170);
  }

  async function playSmooth() {
    const curToken = ++smoothFadeToken;
    isPauseFading = false;
    state.isPlaying = true;
    document.body.classList.add('is-playing');
    hideAudioLoadingState();
    setPlayPauseState(true, true);
    if (el.btnPlayPause) el.btnPlayPause.classList.remove('buffering');
    if (el.playbarSpinner) el.playbarSpinner.classList.add('hidden');
    if (el.playIcon) el.playIcon.classList.remove('hidden');
    if (el.pauseIcon) el.pauseIcon.classList.remove('hidden');

    initAudioContext();
    if (audioEngine && audioEngine.ctx && (audioEngine.ctx.state === 'suspended' || audioEngine.ctx.state === 'interrupted')) {
      audioEngine.ctx.resume().catch(() => {});
    }

    if (audioEngine && audioEngine.fadeGain && audioEngine.ctx) {
      try {
        const ct = audioEngine.ctx.currentTime;
        audioEngine.fadeGain.gain.cancelScheduledValues(ct);
        audioEngine.fadeGain.gain.setValueAtTime(1, ct);
      } catch (_) {}
    }

    if (el.nativeAudio) {
      try {
        const playPromise = el.nativeAudio.play();
        if (playPromise && typeof playPromise.catch === 'function') {
          playPromise.catch(e => console.warn('Play error:', e));
        }
      } catch (e) {
        console.warn('Play error:', e);
      }
    }

    hasDrawnPausedFrame = false;
    startVisualizers();
    if (el.coverContainer && state.vfx.vinylSpin) el.coverContainer.classList.add('spinning');
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = state.isPlaying ? 'playing' : 'paused';
    }
    sendDiscordRpcUpdate(state.currentTrack, true);
    sendStateToServer();
    updateMediaSession();
  }

  window.pauseSmooth = pauseSmooth;
  window.playSmooth = playSmooth;

  async function startWaveIfIdle() {
    if (state.currentTrack) return false;
    if (!Array.isArray(state.vibeTracks) || state.vibeTracks.length === 0) {
      if (typeof fetchPersonalVibe === 'function') {
        await fetchPersonalVibe();
      }
    }
    if (Array.isArray(state.vibeTracks) && state.vibeTracks.length > 0) {
      state.queue = [...state.vibeTracks];
      state.queueIndex = 0;
      state.isRadioQueue = true;
      playTrack(state.queue[0], state.queue, 0);
      return true;
    }
    return false;
  }

  
  const mvController = {
    active: false,
    videoId: null,
    loading: false,
    extractYtId(track) {
      if (!track) return null;
      if (track._matchedYtId && /^[a-zA-Z0-9_-]{11}$/.test(track._matchedYtId)) return track._matchedYtId;
      if (track.id && /^[a-zA-Z0-9_-]{11}$/.test(track.id)) return track.id;
      const str = track.url || '';
      const m = str.match(/(?:youtu\.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([a-zA-Z0-9_-]{11})/);
      return m ? m[1] : null;
    },
    async showMv() {
      if (!state.currentTrack) return;
      const track = state.currentTrack;
      let vid = this.extractYtId(track);
      this.active = true;
      this.videoId = vid || (track && track.id) || 'mv';

      if (el.btnAvVideo) el.btnAvVideo.classList.add('active');
      if (el.btnAvSong) el.btnAvSong.classList.remove('active');
      if (el.btnToggleMv) el.btnToggleMv.classList.add('active');
      if (el.coverContainer) el.coverContainer.classList.add('hidden');
      if (el.mvPlayerWrapper) el.mvPlayerWrapper.classList.remove('hidden');

      if (!state.isRightPanelOpen && el.btnToggleLyricsPanel) {
        el.btnToggleLyricsPanel.click();
      }

      if (el.mvVideo) {
        if (!el.mvVideo._hasListeners) {
          el.mvVideo._hasListeners = true;
          el.mvVideo.addEventListener('loadedmetadata', () => {
            try {
              const cur = el.nativeAudio ? (el.nativeAudio.currentTime || 0) : 0;
              el.mvVideo.currentTime = cur;
              if (state.isPlaying && !el.nativeAudio.paused) {
                el.mvVideo.play().catch(() => {});
              }
            } catch (_) {}
          });
          el.mvVideo.addEventListener('error', () => {
            const err = el.mvVideo.error;
            console.error('MV Video decode error:', err ? err.code : 'unknown', err ? err.message : '');
            if (typeof showToast === 'function') showToast('Không thể giải mã luồng video');
          });
        }

        const trackKey = vid || ((track.title || '') + '|' + (track.artist || ''));
        if (el.mvVideo.dataset.trackKey !== trackKey || !el.mvVideo.src) {
          if (el.mvLoadingOverlay) el.mvLoadingOverlay.classList.remove('hidden');
          this.loading = true;
          try {
            const token = (window.electronAPI && window.electronAPI.serverToken) || (state && state.serverToken) || '';
            const port = state.serverPort || 38472;
            const resp = await fetch(`http://127.0.0.1:${port}/api/mv-stream-info?id=${encodeURIComponent(vid || '')}&title=${encodeURIComponent((track && track.title) || '')}&artist=${encodeURIComponent((track && track.artist) || '')}&token=${encodeURIComponent(token)}`);
            const data = await resp.json();
            if (data && data.success && data.url) {
              el.mvVideo.dataset.trackKey = trackKey;
              el.mvVideo.dataset.vid = vid || (data.resolvedId || '');
              el.mvVideo.src = data.url;
              el.mvVideo.load();
            } else {
              if (typeof showToast === 'function') showToast(data && data.error ? `Lỗi MV: ${data.error}` : 'Không thể tải luồng video');
            }
          } catch (e) {
            try { console.error('MV fetch error:', e); } catch (_) {}
            if (typeof showToast === 'function') showToast('Không thể kết nối máy chủ video');
          } finally {
            if (el.mvLoadingOverlay) el.mvLoadingOverlay.classList.add('hidden');
            this.loading = false;
          }
        } else if (el.mvVideo.readyState >= 1) {
          const cur = el.nativeAudio ? (el.nativeAudio.currentTime || 0) : 0;
          try {
            el.mvVideo.currentTime = cur;
            if (state.isPlaying && !el.nativeAudio.paused) {
              el.mvVideo.play().catch(() => {});
            }
          } catch (_) {}
        }
      }
    },
    hideMv() {
      this.active = false;
      this.videoId = null;

      if (el.btnAvVideo) el.btnAvVideo.classList.remove('active');
      if (el.btnAvSong) el.btnAvSong.classList.add('active');
      if (el.btnToggleMv) el.btnToggleMv.classList.remove('active');
      if (el.coverContainer) el.coverContainer.classList.remove('hidden');
      if (el.mvPlayerWrapper) el.mvPlayerWrapper.classList.add('hidden');

      if (el.mvVideo) {
        try { el.mvVideo.pause(); } catch (_) {}
      }
    },
    toggle() {
      if (this.active) {
        this.hideMv();
      } else {
        this.showMv();
      }
    },
    onTrackChanged(track) {
      if (!this.active) return;
      this.showMv();
    },
    onPlay() {
      if (!this.active || !el.mvVideo) return;
      try {
        if (el.nativeAudio) el.mvVideo.currentTime = el.nativeAudio.currentTime;
        el.mvVideo.play().catch(() => {});
      } catch (_) {}
    },
    onPause() {
      if (!this.active || !el.mvVideo) return;
      try { el.mvVideo.pause(); } catch (_) {}
    },
    onSeek(sec) {
      if (!this.active || !el.mvVideo) return;
      try { el.mvVideo.currentTime = sec; } catch (_) {}
    },
    onTimeUpdate(curTime) {
      if (!this.active || !el.mvVideo || this.loading) return;
      try {
        if (el.mvVideo.readyState >= 2) {
          const diff = Math.abs(el.mvVideo.currentTime - curTime);
          if (diff > 0.4) {
            el.mvVideo.currentTime = curTime;
          }
        }
      } catch (_) {}
    }
  };

  function togglePlayPause() {
    if (state._isLoadingAudio) {
      if (state.currentAbortController) {
        try { state.currentAbortController.abort(); } catch (_) {}
      }
      hideAudioLoadingState();
      updatePlayPauseButton(false, false);
      showToast('Đã dừng kết nối bài hát', 'info');
      return;
    }
    if (!state.currentTrack) {
      startWaveIfIdle();
      return;
    }
    if (mvController && mvController.active) {
      if (state.isPlaying) {
        state.isPlaying = false;
        mvController.onPause();
        updatePlayPauseButton(false, false);
      } else {
        state.isPlaying = true;
        mvController.onPlay();
        updatePlayPauseButton(true, false);
      try { updateTopMomentPin(); prefetchUpcomingQueueStreams(); } catch (_) {}
      }
      return;
    }
    if (!state.currentTrack) {
      startWaveIfIdle();
      return;
    }
    if (state.isPlaying) {
      abortAutoMixIfActive('pause');
      pauseSmooth();
    } else {
      playSmooth();
    }
  }

  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' && e.key !== ' ') return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const act = document.activeElement;
    const isInput = act && (
      (act.tagName === 'INPUT' && !['range', 'button', 'checkbox', 'radio'].includes((act.type || '').toLowerCase())) ||
      act.tagName === 'TEXTAREA' ||
      act.isContentEditable
    );
    if (isInput) return;
    if (syncState && syncState.active) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (act && (act.tagName === 'BUTTON' || act.classList.contains('track-row')) && typeof act.blur === 'function') act.blur();
    togglePlayPause();
  }, true);

  function recordPlayedIndex(idx) {
    if (typeof idx !== 'number' || idx < 0) return;
    const h = state.queueHistory;
    if (h[h.length - 1] !== idx) h.push(idx);
    if (h.length > 200) h.shift();
  }

  async function playNext() {
    if (typeof window !== 'undefined') {
    window._eclipsePlayNext = playNext;
    window.EclipseCore = window.MurielCore = {
      state,
      audio: el.nativeAudio,
      base: () => `http://127.0.0.1:${state.serverPort}`,
      getFavorites: () => Array.isArray(state.favorites) ? state.favorites : [],
      getQueue: () => Array.isArray(state.queue) ? state.queue : [],
      getQueueIndex: () => typeof state.queueIndex === 'number' ? state.queueIndex : -1,
      getNextTrack: () => (Array.isArray(state.queue) && state.queueIndex + 1 < state.queue.length) ? state.queue[state.queueIndex + 1] : null,
      getCurrentSponsorSegments: () => Array.isArray(currentTrackSponsorSegments) ? currentTrackSponsorSegments : [],
      playNext: () => playNext()
    };
  }
    if (syncState && syncState.active) return;
    if (state.queue.length === 0) return;
    abortAutoMixIfActive('skip');
    if (state.serverPort) {
      fetch(`http://127.0.0.1:${state.serverPort}/api/network-profile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bumpGeneration: true })
      }).catch(() => {});
    }

    if (!state._isNaturalEnding && state.myWaveActive && state.currentTrack) {
      const cur = (el.nativeAudio && typeof el.nativeAudio.currentTime === 'number') ? el.nativeAudio.currentTime : 0;
      if (cur < 12 && typeof recordWaveSkip === 'function') {
        recordWaveSkip(state.currentTrack);
        state._skipRecordedFor = (typeof getTrackCanonicalId === 'function' ? getTrackCanonicalId(state.currentTrack) : '') || state.currentTrack.id;
      }
    }

    if (state.isRadioQueue && state.queueIndex + 1 >= state.queue.length) {
      await ensureInfiniteWaveQueue(true);
      if (state.queueIndex + 1 < state.queue.length) {
        let nextIdx = state.queueIndex + 1;
        while (nextIdx < state.queue.length && (isTrackBlocked(state.queue[nextIdx]) || isArtistBlocked(state.queue[nextIdx]?.artist))) {
          nextIdx++;
        }
        if (nextIdx < state.queue.length) {
          state.queueIndex = nextIdx;
          recordPlayedIndex(nextIdx);
          playTrack(state.queue[nextIdx]);
          return;
        }
      }
    }

    // AutoMix DJ exact handover: jump straight to the track crossfaded by integration-bridge (Equal Power = i+1, Tempo Synced = closest BPM)
    if (state._autoMixHandover && typeof state._autoMixHandover.targetIndex === 'number') {
      const targetIdx = state._autoMixHandover.targetIndex;
      if (nextTrackCoordinator) {
        nextTrackCoordinator.commit(state._autoMixHandover.reservationToken || null);
      }
      if (targetIdx >= 0 && targetIdx < state.queue.length) {
        state.queueIndex = targetIdx;
        recordPlayedIndex(targetIdx);
        playTrack(state.queue[targetIdx]);
        return;
      }
    }

    if (nextTrackCoordinator) {
      const plan = await nextTrackCoordinator.reserve();
      const committed = plan ? nextTrackCoordinator.commit(plan.token) : null;
      if (committed && committed.targetIndex >= 0 && committed.targetIndex < state.queue.length) {
        state.queueIndex = committed.targetIndex;
        recordPlayedIndex(committed.targetIndex);
        playTrack(state.queue[committed.targetIndex]);
        if (state.myWaveActive && state.queueIndex >= state.queue.length - 3 && typeof extendMyWaveQueue === 'function') {
          extendMyWaveQueue();
        }
        return;
      }
      if (state.myWaveActive && typeof extendMyWaveQueue === 'function') {
        extendMyWaveQueue().then(added => {
          if (added && state.queueIndex + 1 < state.queue.length) {
            playNext();
          }
        });
        return;
      }
      pauseSmooth();
      return;
    }

    if (state.isShuffle && !state.isAutoRemix) {
      const provider = shuffleProvider;
      let nextIdx = -1;
      if (provider) {
        try {
          const pick = await provider.fn({
            queue: state.queue.slice(),
            queueIndex: state.queueIndex,
            context: state.currentTrackContext,
            current: state.currentTrack
          });
          if (pick) nextIdx = state.queue.findIndex(track => isSameTrack(track, pick));
        } catch (e) { console.warn('[better-shuffle] provider error', e); }
      }
      if (nextIdx < 0) {
        const eligible = state.queue.map((track, index) => index)
          .filter(index => !isTrackBlocked(state.queue[index]) && !isArtistBlocked(state.queue[index]?.artist));
        if (eligible.length === 0) return;
        const recent = new Set(state.queueHistory.slice(-Math.max(1, Math.floor(eligible.length / 2))));
        const pool = eligible.filter(index => !recent.has(index));
        const candidates = pool.length ? pool : eligible;
        nextIdx = candidates[Math.floor(Math.random() * candidates.length)];
      }
      state.queueIndex = nextIdx;
      recordPlayedIndex(nextIdx);
      playTrack(state.queue[nextIdx]);
      return;
    }

    let nextIdx = state.queueIndex + 1;
    let attempts = 0;
    while (attempts < state.queue.length) {
      if (nextIdx >= state.queue.length) {
        if (state.myWaveActive && typeof extendMyWaveQueue === 'function') {
          extendMyWaveQueue().then(added => {
            if (added && state.queueIndex + 1 < state.queue.length) {
              playNext();
            }
          });
          return;
        }
        if (state.repeatMode === 'all') {
          nextIdx = 0;
        } else {
          // repeatMode === 'off' (or 'one' ended without loop)
          pauseSmooth();
          return;
        }
      }
      const candidate = state.queue[nextIdx];
      if (candidate && (isTrackBlocked(candidate) || isArtistBlocked(candidate.artist))) {
        nextIdx++;
        attempts++;
        continue;
      }
      break;
    }
    state.queueIndex = nextIdx;
    recordPlayedIndex(nextIdx);
    playTrack(state.queue[nextIdx]);

    if (state.myWaveActive && state.queueIndex >= state.queue.length - 3 && typeof extendMyWaveQueue === 'function') {
      extendMyWaveQueue();
    }
  }

  function playPrev() {
    if (syncState && syncState.active) return;
    if (nextTrackCoordinator) nextTrackCoordinator.cancel('prev_track');
    abortAutoMixIfActive('skip');
    if (el.nativeAudio && el.nativeAudio.currentTime > 3) {
      el.nativeAudio.currentTime = 0;
      return;
    }
    {
      const h = state.playHistory || [];
      if (h.length) {
        const prev = h.pop();
        navigatingBack = true;
        try { playTrack(prev); } finally { navigatingBack = false; }
        const prevIdx = state.queue.findIndex(t => t.id === prev.id || isSameTrack(t, prev));
        if (prevIdx !== -1) state.queueIndex = prevIdx;
        return;
      }
    }
    if (state.queue.length === 0) return;

    const h = state.queueHistory;
    if (h.length > 1) {
      h.pop();
      const prevIdx = h[h.length - 1];
      if (prevIdx >= 0 && prevIdx < state.queue.length) {
        state.queueIndex = prevIdx;
        playTrack(state.queue[prevIdx]);
        return;
      }
      h.push(state.queueIndex);
    }

    let prevIdx = state.queueIndex - 1;
    if (prevIdx < 0) prevIdx = state.queue.length - 1;
    state.queueIndex = prevIdx;
    state.queueHistory = [prevIdx];
    playTrack(state.queue[prevIdx]);
  }

  if (typeof window !== 'undefined') {
    window._eclipsePlayNext = playNext;
    window.EclipseCore = window.MurielCore = {
      state,
      audio: el.nativeAudio,
      base: () => `http://127.0.0.1:${state.serverPort}`,
      getFavorites: () => Array.isArray(state.favorites) ? state.favorites : [],
      getQueue: () => Array.isArray(state.queue) ? state.queue : [],
      getQueueIndex: () => typeof state.queueIndex === 'number' ? state.queueIndex : -1,
      getNextTrack: () => (Array.isArray(state.queue) && state.queueIndex + 1 < state.queue.length) ? state.queue[state.queueIndex + 1] : null,
      getCurrentSponsorSegments: () => Array.isArray(currentTrackSponsorSegments) ? currentTrackSponsorSegments : [],
      playNext: () => playNext()
    };
  }

  if (el.nativeAudio) {
    el.nativeAudio.addEventListener('volumechange', () => {
      if (!el.nativeAudio || window._autoMixSuppressVolumeSync) return;
      const extMuted = !!el.nativeAudio.muted;
      if (audioEngine && Number.isFinite(audioEngine.appliedElementVolume) &&
          Math.abs(el.nativeAudio.volume - audioEngine.appliedElementVolume) < 0.005) return;
      const expectedNativeVol = state.volume <= 0 ? 0 : Math.pow(state.volume, 1.8);
      if (extMuted !== state.isMuted || (!extMuted && Math.abs(el.nativeAudio.volume - expectedNativeVol) > 0.02)) {
        state.isMuted = extMuted;
        if (!extMuted) {
          const linearVol = el.nativeAudio.volume <= 0 ? 0 : Math.pow(el.nativeAudio.volume, 1 / 1.8);
          state.volume = Math.max(0, Math.min(1, Math.round(linearVol * 100) / 100));
        }
        if (el.volumeSlider) el.volumeSlider.value = String(state.volume);
        if (el.volumeIcon) el.volumeIcon.classList.toggle('hidden', state.isMuted);
        if (el.volumeMutedIcon) el.volumeMutedIcon.classList.toggle('hidden', !state.isMuted);
        persistVolumeState();
        if (audioEngine) {
          audioEngine.volume = state.volume;
          audioEngine.isMuted = state.isMuted;
        }
      }
    });

    el.nativeAudio.addEventListener('error', async () => {
      if (el.trackLoadingOverlay) el.trackLoadingOverlay.classList.add('hidden');
      const cur = state.currentTrack;
      if (!cur) {
        updatePlayPauseButton(false, false);
        return;
      }
      if (cur.platform === 'local') {
        updatePlayPauseButton(false, false);
        showToast('File missing from library', 'error');
        return;
      }
      const currentSrc = el.nativeAudio.src || '';
      const retryStage = cur._errorRetryStage || 0;
      const myToken = state.loadToken;

      if (retryStage === 0 && currentSrc && !currentSrc.includes('/api/audio-proxy') && !currentSrc.includes('127.0.0.1')) {
        cur._errorRetryStage = 1;
        const proxied = `http://127.0.0.1:${state.serverPort}/api/audio-proxy?url=${encodeURIComponent(currentSrc)}`;
        el.nativeAudio.src = proxied;
        playSmooth();
        return;
      }

      if (retryStage <= 1) {
        cur._errorRetryStage = 2;
        try {
          const reqQuality = getConfiguredAudioQuality();
          const qQuality = encodeURIComponent(reqQuality);
          const qSearch = encodeURIComponent(cur.searchQuery || ((cur.artist ? cur.artist + ' - ' : '') + (cur.title || '')));
          const retryYtId = cur._matchedYtId || cur.id || '';
          const retryTrackUrl = cur.url || (cur._matchedYtId ? ('https://www.youtube.com/watch?v=' + cur._matchedYtId) : '');
          const retryUrl = `http://127.0.0.1:${state.serverPort}/api/stream-info?url=${encodeURIComponent(retryTrackUrl)}&id=${encodeURIComponent(retryYtId)}&platform=${encodeURIComponent(cur.platform || state.platform)}&title=${encodeURIComponent(cur.title || '')}&artist=${encodeURIComponent(cur.artist || '')}&duration=${encodeURIComponent(cur.duration || 0)}&quality=${qQuality}&q=${qSearch}&forceYtDlp=1&token=${encodeURIComponent((window.electronAPI && window.electronAPI.serverToken) || (state && state.serverToken) || '')}`;
          const r = await fetch(retryUrl);
          const d = await r.json();
          if (myToken !== state.loadToken) return;
          if (d && d.success && d.streamUrl) {
            cur._preloadedStreamUrl = d.proxyUrl || d.streamUrl;
            cur._preloadedStreamQuality = (d.resolvedQuality ? String(d.resolvedQuality).trim().toLowerCase() : reqQuality);
            cur._preloadedStreamPlatform = String(cur.platform || state.platform || 'ytmusic').trim().toLowerCase();
            cur._preloadedStreamUrlExpires = Date.now() + 3600 * 1000;
            el.nativeAudio.src = d.proxyUrl || d.streamUrl;
            playSmooth();
            return;
          }
        } catch (_) {}
      }

      cur._errorRetryStage = 0;
      state.isPlaying = false;
      updatePlayPauseButton(false, false);
      state._consecutiveErrors = (state._consecutiveErrors || 0) + 1;
      if (state._consecutiveErrors <= 2 && state.queue && state.queue.length > 1) {
        showToast('Could not play this track, trying next...', 'warning');
        setTimeout(() => {
          if (myToken === state.loadToken && !state.isPlaying) playNext();
        }, 1200);
      } else {
        state._consecutiveErrors = 0;
        showToast('Playback stopped: stream unavailable', 'error');
      }
    });

    function postNetworkDiagnostics(payload) {
      if (!state.serverPort || !payload) return;
      const headers = { 'Content-Type': 'application/json' };
      const token = (window.electronAPI && window.electronAPI.serverToken) || state.serverToken || '';
      if (token) headers['x-eclipse-token'] = token;
      fetch(`http://127.0.0.1:${state.serverPort}/api/network-diagnostics`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
      }).catch(() => {});
    }

    el.nativeAudio.addEventListener('waiting', () => {
      updatePlayPauseButton(state.isPlaying, true);
      const nowPerf = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      if (!state._waitingStartedPerfMs) state._waitingStartedPerfMs = nowPerf;
      postNetworkDiagnostics({ playbackBuffering: true });
    });

    function prefetchNextQueueTrack() {
      if (typeof preloadNextTrackStream === 'function') {
        preloadNextTrackStream();
      }
    }

    el.nativeAudio.addEventListener('playing', () => {
      state._consecutiveErrors = 0;
      state.isPlaying = true;
      document.body.classList.add('is-playing');
      updatePlayPauseButton(true, false);
      if (state.serverPort) {
        const nowPerf = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        const payload = { playbackBuffering: false };
        if (state._waitingStartedPerfMs) {
          payload.waitingDeltaMs = Math.max(0, nowPerf - state._waitingStartedPerfMs);
          state._waitingStartedPerfMs = 0;
        }
        const cur = state.currentTrack;
        if (cur && !cur._firstPlayingRecorded && Number.isFinite(cur._playStartPerfMs)) {
          cur._firstPlayingRecorded = true;
          payload.firstPlayingMs = Math.max(0, nowPerf - cur._playStartPerfMs);
        }
        postNetworkDiagnostics(payload);
      }
      // Start resolving the next track as soon as playback begins instead of
      // waiting 10s, so the following track starts without a pause.
      if (!preloadedTrack10sFired) {
        preloadedTrack10sFired = true;
        preloadNextTrackStream();
      }
    });

    el.nativeAudio.addEventListener('canplay', () => {
      updatePlayPauseButton(state.isPlaying, false);
      const cur = state.currentTrack;
      if (state.serverPort && cur && !cur._firstBufferedRecorded && Number.isFinite(cur._playStartPerfMs)) {
        cur._firstBufferedRecorded = true;
        const nowPerf = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        postNetworkDiagnostics({ firstBufferedMs: Math.max(0, nowPerf - cur._playStartPerfMs) });
      }
      if (audioEngine && typeof audioEngine.applySettings === 'function') {
        audioEngine.applySettings(el.nativeAudio);
      }
    });

    el.nativeAudio.addEventListener('loadstart', () => {
      state.audioDurationStale = true;
      state._waitingStartedPerfMs = 0;
    });

    el.nativeAudio.addEventListener('loadedmetadata', () => {
      state.audioDurationStale = false;
      if (audioEngine && typeof audioEngine.applySettings === 'function') {
        audioEngine.applySettings(el.nativeAudio);
      }
      try {
        const tr = getTrackTrim(state.currentTrack);
        if (tr && Number.isFinite(tr.end) && tr.end > (tr.start || 0) + 1.5 && el.nativeAudio.currentTime < tr.start) {
          el.nativeAudio.currentTime = tr.start;
        }
      } catch (_) {}
      const audio = el.nativeAudio;
      const metaDur = (state.currentTrack && Number.isFinite(state.currentTrack.duration) && state.currentTrack.duration > 0) ? state.currentTrack.duration : 0;
      const audioDur = (audio && Number.isFinite(audio.duration) && audio.duration > 1) ? audio.duration : 0;
      if (state.currentTrack && audioDur > 1 && !(metaDur > 45 && audioDur < 32)) {
        const newDur = Math.round(audioDur);
        state.currentTrack.duration = newDur;
        const tid = state.currentTrack.id;
        if (Array.isArray(state.queue)) {
          state.queue.forEach((t) => { if (t && t.id === tid) t.duration = newDur; });
        }
        if (Array.isArray(state.playlists)) {
          state.playlists.forEach((p) => {
            if (p && Array.isArray(p.tracks)) {
              p.tracks.forEach((t) => { if (t && t.id === tid) t.duration = newDur; });
            }
          });
        }
      }
      const d = formatDuration(getReliableTrackDuration());
      if (el.timeDuration) el.timeDuration.textContent = d;
      syncTvkTimeDisplay(undefined, d);
    });

    el.nativeAudio.addEventListener('play', () => {
      try { onLastFmTrackStart(state.currentTrack); } catch (_) {}
      try {
        const tr = getTrackTrim(state.currentTrack);
        if (tr && Number.isFinite(tr.end) && tr.end > (tr.start || 0) + 1.5 && el.nativeAudio.currentTime < tr.start) {
          el.nativeAudio.currentTime = tr.start;
        }
      } catch (_) {}
      emitPluginEvent('play');
      if (!hasNotifiedMediaKeysActive) {
        hasNotifiedMediaKeysActive = true;
        if (window.electronAPI && window.electronAPI.mediaKeysActive) {
          window.electronAPI.mediaKeysActive();
        }
      }
      updatePlayPauseButton(true, false);
      if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = state.isPlaying ? 'playing' : 'paused';
      }
      if (!state.isPlaying) {
        state.isPlaying = true;
        document.body.classList.add('is-playing');
        if (el.coverContainer && state.vfx.vinylSpin) el.coverContainer.classList.add('spinning');
        if ('mediaSession' in navigator) {
          navigator.mediaSession.playbackState = state.isPlaying ? 'playing' : 'paused';
        }
        sendDiscordRpcUpdate(state.currentTrack, true);
        sendStateToServer();
        updateMediaSession();
      }
      updateMediaPositionState();
      hideAudioLoadingState();
      if (el.trackLoadingOverlay) el.trackLoadingOverlay.classList.add('hidden');
      hasDrawnPausedFrame = false;
      if (!animationFrameId) startVisualizers();
      if (audioEngine) {
        if (audioEngine.resumeAudioContext) audioEngine.resumeAudioContext();
        audioEngine._applyMasterVolume();
      }
      if (crossfadeFadeInPending) {
        crossfadeFadeInPending = false;
        const X = parseInt(localStorage.getItem('eclipse_crossfade') || '0', 10);
        if (X > 0 && audioEngine) audioEngine.fadeIn(X / 2);
      }
      if (typeof m3cStart === 'function') m3cStart();
    });

    el.nativeAudio.addEventListener('pause', () => {
      isPauseFading = false;
      emitPluginEvent('pause');
      updatePlayPauseButton(false, false);
      if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = state.isPlaying ? 'playing' : 'paused';
      }
      if (state.isPlaying) {
        state.isPlaying = false;
        document.body.classList.remove('is-playing');
        if (el.coverContainer) el.coverContainer.classList.remove('spinning');
        if ('mediaSession' in navigator) {
          navigator.mediaSession.playbackState = state.isPlaying ? 'playing' : 'paused';
        }
        sendDiscordRpcUpdate(state.currentTrack, false);
        sendStateToServer();
        updateMediaSession();
      }
      updateMediaPositionState();
      if (audioEngine) {
        if (audioEngine.suspendAudioContextDebounced) audioEngine.suspendAudioContextDebounced(5000);
        if (audioEngine.setAnalyserEnabled) audioEngine.setAnalyserEnabled(false);
      }
      if (typeof applyM3Cover === 'function') applyM3Cover();
    });

    function getReliableTrackDuration() {
      const metaDur = (state.currentTrack && Number.isFinite(state.currentTrack.duration) && state.currentTrack.duration > 0) ? state.currentTrack.duration : 0;
      const audioDur = (!state.audioDurationStale && el.nativeAudio && Number.isFinite(el.nativeAudio.duration) && el.nativeAudio.duration > 1) ? el.nativeAudio.duration : 0;
      if (metaDur > 45 && audioDur < 32) return metaDur;
      if (audioDur > 1) return audioDur;
      return metaDur;
    }

    el.nativeAudio.addEventListener('ended', () => {
      if (window._autoMixHandlingEnd) return;
      updatePlayPauseButton(false, false);
      if (state.sleepTimer && state.sleepTimer.mode === 'end') {
        state.sleepTimer = null;
        updateSleepTimerUI();
        return;
      }
      if (audioEngine) {
        if (audioEngine.suspendAudioContextDebounced) audioEngine.suspendAudioContextDebounced(5000);
        if (audioEngine.setAnalyserEnabled) audioEngine.setAnalyserEnabled(false);
      }
      if (syncState && syncState.active) {
        pauseSmooth();
        return;
      }
      if (state.isRepeat) {
        el.nativeAudio.currentTime = 0;
        playSmooth();
      } else {
        const expectedDur = getReliableTrackDuration();
        const pos = el.nativeAudio.currentTime || 0;
        if (state.currentTrack && state.currentTrack.platform !== 'local' && expectedDur > 25 && pos > 2 && pos < expectedDur - 12 && (state._streamRecoverCount || 0) < 2) {
          state._streamRecoverCount = (state._streamRecoverCount || 0) + 1;
          el.nativeAudio.currentTime = pos;
          playSmooth();
          return;
        }
        state._isNaturalEnding = true;
        try {
          playNext();
        } finally {
          state._isNaturalEnding = false;
        }
      }
    });

    el.nativeAudio.addEventListener('durationchange', () => {
      const audio = el.nativeAudio;
      const metaDur = (state.currentTrack && Number.isFinite(state.currentTrack.duration) && state.currentTrack.duration > 0) ? state.currentTrack.duration : 0;
      const audioDur = (!state.audioDurationStale && audio && Number.isFinite(audio.duration) && audio.duration > 1) ? audio.duration : 0;
      if (state.currentTrack && audioDur > 1 && !(metaDur > 45 && audioDur < 32)) {
        const newDur = Math.round(audioDur);
        state.currentTrack.duration = newDur;
        const tid = state.currentTrack.id;
        if (Array.isArray(state.queue)) {
          state.queue.forEach((t) => { if (t && t.id === tid) t.duration = newDur; });
        }
        if (Array.isArray(state.playlists)) {
          state.playlists.forEach((p) => {
            if (p && Array.isArray(p.tracks)) {
              p.tracks.forEach((t) => { if (t && t.id === tid) t.duration = newDur; });
            }
          });
        }
      }
      const d = formatDuration(getReliableTrackDuration());
      if (el.timeDuration) el.timeDuration.textContent = d;
      syncTvkTimeDisplay(undefined, d);
      updateMediaPositionState();
    });

    el.nativeAudio.addEventListener('seeked', () => {
      try { mvController.onSeek(el.nativeAudio.currentTime); } catch (_) {}
      lastDisplayedSec = -1;
      lastTimeupdateSec = -1;
      const seekCur = el.nativeAudio.currentTime || 0;
      const seekDur = getReliableTrackDuration();
      const seekCurText = formatDuration(seekCur);
      const seekDurText = formatDuration(seekDur);
      if (el.timeCurrent) el.timeCurrent.textContent = seekCurText;
      if (el.timeDuration) el.timeDuration.textContent = seekDurText;
      syncTvkTimeDisplay(seekCurText, seekDurText);
      if (el.tvkSeekSlider && !isDraggingTvkSeek && seekDur > 0) {
        el.tvkSeekSlider.value = Math.round((seekCur / seekDur) * 1000);
      }
      updateMediaPositionState();
      state.forceLyricsScroll = true;
      state.forceSnapLyrics = true;
      state.lastActiveLyricIdx = -1;
      if (state.isRightPanelOpen || state.isTvKaraokeOpen) {
        updateSyncedLyricsHighlight(el.nativeAudio.currentTime || 0);
      }
      sendDiscordRpcUpdate(state.currentTrack, true);
    });

    lastTimeupdateSec = -1;
    el.nativeAudio.addEventListener('timeupdate', () => {
      try { mvController.onTimeUpdate(el.nativeAudio.currentTime || 0); } catch (_) {}
      if (!preloadedTrack10sFired && el.nativeAudio && el.nativeAudio.currentTime >= 10) {
        preloadedTrack10sFired = true;
        preloadNextTrackStream();
      }
      try { onLastFmTimeUpdate(); } catch (_) {}
      try {
        if (localStorage.getItem('eclipse_skip_silence_enabled') === '1' && audioEngine && el.nativeAudio && !el.nativeAudio.paused && !isDraggingScrubber) {
          const cur = el.nativeAudio.currentTime;
          if (cur >= 0.5 && cur < 12.0 && audioEngine.isSilent(-52)) {
            el.nativeAudio.currentTime += 0.5;
          }
        }
      } catch (_) {}
      try {
        if (localStorage.getItem('eclipse_sponsorblock_enabled') !== '0' && currentTrackSponsorSegments.length > 0 && el.nativeAudio && !isDraggingScrubber) {
          const curTime = el.nativeAudio.currentTime;
          const enabledCats = typeof getEnabledSponsorBlockCategories === 'function' ? getEnabledSponsorBlockCategories() : null;
          for (const seg of currentTrackSponsorSegments) {
            if (enabledCats && seg.category && !enabledCats.has(seg.category)) continue;
            if (curTime >= seg.start - 0.25 && curTime < seg.end - 0.5 && lastSkippedSegmentEnd !== seg.end) {
              lastSkippedSegmentEnd = seg.end;
              el.nativeAudio.currentTime = seg.end;
              const catName = seg.category ? seg.category.replace('_', ' ') : 'non-music';
              showToast(`Skipped ${catName} segment`, 'info');
              break;
            }
          }
        }
      } catch (_) {}
      updateMediaPositionState();
      try {
        const activeTrim = state.currentTrack ? getTrackTrim(state.currentTrack) : null;
        if (activeTrim && Number.isFinite(activeTrim.end) && activeTrim.end > (activeTrim.start || 0) + 1.5 && el.nativeAudio && !isDraggingScrubber) {
          if (activeTrim.start > 0 && el.nativeAudio.currentTime < activeTrim.start - 0.25) {
            el.nativeAudio.currentTime = activeTrim.start;
          } else if (activeTrim.end > activeTrim.start && el.nativeAudio.currentTime >= activeTrim.end) {
            if (state.isRepeat) {
              el.nativeAudio.currentTime = activeTrim.start;
              playSmooth();
            } else {
              state._isNaturalEnding = true;
              try { playNext(); } finally { state._isNaturalEnding = false; }
            }
            return;
          }
        }
      } catch (_) {}

      const cur = (el.nativeAudio && Number.isFinite(el.nativeAudio.currentTime)) ? el.nativeAudio.currentTime : 0;
      const dur = getReliableTrackDuration();

      const X = parseInt(localStorage.getItem('eclipse_crossfade') || '0', 10);
      const autoMixActive = !!(window.autoMixDjInstance && window.autoMixDjInstance.enabled);
      if (X > 0 && !autoMixActive && !window._autoMixHandlingEnd && !crossfadeTriggered && !state.isRepeat && dur > Math.max(X * 3, 30) && (!hlsInstance || dur >= (state.currentTrack?.duration || 0) * 0.9) && cur >= dur - X && (!audioEngine || !audioEngine.isLiveStream(el.nativeAudio))) {
        crossfadeTriggered = true;
        crossfadeFadeInPending = true;
        if (audioEngine) audioEngine.fadeOut(X / 2);
        state._isNaturalEnding = true;
        try {
          playNext();
        } finally {
          state._isNaturalEnding = false;
        }
      }

      if (state.isPlaying && cur > 5 && !state.nextTrackPrefetched) {
        state.nextTrackPrefetched = true;
        prefetchNextQueueTrack();
      }

      if (!state.isPlaying && typeof m3cDraw === 'function' && typeof m3cEnabled === 'function' && m3cEnabled()) {
        m3cDraw(performance.now());
      }

      if (isPauseFading || isDraggingScrubber) return;
      const roundedSec = Math.floor(cur);
      if (lastTimeupdateSec === roundedSec) return;
      lastTimeupdateSec = roundedSec;
      if (state.isRightPanelOpen || state.isTvKaraokeOpen) {
        updateSyncedLyricsHighlight(cur);
      }
      const curFormatted = formatDuration(cur);
      const durFormatted = formatDuration(dur);
      if (el.timeCurrent) el.timeCurrent.textContent = curFormatted;
      if (el.timeDuration) el.timeDuration.textContent = durFormatted;
      syncTvkTimeDisplay(curFormatted, durFormatted);
      if (el.tvkSeekSlider && !isDraggingTvkSeek && dur > 0) {
        el.tvkSeekSlider.value = Math.round((cur / dur) * 1000);
      }
    });
  }

  let isDraggingScrubber = false;

  function updateScrubberPositionFromEvent(e) {
    if (!el.scrubberTrack) return 0;
    const rect = el.scrubberTrack.getBoundingClientRect();
    const padLeft = 5.5;
    const trackWidth = rect.width - 2 * padLeft;
    let pos = trackWidth > 0 ? (e.clientX - rect.left - padLeft) / trackWidth : 0;
    pos = Math.max(0, Math.min(1, pos));
    const dur = (el.nativeAudio && Number.isFinite(el.nativeAudio.duration) && el.nativeAudio.duration > 0)
      ? el.nativeAudio.duration
      : (state.currentTrack && Number.isFinite(state.currentTrack.duration) ? state.currentTrack.duration : 0);
    const targetTime = pos * dur;

    state.scrubberDragTargetTime = targetTime;
    if (el.timeCurrent) el.timeCurrent.textContent = formatDuration(targetTime);
    return targetTime;
  }

  if (el.scrubberTrack) {
    el.scrubberTrack.addEventListener('mousedown', (e) => {
      isDraggingScrubber = true;
      hasDrawnPausedFrame = false;
      if (!animationFrameId) startVisualizers();
      el.scrubberTrack.classList.add('dragging');
      updateScrubberPositionFromEvent(e);
    });
  }

  window.addEventListener('mousemove', (e) => {
    if (!isDraggingScrubber || isDraggingTvkScrubber) return;
    updateScrubberPositionFromEvent(e);
  });

  window.addEventListener('mouseup', (e) => {
    if (!isDraggingScrubber || isDraggingTvkScrubber) return;
    isDraggingScrubber = false;
    abortAutoMixIfActive('seek');
    if (el.scrubberTrack) el.scrubberTrack.classList.remove('dragging');
    const targetTime = updateScrubberPositionFromEvent(e);
    if (!isNaN(targetTime) && el.nativeAudio) {
      el.nativeAudio.currentTime = targetTime;
      updateMediaPositionState();
    }
    state.scrubberDragTargetTime = undefined;
  });

  let isDraggingTvkScrubber = false;
  function updateTvkScrubberPositionFromEvent(e) {
    const track = document.getElementById('tvk-scrubber-track') || document.getElementById('tvk-progress-row');
    if (!track) return 0;
    const rect = track.getBoundingClientRect();
    const padLeft = 5.5;
    const trackWidth = rect.width - 2 * padLeft;
    let pos = trackWidth > 0 ? (e.clientX - rect.left - padLeft) / trackWidth : 0;
    pos = Math.max(0, Math.min(1, pos));
    const dur = getReliableTrackDuration();
    const targetTime = pos * dur;
    state.scrubberDragTargetTime = targetTime;
    const targetText = formatDuration(targetTime);
    syncTvkTimeDisplay(targetText, undefined);
    if (el.timeCurrent) el.timeCurrent.textContent = targetText;
    return targetTime;
  }

  const tvkProgRowEl = document.getElementById('tvk-scrubber-track') || document.getElementById('tvk-progress-row');
  if (tvkProgRowEl) {
    tvkProgRowEl.addEventListener('pointerdown', (e) => {
      isDraggingTvkScrubber = true;
      isDraggingScrubber = true;
      hasDrawnPausedFrame = false;
      if (!animationFrameId) startVisualizers();
      updateTvkScrubberPositionFromEvent(e);
      try { tvkProgRowEl.setPointerCapture(e.pointerId); } catch (_) {}
    });
    tvkProgRowEl.addEventListener('pointermove', (e) => {
      if (!isDraggingTvkScrubber) return;
      updateTvkScrubberPositionFromEvent(e);
    });
    const finishTvkSeek = (e) => {
      if (!isDraggingTvkScrubber) return;
      isDraggingTvkScrubber = false;
      isDraggingScrubber = false;
      abortAutoMixIfActive('seek');
      const targetTime = updateTvkScrubberPositionFromEvent(e);
      if (!isNaN(targetTime) && el.nativeAudio) {
        el.nativeAudio.currentTime = targetTime;
        updateMediaPositionState();
      }
      state.scrubberDragTargetTime = undefined;
      try { tvkProgRowEl.releasePointerCapture(e.pointerId); } catch (_) {}
    };
    tvkProgRowEl.addEventListener('pointerup', finishTvkSeek);
    tvkProgRowEl.addEventListener('pointercancel', finishTvkSeek);
  }

  let playbarTimelineTimer = null;
  if (el.playbar) {
    const showBarTimeline = () => {
      if (playbarTimelineTimer) { clearTimeout(playbarTimelineTimer); playbarTimelineTimer = null; }
      el.playbar.classList.add('bar-timeline-visible');
    };
    const hideBarTimelineDelayed = () => {
      if (playbarTimelineTimer) clearTimeout(playbarTimelineTimer);
      playbarTimelineTimer = setTimeout(() => {
        if (!isDraggingScrubber && el.playbar) el.playbar.classList.remove('bar-timeline-visible');
      }, 500);
    };
    el.playbar.addEventListener('mouseenter', showBarTimeline);
    el.playbar.addEventListener('pointermove', showBarTimeline);
    el.playbar.addEventListener('mouseleave', hideBarTimelineDelayed);
  }

  const scrollFadeTimers = new WeakMap();
  document.addEventListener('scroll', (e) => {
    const t = e.target;
    if (!t || !t.classList) return;
    t.classList.add('is-scrolling');
    const prev = scrollFadeTimers.get(t);
    if (prev) clearTimeout(prev);
    scrollFadeTimers.set(t, setTimeout(() => t.classList.remove('is-scrolling'), 850));
  }, { capture: true, passive: true });

  if (el.presetsContainer) {
    el.presetsContainer.addEventListener('scroll', updatePresetsFade, { passive: true });
  }
  window.addEventListener('resize', () => {
    updatePresetsFade();
    const c = document.querySelector('#view-album .album-tracks-col');
    if (c) updateFade(c);
    if (el.mainContent) updateFade(el.mainContent);
  });

  async function fetchAlbumsForSearch(query, token) {
    let container = document.getElementById('search-albums-container');
    if (!container) {
      const artistContainer = document.getElementById('search-artist-card-container');
      if (artistContainer && artistContainer.parentNode) {
        container = document.createElement('div');
        container.id = 'search-albums-container';
        artistContainer.parentNode.insertBefore(container, artistContainer.nextSibling);
      }
    }
    if (!container) return;

    try {
      const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/albums/search?q=${encodeURIComponent(query)}`);
      const data = await res.json();
      if (state.searchToken !== token) return;
      if (!data || !data.success || !Array.isArray(data.albums) || data.albums.length === 0) {
        container.innerHTML = '';
        return;
      }

      const albums = data.albums;
      container.innerHTML = `
        <div class="search-albums-section">
          <div class="section-sub-header">
            <h3>Albums</h3>
          </div>
          <div class="search-albums-row">
            ${albums.map(album => {
              const sub = album.year ? `${escapeHtml(album.artist)} · ${escapeHtml(album.year)}` : escapeHtml(album.artist || '');
              return `
                <div class="search-album-card" role="button" tabindex="0">
                  ${album.cover ? `<img class="search-album-cover" src="${escapeHtml(album.cover)}" alt="${escapeHtml(album.title)}" loading="lazy" onerror="this.style.display='none'" />` : '<div class="search-album-cover" style="display:flex;align-items:center;justify-content:center;background:var(--md-sys-color-surface-container-high);"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--md-sys-color-outline);"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg></div>'}
                  <div class="search-album-info">
                    <span class="search-album-title" title="${escapeHtml(album.title)}">${escapeHtml(album.title)}</span>
                    <span class="search-album-sub" title="${sub}">${sub}</span>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        </div>
      `;

      const row = container.querySelector('.search-albums-row');
      if (row) {
        bindHorizontalWheel(row);
        requestAnimationFrame(() => updateRowFade(row));
      }

      const cards = container.querySelectorAll('.search-album-card');
      cards.forEach((card, idx) => {
        const album = albums[idx];
        if (!album) return;
        card.addEventListener('click', () => openAlbum(album));
        card.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            openAlbum(album);
          }
        });
      });
      if (typeof applySearchFilter === 'function') applySearchFilter(currentSearchFilter);
    } catch (e) {
      if (state.searchToken === token && container) {
        container.innerHTML = '';
      }
    }
  }

  function easeInOutCubicFn(x) {
    return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
  }

  function renderM3SearchLoader(container, size = 96) {
    if (!container) return;
    container.innerHTML = `
      <div class="m3-search-loader-wrap">
        <div class="m3-search-shape-stage">
          <svg class="m3-search-loader" width="${size}" height="${size}" viewBox="-180 -180 360 360">
            <path />
          </svg>
          <div class="m3-search-error-icon">
            <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          </div>
        </div>
        <div class="m3-search-error-slot"></div>
      </div>
    `;
    const stage = container.querySelector('.m3-search-shape-stage');
    const svg = container.querySelector('.m3-search-loader');
    const path = svg ? svg.querySelector('path') : null;
    if (!svg || !path) return;
    const S = window.RiffShapes;
    if (!S || !S.ready()) return;

    const STEP_MS = 1150;
    const STEP_ANGLE = Math.PI / 3;
    let fromIdx = 0;
    let toIdx = S.next(0);
    let stepStart = performance.now();
    let baseAngle = 0;
    let currentAngle = 0;
    let lastVel = STEP_ANGLE / STEP_MS;
    const K = S.K;

    const stateObj = {
      stopping: false,
      stopStart: 0,
      stopStartAngle: 0,
      stopExtraAngle: 0,
      stopped: false
    };
    container._m3LoaderState = stateObj;

    function frame(now) {
      if (!svg.isConnected || stateObj.stopped) return;
      let eMorph = 0;

      if (!stateObj.stopping) {
        if (now - stepStart >= STEP_MS) {
          fromIdx = toIdx;
          toIdx = S.next(fromIdx);
          baseAngle = (baseAngle + STEP_ANGLE) % (Math.PI * 2);
          stepStart = now;
        }
        const rawT = Math.min(1, (now - stepStart) / STEP_MS);
        const eased = easeInOutCubicFn(rawT);
        eMorph = eased;
        const prevAngle = currentAngle;
        currentAngle = baseAngle + eased * STEP_ANGLE;
        lastVel = Math.max(0.0003, Math.abs(currentAngle - prevAngle) / 16);
      } else {
        const STOP_DUR = 950;
        const p = Math.min(1, (now - stateObj.stopStart) / STOP_DUR);
        const decel = 1 - Math.pow(1 - p, 3);
        currentAngle = stateObj.stopStartAngle + stateObj.stopExtraAngle * decel;
        eMorph = easeInOutCubicFn(Math.min(1, (stateObj.stopStart - stepStart) / STEP_MS));
        if (p >= 1) {
          stateObj.stopped = true;
        }
      }

      const a = S.profile(fromIdx);
      const b = S.profile(toIdx);
      let d = '';
      for (let k = 0; k < K; k += 3) {
        const th = -Math.PI + (Math.PI * 2 * k) / K + currentAngle;
        const r = a[k] + (b[k] - a[k]) * eMorph;
        d += `${k === 0 ? 'M' : 'L'}${(Math.cos(th) * r).toFixed(1)},${(Math.sin(th) * r).toFixed(1)}`;
      }
      path.setAttribute('d', d + 'Z');
      if (!stateObj.stopped) requestAnimationFrame(frame);
    }

    stateObj.triggerGearStop = () => {
      if (stateObj.stopping) return;
      stateObj.stopping = true;
      stateObj.stopStart = performance.now();
      stateObj.stopStartAngle = currentAngle;
      stateObj.stopExtraAngle = Math.max(0.38, Math.min(1.1, lastVel * 420));
      if (stage) stage.classList.add('is-error');
    };

    requestAnimationFrame(frame);
  }

  function stopM3SearchLoaderWithError(container, errMessage) {
    if (!container) return;
    if (!container.querySelector('.m3-search-loader-wrap')) {
      renderM3SearchLoader(container, 96);
    }
    const st = container._m3LoaderState;
    if (st && typeof st.triggerGearStop === 'function') {
      st.triggerGearStop();
    }
    const slot = container.querySelector('.m3-search-error-slot');
    if (!slot) return;
    const cleanErr = String(errMessage || 'Unknown network or extractor error').trim();
    slot.innerHTML = `
      <div class="m3-search-error-box">
        <div class="m3-search-error-title">Error while fetching tracks. Please report this to GitHub WITH logs / diagnostics.</div>
        <div class="m3-search-error-detail">${escapeHtml(cleanErr)}</div>
        <div style="display:flex;gap:8px;margin-top:4px;">
          <button type="button" class="btn-pill-primary" id="btn-copy-search-err" style="height:34px;padding:0 16px;font-size:12.5px;">Copy error & diagnostics</button>
        </div>
      </div>
    `;
    const copyBtn = slot.querySelector('#btn-copy-search-err');
    if (copyBtn) {
      copyBtn.addEventListener('click', async () => {
        let diag = '';
        try {
          if (window.electronAPI && typeof window.electronAPI.getDiagnostics === 'function') {
            diag = await window.electronAPI.getDiagnostics();
          }
        } catch (_) {}
        const fullReport = `Search Error: ${cleanErr}\nQuery: ${state.searchQuery || ''}\nPlatform: ${state.platform || ''}\n\n${diag}`.trim();
        try {
          await navigator.clipboard.writeText(fullReport);
          showToast('Copied error & diagnostics to clipboard', 'success');
        } catch (_) {}
      });
    }
  }


  const SEARCH_HISTORY_KEY = 'eclipse_search_history_v2';
  const VERIFIED_CHECK_SVG = '<svg class="verified-check" width="14" height="14" viewBox="0 0 24 24" aria-label="Verified artist"><circle cx="12" cy="12" r="11" fill="currentColor"></circle><path d="M7 12.5l3.2 3.2L17 9" fill="none" stroke="var(--md-sys-color-on-primary, #000)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"></path></svg>';

  function stripFeaturing(title) {
    return String(title || '')
      .replace(/\s*[\(\[]\s*(?:feat\.?|ft\.?|featuring)\s[^\)\]]*[\)\]]/gi, '')
      .replace(/\s+(?:feat\.?|ft\.?|featuring)\s+.+$/i, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  function rankSearchTracks(query, tracks) {
    if (!Array.isArray(tracks) || tracks.length < 2) return tracks;
    const q = normalizeMatchText(stripFeaturing(query));
    if (!q) return tracks;
    const exact = [];
    const rest = [];
    tracks.forEach(t => {
      const title = normalizeMatchText(stripFeaturing(t.title));
      const artist = normalizeMatchText(t.artist);
      const hit = title === q || (artist && (q === artist + ' ' + title || q === title + ' ' + artist));
      (hit ? exact : rest).push(t);
    });
    return exact.length ? exact.concat(rest) : tracks;
  }

  function getSearchHistory() {
    const v = safeJson(SEARCH_HISTORY_KEY, []);
    return Array.isArray(v) ? v : [];
  }

  function saveSearchHistory(list) {
    try { localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(list.slice(0, 25))); } catch (_) {}
  }

  function recordSearchHistory(entry) {
    if (!entry || !entry.key) return;
    const list = getSearchHistory().filter(e => e && e.key !== entry.key);
    list.unshift(Object.assign({ ts: Date.now() }, entry));
    saveSearchHistory(list);
  }

  function recordSearchQuery(query, thumb) {
    const q = String(query || '').trim();
    if (!q) return;
    recordSearchHistory({ kind: 'query', key: 'q:' + normalizeMatchText(q), title: q, subtitle: '', query: q, thumb: thumb || '' });
  }

  function recordSearchTrack(track) {
    if (!track || !track.title) return;
    const id = (typeof getTrackCanonicalId === 'function' ? getTrackCanonicalId(track) : '') || track.id;
    if (!id) return;
    let thumb = '';
    try { thumb = (typeof getTrackThumbUrl === 'function' ? getTrackThumbUrl(track) : '') || track.thumbnail || track.cover || ''; } catch (_) {}
    recordSearchHistory({
      kind: 'track',
      key: 't:' + id,
      title: stripFeaturing(track.title),
      subtitle: track.artist || '',
      thumb,
      explicit: typeof isTrackExplicit === 'function' ? !!isTrackExplicit(track) : false,
      track: {
        id: track.id, title: track.title, artist: track.artist, album: track.album,
        duration: track.duration, thumbnail: track.thumbnail || thumb, cover: track.cover,
        url: track.url, platform: track.platform, isExplicit: track.isExplicit,
        searchQuery: track.searchQuery
      }
    });
  }

  function recordSearchArtist(name, thumb, verified) {
    const n = String(name || '').trim();
    if (!n) return;
    recordSearchHistory({ kind: 'artist', key: 'a:' + normalizeMatchText(n), title: n, subtitle: '', thumb: thumb || '', verified: !!verified });
  }

  function setSearchIconCover(thumb) {
    const btn = document.getElementById('search-icon-btn');
    if (!btn) return;
    let img = btn.querySelector('.search-icon-cover');
    if (!thumb) { if (img) img.remove(); const svg = btn.querySelector('.search-icon'); if (svg) svg.classList.remove('hidden'); return; }
    const svg = btn.querySelector('.search-icon');
    if (!img) { img = document.createElement('img'); img.className = 'search-icon-cover'; img.alt = ''; btn.appendChild(img); }
    img.src = thumb;
    if (svg) svg.classList.add('hidden');
  }

  function initSearchHistory() {
    const wrapper = document.querySelector('.search-box-wrapper');
    const input = el.searchInput;
    if (!wrapper || !input || document.getElementById('search-history-panel')) return;

    const panel = document.createElement('div');
    panel.id = 'search-history-panel';
    panel.className = 'search-history-panel hidden';
    wrapper.appendChild(panel);

    const hide = () => panel.classList.add('hidden');

    const openEntry = (entry) => {
      hide();
      if (entry.kind === 'track' && entry.track) {
        playTrack(entry.track, [entry.track], 0, 'search');
        recordSearchTrack(entry.track);
      } else if (entry.kind === 'artist') {
        input.value = '';
        if (el.searchClearBtn) el.searchClearBtn.classList.add('hidden');
        recordSearchArtist(entry.title, entry.thumb, entry.verified);
        openArtistProfile(entry.title);
      } else {
        input.value = entry.query || entry.title || '';
        if (el.searchClearBtn) el.searchClearBtn.classList.remove('hidden');
        performSearch(input.value);
      }
    };

    const render = () => {
      const typed = normalizeMatchText(input.value);
      let list = getSearchHistory();
      if (typed) {
        list = list.filter(e => normalizeMatchText(e.title + ' ' + (e.subtitle || '')).includes(typed));
      }
      if (list.length === 0) {
        hide();
        return;
      }
      panel.innerHTML = '';
      const head = document.createElement('div');
      head.className = 'sh-head';
      const label = document.createElement('span');
      label.textContent = 'Search history';
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'sh-clear';
      clear.textContent = 'Clear';
      clear.addEventListener('mousedown', (ev) => ev.preventDefault());
      clear.addEventListener('click', () => { saveSearchHistory([]); hide(); });
      head.append(label, clear);
      panel.appendChild(head);

      list.slice(0, 12).forEach(entry => {
        const row = document.createElement('div');
        row.className = 'sh-row';
        row.addEventListener('mousedown', (ev) => ev.preventDefault());

        const thumb = document.createElement('div');
        thumb.className = 'sh-thumb' + (entry.kind === 'artist' ? ' round' : '');
        if (entry.kind === 'query') {
          thumb.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.5" y2="16.5"></line></svg>';
        } else if (entry.thumb) {
          const img = document.createElement('img');
          img.alt = '';
          img.addEventListener('error', () => img.remove());
          img.src = entry.thumb;
          thumb.appendChild(img);
        }

        const info = document.createElement('div');
        info.className = 'sh-info';
        const title = document.createElement('div');
        title.className = 'sh-title';
        title.textContent = entry.title;
        if (entry.kind === 'artist' && entry.verified) title.insertAdjacentHTML('beforeend', VERIFIED_CHECK_SVG);
        const sub = document.createElement('div');
        sub.className = 'sh-sub';
        if (entry.kind === 'track' && entry.explicit) {
          const badge = document.createElement('span');
          badge.className = 'explicit-badge';
          badge.textContent = 'E';
          sub.appendChild(badge);
        }
        const kindLabel = entry.kind === 'track' ? 'Track' : entry.kind === 'artist' ? 'Artist' : 'Search';
        sub.appendChild(document.createTextNode(entry.subtitle ? kindLabel + ' • ' + entry.subtitle : kindLabel));
        info.append(title, sub);

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'sh-remove';
        remove.setAttribute('aria-label', 'Remove');
        remove.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
        remove.addEventListener('click', (ev) => {
          ev.stopPropagation();
          saveSearchHistory(getSearchHistory().filter(e => e.key !== entry.key));
          render();
        });

        row.append(thumb, info, remove);
        row.addEventListener('click', () => openEntry(entry));
        panel.appendChild(row);
      });
      panel.classList.remove('hidden');
    };

    input.addEventListener('focus', render);
    input.addEventListener('click', render);
    input.addEventListener('input', render);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'Escape') hide();
    });
    document.addEventListener('pointerdown', (e) => {
      if (!wrapper.contains(e.target)) hide();
    });
  }

  function initQueuePanel() {
    const btn = document.getElementById('btn-toggle-queue-panel');
    if (!btn || document.getElementById('np-queue-panel')) return;

    const panel = document.createElement('aside');
    panel.id = 'np-queue-panel';
    panel.className = 'np-queue-panel';
    panel.innerHTML = `
      <div class="np-queue-head">
        <div class="np-queue-tabs">
          <button type="button" class="np-queue-tab active" data-tab="queue">Queue</button>
          <button type="button" class="np-queue-tab" data-tab="related">Related</button>
          <button type="button" class="np-queue-tab" data-tab="recent">Recently played</button>
        </div>
        <button type="button" class="btn-icon-pill np-queue-close" aria-label="Close">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>
      </div>
      <div class="np-queue-body" id="np-queue-body"></div>`;
    document.body.appendChild(panel);

    const body = panel.querySelector('#np-queue-body');
    let tab = 'queue';
    let signature = '';
    let relatedCacheVid = '';
    let relatedCacheTracks = [];
    let relatedLoadingVid = '';

    const makeRow = (track, onClick, playing) => {
      const row = document.createElement('div');
      row.className = 'np-queue-row' + (playing ? ' playing' : '');
      const thumb = typeof getTrackThumbUrl === 'function' ? getTrackThumbUrl(track) : (track.thumbnail || track.cover || '');
      const art = document.createElement('div');
      art.className = 'np-queue-art';
      if (thumb) {
        const img = document.createElement('img');
        img.alt = '';
        img.loading = 'lazy';
        img.addEventListener('error', () => { img.remove(); });
        img.src = thumb;
        art.appendChild(img);
      }
      const info = document.createElement('div');
      info.className = 'np-queue-info';
      const title = document.createElement('span');
      title.className = 'np-queue-title';
      title.textContent = track.title || 'untitled';
      const artist = document.createElement('span');
      artist.className = 'np-queue-artist';
      artist.textContent = track.artist || '';
      info.append(title, artist);
      row.append(art, info);
      if (onClick) row.addEventListener('click', onClick);
      return row;
    };

    const heading = (text) => {
      const h = document.createElement('div');
      h.className = 'np-queue-heading';
      h.textContent = text;
      return h;
    };

    const render = () => {
      body.innerHTML = '';
      const current = state.currentTrack;
      if (tab === 'related') {
        if (!current) {
          const empty = document.createElement('div');
          empty.className = 'np-queue-empty';
          empty.textContent = 'Play a track to see related songs';
          body.appendChild(empty);
          return;
        }
        const vid = current.videoId || current.id || '';
        if (!vid) {
          const empty = document.createElement('div');
          empty.className = 'np-queue-empty';
          empty.textContent = 'No related tracks available';
          body.appendChild(empty);
          return;
        }
        if (relatedCacheVid === vid) {
          if (!relatedCacheTracks.length) {
            const empty = document.createElement('div');
            empty.className = 'np-queue-empty';
            empty.textContent = 'No related tracks found';
            body.appendChild(empty);
            return;
          }
          body.appendChild(heading('Related tracks'));
          relatedCacheTracks.forEach((t, idx) => {
            body.appendChild(makeRow(t, () => playTrack(t, relatedCacheTracks, idx), false));
          });
          return;
        }
        const loading = document.createElement('div');
        loading.className = 'np-queue-empty';
        loading.textContent = 'Loading related tracks...';
        body.appendChild(loading);
        if (relatedLoadingVid !== vid) {
          relatedLoadingVid = vid;
          fetch(`http://127.0.0.1:${state.serverPort}/api/related?videoId=${encodeURIComponent(vid)}`)
            .then(r => r.ok ? r.json() : [])
            .then(data => {
              const list = Array.isArray(data) ? data : (Array.isArray(data?.tracks) ? data.tracks : []);
              relatedCacheVid = vid;
              relatedCacheTracks = list;
              relatedLoadingVid = '';
              if (tab === 'related') render();
            })
            .catch(() => {
              relatedCacheVid = vid;
              relatedCacheTracks = [];
              relatedLoadingVid = '';
              if (tab === 'related') render();
            });
        }
        return;
      }
      if (tab === 'recent') {
        const recent = (state.history || []).filter(Boolean).slice(0, 40);
        if (!recent.length) {
          const empty = document.createElement('div');
          empty.className = 'np-queue-empty';
          empty.textContent = 'Nothing played yet';
          body.appendChild(empty);
          return;
        }
        recent.forEach(t => body.appendChild(makeRow(t, () => playTrack(t, recent, recent.indexOf(t)), false)));
        return;
      }
      if (!current) {
        const empty = document.createElement('div');
        empty.className = 'np-queue-empty';
        empty.textContent = 'Nothing is playing';
        body.appendChild(empty);
        return;
      }
      body.appendChild(heading('Now playing'));
      body.appendChild(makeRow(current, null, true));
      const start = Math.max(0, state.queueIndex + 1);
      const upcoming = (state.queue || []).slice(start, start + 50);
      if (upcoming.length) {
        body.appendChild(heading('Next up'));
        upcoming.forEach((t, i) => {
          const idx = start + i;
          body.appendChild(makeRow(t, () => playTrack(state.queue[idx], state.queue, idx), false));
        });
      } else {
        const empty = document.createElement('div');
        empty.className = 'np-queue-empty';
        empty.textContent = 'Nothing queued next';
        body.appendChild(empty);
      }
    };

    const currentSignature = () => {
      const cur = state.currentTrack;
      const q = state.queue || [];
      const upcoming = q.slice(state.queueIndex + 1, state.queueIndex + 51)
        .map(track => (typeof getTrackCanonicalId === 'function' ? getTrackCanonicalId(track) : '') || track.id).join(',');
      return [tab, cur ? ((typeof getTrackCanonicalId === 'function' ? getTrackCanonicalId(cur) : '') || cur.id) : '', state.queueIndex, q.length, upcoming, (state.history || []).length].join('|');
    };

    const refresh = () => {
      if (!panel.classList.contains('open')) return;
      const sig = currentSignature();
      if (sig === signature) return;
      signature = sig;
      render();
    };

    const setOpen = (open) => {
      panel.classList.toggle('open', open);
      btn.classList.toggle('active', open);
      localStorage.setItem('eclipse_queue_panel_open', open ? '1' : '0');
      signature = '';
      refresh();
    };

    btn.addEventListener('click', () => setOpen(!panel.classList.contains('open')));
    panel.querySelector('.np-queue-close').addEventListener('click', () => setOpen(false));
    panel.querySelectorAll('.np-queue-tab').forEach(t => {
      t.addEventListener('click', () => {
        tab = t.dataset.tab;
        panel.querySelectorAll('.np-queue-tab').forEach(x => x.classList.toggle('active', x === t));
        signature = '';
        refresh();
      });
    });
    setInterval(refresh, 700);
    if (localStorage.getItem('eclipse_queue_panel_open') === '1') setOpen(true);
  }

  async function performSearch(query) {
    if (!query || !query.trim()) return;

    const searchToken = (state.searchToken || 0) + 1;
    state.searchToken = searchToken;

    state.searchQuery = query;
    state.searchOffset = 0;
    state.searchHasMore = false;
    state.searchLoadingMore = false;
    switchView('discover');

    if (el.discoverEmpty) el.discoverEmpty.classList.add('hidden');
    if (el.searchResultsContainer) {
      el.searchResultsContainer.classList.remove('hidden');
      el.searchResultsContainer.style.display = '';
    }
    if (el.searchResults) {
      el.searchResults.classList.remove('hidden');
      el.searchResults.style.display = '';
    }
    if (typeof syncHomeAmbientVisibility === 'function') syncHomeAmbientVisibility();

    const artistCardContainer = document.getElementById('search-artist-card-container');
    if (artistCardContainer) artistCardContainer.innerHTML = '';

    const albumsContainer = document.getElementById('search-albums-container');
    if (albumsContainer) albumsContainer.innerHTML = '';

    const trimmedQuery = query.trim();
    if (getAdv('albums', true) && trimmedQuery.length >= 3) {
      fetchAlbumsForSearch(trimmedQuery, searchToken);
    }

    if (el.searchTracksList) {
      renderM3SearchLoader(el.searchTracksList);
    }

    try {
      if (!navigator.onLine) {
        if (el.searchTracksList) {
          stopM3SearchLoaderWithError(el.searchTracksList, 'Offline: no internet connection');
        }
        return;
      }
      const searchUrl = `http://127.0.0.1:${state.serverPort}/api/search?q=${encodeURIComponent(query)}&platform=${state.platform}&limit=12&offset=0`;
      const res = await fetch(searchUrl);
      const data = await res.json();
      if (state.searchToken !== searchToken) return;

      if (!data.success || !data.tracks) {
        if (state.platform === 'ytmusic') showToast('YouTube Music is unavailable');
        throw new Error(data.error || 'Failed to load search results');
      }

      data.tracks = rankSearchTracks(query, data.tracks);
      state.searchResults = data.tracks;
      state.searchOffset = data.tracks.length;
      state.searchHasMore = !!data.hasMore;
      const firstThumb = data.tracks.length ? (typeof getTrackThumbUrl === 'function' ? getTrackThumbUrl(data.tracks[0]) : (data.tracks[0].thumbnail || data.tracks[0].cover || '')) : '';
      setSearchIconCover(firstThumb);
      recordSearchQuery(query, firstThumb);

      requestAnimationFrame(() => {
        if (el.searchTracksList) {
          renderTracks(el.searchTracksList, data.tracks, 'search');
          if (typeof applySearchFilter === 'function') applySearchFilter(currentSearchFilter);
        }
      });

      const showArtists = localStorage.getItem('eclipse_search_artists') !== '0';
      if (showArtists && trimmedQuery.length >= 3) {
        fetchArtistCardForSearch(trimmedQuery, searchToken, data.tracks);
      }
    } catch (err) {
      if (state.searchToken !== searchToken) return;
      console.error('Search error:', err);
      const isOff = !navigator.onLine;
      if (el.searchTracksList) {
        stopM3SearchLoaderWithError(el.searchTracksList, isOff ? 'Offline: no internet connection' : (err && err.message ? err.message : String(err)));
      }
    }
  }

  if (el.mainContent) {
    el.mainContent.addEventListener('scroll', async () => {
      const isSearchShowing = (el.searchResults && !el.searchResults.classList.contains('hidden')) || (el.searchResultsContainer && !el.searchResultsContainer.classList.contains('hidden'));
      if (state.currentView === 'discover' && isSearchShowing) {
        if (el.mainContent.scrollTop + el.mainContent.clientHeight >= el.mainContent.scrollHeight - 280) {
          if (state.searchHasMore && !state.searchLoadingMore && state.searchQuery) {
            state.searchLoadingMore = true;
            try {
              const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/search?q=${encodeURIComponent(state.searchQuery)}&platform=${state.platform}&limit=12&offset=${state.searchOffset}`);
              const moreData = await res.json();
              if (moreData && moreData.success && Array.isArray(moreData.tracks) && moreData.tracks.length > 0) {
                const moreTracks = moreData.tracks;
                const currentCanonicalId = state.currentTrack ? getTrackCanonicalId(state.currentTrack) : '';
                const startIdx = (state.searchResults || []).length;
                state.searchResults = (state.searchResults || []).concat(moreTracks);
                if (el.searchTracksList) {
                  const fragment = document.createDocumentFragment();
                  moreTracks.forEach((t, i) => {
                    const row = createTrackRow(t, startIdx + i, currentCanonicalId, 'search', state.searchResults, el.searchTracksList);
                    fragment.appendChild(row);
                  });
                  el.searchTracksList.appendChild(fragment);
                  if (typeof applySearchFilter === 'function') applySearchFilter(currentSearchFilter);
                }
                state.searchOffset += moreTracks.length;
                state.searchHasMore = !!moreData.hasMore;
              } else {
                state.searchHasMore = false;
              }
            } catch (err) {
              console.error('Infinite scroll search error:', err);
            } finally {
              state.searchLoadingMore = false;
            }
          }
        }
      }
    }, { passive: true });
  }


  var explicitTrackCache = window.explicitTrackCache || new Set();
  window.explicitTrackCache = explicitTrackCache;

  function isLyricsExplicit(lyrics) {
    if (!lyrics || typeof lyrics !== 'string') return false;
    return /\b(fuck|fucking|fucked|fucker|fucks|shit|bitch|bitches|bitching|asshole|cunt|nigger|nigga|dick|pussy)\b|ху[йеяёюи]|пизд|залуп|муда[кч]|мудил|г[ао]ндон|дерьм|дроч|(?:^|[^а-яё])(?:бля[а-яё]*|сук[аиуео]|суч[екьяа][а-яё]*)|(?:^|[^а-яё])(?:[её]б[а-яё]+|[её]б\b|(?:вы|за|на|до|по|пере|про|разъ|раз|съ|въ|под|от|у)[её]б[а-яё]*)/i.test(lyrics);
  }
  window.isLyricsExplicit = isLyricsExplicit;

  function isTrackExplicit(track) {
    if (!track) return false;
    const canId = (typeof getTrackCanonicalId === 'function' ? getTrackCanonicalId(track) : '') || track.id;
    if (canId && explicitTrackCache.has(canId)) return true;
    if (track.isExplicit === true || track.explicit === true || track.explicit_lyrics === true || track.explicit_content_lyrics === 1) {
      if (canId) explicitTrackCache.add(canId);
      return true;
    }
    if (Array.isArray(track.badges) && track.badges.some(b => /explicit|18\+/i.test(b?.label || b?.name || b?.iconType || ''))) {
      if (canId) explicitTrackCache.add(canId);
      return true;
    }
    const text = `${track.title || ''} ${track.album || ''} ${track.searchQuery || ''} ${track.subtitle || ''}`;
    if (/\bexplicit\b|\[e\]|\(e\)|\[explicit\]|\(explicit\)|\b18\+\b|\[18\+\]|\(18\+\)|\b\+18\b|\[\+18\]|\(\+18\)|\buncensored\b|\[uncensored\]|\(uncensored\)|\bdirty\b|\[dirty\]|\(dirty\)|без\s+цензуры|нецензурн|\bмат\b|ху[йеяёю]|пизд|еба[тлнщ]|ёб[а-я]|бля[дт]/i.test(text)) {
      if (canId) explicitTrackCache.add(canId);
      return true;
    }
    return false;
  }
  window.isTrackExplicit = isTrackExplicit;

  let isShareInProgress = false;
  function showShareSpinnerToast() {
    document.querySelectorAll('.riff-share-spinner-toast').forEach(t => t.remove());
    const container = document.getElementById('toast-container');
    if (!container) return () => {};
    const toast = document.createElement('div');
    toast.className = 'eclipse-toast info riff-share-spinner-toast';
    toast.innerHTML = '<svg class="g-spinner" style="width:20px;height:20px;" viewBox="0 0 48 48"><circle cx="24" cy="24" r="20"/></svg>';
    container.appendChild(toast);
    return () => {
      toast.classList.add('leaving');
      setTimeout(() => { if (toast.parentNode) toast.remove(); }, 180);
    };
  }
  async function resolveFullTrackStreamForShare(track) {
    if (!track) return '';
    const port = state.serverPort || 38472;
    try {
      const streamInfoUrl = `http://127.0.0.1:${port}/api/stream-info?url=${encodeURIComponent(track.url || '')}&id=${encodeURIComponent(track.id || '')}&platform=${encodeURIComponent(track.platform || state.platform || 'youtube')}&title=${encodeURIComponent(track.title || '')}&artist=${encodeURIComponent(track.artist || '')}&duration=${encodeURIComponent(track.duration || 0)}&forShare=1`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 4500);
      const response = await fetch(streamInfoUrl, { signal: ctrl.signal });
      clearTimeout(timer);
      const data = await response.json();
      if (data && data.success && data.streamUrl && !data.streamUrl.includes('.m3u8')) {
        return data.streamUrl;
      }
    } catch (_) {}
    return '';
  }
  async function executeCopyShareLink(track) {
    if (isShareInProgress) return;
    if (!track) {
      showToast('No track selected', 'error');
      return;
    }
    isShareInProgress = true;
    const hideSpinner = showShareSpinnerToast();
    try {
      let directStream = '';
      if ((track.url || track.id) && track.platform !== 'local') {
        directStream = await resolveFullTrackStreamForShare(track);
      }
      const shareUrl = buildRiffShareUrl(track, directStream, '', 0);
      await navigator.clipboard.writeText(shareUrl);
      showToast('Share link copied to clipboard!', 'success');
    } catch (e) {
      showToast('Failed to copy share link', 'error');
    } finally {
      hideSpinner();
      setTimeout(() => { isShareInProgress = false; }, 400);
    }
  }
  window.executeCopyShareLink = executeCopyShareLink;

  function restoreDiscoverHomeState(forceHome = false) {
    const hasSearchQuery = !forceHome && el.searchInput && el.searchInput.value.trim().length > 0;
    const isSearchActive = hasSearchQuery && el.searchResultsContainer && !el.searchResultsContainer.classList.contains('hidden');

    if (isSearchActive) {
      if (el.discoverEmpty) el.discoverEmpty.classList.add('hidden');
      if (el.searchResultsContainer) {
        el.searchResultsContainer.classList.remove('hidden');
        el.searchResultsContainer.style.display = '';
      }
      if (typeof syncHomeAmbientVisibility === 'function') syncHomeAmbientVisibility();
      return;
    }

    if (forceHome || !hasSearchQuery) {
      if (el.searchInput) el.searchInput.value = '';
      if (el.searchClearBtn) el.searchClearBtn.classList.add('hidden');
      state.searchQuery = '';
      state.searchHasMore = false;
      const artistCardContainer = document.getElementById('search-artist-card-container');
      if (artistCardContainer) artistCardContainer.innerHTML = '';
      const albumsContainer = document.getElementById('search-albums-container');
      if (albumsContainer) albumsContainer.innerHTML = '';
    }

    if (el.searchResultsContainer) {
      el.searchResultsContainer.classList.add('hidden');
      el.searchResultsContainer.style.display = 'none';
    }
    if (el.discoverEmpty) {
      el.discoverEmpty.classList.remove('hidden');
      el.discoverEmpty.style.display = '';
    }
    if (el.discoverHome) {
      el.discoverHome.classList.remove('hidden');
      el.discoverHome.style.display = 'contents';
    }

    const isSpotify = (localStorage.getItem('eclipse_home_layout') || 'spotify') === 'spotify';
    document.body.classList.toggle('home-spotify', isSpotify);
    const spHome = document.getElementById('sp-home');
    const homeHero = document.getElementById('home-hero');

    if (isSpotify) {
      if (homeHero) homeHero.style.display = 'none';
      if (spHome) {
        spHome.classList.remove('hidden');
        spHome.style.display = '';
      }
      if (typeof renderSpotifyHome === 'function') renderSpotifyHome();
    } else {
      if (spHome) spHome.style.display = 'none';
      if (homeHero) {
        homeHero.classList.remove('hidden');
        homeHero.style.display = '';
      }
      if (typeof initHomeHero === 'function') initHomeHero();
    }
    if (typeof syncHomeAmbientVisibility === 'function') syncHomeAmbientVisibility();
  }

  function switchView(viewName) {
    clearTrackSelection();
    if (globalPreloadManager && viewName !== 'discover') {
      globalPreloadManager.clearTrendingQueue();
    }
    if (state.currentView && state.currentView !== viewName) {
      state.previousView = state.currentView;
    }
    state.currentView = viewName;

    requestAnimationFrame(() => {
      document.querySelectorAll('.no-enter-anim').forEach(c => c.classList.remove('no-enter-anim'));
      [el.viewDiscover, el.viewFavorites, el.viewAlbums, el.viewLocal, el.viewHistory, el.viewQueue, el.viewPlaylistDetail, el.viewAlbum, el.viewArtist, el.viewSettings].forEach(v => {
        if (v) v.classList.remove('active');
      });

        const nestedView = viewName === 'playlist-detail' || viewName === 'album' || viewName === 'artist';
        if (!nestedView) {
          [el.navDiscover, el.navFavorites, el.navAlbums, el.navLocal, el.navHistory, el.navQueue, el.navSettings].forEach(n => {
            if (n) n.classList.remove('active');
          });
        }

          if (viewName === 'discover') {
            if (el.viewDiscover) el.viewDiscover.classList.add('active');
            restoreDiscoverHomeState(false);
            if (el.navDiscover) el.navDiscover.classList.add('active');
            const sp = (localStorage.getItem('eclipse_home_layout') || 'spotify') === 'spotify';
            if (sp) renderSpotifyHome();
          } else if (viewName === 'favorites') {
            if (el.viewFavorites) el.viewFavorites.classList.add('active');
            if (el.navFavorites) el.navFavorites.classList.add('active');
            renderFavoritesView();
          } else if (viewName === 'albums') {
            if (el.viewAlbums) el.viewAlbums.classList.add('active');
            if (el.navAlbums) el.navAlbums.classList.add('active');
            renderSavedAlbums();
          } else if (viewName === 'local') {
            if (el.viewLocal) el.viewLocal.classList.add('active');
            if (el.navLocal) el.navLocal.classList.add('active');
            renderLocalView();
          } else if (viewName === 'history') {
            if (el.viewHistory) el.viewHistory.classList.add('active');
            if (el.navHistory) el.navHistory.classList.add('active');
            renderHistoryView();
          } else if (viewName === 'queue') {
            if (el.viewQueue) el.viewQueue.classList.add('active');
            if (el.navQueue) el.navQueue.classList.add('active');
            renderQueueView();
          } else if (viewName === 'playlist-detail') {
            if (el.viewPlaylistDetail) el.viewPlaylistDetail.classList.add('active');
          } else if (viewName === 'album') {
            if (el.viewAlbum) el.viewAlbum.classList.add('active');
          } else if (viewName === 'artist') {
            if (el.viewArtist) el.viewArtist.classList.add('active');
          } else if (viewName === 'settings') {
            if (el.viewSettings) el.viewSettings.classList.add('active');
            if (el.navSettings) el.navSettings.classList.add('active');
            const savedCat = localStorage.getItem('eclipse_settings_cat');
            showSettingsCategory((savedCat === 'overview' || !savedCat) ? 'home' : savedCat);
            updateOfflineStorageUI();
            updateMusicFolderUI();
  updateDownloadFolderUI();
  updateDownloadCaptionPath();
            checkToolsStatus(false);
          }

          updateNavIndicator(true);

          refreshNavBadges();

          highlightPlayingRow();
          if (typeof syncHomeAmbientVisibility === 'function') syncHomeAmbientVisibility();
          updateFxVisibility();
          if (el.mainContent) updateFade(el.mainContent);
    });
    if (el.mainContent) updateFade(el.mainContent);
  }

  function applyStackedRadius(container, itemSelector, horizontal) {
    if (!container) return;
    const raw = Array.isArray(container) ? container : [...container.querySelectorAll(itemSelector)];
    const items = raw.filter((n) => n.getBoundingClientRect().height > 1 && getComputedStyle(n).display !== 'none');
    const stackClasses = ['stack-only', 'stack-first', 'stack-mid', 'stack-last'];
    items.forEach((n, i) => {
      const target = items.length === 1 ? 'stack-only' : i === 0 ? 'stack-first' : i === items.length - 1 ? 'stack-last' : 'stack-mid';
      const needH = !!horizontal;
      if (n.classList.contains('stack-h') !== needH) n.classList.toggle('stack-h', needH);
      stackClasses.forEach((cls) => {
        if (cls === target) {
          if (!n.classList.contains(cls)) n.classList.add(cls);
        } else {
          if (n.classList.contains(cls)) n.classList.remove(cls);
        }
      });
    });
  }
  let stackRetry = false;
  function refreshStacks() {
    const sNav = document.querySelector('.sidebar-nav');
    if (sNav) {
      const all = [...sNav.querySelectorAll('.nav-item')];
      const visible = all.filter((n) => n.getBoundingClientRect().height > 1 && getComputedStyle(n).display !== 'none');
      if (all.length > 0 && visible.length === 0) {
        if (!stackRetry) {
          stackRetry = true;
          requestAnimationFrame(() => { stackRetry = false; refreshStacks(); });
        }
        return;
      }
      sNav.querySelectorAll('.nav-item').forEach((n) => {
        n.classList.remove('stack-only', 'stack-first', 'stack-mid', 'stack-last', 'stack-h');
      });
    }
    applyStackedRadius(document.querySelector('.settings-nav'), '.settings-nav-btn', false);
    applyStackedRadius(document.getElementById('audio-tabs'), '.audio-tab', false);
  }

  let stackRaf = 0;
  const stackObserver = new MutationObserver(() => { if (stackRaf) return; stackRaf = requestAnimationFrame(() => { stackRaf = 0; refreshStacks(); }); });
  ['.sidebar-nav', '.settings-nav', '#audio-tabs'].forEach((s) => { const n = document.querySelector(s); if (n) stackObserver.observe(n, { attributes: true, attributeFilter: ['class', 'style'], childList: true, subtree: true }); });

let navIndicatorAnimId = 0;
let navIndicatorCurTop = null;
let navIndicatorCurBot = null;

function getNavItemOffsetInSidebar(btn, nav) {
  const ind = btn.querySelector('.nav-indicator') || btn;
  let y = 0;
  let cur = ind;
  while (cur && cur !== nav && cur !== document.body) {
    y += cur.offsetTop || 0;
    cur = cur.offsetParent;
  }
  return { top: y, height: ind.offsetHeight || 48 };
}

function moveNavIndicator(targetBtn, animate = true) {
  const indicator = document.getElementById('nav-active-indicator');
  const nav = document.querySelector('.sidebar-nav');
  if (!indicator || !nav) return;

  document.querySelectorAll('.sidebar-nav .nav-item').forEach(b => {
    if (b !== targetBtn) b.classList.remove('indicator-arrived');
  });

  if (navIndicatorAnimId) {
    cancelAnimationFrame(navIndicatorAnimId);
    navIndicatorAnimId = 0;
  }

  const isReduced = !animate || document.body.classList.contains('perf') || document.documentElement.classList.contains('force-reduced-motion');

  if (!targetBtn || targetBtn.id === 'nav-discover' || targetBtn.classList.contains('nav-collapsed')) {
    if (!isReduced && navIndicatorCurTop !== null && !indicator.classList.contains('is-hidden')) {
      const startTop = navIndicatorCurTop;
      const startH = Math.max(48, (navIndicatorCurBot ?? (startTop + 48)) - startTop);
      const shrinkTop = startTop + (startH - 48) * 0.5;
      const t0 = performance.now();
      const dur = 260;
      const fadeStep = (now) => {
        const p = Math.min(1, (now - t0) / dur);
        const e = 1 - Math.pow(1 - p, 3);
        const sc = 1 - 0.55 * e;
        const curY = startTop + (shrinkTop - startTop) * e;
        indicator.style.height = (startH - (startH - 48) * e).toFixed(1) + 'px';
        indicator.style.transform = `translate3d(0, ${curY.toFixed(1)}px, 0) scale(${sc.toFixed(3)})`;
        indicator.style.opacity = String((1 - e).toFixed(3));
        if (p < 1) {
          navIndicatorAnimId = requestAnimationFrame(fadeStep);
        } else {
          navIndicatorAnimId = 0;
          indicator.classList.add('is-hidden');
          indicator.style.opacity = '';
          navIndicatorCurTop = null;
          navIndicatorCurBot = null;
        }
      };
      navIndicatorAnimId = requestAnimationFrame(fadeStep);
    } else {
      indicator.classList.add('is-hidden');
      indicator.style.opacity = '';
      navIndicatorCurTop = null;
      navIndicatorCurBot = null;
    }
    return;
  }

  const box = getNavItemOffsetInSidebar(targetBtn, nav);
  const destTop = box.top;
  const destBot = box.top + box.height;

  const wasHidden = indicator.classList.contains('is-hidden') || navIndicatorCurTop === null;
  indicator.classList.remove('is-hidden');
  indicator.style.opacity = '1';

  if (isReduced) {
    navIndicatorCurTop = destTop;
    navIndicatorCurBot = destBot;
    indicator.style.transform = `translate3d(0, ${destTop.toFixed(1)}px, 0) scale(1)`;
    indicator.style.height = (destBot - destTop).toFixed(1) + 'px';
    targetBtn.classList.add('indicator-arrived');
    return;
  }

  if (wasHidden) {
    navIndicatorCurTop = destTop;
    navIndicatorCurBot = destBot;
    indicator.style.height = (destBot - destTop).toFixed(1) + 'px';
    const t0 = performance.now();
    const dur = 280;
    const popStep = (now) => {
      const p = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - p, 3);
      const sc = 0.45 + 0.55 * e;
      indicator.style.transform = `translate3d(0, ${destTop.toFixed(1)}px, 0) scale(${sc.toFixed(3)})`;
      indicator.style.opacity = String(e.toFixed(3));
      if (p >= 0.65) targetBtn.classList.add('indicator-arrived');
      if (p < 1) {
        navIndicatorAnimId = requestAnimationFrame(popStep);
      } else {
        navIndicatorAnimId = 0;
        indicator.style.transform = `translate3d(0, ${destTop.toFixed(1)}px, 0) scale(1)`;
        indicator.style.opacity = '';
        targetBtn.classList.add('indicator-arrived');
      }
    };
    navIndicatorAnimId = requestAnimationFrame(popStep);
    return;
  }

  const startTop = navIndicatorCurTop;
  const startBot = navIndicatorCurBot;
  const dist = Math.abs(destTop - startTop);
  if (dist < 2) {
    navIndicatorCurTop = destTop;
    navIndicatorCurBot = destBot;
    indicator.style.transform = `translate3d(0, ${destTop.toFixed(1)}px, 0) scale(1)`;
    indicator.style.height = (destBot - destTop).toFixed(1) + 'px';
    targetBtn.classList.add('indicator-arrived');
    return;
  }

  const movingDown = destTop > startTop;
  const totalDur = Math.min(580, Math.max(480, 460 + dist * 0.22));
  const startTime = performance.now();
  let arrivedSet = false;

  const easeLead = (t) => 1 - Math.pow(1 - Math.min(1, t / 0.72), 3.2);
  const easeTrail = (t) => t < 0.34 ? 0 : 1 - Math.pow(1 - (t - 0.34) / 0.66, 2.4);

  const step = (now) => {
    const rawT = Math.min(1, (now - startTime) / totalDur);
    const kLead = easeLead(rawT);
    const kTrail = easeTrail(rawT);
    if (movingDown) {
      navIndicatorCurBot = startBot + (destBot - startBot) * kLead;
      navIndicatorCurTop = startTop + (destTop - startTop) * kTrail;
    } else {
      navIndicatorCurTop = startTop + (destTop - startTop) * kLead;
      navIndicatorCurBot = startBot + (destBot - startBot) * kTrail;
    }
    const h = Math.max(48, navIndicatorCurBot - navIndicatorCurTop);
    const stretchRatio = Math.min(1, (h - 48) / 140);
    const scaleX = 1 - stretchRatio * 0.08;
    indicator.style.transform = `translate3d(0, ${navIndicatorCurTop.toFixed(1)}px, 0) scaleX(${scaleX.toFixed(3)})`;
    indicator.style.height = h.toFixed(1) + 'px';
    if (!arrivedSet && rawT >= 0.62) {
      arrivedSet = true;
      targetBtn.classList.add('indicator-arrived');
    }
    if (rawT < 1) {
      navIndicatorAnimId = requestAnimationFrame(step);
    } else {
      navIndicatorAnimId = 0;
      navIndicatorCurTop = destTop;
      navIndicatorCurBot = destBot;
      indicator.style.transform = `translate3d(0, ${destTop.toFixed(1)}px, 0) scale(1)`;
      indicator.style.height = (destBot - destTop).toFixed(1) + 'px';
      targetBtn.classList.add('indicator-arrived');
    }
  };
  navIndicatorAnimId = requestAnimationFrame(step);
}

function updateNavIndicator(animate) {
  refreshStacks();
  const active = document.querySelector('.sidebar-nav .nav-item.active');
  moveNavIndicator(active, animate);
}

  window.addEventListener('resize', () => updateNavIndicator(false));
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => updateNavIndicator(false));
  const sidebarNavElem = document.querySelector('.sidebar-nav');
  if (sidebarNavElem) {
    refreshStacks();
    new ResizeObserver(() => updateNavIndicator(false)).observe(sidebarNavElem);
  }

  function setPlayPauseState(playing, animate = true) {
    if (typeof setCoverRotationRate === 'function') setCoverRotationRate(playing);
    const btn = el.btnPlayPause;
    const tvkBtn = document.getElementById('btn-tvk-play');

    const tvkPlay = document.getElementById('tvk-play-icon');
    const tvkPause = document.getElementById('tvk-pause-icon');
    if (tvkPlay && tvkPlay.getAnimations) {
      try { tvkPlay.getAnimations().forEach(a => a.cancel()); } catch (e) {}
    }
    if (tvkPause && tvkPause.getAnimations) {
      try { tvkPause.getAnimations().forEach(a => a.cancel()); } catch (e) {}
    }
    if (el.playIcon && el.playIcon.getAnimations) {
      try { el.playIcon.getAnimations().forEach(a => a.cancel()); } catch (e) {}
    }
    if (el.pauseIcon && el.pauseIcon.getAnimations) {
      try { el.pauseIcon.getAnimations().forEach(a => a.cancel()); } catch (e) {}
    }

    if (tvkBtn) {
      if (tvkBtn._morphAnim) {
        try { tvkBtn._morphAnim.cancel(); } catch (e) {}
        tvkBtn._morphAnim = null;
      }
      tvkBtn.classList.toggle('playing', !!playing);
    }

    if (!btn) return;
    if (btn._morphAnim) {
      try { btn._morphAnim.cancel(); } catch (e) {}
      btn._morphAnim = null;
    }
    btn.classList.toggle('playing', !!playing);
  }

  function updatePlayPauseButton(isPlaying, isBuffering = false) {
    const actuallyPlaying = isPauseFading ? false : !!(isPlaying !== undefined ? isPlaying : (state.isPlaying || (el.nativeAudio && !el.nativeAudio.paused && !el.nativeAudio.ended)));
    const tvkBtn = document.getElementById('btn-tvk-play');
    const tvkPlayIcon = document.getElementById('tvk-play-icon');
    const tvkPauseIcon = document.getElementById('tvk-pause-icon');
    const tvkPlaySpinner = document.getElementById('tvk-play-spinner');
    if (tvkBtn) {
      if (isBuffering) {
        tvkBtn.classList.add('buffering');
        if (tvkPlaySpinner) tvkPlaySpinner.classList.remove('hidden');
        if (tvkPlayIcon) tvkPlayIcon.classList.add('hidden');
        if (tvkPauseIcon) tvkPauseIcon.classList.add('hidden');
      } else {
        tvkBtn.classList.remove('buffering');
        if (tvkPlaySpinner) tvkPlaySpinner.classList.add('hidden');
        if (tvkPlayIcon) tvkPlayIcon.classList.remove('hidden');
        if (tvkPauseIcon) tvkPauseIcon.classList.remove('hidden');
      }
    }
    if (isBuffering) {
      if (el.btnPlayPause) el.btnPlayPause.classList.add('buffering');
      if (el.playbarSpinner) el.playbarSpinner.classList.remove('hidden');
      if (el.playIcon) el.playIcon.classList.add('hidden');
      if (el.pauseIcon) el.pauseIcon.classList.add('hidden');
      setPlayPauseState(true, true);
    } else {
      if (el.btnPlayPause) el.btnPlayPause.classList.remove('buffering');
      if (el.playbarSpinner) el.playbarSpinner.classList.add('hidden');
      if (el.playIcon) el.playIcon.classList.remove('hidden');
      if (el.pauseIcon) el.pauseIcon.classList.remove('hidden');
      setPlayPauseState(actuallyPlaying, true);
    }
  }

  setPlayPauseState(false, false);

  function formatDuration(sec) {
    if (!sec || isNaN(sec)) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  }

  if (el.btnResetVfx) {
    el.btnResetVfx.addEventListener('click', () => {
      state.vfx = { ...defaultVfx };
      localStorage.setItem('devsize_vfx', JSON.stringify(state.vfx));
      applyVisualEffects();
    });
  }

  if (window.electronAPI) {
    if (el.btnMinimize) el.btnMinimize.addEventListener('click', () => window.electronAPI.minimizeWindow());
    if (el.btnMaximize) el.btnMaximize.addEventListener('click', () => window.electronAPI.maximizeWindow());
    if (el.btnClose) el.btnClose.addEventListener('click', () => window.electronAPI.closeWindow());
  }

  function goHome() {
    restoreDiscoverHomeState(true);
    switchView('discover');
  }

  document.querySelectorAll('.app-logo').forEach(logo => {
    logo.style.cursor = 'pointer';
    logo.style.pointerEvents = 'auto';
    logo.addEventListener('click', () => {
      goHome();
    });
  });

  const handleNavDiscoverClick = () => {
    goHome();
  };

  if (el.navDiscover) {
    el.navDiscover.addEventListener('click', () => {
      goHome();
    });
  }
  document.querySelectorAll('.sidebar-nav .nav-item[data-view="discover"]').forEach(btn => {
    if (btn !== el.navDiscover) {
      btn.addEventListener('click', () => {
        goHome();
      });
    }
  });

  if (el.navFavorites) el.navFavorites.addEventListener('click', () => switchView('favorites'));
  if (el.navAlbums) el.navAlbums.addEventListener('click', () => switchView('albums'));
  if (el.navLocal) el.navLocal.addEventListener('click', () => switchView('local'));
  if (el.navHistory) el.navHistory.addEventListener('click', () => switchView('history'));
  if (el.navQueue) el.navQueue.addEventListener('click', () => switchView('queue'));
  if (el.navSettings) el.navSettings.addEventListener('click', () => switchView('settings'));
  updateAlbumsCount();

  const addLocalBtn = el.btnAddLocal || el.btnAddLocalFiles || document.getElementById('btn-add-local') || document.getElementById('btn-add-local-files');
  if (addLocalBtn) addLocalBtn.addEventListener('click', () => addLocalFiles());
  const addLocalFolderBtn = el.btnAddLocalFolder || document.getElementById('btn-add-local-folder');
  if (addLocalFolderBtn) addLocalFolderBtn.addEventListener('click', () => addLocalFolder());
  const addLocalFilesEmptyBtn = el.btnAddLocalFilesEmpty || document.getElementById('btn-add-local-files-empty');
  if (addLocalFilesEmptyBtn) addLocalFilesEmptyBtn.addEventListener('click', () => addLocalFiles());

  async function startRadioForTrack(track) {
    if (!track) return;
    const vid = track.videoId || track.id || '';
    if (!vid) {
      playTrack(track, [track], 0);
      return;
    }
    try {
      const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/radio?videoId=${encodeURIComponent(vid)}`);
      const data = res.ok ? await res.json() : [];
      const rawList = Array.isArray(data) ? data : (Array.isArray(data?.tracks) ? data.tracks : []);
      const seen = new Set([vid]);
      const radioQueue = [track];
      for (const item of rawList) {
        const itemId = item && (item.videoId || item.id);
        if (!item || (itemId && seen.has(itemId))) continue;
        if (itemId) seen.add(itemId);
        radioQueue.push(item);
      }
      state.isRadioQueue = true;
      playTrack(radioQueue[0], radioQueue, 0);
      if (typeof showToast === 'function') {
        showToast(`Radio started (${radioQueue.length} tracks)`, 'success');
      }
    } catch (_) {
      state.isRadioQueue = false;
      playTrack(track, [track], 0);
    }
  }
  window.startRadioForTrack = startRadioForTrack;

  const syncAutoMixUiAndEngine = (enabled, mode) => {
    const resolvedEnabled = typeof enabled === 'boolean' ? enabled : !!state.isAutoRemix;
    const resolveMode = (window.AutoMixSettingsController && typeof window.AutoMixSettingsController.resolveInitialAutoMixMode === 'function')
      ? window.AutoMixSettingsController.resolveInitialAutoMixMode
      : (m) => m || 'equal_power';
    const resolvedMode = mode || resolveMode(localStorage.getItem('eclipse_automix_mode'));
    state.isAutoRemix = resolvedEnabled;
    localStorage.setItem('eclipse_automix', resolvedEnabled ? '1' : '0');
    localStorage.setItem('eclipse_automix_mode', resolvedMode);
    if (el.btnAutoRemix) el.btnAutoRemix.classList.toggle('active', resolvedEnabled);
    const settingsToggle = document.getElementById('toggle-automix-dj');
    if (settingsToggle) settingsToggle.classList.toggle('active', resolvedEnabled);
    document.querySelectorAll('#automix-mode-group [data-automix-mode]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.automixMode === resolvedMode);
    });
    if (typeof window.syncAutoMixSettings === 'function') {
      window.syncAutoMixSettings({ enabled: resolvedEnabled, mode: resolvedMode });
    }
    if (window.autoMixDjInstance) {
      window.autoMixDjInstance.enabled = resolvedEnabled;
      if (typeof window.autoMixDjInstance.configure === 'function') {
        window.autoMixDjInstance.configure({ enabled: resolvedEnabled, mode: resolvedMode });
      }
    }
    if (nextTrackCoordinator) nextTrackCoordinator.cancel('automix_mode_changed');
    if (resolvedEnabled && el.nativeAudio && el.nativeAudio.playbackRate !== 1.0) {
      el.nativeAudio.playbackRate = 1.0;
    }
    const speedSliderEl = document.getElementById('slider-playback-speed') || document.getElementById('playback-speed-slider');
    if (speedSliderEl) {
      speedSliderEl.disabled = resolvedEnabled;
      if (resolvedEnabled) speedSliderEl.value = '1';
    }
  };

  const toggleAutoMixState = () => {
    const next = !state.isAutoRemix;
    if (next) {
      state.isShuffle = false;
      localStorage.setItem('eclipse_shuffle', '0');
      if (el.btnShuffle) el.btnShuffle.classList.remove('active');
      if (state.autoMixPlayedIds) state.autoMixPlayedIds.clear();
      if (state.currentTrack) {
        const tid = state.currentTrack.id || state.currentTrack.videoId;
        if (tid) state.autoMixPlayedIds.add(tid);
      }
      if (typeof showToast === 'function') showToast('AutoMix DJ enabled — Shuffle disabled', 'success');
    } else if (typeof showToast === 'function') {
      showToast('AutoMix DJ disabled', 'info');
    }
    syncAutoMixUiAndEngine(next);
  };

  if (el.btnAutoRemix) {
    el.btnAutoRemix.addEventListener('click', toggleAutoMixState);
  }
  const toggleAutoMixDjBtn = document.getElementById('toggle-automix-dj');
  if (toggleAutoMixDjBtn) {
    toggleAutoMixDjBtn.addEventListener('click', toggleAutoMixState);
  }
  document.querySelectorAll('#automix-mode-group [data-automix-mode]').forEach(btn => {
    btn.addEventListener('click', () => {
      syncAutoMixUiAndEngine(state.isAutoRemix, btn.dataset.automixMode);
    });
  });

  const toggleAutoMixSkipAlbum = document.getElementById('toggle-automix-skip-album');
  if (toggleAutoMixSkipAlbum) {
    const syncSkipAlbum = (val) => {
      localStorage.setItem('eclipse_automix_skip_album', val ? '1' : '0');
      toggleAutoMixSkipAlbum.classList.toggle('active', !!val);
      if (typeof window.syncAutoMixSettings === 'function') {
        window.syncAutoMixSettings({ keepAlbumContinuous: !!val });
      }
    };
    syncSkipAlbum(localStorage.getItem('eclipse_automix_skip_album') !== '0');
    toggleAutoMixSkipAlbum.addEventListener('click', () => {
      syncSkipAlbum(localStorage.getItem('eclipse_automix_skip_album') === '0');
    });
  }

  const toggleAutoMixDjFilter = document.getElementById('toggle-automix-dj-filter');
  if (toggleAutoMixDjFilter) {
    const syncDjFilter = (val) => {
      toggleAutoMixDjFilter.classList.toggle('active', !!val);
      if (typeof window.syncAutoMixSettings === 'function') window.syncAutoMixSettings({ djFilter: !!val });
    };
    syncDjFilter(localStorage.getItem('eclipse_automix_dj_filter') !== '0');
    toggleAutoMixDjFilter.addEventListener('click', () => {
      syncDjFilter(localStorage.getItem('eclipse_automix_dj_filter') === '0');
    });
  }

  const toggleAutoMixAuto = document.getElementById('toggle-automix-auto');
  if (toggleAutoMixAuto) {
    const syncAutoDur = (val) => {
      toggleAutoMixAuto.classList.toggle('active', !!val);
      if (typeof window.syncAutoMixSettings === 'function') window.syncAutoMixSettings({ autoDuration: !!val });
    };
    syncAutoDur(localStorage.getItem('eclipse_automix_auto') === '1');
    toggleAutoMixAuto.addEventListener('click', () => {
      syncAutoDur(localStorage.getItem('eclipse_automix_auto') !== '1');
    });
  }

  // Fullscreen Karaoke, Mini Player & Player Bar AutoMix motion indicator
  let autoMixBadgeEl = document.getElementById('automix-mixing-badge');
  if (!autoMixBadgeEl) {
    autoMixBadgeEl = document.createElement('div');
    autoMixBadgeEl.id = 'automix-mixing-badge';
    autoMixBadgeEl.className = 'automix-mixing-badge';
    autoMixBadgeEl.innerHTML = '<span class="automix-mixing-dot"></span><span class="automix-mixing-text">Mixing...</span>';
    document.body.appendChild(autoMixBadgeEl);
  }
  let miniAutoMixStatusEl = document.getElementById('mini-automix-status');
  if (!miniAutoMixStatusEl) {
    const trackMetaEl = document.querySelector('.playbar-left .track-meta');
    if (trackMetaEl) {
      miniAutoMixStatusEl = document.createElement('div');
      miniAutoMixStatusEl.id = 'mini-automix-status';
      miniAutoMixStatusEl.className = 'mini-automix-status hidden';
      trackMetaEl.appendChild(miniAutoMixStatusEl);
    }
  }
  let activeUiTxId = null;
  let activeUiPhase = 'idle';
  window.addEventListener('eclipse:automix-state', (ev) => {
    const detail = ev && ev.detail;
    if (!detail) return;
    const phase = detail.phase || (detail.active ? 'mixing' : (detail.failed ? 'failed' : (detail.aborted ? 'cancelled' : 'settled')));
    const active = typeof detail.active === 'boolean'
      ? detail.active
      : (phase === 'preparing' || phase === 'ready' || phase === 'mixing' || phase === 'dominance');
    const incomingTxId = (detail.transitionId && String(detail.transitionId).trim()) || null;

    if (!active) {
      if (!activeUiTxId || !incomingTxId || incomingTxId !== activeUiTxId) return;
      activeUiTxId = null;
      activeUiPhase = 'idle';
      document.body.classList.remove('is-automixing');
      window._automixRainbowBlend = 0;
      window._automixRainbowLastMs = 0;
      if (autoMixBadgeEl) autoMixBadgeEl.classList.remove('visible');
      const pbCrossfadeLbl = document.getElementById('playbar-crossfading-label');
      if (pbCrossfadeLbl) pbCrossfadeLbl.classList.remove('visible');
      const miniCrossfadeLbl = document.getElementById('mini-crossfading-label');
      if (miniCrossfadeLbl) miniCrossfadeLbl.classList.remove('visible');
      if (miniAutoMixStatusEl) {
        miniAutoMixStatusEl.classList.add('hidden');
        miniAutoMixStatusEl.classList.remove('is-preparing', 'is-ready', 'is-mixing', 'is-dominance');
        miniAutoMixStatusEl.textContent = '';
      }
      return;
    }

    if (incomingTxId && activeUiTxId === incomingTxId && (activeUiPhase === 'mixing' || activeUiPhase === 'dominance') && (phase === 'preparing' || phase === 'ready')) {
      return;
    }
    activeUiTxId = incomingTxId || activeUiTxId || ('tx-' + Date.now());
    activeUiPhase = phase;

    const nextTrack = detail.nextTrack && detail.nextTrack.title ? detail.nextTrack : null;
    const nextTitle = nextTrack ? nextTrack.title : '';
    const modeLabel = detail.mode === 'tempo_synced' ? 'BEAT MIX' : 'AUTOMIX';
    const isMixingPhase = phase === 'mixing' || phase === 'dominance';

    document.body.classList.toggle('is-automixing', isMixingPhase);
    if (autoMixBadgeEl) autoMixBadgeEl.classList.remove('visible');
    const pbCrossfadeLbl = document.getElementById('playbar-crossfading-label');
    if (pbCrossfadeLbl) pbCrossfadeLbl.classList.toggle('visible', isMixingPhase);
    const miniCrossfadeLbl = document.getElementById('mini-crossfading-label');
    if (miniCrossfadeLbl) miniCrossfadeLbl.classList.toggle('visible', isMixingPhase);
    if (miniAutoMixStatusEl) {
      miniAutoMixStatusEl.classList.remove('is-preparing', 'is-ready', 'is-mixing', 'is-dominance');
      if (!nextTitle && (phase === 'preparing' || phase === 'ready')) {
        miniAutoMixStatusEl.classList.add('hidden');
      } else {
        miniAutoMixStatusEl.classList.remove('hidden');
        miniAutoMixStatusEl.classList.add(`is-${phase}`);
        if (phase === 'preparing') miniAutoMixStatusEl.textContent = `UP NEXT · ${nextTitle}`;
        else if (phase === 'ready') miniAutoMixStatusEl.textContent = `UP NEXT · READY · ${nextTitle}`;
        else if (phase === 'mixing') miniAutoMixStatusEl.textContent = nextTitle ? `CROSSFADING → ${nextTitle}` : modeLabel;
        else if (phase === 'dominance') miniAutoMixStatusEl.textContent = nextTitle ? `NOW → ${nextTitle}` : modeLabel;
      }
    }
  });

  const resolveInitMode = (window.AutoMixSettingsController && typeof window.AutoMixSettingsController.resolveInitialAutoMixMode === 'function')
    ? window.AutoMixSettingsController.resolveInitialAutoMixMode
    : (m) => m || 'equal_power';
  syncAutoMixUiAndEngine(state.isAutoRemix, resolveInitMode(localStorage.getItem('eclipse_automix_mode')));

  if (el.btnSavePresetDialog) {
    el.btnSavePresetDialog.addEventListener('click', () => {
      if (el.newPresetName) el.newPresetName.value = '';
      if (el.savePresetModal) openModal(el.savePresetModal);
      if (el.newPresetName) el.newPresetName.focus();
    });
  }

  if (el.btnCancelPreset) {
    el.btnCancelPreset.addEventListener('click', () => {
      if (el.savePresetModal) closeModal(el.savePresetModal);
    });
  }

  if (el.btnConfirmSavePreset) {
    el.btnConfirmSavePreset.addEventListener('click', () => {
      const name = el.newPresetName ? el.newPresetName.value : '';
      if (name.trim()) {
        saveCustomPreset(name);
        if (el.savePresetModal) closeModal(el.savePresetModal);
      }
    });
  }

  if (el.newPresetName) {
    el.newPresetName.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && el.btnConfirmSavePreset) el.btnConfirmSavePreset.click();
      if (e.key === 'Escape' && el.btnCancelPreset) el.btnCancelPreset.click();
    });
  }

  if (el.btnCancelRenamePreset) {
    el.btnCancelRenamePreset.addEventListener('click', () => {
      if (el.renamePresetModal) closeModal(el.renamePresetModal);
    });
  }

  if (el.btnConfirmRenamePreset) {
    el.btnConfirmRenamePreset.addEventListener('click', () => {
      const name = el.renamePresetName ? el.renamePresetName.value : '';
      if (name.trim() && state.presetToRenameId) {
        renameCustomPreset(state.presetToRenameId, name);
        if (el.renamePresetModal) closeModal(el.renamePresetModal);
      }
    });
  }

  if (el.renamePresetName) {
    el.renamePresetName.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && el.btnConfirmRenamePreset) el.btnConfirmRenamePreset.click();
      if (e.key === 'Escape' && el.btnCancelRenamePreset) el.btnCancelRenamePreset.click();
    });
  }

  const deletePresetModal = document.getElementById('delete-preset-modal');
  const btnCancelDeletePreset = document.getElementById('btn-cancel-delete-preset');
  const btnConfirmDeletePreset = document.getElementById('btn-confirm-delete-preset');

  if (btnCancelDeletePreset) {
    btnCancelDeletePreset.addEventListener('click', () => {
      if (deletePresetModal) closeModal(deletePresetModal);
    });
  }

  if (btnConfirmDeletePreset) {
    btnConfirmDeletePreset.addEventListener('click', () => {
      if (state.presetToDeleteId) {
        deleteCustomPreset(state.presetToDeleteId);
        state.presetToDeleteId = null;
      }
      if (deletePresetModal) closeModal(deletePresetModal);
    });
  }

  if (el.btnToggleLyricsPanel) {
    el.btnToggleLyricsPanel.addEventListener('click', () => {
      state.isRightPanelOpen = !state.isRightPanelOpen;
      if (el.rightPanel) el.rightPanel.classList.toggle('hidden', !state.isRightPanelOpen);
      el.btnToggleLyricsPanel.classList.toggle('active', state.isRightPanelOpen);
      if (state.isRightPanelOpen) {
        updateLyricsPadding();
        state.forceSnapLyrics = true;
        state.forceLyricsScroll = true;
        state.lastActiveLyricIdx = -1;
        if (el.nativeAudio) updateSyncedLyricsHighlight(el.nativeAudio.currentTime || 0);
        requestAnimationFrame(() => {
          updateLyricsPadding();
          state.forceSnapLyrics = true;
          state.forceLyricsScroll = true;
          state.lastActiveLyricIdx = -1;
          if (el.nativeAudio) updateSyncedLyricsHighlight(el.nativeAudio.currentTime || 0);
        });
      }
      setTimeout(resizeCanvases, 150);
    });
  }

  
  if (el.btnAvSong) el.btnAvSong.addEventListener('click', () => mvController.hideMv());
  if (el.btnAvVideo) el.btnAvVideo.addEventListener('click', () => mvController.showMv());
  if (el.btnToggleMv) el.btnToggleMv.addEventListener('click', () => mvController.toggle());
  if (el.btnMvPopout) {
    el.btnMvPopout.addEventListener('click', () => {
      if (el.mvPlayerWrapper) el.mvPlayerWrapper.classList.toggle('expanded');
    });
  }
  window.addEventListener('message', (event) => {
    if (!mvController.active || !event.data || typeof event.data !== 'string') return;
    try {
      const data = JSON.parse(event.data);
      if (data.event === 'onStateChange' && data.info === 0) {
        playNext();
      }
    } catch (_) {}
  });

  if (el.btnCloseRightPanel) {
    el.btnCloseRightPanel.addEventListener('click', () => {
      state.isRightPanelOpen = false;
      if (el.rightPanel) el.rightPanel.classList.add('hidden');
      if (el.btnToggleLyricsPanel) el.btnToggleLyricsPanel.classList.remove('active');
      setTimeout(resizeCanvases, 150);
    });
  }

  if (el.rightPanelFallback) {
    el.rightPanelFallback.style.cursor = 'pointer';
    el.rightPanelFallback.addEventListener('click', () => {
      if (!state.currentTrack) {
        startWaveIfIdle();
      }
    });
  }

function bindCoverHoldZoom(wrapEl) {
  if (!wrapEl || wrapEl._holdZoomBound) return;
  wrapEl._holdZoomBound = true;
  let holdTimer = null, isZooming = false;
  const getImg = () => wrapEl.tagName === 'IMG' ? wrapEl : wrapEl.querySelector('img');
  const updateOrigin = (e) => {
    const img = getImg();
    if (!img) return;
    const r = wrapEl.getBoundingClientRect();
    const x = Math.max(0, Math.min(100, ((e.clientX - r.left) / (r.width || 1)) * 100));
    const y = Math.max(0, Math.min(100, ((e.clientY - r.top) / (r.height || 1)) * 100));
    img.style.transformOrigin = x + '% ' + y + '%';
    img.style.transform = 'scale(2.35)';
  };
  wrapEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    wrapEl._zoomedFlag = false;
    holdTimer = setTimeout(() => {
      const img = getImg();
      if (!img) return;
      isZooming = true;
      wrapEl._zoomedFlag = true;
      try { wrapEl.setPointerCapture(e.pointerId); } catch (_) {}
      img.style.transition = document.body.classList.contains('perf') ? 'none' : 'transform 180ms cubic-bezier(0.2, 0, 0, 1)';
      updateOrigin(e);
    }, 320);
  });
  wrapEl.addEventListener('pointermove', (e) => { if (isZooming) updateOrigin(e); });
  const endZoom = (e) => {
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
    if (isZooming) {
      isZooming = false;
      try { wrapEl.releasePointerCapture(e.pointerId); } catch (_) {}
      const img = getImg();
      if (img) {
        img.style.transition = document.body.classList.contains('perf') ? 'none' : 'transform 220ms cubic-bezier(0.2, 0, 0, 1)';
        img.style.transform = '';
      }
      setTimeout(() => { wrapEl._zoomedFlag = false; }, 80);
    }
  };
  wrapEl.addEventListener('pointerup', endZoom);
  wrapEl.addEventListener('pointercancel', endZoom);
  wrapEl.addEventListener('click', (e) => {
    if (wrapEl._zoomedFlag) { e.preventDefault(); e.stopImmediatePropagation(); wrapEl._zoomedFlag = false; }
  }, true);
}

  if (el.coverContainer) {
    el.coverContainer.style.cursor = 'pointer';
    bindCoverHoldZoom(el.coverContainer);
    el.coverContainer.addEventListener('click', (e) => {
      if (state.currentTrack && !el.coverContainer._zoomedFlag) {
        openTrackArtModal(state.currentTrack);
      } else if (!state.currentTrack) {
        if (e.target.closest('#btn-right-panel-art')) return;
        startWaveIfIdle();
      }
    });
  }

  const tvCoverEl = el.tvCover || document.getElementById('tv-cover');
  if (tvCoverEl) bindCoverHoldZoom(tvCoverEl);
  const plDetailCoverEl = document.getElementById('playlist-detail-cover');
  if (plDetailCoverEl) bindCoverHoldZoom(plDetailCoverEl);
  const albDetailCoverEl = document.getElementById('album-detail-cover');
  if (albDetailCoverEl) bindCoverHoldZoom(albDetailCoverEl);

  (function initPanelResize() {
    const edge = document.getElementById('panel-resize-edge');
    const panel = el.rightPanel || document.getElementById('right-panel');
    if (!edge || !panel) return;

    const savedWidth = localStorage.getItem('eclipse_right_panel_width');
    if (savedWidth) {
      const w = parseInt(savedWidth, 10);
      if (w >= 260 && w <= 720) {
        panel.style.width = `${w}px`;
        panel.style.setProperty('--right-panel-width', `${w}px`);
      }
    }

    let startX = 0;
    let startW = 0;
    let pendingW = 0;
    let raf = 0;

    const limits = () => ({ min: 260, max: Math.min(720, window.innerWidth - 300) });

    edge.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      edge.setPointerCapture(e.pointerId);
      startX = e.clientX;
      startW = panel.getBoundingClientRect().width;
      pendingW = Math.round(startW);
      edge.classList.add('dragging');
      document.body.classList.add('is-resizing-panel');
      e.preventDefault();
    });

    edge.addEventListener('pointermove', (e) => {
      if (!edge.hasPointerCapture(e.pointerId)) return;
      const { min, max } = limits();
      pendingW = Math.max(min, Math.min(max, Math.round(startW + (startX - e.clientX))));
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          panel.style.width = `${pendingW}px`;
          panel.style.setProperty('--right-panel-width', `${pendingW}px`);
        });
      }
    });

    const stopDrag = (e) => {
      if (!edge.hasPointerCapture(e.pointerId)) return;
      try { edge.releasePointerCapture(e.pointerId); } catch (_) {}
      edge.classList.remove('dragging');
      document.body.classList.remove('is-resizing-panel');
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      if (pendingW >= 260 && pendingW <= 720) {
        localStorage.setItem('eclipse_right_panel_width', pendingW.toString());
      }
      if (typeof resizeCanvases === 'function') resizeCanvases();
    };

    edge.addEventListener('pointerup', stopDrag);
    edge.addEventListener('pointercancel', stopDrag);

    edge.addEventListener('dblclick', () => {
      panel.style.width = '340px';
      panel.style.setProperty('--right-panel-width', '340px');
      localStorage.setItem('eclipse_right_panel_width', '340px');
      if (typeof resizeCanvases === 'function') resizeCanvases();
    });
  })();

  if (el.searchInput) {
    el.searchInput.addEventListener('input', (e) => {
      const val = e.target.value;
      if (val && el.searchClearBtn) {
        el.searchClearBtn.classList.remove('hidden');
      } else if (el.searchClearBtn) {
        el.searchClearBtn.classList.add('hidden');
      }
      if (!val.trim()) {
        restoreDiscoverHomeState(true);
      }
    });

    el.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const val = el.searchInput.value.trim();
        if (val) performSearch(val);
      } else if (e.key === 'Escape') {
        restoreDiscoverHomeState(true);
      }
    });
  }

  if (el.searchIconBtn) {
    el.searchIconBtn.addEventListener('click', () => {
      const val = el.searchInput ? el.searchInput.value.trim() : '';
      if (val) performSearch(val);
    });
  }

  if (el.searchClearBtn) {
    el.searchClearBtn.addEventListener('click', () => {
      restoreDiscoverHomeState(true);
    });
  }


  function setPlatform(platform, triggerSearch = true) {
    if (!['youtube', 'ytmusic', 'soundcloud'].includes(platform)) platform = 'ytmusic';
    state.platform = platform;
    localStorage.setItem('eclipse_platform', platform);

    if (el.platformYt) el.platformYt.classList.toggle('active', platform === 'youtube');
    if (el.platformYtm) el.platformYtm.classList.toggle('active', platform === 'ytmusic');
    if (el.platformSc) el.platformSc.classList.toggle('active', platform === 'soundcloud');

    const select = document.getElementById('select-engine-api');
    if (select) select.value = platform;
    const label = document.getElementById('engine-api-label');
    const nameMap = { youtube: 'YouTube', ytmusic: 'YouTube Music', soundcloud: 'SoundCloud' };
    if (label) label.textContent = nameMap[platform] || 'YouTube';
    const menu = document.getElementById('engine-api-menu');
    if (menu) {
      menu.querySelectorAll('.m3-dropdown-option').forEach(opt => {
        opt.classList.toggle('selected', opt.dataset.value === platform);
      });
    }

    if (triggerSearch && el.searchInput && el.searchInput.value.trim()) {
      performSearch(el.searchInput.value);
    }
  }

  const savedPlatform = localStorage.getItem('eclipse_platform') || 'ytmusic';
  setPlatform(savedPlatform, false);

  if (el.platformYt) el.platformYt.addEventListener('click', () => setPlatform('youtube'));
  if (el.platformYtm) el.platformYtm.addEventListener('click', () => setPlatform('ytmusic'));
  if (el.platformSc) el.platformSc.addEventListener('click', () => setPlatform('soundcloud'));

  const engineApiDropdown = document.getElementById('engine-api-dropdown');
  const engineApiTrigger = document.getElementById('engine-api-trigger');
  const engineApiMenu = document.getElementById('engine-api-menu');
  if (engineApiDropdown && engineApiTrigger && engineApiMenu) {
    engineApiTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      engineApiDropdown.classList.toggle('open');
    });

    engineApiMenu.querySelectorAll('.m3-dropdown-option').forEach(opt => {
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        const val = opt.dataset.value;
        setPlatform(val);
        engineApiDropdown.classList.remove('open');
      });
    });

    document.addEventListener('click', () => {
      engineApiDropdown.classList.remove('open');
    });
  }

  function updateEngineWidthVar() {
    const container = document.querySelector('.platform-switch-container');
    if (!container) return;
    const isHidden = document.body.classList.contains('hide-engine-btns');
    if (isHidden) {
      document.documentElement.style.setProperty('--engine-w', '0px');
      document.documentElement.style.setProperty('--engine-gap', '0px');
    } else {
      const isCompact = document.body.classList.contains('compact-engine-btns');
      const w = isCompact ? 124 : (container.offsetWidth || 435);
      if (w > 0) {
        document.documentElement.style.setProperty('--engine-w', `${w}px`);
        document.documentElement.style.setProperty('--engine-gap', '16px');
      }
    }
  }

  const btnCompactEngineBtns = document.getElementById('btn-compact-engine-btns');
  const isCompactEngine = localStorage.getItem('eclipse_compact_engine_btns') === '1';
  document.body.classList.toggle('compact-engine-btns', isCompactEngine);
  if (btnCompactEngineBtns) {
    btnCompactEngineBtns.classList.toggle('active', isCompactEngine);
    btnCompactEngineBtns.addEventListener('click', () => {
      const next = !btnCompactEngineBtns.classList.contains('active');
      btnCompactEngineBtns.classList.toggle('active', next);
      document.body.classList.toggle('compact-engine-btns', next);
      localStorage.setItem('eclipse_compact_engine_btns', next ? '1' : '0');
      updateEngineWidthVar();
      setTimeout(updateEngineWidthVar, 350);
    });
  }

  const btnHideEngineBtns = document.getElementById('btn-hide-engine-btns');
  const isHideEngine = localStorage.getItem('eclipse_hide_engine_btns') === '1';
  document.body.classList.toggle('hide-engine-btns', isHideEngine);
  if (btnHideEngineBtns) {
    btnHideEngineBtns.classList.toggle('active', isHideEngine);
    btnHideEngineBtns.addEventListener('click', () => {
      const next = !btnHideEngineBtns.classList.contains('active');
      btnHideEngineBtns.classList.toggle('active', next);
      document.body.classList.toggle('hide-engine-btns', next);
      localStorage.setItem('eclipse_hide_engine_btns', next ? '1' : '0');
      updateEngineWidthVar();
      setTimeout(updateEngineWidthVar, 350);
    });
  }

  const btnPersistSound = document.getElementById('btn-persist-sound-settings');
  if (btnPersistSound) {
    btnPersistSound.classList.toggle('active', soundPersistenceEnabled);
    btnPersistSound.addEventListener('click', () => {
      const next = !btnPersistSound.classList.contains('active');
      btnPersistSound.classList.toggle('active', next);
      soundPersistenceEnabled = next;
      localStorage.setItem('eclipse_persist_sound_settings', next ? '1' : '0');
      if (next) persistSoundSettings();
    });
  }

  if (el.btnPlayPause) el.btnPlayPause.addEventListener('click', togglePlayPause);
  if (el.btnNext) el.btnNext.addEventListener('click', playNext);
  if (el.btnPrev) el.btnPrev.addEventListener('click', playPrev);

  if (el.btnShuffle) {
    el.btnShuffle.classList.toggle('active', state.isShuffle);
    el.btnShuffle.addEventListener('click', () => {
      state.isShuffle = !state.isShuffle;
      if (state.isShuffle && state.isAutoRemix) {
        state.isAutoRemix = false;
        localStorage.setItem('eclipse_automix', '0');
        if (window.autoMixDjInstance) window.autoMixDjInstance.enabled = false;
        const btnAutoMixEl = document.getElementById('btn-auto-remix') || el.btnAutoRemix;
        if (btnAutoMixEl) btnAutoMixEl.classList.remove('active');
        if (typeof showToast === 'function') showToast('Shuffle bật — Đã tắt AutoMix', 'info');
      }
      localStorage.setItem('eclipse_shuffle', state.isShuffle ? '1' : '0');
      el.btnShuffle.classList.toggle('active', state.isShuffle);
      if (nextTrackCoordinator) nextTrackCoordinator.cancel('shuffle_toggled');
    });
  }

  const REPEAT_ICONS = {
    standard: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="17 1 21 5 17 9"></polyline><path d="M3 11V9a4 4 0 0 1 4-4h14"></path><polyline points="7 23 3 19 7 15"></polyline><path d="M21 13v2a4 4 0 0 1-4 4H3"></path></svg>',
    one: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="17 1 21 5 17 9"></polyline><path d="M3 11V9a4 4 0 0 1 4-4h14"></path><polyline points="7 23 3 19 7 15"></polyline><path d="M21 13v2a4 4 0 0 1-4 4H3"></path><path d="M11 9.5h1v5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></path></svg>'
  };

  function updateRepeatUI(showFeedback = false) {
    if (!el.btnRepeat) return;
    const mode = state.repeatMode || 'off';
    el.btnRepeat.classList.remove('active', 'repeat-one');
    if (mode === 'off') {
      el.btnRepeat.innerHTML = REPEAT_ICONS.standard;
      el.btnRepeat.setAttribute('title', 'Repeat: Off');
      if (showFeedback && typeof showToast === 'function') showToast('Repeat: Off', 'info');
    } else if (mode === 'all') {
      el.btnRepeat.classList.add('active');
      el.btnRepeat.innerHTML = REPEAT_ICONS.standard;
      el.btnRepeat.setAttribute('title', 'Repeat: All (Queue)');
      if (showFeedback && typeof showToast === 'function') showToast('Repeat: All (Queue)', 'info');
    } else if (mode === 'one') {
      el.btnRepeat.classList.add('active', 'repeat-one');
      el.btnRepeat.innerHTML = REPEAT_ICONS.one;
      el.btnRepeat.setAttribute('title', 'Repeat: Current Track');
      if (showFeedback && typeof showToast === 'function') showToast('Repeat: Current Track', 'info');
    }
  }

  if (el.btnRepeat) {
    updateRepeatUI(false);
    el.btnRepeat.addEventListener('click', () => {
      // Cycle: off -> all -> one -> off
      if (state.repeatMode === 'off') {
        state.repeatMode = 'all';
      } else if (state.repeatMode === 'all') {
        state.repeatMode = 'one';
      } else {
        state.repeatMode = 'off';
      }
      localStorage.setItem('eclipse_repeat_mode', state.repeatMode);
      localStorage.setItem('eclipse_repeat', state.repeatMode === 'one' ? '1' : '0');
      updateRepeatUI(true);
    });
  }

  window.toggleShuffle = () => el.btnShuffle && el.btnShuffle.click();
  window.toggleRepeat = () => el.btnRepeat && el.btnRepeat.click();

  function persistVolumeState() {
    try {
      localStorage.setItem('eclipse_volume', String(state.volume));
      localStorage.setItem('eclipse_muted', state.isMuted ? '1' : '0');
    } catch (e) {}
  }

  if (el.playbar) {
    let volHudTimeout = null;
    el.playbar.addEventListener('wheel', (e) => {
      // Don't interfere if scrolling inside an internal scrollable list
      if (e.target.closest('.queue-list, .lyrics-container')) return;
      e.preventDefault();
      const delta = (Math.abs(e.deltaY) >= Math.abs(e.deltaX)) ? e.deltaY : -e.deltaX;
      if (Math.abs(delta) < 0.1) return;
      const step = delta < 0 ? 0.02 : -0.02;
      state.volume = Math.max(0, Math.min(1, Math.round((Number(state.volume) + step) * 100) / 100));
      state.isMuted = false;
      if (el.volumeSlider) {
        el.volumeSlider.value = String(state.volume);
      }
      if (el.volumeIcon) el.volumeIcon.classList.remove('hidden');
      if (el.volumeMutedIcon) el.volumeMutedIcon.classList.add('hidden');
      persistVolumeState();
      applyAudioSettings();

      // Show volume HUD toast
      const pct = Math.round(state.volume * 100);
      showToast(`Volume: ${pct}%`, 'info', 800);
    }, { passive: false });
  }

  if (el.volumeSlider) {
    el.volumeSlider.value = String(state.volume);
    if (state.isMuted) {
      if (el.volumeIcon) el.volumeIcon.classList.add('hidden');
      if (el.volumeMutedIcon) el.volumeMutedIcon.classList.remove('hidden');
    }
    const volGroup = el.volumeSlider.closest('.volume-control-group') || el.volumeSlider;
    volGroup.addEventListener('wheel', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const delta = (Math.abs(e.deltaY) >= Math.abs(e.deltaX)) ? e.deltaY : -e.deltaX;
      if (Math.abs(delta) < 0.1) return;
      const step = delta < 0 ? 0.05 : -0.05;
      state.volume = Math.max(0, Math.min(1, Math.round((Number(state.volume) + step) * 100) / 100));
      if (state.volume > 0 && state.isMuted) state.isMuted = false;
      el.volumeSlider.value = String(state.volume);
      el.volumeSlider.dispatchEvent(new Event('input'));
    }, { passive: false });
    el.volumeSlider.addEventListener('input', (e) => {
      state.volume = parseFloat(e.target.value);
      state.isMuted = false;
      if (el.volumeIcon) el.volumeIcon.classList.remove('hidden');
      if (el.volumeMutedIcon) el.volumeMutedIcon.classList.add('hidden');
      persistVolumeState();
      applyAudioSettings();
    });
  }

  if (el.btnVolumeMute) {
    el.btnVolumeMute.addEventListener('click', () => {
      state.isMuted = !state.isMuted;
      if (state.isMuted) {
        if (el.volumeIcon) el.volumeIcon.classList.add('hidden');
        if (el.volumeMutedIcon) el.volumeMutedIcon.classList.remove('hidden');
      } else {
        if (el.volumeIcon) el.volumeIcon.classList.remove('hidden');
        if (el.volumeMutedIcon) el.volumeMutedIcon.classList.add('hidden');
      }
      persistVolumeState();
      applyAudioSettings();
    });
  }

  if (el.btnToggleFav) {
    el.btnToggleFav.addEventListener('click', () => {
      if (state.currentTrack) toggleFavoriteTrack(state.currentTrack);
    });
  }

  const btnPlaybarTrim = el.btnPlaybarTrim || document.getElementById('btn-playbar-trim');
  if (btnPlaybarTrim) {
    btnPlaybarTrim.addEventListener('click', () => {
      if (state.currentTrack) {
        openTrimModalForTrack(state.currentTrack);
      } else {
        showToast('No track playing to trim', 'info');
      }
    });
  }

  if (el.btnClearHistory) {
    el.btnClearHistory.addEventListener('click', () => {
      state.history = [];
      localStorage.setItem('devsize_history', '[]');
      renderHistoryView();
    });
  }

  if (el.btnClearQueue) {
    el.btnClearQueue.addEventListener('click', () => {
      state.isRadioQueue = false;
      state.queue = [];
      state.queueIndex = -1;
      state.queueHistory = [];
      updateQueueBadge();
      renderQueueView();
    });
  }

  if (el.playlistSearchInput) {
    el.playlistSearchInput.addEventListener('input', () => {
      if (state.currentPlaylistId) openPlaylistDetail(state.currentPlaylistId);
    });
  }
  if (el.btnBackPlaylists) el.btnBackPlaylists.addEventListener('click', () => switchView('discover'));

  const deletePlaylistModal = document.getElementById('delete-playlist-modal');
  const deletePlaylistMsg = document.getElementById('delete-playlist-msg');
  const btnCancelDeletePlaylist = document.getElementById('btn-cancel-delete-playlist');
  const btnConfirmDeletePlaylist = document.getElementById('btn-confirm-delete-playlist');

  if (el.btnDeletePlaylist) {
    el.btnDeletePlaylist.addEventListener('click', () => {
      const pl = state.playlists.find(p => p.id === state.currentPlaylistId);
      if (!pl) return;
      if (deletePlaylistMsg) deletePlaylistMsg.textContent = `Delete playlist "${pl.name}"? This action cannot be undone.`;
      if (deletePlaylistModal) openModal(deletePlaylistModal);
    });
  }

  if (btnCancelDeletePlaylist && deletePlaylistModal) {
    btnCancelDeletePlaylist.addEventListener('click', () => {
      closeModal(deletePlaylistModal);
    });
  }

  if (btnConfirmDeletePlaylist && deletePlaylistModal) {
    btnConfirmDeletePlaylist.addEventListener('click', () => {
      deleteCurrentPlaylist();
      closeModal(deletePlaylistModal);
      showToast('Playlist deleted');
    });
  }



  if (el.btnNewPlaylist) {
    el.btnNewPlaylist.addEventListener('click', () => {
      if (el.newPlaylistInput) el.newPlaylistInput.value = '';
      if (el.createPlaylistModal) openModal(el.createPlaylistModal);
      if (el.newPlaylistInput) el.newPlaylistInput.focus();
    });
  }

  if (el.btnCancelNewPlaylist) {
    el.btnCancelNewPlaylist.addEventListener('click', () => {
      if (el.createPlaylistModal) closeModal(el.createPlaylistModal);
    });
  }

  if (el.btnConfirmNewPlaylist) {
    el.btnConfirmNewPlaylist.addEventListener('click', () => {
      const name = el.newPlaylistInput ? el.newPlaylistInput.value : '';
      if (name.trim()) {
        createPlaylist(name);
        if (el.createPlaylistModal) closeModal(el.createPlaylistModal);
      }
    });
  }

  if (el.newPlaylistInput) {
    el.newPlaylistInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && el.btnConfirmNewPlaylist) el.btnConfirmNewPlaylist.click();
      if (e.key === 'Escape' && el.btnCancelNewPlaylist) el.btnCancelNewPlaylist.click();
    });
  }

  if (el.btnCancelAddPlaylist) {
    el.btnCancelAddPlaylist.addEventListener('click', () => {
      if (el.addToPlaylistModal) closeModal(el.addToPlaylistModal);
    });
  }

  const btnCloseAddPlaylist = document.getElementById('btn-close-add-playlist-modal');
  if (btnCloseAddPlaylist) {
    btnCloseAddPlaylist.addEventListener('click', () => {
      if (el.addToPlaylistModal) closeModal(el.addToPlaylistModal);
    });
  }

  const btnCreatePlFromAdd = document.getElementById('btn-create-pl-from-add-modal');
  if (btnCreatePlFromAdd) {
    btnCreatePlFromAdd.addEventListener('click', () => {
      if (el.addToPlaylistModal) closeModal(el.addToPlaylistModal);
      if (el.createPlaylistModal) {
        if (el.newPlaylistInput) el.newPlaylistInput.value = '';
        openModal(el.createPlaylistModal);
        if (el.newPlaylistInput) el.newPlaylistInput.focus();
      }
    });
  }

  document.querySelectorAll('.audio-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.audio-tab').forEach((t) => t.classList.toggle('active', t === tab));
      document.querySelectorAll('.audio-panel').forEach((p) => p.classList.toggle('active', p.dataset.audioPanel === tab.dataset.audioTab));
    });
  });

  function createDropletSpring(el, opts) {
    opts = opts || {};
    const STIFFNESS = 0.12;
    const DAMPING = 0.68;
    const dir = opts.from === 'top' ? -1 : 1;
    const baseX = opts.baseX || '0px';

    let isOpen = false, animT = 0, velocity = 0, rafId = null;

    function render() {
      const translateY = Math.max(0, (1 - animT) * 100) * dir;
      const scaleX = 1 - velocity * 0.12;
      const scaleY = 1 + velocity * 0.12;
      el.style.transform = 'translate3d(' + baseX + ', ' + translateY + '%, 0) scale(' + scaleX + ', ' + scaleY + ')';
    }

    function isReduced() {
      return document.body.classList.contains('perf') ||
        (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    }

    function step() {
      if (isOpen) {
        const force = (1 - animT) * STIFFNESS;
        velocity = (velocity + force) * DAMPING;
        animT += velocity;
        if (Math.abs(1 - animT) < 0.002 && Math.abs(velocity) < 0.002) {
          animT = 1;
          velocity = 0;
          render();
          rafId = null;
          if (opts.onOpened) opts.onOpened();
          return;
        }
      } else {
        velocity = (velocity - animT * 0.18) * 0.62;
        animT = Math.max(0, animT + velocity);
        if (animT <= 0.003) {
          animT = 0;
          velocity = 0;
          render();
          rafId = null;
          if (opts.onClosed) opts.onClosed();
          return;
        }
      }
      render();
      rafId = requestAnimationFrame(step);
    }

    function open() {
      if (isReduced()) {
        if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
        isOpen = true;
        animT = 1;
        velocity = 0;
        el.style.transition = 'transform 150ms ease';
        el.style.transform = 'translate3d(' + baseX + ', 0%, 0) scale(1, 1)';
        setTimeout(() => {
          if (isOpen) {
            el.style.transition = '';
            if (opts.onOpened) opts.onOpened();
          }
        }, 150);
        return;
      }
      if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
      isOpen = true;
      el.style.transition = '';
      if (animT === 0) {
        velocity = 0;
        render();
      }
      rafId = requestAnimationFrame(step);
    }

    function close() {
      if (isReduced()) {
        if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
        isOpen = false;
        animT = 0;
        velocity = 0;
        el.style.transition = 'transform 150ms ease';
        el.style.transform = 'translate3d(' + baseX + ', ' + (100 * dir) + '%, 0) scale(1, 1)';
        setTimeout(() => {
          if (!isOpen) {
            el.style.transition = '';
            if (opts.onClosed) opts.onClosed();
          }
        }, 150);
        return;
      }
      if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
      isOpen = false;
      el.style.transition = '';
      rafId = requestAnimationFrame(step);
    }

    function toggle(forceOpen) {
      const target = forceOpen !== undefined ? forceOpen : !isOpen;
      if (target) open();
      else close();
    }

    return {
      open,
      close,
      toggle,
      get isOpen() { return isOpen; },
      render,
      step
    };
  }
  window.createDropletSpring = createDropletSpring;

  function attachWheelStepCarousel(track, itemSelector) {
    if (!track || track._wheelStepBound) return;
    track._wheelStepBound = true;
    let activeIdx = 0;
    let scrollPos = 0;
    let targetRaf = null;
    let wheelDebounceTimer = null;

    function snapStep() {
      const items = itemSelector ? track.querySelectorAll(itemSelector) : track.children;
      if (!items.length) { targetRaf = null; return; }
      activeIdx = Math.max(0, Math.min(items.length - 1, activeIdx));
      scrollPos += (activeIdx - scrollPos) * 0.25;
      const targetItem = items[activeIdx];
      const targetOffset = targetItem ? (targetItem.offsetLeft - track.offsetLeft) : 0;
      const currentOffset = track.scrollLeft;
      const nextScroll = currentOffset + (targetOffset - currentOffset) * 0.25;
      track.scrollLeft = nextScroll;
      if (Math.abs(targetOffset - nextScroll) > 0.5) {
        targetRaf = requestAnimationFrame(snapStep);
      } else {
        track.scrollLeft = targetOffset;
        scrollPos = activeIdx;
        targetRaf = null;
      }
    }

    track.addEventListener('wheel', (e) => {
      const items = itemSelector ? track.querySelectorAll(itemSelector) : track.children;
      if (items.length <= 1) return;
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (Math.abs(delta) < 2) return;
      e.preventDefault();
      if (wheelDebounceTimer) return;
      wheelDebounceTimer = setTimeout(() => { wheelDebounceTimer = null; }, 65);

      if (delta > 0 && activeIdx < items.length - 1) {
        activeIdx++;
      } else if (delta < 0 && activeIdx > 0) {
        activeIdx--;
      }
      if (!targetRaf) targetRaf = requestAnimationFrame(snapStep);
    }, { passive: false });
  }
  window.attachWheelStepCarousel = attachWheelStepCarousel;

  const audioCard = document.querySelector('.audio-menu-card');

  const wheelTracks = audioCard ? audioCard.querySelectorAll('.preset-wheel, .buffer-wheel, .carousel-track, .audio-presets-wheel, [data-carousel]') : [];
  wheelTracks.forEach(tr => attachWheelStepCarousel(tr));
  if (el.presetsContainer) attachWheelStepCarousel(el.presetsContainer, '.preset-chip');

  function closeConnected() {
    if (!audioCard?.classList.contains('connected-editor')) return;
    audioCard.classList.add('connected-closing');
    setTimeout(() => {
      audioCard.classList.remove('connected-editor', 'connected-closing');
      audioCard.style.transform = '';
      if (el.audioSettingsModal) el.audioSettingsModal.appendChild(audioCard);
    }, 200);
  }
  function toggleConnectedAudio(open) {
    const playbar = document.getElementById('playbar');
    if (!getAdv('connected_audio', true)) {
      if (audioCard && el.audioSettingsModal && audioCard.parentElement !== el.audioSettingsModal) {
        audioCard.classList.remove('connected-editor', 'connected-closing');
        audioCard.style.transform = '';
        el.audioSettingsModal.appendChild(audioCard);
      }
      if (open !== false && el.audioSettingsModal) openModal(el.audioSettingsModal);
      return;
    }
    const isOpen = audioCard?.classList.contains('connected-editor');
    if (open === false || (open === undefined && isOpen)) {
      closeConnected();
    } else if (audioCard && playbar) {
      audioCard.classList.remove('connected-closing');
      audioCard.classList.add('connected-editor');
      audioCard.style.transform = '';
      playbar.parentNode.insertBefore(audioCard, playbar);
    }
  }

  if (el.btnOpenSettings) {
    el.btnOpenSettings.addEventListener('click', (e) => {
      e.stopPropagation();
      const tempoTab = document.querySelector('.audio-tab[data-audio-tab="tempo"]') || document.querySelector('.audio-tab');
      if (tempoTab) tempoTab.click();
      toggleConnectedAudio();
      refreshStacks();
    });
  }

  if (el.btnCloseSettings) {
    el.btnCloseSettings.addEventListener('click', () => {
      if (audioCard?.classList.contains('connected-editor')) toggleConnectedAudio(false);
      else if (el.audioSettingsModal) closeModal(el.audioSettingsModal);
    });
  }

  document.addEventListener('click', (e) => {
    if (audioCard?.classList.contains('connected-editor') && !audioCard.contains(e.target) && !el.btnOpenSettings?.contains(e.target)) toggleConnectedAudio(false);
  });

  if (el.audioSettingsModal) {
    el.audioSettingsModal.addEventListener('click', (e) => {
      if (e.target === el.audioSettingsModal) closeModal(el.audioSettingsModal);
    });
  }

  if (el.btnOpenVisualSettings) {
    el.btnOpenVisualSettings.addEventListener('click', () => {
      if (el.visualSettingsModal) openModal(el.visualSettingsModal);
    });
  }

  if (el.btnCloseVisualSettings) {
    el.btnCloseVisualSettings.addEventListener('click', () => {
      if (el.visualSettingsModal) closeModal(el.visualSettingsModal);
    });
  }

  if (el.visualSettingsModal) {
    el.visualSettingsModal.addEventListener('click', (e) => {
      if (e.target === el.visualSettingsModal) closeModal(el.visualSettingsModal);
    });
  }

  if (el.btnToggleHqAudio) {
    el.btnToggleHqAudio.addEventListener('click', () => {
      state.hqEnabled = !state.hqEnabled;
      el.btnToggleHqAudio.classList.toggle('active', state.hqEnabled);
      
      if (el.hqPanelWrapper) {
        el.hqPanelWrapper.classList.toggle('expanded', state.hqEnabled);
        if (el.hqEnhancerCard) el.hqEnhancerCard.classList.toggle('is-expanded', state.hqEnabled);
      }
      initAudioContext();
      updateHqRouting();
      persistSoundSettings();
    });
  }

  if (el.hqPresetChips) {
    el.hqPresetChips.forEach(chip => {
      chip.addEventListener('click', () => {
        el.hqPresetChips.forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        state.hqSettings.preset = chip.dataset.preset;

        let v = 0, a = 0, b = 0;
        if (state.hqSettings.preset === 'studio') { v = 0; a = 0; b = 0; }
        else if (state.hqSettings.preset === 'vinyl') { v = 15; a = -15; b = 25; }
        else if (state.hqSettings.preset === 'concert') { v = -10; a = 30; b = 15; }

        if (el.sliderHqVocal) { el.sliderHqVocal.value = v; el.valHqVocal.textContent = (v > 0 ? '+' : '') + v + '%'; state.hqSettings.vocal = v; }
        if (el.sliderHqAir) { el.sliderHqAir.value = a; el.valHqAir.textContent = (a > 0 ? '+' : '') + a + '%'; state.hqSettings.air = a; }
        if (el.sliderHqBass) { el.sliderHqBass.value = b; el.valHqBass.textContent = (b > 0 ? '+' : '') + b + '%'; state.hqSettings.bass = b; }

        applyHqSettings();
      });
    });
  }

  ['Vocal', 'Air', 'Bass'].forEach(type => {
    const slider = el[`sliderHq${type}`];
    const valDisplay = el[`valHq${type}`];
    if (slider) {
      slider.addEventListener('input', (e) => {
        const val = parseInt(e.target.value, 10);
        if (valDisplay) valDisplay.textContent = (val > 0 ? '+' : '') + val + '%';
        state.hqSettings[type.toLowerCase()] = val;
        if (el.hqPresetChips) el.hqPresetChips.forEach(c => c.classList.remove('active'));
        applyHqSettings();
      });
    }
  });

  if (el.hqEngineSelect) {
    el.hqEngineSelect.addEventListener('change', (e) => {
      state.hqSettings.engine = e.target.value;
      applyHqSettings();
    });
  }

  const hqDropdown = document.getElementById('hq-engine-dropdown');
  const hqTrigger = document.getElementById('hq-engine-trigger');
  const hqLabel = document.getElementById('hq-engine-label');
  const hqMenu = document.getElementById('hq-engine-menu');

  if (hqTrigger && hqDropdown && hqMenu) {
    hqTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      hqDropdown.classList.toggle('open');
    });

    hqMenu.querySelectorAll('.m3-dropdown-option').forEach(opt => {
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        const val = opt.dataset.value;
        if (hqLabel) hqLabel.textContent = opt.textContent;
        hqMenu.querySelectorAll('.m3-dropdown-option').forEach(o => o.classList.remove('selected'));
        opt.classList.add('selected');
        if (el.hqEngineSelect) {
          el.hqEngineSelect.value = val;
          el.hqEngineSelect.dispatchEvent(new Event('change'));
        }
        hqDropdown.classList.remove('open');
      });
    });

    document.addEventListener('click', () => {
      hqDropdown.classList.remove('open');
    });
  }

  if (el.sliderSpeed) {
    el.sliderSpeed.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      state.audioSettings.speed = val;
      state.audioSettings.speedPitch = 1.0;
      if (el.sliderSpeedPitch) el.sliderSpeedPitch.value = 1.0;
      if (el.valSpeedPitch) el.valSpeedPitch.textContent = '1.00x';
      if (el.valSpeed) el.valSpeed.textContent = `${val.toFixed(2)}x`;
      state.activePresetId = null;
      applyAudioSettings();
      renderPresets();
    });
  }

  if (el.sliderSpeedPitch) {
    el.sliderSpeedPitch.addEventListener('input', (e) => {
      initAudioContext();
      const val = parseFloat(e.target.value);
      state.audioSettings.speedPitch = val;
      state.audioSettings.speed = 1.0;
      if (el.sliderSpeed) el.sliderSpeed.value = 1.0;
      if (el.valSpeed) el.valSpeed.textContent = '1.00x';
      if (el.valSpeedPitch) el.valSpeedPitch.textContent = `${val.toFixed(2)}x`;
      state.activePresetId = null;
      applyAudioSettings();
      renderPresets();
    });
  }

  if (el.sliderPitch) {
    el.sliderPitch.addEventListener('input', (e) => {
      initAudioContext();
      const val = parseInt(e.target.value, 10);
      state.audioSettings.pitch = val;
      if (el.valPitch) el.valPitch.textContent = `${val > 0 ? '+' : ''}${val} st`;
      state.activePresetId = null;
      applyAudioSettings();
      renderPresets();
    });
  }

  if (el.sliderReverb) {
    el.sliderReverb.addEventListener('input', (e) => {
      initAudioContext();
      const val = parseInt(e.target.value, 10);
      state.audioSettings.reverb = val;
      if (el.valReverb) el.valReverb.textContent = `${val}%`;
      state.activePresetId = null;
      applyAudioSettings();
      renderPresets();
    });
  }

  if (el.sliderDistortion) {
    el.sliderDistortion.addEventListener('input', (e) => {
      initAudioContext();
      const val = parseInt(e.target.value, 10);
      state.audioSettings.distortion = val;
      if (el.valDistortion) el.valDistortion.textContent = `${val}%`;
      state.activePresetId = null;
      applyAudioSettings();
      renderPresets();
    });
  }

  if (el.sliderGain) {
    el.sliderGain.addEventListener('input', (e) => {
      initAudioContext();
      const val = parseInt(e.target.value, 10);
      state.audioSettings.volume = val / 100;
      if (el.valGain) el.valGain.textContent = `${val}%`;
      state.activePresetId = null;
      applyAudioSettings();
      renderPresets();
    });
  }

  if (el.sliderEcho) {
    el.sliderEcho.addEventListener('input', (e) => {
      initAudioContext();
      const val = parseInt(e.target.value, 10);
      state.audioSettings.echo = val;
      if (el.valEcho) el.valEcho.textContent = `${val}%`;
      state.activePresetId = null;
      applyAudioSettings();
      renderPresets();
    });
  }

  ['low', 'mid', 'high'].forEach(band => {
    const cap = band.charAt(0).toUpperCase() + band.slice(1);
    const slider = el[`sliderEq${cap}`];
    const valEl = el[`valEq${cap}`];
    if (slider) {
      slider.addEventListener('input', (e) => {
        initAudioContext();
        const val = parseInt(e.target.value, 10);
        if (!state.audioSettings.eq) state.audioSettings.eq = { low: 0, mid: 0, high: 0 };
        state.audioSettings.eq[band] = val;
        if (valEl) valEl.textContent = `${val > 0 ? '+' : ''}${val} dB`;
        state.activePresetId = null;
        applyAudioSettings();
        renderPresets();
      });
      slider.addEventListener('dblclick', () => {
        initAudioContext();
        slider.value = 0;
        if (!state.audioSettings.eq) state.audioSettings.eq = { low: 0, mid: 0, high: 0 };
        state.audioSettings.eq[band] = 0;
        if (valEl) valEl.textContent = '0 dB';
        state.activePresetId = null;
        applyAudioSettings();
        renderPresets();
      });
    }
  });

  init10BandEqUI();

  let sleepTimerInterval = null;

  function syncSleepTimerButtons(value) {
    if (!el.sleepTimerStatus) return;
    const panel = el.sleepTimerStatus.closest('.audio-panel');
    if (!panel) return;
    panel.querySelectorAll('[data-sleep-minutes]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.sleepMinutes === value);
    });
  }

  function updateSleepTimerUI() {
    if (!el.sleepTimerStatus) return;
    if (!state.sleepTimer) {
      el.sleepTimerStatus.textContent = 'Off';
      el.sleepTimerStatus.classList.remove('active');
      syncSleepTimerButtons(null);
      return;
    }
    el.sleepTimerStatus.classList.add('active');
    if (state.sleepTimer.mode === 'end') {
      el.sleepTimerStatus.textContent = 'End of track';
      syncSleepTimerButtons('end');
      return;
    }
    syncSleepTimerButtons(String(state.sleepTimer.minutes));
    const left = Math.max(0, state.sleepTimer.endsAt - Date.now());
    const mins = Math.floor(left / 60000);
    const secs = Math.floor((left % 60000) / 1000);
    el.sleepTimerStatus.textContent = `${mins}:${String(secs).padStart(2, '0')}`;
  }

  function fadeOutAndPause() {
    const from = state.isMuted ? 0 : state.volume;
    if (!from || !audioEngine || !audioEngine.setVolume) {
      pauseSmooth();
      return;
    }
    const started = Date.now();
    const step = () => {
      const p = Math.min(1, (Date.now() - started) / 4000);
      const k = Math.max(0, 1 - p);
      audioEngine.setVolume(Math.round(from * k), state.isMuted);
      if (k < 1) {
        requestAnimationFrame(step);
        return;
      }
      pauseSmooth();
      audioEngine.setVolume(state.volume, state.isMuted);
    };
    step();
  }

  function setSleepTimer(value) {
    if (sleepTimerInterval) {
      clearInterval(sleepTimerInterval);
      sleepTimerInterval = null;
    }
    if (value === 'off') {
      state.sleepTimer = null;
      updateSleepTimerUI();
      return;
    }
    if (value === 'end') {
      state.sleepTimer = { mode: 'end' };
      updateSleepTimerUI();
      showToast('Sleep timer: end of track');
      return;
    }
    const minutes = Number(value);
    if (!Number.isFinite(minutes) || minutes <= 0) return;
    state.sleepTimer = { mode: 'minutes', minutes, endsAt: Date.now() + minutes * 60000 };
    updateSleepTimerUI();
    showToast(`Sleep timer: ${minutes} min`);
    sleepTimerInterval = setInterval(() => {
      if (!state.sleepTimer || state.sleepTimer.mode !== 'minutes') return;
      if (state.sleepTimer.endsAt > Date.now()) {
        updateSleepTimerUI();
        return;
      }
      clearInterval(sleepTimerInterval);
      sleepTimerInterval = null;
      state.sleepTimer = null;
      updateSleepTimerUI();
      fadeOutAndPause();
    }, 1000);
  }

  if (el.sleepTimerStatus) {
    const sleepPanel = el.sleepTimerStatus.closest('.audio-panel');
    if (sleepPanel) {
      sleepPanel.querySelectorAll('[data-sleep-minutes]').forEach((btn) => {
        btn.addEventListener('click', () => setSleepTimer(btn.dataset.sleepMinutes));
      });
    }
  }

  if (el.themeModeBtns) {
    el.themeModeBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        state.themeMode = btn.dataset.themeMode;
        localStorage.setItem('eclipse_theme_mode', state.themeMode);
        updateThemeFromState();
      });
    });
  }

  if (el.themeSwatches) {
    el.themeSwatches.forEach(sw => {
      sw.addEventListener('click', () => {
        state.themeAccent = sw.dataset.color;
        localStorage.setItem('eclipse_theme_accent', state.themeAccent);
        if (state.themeMode === 'auto') {
          const targetMode = currentEffectiveMode || 'dark';
          state.themeMode = targetMode;
          localStorage.setItem('eclipse_theme_mode', targetMode);
        }
        updateThemeFromState();
      });
    });
  }

  if (el.customColorInput) {
    el.customColorInput.addEventListener('input', (e) => {
      state.themeAccent = e.target.value;
      localStorage.setItem('eclipse_theme_accent', state.themeAccent);
      if (state.themeMode === 'auto') {
        const targetMode = currentEffectiveMode || 'dark';
        state.themeMode = targetMode;
        localStorage.setItem('eclipse_theme_mode', targetMode);
      }
      updateThemeFromState();
      if (el.themeSwatches) el.themeSwatches.forEach(sw => sw.classList.remove('active'));
    });
  }

  if (el.sliderHue) {
    el.sliderHue.addEventListener('input', (e) => {
      const h = parseInt(e.target.value, 10);
      if (el.valHue) el.valHue.textContent = h + '°';
      if (el.themeSwatches) el.themeSwatches.forEach(sw => sw.classList.remove('active'));
    });
    el.sliderHue.addEventListener('change', (e) => {
      const h = parseInt(e.target.value, 10);
      if (el.valHue) el.valHue.textContent = h + '°';
      state.themeAccent = hslToHex(h, 55, 50);
      localStorage.setItem('eclipse_theme_accent', state.themeAccent);
      if (state.themeMode === 'auto') {
        const targetMode = currentEffectiveMode || 'dark';
        state.themeMode = targetMode;
        localStorage.setItem('eclipse_theme_mode', targetMode);
      }
      updateThemeFromState();
      if (el.themeSwatches) el.themeSwatches.forEach(sw => sw.classList.remove('active'));
    });
  }

  if (el.sliderIntensity) {
    el.sliderIntensity.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      if (el.valIntensity) el.valIntensity.textContent = val + '%';
    });
    el.sliderIntensity.addEventListener('change', (e) => {
      if (state.themeMode === 'auto') return;
      const val = parseInt(e.target.value, 10);
      state.themeIntensity = val;
      document.body.classList.toggle('intensity-zero', state.themeIntensity < 8);
      if (el.valIntensity) el.valIntensity.textContent = val + '%';
      localStorage.setItem('eclipse_theme_intensity', val.toString());
      updateThemeFromState();
    });
  }
  if (el.sliderBrightness) {
    el.sliderBrightness.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      if (el.valBrightness) el.valBrightness.textContent = val + '%';
    });
    el.sliderBrightness.addEventListener('change', (e) => {
      if (state.themeMode === 'auto') return;
      const val = parseInt(e.target.value, 10);
      state.themeBrightness = val;
      if (el.valBrightness) el.valBrightness.textContent = val + '%';
      localStorage.setItem('eclipse_theme_brightness', val.toString());
      updateThemeFromState();
    });
  }

  if (el.sliderScale) {
    el.sliderScale.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      state.uiScale = val;
      if (el.valScale) el.valScale.textContent = `${val}%`;
    });
    el.sliderScale.addEventListener('change', (e) => {
      const val = parseInt(e.target.value, 10);
      state.uiScale = val;
      if (el.valScale) el.valScale.textContent = `${val}%`;
      localStorage.setItem('devsize_ui_scale', val.toString());
      requestAnimationFrame(() => {
        applyScale(val);
        requestAnimationFrame(resizeCanvases);
      });
    });
  }

  if (el.sliderFontScale) {
    el.sliderFontScale.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      if (el.valFontScale) el.valFontScale.textContent = `${val}%`;
      document.documentElement.style.setProperty('--font-scale', ((val / 100) * 0.95 * 1.25).toString());
      localStorage.setItem('eclipse_font_scale', val.toString());
      requestAnimationFrame(updateEngineWidthVar);
    });
  }

  const fontOptGoogle = document.getElementById('font-opt-google');
  const fontOptSf = document.getElementById('font-opt-sf');
  const fontOptSystem = document.getElementById('font-opt-system');

  [
    { btn: fontOptGoogle, key: 'google' },
    { btn: fontOptSf, key: 'sf' },
    { btn: fontOptSystem, key: 'system' }
  ].forEach(({ btn, key }) => {
    if (btn) {
      btn.addEventListener('click', () => {
        localStorage.setItem('eclipse_font', key);
        applyFont(key);
      });
    }
  });
  applyFont(state.riffFont);

  const ICON_PACKS = {
    sf: {
      '#nav-discover svg': '<circle cx="12" cy="12" r="9.5"></circle><polygon points="15.5 8.5 13.5 13.5 8.5 15.5 10.5 10.5 15.5 8.5" fill="currentColor"></polygon>',
      '#nav-favorites svg': '<path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"></path>',
      '#nav-albums svg': '<circle cx="12" cy="12" r="9.5"></circle><circle cx="12" cy="12" r="3.2"></circle><circle cx="12" cy="12" r="1" fill="currentColor"></circle>',
      '#nav-local svg': '<path d="M2.5 7A2.5 2.5 0 0 1 5 4.5h4.2c.8 0 1.5.4 1.9 1l1.2 1.8c.4.6 1.1 1 1.9 1H19A2.5 2.5 0 0 1 21.5 11v6.5a2.5 2.5 0 0 1-2.5 2.5H5a2.5 2.5 0 0 1-2.5-2.5V7z"></path>',
      '#nav-history svg': '<circle cx="12" cy="12" r="9.5"></circle><polyline points="12 6.5 12 12 15.5 14"></polyline>',
      '#nav-queue svg': '<path d="M4 6.5h16M4 12h16M4 17.5h16" stroke-linecap="round"></path>',
      '#nav-settings svg': '<circle cx="12" cy="12" r="3.2"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"></path>',
      '#btn-shuffle svg': '<path d="M16 4h4v4M4 20l16-16M16 20h4v-4M4 4l5 5m6 6l5 5"></path>',
      '#btn-prev svg': '<polygon points="19 20 9 12 19 4 19 20"></polygon><line x1="5" y1="19" x2="5" y2="5" stroke="currentColor" stroke-width="2.5"></line>',
      '#btn-next svg': '<polygon points="5 4 15 12 5 20 5 4"></polygon><line x1="19" y1="5" x2="19" y2="19" stroke="currentColor" stroke-width="2.5"></line>',
      '#btn-repeat svg': '<path d="M17 2l4 4-4 4M21 6H7a4 4 0 0 0-4 4v2M7 22l-4-4 4-4M3 18h14a4 4 0 0 0 4-4v-2"></path>',
      '#btn-auto-remix svg': '<circle cx="12" cy="12" r="9.5"></circle><circle cx="12" cy="12" r="2.8" fill="currentColor"></circle><path d="M12 2.5v3"></path><path d="M18.7 5.3l-2.1 2.1"></path>',
      '#btn-toggle-lyrics-panel svg': '<path d="M9 18V5l12-2v13M9 9l12-2"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle>',
      '#btn-open-settings svg': '<line x1="4" y1="21" x2="4" y2="14"></line><line x1="4" y1="10" x2="4" y2="3"></line><line x1="12" y1="21" x2="12" y2="12"></line><line x1="12" y1="8" x2="12" y2="3"></line><line x1="20" y1="21" x2="20" y2="16"></line><line x1="20" y1="12" x2="20" y2="3"></line><line x1="1" y1="14" x2="7" y2="14"></line><line x1="9" y1="8" x2="15" y2="8"></line><line x1="17" y1="16" x2="23" y2="16"></line>',
      '#volume-icon': '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"></path>'
    },
    lucide: {
      '#nav-discover svg': '<circle cx="12" cy="12" r="10"></circle><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"></polygon>',
      '#nav-favorites svg': '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"></path>',
      '#nav-albums svg': '<circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="4"></circle><circle cx="12" cy="12" r="1"></circle>',
      '#nav-local svg': '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"></path>',
      '#nav-history svg': '<circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline>',
      '#nav-queue svg': '<line x1="4" y1="7" x2="20" y2="7"></line><line x1="4" y1="12" x2="20" y2="12"></line><line x1="4" y1="17" x2="14" y2="17"></line>',
      '#nav-settings svg': '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path><circle cx="12" cy="12" r="3"></circle>',
      '#btn-shuffle svg': '<path d="M2 18h1.4c1.3 0 2.5-.6 3.3-1.7l6.6-8.6c.8-1.1 2-1.7 3.3-1.7H22"></path><path d="m18 2 4 4-4 4"></path><path d="M2 6h1.4c1.3 0 2.5.6 3.3 1.7l1.7 2.2"></path><path d="m14.6 14.1 1.8 2.2c.8 1.1 2 1.7 3.3 1.7H22"></path><path d="m18 14 4 4-4 4"></path>',
      '#btn-prev svg': '<polygon points="19 20 9 12 19 4 19 20"></polygon><line x1="5" y1="19" x2="5" y2="5"></line>',
      '#btn-next svg': '<polygon points="5 4 15 12 5 20 5 4"></polygon><line x1="19" y1="5" x2="19" y2="19"></line>',
      '#btn-repeat svg': '<path d="m17 2 4 4-4 4"></path><path d="M3 11v-1a4 4 0 0 1 4-4h14"></path><path d="m7 22-4-4 4-4"></path><path d="M21 13v1a4 4 0 0 1-4 4H3"></path>',
      '#btn-auto-remix svg': '<circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="2.5"></circle><path d="M12 2v3"></path><path d="M19.07 4.93l-2.12 2.12"></path>',
      '#btn-toggle-lyrics-panel svg': '<path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle>',
      '#btn-open-settings svg': '<line x1="4" y1="21" x2="4" y2="14"></line><line x1="4" y1="10" x2="4" y2="3"></line><line x1="12" y1="21" x2="12" y2="12"></line><line x1="12" y1="8" x2="12" y2="3"></line><line x1="20" y1="21" x2="20" y2="16"></line><line x1="20" y1="12" x2="20" y2="3"></line><line x1="1" y1="14" x2="7" y2="14"></line><line x1="9" y1="8" x2="15" y2="8"></line><line x1="17" y1="16" x2="23" y2="16"></line>',
      '#volume-icon': '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path>'
    },
    solar: {
      '#nav-discover svg': '<circle cx="12" cy="12" r="9.5"></circle><polygon points="16 8 13.8 13.8 8 16 10.2 10.2 16 8"></polygon>',
      '#nav-favorites svg': '<path d="M12.62 20.89c-.38.14-.86.14-1.24 0C8.48 19.82 2 15.69 2 8.69A5.69 5.69 0 0 1 7.69 3c1.64 0 3.12.7 4.31 1.83A6.05 6.05 0 0 1 16.31 3 5.69 5.69 0 0 1 22 8.69c0 7-6.48 11.13-9.38 12.2z"></path>',
      '#nav-albums svg': '<circle cx="12" cy="12" r="9.5"></circle><circle cx="12" cy="12" r="3"></circle>',
      '#nav-local svg': '<path d="M2 11c0-2.83 0-4.24.88-5.12C3.76 5 5.17 5 8 5h.5c.78 0 1.43 0 1.98.24.54.23.97.66 1.52 1.48L13 8h3c2.83 0 4.24 0 5.12.88C22 9.76 22 11.17 22 14v2c0 2.83 0 4.24-.88 5.12C20.24 22 18.83 22 16 22H8c-2.83 0-4.24 0-5.12-.88C2 20.24 2 18.83 2 16v-5z"></path>',
      '#nav-history svg': '<circle cx="12" cy="12" r="9.5"></circle><polyline points="12 7 12 12 15 13.5"></polyline>',
      '#nav-queue svg': '<path d="M4 7h16M4 12h16M4 17h11"></path>',
      '#nav-settings svg': '<circle cx="12" cy="12" r="3.5"></circle><path d="M12 2v2m0 16v2m10-10h-2M4 12H2m15.07-7.07-1.41 1.41M8.34 17.66l-1.41 1.41m12.14 0-1.41-1.41M8.34 6.34 6.93 4.93"></path>',
      '#btn-shuffle svg': '<polyline points="16 3 21 3 21 8"></polyline><line x1="4" y1="20" x2="21" y2="3"></line><polyline points="21 16 21 21 16 21"></polyline><line x1="15" y1="15" x2="21" y2="21"></line><line x1="4" y1="4" x2="9" y2="9"></line>',
      '#btn-prev svg': '<polygon points="19 20 9 12 19 4 19 20"></polygon><line x1="5" y1="19" x2="5" y2="5" stroke="currentColor" stroke-width="2.5"></line>',
      '#btn-next svg': '<polygon points="5 4 15 12 5 20 5 4"></polygon><line x1="19" y1="5" x2="19" y2="19" stroke="currentColor" stroke-width="2.5"></line>',
      '#btn-repeat svg': '<path d="M17 1l4 4-4 4H7a4 4 0 0 0-4 4v1M7 23l-4-4 4-4h10a4 4 0 0 0 4-4v-1"></path>',
      '#btn-auto-remix svg': '<circle cx="12" cy="12" r="9.5"></circle><circle cx="12" cy="12" r="2.5"></circle><path d="M12 2.5v3m6.7 2.8-2.1 2.1"></path>',
      '#btn-toggle-lyrics-panel svg': '<path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle>',
      '#btn-open-settings svg': '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"></path>',
      '#volume-icon': '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path>'
    }
  };

  const savedIconPack = localStorage.getItem('eclipse_icon_pack') || 'material';
  applyIconPack(savedIconPack);

  const iconPackDropdown = document.getElementById('icon-pack-dropdown');
  const iconPackTrigger = document.getElementById('icon-pack-trigger');
  const iconPackMenu = document.getElementById('icon-pack-menu');
  if (iconPackDropdown && iconPackTrigger && iconPackMenu) {
    iconPackTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      iconPackDropdown.classList.toggle('open');
    });

    iconPackMenu.querySelectorAll('.m3-dropdown-option').forEach(opt => {
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        const val = opt.dataset.value;
        localStorage.setItem('eclipse_icon_pack', val);
        applyIconPack(val);
        iconPackDropdown.classList.remove('open');
      });
    });

    document.addEventListener('click', () => {
      iconPackDropdown.classList.remove('open');
    });
  }

  const savedSearchPos = localStorage.getItem('eclipse_search_pos') || 'middle';
  applySearchPos(savedSearchPos);

  const searchPosDropdown = document.getElementById('search-pos-dropdown');
  const searchPosTrigger = document.getElementById('search-pos-trigger');
  const searchPosMenu = document.getElementById('search-pos-menu');
  if (searchPosDropdown && searchPosTrigger && searchPosMenu) {
    searchPosTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      searchPosDropdown.classList.toggle('open');
    });

    searchPosMenu.querySelectorAll('.m3-dropdown-option').forEach(opt => {
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        const val = opt.dataset.value;
        localStorage.setItem('eclipse_search_pos', val);
        applySearchPos(val);
        searchPosDropdown.classList.remove('open');
      });
    });

    document.addEventListener('click', () => {
      searchPosDropdown.classList.remove('open');
    });
  }

  let navResizeTimer = null;
  window.addEventListener('resize', () => {
    document.body.classList.add('is-window-resizing');
    clearTimeout(navResizeTimer);
    navResizeTimer = setTimeout(() => {
      document.body.classList.remove('is-window-resizing');
      updateEngineWidthVar();
    }, 120);
  });

  setTimeout(() => {
    updateEngineWidthVar();
    document.body.classList.remove('no-nav-transition');
  }, 50);

  if (el.sliderCornerRadius) {
    el.sliderCornerRadius.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      if (el.valCornerRadius) el.valCornerRadius.textContent = val === 16 ? 'Default' : `${val}px`;
      document.documentElement.style.setProperty('--md-shape-corner-l', `${val}px`);
      document.documentElement.style.setProperty('--md-shape-corner-m', `${Math.max(0, val - 4)}px`);
      localStorage.setItem('eclipse_corner_radius', val.toString());
    });
  }

  if (el.sliderUiAlpha) {
    el.sliderUiAlpha.addEventListener('input', (e) => {
      const val = Math.max(20, Math.min(100, parseInt(e.target.value, 10) || 100));
      if (el.valUiAlpha) el.valUiAlpha.textContent = `${val}%`;
      document.documentElement.style.setProperty('--ui-alpha', `${val}%`);
      localStorage.setItem('eclipse_ui_alpha', val.toString());
      refreshCachedThemeColors();
    });
  }

  if (el.btnResetUiAlpha) {
    el.btnResetUiAlpha.addEventListener('click', () => {
      const val = 100;
      if (el.sliderUiAlpha) el.sliderUiAlpha.value = val;
      if (el.valUiAlpha) el.valUiAlpha.textContent = `${val}%`;
      document.documentElement.style.setProperty('--ui-alpha', `${val}%`);
      localStorage.setItem('eclipse_ui_alpha', val.toString());
      refreshCachedThemeColors();
    });
  }

  if (el.sliderTextAlpha) {
    el.sliderTextAlpha.addEventListener('input', (e) => {
      const val = Math.max(1, Math.min(100, parseInt(e.target.value, 10) || 100));
      if (el.valTextAlpha) el.valTextAlpha.textContent = `${val}%`;
      document.documentElement.style.setProperty('--text-alpha', `${val}%`);
      localStorage.setItem('eclipse_text_alpha', val.toString());
      refreshCachedThemeColors();
    });
  }

  if (el.btnResetTextAlpha) {
    el.btnResetTextAlpha.addEventListener('click', () => {
      const val = 100;
      if (el.sliderTextAlpha) el.sliderTextAlpha.value = val;
      if (el.valTextAlpha) el.valTextAlpha.textContent = `${val}%`;
      document.documentElement.style.setProperty('--text-alpha', `${val}%`);
      localStorage.setItem('eclipse_text_alpha', val.toString());
      refreshCachedThemeColors();
    });
  }

  const btnChooseBannerMedia = document.getElementById('btn-choose-banner-media');
  const btnResetBannerMedia = document.getElementById('btn-reset-banner-media');

  if (btnChooseBannerMedia) {
    btnChooseBannerMedia.addEventListener('click', async () => {
      if (window.electronAPI && window.electronAPI.pickMedia) {
        const url = await window.electronAPI.pickMedia();
        if (url) {
          localStorage.setItem('eclipse_banner_media', url);
          const thumb = getTrackThumbUrl(state.currentTrack);
          updateRightPanelBanner(thumb);
          updatePlaylistDetailBanner(thumb);
        }
      }
    });
  }

  if (btnResetBannerMedia) {
    btnResetBannerMedia.addEventListener('click', () => {
      localStorage.removeItem('eclipse_banner_media');
      const thumb = getTrackThumbUrl(state.currentTrack);
      updateRightPanelBanner(thumb);
      updatePlaylistDetailBanner(thumb);
    });
  }

  const sliderBannerBlur = document.getElementById('slider-banner-blur');
  const valBannerBlur = document.getElementById('val-banner-blur');
  if (sliderBannerBlur) {
    sliderBannerBlur.value = savedBannerBlur;
    if (valBannerBlur) valBannerBlur.textContent = `${savedBannerBlur}px`;
    sliderBannerBlur.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      document.documentElement.style.setProperty('--banner-blur', `${v}px`);
      if (valBannerBlur) valBannerBlur.textContent = `${v}px`;
      localStorage.setItem('eclipse_banner_blur', v.toString());
    });
  }

  const sliderBannerOpacity = document.getElementById('slider-banner-opacity');
  const valBannerOpacity = document.getElementById('val-banner-opacity');
  if (sliderBannerOpacity) {
    sliderBannerOpacity.value = savedBannerOpacity;
    if (valBannerOpacity) valBannerOpacity.textContent = `${savedBannerOpacity}%`;
    sliderBannerOpacity.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      document.documentElement.style.setProperty('--banner-opacity', `${v / 100}`);
      if (valBannerOpacity) valBannerOpacity.textContent = `${v}%`;
      localStorage.setItem('eclipse_banner_opacity', v.toString());
    });
  }

  const sliderBannerFade = document.getElementById('slider-banner-fade');
  const valBannerFade = document.getElementById('val-banner-fade');
  if (sliderBannerFade) {
    sliderBannerFade.value = savedBannerFade;
    if (valBannerFade) valBannerFade.textContent = `${savedBannerFade}%`;
    sliderBannerFade.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      document.documentElement.style.setProperty('--banner-fade-base', `${v}%`);
      document.documentElement.style.setProperty('--banner-fade-end', `${v}%`);
      const rightBanner = document.getElementById('right-panel-banner');
      if (rightBanner) {
        rightBanner.style.setProperty('--banner-fade-base', `${v}%`);
        rightBanner.style.setProperty('--banner-fade-end', `${v}%`);
      }
      if (valBannerFade) valBannerFade.textContent = `${v}%`;
      localStorage.setItem('eclipse_banner_fade', v.toString());
    });
  }

  const selectBannerFit = document.getElementById('select-banner-fit');
  const bannerFitDropdown = document.getElementById('banner-fit-dropdown');
  const bannerFitTrigger = document.getElementById('banner-fit-trigger');
  const bannerFitLabel = document.getElementById('banner-fit-label');
  const bannerFitMenu = document.getElementById('banner-fit-menu');

  if (selectBannerFit) {
    selectBannerFit.value = savedBannerFit;
  }

  if (bannerFitDropdown && bannerFitTrigger && bannerFitMenu) {
    const curFit = savedBannerFit || 'zoom';
    if (bannerFitLabel) {
      bannerFitLabel.textContent = curFit.charAt(0).toUpperCase() + curFit.slice(1);
    }
    bannerFitMenu.querySelectorAll('.m3-dropdown-option').forEach(opt => {
      opt.classList.toggle('selected', opt.dataset.value === curFit);
    });

    bannerFitTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      bannerFitDropdown.classList.toggle('open');
    });

    bannerFitMenu.querySelectorAll('.m3-dropdown-option').forEach(opt => {
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        const val = opt.dataset.value;
        localStorage.setItem('eclipse_banner_fit', val);
        applyBannerFit(val);
        if (bannerFitLabel) bannerFitLabel.textContent = opt.textContent;
        bannerFitMenu.querySelectorAll('.m3-dropdown-option').forEach(o => o.classList.remove('selected'));
        opt.classList.add('selected');
        if (selectBannerFit) selectBannerFit.value = val;
        bannerFitDropdown.classList.remove('open');
      });
    });

    document.addEventListener('click', () => {
      bannerFitDropdown.classList.remove('open');
    });
  }

  const btnChooseCustomBg = document.getElementById('btn-choose-custom-bg');
  const btnRemoveCustomBg = document.getElementById('btn-remove-custom-bg');
  const sliderBgOpacity = document.getElementById('slider-bg-opacity');
  const valBgOpacity = document.getElementById('val-bg-opacity');
  const sliderBgBlur = document.getElementById('slider-bg-blur');
  const valBgBlur = document.getElementById('val-bg-blur');

  if (btnChooseCustomBg) {
    btnChooseCustomBg.addEventListener('click', async () => {
      if (window.electronAPI && window.electronAPI.pickMedia) {
        const url = await window.electronAPI.pickMedia();
        if (url) {
          localStorage.setItem('eclipse_bg_url', url);
          updateCustomBg();
          onBackgroundChanged('custom', true);
        }
      }
    });
  }

  if (btnRemoveCustomBg) {
    btnRemoveCustomBg.addEventListener('click', () => {
      localStorage.removeItem('eclipse_bg_url');
      updateCustomBg();
      onBackgroundChanged('custom', false);
    });
  }

  if (sliderBgOpacity) {
    sliderBgOpacity.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      if (valBgOpacity) valBgOpacity.textContent = `${v}%`;
      localStorage.setItem('eclipse_bg_opacity', String(v));
      const customBg = document.getElementById('custom-bg');
      if (customBg) customBg.style.opacity = (v / 100).toString();
    });
  }

  if (sliderBgBlur) {
    sliderBgBlur.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      if (valBgBlur) valBgBlur.textContent = `${v}px`;
      localStorage.setItem('eclipse_bg_blur', String(v));
      const customBg = document.getElementById('custom-bg');
      if (customBg) {
        customBg.style.filter = 'none';
        const media = customBg.firstElementChild;
        if (media) {
          const q = v > 0 ? 4 : 1;
          media.style.width = `${100 / q}%`;
          media.style.height = `${100 / q}%`;
          media.style.transformOrigin = '0 0';
          media.style.transform = q > 1 ? `scale(${q * 1.06}) translate(-3%, -3%)` : 'none';
          media.style.filter = v > 0 ? `blur(${v / q}px)` : 'none';
        }
      }
    });
  }

  updateCustomBg();

  const sliderCoverBgBrightness = document.getElementById('slider-cover-bg-brightness');
  const valCoverBgBrightness = document.getElementById('val-cover-bg-brightness');
  if (sliderCoverBgBrightness) {
    const savedBrightness = parseInt(localStorage.getItem('eclipse_cover_bg_brightness') ?? '45', 10);
    sliderCoverBgBrightness.value = savedBrightness;
    if (valCoverBgBrightness) valCoverBgBrightness.textContent = `${savedBrightness}%`;
    document.documentElement.style.setProperty('--cover-bg-brightness', (savedBrightness / 100).toString());

    sliderCoverBgBrightness.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      if (valCoverBgBrightness) valCoverBgBrightness.textContent = `${v}%`;
      localStorage.setItem('eclipse_cover_bg_brightness', String(v));
      document.documentElement.style.setProperty('--cover-bg-brightness', (v / 100).toString());
    });
  }

  setCoverBg(state.currentTrack ? getTrackThumbUrl(state.currentTrack) : '');

  registerFx(document.getElementById('home-ambient'), 'ambient', document.getElementById('view-discover'));
  registerFx(document.getElementById('playlist-hero-fx'), 'hero', document.getElementById('view-playlist-detail'));
  registerFx(document.getElementById('album-hero-fx'), 'hero', document.getElementById('view-album'));
  document.body.classList.toggle('no-clip-fx', !getAdv('clip_fx', false));
  document.body.classList.toggle('no-page-glow', !getAdv('page_glow_gradients', true));
  applyFxClip();

  const sliderMeshBrightness = document.getElementById('slider-mesh-brightness');
  const valMeshBrightness = document.getElementById('val-mesh-brightness');
  if (sliderMeshBrightness) {
    sliderMeshBrightness.value = state.meshBrightness;
    if (valMeshBrightness) valMeshBrightness.textContent = `${state.meshBrightness}%`;
    sliderMeshBrightness.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      if (valMeshBrightness) valMeshBrightness.textContent = `${v}%`;
    });
    sliderMeshBrightness.addEventListener('change', (e) => {
      const v = parseInt(e.target.value, 10);
      state.meshBrightness = v;
      if (valMeshBrightness) valMeshBrightness.textContent = `${v}%`;
      localStorage.setItem('eclipse_mesh_brightness', v.toString());
      updateThemeFromState();
    });
  }

  meshCfg = { ...DEFAULT_MESH_CFG };
  try {
    const raw = localStorage.getItem('eclipse_mesh_cfg');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.p1 && parsed.p2) {
        meshCfg = {
          p1: { x: Math.max(0, Math.min(100, Number(parsed.p1.x) ?? 20)), y: Math.max(0, Math.min(100, Number(parsed.p1.y) ?? 0)) },
          p2: { x: Math.max(0, Math.min(100, Number(parsed.p2.x) ?? 85)), y: Math.max(0, Math.min(100, Number(parsed.p2.y) ?? 5)) },
          speed: Math.max(0, Math.min(100, Number(parsed.speed) || 0)),
          blur: Math.max(0, Math.min(60, Number(parsed.blur) || 0))
        };
      }
    }
  } catch (_) {}

  applyMeshCfg(meshCfg, false);

  const btnConfigureMesh = document.getElementById('btn-configure-mesh');
  const meshModal = document.getElementById('mesh-customizer-modal');
  const btnCloseMeshModal = document.getElementById('btn-close-mesh-modal');
  const btnResetMesh = document.getElementById('btn-reset-mesh');
  const sliderMeshSpeed = document.getElementById('slider-mesh-speed');
  const sliderMeshBlur = document.getElementById('slider-mesh-blur');

  if (btnConfigureMesh) btnConfigureMesh.addEventListener('click', openMeshModal);
  if (btnCloseMeshModal) btnCloseMeshModal.addEventListener('click', closeMeshModal);
  if (meshModal) {
    meshModal.addEventListener('click', (e) => {
      if (e.target === meshModal) closeMeshModal();
    });
  }

  if (sliderMeshSpeed) {
    sliderMeshSpeed.addEventListener('input', (e) => {
      meshCfg.speed = parseInt(e.target.value, 10);
      applyMeshCfg(meshCfg, true);
    });
  }

  if (sliderMeshBlur) {
    sliderMeshBlur.addEventListener('input', (e) => {
      meshCfg.blur = parseInt(e.target.value, 10);
      applyMeshCfg(meshCfg, true);
    });
  }

  if (btnResetMesh) {
    btnResetMesh.addEventListener('click', () => {
      applyMeshCfg({
        p1: { x: 20, y: 0 },
        p2: { x: 85, y: 5 },
        speed: 0,
        blur: 0
      }, true);
    });
  }

  const previewBox = document.getElementById('mesh-preview-box');
  const dot1 = document.getElementById('mesh-dot-1');
  const dot2 = document.getElementById('mesh-dot-2');

  attachDotDrag(dot1, 'p1');
  attachDotDrag(dot2, 'p2');

  const paletteDropdown = document.getElementById('palette-style-dropdown');
  const paletteTrigger = document.getElementById('palette-style-trigger');
  const paletteLabel = document.getElementById('palette-style-trigger-label');
  const paletteMenu = document.getElementById('palette-style-menu');
  if (paletteDropdown && paletteTrigger && paletteMenu) {
    const currentStyle = state.paletteStyle || 'classic';
    const styleObj = PALETTE_STYLES[currentStyle] || PALETTE_STYLES.classic;
    if (paletteLabel) paletteLabel.textContent = styleObj.label;
    paletteMenu.querySelectorAll('.m3-dropdown-option').forEach(opt => {
      opt.classList.toggle('selected', opt.dataset.value === currentStyle);
    });

    paletteTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      paletteDropdown.classList.toggle('open');
    });

    paletteMenu.querySelectorAll('.m3-dropdown-option').forEach(opt => {
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        const val = opt.dataset.value;
        state.paletteStyle = val;
        localStorage.setItem('eclipse_palette_style', state.paletteStyle);
        if (paletteLabel) paletteLabel.textContent = opt.textContent;
        paletteMenu.querySelectorAll('.m3-dropdown-option').forEach(o => o.classList.remove('selected'));
        opt.classList.add('selected');
        paletteDropdown.classList.remove('open');
        updateThemeFromState();
      });
    });

    document.addEventListener('click', () => {
      paletteDropdown.classList.remove('open');
    });
  }

  const btnToggleAdv = document.getElementById('btn-toggle-adv-section');
  const advWrapper = document.getElementById('adv-collapsible-wrapper');
  if (btnToggleAdv && advWrapper) {
    const isAdvOpen = localStorage.getItem('eclipse_adv_open') === 'true';
    if (isAdvOpen) {
      btnToggleAdv.classList.add('is-open');
      advWrapper.classList.add('is-open');
    }
    btnToggleAdv.addEventListener('click', () => {
      const nowOpen = advWrapper.classList.toggle('is-open');
      btnToggleAdv.classList.toggle('is-open', nowOpen);
      localStorage.setItem('eclipse_adv_open', nowOpen ? 'true' : 'false');
    });
  }

  const advButtons = document.querySelectorAll('.effect-switch-btn[data-adv]');
  advButtons.forEach(btn => {
    const key = btn.dataset.adv;
    const defaultVal = (key === 'reduce_motion' || key === 'mesh_gradient' || key === 'mesh_cover_color' || key === 'clip_fx' || key === 'intensity_bg' || key === 'hide_titlebar' || key === 'classic_sidebar') ? false : true;
    const currentVal = getAdv(key, defaultVal);
    btn.classList.toggle('active', currentVal);

    btn.addEventListener('click', () => {
      const newVal = !btn.classList.contains('active');
      document.querySelectorAll(`.effect-switch-btn[data-adv="${key}"]`).forEach(b => b.classList.toggle('active', newVal));
      setAdv(key, newVal);

      if (key === 'reduce_motion') {
        applyReducedMotionSetting();
      } else if (key === 'classic_sidebar') {
        document.body.classList.toggle('classic-sidebar', !!newVal);
        setTimeout(() => {
          if (typeof updateNavIndicator === 'function') updateNavIndicator(false);
          if (typeof resizeCanvases === 'function') resizeCanvases();
        }, 260);
      } else if (key === 'hide_titlebar') {
        document.body.classList.toggle('hide-titlebar', !!newVal);
      } else if (key === 'autohide_timestamps') {
        document.body.classList.toggle('keep-bar-timestamps', !newVal);
      } else if (key === 'intensity_bg') {
        updateThemeFromState();
      } else if (key === 'mesh_gradient') {
        updateThemeFromState();
      } else if (key === 'mesh_follow_intensity') {
        lastMeshKey = '';
        if (lastMeshArgs) updateMeshGradient(...lastMeshArgs);
      } else if (key === 'mesh_cover_color') {
        refreshMeshCover();
        lastMeshKey = '';
        if (lastMeshArgs) updateMeshGradient(...lastMeshArgs);
      } else if (key === 'cover_bg') {
        const thumb = state.currentTrack ? getTrackThumbUrl(state.currentTrack) : '';
        setCoverBg(thumb);
        if (typeof onBackgroundChanged === 'function') onBackgroundChanged('cover', newVal);
      } else if (key === 'clip_fx') {
        document.body.classList.toggle('no-clip-fx', !newVal);
        applyFxClip();
      } else if (key === 'page_glow_gradients') {
        document.body.classList.toggle('no-page-glow', !newVal);
      } else if (key === 'albums') {
        if (!newVal && state.currentView === 'album') {
          const target = (state.previousView && state.previousView !== 'album') ? state.previousView : 'discover';
          switchView(target);
        }
      } else if (key === 'my_wave' || key === 'jump_back' || key === 'fav_artists') {
        initHomeHero();
        if (newVal) loadHomePage();
        applyHomeLayout();
      } else if (key === 'my_wave_ambient') {
        const homeAmb = document.getElementById('home-ambient');
        if (homeAmb) homeAmb.style.display = newVal ? '' : 'none';
        const ambientEl = document.getElementById('my-wave-ambient-light');
        if (ambientEl) ambientEl.style.display = newVal ? '' : 'none';
        const jumpAmbient = document.getElementById('jump-ambient-light');
        if (jumpAmbient) jumpAmbient.style.display = newVal ? '' : 'none';
      } else if (key === 'banners' || key === 'track_banners') {
        const bannerR = document.getElementById('right-panel-banner');
        const bannerP = document.getElementById('playlist-header-banner');
        const showR = getAdv('banners', true) && getAdv('track_banners', true);
        const showP = getAdv('banners', true);
        if (bannerR) {
          bannerR.style.display = showR ? '' : 'none';
          if (!showR) {
            bannerR.style.opacity = '0';
            const vid = bannerR.querySelector('video.banner-video');
            if (vid) vid.remove();
          }
        }
        if (bannerP) {
          bannerP.style.display = showP ? '' : 'none';
          if (!showP) {
            bannerP.style.opacity = '0';
          }
        }
        if (showR && state.currentTrack) {
          updateRightPanelBanner(getTrackThumbUrl(state.currentTrack));
        }
        if (state.isTvKaraokeOpen) syncTvBanner();
      } else if (key === 'karaoke_words') {
        renderLyricsView();
      }
    });
  });

  const btnSearchArtists = document.getElementById('btn-search-artists');
  if (btnSearchArtists) {
    btnSearchArtists.classList.toggle('active', localStorage.getItem('eclipse_search_artists') !== '0');
    btnSearchArtists.addEventListener('click', () => {
      const v = !btnSearchArtists.classList.contains('active');
      btnSearchArtists.classList.toggle('active', v);
      localStorage.setItem('eclipse_search_artists', v ? '1' : '0');
    });
  }

  const btnSmooth = document.getElementById('btn-smooth-presets');
  if (btnSmooth) {
    btnSmooth.classList.toggle('active', localStorage.getItem('eclipse_smooth_presets') !== 'false');
    btnSmooth.addEventListener('click', () => {
      const v = !btnSmooth.classList.contains('active');
      btnSmooth.classList.toggle('active', v);
      localStorage.setItem('eclipse_smooth_presets', String(v));
    });
  }
  if (sidebarEl) {
    sidebarEl.classList.add('no-nav-anim');
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        sidebarEl.classList.remove('no-nav-anim');
      });
    });
  }

  const btnShowLocal = document.getElementById('btn-show-local');
  if (btnShowLocal) {
    btnShowLocal.addEventListener('click', () => {
      const show = localStorage.getItem('eclipse_show_local') !== 'false';
      localStorage.setItem('eclipse_show_local', (!show) ? 'true' : 'false');
      updateShowLocalUI(true);
      refreshStacks();
    });
  }
  updateShowLocalUI(false);

  const showAlbumsSaved = localStorage.getItem('eclipse_show_albums') === '1';
  document.body.classList.toggle('hide-albums-tab', !showAlbumsSaved);
  const btnShowAlbums = document.getElementById('btn-show-albums');
  if (btnShowAlbums) {
    btnShowAlbums.classList.toggle('active', showAlbumsSaved);
    btnShowAlbums.addEventListener('click', () => {
      const next = !btnShowAlbums.classList.contains('active');
      btnShowAlbums.classList.toggle('active', next);
      localStorage.setItem('eclipse_show_albums', next ? '1' : '0');
      document.body.classList.toggle('hide-albums-tab', !next);
      if (!next && state.currentView === 'albums') {
        switchView('discover');
      }
      if (typeof refreshStacks === 'function') refreshStacks();
      if (typeof updateNavIndicator === 'function') updateNavIndicator(false);
    });
  }

  function applyNoHandCursor(on) {
    document.body.classList.toggle('no-hand-cursor', !!on);
  }
  const btnNoHandCursor = document.getElementById('btn-no-hand-cursor');
  const noHand = localStorage.getItem('eclipse_no_hand_cursor') !== '0';
  applyNoHandCursor(noHand);
  if (btnNoHandCursor) {
    btnNoHandCursor.classList.toggle('active', noHand);
    btnNoHandCursor.addEventListener('click', () => {
      const next = !btnNoHandCursor.classList.contains('active');
      btnNoHandCursor.classList.toggle('active', next);
      localStorage.setItem('eclipse_no_hand_cursor', next ? '1' : '0');
      applyNoHandCursor(next);
    });
  }

  function applyHighlightButtons(on) {
    document.body.classList.toggle('highlight-buttons', !!on);
  }
  const btnHighlightButtons = document.getElementById('btn-highlight-buttons');
  const initialHighlightButtons = localStorage.getItem('eclipse_highlight_buttons') !== '0';
  applyHighlightButtons(initialHighlightButtons);
  if (btnHighlightButtons) {
    btnHighlightButtons.classList.toggle('active', initialHighlightButtons);
    btnHighlightButtons.addEventListener('click', () => {
      const next = !btnHighlightButtons.classList.contains('active');
      btnHighlightButtons.classList.toggle('active', next);
      localStorage.setItem('eclipse_highlight_buttons', next ? '1' : '0');
      applyHighlightButtons(next);
    });
  }

  const RIFF_APP_ICONS = [
    { id: '01-default.svg', label: 'Default' },
    { id: '02-editor.svg', label: 'Editor' },
    { id: '03-orbit.svg', label: 'Orbit' },
    { id: '04-vinyl.svg', label: 'Vinyl' },
    { id: '06-cosmos.svg', label: 'Cosmos' },
    { id: '07-aurora.svg', label: 'Aurora' },
    { id: '08-sunset.svg', label: 'Sunset' },
    { id: '09-amethyst.svg', label: 'Amethyst' },
    { id: '10-y2k-disc.svg', label: 'Y2K Disc' },
    { id: '11-cassette.svg', label: 'Cassette' },
    { id: '12-invincible.svg', label: 'Invincible' },
    { id: '13-blueprint.svg', label: 'Blueprint' },
    { id: '14-galaxy.svg', label: 'Galaxy' },
    { id: '15-opal.svg', label: 'Opal' },
    { id: '16-chrome.svg', label: 'Chrome' },
    { id: '17-eclipse.svg', label: 'Eclipse' },
    { id: '18-nebula.svg', label: 'Nebula' },
    { id: '19-horizon.svg', label: 'Horizon' },
    { id: '20-vice.svg', label: 'Vice Sunset' }
  ];
  function resolveAppIconSrc(val) {
    if (!val) return '../../assets/02-editor.svg';
    if (val.startsWith('file:') || val.startsWith('http') || val.startsWith('data:')) return val;
    return '../../assets/' + val.replace(/^.*assets\//, '');
  }
  function applyHomeAppIcon(val) {
    const chosen = val || localStorage.getItem('eclipse_app_icon') || '02-editor.svg';
    localStorage.setItem('eclipse_app_icon', chosen);
    const homeImg = document.getElementById('nav-home-app-icon');
    if (homeImg) homeImg.src = resolveAppIconSrc(chosen);
    const grid = document.getElementById('app-icon-picker-grid');
    if (grid) {
      grid.querySelectorAll('.app-icon-option').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.icon === chosen);
      });
    }
  }
  function initAppIconPicker() {
    const grid = document.getElementById('app-icon-picker-grid');
    const saved = localStorage.getItem('eclipse_app_icon') || '02-editor.svg';
    if (grid) {
      grid.innerHTML = '';
      RIFF_APP_ICONS.forEach(item => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'app-icon-option' + (saved === item.id ? ' active' : '');
        btn.dataset.icon = item.id;
        btn.innerHTML = '<div class="app-icon-option-box"><img src="' + resolveAppIconSrc(item.id) + '" alt="' + item.label + '" draggable="false" /></div><span class="app-icon-option-label">' + item.label + '</span>';
        btn.addEventListener('click', () => applyHomeAppIcon(item.id));
        grid.appendChild(btn);
      });
    }
    const btnCustom = document.getElementById('btn-pick-custom-home-icon');
    if (btnCustom && window.electronAPI && window.electronAPI.pickMedia) {
      btnCustom.addEventListener('click', async () => {
        const url = await window.electronAPI.pickMedia();
        if (url) applyHomeAppIcon(url);
      });
    }
    applyHomeAppIcon(saved);
  }
  initAppIconPicker();

  function watchSliderValue(input, onChange) {
    const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    Object.defineProperty(input, 'value', { configurable: true, get() { return desc.get.call(this); }, set(v) { desc.set.call(this, v); onChange(); } });
    input.addEventListener('input', onChange);
  }
  function enhanceSliders(root) {
    (root || document).querySelectorAll('input[type="range"]:not(.sl-done):not(#slider-theme-hue)').forEach((input) => {
      if (input.closest('.eq-slider-box') || input.closest('.eq-slider-wrap') || input.closest('.hue-seg') || input.classList.contains('eq-band-range')) return;
      input.classList.add('sl-done');
      const wrap = document.createElement('div');
      wrap.className = 'sl';
      wrap.innerHTML = '<div class="sl-active"></div><div class="sl-inactive"></div>';
      input.parentNode.insertBefore(wrap, input);
      wrap.appendChild(input);
      const sync = () => {
        const min = input.min === '' ? 0 : parseFloat(input.min);
        const max = input.max === '' ? 100 : parseFloat(input.max);
        const rawRatio = max > min ? (parseFloat(input.value) - min) / (max - min) : 0;
        if (input.id === 'volume-slider') {
          const v = (!state.isMuted && rawRatio > 0) ? (0.06 + rawRatio * 0.94) : 0;
          wrap.style.setProperty('--v', v);
        } else {
          wrap.style.setProperty('--v', rawRatio);
        }
      };
      watchSliderValue(input, sync);
      sync();
    });
  }
  enhanceSliders();
  let sliderRaf = 0;
  new MutationObserver(() => { if (sliderRaf) return; sliderRaf = requestAnimationFrame(() => { sliderRaf = 0; enhanceSliders(); }); }).observe(document.body, { childList: true, subtree: true });

  (function initHueSegments() {
    const input = document.getElementById('slider-theme-hue');
    const track = document.querySelector('.hue-seg-track');
    const host = document.getElementById('hue-seg');
    if (!input || !track || !host) return;
    for (let i = 0; i < 12; i++) {
      const seg = document.createElement('i');
      seg.style.background = `linear-gradient(90deg, hsl(${i * 30} 75% 55%), hsl(${(i + 1) * 30} 75% 55%))`;
      track.appendChild(seg);
    }
    const sync = () => {
      const min = input.min === '' ? 0 : parseFloat(input.min);
      const max = input.max === '' ? 360 : parseFloat(input.max);
      host.style.setProperty('--v', max > min ? (parseFloat(input.value) - min) / (max - min) : 0);
    };
    watchSliderValue(input, sync);
    sync();
  })();

  const btnWavyProgress = document.getElementById('btn-wavy-progress');
  const btnBarWave = document.getElementById('btn-bar-wave');
  const barWaveOn = localStorage.getItem('eclipse_bar_wave') !== '0';
  applyBarWave(barWaveOn);
  if (btnBarWave) {
    btnBarWave.classList.toggle('active', barWaveOn);
    btnBarWave.addEventListener('click', () => {
      const next = !btnBarWave.classList.contains('active');
      btnBarWave.classList.toggle('active', next);
      localStorage.setItem('eclipse_bar_wave', next ? '1' : '0');
      applyBarWave(next);
    });
  }

  const barVizPosGroup = document.getElementById('bar-viz-pos-group');
  const initialBarVizPos = localStorage.getItem('eclipse_bar_viz_pos') || 'behind';
  applyBarVizPos(initialBarVizPos);
  if (barVizPosGroup) {
    barVizPosGroup.querySelectorAll('.theme-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const pos = btn.getAttribute('data-bar-viz-pos') || 'behind';
        localStorage.setItem('eclipse_bar_viz_pos', pos);
        applyBarVizPos(pos);
      });
    });
  }

  const sliderBarVizOpacity = document.getElementById('slider-bar-viz-opacity');
  const valBarVizOpacity = document.getElementById('val-bar-viz-opacity');
  const initialBarVizOpacity = localStorage.getItem('eclipse_bar_viz_opacity') || '22';
  applyBarVizOpacity(initialBarVizOpacity);
  if (sliderBarVizOpacity) {
    const onOpInput = (e) => {
      const v = e.target.value;
      localStorage.setItem('eclipse_bar_viz_opacity', v);
      applyBarVizOpacity(v);
    };
    sliderBarVizOpacity.addEventListener('input', onOpInput);
    sliderBarVizOpacity.addEventListener('change', onOpInput);
  }

  const btnVizConnected = document.getElementById('btn-viz-connected');
  const btnTvkVizConnected = document.getElementById('btn-tvk-viz-connected');
  if (btnVizConnected) btnVizConnected.addEventListener('click', toggleVizConnected);
  if (btnTvkVizConnected) btnTvkVizConnected.addEventListener('click', toggleVizConnected);
  syncVizConnectedUI();

  const toggleM3Cover = document.getElementById('toggle-m3-cover');
  if (toggleM3Cover) {
    const saved = localStorage.getItem('eclipse_m3_cover');
    const isM3On = saved !== '0';
    toggleM3Cover.classList.toggle('active', isM3On);
    toggleM3Cover.addEventListener('click', () => {
      const next = !toggleM3Cover.classList.contains('active');
      toggleM3Cover.classList.toggle('active', next);
      localStorage.setItem('eclipse_m3_cover', next ? '1' : '0');
      applyM3Cover();
    });
  }

  const toggleM3Hero = document.getElementById('toggle-m3-hero-covers');
  if (toggleM3Hero) {
    const isHeroOn = localStorage.getItem('eclipse_m3_hero_covers') === '1';
    toggleM3Hero.classList.toggle('active', isHeroOn);
    document.body.classList.toggle('m3-hero-covers-on', isHeroOn);
    toggleM3Hero.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const next = !toggleM3Hero.classList.contains('active');
      toggleM3Hero.classList.toggle('active', next);
      document.body.classList.toggle('m3-hero-covers-on', next);
      localStorage.setItem('eclipse_m3_hero_covers', next ? '1' : '0');
      if (typeof m3cStart === 'function') m3cStart();
    };
  }

  const toggleExplicitTag = document.getElementById('toggle-explicit-tag');
  const isExplicitOn = localStorage.getItem('eclipse_show_explicit') !== '0';
  document.body.classList.toggle('hide-explicit-badges', !isExplicitOn);
  if (toggleExplicitTag) {
    toggleExplicitTag.classList.toggle('active', isExplicitOn);
    toggleExplicitTag.addEventListener('click', () => {
      const next = !toggleExplicitTag.classList.contains('active');
      toggleExplicitTag.classList.toggle('active', next);
      localStorage.setItem('eclipse_show_explicit', next ? '1' : '0');
      document.body.classList.toggle('hide-explicit-badges', !next);
    });
  }

  updateTvkVisualizerSetting(localStorage.getItem('eclipse_tvk_visualizer') !== 'false');
  updateTvkVisualizerLyricsSetting(localStorage.getItem('eclipse_tvk_visualizer_lyrics') !== 'false');
  updateTvkVisualizerOpacity(parseInt(localStorage.getItem('eclipse_tvk_visualizer_opacity') || '85', 10));

  const btnPerfMode = document.getElementById('btn-perf-mode');
  const initialPerfMode = localStorage.getItem('eclipse_perf_mode') === '1';
  applyPerfMode(initialPerfMode);
  document.body.classList.toggle('perf', initialPerfMode);
  if (typeof applyReducedMotionSetting === 'function') applyReducedMotionSetting();
  localStorage.setItem('eclipse_perf_mode', initialPerfMode ? '1' : '0');
  if (btnPerfMode) btnPerfMode.classList.toggle('active', initialPerfMode);
  applyLyricsEase();
  updateNavIndicator(true);
  if (btnPerfMode) {
    btnPerfMode.addEventListener('click', () => {
      const next = !btnPerfMode.classList.contains('active');
      btnPerfMode.classList.toggle('active', next);
      localStorage.setItem('eclipse_perf_mode', next ? '1' : '0');
      applyPerfMode(next);
    });
  }

  if (btnWavyProgress) {
    btnWavyProgress.addEventListener('click', () => {
      const isWavy = localStorage.getItem('eclipse_wavy_progress') !== 'false';
      const next = !isWavy;
      localStorage.setItem('eclipse_wavy_progress', next ? 'true' : 'false');
      updateWavyProgressUI();
      hasDrawnPausedFrame = false;
    });
  }

  const btnProgressKnob = document.getElementById('btn-progress-knob');
  if (btnProgressKnob) {
    btnProgressKnob.addEventListener('click', () => {
      const isKnob = localStorage.getItem('eclipse_progress_knob') === 'true';
      const next = !isKnob;
      localStorage.setItem('eclipse_progress_knob', next ? 'true' : 'false');
      updateProgressKnobUI();
      hasDrawnPausedFrame = false;
      if (!animationFrameId && typeof startVisualizers === 'function') startVisualizers();
    });
  }

  const btnProgressBg = document.getElementById('btn-progress-bg');
  if (btnProgressBg) {
    btnProgressBg.addEventListener('click', () => {
      const isBg = localStorage.getItem('eclipse_progress_bg') === 'true';
      const next = !isBg;
      localStorage.setItem('eclipse_progress_bg', next ? 'true' : 'false');
      updateProgressBgUI();
      hasDrawnPausedFrame = false;
      if (!animationFrameId && typeof startVisualizers === 'function') startVisualizers();
    });
  }

  updateWavyProgressUI();
  updateProgressKnobUI();
  updateProgressBgUI();

  const btnTrayOnClose = document.getElementById('btn-tray-on-close');
  const storedTrayOnClose = localStorage.getItem('eclipse_tray_on_close');
  const savedTrayOnClose = storedTrayOnClose !== null
    ? storedTrayOnClose === 'true'
    : /Windows|Mac/.test(navigator.userAgent);
  if (btnTrayOnClose) {
    btnTrayOnClose.classList.toggle('active', savedTrayOnClose);
    btnTrayOnClose.addEventListener('click', () => {
      const next = !btnTrayOnClose.classList.contains('active');
      btnTrayOnClose.classList.toggle('active', next);
      localStorage.setItem('eclipse_tray_on_close', next ? 'true' : 'false');
      if (window.electronAPI && window.electronAPI.setTrayOnClose) {
        window.electronAPI.setTrayOnClose(next);
      }
    });
  }
  if (window.electronAPI && window.electronAPI.setTrayOnClose) {
    window.electronAPI.setTrayOnClose(savedTrayOnClose);
  }

  const btnMultiInstance = document.getElementById('btn-multi-instance');
  if (btnMultiInstance && window.electronAPI && window.electronAPI.getMultiInstance) {
    window.electronAPI.getMultiInstance().then((on) => btnMultiInstance.classList.toggle('active', !!on));
    btnMultiInstance.addEventListener('click', () => {
      const next = !btnMultiInstance.classList.contains('active');
      btnMultiInstance.classList.toggle('active', next);
      window.electronAPI.setMultiInstance(next);
      showToast(next ? 'Multiple instances will be allowed after restart' : 'Single instance mode after restart', 'info');
    });
  }

  async function refreshAudioOutputDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioOutputs = devices.filter(d => d.kind === 'audiooutput');
      knownAudioOutputIds = new Set(audioOutputs.map(d => d.deviceId));

      const dropdown = document.getElementById('audio-output-dropdown');
      const label = document.getElementById('audio-output-label');
      const menu = document.getElementById('audio-output-menu');

      if (menu) {
        menu.innerHTML = '';

        const defaultOpt = document.createElement('button');
        defaultOpt.type = 'button';
        const isDefault = (!currentAudioOutputDeviceId || currentAudioOutputDeviceId === 'default' || currentAudioOutputDeviceId === '');
        defaultOpt.className = 'm3-dropdown-option' + (isDefault ? ' selected' : '');
        defaultOpt.dataset.value = 'default';
        defaultOpt.textContent = 'System default';
        defaultOpt.addEventListener('click', (e) => {
          e.stopPropagation();
          applyAudioOutputDevice('default');
          if (dropdown) dropdown.classList.remove('open');
        });
        menu.appendChild(defaultOpt);

        let foundActive = isDefault;
        let activeLabel = 'System default';

        audioOutputs.forEach(device => {
          if (!device.deviceId || device.deviceId === 'default') return;
          const opt = document.createElement('button');
          opt.type = 'button';
          const isSel = (device.deviceId === currentAudioOutputDeviceId);
          if (isSel) {
            foundActive = true;
            activeLabel = device.label || `Speaker (${device.deviceId.slice(0, 5)})`;
          }
          opt.className = 'm3-dropdown-option' + (isSel ? ' selected' : '');
          opt.dataset.value = device.deviceId;
          opt.textContent = device.label || `Speaker (${device.deviceId.slice(0, 5)})`;
          opt.addEventListener('click', (e) => {
            e.stopPropagation();
            applyAudioOutputDevice(device.deviceId);
            if (dropdown) dropdown.classList.remove('open');
          });
          menu.appendChild(opt);
        });

        if (label) {
          label.textContent = activeLabel;
        }
      }
    } catch (err) {
      console.warn('Failed to enumerate audio output devices:', err);
    }
  }

  const audioOutputDropdown = document.getElementById('audio-output-dropdown');
  const audioOutputTrigger = document.getElementById('audio-output-trigger');
  if (audioOutputTrigger && audioOutputDropdown) {
    audioOutputTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      audioOutputDropdown.classList.toggle('open');
    });
    document.addEventListener('click', () => {
      audioOutputDropdown.classList.remove('open');
    });
  }

  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', async () => {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioOutputs = devices.filter(d => d.kind === 'audiooutput');
        const currentIds = new Set(audioOutputs.map(d => d.deviceId));

        const decreased = (knownAudioOutputIds.size > 0 && audioOutputs.length < knownAudioOutputIds.size);
        const activeLost = (currentAudioOutputDeviceId && currentAudioOutputDeviceId !== 'default' && !currentIds.has(currentAudioOutputDeviceId));

        if (state.isPlaying && (decreased || activeLost)) {
          if (typeof pauseSmooth === 'function') {
            pauseSmooth();
          } else if (el.nativeAudio) {
            el.nativeAudio.pause();
          }
        }

        await refreshAudioOutputDevices();
      } catch (e) {
        console.warn('devicechange error:', e);
      }
    });
  }

  refreshAudioOutputDevices().then(() => {
    if (currentAudioOutputDeviceId && currentAudioOutputDeviceId !== 'default') {
      applyAudioOutputDevice(currentAudioOutputDeviceId);
    }
  });

  const sliderCrossfade = document.getElementById('slider-crossfade');
  const valCrossfade = document.getElementById('val-crossfade');
  if (sliderCrossfade) {
    const cf = parseInt(localStorage.getItem('eclipse_crossfade') || '0', 10);
    sliderCrossfade.value = cf;
    if (valCrossfade) valCrossfade.textContent = cf > 0 ? `${cf}s` : 'Off';
    sliderCrossfade.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      if (valCrossfade) valCrossfade.textContent = v > 0 ? `${v}s` : 'Off';
      localStorage.setItem('eclipse_crossfade', String(v));
    });
  }

  if (el.btnTrEnabled) {
    el.btnTrEnabled.addEventListener('click', () => {
      state.trEnabled = !state.trEnabled;
      localStorage.setItem('eclipse_tr_enabled', String(state.trEnabled));
      updateLyricsTranslationUI();
      if (!state.trEnabled) {
        state.trActive = false;
        state.currentTranslations = null;
        renderLyricsView();
        if (el.nativeAudio) updateSyncedLyricsHighlight(el.nativeAudio.currentTime || 0);
      } else if (state.trAuto || state.trActive) {
        state.trActive = true;
        updateLyricsTranslationUI();
        fetchAndApplyTranslation();
      }
    });
  }

  const trLangDropdown = document.getElementById('tr-lang-dropdown');
  const trLangTrigger = document.getElementById('tr-lang-trigger');
  const trLangLabel = document.getElementById('tr-lang-label');
  const trLangMenu = document.getElementById('tr-lang-menu');
  const trLangList = document.getElementById('tr-lang-list');
  const trLangSearch = document.getElementById('tr-lang-search');

  if (trLangDropdown && trLangTrigger && trLangMenu) {
    const curLang = state.trLang || 'en';
    if (trLangList) {
      trLangList.innerHTML = '';
      const frag = document.createDocumentFragment();
      TRANSLATION_LANGUAGES.forEach(item => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'm3-dropdown-option';
        btn.dataset.value = item.code;
        const text = `${item.flag} ${item.name} (${item.code})`;
        btn.textContent = text;
        if (item.code === curLang) {
          btn.classList.add('selected');
          if (trLangLabel) trLangLabel.textContent = text;
        }
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          state.trLang = item.code;
          state.lyricsTranslationLang = item.code;
          localStorage.setItem('eclipse_tr_lang', state.trLang);
          if (trLangLabel) trLangLabel.textContent = text;
          trLangMenu.querySelectorAll('.m3-dropdown-option').forEach(o => o.classList.remove('selected'));
          btn.classList.add('selected');
          if (el.selectTrLang) el.selectTrLang.value = item.code;
          trLangDropdown.classList.remove('open');
          if (state.trActive) {
            fetchAndApplyTranslation();
          }
        });
        frag.appendChild(btn);
      });
      trLangList.appendChild(frag);

      if (el.selectTrLang) {
        el.selectTrLang.innerHTML = '';
        TRANSLATION_LANGUAGES.forEach(item => {
          const opt = document.createElement('option');
          opt.value = item.code;
          opt.textContent = `${item.flag} ${item.name} (${item.code})`;
          el.selectTrLang.appendChild(opt);
        });
        el.selectTrLang.value = curLang;
      }
    }

    if (trLangSearch) {
      trLangSearch.addEventListener('click', (e) => e.stopPropagation());
      trLangSearch.addEventListener('input', (e) => {
        const q = e.target.value.toLowerCase().trim();
        if (!trLangList) return;
        trLangList.querySelectorAll('.m3-dropdown-option').forEach(opt => {
          const text = (opt.textContent || '').toLowerCase();
          const code = (opt.dataset.value || '').toLowerCase();
          opt.style.display = (!q || text.includes(q) || code.includes(q)) ? '' : 'none';
        });
      });
      trLangSearch.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          trLangDropdown.classList.remove('open');
        } else if (e.key === 'Enter') {
          e.preventDefault();
          const firstVisible = trLangList ? trLangList.querySelector('.m3-dropdown-option:not([style*="display: none"])') : null;
          if (firstVisible) firstVisible.click();
        }
      });
    }

    trLangTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = trLangDropdown.classList.toggle('open');
      if (isOpen && trLangSearch) {
        trLangSearch.value = '';
        if (trLangList) {
          trLangList.querySelectorAll('.m3-dropdown-option').forEach(opt => opt.style.display = '');
        }
        setTimeout(() => trLangSearch.focus(), 50);
      }
    });

    document.addEventListener('click', () => {
      trLangDropdown.classList.remove('open');
    });
  }

  const uiLangDropdown = document.getElementById('ui-lang-dropdown');
  const uiLangTrigger = document.getElementById('ui-lang-trigger');
  const uiLangLabel = document.getElementById('ui-lang-label');
  const uiLangMenu = document.getElementById('ui-lang-menu');
  const uiLangList = document.getElementById('ui-lang-list');
  const uiLangSearch = document.getElementById('ui-lang-search');

  if (uiLangDropdown && uiLangTrigger && uiLangMenu) {
    const curLang = localStorage.getItem('eclipse_ui_lang') || 'en';
    const foundCur = TRANSLATION_LANGUAGES.find(l => l.code === curLang);
    if (foundCur && uiLangLabel) {
      uiLangLabel.textContent = `${foundCur.flag} ${foundCur.name} (${foundCur.code})`;
    }

    if (uiLangList) {
      uiLangList.innerHTML = '';
      const frag = document.createDocumentFragment();
      TRANSLATION_LANGUAGES.forEach(item => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'm3-dropdown-option';
        btn.dataset.value = item.code;
        const text = `${item.flag} ${item.name} (${item.code})`;
        btn.textContent = text;
        if (item.code === curLang) {
          btn.classList.add('selected');
        }
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const targetCode = item.code;
          const prevLang = localStorage.getItem('eclipse_ui_lang') || localStorage.getItem('eclipse_ui_lang') || 'en';
          
          localStorage.setItem('eclipse_ui_lang', targetCode);
          localStorage.setItem('eclipse_ui_lang', targetCode);
          if (uiLangLabel) uiLangLabel.textContent = text;
          uiLangMenu.querySelectorAll('.m3-dropdown-option').forEach(o => {
            o.classList.toggle('selected', o.dataset.value === targetCode);
          });
          uiLangDropdown.classList.remove('open');
          
          if (window.electronAPI && window.electronAPI.storageSaveSync && window.__RIFF_STORAGE_MAP__) {
            window.__RIFF_STORAGE_MAP__['eclipse_ui_lang'] = targetCode;
            window.__RIFF_STORAGE_MAP__['eclipse_ui_lang'] = targetCode;
            try { window.electronAPI.storageSaveSync(window.__RIFF_STORAGE_MAP__); } catch (_) {}
          }
          
          applyI18n(targetCode);
          if (targetCode !== prevLang) {
            showLangRestartDialog(targetCode);
          }
        });
        frag.appendChild(btn);
      });
      uiLangList.appendChild(frag);
    }

    if (uiLangSearch) {
      uiLangSearch.addEventListener('click', (e) => e.stopPropagation());
      uiLangSearch.addEventListener('input', (e) => {
        const q = e.target.value.toLowerCase().trim();
        if (!uiLangList) return;
        uiLangList.querySelectorAll('.m3-dropdown-option').forEach(opt => {
          const text = (opt.textContent || '').toLowerCase();
          const code = (opt.dataset.value || '').toLowerCase();
          opt.style.display = (!q || text.includes(q) || code.includes(q)) ? '' : 'none';
        });
      });
      uiLangSearch.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          uiLangDropdown.classList.remove('open');
        } else if (e.key === 'Enter') {
          e.preventDefault();
          const firstVisible = uiLangList ? uiLangList.querySelector('.m3-dropdown-option:not([style*="display: none"])') : null;
          if (firstVisible) firstVisible.click();
        }
      });
    }

    uiLangTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = uiLangDropdown.classList.toggle('open');
      if (isOpen && uiLangSearch) {
        uiLangSearch.value = '';
        if (uiLangList) {
          uiLangList.querySelectorAll('.m3-dropdown-option').forEach(opt => opt.style.display = '');
        }
        setTimeout(() => uiLangSearch.focus(), 50);
      }
    });

    document.addEventListener('click', () => {
      uiLangDropdown.classList.remove('open');
    });
  }

  if (el.btnTrAuto) {
    el.btnTrAuto.addEventListener('click', () => {
      state.trAuto = !state.trAuto;
      localStorage.setItem('eclipse_tr_auto', String(state.trAuto));
      updateLyricsTranslationUI();
      if (state.trEnabled && state.trAuto && !state.trActive) {
        state.trActive = true;
        updateLyricsTranslationUI();
        fetchAndApplyTranslation();
      }
    });
  }

  const LANG_RESTART_TEXT = {
    en: {
      title: 'Restart required',
      msg: 'Changes will take effect after restarting the app',
      cancel: 'Cancel',
      restart: 'Restart'
    },
    vi: {
      title: 'Yêu cầu khởi động lại',
      msg: 'Các thay đổi sẽ có hiệu lực sau khi khởi động lại ứng dụng',
      cancel: 'Hủy',
      restart: 'Khởi động lại'
    },
    ja: {
      title: '再起動が必要です',
      msg: '変更はアプリを再起動した後に有効になります',
      cancel: 'キャンセル',
      restart: '再起動'
    },
    ko: {
      title: '재시작 필요',
      msg: '변경 사항은 앱을 다시 시작한 후 적용됩니다',
      cancel: '취소',
      restart: '재시작'
    },
    'zh-CN': {
      title: '需要重启',
      msg: '更改将在重启应用后生效',
      cancel: '取消',
      restart: '重启'
    },
    'zh-TW': {
      title: '需要重啟',
      msg: '變更將在重啟應用後生效',
      cancel: '取消',
      restart: '重啟'
    },
    ru: {
      title: 'Необходимо перезагрузить приложение',
      msg: 'Изменения войдут после перезагрузки приложения',
      cancel: 'Отмена',
      restart: 'Перезагрузить'
    }
  };

  const langRestartModal = document.getElementById('lang-restart-modal');

  function showLangRestartDialog(lang) {
    if (!langRestartModal) return;
    const t = LANG_RESTART_TEXT[lang];
    if (t) {
      const title = langRestartModal.querySelector('h3');
      const msg = document.getElementById('lang-restart-msg');
      const cancel = document.getElementById('btn-lang-restart-cancel');
      const confirm = document.getElementById('btn-lang-restart-confirm');
      if (title) title.textContent = t.title;
      if (msg) msg.textContent = t.msg;
      if (cancel) cancel.textContent = t.cancel;
      if (confirm) confirm.textContent = t.restart;
    }
    openModal(langRestartModal);
  }

  const btnCancelLangRestart = document.getElementById('btn-lang-restart-cancel');
  const btnConfirmLangRestart = document.getElementById('btn-lang-restart-confirm');

  if (btnCancelLangRestart) {
    btnCancelLangRestart.addEventListener('click', () => closeModal(langRestartModal));
  }

  if (btnConfirmLangRestart) {
    btnConfirmLangRestart.addEventListener('click', () => {
      const cur = localStorage.getItem('eclipse_ui_lang') || localStorage.getItem('eclipse_ui_lang') || 'en';
      if (window.electronAPI && window.electronAPI.storageSaveSync && window.__RIFF_STORAGE_MAP__) {
        window.__RIFF_STORAGE_MAP__['eclipse_ui_lang'] = cur;
        window.__RIFF_STORAGE_MAP__['eclipse_ui_lang'] = cur;
        try { window.electronAPI.storageSaveSync(window.__RIFF_STORAGE_MAP__); } catch (_) {}
      }
      if (window.electronAPI && window.electronAPI.restartApp) {
        window.electronAPI.restartApp();
      } else {
        window.location.reload();
      }
    });
  }

  const lyricsEaseDropdown = document.getElementById('lyrics-ease-dropdown');
  const lyricsEaseTrigger = document.getElementById('lyrics-ease-trigger');
  const lyricsEaseLabel = document.getElementById('lyrics-ease-label');
  const lyricsEaseMenu = document.getElementById('lyrics-ease-menu');

  if (lyricsEaseDropdown && lyricsEaseTrigger && lyricsEaseMenu) {
    const curEase = getLyricsEase();
    lyricsEaseMenu.querySelectorAll('.m3-dropdown-option').forEach(opt => {
      const isSel = opt.dataset.value === curEase;
      opt.classList.toggle('selected', isSel);
      if (isSel && lyricsEaseLabel) lyricsEaseLabel.textContent = opt.textContent;
    });

    lyricsEaseTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      lyricsEaseDropdown.classList.toggle('open');
    });

    lyricsEaseMenu.querySelectorAll('.m3-dropdown-option').forEach(opt => {
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        const val = opt.dataset.value;
        localStorage.setItem('eclipse_lyrics_ease', val);
        if (lyricsEaseLabel) lyricsEaseLabel.textContent = opt.textContent;
        lyricsEaseMenu.querySelectorAll('.m3-dropdown-option').forEach(o => o.classList.toggle('selected', o === opt));
        applyLyricsEase();
        lyricsEaseDropdown.classList.remove('open');
      });
    });

    document.addEventListener('click', () => {
      lyricsEaseDropdown.classList.remove('open');
    });
  }

  const sliderLyricsSpeed = document.getElementById('slider-lyrics-speed');
  const valLyricsSpeed = document.getElementById('val-lyrics-speed');
  if (sliderLyricsSpeed && valLyricsSpeed) {
    const currentSpeed = getLyricsSpeed();
    sliderLyricsSpeed.value = Math.round(currentSpeed * 10);
    valLyricsSpeed.textContent = `${currentSpeed.toFixed(1)}x`;

    sliderLyricsSpeed.addEventListener('input', () => {
      const val = parseInt(sliderLyricsSpeed.value, 10) / 10;
      valLyricsSpeed.textContent = `${val.toFixed(1)}x`;
      localStorage.setItem('eclipse_lyrics_speed', val.toString());
      applyLyricsEase();
    });
  }

  const lyricsSourceDropdown = document.getElementById('lyrics-source-dropdown');
  const lyricsSourceTrigger = document.getElementById('lyrics-source-trigger');
  const lyricsSourceLabel = document.getElementById('lyrics-source-label');
  const lyricsSourceMenu = document.getElementById('lyrics-source-menu');

  const VALID_LYRICS_SOURCES = ['auto', 'nhaccuatui', 'zingmp3', 'synclrc', 'lrclib', 'musixmatch', 'kugou', 'netease', 'youtube', 'genius'];
  const LYRICS_SOURCE_NAMES = { auto: 'Auto', custom: 'Custom', plain: 'Genius', nhaccuatui: 'NhacCuaTui', zingmp3: 'Zing MP3', synclrc: 'SyncLRC', lrclib: 'LRCLIB', musixmatch: 'Musixmatch', kugou: 'Kugou', netease: 'NetEase', youtube: 'YouTube', genius: 'Genius' };

  function getTrackLyricsOffsetSec() {
    if (!state.currentTrack) return 0;
    const key = state.currentTrack.id || `${state.currentTrack.artist || ''}:${state.currentTrack.title || ''}`;
    try {
      const map = JSON.parse(localStorage.getItem('eclipse_lyrics_offsets') || '{}');
      return Number(map[key]) || 0;
    } catch (_) { return 0; }
  }

  function setTrackLyricsOffsetSec(sec) {
    if (!state.currentTrack) return;
    const key = state.currentTrack.id || `${state.currentTrack.artist || ''}:${state.currentTrack.title || ''}`;
    const rounded = Math.round(sec * 10) / 10;
    try {
      const map = JSON.parse(localStorage.getItem('eclipse_lyrics_offsets') || '{}');
      const prev = Number(map[key]) || 0;
      const delta = rounded - prev;
      if (rounded === 0) delete map[key];
      else map[key] = rounded;
      localStorage.setItem('eclipse_lyrics_offsets', JSON.stringify(map));
      if (delta !== 0 && Array.isArray(state.syncedLyrics)) {
        state.syncedLyrics.forEach(l => {
          if (l.time != null && l.time >= 0) l.time = Math.max(0, l.time + delta);
          if (Array.isArray(l.words)) {
            l.words.forEach(w => {
              if (w.start != null) w.start = Math.max(0, w.start + delta);
              if (w.end != null) w.end = Math.max(0, w.end + delta);
            });
          }
        });
        state.lastActiveLyricIdx = -1;
        state.forceLyricsScroll = true;
        renderLyricsView();
      }
    } catch (_) {}
    syncLyricsOffsetUI();
  }

  function syncLyricsOffsetUI(providerName) {
    const off = getTrackLyricsOffsetSec();
    const sign = off > 0 ? '+' : '';
    const formatted = `${sign}${off.toFixed(1)}s`;

    const badge = document.getElementById('lyrics-offset-badge');
    if (badge) {
      badge.textContent = formatted;
      badge.style.color = off !== 0 ? 'var(--md-sys-color-primary, #60a5fa)' : 'inherit';
    }

    const tvkBadge = document.getElementById('btn-tvk-offset-badge');
    if (tvkBadge) {
      tvkBadge.textContent = formatted;
      tvkBadge.style.color = off !== 0 ? 'var(--md-sys-color-primary, #a78bfa)' : 'inherit';
    }

    const tvkOffsetCtrl = document.getElementById('tvk-offset-control');
    if (tvkOffsetCtrl) {
      const hasLyrics = state.syncedLyrics && state.syncedLyrics.length > 0;
      tvkOffsetCtrl.classList.toggle('hidden', !hasLyrics);
    }
    const pill = document.getElementById('lyrics-provider-pill');
    if (pill) {
      const prov = providerName || localStorage.getItem('eclipse_lyrics_source') || 'auto';
      pill.textContent = LYRICS_SOURCE_NAMES[prov] || prov.toUpperCase();
    }
  }

  const btnOffsetMinus = document.getElementById('btn-lyrics-offset-minus');
  if (btnOffsetMinus) {
    btnOffsetMinus.addEventListener('click', (e) => {
      e.stopPropagation();
      setTrackLyricsOffsetSec(getTrackLyricsOffsetSec() - 0.2);
    });
  }
  const btnOffsetPlus = document.getElementById('btn-lyrics-offset-plus');
  if (btnOffsetPlus) {
    btnOffsetPlus.addEventListener('click', (e) => {
      e.stopPropagation();
      setTrackLyricsOffsetSec(getTrackLyricsOffsetSec() + 0.2);
    });
  }
  const btnOffsetBadge = document.getElementById('lyrics-offset-badge');
  if (btnOffsetBadge) {
    btnOffsetBadge.addEventListener('click', (e) => {
      e.stopPropagation();
      setTrackLyricsOffsetSec(0);
    });
  }

  const btnCycleSource = document.getElementById('btn-cycle-lyrics-source');
  if (btnCycleSource) {
    btnCycleSource.addEventListener('click', (e) => {
      e.stopPropagation();
      const cur = localStorage.getItem('eclipse_lyrics_source') || 'auto';
      const idx = VALID_LYRICS_SOURCES.indexOf(cur);
      const next = VALID_LYRICS_SOURCES[(idx + 1) % VALID_LYRICS_SOURCES.length];
      localStorage.setItem('eclipse_lyrics_source', next);
      if (lyricsSourceLabel) lyricsSourceLabel.textContent = LYRICS_SOURCE_NAMES[next] || next;
      if (lyricsSourceMenu) {
        lyricsSourceMenu.querySelectorAll('.m3-dropdown-option').forEach(o => o.classList.toggle('selected', o.dataset.value === next));
      }
      lyricsSessionCache.clear(); lyricsTranslationCache.clear();
      syncLyricsOffsetUI(next);
      if (state.currentTrack) {
        loadSyncedLyrics(state.currentTrack.title, state.currentTrack.artist, state.loadToken);
      }
    });
  }

  if (lyricsSourceDropdown && lyricsSourceTrigger && lyricsSourceMenu) {
    const curSource = localStorage.getItem('eclipse_lyrics_source') || 'auto';
    lyricsSourceMenu.querySelectorAll('.m3-dropdown-option').forEach(opt => {
      const isSel = opt.dataset.value === curSource;
      opt.classList.toggle('selected', isSel);
      if (isSel && lyricsSourceLabel) lyricsSourceLabel.textContent = opt.textContent;
    });

    lyricsSourceTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      lyricsSourceDropdown.classList.toggle('open');
    });

    lyricsSourceMenu.querySelectorAll('.m3-dropdown-option').forEach(opt => {
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        const val = opt.dataset.value;
        localStorage.setItem('eclipse_lyrics_source', val);
        if (lyricsSourceLabel) lyricsSourceLabel.textContent = opt.textContent;
        lyricsSourceMenu.querySelectorAll('.m3-dropdown-option').forEach(o => o.classList.toggle('selected', o === opt));
        lyricsSourceDropdown.classList.remove('open');
        lyricsSessionCache.clear(); lyricsTranslationCache.clear();
        syncLyricsOffsetUI(val);
        if (state.currentTrack) {
          loadSyncedLyrics(state.currentTrack.title, state.currentTrack.artist, state.loadToken);
        }
      });
    });

    document.addEventListener('click', () => {
      lyricsSourceDropdown.classList.remove('open');
    });
  }

  const wordSourceDropdown = document.getElementById('word-source-dropdown');
  const wordSourceTrigger = document.getElementById('word-source-trigger');
  const wordSourceLabel = document.getElementById('word-source-label');
  const wordSourceMenu = document.getElementById('word-source-menu');

  if (wordSourceDropdown && wordSourceTrigger && wordSourceMenu) {
    const curWordSource = localStorage.getItem('eclipse_word_source') || 'auto';
    wordSourceMenu.querySelectorAll('.m3-dropdown-option').forEach(opt => {
      const isSel = opt.dataset.value === curWordSource;
      opt.classList.toggle('selected', isSel);
      if (isSel && wordSourceLabel) wordSourceLabel.textContent = opt.textContent;
    });

    wordSourceTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      wordSourceDropdown.classList.toggle('open');
    });

    wordSourceMenu.querySelectorAll('.m3-dropdown-option').forEach(opt => {
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        const val = opt.dataset.value;
        localStorage.setItem('eclipse_word_source', val);
        if (wordSourceLabel) wordSourceLabel.textContent = opt.textContent;
        wordSourceMenu.querySelectorAll('.m3-dropdown-option').forEach(o => o.classList.toggle('selected', o === opt));
        wordSourceDropdown.classList.remove('open');
        wordsSessionCache.clear();
        if (state.currentTrack) {
          loadSyncedLyrics(state.currentTrack.title, state.currentTrack.artist, state.loadToken);
        }
      });
    });

    document.addEventListener('click', () => {
      wordSourceDropdown.classList.remove('open');
    });
  }

  const lyricsWordStyleDropdown = document.getElementById('lyrics-wordstyle-dropdown');
  const lyricsWordStyleTrigger = document.getElementById('lyrics-wordstyle-trigger');
  const lyricsWordStyleLabel = document.getElementById('lyrics-wordstyle-label');
  const lyricsWordStyleMenu = document.getElementById('lyrics-wordstyle-menu');

  if (lyricsWordStyleDropdown && lyricsWordStyleTrigger && lyricsWordStyleMenu) {
    const curStyle = getLyricsWordStyle();
    lyricsWordStyleMenu.querySelectorAll('.m3-dropdown-option').forEach(opt => {
      const isSel = opt.dataset.value === curStyle;
      opt.classList.toggle('selected', isSel);
      if (isSel && lyricsWordStyleLabel) lyricsWordStyleLabel.textContent = opt.textContent;
    });

    lyricsWordStyleTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      lyricsWordStyleDropdown.classList.toggle('open');
    });

    lyricsWordStyleMenu.querySelectorAll('.m3-dropdown-option').forEach(opt => {
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        const val = opt.dataset.value;
        localStorage.setItem('eclipse_lyrics_word_style', val);
        if (lyricsWordStyleLabel) lyricsWordStyleLabel.textContent = opt.textContent;
        lyricsWordStyleMenu.querySelectorAll('.m3-dropdown-option').forEach(o => o.classList.toggle('selected', o === opt));
        lyricsWordStyleDropdown.classList.remove('open');
        renderLyricsView();
        if (el.nativeAudio) updateSyncedLyricsHighlight(el.nativeAudio.currentTime || 0);
      });
    });

    document.addEventListener('click', () => {
      lyricsWordStyleDropdown.classList.remove('open');
    });
  }

  const sliderLyricsTightness = document.getElementById('slider-lyrics-tightness');
  const valLyricsTightness = document.getElementById('val-lyrics-tightness');
  if (sliderLyricsTightness && valLyricsTightness) {
    const currentTightness = getLyricsGradientTightness();
    sliderLyricsTightness.value = currentTightness;
    valLyricsTightness.textContent = `${currentTightness}%`;

    sliderLyricsTightness.addEventListener('input', () => {
      const val = parseInt(sliderLyricsTightness.value, 10);
      valLyricsTightness.textContent = `${val}%`;
      localStorage.setItem('eclipse_lyrics_gradient_tightness', val.toString());
      localStorage.setItem('eclipse_gradient_tight', val.toString());
      applyLyricsGradientTightness();
      updateActiveGradient();
    });
  }

  const btnResetAudio = el.btnResetAudio || document.getElementById('btn-reset-audio');
  if (btnResetAudio) {
    btnResetAudio.addEventListener('click', () => {
      state.activePresetId = 'p_default';
      state.audioSettings = { speed: 1.0, speedPitch: 1.0, pitch: 0, reverb: 0, distortion: 0, volume: 1.0, echo: 0, eq: { low: 0, mid: 0, high: 0 }, eqBands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] };
      state.hqSettings = { engine: 'hqmusic-3', preset: 'studio', vocal: 0, air: 0, bass: 0 };
      state.hqEnabled = false;

      localStorage.setItem('eclipse_hq_enabled', '0');
      updateHqRouting();
      localStorage.setItem('eclipse_audio_normalize', '0');
      const toggleNorm = document.getElementById('toggle-normalize');
      if (toggleNorm) toggleNorm.classList.remove('active');
      if (typeof resetLevelWatcher === 'function') resetLevelWatcher();
      if (audioEngine && typeof audioEngine.setNormalizeGainDb === 'function') {
        audioEngine.setNormalizeGainDb(0);
      }
      document.querySelectorAll('#audio-settings-modal .effect-switch-btn').forEach(btn => btn.classList.remove('active'));

      syncSettingsSlidersToState();

      document.querySelectorAll('#audio-settings-modal input[type="range"]').forEach(input => {
        const wrap = input.closest('.sl');
        if (wrap) {
          const min = input.min === '' ? 0 : parseFloat(input.min);
          const max = input.max === '' ? 100 : parseFloat(input.max);
          const rawRatio = max > min ? (parseFloat(input.value) - min) / (max - min) : 0;
          wrap.style.setProperty('--v', rawRatio);
        }
      });

      applyAudioSettings();
      applyHqSettings();
      renderPresets();
      showToast('Audio settings reset');
    });
  }

  const toggleNormalize = document.getElementById('toggle-normalize');
  if (toggleNormalize) {
    const isNorm = localStorage.getItem('eclipse_audio_normalize') === '1';
    toggleNormalize.classList.toggle('active', isNorm);
    toggleNormalize.addEventListener('click', () => {
      const active = !toggleNormalize.classList.contains('active');
      toggleNormalize.classList.toggle('active', active);
      localStorage.setItem('eclipse_audio_normalize', active ? '1' : '0');
      if (!active) resetLevelWatcher();
    });
  }

  (function initSpatial8dControls() {
    const toggleBtn = document.getElementById('toggle-spatial-8d');
    const speedSlider = document.getElementById('slider-spatial-8d-speed');
    const speedVal = document.getElementById('val-spatial-8d-speed');
    const controlsWrap = document.getElementById('spatial-8d-controls');
    const dirBtns = document.querySelectorAll('#spatial-8d-dir-group [data-spatial-dir]');
    if (!toggleBtn) return;

    const loadSpatial8d = () => {
      try {
        const parsed = JSON.parse(localStorage.getItem('eclipse_spatial_8d') || 'null');
        if (parsed && typeof parsed === 'object') {
          return {
            enabled: !!parsed.enabled,
            cycleSec: Math.min(24, Math.max(4, Number(parsed.cycleSec) || 10)),
            direction: parsed.direction === 'ccw' ? 'ccw' : 'cw'
          };
        }
      } catch (_) {}
      return { enabled: false, cycleSec: 10, direction: 'cw' };
    };

    let cfg = loadSpatial8d();

    const applySpatial8d = (persist = true) => {
      toggleBtn.classList.toggle('active', cfg.enabled);
      if (controlsWrap) controlsWrap.classList.toggle('disabled', !cfg.enabled);
      if (speedSlider) speedSlider.value = String(cfg.cycleSec);
      if (speedVal) speedVal.textContent = `${cfg.cycleSec}s`;
      dirBtns.forEach(b => b.classList.toggle('active', b.dataset.spatialDir === cfg.direction));
      if (persist) {
        try { localStorage.setItem('eclipse_spatial_8d', JSON.stringify(cfg)); } catch (_) {}
      }
      const engine = window.audioEngine || (typeof audioEngine !== 'undefined' ? audioEngine : null);
      if (engine && typeof engine.setSpatial8d === 'function') {
        try { engine.setSpatial8d({ enabled: cfg.enabled, cycleSec: cfg.cycleSec, direction: cfg.direction }); } catch (err) { console.warn('[spatial8d]', err); }
      }
    };

    toggleBtn.addEventListener('click', () => {
      cfg.enabled = !cfg.enabled;
      applySpatial8d(true);
    });
    if (speedSlider) {
      speedSlider.addEventListener('input', () => {
        cfg.cycleSec = Math.min(24, Math.max(4, parseInt(speedSlider.value, 10) || 10));
        applySpatial8d(true);
      });
    }
    dirBtns.forEach(b => {
      b.addEventListener('click', () => {
        cfg.direction = b.dataset.spatialDir === 'ccw' ? 'ccw' : 'cw';
        applySpatial8d(true);
      });
    });

    applySpatial8d(false);
  })();

  (function initUpdateUI() {
    const api = window.electronAPI;
    const $ = (id) => document.getElementById(id);
    let currentAppVersion = '1.3.1';
    if (api && api.getAppVersion) {
      api.getAppVersion().then((v) => {
        if (v) {
          currentAppVersion = v;
          const a = $('about-version'); if (a) a.textContent = 'Version ' + v;
          const t = document.querySelector('.settings-version-tag'); if (t) t.textContent = 'v' + v;
        }
      }).catch(() => {});
    } else {
      const a = $('about-version');
      if (a && a.textContent) {
        const match = a.textContent.match(/[\d.]+/);
        if (match) currentAppVersion = match[0];
      }
    }

    const btn = $('btn-check-updates');
    const originalBtnHtml = btn ? btn.innerHTML : 'Check for updates';
    let manualUpdateCheck = false;
    let checkTimeoutId = null;
    let fallbackReleaseUrl = 'https://github.com/valzevox/Eclipse-music/releases/latest';
    let canNativeInstall = false;

    let latestUpdateInfo = null;
    let isUpdateDownloaded = false;
    let isWaitingToRestart = false;

    function formatRelativeReleaseTime(isoDateStr) {
      if (!isoDateStr) return 'New release';
      const ts = Date.parse(isoDateStr);
      if (!Number.isFinite(ts)) return 'New release';
      const diffSec = Math.max(60, Math.floor((Date.now() - ts) / 1000));
      if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
      if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
      if (diffSec < 2592000) return `${Math.floor(diffSec / 86400)}d ago`;
      return `${Math.floor(diffSec / 2592000)}mo ago`;
    }

    function parseGithubReleaseBodyAndBanner(rawNotes) {
      let text = String(rawNotes || '');
      let bannerUrl = '';
      const htmlImgMatch = text.match(/<img[^>]+src=["'](https?:\/\/[^"']+)["'][^>]*>/i);
      if (htmlImgMatch && htmlImgMatch[1]) {
        bannerUrl = htmlImgMatch[1].trim();
        text = text.replace(/<img[^>]*>/gi, '');
      } else {
        const mdImgMatch = text.match(/!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/i);
        if (mdImgMatch && mdImgMatch[1]) {
          bannerUrl = mdImgMatch[1].trim();
          text = text.replace(/!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/gi, '');
        }
      }
      text = text
        .replace(/<\/?(?:p|div|br|h[1-6]|ul|ol|li|strong|em|b|i|code|pre|blockquote|hr)[^>]*>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/^#{1,6}\s+.*$/gm, (m) => m.replace(/^#{1,6}\s+/, ''))
        .replace(/^\s*[-*•]\s+/gm, '• ')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      return { cleanText: text, bannerUrl };
    }

    function populateOtaUpdateSheet(info) {
      const modal = document.getElementById('update-modal');
      const sheet = document.getElementById('update-sheet-card');
      const spinnerBox = document.getElementById('update-center-spinner');
      const timeEl = document.getElementById('update-release-time');
      const verEl = document.getElementById('update-version-badge');
      const notesEl = document.getElementById('update-notes');
      const bannerWrap = document.getElementById('update-banner-wrap');
      const bannerImg = document.getElementById('update-banner-img');
      const bodyGrid = document.getElementById('update-body-grid');
      if (!modal || !sheet || !notesEl) return;

      const rawVer = String(info?.version || '').replace(/^v/i, '');
      const ignoredVer = localStorage.getItem('eclipse_ignored_update_ver') || '';
      if (!manualUpdateCheck && rawVer && ignoredVer === rawVer) return;

      const displayVer = rawVer.endsWith('.0.0') ? ('v' + rawVer.slice(0, -4)) : (rawVer.endsWith('.0') ? ('v' + rawVer.slice(0, -2)) : ('v' + rawVer));
      if (verEl) verEl.textContent = displayVer || 'v43.1';
      if (timeEl) timeEl.textContent = formatRelativeReleaseTime(info?.publishedAt || info?.releaseDate || '');

      const { cleanText, bannerUrl } = parseGithubReleaseBodyAndBanner(info?.releaseNotes || '');
      notesEl.innerHTML = '';
      const paragraphs = (cleanText || 'Bug fixes, playback improvements, and UI polish.').split(/\n+/).map(s => s.trim()).filter(Boolean);
      paragraphs.forEach((line) => {
        const p = document.createElement('p');
        p.textContent = line;
        notesEl.appendChild(p);
      });

      if (bannerUrl && bannerWrap && bannerImg) {
        bannerImg.src = bannerUrl;
        bannerWrap.classList.remove('hidden');
        if (bodyGrid) bodyGrid.classList.remove('no-banner');
        bannerImg.onerror = () => {
          bannerWrap.classList.add('hidden');
          if (bodyGrid) bodyGrid.classList.add('no-banner');
        };
      } else {
        if (bannerWrap) bannerWrap.classList.add('hidden');
        if (bodyGrid) bodyGrid.classList.add('no-banner');
      }

      sheet.classList.remove('leaving');
      if (spinnerBox) spinnerBox.classList.add('hidden');
      modal.classList.remove('hidden');
    }

    function restoreButton() {
      manualUpdateCheck = false;
      if (checkTimeoutId) {
        clearTimeout(checkTimeoutId);
        checkTimeoutId = null;
      }
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = originalBtnHtml;
      }
    }

    function isNewerVersion(latest, current) {
      const p1 = String(latest || '').split('.').map(n => parseInt(n, 10) || 0);
      const p2 = String(current || '').split('.').map(n => parseInt(n, 10) || 0);
      for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
        const a = p1[i] || 0;
        const b = p2[i] || 0;
        if (a > b) return true;
        if (a < b) return false;
      }
      return false;
    }

    async function checkDirectFromRenderer() {
      try {
        if (!navigator.onLine) {
          restoreButton();
          showToast('Could not check for updates', 'error');
          return;
        }
        const res = await fetch('https://api.github.com/repos/valzevox/Eclipse-music/releases/latest', {
          headers: { 'User-Agent': 'Eclipse-Player' }
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const json = await res.json();
        const latestVersion = (json.tag_name || '').replace(/^v/i, '');
        fallbackReleaseUrl = json.html_url || 'https://github.com/valzevox/Eclipse-music/releases/latest';
        if (isNewerVersion(latestVersion, currentAppVersion)) {
          latestUpdateInfo = {
            version: latestVersion,
            releaseNotes: json.body || '',
            publishedAt: json.published_at || '',
            htmlUrl: fallbackReleaseUrl,
            canInstall: false
          };
          populateOtaUpdateSheet(latestUpdateInfo);
          restoreButton();
        } else {
          restoreButton();
          showToast('You are using the latest version of Eclipse!', 'success');
        }
      } catch (err) {
        restoreButton();
        showToast('Could not check for updates', 'error');
      }
    }

    if (btn) {
      btn.addEventListener('click', async () => {
        if (manualUpdateCheck) return;
        manualUpdateCheck = true;
        btn.disabled = true;
        btn.innerHTML = `<svg class="g-spinner" style="width:14px;height:14px;margin-right:6px;" viewBox="0 0 48 48"><circle cx="24" cy="24" r="20"/></svg><span>Checking...</span>`;

        if (!api || !api.checkForUpdates) {
          checkDirectFromRenderer();
          return;
        }

        checkTimeoutId = setTimeout(() => {
          if (manualUpdateCheck) {
            checkDirectFromRenderer();
          }
        }, 15000);

        try {
          const r = await api.checkForUpdates();
          if (r && r.ok === false) {
            if (checkTimeoutId) clearTimeout(checkTimeoutId);
            checkDirectFromRenderer();
          }
        } catch (_) {
          if (checkTimeoutId) clearTimeout(checkTimeoutId);
          checkDirectFromRenderer();
        }
      });
    }

    if (api && api.onUpdateAvailable) {
      api.onUpdateAvailable(async (info) => {
        restoreButton();
        latestUpdateInfo = { ...(info || {}) };
        canNativeInstall = !!info?.canInstall;

        const hasImg = latestUpdateInfo.releaseNotes && /<img/i.test(latestUpdateInfo.releaseNotes);
        const hasPublishedAt = !!latestUpdateInfo.publishedAt;

        if (!hasImg || !hasPublishedAt) {
          try {
            const res = await fetch('https://api.github.com/repos/valzevox/Eclipse-music/releases/latest', {
              headers: { 'User-Agent': 'Eclipse-Player' }
            });
            if (res.ok) {
              const gh = await res.json();
              if (gh.body) latestUpdateInfo.releaseNotes = gh.body;
              if (gh.published_at) latestUpdateInfo.publishedAt = gh.published_at;
              if (gh.html_url) latestUpdateInfo.htmlUrl = gh.html_url;
              if (gh.tag_name && !latestUpdateInfo.version) latestUpdateInfo.version = gh.tag_name;
            }
          } catch (_) {}
        }

        populateOtaUpdateSheet(latestUpdateInfo);
      });
    }

    const onDownloaded = (info) => {
      isUpdateDownloaded = true;
      if (info && !latestUpdateInfo) {
        latestUpdateInfo = { ...info };
      }
      if (isWaitingToRestart) {
        setTimeout(async () => {
          if (window.electronAPI && window.electronAPI.installUpdateNow) {
            try {
              await window.electronAPI.installUpdateNow();
            } catch (err) {
              isWaitingToRestart = false;
              restoreButton();
              showToast(err?.message || 'Failed to launch installer', 'error');
            }
          } else if (window.electronAPI && window.electronAPI.updateAction) {
            window.electronAPI.updateAction('now');
          }
        }, 600);
      } else {
        const modal = document.getElementById('update-modal');
        if (modal && modal.classList.contains('hidden')) {
          populateOtaUpdateSheet(latestUpdateInfo || info);
        }
      }
    };

    if (api && api.onUpdateDownloaded) {
      api.onUpdateDownloaded(onDownloaded);
    }
    if (api && api.onUpdateReady) {
      api.onUpdateReady(onDownloaded);
    }

    if (api && api.onUpdateNotAvailable) {
      api.onUpdateNotAvailable(() => {
        const wasManual = manualUpdateCheck;
        restoreButton();
        if (wasManual) {
          showToast('You are using the latest version of Eclipse!', 'success');
        }
      });
    }

    if (api && api.onUpdateError) {
      api.onUpdateError((err) => {
        const wasManual = manualUpdateCheck;
        restoreButton();
        if (isWaitingToRestart) {
          isWaitingToRestart = false;
          showToast(err?.message || 'Update installation failed', 'error');
        } else if (wasManual) {
          showToast(err?.message || 'Could not check for updates', 'error');
        }
      });
    }

    if (api && api.onUpdateProgress) {
      api.onUpdateProgress((d) => {
        const pct = Math.min(100, Math.max(0, Math.round(d?.percent || 0)));
        const wrap = document.getElementById('update-progress-wrap');
        const fill = document.getElementById('update-progress-fill');
        const label = document.getElementById('update-progress-label');
        const spinnerLabel = document.getElementById('update-spinner-label');
        if (wrap) wrap.classList.remove('hidden');
        if (fill) fill.style.width = pct + '%';
        if (label) label.textContent = pct + '%';
        if (spinnerLabel) {
          spinnerLabel.textContent = pct >= 100 ? 'Installing & restarting Eclipse...' : `Downloading update (${pct}%)...`;
        }
      });
    }

    const btnUpdateNow = document.getElementById('btn-update-now');
    if (btnUpdateNow) {
      btnUpdateNow.addEventListener('click', async () => {
        const sheet = document.getElementById('update-sheet-card');
        const spinnerBox = document.getElementById('update-center-spinner');
        const spinnerLabel = document.getElementById('update-spinner-label');
        const wrap = document.getElementById('update-progress-wrap');
        if (sheet) sheet.classList.add('leaving');
        if (spinnerBox) spinnerBox.classList.remove('hidden');
        if (spinnerLabel) spinnerLabel.textContent = 'Preparing update...';
        if (wrap) wrap.classList.remove('hidden');

        if (window.electronAPI && window.electronAPI.installUpdateNow) {
          try {
            await window.electronAPI.installUpdateNow();
          } catch (err) {
            if (sheet) sheet.classList.remove('leaving');
            if (spinnerBox) spinnerBox.classList.add('hidden');
            showToast(err?.message || 'Failed to launch installer', 'error');
          }
        } else if (window.electronAPI && window.electronAPI.updateAction) {
          window.electronAPI.updateAction('now');
        }
      });
    }

    const btnUpdateLater = document.getElementById('btn-update-later');
    if (btnUpdateLater) {
      btnUpdateLater.addEventListener('click', () => {
        if (latestUpdateInfo?.version) {
          localStorage.setItem('eclipse_ignored_update_ver', String(latestUpdateInfo.version).replace(/^v/i, ''));
        }
        if (api && api.updateAction) {
          api.updateAction('ignore');
        }
        const sheet = document.getElementById('update-sheet-card');
        const modal = document.getElementById('update-modal');
        if (sheet) sheet.classList.add('leaving');
        setTimeout(() => {
          if (modal) modal.classList.add('hidden');
        }, 260);
      });
    }
  })();

  function isTextInput(target) {
    if (!target) return false;
    const tag = (target.tagName || '').toUpperCase();
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!target.isContentEditable;
  }

  function adjustVolume(delta) {
    state.volume = Math.max(0, Math.min(1, Math.round((state.volume + delta) * 100) / 100));
    state.isMuted = false;
    if (el.volumeSlider) el.volumeSlider.value = state.volume;
    if (el.volumeIcon) el.volumeIcon.classList.remove('hidden');
    if (el.volumeMutedIcon) el.volumeMutedIcon.classList.add('hidden');
    persistVolumeState();
    applyAudioSettings();
  }

  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space' && !isTextInput(e.target)) {
      e.preventDefault();
    }
  }, true);

  window.addEventListener('keydown', (e) => {
    const inInput = isTextInput(e.target);

    if (e.code === 'Escape' || e.key === 'Escape') {
      if (syncState && syncState.active) {
        e.preventDefault();
        closeSyncMode();
        return;
      }
      const openModals = Array.from(document.querySelectorAll('.modal-backdrop:not(.hidden)'));
      if (openModals.length > 0) {
        const topModal = openModals[openModals.length - 1];
        if (topModal.id === 'tools-install-modal' && (!state || !state.toolsReady)) {
          e.preventDefault();
          return;
        }
        e.preventDefault();
        closeModal(topModal);
        return;
      }
      const tvkPanel = document.getElementById('tvk-panel');
      if (state.isTvKaraokeOpen && tvkPanel && tvkPanel.classList.contains('open')) {
        e.preventDefault();
        tvkPanel.classList.remove('open');
        const btnSettings = document.getElementById('btn-tvk-settings');
        if (btnSettings) btnSettings.classList.remove('open');
        resetTvIdleTimer();
        return;
      }
      if (state.isTvKaraokeOpen && typeof closeTvKaraoke === 'function') {
        e.preventDefault();
        closeTvKaraoke();
        return;
      }
      if (inInput) {
        e.preventDefault();
        e.target.blur();
        return;
      }
      if (state.currentView === 'album') {
        e.preventDefault();
        const target = (state.previousView && state.previousView !== 'album') ? state.previousView : 'discover';
        switchView(target);
        return;
      }
      if (state.currentView === 'artist') {
        e.preventDefault();
        const target = (state.previousView && state.previousView !== 'artist') ? state.previousView : 'discover';
        switchView(target);
        return;
      }
      return;
    }

    if (inInput) {
      if ((e.code === 'ArrowLeft' || e.code === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') && (e.ctrlKey || e.metaKey || e.shiftKey)) {
        return;
      }
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        return;
      }
    }

    if (e.code === 'Space') {
      e.preventDefault();
      if (syncState && syncState.active && syncState.currentIndex < syncState.lines.length) {
        handleSyncLineClick(syncState.currentIndex);
      } else {
        togglePlayPause();
      }
      return;
    }

    if ((e.code === 'KeyK' && (e.ctrlKey || e.metaKey)) || (!inInput && (e.code === 'Slash' || e.key === '/'))) {
      e.preventDefault();
      if (el.searchInput) {
        el.searchInput.focus();
        el.searchInput.select();
      }
      return;
    }

    if ((e.ctrlKey || e.metaKey) && !e.shiftKey) {
      if (e.code === 'ArrowRight' || e.key === 'ArrowRight') {
        e.preventDefault();
        playNext();
        return;
      }
      if (e.code === 'ArrowLeft' || e.key === 'ArrowLeft') {
        e.preventDefault();
        playPrev();
        return;
      }
      if (e.code === 'ArrowUp' || e.key === 'ArrowUp') {
        e.preventDefault();
        adjustVolume(0.05);
        return;
      }
      if (e.code === 'ArrowDown' || e.key === 'ArrowDown') {
        e.preventDefault();
        adjustVolume(-0.05);
        return;
      }
    }

    if (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (e.code === 'ArrowRight' || e.key === 'ArrowRight') {
        e.preventDefault();
        if (el.nativeAudio) el.nativeAudio.currentTime = Math.min(el.nativeAudio.duration || 0, el.nativeAudio.currentTime + 5);
        return;
      }
      if (e.code === 'ArrowLeft' || e.key === 'ArrowLeft') {
        e.preventDefault();
        if (el.nativeAudio) el.nativeAudio.currentTime = Math.max(0, el.nativeAudio.currentTime - 5);
        return;
      }
    }

    if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      if (e.code === 'KeyM') {
        e.preventDefault();
        if (el.btnVolumeMute) el.btnVolumeMute.click();
        return;
      }
      if (e.code === 'KeyH') {
        e.preventDefault();
        if (typeof window.toggleShuffle === 'function') window.toggleShuffle();
        return;
      }
      if (e.code === 'KeyR') {
        e.preventDefault();
        if (typeof window.toggleRepeat === 'function') window.toggleRepeat();
        return;
      }
      if (e.code === 'KeyL') {
        e.preventDefault();
        if (el.btnToggleLyricsPanel) el.btnToggleLyricsPanel.click();
        return;
      }
      if (e.code === 'KeyF') {
        e.preventDefault();
        if (typeof openTvKaraoke === 'function') openTvKaraoke();
        return;
      }
      if (e.code === 'KeyZ') {
        if (state.isTvKaraokeOpen && typeof toggleTvkZenMode === 'function') {
          e.preventDefault();
          toggleTvkZenMode();
          return;
        }
      }
      if (e.code === 'KeyP') {
        e.preventDefault();
        if (typeof toggleMiniWindow === 'function') toggleMiniWindow();
        return;
      }
    }
  }, true);

  const btnDiscordRpc = document.getElementById('btn-discord-rpc');
  const badgeDiscordRpc = document.getElementById('badge-discord-rpc');

  function syncDiscordRpcUI() {
    if (btnDiscordRpc) {
      btnDiscordRpc.classList.toggle('active', state.discordRpcEnabled);
      
    }
    if (badgeDiscordRpc) {
      badgeDiscordRpc.textContent = state.discordRpcEnabled ? 'on' : 'off';
    }
    const card = document.getElementById('card-discord-rpc');
    if (card) card.classList.toggle('enabled', state.discordRpcEnabled);
  }

  if (btnDiscordRpc) {
    btnDiscordRpc.addEventListener('click', () => {
      state.discordRpcEnabled = !state.discordRpcEnabled;
      localStorage.setItem('devsize_discord_rpc', JSON.stringify(state.discordRpcEnabled));
      if (window.electronAPI && window.electronAPI.discordRpcSetEnabled) {
        window.electronAPI.discordRpcSetEnabled(state.discordRpcEnabled);
      }
      if (state.discordRpcEnabled && state.isPlaying && state.currentTrack) {
        sendDiscordRpcUpdate(state.currentTrack, true);
      }
      syncDiscordRpcUI();
    });
  }

  const btnDiscordReconnect = document.getElementById('btn-discord-reconnect');
  if (btnDiscordReconnect) {
    btnDiscordReconnect.addEventListener('click', async () => {
      if (window.electronAPI && window.electronAPI.discordRpcReconnect) {
        await window.electronAPI.discordRpcReconnect();
        if (state.discordRpcEnabled && state.isPlaying && state.currentTrack) {
          sendDiscordRpcUpdate(state.currentTrack, true);
        }
        showToast('Discord RPC reconnected', 'info');
      }
    });
  }

  const inputDiscordClientId = document.getElementById('input-discord-client-id');
  const btnDiscordSaveClientId = document.getElementById('btn-discord-save-client-id');
  if (inputDiscordClientId) {
    const savedId = localStorage.getItem('eclipse_discord_client_id') || '';
    if (savedId) {
      inputDiscordClientId.value = savedId;
      if (window.electronAPI && window.electronAPI.discordRpcSetClientId) {
        window.electronAPI.discordRpcSetClientId(savedId);
      }
    }
    if (btnDiscordSaveClientId) {
      btnDiscordSaveClientId.addEventListener('click', async () => {
        const val = (inputDiscordClientId.value || '').trim();
        if (val) {
          localStorage.setItem('eclipse_discord_client_id', val);
          if (window.electronAPI && window.electronAPI.discordRpcSetClientId) {
            await window.electronAPI.discordRpcSetClientId(val);
          }
          if (state.discordRpcEnabled && state.isPlaying && state.currentTrack) {
            sendDiscordRpcUpdate(state.currentTrack, true);
          }
          showToast('Discord Client ID saved & reconnected', 'success');
        } else {
          localStorage.removeItem('eclipse_discord_client_id');
          if (window.electronAPI && window.electronAPI.discordRpcSetClientId) {
            await window.electronAPI.discordRpcSetClientId('1564857196334940162');
          }
          showToast('Reset to default Discord Client ID', 'info');
        }
      });
    }
  }

  const inputEclipseShareUrl = document.getElementById('input-eclipse-share-url');
  const btnEclipseSaveShareUrl = document.getElementById('btn-eclipse-save-share-url');
  if (inputEclipseShareUrl) {
    const savedShareUrl = localStorage.getItem('eclipse_share_base_url') || '';
    if (savedShareUrl) {
      inputEclipseShareUrl.value = savedShareUrl;
    }
    if (btnEclipseSaveShareUrl) {
      btnEclipseSaveShareUrl.addEventListener('click', () => {
        const val = (inputEclipseShareUrl.value || '').trim();
        if (val) {
          localStorage.setItem('eclipse_share_base_url', val);
          showToast('Share Web URL saved', 'success');
        } else {
          localStorage.removeItem('eclipse_share_base_url');
          showToast('Reset to default Share URL', 'info');
        }
        if (state.discordRpcEnabled && state.isPlaying && state.currentTrack) {
          sendDiscordRpcUpdate(state.currentTrack, true);
        }
      });
    }
  }

  const btnFloatingLyrics = document.getElementById('btn-floating-lyrics');
  if (btnFloatingLyrics) {
    btnFloatingLyrics.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (window.electronAPI && window.electronAPI.toggleFloatingLyrics) {
        const isOpen = await window.electronAPI.toggleFloatingLyrics();
        state.isFloatingLyricsOpen = !!isOpen;
        btnFloatingLyrics.classList.toggle('active', !!isOpen);
        if (isOpen && typeof sendFloatingLyricsUpdate === 'function') {
          sendFloatingLyricsUpdate();
        }
        showToast(isOpen ? 'Floating lyrics opened' : 'Floating lyrics closed', 'info');
      }
    });

    if (window.electronAPI && window.electronAPI.onFloatingLyricsState) {
      window.electronAPI.onFloatingLyricsState((isOpen) => {
        state.isFloatingLyricsOpen = !!isOpen;
        btnFloatingLyrics.classList.toggle('active', !!isOpen);
        if (isOpen && typeof sendFloatingLyricsUpdate === 'function') {
          sendFloatingLyricsUpdate();
        }
      });
    }

    if (window.electronAPI && window.electronAPI.onFloatingLyricsRequestSync) {
      window.electronAPI.onFloatingLyricsRequestSync(() => {
        if (typeof sendFloatingLyricsUpdate === 'function') {
          sendFloatingLyricsUpdate();
        }
      });
    }
  }

  const btnSkipSilence = document.getElementById('btn-skip-silence');
  if (btnSkipSilence) {
    const on = localStorage.getItem('eclipse_skip_silence_enabled') === '1';
    btnSkipSilence.classList.toggle('active', on);
    btnSkipSilence.addEventListener('click', () => {
      const next = !btnSkipSilence.classList.contains('active');
      btnSkipSilence.classList.toggle('active', next);
      localStorage.setItem('eclipse_skip_silence_enabled', next ? '1' : '0');
      showToast(next ? 'Skip silences enabled' : 'Skip silences disabled', 'info');
    });
  }

  const DEFAULT_SPONSORBLOCK_CATEGORIES = [
    'sponsor', 'intro', 'outro', 'selfpromo', 'music_offtopic', 'interaction', 'preview', 'filler'
  ];
  function getEnabledSponsorBlockCategories() {
    try {
      const raw = localStorage.getItem('eclipse_sponsorblock_categories');
      if (!raw) return new Set(DEFAULT_SPONSORBLOCK_CATEGORIES);
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return new Set(parsed);
    } catch (_) {}
    return new Set(DEFAULT_SPONSORBLOCK_CATEGORIES);
  }

  const btnSponsorBlock = document.getElementById('btn-sponsorblock');
  if (btnSponsorBlock) {
    const on = localStorage.getItem('eclipse_sponsorblock_enabled') !== '0';
    btnSponsorBlock.classList.toggle('active', on);
    btnSponsorBlock.addEventListener('click', () => {
      const next = !btnSponsorBlock.classList.contains('active');
      btnSponsorBlock.classList.toggle('active', next);
      localStorage.setItem('eclipse_sponsorblock_enabled', next ? '1' : '0');
      showToast(next ? 'SponsorBlock enabled' : 'SponsorBlock disabled', 'info');
      if (next && state.currentTrack) loadSponsorBlockSegments(state.currentTrack);
    });
  }

  const sbCatPills = document.querySelectorAll('#sponsorblock-categories-wrap .sb-cat-pill');
  if (sbCatPills.length) {
    const syncSbPills = () => {
      const enabled = getEnabledSponsorBlockCategories();
      sbCatPills.forEach(pill => {
        pill.classList.toggle('active', enabled.has(pill.dataset.category));
      });
    };
    syncSbPills();
    sbCatPills.forEach(pill => {
      pill.addEventListener('click', () => {
        const cat = pill.dataset.category;
        if (!cat) return;
        const enabled = getEnabledSponsorBlockCategories();
        if (enabled.has(cat)) enabled.delete(cat);
        else enabled.add(cat);
        localStorage.setItem('eclipse_sponsorblock_categories', JSON.stringify(Array.from(enabled)));
        syncSbPills();
      });
    });
  }

  const btnDiscordArtistStatus = document.getElementById('btn-discord-artist-status');
  if (btnDiscordArtistStatus) {
    const on = localStorage.getItem('eclipse_discord_artist_status') !== '0';
    btnDiscordArtistStatus.classList.toggle('active', on);
    btnDiscordArtistStatus.addEventListener('click', () => {
      const next = !btnDiscordArtistStatus.classList.contains('active');
      btnDiscordArtistStatus.classList.toggle('active', next);
      localStorage.setItem('eclipse_discord_artist_status', next ? '1' : '0');
      if (state.discordRpcEnabled && state.currentTrack) {
        sendDiscordRpcUpdate(state.currentTrack, state.isPlaying);
      }
    });
  }

  [
    ['btn-discord-show-paused', 'eclipse_discord_show_paused'],
    ['btn-discord-show-time', 'eclipse_discord_show_time'],
    ['btn-discord-show-button', 'eclipse_discord_show_button']
  ].forEach(([btnId, storageKey]) => {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    const on = localStorage.getItem(storageKey) !== '0';
    btn.classList.toggle('active', on);
    btn.addEventListener('click', () => {
      const next = !btn.classList.contains('active');
      btn.classList.toggle('active', next);
      localStorage.setItem(storageKey, next ? '1' : '0');
      if (state.discordRpcEnabled && state.currentTrack) {
        sendDiscordRpcUpdate(state.currentTrack, state.isPlaying);
      }
    });
  });

  if (el.nativeAudio) {
    el.nativeAudio.addEventListener('seeked', () => {
      if (state.discordRpcEnabled && state.currentTrack) {
        sendDiscordRpcUpdate(state.currentTrack, state.isPlaying);
      }
    });
  }

  syncDiscordRpcUI();

  const lastfmModal = document.getElementById('lastfm-modal');
  const btnLastFmOpen = document.getElementById('btn-lastfm-open-modal');
  const btnCloseLfm = document.getElementById('btn-close-lastfm-modal');
  const btnCancelLfm = document.getElementById('btn-cancel-lastfm-modal');
  const btnLastFmToggle = document.getElementById('btn-lastfm-toggle');
  const btnLastFmWebAuth = document.getElementById('btn-lastfm-web-auth');
  const btnLastFmLoginDirect = document.getElementById('btn-lastfm-login-direct');
  const btnLastFmDisconnect = document.getElementById('btn-lastfm-disconnect');

  function closeLastFmModal() {
    if (lastfmModal) {
      if (typeof closeModal === 'function') {
        closeModal(lastfmModal);
      } else {
        lastfmModal.classList.remove('visible');
        lastfmModal.classList.add('hidden');
      }
    }
    if (lastfmState.pollTimer) {
      clearInterval(lastfmState.pollTimer);
      lastfmState.pollTimer = null;
    }
  }

  if (btnLastFmOpen && lastfmModal) {
    btnLastFmOpen.addEventListener('click', () => {
      const userInp = document.getElementById('lastfm-input-user');
      const keyInp = document.getElementById('lastfm-input-key');
      const secretInp = document.getElementById('lastfm-input-secret');
      if (userInp && !userInp.value) userInp.value = lastfmState.username || '';
      if (keyInp && !keyInp.value) keyInp.value = lastfmState.apiKey || '';
      if (secretInp && !secretInp.value) secretInp.value = lastfmState.apiSecret || '';
      const statusEl = document.getElementById('lastfm-modal-status');
      if (statusEl) {
        statusEl.textContent = '';
        statusEl.classList.add('hidden');
      }
      if (typeof openModal === 'function') {
        openModal(lastfmModal);
      } else {
        lastfmModal.classList.remove('hidden');
        lastfmModal.classList.add('visible');
      }
    });
  }

  if (btnCloseLfm) btnCloseLfm.addEventListener('click', closeLastFmModal);
  if (btnCancelLfm) btnCancelLfm.addEventListener('click', closeLastFmModal);

  if (lastfmModal) {
    lastfmModal.addEventListener('click', (e) => {
      if (e.target === lastfmModal) closeLastFmModal();
    });
  }

  if (btnLastFmToggle) {
    btnLastFmToggle.addEventListener('click', () => {
      lastfmState.enabled = !lastfmState.enabled;
      localStorage.setItem('eclipse_lastfm_enabled', String(lastfmState.enabled));
      syncLastFmUI();
    });
  }

  if (btnLastFmWebAuth) {
    btnLastFmWebAuth.addEventListener('click', async () => {
      const statusEl = document.getElementById('lastfm-modal-status');
      const keyInp = document.getElementById('lastfm-input-key');
      const secretInp = document.getElementById('lastfm-input-secret');
      const customKey = (keyInp?.value || '').trim();
      const customSecret = (secretInp?.value || '').trim();
      if (customKey && customSecret) {
        lastfmState.apiKey = customKey;
        lastfmState.apiSecret = customSecret;
        localStorage.setItem('eclipse_lastfm_apikey', customKey);
        localStorage.setItem('eclipse_lastfm_apisecret', customSecret);
      } else {
        lastfmState.apiKey = '';
        lastfmState.apiSecret = '';
        localStorage.removeItem('eclipse_lastfm_apikey');
        localStorage.removeItem('eclipse_lastfm_apisecret');
      }
      if (statusEl) {
        statusEl.textContent = 'Requesting Last.fm authorization...';
        statusEl.classList.remove('hidden');
      }
      try {
        const port = state.serverPort || 38472;
        const res = await fetch(`http://127.0.0.1:${port}/api/lastfm/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            apiKey: lastfmState.apiKey,
            apiSecret: lastfmState.apiSecret
          })
        });
        const data = await res.json();
        if (!data.success || !data.token || !data.authUrl) {
          if (statusEl) statusEl.textContent = data.error || 'Failed to get auth token';
          return;
        }
        if (window.electronAPI && window.electronAPI.openExternal) window.electronAPI.openExternal(data.authUrl);
        else window.open(data.authUrl, '_blank');

        if (statusEl) {
          statusEl.textContent = 'Waiting for authorization in browser...';
          statusEl.classList.remove('hidden');
        }

        if (lastfmState.pollTimer) clearInterval(lastfmState.pollTimer);
        const token = data.token;
        lastfmState.pollTimer = setInterval(async () => {
          try {
            const sRes = await fetch(`http://127.0.0.1:${port}/api/lastfm/session`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                token,
                apiKey: lastfmState.apiKey,
                apiSecret: lastfmState.apiSecret
              })
            });
            const sData = await sRes.json();
            if (sData.success && sData.sessionKey) {
              clearInterval(lastfmState.pollTimer);
              lastfmState.pollTimer = null;
              lastfmState.sessionKey = sData.sessionKey;
              lastfmState.username = sData.username;
              localStorage.setItem('eclipse_lastfm_sk', sData.sessionKey);
              localStorage.setItem('eclipse_lastfm_user', sData.username);
              syncLastFmUI();
              if (typeof showToast === 'function') showToast('Connected to Last.fm as @' + sData.username, 'info');
              closeLastFmModal();
            }
          } catch (_) {}
        }, 2500);
      } catch (err) {
        if (statusEl) {
          statusEl.textContent = 'Error: ' + err.message;
          statusEl.classList.remove('hidden');
        }
      }
    });
  }

  if (btnLastFmLoginDirect) {
    btnLastFmLoginDirect.addEventListener('click', async () => {
      const statusEl = document.getElementById('lastfm-modal-status');
      const userInp = document.getElementById('lastfm-input-user');
      const passInp = document.getElementById('lastfm-input-pass');
      const keyInp = document.getElementById('lastfm-input-key');
      const secretInp = document.getElementById('lastfm-input-secret');
      const username = (userInp?.value || '').trim();
      const password = passInp?.value || '';
      const customKey = (keyInp?.value || '').trim();
      const customSecret = (secretInp?.value || '').trim();

      if (!username || !password) {
        if (statusEl) {
          statusEl.textContent = 'Please enter username and password';
          statusEl.classList.remove('hidden');
        }
        return;
      }

      if (customKey) {
        lastfmState.apiKey = customKey;
        localStorage.setItem('eclipse_lastfm_apikey', customKey);
      }
      if (customSecret) {
        lastfmState.apiSecret = customSecret;
        localStorage.setItem('eclipse_lastfm_apisecret', customSecret);
      }

      if (statusEl) {
        statusEl.textContent = 'Signing in...';
        statusEl.classList.remove('hidden');
      }

      try {
        const port = state.serverPort || 38472;
        const res = await fetch(`http://127.0.0.1:${port}/api/lastfm/mobile-session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username,
            password,
            apiKey: lastfmState.apiKey,
            apiSecret: lastfmState.apiSecret
          })
        });
        const data = await res.json();
        if (data.success && data.sessionKey) {
          lastfmState.sessionKey = data.sessionKey;
          lastfmState.username = data.username || username;
          localStorage.setItem('eclipse_lastfm_sk', data.sessionKey);
          localStorage.setItem('eclipse_lastfm_user', lastfmState.username);
          if (passInp) passInp.value = '';
          if (statusEl) {
            statusEl.textContent = `Connected as @${lastfmState.username}!`;
            statusEl.classList.remove('hidden');
          }
          syncLastFmUI();
          if (typeof showToast === 'function') showToast(`Connected to Last.fm as @${lastfmState.username}`, 'info');
        } else {
          if (statusEl) {
            statusEl.textContent = data.error || 'Authentication failed';
            statusEl.classList.remove('hidden');
          }
        }
      } catch (err) {
        if (statusEl) {
          statusEl.textContent = 'Error: ' + err.message;
          statusEl.classList.remove('hidden');
        }
      }
    });
  }

  if (btnLastFmDisconnect) {
    btnLastFmDisconnect.addEventListener('click', () => {
      lastfmState.sessionKey = '';
      lastfmState.username = '';
      localStorage.removeItem('eclipse_lastfm_sk');
      localStorage.removeItem('eclipse_lastfm_user');
      if (lastfmState.pollTimer) {
        clearInterval(lastfmState.pollTimer);
        lastfmState.pollTimer = null;
      }
      const statusEl = document.getElementById('lastfm-modal-status');
      if (statusEl) {
        statusEl.textContent = '';
        statusEl.classList.add('hidden');
      }
      syncLastFmUI();
      if (typeof showToast === 'function') showToast('Disconnected from Last.fm', 'info');
    });
  }

  syncLastFmUI();

  let trackToDownload = null;
  let downloadBatch = null;
  let selectedFormat = localStorage.getItem('eclipse_download_format') || 'mp3';
  let selectedQuality = '0';

  function updateDownloadBtnLabel() {
    if (!el.downloadBtnText) return;
    if (downloadBatch) {
      const count = downloadBatch.tracks.length;
      el.downloadBtnText.textContent = `Download ${count} track${count === 1 ? '' : 's'}`;
    } else {
      el.downloadBtnText.textContent = `Download ${selectedFormat.toUpperCase()}`;
    }
  }

  function updateLosslessQualityState() {
    const isLossless = selectedFormat === 'flac' || selectedFormat === 'wav';
    const qualityGrid = document.getElementById('quality-chips-grid');
    if (qualityGrid) {
      qualityGrid.classList.toggle('disabled', isLossless);
    }
  }

  async function updateDownloadCaptionPath() {
    const elPath = document.getElementById('download-caption-path');
    if (!elPath) return;
    try {
      if (window.electronAPI && window.electronAPI.getDownloadDir) {
        const info = await window.electronAPI.getDownloadDir();
        if (info && info.dir) {
          elPath.textContent = info.dir;
          return;
        }
      }
    } catch (e) {
      console.warn('getDownloadDir failed', e);
    }
    elPath.textContent = '~/Downloads';
  }

  let trimDraft = { start: 0, end: 180, dur: 180 };
  const waveformPeakCache = new Map();

  function formatPreciseTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    const d = Math.floor((sec * 10) % 10);
    return `${m}:${s < 10 ? '0' : ''}${s}.${d}`;
  }

  function computeFastWaveformPeaks(track, barCount = 84) {
    if (!track) return new Float32Array(barCount).fill(0.3);
    const cid = getTrackCanonicalId(track);
    if (cid && waveformPeakCache.has(cid)) {
      return waveformPeakCache.get(cid);
    }
    let seed = 0;
    for (let i = 0; i < cid.length; i++) {
      seed = ((seed << 5) - seed + cid.charCodeAt(i)) | 0;
    }
    function pseudoRandom() {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    }
    const peaks = new Float32Array(barCount);
    for (let i = 0; i < barCount; i++) {
      const t = i / barCount;
      const env = Math.sin(t * Math.PI) * 0.45 + 0.35 +
                  0.15 * Math.sin(t * Math.PI * 4.2) +
                  0.1 * Math.sin(t * Math.PI * 7.8);
      const noise = pseudoRandom() * 0.45 + 0.15;
      const val = Math.max(0.12, Math.min(0.96, env * noise * 1.25));
      peaks[i] = Math.round(val * 100) / 100;
    }
    if (cid) {
      waveformPeakCache.set(cid, peaks);
      boundMap(waveformPeakCache, 20);
    }

    
    (async () => {
      try {
        let targetUrl = '';
        if (track.platform === 'local' && track.path) {
          targetUrl = `file://${encodeURI(track.path)}`;
        } else if (track.id && state.serverPort) {
          const checkRes = await fetch(`http://127.0.0.1:${state.serverPort}/api/check-cache?id=${encodeURIComponent(track.id)}`).catch(() => null);
          if (checkRes && checkRes.ok) {
            const checkData = await checkRes.json();
            if (checkData && checkData.cached) {
              targetUrl = `http://127.0.0.1:${state.serverPort}/api/local-track?id=${encodeURIComponent(track.id)}`;
            }
          }
        }
        if (!targetUrl) return;

        const resp = await fetch(targetUrl, { headers: { Range: 'bytes=0-15000000' } }).catch(() => null);
        if (!resp || !resp.ok) return;
        const ab = await resp.arrayBuffer();
        if (!ab || ab.byteLength === 0) return;
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const audioBuffer = await ctx.decodeAudioData(ab.slice(0)).catch(() => null);
        ctx.close().catch(() => {});
        if (!audioBuffer) return;

        const channelData = audioBuffer.getChannelData(0);
        const blockSize = Math.floor(channelData.length / barCount);
        const upgraded = new Float32Array(barCount);
        let maxPeak = 0.001;
        for (let b = 0; b < barCount; b++) {
          let sum = 0;
          const startIdx = b * blockSize;
          for (let j = 0; j < blockSize; j += 4) {
            const v = Math.abs(channelData[startIdx + j]);
            if (v > sum) sum = v;
          }
          upgraded[b] = sum;
          if (sum > maxPeak) maxPeak = sum;
        }
        for (let b = 0; b < barCount; b++) {
          upgraded[b] = Math.max(0.12, Math.min(1.0, upgraded[b] / maxPeak));
        }
        if (cid) {
          waveformPeakCache.set(cid, upgraded);
          boundMap(waveformPeakCache, 20);
          if (trackToDownload && getTrackCanonicalId(trackToDownload) === cid) {
            renderTrimmerWaveform();
          }
        }
      } catch (_) {}
    })();

    return peaks;
  }

  function renderTrimmerWaveform() {
    const canvas = document.getElementById('capcut-wave-canvas');
    if (!canvas || !trackToDownload) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const barCount = 84;
    const peaks = computeFastWaveformPeaks(trackToDownload, barCount);
    const w = canvas.width || 420;
    const h = canvas.height || 88;
    ctx.clearRect(0, 0, w, h);

    const dur = Math.max(1, trimDraft.dur);
    const startRatio = trimDraft.start / dur;
    const endRatio = trimDraft.end / dur;
    const primaryColor = getComputedStyle(document.documentElement).getPropertyValue('--md-sys-color-primary').trim() || '#a8c7fa';

    const barW = (w / barCount) * 0.6;
    const step = w / barCount;
    for (let i = 0; i < barCount; i++) {
      const ratio = i / (barCount - 1);
      const inside = (ratio >= startRatio - 0.01 && ratio <= endRatio + 0.01);
      ctx.fillStyle = inside ? primaryColor : 'rgba(255, 255, 255, 0.22)';
      const barH = Math.max(6, (peaks[i] || 0.3) * (h - 16));
      const x = i * step + (step - barW) / 2;
      const y = (h - barH) / 2;
      ctx.beginPath();
      ctx.roundRect(x, y, barW, barH, 2);
      ctx.fill();
    }
  }

  function updateTrimmerUI() {
    const dur = Math.max(1, trimDraft.dur);
    const startPct = (trimDraft.start / dur) * 100;
    const endPct = (trimDraft.end / dur) * 100;
    const widthPct = Math.max(0, endPct - startPct);

    const maskLeft = document.getElementById('cc-mask-left');
    const maskRight = document.getElementById('cc-mask-right');
    const selBox = document.getElementById('cc-selection-box');
    const startVal = document.getElementById('cc-trim-start-val');
    const durVal = document.getElementById('cc-trim-dur-val');
    const endVal = document.getElementById('cc-trim-end-val');
    const floatLeft = document.getElementById('cc-float-left');
    const floatRight = document.getElementById('cc-float-right');
    const trimStartEl = document.getElementById('trim-start');
    const trimEndEl = document.getElementById('trim-end');

    if (maskLeft) maskLeft.style.width = `${startPct}%`;
    if (maskRight) maskRight.style.width = `${100 - endPct}%`;
    if (selBox) {
      selBox.style.left = `${startPct}%`;
      selBox.style.width = `${widthPct}%`;
    }

    const sStr = formatPreciseTime(trimDraft.start);
    const eStr = formatPreciseTime(trimDraft.end);
    const dStr = formatPreciseTime(Math.max(0, trimDraft.end - trimDraft.start));

    if (startVal) startVal.textContent = sStr;
    if (durVal) durVal.textContent = dStr;
    if (endVal) endVal.textContent = eStr;
    if (floatLeft) floatLeft.textContent = sStr;
    if (floatRight) floatRight.textContent = eStr;

    if (trimStartEl) trimStartEl.value = sStr;
    if (trimEndEl) trimEndEl.value = eStr;

    renderTrimmerWaveform();
  }

  function openDownloadModal(track, initialTab = 'download') {
    if (!track || !el.downloadModal) return;
    trackToDownload = track;
    downloadBatch = null;
    el.downloadModal.classList.remove('batch-mode');
    const dlModeTabs = document.getElementById('dl-mode-tabs');
    if (dlModeTabs) dlModeTabs.style.display = '';

    const modalTitle = document.getElementById('download-modal-title');
    if (modalTitle) modalTitle.textContent = 'Download track';
    if (el.downloadPreviewTitle) el.downloadPreviewTitle.textContent = track.title || 'untitled';
    if (el.downloadPreviewArtist) el.downloadPreviewArtist.textContent = track.artist || 'unknown artist';

    const dur = (isSameTrack(track, state.currentTrack) && el.nativeAudio && Number.isFinite(el.nativeAudio.duration) && el.nativeAudio.duration > 0)
      ? el.nativeAudio.duration
      : (track.duration && Number(track.duration) > 0 ? Number(track.duration) : 180);
    const tr = getTrackTrim(track);
    trimDraft = {
      start: tr ? Math.max(0, tr.start) : 0,
      end: tr ? Math.min(dur, tr.end) : dur,
      dur: dur
    };

    const btnCcReset = document.getElementById('btn-cc-reset');
    if (btnCcReset) {
      if (tr) btnCcReset.classList.remove('hidden');
      else btnCcReset.classList.add('hidden');
    }

    const dlTabs = document.querySelectorAll('.dl-mode-tab');
    const isTrimMode = initialTab === 'trim';
    dlTabs.forEach(t => t.classList.toggle('active', t.dataset.dlTab === (isTrimMode ? 'trim' : 'download')));
    const dlPaneDownload = document.getElementById('dl-pane-download');
    const dlPaneTrim = document.getElementById('dl-pane-trim');
    if (dlPaneDownload) dlPaneDownload.classList.toggle('hidden', isTrimMode);
    if (dlPaneTrim) dlPaneTrim.classList.toggle('hidden', !isTrimMode);

    updateTrimmerUI();

    if (track.thumbnail) {
      if (el.downloadPreviewThumb) {
        el.downloadPreviewThumb.src = track.thumbnail;
        el.downloadPreviewThumb.style.display = 'block';
      }
      if (el.downloadPreviewFallback) el.downloadPreviewFallback.style.display = 'none';
    } else {
      if (el.downloadPreviewThumb) el.downloadPreviewThumb.style.display = 'none';
      if (el.downloadPreviewFallback) el.downloadPreviewFallback.style.display = 'flex';
    }

    updateDownloadBtnLabel();
    updateLosslessQualityState();
    updateDownloadCaptionPath();

    const btnDeleteOfflineTrack = document.getElementById('btn-delete-offline-track');
    if (btnDeleteOfflineTrack) {
      btnDeleteOfflineTrack.classList.add('hidden');
      if (track && track.id) {
        fetch(`http://127.0.0.1:${state.serverPort}/api/check-cache?id=${encodeURIComponent(track.id)}`)
          .then(r => r.json())
          .then(res => {
            if (res.cached) {
              btnDeleteOfflineTrack.classList.remove('hidden');
            }
          })
          .catch(() => {});
      }
    }

    openModal(el.downloadModal);
  }

  function openDownloadAllModal(playlist) {
    if (!el.downloadModal) return;
    const tracks = (playlist && Array.isArray(playlist.tracks) ? playlist.tracks : []).filter(t => t.platform !== 'local');
    if (!tracks.length) {
      showToast('No remote tracks to download in this playlist', 'info');
      return;
    }
    trackToDownload = null;
    downloadBatch = { name: playlist.name || 'Playlist', tracks };
    el.downloadModal.classList.add('batch-mode');
    const dlModeTabs = document.getElementById('dl-mode-tabs');
    if (dlModeTabs) dlModeTabs.style.display = 'none';
    const dlPaneDownload = document.getElementById('dl-pane-download');
    const dlPaneTrim = document.getElementById('dl-pane-trim');
    if (dlPaneDownload) dlPaneDownload.classList.remove('hidden');
    if (dlPaneTrim) dlPaneTrim.classList.add('hidden');
    const modalTitle = document.getElementById('download-modal-title');
    if (modalTitle) modalTitle.textContent = 'Download playlist';
    if (el.downloadPreviewTitle) el.downloadPreviewTitle.textContent = playlist.name || 'Playlist';
    if (el.downloadPreviewArtist) el.downloadPreviewArtist.textContent = `${tracks.length} track${tracks.length === 1 ? '' : 's'}`;
    if (el.downloadPreviewThumb) el.downloadPreviewThumb.style.display = 'none';
    if (el.downloadPreviewFallback) el.downloadPreviewFallback.style.display = 'none';
    updateDownloadBtnLabel();
    updateLosslessQualityState();
    updateDownloadCaptionPath();
    openModal(el.downloadModal);
  }

  const dlTabs = document.querySelectorAll('.dl-mode-tab');
  dlTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.dlTab;
      dlTabs.forEach(t => t.classList.toggle('active', t === tab));
      const dlPaneDownload = document.getElementById('dl-pane-download');
      const dlPaneTrim = document.getElementById('dl-pane-trim');
      if (target === 'trim') {
        if (dlPaneDownload) dlPaneDownload.classList.add('hidden');
        if (dlPaneTrim) dlPaneTrim.classList.remove('hidden');
        updateTrimmerUI();
      } else {
        if (dlPaneDownload) dlPaneDownload.classList.remove('hidden');
        if (dlPaneTrim) dlPaneTrim.classList.add('hidden');
      }
    });
  });

  const ccStage = document.getElementById('capcut-wave-stage');
  const ccHandleLeft = document.getElementById('cc-handle-left');
  const ccHandleRight = document.getElementById('cc-handle-right');

  if (ccHandleLeft && ccStage) {
    let isDraggingLeft = false;
    ccHandleLeft.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      isDraggingLeft = true;
      ccHandleLeft.setPointerCapture(e.pointerId);
      ccHandleLeft.classList.add('dragging');
    });
    ccHandleLeft.addEventListener('pointermove', (e) => {
      if (!isDraggingLeft) return;
      const rect = ccStage.getBoundingClientRect();
      if (!rect.width) return;
      let ratio = (e.clientX - rect.left) / rect.width;
      const maxRatio = (trimDraft.end - 1.0) / trimDraft.dur;
      ratio = Math.max(0, Math.min(ratio, maxRatio));
      trimDraft.start = Math.round(ratio * trimDraft.dur * 10) / 10;
      updateTrimmerUI();
    });
    const stopDragLeft = (e) => {
      if (!isDraggingLeft) return;
      isDraggingLeft = false;
      try { ccHandleLeft.releasePointerCapture(e.pointerId); } catch (_) {}
      ccHandleLeft.classList.remove('dragging');
    };
    ccHandleLeft.addEventListener('pointerup', stopDragLeft);
    ccHandleLeft.addEventListener('pointercancel', stopDragLeft);
  }

  if (ccHandleRight && ccStage) {
    let isDraggingRight = false;
    ccHandleRight.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      isDraggingRight = true;
      ccHandleRight.setPointerCapture(e.pointerId);
      ccHandleRight.classList.add('dragging');
    });
    ccHandleRight.addEventListener('pointermove', (e) => {
      if (!isDraggingRight) return;
      const rect = ccStage.getBoundingClientRect();
      if (!rect.width) return;
      let ratio = (e.clientX - rect.left) / rect.width;
      const minRatio = (trimDraft.start + 1.0) / trimDraft.dur;
      ratio = Math.min(1.0, Math.max(ratio, minRatio));
      trimDraft.end = Math.round(ratio * trimDraft.dur * 10) / 10;
      updateTrimmerUI();
    });
    const stopDragRight = (e) => {
      if (!isDraggingRight) return;
      isDraggingRight = false;
      try { ccHandleRight.releasePointerCapture(e.pointerId); } catch (_) {}
      ccHandleRight.classList.remove('dragging');
    };
    ccHandleRight.addEventListener('pointerup', stopDragRight);
    ccHandleRight.addEventListener('pointercancel', stopDragRight);
  }

  if (ccStage) {
    ccStage.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.cc-handle')) return;
      const rect = ccStage.getBoundingClientRect();
      if (!rect.width) return;
      let ratio = (e.clientX - rect.left) / rect.width;
      ratio = Math.max(0, Math.min(1.0, ratio));
      const targetSec = ratio * trimDraft.dur;
      if (isSameTrack(state.currentTrack, trackToDownload)) {
        if (el.nativeAudio) {
          el.nativeAudio.currentTime = targetSec;
          playSmooth();
        }
      } else if (trackToDownload) {
        playTrack(trackToDownload).then(() => {
          if (el.nativeAudio) {
            el.nativeAudio.currentTime = targetSec;
            playSmooth();
          }
        });
      }
    });
  }

  const btnCcPreview = document.getElementById('btn-cc-preview');
  if (btnCcPreview) {
    btnCcPreview.addEventListener('click', async () => {
      if (!trackToDownload) return;
      if (!isSameTrack(state.currentTrack, trackToDownload)) {
        await playTrack(trackToDownload);
      }
      if (el.nativeAudio) {
        el.nativeAudio.currentTime = trimDraft.start;
        playSmooth();
      }
    });
  }

  const btnCcSave = document.getElementById('btn-cc-save');
  if (btnCcSave) {
    btnCcSave.addEventListener('click', () => {
      if (!trackToDownload) return;
      saveTrackTrim(trackToDownload, trimDraft.start, trimDraft.end, trimDraft.dur);
      showToast('Track trim saved (' + formatPreciseTime(trimDraft.start) + ' – ' + formatPreciseTime(trimDraft.end) + ')');
      const btnCcReset = document.getElementById('btn-cc-reset');
      if (btnCcReset) btnCcReset.classList.remove('hidden');
      if (isSameTrack(state.currentTrack, trackToDownload) && el.nativeAudio) {
        if (el.nativeAudio.currentTime < trimDraft.start || el.nativeAudio.currentTime > trimDraft.end) {
          el.nativeAudio.currentTime = trimDraft.start;
        }
      }
    });
  }

  const btnCcReset = document.getElementById('btn-cc-reset');
  if (btnCcReset) {
    btnCcReset.addEventListener('click', () => {
      if (!trackToDownload) return;
      const cid = getTrackCanonicalId(trackToDownload);
      if (cid) {
        const all = getTrackTrims();
        delete all[cid];
        try { localStorage.setItem('eclipse_track_trims', JSON.stringify(all)); } catch (_) {}
      }
      trimDraft.start = 0;
      trimDraft.end = trimDraft.dur;
      updateTrimmerUI();
      btnCcReset.classList.add('hidden');
      showToast('Track trim removed');
    });
  }

  function setDownloadFormat(fmt) {
    selectedFormat = fmt || 'mp3';
    localStorage.setItem('eclipse_download_format', selectedFormat);
    document.querySelectorAll('.format-chip').forEach(c => {
      c.classList.toggle('active', c.dataset.format === selectedFormat);
    });
    updateDownloadBtnLabel();
    updateLosslessQualityState();
  }

  document.querySelectorAll('.format-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      setDownloadFormat(chip.dataset.format);
    });
  });

  setDownloadFormat(selectedFormat);

  document.querySelectorAll('.quality-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.quality-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      selectedQuality = chip.dataset.quality;
    });
  });

  let downloadAbort = null;

  function cancelCurrentDownload() {
    if (downloadAbort) {
      try { downloadAbort.abort(); } catch (_) {}
      downloadAbort = null;
      const curSpinner = el.downloadSpinner || document.getElementById('download-spinner');
      if (curSpinner) curSpinner.innerHTML = '';
      if (el.btnConfirmDownload) {
        el.btnConfirmDownload.style.display = '';
        el.btnConfirmDownload.disabled = false;
      }
      updateDownloadBtnLabel();
      showToast('Download cancelled', 'info');
      if (el.downloadModal) closeModal(el.downloadModal);
      return true;
    }
    return false;
  }

  if (el.btnCloseDownloadModal) {
    el.btnCloseDownloadModal.addEventListener('click', () => {
      if (!cancelCurrentDownload()) {
        if (el.downloadModal) closeModal(el.downloadModal);
      }
    });
  }

  if (el.btnCancelDownload) {
    el.btnCancelDownload.addEventListener('click', () => {
      if (!cancelCurrentDownload()) {
        if (el.downloadModal) closeModal(el.downloadModal);
      }
    });
  }

  if (el.btnPlaybarMore) {
    el.btnPlaybarMore.addEventListener('click', () => {
      if (state.currentTrack) {
        openDownloadModal(state.currentTrack);
      } else {
        showToast('No track currently playing', 'info');
      }
    });
  }

  const btnPlaybarShare = document.getElementById('btn-playbar-share');
  if (btnPlaybarShare) {
    btnPlaybarShare.addEventListener('click', () => {
      if (state.currentTrack) {
        executeCopyShareLink(state.currentTrack);
      } else {
        showToast('No track currently playing', 'info');
      }
    });
  }

  function parseTimeInputToSeconds(str) {
    if (!str || typeof str !== 'string') return null;
    const s = str.trim();
    if (!s) return null;
    if (/^\d+(\.\d+)?$/.test(s)) {
      const val = parseFloat(s);
      return isNaN(val) ? null : Math.max(0, val);
    }
    const parts = s.split(':').map(p => p.trim());
    if (parts.length === 2) {
      const m = parseInt(parts[0], 10);
      const sec = parseFloat(parts[1]);
      if (!isNaN(m) && !isNaN(sec) && m >= 0 && sec >= 0) {
        return m * 60 + sec;
      }
    } else if (parts.length === 3) {
      const h = parseInt(parts[0], 10);
      const m = parseInt(parts[1], 10);
      const sec = parseFloat(parts[2]);
      if (!isNaN(h) && !isNaN(m) && !isNaN(sec) && h >= 0 && m >= 0 && sec >= 0) {
        return h * 3600 + m * 60 + sec;
      }
    }
    return null;
  }

  function trimAudioBuffer(ctx, buffer, startSec, endSec) {
    const sampleRate = buffer.sampleRate;
    const numChannels = buffer.numberOfChannels;
    const totalDuration = buffer.duration;
    const start = Math.max(0, Math.min(startSec || 0, totalDuration));
    const end = (endSec !== null && endSec !== undefined && endSec > start)
      ? Math.min(endSec, totalDuration)
      : totalDuration;

    if (start <= 0 && end >= totalDuration) {
      return buffer;
    }

    const startSample = Math.floor(start * sampleRate);
    const endSample = Math.floor(end * sampleRate);
    const length = Math.max(1, endSample - startSample);

    const trimmed = ctx.createBuffer(numChannels, length, sampleRate);
    for (let ch = 0; ch < numChannels; ch++) {
      const srcData = buffer.getChannelData(ch);
      const dstData = trimmed.getChannelData(ch);
      dstData.set(srcData.subarray(startSample, startSample + length));
    }
    return trimmed;
  }

  function audioBufferToWav(buffer) {
    const numChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const bitDepth = 16;
    const bytesPerSample = bitDepth / 8;
    const blockAlign = numChannels * bytesPerSample;
    const length = buffer.length;
    const dataSize = length * blockAlign;
    const arrayBuffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(arrayBuffer);

    const writeStr = (offset, str) => {
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };

    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitDepth, true);
    writeStr(36, 'data');
    view.setUint32(40, dataSize, true);

    let offset = 44;
    for (let i = 0; i < length; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        const sample = Math.max(-1, Math.min(1, buffer.getChannelData(ch)[i]));
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
        offset += 2;
      }
    }
    return new Blob([arrayBuffer], { type: 'audio/wav' });
  }

  if (el.btnConfirmDownload) {
    el.btnConfirmDownload.addEventListener('click', async () => {
      if (downloadBatch) {
        const tracks = downloadBatch.tracks;
        el.btnConfirmDownload.disabled = true;
        let done = 0;
        let failed = 0;
        let lastDir = null;
        for (let i = 0; i < tracks.length; i++) {
          const t = tracks[i];
          if (el.downloadBtnText) el.downloadBtnText.textContent = `Downloading ${i + 1}/${tracks.length}`;
          try {
            const customDir = state.downloadDir || localStorage.getItem('eclipse_download_dir') || '';
            const thumbUrl = getTrackThumbUrl(t) || t.thumbnail || t.cover || '';
            const downloadUrl = `http://127.0.0.1:${state.serverPort}/api/download?url=${encodeURIComponent(t.url || '')}&id=${encodeURIComponent(t.id || '')}&title=${encodeURIComponent(t.title || '')}&artist=${encodeURIComponent(t.artist || '')}&format=${selectedFormat}&quality=${selectedQuality}&thumbnail=${encodeURIComponent(thumbUrl)}&customDir=${encodeURIComponent(customDir)}`;
            const res = await fetch(downloadUrl);
            const text = await res.text();
            let data;
            try {
              data = JSON.parse(text);
            } catch (e) {
              throw new Error(text || 'server error');
            }
            if (!data.success) throw new Error(data.error || 'Failed to download');
            done++;
            if (data.directory) lastDir = data.directory;
          } catch (err) {
            failed++;
            console.error('Download failed:', t.title || t.url || '', err.message);
          }
        }
        el.btnConfirmDownload.disabled = false;
        downloadBatch = null;
        if (el.downloadModal) closeModal(el.downloadModal);
        showToast(failed > 0 ? `Downloaded ${done}/${tracks.length} (${failed} failed)` : `Downloaded ${tracks.length} tracks${lastDir ? ' to ' + lastDir : ''}`, failed > 0 ? 'error' : 'success');
        return;
      }
      if (!trackToDownload) return;
      const t = trackToDownload;

      const trimStartEl = document.getElementById('trim-start');
      const trimEndEl = document.getElementById('trim-end');
      const rawStart = trimStartEl ? trimStartEl.value.trim() : '';
      const rawEnd = trimEndEl ? trimEndEl.value.trim() : '';

      const parsedStart = parseTimeInputToSeconds(rawStart);
      const startSec = (parsedStart !== null && parsedStart >= 0) ? parsedStart : 0;
      const endSec = rawEnd ? parseTimeInputToSeconds(rawEnd) : null;

      if (endSec !== null && endSec <= startSec) {
        showToast('Trim end must be after start', 'error');
        return;
      }

      if (el.btnConfirmDownload) {
        el.btnConfirmDownload.disabled = true;
        el.btnConfirmDownload.style.display = 'none';
      }
      const spinnerEl = el.downloadSpinner || document.getElementById('download-spinner');
      if (spinnerEl) {
        spinnerEl.innerHTML = `
          <div class="m3-spinner-container" style="width: 32px; height: 32px; padding: 4px; background: transparent;">
            <svg class="m3-circular-progress" viewBox="0 0 48 48" style="width: 24px; height: 24px;">
              <circle class="m3-spinner-track" cx="24" cy="24" r="18" fill="none" stroke-width="4"></circle>
              <circle class="m3-spinner-head" cx="24" cy="24" r="18" fill="none" stroke-width="4" stroke="var(--md-sys-color-primary)"></circle>
            </svg>
          </div>
        `;
      }

      showToast(`Downloading: ${t.title || 'Track'} (.${selectedFormat})`, 'info');
      downloadAbort = new AbortController();

      try {
        let audioSourceUrl = null;
        const isCurrent = isSameTrack(t, state.currentTrack);
        if (isCurrent && el.nativeAudio && el.nativeAudio.src && !el.nativeAudio.src.startsWith('blob:')) {
          audioSourceUrl = el.nativeAudio.src;
        }

        if (!audioSourceUrl && t.platform === 'local' && t.id) {
          audioSourceUrl = `http://127.0.0.1:${state.serverPort}/api/library-file?id=${encodeURIComponent(t.id)}`;
        }

        if (!audioSourceUrl && t.id) {
          try {
            const checkRes = await fetch(`http://127.0.0.1:${state.serverPort}/api/check-cache?id=${encodeURIComponent(t.id)}`, { signal: downloadAbort.signal });
            const checkData = await checkRes.json();
            if (checkData && checkData.cached) {
              audioSourceUrl = `http://127.0.0.1:${state.serverPort}/api/local-track?id=${encodeURIComponent(t.id)}`;
            }
          } catch (_) {}
        }

        if (!audioSourceUrl) {
          const streamInfoUrl = `http://127.0.0.1:${state.serverPort}/api/stream-info?url=${encodeURIComponent(t.url || '')}&id=${encodeURIComponent(t.id || '')}&platform=${t.platform || 'ytmusic'}&title=${encodeURIComponent(t.title || '')}&artist=${encodeURIComponent(t.artist || '')}&duration=${encodeURIComponent(t.duration || 0)}`;
          const streamRes = await fetch(streamInfoUrl, { signal: downloadAbort.signal });
          const streamData = await streamRes.json();
          if (!streamData || !streamData.success || (!streamData.streamUrl && !streamData.proxyUrl)) {
            throw new Error((streamData && streamData.error) || 'Failed to locate track audio stream');
          }
          audioSourceUrl = streamData.isLocal ? streamData.streamUrl : (streamData.proxyUrl || streamData.streamUrl);
        }

        let fetchUrl = audioSourceUrl;
        const isLoopback = fetchUrl.startsWith('http://127.0.0.1') || fetchUrl.startsWith('http://localhost');
        if (!isLoopback) {
          fetchUrl = `http://127.0.0.1:${state.serverPort}/api/audio-proxy?url=${encodeURIComponent(audioSourceUrl)}`;
        }

        const resFile = await fetch(fetchUrl, { signal: downloadAbort.signal });
        if (!resFile.ok) throw new Error(`Failed to load audio (${resFile.status})`);
        const arrayBuffer = await resFile.arrayBuffer();

        if (downloadAbort?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');

        const decodeCtx = audioEngine.ctx || new (window.AudioContext || window.webkitAudioContext)();
        const decodedBuffer = await new Promise((resolve, reject) => {
          decodeCtx.decodeAudioData(arrayBuffer.slice(0), resolve, reject);
        });

        if (downloadAbort?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');

        let bufferToProcess = decodedBuffer;
        if (startSec > 0 || (endSec !== null && endSec < decodedBuffer.duration)) {
          bufferToProcess = trimAudioBuffer(decodeCtx, decodedBuffer, startSec, endSec);
        }

        const applyEffects = Boolean(document.getElementById('download-apply-effects')?.checked);
        let finalBuffer = bufferToProcess;
        if (applyEffects) {
          const currentSettings = {
            ...state.audioSettings,
            volume: 1.0,
            eq: { ...(state.audioSettings.eq || {}) },
            eqBands: Array.isArray(state.audioSettings.eqBands) ? [...state.audioSettings.eqBands] : [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
          };
          finalBuffer = await audioEngine.renderOffline(bufferToProcess, currentSettings);
        }

        if (downloadAbort?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');

        const wavBlob = audioBufferToWav(finalBuffer);

        if (downloadAbort?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');

        const customDir = state.downloadDir || localStorage.getItem('eclipse_download_dir') || '';
        const thumbUrl = getTrackThumbUrl(t) || t.thumbnail || t.cover || '';
        const encodeUrl = `http://127.0.0.1:${state.serverPort}/api/encode?title=${encodeURIComponent(t.title || 'untitled')}&artist=${encodeURIComponent(t.artist || 'unknown artist')}&format=${selectedFormat}&quality=${selectedQuality}&thumbnail=${encodeURIComponent(thumbUrl)}&customDir=${encodeURIComponent(customDir)}`;
        const resEncode = await fetch(encodeUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'audio/wav' },
          body: wavBlob,
          signal: downloadAbort.signal
        });
        const textEncode = await resEncode.text();
        let dataEncode;
        try {
          dataEncode = JSON.parse(textEncode);
        } catch (e) {
          throw new Error(textEncode || 'Server error');
        }
        if (!dataEncode.success) throw new Error(dataEncode.error || 'Failed to encode');

        showToast(`Download complete: saved to ${dataEncode.directory ? dataEncode.directory + '/' : ''}${dataEncode.filename}`, 'info');
        if (el.downloadModal) closeModal(el.downloadModal);
      } catch (err) {
        if (err.name === 'AbortError') return;
        console.error('Download error:', err);
        showToast(`Download failed: ${err.message}`, 'error');
      } finally {
        downloadAbort = null;
        const curSpinner = el.downloadSpinner || document.getElementById('download-spinner');
        if (curSpinner) curSpinner.innerHTML = '';
        if (el.btnConfirmDownload) {
          el.btnConfirmDownload.style.display = '';
          el.btnConfirmDownload.disabled = false;
        }
        updateDownloadBtnLabel();
      }
    });
  }

  const btnDownloadPlaylist = document.getElementById('btn-download-playlist');
  if (btnDownloadPlaylist) {
    btnDownloadPlaylist.addEventListener('click', () => {
      const pl = (state.playlists || []).find(p => p.id === state.currentPlaylistId);
      openDownloadAllModal(pl);
    });
  }

  refreshNavBadges();
  renderPlaylistsList();
  renderPresets();
  syncSettingsSlidersToState();
  applyVisualEffects();

  const analysisCache = new Map();
  let myWaveCurrentTracks = [];
  let jumpBackCurrentTracks = [];
  let homeMode = localStorage.getItem('eclipse_home_pane') === 'recent' ? 'recent' : 'wave';
  let isExtendingMyWave = false;

  function getCachedTrackAnalysis(trackId) {
    if (!trackId) return null;
    const cleanId = String(trackId).replace(/[^a-zA-Z0-9_-]/g, '_');
    if (analysisCache.has(cleanId)) return analysisCache.get(cleanId);
    try {
      const stored = localStorage.getItem(`eclipse_audio_analysis_${cleanId}`);
      if (stored) {
        const parsed = JSON.parse(stored);
        analysisCache.set(cleanId, parsed);
        return parsed;
      }
    } catch (e) {}
    return null;
  }

  function setCachedTrackAnalysis(trackId, analysis) {
    if (!trackId || !analysis) return;
    const cleanId = String(trackId).replace(/[^a-zA-Z0-9_-]/g, '_');
    analysisCache.set(cleanId, analysis);
    try {
      localStorage.setItem(`eclipse_audio_analysis_${cleanId}`, JSON.stringify(analysis));
      fetch(`http://127.0.0.1:${state.serverPort}/api/track-analysis`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: cleanId, analysis })
      }).catch(() => {});
    } catch (e) {}
  }

  function getTrackNormalizedKey(artist, title) {
    let a = String(artist || '').toLowerCase();
    let t = String(title || '').toLowerCase();
    t = t.replace(/\s*\([^)]*official[^)]*\)/gi, '')
         .replace(/\s*\[[^\]]*\]/gi, '')
         .replace(/\s*\([^)]*(video|audio|remaster(ed)?|lyrics?|visualizer)[^)]*\)/gi, '');
    t = t.replace(/\s*(feat\.?|ft\.?)\s+[^(\[-]+/gi, '')
         .replace(/\s*\((feat\.?|ft\.?)[^)]*\)/gi, '');
    a = a.replace(/\s*(feat\.?|ft\.?)\s+.*$/gi, '');
    a = a.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
    t = t.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
    return `${a}::${t}`;
  }

  const WAVE_SKIPS_KEY = 'eclipse_wave_skips';

  function normalizeArtistName(name) {
    return String(name || '')
      .replace(/\b(official|vevo|records|topic)\b/gi, '')
      .replace(/[^\w\s&-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function getWaveSkips() {
    try {
      const raw = localStorage.getItem(WAVE_SKIPS_KEY);
      return Array.isArray(JSON.parse(raw)) ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  function recordWaveSkip(track) {
    if (!track) return;
    const key = (typeof getTrackNormalizedKey === 'function') ? getTrackNormalizedKey(track.artist, track.title) : '';
    const artist = (track.artist || '').trim();
    if (!key && !artist) return;
    const skips = getWaveSkips();
    skips.push({ key, artist, t: Date.now() });
    if (skips.length > 200) {
      skips.splice(0, skips.length - 200);
    }
    try {
      localStorage.setItem(WAVE_SKIPS_KEY, JSON.stringify(skips));
    } catch (e) {}
  }

  function getBlockedArtists() {
    try {
      const raw = localStorage.getItem('eclipse_blocked_artists');
      return Array.isArray(JSON.parse(raw)) ? JSON.parse(raw) : [];
    } catch (_) {
      return [];
    }
  }

  function getBlockedTracks() {
    try {
      const raw = localStorage.getItem('eclipse_blocked_tracks');
      return Array.isArray(JSON.parse(raw)) ? JSON.parse(raw) : [];
    } catch (_) {
      return [];
    }
  }

  function isArtistBlocked(name) {
    if (!name || typeof name !== 'string') return false;
    const clean = name.trim();
    if (!clean) return false;
    const target = typeof normalizeArtistName === 'function' ? normalizeArtistName(clean) : clean.toLowerCase();
    const list = getBlockedArtists();
    return list.some(a => {
      const na = typeof normalizeArtistName === 'function' ? normalizeArtistName(a) : (a || '').trim().toLowerCase();
      return na === target;
    });
  }

  function isTrackBlocked(track) {
    if (!track) return false;
    const list = getBlockedTracks();
    if (!list.length) return false;
    const trackId = track.id || '';
    const trackKey = track.key || (typeof getTrackNormalizedKey === 'function' && track.artist && track.title ? getTrackNormalizedKey(track.artist, track.title) : `${track.artist}-${track.title}`);
    const normTitle = (track.title || '').trim().toLowerCase();
    const normArtist = typeof normalizeArtistName === 'function' ? normalizeArtistName(track.artist || '') : (track.artist || '').trim().toLowerCase();

    return list.some(bt => {
      if (trackId && bt.id && trackId === bt.id) return true;
      if (trackKey && bt.key && trackKey === bt.key) return true;
      if (normTitle && bt.title && bt.title.trim().toLowerCase() === normTitle) {
        const btArtist = typeof normalizeArtistName === 'function' ? normalizeArtistName(bt.artist || '') : (bt.artist || '').trim().toLowerCase();
        if (!normArtist || !btArtist || normArtist === btArtist) return true;
      }
      return false;
    });
  }

  function toggleBlockArtist(name) {
    if (!name) return false;
    const clean = name.trim();
    const list = getBlockedArtists();
    const target = typeof normalizeArtistName === 'function' ? normalizeArtistName(clean) : clean.toLowerCase();
    const idx = list.findIndex(a => {
      const na = typeof normalizeArtistName === 'function' ? normalizeArtistName(a) : (a || '').trim().toLowerCase();
      return na === target;
    });

    let blocked = false;
    if (idx >= 0) {
      list.splice(idx, 1);
      blocked = false;
    } else {
      list.push(clean);
      blocked = true;
    }
    localStorage.setItem('eclipse_blocked_artists', JSON.stringify(list));
    showToast(blocked ? `Blocked artist "${clean}"` : `Unblocked artist "${clean}"`, 'info');
    renderBlockedItemsSettings();
    syncArtistBlockButtonUI();
    return blocked;
  }

  function toggleBlockTrack(track) {
    if (!track) return false;
    const list = getBlockedTracks();
    const trackId = track.id || '';
    const title = track.title || '';
    const artist = track.artist || '';
    const trackKey = track.key || (typeof getTrackNormalizedKey === 'function' && artist && title ? getTrackNormalizedKey(artist, title) : `${artist}-${title}`);
    const normTitle = title.trim().toLowerCase();
    const normArtist = typeof normalizeArtistName === 'function' ? normalizeArtistName(artist) : artist.trim().toLowerCase();

    const idx = list.findIndex(bt => {
      if (trackId && bt.id && trackId === bt.id) return true;
      if (trackKey && bt.key && trackKey === bt.key) return true;
      if (normTitle && bt.title && bt.title.trim().toLowerCase() === normTitle) {
        const btArtist = typeof normalizeArtistName === 'function' ? normalizeArtistName(bt.artist || '') : (bt.artist || '').trim().toLowerCase();
        if (!normArtist || !btArtist || normArtist === btArtist) return true;
      }
      return false;
    });

    let blocked = false;
    if (idx >= 0) {
      list.splice(idx, 1);
      blocked = false;
    } else {
      list.push({ key: trackKey, id: trackId, title, artist });
      blocked = true;
    }
    localStorage.setItem('eclipse_blocked_tracks', JSON.stringify(list));
    showToast(blocked ? `Blocked track "${title || 'Track'}"` : `Unblocked track "${title || 'Track'}"`, 'info');
    renderBlockedItemsSettings();
    return blocked;
  }

  function syncArtistBlockButtonUI() {
    const btnBlock = document.getElementById('btn-artist-block');
    const profName = document.getElementById('artist-profile-name');
    if (btnBlock && profName && profName.textContent) {
      const isBlocked = isArtistBlocked(profName.textContent.trim());
      btnBlock.classList.toggle('blocked', isBlocked);
      btnBlock.textContent = isBlocked ? 'Blocked' : 'Block';
    }
  }

  function renderBlockedItemsSettings() {
    const container = document.getElementById('blocked-items-list');
    if (!container) return;
    const artists = getBlockedArtists();
    const tracks = getBlockedTracks();
    if (artists.length === 0 && tracks.length === 0) {
      container.innerHTML = '<span style="font-size:12px;color:var(--md-sys-color-outline);padding:4px 0;">No blocked artists or tracks</span>';
      return;
    }
    container.innerHTML = '';
    artists.forEach(a => {
      const pill = document.createElement('div');
      pill.className = 'blocked-item-pill';
      pill.innerHTML = `<span><strong>${escapeHtml(a)}</strong> <span style="opacity:0.75;font-size:11px;">(Artist)</span></span><span class="pill-del">✕</span>`;
      pill.title = `Click to unblock ${a}`;
      pill.addEventListener('click', () => {
        toggleBlockArtist(a);
      });
      container.appendChild(pill);
    });
    tracks.forEach(t => {
      const pill = document.createElement('div');
      pill.className = 'blocked-item-pill';
      const label = t.title ? `${t.title}${t.artist ? ' · ' + t.artist : ''}` : (t.key || 'Track');
      pill.innerHTML = `<span>${escapeHtml(label)} <span style="opacity:0.75;font-size:11px;">(Track)</span></span><span class="pill-del">✕</span>`;
      pill.title = `Click to unblock ${t.title || 'track'}`;
      pill.addEventListener('click', () => {
        toggleBlockTrack(t);
      });
      container.appendChild(pill);
    });
  }

  function getWaveAvoid() {
    const skips = getWaveSkips();
    const keys = [];
    const artistCounts = {};
    const artistDisplay = {};

    for (const s of skips) {
      if (s && s.key) {
        keys.push(s.key);
      }
      if (s && s.artist) {
        const a = s.artist.trim();
        const normA = normalizeArtistName(a);
        if (normA) {
          artistCounts[normA] = (artistCounts[normA] || 0) + 1;
          if (!artistDisplay[normA]) {
            artistDisplay[normA] = a;
          }
        }
      }
    }

    const artists = Object.entries(artistCounts)
      .filter(([_, count]) => count >= 3)
      .map(([normA]) => artistDisplay[normA]);

    const feedback = typeof getMixFeedback === 'function' ? getMixFeedback() : null;
    if (feedback) {
      if (Array.isArray(feedback.dislikedTracks)) {
        feedback.dislikedTracks.forEach(t => {
          if (!t) return;
          if (typeof t === 'string') {
            keys.push(t);
          } else {
            if (t.key) keys.push(t.key);
            if (t.id) keys.push(t.id);
            if (t.artist && t.title && typeof getTrackNormalizedKey === 'function') {
              keys.push(getTrackNormalizedKey(t.artist, t.title));
            }
          }
        });
      }
      if (Array.isArray(feedback.dislikedArtists)) {
        feedback.dislikedArtists.forEach(a => {
          if (a && typeof a === 'string') {
            const tr = a.trim();
            if (tr && !artists.includes(tr)) artists.push(tr);
          }
        });
      }
    }

    const bArtists = typeof getBlockedArtists === 'function' ? getBlockedArtists() : [];
    bArtists.forEach(a => {
      if (a && typeof a === 'string') {
        const tr = a.trim();
        if (tr && !artists.includes(tr)) artists.push(tr);
      }
    });

    const bTracks = typeof getBlockedTracks === 'function' ? getBlockedTracks() : [];
    bTracks.forEach(bt => {
      if (!bt) return;
      if (bt.key) keys.push(bt.key);
      if (bt.id) keys.push(bt.id);
      if (bt.artist && bt.title && typeof getTrackNormalizedKey === 'function') {
        keys.push(getTrackNormalizedKey(bt.artist, bt.title));
      }
    });

    return {
      keys: Array.from(new Set(keys)),
      artists
    };
  }

  async function computeTasteProfile(maxSeeds = 8) {
    const avoid = typeof getWaveAvoid === 'function' ? getWaveAvoid() : { keys: [], artists: [] };
    const feedback = typeof getMixFeedback === 'function' ? getMixFeedback() : null;

    const dislikedArtistSet = new Set();
    if (avoid && Array.isArray(avoid.artists)) {
      avoid.artists.forEach(a => {
        if (a) dislikedArtistSet.add(normalizeArtistName(a));
      });
    }
    if (feedback && Array.isArray(feedback.dislikedArtists)) {
      feedback.dislikedArtists.forEach(a => {
        if (a) dislikedArtistSet.add(normalizeArtistName(a));
      });
    }

    const dislikedTrackKeySet = new Set();
    if (avoid && Array.isArray(avoid.keys)) {
      avoid.keys.forEach(k => {
        if (k) dislikedTrackKeySet.add(String(k).trim().toLowerCase());
      });
    }
    if (feedback && Array.isArray(feedback.dislikedTracks)) {
      feedback.dislikedTracks.forEach(t => {
        if (!t) return;
        if (typeof t === 'string') {
          dislikedTrackKeySet.add(t.trim().toLowerCase());
        } else {
          if (t.key) dislikedTrackKeySet.add(String(t.key).trim().toLowerCase());
          if (t.id) dislikedTrackKeySet.add(String(t.id).trim().toLowerCase());
          if (t.artist && t.title && typeof getTrackNormalizedKey === 'function') {
            dislikedTrackKeySet.add(getTrackNormalizedKey(t.artist, t.title).toLowerCase());
          }
        }
      });
    }

    const favs = Array.isArray(state.favorites) ? state.favorites : [];
    const hist = Array.isArray(state.history) ? state.history : [];

    let cyrillicCount = 0;
    const durations = [];
    const allTracks = [...favs, ...hist];

    allTracks.forEach(track => {
      if (!track) return;
      if (track.title && /[\u0400-\u04FF]/.test(track.title)) {
        cyrillicCount++;
      }
      if (track.duration > 0) {
        durations.push(track.duration);
      }
    });

    const seenHistCanIds = new Set();
    const canIdRepeatBonus = new Map();
    const canIdRecency = new Map();

    hist.forEach((track, index) => {
      if (!track) return;
      const rawCanId = String(track.id || track.url || track.key || (typeof getTrackCanonicalId === 'function' ? getTrackCanonicalId(track) : '') || '').trim();
      const normKey = (track.artist && track.title && typeof getTrackNormalizedKey === 'function') ? getTrackNormalizedKey(track.artist, track.title) : '';
      const effectiveCanId = rawCanId || normKey;
      if (!effectiveCanId) return;

      if (!seenHistCanIds.has(effectiveCanId)) {
        seenHistCanIds.add(effectiveCanId);
        let recency;
        const ts = Number(track.playedAt || track.timestamp || track.date || track.time);
        if (ts && !isNaN(ts) && ts > 0) {
          const ageDays = Math.max(0, (Date.now() - ts) / (1000 * 60 * 60 * 24));
          recency = Math.pow(0.5, ageDays / 21);
        } else {
          recency = Math.pow(0.97, index);
        }
        canIdRecency.set(effectiveCanId, recency);
      } else {
        const curBonus = canIdRepeatBonus.get(effectiveCanId) || 0;
        if (curBonus < 2.0) {
          canIdRepeatBonus.set(effectiveCanId, Math.min(2.0, curBonus + 0.5));
        }
      }
    });

    const mergedMap = new Map();

    function getOrCreateEntry(track) {
      if (!track || !track.artist || !track.title) return null;
      const artist = String(track.artist).trim();
      const title = String(track.title).trim();
      if (!artist || !title) return null;
      if (dislikedArtistSet.has(normalizeArtistName(artist))) return null;
      const normKey = (typeof getTrackNormalizedKey === 'function') ? getTrackNormalizedKey(artist, title) : '';
      if (!normKey || normKey === '::') return null;
      if (dislikedTrackKeySet.has(normKey.toLowerCase()) || (track.id && dislikedTrackKeySet.has(String(track.id).trim().toLowerCase()))) return null;

      if (!mergedMap.has(normKey)) {
        mergedMap.set(normKey, {
          artist,
          title,
          id: track.id || '',
          platform: track.platform || state.platform || 'youtube',
          weight: 0,
          seenHistCanIds: new Set(),
          favAdded: false
        });
      }
      const entry = mergedMap.get(normKey);
      if (!entry.id && track.id) {
        entry.id = track.id;
        entry.platform = track.platform || state.platform || 'youtube';
      }
      return { entry, normKey };
    }

    favs.forEach(track => {
      const res = getOrCreateEntry(track);
      if (!res) return;
      const { entry } = res;
      if (!entry.favAdded) {
        entry.weight += 3;
        entry.favAdded = true;
      }
    });

    hist.forEach(track => {
      const res = getOrCreateEntry(track);
      if (!res) return;
      const { entry, normKey } = res;
      const rawCanId = String(track.id || track.url || track.key || (typeof getTrackCanonicalId === 'function' ? getTrackCanonicalId(track) : '') || '').trim();
      const effectiveCanId = rawCanId || normKey;

      if (!entry.seenHistCanIds.has(effectiveCanId)) {
        entry.seenHistCanIds.add(effectiveCanId);
        const recency = canIdRecency.get(effectiveCanId) || 0;
        const repeatBonus = canIdRepeatBonus.get(effectiveCanId) || 0;
        entry.weight += (recency + repeatBonus);
      }
    });

    if (feedback && Array.isArray(feedback.likedTracks)) {
      feedback.likedTracks.forEach(track => {
        const res = getOrCreateEntry(track);
        if (!res) return;
        const { entry } = res;
        entry.weight += 3;
      });
    }

    const artistWeights = {};
    const artistDisplayNames = {};
    mergedMap.forEach(item => {
      if (item.artist) {
        const a = item.artist.trim();
        const normArtist = normalizeArtistName(a);
        if (normArtist) {
          artistWeights[normArtist] = (artistWeights[normArtist] || 0) + item.weight;
          if (!artistDisplayNames[normArtist]) {
            artistDisplayNames[normArtist] = a;
          }
        }
      }
    });

    if (feedback && Array.isArray(feedback.likedArtists)) {
      feedback.likedArtists.forEach(a => {
        if (!a || typeof a !== 'string') return;
        const tr = a.trim();
        const normA = normalizeArtistName(tr);
        if (normA) {
          artistWeights[normA] = (artistWeights[normA] || 0) + 4;
          if (!artistDisplayNames[normA]) {
            artistDisplayNames[normA] = tr;
          }
        }
      });
    }

    const sortedArtists = Object.entries(artistWeights)
      .sort((a, b) => b[1] - a[1])
      .map(([normArtist]) => artistDisplayNames[normArtist]);

    const seeds = Array.from(mergedMap.values())
      .filter(s => s.artist && s.title && s.artist.trim() && s.title.trim())
      .sort((a, b) => b.weight - a.weight)
      .slice(0, maxSeeds)
      .map(s => ({
        artist: s.artist,
        title: s.title,
        id: s.id,
        platform: s.platform || 'youtube',
        weight: Math.round(s.weight * 1000) / 1000
      }));

    const dominantScript = cyrillicCount > (allTracks.length ? allTracks.length * 0.35 : 0) ? 'Cyrillic' : 'Latin';
    const avgDuration = durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null;

    return {
      trackCount: Math.max(mergedMap.size, favs.length),
      topArtists: sortedArtists.slice(0, 5),
      dominantScript,
      avgDuration,
      bpmLabel: null,
      energyLabel: null,
      seeds
    };
  }

  function renderMyWaveChips(profile) {
    const chipsContainer = document.getElementById('my-wave-chips');
    if (chipsContainer) chipsContainer.innerHTML = '';
  }

  const dominantColorsCache = new Map();

  function getCoverDominantColors(url) {
    if (!url) return Promise.resolve(['rgb(80, 80, 120)', 'rgb(120, 80, 100)']);
    if (dominantColorsCache.has(url)) {
      return Promise.resolve(dominantColorsCache.get(url));
    }
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'Anonymous';
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = 32;
          canvas.height = 32;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, 32, 32);
          const data = ctx.getImageData(0, 0, 32, 32).data;

          const buckets = new Map();
          for (let i = 0; i < data.length; i += 4) {
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            const brightness = (r * 299 + g * 587 + b * 114) / 1000;
            if (brightness < 30 || brightness > 230) continue;

            const qr = Math.round(r / 32) * 32;
            const qg = Math.round(g / 32) * 32;
            const qb = Math.round(b / 32) * 32;
            const key = `${qr},${qg},${qb}`;
            buckets.set(key, (buckets.get(key) || 0) + 1);
          }

          const sorted = Array.from(buckets.entries()).sort((a, b) => b[1] - a[1]);
          const c1 = sorted[0] ? `rgb(${sorted[0][0]})` : 'rgb(80, 100, 140)';
          const c2 = sorted[1] ? `rgb(${sorted[1][0]})` : sorted[0] ? `rgb(${sorted[0][0]})` : 'rgb(140, 80, 100)';

          const result = [c1, c2];
          dominantColorsCache.set(url, result);
          boundMap(dominantColorsCache, 20);
          canvas.width = 0;
          canvas.height = 0;
          img.onload = null;
          img.onerror = null;
          img.src = '';
          resolve(result);
        } catch (e) {
          const fallback = ['rgb(80, 100, 140)', 'rgb(140, 80, 100)'];
          dominantColorsCache.set(url, fallback);
          boundMap(dominantColorsCache, 20);
          img.onload = null;
          img.onerror = null;
          resolve(fallback);
        }
      };
      img.onerror = () => {
        if (img.crossOrigin) {
          img.crossOrigin = null;
          img.src = url;
          return;
        }
        const fallback = ['rgb(80, 100, 140)', 'rgb(140, 80, 100)'];
        dominantColorsCache.set(url, fallback);
        boundMap(dominantColorsCache, 20);
        img.onload = null;
        img.onerror = null;
        resolve(fallback);
      };
      img.src = url;
    });
  }

  function updateTextFade(el) {
    if (!el) return;
    el.classList.toggle('fade-end', el.scrollWidth > el.clientWidth);
  }

  window.addEventListener('resize', () => {
    ['my-wave-focused-title', 'my-wave-focused-artist', 'jump-focused-title', 'jump-focused-artist'].forEach(id => {
      const el = document.getElementById(id);
      if (el) updateTextFade(el);
    });
  });

  let ambientIdx = 0;
  let currentAmbientUrl = null;
  async function setHomeAmbient(url) {
    const box = document.getElementById('home-ambient');
    if (!box) return;
    const layers = box.querySelectorAll('.home-ambient-layer');
    if (!url) {
      currentAmbientUrl = null;
      layers.forEach(l => {
        l.classList.remove('on');
        l.style.background = '';
      });
      return;
    }
    currentAmbientUrl = url;
    try {
      const [c1, c2] = await getCoverDominantColors(url);
      if (currentAmbientUrl !== url) return;
      const next = layers[ambientIdx ^ 1];
      const prev = layers[ambientIdx];
      const gradient = `radial-gradient(circle 550px at 28% 35%, ${c1} 0%, transparent 68%), radial-gradient(circle 550px at 72% 65%, ${c2} 0%, transparent 68%)`;
      if (next) {
        next.style.backgroundImage = 'none';
        next.style.background = gradient;
        next.classList.add('on');
      }
      if (prev) {
        prev.classList.remove('on');
      }
      ambientIdx ^= 1;
    } catch (e) {
      console.warn('Ambient error:', e);
    }
  }

  function syncHomeAmbientVisibility() {
    const ambient = document.getElementById('home-ambient');
    if (!ambient) return;
    const isDiscoverActive = state.currentView === 'discover' && el.viewDiscover && el.viewDiscover.classList.contains('active');
    const isSearchShowing = el.searchResultsContainer && !el.searchResultsContainer.classList.contains('hidden');
    const isDiscoverEmptyShowing = el.discoverEmpty && !el.discoverEmpty.classList.contains('hidden');
    const hasModes = typeof availableModes === 'function' ? availableModes().length > 0 : true;
    const isAmbientEnabled = getAdv('my_wave_ambient', true);

    const shouldShow = isDiscoverActive && !isSearchShowing && isDiscoverEmptyShowing && hasModes && isAmbientEnabled;
    ambient.classList.toggle('ambient-hidden', !shouldShow);
    ambient.style.display = shouldShow ? '' : 'none';
  }

  async function updateAmbientLight(ambientEl, thumbnailUrl) {
    let url = '';
    if (typeof thumbnailUrl === 'string') {
      url = thumbnailUrl;
    } else if (typeof ambientEl === 'string') {
      if (ambientEl === 'my-wave-ambient-light' || ambientEl === 'jump-ambient-light') {
        url = typeof thumbnailUrl === 'string' ? thumbnailUrl : '';
      } else {
        url = ambientEl;
      }
    } else if (ambientEl && typeof ambientEl === 'object' && typeof thumbnailUrl === 'string') {
      url = thumbnailUrl;
    }

    syncHomeAmbientVisibility();
    setHomeAmbient(url);
  }

  let currentWaveFocusedIndex = 0;

  async function extendMyWaveQueue() {
    if (!state.myWaveActive || isExtendingMyWave) return false;
    isExtendingMyWave = true;
    try {
      const profile = await computeTasteProfile();
      const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/vibe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          history: (state.history || []).slice(0, 30),
          favorites: (state.favorites || []).slice(0, 25),
          platform: 'youtube',
          limit: 8,
          clientProfile: profile,
          seeds: profile.seeds,
          avoid: getWaveAvoid()
        })
      });
      const data = await res.json();
      if (data.success && Array.isArray(data.tracks) && data.tracks.length > 0) {
        const existingIds = new Set(state.queue.map(t => getTrackCanonicalId(t)));
        const existingKeys = new Set(state.queue.map(t => getTrackNormalizedKey(t.artist, t.title)));
        const newTracks = data.tracks.filter(t => {
          const cid = getTrackCanonicalId(t);
          const nkey = getTrackNormalizedKey(t.artist, t.title);
          return !existingIds.has(cid) && !existingKeys.has(nkey);
        });
        if (newTracks.length > 0) {
          state.queue.push(...newTracks);
          updateQueueBadge();
          renderQueueView();
          return true;
        }
      }
      return false;
    } catch (e) {
      return false;
    } finally {
      isExtendingMyWave = false;
    }
  }

  async function ensureInfiniteWaveQueue(force = false) {
    if (!state.isRadioQueue && !force) return false;
    if (state._waveReplenishBusy) return false;
    const remaining = state.queue.length - 1 - state.queueIndex;
    if (!force && remaining > 3) return false;
    state._waveReplenishBusy = true;
    try {
      const port = state.serverPort || 38472;
      const taste = typeof computeTasteProfile === 'function' ? computeTasteProfile() : { seeds: [], topArtists: [] };
      const avoid = typeof getWaveAvoid === 'function' ? getWaveAvoid() : { ids: [], keys: [], artists: [] };
      const seenIds = new Set();
      const seenKeys = new Set();
      state.queue.slice(-60).forEach(t => {
        if (!t) return;
        if (t.id) seenIds.add(String(t.id));
        const k = (t.artist || '').toLowerCase().trim() + '::' + (t.title || '').toLowerCase().trim();
        if (k !== '::') seenKeys.add(k);
      });
      const mergedAvoid = {
        ids: Array.from(new Set([...(avoid.ids || []), ...seenIds])).slice(0, 120),
        keys: Array.from(new Set([...(avoid.keys || []), ...seenKeys])).slice(0, 120),
        artists: (avoid.artists || []).slice(0, 40)
      };
      const res = await fetch('http://127.0.0.1:' + port + '/api/vibe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: state.platform || 'ytmusic', seeds: taste.seeds || [], topArtists: taste.topArtists || [], avoid: mergedAvoid, count: 12 })
      });
      const data = await res.json();
      const incoming = Array.isArray(data && data.tracks) ? data.tracks : [];
      const fresh = [];
      for (const t of incoming) {
        if (!t || !t.title || (!t.id && !t.url)) continue;
        const tid = String(t.id || '');
        const tkey = (t.artist || '').toLowerCase().trim() + '::' + (t.title || '').toLowerCase().trim();
        if ((tid && seenIds.has(tid)) || seenKeys.has(tkey)) continue;
        if (tid) seenIds.add(tid);
        seenKeys.add(tkey);
        fresh.push(t);
      }
      if (fresh.length > 0) {
        const startIdx = state.queue.length;
        state.queue.push(...fresh);
        if (typeof rememberWaveShown === 'function') rememberWaveShown(fresh);
        updateQueueBadge();
        if (state.currentView === 'queue' && el.queueTracksList) {
          el.queueTracksList.querySelector('.empty-hint')?.remove();
          fresh.forEach((tr, i) => {
            const qIdx = startIdx + i;
            el.queueTracksList.appendChild(createTrackRow(tr, qIdx, state.currentTrack ? getTrackCanonicalId(state.currentTrack) : '', 'queue', state.queue, el.queueTracksList));
          });
        }
        return true;
      }
    } catch (_) {} finally { state._waveReplenishBusy = false; }
    return false;
  }

  async function playMyWave() {
    if (!myWaveCurrentTracks || myWaveCurrentTracks.length === 0) {
      const profile = await computeTasteProfile();
      if (profile.trackCount < 5) {
        showToast('Save at least 5 tracks to tune For you');
        return;
      }
      await loadHomePage();
    }
    if (myWaveCurrentTracks && myWaveCurrentTracks.length > 0) {
      state.isRadioQueue = true;
      state.myWaveActive = true;
      const startIdx = (currentWaveFocusedIndex >= 0 && currentWaveFocusedIndex < myWaveCurrentTracks.length) ? currentWaveFocusedIndex : 0;
      playTrack(myWaveCurrentTracks[startIdx], [...myWaveCurrentTracks], startIdx);
      showToast('Playing For you');
    }
  }

  const btnPlayMyWave = document.getElementById('btn-play-my-wave');
  if (btnPlayMyWave) {
    btnPlayMyWave.addEventListener('click', playMyWave);
  }

  if (el.btnRefreshVibe) {
    el.btnRefreshVibe.addEventListener('click', async () => {
      const btn = el.btnRefreshVibe;
      if (btn.classList.contains('loading')) return;

      const wrapper = document.querySelector('#section-my-wave .my-wave-carousel-wrapper');
      btn.classList.add('loading');
      if (wrapper) wrapper.classList.add('loading');

      let spinner = wrapper ? wrapper.querySelector('.my-wave-carousel-spinner') : null;
      if (!spinner && wrapper) {
        spinner = document.createElement('div');
        spinner.className = 'my-wave-carousel-spinner';
        spinner.innerHTML = `
          <div class="m3-spinner-container">
            <svg class="m3-circular-progress" viewBox="0 0 48 48">
              <circle class="m3-spinner-track" cx="24" cy="24" r="18" fill="none" stroke-width="4"></circle>
              <circle class="m3-spinner-head" cx="24" cy="24" r="18" fill="none" stroke-width="4"></circle>
            </svg>
          </div>
        `;
        wrapper.appendChild(spinner);
      }
      if (spinner) spinner.style.display = 'flex';

      try {
        const ok = await fetchPersonalVibe(true);
        if (!ok) {
          showToast('Could not refresh', 'error');
        }
      } catch (err) {
        showToast('Could not refresh', 'error');
      } finally {
        btn.classList.remove('loading');
        if (wrapper) wrapper.classList.remove('loading');
        if (spinner) spinner.style.display = 'none';
      }
    });
  }

  function scrollCarouselTo(row, idx) {
    if (!row) return;
    const cards = row.querySelectorAll('.my-wave-track-card');
    if (cards.length === 0) return;
    const clampedIdx = Math.max(0, Math.min(cards.length - 1, idx));
    row._targetIndex = clampedIdx;
    let step = 304;
    if (cards.length > 1) {
      step = cards[1].offsetLeft - cards[0].offsetLeft;
    } else if (cards.length === 1) {
      step = cards[0].offsetWidth + 24;
    }
    const maxScroll = Math.max(0, row.scrollWidth - row.clientWidth);
    const target = Math.max(0, Math.min(maxScroll, clampedIdx * step));
    row.scrollTo({ left: target, behavior: 'smooth' });
  }

  function updateCoverflowCards(row, titleEl, artistEl, ambientEl, tracks) {
    if (!row) row = document.getElementById('home-vibe-grid');
    if (!row) return;
    if (!tracks) {
      tracks = (row.id === 'home-vibe-grid')
        ? (homeMode === 'recent' ? jumpBackCurrentTracks : (homeMode === 'artists' ? favArtistsCurrentList : myWaveCurrentTracks))
        : jumpBackCurrentTracks;
    }
    if (!tracks || tracks.length === 0) return;
    const cards = row.querySelectorAll('.my-wave-track-card');
    if (cards.length === 0) return;

    if (!titleEl) titleEl = document.getElementById(row.id === 'home-vibe-grid' ? 'my-wave-focused-title' : 'jump-focused-title');
    if (!artistEl) artistEl = document.getElementById(row.id === 'home-vibe-grid' ? 'my-wave-focused-artist' : 'jump-focused-artist');
    if (!ambientEl) ambientEl = document.getElementById(row.id === 'home-vibe-grid' ? 'my-wave-ambient-light' : 'jump-ambient-light');

    let step = 304;
    if (cards.length > 1) {
      step = cards[1].offsetLeft - cards[0].offsetLeft;
    } else if (cards.length === 1) {
      step = cards[0].offsetWidth + 24;
    }
    if (!step || step <= 0) step = 304;

    const floatIndex = row.scrollLeft / step;
    const newFocused = Math.max(0, Math.min(cards.length - 1, Math.round(floatIndex)));
    if (typeof row._targetIndex === 'number' && Math.abs(row.scrollLeft - (row._targetIndex * step)) < 12) {
      row._targetIndex = undefined;
    }

    cards.forEach((card, j) => {
      const dist = Math.abs(j - newFocused);
      card.classList.remove('near', 'far');
      if (dist === 0) {
        card.style.zIndex = '10';
      } else if (dist === 1) {
        card.classList.add('near');
        card.style.zIndex = '5';
      } else {
        card.classList.add('far');
        card.style.zIndex = '1';
      }
    });

    const prevFocused = (typeof row._focusedIndex === 'number') ? row._focusedIndex : -1;
    if (newFocused !== prevFocused && tracks[newFocused]) {
      row._focusedIndex = newFocused;
      if (row.id === 'home-vibe-grid') {
        currentWaveFocusedIndex = newFocused;
      }
      const item = tracks[newFocused];
      if (titleEl && artistEl) {
        if (homeMode === 'artists') {
          titleEl.textContent = item.name || 'Unknown';
          const pText = item.plays > 0
            ? `${formatCount(item.plays)} play${item.plays === 1 ? '' : 's'}`
            : (item.fans > 0 ? `${formatCount(item.fans)} fans` : '0 plays');
          artistEl.textContent = pText;
        } else {
          titleEl.textContent = item.title || 'Untitled';
          artistEl.textContent = item.artist || 'Unknown';
        }
        updateTextFade(titleEl);
        updateTextFade(artistEl);
      }
      if (homeMode === 'artists') {
        updateAmbientLight(ambientEl, '');
      } else {
        const thumb = (typeof getTrackThumbUrl === 'function' ? getTrackThumbUrl(item) : '') || item.thumbnail || item.cover || item.image || '';
        updateAmbientLight(ambientEl, thumb);
      }
    }
  }

  function getJumpBackTracks() {
    const raw = Array.isArray(state.history) ? state.history : [];
    const seen = new Set();
    const tracks = [];
    for (const t of raw) {
      if (!t || typeof t !== 'object') continue;
      const canId = (typeof getTrackCanonicalId === 'function' ? getTrackCanonicalId(t) : '') || t.id || `${t.artist || ''}::${t.title || ''}`;
      if (seen.has(canId)) continue;
      seen.add(canId);
      const thumb = (typeof getTrackThumbUrl === 'function' ? getTrackThumbUrl(t) : '') || t.thumbnail || t.cover || t.image || t.localThumbnail || '';
      tracks.push({
        ...t,
        thumbnail: thumb,
        title: t.title || 'Untitled',
        artist: t.artist || t.uploader || 'Unknown artist'
      });
      if (tracks.length >= 15) break;
    }
    return tracks;
  }

  function buildHomeCard(track, mode, idx) {
    const card = document.createElement('div');
    card.className = 'my-wave-track-card';
    if (typeof idx === 'number') card.dataset.index = String(idx);
    const thumbUrl = (typeof getTrackThumbUrl === 'function' ? getTrackThumbUrl(track) : '') || track.thumbnail || track.cover || track.image || '';
    card.innerHTML = `
      <div class="my-wave-track-cover-wrap">
        <img class="my-wave-track-cover" src="${escapeHtml(thumbUrl)}" alt="" onerror="this.src='data:image/svg+xml;utf8,<svg xmlns=\\'http://www.w3.org/2000/svg\\' width=\\'280\\' height=\\'280\\' fill=\\'%23555\\'><rect width=\\'100%\\' height=\\'100%\\'/></svg>'">
        <div class="my-wave-track-play-overlay">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
        </div>
      </div>
    `;

    card.addEventListener('click', () => {
      const row = document.getElementById('home-vibe-grid');
      const curIdx = (typeof idx === 'number') ? idx : parseInt(card.dataset.index, 10);
      const focusedIndex = (row && typeof row._focusedIndex === 'number') ? row._focusedIndex : 0;
      if (curIdx === focusedIndex) {
        if (mode === 'wave') {
          state.isRadioQueue = true;
          state.myWaveActive = true;
          const waveQueue = [...myWaveCurrentTracks];
          playTrack(track, waveQueue, curIdx);
        } else {
          state.isRadioQueue = false;
          state.myWaveActive = false;
          const recentTracks = jumpBackCurrentTracks.length > 0 ? jumpBackCurrentTracks : getJumpBackTracks();
          playTrack(track, [...recentTracks], curIdx);
        }
      } else if (row) {
        scrollCarouselTo(row, curIdx);
      }
    });

    return card;
  }

  function getWaveSpinnerHtml() {
    return `
      <div class="m3-spinner-container" style="margin: auto;">
        <svg class="m3-circular-progress" viewBox="0 0 48 48">
          <circle class="m3-spinner-track" cx="24" cy="24" r="18" fill="none" stroke-width="4"></circle>
          <circle class="m3-spinner-head" cx="24" cy="24" r="18" fill="none" stroke-width="4"></circle>
        </svg>
      </div>
    `;
  }

  function renderHomeCarousel(mode) {
    if (!mode) mode = homeMode || 'wave';
    homeMode = mode;

    const headerLabel = document.querySelector('#section-my-wave .home-pane-label');
    if (headerLabel) {
      const waveLabel = (state.isHotPicks && state.hotPicksTitle) ? state.hotPicksTitle : 'For you';
      headerLabel.textContent = (mode === 'recent') ? 'Jump back in' : (mode === 'artists' ? 'Favorite artists' : waveLabel);
      headerLabel.style.cursor = availableModes().length > 1 ? 'pointer' : 'default';
      headerLabel.style.pointerEvents = 'auto';
      if (!headerLabel._hasToggleListener) {
        headerLabel._hasToggleListener = true;
        headerLabel.addEventListener('click', () => {
          const avail = availableModes();
          if (avail.length > 1) {
            const curIdx = avail.indexOf(homeMode);
            const nextIdx = (curIdx + 1) % avail.length;
            if (nextIdx !== -1) {
              switchHomeMode(nextIdx - curIdx);
            }
          }
        });
      }
    }
    const actions = document.querySelector('#section-my-wave .my-wave-actions');
    if (actions) {
      actions.style.display = (mode === 'wave') ? '' : 'none';
    }

    const vibeGrid = document.getElementById('home-vibe-grid');
    const focusedMeta = document.getElementById('my-wave-focused-meta');
    if (!vibeGrid) return;

    if (mode === 'recent') {
      jumpBackCurrentTracks = getJumpBackTracks();
    } else if (mode === 'artists') {
      favArtistsCurrentList = getFavoriteArtistsList();
    }
    const source = (mode === 'recent') ? jumpBackCurrentTracks : (mode === 'artists' ? favArtistsCurrentList : myWaveCurrentTracks);

    vibeGrid.innerHTML = '';

    if (!source || source.length === 0) {
      if (focusedMeta) focusedMeta.innerHTML = '';
      if (mode === 'recent') {
        vibeGrid.innerHTML = `<div class="vibe-empty-hint">Play some tracks to see them here</div>`;
      } else if (mode === 'artists') {
        vibeGrid.innerHTML = `<div class="vibe-empty-hint">Follow some artists to see them here</div>`;
      } else {
        vibeGrid.innerHTML = getWaveSpinnerHtml();
      }
      updateAmbientLight('my-wave-ambient-light', '');
      return;
    }

    const fragment = document.createDocumentFragment();
    if (mode === 'artists') {
      source.forEach((artistObj, idx) => {
        fragment.appendChild(buildFavArtistCircleCard(artistObj, true, idx));
      });
    } else {
      source.forEach((track, idx) => {
        fragment.appendChild(buildHomeCard(track, mode, idx));
      });
    }
    vibeGrid.appendChild(fragment);

    const firstThumb = (mode === 'artists') ? '' : ((typeof getTrackThumbUrl === 'function' ? getTrackThumbUrl(source[0]) : '') || source[0].thumbnail || source[0].cover || source[0].image || '');

    if (focusedMeta && source[0]) {
      if (mode === 'artists') {
        const item = source[0];
        const pText = item.plays > 0
          ? `${formatCount(item.plays)} play${item.plays === 1 ? '' : 's'}`
          : (item.fans > 0 ? `${formatCount(item.fans)} fans` : '0 plays');
        focusedMeta.innerHTML = `
          <div class="my-wave-focused-title" id="my-wave-focused-title">${escapeHtml(item.name || 'Unknown')}</div>
          <div class="my-wave-focused-artist" id="my-wave-focused-artist">${escapeHtml(pText)}</div>
        `;
        const titleEl = document.getElementById('my-wave-focused-title');
        const artistEl = document.getElementById('my-wave-focused-artist');
        if (titleEl) updateTextFade(titleEl);
        if (artistEl) updateTextFade(artistEl);
        updateAmbientLight('my-wave-ambient-light', '');
      } else {
        focusedMeta.innerHTML = `
          <div class="my-wave-focused-title" id="my-wave-focused-title">${escapeHtml(source[0].title || 'Untitled')}</div>
          <div class="my-wave-focused-artist" id="my-wave-focused-artist">${escapeHtml(source[0].artist || 'Unknown')}</div>
        `;
        const titleEl = document.getElementById('my-wave-focused-title');
        const artistEl = document.getElementById('my-wave-focused-artist');
        if (titleEl) updateTextFade(titleEl);
        if (artistEl) updateTextFade(artistEl);
        updateAmbientLight('my-wave-ambient-light', firstThumb);
      }
    }

    vibeGrid.scrollLeft = 0;
    vibeGrid._focusedIndex = -1;
    updateCoverflowCards(vibeGrid, document.getElementById('my-wave-focused-title'), document.getElementById('my-wave-focused-artist'), document.getElementById('my-wave-ambient-light'), source);
  }


  function availableModes() {
    const modes = [];
    if (getAdv('my_wave', true)) modes.push('wave');
    if (getAdv('jump_back', true)) modes.push('recent');
    if (getAdv('fav_artists', true)) modes.push('artists');
    return modes;
  }

  function updateHomeDots() {
    const dotsContainer = document.getElementById('home-hero-dots');
    if (!dotsContainer) return;
    const avail = availableModes();
    if (avail.length <= 1) {
      dotsContainer.style.display = 'none';
      dotsContainer.innerHTML = '';
      return;
    }
    dotsContainer.style.display = '';
    dotsContainer.innerHTML = '';
    avail.forEach(m => {
      const btn = document.createElement('button');
      const label = m === 'recent' ? 'Jump back in' : (m === 'artists' ? 'Favorite artists' : 'For you');
      btn.setAttribute('aria-label', label);
      btn.title = label;
      if (m === homeMode) btn.classList.add('active');
      btn.addEventListener('click', () => {
        if (m !== homeMode) {
          const curIdx = avail.indexOf(homeMode);
          const targetIdx = avail.indexOf(m);
          switchHomeMode(targetIdx - curIdx);
        }
      });
      dotsContainer.appendChild(btn);
    });
  }

  function switchHomeMode(dir) {
    const avail = availableModes();
    if (avail.length <= 1) return;
    const curIdx = avail.indexOf(homeMode);
    if (curIdx === -1) return;
    const targetIdx = curIdx + dir;
    if (targetIdx < 0 || targetIdx >= avail.length) return;
    const newMode = avail[targetIdx];
    if (newMode === homeMode) return;

    homeMode = newMode;
    localStorage.setItem('eclipse_home_pane', newMode);
    updateHomeDots();

    const isPerf = document.body.classList.contains('perf') || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (isPerf) {
      renderHomeCarousel(newMode);
      return;
    }

    const vibeGrid = document.getElementById('home-vibe-grid');
    const focusedMeta = document.getElementById('my-wave-focused-meta');
    const animTargets = [vibeGrid, focusedMeta].filter(Boolean);

    const shiftOut = dir > 0 ? '-16px' : '16px';
    const shiftIn = dir > 0 ? '16px' : '-16px';

    animTargets.forEach(el => {
      el.style.setProperty('--home-shift', shiftOut);
      el.classList.remove('home-in');
      el.classList.add('home-out');
    });

    setTimeout(() => {
      renderHomeCarousel(newMode);
      const newVibeGrid = document.getElementById('home-vibe-grid');
      const newFocusedMeta = document.getElementById('my-wave-focused-meta');
      const newTargets = [newVibeGrid, newFocusedMeta].filter(Boolean);
      newTargets.forEach(el => {
        el.style.setProperty('--home-in-shift', shiftIn);
        el.classList.remove('home-out');
        el.classList.add('home-in');
        setTimeout(() => {
          el.classList.remove('home-in');
        }, 260);
      });
    }, 180);
  }

  function initHomeHero() {
    const avail = availableModes();
    const hero = document.getElementById('home-hero') || document.querySelector('#view-discover .discover-content');
    const dots = document.getElementById('home-hero-dots');

    if (avail.length === 0) {
      if (hero) hero.style.display = 'none';
      if (dots) dots.style.display = 'none';
      const homeAmbient = document.getElementById('home-ambient');
      if (homeAmbient) homeAmbient.style.display = 'none';
      return;
    }

    if (hero) hero.style.display = '';

    if (!avail.includes(homeMode)) {
      homeMode = avail[0];
      localStorage.setItem('eclipse_home_pane', homeMode);
    }

    updateHomeDots();
    renderHomeCarousel(homeMode);
    syncHomeAmbientVisibility();
  }

  function stepCarouselFocus(delta) {
    const row = document.getElementById('home-vibe-grid');
    if (!row) return;
    const cards = row.querySelectorAll('.my-wave-track-card');
    if (cards.length === 0) return;
    const base = (typeof row._targetIndex === 'number')
      ? row._targetIndex
      : ((typeof row._focusedIndex === 'number') ? row._focusedIndex : 0);
    const next = Math.max(0, Math.min(cards.length - 1, base + delta));
    scrollCarouselTo(row, next);
  }

  function isDiscoverActive() {
    const view = document.getElementById('view-discover');
    return !!(view && view.classList.contains('active'));
  }

  function isFormInputFocused() {
    const activeEl = document.activeElement;
    if (!activeEl) return false;
    const tag = activeEl.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || activeEl.isContentEditable;
  }

  let isWheelModeLocked = false;
  let isCarouselWheelLocked = false;

  const viewDiscoverEl = document.getElementById('view-discover');
  if (viewDiscoverEl) {
    viewDiscoverEl.addEventListener('wheel', (e) => {
      if (!isDiscoverActive() || isFormInputFocused()) return;
      if (el.searchResultsContainer && !el.searchResultsContainer.classList.contains('hidden')) return;
      if (e.target.closest('#search-results-container')) return;
      const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      if (Math.abs(delta) < 8) return;
      if (isCarouselWheelLocked) return;
      e.preventDefault();
      isCarouselWheelLocked = true;
      setTimeout(() => { isCarouselWheelLocked = false; }, 85);
      stepCarouselFocus(delta > 0 ? 1 : -1);
    }, { passive: false });

    let touchStartY = 0;
    let touchStartX = 0;
    viewDiscoverEl.addEventListener('touchstart', (e) => {
      if (!isDiscoverActive()) return;
      if (el.searchResultsContainer && !el.searchResultsContainer.classList.contains('hidden')) return;
      if (e.touches.length > 0) {
        touchStartY = e.touches[0].clientY;
        touchStartX = e.touches[0].clientX;
      }
    }, { passive: true });

    viewDiscoverEl.addEventListener('touchend', (e) => {
      if (!isDiscoverActive()) return;
      if (el.searchResultsContainer && !el.searchResultsContainer.classList.contains('hidden')) return;
      if (e.changedTouches.length > 0) {
        const touchEndY = e.changedTouches[0].clientY;
        const touchEndX = e.changedTouches[0].clientX;
        const diffY = touchStartY - touchEndY;
        const diffX = touchStartX - touchEndX;
        const diff = Math.abs(diffX) >= Math.abs(diffY) ? diffX : diffY;
        if (Math.abs(diff) > 40) {
          stepCarouselFocus(diff > 0 ? 1 : -1);
        }
      }
    }, { passive: true });
  }

  window.addEventListener('keydown', (e) => {
    if (!isDiscoverActive() || isFormInputFocused()) return;
    if (el.searchResultsContainer && !el.searchResultsContainer.classList.contains('hidden')) return;

    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      stepCarouselFocus(-1);
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      stepCarouselFocus(1);
    }
  });

  function renderVibeCards(tracks) {
    if (!Array.isArray(tracks)) return;
    state.vibeTracks = tracks;
    myWaveCurrentTracks = tracks;
    currentWaveFocusedIndex = 0;
    if (typeof renderHomeCarousel === 'function') renderHomeCarousel('wave');
  }

  async function fetchPersonalVibe(forceRefresh = false) {
    const cachedWave = safeJson('eclipse_my_wave_cache', null);
    if (!forceRefresh && cachedWave && Array.isArray(cachedWave.tracks) && cachedWave.tracks.length > 0) {
      state.vibeTracks = cachedWave.tracks.filter(t => !isTrackBlocked(t) && !isArtistBlocked(t.artist));
      renderVibeCards(state.vibeTracks);
      if (typeof renderSpotifyHome === 'function') renderSpotifyHome();
      if (Date.now() - (cachedWave.ts || 0) < 4 * 3600 * 1000) return true;
    }
    return await loadHomePage(forceRefresh);
  }

  async function loadHomePage(isRefresh = false) {
    const jumpSection = document.getElementById('section-jump-back');
    if (jumpSection) {
      jumpSection.style.display = 'none';
    }

    const waveSection = document.getElementById('section-my-wave');
    if (waveSection) {
      waveSection.style.display = '';
    }

    if (!isRefresh) {
      jumpBackCurrentTracks = getJumpBackTracks();
      initHomeHero();
    }
    if (availableModes().length === 0) return false;

    if (!getAdv('my_wave', true)) {
      if (homeMode === 'recent') {
        renderHomeCarousel('recent');
      } else if (homeMode === 'artists') {
        renderHomeCarousel('artists');
      }
      return false;
    }

    const vibeGrid = document.getElementById('home-vibe-grid');
    const focusedMeta = document.getElementById('my-wave-focused-meta');

    if (!isRefresh && focusedMeta && homeMode === 'wave' && myWaveCurrentTracks.length === 0) {
      focusedMeta.innerHTML = `
        <div class="my-wave-skeleton-title-bar skeleton-shimmer"></div>
        <div class="my-wave-skeleton-artist-bar skeleton-shimmer"></div>
      `;
    }

    if (!isRefresh && vibeGrid && homeMode === 'wave' && myWaveCurrentTracks.length === 0) {
      vibeGrid.style.opacity = '1';
      vibeGrid.innerHTML = getWaveSpinnerHtml();
    }

    try {
      const profile = await computeTasteProfile();
      const vibePayload = {
        history: (state.history || []).slice(0, 30),
        favorites: (state.favorites || []).slice(0, 25),
        platform: 'youtube',
        limit: 10,
        clientProfile: profile,
        seeds: profile.seeds,
        avoid: getWaveAvoid()
      };
      if (isRefresh) {
        vibePayload.refresh = true;
      }
      let uniqueTracks = [];
      try {
        const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/vibe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(vibePayload)
        });

        const data = await res.json();
        if (data && data.success && Array.isArray(data.tracks) && data.tracks.length > 0) {
          const seenIds = new Set();
          const seenKeys = new Set();
          for (const t of data.tracks) {
            if (isTrackBlocked(t) || isArtistBlocked(t.artist)) continue;
            const cid = getTrackCanonicalId(t);
            const nkey = getTrackNormalizedKey(t.artist, t.title);
            if (!seenIds.has(cid) && !seenKeys.has(nkey)) {
              seenIds.add(cid);
              seenKeys.add(nkey);
              uniqueTracks.push(t);
            }
          }
          if (uniqueTracks.length > 0) {
            state.vibeTracks = uniqueTracks;
            try { localStorage.setItem('eclipse_my_wave_cache', JSON.stringify({ ts: Date.now(), tracks: state.vibeTracks })); } catch (_) {}
          }
        }
      } catch (_) {}

      state.isHotPicks = false;
      state.hotPicksTitle = '';

      if (uniqueTracks.length < 5) {
        try {
          const hotRes = await fetch(`http://127.0.0.1:${state.serverPort}/api/hot?limit=12`);
          const hotData = await hotRes.json();
          if (hotData && hotData.success && Array.isArray(hotData.tracks) && hotData.tracks.length > 0) {
            uniqueTracks = hotData.tracks.filter(t => !isTrackBlocked(t) && !isArtistBlocked(t.artist));
            state.isHotPicks = true;
            state.hotPicksTitle = hotData.title || `Hot picks ${new Date().getFullYear()}`;
          }
        } catch (_) {}
      }

      if (uniqueTracks.length === 0) {
        if (!isRefresh) {
          myWaveCurrentTracks = [];
          if (homeMode === 'wave') {
            if (focusedMeta) focusedMeta.innerHTML = '';
            if (vibeGrid) {
              vibeGrid.innerHTML = `
                <div class="my-wave-retry-container" style="display: flex; align-items: center; justify-content: center; gap: 8px; margin: auto; padding: 24px; color: var(--md-sys-color-on-surface-variant); font-size: 14px;">
                  <span>Couldn't load recommendations</span>
                  <button class="btn-icon-pill" id="btn-retry-vibe" title="Retry" aria-label="Retry" style="width: 32px; height: 32px;">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
                  </button>
                </div>
              `;
              const retryBtn = vibeGrid.querySelector('#btn-retry-vibe');
              if (retryBtn) {
                retryBtn.addEventListener('click', () => {
                  if (el.btnRefreshVibe) el.btnRefreshVibe.click();
                  else loadHomePage(true);
                });
              }
            }
            updateAmbientLight('my-wave-ambient-light', '');
          }
        }
        return false;
      }

      myWaveCurrentTracks = uniqueTracks;
      state.vibeTracks = uniqueTracks;
      try { localStorage.setItem('eclipse_my_wave_cache', JSON.stringify({ ts: Date.now(), tracks: state.vibeTracks })); } catch (_) {}
      currentWaveFocusedIndex = 0;
      if (homeMode === 'wave') {
        if (vibeGrid) {
          vibeGrid.style.transition = 'none';
          vibeGrid.style.opacity = '0';
        }
        renderHomeCarousel('wave');
        currentWaveFocusedIndex = 0;
        if (vibeGrid) {
          vibeGrid.scrollLeft = 0;
          vibeGrid._focusedIndex = 0;
          const firstCard = vibeGrid.querySelector('.my-wave-track-card');
          if (firstCard && document.activeElement && document.activeElement.closest('#home-vibe-grid')) {
            firstCard.focus();
          }
          vibeGrid.offsetHeight;
          vibeGrid.style.transition = 'opacity 250ms ease';
          vibeGrid.style.opacity = '1';
        }
      }
      if (state.serverPort && !state._homeReadyReported) {
        state._homeReadyReported = true;
        const nowPerf = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        fetch(`http://127.0.0.1:${state.serverPort}/api/network-diagnostics`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ homeReadyMs: Math.round(nowPerf) })
        }).catch(() => {});
      }
      return true;
    } catch (err) {
      if (!isRefresh) {
        myWaveCurrentTracks = [];
        if (homeMode === 'wave') {
          if (focusedMeta) focusedMeta.innerHTML = '';
          if (vibeGrid) {
            vibeGrid.innerHTML = `
              <div class="my-wave-retry-container" style="display: flex; align-items: center; justify-content: center; gap: 8px; margin: auto; padding: 24px; color: var(--md-sys-color-on-surface-variant); font-size: 14px;">
                <span>Couldn't load recommendations</span>
                <button class="btn-icon-pill" id="btn-retry-vibe" title="Retry" aria-label="Retry" style="width: 32px; height: 32px;">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
                </button>
              </div>
            `;
            const retryBtn = vibeGrid.querySelector('#btn-retry-vibe');
            if (retryBtn) {
              retryBtn.addEventListener('click', () => {
                if (el.btnRefreshVibe) el.btnRefreshVibe.click();
                else loadHomePage(true);
              });
            }
          }
          updateAmbientLight('my-wave-ambient-light', '');
        }
      }
      return false;
    }
  }

  const vibeGridEl = document.getElementById('home-vibe-grid');
  if (vibeGridEl) {
    vibeGridEl.addEventListener('scroll', () => {
      const curTracks = (homeMode === 'recent') ? jumpBackCurrentTracks : myWaveCurrentTracks;
      updateCoverflowCards(vibeGridEl, document.getElementById('my-wave-focused-title'), document.getElementById('my-wave-focused-artist'), document.getElementById('my-wave-ambient-light'), curTracks);
    }, { passive: true });
  }

  const quickRowEl = document.getElementById('home-quick-play-row');
  if (quickRowEl) {
    quickRowEl.addEventListener('scroll', () => {
      updateCoverflowCards(quickRowEl, document.getElementById('jump-focused-title'), document.getElementById('jump-focused-artist'), document.getElementById('jump-ambient-light'), jumpBackCurrentTracks);
    }, { passive: true });
  }

  function renderQuickAccess() {
    const sec = document.getElementById('sp-quick-sec');
    const container = document.getElementById('sp-quick');
    if (!sec || !container) return;
    if (!getAdv('jump_back', true)) {
      sec.hidden = true;
      return;
    }
    sec.hidden = false;
    container.innerHTML = '';

    const favCount = (state.favorites || []).length;
    const likedTile = document.createElement('div');
    likedTile.className = 'sp-tile';
    likedTile.innerHTML = `
      <div class="sp-heart">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
          <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>
        </svg>
      </div>
      <div class="sp-tile-text">
        <div class="sp-tile-title sp-fade">Liked songs</div>
        ${favCount > 0 ? `<div class="sp-tile-sub sp-fade">${favCount} songs</div>` : ''}
      </div>
    `;
    likedTile.addEventListener('click', () => {
      switchView('favorites');
    });
    container.appendChild(likedTile);

    const rawHist = Array.isArray(state.history) ? state.history : [];
    const seenTracks = new Set();
    const recentTracks = [];
    for (const t of rawHist) {
      if (!t) continue;
      const canId = (typeof getTrackCanonicalId === 'function' ? getTrackCanonicalId(t) : '') || t.id || `${t.artist || ''}::${t.title || ''}`;
      if (!canId || seenTracks.has(canId)) continue;
      seenTracks.add(canId);
      recentTracks.push(t);
      if (recentTracks.length >= 5) break;
    }

    recentTracks.forEach(track => {
      const tile = document.createElement('div');
      tile.className = 'sp-tile';
      const thumb = (typeof getTrackThumbUrl === 'function' ? getTrackThumbUrl(track) : '') || track.thumbnail || track.cover || '';
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.decoding = 'async';
      img.src = thumb;
      img.alt = '';
      const text = document.createElement('div');
      text.className = 'sp-tile-text';
      const title = document.createElement('div');
      title.className = 'sp-tile-title sp-fade';
      title.textContent = track.title || 'Untitled';
      const sub = document.createElement('div');
      sub.className = 'sp-tile-sub sp-fade';
      sub.textContent = track.artist || track.uploader || 'Unknown artist';
      text.appendChild(title);
      text.appendChild(sub);
      tile.appendChild(img);
      tile.appendChild(text);
      tile.addEventListener('click', () => {
        playTrack(track);
      });
      container.appendChild(tile);
    });

    if (recentTracks.length < 5 && Array.isArray(state.playlists)) {
      const needed = 5 - recentTracks.length;
      const playlists = state.playlists.slice(0, needed);
      playlists.forEach(pl => {
        const tile = document.createElement('div');
        tile.className = 'sp-tile';
        const coverDiv = document.createElement('div');
        coverDiv.className = 'playlist-cover-art';
        renderPlaylistCover(coverDiv, pl, 64);
        const text = document.createElement('div');
        text.className = 'sp-tile-text';
        const title = document.createElement('div');
        title.className = 'sp-tile-title sp-fade';
        title.textContent = pl.name || 'Untitled';
        const sub = document.createElement('div');
        sub.className = 'sp-tile-sub sp-fade';
        const trackCount = (pl.tracks || []).length;
        sub.textContent = `${trackCount} tracks`;
        text.appendChild(title);
        text.appendChild(sub);
        tile.appendChild(coverDiv);
        tile.appendChild(text);
        tile.addEventListener('click', () => {
          openPlaylistDetail(pl.id);
        });
        container.appendChild(tile);
      });
    }
  }

  function getMix4Covers(mix) {
    if (!mix || !Array.isArray(mix.tracks)) return [];
    const covers = [];
    const seen = new Set();
    for (const t of mix.tracks) {
      if (!t) continue;
      const c = (typeof getTrackThumbUrl === 'function' ? getTrackThumbUrl(t) : '') || t.thumbnail || t.cover || '';
      if (c && !seen.has(c)) {
        seen.add(c);
        covers.push(c);
        if (covers.length === 4) break;
      }
    }
    if (covers.length < 4) {
      for (const t of mix.tracks) {
        if (!t) continue;
        const c = (typeof getTrackThumbUrl === 'function' ? getTrackThumbUrl(t) : '') || t.thumbnail || t.cover || '';
        if (c) {
          covers.push(c);
          if (covers.length === 4) break;
        }
      }
    }
    return covers;
  }

  function spCard({ cover, gridCovers, title, sub, onClick, isExplicit = false }) {
    const card = document.createElement('div');
    card.className = 'sp-card';

    const coverWrap = document.createElement('div');
    coverWrap.className = 'sp-card-cover';
    if (gridCovers && Array.isArray(gridCovers) && gridCovers.length >= 4) {
      const grid = document.createElement('div');
      grid.className = 'sp-grid-cover';
      gridCovers.slice(0, 4).forEach(c => {
        const gImg = document.createElement('img');
        gImg.loading = 'lazy';
        gImg.decoding = 'async';
        gImg.src = c || '';
        gImg.alt = '';
        grid.appendChild(gImg);
      });
      coverWrap.appendChild(grid);
    } else {
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.decoding = 'async';
      img.src = cover || '';
      img.alt = '';
      coverWrap.appendChild(img);
    }

    const titleEl = document.createElement('div');
    titleEl.className = 'sp-card-title sp-fade';
    titleEl.textContent = title || '';

    const subEl = document.createElement('div');
    subEl.className = 'sp-card-sub sp-fade';
    if (isExplicit) {
      const badge = document.createElement('span');
      badge.className = 'explicit-badge';
      badge.title = 'Explicit';
      badge.textContent = 'E';
      subEl.appendChild(badge);
    }
    const subText = document.createTextNode(sub || '');
    subEl.appendChild(subText);

    card.appendChild(coverWrap);
    card.appendChild(titleEl);
    card.appendChild(subEl);

    if (typeof onClick === 'function') {
      card.addEventListener('click', onClick);
    }
    return card;
  }

  let currentTrendingCategory = 'trending';
  let trendingHeroTimer = null;
  let trendingHeroIndex = 0;
  let trendingChipsBound = false;

  function renderTrendingShimmer(heroWrap, row) {
    if (heroWrap) {
      heroWrap.innerHTML = '<div class="trending-shimmer-hero"></div>';
    }
    if (row) {
      let shimmerHtml = '';
      for (let i = 0; i < 9; i++) {
        shimmerHtml += '<div class="trending-shimmer-item"></div>';
      }
      row.innerHTML = shimmerHtml;
    }
  }

  function renderTrendingHeroSpotlight(heroWrap, tracks) {
    if (!heroWrap) return;
    if (trendingHeroTimer) {
      clearInterval(trendingHeroTimer);
      trendingHeroTimer = null;
    }
    const spotlightTracks = (tracks || []).slice(0, 5);
    if (spotlightTracks.length === 0) {
      heroWrap.innerHTML = '';
      heroWrap.style.display = 'none';
      return;
    }
    heroWrap.style.display = '';

    if (trendingHeroIndex >= spotlightTracks.length) trendingHeroIndex = 0;

    function renderSlide(idx) {
      const track = spotlightTracks[idx];
      if (!track) return;
      const thumb = (typeof getTrackThumbUrl === 'function' ? getTrackThumbUrl(track) : '') || track.thumbnail || track.cover || '';
      const title = track.title || 'Untitled';
      const artist = track.artist || track.uploader || 'Unknown artist';
      const isCur = state.currentTrack && (state.currentTrack.id === track.id || (state.currentTrack.title === track.title && state.currentTrack.artist === track.artist));
      const isPlay = isCur && state.isPlaying;

      let dotsHtml = '';
      spotlightTracks.forEach((_, dIdx) => {
        dotsHtml += `<div class="trending-hero-dot${dIdx === idx ? ' active' : ''}" data-idx="${dIdx}"></div>`;
      });

      heroWrap.innerHTML = `
        <div class="trending-hero-card">
          <div class="trending-hero-backdrop" style="background-image: url('${thumb}');"></div>
          <div class="trending-hero-gradient"></div>
          <div class="trending-hero-left" id="trending-hero-play-trigger">
            <img src="${thumb}" alt="${escapeHtml(title)}" draggable="false" />
            <div class="hero-play-badge">
              <div class="hero-play-badge-btn">
                ${isPlay
                  ? '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>'
                  : '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" style="margin-left: 2px;"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>'
                }
              </div>
            </div>
          </div>
          <div class="trending-hero-info">
            <div class="trending-hero-tag">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2c1 4 5 5.5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3-1-6 1-9z"/></svg>
              <span>#${idx + 1} Spotlight</span>
            </div>
            <div class="trending-hero-title" title="${escapeHtml(title)}">${escapeHtml(title)}</div>
            <div class="trending-hero-artist" title="${escapeHtml(artist)}">${escapeHtml(artist)}</div>
            <div class="trending-hero-actions">
              <button type="button" class="trending-hero-play-btn" id="trending-hero-btn-play">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                <span>${isPlay ? (window.t ? t('Pause') : 'Pause') : (window.t ? t('Play now') : 'Play now')}</span>
              </button>
              <button type="button" class="trending-hero-radio-btn" id="trending-hero-btn-radio">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="2"></circle><path d="M16.24 7.76a6 6 0 0 1 0 8.49m-8.48-.01a6 6 0 0 1 0-8.49m11.31-2.82a10 10 0 0 1 0 14.14m-14.14 0a10 10 0 0 1 0-14.14"></path></svg>
                <span>${window.t ? t('Radio') : 'Radio'}</span>
              </button>
            </div>
          </div>
          <div class="trending-hero-dots-wrap" id="trending-hero-dots-wrap">
            ${dotsHtml}
          </div>
        </div>
      `;

      const playTrigger = heroWrap.querySelector('#trending-hero-play-trigger');
      const btnPlay = heroWrap.querySelector('#trending-hero-btn-play');
      const btnRadio = heroWrap.querySelector('#trending-hero-btn-radio');
      const dotsWrap = heroWrap.querySelector('#trending-hero-dots-wrap');

      const handlePlay = () => {
        if (isCur) {
          if (typeof togglePlayPause === 'function') togglePlayPause();
        } else {
          state.isRadioQueue = false;
          playTrack(track, [...spotlightTracks], idx);
        }
      };

      if (playTrigger) playTrigger.addEventListener('click', handlePlay);
      if (btnPlay) btnPlay.addEventListener('click', handlePlay);
      if (btnRadio) {
        btnRadio.addEventListener('click', () => {
          if (typeof startRadioForTrack === 'function') {
            startRadioForTrack(track);
          } else {
            handlePlay();
          }
        });
      }

      if (dotsWrap) {
        dotsWrap.querySelectorAll('.trending-hero-dot').forEach(d => {
          d.addEventListener('click', (e) => {
            e.stopPropagation();
            const targetIdx = parseInt(d.dataset.idx, 10);
            if (!isNaN(targetIdx) && targetIdx !== idx) {
              trendingHeroIndex = targetIdx;
              renderSlide(targetIdx);
            }
          });
        });
      }
    }

    renderSlide(trendingHeroIndex);

    let isHovered = false;
    heroWrap.onmouseenter = () => { isHovered = true; };
    heroWrap.onmouseleave = () => { isHovered = false; };

    trendingHeroTimer = setInterval(() => {
      if (isHovered || !heroWrap.isConnected) return;
      trendingHeroIndex = (trendingHeroIndex + 1) % spotlightTracks.length;
      renderSlide(trendingHeroIndex);
    }, 5500);
  }

  function renderTrendingRankedGrid(row, tracks) {
    if (!row) return;
    row.innerHTML = '';
    const filteredTracks = (tracks || []).filter(t => !isTrackBlocked(t) && !isArtistBlocked(t.artist));
    if (filteredTracks.length === 0) {
      row.innerHTML = '<div class="empty-hint" style="grid-column: 1 / -1; padding: 24px;">No tracks available</div>';
      return;
    }

    const frag = document.createDocumentFragment();
    filteredTracks.forEach((track, idx) => {
      const card = document.createElement('div');
      card.className = 'trending-rank-card';
      const isCur = state.currentTrack && (state.currentTrack.id === track.id || (state.currentTrack.title === track.title && state.currentTrack.artist === track.artist));
      if (isCur && state.isPlaying) {
        card.classList.add('active-playing');
      }

      const thumb = (typeof getTrackThumbUrl === 'function' ? getTrackThumbUrl(track) : '') || track.thumbnail || track.cover || '';
      const title = track.title || 'Untitled';
      const artist = track.artist || track.uploader || 'Unknown artist';
      const rankNum = idx + 1;
      let rankClass = '';
      if (rankNum === 1) rankClass = ' top-1';
      else if (rankNum === 2) rankClass = ' top-2';
      else if (rankNum === 3) rankClass = ' top-3';

      card.innerHTML = `
        <div class="trending-rank-badge${rankClass}">${rankNum}</div>
        <div class="trending-rank-thumb">
          <img src="${thumb}" alt="${escapeHtml(title)}" loading="lazy" draggable="false" />
          <div class="rank-play-hover">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" style="margin-left: 2px;"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
          </div>
        </div>
        <div class="trending-rank-text">
          <div class="trending-rank-title" title="${escapeHtml(title)}">${escapeHtml(title)}</div>
          <div class="trending-rank-artist" title="${escapeHtml(artist)}">${escapeHtml(artist)}</div>
        </div>
      `;

      card.addEventListener('click', () => {
        state.isRadioQueue = false;
        playTrack(track, [...filteredTracks], idx);
      });

      // Hover / focus instant preload with debounce
      card.addEventListener('mouseenter', () => {
        if (globalPreloadManager) globalPreloadManager.onTrackHover(track);
      });
      card.addEventListener('mouseleave', () => {
        if (globalPreloadManager) globalPreloadManager.onTrackLeave(track);
      });
      card.addEventListener('focusin', () => {
        if (globalPreloadManager) globalPreloadManager.onTrackHover(track);
      });
      card.addEventListener('focusout', () => {
        if (globalPreloadManager) globalPreloadManager.onTrackLeave(track);
      });

      card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (typeof showTrackContextMenu === 'function') {
          showTrackContextMenu(e, track, filteredTracks, idx);
        }
      });

      frag.appendChild(card);
    });

    row.appendChild(frag);
    bindHorizontalWheel(row);
    requestAnimationFrame(() => updateRowFade(row));
  }

  function bindTrendingFilterChips() {
    if (trendingChipsBound) return;
    const chipsContainer = document.getElementById('trending-filter-chips');
    if (!chipsContainer) return;
    trendingChipsBound = true;

    chipsContainer.querySelectorAll('.trending-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        const type = btn.dataset.type || 'trending';
        if (type === currentTrendingCategory) return;
        currentTrendingCategory = type;
        chipsContainer.querySelectorAll('.trending-chip').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        renderTrending(type, true);
      });
    });
  }

  async function renderTrending(targetCategory = null, forceRefresh = false) {
    const sec = document.getElementById('sp-trend-sec');
    const heroWrap = document.getElementById('trending-hero-wrap');
    const row = document.getElementById('sp-trend');
    if (!sec || !row) return;

    if (!getAdv('my_wave', true)) {
      sec.hidden = true;
      return;
    }
    sec.hidden = false;

    bindTrendingFilterChips();

    const category = targetCategory || currentTrendingCategory || 'trending';
    const cacheKey = 'eclipse_trending_cache_' + category;

    let hasCachedTracks = false;
    const cached = safeJson(cacheKey, null);
    if (!forceRefresh && cached && Array.isArray(cached.tracks) && cached.tracks.length > 0) {
      renderTrendingHeroSpotlight(heroWrap, cached.tracks);
      renderTrendingRankedGrid(row, cached.tracks);
      hasCachedTracks = true;
      if (globalPreloadManager) {
        globalPreloadManager.queueTrendingSequential(cached.tracks);
      }
    } else {
      renderTrendingShimmer(heroWrap, row);
    }

    try {
      const port = state.serverPort || 38472;
      const res = await fetch(`http://127.0.0.1:${port}/api/trending?category=${encodeURIComponent(category)}`);
      const data = await res.json();
      if (data && data.success && Array.isArray(data.tracks) && data.tracks.length > 0) {
        try {
          localStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), tracks: data.tracks }));
        } catch (_) {}
        renderTrendingHeroSpotlight(heroWrap, data.tracks);
        renderTrendingRankedGrid(row, data.tracks);
        sec.hidden = false;

        // Spec-compliant speculative preload for top 3 trending tracks
        if (globalPreloadManager) {
          globalPreloadManager.queueTrendingSequential(data.tracks);
        }
      } else if (!hasCachedTracks) {
        sec.hidden = true;
      }
    } catch (_) {
      if (!hasCachedTracks) {
        sec.hidden = true;
      }
    }
  }

  const MIX_KEY = 'eclipse_daily_mixes';

  function getLocalDateString() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  async function planMixes() {
    const profile = await computeTasteProfile(40);
    const seeds = (profile && Array.isArray(profile.seeds)) ? profile.seeds : [];
    if (seeds.length === 0) return [];

    const artistMap = new Map();
    for (const s of seeds) {
      if (!s || !s.artist) continue;
      const norm = normalizeArtistName(s.artist);
      if (!norm) continue;
      if (!artistMap.has(norm)) {
        artistMap.set(norm, { name: s.artist, tracks: [] });
      }
      artistMap.get(norm).tracks.push(s);
    }

    const artists = [];
    for (const [norm, entry] of artistMap.entries()) {
      entry.tracks.sort(() => Math.random() - 0.5);
      const topTracks = entry.tracks.slice(0, 2);
      const summedWeight = topTracks.reduce((sum, t) => sum + (t.weight || 0), 0);
      artists.push({
        norm,
        name: entry.name,
        tracks: topTracks,
        weight: summedWeight
      });
    }

    artists.sort((a, b) => b.weight - a.weight);
    const topArtists = artists.slice(0, 28);
    topArtists.sort((a, b) => (b.weight * (0.65 + Math.random() * 0.7)) - (a.weight * (0.65 + Math.random() * 0.7)));
    if (topArtists.length < 4) return [];

    const bucketCount = Math.min(5, Math.floor(topArtists.length / 2));
    const buckets = [];
    for (let i = 0; i < bucketCount; i++) {
      buckets.push({
        title: `Daily Mix ${i + 1}`,
        artists: [],
        seeds: []
      });
    }

    topArtists.forEach((art, rank) => {
      const b = buckets[rank % bucketCount];
      b.artists.push(art.name);
      b.seeds.push(...art.tracks);
    });

    buckets.forEach(b => {
      if (b.seeds.length > 6) b.seeds = b.seeds.slice(0, 6);
    });

    let validBuckets = buckets.filter(b => b.artists.length >= 2);
    if (validBuckets.length === 0 && buckets.length > 0) {
      validBuckets = [buckets[0]];
    }

    validBuckets.forEach((b, i) => {
      b.id = `daily-mix-${i + 1}`;
      b.title = `Daily Mix ${i + 1}`;
    });

    return validBuckets;
  }

  async function generateDailyMixes(force = false) {
    if (!getAdv('my_wave', true)) return null;
    const sp = (localStorage.getItem('eclipse_home_layout') || 'spotify') === 'spotify';
    if (!sp) return null;

    const today = getLocalDateString();
    let cached = null;
    try {
      const raw = localStorage.getItem(MIX_KEY);
      if (raw) cached = JSON.parse(raw);
    } catch (_) {}

    if (!force && cached && cached.day === today && Array.isArray(cached.mixes)) {
      return cached;
    }

    if (state.mixesBusy) return cached;
    state.mixesBusy = true;
    if (typeof beginBusy === 'function') beginBusy('vibe');

    let buckets = [];
    try {
      buckets = await planMixes();
    } catch (_) {}

    state._plannedMixCount = buckets.length;
    if (typeof renderMadeForYou === 'function') renderMadeForYou();

    const generatedMixes = [];
    try {
      const profile = await computeTasteProfile();
      for (let i = 0; i < buckets.length; i++) {
        const bucket = buckets[i];
        const payload = {
          history: (state.history || []).slice(0, 30),
          favorites: (state.favorites || []).slice(0, 25),
          platform: 'youtube',
          limit: 20,
          clientProfile: profile,
          seeds: bucket.seeds,
          avoid: typeof getWaveAvoid === 'function' ? getWaveAvoid() : []
        };

        try {
          const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/vibe`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          const data = await res.json();
          if (data && data.success && Array.isArray(data.tracks) && data.tracks.length >= 8) {
            generatedMixes.push({
              id: bucket.id || `daily-mix-${generatedMixes.length + 1}`,
              title: `Daily Mix ${generatedMixes.length + 1}`,
              artists: bucket.artists,
              tracks: data.tracks
            });
            localStorage.setItem(MIX_KEY, JSON.stringify({
              day: today,
              mixes: generatedMixes
            }));
            if (typeof renderMadeForYou === 'function') renderMadeForYou();
          }
        } catch (err) {
          break;
        }
      }
    } catch (err) {
    } finally {
      state.mixesBusy = false;
      delete state._plannedMixCount;
      if (typeof endBusy === 'function') endBusy('vibe');
      localStorage.setItem(MIX_KEY, JSON.stringify({
        day: today,
        mixes: generatedMixes
      }));
      if (typeof renderMadeForYou === 'function') renderMadeForYou();
    }
    return { day: today, mixes: generatedMixes };
  }

  function renderMadeForYou() {
    const sec = document.getElementById('sp-made-sec');
    const row = document.getElementById('sp-made');
    if (!sec || !row) return;

    if (!getAdv('my_wave', true)) {
      sec.hidden = true;
      return;
    }

    const today = getLocalDateString();
    let cached = null;
    try {
      const raw = localStorage.getItem(MIX_KEY);
      if (raw) cached = JSON.parse(raw);
    } catch (_) {}

    const mixes = (cached && cached.day === today && Array.isArray(cached.mixes)) ? cached.mixes : [];
    const hasWave = Array.isArray(myWaveCurrentTracks) && myWaveCurrentTracks.length > 0;

    if (!cached || cached.day !== today) {
      setTimeout(() => {
        if (!state.mixesBusy) generateDailyMixes(false);
      }, 3000);
    }

    if (!hasWave && mixes.length === 0 && !state.mixesBusy) {
      sec.hidden = true;
      return;
    }

    sec.hidden = false;
    row.innerHTML = '';

    let myWaveCard;
    if (hasWave) {
      const firstWaveTrack = myWaveCurrentTracks[0];
      const waveThumb = (typeof getTrackThumbUrl === 'function' ? getTrackThumbUrl(firstWaveTrack) : '') || firstWaveTrack.thumbnail || firstWaveTrack.cover || '';
      myWaveCard = spCard({
        cover: waveThumb,
        title: 'For you',
        sub: 'Based on your taste',
        onClick: playMyWave
      });
    } else {
      myWaveCard = document.createElement('div');
      myWaveCard.className = 'sp-card';
      const coverWrap = document.createElement('div');
      coverWrap.className = 'sp-card-cover';
      coverWrap.style.display = 'flex';
      coverWrap.style.alignItems = 'center';
      coverWrap.style.justifyContent = 'center';
      coverWrap.innerHTML = `
        <div class="m3-spinner-container" style="width: 32px; height: 32px; background: transparent;">
          <svg class="m3-circular-progress" viewBox="0 0 48 48" style="width: 24px; height: 24px;">
            <circle class="m3-spinner-track" cx="24" cy="24" r="18" fill="none" stroke-width="4"></circle>
            <circle class="m3-spinner-head" cx="24" cy="24" r="18" fill="none" stroke-width="4"></circle>
          </svg>
        </div>
      `;
      const titleEl = document.createElement('div');
      titleEl.className = 'sp-card-title sp-fade';
      titleEl.textContent = 'For you';
      const subEl = document.createElement('div');
      subEl.className = 'sp-card-sub sp-fade';
      subEl.textContent = 'Based on your taste';
      myWaveCard.appendChild(coverWrap);
      myWaveCard.appendChild(titleEl);
      myWaveCard.appendChild(subEl);
      myWaveCard.addEventListener('click', playMyWave);
    }
    row.appendChild(myWaveCard);

    mixes.forEach((mix, i) => {
      const fourCovers = getMix4Covers(mix);
      const cover = fourCovers[0] || '';
      const sub = (mix.artists && mix.artists.length > 0) ? mix.artists.join(', ') : '';
      const card = spCard({
        cover,
        gridCovers: fourCovers.length >= 4 ? fourCovers : null,
        title: mix.title || `Daily Mix ${i + 1}`,
        sub,
        onClick: () => {
          if (mix.tracks && mix.tracks.length > 0) {
            openAlbum({
              id: mix.id || `daily-mix-${i + 1}`,
              title: mix.title || `Daily Mix ${i + 1}`,
              type: 'Daily Mix',
              artist: (mix.artists && mix.artists.length > 0) ? mix.artists.join(', ') : 'Daily Mix',
              trackCount: mix.tracks.length,
              tracks: [...mix.tracks],
              gridCovers: fourCovers.length >= 4 ? fourCovers : null,
              cover: cover
            });
          }
        }
      });
      row.appendChild(card);
    });

    if (state.mixesBusy) {
      const totalToRender = Math.max(mixes.length, state._plannedMixCount || 5);
      for (let n = mixes.length + 1; n <= totalToRender; n++) {
        const phCard = document.createElement('div');
        phCard.className = 'sp-card';
        const coverWrap = document.createElement('div');
        coverWrap.className = 'sp-card-cover';
        coverWrap.style.display = 'flex';
        coverWrap.style.alignItems = 'center';
        coverWrap.style.justifyContent = 'center';
        coverWrap.innerHTML = `
          <div class="m3-spinner-container" style="width: 32px; height: 32px; background: transparent;">
            <svg class="m3-circular-progress" viewBox="0 0 48 48" style="width: 24px; height: 24px;">
              <circle class="m3-spinner-track" cx="24" cy="24" r="18" fill="none" stroke-width="4"></circle>
              <circle class="m3-spinner-head" cx="24" cy="24" r="18" fill="none" stroke-width="4"></circle>
            </svg>
          </div>
        `;
        const titleEl = document.createElement('div');
        titleEl.className = 'sp-card-title sp-fade';
        titleEl.textContent = `Daily Mix ${n}`;
        phCard.appendChild(coverWrap);
        phCard.appendChild(titleEl);
        row.appendChild(phCard);
      }
    }

    bindHorizontalWheel(row);
    requestAnimationFrame(() => updateRowFade(row));
  }

  const btnRegenMixes = document.getElementById('btn-regen-mixes');
  if (btnRegenMixes) {
    btnRegenMixes.addEventListener('click', (e) => {
      e.stopPropagation();
      fetchPersonalVibe(true).catch(() => {});
      if (state.mixesBusy) return;
      localStorage.removeItem(MIX_KEY);
      generateDailyMixes(true);
    });
  }

  let favArtistsFetchGen = 0;

  function renderFavArtistsHome() {
    const sec = document.getElementById('sp-artists-sec');
    const container = document.getElementById('sp-artists');
    if (!sec || !container) return;
    if (!getAdv('fav_artists', true)) {
      sec.style.display = 'none';
      return;
    }
    const artists = getFavoriteArtistsList();
    if (!artists || artists.length === 0) {
      sec.style.display = 'none';
      return;
    }
    sec.style.display = '';
    container.innerHTML = '';
    const frag = document.createDocumentFragment();
    const toFetch = [];
    artists.forEach(a => {
      const card = buildFavArtistCircleCard(a, false, 0, false);
      frag.appendChild(card);
      if (!a.avatar || !a.fans) {
        toFetch.push({ artist: a, card });
      }
    });
    container.appendChild(frag);

    if (toFetch.length > 0) {
      const gen = ++favArtistsFetchGen;
      const concurrency = Math.min(4, toFetch.length);
      let queueIdx = 0;
      const runWorker = async (initialDelay) => {
        if (initialDelay) await new Promise(r => setTimeout(r, initialDelay));
        while (queueIdx < toFetch.length) {
          if (gen !== favArtistsFetchGen) return;
          const item = toFetch[queueIdx++];
          if (!item) break;
          await fetchFavArtistMeta(item.artist, item.card);
          if (queueIdx < toFetch.length) {
            await new Promise(r => setTimeout(r, 200));
          }
        }
      };
      for (let i = 0; i < concurrency; i++) {
        runWorker(i * 200);
      }
    }
  }

  function renderSpotifyHome() {
    renderQuickAccess();
    renderTrending();
    renderMadeForYou();
    renderFavArtistsHome();
  }

  function applyHomeLayout() {
    const sp = (localStorage.getItem('eclipse_home_layout') || 'spotify') === 'spotify';
    document.body.classList.toggle('home-spotify', sp);
    const btnSp = document.getElementById('home-layout-spotify');
    const btnRiff = document.getElementById('home-layout-eclipse');
    if (btnSp) btnSp.classList.toggle('active', sp);
    if (btnRiff) btnRiff.classList.toggle('active', !sp);
    if (sp) renderSpotifyHome();
  }

  const btnHomeSpotify = document.getElementById('home-layout-spotify');
  const btnHomeRiff = document.getElementById('home-layout-eclipse');
  if (btnHomeSpotify) {
    btnHomeSpotify.addEventListener('click', () => {
      localStorage.setItem('eclipse_home_layout', 'spotify');
      applyHomeLayout();
    });
  }
  if (btnHomeRiff) {
    btnHomeRiff.addEventListener('click', () => {
      localStorage.setItem('eclipse_home_layout', 'riff');
      applyHomeLayout();
    });
  }

  cacheModal = document.getElementById('cache-modal');
  const cacheModalCard = document.querySelector('.cache-modal-card');
  const btnCancelCache = document.getElementById('btn-cancel-cache');
  const btnConfirmClearCache = document.getElementById('btn-confirm-clear-cache');
  const cacheAudioSize = document.getElementById('cache-audio-size');
  const cacheWebSize = document.getElementById('cache-web-size');

  const CACHE_BAR_MAX_BYTES = 4 * 1024 * 1024 * 1024;
  const CACHE_BAR_SAFE_STOP = 0.25;
  const CACHE_BAR_DANGER_STOP = 0.75;
  const CACHE_BAR_MIN_VISIBLE_PX = 4;

  const cacheBars = {
    audio: { canvas: document.getElementById('cache-audio-bar'), current: 0, from: 0, to: 0, t0: 0, dur: 0 },
    web: { canvas: document.getElementById('cache-web-bar'), current: 0, from: 0, to: 0, t0: 0, dur: 0 }
  };
  cacheRafId = 0;
  let cachePhase = 0;
  let cacheSpeed = 0.06;
  let cacheTargetSpeed = 0.06;
  let cacheBusy = false;
  let cacheColors = { primary: '#6750A4', dim: '#E6E0E9', warn: '#F9A825', error: '#B3261E' };

  function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  function animateValue(obj, start, end, duration) {
    let startTimestamp = null;
    const step = (timestamp) => {
      if (!startTimestamp) startTimestamp = timestamp;
      const progress = Math.min((timestamp - startTimestamp) / duration, 1);
      obj.textContent = formatBytes(Math.floor(progress * (end - start) + start));
      if (progress < 1) {
        window.requestAnimationFrame(step);
      }
    };
    window.requestAnimationFrame(step);
  }

  const cacheWait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function readCacheColors() {
    const rootStyle = getComputedStyle(document.documentElement);
    return {
      primary: rootStyle.getPropertyValue('--md-sys-color-primary').trim() || '#6750A4',
      dim: rootStyle.getPropertyValue('--md-sys-color-surface-container-highest-solid').trim() || '#E6E0E9',
      warn: '#F9A825',
      error: rootStyle.getPropertyValue('--md-sys-color-error').trim() || '#B3261E'
    };
  }

  function setCacheBarTarget(bar, bytes, duration) {
    bar.from = bar.current;
    bar.to = bytes;
    bar.t0 = performance.now();
    bar.dur = duration;
  }

  function drawCacheBar(canvas, bytes, phase) {
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const lineW = 6;
    const pad = lineW / 2;
    const centerY = h / 2;
    const usable = Math.max(1, w - lineW);

    ctx.lineWidth = lineW;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.beginPath();
    ctx.moveTo(pad, centerY);
    ctx.lineTo(w - pad, centerY);
    ctx.strokeStyle = cacheColors.dim;
    ctx.stroke();

    if (bytes <= 0) return;
    const frac = Math.min(1, Math.max(0, bytes / CACHE_BAR_MAX_BYTES));
    const fillW = Math.max(frac * usable, CACHE_BAR_MIN_VISIBLE_PX);
    const endX = pad + fillW;

    const grad = ctx.createLinearGradient(pad, 0, w - pad, 0);
    grad.addColorStop(0, cacheColors.primary);
    grad.addColorStop(CACHE_BAR_SAFE_STOP, cacheColors.primary);
    grad.addColorStop((CACHE_BAR_SAFE_STOP + CACHE_BAR_DANGER_STOP) / 2, cacheColors.warn);
    grad.addColorStop(CACHE_BAR_DANGER_STOP, cacheColors.error);
    grad.addColorStop(1, cacheColors.error);

    const amplitude = 4;
    const freq = 0.12;
    ctx.beginPath();
    for (let x = pad; x <= endX; x++) {
      const distFromEnd = endX - x;
      const damping = Math.min(1, distFromEnd / 14);
      const distFromStart = x - pad;
      const startDamping = Math.min(1, distFromStart / 14);
      const snakeWave = Math.sin(x * freq - phase) + 0.4 * Math.sin(x * freq * 0.5 - phase * 1.5);
      const y = centerY + snakeWave * (amplitude * damping * startDamping);
      if (x === pad) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = grad;
    ctx.stroke();
  }

  function cacheFrame(now) {
    if (document.hidden || !state.isWindowVisible || !cacheModal || !cacheModal.classList.contains('visible')) {
      cacheRafId = 0;
      return;
    }
    cacheSpeed += (cacheTargetSpeed - cacheSpeed) * 0.08;
    cachePhase += cacheSpeed;
    Object.keys(cacheBars).forEach((key) => {
      const bar = cacheBars[key];
      if (bar.dur > 0) {
        const p = Math.min(1, (now - bar.t0) / bar.dur);
        const ease = 1 - Math.pow(1 - p, 3);
        bar.current = bar.from + (bar.to - bar.from) * ease;
        if (p >= 1) bar.dur = 0;
      }
      drawCacheBar(bar.canvas, bar.current, cachePhase);
    });
    cacheRafId = requestAnimationFrame(cacheFrame);
  }

  function closeCacheModal() {
    if (!cacheModal) return;
    cacheModal.classList.remove('visible');
    setTimeout(() => {
      if (cacheModal.classList.contains('visible')) return;
      cacheModal.classList.add('hidden');
      if (cacheRafId) {
        cancelAnimationFrame(cacheRafId);
        cacheRafId = 0;
      }
      if (cacheModalCard) cacheModalCard.classList.remove('cleaning', 'finishing', 'done');
      if (btnConfirmClearCache) btnConfirmClearCache.disabled = false;
      if (btnCancelCache) btnCancelCache.disabled = false;
    }, 200);
  }

  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('#btn-open-clear-cache');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    if (!cacheModal || cacheBusy) return;

    cacheColors = readCacheColors();
    cacheSpeed = 0.06;
    cacheTargetSpeed = 0.06;
    Object.keys(cacheBars).forEach((key) => {
      const bar = cacheBars[key];
      bar.current = 0;
      bar.from = 0;
      bar.to = 0;
      bar.dur = 0;
    });
    if (cacheAudioSize) { cacheAudioSize.textContent = 'calculating...'; cacheAudioSize.dataset.val = '0'; }
    if (cacheWebSize) { cacheWebSize.textContent = 'calculating...'; cacheWebSize.dataset.val = '0'; }

    cacheModal.classList.remove('hidden');
    requestAnimationFrame(() => cacheModal.classList.add('visible'));
    if (!cacheRafId) cacheRafId = requestAnimationFrame(cacheFrame);

    let sizes = { audio: 0, web: 0 };
    try {
      if (window.electronAPI && window.electronAPI.getCacheSize) {
        sizes = await window.electronAPI.getCacheSize();
      }
    } catch (err) {
      console.warn('getCacheSize failed', err);
    }
    if (cacheAudioSize) { cacheAudioSize.textContent = formatBytes(sizes.audio); cacheAudioSize.dataset.val = String(sizes.audio); }
    if (cacheWebSize) { cacheWebSize.textContent = formatBytes(sizes.web); cacheWebSize.dataset.val = String(sizes.web); }
    setCacheBarTarget(cacheBars.audio, sizes.audio, 900);
    setCacheBarTarget(cacheBars.web, sizes.web, 900);
  });

  if (btnCancelCache) {
    btnCancelCache.addEventListener('click', () => {
      if (cacheBusy) return;
      closeCacheModal();
    });
  }

  if (btnConfirmClearCache) {
    btnConfirmClearCache.addEventListener('click', async () => {
      if (cacheBusy) return;
      cacheBusy = true;
      btnConfirmClearCache.disabled = true;
      if (btnCancelCache) btnCancelCache.disabled = true;

      cacheModalCard.classList.add('cleaning');
      cacheTargetSpeed = 0.2;

      const startAudio = parseInt(cacheAudioSize.dataset.val || '0', 10);
      const startWeb = parseInt(cacheWebSize.dataset.val || '0', 10);
      animateValue(cacheAudioSize, startAudio, 0, 1500);
      animateValue(cacheWebSize, startWeb, 0, 1500);
      setCacheBarTarget(cacheBars.audio, 0, 1500);
      setCacheBarTarget(cacheBars.web, 0, 1500);

      const startedAt = Date.now();
      try {
        await window.electronAPI.clearCache();
        if (window.electronAPI.cleanOldVersions) {
          await window.electronAPI.cleanOldVersions();
        }
      } catch (err) {
        console.warn('clearCache failed', err);
      }
      await cacheWait(Math.max(0, 1500 - (Date.now() - startedAt)));

      cacheModalCard.classList.add('finishing');
      cacheTargetSpeed = 0;
      await cacheWait(350);

      cacheModalCard.classList.remove('cleaning', 'finishing');
      cacheModalCard.classList.add('done');
      cacheAudioSize.dataset.val = '0';
      cacheWebSize.dataset.val = '0';
      await cacheWait(1200);

      cacheBusy = false;
      closeCacheModal();
    });
  }

  async function updateOfflineStorageUI() {
    const elSize = document.getElementById('offline-library-size');
    if (!elSize) return;
    try {
      const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/offline-library`);
      const data = await res.json();
      if (data && data.success) {
        elSize.textContent = `${data.count} track${data.count === 1 ? '' : 's'} (${formatBytes(data.totalBytes)})`;
      } else {
        elSize.textContent = '0 tracks (0 B)';
      }
    } catch (e) {
      elSize.textContent = 'Unavailable';
    }
  }

  async function updateMusicFolderUI() {
    const elPath = document.getElementById('music-folder-path');
    if (!elPath) return;
    try {
      if (window.electronAPI && window.electronAPI.getDataDir) {
        const info = await window.electronAPI.getDataDir();
        if (info && info.dir) {
          elPath.textContent = info.isCustom ? info.dir : `${info.dir} (default)`;
          return;
        }
      }
    } catch (e) {
      console.warn('getDataDir failed', e);
    }
    elPath.textContent = 'Unavailable';
  }

  const btnChangeMusicFolder = document.getElementById('btn-change-music-folder');
  if (btnChangeMusicFolder) {
    btnChangeMusicFolder.addEventListener('click', async () => {
      if (!window.electronAPI || !window.electronAPI.pickDataDir) return;
      if (btnChangeMusicFolder.disabled) return;
      let info = null;
      try { info = await window.electronAPI.getDataDir(); } catch (e) {}
      const dir = await window.electronAPI.pickDataDir();
      if (!dir) return;
      if (info && info.dir && dir === info.dir) {
        showToast('This is already the music folder');
        return;
      }
      const move = window.confirm(
        'Move your existing music to the new folder?\n\n' +
        'OK: move all downloaded and imported files, then restart Eclipse.\n' +
        'Cancel: switch to the new folder without moving (files stay in the old one).'
      );
      btnChangeMusicFolder.disabled = true;
      const originalLabel = btnChangeMusicFolder.textContent;
      btnChangeMusicFolder.textContent = move ? 'Moving...' : 'Switching...';
      showToast(move ? 'Moving your music, this may take a while...' : 'Switching music folder...');
      let res = null;
      try {
        res = await window.electronAPI.setDataDir(dir, move);
      } catch (e) {
        res = { ok: false, error: e.message };
      }
      if (!res || !res.ok) {
        showToast((res && res.error) || 'Could not change the music folder', 'error');
        btnChangeMusicFolder.disabled = false;
        btnChangeMusicFolder.textContent = originalLabel;
        return;
      }
      btnChangeMusicFolder.textContent = 'Restarting...';
      showToast('Restarting Eclipse...');
      setTimeout(() => { if (window.electronAPI.restartApp) window.electronAPI.restartApp(); }, 400);
    });
  }

  async function updateDownloadFolderUI() {
    const elPath = document.getElementById('download-folder-path');
    const btnReset = document.getElementById('btn-reset-download-folder');
    if (elPath) {
      try {
        if (window.electronAPI && window.electronAPI.getDownloadDir) {
          const info = await window.electronAPI.getDownloadDir();
          if (info && info.dir) {
            elPath.textContent = info.isCustom ? info.dir : `${info.dir} (default)`;
            if (btnReset) btnReset.classList.toggle('hidden', !info.isCustom);
            return;
          }
        }
      } catch (e) {
        console.warn('getDownloadDir failed', e);
      }
      elPath.textContent = 'Unavailable';
    }
    if (btnReset) btnReset.classList.add('hidden');
  }

  const btnChangeDownloadFolder = document.getElementById('btn-change-download-folder');
  if (btnChangeDownloadFolder) {
    btnChangeDownloadFolder.addEventListener('click', async () => {
      if (!window.electronAPI || !window.electronAPI.pickDownloadDir) return;
      if (btnChangeDownloadFolder.disabled) return;
      let info = null;
      try { info = await window.electronAPI.getDownloadDir(); } catch (e) {}
      const dir = await window.electronAPI.pickDownloadDir();
      if (!dir) return;
      if (info && info.dir && dir === info.dir) {
        showToast('This is already the download folder');
        return;
      }
      btnChangeDownloadFolder.disabled = true;
      let res = null;
      try {
        res = await window.electronAPI.setDownloadDir(dir);
      } catch (e) {
        res = { ok: false, error: e.message };
      }
      btnChangeDownloadFolder.disabled = false;
      if (!res || !res.ok) {
        showToast((res && res.error) || 'Could not change the download folder', 'error');
        return;
      }
      updateDownloadFolderUI();
      updateDownloadCaptionPath();
      showToast('Downloads will be saved to ' + res.dir);
    });
  }

  const btnResetDownloadFolder = document.getElementById('btn-reset-download-folder');
  if (btnResetDownloadFolder) {
    btnResetDownloadFolder.addEventListener('click', async () => {
      if (!window.electronAPI || !window.electronAPI.resetDownloadDir) return;
      if (btnResetDownloadFolder.disabled) return;
      btnResetDownloadFolder.disabled = true;
      let res = null;
      try {
        res = await window.electronAPI.resetDownloadDir();
      } catch (e) {
        res = { ok: false, error: e.message };
      }
      btnResetDownloadFolder.disabled = false;
      if (!res || !res.ok) {
        showToast((res && res.error) || 'Could not reset the download folder', 'error');
        return;
      }
      updateDownloadFolderUI();
      showToast('Download folder reset to default');
    });
  }

  const btnDeleteOfflineTrack = document.getElementById('btn-delete-offline-track');
  if (btnDeleteOfflineTrack) {
    btnDeleteOfflineTrack.addEventListener('click', async () => {
      if (!trackToDownload || !trackToDownload.id) return;
      try {
        await fetch(`http://127.0.0.1:${state.serverPort}/api/offline-delete?id=${encodeURIComponent(trackToDownload.id)}`, { method: 'POST' });
        showToast('Track removed from offline cache');
        updateOfflineStorageUI();
        if (el.downloadModal) closeModal(el.downloadModal);
      } catch (e) {
        showToast('Failed to delete offline track');
      }
    });
  }

  const btnClearOffline = document.getElementById('btn-clear-offline');
  const clearOfflineModal = document.getElementById('clear-offline-modal');
  const btnCancelClearOffline = document.getElementById('btn-cancel-clear-offline');
  const btnConfirmClearOffline = document.getElementById('btn-confirm-clear-offline');

  if (btnClearOffline && clearOfflineModal) {
    btnClearOffline.addEventListener('click', () => {
      openModal(clearOfflineModal);
    });
  }
  if (btnCancelClearOffline && clearOfflineModal) {
    btnCancelClearOffline.addEventListener('click', () => {
      closeModal(clearOfflineModal);
    });
  }
  if (btnConfirmClearOffline && clearOfflineModal) {
    btnConfirmClearOffline.addEventListener('click', async () => {
      try {
        await fetch(`http://127.0.0.1:${state.serverPort}/api/clear-offline-library`, { method: 'POST' });
        showToast('Offline library cleared');
        updateOfflineStorageUI();
      } catch (e) {
        showToast('Failed to clear offline library');
      }
      closeModal(clearOfflineModal);
    });
  }

  let toolsPollInterval = null;
  let toolsWavyYt = null;
  let toolsWavyFf = null;

  const STATUS_ICONS = {
    pending: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: var(--md-sys-color-outline);"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
    downloading: '<svg class="g-spinner" style="width: 18px; height: 18px;" viewBox="0 0 48 48"><circle cx="24" cy="24" r="20"/></svg>',
    done: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="color: #4cd964;"><polyline points="20 6 9 17 4 12"/></svg>',
    error: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: var(--md-sys-color-error, #ff5449);"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>'
  };

  function updateToolsUI(status) {
    if (!status) return;

    const isYtDlp = Boolean(status.ytdlp !== undefined ? status.ytdlp : status.ytDlp);
    const isFfmpeg = Boolean(status.ffmpeg);
    const isReady = isYtDlp && isFfmpeg;
    state.toolsReady = isReady;

    const prog = status.progress || {};
    const errorMsg = status.error || prog.error || '';
    const isError = Boolean(errorMsg || prog.status === 'error');
    const pct = typeof status.percent === 'number' ? status.percent : (typeof prog.percent === 'number' ? prog.percent : 0);
    const step = status.step || (prog.tool ? `downloading ${prog.tool}` : '');

    let activeTool = null;
    if (step.includes('yt-dlp') || prog.tool === 'yt-dlp') activeTool = 'yt-dlp';
    else if (step.includes('ffmpeg') || prog.tool === 'ffmpeg') activeTool = 'ffmpeg';
    else if (!isYtDlp) activeTool = 'yt-dlp';
    else if (!isFfmpeg) activeTool = 'ffmpeg';

    let ytdlpStatus = 'pending';
    let ffmpegStatus = 'pending';

    if (isReady) {
      ytdlpStatus = 'done';
      ffmpegStatus = 'done';
    } else if (isError) {
      if (activeTool === 'yt-dlp') {
        ytdlpStatus = 'error';
        ffmpegStatus = isFfmpeg ? 'done' : 'pending';
      } else {
        ytdlpStatus = isYtDlp ? 'done' : 'pending';
        ffmpegStatus = 'error';
      }
    } else if (activeTool === 'yt-dlp') {
      ytdlpStatus = 'downloading';
      ffmpegStatus = isFfmpeg ? 'done' : 'pending';
    } else if (activeTool === 'ffmpeg') {
      ytdlpStatus = 'done';
      ffmpegStatus = 'downloading';
    } else {
      ytdlpStatus = isYtDlp ? 'done' : 'pending';
      ffmpegStatus = isFfmpeg ? 'done' : 'pending';
    }

    const iconYt = document.getElementById('tools-icon-ytdlp');
    const iconFf = document.getElementById('tools-icon-ffmpeg');
    if (iconYt) iconYt.innerHTML = STATUS_ICONS[ytdlpStatus] || STATUS_ICONS.pending;
    if (iconFf) iconFf.innerHTML = STATUS_ICONS[ffmpegStatus] || STATUS_ICONS.pending;

    const pctYt = document.getElementById('tools-pct-ytdlp');
    const pctFf = document.getElementById('tools-pct-ffmpeg');
    if (pctYt) {
      pctYt.textContent = ytdlpStatus === 'downloading' ? `${pct}%` : (ytdlpStatus === 'done' ? 'Ready' : (ytdlpStatus === 'error' ? 'Failed' : ''));
    }
    if (pctFf) {
      pctFf.textContent = ffmpegStatus === 'downloading' ? `${pct}%` : (ffmpegStatus === 'done' ? 'Ready' : (ffmpegStatus === 'error' ? 'Failed' : ''));
    }

    const wrapYt = document.getElementById('tools-wavy-ytdlp');
    const wrapFf = document.getElementById('tools-wavy-ffmpeg');
    if (activeTool === 'yt-dlp' && ytdlpStatus === 'downloading') {
      if (wrapYt) {
        wrapYt.style.display = 'block';
        wrapYt.style.setProperty('--tools-progress', pct.toString());
        if (!toolsWavyYt && typeof createWavyProgress === 'function') toolsWavyYt = createWavyProgress(wrapYt);
        if (toolsWavyYt) toolsWavyYt.set(pct);
      }
      if (wrapFf) wrapFf.style.display = 'none';
    } else if (activeTool === 'ffmpeg' && ffmpegStatus === 'downloading') {
      if (wrapYt) wrapYt.style.display = 'none';
      if (wrapFf) {
        wrapFf.style.display = 'block';
        wrapFf.style.setProperty('--tools-progress', pct.toString());
        if (!toolsWavyFf && typeof createWavyProgress === 'function') toolsWavyFf = createWavyProgress(wrapFf);
        if (toolsWavyFf) toolsWavyFf.set(pct);
      }
    } else {
      if (wrapYt) wrapYt.style.display = 'none';
      if (wrapFf) wrapFf.style.display = 'none';
    }

    const errEl = document.getElementById('tools-error-msg');
    const btnDownload = document.getElementById('btn-confirm-install-tools');
    const btnRetry = document.getElementById('btn-retry-tools');
    const btnDismiss = document.getElementById('btn-dismiss-tools-modal');
    const btnClose = document.getElementById('btn-close-tools-modal');

    // CANNOT be closed or skipped: hide Cancel / Later / Skip / Close × buttons while missing
    if (btnClose) btnClose.style.display = 'none';
    if (btnDismiss) btnDismiss.style.display = 'none';
    if (btnDownload) btnDownload.style.display = 'none';

    if (isError) {
      if (errEl) {
        errEl.textContent = errorMsg || 'Installation failed';
        errEl.style.display = 'block';
      }
      if (btnRetry) {
        btnRetry.className = 'btn-pill-primary';
        btnRetry.textContent = 'Retry download';
        btnRetry.style.display = 'inline-flex';
      }
    } else {
      if (errEl) errEl.style.display = 'none';
      if (btnRetry) btnRetry.style.display = 'none';
    }

    const statusText = document.getElementById('tools-status-text');
    const btnInstall = document.getElementById('btn-install-tools');
    if (statusText) {
      if (isReady) {
        statusText.textContent = 'Installed';
        if (btnInstall) {
          btnInstall.classList.add('hidden');
          btnInstall.disabled = false;
        }
      } else if (isError) {
        statusText.textContent = 'Download failed';
        if (btnInstall) {
          btnInstall.classList.remove('hidden');
          btnInstall.disabled = false;
        }
      } else {
        const stepDesc = step || `downloading ${activeTool || 'tools'}`;
        statusText.textContent = `${stepDesc} ${pct}%`;
        if (btnInstall) {
          btnInstall.classList.remove('hidden');
          btnInstall.disabled = true;
        }
      }
    }

    if (isReady) {
      const modal = document.getElementById('tools-install-modal');
      if (modal) closeModal(modal);
    }
  }

  function pollToolsStatus() {
    if (toolsPollInterval) return;
    toolsPollInterval = setInterval(async () => {
      if (!state.serverPort) return;
      try {
        const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/tools/status`);
        const status = await res.json();
        updateToolsUI(status);
        const isReady = Boolean(status.ytdlp !== undefined ? status.ytdlp : status.ytDlp) && Boolean(status.ffmpeg);
        const isError = Boolean(status.error || (status.progress && status.progress.status === 'error'));
        if (isReady) {
          clearInterval(toolsPollInterval);
          toolsPollInterval = null;
          state.toolsReady = true;
          const modal = document.getElementById('tools-install-modal');
          if (modal) closeModal(modal);
        } else if (isError) {
          clearInterval(toolsPollInterval);
          toolsPollInterval = null;
        }
      } catch (e) {}
    }, 500);
  }

  function startToolsInstall() {
    const btnInstall = document.getElementById('btn-install-tools');
    if (btnInstall) btnInstall.disabled = true;

    const modal = document.getElementById('tools-install-modal');
    if (modal) openModal(modal);

    const btnClose = document.getElementById('btn-close-tools-modal');
    const btnDismiss = document.getElementById('btn-dismiss-tools-modal');
    const btnDownload = document.getElementById('btn-confirm-install-tools');
    const btnRetry = document.getElementById('btn-retry-tools');
    const errEl = document.getElementById('tools-error-msg');

    if (btnClose) btnClose.style.display = 'none';
    if (btnDismiss) btnDismiss.style.display = 'none';
    if (btnDownload) btnDownload.style.display = 'none';
    if (btnRetry) btnRetry.style.display = 'none';
    if (errEl) errEl.style.display = 'none';

    if (state.serverPort) {
      fetch(`http://127.0.0.1:${state.serverPort}/api/tools/install`, { method: 'POST' }).catch(() => {
        fetch(`http://127.0.0.1:${state.serverPort}/api/tools-install`, { method: 'POST' }).catch(() => {});
      });
    }
    pollToolsStatus();
  }

  async function checkToolsStatus(promptUser = false) {
    if (!state.serverPort) return;
    try {
      const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/tools/status`);
      const status = await res.json();
      updateToolsUI(status);

      const isYtDlp = Boolean(status.ytdlp !== undefined ? status.ytdlp : status.ytDlp);
      const isFfmpeg = Boolean(status.ffmpeg);
      if (!isYtDlp || !isFfmpeg) {
        state.toolsReady = false;
        const modal = document.getElementById('tools-install-modal');
        if (modal) openModal(modal);
        startToolsInstall();
      } else {
        state.toolsReady = true;
        const modal = document.getElementById('tools-install-modal');
        if (modal && !modal.classList.contains('hidden')) {
          closeModal(modal);
        }
      }
    } catch (e) {}
  }

  const btnInstallTools = document.getElementById('btn-install-tools');
  if (btnInstallTools) {
    btnInstallTools.addEventListener('click', () => {
      startToolsInstall();
    });
  }

  const toolsModal = document.getElementById('tools-install-modal');
  const btnConfirmInstallTools = document.getElementById('btn-confirm-install-tools');
  const btnDismissToolsModal = document.getElementById('btn-dismiss-tools-modal');
  const btnCloseToolsModal = document.getElementById('btn-close-tools-modal');
  const btnRetryTools = document.getElementById('btn-retry-tools');

  if (btnConfirmInstallTools) {
    btnConfirmInstallTools.addEventListener('click', () => {
      startToolsInstall();
    });
  }

  if (btnRetryTools) {
    btnRetryTools.addEventListener('click', () => {
      startToolsInstall();
    });
  }

  if (btnDismissToolsModal && toolsModal) {
    btnDismissToolsModal.addEventListener('click', () => {
      if (!state.toolsReady) return;
      closeModal(toolsModal);
    });
  }

  if (btnCloseToolsModal && toolsModal) {
    btnCloseToolsModal.addEventListener('click', () => {
      if (!state.toolsReady) return;
      closeModal(toolsModal);
    });
  }

  if (toolsModal) {
    toolsModal.addEventListener('click', (e) => {
      if (e.target === toolsModal) {
        if (!state.toolsReady) {
          e.stopPropagation();
          e.preventDefault();
        } else {
          closeModal(toolsModal);
        }
      }
    });
  }



  const btnOpenShortcuts = document.getElementById('btn-open-shortcuts');
  const shortcutsModal = document.getElementById('shortcuts-modal');
  const btnCloseShortcutsModal = document.getElementById('btn-close-shortcuts-modal');
  if (btnOpenShortcuts && shortcutsModal) btnOpenShortcuts.addEventListener('click', () => openModal(shortcutsModal));
  if (btnCloseShortcutsModal && shortcutsModal) btnCloseShortcutsModal.addEventListener('click', () => closeModal(shortcutsModal));

  const btnCopyDiagnostics = document.getElementById('btn-copy-diagnostics');
  if (btnCopyDiagnostics) {
    btnCopyDiagnostics.addEventListener('click', async () => {
      if (window.electronAPI && typeof window.electronAPI.getDiagnostics === 'function') {
        navigator.clipboard.writeText(await window.electronAPI.getDiagnostics());
        showToast('Diagnostics copied. Paste it into your report', 'info');
      }
    });
  }

  const btnOpenLogs = document.getElementById('btn-open-logs');
  if (btnOpenLogs) {
    btnOpenLogs.addEventListener('click', () => {
      if (window.electronAPI && typeof window.electronAPI.openLogsFolder === 'function') {
        window.electronAPI.openLogsFolder();
      }
    });
  }

  let trackArtCurrentTrack = null;

  function onTrackArtUpdated(track) {
    if (!track) return;

    const currentCover = getTrackThumbUrl(track);
    if (currentCover) coverAnalysisCache.delete(currentCover);
    if (track.thumbnail) coverAnalysisCache.delete(track.thumbnail);
    const art = getTrackArt(track);
    if (art.cover) coverAnalysisCache.delete(art.cover);

    if (track.id) {
      const cleanId = String(track.id).replace(/[^a-zA-Z0-9_-]/g, '_');
      if (typeof analysisCache !== 'undefined' && analysisCache.delete) {
        analysisCache.delete(cleanId);
      }
    }

    if (state.currentTrack && isSameTrack(state.currentTrack, track)) {
      const thumb = getTrackThumbUrl(state.currentTrack);
      if (thumb) {
        if (el.playbarArtwork) {
          el.playbarArtwork.src = thumb;
          if (typeof m3cSetImage === 'function') m3cSetImage(thumb);
          el.playbarArtwork.style.display = 'block';
        }
        if (el.artworkFallback) el.artworkFallback.style.display = 'none';
        if (el.rightPanelCover) {
          el.rightPanelCover.src = thumb;
          el.rightPanelCover.style.display = 'block';
        }
        if (el.rightPanelFallback) el.rightPanelFallback.style.display = 'none';
      }
      updateRightPanelBanner(thumb);
      updateMediaSession();
      updateThemeFromState();
    }

    const canonical = getTrackCanonicalId(track);
    document.querySelectorAll('.track-row').forEach(row => {
      if (row.dataset && row.dataset.canonicalId === canonical) {
        const wrap = row.querySelector('.track-row-thumb-wrap');
        const img = row.querySelector('.track-row-thumb');
        const newThumb = getTrackThumbUrl(track);
        if (img) {
          if (newThumb) {
            img.src = newThumb;
            img.style.display = '';
          } else {
            img.style.display = 'none';
          }
        } else if (wrap && newThumb) {
          const newImg = document.createElement('img');
          newImg.className = 'track-row-thumb';
          newImg.src = newThumb;
          newImg.alt = '';
          newImg.onerror = () => { newImg.style.display = 'none'; };
          wrap.appendChild(newImg);
        }
      }
    });
  }

  function renderTrackArtModal() {
    if (!trackArtCurrentTrack) return;
    const t = trackArtCurrentTrack;
    const titleEl = document.getElementById('track-art-modal-title');
    if (titleEl) titleEl.textContent = `Art: ${t.title || 'Untitled'}`;

    const art = getTrackArt(t);

    const coverImg = document.getElementById('track-art-cover-img');
    const coverPh = document.getElementById('track-art-cover-placeholder');
    const coverStatus = document.getElementById('track-art-cover-status');
    const activeCover = art.cover || t.thumbnail || '';
    if (activeCover) {
      if (coverImg) {
        coverImg.src = activeCover;
        coverImg.style.display = 'block';
      }
      if (coverPh) coverPh.style.display = 'none';
    } else {
      if (coverImg) coverImg.style.display = 'none';
      if (coverPh) coverPh.style.display = 'block';
    }
    if (coverStatus) coverStatus.textContent = art.cover ? 'Custom cover' : 'Default art';

    const bannerImg = document.getElementById('track-art-banner-img');
    const bannerVid = document.getElementById('track-art-banner-vid');
    const bannerPh = document.getElementById('track-art-banner-placeholder');
    const bannerStatus = document.getElementById('track-art-banner-status');
    const activeBanner = art.banner || localStorage.getItem('eclipse_banner_media') || activeCover;
    const isVideo = activeBanner && /\.(mp4|webm)($|\?)/i.test(activeBanner);

    if (activeBanner) {
      if (isVideo) {
        if (bannerImg) bannerImg.style.display = 'none';
        if (bannerVid) {
          bannerVid.src = activeBanner;
          bannerVid.style.display = 'block';
        }
      } else {
        if (bannerVid) bannerVid.style.display = 'none';
        if (bannerImg) {
          bannerImg.src = activeBanner;
          bannerImg.style.display = 'block';
        }
      }
      if (bannerPh) bannerPh.style.display = 'none';
    } else {
      if (bannerImg) bannerImg.style.display = 'none';
      if (bannerVid) bannerVid.style.display = 'none';
      if (bannerPh) bannerPh.style.display = 'block';
    }
    if (bannerStatus) bannerStatus.textContent = art.banner ? 'Custom banner' : (localStorage.getItem('eclipse_banner_media') ? 'Global banner' : 'Default art');

    const btnCustomFx = document.getElementById('btn-track-banner-custom-fx');
    const fxControls = document.getElementById('track-banner-fx-controls');
    const sliderBlur = document.getElementById('slider-track-banner-blur');
    const sliderOpacity = document.getElementById('slider-track-banner-opacity');
    const sliderFade = document.getElementById('slider-track-banner-fade');
    const valBlur = document.getElementById('val-track-banner-blur');
    const valOpacity = document.getElementById('val-track-banner-opacity');
    const valFade = document.getElementById('val-track-banner-fade');

    const isFxOn = !!(art.bannerCustomFx || (art.bannerFx && art.bannerFx.enabled));
    if (btnCustomFx) btnCustomFx.classList.toggle('active', isFxOn);
    if (fxControls) fxControls.style.display = isFxOn ? 'flex' : 'none';

    const curBlur = art.bannerBlur !== undefined ? art.bannerBlur : (art.bannerFx && art.bannerFx.blur !== undefined ? art.bannerFx.blur : 3);
    const curOpacity = art.bannerOpacity !== undefined ? art.bannerOpacity : (art.bannerFx && art.bannerFx.opacity !== undefined ? art.bannerFx.opacity : 100);
    const curFade = art.bannerFade !== undefined ? art.bannerFade : (art.bannerFx && art.bannerFx.fade !== undefined ? art.bannerFx.fade : 100);

    if (sliderBlur) {
      sliderBlur.value = curBlur;
      if (valBlur) valBlur.textContent = `${curBlur}px`;
    }
    if (sliderOpacity) {
      sliderOpacity.value = curOpacity;
      if (valOpacity) valOpacity.textContent = `${curOpacity}%`;
    }
    if (sliderFade) {
      sliderFade.value = curFade;
      if (valFade) valFade.textContent = `${curFade}%`;
    }

    if (btnCustomFx) {
      btnCustomFx.onclick = () => {
        const next = !btnCustomFx.classList.contains('active');
        btnCustomFx.classList.toggle('active', next);
        if (fxControls) fxControls.style.display = next ? 'flex' : 'none';
        const b = sliderBlur ? parseInt(sliderBlur.value, 10) : curBlur;
        const o = sliderOpacity ? parseInt(sliderOpacity.value, 10) : curOpacity;
        const f = sliderFade ? parseInt(sliderFade.value, 10) : curFade;
        setTrackArt(t, {
          bannerCustomFx: next,
          bannerBlur: b,
          bannerOpacity: o,
          bannerFade: f,
          bannerFx: { enabled: next, blur: b, opacity: o, fade: f }
        });
        onTrackArtUpdated(t);
      };
    }

    if (sliderBlur) {
      sliderBlur.oninput = (e) => {
        const v = parseInt(e.target.value, 10);
        if (valBlur) valBlur.textContent = `${v}px`;
        const o = sliderOpacity ? parseInt(sliderOpacity.value, 10) : 100;
        const f = sliderFade ? parseInt(sliderFade.value, 10) : 100;
        const active = btnCustomFx ? btnCustomFx.classList.contains('active') : true;
        setTrackArt(t, {
          bannerCustomFx: active,
          bannerBlur: v,
          bannerOpacity: o,
          bannerFade: f,
          bannerFx: { enabled: active, blur: v, opacity: o, fade: f }
        });
        onTrackArtUpdated(t);
      };
    }

    if (sliderOpacity) {
      sliderOpacity.oninput = (e) => {
        const v = parseInt(e.target.value, 10);
        if (valOpacity) valOpacity.textContent = `${v}%`;
        const b = sliderBlur ? parseInt(sliderBlur.value, 10) : 3;
        const f = sliderFade ? parseInt(sliderFade.value, 10) : 100;
        const active = btnCustomFx ? btnCustomFx.classList.contains('active') : true;
        setTrackArt(t, {
          bannerCustomFx: active,
          bannerBlur: b,
          bannerOpacity: v,
          bannerFade: f,
          bannerFx: { enabled: active, blur: b, opacity: v, fade: f }
        });
        onTrackArtUpdated(t);
      };
    }

    if (sliderFade) {
      sliderFade.oninput = (e) => {
        const v = parseInt(e.target.value, 10);
        if (valFade) valFade.textContent = `${v}%`;
        const b = sliderBlur ? parseInt(sliderBlur.value, 10) : 3;
        const o = sliderOpacity ? parseInt(sliderOpacity.value, 10) : 100;
        const active = btnCustomFx ? btnCustomFx.classList.contains('active') : true;
        setTrackArt(t, {
          bannerCustomFx: active,
          bannerBlur: b,
          bannerOpacity: o,
          bannerFade: v,
          bannerFx: { enabled: active, blur: b, opacity: v, fade: v }
        });
        onTrackArtUpdated(t);
      };
    }
  }

  function openTrackArtModal(track, triggerEl = null) {
    if (!track) return;
    trackArtCurrentTrack = track;
    const modal = document.getElementById('track-art-modal');
    if (!modal) return;
    renderTrackArtModal();
    const card = modal.querySelector('.dialog-card') || modal;
    if (card) {
      card.classList.remove('liquid-surface', 'liquid-x', 'liquid-y', 'liquid-open', 'liquid-closing');
    }
    openModal(modal);
  }
  window.openTrackArtModal = openTrackArtModal;

  function closeTrackArtModal() {
    const modal = document.getElementById('track-art-modal');
    if (!modal) return;
    const card = modal.querySelector('.dialog-card') || modal;
    if (card) {
      card.classList.remove('liquid-surface', 'liquid-x', 'liquid-y', 'liquid-open', 'liquid-closing');
    }
    closeModal(modal);
  }

  const trackArtModal = document.getElementById('track-art-modal');
  const btnCloseTrackArtModal = document.getElementById('btn-close-track-art-modal');
  const btnChooseTrackCover = document.getElementById('btn-choose-track-cover');
  const btnResetTrackCover = document.getElementById('btn-reset-track-cover');
  const btnChooseTrackBanner = document.getElementById('btn-choose-track-banner');
  const btnResetTrackBanner = document.getElementById('btn-reset-track-banner');
  const btnRightPanelArt = document.getElementById('btn-right-panel-art');

  if (btnRightPanelArt) {
    btnRightPanelArt.addEventListener('click', () => {
      if (state.currentTrack) {
        openTrackArtModal(state.currentTrack, btnRightPanelArt);
      }
    });
  }

  if (btnCloseTrackArtModal) {
    btnCloseTrackArtModal.addEventListener('click', closeTrackArtModal);
  }

  if (trackArtModal) {
    trackArtModal.addEventListener('click', (e) => {
      if (e.target === trackArtModal) closeTrackArtModal();
    });
  }

  const isImageFile = (u) => /\.(png|jpe?g|webp|gif)($|\?)/i.test(u);
  const isMediaFile = (u) => /\.(png|jpe?g|webp|gif|mp4|webm)($|\?)/i.test(u);

  if (btnChooseTrackCover) {
    btnChooseTrackCover.addEventListener('click', async () => {
      if (!trackArtCurrentTrack) return;
      if (window.electronAPI && window.electronAPI.pickMedia) {
        const url = await window.electronAPI.pickMedia();
        if (url) {
          if (!isImageFile(url)) {
            showToast('Cover must be an image (PNG, JPG, WebP, GIF)');
            return;
          }
          setTrackArt(trackArtCurrentTrack, { cover: url });
          onTrackArtUpdated(trackArtCurrentTrack);
          renderTrackArtModal();
        }
      }
    });
  }

  if (btnResetTrackCover) {
    btnResetTrackCover.addEventListener('click', () => {
      if (!trackArtCurrentTrack) return;
      setTrackArt(trackArtCurrentTrack, { cover: undefined });
      onTrackArtUpdated(trackArtCurrentTrack);
      renderTrackArtModal();
    });
  }

  if (btnChooseTrackBanner) {
    btnChooseTrackBanner.addEventListener('click', async () => {
      if (!trackArtCurrentTrack) return;
      if (window.electronAPI && window.electronAPI.pickMedia) {
        const url = await window.electronAPI.pickMedia();
        if (url) {
          if (!isMediaFile(url)) {
            showToast('Banner must be image or video (PNG, JPG, WebP, GIF, MP4, WebM)');
            return;
          }
          setTrackArt(trackArtCurrentTrack, { banner: url });
          onTrackArtUpdated(trackArtCurrentTrack);
          renderTrackArtModal();
        }
      }
    });
  }

  if (btnResetTrackBanner) {
    btnResetTrackBanner.addEventListener('click', () => {
      if (!trackArtCurrentTrack) return;
      setTrackArt(trackArtCurrentTrack, { banner: undefined });
      onTrackArtUpdated(trackArtCurrentTrack);
      renderTrackArtModal();
    });
  }

  const DEFAULT_SIDEBAR_ORDER = ['discover', 'favorites', 'albums', 'local', 'history', 'queue'];

  const SIDEBAR_ITEM_DEFS = {
    discover: { name: 'Home', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>' },
    favorites: { name: 'Favorites', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>' },
    albums: { name: 'Albums', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg>' },
    local: { name: 'My files', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>' },
    history: { name: 'History', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>' },
    queue: { name: 'Queue', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="14" y2="17"/></svg>' }
  };

  function getSidebarOrder() {
    try {
      const raw = localStorage.getItem('eclipse_sidebar_order');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const valid = parsed.filter(id => DEFAULT_SIDEBAR_ORDER.includes(id));
          DEFAULT_SIDEBAR_ORDER.forEach(id => {
            if (!valid.includes(id)) valid.push(id);
          });
          return valid;
        }
      }
    } catch (_) {}
    return [...DEFAULT_SIDEBAR_ORDER];
  }

  function applySidebarOrder(order) {
    const currentOrder = order || getSidebarOrder();
    const nav = document.querySelector('#sidebar .sidebar-nav');
    const divider = nav ? nav.querySelector('.rail-divider') : null;
    if (!nav || !divider) return;
    currentOrder.forEach(viewId => {
      const btn = nav.querySelector(`.nav-item[data-view="${viewId}"]`);
      if (btn) {
        divider.parentNode.insertBefore(btn, divider);
      }
    });
    if (typeof updateNavIndicator === 'function') {
      requestAnimationFrame(() => updateNavIndicator(false));
    }
  }

  const DEFAULT_HOME_ORDER = ['sp-made-sec', 'sp-quick-sec', 'sp-trend-sec', 'sp-artists-sec'];

  const HOME_SECTION_DEFS = {
    'sp-made-sec': { name: 'For you', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 10v2M8 6v10M12 2v18M16 6v10M20 10v2"/></svg>' },
    'sp-quick-sec': { name: 'Home / Quick picks', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/></svg>' },
    'sp-trend-sec': { name: 'Trending now', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2c1 4 5 5.5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3-1-6 1-9z"/></svg>' },
    'sp-artists-sec': { name: 'Favorite artists', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>' }
  };

  function getHomeSectionsOrder() {
    try {
      const raw = localStorage.getItem('eclipse_home_order');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const valid = parsed.filter(id => DEFAULT_HOME_ORDER.includes(id));
          DEFAULT_HOME_ORDER.forEach(id => {
            if (!valid.includes(id)) valid.push(id);
          });
          return valid;
        }
      }
    } catch (_) {}
    return [...DEFAULT_HOME_ORDER];
  }

  function applyHomeSectionsOrder(order) {
    const currentOrder = order || getHomeSectionsOrder();
    const container = document.getElementById('sp-home');
    if (!container) return;
    currentOrder.forEach(secId => {
      const secEl = document.getElementById(secId);
      if (secEl && secEl.parentNode === container) {
        container.appendChild(secEl);
      }
    });
  }

  function makeCustomizerList(container, getOrderFn, saveKey, defsMap, applyFn) {
    if (!container) return () => {};
    const render = () => {
      const currentOrder = getOrderFn();
      container.innerHTML = '';
      currentOrder.forEach((id, index) => {
        const def = defsMap[id] || { name: id, icon: '' };
        const row = document.createElement('div');
        row.className = 'customizer-drag-row';
        row.setAttribute('draggable', 'true');
        row.setAttribute('data-id', id);
        row.innerHTML = `
          <span class="drag-handle" title="Drag to reorder">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="9" cy="5" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="9" cy="19" r="1.5"/><circle cx="15" cy="5" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="15" cy="19" r="1.5"/></svg>
          </span>
          <span class="customizer-icon">${def.icon}</span>
          <span style="flex:1; font-weight:500;">${escapeHtml(def.name)}</span>
          <div style="display:flex; gap:4px;">
            <button type="button" class="btn-icon-pill btn-move-up" style="width:24px;height:24px;padding:0;min-width:24px;" title="Move up" ${index === 0 ? 'disabled' : ''}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="18 15 12 9 6 15"/></svg>
            </button>
            <button type="button" class="btn-icon-pill btn-move-down" style="width:24px;height:24px;padding:0;min-width:24px;" title="Move down" ${index === currentOrder.length - 1 ? 'disabled' : ''}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
            </button>
          </div>
        `;

        const btnUp = row.querySelector('.btn-move-up');
        if (btnUp) {
          btnUp.addEventListener('click', (e) => {
            e.stopPropagation();
            const prev = row.previousElementSibling;
            if (prev) {
              container.insertBefore(row, prev);
              saveAndApply();
            }
          });
        }

        const btnDown = row.querySelector('.btn-move-down');
        if (btnDown) {
          btnDown.addEventListener('click', (e) => {
            e.stopPropagation();
            const next = row.nextElementSibling;
            if (next) {
              container.insertBefore(next, row);
              saveAndApply();
            }
          });
        }

        row.addEventListener('dragstart', (e) => {
          row.classList.add('dragging');
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', id);
        });

        row.addEventListener('dragend', () => {
          row.classList.remove('dragging');
          container.querySelectorAll('.customizer-drag-row').forEach(r => r.classList.remove('drag-over'));
          saveAndApply();
        });

        row.addEventListener('dragover', (e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          const dragging = container.querySelector('.customizer-drag-row.dragging');
          if (dragging && dragging !== row) {
            const rect = row.getBoundingClientRect();
            const midY = rect.top + rect.height / 2;
            if (e.clientY < midY) {
              container.insertBefore(dragging, row);
            } else {
              container.insertBefore(dragging, row.nextElementSibling);
            }
          }
        });

        container.appendChild(row);
      });
    };

    const saveAndApply = () => {
      const newOrder = Array.from(container.children).map(c => c.getAttribute('data-id')).filter(Boolean);
      localStorage.setItem(saveKey, JSON.stringify(newOrder));
      applyFn(newOrder);
      render();
    };

    render();
    return render;
  }

  function initSidebarOrderCustomizer() {
    const sidebarContainer = document.getElementById('settings-sidebar-replica');
    const homeContainer = document.getElementById('settings-home-order-list');
    const resetBtn = document.getElementById('btn-reset-sidebar-order');

    let renderSidebar, renderHome;
    if (sidebarContainer) {
      renderSidebar = makeCustomizerList(
        sidebarContainer,
        getSidebarOrder,
        'eclipse_sidebar_order',
        SIDEBAR_ITEM_DEFS,
        applySidebarOrder
      );
    }
    if (homeContainer) {
      renderHome = makeCustomizerList(
        homeContainer,
        getHomeSectionsOrder,
        'eclipse_home_order',
        HOME_SECTION_DEFS,
        applyHomeSectionsOrder
      );
    }

    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        localStorage.removeItem('eclipse_sidebar_order');
        localStorage.removeItem('eclipse_home_order');
        applySidebarOrder(DEFAULT_SIDEBAR_ORDER);
        applyHomeSectionsOrder(DEFAULT_HOME_ORDER);
        if (renderSidebar) renderSidebar();
        if (renderHome) renderHome();
        showToast('Sidebar & home layout reset to default');
      });
    }
  }

  let currentSearchFilter = 'all';

  function applySearchFilter(filter) {
    if (filter) currentSearchFilter = filter;
    const chips = document.querySelectorAll('#search-filter-chips .search-chip');
    chips.forEach(chip => {
      chip.classList.toggle('active', chip.getAttribute('data-filter') === currentSearchFilter);
    });

    const artistContainer = document.getElementById('search-artist-card-container');
    const albumsContainer = document.getElementById('search-albums-container');
    const tracksList = document.getElementById('search-tracks-list');

    const showArtist = (currentSearchFilter === 'all' || currentSearchFilter === 'artists');
    const showAlbums = (currentSearchFilter === 'all' || currentSearchFilter === 'albums');
    const showSongs = (currentSearchFilter === 'all' || currentSearchFilter === 'songs');

    if (artistContainer) {
      artistContainer.style.display = showArtist ? '' : 'none';
    }
    if (albumsContainer) {
      albumsContainer.style.display = showAlbums ? '' : 'none';
    }
    if (tracksList) {
      tracksList.style.display = showSongs ? '' : 'none';
    }
  }

  function initSearchFilterChips() {
    const container = document.getElementById('search-filter-chips');
    if (!container) return;
    const chips = container.querySelectorAll('.search-chip');
    chips.forEach(chip => {
      chip.addEventListener('click', () => {
        const filter = chip.getAttribute('data-filter') || 'all';
        applySearchFilter(filter);
      });
    });
  }

  function initMouseNavInterceptor() {
    const handleMouseNav = (e) => {
      if (e.button === 3) {
        e.preventDefault();
        e.stopPropagation();
        const target = (state.previousView && state.previousView !== state.currentView) ? state.previousView : 'discover';
        switchView(target);
      } else if (e.button === 4) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('mouseup', handleMouseNav, true);
    window.addEventListener('auxclick', handleMouseNav, true);
  }

  function initDesktopShortcutSetting() {
    const btn = document.getElementById('btn-create-shortcut');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      if (window.electronAPI && window.electronAPI.installLauncher) {
        try {
          btn.disabled = true;
          btn.textContent = 'Creating...';
          const res = await window.electronAPI.installLauncher();
          if (res && res.success) {
            showToast('Desktop and app menu shortcut created successfully');
          } else {
            showToast('Failed to create shortcut: ' + ((res && res.error) || 'unknown error'));
          }
        } catch (err) {
          showToast('Error creating shortcut: ' + (err.message || err));
        } finally {
          btn.disabled = false;
          btn.textContent = 'Create shortcut';
        }
      } else {
        showToast('Shortcut installer is not supported in this environment');
      }
    });
  }

  function initLikeAlbumTracksSetting() {
    const btn = document.getElementById('btn-like-album-tracks');
    if (!btn) return;
    const isEnabled = localStorage.getItem('eclipse_like_album_tracks') === '1';
    btn.classList.toggle('active', isEnabled);
    btn.addEventListener('click', () => {
      const nextState = !btn.classList.contains('active');
      btn.classList.toggle('active', nextState);
      localStorage.setItem('eclipse_like_album_tracks', nextState ? '1' : '0');
    });
  }

  loadPlugins();
  fetchPersonalVibe();
  initHomeHero();
  applyHomeLayout();
  applySidebarOrder();
  applyHomeSectionsOrder();
  initSidebarOrderCustomizer();
  renderBlockedItemsSettings();
  initSearchFilterChips();
  initSearchHistory();
  initQueuePanel();
  initMouseNavInterceptor();
  initDesktopShortcutSetting();
  initLikeAlbumTracksSetting();
  resizeCanvases();
  updateOfflineStorageUI();
  updateMusicFolderUI();
  updateDownloadFolderUI();
  checkToolsStatus(false);
  setLyricsEmpty(true);
  updateLyricsTranslationUI();
  loadCustomThemes();
  applyCustomStyles();
  initProxyManager();
  initSongQualitySetting();
  const initCat = localStorage.getItem('eclipse_settings_cat');
  showSettingsCategory((initCat === 'overview' || !initCat) ? 'home' : initCat);
  refreshStacks();
  requestAnimationFrame(() => requestAnimationFrame(refreshStacks));
  initTvk();
  if (window.KaraokeMotionController && typeof window.KaraokeMotionController.init === 'function') {
    window.KaraokeMotionController.init();
  }
  let dominantGeneration = 0;
  let tvkMetadataSnapshot = null;

  window.addEventListener('eclipse:karaoke-dominant-switch', (ev) => {
    if (!state.isTvKaraokeOpen) return;
    const toTrack = ev.detail && ev.detail.toTrack;
    const transitionId = ev.detail && ev.detail.transitionId;
    if (toTrack) {
      const titleEl = el.tvKaraokeTitle || document.getElementById('tv-karaoke-title');
      const artistEl = el.tvKaraokeArtist || document.getElementById('tv-karaoke-artist');
      const coverEl = el.tvCover || document.getElementById('tv-cover');

      // Capture pre-dominant metadata snapshot for rollback if transition is aborted
      tvkMetadataSnapshot = {
        transitionId: transitionId || null,
        title: titleEl ? titleEl.textContent : '',
        artist: (state.currentTrack && state.currentTrack.artist) || (artistEl ? artistEl.textContent : ''),
        coverSrc: coverEl ? coverEl.src : ''
      };

      dominantGeneration += 1;
      const currentGen = dominantGeneration;
      if (titleEl) {
        titleEl.style.opacity = '0';
        titleEl.style.transform = 'translateY(6px)';
        setTimeout(() => {
          if (dominantGeneration !== currentGen) return;
          titleEl.textContent = toTrack.title || '';
          titleEl.style.opacity = '1';
          titleEl.style.transform = 'none';
        }, 140);
      }
      if (artistEl) {
        artistEl.style.opacity = '0';
        artistEl.style.transform = 'translateY(6px)';
        setTimeout(() => {
          if (dominantGeneration !== currentGen) return;
          renderClickableArtists(artistEl, toTrack.artist || '');
          artistEl.style.opacity = '1';
          artistEl.style.transform = 'none';
        }, 140);
      }
      if (coverEl) {
        const thumb = getTrackThumbUrl(toTrack);
        if (thumb) {
          coverEl.style.opacity = '0';
          setTimeout(() => {
            if (dominantGeneration !== currentGen) return;
            coverEl.src = thumb;
            coverEl.style.opacity = '1';
          }, 150);
        }
      }
    }
  });

  // Rollback TV Karaoke metadata if AutoMix transition was aborted or failed after dominance
  window.addEventListener('eclipse:automix-state', (ev) => {
    const detail = ev && ev.detail;
    if (!detail || detail.active) return;

    if (detail.completed) {
      if (tvkMetadataSnapshot && detail.transitionId && tvkMetadataSnapshot.transitionId === detail.transitionId) {
        tvkMetadataSnapshot = null;
      }
      return;
    }

    if ((detail.aborted || detail.failed) && tvkMetadataSnapshot) {
      const incomingTxId = detail.transitionId || null;
      // Stale terminal event for a different transition MUST NOT rollback
      if (incomingTxId && tvkMetadataSnapshot.transitionId && incomingTxId !== tvkMetadataSnapshot.transitionId) {
        return;
      }

      // Invalidate any pending setTimeout(..., 140) from dominant switch
      dominantGeneration += 1;

      const titleEl = el.tvKaraokeTitle || document.getElementById('tv-karaoke-title');
      const artistEl = el.tvKaraokeArtist || document.getElementById('tv-karaoke-artist');
      const coverEl = el.tvCover || document.getElementById('tv-cover');

      if (titleEl) {
        titleEl.textContent = tvkMetadataSnapshot.title || '';
        titleEl.style.opacity = '1';
        titleEl.style.transform = 'none';
      }
      if (artistEl) {
        if (tvkMetadataSnapshot.artist) {
          renderClickableArtists(artistEl, tvkMetadataSnapshot.artist);
        } else {
          artistEl.textContent = '';
        }
        artistEl.style.opacity = '1';
        artistEl.style.transform = 'none';
      }
      if (coverEl && tvkMetadataSnapshot.coverSrc) {
        coverEl.src = tvkMetadataSnapshot.coverSrc;
        coverEl.style.opacity = '1';
        coverEl.style.transform = 'scale(1)';
      }

      tvkMetadataSnapshot = null;
    }
  });
  if (typeof m3cInit === 'function') m3cInit();
  requestAnimationFrame(() => requestAnimationFrame(() => updateNavIndicator(false)));

  const heroBanner = document.querySelector('.eclipse-hero-banner');
  if (heroBanner) {
    heroBanner.addEventListener('pointermove', (e) => {
      if (document.body.classList.contains('perf')) return;
      const rect = heroBanner.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const px = Math.max(-1, Math.min(1, ((e.clientX - rect.left) / rect.width) * 2 - 1));
      const py = Math.max(-1, Math.min(1, ((e.clientY - rect.top) / rect.height) * 2 - 1));
      heroBanner.style.setProperty('--px', px);
      heroBanner.style.setProperty('--py', py);
    });
    heroBanner.addEventListener('pointerleave', () => {
      if (document.body.classList.contains('perf')) return;
      heroBanner.style.setProperty('--px', 0);
      heroBanner.style.setProperty('--py', 0);
    });
  }

  if (typeof checkGoogleAuthStatus === 'function') {
    checkGoogleAuthStatus().catch(() => {});
  }
  emitPluginEvent('ready');

  // --- SQLite Library Storage Integration & Migration ---
  (async function initSqliteLibraryStore() {
    if (!window.electronAPI || !window.electronAPI.libraryDb || typeof window.electronAPI.libraryDb.loadAll !== 'function') {
      return;
    }
    try {
      const res = await window.electronAPI.libraryDb.loadAll('default');
      if (res && res.success && res.data) {
        const { albums, playlists, favorites, history } = res.data;
        const dbHasData = (Array.isArray(albums) && albums.length > 0) ||
                          (Array.isArray(playlists) && playlists.length > 0) ||
                          (Array.isArray(favorites) && favorites.length > 0);

        if (dbHasData) {
          // Hydrate memory state directly from SQLite
          if (Array.isArray(albums) && albums.length > 0) {
            cachedSavedAlbums = albums;
            try { localStorage.setItem('eclipse_saved_albums', JSON.stringify(albums)); } catch (_) {}
            updateAlbumsCount();
            if (state.currentView === 'albums') renderSavedAlbums();
          }
          if (Array.isArray(playlists) && playlists.length > 0) {
            state.playlists = playlists;
            try { localStorage.setItem('devsize_playlists', JSON.stringify(playlists)); } catch (_) {}
            if (typeof renderPlaylistsList === 'function') renderPlaylistsList();
          }
          if (Array.isArray(favorites) && favorites.length > 0) {
            state.favorites = favorites;
            try { localStorage.setItem('devsize_favorites', JSON.stringify(favorites.map(sanitizeTrackForStorage))); } catch (_) {}
            updateFavCount();
            if (state.currentView === 'favorites') renderFavorites();
          }
          if (Array.isArray(history) && history.length > 0) {
            state.history = history;
            try { localStorage.setItem('devsize_history', JSON.stringify(history.map(sanitizeTrackForStorage))); } catch (_) {}
            if (state.currentView === 'history') renderHistory();
          }
        } else {
          // Auto-migrate legacy localStorage data to SQLite backend
          const localAlbums = getSavedAlbums();
          const localPlaylists = Array.isArray(state.playlists) ? state.playlists : [];
          const localFavorites = Array.isArray(state.favorites) ? state.favorites : [];
          const localHistory = Array.isArray(state.history) ? state.history : [];

          const hasLegacy = localAlbums.length > 0 || localPlaylists.length > 0 || localFavorites.length > 0;
          if (hasLegacy) {
            const migrationPayload = {
              albums: localAlbums,
              playlists: localPlaylists,
              favorites: localFavorites,
              history: localHistory
            };
            const migRes = await window.electronAPI.libraryDb.migrateLegacy(migrationPayload, 'default');
            if (migRes && migRes.success) {
              // Backup legacy keys safely
              try {
                if (localAlbums.length > 0) localStorage.setItem('eclipse_saved_albums_backup_v1', JSON.stringify(localAlbums));
                if (localPlaylists.length > 0) localStorage.setItem('devsize_playlists_backup_v1', JSON.stringify(localPlaylists));
                if (localFavorites.length > 0) localStorage.setItem('devsize_favorites_backup_v1', JSON.stringify(localFavorites));
              } catch (_) {}
            }
          }
        }
      }
    } catch (err) {
      console.warn('[initSqliteLibraryStore] Initialization warning:', err);
    }
  })();

  // --- YOUTUBE COMMENTS & TIMESTAMPS SEEK INTEGRATION ---
  let activeCommentsTrackId = null;
  let activeCommentsAbortController = null;

  function resolveYouTubeVideoId(track) {
    if (!track || typeof track !== 'object') return null;
    const candidates = [
      track.videoId,
      track.video_id,
      track._matchedYtId,
      track.id
    ];
    for (const c of candidates) {
      if (typeof c === 'string') {
        const trimmed = c.trim();
        if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
          return trimmed;
        }
      }
    }
    const urlCandidates = [track.url, track.streamUrl, track.sourceUrl];
    for (const u of urlCandidates) {
      if (typeof u === 'string' && u.trim()) {
        const m = u.match(/(?:youtu\.be\/|v\/|u\/\w\/|embed\/|shorts\/|live\/|watch\?v=|&v=)([a-zA-Z0-9_-]{11})/);
        if (m && m[1]) return m[1];
      }
    }
    return null;
  }

  function seekToTrackPosition(targetSeconds) {
    if (!Number.isFinite(targetSeconds) || targetSeconds < 0) return false;
    abortAutoMixIfActive('seek');
    const dur = typeof getReliableTrackDuration === 'function' ? getReliableTrackDuration() : ((state.currentTrack && state.currentTrack.duration) || 0);
    if (dur > 0 && targetSeconds > dur) {
      if (typeof showToast === 'function') showToast('Thời điểm vượt quá độ dài bài hát');
      return false;
    }

    if (el.nativeAudio) {
      el.nativeAudio.currentTime = targetSeconds;
    }
    if (state.secondaryAudio && !state.secondaryAudio.paused) {
      state.secondaryAudio.currentTime = targetSeconds;
    }
    if (typeof mvController !== 'undefined' && mvController && mvController.active && el.mvVideo && el.mvVideo.readyState >= 1) {
      try { el.mvVideo.currentTime = targetSeconds; } catch (_) {}
    }
    if (typeof updateMediaPositionState === 'function') {
      updateMediaPositionState();
    }
    if (typeof updateSyncedLyricsHighlight === 'function') {
      updateSyncedLyricsHighlight(targetSeconds);
    }
    return true;
  }

  function renderCommentTextWithTimestamps(rawText, container) {
    if (!container) return;
    container.innerHTML = '';
    const text = String(rawText || '');
    const regex = /\b(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\b/g;
    let lastIndex = 0;
    let match;

    while ((match = regex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        container.appendChild(document.createTextNode(text.substring(lastIndex, match.index)));
      }
      const hasHours = match[1] !== undefined;
      const hours = hasHours ? parseInt(match[1], 10) : 0;
      const mins = parseInt(match[2], 10);
      const secs = parseInt(match[3], 10);
      const totalSecs = hours * 3600 + mins * 60 + secs;

      const tag = document.createElement('span');
      tag.className = 'comment-timestamp-tag';
      tag.textContent = match[0];
      tag.title = `Tua đến ${match[0]}`;
      tag.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        seekToTrackPosition(totalSecs);
      });
      container.appendChild(tag);
      lastIndex = regex.lastIndex;
    }

    if (lastIndex < text.length) {
      container.appendChild(document.createTextNode(text.substring(lastIndex)));
    }
  }

  async function loadTrackComments(forceRefresh = false) {
    const modal = document.getElementById('comments-modal');
    const container = document.getElementById('comments-container');
    const titleEl = document.getElementById('comments-modal-title');
    const subtitleEl = document.getElementById('comments-modal-subtitle');
    if (!container) return;

    // 1. Guard against no active track
    if (!state.currentTrack) {
      container.innerHTML = '<div class="comments-empty-state"><svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg><span>Vui lòng chọn bài hát để xem bình luận</span></div>';
      if (titleEl) titleEl.textContent = 'Bình luận';
      if (subtitleEl) subtitleEl.textContent = 'Chưa phát bài hát';
      return;
    }

    const track = state.currentTrack;
    if (titleEl) titleEl.textContent = track.title || 'Bình luận bài hát';
    if (subtitleEl) subtitleEl.textContent = track.artist || 'YouTube Music';

    // 2. Resolve YouTube video ID inside guarded execution
    let vid = null;
    try {
      vid = resolveYouTubeVideoId(track);
    } catch (resolveErr) {
      console.warn('[comments] Failed to resolve video ID:', resolveErr);
    }

    if (!vid) {
      container.innerHTML = '<div class="comments-empty-state"><svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg><span>Bài hát này không có ID YouTube hợp lệ</span></div>';
      return;
    }

    // 3. Set loading state immediately
    if (activeCommentsAbortController) {
      activeCommentsAbortController.abort();
      activeCommentsAbortController = null;
    }
    const abortController = new AbortController();
    activeCommentsAbortController = abortController;
    activeCommentsTrackId = vid;

    container.innerHTML = '<div class="comments-loading-state"><span class="mv-loading-spinner" style="width: 28px; height: 28px;"></span><span>Đang tải bình luận...</span></div>';

    // 4. Bounded client fetch (15s timeout)
    const timeoutId = setTimeout(() => {
      abortController.abort(new Error('Comments request timed out (15s)'));
    }, 15000);

    try {
      const port = state.serverPort || 38472;
      const token = (window.electronAPI && window.electronAPI.serverToken) || (state && state.serverToken) || '';
      const refreshParam = forceRefresh ? '&t=' + Date.now() : '';
      const url = `http://127.0.0.1:${port}/api/ytm/comments?id=${encodeURIComponent(vid)}&token=${encodeURIComponent(token)}${refreshParam}`;

      const resp = await fetch(url, { signal: abortController.signal });
      clearTimeout(timeoutId);

      if (!resp.ok) throw new Error(`Máy chủ phản hồi HTTP ${resp.status}`);
      const data = await resp.json();

      if (activeCommentsTrackId !== vid) return; // Track changed during fetch

      if (!data || !data.success || !Array.isArray(data.comments)) {
        throw new Error(data && data.error ? data.error : 'Không thể tải bình luận');
      }

      if (data.comments.length === 0) {
        container.innerHTML = '<div class="comments-empty-state"><svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg><span>Chưa có bình luận nào cho bài hát này</span></div>';
        return;
      }

      container.innerHTML = '';
      for (const c of data.comments) {
        const item = document.createElement('div');
        item.className = 'comment-item';

        if (c.avatar) {
          const img = document.createElement('img');
          img.className = 'comment-avatar';
          img.src = c.avatar;
          img.alt = c.author || '';
          img.onerror = () => {
            img.style.display = 'none';
          };
          item.appendChild(img);
        } else {
          const fb = document.createElement('div');
          fb.className = 'comment-avatar-fallback';
          fb.textContent = (c.author && c.author[0]) ? c.author[0].toUpperCase() : 'U';
          item.appendChild(fb);
        }

        const content = document.createElement('div');
        content.className = 'comment-content';

        const authorRow = document.createElement('div');
        authorRow.className = 'comment-author-row';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'comment-author-name';
        nameSpan.textContent = c.author || 'Người nghe';
        authorRow.appendChild(nameSpan);

        if (c.publishedTime) {
          const timeSpan = document.createElement('span');
          timeSpan.className = 'comment-published-time';
          timeSpan.textContent = c.publishedTime;
          authorRow.appendChild(timeSpan);
        }
        content.appendChild(authorRow);

        const textDiv = document.createElement('div');
        textDiv.className = 'comment-text';
        renderCommentTextWithTimestamps(c.text, textDiv);
        content.appendChild(textDiv);

        if (c.likes && c.likes !== '0') {
          const footer = document.createElement('div');
          footer.className = 'comment-footer';
          footer.innerHTML = `<span class="comment-like-badge"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z"></path></svg> ${escapeHtml(c.likes)}</span>`;
          content.appendChild(footer);
        }

        item.appendChild(content);
        container.appendChild(item);
      }
    } catch (err) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError' && (!activeCommentsAbortController || activeCommentsAbortController.signal.reason !== 'Comments request timed out (15s)')) {
        return;
      }
      if (activeCommentsTrackId !== vid) return;
      const isTimeout = err.name === 'AbortError' || /timed out/i.test(err.message);
      const msg = isTimeout ? 'Hết thời gian tải bình luận (15s)' : (err.message || 'Lỗi kết nối bình luận');
      container.innerHTML = `<div class="comments-error-state"><svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg><span>${escapeHtml(msg)}</span><button type="button" class="btn-outline-pill" id="btn-retry-comments" style="margin-top:8px;">Thử lại</button></div>`;
      const retryBtn = document.getElementById('btn-retry-comments');
      if (retryBtn) {
        retryBtn.onclick = () => loadTrackComments(true);
      }
    }
  }

  function openCommentsModal() {
    try {
      const modal = document.getElementById('comments-modal');
      if (!modal) return;
      modal.classList.remove('hidden');
      modal.classList.add('visible');
      loadTrackComments(false).catch((err) => {
        console.warn('[comments] loadTrackComments rejected:', err);
      });
    } catch (modalErr) {
      console.warn('[comments] openCommentsModal exception:', modalErr);
    }
  }

  function closeCommentsModal() {
    const modal = document.getElementById('comments-modal');
    if (!modal) return;
    modal.classList.remove('visible');
    modal.classList.add('hidden');
    if (activeCommentsAbortController) {
      activeCommentsAbortController.abort();
      activeCommentsAbortController = null;
    }
  }

  function initCommentsFeature() {
    const btnToggle = document.getElementById('btn-toggle-comments');
    if (btnToggle) {
      btnToggle.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        openCommentsModal();
      };
    }

    const btnClose = document.getElementById('btn-close-comments-modal');
    if (btnClose) {
      btnClose.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeCommentsModal();
      };
    }

    const btnRefresh = document.getElementById('btn-refresh-comments');
    if (btnRefresh) {
      btnRefresh.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        loadTrackComments(true);
      };
    }

    const modal = document.getElementById('comments-modal');
    if (modal) {
      modal.onclick = (e) => {
        if (e.target === modal) closeCommentsModal();
      };
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initCommentsFeature);
  } else {
    initCommentsFeature();
  }

  // ==========================================================================
  // Share Lyrics Card Controller (Independent Top-Level DOM Initializer)
  // ==========================================================================
  let isShareLyricsInitialized = false;
  let selectedLyricsIndices = [];
  let selectedCardBackground = '';

  function initShareLyricsUI() {
    if (isShareLyricsInitialized) return;

    const shareLyricsModal = document.getElementById('share-lyrics-modal');
    const shareLyricsCard = shareLyricsModal ? shareLyricsModal.querySelector('.share-lyrics-modal-card') : null;
    const shareLyricsSwatches = document.getElementById('share-lyrics-swatches');
    const btnShareLyrics = document.getElementById('btn-share-lyrics');
    const btnCloseShareLyrics = document.getElementById('btn-close-share-lyrics');
    const shareLyricsLinesList = document.getElementById('share-lyrics-lines-list');
    const shareLyricsCounter = document.getElementById('share-lyrics-counter');
    const shareLyricsCanvas = document.getElementById('share-lyrics-canvas');
    const btnCopyLyricsImage = document.getElementById('btn-copy-lyrics-image');
    const btnDownloadLyricsCard = document.getElementById('btn-download-lyrics-card');

    const requiredNodes = [
      { id: 'share-lyrics-modal', el: shareLyricsModal },
      { id: 'btn-share-lyrics', el: btnShareLyrics },
      { id: 'btn-close-share-lyrics', el: btnCloseShareLyrics },
      { id: 'share-lyrics-lines-list', el: shareLyricsLinesList },
      { id: 'share-lyrics-counter', el: shareLyricsCounter },
      { id: 'share-lyrics-canvas', el: shareLyricsCanvas },
      { id: 'btn-copy-lyrics-image', el: btnCopyLyricsImage },
      { id: 'btn-download-lyrics-card', el: btnDownloadLyricsCard }
    ];

    const missingNodes = requiredNodes.filter(n => !n.el);
    if (missingNodes.length > 0) {
      console.warn('[ShareLyrics] Missing required DOM elements:', missingNodes.map(n => n.id).join(', '));
      if (!shareLyricsModal || !btnShareLyrics) return;
    }

    isShareLyricsInitialized = true;

    function openShareLyricsModal() {
      if (!shareLyricsModal) return;
      if (!state.syncedLyrics || !Array.isArray(state.syncedLyrics) || state.syncedLyrics.length === 0) {
        if (typeof showToast === 'function') {
          showToast('Không có lời bài hát để chia sẻ', 'warning');
        }
        return;
      }
      selectedLyricsIndices = [];
      renderShareLyricsLines();

      // Open modal immediately so user gets instant visual response
      shareLyricsModal.classList.remove('hidden');
      shareLyricsModal.classList.add('visible');

      // Extract artwork tint & render swatches non-blockingly
      const track = state.currentTrack || {};
      const coverUrl = track.artwork || track.coverUrl || '';
      if (typeof LyricsCardGenerator !== 'undefined' && typeof LyricsCardGenerator.extractDominantColor === 'function') {
        LyricsCardGenerator.extractDominantColor(coverUrl, '#2e1065').then((autoHex) => {
          selectedCardBackground = autoHex;
          if (shareLyricsCard) {
            shareLyricsCard.style.setProperty('--share-tint', `${autoHex}e6`);
          }
          renderShareLyricsSwatches(autoHex);
          updateShareLyricsPreview().catch(() => {});
        }).catch(() => {
          renderShareLyricsSwatches('#2e1065');
          updateShareLyricsPreview().catch(() => {});
        });
      } else {
        updateShareLyricsPreview().catch((err) => {
          console.warn('[ShareLyrics] Preview render failed:', err);
        });
      }
    }

    function renderShareLyricsSwatches(autoHex) {
      if (!shareLyricsSwatches) return;
      const presets = [
        { label: 'Artwork Tint', color: autoHex || '#2e1065' },
        { label: 'Eclipse Neon', color: '#7c3aed' },
        { label: 'Cyber Cyan', color: '#0891b2' },
        { label: 'Crimson Pulse', color: '#be123c' },
        { label: 'Midnight', color: '#0f172a' },
        { label: 'Paper Light', color: '#f4f1ea' }
      ];
      shareLyricsSwatches.innerHTML = '';
      presets.forEach((p) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'share-lyrics-swatch';
        if (selectedCardBackground.toLowerCase() === p.color.toLowerCase()) btn.classList.add('active');
        btn.style.background = p.color;
        btn.title = p.label;
        btn.setAttribute('aria-label', p.label);
        btn.onclick = () => {
          selectedCardBackground = p.color;
          shareLyricsSwatches.querySelectorAll('.share-lyrics-swatch').forEach(s => s.classList.remove('active'));
          btn.classList.add('active');
          updateShareLyricsPreview().catch(() => {});
        };
        shareLyricsSwatches.appendChild(btn);
      });
    }

    function closeShareLyricsModal() {
      if (!shareLyricsModal) return;
      shareLyricsModal.classList.remove('visible');
      shareLyricsModal.classList.add('hidden');
      selectedLyricsIndices = [];
    }

    function renderShareLyricsLines() {
      if (!shareLyricsLinesList || !state.syncedLyrics) return;
      shareLyricsLinesList.innerHTML = '';

      const lines = state.syncedLyrics.map((l, i) => ({
        text: (l.text || '').replace(/<[^>]+>/g, '').trim(),
        index: i
      })).filter(l => l.text.length > 0);

      const activeIdx = state.lastActiveLyricIdx >= 0 ? state.lastActiveLyricIdx : 0;
      const matchLine = lines.find(l => l.index === activeIdx) || lines[0];
      if (matchLine) selectedLyricsIndices = [matchLine.index];

      lines.forEach(lineItem => {
        const row = document.createElement('div');
        row.className = 'share-lyrics-line-item';
        if (selectedLyricsIndices.includes(lineItem.index)) row.classList.add('selected');

        const chk = document.createElement('div');
        chk.className = 'share-lyrics-line-checkbox';
        const textSpan = document.createElement('span');
        textSpan.textContent = lineItem.text;

        row.appendChild(chk);
        row.appendChild(textSpan);

        row.addEventListener('click', () => {
          handleLineSelectionToggle(lineItem.index);
        });

        shareLyricsLinesList.appendChild(row);
      });

      updateShareLyricsCounter();
    }

    function handleLineSelectionToggle(lineIndex) {
      if (selectedLyricsIndices.length === 0) {
        selectedLyricsIndices = [lineIndex];
      } else {
        const minIdx = selectedLyricsIndices[0];
        const maxIdx = selectedLyricsIndices[selectedLyricsIndices.length - 1];
        if (selectedLyricsIndices.includes(lineIndex)) {
          if (selectedLyricsIndices.length === 1) {
            selectedLyricsIndices = [];
          } else if (lineIndex === minIdx) {
            selectedLyricsIndices = selectedLyricsIndices.slice(1);
          } else if (lineIndex === maxIdx) {
            selectedLyricsIndices = selectedLyricsIndices.slice(0, -1);
          } else {
            selectedLyricsIndices = [lineIndex];
          }
        } else {
          const newMin = Math.min(minIdx, lineIndex);
          const newMax = Math.max(maxIdx, lineIndex);
          if (newMax - newMin + 1 <= 5) {
            selectedLyricsIndices = [];
            for (let i = newMin; i <= newMax; i++) selectedLyricsIndices.push(i);
          } else {
            if (typeof showToast === 'function') {
              showToast('Tối đa chọn 5 câu liên tiếp', 'warning');
            }
            selectedLyricsIndices = [lineIndex];
          }
        }
      }

      if (shareLyricsLinesList) {
        const items = shareLyricsLinesList.querySelectorAll('.share-lyrics-line-item');
        items.forEach((item, idx) => {
          item.classList.toggle('selected', selectedLyricsIndices.includes(idx));
        });
      }

      updateShareLyricsCounter();
      updateShareLyricsPreview().catch(() => {});
    }

    function updateShareLyricsCounter() {
      if (shareLyricsCounter) {
        shareLyricsCounter.textContent = `${selectedLyricsIndices.length}/5`;
      }
    }

    async function updateShareLyricsPreview() {
      if (!shareLyricsCanvas || typeof LyricsCardGenerator === 'undefined') return;
      const linesToRender = selectedLyricsIndices.length > 0
        ? selectedLyricsIndices.map(i => (state.syncedLyrics[i] ? state.syncedLyrics[i].text : '')).filter(Boolean)
        : ['(Chọn 1–5 câu ở danh sách bên trái)'];

      const track = state.currentTrack || { title: 'Unknown Title', artist: 'Unknown Artist' };
      const coverUrl = track.artwork || track.coverUrl || '';

      try {
        const renderedCanvas = await LyricsCardGenerator.generateCanvasCard({
          lines: linesToRender,
          title: track.title || 'Unknown Title',
          artist: track.artist || 'Unknown Artist',
          coverUrl: coverUrl,
          background: selectedCardBackground || undefined,
          width: 800,
          height: 1000
        });

        shareLyricsCanvas.width = 800;
        shareLyricsCanvas.height = 1000;
        const ctx = shareLyricsCanvas.getContext('2d');
        ctx.drawImage(renderedCanvas, 0, 0);
      } catch (err) {
        console.warn('[ShareLyrics] Preview render warning:', err);
      }
    }

    btnShareLyrics.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      openShareLyricsModal();
    };

    if (btnCloseShareLyrics) {
      btnCloseShareLyrics.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeShareLyricsModal();
      };
    }

    shareLyricsModal.onclick = (e) => {
      if (e.target === shareLyricsModal) closeShareLyricsModal();
    };

    if (btnCopyLyricsImage) {
      btnCopyLyricsImage.onclick = async () => {
        try {
          if (!shareLyricsCanvas) return;
          shareLyricsCanvas.toBlob(async (blob) => {
            if (!blob) {
              if (typeof showToast === 'function') showToast('Không thể tạo ảnh lời bài hát', 'error');
              return;
            }
            if (navigator.clipboard && navigator.clipboard.write) {
              await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
              if (typeof showToast === 'function') showToast('Đã sao chép ảnh thẻ lời bài hát vào bộ nhớ tạm', 'info');
            } else {
              if (typeof showToast === 'function') showToast('Trình duyệt không hỗ trợ sao chép ảnh', 'warning');
            }
          }, 'image/png');
        } catch (err) {
          if (typeof showToast === 'function') showToast('Lỗi sao chép ảnh: ' + err.message, 'error');
        }
      };
    }

    if (btnDownloadLyricsCard) {
      btnDownloadLyricsCard.onclick = () => {
        try {
          if (!shareLyricsCanvas) return;
          const dataUrl = shareLyricsCanvas.toDataURL('image/png');
          const link = document.createElement('a');
          const safeTitle = (state.currentTrack ? state.currentTrack.title : 'lyrics')
            .replace(/[^a-zA-Z0-9_-]/g, '_')
            .toLowerCase();
          link.download = `${safeTitle}_lyrics_card.png`;
          link.href = dataUrl;
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          if (typeof showToast === 'function') showToast('Đã lưu ảnh thẻ lời bài hát', 'info');
        } catch (err) {
          if (typeof showToast === 'function') showToast('Lỗi lưu ảnh: ' + err.message, 'error');
        }
      };
    }
  }

  // Independent DOM ready trigger without arbitrary delay
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initShareLyricsUI);
  } else {
    initShareLyricsUI();
  }

});


document.addEventListener('DOMContentLoaded', () => {
  const btnCollapseRightPanel = document.getElementById('btn-collapse-right-panel');
  const rightPanel = document.getElementById('right-panel');
  if (btnCollapseRightPanel && rightPanel) {
    btnCollapseRightPanel.addEventListener('click', () => {
      rightPanel.classList.toggle('is-collapsed');
    });
  }
});




  
  // --- ECLIPSE DONATE FEATURE ---
  function openExternalLink(url) {
    if (!url) return;
    try {
      if (window.electronAPI && typeof window.electronAPI.openExternal === 'function') {
        window.electronAPI.openExternal(url);
      } else {
        window.open(url, '_blank', 'noopener,noreferrer');
      }
    } catch (_) {
      try { window.open(url, '_blank'); } catch (__) {}
    }
  }

  function openDonateModal(isMilestone = false) {
    const modal = document.getElementById('donate-modal');
    if (!modal) return;
    const subtitle = document.getElementById('donate-modal-subtitle');
    if (subtitle) {
      subtitle.textContent = isMilestone
        ? 'Cảm ơn bạn đã đồng hành cùng Eclipse! Hãy ủng hộ dev một ly cà phê nếu bạn thấy app hữu ích nhé ☕'
        : 'Mời lập trình viên ly cà phê để tiếp tục duy trì app';
    }
    if (typeof openModal === 'function') {
      openModal(modal);
    } else {
      modal.classList.remove('hidden');
      modal.classList.add('visible');
    }
  }

  function closeDonateModal() {
    const modal = document.getElementById('donate-modal');
    if (!modal) return;
    if (typeof closeModal === 'function') {
      closeModal(modal);
    } else {
      modal.classList.remove('visible');
      modal.classList.add('hidden');
    }
  }

  function initDonateFeature() {
    const btnSidebar = document.getElementById('btn-sidebar-donate');
    if (btnSidebar) {
      btnSidebar.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        openDonateModal(false);
      };
    }

    const btnSettings = document.getElementById('btn-settings-open-donate');
    if (btnSettings) {
      btnSettings.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        openDonateModal(false);
      };
    }

    const btnClose = document.getElementById('btn-close-donate-modal');
    if (btnClose) {
      btnClose.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeDonateModal();
      };
    }

    const btnCloseOk = document.getElementById('btn-close-donate-ok');
    if (btnCloseOk) {
      btnCloseOk.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeDonateModal();
      };
    }

    const btnDismissForever = document.getElementById('btn-donate-dismiss-forever');
    if (btnDismissForever) {
      btnDismissForever.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        try {
          localStorage.setItem('eclipse_donate_dismissed', 'forever');
          if (window.electronAPI && window.electronAPI.storageSaveSync && window.__RIFF_STORAGE_MAP__) {
            window.__RIFF_STORAGE_MAP__['eclipse_donate_dismissed'] = 'forever';
            try { window.electronAPI.storageSaveSync(window.__RIFF_STORAGE_MAP__); } catch (_) {}
          }
        } catch (_) {}
        closeDonateModal();
        if (typeof showToast === 'function') {
          showToast('Cảm ơn bạn rất nhiều! Eclipse sẽ không nhắc lại nữa.', 'info');
        }
      };
    }

    const modal = document.getElementById('donate-modal');
    if (modal) {
      modal.onclick = (e) => {
        if (e.target === modal) closeDonateModal();
      };
    }

    // Tabs
    const tabs = document.querySelectorAll('#donate-tabs .sp-mode-btn');
    tabs.forEach(btn => {
      btn.onclick = (e) => {
        e.preventDefault();
        tabs.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const tabKey = btn.dataset.tab;
        document.querySelectorAll('.donate-tab-content').forEach(c => c.classList.add('hidden'));
        const target = document.getElementById('donate-tab-' + tabKey);
        if (target) target.classList.remove('hidden');
      };
    });

    // External buttons
    document.querySelectorAll('.donate-ext-btn').forEach(btn => {
      btn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const url = btn.dataset.url;
        if (url) openExternalLink(url);
      };
    });

    // Copy helper
    async function copyText(text, successMsg) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
        } else {
          const ta = document.createElement('textarea');
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
        }
        if (typeof showToast === 'function') showToast(successMsg, 'success');
      } catch (_) {
        if (typeof showToast === 'function') showToast(text, 'info');
      }
    }

    const btnCopyStk = document.getElementById('btn-copy-stk');
    if (btnCopyStk) {
      btnCopyStk.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        copyText('57995999', 'Đã copy số tài khoản MBBank: 57995999!');
      };
    }

    async function saveQrImage() {
      try {
        const qrImg = document.getElementById('donate-qr-img');
        if (!qrImg) return;

        // Try Canvas DataURL conversion first (highest fidelity & direct download)
        const canvas = document.createElement('canvas');
        canvas.width = qrImg.naturalWidth || 600;
        canvas.height = qrImg.naturalHeight || 800;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(qrImg, 0, 0, canvas.width, canvas.height);

        const dataUrl = canvas.toDataURL('image/jpeg', 0.95);
        const filename = 'VietQR-MBBank-57995999-VOVANGIAMINH.jpg';

        const a = document.createElement('a');
        a.href = dataUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);

        if (typeof showToast === 'function') {
          showToast('Đã lưu mã QR về máy thành công!', 'success');
        }
      } catch (err) {
        // Fallback: direct download link
        try {
          const qrImg = document.getElementById('donate-qr-img');
          const src = (qrImg && qrImg.src) || 'assets/donate-vietqr.jpg';
          const a = document.createElement('a');
          a.href = src;
          a.download = 'VietQR-MBBank-57995999-VOVANGIAMINH.jpg';
          a.target = '_blank';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          if (typeof showToast === 'function') {
            showToast('Đang tải ảnh mã QR về máy...', 'info');
          }
        } catch (_) {
          if (typeof showToast === 'function') {
            showToast('Vui lòng chạm giữ vào ảnh để lưu ảnh về máy', 'info');
          }
        }
      }
    }

    const btnSaveQr = document.getElementById('btn-save-qr-img');
    if (btnSaveQr) {
      btnSaveQr.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (typeof recordDonateUserAction === 'function') recordDonateUserAction('saved_qr_image');
        saveQrImage();
      };
    }


    const btnCopyBep20 = document.getElementById('btn-copy-bep20');
    if (btnCopyBep20) {
      btnCopyBep20.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        copyText('0x37d1e10a2ba7f99ba758b644510c73ef16d5dd77', 'Đã copy địa chỉ ví BNB Smart Chain (BEP20)!');
      };
    }

    const btnCopyTrc20 = document.getElementById('btn-copy-trc20');
    if (btnCopyTrc20) {
      btnCopyTrc20.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        copyText('TL4eNxibcgmSx3RsnMN3QLZcLnKcXFAS27', 'Đã copy địa chỉ ví Tron (TRC20)!');
      };
    }
  }

  function checkDonatePromptMilestone() {
    try {
      const dismissed = localStorage.getItem('eclipse_donate_dismissed');
      if (dismissed === 'forever') return;

      let playedCount = parseInt(localStorage.getItem('eclipse_tracks_played_count') || '0', 10) + 1;
      localStorage.setItem('eclipse_tracks_played_count', String(playedCount));

      // Trigger milestone after 20 tracks played
      if (playedCount < 20) return;

      const lastPrompt = parseInt(localStorage.getItem('eclipse_donate_last_prompt') || '0', 10);
      const now = Date.now();
      const FOURTEEN_DAYS = 14 * 24 * 60 * 60 * 1000;

      if (!lastPrompt || (now - lastPrompt >= FOURTEEN_DAYS)) {
        localStorage.setItem('eclipse_donate_last_prompt', String(now));
        setTimeout(() => {
          openDonateModal(true);
        }, 2000);
      }
    } catch (_) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initDonateFeature);
  } else {
    setTimeout(initDonateFeature, 100);
  }

  // Periodic background library sync (only runs when app is active; coordinated via single-flight)
  setInterval(() => {
    if (googleConnected && !document.hidden && typeof autoSyncYtmLibraryOnLogin === 'function') {
      autoSyncYtmLibraryOnLogin(null, { trigger: 'background' }).catch(() => {});
    }
  }, 60 * 60 * 1000);

  // Authoritative External Session Connection Center Controller
  (function initExternalSessionController() {
    const VALID_STATES = new Set([
      'not_installed',
      'unpaired',
      'pairing',
      'connected',
      'expired',
      'error',
      'reconnect',
      'disconnect',
      'manual_fallback'
    ]);

    const dialog = document.getElementById('external-session-dialog');
    const btnOpen = document.getElementById('btn-open-external-session');
    const btnClose = document.getElementById('btn-close-external-session');
    const chkConsent = document.getElementById('chk-external-consent');

    const badgePkce = document.getElementById('ext-badge-pkce');
    const badgeBridge = document.getElementById('ext-badge-bridge');
    const badgeState = document.getElementById('ext-state-badge');
    const errorBox = document.getElementById('ext-session-error');

    const tabPkce = document.getElementById('tab-ext-pkce');
    const tabBridge = document.getElementById('tab-ext-bridge');
    const tabWindow = document.getElementById('tab-ext-window');
    const panePkce = document.getElementById('pane-ext-pkce');
    const paneBridge = document.getElementById('pane-ext-bridge');
    const paneWindow = document.getElementById('pane-ext-window');

    const btnStartPkce = document.getElementById('btn-ext-start-pkce');
    const btnCancelPkce = document.getElementById('btn-ext-cancel-pkce');
    const btnStartPairing = document.getElementById('btn-ext-start-pairing');
    const btnCancelPairing = document.getElementById('btn-ext-cancel-pairing');
    const btnRefreshProfiles = document.getElementById('btn-ext-refresh-profiles');
    const profilesList = document.getElementById('ext-profiles-list');
    const pairingInfo = document.getElementById('ext-pairing-info');
    const pairingPort = document.getElementById('ext-pairing-port');
    const pairingNonce = document.getElementById('ext-pairing-nonce');
    const pairingCountdown = document.getElementById('ext-pairing-countdown');
    const btnCopyPort = document.getElementById('btn-ext-copy-port');
    const btnCopyNonce = document.getElementById('btn-ext-copy-nonce');
    const btnCopyAll = document.getElementById('btn-ext-copy-all');
    const btnOpenLoginWindow = document.getElementById('btn-ext-open-login-window');

    const btnReconnect = document.getElementById('btn-ext-reconnect');
    const btnDisconnect = document.getElementById('btn-ext-disconnect');
    const btnManualFallback = document.getElementById('btn-ext-manual-fallback');

    if (!dialog) return;

    function getApi() {
      return window.eclipseAPI || window.electronAPI || null;
    }

    const controller = {
      state: 'unpaired',
      pkceStatus: 'unpaired',
      bridgeStatus: 'not_installed',
      activeOp: null,
      currentOperationId: 0,
      countdownTimer: null,
      unsubscribeResult: null,

      nextOperationId() {
        this.currentOperationId += 1;
        return this.currentOperationId;
      },

      isStaleOp(opId) {
        return typeof opId === 'number' && opId !== this.currentOperationId;
      },

      hasConsent() {
        return !!(chkConsent && chkConsent.checked);
      },

      setError(msg, tone = 'error') {
        if (!errorBox) return;
        if (!msg) {
          errorBox.textContent = '';
          errorBox.classList.add('hidden');
          errorBox.style.color = '';
          errorBox.style.background = '';
          errorBox.style.borderColor = '';
        } else {
          errorBox.textContent = String(msg);
          errorBox.classList.remove('hidden');
          if (tone === 'warning' || tone === 'info') {
            errorBox.style.color = '#fbbf24';
            errorBox.style.background = 'rgba(251, 191, 36, 0.12)';
            errorBox.style.borderColor = 'rgba(251, 191, 36, 0.3)';
          } else {
            errorBox.style.color = '';
            errorBox.style.background = '';
            errorBox.style.borderColor = '';
          }
        }
      },

      stopCountdown() {
        if (this.countdownTimer) {
          clearInterval(this.countdownTimer);
          this.countdownTimer = null;
        }
      },

      startCountdown(seconds) {
        this.stopCountdown();
        let remaining = Math.max(1, Number(seconds) || 120);
        if (pairingCountdown) pairingCountdown.textContent = String(remaining);
        this.countdownTimer = setInterval(() => {
          remaining -= 1;
          if (pairingCountdown) pairingCountdown.textContent = String(Math.max(0, remaining));
          if (remaining <= 0) {
            this.stopCountdown();
            if (this.state === 'pairing') {
              this.activeOp = null;
              this.applyState('error', { error: 'Pairing timed out. Try Official OAuth PKCE or Manual Fallback.' });
            }
          }
        }, 1000);
      },

      switchTab(mode) {
        const tabs = [
          [tabPkce, panePkce, 'pkce'],
          [tabBridge, paneBridge, 'bridge'],
          [tabWindow, paneWindow, 'window']
        ];
        tabs.forEach(([tab, pane, key]) => {
          const active = key === mode;
          if (tab) tab.classList.toggle('active', active);
          if (pane) pane.classList.toggle('hidden', !active);
        });
      },

      applyState(nextState, meta = {}) {
        const normalized = VALID_STATES.has(nextState) ? nextState : 'error';
        this.state = normalized;

        if (meta.pkceStatus) this.pkceStatus = meta.pkceStatus;
        if (meta.bridgeStatus) this.bridgeStatus = meta.bridgeStatus;

        if (badgeState) {
          badgeState.textContent = `State: ${normalized}`;
          badgeState.dataset.state = normalized;
        }
        if (badgePkce) {
          badgePkce.textContent = `Official PKCE: ${this.pkceStatus}`;
        }
        if (badgeBridge) {
          badgeBridge.textContent = `Experimental Bridge: ${this.bridgeStatus}`;
        }

        const consented = this.hasConsent();
        const busy = this.activeOp !== null || normalized === 'pairing';

        if (btnStartPkce) btnStartPkce.disabled = !consented || busy;
        if (btnStartPairing) btnStartPairing.disabled = !consented || busy;
        if (btnOpenLoginWindow) btnOpenLoginWindow.disabled = !consented || busy;

        if (btnCancelPkce) btnCancelPkce.classList.toggle('hidden', this.activeOp !== 'pkce');
        if (btnCancelPairing) btnCancelPairing.classList.toggle('hidden', this.activeOp !== 'pairing');
        if (pairingInfo) pairingInfo.classList.toggle('hidden', this.activeOp !== 'pairing');

        if (btnDisconnect) {
          btnDisconnect.classList.toggle('hidden', normalized !== 'connected' && normalized !== 'expired');
        }
        if (btnReconnect) {
          btnReconnect.classList.toggle('hidden', normalized !== 'expired' && normalized !== 'error' && normalized !== 'reconnect');
        }
        if (btnManualFallback) {
          btnManualFallback.classList.toggle('hidden', normalized !== 'error' && normalized !== 'not_installed' && normalized !== 'manual_fallback');
        }

        if (meta.error) {
          this.setError(meta.error, meta.errorTone || 'error');
        } else if (normalized === 'connected' || normalized === 'unpaired' || normalized === 'disconnect') {
          this.setError('');
        }
      },

      async syncStatus() {
        const api = getApi();
        if (!api || typeof api.externalSessionGetStatus !== 'function') {
          this.applyState('not_installed', {
            pkceStatus: 'unavailable',
            bridgeStatus: 'not_installed'
          });
          return;
        }
        const opId = this.nextOperationId();
        try {
          const res = await api.externalSessionGetStatus();
          if (this.isStaleOp(opId)) return;
          const state = (res && VALID_STATES.has(res.state)) ? res.state : (res && res.connected ? 'connected' : 'unpaired');
          this.applyState(state, {
            pkceStatus: (res && res.pkceStatus) || (state === 'connected' && res.method === 'pkce' ? 'connected' : 'ready'),
            bridgeStatus: (res && res.bridgeStatus) || 'experimental / not verified',
            error: res && res.error ? res.error : ''
          });
        } catch (err) {
          if (this.isStaleOp(opId)) return;
          this.applyState('error', { error: (err && err.message) || 'Failed to query external session status' });
        }
      },

      async startPkce() {
        if (this.activeOp || !this.hasConsent()) return;
        const spInput = document.getElementById('sp-client-id');
        const rawClientId = (spInput && typeof spInput.value === 'string' && spInput.value.trim())
          ? spInput.value.trim()
          : String(localStorage.getItem('eclipse_spotify_client_id') || '').trim();
        if (!/^[a-f0-9]{32}$/i.test(rawClientId)) {
          this.setError('Missing or invalid Spotify Client ID. Enter your 32-character hex Client ID in Settings before connecting.', 'error');
          return;
        }
        const api = getApi();
        if (!api || typeof api.externalSessionStartPkce !== 'function') {
          this.applyState('error', { error: 'Official PKCE IPC is unavailable in this runtime.' });
          return;
        }
        const opId = this.nextOperationId();
        this.activeOp = 'pkce';
        this.setError('');
        this.applyState('pairing', { pkceStatus: 'authorizing' });
        try {
          const res = await api.externalSessionStartPkce({ operationId: opId, clientId: rawClientId });
          if (this.isStaleOp(opId)) return;
          this.activeOp = null;
          if (res && res.canceled) {
            this.applyState('unpaired', { pkceStatus: 'unpaired' });
          } else if (res && res.success) {
            this.applyState('connected', { pkceStatus: 'connected' });
          } else {
            this.applyState('error', {
              pkceStatus: 'error',
              error: (res && res.error) || 'Official PKCE authorization failed.'
            });
          }
        } catch (err) {
          if (this.isStaleOp(opId)) return;
          this.activeOp = null;
          this.applyState('error', {
            pkceStatus: 'error',
            error: (err && err.message) || 'Official PKCE authorization failed.'
          });
        }
      },

      async cancelActiveOp() {
        const prevOp = this.activeOp;
        this.nextOperationId();
        this.activeOp = null;
        this.stopCountdown();
        const api = getApi();
        if (api && typeof api.externalSessionCancelPairing === 'function') {
          try { await api.externalSessionCancelPairing(); } catch (_) {}
        }
        this.applyState('unpaired', {
          pkceStatus: prevOp === 'pkce' ? 'unpaired' : this.pkceStatus,
          bridgeStatus: prevOp === 'pairing' ? 'unpaired' : this.bridgeStatus
        });
      },

      async startPairing() {
        if (this.activeOp || !this.hasConsent()) return;
        const api = getApi();
        if (!api || typeof api.externalSessionStartPairing !== 'function') {
          this.applyState('not_installed', { bridgeStatus: 'not_installed', error: 'Experimental Bridge IPC is unavailable.' });
          return;
        }
        const opId = this.nextOperationId();
        this.activeOp = 'pairing';
        this.setError('');
        this.applyState('pairing', { bridgeStatus: 'pairing' });
        try {
          const res = await api.externalSessionStartPairing({ operationId: opId });
          if (this.isStaleOp(opId)) return;
          if (res && res.success) {
            const resolvedNonce = res.nonce || res.pairingCode || '';
            if (pairingPort) pairingPort.textContent = res.port ? String(res.port) : '--';
            if (pairingNonce) pairingNonce.textContent = resolvedNonce ? String(resolvedNonce) : '--';
            this.startCountdown(res.timeoutSeconds || 120);
          } else {
            this.activeOp = null;
            this.applyState('error', {
              bridgeStatus: 'error',
              error: (res && res.error) || 'Failed to start experimental pairing.'
            });
          }
        } catch (err) {
          if (this.isStaleOp(opId)) return;
          this.activeOp = null;
          this.applyState('error', {
            bridgeStatus: 'error',
            error: (err && err.message) || 'Failed to start experimental pairing.'
          });
        }
      },

      async refreshProfiles() {
        const api = getApi();
        if (!profilesList) return;
        if (!api || typeof api.externalSessionGetProfiles !== 'function') {
          profilesList.innerHTML = '<div class="browser-profiles-empty">Profile discovery unavailable.</div>';
          return;
        }
        const opId = this.nextOperationId();
        profilesList.innerHTML = '<div class="browser-profiles-empty">Scanning local browser profiles...</div>';
        try {
          const res = await api.externalSessionGetProfiles();
          if (this.isStaleOp(opId)) return;
          const items = (res && Array.isArray(res.profiles)) ? res.profiles : [];
          if (!items.length) {
            profilesList.innerHTML = '<div class="browser-profiles-empty">No external browser profiles detected.</div>';
            return;
          }
          profilesList.innerHTML = '';
          items.forEach((p) => {
            const row = document.createElement('div');
            row.className = 'extension-path-box';
            row.style.margin = '4px 0';
            row.textContent = `${p.browser || 'Browser'} — ${p.label || p.profileId || 'Profile'} (${p.status || 'Experimental / Not verified'})`;
            profilesList.appendChild(row);
          });
        } catch (_) {
          if (this.isStaleOp(opId)) return;
          profilesList.innerHTML = '<div class="browser-profiles-empty">Failed to scan browser profiles.</div>';
        }
      },

      async openLoginWindow() {
        if (this.activeOp || !this.hasConsent()) return;
        const api = getApi();
        if (!api || typeof api.externalSessionOpenLoginWindow !== 'function') {
          this.applyState('manual_fallback', { error: 'Isolated Login Window is not available in this build.' });
          return;
        }
        const opId = this.nextOperationId();
        this.activeOp = 'window';
        this.setError('');
        this.applyState('manual_fallback');
        try {
          const res = await api.externalSessionOpenLoginWindow({ operationId: opId });
          if (this.isStaleOp(opId)) return;
          this.activeOp = null;
          if (res && (res.webSessionUnverified || res.error === 'spotify_web_session_unverified')) {
            this.applyState('unpaired', {
              bridgeStatus: 'unverified local web session',
              error: 'Unverified local web session captured. This does not authenticate your account — use Official OAuth PKCE to connect.',
              errorTone: 'warning'
            });
          } else if (res && res.canceled) {
            this.applyState('unpaired');
          } else {
            this.applyState('error', { error: (res && res.error) || 'Isolated login window did not complete.' });
          }
        } catch (err) {
          if (this.isStaleOp(opId)) return;
          this.activeOp = null;
          this.applyState('error', { error: (err && err.message) || 'Isolated login window failed.' });
        }
      },

      async disconnect() {
        this.nextOperationId();
        this.activeOp = null;
        this.stopCountdown();
        const api = getApi();
        this.applyState('disconnect');
        if (api && typeof api.externalSessionLogout === 'function') {
          try { await api.externalSessionLogout(); } catch (_) {}
        }
        this.applyState('unpaired', { pkceStatus: 'unpaired', bridgeStatus: 'unpaired' });
      },

      open() {
        dialog.classList.remove('hidden');
        dialog.classList.add('visible');
        this.switchTab('pkce');
        this.syncStatus();
      },

      close() {
        dialog.classList.remove('visible');
        dialog.classList.add('hidden');
        if (this.activeOp) {
          this.cancelActiveOp();
        }
      }
    };

    const api = getApi();
    if (api && typeof api.onExternalSessionResult === 'function') {
      controller.unsubscribeResult = api.onExternalSessionResult((payload) => {
        if (!payload || typeof payload !== 'object') return;
        if (payload.operationId !== undefined && controller.isStaleOp(payload.operationId)) return;
        controller.activeOp = null;
        controller.stopCountdown();
        if (payload.success && !payload.webSessionUnverified && payload.error !== 'spotify_web_session_unverified') {
          controller.applyState('connected', {
            pkceStatus: payload.method === 'pkce' ? 'connected' : controller.pkceStatus,
            bridgeStatus: controller.bridgeStatus
          });
        } else if (payload.webSessionUnverified || payload.error === 'spotify_web_session_unverified') {
          controller.applyState('unpaired', {
            bridgeStatus: 'unverified local web session',
            error: 'Unverified local web session captured. This does not authenticate your account — use Official OAuth PKCE to connect.',
            errorTone: 'warning'
          });
        } else if (payload.canceled) {
          controller.applyState('unpaired');
        } else {
          controller.applyState(payload.state || 'error', {
            error: payload.error || 'External session connection failed.'
          });
        }
      });
    }

    if (btnOpen) btnOpen.addEventListener('click', () => controller.open());
    if (btnClose) btnClose.addEventListener('click', () => controller.close());
    if (chkConsent) chkConsent.addEventListener('change', () => controller.applyState(controller.state));
    if (tabPkce) tabPkce.addEventListener('click', () => controller.switchTab('pkce'));
    if (tabBridge) tabBridge.addEventListener('click', () => controller.switchTab('bridge'));
    if (tabWindow) tabWindow.addEventListener('click', () => controller.switchTab('window'));
    if (btnStartPkce) btnStartPkce.addEventListener('click', () => controller.startPkce());
    if (btnCancelPkce) btnCancelPkce.addEventListener('click', () => controller.cancelActiveOp());
    if (btnStartPairing) btnStartPairing.addEventListener('click', () => controller.startPairing());
    if (btnCancelPairing) btnCancelPairing.addEventListener('click', () => controller.cancelActiveOp());
    const copyWithFeedback = (btn, text) => {
      if (!text || text === '--' || !navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') return;
      navigator.clipboard.writeText(text).then(() => {
        const orig = btn.textContent;
        btn.textContent = 'Copied';
        setTimeout(() => { btn.textContent = orig; }, 1200);
      }).catch(() => {});
    };
    if (btnCopyPort) btnCopyPort.addEventListener('click', () => copyWithFeedback(btnCopyPort, pairingPort ? pairingPort.textContent.trim() : ''));
    if (btnCopyNonce) btnCopyNonce.addEventListener('click', () => copyWithFeedback(btnCopyNonce, pairingNonce ? pairingNonce.textContent.trim() : ''));
    if (btnCopyAll) btnCopyAll.addEventListener('click', () => {
      const p = pairingPort ? pairingPort.textContent.trim() : '';
      const n = pairingNonce ? pairingNonce.textContent.trim() : '';
      if (p && p !== '--' && n && n !== '--') {
        copyWithFeedback(btnCopyAll, `Port: ${p}\nNonce: ${n}`);
      }
    });
    if (btnRefreshProfiles) btnRefreshProfiles.addEventListener('click', () => controller.refreshProfiles());
    if (btnOpenLoginWindow) btnOpenLoginWindow.addEventListener('click', () => controller.openLoginWindow());
    if (btnDisconnect) btnDisconnect.addEventListener('click', () => controller.disconnect());
    if (btnReconnect) btnReconnect.addEventListener('click', () => {
      controller.applyState('reconnect');
      controller.switchTab('pkce');
    });
    if (btnManualFallback) btnManualFallback.addEventListener('click', () => {
      controller.applyState('manual_fallback');
      controller.switchTab('window');
    });

    window.ExternalSessionController = controller;
    controller.syncStatus();
  })();
