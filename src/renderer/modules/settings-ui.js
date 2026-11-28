// src/renderer/modules/settings-ui.js
// Settings UI, proxy manager, custom themes, plugins, CSS editor, and audio output device controls.

function normalizeProxyString(raw) {
  let clean = String(raw || '').trim();
  if (!clean) return '';
  if (clean.includes('://')) return clean;

  const quadMatch = clean.match(/^([^:]+):(\d+):([^:]+):(.+)$/);
  if (quadMatch) {
    const [, host, port, user, pass] = quadMatch;
    return `socks5://${user}:${pass}@${host}:${port}`;
  }

  const pairMatch = clean.match(/^([^:]+):(\d+)$/);
  if (pairMatch) {
    const [, host, port] = pairMatch;
    const httpPorts = ['8080', '8888', '3128', '10809'];
    const protocol = httpPorts.includes(port) ? 'http://' : 'socks5://';
    return `${protocol}${host}:${port}`;
  }

  return `socks5://${clean}`;
}

function initProxyManager() {
  const btnProxyEnable = document.getElementById('btn-proxy-enable');
  const proxyInputUrl = document.getElementById('proxy-input-url');
  const btnProxyAdd = document.getElementById('btn-proxy-add');
  const btnProxyTest = document.getElementById('btn-proxy-test');
  const proxyListContainer = document.getElementById('proxy-list-container');

  function getProxyList() {
    try {
      const raw = localStorage.getItem('eclipse_proxy_list');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }

  function saveProxyList(list) {
    localStorage.setItem('eclipse_proxy_list', JSON.stringify(list));
  }

  function isProxyEnabled() {
    return localStorage.getItem('eclipse_proxy_enabled') === 'true';
  }

  function getActiveProxy() {
    const list = getProxyList();
    if (!list.length) return null;
    const activeId = localStorage.getItem('eclipse_proxy_active_id');
    return list.find(p => p.id === activeId) || list[0];
  }

  function syncActiveProxyToBackend() {
    const enabled = isProxyEnabled();
    const activeProxy = getActiveProxy();
    const activeProxyUrl = (enabled && activeProxy) ? activeProxy.url : '';
    const payload = {
      enabled: Boolean(enabled && activeProxyUrl),
      proxyUrl: activeProxyUrl
    };

    const port = state.serverPort || 38472;
    fetch(`http://127.0.0.1:${port}/api/proxy-config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).catch(e => console.error('Failed to sync proxy config to server', e));

    if (window.electronAPI && typeof window.electronAPI.setAppProxy === 'function') {
      window.electronAPI.setAppProxy(payload.enabled ? activeProxyUrl : '').catch(e => console.error('Failed to set app proxy', e));
    }
  }

  function renderProxyList() {
    if (!proxyListContainer) return;
    const list = getProxyList();
    const activeProxy = getActiveProxy();
    const activeId = activeProxy ? activeProxy.id : null;

    if (!list.length) {
      proxyListContainer.innerHTML = '<div style="font-size: 12px; opacity: 0.6; padding: 6px 4px;">No proxies configured</div>';
      return;
    }

    proxyListContainer.innerHTML = '';
    list.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'proxy-list-item' + (item.id === activeId ? ' active' : '');
      row.dataset.proxyId = item.id;

      let proto = 'PROXY';
      try {
        const u = new URL(item.url);
        proto = u.protocol.replace(':', '').toUpperCase();
      } catch (_) {
        if (item.url.startsWith('socks5://')) proto = 'SOCKS5';
        else if (item.url.startsWith('http://')) proto = 'HTTP';
        else if (item.url.startsWith('https://')) proto = 'HTTPS';
      }

      const left = document.createElement('div');
      left.className = 'proxy-item-left';

      const badge = document.createElement('span');
      badge.className = 'proxy-item-badge';
      badge.textContent = proto;

      const urlSpan = document.createElement('span');
      urlSpan.className = 'proxy-item-url';
      urlSpan.textContent = item.url;
      urlSpan.title = item.url;

      left.appendChild(badge);
      left.appendChild(urlSpan);

      const right = document.createElement('div');
      right.style.display = 'flex';
      right.style.alignItems = 'center';
      right.style.gap = '8px';
      right.style.flexShrink = '0';

      if (typeof item.ping === 'number') {
        const pingSpan = document.createElement('span');
        pingSpan.className = 'proxy-item-ping';
        pingSpan.textContent = `${item.ping} ms`;
        right.appendChild(pingSpan);
      }

      const btnRemove = document.createElement('button');
      btnRemove.type = 'button';
      btnRemove.className = 'btn-proxy-remove';
      btnRemove.title = 'Remove proxy';
      btnRemove.setAttribute('aria-label', 'Remove proxy');
      btnRemove.innerHTML = '&minus;';

      btnRemove.addEventListener('click', (e) => {
        e.stopPropagation();
        let currentList = getProxyList();
        currentList = currentList.filter(p => p.id !== item.id);
        saveProxyList(currentList);
        if (localStorage.getItem('eclipse_proxy_active_id') === item.id) {
          const nextActive = currentList[0];
          if (nextActive) {
            localStorage.setItem('eclipse_proxy_active_id', nextActive.id);
          } else {
            localStorage.removeItem('eclipse_proxy_active_id');
          }
        }
        renderProxyList();
        syncActiveProxyToBackend();
      });

      right.appendChild(btnRemove);

      row.appendChild(left);
      row.appendChild(right);

      row.addEventListener('click', () => {
        localStorage.setItem('eclipse_proxy_active_id', item.id);
        renderProxyList();
        syncActiveProxyToBackend();
      });

      proxyListContainer.appendChild(row);
    });
  }

  if (btnProxyEnable) {
    btnProxyEnable.classList.toggle('active', isProxyEnabled());
    btnProxyEnable.addEventListener('click', () => {
      const next = !isProxyEnabled();
      localStorage.setItem('eclipse_proxy_enabled', next ? 'true' : 'false');
      btnProxyEnable.classList.toggle('active', next);
      syncActiveProxyToBackend();
    });
  }

  function handleAdd() {
    if (!proxyInputUrl) return;
    const raw = proxyInputUrl.value.trim();
    const url = normalizeProxyString(raw);
    if (!url) {
      showToast('Please enter a proxy URL');
      return;
    }
    const list = getProxyList();
    const newProxy = {
      id: 'pxy_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      url,
      ping: null
    };
    list.push(newProxy);
    saveProxyList(list);
    localStorage.setItem('eclipse_proxy_active_id', newProxy.id);
    localStorage.setItem('eclipse_proxy_enabled', 'true');
    if (btnProxyEnable) btnProxyEnable.classList.add('active');
    proxyInputUrl.value = '';
    renderProxyList();
    syncActiveProxyToBackend();
    showToast('Proxy added and activated');
  }

  if (btnProxyAdd) {
    btnProxyAdd.addEventListener('click', handleAdd);
  }
  if (proxyInputUrl) {
    proxyInputUrl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleAdd();
      }
    });
  }

  if (btnProxyTest) {
    btnProxyTest.addEventListener('click', async () => {
      const activeProxy = getActiveProxy();
      if (!activeProxy) {
        showToast('No active proxy to test');
        return;
      }
      btnProxyTest.disabled = true;
      showToast('Testing proxy connection...');
      try {
        const port = state.serverPort || 38472;
        const res = await fetch(`http://127.0.0.1:${port}/api/proxy-test`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ proxyUrl: activeProxy.url })
        });
        const data = await res.json();
        if (data && data.success && typeof data.pingMs === 'number') {
          const list = getProxyList();
          const target = list.find(p => p.id === activeProxy.id);
          if (target) {
            target.ping = data.pingMs;
            saveProxyList(list);
          }
          renderProxyList();
          showToast('Proxy connected (' + data.pingMs + ' ms)');
        } else {
          showToast('Proxy connection failed');
        }
      } catch (_) {
        showToast('Proxy connection failed');
      } finally {
        btnProxyTest.disabled = false;
      }
    });
  }

  renderProxyList();
  syncActiveProxyToBackend();
}

