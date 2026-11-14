// src/main/updater.js
const { app, ipcMain, shell, net } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const { once } = require('events');

const CHECK_DELAY_MS = 2500;
const CHECK_EVERY_MS = 2 * 60 * 60 * 1000;
const RELEASE_API = 'https://api.github.com/repos/valzevox/Eclipse-music/releases/latest';
const DOWNLOAD_IDLE_TIMEOUT_MS = 30000;
const ARTIFACT_MIN_AGE_MS = 30 * 60 * 1000;

function readIgnored(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).version || ''; } catch (_) { return ''; }
}

function writeIgnored(file, version) {
  try { fs.writeFileSync(file, JSON.stringify({ version })); } catch (_) {}
}

function isNewer(latest, current) {
  const p1 = String(latest || '').replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  const p2 = String(current || '').replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
    const a = p1[i] || 0;
    const b = p2[i] || 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return false;
}

function findMatchingAsset(assets = [], platform = process.platform, arch = process.arch) {
  if (!Array.isArray(assets) || assets.length === 0) return null;
  if (platform === 'win32') {
    const is64 = arch === 'x64' || arch === 'arm64' || !!process.env.ProgramFiles;
    if (is64) {
      const win64 = assets.find(a => /x64\.exe$/i.test(a.name)) || assets.find(a => /win\.exe$/i.test(a.name));
      if (win64) return win64;
    } else {
      const win32 = assets.find(a => /ia32\.exe$/i.test(a.name));
      if (win32) return win32;
    }
    return assets.find(a => /\.exe$/i.test(a.name) && !/blockmap/i.test(a.name)) || null;
  }
  if (platform === 'linux') {
    return assets.find(a => /\.AppImage$/i.test(a.name)) || assets.find(a => /\.deb$/i.test(a.name)) || null;
  }
  if (platform === 'darwin') {
    const isArm = arch === 'arm64';
    if (isArm) {
      return assets.find(a => /arm64\.dmg$/i.test(a.name)) || assets.find(a => /\.dmg$/i.test(a.name)) || null;
    }
    return assets.find(a => /x64\.dmg$/i.test(a.name)) || assets.find(a => /\.dmg$/i.test(a.name)) || null;
  }
  return null;
}

// Use Chromium's network stack first so the app proxy / system proxy / VPN settings apply
async function httpFetch(url, opts = {}) {
  const useNet = net && typeof net.fetch === 'function';
  try {
    return await (useNet ? net.fetch(url, opts) : fetch(url, opts));
  } catch (err) {
    if (useNet && !(opts.signal && opts.signal.aborted)) return await fetch(url, opts);
    throw err;
  }
}

