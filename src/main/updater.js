// d:\Eclipse\eclipse-pc\src\main\updater.js
// Eclipse Enterprise Auto-Updater Engine (Chrome / VS Code / Slack Standard)
const { app, ipcMain, shell, net, powerMonitor } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { Readable } = require('stream');
const { once } = require('events');

const {
  isNewerSemVer,
  findMatchingAsset,
  parseLatestYml,
  verifyBufferSha512Base64,
  evaluateBlockedVersion,
  evaluateMinSupported,
  decideRangeResume
} = require('./updater-core');

const { initLogger, logStage, getLogPath } = require('./updater-logger');

const REPO = 'valzevox/Eclipse-music';
const CDN_STATIC_MANIFEST = `https://github.com/${REPO}/releases/latest/download/latest.json`;
const CDN_STATIC_YML = `https://github.com/${REPO}/releases/latest/download/latest.yml`;
const RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;

const CHECK_DELAY_MS = 3000;
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000; // 4 hours
const DOWNLOAD_IDLE_TIMEOUT_MS = 30000;
const ARTIFACT_MIN_AGE_MS = 24 * 60 * 60 * 1000;

let pendingInstallerPath = null;
let pendingTargetVersion = null;
let pendingExpectedSha512 = null;
let lastManifestEtag = null;
let crashCounterChecked = false;
let isApplyingUpdate = false;
let isSystemShuttingDown = false;
let latestPlaybackSnapshot = null;

function getUpdateStateFile() {
  return path.join(app.getPath('userData'), 'update-state.json');
}

function readUpdateState() {
  try {
    const raw = fs.readFileSync(getUpdateStateFile(), 'utf8');
    return JSON.parse(raw) || {};
  } catch (_) {
    return { consecutiveCrashes: 0, startedOk: true, failedVersions: {} };
  }
}

function writeUpdateState(state) {
  try {
    fs.writeFileSync(getUpdateStateFile(), JSON.stringify(state, null, 2), 'utf8');
  } catch (_) {}
}

function checkCrashRollback(currentVer) {
  if (crashCounterChecked) return;
  crashCounterChecked = true;

  const state = readUpdateState();
  // Only count a crash against an updated version if we are ACTUALLY running that newly applied version
  if (state.startedOk === false && state.lastAttemptedVersion && currentVer === state.lastAttemptedVersion) {
    state.consecutiveCrashes = (state.consecutiveCrashes || 0) + 1;
    logStage('crash-guard', `App v${currentVer} failed to run 60s previously. Crash count: ${state.consecutiveCrashes}`);
    if (state.consecutiveCrashes >= 2) {
      state.failedVersions = state.failedVersions || {};
      state.failedVersions[state.lastAttemptedVersion] = (state.failedVersions[state.lastAttemptedVersion] || 0) + 1;
      logStage('rollback', `Blacklisting version ${state.lastAttemptedVersion} due to 2 consecutive crashes.`);
    }
  } else {
    state.consecutiveCrashes = 0;
  }

  state.startedOk = false;
  state.currentVersion = currentVer;
  writeUpdateState(state);

  // Set startedOk to true after 60s of stable execution
  setTimeout(() => {
    try {
      const s = readUpdateState();
      s.startedOk = true;
      s.consecutiveCrashes = 0;
      writeUpdateState(s);
      logStage('health', 'App running stably for 60s. Marked startedOk = true');
    } catch (_) {}
  }, 60000).unref();
}

async function httpFetch(url, opts = {}) {
  const useNet = net && typeof net.fetch === 'function';
  try {
    return await (useNet ? net.fetch(url, opts) : fetch(url, opts));
  } catch (err) {
    if (useNet && !(opts.signal && opts.signal.aborted)) return await fetch(url, opts);
    throw err;
  }
}