function captureSongQualitySnapshot(requestedValue) {
  const label = document.getElementById('label-song-quality');
  const menu = document.getElementById('menu-song-quality');
  const selectedEl = menu ? menu.querySelector('.m3-dropdown-option.selected') : null;
  let localStorageReadback = null;
  try {
    localStorageReadback = localStorage.getItem('eclipse_audio_quality');
  } catch (_) {}
  const storageMapValue = (typeof window !== 'undefined' && window.__RIFF_STORAGE_MAP__ && typeof window.__RIFF_STORAGE_MAP__ === 'object')
    ? (Object.prototype.hasOwnProperty.call(window.__RIFF_STORAGE_MAP__, 'eclipse_audio_quality') ? window.__RIFF_STORAGE_MAP__['eclipse_audio_quality'] : null)
    : null;
  return {
    requestedValue: requestedValue ?? null,
    localStorageReadback,
    storageMapValue,
    dropdownLabel: label ? label.textContent.trim() : null,
    selectedOption: selectedEl ? (selectedEl.dataset.val || null) : null,
    timestamp: new Date().toISOString()
  };
}

function logSongQualityDiagnostic(stage, requestedValue) {
  const snap = captureSongQualitySnapshot(requestedValue);
  console.info(`[quality-setting] ${stage}`, snap);
  if (requestedValue === 'high' || requestedValue === 'max') {
    const failedSteps = [];
    if (snap.localStorageReadback !== requestedValue) failedSteps.push(`localStorageReadback=${snap.localStorageReadback}`);
    if (typeof window !== 'undefined' && window.__RIFF_STORAGE_MAP__ && snap.storageMapValue !== requestedValue) {
      failedSteps.push(`storageMap=${snap.storageMapValue}`);
    }
    if (snap.selectedOption !== requestedValue) failedSteps.push(`selectedOption=${snap.selectedOption}`);
    const expectedLabel = requestedValue === 'high' ? 'High' : 'Max';
    if (snap.dropdownLabel !== expectedLabel) failedSteps.push(`dropdownLabel=${snap.dropdownLabel}`);
    if (failedSteps.length > 0) {
      console.warn(`[quality-setting] persistence-mismatch at ${stage}: requested=${requestedValue}, failed=[${failedSteps.join(', ')}]`);
    }
  }
  return snap;
}

function initSongQualitySetting() {
  const drop = document.getElementById('dropdown-song-quality');
  const trigger = document.getElementById('btn-song-quality-trigger');
  const label = document.getElementById('label-song-quality');
  const menu = document.getElementById('menu-song-quality');

  if (!drop || !trigger || !menu) return;

  const qualityNames = { low: 'Low', medium: 'Medium', high: 'High', max: 'Max' };
  const saved = localStorage.getItem('eclipse_audio_quality');
  if (saved && !qualityNames[saved]) {
    console.warn(`[quality-setting] invalid-saved-value at init: saved=${saved}`);
  }
  const active = (saved && qualityNames[saved]) ? saved : 'medium';

  const applySelection = (val) => {
    if (label) label.textContent = qualityNames[val] || 'Medium';
    menu.querySelectorAll('.m3-dropdown-option').forEach(opt => {
      opt.classList.toggle('selected', opt.dataset.val === val);
    });
  };

  applySelection(active);

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    drop.classList.toggle('open');
  });

  menu.querySelectorAll('.m3-dropdown-option').forEach(opt => {
    opt.addEventListener('click', (e) => {
      e.stopPropagation();
      const val = opt.dataset.val;
      if (val) {
        window.__eclipseLastRequestedQuality = val;
        localStorage.setItem('eclipse_audio_quality', val);
        applySelection(val);
      }
      drop.classList.remove('open');
      logSongQualityDiagnostic('click', val || null);
      queueMicrotask(() => {
        logSongQualityDiagnostic('immediate-readback', val || null);
      });
      setTimeout(() => {
        logSongQualityDiagnostic('delayed-readback', val || null);
      }, 300);
    });
  });

  document.addEventListener('click', () => {
    drop.classList.remove('open');
  });

  window.__eclipseQualitySettingInitialized = true;
}

