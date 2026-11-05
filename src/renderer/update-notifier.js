// Eclipse Auto-Update Notifier & Markdown Changelog Viewer
// Checks GitHub Releases (valzevox/Eclipse-music) for newer semantic version vX.Y.Z
(() => {
  const build = window.ECLIPSE_BUILD || window.MURIEL_BUILD || {};
  const REPO = build.repo || 'valzevox/Eclipse-music';
  const CURRENT_VER = String(build.version || '1.0.8').replace(/^v/i, '');
  const CHECK_EVERY = 30 * 60 * 1000;
  const SNOOZE = 24 * 3600 * 1000;

  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };

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
        headers: { Accept: 'application/vnd.github+json' },
        signal: ctrl.signal
      });
      if (res.ok) return await res.json();
      const listRes = await fetch('https://api.github.com/repos/' + REPO + '/releases?per_page=5', {
        headers: { Accept: 'application/vnd.github+json' },
        signal: ctrl.signal
      });
      if (!listRes.ok) return null;
      const list = await listRes.json();
      return Array.isArray(list) && list.length ? list[0] : null;
    } catch (e) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchReleaseChangelog(tag, prevTag) {
    try {
      // 1. Check if release notes exist on the specific tag
      const relRes = await fetch('https://api.github.com/repos/' + REPO + '/releases/tags/' + tag, {
        headers: { Accept: 'application/vnd.github+json' }
      });
      if (relRes.ok) {
        const relData = await relRes.json();
        if (relData.body && relData.body.trim().length > 0) {
          return relData.body.trim();
        }
      }
    } catch (e) {}

    // 2. If release notes are empty, fetch commit compare diff from GitHub API
    try {
      const compareUrl = prevTag
        ? 'https://api.github.com/repos/' + REPO + '/compare/' + prevTag + '...' + tag
        : 'https://api.github.com/repos/' + REPO + '/commits?sha=' + tag + '&per_page=10';
      const compRes = await fetch(compareUrl, { headers: { Accept: 'application/vnd.github+json' } });
      if (compRes.ok) {
        const compData = await compRes.json();
        const commits = Array.isArray(compData.commits) ? compData.commits : (Array.isArray(compData) ? compData : []);
        if (commits.length > 0) {
          const lines = commits.map(c => {
            const msg = (c.commit && c.commit.message ? c.commit.message : '').split('\n')[0].trim();
            return msg ? '- ' + msg : '';
          }).filter(Boolean);
          if (lines.length > 0) {
            return '### Changes in ' + tag + '\n' + lines.join('\n');
          }
        }
      }
    } catch (e) {}
    return '';
  }

  function describe(rel, localVer) {
    const activeLocal = localVer || CURRENT_VER;
    if (!rel) return null;
    const tag = String(rel.tag_name || '').trim();
    const body = String(rel.body || '');
    const verMatch = tag.match(/^v?(\d+\.\d+\.\d+)/) || body.match(/eclipse-version:\s*([0-9][\w.-]*)/i) || body.match(/muriel-version:\s*([0-9][\w.-]*)/i);
    const remoteVer = verMatch ? verMatch[1] : tag.replace(/^v/i, '');
    const newerVer = remoteVer && /^\d+\.\d+/.test(remoteVer) && isNewerVer(remoteVer, CURRENT_VER);
    if (!newerVer) return null;

    const assets = Array.isArray(rel.assets) ? rel.assets : [];
    const apkAsset = assets.find((a) => a && typeof a.name === 'string' && a.name.toLowerCase().endsWith('.apk'));
    const exeAsset = assets.find((a) => a && typeof a.name === 'string' && a.name.toLowerCase().endsWith('.exe'));
    const isWin = navigator.userAgent.includes('Windows') && !(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
    const chosen = isWin ? (exeAsset || apkAsset) : (apkAsset || exeAsset);
    const downloadUrl = (chosen && chosen.browser_download_url) || ('https://github.com/' + REPO + '/releases/download/' + tag + '/Eclipse-' + tag + '.apk');

    return {
      tag,
      version: remoteVer,
      notes: body,
      url: downloadUrl,
      page: rel.html_url || ('https://github.com/' + REPO + '/releases/tag/' + tag)
    };
  }

  function openExternal(url) {
    if (window.electronAPI && typeof window.electronAPI.openUrl === 'function') {
      window.electronAPI.openUrl(url);
      return;
    }
    window.open(url, '_system');
    location.href = url;
  }

  let modalEl = null;
  function showUpdateModal(update, isChangelogOnly = false) {
    if (modalEl) modalEl.remove();
    modalEl = document.createElement('div');
    modalEl.style.cssText = 'position:fixed;inset:0;z-index:999998;background:rgba(0,0,0,0.72);backdrop-filter:blur(12px);display:flex;align-items:center;justify-content:center;padding:20px;';
    const title = isChangelogOnly ? "What\'s New in Eclipse" : "Update Available";
    const subtitle = isChangelogOnly ? ("Eclipse v" + update.version + " • Just Updated") : ("Eclipse v" + update.version + " • Latest Build");
    const actionBtnText = isChangelogOnly ? 'Got it' : 'Download & Install';
    let html = '<div style="width:100%;max-width:440px;max-height:85vh;background:var(--md-sys-color-surface-container-high,#1A1922);border:1px solid rgba(255,255,255,0.14);border-radius:28px;padding:24px;display:flex;flex-direction:column;gap:16px;box-shadow:0 24px 60px rgba(0,0,0,0.7);color:var(--md-sys-color-on-surface,#fff);animation:popupFadeIn 0.25s cubic-bezier(0.2, 0, 0, 1);">';
    html += '<div style="display:flex;align-items:center;gap:14px;">';
    html += '<div style="width:48px;height:48px;border-radius:24px;background:rgba(182,157,248,0.2);display:flex;align-items:center;justify-content:center;color:var(--md-sys-color-primary,#B69DF8);flex-shrink:0;">';
    html += '<svg viewBox="0 0 512 512" width="28" height="28" fill="currentColor"><path d="M256 36C134.497 36 36 134.497 36 256C36 377.503 134.497 476 256 476C330.185 476 395.816 439.298 435.691 383.105C411.519 401.181 381.471 411.9 348.9 411.9C268.819 411.9 203.9 346.981 203.9 266.9C203.9 186.819 268.819 121.9 348.9 121.9C381.471 121.9 411.519 132.619 435.691 150.695C395.816 94.502 330.185 36 256 36ZM372 204C364.268 204 358 210.268 358 218V316C358 323.732 364.268 330 372 330C379.732 330 386 323.732 386 316V218C386 210.268 379.732 204 372 204ZM424 176C416.268 176 410 182.268 410 190V344C410 351.732 416.268 358 424 358C431.732 358 438 351.732 438 344V190C438 182.268 431.732 176 424 176ZM320 236C312.268 236 306 242.268 306 250V284C306 291.732 312.268 298 320 298C327.732 298 334 291.732 334 284V250C334 242.268 327.732 236 320 236Z"/></svg>';
    html += '</div>';
    html += '<div style="flex:1;min-width:0;">';
    html += '<div style="font-weight:700;font-size:18px;letter-spacing:-0.3px;">' + title + '</div>';
    html += '<div style="font-size:13px;opacity:0.75;">' + subtitle + '</div>';
    html += '</div></div>';
    html += '<div style="overflow-y:auto;max-height:48vh;padding:16px;background:rgba(0,0,0,0.28);border:1px solid rgba(255,255,255,0.06);border-radius:20px;font-size:13px;color:#D4D4D8;line-height:1.5;">' + renderMarkdown(update.notes) + '</div>';
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
      if (window.electronAPI && typeof window.electronAPI.downloadAndInstall === 'function' && String(update.url || '').endsWith('.apk')) {
        goBtn.disabled = true;
        goBtn.style.opacity = '0.5';
        if (laterBtn) laterBtn.style.display = 'none';
        progWrap.style.display = 'flex';
        window.electronAPI.downloadAndInstall(update.url, (p) => {
          const pct = Math.max(0, Math.min(100, (p && p.percent) || 0));
          if (bar) bar.style.width = pct + '%';
          if (pctTxt) pctTxt.textContent = pct + '%';
          if (pct >= 100 && statusTxt) statusTxt.textContent = 'Launching installer…';
        }).catch((err) => {
          const errMsg = String((err && err.message) || err || '');
          if (errMsg.includes('PERMISSION_NEEDED')) {
            if (statusTxt) statusTxt.textContent = 'Please allow Install unknown apps, then click Download again';
          } else {
            openExternal(update.url);
          }
          goBtn.disabled = false;
          goBtn.style.opacity = '1';
          if (laterBtn) laterBtn.style.display = 'inline-block';
        });
      } else {
        openExternal(update.url);
        modalEl.remove();
        modalEl = null;
      }
    });
  }

  let banner = null;
  function hideBanner() {
    if (!banner) return;
    const b = banner; banner = null;
    b.classList.remove('show');
    setTimeout(() => b.remove(), 400);
  }
  function showBanner(update) {
    if (banner) return;
    const snooze = store.get('eclipse_update_snooze');
    if (snooze && snooze.ver === update.version && snooze.until > Date.now()) return;
    banner = document.createElement('div');
    banner.className = 'update-banner';
    banner.setAttribute('role', 'status');
    banner.innerHTML = `
      <svg class="update-banner-star" viewBox="0 0 512 512" aria-hidden="true"><path d="M256 36C134.497 36 36 134.497 36 256C36 377.503 134.497 476 256 476C330.185 476 395.816 439.298 435.691 383.105C411.519 401.181 381.471 411.9 348.9 411.9C268.819 411.9 203.9 346.981 203.9 266.9C203.9 186.819 268.819 121.9 348.9 121.9C381.471 121.9 411.519 132.619 435.691 150.695C395.816 94.502 330.185 36 256 36ZM372 204C364.268 204 358 210.268 358 218V316C358 323.732 364.268 330 372 330C379.732 330 386 323.732 386 316V218C386 210.268 379.732 204 372 204ZM424 176C416.268 176 410 182.268 410 190V344C410 351.732 416.268 358 424 358C431.732 358 438 351.732 438 344V190C438 182.268 431.732 176 424 176ZM320 236C312.268 236 306 242.268 306 250V284C306 291.732 312.268 298 320 298C327.732 298 334 291.732 334 284V250C334 242.268 327.732 236 320 236Z"/></svg>
      <div class="update-banner-text"><b data-i18n>Update available</b><span>Eclipse v${update.version} is ready</span></div>
      <button type="button" class="update-banner-later" data-i18n>Details</button>
      <button type="button" class="update-banner-go" data-i18n>Download</button>`;
    banner.querySelector('.update-banner-go').addEventListener('click', () => { openExternal(update.url); hideBanner(); });
    banner.querySelector('.update-banner-later').addEventListener('click', () => { hideBanner(); showUpdateModal(update); });
    document.body.appendChild(banner);
    requestAnimationFrame(() => requestAnimationFrame(() => banner && banner.classList.add('show')));
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
        if (v) localVer = String(v).replace(/^v/i, '');
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
      showUpdateModal(current);
    } else {
      setStatus("You're up to date (v" + localVer + ')');
    }
  }

  if (checkBtn) checkBtn.addEventListener('click', () => (current ? showUpdateModal(current) : check(true)));
  if (statusEl) setStatus('Eclipse v' + CURRENT_VER + ' • Checks for updates automatically');

  const lastSeenVer = store.get('eclipse_last_seen_version');
  if (lastSeenVer && isNewerVer(CURRENT_VER, lastSeenVer)) {
    store.set('eclipse_last_seen_version', CURRENT_VER);
    const prevTag = 'v' + lastSeenVer;
    const currentTag = 'v' + CURRENT_VER;
    fetchReleaseChangelog(currentTag, prevTag).then((changelog) => {
      showUpdateModal({
        tag: currentTag,
        version: CURRENT_VER,
        notes: changelog || '',
        page: 'https://github.com/' + REPO + '/releases/tag/' + currentTag
      }, true);
    }).catch(() => {
      showUpdateModal({
        tag: currentTag,
        version: CURRENT_VER,
        notes: '',
        page: 'https://github.com/' + REPO + '/releases/tag/' + currentTag
      }, true);
    });
  } else if (!lastSeenVer) {
    store.set('eclipse_last_seen_version', CURRENT_VER);
  }

  setTimeout(() => check(false), 2000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      const last = store.get('eclipse_update_last') || 0;
      if (Date.now() - last > CHECK_EVERY) check(false);
    }
  });
  window.EclipseUpdates = { check: () => check(true) };
})();
