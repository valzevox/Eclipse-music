const { app, BrowserWindow, dialog, ipcMain, screen, shell, Tray, Menu, nativeImage, globalShortcut, powerMonitor, session, safeStorage } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const url = require('url');
const { pathToFileURL } = url;
const { spawn, execFile, execSync, execFileSync } = require('child_process');
const crypto = require('crypto');
const zlib = require('zlib');
const {
  createCodeVerifier,
  createCodeChallenge,
  createOAuthState,
  createAuthorizationUrl,
  exchangeAuthorizationCode,
  refreshAccessToken,
  executeGoogleLogout
} = require('./google-oauth');
const { fetchYouTubeLibrary } = require('./youtube-data');
const { LibraryDatabase } = require('./db/library-database');
const googleOAuthCfg = require('./google-oauth');
const GOOGLE_CLIENT_ID = String(googleOAuthCfg.GOOGLE_CLIENT_ID || process.env.ECLIPSE_GOOGLE_CLIENT_ID || '').trim();
const RFACC_KEY = crypto.createHash('sha256').update('riff-account-key-v1').digest();

function encryptAccount(dataObj) {
  const jsonStr = typeof dataObj === 'string' ? dataObj : JSON.stringify(dataObj);
  const compressed = zlib.deflateRawSync(Buffer.from(jsonStr, 'utf8'));
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', RFACC_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const tag = cipher.getAuthTag();
  const header = Buffer.from('RFAC');
  return Buffer.concat([header, iv, tag, encrypted]);
}

function decryptAccount(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 32) throw new Error('Invalid account file');
  if (buffer.subarray(0, 4).toString('utf8') !== 'RFAC') throw new Error('Invalid file header');
  const iv = buffer.subarray(4, 16);
  const tag = buffer.subarray(16, 32);
  const encrypted = buffer.subarray(32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', RFACC_KEY, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  const decompressed = zlib.inflateRawSync(decrypted);
  return JSON.parse(decompressed.toString('utf8'));
}
const { LIBRARY_DIR, DATA_DIR, resolveBinary, tutorialDone, markTutorialDone, readStartupConfig, writeStartupConfig } = require('../shared/platform');
const { getTempCookieManager } = require('../shared/temp-cookie-manager');
const { BrowserLoginService } = require('./browser-login/browser-login-service');
const { createBrowserExtensionManager } = require('./browser-login/browser-extension-manager');
const { BrowserLoginTarget } = require('./browser-login/browser-login-targets');
const { ExternalSessionService } = require('./browser-login/external-session-service');
const mainTempCookieMgr = getTempCookieManager(DATA_DIR);
try {
  mainTempCookieMgr.sweepStaleCookieJars();
  const legacyJar = path.join(DATA_DIR, 'yt-cookies.txt');
  if (fs.existsSync(legacyJar)) fs.unlinkSync(legacyJar);
} catch (_) {}
const { getLauncherInfo, installLauncher } = require('./launcher');
const { getSystemAudioOutputInfo } = require('../shared/audio-output');
const { log, tail, LOG_DIR } = require('../shared/logger');
const logger = { log, tail, LOG_DIR, error: (msg, err) => log('ERROR', `${msg}: ${err && err.message ? err.message : err}`) };

process.on('uncaughtException', (err) => {
  try { logger.error('Uncaught exception in main', err); } catch (_) {}
});
process.on('unhandledRejection', (reason) => {
  try {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    logger.error('Unhandled rejection in main', err);
  } catch (_) {}
});

const enabledFeatures = [];
if (process.platform === 'linux') {
  enabledFeatures.push('WaylandWindowDecorations', 'UseOzonePlatform', 'WaylandFractionalScaleV1', 'MediaSessionService', 'HardwareMediaKeyHandling');
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
  app.commandLine.appendSwitch('disable-features', 'Vulkan,AudioServiceOutOfProcess');

  if (process.env.RIFF_SKIP_GPU_BUFFER_FLAGS !== '1') {
    app.commandLine.appendSwitch('disable-gpu-memory-buffer-video-frames');
    app.commandLine.appendSwitch('disable-gpu-memory-buffer-compositor-resources');
  }
}

if (process.platform === 'win32') {
  enabledFeatures.push('HardwareMediaKeyHandling', 'MediaSessionService');
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
}

if (enabledFeatures.length > 0) {
  app.commandLine.appendSwitch('enable-features', enabledFeatures.join(','));
}

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('renderer-process-limit', '1');
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-domain-reliability');
app.commandLine.appendSwitch('disable-sync');
app.commandLine.appendSwitch('disable-speech-api');
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=384');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
app.commandLine.appendSwitch('disk-cache-size', '52428800');
app.commandLine.appendSwitch('media-cache-size', '52428800');

setInterval(() => {
  try {
    session.defaultSession.clearCache().catch(() => {});
    if (global.gc) global.gc();
  } catch (_) {}
}, 180000);
app.on('ready', () => {
  const cleanUA = (app.userAgentFallback || '').replace(/\s*Electron\/[^\s]+/gi, '').replace(/\s*(?:riff|eclipse)\/[^\s]+/gi, '');
  if (cleanUA) app.userAgentFallback = cleanUA;
});

const extraFlags = (process.env.RIFF_FLAGS || '').split(';').map((s) => s.trim()).filter(Boolean);
for (const flag of extraFlags) {
  const eq = flag.indexOf('=');
  if (eq > 0) app.commandLine.appendSwitch(flag.slice(0, eq), flag.slice(eq + 1));
  else app.commandLine.appendSwitch(flag);
}

if (process.env.RIFF_DEBUG === '1') {
  app.whenReady().then(async () => {
    console.log('[gpu] features', JSON.stringify(app.getGPUFeatureStatus()));
    try {
      console.log('[gpu] info', JSON.stringify(await app.getGPUInfo('basic')));
    } catch (e) {}
    setInterval(() => {
      const rows = app.getAppMetrics().map((m) => `${m.type}:${Math.round(m.cpu.percentCPUUsage)}%`);
      console.log('[cpu]', rows.join('  '));
    }, 5000).unref();
  });
}

if (process.argv.includes('lyrics') || process.argv.includes('--lyrics')) {
  const cliPath = path.join(__dirname, 'cli.js');
  const child = spawn(process.execPath, [cliPath, 'lyrics'], { stdio: 'inherit', env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }) });
  child.on('exit', (code) => process.exit(code || 0));
} else {
  runGUI();
}