function showSettingsCategory(cat) {
  if (cat === 'appearance' || cat === 'overview' || !cat) cat = 'home';
  document.querySelectorAll('#view-settings .setting-item').forEach(i => i.classList.remove('hidden'));
  document.querySelectorAll('#view-settings .settings-section').forEach(s => s.classList.toggle('cat-hidden', s.dataset.cat !== cat));
  document.querySelectorAll('#settings-nav .settings-nav-btn').forEach(b => b.classList.toggle('active', b.dataset.cat === cat));
  const pane = document.querySelector('#view-settings .settings-pane'); if (pane) pane.scrollTop = 0;
  try { localStorage.setItem('eclipse_settings_cat', cat); } catch (e) {}
  if (cat === 'custom-themes' && typeof renderThemeCards === 'function') renderThemeCards();
  if (cat === 'plugins' && typeof reloadPluginsList === 'function') reloadPluginsList();
  refreshStacks();
  if (window.__eclipseQualitySettingInitialized) {
    logSongQualityDiagnostic('settings-reopen', window.__eclipseLastRequestedQuality || null);
  }
}
window.showSettingsCategory = showSettingsCategory;

const settingsSearchInput = document.getElementById('settings-search-input');
if (settingsSearchInput) {
  settingsSearchInput.addEventListener('input', () => {
    const q = settingsSearchInput.value.trim().toLowerCase();
    const sections = document.querySelectorAll('#view-settings .settings-section');
    const activeNavBtn = document.querySelector('#view-settings .settings-nav-btn.active');
    const activeCat = activeNavBtn ? activeNavBtn.dataset.cat : 'interface';

    if (!q) {
      sections.forEach(sec => {
        sec.style.display = '';
        sec.classList.toggle('active', sec.dataset.cat === activeCat);
        sec.querySelectorAll('.setting-item, .m3-group, .settings-section-title, details, .ct-head, .ct-list, .about-hero').forEach(elNode => {
          elNode.style.display = '';
        });
      });
      return;
    }

    sections.forEach(sec => {
      const items = Array.from(sec.querySelectorAll('.setting-item'));
      let sectionMatchCount = 0;

      items.forEach(item => {
        const nameText = (item.querySelector('.setting-name')?.textContent || item.textContent || '').toLowerCase();
        const hintText = (item.querySelector('.setting-hint')?.textContent || '').toLowerCase();
        const matched = nameText.includes(q) || hintText.includes(q);
        item.style.display = matched ? '' : 'none';
        if (matched) sectionMatchCount++;
      });

      sec.querySelectorAll('.m3-group, details').forEach(grp => {
        const visibleInGrp = Array.from(grp.querySelectorAll('.setting-item')).some(it => it.style.display !== 'none');
        grp.style.display = visibleInGrp ? '' : 'none';
        if (visibleInGrp && grp.tagName === 'DETAILS') grp.open = true;
      });

      sec.querySelectorAll('.settings-section-title, .ct-head, .ct-list, .about-hero').forEach(extra => {
        extra.style.display = 'none';
      });

      if (sectionMatchCount > 0) {
        sec.classList.add('active');
        sec.style.display = 'block';
      } else {
        sec.classList.remove('active');
        sec.style.display = 'none';
      }
    });
  });
}

const settingsNav = document.getElementById('settings-nav');
if (settingsNav) {
  settingsNav.addEventListener('click', (e) => {
    const btn = e.target.closest('.settings-nav-btn');
    if (btn && btn.dataset.cat) {
      if (settingsSearchInput) settingsSearchInput.value = '';
      showSettingsCategory(btn.dataset.cat);
    }
  });
}

document.querySelectorAll('.settings-home-card').forEach(card => {
  card.addEventListener('click', () => {
    const cat = card.dataset.target;
    if (cat) showSettingsCategory(cat);
  });
});
const sliderUiAlphaHome = document.getElementById('slider-ui-alpha-home');
const valUiAlphaHome = document.getElementById('val-ui-alpha-home');
if (sliderUiAlphaHome && typeof el !== 'undefined' && el.sliderUiAlpha) {
  sliderUiAlphaHome.value = el.sliderUiAlpha.value;
  if (valUiAlphaHome) valUiAlphaHome.textContent = `${el.sliderUiAlpha.value}%`;
  sliderUiAlphaHome.addEventListener('input', (e) => {
    el.sliderUiAlpha.value = e.target.value;
    el.sliderUiAlpha.dispatchEvent(new Event('input'));
    if (valUiAlphaHome) valUiAlphaHome.textContent = `${e.target.value}%`;
  });
  el.sliderUiAlpha.addEventListener('input', () => {
    sliderUiAlphaHome.value = el.sliderUiAlpha.value;
    if (valUiAlphaHome) valUiAlphaHome.textContent = `${el.sliderUiAlpha.value}%`;
  });
}
const btnPerfHome = document.getElementById('btn-perf-mode-home');
const btnPerfMain = document.getElementById('btn-perf-mode');
if (btnPerfHome && btnPerfMain) {
  const syncPerfHome = () => btnPerfHome.classList.toggle('active', document.body.classList.contains('perf'));
  syncPerfHome();
  btnPerfHome.addEventListener('click', () => {
    btnPerfMain.click();
    syncPerfHome();
  });
  btnPerfMain.addEventListener('click', syncPerfHome);
}