async function fetchLatestManifest() {
  // 1. Try static latest.json from GitHub CDN (Bypasses 60 req/h rate limit)
  try {
    const headers = { 'User-Agent': 'Eclipse-Player' };
    if (lastManifestEtag) headers['If-None-Match'] = lastManifestEtag;

    const res = await httpFetch(CDN_STATIC_MANIFEST, {
      headers,
      signal: AbortSignal.timeout(8000),
      redirect: 'follow'
    });

    if (res.status === 304) {
      logStage('check', 'Manifest not modified (304 ETag match)');
      return { notModified: true };
    }

    if (res.ok) {
      lastManifestEtag = res.headers.get('etag');
      const data = await res.json();
      if (data && Array.isArray(data.files) && !data.url) {
        const pick = findMatchingAsset(data.files);
        if (pick) {
          data.url = pick.url || `https://github.com/${REPO}/releases/download/v${data.version}/${pick.name}`;
          data.sha512 = pick.sha512 || data.sha512;
          data.size = pick.size || data.size;
          data.assetName = pick.name || data.assetName;
        }
      }
      logStage('check', 'Fetched static latest.json via GitHub CDN', { version: data.version });
      return data;
    }
  } catch (err) {
    logStage('check-warning', 'Static latest.json unavailable, attempting latest.yml / API fallback', err.message);
  }

  // 2. Try static latest.yml from GitHub CDN
  try {
    const ymlRes = await httpFetch(CDN_STATIC_YML, {
      headers: { 'User-Agent': 'Eclipse-Player' },
      signal: AbortSignal.timeout(8000),
      redirect: 'follow'
    });
    if (ymlRes.ok) {
      const ymlText = await ymlRes.text();
      const parsedYml = parseLatestYml(ymlText);
      if (parsedYml) {
        logStage('check', 'Fetched static latest.yml via GitHub CDN', parsedYml);
        // Pick installer matching this binary's arch (x64 / ia32); fall back to universal `path`.
        const pick = findMatchingAsset(parsedYml.files) || { name: parsedYml.path, sha512: parsedYml.sha512, size: 0 };
        return {
          version: parsedYml.version,
          sha512: pick.sha512,
          size: pick.size,
          url: `https://github.com/${REPO}/releases/download/v${parsedYml.version}/${pick.name}`,
          assetName: pick.name
        };
      }
    }
  } catch (err) {
    logStage('check-warning', 'Static latest.yml unavailable', err.message);
  }

  // 3. Fallback to GitHub Releases API (rate-limited, with backoff)
  logStage('check', 'Falling back to GitHub Releases API');
  const apiRes = await httpFetch(RELEASE_API, {
    headers: { 'User-Agent': 'Eclipse-Player', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(12000)
  });
  if (!apiRes.ok) throw new Error(`GitHub API HTTP ${apiRes.status}`);
  const json = await apiRes.json();
  const matched = findMatchingAsset(json.assets || []);
  return {
    version: String(json.tag_name || '').replace(/^v/i, ''),
    url: matched ? matched.browser_download_url : null,
    assetName: matched ? matched.name : null,
    size: matched ? matched.size : 0,
    notes: json.body || '',
    htmlUrl: json.html_url
  };
}

async function sha512FileBase64(filePath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha512');
    fs.createReadStream(filePath)
      .on('data', d => h.update(d))
      .on('end', () => resolve(h.digest('base64')))
      .on('error', reject);
  });
}