async function fetchLatestRelease() {
  const res = await httpFetch(RELEASE_API, {
    headers: { 'User-Agent': 'Eclipse-Player', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error('GitHub API HTTP ' + res.status);
  return res.json();
}

function buildUpdate(json, fallbackReleasesUrl) {
  const version = String(json.tag_name || '').replace(/^v/i, '');
  const asset = findMatchingAsset(json.assets || []);
  const digest = asset && typeof asset.digest === 'string' && /^sha256:/i.test(asset.digest)
    ? asset.digest.slice(7).toLowerCase() : '';
  return {
    version,
    releaseNotes: json.body || 'Cập nhật phiên bản mới, sửa lỗi và nâng cấp hiệu năng.',
    publishedAt: json.published_at || '',
    htmlUrl: json.html_url || `${fallbackReleasesUrl}/tag/v${version}`,
    downloadUrl: asset ? asset.browser_download_url : null,
    assetName: asset ? path.basename(asset.name) : `eclipse-${version}-win-x64.exe`,
    assetSize: asset ? Number(asset.size) || 0 : 0,
    digest
  };
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', d => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}

async function fileIsValid(file, size, digest) {
  try {
    const st = fs.statSync(file);
    if (size > 0 && st.size !== size) return false;
    if (digest) return (await sha256File(file)) === digest;
    return size > 0;
  } catch (_) { return false; }
}

async function downloadFile(url, dest, expectedSize, onProgress) {
  const part = dest + '.part';
  try { fs.unlinkSync(part); } catch (_) {}

  const ac = new AbortController();
  let idle = setTimeout(() => ac.abort(), DOWNLOAD_IDLE_TIMEOUT_MS);
  const bump = () => { clearTimeout(idle); idle = setTimeout(() => ac.abort(), DOWNLOAD_IDLE_TIMEOUT_MS); };

  const out = fs.createWriteStream(part);
  let outError = null;
  out.on('error', (e) => { outError = e; });

  try {
    const res = await httpFetch(url, { headers: { 'User-Agent': 'Eclipse-Player' }, redirect: 'follow', signal: ac.signal });
    if (!res.ok || !res.body) throw new Error('Tải bản cập nhật thất bại: HTTP ' + res.status);

    const total = Number(res.headers.get('content-length')) || expectedSize || 0;
    let received = 0;
    let lastPct = -1;

    for await (const chunk of Readable.fromWeb(res.body)) {
      if (outError) throw outError;
      bump();
      received += chunk.length;
      if (!out.write(chunk)) await once(out, 'drain');
      if (total > 0) {
        const pct = Math.min(99, Math.round((received / total) * 100));
        if (pct !== lastPct) { lastPct = pct; onProgress(pct, received, total); }
      }
    }
    out.end();
    await once(out, 'finish');
    if (outError) throw outError;

    if (total > 0 && received !== total) throw new Error(`File tải về bị thiếu (${received}/${total} bytes)`);
    fs.renameSync(part, dest);
    return dest;
  } catch (err) {
    try { out.destroy(); } catch (_) {}
    try { fs.unlinkSync(part); } catch (_) {}
    if (ac.signal.aborted) throw new Error('Mất kết nối khi tải bản cập nhật (quá 30s không có dữ liệu)');
    throw err;
  } finally {
    clearTimeout(idle);
  }
}

function removeIfOld(p) {
  try {
    const st = fs.statSync(p);
    if (Date.now() - st.mtimeMs < ARTIFACT_MIN_AGE_MS) return 0;
    fs.unlinkSync(p);
    return st.size;
  } catch (_) { return 0; }
}

function cleanOldVersionArtifacts() {
  let freed = 0;
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    const updaterDir = path.join(localAppData, 'eclipse-updater');
    const updaterPending = path.join(updaterDir, 'pending');
    try {
      if (fs.existsSync(updaterPending)) {
        for (const f of fs.readdirSync(updaterPending)) freed += removeIfOld(path.join(updaterPending, f));
      }
    } catch (_) {}
    try {
      if (fs.existsSync(updaterDir)) {
        for (const f of fs.readdirSync(updaterDir)) {
          if (/\.exe$/i.test(f) || /\.blockmap$/i.test(f)) freed += removeIfOld(path.join(updaterDir, f));
        }
      }
    } catch (_) {}
  }
  try {
    const tempDir = app.getPath('temp');
    for (const f of fs.readdirSync(tempDir)) {
      if (/^(?:eclipse|Eclipse)-.*(?:\.exe|\.tmp|\.part)$/i.test(f)) freed += removeIfOld(path.join(tempDir, f));
    }
  } catch (_) {}
  return freed;
}

async function launchInstallerAndExit(installerPath, hooks) {
  try { if (hooks && typeof hooks.beforeExit === 'function') hooks.beforeExit(); } catch (_) {}

  if (process.platform === 'linux' && process.env.APPIMAGE) {
    fs.chmodSync(installerPath, 0o755);
    const child = spawn(installerPath, [], { detached: true, stdio: 'ignore' });
    child.unref();
  } else if (process.platform === 'win32') {
    try {
      const execDir = path.dirname(process.execPath);
      const isUnpacked = fs.existsSync(path.join(execDir, 'resources', 'app.asar'));
      const dirArg = isUnpacked ? ' /D=' + execDir : '';
      const cmd = 'timeout /t 2 /nobreak >nul & start "" "' + installerPath + '" /S' + dirArg;
      const child = spawn('cmd.exe', ['/c', cmd], { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
      try { app.exit(0); } catch (_) { process.exit(0); }
      return;
    } catch (_) {
      const err = await shell.openPath(installerPath);
      if (err) throw new Error('Không mở được trình cài đặt: ' + err);
    }
  } else {
    const err = await shell.openPath(installerPath);
    if (err) throw new Error('Không mở được trình cài đặt: ' + err);
  }

  setTimeout(() => { try { app.quit(); } catch (_) {} }, 300);
  setTimeout(() => { try { app.exit(0); } catch (_) { process.exit(0); } }, 1000);
}

function initUpdater(getWindow, hooks = {}) {
  const ignoreFile = path.join(app.getPath('userData'), 'ignored-update.json');
  const pkg = require('../../package.json');
  if (pkg.version && typeof app.setVersion === 'function') {
    app.setVersion(pkg.version);
  }
  const releasesUrl = `${pkg.homepage || 'https://github.com/valzevox/Eclipse-music'}/releases`;
  const currentVersion = () => pkg.version || app.getVersion();
  console.log('[updater] running version', currentVersion());

  let manualCheck = false;
  let installing = false;
  let currentUpdate = null;

  try { ipcMain.removeHandler('clean-old-versions'); } catch (_) {}
  ipcMain.handle('clean-old-versions', () => cleanOldVersionArtifacts());

  setTimeout(() => { try { cleanOldVersionArtifacts(); } catch (_) {} }, 3500);

  try { ipcMain.removeHandler('get-app-version'); } catch (_) {}
  ipcMain.handle('get-app-version', () => currentVersion());

  const send = (channel, payload) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };

  const checkUpdates = async () => {
    try {
      const json = await fetchLatestRelease();
      const latestVer = String(json.tag_name || '').replace(/^v/i, '');
      const curVer = currentVersion();

      if (isNewer(latestVer, curVer)) {
        currentUpdate = buildUpdate(json, releasesUrl);
        const ignored = readIgnored(ignoreFile) === latestVer;
        if (ignored && !manualCheck) return;
        manualCheck = false;

        send('update-available', {
          version: latestVer,
          releaseNotes: currentUpdate.releaseNotes,
          publishedAt: currentUpdate.publishedAt,
          htmlUrl: currentUpdate.htmlUrl,
          canInstall: !!currentUpdate.downloadUrl,
          downloadUrl: currentUpdate.downloadUrl,
          url: currentUpdate.htmlUrl
        });
      } else {
        if (manualCheck) send('update-not-available', { version: curVer });
        manualCheck = false;
      }
    } catch (err) {
      console.warn('[updater] check failed:', err && err.message);
      if (manualCheck) {
        send('update-error', { stage: 'check', message: err && err.message ? err.message : 'Không thể kiểm tra cập nhật' });
      }
      manualCheck = false;
    }
  };

  try { ipcMain.removeHandler('update-check'); } catch (_) {}
  ipcMain.handle('update-check', () => {
    manualCheck = true;
    checkUpdates();
    return { ok: true };
  });

  const doInstallNow = async () => {
    if (installing) return { ok: true };
    installing = true;
    try {
      if (!currentUpdate || !currentUpdate.downloadUrl) {
        currentUpdate = buildUpdate(await fetchLatestRelease(), releasesUrl);
      }
      if (!currentUpdate.downloadUrl) {
        throw new Error(`Bản v${currentUpdate.version} chưa có file cài đặt phù hợp (có thể đang được upload). Thử lại sau vài phút.`);
      }

      send('update-progress', { percent: 1 });
      const dest = path.join(app.getPath('temp'), currentUpdate.assetName || `eclipse-${currentUpdate.version}-setup.exe`);

      if (await fileIsValid(dest, currentUpdate.assetSize, currentUpdate.digest)) {
        send('update-progress', { percent: 100 });
      } else {
        try { fs.unlinkSync(dest); } catch (_) {}
        await downloadFile(currentUpdate.downloadUrl, dest, currentUpdate.assetSize, (pct) => {
          send('update-progress', { percent: pct });
        });
        if (currentUpdate.digest) {
          const actual = await sha256File(dest);
          if (actual !== currentUpdate.digest) {
            try { fs.unlinkSync(dest); } catch (_) {}
            throw new Error('File cài đặt tải về không khớp mã SHA-256, đã huỷ.');
          }
        }
        send('update-progress', { percent: 100 });
      }

      send('update-ready', { version: currentUpdate.version });
      send('update-downloaded', { version: currentUpdate.version, canInstall: true });
      await launchInstallerAndExit(dest, hooks);
      return { ok: true };
    } catch (err) {
      installing = false;
      const message = err && err.message ? err.message : 'Lỗi tải bản cập nhật';
      console.warn('[updater] install failed:', message);
      send('update-error', {
        stage: 'install',
        message,
        htmlUrl: (currentUpdate && currentUpdate.htmlUrl) || releasesUrl
      });
      return { ok: false, error: message };
    }
  };

  try { ipcMain.removeHandler('install-update-now'); } catch (_) {}
  ipcMain.handle('install-update-now', () => doInstallNow());
  try { ipcMain.removeAllListeners('install-update-now'); } catch (_) {}
  ipcMain.on('install-update-now', () => { doInstallNow(); });

  try { ipcMain.removeAllListeners('update-action'); } catch (_) {}
  ipcMain.on('update-action', (event, action) => {
    if (action === 'ignore' || action === 'skip') {
      if (currentUpdate && currentUpdate.version) writeIgnored(ignoreFile, currentUpdate.version);
      return;
    }
    if (action === 'now') doInstallNow();
  });

  setTimeout(checkUpdates, CHECK_DELAY_MS);
  setInterval(checkUpdates, CHECK_EVERY_MS).unref();
}

module.exports = { initUpdater };