let customThemes = [];
let appCssCache = null;

function applyCustomStyles() {
  document.querySelectorAll('style[data-riff-custom]').forEach((n) => n.remove());
  customThemes.filter((t) => t.enabled).forEach((t) => {
    const s = document.createElement('style');
    s.dataset.riffCustom = 'theme';
    s.dataset.themeId = t.id;
    s.textContent = t.css;
    document.head.appendChild(s);
  });
  const userCss = localStorage.getItem('eclipse_custom_css') || '';
  if (userCss.trim()) {
    const s = document.createElement('style');
    s.dataset.riffCustom = 'user';
    s.textContent = userCss;
    document.head.appendChild(s);
  }
  if (typeof refreshCachedThemeColors === 'function') refreshCachedThemeColors();
}

function resetCustomStyling() {
  const userCss = localStorage.getItem('eclipse_custom_css') || '';
  if (userCss.trim()) localStorage.setItem('eclipse_custom_css_backup', userCss);
  localStorage.removeItem('eclipse_custom_css');
  customThemes.forEach((t) => { t.enabled = false; });
  if (window.electronAPI && window.electronAPI.disableAllThemes) window.electronAPI.disableAllThemes();
  if (typeof cssEditorInstance !== 'undefined' && cssEditorInstance) cssEditorInstance.setValue('');
  if (window.electronAPI && window.electronAPI.disableAllPlugins) window.electronAPI.disableAllPlugins();
  pluginsCache.forEach((p) => { p.enabled = false; stopPlugin(p, true); });
  renderPluginCards();
  applyCustomStyles();
  renderThemeCards();
  showToast('Custom CSS, themes and plugins reset (Ctrl+Shift+R)', 'info');
}

window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === 'KeyR') {
    e.preventDefault();
    e.stopPropagation();
    resetCustomStyling();
  }
}, true);

async function mountThemePreview(host, themeCss) {
  if (!window.electronAPI || !window.electronAPI.getAppCss) return;
  if (appCssCache === null) appCssCache = (await window.electronAPI.getAppCss()) || '';
  const rewrite = (css) => css
    .replace(/:root/g, ':host')
    .replace(/(^|[\s,{};])html(?![\w-])/g, '$1:host')
    .replace(/(^|[\s,{};])body(?![\w-])/g, '$1.ct-mini');
  const root = host.shadowRoot || host.attachShadow({ mode: 'open' });
  root.textContent = '';
  const addStyle = (css) => {
    const styleEl = document.createElement('style');
    styleEl.textContent = css;
    root.appendChild(styleEl);
  };
  addStyle('.ct-mini{position:absolute;left:0;top:0;transform-origin:0 0;overflow:hidden;}');
  addStyle(rewrite(appCssCache));
  addStyle(rewrite(themeCss));
  const mini = document.createElement('div');
  mini.className = `ct-mini ${document.body.className}`;
  mini.style.width = `${window.innerWidth}px`;
  mini.style.height = `${window.innerHeight}px`;
  [...document.body.children].forEach((n) => {
    if (/^(SCRIPT|STYLE|LINK)$/.test(n.tagName) || n.classList.contains('modal-backdrop') || n.id === 'css-editor' || n.id === 'custom-bg') return;
    mini.appendChild(n.cloneNode(true));
  });
  mini.querySelectorAll('video, audio, canvas, iframe').forEach((n) => n.remove());
  root.appendChild(mini);
  const fit = () => { const w = host.clientWidth; if (w) mini.style.transform = `scale(${w / window.innerWidth})`; };
  new ResizeObserver(fit).observe(host);
  fit();
}

function renderThemeCards() {
  const list = document.getElementById('custom-themes-list');
  if (!list) return;
  list.innerHTML = '';
  if (!customThemes.length) {
    const empty = document.createElement('div');
    empty.className = 'ct-empty';
    empty.textContent = 'No themes yet. Click Add and choose a .css file.';
    list.appendChild(empty);
    return;
  }
  customThemes.forEach((t) => {
    const card = document.createElement('div');
    card.className = 'ct-card';
    card.innerHTML = '<div class="ct-preview"></div><div class="ct-info"><div class="ct-name"></div><div class="ct-meta"></div></div><button class="btn-icon-pill ct-remove" title="Remove"><svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg></button><button class="effect-switch-btn"><span class="thumb"></span></button>';
    card.querySelector('.ct-name').textContent = t.name;
    card.querySelector('.ct-meta').textContent = [t.author && `by ${t.author}`, t.description].filter(Boolean).join(' · ');
    const preview = card.querySelector('.ct-preview');
    preview.style.aspectRatio = `${window.innerWidth} / ${window.innerHeight}`;
    const toggle = card.querySelector('.effect-switch-btn');
    toggle.classList.toggle('active', !!t.enabled);
    toggle.addEventListener('click', () => {
      t.enabled = !t.enabled;
      toggle.classList.toggle('active', t.enabled);
      window.electronAPI.setThemeEnabled(t.id, t.enabled);
      applyCustomStyles();
    });
    card.querySelector('.ct-remove').addEventListener('click', () => {
      window.electronAPI.removeTheme(t.id);
      customThemes = customThemes.filter((x) => x.id !== t.id);
      applyCustomStyles();
      renderThemeCards();
      showToast('Theme removed', 'info');
    });
    list.appendChild(card);
    mountThemePreview(preview, t.css);
  });
}

async function loadCustomThemes() {
  if (!window.electronAPI || !window.electronAPI.listThemes) {
    applyCustomStyles();
    return;
  }
  customThemes = await window.electronAPI.listThemes();
  applyCustomStyles();
  renderThemeCards();
}