async function downloadFileWithResume(url, dest, expectedSize, expectedSha512, onProgress) {
  const part = dest + '.part';
  let existingBytes = 0;
  if (fs.existsSync(part)) {
    try {
      existingBytes = fs.statSync(part).size;
    } catch (_) { existingBytes = 0; }
  }

  const ac = new AbortController();
  let idle = setTimeout(() => ac.abort(), DOWNLOAD_IDLE_TIMEOUT_MS);
  const bump = () => { clearTimeout(idle); idle = setTimeout(() => ac.abort(), DOWNLOAD_IDLE_TIMEOUT_MS); };

  const headers = { 'User-Agent': 'Eclipse-Player' };
  if (existingBytes > 0) {
    headers['Range'] = `bytes=${existingBytes}-`;
  }

  logStage('download', `Starting download: ${url}`, { existingBytes, dest });

  const res = await httpFetch(url, { headers, redirect: 'follow', signal: ac.signal });
  if (!res.ok && res.status !== 206) {
    throw new Error(`Download HTTP error: ${res.status}`);
  }

  const rangeDecision = decideRangeResume(res.status, existingBytes, expectedSize);
  let writeStream;
  let received = rangeDecision.startByte;

  if (rangeDecision.mode === 'overwrite') {
    try { fs.unlinkSync(part); } catch (_) {}
    writeStream = fs.createWriteStream(part);
  } else {
    writeStream = fs.createWriteStream(part, { flags: 'a' });
  }

  const total = Number(res.headers.get('content-length')) ? (rangeDecision.startByte + Number(res.headers.get('content-length'))) : (expectedSize || 0);

  let outError = null;
  writeStream.on('error', (e) => { outError = e; });

  try {
    for await (const chunk of Readable.fromWeb(res.body)) {
      if (outError) throw outError;
      bump();
      received += chunk.length;
      if (!writeStream.write(chunk)) await once(writeStream, 'drain');
      if (total > 0 && typeof onProgress === 'function') {
        const pct = Math.min(99, Math.round((received / total) * 100));
        onProgress(pct, received, total);
      }
    }
    writeStream.end();
    await once(writeStream, 'finish');
    if (outError) throw outError;

    if (total > 0 && received !== total) {
      throw new Error(`Incomplete download: received ${received} of ${total} bytes`);
    }

    // Verify SHA-512 base64 if expected
    if (expectedSha512) {
      logStage('verify', 'Verifying sha512 hash...');
      const actualSha512 = await sha512FileBase64(part);
      if (actualSha512.trim() !== expectedSha512.trim()) {
        try { fs.unlinkSync(part); } catch (_) {}
        throw new Error(`Checksum mismatch! Expected sha512: ${expectedSha512}, got: ${actualSha512}`);
      }
      logStage('verify', 'SHA-512 verification passed.');
    }

    try { fs.unlinkSync(dest); } catch (_) {}
    fs.renameSync(part, dest);
    logStage('download', 'Download completed successfully', { dest, totalBytes: received });
    return dest;
  } catch (err) {
    try { writeStream.destroy(); } catch (_) {}
    if (rangeDecision.mode === 'overwrite') {
      try { fs.unlinkSync(part); } catch (_) {}
    }
    logStage('download-error', err.message);
    throw err;
  } finally {
    clearTimeout(idle);
  }
}

function flushPlaybackResume(rendererWindow) {
  try {
    const resumeFile = path.join(app.getPath('userData'), 'playback-resume.json');
    if (latestPlaybackSnapshot) {
      fs.writeFileSync(resumeFile, JSON.stringify(latestPlaybackSnapshot, null, 2), 'utf8');
      logStage('apply', 'Flushed in-memory playback snapshot synchronously to disk');
    } else if (rendererWindow && !rendererWindow.isDestroyed()) {
      rendererWindow.webContents.send('playback-persist-req');
      logStage('apply', 'Sent playback-persist-req to renderer window');
    }
  } catch (err) {
    logStage('apply-warning', 'Failed to flush playback resume state', err.message);
  }
}