function runGUI() {
  // Set AppUserModelId as early as possible so Windows Taskbar pins and icons associate correctly
  if (process.platform === 'win32') {
    app.setAppUserModelId('io.github.eclipse.app');
  }
  const { startServer, PORT, getServerToken } = require('../server/server');
  const discordRPC = require('./discord');

  let mainWindow = null;
  const allowMulti = !!readStartupConfig().multiInstance;
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock && !allowMulti) { app.quit(); return; }
  if (!gotLock && allowMulti) app.setPath('userData', `${app.getPath('userData')}-instance-${process.pid}`);
  app.on('second-instance', () => {
    if (allowMulti) return;
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
  let serverPort = PORT;
  let tray = null;
  let isQuitting = false;
  let trayOnClose = process.platform !== 'linux';
  let isMiniWindow = false;
  let preMiniBounds = null;

  const windowStatePath = path.join(app.getPath('userData'), 'window-state.json');

  const PRIMARY_STORAGE_FILE = path.join(__dirname, '../storage.json');
  const FALLBACK_STORAGE_FILE = path.join(app.getPath('userData'), 'storage.json');
  const AUTOSAVE_PROFILE_FILE = path.join(
    process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Eclipse')
      : process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support', 'Eclipse')
      : path.join(os.homedir(), '.config', 'eclipse'),
    'profile-autosave.json'
  );

  function getActiveStorageFile() {
    return FALLBACK_STORAGE_FILE;
  }

  function readStorageDiskSync() {
    const candidates = [
      FALLBACK_STORAGE_FILE,
      AUTOSAVE_PROFILE_FILE,
      path.join(app.getPath('appData'), 'riff', 'storage.json'),
      path.join(process.env.LOCALAPPDATA || '', 'Eclipse', 'storage.json'),
      path.join(process.env.LOCALAPPDATA || '', 'Riff', 'profile-autosave.json'),
      path.join(process.env.LOCALAPPDATA || '', 'Riff', 'storage.json'),
      PRIMARY_STORAGE_FILE
    ];

    for (const file of candidates) {
      try {
        if (file && fs.existsSync(file)) {
          const raw = fs.readFileSync(file, 'utf8').trim();
          if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) {
              writeStorageDiskSync(parsed);
              return parsed;
            }
          }
        }
      } catch (e) {
        console.warn('[eclipse] storage read warning for', file, e.message);
      }
    }
    return null;
  }

  function writeStorageDiskSync(data) {
    if (!data || typeof data !== 'object') return;
    const targets = [FALLBACK_STORAGE_FILE, AUTOSAVE_PROFILE_FILE];
    for (const file of targets) {
      try {
        const dir = path.dirname(file);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const tmpFile = file + '.tmp';
        fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf8');
        fs.renameSync(tmpFile, file);
      } catch (_) {
        try {
          fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
        } catch (_) {}
      }
    }
  }

  let storageFlushTimer = null;
  let latestStorageSnapshot = null;

  ipcMain.on('storage-get-all-sync', (event) => {
    event.returnValue = latestStorageSnapshot || readStorageDiskSync();
  });

  let storageDirty = false;

  ipcMain.on('storage-save-batch', (event, data) => {
    if (!data || typeof data !== 'object') return;
    latestStorageSnapshot = data;
    storageDirty = true;
    if (storageFlushTimer) clearTimeout(storageFlushTimer);
    storageFlushTimer = setTimeout(() => {
      storageFlushTimer = null;
      storageDirty = false;
      writeStorageDiskSync(latestStorageSnapshot);
    }, 250);
  });

  ipcMain.on('storage-save-sync', (event, data) => {
    if (storageFlushTimer) { clearTimeout(storageFlushTimer); storageFlushTimer = null; }
    if (data && typeof data === 'object') {
      latestStorageSnapshot = data;
      storageDirty = false;
      writeStorageDiskSync(latestStorageSnapshot);
    } else if (storageDirty && latestStorageSnapshot) {
      storageDirty = false;
      writeStorageDiskSync(latestStorageSnapshot);
    }
    event.returnValue = true;
  });

  app.on('before-quit', () => {
    if (storageFlushTimer) {
      clearTimeout(storageFlushTimer);
      storageFlushTimer = null;
    }
    if (storageDirty && latestStorageSnapshot) {
      storageDirty = false;
      writeStorageDiskSync(latestStorageSnapshot);
    }
    if (libraryDb) {
      try { libraryDb.close(); } catch (_) {}
    }
  });

  // --- SQLite Library Database (node:sqlite) ---
  let libraryDb = null;
  function getLibraryDb() {
    if (!libraryDb) {
      const dbPath = path.join(app.getPath('userData'), 'eclipse-library.db');
      libraryDb = new LibraryDatabase(dbPath);
    }
    return libraryDb;
  }

  ipcMain.handle('library-db:load-all', async (event, accountId = 'default') => {
    try {
      return { success: true, data: getLibraryDb().loadAllLibrary(accountId) };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('library-db:save-albums', async (event, { albums, accountId = 'default' } = {}) => {
    try {
      getLibraryDb().setSavedAlbums(albums, accountId);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('library-db:delete-album', async (event, { id, accountId = 'default', entityType = 'Album' } = {}) => {
    try {
      getLibraryDb().deleteAlbum(id, accountId, entityType);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('library-db:save-playlists', async (event, { playlists, accountId = 'default' } = {}) => {
    try {
      getLibraryDb().setPlaylists(playlists, accountId);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('library-db:delete-playlist', async (event, { id } = {}) => {
    try {
      getLibraryDb().deletePlaylist(id);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('library-db:save-favorites', async (event, { tracks, accountId = 'default' } = {}) => {
    try {
      getLibraryDb().setFavorites(tracks, accountId);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('library-db:add-favorite', async (event, { track, accountId = 'default' } = {}) => {
    try {
      getLibraryDb().addFavorite(track, accountId);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('library-db:remove-favorite', async (event, { trackId, accountId = 'default' } = {}) => {
    try {
      getLibraryDb().removeFavorite(trackId, accountId);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('library-db:record-history', async (event, { track, source = null } = {}) => {
    try {
      getLibraryDb().recordHistory(track, source);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('library-db:get-history', async (event, { limit = 100 } = {}) => {
    try {
      return { success: true, data: getLibraryDb().getHistory(limit) };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('library-db:migrate-legacy', async (event, { payload, accountId = 'default' } = {}) => {
    try {
      const res = getLibraryDb().migrateFromLegacy(payload, accountId);
      return res;
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  function readWindowState() {
    try {
      const raw = fs.readFileSync(windowStatePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      return parsed;
    } catch (error) {
      return null;
    }
  }

  function clampBoundsToDisplay(bounds) {
    const primaryDisplay = screen.getPrimaryDisplay();
    const primaryWorkArea = primaryDisplay.workArea;
    const scaleFactor = primaryDisplay.scaleFactor;

    const sourceBounds = bounds && Number.isFinite(bounds.width) && Number.isFinite(bounds.height)
    ? { ...bounds }
    : {};

    const minW = 800;
    const minH = 540;

    const width = Math.max(minW, Math.min(sourceBounds.width || 0, primaryWorkArea.width));
    const height = Math.max(minH, Math.min(sourceBounds.height || 0, primaryWorkArea.height));

    const display = screen.getDisplayMatching({
      x: sourceBounds.x ?? primaryWorkArea.x,
      y: sourceBounds.y ?? primaryWorkArea.y,
      width,
      height
    }) || primaryDisplay;

    const workArea = display.workArea;
    const x = Math.min(
      Math.max(sourceBounds.x ?? workArea.x + Math.round((workArea.width - width) / 2), workArea.x),
                       workArea.x + Math.max(0, workArea.width - width)
    );
    const y = Math.min(
      Math.max(sourceBounds.y ?? workArea.y + Math.round((workArea.height - height) / 2), workArea.y),
                       workArea.y + Math.max(0, workArea.height - height)
    );

    return { x, y, width, height };
  }

  function getResponsiveWindowBounds() {
    const { workArea } = screen.getPrimaryDisplay();
    const persisted = readWindowState();
    const responsiveBounds = {
      width: Math.round(workArea.width * 0.82),
      height: Math.round(workArea.height * 0.86),
      x: workArea.x + Math.round(workArea.width * 0.09),
      y: workArea.y + Math.round(workArea.height * 0.07)
    };
    const merged = {
      ...responsiveBounds,
      ...(persisted && persisted.bounds ? persisted.bounds : {})
    };
    return clampBoundsToDisplay(merged);
  }

  function persistWindowState() {
    if (isMiniWindow) return;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const isMaximized = mainWindow.isMaximized();
    const isFullScreen = mainWindow.isFullScreen();
    const bounds = isMaximized || isFullScreen ? mainWindow.getNormalBounds() : mainWindow.getBounds();
    try {
      fs.mkdirSync(path.dirname(windowStatePath), { recursive: true });
      fs.writeFileSync(windowStatePath, JSON.stringify({
        bounds,
        isMaximized,
        isFullScreen
      }, null, 2));
    } catch (error) {
      console.warn('Failed to persist window state:', error);
    }
  }

  async function createWindow() {
    serverPort = await startServer(PORT);
    const firstRun = !tutorialDone();
    const initialBounds = getResponsiveWindowBounds();
    const savedState = readWindowState();

    const primaryDisplay = screen.getPrimaryDisplay();
    const scaleFactor = primaryDisplay.scaleFactor;

    app.setAppUserModelId('io.github.eclipse.app');
    mainWindow = new BrowserWindow({
      x: initialBounds.x,
      y: initialBounds.y,
      width: initialBounds.width,
      height: initialBounds.height,
      minWidth: 800,
      minHeight: 540,
                                   backgroundColor: firstRun ? '#8d5ef2' : '#000000',
                                   title: 'Eclipse',
                                   icon: path.join(__dirname, '../../assets', (process.platform === 'win32' ? 'icon.ico' : 'icon.png')),
                                   frame: false,
                                   titleBarStyle: 'hidden',
                                   show: false,
                                   useContentSize: true,
                                   webPreferences: {
                                     preload: path.join(__dirname, 'preload.js'),
                                   additionalArguments: [`--eclipse-token=${getServerToken()}`],
                                   nodeIntegration: false,
                                   contextIsolation: true,
                                   webSecurity: false,
                                   webviewTag: true,
                                   backgroundThrottling: true,
                                   spellcheck: false
                                   }
    });

    if (savedState?.isMaximized) {
      mainWindow.maximize();
    }

    let hasShown = false;
    const forceShow = () => {
      if (hasShown || !mainWindow || mainWindow.isDestroyed()) return;
      hasShown = true;
      mainWindow.show();
      mainWindow.focus();
      try { updateThumbarButtons(false); } catch (_) {}
    };

    mainWindow.once('ready-to-show', forceShow);
    setTimeout(forceShow, 2000);

    mainWindow.loadFile(path.join(__dirname, '../renderer', firstRun ? 'welcome.html' : 'index.html'));
    if (firstRun) {
      ipcMain.removeAllListeners('welcome-finish');
      ipcMain.once('welcome-finish', (e, detail) => {
        markTutorialDone();
        if (detail && detail.launcher) installLauncher();
        if (!mainWindow || mainWindow.isDestroyed()) return;
        const result = detail && !detail.skipped ? detail : null;
        mainWindow.setBackgroundColor('#000000');
        mainWindow.webContents.once('did-finish-load', () => { if (result) mainWindow.webContents.send('welcome-result', result); });
        mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
        require('./updater').initUpdater(() => mainWindow, {
          beforeExit: () => { isQuitting = true; }
        });
      });
    }

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: 'deny' };
    });

    mainWindow.webContents.on('did-finish-load', () => {
      try {
        const curUrl = mainWindow.webContents.getURL() || '';
        if (curUrl.includes('index.html')) {
          if (mainWindow.webContents.navigationHistory?.clear) {
            mainWindow.webContents.navigationHistory.clear();
          } else if (mainWindow.webContents.clearHistory) {
            mainWindow.webContents.clearHistory();
          }
        }
      } catch (_) {}
    });

    mainWindow.on('minimize', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('window-visibility', false);
        if (global.gc) global.gc();
      }
    });

    mainWindow.on('blur', () => {
      if (global.gc) global.gc();
    });

    mainWindow.on('restore', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('window-visibility', true);
      }
    });

    mainWindow.on('hide', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('window-visibility', false);
      }
    });

    mainWindow.on('show', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('window-visibility', true);
      }
    });
    mainWindow.on('resize', persistWindowState);
    mainWindow.on('move', persistWindowState);
    mainWindow.on('maximize', persistWindowState);
    mainWindow.on('unmaximize', persistWindowState);
    mainWindow.on('enter-full-screen', persistWindowState);
    mainWindow.on('leave-full-screen', persistWindowState);
    mainWindow.on('close', (e) => {
      persistWindowState();
      if (trayOnClose && tray && !isQuitting) {
        e.preventDefault();
        mainWindow.hide();
      }
    });

    discordRPC.initRPC();
  }

  ipcMain.removeHandler('get-server-port');
  ipcMain.removeHandler('get-server-token');
  ipcMain.removeAllListeners('get-server-token-sync');
  ipcMain.removeHandler('discord-rpc-get-enabled');
  ipcMain.removeHandler('discord-rpc-get-connected');
  ipcMain.removeHandler('discord-rpc-reconnect');
  ipcMain.removeHandler('account-export');
  ipcMain.removeHandler('account-import');
  ipcMain.removeHandler('pick-media');
  ipcMain.removeHandler('import-audio-files');
  ipcMain.removeHandler('pick-local-files');
  ipcMain.removeHandler('pick-local-folder');
  ipcMain.removeHandler('rescan-local-metadata');

  
const thumbarIconPrev = path.join(__dirname, '../../assets/thumbar', 'previous.png');
const thumbarIconPlay = path.join(__dirname, '../../assets/thumbar', 'play.png');
const thumbarIconPause = path.join(__dirname, '../../assets/thumbar', 'pause.png');
const thumbarIconNext = path.join(__dirname, '../../assets/thumbar', 'next.png');

function updateThumbarButtons(isPlaying) {
  if (process.platform !== 'win32' || !mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.setThumbarButtons([
      {
        tooltip: 'Previous track',
        icon: thumbarIconPrev,
        click() {
          mainWindow.webContents.send('media-command', 'prev');
        }
      },
      {
        tooltip: isPlaying ? 'Pause' : 'Play',
        icon: isPlaying ? thumbarIconPause : thumbarIconPlay,
        click() {
          mainWindow.webContents.send('media-command', isPlaying ? 'pause' : 'play');
        }
      },
      {
        tooltip: 'Next track',
        icon: thumbarIconNext,
        click() {
          mainWindow.webContents.send('media-command', 'next');
        }
      }
    ]);
  } catch (err) {
    console.warn('[Thumbar] Error setting thumbar buttons:', err);
  }
}

ipcMain.on('update-thumbar', (event, isPlaying) => {
  updateThumbarButtons(!!isPlaying);
});


let floatingLyricsWindow = null;
const MINI_PLAYER_STATE_FILE = path.join(app.getPath('userData'), 'mini-player-state.json');

function loadMiniPlayerBounds() {
  try {
    if (fs.existsSync(MINI_PLAYER_STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(MINI_PLAYER_STATE_FILE, 'utf8'));
      if (data && typeof data.width === 'number' && typeof data.height === 'number') {
        const displays = screen.getAllDisplays();
        const minW = 220;
        const minH = 76;
        const w = Math.max(minW, data.width);
        const h = Math.max(minH, data.height);

        if (typeof data.x === 'number' && typeof data.y === 'number') {
          const isVisible = displays.some(d => {
            const b = d.bounds;
            return data.x >= b.x - 20 && data.x <= b.x + b.width - 50 &&
                   data.y >= b.y - 20 && data.y <= b.y + b.height - 50;
          });
          if (isVisible) {
            return { x: data.x, y: data.y, width: w, height: h };
          }
        }
        return { width: w, height: h };
      }
    }
  } catch (_) {}
  return null;
}

function saveMiniPlayerBounds() {
  if (!floatingLyricsWindow || floatingLyricsWindow.isDestroyed()) return;
  try {
    const b = floatingLyricsWindow.getBounds();
    fs.writeFileSync(MINI_PLAYER_STATE_FILE, JSON.stringify(b, null, 2), 'utf8');
  } catch (_) {}
}

function createFloatingLyricsWindow() {
  if (floatingLyricsWindow && !floatingLyricsWindow.isDestroyed()) {
    floatingLyricsWindow.show();
    floatingLyricsWindow.focus();
    return;
  }
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;

  const savedBounds = loadMiniPlayerBounds();
  const initWidth = savedBounds ? savedBounds.width : 660;
  const initHeight = savedBounds ? savedBounds.height : 105;
  const initX = (savedBounds && typeof savedBounds.x === 'number') ? savedBounds.x : Math.round((screenWidth - initWidth) / 2);
  const initY = (savedBounds && typeof savedBounds.y === 'number') ? savedBounds.y : (screenHeight - initHeight - 55);

  floatingLyricsWindow = new BrowserWindow({
    width: initWidth,
    height: initHeight,
    minWidth: 220,
    minHeight: 76,
    x: initX,
    y: initY,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      additionalArguments: [`--eclipse-token=${getServerToken()}`],
      nodeIntegration: false,
      contextIsolation: true,
      spellcheck: false
    }
  });

  let saveTimer = null;
  const debounceSaveBounds = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveMiniPlayerBounds, 400);
  };

  floatingLyricsWindow.on('resize', debounceSaveBounds);
  floatingLyricsWindow.on('move', debounceSaveBounds);

  floatingLyricsWindow.loadFile(path.join(__dirname, '../renderer/floating-lyrics.html'));
  floatingLyricsWindow.once('ready-to-show', () => {
    if (floatingLyricsWindow && !floatingLyricsWindow.isDestroyed()) {
      floatingLyricsWindow.showInactive();
    }
  });

  floatingLyricsWindow.on('closed', () => {
    if (saveTimer) clearTimeout(saveTimer);
    floatingLyricsWindow = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('floating-lyrics-state', false);
    }
  });
}

ipcMain.handle('toggle-floating-lyrics', () => {
  if (floatingLyricsWindow && !floatingLyricsWindow.isDestroyed()) {
    floatingLyricsWindow.close();
    floatingLyricsWindow = null;
    return false;
  } else {
    createFloatingLyricsWindow();
    return true;
  }
});

ipcMain.on('floating-lyrics-ready', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('floating-lyrics-request-sync');
  }
});

ipcMain.on('floating-lyrics-update', (event, data) => {
  if (floatingLyricsWindow && !floatingLyricsWindow.isDestroyed()) {
    floatingLyricsWindow.webContents.send('floating-lyrics-data', data);
  }
});

ipcMain.on('floating-command', (event, cmd) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('media-command', cmd);
  }
});

ipcMain.on('close-floating-lyrics', () => {
  if (floatingLyricsWindow && !floatingLyricsWindow.isDestroyed()) {
    floatingLyricsWindow.close();
    floatingLyricsWindow = null;
  }
});

ipcMain.on('window-minimize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
  });

    ipcMain.on('window-maximize', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMaximized()) mainWindow.unmaximize();
        else mainWindow.maximize();
      }
    });

    ipcMain.on('window-close', () => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
    });

    ipcMain.on('open-external', (e, u) => {
      if (/^https:\/\/(?:accounts\.spotify\.com|(?:www\.)?last\.fm|github\.com)\//i.test(String(u))) {
        shell.openExternal(String(u));
      }
    });

    let mainLogCount = 0;
    let mainLogReset = Date.now();
    ipcMain.on('log-error', (e, data) => {
      const now = Date.now();
      if (now - mainLogReset > 60000) {
        mainLogReset = now;
        mainLogCount = 0;
      }
      if (mainLogCount < 20) {
        mainLogCount++;
        if (data && typeof data === 'object') {
          logger.log(data.level || 'ERROR', data.message || '', data.stack || null);
        }
      }
    });

    ipcMain.handle('get-diagnostics', async () => {
      const lines = [`Eclipse ${app.getVersion()}`, `OS ${process.platform} ${process.arch} ${os.release()}`, `Electron ${process.versions.electron} Chromium ${process.versions.chrome} Node ${process.versions.node}`, `Locale ${app.getLocale()}`, `Data ${DATA_DIR}`];
      for (const name of ['yt-dlp', 'ffmpeg']) {
        const bin = resolveBinary(name);
        lines.push(`${name}: ${bin || 'NOT FOUND'}`);
      }
      lines.push('--- last log lines ---', ...tail(60));
      return lines.join('\n');
    });
    ipcMain.on('open-logs-folder', () => { shell.openPath(LOG_DIR); });

      ipcMain.handle('get-server-port', () => serverPort);
      ipcMain.handle('get-server-token', () => getServerToken());
      ipcMain.on('get-server-token-sync', (event) => { event.returnValue = getServerToken(); });
      ipcMain.on('get-i18n-dict-sync', (event, lang) => {
        try {
          const safeLang = String(lang || 'en').replace(/[^a-zA-Z0-9_-]/g, '');
          const file = path.join(DATA_DIR, 'i18n', safeLang + '.json');
          if (fs.existsSync(file)) {
            event.returnValue = JSON.parse(fs.readFileSync(file, 'utf8'));
            return;
          }
        } catch (_) {}
        event.returnValue = null;
      });
      ipcMain.handle('get-i18n-dict', async (event, lang) => {
        try {
          const safeLang = String(lang || 'en').replace(/[^a-zA-Z0-9_-]/g, '');
          const file = path.join(DATA_DIR, 'i18n', safeLang + '.json');
          if (fs.existsSync(file)) {
            const raw = await fs.promises.readFile(file, 'utf8');
            return JSON.parse(raw);
          }
        } catch (_) {}
        return null;
      });
      let activeProxyAuth = null;
      app.on('login', (event, webContents, request, authInfo, callback) => {
        if (authInfo.isProxy && activeProxyAuth) {
          event.preventDefault();
          callback(activeProxyAuth.username, activeProxyAuth.password);
          return;
        }
      });

      ipcMain.handle('set-app-proxy', async (event, proxyUrl) => {
        try {
          const clean = String(proxyUrl || '').trim();
          let proxyRules = clean;
          activeProxyAuth = null;
          if (clean) {
            try {
              const u = new URL(clean);
              if (u.username || u.password) {
                activeProxyAuth = {
                  username: decodeURIComponent(u.username || ''),
                  password: decodeURIComponent(u.password || '')
                };
                proxyRules = u.protocol + '//' + u.host;
              }
            } catch (_) {}
          }
          const config = clean
            ? { proxyRules, proxyBypassRules: '<local>,127.0.0.1,localhost' }
            : { mode: 'direct' };
          await session.defaultSession.setProxy(config);
          const googleSess = session.fromPartition('persist:eclipse-google');
          if (googleSess) await googleSess.setProxy(config);
          return { success: true };
        } catch (e) {
          return { success: false, error: e.message };
        }
      });
      ipcMain.handle('get-gpu-compositing', () => { try { return String(app.getGPUFeatureStatus().gpu_compositing || ''); } catch (e) { return ''; } });
      ipcMain.handle('launcher-info', () => getLauncherInfo());
      ipcMain.handle('install-launcher', () => installLauncher());
      ipcMain.handle('get-audio-output-info', async () => getSystemAudioOutputInfo());
      require('./themes').register(() => mainWindow);
      require('./plugins').register(() => mainWindow);

      ipcMain.on('discord-rpc-update', (event, trackInfo) => {
        discordRPC.updatePresence(trackInfo);
      });

      ipcMain.on('discord-rpc-clear', () => {
        discordRPC.clearPresence();
      });

      ipcMain.on('discord-rpc-set-enabled', (event, enabled) => {
        discordRPC.setEnabled(enabled);
      });

      ipcMain.handle('discord-rpc-set-client-id', (event, clientId) => {
        if (discordRPC && discordRPC.setClientId) {
          discordRPC.setClientId(clientId);
          if (discordRPC.reconnectRPC) discordRPC.reconnectRPC();
          return true;
        }
        return false;
      });

      ipcMain.handle('discord-rpc-get-client-id', () => {
        return (discordRPC && discordRPC.getClientId) ? discordRPC.getClientId() : '';
      });

      ipcMain.handle('discord-rpc-get-enabled', () => discordRPC.getEnabled());
      ipcMain.handle('discord-rpc-get-connected', () => discordRPC.getConnected());
      ipcMain.handle('discord-rpc-reconnect', () => {
        if (discordRPC && discordRPC.reconnectRPC) discordRPC.reconnectRPC();
        return true;
      });
      ipcMain.on('discord-rpc-reconnect', () => {
        if (discordRPC && discordRPC.reconnectRPC) discordRPC.reconnectRPC();
      });

      ipcMain.handle('get-cache-size', async () => {
        const fs = require('fs');
        const path = require('path');
        const os = require('os');
        const { session } = require('electron');

        let webSize = 0;
        try { webSize = await session.defaultSession.getCacheSize(); } catch(e) {}

        let audioSize = 0;
        const tracksDir = require('../shared/platform').CACHE_DIR;
        const thumbnailsDir = require('../shared/platform').THUMBNAILS_DIR;
        const audioExtRegex = /\.(opus|webm|m4a|mp3)$/i;
        try {
          if (fs.existsSync(tracksDir)) {
            for (const file of fs.readdirSync(tracksDir)) {
              if (audioExtRegex.test(file)) {
                try { audioSize += fs.statSync(path.join(tracksDir, file)).size; } catch(e) {}
              }
            }
          }
        } catch(e) {}
        try {
          if (fs.existsSync(thumbnailsDir)) {
            for (const file of fs.readdirSync(thumbnailsDir)) {
              try { audioSize += fs.statSync(path.join(thumbnailsDir, file)).size; } catch(e) {}
            }
          }
        } catch(e) {}

        return { audio: audioSize, web: webSize };
      });

      ipcMain.handle('clear-cache', async () => {
        const fs = require('fs');
        const path = require('path');
        const os = require('os');
        const { session } = require('electron');
        
        try { await session.defaultSession.clearCache(); } catch(e) {}
        try { await session.defaultSession.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] }); } catch(e) {}

        const tracksDir = require('../shared/platform').CACHE_DIR;
        const thumbnailsDir = require('../shared/platform').THUMBNAILS_DIR;
        const audioExtRegex = /\.(opus|webm|m4a|mp3)$/i;
        try {
          if (fs.existsSync(tracksDir)) {
            for (const file of fs.readdirSync(tracksDir)) {
              if (audioExtRegex.test(file)) {
                try { fs.unlinkSync(path.join(tracksDir, file)); } catch(e) {}
              }
            }
          }
        } catch(e) {}
        try {
          if (fs.existsSync(thumbnailsDir)) {
            for (const file of fs.readdirSync(thumbnailsDir)) {
              try { fs.unlinkSync(path.join(thumbnailsDir, file)); } catch(e) {}
            }
          }
        } catch(e) {}

        return true;
      });

      ipcMain.handle('pick-media', async () => {
        const r = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: [{ name: 'Media', extensions: ['png','jpg','jpeg','webp','gif','mp4','webm'] }] });
        return r.canceled ? null : pathToFileURL(r.filePaths[0]).href;
      });

      ipcMain.handle('import-audio-files', async () => {
        const r = await dialog.showOpenDialog(mainWindow, { properties: ['openFile', 'multiSelections', 'openDirectory'], filters: [{ name: 'Audio', extensions: ['mp3','wav','flac','opus','ogg','oga','m4a','aac','webm','weba'] }] });
        if (r.canceled) return [];
        const AUDIO_EXT = new Set(['mp3','wav','flac','opus','ogg','oga','m4a','aac','webm','weba']);
        const sources = [];
        for (const p of r.filePaths) {
          const st = fs.statSync(p);
          if (st.isDirectory()) {
            for (const f of fs.readdirSync(p)) {
              const fp = path.join(p, f);
              if (AUDIO_EXT.has(path.extname(f).slice(1).toLowerCase()) && fs.statSync(fp).isFile()) sources.push(fp);
            }
          } else {
            sources.push(p);
          }
        }
        fs.mkdirSync(LIBRARY_DIR, { recursive: true });
        const out = [];
        for (const src of sources) {
          const st = fs.statSync(src), ext = path.extname(src).slice(1).toLowerCase();
          const id = 'local_' + crypto.createHash('sha1').update(path.basename(src) + st.size).digest('hex').slice(0, 12);
          const file = `${id}.${ext}`;
          if (!fs.existsSync(path.join(LIBRARY_DIR, file))) await fs.promises.copyFile(src, path.join(LIBRARY_DIR, file));
          out.push({ id, file, ext, name: path.basename(src, path.extname(src)) });
        }
        return out;
      });

      async function extractLocalTrackMetadata(filePath) {
        if (!filePath || typeof filePath !== 'string') return null;
        const coversDir = path.join(app.getPath('userData'), 'local-covers');
        fs.mkdirSync(coversDir, { recursive: true });

        const fileHash = crypto.createHash('md5').update(filePath).digest('hex');
        const coverOut = path.join(coversDir, fileHash + '.jpg');

        let title = '';
        let artist = '';
        let album = '';
        let trackNum = 0;
        let duration = 0;

        let fd = null;
        try {
          fd = fs.openSync(filePath, 'r');
          const header = Buffer.alloc(10);
          const bytesRead = fs.readSync(fd, header, 0, 10, 0);

          if (bytesRead >= 10 && header[0] === 0x49 && header[1] === 0x44 && header[2] === 0x33) {
            const id3Version = header[3];
            const id3Flags = header[5];
            const tagSize = (header[6] << 21) | (header[7] << 14) | (header[8] << 7) | header[9];
            const readLimit = Math.min(tagSize, 12 * 1024 * 1024);
            const tagBuf = Buffer.alloc(readLimit);
            fs.readSync(fd, tagBuf, 0, tagBuf.length, 10);

            let offset = 0;
            if (id3Flags & 0x40) {
              if (id3Version === 4 && offset + 4 <= tagBuf.length) {
                const extSize = (tagBuf[offset] << 21) | (tagBuf[offset + 1] << 14) | (tagBuf[offset + 2] << 7) | tagBuf[offset + 3];
                offset += extSize;
              } else if (id3Version === 3 && offset + 4 <= tagBuf.length) {
                const extSize = tagBuf.readUInt32BE(offset);
                offset += 4 + extSize;
              }
            }

            function decodeId3Text(buf) {
              if (!buf || buf.length <= 1) return '';
              const enc = buf[0];
              const data = buf.subarray(1);
              if (enc === 0) return data.toString('latin1').replace(/\0+$/, '');
              if (enc === 1) {
                if (data.length >= 2 && data[0] === 0xfe && data[1] === 0xff) {
                  return data.swap16().toString('utf16le').replace(/\0+$/, '');
                }
                return data.toString('utf16le').replace(/\0+$/, '');
              }
              if (enc === 2) {
                return data.swap16().toString('utf16le').replace(/\0+$/, '');
              }
              if (enc === 3) return data.toString('utf8').replace(/\0+$/, '');
              return data.toString('utf8').replace(/\0+$/, '');
            }

            while (offset + 10 <= tagBuf.length) {
              if (tagBuf[offset] === 0) break;
              const frameId = tagBuf.toString('latin1', offset, offset + 4);
              if (!/^[A-Z0-9]{4}$/.test(frameId)) break;
              let frameSize = 0;
              if (id3Version === 4) {
                frameSize = (tagBuf[offset + 4] << 21) | (tagBuf[offset + 5] << 14) | (tagBuf[offset + 6] << 7) | tagBuf[offset + 7];
              } else {
                frameSize = tagBuf.readUInt32BE(offset + 4);
              }
              offset += 10;
              if (frameSize <= 0 || offset + frameSize > tagBuf.length) break;

              const frameData = tagBuf.subarray(offset, offset + frameSize);
              if (frameId === 'TIT2' && !title) {
                title = decodeId3Text(frameData).trim();
              } else if (frameId === 'TPE1' && !artist) {
                artist = decodeId3Text(frameData).trim();
              } else if (frameId === 'TPE2' && !artist) {
                artist = decodeId3Text(frameData).trim();
              } else if (frameId === 'TALB' && !album) {
                album = decodeId3Text(frameData).trim();
              } else if (frameId === 'TRCK' && !trackNum) {
                const val = decodeId3Text(frameData).trim();
                const n = parseInt(val.split('/')[0], 10);
                if (!isNaN(n)) trackNum = n;
              } else if (frameId === 'TLEN' && !duration) {
                const ms = parseInt(decodeId3Text(frameData).trim(), 10);
                if (!isNaN(ms) && ms > 0) duration = ms / 1000;
              } else if (frameId === 'APIC' && !fs.existsSync(coverOut)) {
                try {
                  const enc = frameData[0];
                  let p = 1;
                  while (p < frameData.length && frameData[p] !== 0) p++;
                  p++;
                  p++;
                  if (enc === 1 || enc === 2) {
                    while (p + 1 < frameData.length && !(frameData[p] === 0 && frameData[p + 1] === 0)) p += 2;
                    p += 2;
                  } else {
                    while (p < frameData.length && frameData[p] !== 0) p++;
                    p++;
                  }
                  if (p < frameData.length) {
                    const imgBuf = frameData.subarray(p);
                    if (imgBuf.length > 32) {
                      fs.writeFileSync(coverOut, imgBuf);
                    }
                  }
                } catch (e) {}
              }
              offset += frameSize;
            }
          } else if (bytesRead >= 4 && header.subarray(0, 4).toString('latin1') === 'fLaC') {
            let pos = 4;
            let isLast = false;
            while (!isLast) {
              const blkHeader = Buffer.alloc(4);
              if (fs.readSync(fd, blkHeader, 0, 4, pos) < 4) break;
              pos += 4;
              isLast = (blkHeader[0] & 0x80) !== 0;
              const blockType = blkHeader[0] & 0x7F;
              const blockLength = (blkHeader[1] << 16) | (blkHeader[2] << 8) | blkHeader[3];

              if (blockType === 0 && blockLength >= 18) {
                const sBuf = Buffer.alloc(Math.min(blockLength, 34));
                fs.readSync(fd, sBuf, 0, sBuf.length, pos);
                const sampleRate = (sBuf[10] << 12) | (sBuf[11] << 4) | (sBuf[12] >> 4);
                const totalSamples = ((sBuf[13] & 0x0f) * 0x100000000) +
                  (sBuf[14] << 24 >>> 0) + (sBuf[15] << 16) + (sBuf[16] << 8) + sBuf[17];
                if (sampleRate > 0 && totalSamples > 0 && !duration) {
                  duration = totalSamples / sampleRate;
                }
              } else if (blockType === 4) {
                const vBuf = Buffer.alloc(Math.min(blockLength, 1024 * 1024));
                fs.readSync(fd, vBuf, 0, vBuf.length, pos);
                let vPos = 0;
                if (vPos + 4 <= vBuf.length) {
                  const vendorLen = vBuf.readUInt32LE(vPos);
                  vPos += 4 + vendorLen;
                  if (vPos + 4 <= vBuf.length) {
                    const count = vBuf.readUInt32LE(vPos);
                    vPos += 4;
                    for (let i = 0; i < count && vPos + 4 <= vBuf.length; i++) {
                      const commentLen = vBuf.readUInt32LE(vPos);
                      vPos += 4;
                      if (vPos + commentLen > vBuf.length) break;
                      const comment = vBuf.toString('utf8', vPos, vPos + commentLen);
                      vPos += commentLen;
                      const eq = comment.indexOf('=');
                      if (eq > 0) {
                        const key = comment.slice(0, eq).toUpperCase();
                        const val = comment.slice(eq + 1).trim();
                        if (key === 'TITLE' && !title) title = val;
                        else if (key === 'ARTIST' && !artist) artist = val;
                        else if (key === 'ALBUM' && !album) album = val;
                        else if (key === 'TRACKNUMBER' && !trackNum) {
                          const n = parseInt(val.split('/')[0], 10);
                          if (!isNaN(n)) trackNum = n;
                        }
                      }
                    }
                  }
                }
              } else if (blockType === 6 && !fs.existsSync(coverOut)) {
                try {
                  const pBuf = Buffer.alloc(Math.min(blockLength, 12 * 1024 * 1024));
                  fs.readSync(fd, pBuf, 0, pBuf.length, pos);
                  let pPos = 4;
                  const mimeLen = pBuf.readUInt32BE(pPos);
                  pPos += 4 + mimeLen;
                  const descLen = pBuf.readUInt32BE(pPos);
                  pPos += 4 + descLen + 16;
                  const picLen = pBuf.readUInt32BE(pPos);
                  pPos += 4;
                  if (picLen > 0 && pPos + picLen <= pBuf.length) {
                    fs.writeFileSync(coverOut, pBuf.subarray(pPos, pPos + picLen));
                  }
                } catch (e) {}
              }
              pos += blockLength;
            }
          }
        } catch (e) {
        } finally {
          if (fd !== null) {
            try { fs.closeSync(fd); } catch (e) {}
          }
        }

        const platform = require('../shared/platform');
        const ffprobeBin = platform.resolveBinary('ffprobe');
        const ffmpegBin = platform.resolveBinary('ffmpeg');

        if ((!title || !artist || !duration) && ffprobeBin) {
          await new Promise(resolve => {
            execFile(ffprobeBin, [
              '-v', 'quiet',
              '-print_format', 'json',
              '-show_format',
              '-show_streams',
              filePath
            ], { timeout: 5000 }, (err, stdout) => {
              if (!err && stdout) {
                try {
                  const info = JSON.parse(stdout);
                  const tags = (info.format && info.format.tags) || {};
                  const getTag = (name) => {
                    const k = Object.keys(tags).find(x => x.toLowerCase() === name.toLowerCase());
                    return k ? String(tags[k]).trim() : '';
                  };
                  if (!title) title = getTag('title');
                  if (!artist) artist = getTag('artist') || getTag('album_artist') || getTag('composer');
                  if (!album) album = getTag('album');
                  if (!trackNum) {
                    const trk = getTag('track');
                    const n = parseInt(trk.split('/')[0], 10);
                    if (!isNaN(n)) trackNum = n;
                  }
                  if (!duration && info.format && info.format.duration) {
                    const d = parseFloat(info.format.duration);
                    if (!isNaN(d) && d > 0) duration = d;
                  }
                } catch (e) {}
              }
              resolve();
            });
          });
        }

        if (!fs.existsSync(coverOut) && ffmpegBin) {
          await new Promise(resolve => {
            execFile(ffmpegBin, [
              '-y',
              '-i', filePath,
              '-an',
              '-vcodec', 'mjpeg',
              '-frames:v', '1',
              coverOut
            ], { timeout: 5000 }, () => resolve());
          });
        }

        const ext = path.extname(filePath);
        const base = path.basename(filePath, ext);
        if (!title) {
          if (base.includes(' - ')) {
            const parts = base.split(' - ');
            if (!artist) artist = parts[0].trim();
            title = parts.slice(1).join(' - ').trim();
          } else {
            title = base.trim();
          }
        }
        if (!artist) {
          artist = 'Unknown Artist';
        }

        return {
          id: 'local_' + fileHash,
          title,
          artist: artist || 'Unknown Artist',
          album: album || '',
          trackNumber: trackNum || 0,
          duration: Math.round(duration || 0),
          path: filePath,
          url: url.pathToFileURL(filePath).toString(),
          thumbnail: fs.existsSync(coverOut) ? url.pathToFileURL(coverOut).toString() : '',
          cover: fs.existsSync(coverOut) ? url.pathToFileURL(coverOut).toString() : '',
          platform: 'local'
        };
      }

      ipcMain.handle('pick-local-files', async () => {
        const r = await dialog.showOpenDialog(mainWindow, {
          properties: ['openFile', 'multiSelections'],
          filters: [{ name: 'Audio', extensions: ['mp3', 'flac', 'wav', 'ogg', 'm4a', 'aac', 'opus', 'wma'] }]
        });
        if (r.canceled || !r.filePaths) return [];
        const tracks = [];
        for (const fp of r.filePaths) {
          try {
            const meta = await extractLocalTrackMetadata(fp);
            if (meta) tracks.push(meta);
          } catch (e) {}
        }
        return tracks;
      });

      ipcMain.handle('pick-local-folder', async () => {
        const r = await dialog.showOpenDialog(mainWindow, {
          properties: ['openDirectory', 'multiSelections']
        });
        if (r.canceled || !r.filePaths) return [];
        const AUDIO_EXT = new Set(['.mp3', '.flac', '.wav', '.ogg', '.m4a', '.aac', '.opus', '.wma']);
        const sources = [];

        function scanDir(dir) {
          try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
              const fullPath = path.join(dir, entry.name);
              if (entry.isDirectory()) {
                scanDir(fullPath);
              } else if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase();
                if (AUDIO_EXT.has(ext)) {
                  sources.push(fullPath);
                }
              }
            }
          } catch (e) {}
        }

        for (const dir of r.filePaths) {
          scanDir(dir);
        }

        const tracks = [];
        for (const fp of sources) {
          try {
            const meta = await extractLocalTrackMetadata(fp);
            if (meta) tracks.push(meta);
          } catch (e) {}
        }
        return tracks;
      });

      ipcMain.handle('rescan-local-metadata', async (event, paths) => {
        if (!Array.isArray(paths)) return [];
        const tracks = [];
        for (const fp of paths) {
          if (!fp || typeof fp !== 'string') continue;
          try {
            if (fs.existsSync(fp)) {
              const meta = await extractLocalTrackMetadata(fp);
              if (meta) tracks.push(meta);
            }
          } catch (e) {}
        }
        return tracks;
      });

      ipcMain.handle('get-data-dir', () => {
        const platform = require('../shared/platform');
        return {
          dir: platform.DATA_DIR,
          defaultDir: platform.DEFAULT_DATA_DIR,
          isCustom: platform.DATA_DIR !== platform.DEFAULT_DATA_DIR
        };
      });

      ipcMain.handle('pick-data-dir', async () => {
        const platform = require('../shared/platform');
        const r = await dialog.showOpenDialog(mainWindow, {
          title: 'Choose music folder',
          defaultPath: platform.DATA_DIR,
          properties: ['openDirectory', 'createDirectory']
        });
        return r.canceled ? null : r.filePaths[0];
      });

      ipcMain.handle('set-data-dir', async (event, payload) => {
        const platform = require('../shared/platform');
        const target = payload && payload.dir ? path.resolve(String(payload.dir)) : null;
        const move = !!(payload && payload.move);
        if (!target) return { ok: false, error: 'No folder selected' };

        const current = path.resolve(platform.DATA_DIR);
        if (target === current) return { ok: true, dir: target, moved: false };

        const rel = path.relative(current, target);
        const insideCurrent = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
        const relBack = path.relative(target, current);
        const currentInsideTarget = relBack === '' || (!relBack.startsWith('..') && !path.isAbsolute(relBack));
        if (insideCurrent || currentInsideTarget) {
          return { ok: false, error: 'Choose a folder outside the current music folder' };
        }

        try {
          fs.mkdirSync(target, { recursive: true });
          fs.accessSync(target, fs.constants.W_OK);
        } catch (e) {
          return { ok: false, error: 'That folder is not writable' };
        }

        if (move) {
          try {
            await platform.copyDirContents(current, target);
          } catch (e) {
            return { ok: false, error: 'Could not move files: ' + e.message };
          }
        }

        platform.setDataDir(target);

        if (move) {
          try { await platform.removeDirContents(current); } catch (e) {}
        }

        return { ok: true, dir: target, moved: move };
      });

      const defaultDownloadsDir = () => {
        try { return app.getPath('downloads'); } catch (e) { return null; }
      };

      ipcMain.handle('get-download-dir', () => {
        const platform = require('../shared/platform');
        const def = defaultDownloadsDir();
        const custom = platform.resolveDownloadDir();
        return {
          dir: custom || def,
          defaultDir: def,
          isCustom: !!custom
        };
      });

      ipcMain.handle('pick-download-dir', async () => {
        const platform = require('../shared/platform');
        const r = await dialog.showOpenDialog(mainWindow, {
          title: 'Choose download folder',
          defaultPath: platform.resolveDownloadDir() || defaultDownloadsDir() || undefined,
          properties: ['openDirectory', 'createDirectory']
        });
        return r.canceled ? null : r.filePaths[0];
      });

      ipcMain.handle('set-download-dir', async (event, payload) => {
        const platform = require('../shared/platform');
        const reset = !!(payload && payload.reset);
        if (reset) {
          platform.setDownloadDir(null);
          return { ok: true, dir: defaultDownloadsDir(), reset: true };
        }
        const target = payload && payload.dir ? path.resolve(String(payload.dir)) : null;
        if (!target) return { ok: false, error: 'No folder selected' };
        try {
          fs.mkdirSync(target, { recursive: true });
          fs.accessSync(target, fs.constants.W_OK);
        } catch (e) {
          return { ok: false, error: 'That folder is not writable' };
        }
        platform.setDownloadDir(target);
        return { ok: true, dir: target };
      });

      ipcMain.on('restart-app', () => {
        if (storageFlushTimer) {
          clearTimeout(storageFlushTimer);
          storageFlushTimer = null;
        }
        if (latestStorageSnapshot) {
          writeStorageDiskSync(latestStorageSnapshot);
        }
        app.relaunch();
        app.exit(0);
      });

      ipcMain.on('set-tray-on-close', (e, v) => {
        trayOnClose = !!v;
      });

      ipcMain.handle('get-multi-instance', () => !!readStartupConfig().multiInstance);
      ipcMain.on('set-multi-instance', (e, value) => { writeStartupConfig({ multiInstance: !!value }); });

      const MEDIA_KEYS = { MediaPlayPause: 'toggle', MediaNextTrack: 'next', MediaPreviousTrack: 'prev', MediaStop: 'stop' };
      let mediaKeysWanted = true;
      let mediaKeysActive = false;
      const sendMedia = (cmd) => {
        if (process.env.RIFF_DEBUG === '1') console.log('[media] globalShortcut', cmd);
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('media-command', cmd);
      };
      function unregisterMediaKeys() {
        for (const k of Object.keys(MEDIA_KEYS)) {
          try { globalShortcut.unregister(k); } catch (e) {}
        }
      }
      function registerMediaKeys() {
        if (process.platform !== 'win32') return;
        unregisterMediaKeys();
        if (!mediaKeysWanted || !mediaKeysActive) return;
        for (const [k, cmd] of Object.entries(MEDIA_KEYS)) {
          try {
            if (!globalShortcut.register(k, () => sendMedia(cmd))) {
              console.warn('[media] could not register', k);
            }
          } catch (e) {}
        }
      }
      ipcMain.on('set-media-keys', (e, enabled) => { mediaKeysWanted = !!enabled; registerMediaKeys(); });
      ipcMain.on('media-keys-active', () => { if (!mediaKeysActive) { mediaKeysActive = true; registerMediaKeys(); } });
      powerMonitor.on('resume', registerMediaKeys);
      powerMonitor.on('unlock-screen', registerMediaKeys);
      app.on('will-quit', () => {
        try {
          globalShortcut.unregister('MediaPlayPause');
          globalShortcut.unregister('MediaNextTrack');
          globalShortcut.unregister('MediaPreviousTrack');
        } catch (e) {}
        globalShortcut.unregisterAll();
      });

      let preMiniLyricsH = null;
      ipcMain.removeHandler('toggle-mini-window');
      ipcMain.handle('toggle-mini-window', () => {
        if (!mainWindow || mainWindow.isDestroyed()) return false;
        if (!isMiniWindow) {
          isMiniWindow = true;
          preMiniBounds = mainWindow.isMaximized() ? mainWindow.getNormalBounds() : mainWindow.getBounds();
          if (mainWindow.isMaximized()) mainWindow.unmaximize();
          mainWindow.setMinimumSize(280, 115);
          mainWindow.setSize(380, 160);
          mainWindow.setAlwaysOnTop(true);
          return true;
        } else {
          isMiniWindow = false;
          preMiniLyricsH = null;
          mainWindow.setAlwaysOnTop(false);
          mainWindow.setMinimumSize(800, 540);
          if (preMiniBounds) {
            mainWindow.setBounds(clampBoundsToDisplay(preMiniBounds));
          } else {
            mainWindow.setSize(1000, 700);
          }
          return false;
        }
      });

      ipcMain.removeHandler('set-mini-lyrics');
      ipcMain.handle('set-mini-lyrics', (e, enabled) => {
        if (!mainWindow || mainWindow.isDestroyed() || !isMiniWindow) return false;
        const bounds = mainWindow.getBounds();
        const display = screen.getDisplayMatching(bounds);
        const maxH = Math.floor(display.workArea.height * 0.9);
        if (enabled) {
          if (!preMiniLyricsH) preMiniLyricsH = bounds.height;
          mainWindow.setMinimumSize(320, 240);
          const targetH = Math.min(Math.max(bounds.height, 360), maxH);
          if (bounds.y + targetH > display.workArea.y + display.workArea.height) {
            const newY = Math.max(display.workArea.y, display.workArea.y + display.workArea.height - targetH);
            mainWindow.setBounds({ x: bounds.x, y: newY, width: bounds.width, height: targetH });
          } else {
            mainWindow.setSize(bounds.width, targetH);
          }
        } else {
          mainWindow.setMinimumSize(320, 140);
          const targetH = preMiniLyricsH || 160;
          mainWindow.setSize(bounds.width, targetH);
          preMiniLyricsH = null;
        }
        return true;
      });

      ipcMain.handle('get-app-version', () => app.getVersion());

      ipcMain.handle('save-playlists-json', async (event, payload) => {
        const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
        const defaultName = payload && payload.defaultName ? payload.defaultName : 'playlists.json';
        const content = payload && payload.content ? payload.content : '';
        const r = await dialog.showSaveDialog(win, {
          title: 'Export playlists as JSON',
          defaultPath: defaultName,
          filters: [{ name: 'JSON', extensions: ['json'] }]
        });
        if (r.canceled || !r.filePath) return { canceled: true };
        await fs.promises.writeFile(r.filePath, content, 'utf8');
        return { success: true, filePath: r.filePath };
      });

      ipcMain.handle('account-export', async (event, payload) => {
        try {
          const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
          const r = await dialog.showSaveDialog(win, {
            title: 'Export Eclipse account',
            defaultPath: 'eclipse-account.rfacc',
            filters: [{ name: 'Eclipse Account (.rfacc)', extensions: ['rfacc'] }]
          });
          if (r.canceled || !r.filePath) return { canceled: true };
          const buffer = encryptAccount(payload || {});
          await fs.promises.writeFile(r.filePath, buffer);
          return { success: true, filePath: r.filePath };
        } catch (err) {
          return { success: false, error: err.message };
        }
      });

      ipcMain.handle('account-import', async (event) => {
        try {
          const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
          const r = await dialog.showOpenDialog(win, {
            title: 'Import Eclipse account',
            properties: ['openFile'],
            filters: [{ name: 'Eclipse Account (.rfacc)', extensions: ['rfacc'] }]
          });
          if (r.canceled || !r.filePaths || !r.filePaths.length) return { canceled: true };
          const buffer = await fs.promises.readFile(r.filePaths[0]);
          const data = decryptAccount(buffer);
          return { success: true, data, filePath: r.filePaths[0] };
        } catch (err) {
          return { success: false, error: err.message };
        }
      });

      ipcMain.handle('show-playlist-context-menu', async (event) => {
        const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
        return new Promise((resolve) => {
          const menu = Menu.buildFromTemplate([
            {
              label: 'Export as JSON',
              click: () => resolve('export')
            }
          ]);
          menu.popup({
            window: win,
            callback: () => resolve(null)
          });
        });
      });

      const YT_LOGOUT_FLAG = path.join(DATA_DIR, '.yt-logged-out');
      const GOOGLE_OAUTH_FILE = path.join(DATA_DIR, 'google-oauth.enc');
      let youtubeCookieImportPromise = null;

      function readGoogleOAuthData() {
        if (!fs.existsSync(GOOGLE_OAUTH_FILE)) return null;
        if (!safeStorage.isEncryptionAvailable()) return null;
        return JSON.parse(safeStorage.decryptString(fs.readFileSync(GOOGLE_OAUTH_FILE)));
      }

      function writeGoogleOAuthData(data) {
        if (!safeStorage.isEncryptionAvailable()) {
          throw new Error('Secure storage is unavailable on this system');
        }
        fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
        const tmpPath = `${GOOGLE_OAUTH_FILE}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`;
        try {
          fs.writeFileSync(tmpPath, safeStorage.encryptString(JSON.stringify(data)), { mode: 0o600 });
          fs.renameSync(tmpPath, GOOGLE_OAUTH_FILE);
        } finally {
          try {
            if (fs.existsSync(tmpPath)) {
              fs.unlinkSync(tmpPath);
            }
          } catch (_) {}
        }
      }

      async function getGoogleAccessToken() {
        const auth = readGoogleOAuthData();
        if (!auth || !auth.refreshToken) {
          throw new Error('Sign in to Google before importing your YouTube library');
        }
        if (auth.accessToken && auth.expiresAt > Date.now() + 60000) {
          return auth.accessToken;
        }
        const refreshed = await refreshAccessToken(auth.refreshToken);
        auth.accessToken = refreshed.access_token;
        auth.expiresAt = Date.now() + (Number(refreshed.expires_in) || 3600) * 1000;
        if (refreshed.refresh_token) auth.refreshToken = refreshed.refresh_token;
        writeGoogleOAuthData(auth);
        return auth.accessToken;
      }

      async function startGoogleOAuthLogin() {
        if (!safeStorage.isEncryptionAvailable()) {
          throw new Error('Secure storage is unavailable on this system');
        }
        const codeVerifier = createCodeVerifier();
        const state = createOAuthState();
        const server = http.createServer();
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(0, '127.0.0.1', resolve);
        });
        const address = server.address();
        const redirectUri = `http://127.0.0.1:${address.port}`;
        const authUrl = createAuthorizationUrl({
          redirectUri,
          state,
          codeChallenge: createCodeChallenge(codeVerifier)
        });
        let cancelCallback;
        try {
          const callback = new Promise((resolve, reject) => {
            let settled = false;
            const timeout = setTimeout(() => {
              finish(new Error('Google sign-in timed out. Complete the authorization in your browser and try again.'));
            }, 180000);
            const finish = (error, value) => {
              if (settled) return;
              settled = true;
              clearTimeout(timeout);
              server.removeListener('request', onRequest);
              if (error) reject(error);
              else resolve(value);
            };
            cancelCallback = () => finish(new Error('Google sign-in could not be completed'));
            const onRequest = (req, res) => {
              const isLoopback = req.socket.remoteAddress === '127.0.0.1' ||
                req.socket.remoteAddress === '::ffff:127.0.0.1';
              if (!isLoopback) {
                res.writeHead(403);
                res.end();
                return;
              }
              const requestUrl = new URL(req.url || '/', redirectUri);
              if (req.method !== 'GET' || requestUrl.pathname !== '/') {
                res.writeHead(404);
                res.end();
                return;
              }
              const returnedState = requestUrl.searchParams.get('state') || '';
              const expected = Buffer.from(state);
              const actual = Buffer.from(returnedState);
              if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
                res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('Authorization could not be verified. Return to Eclipse and try again.');
                finish(new Error('Google authorization state did not match'));
                return;
              }
              const providerError = requestUrl.searchParams.get('error');
              if (providerError) {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
                res.end('<!doctype html><title>Eclipse</title><p>Google sign-in was cancelled. You can close this tab and return to Eclipse.</p>');
                finish(new Error(providerError === 'access_denied'
                  ? 'Google sign-in was cancelled'
                  : `Google authorization failed: ${providerError}`));
                return;
              }
              const code = requestUrl.searchParams.get('code');
              if (!code) {
                res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('Google did not return an authorization code. Return to Eclipse and try again.');
                finish(new Error('Google did not return an authorization code'));
                return;
              }
              res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
              res.end('<!doctype html><title>Eclipse</title><p>Google account connected. You can close this tab and return to Eclipse.</p>');
              finish(null, { code });
            };
            server.on('request', onRequest);
          });
          await shell.openExternal(authUrl);
          const result = await callback;
          const tokens = await exchangeAuthorizationCode({
            code: result.code,
            redirectUri,
            codeVerifier
          });
          if (!tokens.refresh_token) {
            throw new Error('Google did not provide a refresh token. Revoke Eclipse access in your Google account and try again.');
          }
          writeGoogleOAuthData({
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
            expiresAt: Date.now() + (Number(tokens.expires_in) || 3600) * 1000,
            scope: tokens.scope || ''
          });
        } finally {
          if (cancelCallback) cancelCallback();
          if (server.listening) {
            await new Promise(resolve => server.close(resolve));
          }
        }
      }

      let capturedGoogleCookieHeader = '';

      function getSapisidFromCookieStr(str) {
        if (!str) return '';
        const m = String(str).match(/(?:^|;\s*)(?:SAPISID|__Secure-3PAPISID)=([^;]+)/);
        return m ? m[1].trim() : '';
      }

      function extractCandidateYtCookie(cookies) {
        if (!Array.isArray(cookies)) return null;
        const { BrowserCookieRecord, buildCookieHeader, extractSapisidCredential } = require('./browser-login/browser-cookie-record');
        const records = [];
        for (const c of cookies) {
          if (!c || !c.name || typeof c.value !== 'string' || !c.domain) continue;
          try {
            records.push(new BrowserCookieRecord({
              name: c.name,
              value: c.value,
              domain: c.domain,
              path: c.path || '/',
              secure: c.secure !== false,
              httpOnly: !!c.httpOnly,
              expiry: c.expirationDate || c.expires || null,
              hostOnly: !!c.hostOnly
            }));
          } catch (_) {}
        }
        const targetHost = 'music.youtube.com';
        const cred = extractSapisidCredential(records, targetHost, '/getAccountSwitcherEndpoint');
        if (!cred) return null;
        const cookieHeader = buildCookieHeader(records, targetHost, '/');
        if (!cookieHeader || !cookieHeader.includes(`${cred.name}=${cred.value}`)) return null;
        return {
          candidateName: cred.name,
          candidateValue: cred.value,
          sapisidCredential: cred,
          cookieHeader
        };
      }

      async function verifyAndPersistYtSession(cookieStr, sessionObj) {
        if (!cookieStr || typeof cookieStr !== 'string') return false;
        if (!serverPort) {
          console.warn('[auth] Cannot verify session: backend serverPort not available');
          return false;
        }
        try {
          const res = await fetch(`http://127.0.0.1:${serverPort}/api/ytm/intercept-cookie`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cookie: cookieStr }),
            signal: AbortSignal.timeout(15000)
          });
          if (!res.ok) {
            console.warn(`[auth] intercept-cookie returned HTTP ${res.status}`);
            return false;
          }
          const body = await res.json().catch(() => null);
          if (!body || !body.success || !body.account) {
            console.warn('[auth] intercept-cookie returned unauthenticated profile:', body && body.error);
            return false;
          }
          capturedGoogleCookieHeader = cookieStr;
          try { if (fs.existsSync(YT_LOGOUT_FLAG)) fs.unlinkSync(YT_LOGOUT_FLAG); } catch (_) {}
          return true;
        } catch (err) {
          console.warn('[auth] verifyAndPersistYtSession network/timeout error:', err && err.message);
          return false;
        }
      }

      ipcMain.handle('google-import-cookie-text', async (event, cookieText) => {
        try {
          if (!cookieText || typeof cookieText !== 'string' || !cookieText.trim()) {
            return { success: false, error: 'Cookie content is empty' };
          }
          const raw = cookieText.trim();
          const parsedCookies = [];
          const netscapeLines = ['# Netscape HTTP Cookie File', '# Created by Eclipse', ''];
          let candidateFound = false;

          let parsedJson = null;
          if (raw.startsWith('[') || raw.startsWith('{')) {
            try {
              const data = JSON.parse(raw);
              parsedJson = Array.isArray(data) ? data : (Array.isArray(data.cookies) ? data.cookies : null);
            } catch (_) {}
          }

          if (parsedJson && Array.isArray(parsedJson)) {
            for (const item of parsedJson) {
              if (!item || typeof item !== 'object') continue;
              const name = String(item.name || '').trim();
              const val = String(item.value != null ? item.value : '').trim();
              if (!name || !val) continue;
              if (name === 'SAPISID' || name === '__Secure-3PAPISID') candidateFound = true;

              let domain = String(item.domain || '.youtube.com').trim();
              if (!domain.startsWith('.') && !domain.includes('localhost') && domain.includes('.')) {
                domain = '.' + domain;
              }
              const cookiePath = String(item.path || '/');
              const host = domain.replace(/^\./, '');
              const secure = item.secure !== false;
              const httpOnly = item.httpOnly === true;
              const expiration = Number(item.expirationDate || item.expires || 0);

              const details = {
                url: `https://${host}${cookiePath.startsWith('/') ? cookiePath : '/'}`,
                name,
                value: val,
                domain,
                path: cookiePath.startsWith('/') ? cookiePath : '/',
                secure,
                httpOnly
              };
              if (Number.isFinite(expiration) && expiration > 0) details.expirationDate = Math.floor(expiration);
              parsedCookies.push(details);
              netscapeLines.push(`${httpOnly ? '#HttpOnly_' : ''}${domain}\tTRUE\t${details.path}\t${secure ? 'TRUE' : 'FALSE'}\t${details.expirationDate || 2147483647}\t${name}\t${val}`);
            }
          } else if (raw.includes('\t') && (raw.includes('youtube.com') || raw.includes('google.com') || raw.includes('#HttpOnly'))) {
            const rows = raw.split(/\r?\n/);
            for (const row of rows) {
              const line = row.startsWith('#HttpOnly_') ? row.slice(10) : row;
              if (!line || line.startsWith('#')) continue;
              const fields = line.split('\t');
              if (fields.length < 7) continue;
              const [domain, , cookiePath, secure, expires, name, ...valueParts] = fields;
              if (!domain || !name || valueParts.length === 0) continue;
              const val = valueParts.join('\t');
              if (name === 'SAPISID' || name === '__Secure-3PAPISID') candidateFound = true;
              const host = domain.replace(/^\./, '');
              const details = {
                url: `https://${host}${cookiePath.startsWith('/') ? cookiePath : '/'}`,
                name,
                value: val,
                domain,
                path: cookiePath || '/',
                secure: secure.toUpperCase() === 'TRUE',
                httpOnly: row.startsWith('#HttpOnly_')
              };
              const expiration = Number(expires);
              if (Number.isFinite(expiration) && expiration > 0) details.expirationDate = expiration;
              parsedCookies.push(details);
              netscapeLines.push(`${details.httpOnly ? '#HttpOnly_' : ''}${domain}\tTRUE\t${details.path}\t${details.secure ? 'TRUE' : 'FALSE'}\t${details.expirationDate || 2147483647}\t${name}\t${val}`);
            }
          } else {
            const pairs = raw.split(';');
            const now = Math.floor(Date.now() / 1000) + 31536000;
            for (const pair of pairs) {
              const eq = pair.indexOf('=');
              if (eq <= 0) continue;
              const name = pair.slice(0, eq).trim();
              const val = pair.slice(eq + 1).trim();
              if (!name || !val) continue;
              if (name === 'SAPISID' || name === '__Secure-3PAPISID') candidateFound = true;
              for (const domain of ['.youtube.com', '.google.com']) {
                parsedCookies.push({
                  url: `https://${domain.replace(/^\./, '')}/`,
                  name,
                  value: val,
                  domain,
                  path: '/',
                  secure: true,
                  expirationDate: now
                });
                netscapeLines.push(`${domain}\tTRUE\t/\tTRUE\t${now}\t${name}\t${val}`);
              }
            }
          }

          if (!candidateFound) {
            return { success: false, error: 'Could not find SAPISID or __Secure-3PAPISID in the provided cookie. Make sure you copied cookies from YouTube or YouTube Music while logged in.' };
          }

          const cookieHeaderStr = parsedCookies
            .filter(c => c.name && c.value && c.domain && (c.domain.includes('youtube.com') || c.domain.includes('google.com')))
            .map(c => `${c.name}=${c.value}`)
            .join('; ');

          if (!serverPort) {
            return { success: false, error: 'Cannot authenticate: YouTube Music backend service is not running or available' };
          }

          const res = await fetch(`http://127.0.0.1:${serverPort}/api/ytm/intercept-cookie`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cookie: cookieHeaderStr }),
            signal: AbortSignal.timeout(15000)
          }).catch((fetchErr) => {
            console.warn('[auth] intercept-cookie network failure:', fetchErr?.message || fetchErr);
            return null;
          });

          if (!res || !res.ok) {
            return { success: false, error: 'YouTube Music authentication server rejected the imported cookies or timed out' };
          }
          const body = await res.json().catch(() => null);
          if (!body || !body.success || !body.account) {
            return { success: false, error: (body && body.error) || 'Failed to authenticate YouTube Music profile with imported cookies' };
          }

          const googleSession = session.fromPartition('persist:eclipse-google');
          await googleSession.clearStorageData({ storages: ['cookies'] });

          for (const details of parsedCookies) {
            const setDetails = { ...details };
            if (setDetails.name.startsWith('__Host-')) delete setDetails.domain;
            await googleSession.cookies.set(setDetails).catch(() => {});
          }

          capturedGoogleCookieHeader = cookieHeaderStr;
          fs.mkdirSync(DATA_DIR, { recursive: true });
          // persistent YT_COOKIES_FILE eliminated
          try { if (fs.existsSync(YT_LOGOUT_FLAG)) fs.unlinkSync(YT_LOGOUT_FLAG); } catch (_) {}

          return { success: true, loggedIn: true };
        } catch (err) {
          return { success: false, error: err && err.message ? err.message : 'Failed to import cookie' };
        }
      });

      const browserLoginService = new BrowserLoginService({
        ytmAuthUrl: `http://127.0.0.1:${serverPort || 38472}/api/ytm/intercept-cookie`
      });

      ipcMain.handle('browser-login:get-profiles', async () => {
        try {
          return { success: true, profiles: await browserLoginService.getProfiles(BrowserLoginTarget.YOUTUBE) };
        } catch (err) {
          return { success: false, error: err.message, profiles: [] };
        }
      });

      ipcMain.handle('browser-login:start-pairing', async (event) => {
        try {
          const sender = event.sender;
          browserLoginService.ytmAuthUrl = `http://127.0.0.1:${serverPort || 38472}/api/ytm/intercept-cookie`;
          const sessionInfo = await browserLoginService.startPairingSession(
            (authResult) => {
              try {
                try { if (fs.existsSync(YT_LOGOUT_FLAG)) fs.unlinkSync(YT_LOGOUT_FLAG); } catch (_) {}
                if (sender && !sender.isDestroyed()) {
                  sender.send('browser-login:pairing-result', { success: true, account: authResult.account });
                } else if (mainWindow && !mainWindow.isDestroyed()) {
                  mainWindow.webContents.send('browser-login:pairing-result', { success: true, account: authResult.account });
                }
              } catch (_) {}
            },
            (err) => {
              try {
                if (sender && !sender.isDestroyed()) {
                  sender.send('browser-login:pairing-result', { success: false, error: err.message, reason: err.reason, details: err.details || null });
                } else if (mainWindow && !mainWindow.isDestroyed()) {
                  mainWindow.webContents.send('browser-login:pairing-result', { success: false, error: err.message, reason: err.reason, details: err.details || null });
                }
              } catch (_) {}
            }
          );
          return { success: true, ...sessionInfo };
        } catch (err) {
          return { success: false, error: err.message };
        }
      });

      ipcMain.handle('browser-login:cancel-pairing', async () => {
        browserLoginService.cancelPairingSession();
        return { success: true };
      });

      ipcMain.handle('browser-login:confirm-candidate', async (event, { pendingToken, candidateIndex }) => {
        try {
          const authUrl = `http://127.0.0.1:${serverPort || 38472}/api/ytm/confirm-candidate`;
          const res = await fetch(authUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pendingToken, candidateIndex }),
            signal: AbortSignal.timeout(15000)
          });
          const data = await res.json();
          if (!res.ok || !data.success) {
            return { success: false, error: data.error || ('HTTP ' + res.status) };
          }
          try { if (fs.existsSync(YT_LOGOUT_FLAG)) fs.unlinkSync(YT_LOGOUT_FLAG); } catch (_) {}
          return { success: true, account: data.account };
        } catch (err) {
          return { success: false, error: err.message };
        }
      });

      ipcMain.handle('browser-login:import-profile', async (event, profile) => {
        try {
          if (!profile || !profile.profilePath) {
            return { success: false, error: 'Invalid browser profile parameter' };
          }
          browserLoginService.ytmAuthUrl = `http://127.0.0.1:${serverPort || 38472}/api/ytm/intercept-cookie`;
          const authResult = await browserLoginService.importFromGeckoProfile(profile.profilePath);
          try { if (fs.existsSync(YT_LOGOUT_FLAG)) fs.unlinkSync(YT_LOGOUT_FLAG); } catch (_) {}
          return { success: true, account: authResult.account };
        } catch (err) {
          return { success: false, error: err.message, reason: err.reason, details: err.details || null };
        }
      });

      function resolveExtensionZipPath() {
        const candidates = [
          path.join(process.resourcesPath || '', 'extension', 'eclipse-connect.zip'),
          path.join(app.getAppPath(), 'dist', 'extension', 'eclipse-connect.zip'),
          path.join(__dirname, '..', '..', 'dist', 'extension', 'eclipse-connect.zip')
        ];
        let zipPath = candidates.find(c => c && fs.existsSync(c));
        if (!zipPath) {
          try {
            const { buildExtensionZip } = require('../../scripts/build-extension');
            zipPath = buildExtensionZip();
          } catch (_) {}
        }
        return zipPath || null;
      }

      const browserExtensionManager = createBrowserExtensionManager({
        fs,
        path,
        os,
        spawn,
        execFileSync,
        dialog,
        shell,
        app,
        BrowserWindow,
        getExtensionZipPath: resolveExtensionZipPath,
        processPlatform: process.platform,
        env: process.env
      });

      ipcMain.handle('browser-login:open-extension-manager', async (event, browser) => {
        return browserExtensionManager.openExtensionManager(browser);
      });

      ipcMain.handle('browser-login:export-extension', async (event) => {
        return browserExtensionManager.exportExtension(event, mainWindow);
      });

      ipcMain.handle('browser-login:reveal-exported-extension', async () => {
        return browserExtensionManager.revealExportedExtension();
      });

      function isValidMainWindowIpcSender(event) {
        if (!event || !mainWindow || mainWindow.isDestroyed()) return false;
        const wc = mainWindow.webContents;
        if (!wc || wc.isDestroyed()) return false;
        if (event.sender !== wc) return false;
        const frame = event.senderFrame;
        if (!frame || frame !== wc.mainFrame) return false;
        return true;
      }

      function sanitizeExternalSessionStatus(status) {
        const s = status && typeof status === 'object' ? status : {};
        return {
          connected: Boolean(s.connected),
          displayName: typeof s.displayName === 'string' ? s.displayName : null,
          avatarUrl: typeof s.avatarUrl === 'string' ? s.avatarUrl : null,
          connectionMethod: typeof s.connectionMethod === 'string' ? s.connectionMethod : null,
          authType: typeof s.authType === 'string' ? s.authType : null,
          lastVerifiedAt: Number.isFinite(s.lastVerifiedAt) ? s.lastVerifiedAt : null,
          sessionStatus: typeof s.sessionStatus === 'string' ? s.sessionStatus : 'SIGNED_OUT',
          webSessionStatus: typeof s.webSessionStatus === 'string' ? s.webSessionStatus : null,
          persisted: Boolean(s.persisted),
          storageWarning: typeof s.storageWarning === 'string' ? s.storageWarning : null
        };
      }

      function emitExternalSessionResult(payload) {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        const wc = mainWindow.webContents;
        if (!wc || wc.isDestroyed()) return;
        wc.send('external-session:pairing-result', payload);
      }

      const externalVaultPath = path.join(app.getPath('userData'), 'external-session.vault.json');
      let activeExternalOpId = null;
      const externalSessionService = new ExternalSessionService({
        isPackaged: app.isPackaged,
        vaultPath: externalVaultPath,
        safeStorage,
        openExternal: (targetUrl) => shell.openExternal(targetUrl),
        onStateChange: (status) => {
          const safeStatus = sanitizeExternalSessionStatus(status);
          emitExternalSessionResult({
            operationId: activeExternalOpId,
            success: safeStatus.connected,
            webSessionUnverified: safeStatus.webSessionStatus === 'spotify_web_session_unverified',
            method: safeStatus.connectionMethod === 'pkce'
              ? 'pkce'
              : (safeStatus.connectionMethod === 'extension_pairing' ? 'bridge' : safeStatus.connectionMethod),
            status: safeStatus
          });
        }
      });
      externalSessionService.initialize().catch(() => {});

      ipcMain.handle('external-session:start-pkce', async (event, opts = {}) => {
        if (!isValidMainWindowIpcSender(event)) {
          return { success: false, error: 'Unauthorized IPC sender' };
        }
        const clientId = opts && typeof opts.clientId === 'string' ? opts.clientId.trim() : '';
        if (!/^[a-f0-9]{32}$/i.test(clientId)) {
          return {
            success: false,
            canceled: false,
            code: 'PKCE_CLIENT_ID_MISSING',
            error: 'Missing or invalid Spotify Client ID. Enter your 32-character hex Client ID in Settings before connecting.'
          };
        }
        activeExternalOpId = opts && opts.operationId !== undefined ? opts.operationId : null;
        try {
          const status = sanitizeExternalSessionStatus(await externalSessionService.startPkceLogin({ ...(opts || {}), clientId }));
          return { success: status.connected, status };
        } catch (err) {
          const msg = err && err.message ? err.message : 'PKCE authorization failed';
          const canceled = Boolean(err && (err.code === 'PKCE_CANCELLED' || /cancel/i.test(msg)));
          return { success: false, canceled, code: err && err.code ? err.code : undefined, error: msg };
        }
      });

      ipcMain.handle('external-session:start-pairing', async (event, opts = {}) => {
        if (!isValidMainWindowIpcSender(event)) {
          return { success: false, error: 'Unauthorized IPC sender' };
        }
        activeExternalOpId = opts && opts.operationId !== undefined ? opts.operationId : null;
        try {
          const sessionInfo = await externalSessionService.startPairingSession(opts || {});
          return {
            success: true,
            port: sessionInfo && sessionInfo.port ? sessionInfo.port : null,
            nonce: sessionInfo && sessionInfo.nonce ? sessionInfo.nonce : null,
            pairingCode: sessionInfo && sessionInfo.nonce ? sessionInfo.nonce : null,
            timeoutSeconds: sessionInfo && sessionInfo.timeoutSeconds ? sessionInfo.timeoutSeconds : 120
          };
        } catch (err) {
          return { success: false, error: err && err.message ? err.message : 'Failed to start pairing session' };
        }
      });

      ipcMain.handle('external-session:cancel-pairing', async (event) => {
        if (!isValidMainWindowIpcSender(event)) {
          return { success: false, error: 'Unauthorized IPC sender' };
        }
        activeExternalOpId = null;
        const status = sanitizeExternalSessionStatus(externalSessionService.cancelActiveAuth());
        return { success: true, status };
      });

      ipcMain.handle('external-session:get-status', async (event) => {
        if (!isValidMainWindowIpcSender(event)) {
          return { success: false, error: 'Unauthorized IPC sender' };
        }
        const status = sanitizeExternalSessionStatus(externalSessionService.getStatus());
        return { success: true, ...status, status };
      });

      ipcMain.handle('external-session:logout', async (event) => {
        if (!isValidMainWindowIpcSender(event)) {
          return { success: false, error: 'Unauthorized IPC sender' };
        }
        activeExternalOpId = null;
        const status = sanitizeExternalSessionStatus(externalSessionService.logout());
        return { success: true, status };
      });

      ipcMain.handle('external-session:open-login-window', async (event, opts = {}) => {
        if (!isValidMainWindowIpcSender(event)) {
          return { success: false, error: 'Unauthorized IPC sender' };
        }
        activeExternalOpId = opts && opts.operationId !== undefined ? opts.operationId : null;
        try {
          const status = sanitizeExternalSessionStatus(
            await externalSessionService.openLoginWindow({
              ...(opts && typeof opts === 'object' ? opts : {}),
              parentWindow: mainWindow
            })
          );
          const webSessionUnverified = status.webSessionStatus === 'spotify_web_session_unverified';
          return {
            success: false,
            webSessionUnverified,
            status,
            error: webSessionUnverified
              ? 'Local web session captured (unverified). Use Official OAuth PKCE to connect your external account.'
              : 'External login window did not complete.'
          };
        } catch (err) {
          const msg = err && err.message ? err.message : 'External login window failed';
          const code = err && err.code ? err.code : null;
          const canceled = Boolean(
            err && (
              code === 'LOGIN_WINDOW_CLOSED' ||
              code === 'LOGIN_WINDOW_CANCELLED' ||
              code === 'APP_EXIT' ||
              /cancel|closed/i.test(msg)
            )
          );
          return { success: false, canceled, code, error: msg };
        }
      });

      ipcMain.handle('external-session:get-profiles', async (event) => {
        if (!isValidMainWindowIpcSender(event)) {
          return { success: false, error: 'Unauthorized IPC sender', profiles: [] };
        }
        try {
          const profiles = await externalSessionService.getProfiles();
          return { success: true, profiles: Array.isArray(profiles) ? profiles : [] };
        } catch (err) {
          return { success: false, error: err && err.message ? err.message : 'Failed to discover profiles', profiles: [] };
        }
      });

      ipcMain.handle('google-auth-status', async () => {
        try {
          const auth = readGoogleOAuthData();
          const googleDataOAuth = {
            hasRefreshToken: !!(auth && typeof auth.refreshToken === 'string' && auth.refreshToken.trim())
          };

          // YouTube Music authentication status is strictly verified via backend active account
          // Never rely on unverified raw cookies or Google Data OAuth refresh tokens!
          let ytmConnected = false;
          let ytmAccount = null;

          if (serverPort) {
            try {
              const sRes = await fetch(`http://127.0.0.1:${serverPort}/api/ytm/accounts`, { signal: AbortSignal.timeout(3000) });
              if (sRes.ok) {
                const sData = await sRes.json();
                if (sData && sData.activeAccount && sData.activeAccount.id && sData.activeAccount.id !== 'unknown') {
                  ytmConnected = true;
                  ytmAccount = sData.activeAccount;
                  // If backend has verified active account, clear stale logout flag
                  try { if (fs.existsSync(YT_LOGOUT_FLAG)) fs.unlinkSync(YT_LOGOUT_FLAG); } catch (_) {}
                }
              }
            } catch (_) {
              // If backend check threw network error, respect logout flag if present
              if (fs.existsSync(YT_LOGOUT_FLAG)) {
                ytmConnected = false;
                ytmAccount = null;
              }
            }
          }

          // loggedIn is an alias of ytmConnected for backward compatibility
          return {
            loggedIn: ytmConnected,
            ytmConnected,
            ytmAccount,
            googleDataOAuth
          };
        } catch (e) {
          return {
            loggedIn: false,
            ytmConnected: false,
            ytmAccount: null,
            googleDataOAuth: { hasRefreshToken: false }
          };
        }
      });

      ipcMain.handle('google-logout', async () => {
        capturedGoogleCookieHeader = '';
        return await executeGoogleLogout({
          serverPort,
          fetchImpl: fetch,
          readOAuthData: readGoogleOAuthData,
          cleanLocalSession: async () => {
            fs.mkdirSync(DATA_DIR, { recursive: true });
            fs.writeFileSync(YT_LOGOUT_FLAG, '1', 'utf8');
            if (fs.existsSync(GOOGLE_OAUTH_FILE)) fs.unlinkSync(GOOGLE_OAUTH_FILE);
            const legacyJar = path.join(DATA_DIR, 'yt-cookies.txt'); if (fs.existsSync(legacyJar)) fs.unlinkSync(legacyJar); mainTempCookieMgr.sweepStaleCookieJars();
            const s = session.fromPartition('persist:eclipse-google');
            await s.clearStorageData();
          },
          revokeOAuthToken: async (token) => {
            await fetch('https://oauth2.googleapis.com/revoke', {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({ token }),
              signal: AbortSignal.timeout(10000)
            });
          }
        });
      });

      ipcMain.handle('google-login', async (event) => {
        const s = session.fromPartition('persist:eclipse-google');
        const loginUrl = 'https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fmusic.youtube.com%2F';

        const { spawn } = require('child_process');
        const os = require('os');
        const net = require('net');
        const candidates = [
          process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
          process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
          process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
          process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
          process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
          process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        ].filter(Boolean);
        const browserExe = candidates.find(p => { try { return fs.existsSync(p); } catch (_) { return false; } });

        if (browserExe) {
          const port = await new Promise((res) => {
            const srv = net.createServer();
            srv.listen(0, '127.0.0.1', () => {
              const p = srv.address().port;
              srv.close(() => res(p));
            });
          });
          const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eclipse-yt-login-'));
          const proc = spawn(browserExe, [
            `--remote-debugging-port=${port}`,
            '--remote-allow-origins=*',
            `--user-data-dir=${userDataDir}`,
            '--no-first-run',
            '--no-default-browser-check',
            `--app=${loginUrl}`
          ], { stdio: 'ignore' });

          return new Promise((resolve) => {
            let finished = false;
            let validating = false;
            const timeoutTimer = setTimeout(() => {
              finish(false, 'Login timed out after 120 seconds');
            }, 120000);

            const cleanup = () => {
              clearTimeout(timeoutTimer);
              clearInterval(timer);
              try { proc.kill(); } catch (_) {}
              setTimeout(() => {
                try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}
              }, 800);
            };

            const finish = async (loggedIn, err = null) => {
              if (finished) return;
              finished = true;
              cleanup();
              resolve({ success: loggedIn, loggedIn, error: err });
            };

            proc.on('exit', () => { if (!finished) finish(false); });

            const timer = setInterval(async () => {
              if (finished || validating) return;
              try {
                const targetsRes = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) });
                const targets = await targetsRes.json();
                const page = Array.isArray(targets) && (targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl) || targets[0]);
                if (!page || !page.webSocketDebuggerUrl) return;

                const WebSocket = require('ws');
                const ws = new WebSocket(page.webSocketDebuggerUrl);
                await new Promise((resWs, rejWs) => {
                  ws.addEventListener('open', () => {
                    ws.send(JSON.stringify({ id: 1, method: 'Network.getAllCookies' }));
                  });
                  ws.addEventListener('message', async (msg) => {
                    try {
                      const data = JSON.parse(String(msg.data));
                      if (data.id === 1 && data.result && Array.isArray(data.result.cookies)) {
                        const cookies = data.result.cookies;
                        const candidate = extractCandidateYtCookie(cookies);
                        if (candidate) {
                          validating = true;
                          for (const c of cookies) {
                            if (!c.domain || (!c.domain.includes('youtube.com') && !c.domain.includes('google.com'))) continue;
                            const cleanDomain = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain;
                            const url = `https://${cleanDomain}${c.path || '/'}`;
                            try {
                              const cookieObj = {
                                url,
                                name: c.name,
                                value: c.value,
                                domain: c.domain,
                                path: c.path || '/',
                                secure: !!c.secure,
                                httpOnly: !!c.httpOnly,
                                expirationDate: c.expires > 0 ? c.expires : undefined
                              };
                              if (c.name.startsWith('__Host-')) delete cookieObj.domain;
                              await s.cookies.set(cookieObj);
                            } catch (_) {}
                          }
                          ws.close();
                          const verified = await verifyAndPersistYtSession(candidate.cookieHeader, s);
                          if (verified) {
                            resWs(true);
                            await finish(true);
                            return;
                          } else {
                            validating = false;
                          }
                        }
                      }
                    } catch (_) {
                      validating = false;
                    }
                    ws.close();
                    resWs(false);
                  });
                  ws.addEventListener('error', () => rejWs(new Error('ws error')));
                }).catch(() => {});
              } catch (_) {}
            }, 1000);
          });
        }

        const cleanSessionUa = (app.userAgentFallback || s.getUserAgent() || '')
          .replace(/\s*Electron\/[^\s]+/gi, '')
          .replace(/\s*(?:riff|eclipse)\/[^\s]+/gi, '');
        if (cleanSessionUa) s.setUserAgent(cleanSessionUa);
        return new Promise((resolve) => {
          const parent = BrowserWindow.fromWebContents(event.sender) || mainWindow;
          const win = new BrowserWindow({
            width: 480,
            height: 680,
            parent: parent && !parent.isDestroyed() ? parent : undefined,
            modal: true,
            show: true,
            autoHideMenuBar: true,
            title: 'YouTube / YouTube Music Sign In',
            webPreferences: {
              partition: 'persist:eclipse-google',
              contextIsolation: true,
              nodeIntegration: false,
              sandbox: true
            }
          });
          let finished = false;
          let validating = false;

          const timeoutTimer = setTimeout(() => {
            finish(false, 'Login timed out after 120 seconds');
          }, 120000);

          const getSessionCandidateCookieHeader = async () => {
            try {
              const ytCookies = await s.cookies.get({ url: 'https://music.youtube.com' });
              return extractCandidateYtCookie(ytCookies);
            } catch (_) { return null; }
          };

          const finish = async (loggedIn, err = null) => {
            if (finished) return;
            finished = true;
            clearTimeout(timeoutTimer);
            clearInterval(timer);
            if (!win.isDestroyed()) win.close();
            resolve({ success: loggedIn, loggedIn, error: err });
          };

          const check = async () => {
            if (finished || validating || win.isDestroyed()) return;
            const url = win.webContents.getURL() || '';
            if (/^https:\/\/(?:music|www)\.youtube\.com\//.test(url)) {
              const candidate = await getSessionCandidateCookieHeader();
              if (candidate) {
                validating = true;
                const verified = await verifyAndPersistYtSession(candidate.cookieHeader, s);
                if (verified) {
                  await finish(true);
                  return;
                }
                validating = false;
              }
            }
          };

          const timer = setInterval(check, 1000);
          win.webContents.on('did-navigate', check);
          win.webContents.on('did-navigate-in-page', check);
          win.webContents.on('did-finish-load', check);
          win.on('closed', () => {
            if (!finished) {
              getSessionCandidateCookieHeader().then(async (cand) => {
                if (cand) {
                  const verified = await verifyAndPersistYtSession(cand.cookieHeader, s);
                  finish(verified);
                } else {
                  finish(false);
                }
              }, () => finish(false));
            }
          });
          win.loadURL(
            'https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fmusic.youtube.com%2F'
          ).catch(() => finish(false));
        });
      });

      ipcMain.handle('cancel-library-sync', async (event, requestId) => {
        if (!serverPort || !requestId) return { success: false, cancelled: false };
        try {
          const res = await fetch(`http://127.0.0.1:${serverPort}/api/ytm/library-cancel`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ requestId }),
            signal: AbortSignal.timeout(5000)
          });
          return await res.json();
        } catch (err) {
          return { success: false, cancelled: false, error: err.message };
        }
      });

      ipcMain.handle('google-import-library', async (event, opts) => {
        const doLikes = !opts || opts.doLikes !== false;
        const doPlaylists = !opts || opts.doPlaylists !== false;
        const doAlbums = !opts || opts.doAlbums !== false;
        const expectedAccountId = (opts && opts.accountId) || null;
        const requestId = (opts && opts.requestId) || null;

        if (!serverPort) {
          return { success: false, status: 503, httpStatus: 503, errorCode: 'BACKEND_UNAVAILABLE', error: 'Internal server not ready' };
        }
        try {
          const res = await fetch(`http://127.0.0.1:${serverPort}/api/ytm/library-full`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ doLikes, doPlaylists, doAlbums, expectedAccountId, requestId })
          });
          const data = await res.json().catch(() => ({ success: false, error: `HTTP ${res.status}` }));
          if (!res.ok) {
            return {
              ...data,
              success: false,
              status: data.status || res.status,
              httpStatus: data.httpStatus || res.status
            };
          }
          return data;
        } catch (err) {
          return {
            success: false,
            status: 502,
            httpStatus: 502,
            errorCode: err.name === 'AbortError' ? 'ABORTED' : 'BACKEND_FETCH_FAILED',
            error: err.message || 'Failed to contact YTM backend'
          };
        }
      });

      ipcMain.handle('fetch-youtube-album-tracks', async (event, albumId, opts) => {
        if (!albumId || typeof albumId !== 'string') {
          return { success: false, tracks: [], complete: false, failed: true, errorCode: 'MISSING_ID', error: 'Invalid albumId' };
        }
        if (!serverPort) {
          return { success: false, tracks: [], complete: false, failed: true, errorCode: 'BACKEND_UNAVAILABLE', error: 'Internal server not ready' };
        }
        try {
          const expectedAccountId = (opts && opts.accountId) || null;
          const res = await fetch(`http://127.0.0.1:${serverPort}/api/ytm/album-tracks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ albumId, expectedAccountId })
          });
          const data = await res.json().catch(() => ({ success: false, tracks: [], complete: false, failed: true, error: `HTTP ${res.status}` }));
          if (!res.ok) {
            return {
              ...data,
              success: false,
              tracks: Array.isArray(data.tracks) ? data.tracks : [],
              complete: false,
              failed: true,
              status: data.status || res.status,
              httpStatus: data.httpStatus || res.status
            };
          }
          return data;
        } catch (err) {
          return {
            success: false,
            tracks: [],
            complete: false,
            failed: true,
            errorCode: err.name === 'AbortError' ? 'ABORTED' : 'BACKEND_FETCH_FAILED',
            error: err.message || 'Failed to fetch album tracks'
          };
        }
      });

      function setupTray() {
        try {
          const icoPath = path.join(__dirname, '../../assets', 'tray-icon.ico');
          const pngPath = path.join(__dirname, '../../assets', 'tray-icon.png');
          const fallbackPath = path.join(__dirname, '../../assets', 'icon.ico');
          const targetPath = (process.platform === 'win32' && fs.existsSync(icoPath)) ? icoPath : (fs.existsSync(pngPath) ? pngPath : fallbackPath);
          let trayIcon = nativeImage.createFromPath(targetPath);
          tray = new Tray(trayIcon);
          tray.setToolTip('Eclipse');
          const contextMenu = Menu.buildFromTemplate([
            {
              label: 'Show/Hide',
              click: () => {
                if (!mainWindow || mainWindow.isDestroyed()) return;
                if (mainWindow.isVisible()) mainWindow.hide();
                else { mainWindow.show(); mainWindow.focus(); }
              }
            },
            {
              label: 'Play/Pause',
              click: () => {
                if (mainWindow && !mainWindow.isDestroyed()) {
                  mainWindow.webContents.send('media-command', 'toggle');
                }
              }
            },
            { type: 'separator' },
            {
              label: 'Quit',
              click: () => {
                isQuitting = true;
                app.quit();
              }
            }
          ]);
          tray.setContextMenu(contextMenu);
          tray.on('click', () => {
            if (!mainWindow || mainWindow.isDestroyed()) return;
            if (mainWindow.isVisible()) mainWindow.hide();
            else { mainWindow.show(); mainWindow.focus(); }
          });
        } catch (err) {
          console.warn('Tray creation failed:', err);
          tray = null;
        }
      }

      app.on('before-quit', () => {
        isQuitting = true;
      });

      app.whenReady().then(() => {
        const sessionFetchFn = (urlStr, opts) => session.defaultSession.fetch(urlStr, opts);
        global.eclipseSessionFetch = sessionFetchFn;
        global.riffSessionFetch = sessionFetchFn;
        if (process.platform === 'darwin' && app.dock) {
          try {
            const dockIcon = nativeImage.createFromPath(path.join(__dirname, '../../assets', 'icon.png'));
            if (!dockIcon.isEmpty()) app.dock.setIcon(dockIcon);
          } catch (_) {}
        }
        setupTray();
        try {
          // Fix Error 153 for YouTube iframe embeds inside Electron
          session.defaultSession.webRequest.onBeforeSendHeaders(
            { urls: ['*://*.youtube.com/*', '*://*.youtube-nocookie.com/*'] },
            (details, callback) => {
              const h = details.requestHeaders || {};
              h['Origin'] = 'https://www.youtube.com';
              h['Referer'] = 'https://www.youtube.com/';
              callback({ requestHeaders: h });
            }
          );

          session.defaultSession.webRequest.onBeforeSendHeaders(
            { urls: ['*://*.googlevideo.com/*'] },
            (details, callback) => {
              const h = details.requestHeaders || {};
              try {
                const u = new URL(details.url);
                const c = u.searchParams.get('c') || '';
                if (c === 'ANDROID_VR') {
                  h['User-Agent'] = 'com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 14; eureka-user Build/SQ3A.220605.009.A1) gzip';
                } else if (c === 'IOS') {
                  h['User-Agent'] = 'com.google.ios.youtube/20.03.02 (iPhone16,2; U; CPU iOS 18_2_1 like Mac OS X;)';
                } else if (c === 'ANDROID_TESTSUITE' || c.startsWith('ANDROID')) {
                  h['User-Agent'] = 'com.google.android.youtube/1.9 (Linux; U; Android 14; en_US) gzip';
                }
                delete h['Origin'];
                delete h['origin'];
                delete h['Referer'];
                delete h['referer'];
              } catch (_) {}
              callback({ requestHeaders: h });
            }
          );
        } catch (_) {}
        try {
          session.defaultSession.webRequest.onHeadersReceived(
            {
              urls: [
                '*://*.youtube.com/*',
                '*://*.youtube-nocookie.com/*',
                '*://*.googlevideo.com/*',
                '*://*.ytimg.com/*',
                '*://*.ggpht.com/*',
                '*://*.googleusercontent.com/*',
                '*://*.scdn.co/*',
                '*://*.spotifycdn.com/*',
                '*://*.mzstatic.com/*',
                '*://*.sndcdn.com/*',
                '*://*.dzcdn.net/*',
                '*://*.yandex.net/*'
              ]
            },
            (details, callback) => {
              const rh = Object.assign({}, details.responseHeaders || {});
              delete rh['x-frame-options'];
              delete rh['X-Frame-Options'];
              delete rh['content-security-policy'];
              delete rh['Content-Security-Policy'];
              delete rh['access-control-allow-origin'];
              delete rh['Access-Control-Allow-Origin'];
              rh['Access-Control-Allow-Origin'] = ['*'];
              rh['Access-Control-Allow-Headers'] = ['*'];
              rh['Access-Control-Expose-Headers'] = ['Content-Length, Content-Range, Accept-Ranges'];
              callback({ responseHeaders: rh });
            }
          );
        } catch (_) {}
        createWindow();
        try {
          globalShortcut.register('MediaPlayPause', () => {
            mainWindow?.webContents.send('media-control', 'play-pause');
          });
          globalShortcut.register('MediaNextTrack', () => {
            mainWindow?.webContents.send('media-control', 'next');
          });
          globalShortcut.register('MediaPreviousTrack', () => {
            mainWindow?.webContents.send('media-control', 'prev');
          });
        } catch (e) {}
        if (tutorialDone()) require('./updater').initUpdater(() => mainWindow, {
          beforeExit: () => { isQuitting = true; }
        });
        app.on('activate', () => {
          if (BrowserWindow.getAllWindows().length === 0) createWindow();
        });
      });

      app.on('window-all-closed', () => {
        discordRPC.destroyRPC();
        if (process.platform !== 'darwin') app.quit();
      });
}