const btnAddTheme = document.getElementById('btn-add-theme');
if (btnAddTheme && window.electronAPI && window.electronAPI.importThemes) {
  btnAddTheme.addEventListener('click', async () => {
    const added = await window.electronAPI.importThemes();
    if (!added.length) return;
    customThemes.push(...added);
    renderThemeCards();
    showToast(`Added ${added.length} theme${added.length > 1 ? 's' : ''}. Turn one on to try it`, 'info');
  });
}

const loadedPlugins = new Map();
const pluginListeners = [];
let shuffleProvider = null;
function emitPluginEvent(event, data) {
  pluginListeners.filter((l) => l.event === event).forEach((l) => { try { l.cb(data); } catch (e) { reportPluginError(l.file, e); } });
}
function reportPluginError(file, e) {
  console.error('[plugin ' + file + ']', e);
  showToast(`Plugin ${file} failed: ${e && e.message ? e.message : e}`, 'error');
}
function createPluginApi(p) {
  const prefix = `eclipse_plugin_${p.file}_`;
  return {
    plugin: { file: p.file, name: p.name, author: p.author, version: p.version },
    on(event, cb) {
      const l = { event, cb, file: p.file };
      pluginListeners.push(l);
      return () => { const i = pluginListeners.indexOf(l); if (i >= 0) pluginListeners.splice(i, 1); };
    },
    toast: (message, type) => showToast(String(message), type || 'info'),
    addStyle(css) {
      const s = document.createElement('style');
      s.dataset.riffCustom = 'plugin';
      s.dataset.plugin = p.file;
      s.textContent = css;
      document.head.appendChild(s);
      return () => s.remove();
    },
    storage: {
      get: (k, d) => { const v = localStorage.getItem(prefix + k); return v === null ? d : JSON.parse(v); },
      set: (k, v) => localStorage.setItem(prefix + k, JSON.stringify(v))
    },
    getTrack: () => state.currentTrack,
    isPlaying: () => state.isPlaying,
    audio: () => el.nativeAudio,
    query: (sel) => document.querySelector(sel),
    sameTrack: (a, b) => isSameTrack(a, b),
    shuffle: {
      setProvider(fn) {
        shuffleProvider = typeof fn === 'function' ? { fn, file: p.file } : null;
        return () => {
          if (shuffleProvider && shuffleProvider.file === p.file) shuffleProvider = null;
        };
      },
      isOn: () => !!state.isShuffle
    },
    queue: {
      get: () => state.queue.slice(),
      getIndex: () => state.queueIndex,
      getContext: () => state.currentTrackContext,
      append(tracks) {
        const added = [];
        (Array.isArray(tracks) ? tracks : []).forEach(track => {
          if (!track || !track.title || (!track.id && !track.url)) return;
          if (state.queue.some(queued => isSameTrack(queued, track))) return;
          state.queue.push(track);
          added.push(track);
        });
        if (added.length) {
          updateQueueBadge();
          if (state.currentView === 'queue') renderQueueView();
        }
        return added;
      }
    },
    library: {
      favorites: () => (state.favorites || []).slice(),
      history: () => (state.history || []).slice()
    },
    api: {
      async search(query, options) {
        const opts = options || {};
        const limit = Math.max(1, Math.min(parseInt(opts.limit, 10) || 10, 30));
        const url = "http://127.0.0.1:" + state.serverPort + "/api/search?q=" + encodeURIComponent(query) + "&platform=" + encodeURIComponent(opts.platform || state.platform) + "&limit=" + limit;
        const response = await fetch(url, { signal: opts.signal });
        if (!response.ok) throw new Error("Search failed (" + response.status + ")");
        const data = await response.json();
        if (!data || !data.success) throw new Error(data && data.error || 'Search failed');
        if (!Array.isArray(data.tracks)) throw new Error('Search returned an invalid response');
        return data.tracks;
      },
      async vibe(body) {
        const response = await fetch("http://127.0.0.1:" + state.serverPort + "/api/vibe", {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body || {})
        });
        if (!response.ok) throw new Error("Recommendations failed (" + response.status + ")");
        const data = await response.json();
        if (!data || !data.success) throw new Error(data && data.error || 'Recommendations failed');
        if (!Array.isArray(data.tracks)) throw new Error('Recommendations returned an invalid response');
        return data.tracks;
      }
    }
  };
}
function runPlugin(p) {
  if (loadedPlugins.has(p.file)) return;
  try {
    const api = createPluginApi(p);
    const fn = new Function('Riff', 'plugin', `${p.code}\n//# sourceURL=riff-plugin-${p.file}`);
    const result = fn(api, api.plugin);
    loadedPlugins.set(p.file, { stop: result && typeof result.stop === 'function' ? result.stop : null });
  } catch (e) { reportPluginError(p.file, e); }
}
function stopPlugin(p, silent) {
  const entry = loadedPlugins.get(p.file);
  try { if (entry && entry.stop) entry.stop(); } catch (e) { reportPluginError(p.file, e); }
  for (let i = pluginListeners.length - 1; i >= 0; i--) if (pluginListeners[i].file === p.file) pluginListeners.splice(i, 1);
  if (shuffleProvider && shuffleProvider.file === p.file) shuffleProvider = null;
  document.querySelectorAll(`style[data-plugin="${p.file}"]`).forEach((n) => n.remove());
  const hadStop = !!(entry && entry.stop);
  loadedPlugins.delete(p.file);
  if (!silent && !hadStop) showToast(`Restart Eclipse to fully unload "${p.name}"`, 'info');
}
let pluginsCache = [];
function renderPluginCards() {
  const list = document.getElementById('plugins-list');
  if (!list) return;
  list.innerHTML = '';
  if (!pluginsCache.length) {
    const empty = document.createElement('div');
    empty.className = 'ct-empty';
    empty.textContent = 'No plugins. Put .js files into the plugins folder or click Add.';
    list.appendChild(empty);
    return;
  }
  pluginsCache.forEach((p) => {
    const card = document.createElement('div');
    card.className = 'ct-card plugin-card';
    card.innerHTML = '<div class="ct-info"><div class="ct-name"></div><div class="ct-meta"></div></div><button class="btn-icon-pill ct-remove" title="Delete file"><svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg></button><button class="effect-switch-btn"><span class="thumb"></span></button>';
    card.querySelector('.ct-name').textContent = `${p.name}${p.version ? ' v' + p.version : ''}`;
    card.querySelector('.ct-meta').textContent = [p.author && `by ${p.author}`, p.description, p.file].filter(Boolean).join(' · ');
    const toggle = card.querySelector('.effect-switch-btn');
    toggle.classList.toggle('active', !!p.enabled);
    toggle.addEventListener('click', () => {
      p.enabled = !p.enabled;
      toggle.classList.toggle('active', p.enabled);
      window.electronAPI.setPluginEnabled(p.file, p.enabled);
      if (p.enabled) runPlugin(p); else stopPlugin(p, false);
    });
    card.querySelector('.ct-remove').addEventListener('click', () => {
      stopPlugin(p, true);
      window.electronAPI.removePlugin(p.file);
      pluginsCache = pluginsCache.filter((x) => x.file !== p.file);
      renderPluginCards();
      showToast('Plugin file deleted', 'info');
    });
    list.appendChild(card);
  });
}
async function loadPlugins() {
  if (!window.electronAPI || !window.electronAPI.listPlugins) return;
  pluginsCache = await window.electronAPI.listPlugins();
  pluginsCache.filter((p) => p.enabled).forEach(runPlugin);
  renderPluginCards();
}
const pluginsApi = window.electronAPI;
async function reloadPluginsList() {
  if (pluginsApi && pluginsApi.listPlugins) {
    pluginsCache = await pluginsApi.listPlugins();
    const present = new Set(pluginsCache.map((x) => x.file));
    [...loadedPlugins.keys()].filter((f) => !present.has(f)).forEach((f) => stopPlugin({ file: f, name: f }, true));
  }
  renderPluginCards();
}
if (pluginsApi && pluginsApi.listPlugins) {
  document.getElementById('btn-plugins-folder').addEventListener('click', () => pluginsApi.openPluginsFolder());
  document.getElementById('btn-plugins-reload').addEventListener('click', reloadPluginsList);
  document.getElementById('btn-add-plugin').addEventListener('click', async () => {
    const added = await pluginsApi.importPlugins();
    if (!added) return;
    pluginsCache = await pluginsApi.listPlugins();
    renderPluginCards();
    showToast(`Added ${added} plugin${added > 1 ? 's' : ''}. Turn one on to run it`, 'info');
  });
}

