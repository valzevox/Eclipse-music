const { app, ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { spawn } = require('child_process');

const CHECK_DELAY_MS = 2500;
const CHECK_EVERY_MS = 2 * 60 * 60 * 1000;

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
    const x64Exe = assets.find(a => /\.exe$/i.test(a.name) && /x64/i.test(a.name) && !/ia32/i.test(a.name));
    if (x64Exe) return x64Exe;
    const anyExe = assets.find(a => /\.exe$/i.test(a.name) && !/ia32/i.test(a.name) && !/blockmap/i.test(a.name));
    if (anyExe) return anyExe;
    return assets.find(a => /\.exe$/i.test(a.name) && !/blockmap/i.test(a.name)) || null;
  }
  if (platform === 'linux') {
    return assets.find(a => /\.AppImage$/i.test(a.name)) || null;
  }
  if (platform === 'darwin') {
    return assets.find(a => /\.dmg$/i.test(a.name) && (arch === 'arm64' ? /arm64/i.test(a.name) : /x64/i.test(a.name))) || assets.find(a => /\.dmg$/i.test(a.name)) || null;
  }
  return null;
}

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    let file = null;
    let totalBytes = 0;
    let receivedBytes = 0;
    let lastPercent = -1;

    function doReq(targetUrl, depth = 0) {
      if (depth > 10) {
        if (file) file.close();
        try { fs.unlinkSync(dest); } catch (_) {}
        return reject(new Error('Quá nhiều lần chuyển hướng tải bản cập nhật'));
      }

      let parsed;
      try {
        parsed = new URL(targetUrl);
      } catch (e) {
        return reject(e);
      }
      const client = parsed.protocol === 'https:' ? https : http;

      client.get(targetUrl, {
        headers: { 'User-Agent': 'Eclipse-Player' }
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const nextUrl = new URL(res.headers.location, targetUrl).href;
          return doReq(nextUrl, depth + 1);
        }

        if (res.statusCode !== 200) {
          if (file) file.close();
          try { fs.unlinkSync(dest); } catch (_) {}
          return reject(new Error('Tải bản cập nhật thất bại: HTTP ' + res.statusCode));
        }

        totalBytes = parseInt(res.headers['content-length'] || '0', 10);
        file = fs.createWriteStream(dest);

        res.on('data', (chunk) => {
          receivedBytes += chunk.length;
          file.write(chunk);
          if (totalBytes > 0) {
            const pct = Math.min(99, Math.round((receivedBytes / totalBytes) * 100));
            if (pct !== lastPercent) {
              lastPercent = pct;
              onProgress(pct, receivedBytes, totalBytes);
            }
          }
        });

        res.on('end', () => {
          file.end();
          file.on('finish', () => resolve(dest));
        });

        res.on('error', (err) => {
          file.close();
          try { fs.unlinkSync(dest); } catch (_) {}
          reject(err);
        });
      }).on('error', (err) => {
        if (file) file.close();
        try { fs.unlinkSync(dest); } catch (_) {}
        reject(err);
      });
    }

    doReq(url);
  });
}

function launchInstallerAndExit(installerPath) {
  if (process.platform === 'win32') {
    try {
      const child = spawn(installerPath, ['/S', '--force-run'], {
        detached: true,
        stdio: 'ignore'
      });
      child.unref();
      setTimeout(() => {
        try { app.exit(0); } catch (_) {}
      }, 500);
      return;
    } catch (_) {
      try { shell.openPath(installerPath); } catch (_) {}
      setTimeout(() => {
        try { app.exit(0); } catch (_) {}
      }, 1000);
      return;
    }
  }

  if (process.platform === 'linux' && process.env.APPIMAGE) {
    try {
      fs.chmodSync(installerPath, 0o755);
      const child = spawn(installerPath, [], { detached: true, stdio: 'ignore' });
      child.unref();
      app.exit(0);
      return;
    } catch (_) {}
  }

  shell.openPath(installerPath);
  app.exit(0);
}

