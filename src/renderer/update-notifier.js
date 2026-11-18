// d:\Eclipse\eclipse-pc\src\renderer\update-notifier.js
// Eclipse Enterprise Auto-Update Notifier & Changelog Viewer
(async () => {
  const REPO = 'valzevox/Eclipse-music';
  const SNOOZE = 24 * 3600 * 1000;

  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };

  let CURRENT_VER = '1.4.16';
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
    if (!md) return '<p>Xem chi tiết thay đổi trên trang phát hành GitHub.</p>';
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

  function openExternal(url) {
    if (!url) return;
    try {
      if (window.electronAPI && typeof window.electronAPI.openExternal === 'function') {
        window.electronAPI.openExternal(url);
        return;
      }
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (_) {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  }

  // Hook playback state persistence request from main process
  if (window.electronAPI && window.electronAPI.onPlaybackPersistReq) {
    window.electronAPI.onPlaybackPersistReq(() => {
      try {
        const audio = document.querySelector('audio');
        const state = {
          currentTime: audio ? audio.currentTime : 0,
          paused: audio ? audio.paused : true,
          volume: audio ? audio.volume : 1,
          savedAt: Date.now()
        };
        localStorage.setItem('eclipse_playback_resume', JSON.stringify(state));
      } catch (_) {}
    });
  }

  let modalEl = null;
  function showUpdateModal(update, mode = 'update') {
    if (modalEl) modalEl.remove();
    modalEl = document.createElement('div');
    modalEl.style.cssText = 'position:fixed;inset:0;z-index:999998;background:rgba(0,0,0,0.72);backdrop-filter:blur(14px);display:flex;align-items:center;justify-content:center;padding:20px;';

    const isChangelog = mode === 'changelog';
    const isBlocked = mode === 'blocked';
    const isMandatory = mode === 'mandatory';

    let title = "Bản Cập Nhật Mới";
    let subtitle = `Eclipse v${update.version} • Bản phát hành chính thức`;
    let actionBtnText = "Tải & Cài Đặt";

    if (isChangelog) {
      title = "Có Gì Mới Trong Eclipse";
      subtitle = `Eclipse v${update.version} • Vừa cập nhật`;
      actionBtnText = "Đã Hiểu";
    } else if (isBlocked) {
      title = "Cảnh Báo Phiên Bản Lỗi";
      subtitle = `Phiên bản hiện tại (v${CURRENT_VER}) đã bị thu hồi do lỗi`;
      actionBtnText = "Cập Nhật Ngay";
    } else if (isMandatory) {
      title = "Yêu Cầu Cập Nhật Bắt Buộc";
      subtitle = `Yêu cầu tối thiểu v${update.minSupported || update.version}`;
      actionBtnText = "Cập Nhật Ngay";
    }

    let html = '<div style="width:100%;max-width:470px;max-height:85vh;background:var(--md-sys-color-surface-container-high,#1A1922);border:1px solid rgba(255,255,255,0.14);border-radius:28px;padding:24px;display:flex;flex-direction:column;gap:16px;box-shadow:0 24px 60px rgba(0,0,0,0.7);color:var(--md-sys-color-on-surface,#fff);animation:popupFadeIn 0.25s cubic-bezier(0.2, 0, 0, 1);">';
    html += '<div style="display:flex;align-items:center;gap:14px;">';
    html += `<div style="width:48px;height:48px;border-radius:24px;background:${isBlocked ? 'rgba(255,80,80,0.2)' : 'rgba(182,157,248,0.2)'};display:flex;align-items:center;justify-content:center;color:${isBlocked ? '#ff5050' : 'var(--md-sys-color-primary,#B69DF8)'};flex-shrink:0;">`;
    html += '<svg viewBox="0 0 512 512" width="28" height="28" fill="currentColor"><path d="M256 36C134.497 36 36 134.497 36 256C36 377.503 134.497 476 256 476C330.185 476 395.816 439.298 435.691 383.105C411.519 401.181 381.471 411.9 348.9 411.9C268.819 411.9 203.9 346.981 203.9 266.9C203.9 186.819 268.819 121.9 348.9 121.9C381.471 121.9 411.519 132.619 435.691 150.695C395.816 94.502 330.185 36 256 36ZM372 204C364.268 204 358 210.268 358 218V316C358 323.732 364.268 330 372 330C379.732 330 386 323.732 386 316V218C386 210.268 379.732 204 372 204ZM424 176C416.268 176 410 182.268 410 190V344C410 351.732 416.268 358 424 358C431.732 358 438 351.732 438 344V190C438 182.268 431.732 176 424 176ZM320 236C312.268 236 306 242.268 306 250V284C306 291.732 312.268 298 320 298C327.732 298 334 291.732 334 284V250C334 242.268 327.732 236 320 236Z"/></svg>';
    html += '</div>';
    html += '<div style="flex:1;min-width:0;">';
    html += `<div style="font-weight:700;font-size:18px;letter-spacing:-0.3px;color:${isBlocked ? '#ff7b7b' : '#fff'};">${title}</div>`;
    html += '<div style="font-size:13px;opacity:0.75;">' + subtitle + '</div>';
    html += '</div></div>';

    html += '<div style="overflow-y:auto;max-height:44vh;padding:16px;background:rgba(0,0,0,0.28);border:1px solid rgba(255,255,255,0.06);border-radius:20px;font-size:13px;color:#D4D4D8;line-height:1.5;">' + renderMarkdown(update.releaseNotes || update.notes) + '</div>';

    // Progress bar wrap
    html += '<div id="eclipse-upd-progress-wrap" style="display:none;flex-direction:column;gap:6px;">';
    html += '<div style="display:flex;justify-content:space-between;font-size:12px;opacity:0.8;"><span id="eclipse-upd-status-text">Đang tải bản cập nhật…</span><span id="eclipse-upd-pct-text">0%</span></div>';
    html += '<div style="height:6px;width:100%;background:rgba(255,255,255,0.12);border-radius:3px;overflow:hidden;"><div id="eclipse-upd-bar" style="height:100%;width:0%;background:var(--md-sys-color-primary,#B69DF8);transition:width 0.2s ease;"></div></div>';
    html += '</div>';

    // Buttons
    html += '<div style="display:flex;justify-content:flex-end;gap:10px;margin-top:6px;">';
    if (!isChangelog && !isBlocked && !isMandatory) {
      html += '<button type="button" id="eclipse-upd-later" style="padding:11px 18px;border-radius:999px;background:rgba(255,255,255,0.08);color:#D4D4D8;font-weight:600;font-size:13px;cursor:pointer;border:none;">Để Sau</button>';
      html += '<button type="button" id="eclipse-upd-on-quit" style="display:none;padding:11px 18px;border-radius:999px;background:rgba(255,255,255,0.14);color:#fff;font-weight:600;font-size:13px;cursor:pointer;border:none;">Cài Khi Thoát App</button>';
    }
    html += `<button type="button" id="eclipse-upd-go" style="padding:11px 22px;border-radius:999px;background:var(--md-sys-color-primary,#B69DF8);color:#121214;font-weight:700;font-size:13px;cursor:pointer;border:none;">${actionBtnText}</button>`;
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

    const onQuitBtn = modalEl.querySelector('#eclipse-upd-on-quit');
    if (onQuitBtn) {
      onQuitBtn.addEventListener('click', () => {
        if (window.electronAPI && window.electronAPI.installUpdateOnQuit) {
          window.electronAPI.installUpdateOnQuit();
        }
        modalEl.remove();
        modalEl = null;
      });
    }

    const goBtn = modalEl.querySelector('#eclipse-upd-go');
    goBtn.addEventListener('click', () => {
      if (isChangelog) {
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

        window.electronAPI.installUpdateNow();
        return;
      }

      openExternal(update.downloadUrl || update.url);
      modalEl.remove();
      modalEl = null;
    });
  }

  // Register Electron IPC listeners
  if (window.electronAPI) {
    if (window.electronAPI.onUpdateAvailable) {
      window.electronAPI.onUpdateAvailable((data) => {
        const snooze = store.get('eclipse_update_snooze');
        if (snooze && snooze.ver === data.version && snooze.until > Date.now()) return;
        showUpdateModal(data, 'update');
      });
    }

    if (window.electronAPI.onUpdateProgress) {
      window.electronAPI.onUpdateProgress((d) => {
        const modal = document.querySelector('#eclipse-upd-progress-wrap');
        const bar = document.querySelector('#eclipse-upd-bar');
        const pctTxt = document.querySelector('#eclipse-upd-pct-text');
        const statusTxt = document.querySelector('#eclipse-upd-status-text');
        if (modal) modal.style.display = 'flex';
        const pct = d.percent || 0;
        if (bar) bar.style.width = pct + '%';
        if (pctTxt) pctTxt.textContent = pct + '%';
        if (statusTxt) statusTxt.textContent = pct >= 100 ? 'Đang chuẩn bị cài đặt...' : `Đang tải bản cập nhật (${pct}%)...`;
      });
    }

    if (window.electronAPI.onUpdateReady) {
      window.electronAPI.onUpdateReady((d) => {
        const onQuitBtn = document.querySelector('#eclipse-upd-on-quit');
        const goBtn = document.querySelector('#eclipse-upd-go');
        const statusTxt = document.querySelector('#eclipse-upd-status-text');
        if (onQuitBtn) onQuitBtn.style.display = 'inline-block';
        if (goBtn) {
          goBtn.disabled = false;
          goBtn.style.opacity = '1';
          goBtn.textContent = 'Khởi Động Lại Ngay';
        }
        if (statusTxt) statusTxt.textContent = 'Đã tải xong và xác thực SHA-512 an toàn.';
      });
    }

    if (window.electronAPI.onUpdateError) {
      window.electronAPI.onUpdateError((err) => {
        const statusTxt = document.querySelector('#eclipse-upd-status-text');
        const goBtn = document.querySelector('#eclipse-upd-go');
        const laterBtn = document.querySelector('#eclipse-upd-later');
        if (statusTxt) {
          statusTxt.textContent = (err && err.message) ? err.message : 'Cập nhật thất bại';
          statusTxt.style.color = '#ff7b7b';
        }
        if (goBtn) {
          goBtn.disabled = false;
          goBtn.style.opacity = '1';
          goBtn.textContent = 'Thử Lại';
        }
        if (laterBtn) laterBtn.style.display = 'inline-block';
      });
    }

    if (window.electronAPI.onUpdateCurrentBlocked) {
      window.electronAPI.onUpdateCurrentBlocked((d) => {
        showUpdateModal({
          version: d.target,
          releaseNotes: `### CẢNH BÁO BẢO MẬT & TÍNH ỔN ĐỊNH\n\nPhiên bản hiện tại (**v${d.current}**) đã bị thu hồi do lỗi nghiêm trọng.\n\nVui lòng nâng cấp ngay lên **v${d.target}** để đảm bảo ứng dụng không bị crash.`
        }, 'blocked');
      });
    }

    if (window.electronAPI.onUpdateMandatory) {
      window.electronAPI.onUpdateMandatory((d) => {
        showUpdateModal({
          version: d.minSupported,
          minSupported: d.minSupported,
          releaseNotes: `### YÊU CẦU CẬP NHẬT TỐI THIỂU\n\nEclipse yêu cầu tối thiểu phiên bản **v${d.minSupported}** để duy trì kết nối hệ thống.`
        }, 'mandatory');
      });
    }
  }

  // Handle post-update changelog (Got it)
  const lastSeenVer = store.get('eclipse_last_seen_version');
  if (lastSeenVer && isNewerVer(CURRENT_VER, lastSeenVer)) {
    store.set('eclipse_last_seen_version', CURRENT_VER);
    showUpdateModal({
      version: CURRENT_VER,
      releaseNotes: `### Nâng Cấp Thành Công Lên v${CURRENT_VER}!\n\n- Tối ưu hóa hiệu năng và vá lỗi hệ thống.\n- Chúc bạn có trải nghiệm nghe nhạc tuyệt vời với Eclipse.`
    }, 'changelog');
  } else if (!lastSeenVer) {
    store.set('eclipse_last_seen_version', CURRENT_VER);
  }

  // UI Settings button triggers
  const checkBtn = document.getElementById('btn-check-updates');
  const statusEl = document.getElementById('update-status');
  if (checkBtn) {
    checkBtn.addEventListener('click', () => {
      if (statusEl) statusEl.textContent = 'Đang kiểm tra cập nhật...';
      if (window.electronAPI && window.electronAPI.checkForUpdates) {
        window.electronAPI.checkForUpdates();
      }
    });
  }
})();