let cssEditorInstance = null;
let cssEditorLoading = null;

function loadMonaco() {
  if (window.monaco) return Promise.resolve(window.monaco);
  if (cssEditorLoading) return cssEditorLoading;
  cssEditorLoading = new Promise((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '../../vendor/monaco/vs/editor/editor.main.css';
    document.head.appendChild(link);
    const s = document.createElement('script');
    s.src = '../../vendor/monaco/vs/loader.js';
    s.onload = () => {
      window.require.config({ paths: { vs: '../../vendor/monaco/vs' } });
      window.require(['vs/editor/editor.main'], () => resolve(window.monaco), reject);
    };
    s.onerror = reject;
    document.head.appendChild(s);
  });
  return cssEditorLoading;
}

function defineRiffMonacoTheme(monaco) {
  const cs = getComputedStyle(document.documentElement);
  const hex = (name, fallback) => { const v = cs.getPropertyValue(name).trim(); return /^#[0-9a-f]{6}$/i.test(v) ? v : fallback; };
  const bg = hex('--md-sys-color-surface-container-lowest-solid', '#141218');
  const high = hex('--md-sys-color-surface-container-high-solid', '#2b2930');
  const primary = hex('--md-sys-color-primary', '#d0bcff');
  const lum = (h) => { const n = parseInt(h.slice(1), 16); return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255; };
  monaco.editor.defineTheme('riff', { base: lum(bg) < 0.5 ? 'vs-dark' : 'vs', inherit: true, rules: [], colors: { 'editor.background': bg, 'editorGutter.background': bg, 'minimap.background': bg, 'editor.lineHighlightBackground': high, 'editorCursor.foreground': primary, 'editor.selectionBackground': primary + '55' } });
  monaco.editor.setTheme('riff');
}

async function openCssEditor() {
  const overlay = document.getElementById('css-editor');
  overlay.classList.remove('hidden');
  let monaco;
  try { monaco = await loadMonaco(); } catch (e) { overlay.classList.add('hidden'); showToast('Could not load the CSS editor', 'error'); return; }
  defineRiffMonacoTheme(monaco);
  if (cssEditorInstance) { cssEditorInstance.focus(); return; }
  cssEditorInstance = monaco.editor.create(document.getElementById('css-editor-host'), {
    value: localStorage.getItem('eclipse_custom_css') || '/* Your CSS goes here. Example:\n.btn-pill-primary { border-radius: 8px; }\n*/\n',
    language: 'css',
    theme: 'riff',
    automaticLayout: true,
    minimap: { enabled: true },
    fontSize: 14,
    fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
    fontLigatures: true,
    roundedSelection: true,
    scrollBeyondLastLine: false,
    smoothScrolling: true,
    cursorSmoothCaretAnimation: 'on',
    padding: { top: 12 },
    tabSize: 2,
    wordWrap: 'on',
    bracketPairColorization: { enabled: true },
    colorDecorators: true
  });
  let saveTimer = 0;
  cssEditorInstance.onDidChangeModelContent(() => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      localStorage.setItem('eclipse_custom_css', cssEditorInstance.getValue());
      applyCustomStyles();
    }, 350);
  });
  cssEditorInstance.focus();
}