async function executeInstaller(installerPath, hooks = {}, getWindow = null) {
  if (isApplyingUpdate) {
    logStage('apply', 'executeInstaller already running. Skipping re-entrant call.');
    return;
  }
  if (isSystemShuttingDown) {
    logStage('apply', 'System is shutting down. Skipping installer execution to avoid corruption.');
    return;
  }

  isApplyingUpdate = true;
  logStage('apply', 'Executing installer...', { installerPath, pid: process.pid });

  // Re-verify sha512 checksum right before running installer
  if (pendingExpectedSha512) {
    try {
      const fileBuf = fs.readFileSync(installerPath);
      const ok = verifyBufferSha512Base64(fileBuf, pendingExpectedSha512);
      if (!ok) {
        isApplyingUpdate = false;
        throw new Error('sha512 mismatch on pre-install verification! Installer file corrupted or tampered.');
      }
      logStage('apply', 'Pre-install sha512 verification passed.');
    } catch (verr) {
      isApplyingUpdate = false;
      logStage('apply-error', `Pre-install sha512 check failed: ${verr.message}`);
      throw verr;
    }
  }

  flushPlaybackResume(getWindow ? getWindow() : null);

  try { if (hooks && typeof hooks.beforeExit === 'function') hooks.beforeExit(); } catch (_) {}

  if (process.platform === 'win32') {
    const execPath = process.execPath;
    const execDir = path.dirname(execPath);
    const isUnpacked = fs.existsSync(path.join(execDir, 'resources', 'app.asar'));
    const pid = process.pid;

    // electron-builder NSIS: --force-run relaunches the app after a silent install.
    // Spawning the installer directly (no cmd/bat) removes console popups; NSIS itself waits for/closes the running app.
    // /D= must be last and unquoted (NSIS rule).
    const args = ['/S', '--force-run'];
    if (isUnpacked) args.push('/D=' + execDir);

    // Mark clean exit before handing off to installer so crash-guard never counts this as a crash
    try {
      const st = readUpdateState();
      st.startedOk = true;
      st.consecutiveCrashes = 0;
      writeUpdateState(st);
    } catch (_) {}

    const child = spawn(installerPath, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();

    logStage('apply', 'Spawned installer directly with --force-run. Exiting app (0).', { args, pid });
    setTimeout(() => { try { app.exit(0); } catch (_) { process.exit(0); } }, 200);
    return;
  }

  // Linux AppImage / macOS
  const err = await shell.openPath(installerPath);
  if (err) {
    isApplyingUpdate = false;
    throw new Error(`Could not launch installer: ${err}`);
  }
  setTimeout(() => { try { app.exit(0); } catch (_) { process.exit(0); } }, 500);
}

async function checkAndUpdateYtDlp() {
  try {
    const userData = app.getPath('userData');
    const binDir = path.join(userData, 'bin');
    if (!fs.existsSync(binDir)) {
      fs.mkdirSync(binDir, { recursive: true });
    }
    const exeName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
    const targetPath = path.join(binDir, exeName);

    // Check version if binary already exists
    if (fs.existsSync(targetPath)) {
      await new Promise((res) => {
        execFile(targetPath, ['--version'], { timeout: 10000 }, (err, stdout) => {
          if (!err && stdout) {
            logStage('yt-dlp', `Existing managed yt-dlp version: ${stdout.trim()}`);
          }
          res();
        });
      });
    }

    // Check latest release from yt-dlp official github
    const checkUrl = 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest';
    const req = net.request({ url: checkUrl, method: 'GET' });
    req.setHeader('User-Agent', 'Eclipse-Updater');
    req.setHeader('Accept', 'application/vnd.github+json');

    const body = await new Promise((res, rej) => {
      let data = '';
      req.on('response', (response) => {
        if (response.statusCode !== 200) {
          return rej(new Error(`yt-dlp api returned ${response.statusCode}`));
        }
        response.on('data', (c) => { data += c.toString('utf8'); });
        response.on('end', () => res(data));
      });
      req.on('error', rej);
      req.end();
    });

    const parsed = JSON.parse(body);
    const assets = Array.isArray(parsed.assets) ? parsed.assets : [];
    const targetAsset = assets.find((a) => a && a.name === exeName);

    if (targetAsset && targetAsset.browser_download_url) {
      const tempPath = `${targetPath}.tmp-${Date.now()}`;
      logStage('yt-dlp', `Downloading updated yt-dlp from ${targetAsset.browser_download_url}`);
      await downloadFileWithResume(targetAsset.browser_download_url, tempPath, targetAsset.size || 0, null);
      if (fs.existsSync(targetPath)) {
        try { fs.unlinkSync(targetPath); } catch (_) {}
      }
      fs.renameSync(tempPath, targetPath);
      if (process.platform !== 'win32') {
        try { fs.chmodSync(targetPath, 0o755); } catch (_) {}
      }
      logStage('yt-dlp', 'Successfully updated managed yt-dlp binary.');
    }
  } catch (err) {
    logStage('yt-dlp', `Managed yt-dlp update check skipped/failed: ${err.message}. Using bundled fallback.`);
  }
}

function initUpdater(getWindow, hooks = {}) {
  const currentVer = app.getVersion();
  initLogger(app.getPath('userData'));
  logStage('init', `Updater initialized for Eclipse v${currentVer}`, { pid: process.pid, platform: process.platform, arch: process.arch });

  checkCrashRollback(currentVer);

  let manualCheck = false;
  let isDownloading = false;
  let activeManifest = null;

  const send = (channel, payload) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };

  const checkForUpdates = async () => {
    try {
      logStage('check', 'Checking for updates...');
      const manifest = await fetchLatestManifest();
      if (!manifest || manifest.notModified) return;

      activeManifest = manifest;
      const remoteVer = manifest.version;

      // 1. MinSupported evaluation
      const minCheck = evaluateMinSupported(manifest, currentVer);
      if (!minCheck.supported) {
        logStage('guard', `Current version ${currentVer} is below minSupported ${minCheck.minSupported}`);
        send('update-mandatory', { current: currentVer, minSupported: minCheck.minSupported });
      }

      // 2. Blocked evaluation
      const blockCheck = evaluateBlockedVersion(manifest, currentVer, remoteVer);
      if (blockCheck.status === 'no-safe-target') {
        logStage('guard-blocked', 'Both current and target versions are blocked. Halting update attempts.');
        send('update-no-safe-target', { current: currentVer, target: remoteVer, reason: blockCheck.reason });
        manualCheck = false;
        return;
      }
      if (blockCheck.currentBlocked) {
        logStage('guard-blocked', `Current version ${currentVer} is revoked/blocked!`);
        send('update-current-blocked', { current: currentVer, target: remoteVer });
      }
      if (blockCheck.targetBlocked) {
        logStage('guard-blocked', `Remote target version ${remoteVer} is blocked from installation.`);
        manualCheck = false;
        return;
      }

      // 3. Rollback guard (2 crashes check)
      const state = readUpdateState();
      if (state.failedVersions && state.failedVersions[remoteVer] >= 2) {
        logStage('guard-rollback', `Skipping auto-update to ${remoteVer}: crashed 2+ times previously.`);
        if (manualCheck) {
          send('update-error', { stage: 'check', message: `Bản v${remoteVer} đã bị tạm ngưng tự động do lỗi crash trước đó. Hãy tải thủ công.` });
        }
        manualCheck = false;
        return;
      }

      // 4. SemVer comparison
      if (isNewerSemVer(remoteVer, currentVer)) {
        logStage('check', `Newer version available: v${remoteVer} (local: v${currentVer})`);

        // If manifest has no notes (e.g. from static latest.yml), attempt to fetch real release notes from API
        let notes = manifest.notes || manifest.releaseNotes || manifest.body || '';
        if (!notes) {
          try {
            const relRes = await httpFetch(`https://api.github.com/repos/${REPO}/releases/tags/v${remoteVer}`, {
              headers: { 'User-Agent': 'Eclipse-Player', Accept: 'application/vnd.github+json' },
              signal: AbortSignal.timeout(6000)
            });
            if (relRes.ok) {
              const relJson = await relRes.json();
              if (relJson && relJson.body) notes = relJson.body;
            }
          } catch (_) {}
        }

        send('update-available', {
          version: remoteVer,
          releaseNotes: notes || 'Cập nhật phiên bản mới, sửa lỗi và nâng cấp hiệu năng.',
          downloadUrl: manifest.url,
          canInstall: !!manifest.url,
          sha512: manifest.sha512
        });
      } else {
        logStage('check', `Application is up to date (v${currentVer})`);
        if (manualCheck) send('update-not-available', { version: currentVer });
      }
      manualCheck = false;
    } catch (err) {
      logStage('check-error', err.message);
      if (manualCheck) {
        send('update-error', { stage: 'check', message: err.message || 'Không thể kiểm tra cập nhật' });
      }
      manualCheck = false;
    }
  };

  const startDownloadAndPrepare = async () => {
    if (isDownloading) return { ok: true, status: 'downloading' };
    if (!activeManifest || !activeManifest.url) {
      throw new Error('Chưa có thông tin file cài đặt hợp lệ');
    }

    isDownloading = true;
    const targetVer = activeManifest.version;
    const assetName = activeManifest.assetName || `eclipse-${targetVer}-win-x64.exe`;
    const dest = path.join(app.getPath('temp'), assetName);

    // Track attempt in update-state
    const state = readUpdateState();
    state.lastAttemptedVersion = targetVer;
    writeUpdateState(state);

    send('update-progress', { percent: 1 });

    try {
      await downloadFileWithResume(
        activeManifest.url,
        dest,
        activeManifest.size || 0,
        activeManifest.sha512 || null,
        (pct, received, total) => {
          send('update-progress', { percent: pct, received, total });
        }
      );

      pendingInstallerPath = dest;
      pendingTargetVersion = targetVer;
      pendingExpectedSha512 = activeManifest.sha512 || null;
      isDownloading = false;

      send('update-ready', {
        version: targetVer,
        canInstallNow: true,
        canInstallOnQuit: true
      });
      return { ok: true, dest };
    } catch (err) {
      isDownloading = false;
      send('update-error', { stage: 'download', message: err.message });
      throw err;
    }
  };

  // IPC Handlers
  ipcMain.handle('update-check', () => {
    manualCheck = true;
    checkForUpdates();
    return { ok: true };
  });

  ipcMain.handle('install-update-now', async () => {
    if (pendingInstallerPath && fs.existsSync(pendingInstallerPath)) {
      await executeInstaller(pendingInstallerPath, hooks, getWindow);
      return { ok: true };
    }
    // Not downloaded yet: download only; renderer shows "Restart now" on update-ready and the user decides when to apply.
    await startDownloadAndPrepare();
    return { ok: true, status: 'ready' };
  });

  ipcMain.handle('install-update-on-quit', () => {
    logStage('apply', 'User selected Install on Quit');
    return { ok: true };
  });

  // Listen to periodic playback snapshot sync from Renderer
  ipcMain.on('playback-state-sync', (event, snapshot) => {
    if (snapshot && typeof snapshot === 'object') {
      latestPlaybackSnapshot = snapshot;
    }
  });

  // Guard against Windows session shutdown / OS restart
  if (powerMonitor && typeof powerMonitor.on === 'function') {
    powerMonitor.on('shutdown', () => {
      isSystemShuttingDown = true;
      logStage('apply', 'powerMonitor shutdown detected: suppressing auto-update installer.');
    });
  }

  // Hook before-quit for System Tray quit execution
  app.on('before-quit', (event) => {
    // Mark clean user-initiated quit so closing app in <60s is never counted as a crash
    try {
      const st = readUpdateState();
      st.startedOk = true;
      st.consecutiveCrashes = 0;
      writeUpdateState(st);
    } catch (_) {}

    if (isSystemShuttingDown) {
      logStage('apply', 'before-quit triggered by OS shutdown. Preserving installer for next startup.');
      return;
    }
    if (pendingInstallerPath && fs.existsSync(pendingInstallerPath)) {
      logStage('apply', 'Triggering pending update during app before-quit');
      executeInstaller(pendingInstallerPath, hooks, getWindow);
    }
  });

  // Initial check with randomized jitter
  const initialDelay = CHECK_DELAY_MS + Math.floor(Math.random() * 2000);
  setTimeout(checkForUpdates, initialDelay);

  // Periodic check with jitter (±15 mins)
  const jitter = Math.floor((Math.random() - 0.5) * 30 * 60 * 1000);
  setInterval(checkForUpdates, CHECK_EVERY_MS + jitter).unref();

  // Background decoupled update check for yt-dlp binary (delayed 10s after startup)
  setTimeout(() => { checkAndUpdateYtDlp().catch(() => {}); }, 10000);
}

module.exports = {
  initUpdater,
  fetchLatestManifest,
  downloadFileWithResume,
  executeInstaller,
  checkAndUpdateYtDlp
};