function initUpdater(getWindow) {
  const ignoreFile = path.join(app.getPath('userData'), 'ignored-update.json');
  const pkg = require('../../package.json');
  if (pkg.version) {
    app.setVersion(pkg.version);
  }
  const releasesUrl = `${pkg.homepage || 'https://github.com/valzevox/Eclipse-music'}/releases`;
  let manualCheck = false;
  let isDownloading = false;
  let currentUpdate = null;

  try { ipcMain.removeHandler('get-app-version'); } catch (_) {}
  ipcMain.handle('get-app-version', () => pkg.version || app.getVersion());

  const send = (channel, payload) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };

  const checkUpdates = async () => {
    try {
      const res = await fetch('https://api.github.com/repos/valzevox/Eclipse-music/releases/latest', {
        headers: { 'User-Agent': 'Eclipse-Player' }
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      const latestVer = (json.tag_name || '').replace(/^v/i, '');
      const currentVer = pkg.version || app.getVersion();

      if (isNewer(latestVer, currentVer)) {
        const targetAsset = findMatchingAsset(json.assets || []);
        currentUpdate = {
          version: latestVer,
          releaseNotes: json.body || 'Cập nhật phiên bản mới, sửa lỗi và nâng cấp hiệu năng.',
          publishedAt: json.published_at || '',
          htmlUrl: json.html_url || `${releasesUrl}/tag/v${latestVer}`,
          downloadUrl: targetAsset ? targetAsset.browser_download_url : null,
          assetName: targetAsset ? targetAsset.name : `eclipse-${latestVer}-win-x64.exe`,
          assetSize: targetAsset ? targetAsset.size : 0
        };

        const ignored = readIgnored(ignoreFile) === latestVer;
        if (ignored && !manualCheck) return;
        manualCheck = false;

        send('update-available', {
          version: latestVer,
          releaseNotes: currentUpdate.releaseNotes,
          publishedAt: currentUpdate.publishedAt,
          htmlUrl: currentUpdate.htmlUrl,
          canInstall: true,
          downloadUrl: currentUpdate.downloadUrl,
          url: currentUpdate.htmlUrl
        });
      } else {
        if (manualCheck) {
          send('update-not-available', { version: currentVer });
        }
        manualCheck = false;
      }
    } catch (err) {
      if (manualCheck) {
        send('update-error', { message: err && err.message ? err.message : 'Không thể kiểm tra cập nhật' });
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
    if (!currentUpdate) {
      shell.openExternal(releasesUrl);
      return;
    }

    if (!currentUpdate.downloadUrl) {
      shell.openExternal(currentUpdate.htmlUrl || releasesUrl);
      return;
    }

    if (isDownloading) return;
    isDownloading = true;

    try {
      send('update-progress', { percent: 1 });
      const tempDest = path.join(app.getPath('temp'), currentUpdate.assetName || `Eclipse-v${currentUpdate.version}-setup.exe`);

      // If file already exists and matches expected size, skip downloading
      if (fs.existsSync(tempDest) && currentUpdate.assetSize > 0) {
        try {
          const stat = fs.statSync(tempDest);
          if (stat.size === currentUpdate.assetSize) {
            send('update-progress', { percent: 100 });
            send('update-ready', { version: currentUpdate.version });
            send('update-downloaded', { version: currentUpdate.version, canInstall: true });
            launchInstallerAndExit(tempDest);
            return;
          }
        } catch (_) {}
      }

      await downloadFile(currentUpdate.downloadUrl, tempDest, (pct) => {
        send('update-progress', { percent: pct });
      });

      send('update-progress', { percent: 100 });
      send('update-ready', { version: currentUpdate.version });
      send('update-downloaded', { version: currentUpdate.version, canInstall: true });

      setTimeout(() => {
        launchInstallerAndExit(tempDest);
      }, 500);
    } catch (err) {
      isDownloading = false;
      send('update-error', { message: err && err.message ? err.message : 'Lỗi tải bản cập nhật' });
    }
  };

  try { ipcMain.removeHandler('install-update-now'); } catch (_) {}
  ipcMain.on('install-update-now', doInstallNow);

  try { ipcMain.removeAllListeners('update-action'); } catch (_) {}
  ipcMain.on('update-action', (event, action) => {
    if (action === 'ignore' || action === 'skip') {
      if (currentUpdate && currentUpdate.version) {
        writeIgnored(ignoreFile, currentUpdate.version);
      }
      return;
    }
    if (action === 'now') {
      doInstallNow();
    }
  });

  setTimeout(checkUpdates, CHECK_DELAY_MS);
  setInterval(checkUpdates, CHECK_EVERY_MS).unref();
}

module.exports = { initUpdater };