const btnOpenCssEditor = document.getElementById('btn-open-css-editor');
if (btnOpenCssEditor) btnOpenCssEditor.addEventListener('click', openCssEditor);
const btnCssClose = document.getElementById('btn-css-close');
if (btnCssClose) btnCssClose.addEventListener('click', () => document.getElementById('css-editor').classList.add('hidden'));
const btnCssClear = document.getElementById('btn-css-clear');
if (btnCssClear) btnCssClear.addEventListener('click', () => {
  const current = localStorage.getItem('eclipse_custom_css') || '';
  if (current.trim()) localStorage.setItem('eclipse_custom_css_backup', current);
  if (cssEditorInstance) cssEditorInstance.setValue('');
  else { localStorage.removeItem('eclipse_custom_css'); applyCustomStyles(); }
});
const btnCssRestore = document.getElementById('btn-css-restore');
if (btnCssRestore) btnCssRestore.addEventListener('click', () => {
  const backup = localStorage.getItem('eclipse_custom_css_backup');
  if (!backup) { showToast('Nothing to restore', 'info'); return; }
  if (cssEditorInstance) cssEditorInstance.setValue(backup);
  else { localStorage.setItem('eclipse_custom_css', backup); applyCustomStyles(); }
});

function addSliderTicks(input) {
  const item = input.closest('.setting-item') || input.parentElement;
  const hints = item ? item.querySelector('.setting-hints') : null;
  const spans = hints ? [...hints.querySelectorAll('span')].map(s => s.textContent) : [];
  const min = +input.min, max = +input.max, step = +input.step || 1;
  const def = +input.getAttribute('value');
  const labels = {};
  if (spans.length === 3) { labels[min] = spans[0]; labels[def] = spans[1]; labels[max] = spans[2]; }
  else if (spans.length === 2) { labels[min] = spans[0]; labels[max] = spans[1]; }
  const wrap = document.createElement('div'); wrap.className = 'slider-ticks';
  for (let v = min; v <= max; v += step) {
    const t = document.createElement('i'); t.style.setProperty('--p', (v - min) / (max - min));
    if (labels[v] != null) { t.className = 'major'; const s = document.createElement('span'); s.textContent = labels[v]; t.appendChild(s); }
    wrap.appendChild(t);
  }
  const host = input.closest('.sl') || input;
  host.insertAdjacentElement('afterend', wrap);
  if (hints) hints.remove();
}

const scaleInput = document.getElementById('settings-slider-scale');
if (scaleInput) addSliderTicks(scaleInput);
document.querySelectorAll('#view-settings .pill-range').forEach(input => {
  if (input === scaleInput) return;
  const item = input.closest('.setting-item') || input.parentElement;
  const hints = item ? item.querySelector('.setting-hints') : null;
  if (!hints) return;
  const min = +input.min, max = +input.max, step = +input.step || 1;
  if ((max - min) / step <= 20) {
    addSliderTicks(input);
  }
});

function decorateSwitches() {
  document.querySelectorAll('.effect-switch-btn .thumb:not(.has-icon)').forEach((t) => {
    t.classList.add('has-icon');
    t.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="sw-icon"/></svg>';
  });
}
let swRaf = 0;
new MutationObserver(() => { if (swRaf) return; swRaf = requestAnimationFrame(() => { swRaf = 0; decorateSwitches(); }); }).observe(document.body, { childList: true, subtree: true });
decorateSwitches();

const settingWinMediaKeys = document.getElementById('setting-win-media-keys');
const btnWinMediaKeys = document.getElementById('btn-win-media-keys');
const isWindows = (window.electronAPI && typeof window.electronAPI.isWindows === 'boolean')
  ? window.electronAPI.isWindows
  : (navigator.userAgent.includes('Windows') || (navigator.platform && navigator.platform.includes('Win')));

if (settingWinMediaKeys) {
  settingWinMediaKeys.style.display = isWindows ? '' : 'none';
}

const savedWinMediaKeys = localStorage.getItem('eclipse_global_media_keys') !== 'false';
if (btnWinMediaKeys) {
  btnWinMediaKeys.classList.toggle('active', savedWinMediaKeys);
  btnWinMediaKeys.addEventListener('click', () => {
    const next = !btnWinMediaKeys.classList.contains('active');
    btnWinMediaKeys.classList.toggle('active', next);
    localStorage.setItem('eclipse_global_media_keys', next ? 'true' : 'false');
    if (window.electronAPI && window.electronAPI.setMediaKeys) {
      window.electronAPI.setMediaKeys(next);
    }
  });
}
if (window.electronAPI && window.electronAPI.setMediaKeys) {
  window.electronAPI.setMediaKeys(savedWinMediaKeys);
}

