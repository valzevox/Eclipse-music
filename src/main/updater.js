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
  resolveManifestAsset,
  computeRateLimitDelayMs,
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
let updaterInitialized = false;

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

function sanitizeErrorMessage(msg) {
  return String(msg || '').replace(/(token|authorization|bearer|key)=[^\s&]+/gi, '$1=[REDACTED]');
}

function buildResponseDiag(endpoint, requestedUrl, res, bodyLength, durationMs, err = null) {
  const h = res && res.headers && typeof res.headers.get === 'function' ? res.headers : null;
  return {
    endpoint,
    requestedUrl,
    finalUrl: (res && res.url) || requestedUrl,
    status: res ? res.status : null,
    statusText: (res && res.statusText) || '',
    contentType: h ? h.get('content-type') : null,
    etag: h ? h.get('etag') : null,
    bodyLength: typeof bodyLength === 'number' ? bodyLength : null,
    rateLimitLimit: h ? h.get('x-ratelimit-limit') : null,
    rateLimitRemaining: h ? h.get('x-ratelimit-remaining') : null,
    rateLimitReset: h ? h.get('x-ratelimit-reset') : null,
    retryAfter: h ? h.get('retry-after') : null,
    durationMs,
    transport: (res && res._transport) || null,
    errorType: err ? (err.name || 'Error') : null,
    errorMessage: err ? sanitizeErrorMessage(err.message) : null
  };
}

async function httpFetch(url, opts = {}) {
  const useNet = net && typeof net.fetch === 'function';
  try {
    const res = await (useNet ? net.fetch(url, opts) : fetch(url, opts));
    try { Object.defineProperty(res, '_transport', { value: useNet ? 'net.fetch' : 'fetch', configurable: true }); } catch (_) {}
    return res;
  } catch (err) {
    const timedOut = (opts.signal && opts.signal.aborted) || err.name === 'TimeoutError' || err.name === 'AbortError';
    if (useNet && !timedOut) {
      const res = await fetch(url, opts);
      try { Object.defineProperty(res, '_transport', { value: 'fetch-fallback', configurable: true }); } catch (_) {}
      return res;
    }
    throw err;
  }
}

async function fetchWithBoundedRetry(endpoint, url, opts, maxRetries = 1) {
  let attempt = 0;
  while (true) {
    const t0 = Date.now();
    try {
      const res = await httpFetch(url, opts);
      const durationMs = Date.now() - t0;
      const h = res && res.headers && typeof res.headers.get === 'function' ? res.headers : null;
      const remaining = h ? h.get('x-ratelimit-remaining') : null;
      const retryAfter = h ? h.get('retry-after') : null;
      const resetHdr = h ? h.get('x-ratelimit-reset') : null;
      const is403RateLimit = res.status === 403 && (remaining === '0' || !!retryAfter);
      const isRateLimited = res.status === 429 || is403RateLimit;
      const isServerErr = res.status >= 500;

      if (isRateLimited) {
        const rawDelay = computeRateLimitDelayMs(h, Date.now(), Number.MAX_SAFE_INTEGER);
        if (rawDelay > 2500) {
          logStage('rate-limit-deferred', `${endpoint} rate-limited (HTTP ${res.status}); reset in ${Math.ceil(rawDelay / 1000)}s, deferring retry`, {
            endpoint, status: res.status, rateLimitRemaining: remaining, rateLimitReset: resetHdr, retryAfter
          });
          return { res, durationMs, err: null };
        }
        if (attempt < maxRetries && !(opts.signal && opts.signal.aborted)) {
          const backoff = rawDelay > 0 ? rawDelay : (300 * Math.pow(2, attempt) + Math.floor(Math.random() * 200));
          attempt++;
          await new Promise(r => setTimeout(r, backoff));
          continue;
        }
      } else if (isServerErr && attempt < maxRetries && !(opts.signal && opts.signal.aborted)) {
        const backoff = 300 * Math.pow(2, attempt) + Math.floor(Math.random() * 200);
        attempt++;
        await new Promise(r => setTimeout(r, backoff));
        continue;
      }
      return { res, durationMs, err: null };
    } catch (err) {
      const durationMs = Date.now() - t0;
      const timedOut = (opts.signal && opts.signal.aborted) || err.name === 'TimeoutError' || err.name === 'AbortError';
      if (!timedOut && attempt < maxRetries) {
        const backoff = 300 * Math.pow(2, attempt) + Math.floor(Math.random() * 200);
        attempt++;
        await new Promise(r => setTimeout(r, backoff));
        continue;
      }
      return { res: null, durationMs, err };
    }
  }
}

