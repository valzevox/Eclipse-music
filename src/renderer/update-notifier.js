// Eclipse Auto-Update Notifier & Markdown Changelog Viewer
// Checks GitHub Releases (valzevox/Eclipse-music) for newer semantic version
(async () => {
  const REPO = 'valzevox/Eclipse-music';
  const CHECK_EVERY = 30 * 60 * 1000;
  const SNOOZE = 24 * 3600 * 1000;

  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };

  // Determine current running version
  let CURRENT_VER = '1.3.1';
  if (window.electronAPI && typeof window.electronAPI.getAppVersion === 'function') {
    try {
      const v = await window.electronAPI.getAppVersion();
      if (v) CURRENT_VER = String(v).replace(/^v/i, '').trim();
    } catch (_) {}
  }

  function parseVer(v) {
    return String(v || '').replace(/^v/i, '').trim().split('.').map((n) => parseInt(n, 10) || 0);
  }

  function isNewerVer(remote, local) {
    const r = parseVer(remote);
    const l = parseVer(local);
    const len = Math.max(r.length, l.length);
    for (let i = 0; i < len; i++) {
      if ((r[i] || 0) > (l[i] || 0)) return true;
      if ((r[i] || 0) < (l[i] || 0)) return false;
    }
    return false;
  }

  function renderMarkdown(md) {
    if (!md) return '<p>See full release details on GitHub Release page.</p>';
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const inline = (s) => esc(s)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code style="background:rgba(255,255,255,0.1);padding:2px 6px;border-radius:5px;font-size:0.92em;">$1</code>');
    return String(md).split(/\r?\n/).map((line) => {
      const t = line.trim();
      if (!t || t.startsWith('<!--')) return '';
      if (t.startsWith('### ')) return '<h4 style="margin:10px 0 4px;color:#fff;font-size:14px;">' + inline(t.slice(4)) + '</h4>';
      if (t.startsWith('## ')) return '<h3 style="margin:12px 0 6px;color:#fff;font-size:15px;">' + inline(t.slice(3)) + '</h3>';
      if (t.startsWith('# ')) return '<h3 style="margin:12px 0 6px;color:#fff;font-size:16px;">' + inline(t.slice(2)) + '</h3>';
      if (t.startsWith('- ') || t.startsWith('* ')) {
        return '<div style="display:flex;gap:8px;margin:4px 0;line-height:1.45;"><span style="color:var(--md-sys-color-primary,#B69DF8);">•</span><span>' + inline(t.slice(2)) + '</span></div>';
      }
      return '<p style="margin:4px 0;line-height:1.45;">' + inline(t) + '</p>';
    }).join('');
  }

  async function fetchLatestRelease() {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    try {
      const res = await fetch('https://api.github.com/repos/' + REPO + '/releases/latest', {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Eclipse-Player' },
        signal: ctrl.signal
      });
      if (res.ok) return await res.json();
      return null;
    } catch (e) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  function findMatchingAsset(assets = []) {
    if (!Array.isArray(assets) || assets.length === 0) return null;
    const ua = navigator.userAgent || '';
    const isWin = ua.includes('Windows');
    const isMac = ua.includes('Macintosh') || ua.includes('Mac OS');
    const isLinux = ua.includes('Linux');

    if (isWin) {
      // Prefer standard setup exe (x64)
      return assets.find(a => /x64.exe$/i.test(a.name) && !/ia32/i.test(a.name))
        || assets.find(a => /.exe$/i.test(a.name) && !/ia32/i.test(a.name) && !/blockmap/i.test(a.name))
        || assets.find(a => /.exe$/i.test(a.name));
    }
    if (isMac) {
      // Check arm64 or x64
      const isArm = /arm64|aarch64/i.test(navigator.platform || '') || /Macintosh/i.test(ua);
      if (isArm) {
        return assets.find(a => /arm64.dmg$/i.test(a.name)) || assets.find(a => /.dmg$/i.test(a.name));
      }
      return assets.find(a => /x64.dmg$/i.test(a.name)) || assets.find(a => /.dmg$/i.test(a.name));
    }
    if (isLinux) {
      return assets.find(a => /.AppImage$/i.test(a.name)) || assets.find(a => /.deb$/i.test(a.name));
    }
    return null;
  }

  function describe(rel, localVer) {
    if (!rel) return null;
    const tag = String(rel.tag_name || '').trim();
    const body = String(rel.body || '');
    const verMatch = tag.match(/^v?(\d+\.\d+\.\d+)/);
    const remoteVer = verMatch ? verMatch[1] : tag.replace(/^v/i, '');

    // Strict version comparison
    if (!remoteVer || !isNewerVer(remoteVer, localVer)) return null;

    const matchedAsset = findMatchingAsset(rel.assets || []);
    const downloadUrl = (matchedAsset && matchedAsset.browser_download_url)
      || rel.html_url
      || ('https://github.com/' + REPO + '/releases/tag/' + tag);

    return {
      tag,
      version: remoteVer,
      notes: body,
      url: downloadUrl,
      assetName: matchedAsset ? matchedAsset.name : ('Eclipse-' + tag + '.exe'),
      assetSize: matchedAsset ? matchedAsset.size : 0,
      page: rel.html_url || ('https://github.com/' + REPO + '/releases/tag/' + tag)
    };
  }

  function openExternal(url) {
    if (!url) return;
    try {
      if (window.electronAPI && typeof window.electronAPI.openUrl === 'function') {
        window.electronAPI.openUrl(url);
        return;
      }
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (_) {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  }

  let modalEl = null;
  function showUpdateModal(update, isChangelogOnly = false) {
    if (modalEl) modalEl.remove();
    modalEl = document.createElement('div');
    modalEl.style.cssText = 'position:fixed;inset:0;z-index:999998;background:rgba(0,0,0,0.72);backdrop-filter:blur(14px);display:flex;align-items:center;justify-content:center;padding:20px;';

    const title = isChangelogOnly ? "What's New in Eclipse" : "Update Available";
    const subtitle = isChangelogOnly ? ("Eclipse v" + update.version + " • Just Updated") : ("Eclipse v" + update.version + " • Latest Release");
    const actionBtnText = isChangelogOnly ? 'Got it' : 'Download & Install';

    let html = '<div style="width:100%;max-width:460px;max-height:85vh;background:var(--md-sys-color-surface-container-high,#1A1922);border:1px solid rgba(255,255,255,0.14);border-radius:28px;padding:24px;display:flex;flex-direction:column;gap:16px;box-shadow:0 24px 60px rgba(0,0,0,0.7);color:var(--md-sys-color-on-surface,#fff);animation:popupFadeIn 0.25s cubic-bezier(0.2, 0, 0, 1);">';
    html += '<div style="display:flex;align-items:center;gap:14px;">';
    html += '<div style="width:48px;height:48px;border-radius:24px;background:rgba(182,157,248,0.2);display:flex;align-items:center;justify-content:center;color:var(--md-sys-color-primary,#B69DF8);flex-shrink:0;">';
    html += '<svg viewBox="0 0 512 512" width="28" height="28" fill="currentColor"><path d="M256 36C134.497 36 36 134.497 36 256C36 377.503 134.497 476 256 476C330.185 476 395.816 439.298 435.691 383.105C411.519 401.181 381.471 411.9 348.9 411.9C268.819 411.9 203.9 346.981 203.9 266.9C203.9 186.819 268.819 121.9 348.9 121.9C381.471 121.9 411.519 132.619 435.691 150.695C395.816 94.502 330.185 36 256 36ZM372 204C364.268 204 358 210.268 358 218V316C358 323.732 364.268 330 372 330C379.732 330 386 323.732 386 316V218C386 210.268 379.732 204 372 204ZM424 176C416.268 176 410 182.268 410 190V344C410 351.732 416.268 358 424 358C431.732 358 438 351.732 438 344V190C438 182.268 431.732 176 424 176ZM320 236C312.268 236 306 242.268 306 250V284C306 291.732 312.268 298 320 298C327.732 298 334 291.732 334 284V250C334 242.268 327.732 236 320 236Z"/></svg>';
    html += '</div>';
    html += '<div style="flex:1;min-width:0;">';
    html += '<div style="font-weight:700;font-size:18px;letter-spacing:-0.3px;">' + title + '</div>';
    html += '<div style="font-size:13px;opacity:0.75;">' + subtitle + '</div>';
    html += '</div></div>';
    html += '<div style="overflow-y:auto;max-height:48vh;padding:16px;background:rgba(0,0,0,0.28);border:1px solid rgba(255,255,255,0.06);border-radius:20px;font-size:13px;color:#D4D4D8;line-height:1.5;">' + renderMarkdown(update.notes) + '</div>';

    // Progress bar
    html += '<div id="eclipse-upd-progress-wrap" style="display:none;flex-direction:column;gap:6px;">';
    html += '<div style="display:flex;justify-content:space-between;font-size:12px;opacity:0.8;"><span id="eclipse-upd-status-text">Downloading update…</span><span id="eclipse-upd-pct-text">0%</span></div>';
    html += '<div style="height:6px;width:100%;background:rgba(255,255,255,0.12);border-radius:3px;overflow:hidden;"><div id="eclipse-upd-bar" style="height:100%;width:0%;background:var(--md-sys-color-primary,#B69DF8);transition:width 0.2s ease;"></div></div>';
    html += '</div>';

    html += '<div style="display:flex;justify-content:flex-end;gap:10px;margin-top:6px;">';
    if (!isChangelogOnly) html += '<button type="button" id="eclipse-upd-later" style="padding:11px 20px;border-radius:999px;background:rgba(255,255,255,0.08);color:#D4D4D8;font-weight:600;font-size:13px;cursor:pointer;border:none;">Later</button>';
    html += '<button type="button" id="eclipse-upd-go" style="padding:11px 22px;border-radius:999px;background:var(--md-sys-color-primary,#B69DF8);color:#121214;font-weight:700;font-size:13px;cursor:pointer;border:none;">' + actionBtnText + '</button>';
    html += '</div></div>';

    modalEl.innerHTML = html;
    document.body.appendChild(modalEl);

    const laterBtn = modalEl.querySelector('#eclipse-upd-later');
    if (laterBtn) {
      laterBtn.addEventListener('click', () => {
        store.set('eclipse_update_snooze', { ver: update.version, until: Date.now() + SNOOZE });
        modalEl.remove();
        modalEl = null;
      });
    }

    const goBtn = modalEl.querySelector('#eclipse-upd-go');
    goBtn.addEventListener('click', () => {
      if (isChangelogOnly) {
        modalEl.remove();
        modalEl = null;
        return;
      }

      const progWrap = modalEl.querySelector('#eclipse-upd-progress-wrap');
      const bar = modalEl.querySelector('#eclipse-upd-bar');
      const statusTxt = modalEl.querySelector('#eclipse-upd-status-text');
      const pctTxt = modalEl.querySelector('#eclipse-upd-pct-text');

      if (window.electronAPI && typeof window.electronAPI.installUpdateNow === 'function') {
        goBtn.disabled = true;
        goBtn.style.opacity = '0.6';
        if (laterBtn) laterBtn.style.display = 'none';
        if (progWrap) progWrap.style.display = 'flex';

        if (window.electronAPI.onUpdateProgress) {
          window.electronAPI.onUpdateProgress((d) => {
            const pct = d.percent || 0;
            if (bar) bar.style.width = pct + '%';
            if (pctTxt) pctTxt.textContent = pct + '%';
            if (statusTxt) statusTxt.textContent = pct >= 100 ? 'Installing & restarting...' : ('Downloading update (' + pct + '%)...');
          });
        }

        window.electronAPI.installUpdateNow();
        return;
      }

      openExternal(update.url);
      modalEl.remove();
      modalEl = null;
    });
  }

  const statusEl = document.getElementById('update-status');
  const checkBtn = document.getElementById('btn-check-updates');
  const aboutVerEl = document.getElementById('about-version');
  if (aboutVerEl) aboutVerEl.textContent = 'Version ' + CURRENT_VER;
  const creditsVerEl = document.querySelector('.settings-version-tag');
  if (creditsVerEl) creditsVerEl.textContent = 'v' + CURRENT_VER;

  const setStatus = (text, update) => {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.classList.toggle('has-update', !!update);
    if (checkBtn) checkBtn.textContent = update ? 'Update Now' : 'Check now';
  };
  let current = null;

  async function check(manual) {
    if (manual) setStatus('Checking GitHub releases…');
    let localVer = CURRENT_VER;
    if (window.electronAPI && typeof window.electronAPI.getAppVersion === 'function') {
      try {
        const v = await window.electronAPI.getAppVersion();
        if (v) localVer = String(v).replace(/^v/i, '').trim();
      } catch (_) {}
    }

    const rel = await fetchLatestRelease();
    if (!rel) {
      if (manual) setStatus("Couldn't reach GitHub, try again later");
      return;
    }

    store.set('eclipse_update_last', Date.now());
    current = describe(rel, localVer);

    if (current) {
      setStatus('Eclipse v' + current.version + ' is available', current);
      showUpdateModal(current, false);
    } else {
      setStatus("You're up to date (v" + localVer + ')');
      if (manual) {
        showUpdateModal({
          version: localVer,
          notes: '### You are on the latest version!\n\nEclipse v' + localVer + ' is currently up to date with the latest release.'
        }, true);
      }
    }
  }

  if (checkBtn) checkBtn.addEventListener('click', () => (current ? showUpdateModal(current) : check(true)));
  if (statusEl) setStatus('Eclipse v' + CURRENT_VER + ' • Checks for updates automatically');

  // If user just updated and opened the new version for the first time, show "What's New" Got it modal!
  const lastSeenVer = store.get('eclipse_last_seen_version');
  if (lastSeenVer && isNewerVer(CURRENT_VER, lastSeenVer)) {
    store.set('eclipse_last_seen_version', CURRENT_VER);
    fetchLatestRelease().then((rel) => {
      showUpdateModal({
        tag: 'v' + CURRENT_VER,
        version: CURRENT_VER,
        notes: (rel && rel.body) ? rel.body : ('### Updated to v' + CURRENT_VER + '\n- Performance improvements and bug fixes.'),
        page: 'https://github.com/' + REPO + '/releases/tag/v' + CURRENT_VER
      }, true);
    }).catch(() => {
      showUpdateModal({
        tag: 'v' + CURRENT_VER,
        version: CURRENT_VER,
        notes: '### Updated to v' + CURRENT_VER + '\n- Enjoy the latest Eclipse Music features!',
        page: 'https://github.com/' + REPO + '/releases/tag/v' + CURRENT_VER
      }, true);
    });
  } else if (!lastSeenVer) {
    store.set('eclipse_last_seen_version', CURRENT_VER);
  }

  setTimeout(() => check(false), 2500);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      const last = store.get('eclipse_update_last') || 0;
      if (Date.now() - last > CHECK_EVERY) check(false);
    }
  });

  window.EclipseUpdates = { check: () => check(true) };
})();