if (window.electronAPI && window.electronAPI.onMediaCommand) {
  window.electronAPI.onMediaCommand((cmd) => handleMediaCommand(cmd, 'ipc'));
}
if (window.electronAPI && window.electronAPI.onMediaControl) {
  window.electronAPI.onMediaControl((action) => {
    if (action === 'play-pause') togglePlayPause();
    else if (action === 'next') playNext();
    else if (action === 'prev') playPrev();
  });
}
function applyWelcomeResult(d) {
  if (!d) return;
  function setSwitch(btn, on) { if (btn && btn.classList.contains('active') !== !!on) btn.click(); }
  if (d.theme) {
    const modeBtn = document.querySelector(`.theme-mode-btn[data-theme-mode="${d.theme.b < 50 ? 'dark' : 'light'}"]`);
    if (modeBtn) modeBtn.click();
    const sH = document.getElementById('slider-theme-hue');
    if (sH && d.theme.h !== undefined) { sH.value = d.theme.h; sH.dispatchEvent(new Event('input', { bubbles: true })); }
    const sB = document.getElementById('slider-theme-brightness');
    if (sB && d.theme.b !== undefined) {
      sB.value = Math.min(Math.max(d.theme.b, Number(sB.min) || 0), Number(sB.max) || 100);
      sB.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }
  if (d.toggles) {
    setSwitch(document.getElementById('btn-show-local'), d.toggles.riff_show_local);
    setSwitch(document.getElementById('btn-search-artists'), d.toggles.riff_search_artists);
    setSwitch(document.getElementById('btn-no-hand-cursor'), d.toggles.riff_no_hand_cursor);
    setSwitch(document.getElementById('btn-perf-mode'), d.toggles.riff_perf_mode);
    if (d.toggles.riff_custom_bg_enabled && d.background) {
      localStorage.setItem('eclipse_bg_url', d.background);
      if (typeof updateCustomBg === 'function') updateCustomBg();
      if (typeof onBackgroundChanged === 'function') onBackgroundChanged('custom', true);
    }
  }
  if (d.discord !== undefined) setSwitch(document.getElementById('btn-discord-rpc'), d.discord);
  if (d.spotify && d.spotify.url) {
    const btnOpen = document.getElementById('btn-open-spotify-import');
    if (btnOpen) btnOpen.click();
    const urlInput = document.getElementById('spotify-import-url');
    if (urlInput) urlInput.value = d.spotify.url;
    const targetInput = document.getElementById('spotify-import-target');
    if (targetInput) targetInput.value = 'new';
    const btnConfirm = document.getElementById('btn-confirm-spotify-import');
    if (btnConfirm) btnConfirm.click();
  }
  showToast('Welcome to Eclipse!', 'info');
}
if (window.electronAPI && window.electronAPI.onWelcomeResult) window.electronAPI.onWelcomeResult((d) => applyWelcomeResult(d));

function checkCompactLayout() {
  const isMini = window.innerWidth <= 520;
  document.body.classList.toggle('mini', isMini);
  const savedLyricsOn = localStorage.getItem('eclipse_mini_lyrics') === '1';
  document.body.classList.toggle('mini-lyrics-on', isMini && savedLyricsOn);
  const btn = document.getElementById('btn-mini-lyrics');
  if (btn) btn.classList.toggle('active', isMini && savedLyricsOn);
  if (isMini && savedLyricsOn) {
    renderMiniLyrics();
    if (el.nativeAudio) updateMiniLyricsHighlight(el.nativeAudio.currentTime || 0);
  }
}
window.addEventListener('resize', checkCompactLayout);
checkCompactLayout();

async function toggleMiniWindow() {
  if (window.electronAPI && window.electronAPI.toggleMiniWindow) {
    const isNowMini = await window.electronAPI.toggleMiniWindow();
    if (isNowMini) {
      const savedLyricsOn = localStorage.getItem('eclipse_mini_lyrics') === '1';
      if (savedLyricsOn && window.electronAPI.setMiniLyrics) {
        await window.electronAPI.setMiniLyrics(true);
      }
    }
  }
}
window.toggleMiniWindow = toggleMiniWindow;
window.renderMiniLyrics = renderMiniLyrics;
window.updateMiniLyricsHighlight = updateMiniLyricsHighlight;
window.setSyncedLyrics = (lyrics) => { state.syncedLyrics = lyrics; renderMiniLyrics(); };

const btnMiniPlayer = document.getElementById('btn-mini-player');
if (btnMiniPlayer) {
  btnMiniPlayer.addEventListener('click', () => {
    toggleMiniWindow();
  });
}

const btnMiniLyrics = document.getElementById('btn-mini-lyrics');
if (btnMiniLyrics) {
  btnMiniLyrics.addEventListener('click', async () => {
    const nextOn = !document.body.classList.contains('mini-lyrics-on');
    localStorage.setItem('eclipse_mini_lyrics', nextOn ? '1' : '0');
    document.body.classList.toggle('mini-lyrics-on', nextOn);
    btnMiniLyrics.classList.toggle('active', nextOn);
    if (window.electronAPI && window.electronAPI.setMiniLyrics) {
      await window.electronAPI.setMiniLyrics(nextOn);
    }
    if (nextOn) {
      renderMiniLyrics();
      if (el.nativeAudio) updateMiniLyricsHighlight(el.nativeAudio.currentTime || 0);
    }
  });
}

let knownAudioOutputIds = new Set();
let currentAudioOutputDeviceId = localStorage.getItem('eclipse_audio_output_device') || 'default';

async function applyAudioOutputDevice(deviceId) {
  currentAudioOutputDeviceId = deviceId || 'default';
  try {
    localStorage.setItem('eclipse_audio_output_device', currentAudioOutputDeviceId);
  } catch (_) {}

  const targetId = (deviceId === 'default' || !deviceId) ? '' : deviceId;

  if (el.nativeAudio && typeof el.nativeAudio.setSinkId === 'function') {
    try {
      await el.nativeAudio.setSinkId(targetId);
    } catch (e) {
      console.warn('Failed to set sink ID on nativeAudio:', e);
    }
  }
  if (window.audioEngine && window.audioEngine.ctx && typeof window.audioEngine.ctx.setSinkId === 'function') {
    try {
      await window.audioEngine.ctx.setSinkId(targetId);
    } catch (_) {}
  }

  const labelEl = document.getElementById('audio-output-label');
  const menuEl = document.getElementById('audio-output-menu');
  if (menuEl) {
    let foundLabel = null;
    menuEl.querySelectorAll('.m3-dropdown-option').forEach(opt => {
      const isMatch = (opt.dataset.value === currentAudioOutputDeviceId) ||
                      (opt.dataset.value === '' && currentAudioOutputDeviceId === 'default') ||
                      (opt.dataset.value === 'default' && currentAudioOutputDeviceId === '');
      if (isMatch) {
        opt.classList.add('selected');
        foundLabel = opt.textContent;
      } else {
        opt.classList.remove('selected');
      }
    });
    if (labelEl && foundLabel) {
      labelEl.textContent = foundLabel;
    }
  }
}