async function fetchLatestManifest(hasCachedManifest = false) {
  const stageErrors = [];

  // 1. Static latest.json from GitHub CDN
  logStage('check-json-start', `Fetching ${CDN_STATIC_MANIFEST}`);
  {
    const headers = { 'User-Agent': 'Eclipse-Player' };
    if (lastManifestEtag && hasCachedManifest) headers['If-None-Match'] = lastManifestEtag;
    let { res, durationMs, err } = await fetchWithBoundedRetry('latest.json', CDN_STATIC_MANIFEST, {
      headers,
      signal: AbortSignal.timeout(8000),
      redirect: 'follow'
    });

    if (!err && res && res.status === 304 && !hasCachedManifest) {
      logStage('check-json-result', 'Received 304 without cached manifest; retrying unconditionally without If-None-Match', buildResponseDiag('latest.json', CDN_STATIC_MANIFEST, res, 0, durationMs));
      lastManifestEtag = null;
      ({ res, durationMs, err } = await fetchWithBoundedRetry('latest.json', CDN_STATIC_MANIFEST, {
        headers: { 'User-Agent': 'Eclipse-Player' },
        signal: AbortSignal.timeout(8000),
        redirect: 'follow'
      }));
    }

    if (err) {
      const diag = buildResponseDiag('latest.json', CDN_STATIC_MANIFEST, null, null, durationMs, err);
      logStage('check-json-result', 'Network/timeout error fetching latest.json', diag);
      stageErrors.push(`latest.json (${diag.errorType}: ${diag.errorMessage})`);
      logStage('check-fallback', 'Falling back from latest.json to latest.yml', { reason: diag.errorType });
    } else if (res.status === 304) {
      const diag = buildResponseDiag('latest.json', CDN_STATIC_MANIFEST, res, 0, durationMs);
      logStage('check-json-result', 'Manifest not modified (304 ETag match)', diag);
      return { notModified: true };
    } else if (res.ok) {
      let rawText = '';
      try {
        rawText = typeof res.text === 'function' ? await res.text() : JSON.stringify(await res.json());
        const data = JSON.parse(rawText);
        const diag = buildResponseDiag('latest.json', CDN_STATIC_MANIFEST, res, rawText.length, durationMs);
        logStage('check-json-result', 'Fetched static latest.json via GitHub CDN', diag);
        lastManifestEtag = res.headers.get('etag');
        const resolved = resolveManifestAsset(data, REPO);
        if (resolved) {
          data.url = resolved.url;
          data.sha512 = resolved.sha512;
          data.size = resolved.size;
          data.assetName = resolved.assetName;
          return data;
        }
        stageErrors.push(`latest.json (no compatible asset for ${process.platform}/${process.arch})`);
        logStage('check-fallback', 'latest.json has no compatible asset for current platform; falling back to latest.yml', { platform: process.platform, arch: process.arch });
      } catch (parseErr) {
        const diag = buildResponseDiag('latest.json', CDN_STATIC_MANIFEST, res, rawText.length, durationMs, parseErr);
        logStage('check-json-result', 'Malformed JSON in latest.json', diag);
        stageErrors.push(`latest.json (HTTP ${res.status} malformed JSON)`);
        logStage('check-fallback', 'Falling back from latest.json to latest.yml', { reason: 'malformed-json' });
      }
    } else {
      let bodyLen = 0;
      try { bodyLen = (await res.text()).length; } catch (_) {}
      const diag = buildResponseDiag('latest.json', CDN_STATIC_MANIFEST, res, bodyLen, durationMs);
      const is403Rl = res.status === 403 && (diag.rateLimitRemaining === '0' || !!diag.retryAfter);
      const reason = res.status === 404 ? 'manifest asset missing (404)'
        : (res.status === 429 || is403Rl) ? `rate-limited (HTTP ${res.status})`
        : res.status === 403 ? 'forbidden (HTTP 403)'
        : `HTTP ${res.status}`;
      logStage('check-json-result', `latest.json failed: ${reason}`, diag);
      stageErrors.push(`latest.json (${reason})`);
      logStage('check-fallback', 'Falling back from latest.json to latest.yml', { reason });
    }
  }

  // 2. Static latest.yml from GitHub CDN
  logStage('check-yml-start', `Fetching ${CDN_STATIC_YML}`);
  {
    const { res: ymlRes, durationMs, err } = await fetchWithBoundedRetry('latest.yml', CDN_STATIC_YML, {
      headers: { 'User-Agent': 'Eclipse-Player' },
      signal: AbortSignal.timeout(8000),
      redirect: 'follow'
    });

    if (err) {
      const diag = buildResponseDiag('latest.yml', CDN_STATIC_YML, null, null, durationMs, err);
      logStage('check-yml-result', 'Network/timeout error fetching latest.yml', diag);
      stageErrors.push(`latest.yml (${diag.errorType}: ${diag.errorMessage})`);
      logStage('check-fallback', 'Falling back from latest.yml to releases-api', { reason: diag.errorType });
    } else if (ymlRes.ok) {
      let ymlText = '';
      try {
        ymlText = await ymlRes.text();
        const parsedYml = parseLatestYml(ymlText);
        const diag = buildResponseDiag('latest.yml', CDN_STATIC_YML, ymlRes, ymlText.length, durationMs);
        if (parsedYml) {
          logStage('check-yml-result', 'Fetched static latest.yml via GitHub CDN', diag);
          const resolved = resolveManifestAsset({
            version: parsedYml.version,
            url: parsedYml.path ? `https://github.com/${REPO}/releases/download/v${parsedYml.version}/${parsedYml.path}` : null,
            sha512: parsedYml.sha512,
            files: parsedYml.files
          }, REPO);
          if (resolved) {
            return {
              version: parsedYml.version,
              sha512: resolved.sha512,
              size: resolved.size,
              url: resolved.url,
              assetName: resolved.assetName
            };
          }
          stageErrors.push(`latest.yml (no compatible asset for ${process.platform}/${process.arch})`);
          logStage('check-fallback', 'latest.yml has no compatible asset for current platform; falling back to releases-api', { platform: process.platform, arch: process.arch });
        } else {
          logStage('check-yml-result', 'Malformed YAML in latest.yml', diag);
          stageErrors.push(`latest.yml (HTTP ${ymlRes.status} malformed YAML)`);
          logStage('check-fallback', 'Falling back from latest.yml to releases-api', { reason: 'malformed-yaml' });
        }
      } catch (parseErr) {
        const diag = buildResponseDiag('latest.yml', CDN_STATIC_YML, ymlRes, ymlText.length, durationMs, parseErr);
        logStage('check-yml-result', 'Failed reading/parsing latest.yml', diag);
        stageErrors.push(`latest.yml (parse error)`);
        logStage('check-fallback', 'Falling back from latest.yml to releases-api', { reason: 'parse-error' });
      }
    } else {
      let bodyLen = 0;
      try { bodyLen = (await ymlRes.text()).length; } catch (_) {}
      const diag = buildResponseDiag('latest.yml', CDN_STATIC_YML, ymlRes, bodyLen, durationMs);
      const is403Rl = ymlRes.status === 403 && (diag.rateLimitRemaining === '0' || !!diag.retryAfter);
      const reason = ymlRes.status === 404 ? 'manifest asset missing (404)'
        : (ymlRes.status === 429 || is403Rl) ? `rate-limited (HTTP ${ymlRes.status})`
        : ymlRes.status === 403 ? 'forbidden (HTTP 403)'
        : `HTTP ${ymlRes.status}`;
      logStage('check-yml-result', `latest.yml failed: ${reason}`, diag);
      stageErrors.push(`latest.yml (${reason})`);
      logStage('check-fallback', 'Falling back from latest.yml to releases-api', { reason });
    }
  }

  // 3. Fallback to GitHub Releases API
  logStage('check-api-start', `Fetching ${RELEASE_API}`);
  const { res: apiRes, durationMs, err: apiErr } = await fetchWithBoundedRetry('releases-api', RELEASE_API, {
    headers: { 'User-Agent': 'Eclipse-Player', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(12000)
  });

  if (apiErr) {
    const diag = buildResponseDiag('releases-api', RELEASE_API, null, null, durationMs, apiErr);
    logStage('check-api-result', 'Network/timeout error fetching Releases API', diag);
    stageErrors.push(`releases-api (${diag.errorType}: ${diag.errorMessage})`);
    const finalErr = new Error(`Update check failed: ${stageErrors.join('; ')}`);
    finalErr.stages = stageErrors;
    throw finalErr;
  }

  if (!apiRes.ok) {
    let bodyLen = 0;
    try { bodyLen = (await apiRes.text()).length; } catch (_) {}
    const diag = buildResponseDiag('releases-api', RELEASE_API, apiRes, bodyLen, durationMs);
    const is403Rl = apiRes.status === 403 && (diag.rateLimitRemaining === '0' || !!diag.retryAfter);
    const reason = (apiRes.status === 429 || is403Rl)
      ? `rate-limited (HTTP ${apiRes.status}${diag.retryAfter ? `, Retry-After=${diag.retryAfter}` : ''}${diag.rateLimitReset ? `, Reset=${diag.rateLimitReset}` : ''})`
      : apiRes.status === 403 ? 'forbidden (HTTP 403)'
      : `HTTP ${apiRes.status}`;
    logStage('check-api-result', `Releases API failed: ${reason}`, diag);
    stageErrors.push(`releases-api (${reason})`);
    const finalErr = new Error(`Update check failed: ${stageErrors.join('; ')}`);
    finalErr.stages = stageErrors;
    throw finalErr;
  }

  let apiText = '';
  try {
    apiText = typeof apiRes.text === 'function' ? await apiRes.text() : JSON.stringify(await apiRes.json());
    const json = JSON.parse(apiText);
    const diag = buildResponseDiag('releases-api', RELEASE_API, apiRes, apiText.length, durationMs);
    logStage('check-api-result', 'Fetched GitHub Releases API', diag);
    if (json.draft === true) {
      stageErrors.push('releases-api (draft release ignored)');
      const draftErr = new Error(`Update check failed: ${stageErrors.join('; ')}`);
      draftErr.stages = stageErrors;
      throw draftErr;
    }
    const matched = findMatchingAsset(json.assets || []);
    return {
      version: String(json.tag_name || '').replace(/^v/i, ''),
      url: matched ? matched.browser_download_url : null,
      assetName: matched ? matched.name : null,
      size: matched ? matched.size : 0,
      notes: json.body || '',
      htmlUrl: json.html_url
    };
  } catch (parseErr) {
    if (parseErr.stages) throw parseErr;
    const diag = buildResponseDiag('releases-api', RELEASE_API, apiRes, apiText.length, durationMs, parseErr);
    logStage('check-api-result', 'Malformed JSON from Releases API', diag);
    stageErrors.push('releases-api (malformed JSON)');
    const finalErr = new Error(`Update check failed: ${stageErrors.join('; ')}`);
    finalErr.stages = stageErrors;
    throw finalErr;
  }
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

function inspectWindowsInstallLocations(execDir, existsFn = fs.existsSync) {
  const candidates = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Eclipse') : null,
    'C:\\Program Files\\Eclipse',
    'C:\\Program Files (x86)\\Eclipse'
  ].filter(Boolean);

  const normExec = path.resolve(execDir || '').toLowerCase();
  const found = [];
  const duplicates = [];
  for (const dir of candidates) {
    const exe = path.join(dir, 'Eclipse.exe');
    if (existsFn(exe)) {
      found.push(dir);
      if (path.resolve(dir).toLowerCase() !== normExec) {
        duplicates.push(dir);
      }
    }
  }
  return { found, duplicates };
}

function emitInstallerError(getWindow, message) {
  try {
    const win = typeof getWindow === 'function' ? getWindow() : null;
    if (win && !win.isDestroyed() && win.webContents) {
      win.webContents.send('update-error', { stage: 'install', message });
    }
  } catch (_) {}
}

async function executeInstaller(installerPath, hooks = {}, getWindow = null) {
  if (isApplyingUpdate) {
    logStage('apply', 'executeInstaller already running. Skipping re-entrant call.');
    return { ok: false, skipped: true };
  }
  if (isSystemShuttingDown) {
    logStage('apply', 'System is shutting down. Skipping installer execution to avoid corruption.');
    return { ok: false, skipped: true };
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
        const msg = 'sha512 mismatch on pre-install verification! Installer file corrupted or tampered.';
        emitInstallerError(getWindow, msg);
        throw new Error(msg);
      }
      logStage('apply', 'Pre-install sha512 verification passed.');
    } catch (verr) {
      isApplyingUpdate = false;
      logStage('apply-error', `Pre-install sha512 check failed: ${verr.message}`);
      emitInstallerError(getWindow, verr.message);
      throw verr;
    }
  }

  flushPlaybackResume(getWindow ? getWindow() : null);

  try { if (hooks && typeof hooks.beforeExit === 'function') hooks.beforeExit(); } catch (_) {}

  const platform = (hooks && hooks.platform) || process.platform;
  if (platform === 'win32') {
    const execPath = (hooks && hooks.execPath) || process.execPath;
    const execDir = path.dirname(execPath);
    const existsFn = (hooks && typeof hooks.existsSync === 'function') ? hooks.existsSync : fs.existsSync;
    const isUnpacked = existsFn(path.join(execDir, 'resources', 'app.asar'));
    const pid = process.pid;

    // electron-builder NSIS: --updated + /S + --force-run, with /D=<execDir> last and unquoted.
    const args = ['--updated', '/S', '--force-run'];
    if (isUnpacked) {
      args.push('/D=' + execDir);
    }
    const installDir = isUnpacked ? execDir : null;

    const locInfo = inspectWindowsInstallLocations(execDir, existsFn);
    logStage('apply', 'Pre-install path & duplicate check', {
      execPath,
      execDir,
      pendingInstallerPath: installerPath,
      targetVersion: pendingTargetVersion,
      args,
      installDir,
      foundInstallations: locInfo.found,
      duplicateInstallations: locInfo.duplicates
    });
    if (locInfo.duplicates.length > 0) {
      logStage('apply-warning', 'Duplicate Eclipse installations detected outside active execDir', {
        execDir,
        duplicates: locInfo.duplicates
      });
    }

    const spawnFn = (hooks && typeof hooks.spawnImpl === 'function') ? hooks.spawnImpl : spawn;
    const exitFn = (hooks && typeof hooks.exitImpl === 'function')
      ? hooks.exitImpl
      : (code) => { try { app.exit(code); } catch (_) { process.exit(code); } };
    const handoffDelayMs = (hooks && Number.isFinite(hooks.handoffDelayMs)) ? hooks.handoffDelayMs : 200;

    return await new Promise((resolve, reject) => {
      let settled = false;
      let spawned = false;
      let earlyExit = false;
      let handoffTimer = null;

      let child;
      try {
        child = spawnFn(installerPath, args, { detached: true, stdio: 'ignore', windowsHide: true });
      } catch (syncErr) {
        isApplyingUpdate = false;
        logStage('installer-error', 'Synchronous spawn failure', {
          code: syncErr.code || null,
          message: syncErr.message,
          installerPath
        });
        logStage('install-failed', 'Installer failed to start', { code: syncErr.code || null, message: syncErr.message });
        emitInstallerError(getWindow, `Installer failed to start: ${syncErr.message}`);
        return reject(syncErr);
      }

      const fail = (err, stage = 'installer-error') => {
        if (handoffTimer) { clearTimeout(handoffTimer); handoffTimer = null; }
        if (settled) return;
        settled = true;
        isApplyingUpdate = false;
        logStage(stage, err.message, { code: err.code || null, installerPath });
        logStage('install-failed', err.message, { code: err.code || null, installerPath });
        emitInstallerError(getWindow, err.message);
        reject(err);
      };

      child.once('error', (err) => {
        fail(err, 'installer-error');
      });

      const onExitOrClose = (eventName, code, signal) => {
        logStage('installer-exit', `Installer ${eventName}`, {
          exitCode: code,
          signal: signal || null,
          installerPath
        });
        if (!settled && code !== 0) {
          earlyExit = true;
          const err = new Error(`Installer exited with code ${code}${signal ? ` (signal ${signal})` : ''}`);
          err.exitCode = code;
          fail(err, 'installer-exit');
        }
      };

      child.once('exit', (code, signal) => onExitOrClose('exit', code, signal));
      child.once('close', (code, signal) => onExitOrClose('close', code, signal));

      child.once('spawn', () => {
        spawned = true;
        logStage('installer-spawn', 'NSIS installer process spawned', {
          pid: child.pid || null,
          parentPid: pid,
          installerPath,
          args
        });

        // Mark clean exit before handing off to installer so crash-guard never counts this as a crash
        try {
          const st = readUpdateState();
          st.startedOk = true;
          st.consecutiveCrashes = 0;
          writeUpdateState(st);
        } catch (_) {}

        try { if (typeof child.unref === 'function') child.unref(); } catch (_) {}

        handoffTimer = setTimeout(() => {
          if (earlyExit || settled || !spawned) return;
          settled = true;
          logStage('install-success', 'Installer handoff confirmed; exiting app for update', {
            pid: child.pid || null,
            installDir,
            args
          });
          exitFn(0);
          resolve({ ok: true, pid: child.pid || null, args, installDir });
        }, handoffDelayMs);
      });
    });
  }

  // Linux AppImage / macOS
  const err = await shell.openPath(installerPath);
  if (err) {
    isApplyingUpdate = false;
    logStage('install-failed', `Could not launch installer: ${err}`, { installerPath });
    emitInstallerError(getWindow, `Could not launch installer: ${err}`);
    throw new Error(`Could not launch installer: ${err}`);
  }
  logStage('install-success', 'Launched non-Windows installer via shell.openPath', { installerPath });
  setTimeout(() => { try { app.exit(0); } catch (_) { process.exit(0); } }, 500);
  return { ok: true };
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
  if (updaterInitialized) {
    logStage('init', 'Updater already initialized; skipping duplicate initUpdater call.');
    return;
  }
  updaterInitialized = true;
  const currentVer = app.getVersion();
  initLogger(app.getPath('userData'));
  logStage('init', `Updater initialized for Eclipse v${currentVer}`, { pid: process.pid, platform: process.platform, arch: process.arch });

  checkCrashRollback(currentVer);

  let manualCheck = false;
  let isDownloading = false;
  let activeManifest = null;
  let lastManifest = null;
  let checkInFlight = null;
  lastManifestEtag = null;

  const send = (channel, payload) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };

  const checkForUpdates = async (isManual = false) => {
    if (checkInFlight) {
      try { await checkInFlight; } catch (_) {}
      if (!isManual) return;
    }
    if (isManual) manualCheck = true;

    const run = (async () => {
      try {
        logStage('check', 'Checking for updates...');
        let manifest = await fetchLatestManifest(lastManifest !== null);
        if (manifest && manifest.notModified) {
          manifest = lastManifest;
        } else if (manifest) {
          lastManifest = manifest;
        }
        if (!manifest) {
          const errMsg = 'Update check failed: empty manifest after 304 without cache.';
          logStage('check-error', errMsg);
          if (manualCheck) send('update-error', { stage: 'check', message: errMsg });
          manualCheck = false;
          return;
        }

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
          if (manualCheck) {
            send('update-error', { stage: 'check', message: `Update v${remoteVer} is blocked from installation.` });
          }
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
          if (!manifest.url) {
            const missingMsg = `No compatible installer found for ${process.platform}/${process.arch} in v${remoteVer}.`;
            logStage('check-error', missingMsg, { version: remoteVer, platform: process.platform, arch: process.arch });
            if (manualCheck) send('update-error', { stage: 'check', message: missingMsg });
            manualCheck = false;
            return;
          }
          logStage('check-success', `Newer version available: v${remoteVer} (local: v${currentVer})`, {
            version: remoteVer,
            assetName: manifest.assetName,
            url: manifest.url
          });

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
          logStage('check-no-update', `Application is up to date (v${currentVer})`);
          if (manualCheck) send('update-not-available', { version: currentVer, manual: true });
        }
        manualCheck = false;
      } catch (err) {
        logStage('check-error', err.message);
        if (manualCheck) {
          send('update-error', { stage: 'check', message: err.message || 'Không thể kiểm tra cập nhật' });
        }
        manualCheck = false;
      }
    })();

    checkInFlight = run;
    try {
      await run;
    } finally {
      if (checkInFlight === run) checkInFlight = null;
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
  ipcMain.handle('update-check', async () => {
    await checkForUpdates(true);
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
      executeInstaller(pendingInstallerPath, hooks, getWindow).catch((err) => {
        logStage('install-failed', 'before-quit installer failed', { message: err.message });
      });
    }
  });

  // Initial check with randomized jitter
  const initialDelay = CHECK_DELAY_MS + Math.floor(Math.random() * 2000);
  setTimeout(() => { checkForUpdates(false); }, initialDelay).unref();

  // Periodic check with jitter (±15 mins)
  const jitter = Math.floor((Math.random() - 0.5) * 30 * 60 * 1000);
  setInterval(() => { checkForUpdates(false); }, CHECK_EVERY_MS + jitter).unref();

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
