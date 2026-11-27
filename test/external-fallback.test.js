'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { DatabaseSync } = require('node:sqlite');

const {
  readGeckoCookies,
  cleanupAbandonedGeckoSnapshots
} = require('../src/main/browser-login/browser-cookie-reader');
const { BrowserLoginTarget } = require('../src/main/browser-login/browser-login-targets');
const { BrowserLoginFailure, BrowserLoginException } = require('../src/main/browser-login/browser-login-errors');
const {
  ExternalLoginWindow,
  GOOGLE_DISALLOWED_UA_MESSAGE,
  isAllowedNavigationUrl,
  isDestinationLandingUrl
} = require('../src/main/browser-login/external-login-window');
const { ExternalSessionService } = require('../src/main/browser-login/external-session-service');
const { ExternalSessionStatus } = require('../src/main/browser-login/external-session-verifier');
const { ExternalSessionVault } = require('../src/main/browser-login/external-session-vault');

const ROOT_DIR = path.resolve(__dirname, '..');

function makeTempDir(prefix = 'eclipse-gate-c-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createGeckoCookieDb(profileDir, rows = [], { wal = false } = {}) {
  const dbPath = path.join(profileDir, 'cookies.sqlite');
  const db = new DatabaseSync(dbPath);
  if (wal) {
    db.exec('PRAGMA journal_mode = WAL;');
  }
  db.exec(`
    CREATE TABLE moz_cookies (
      id INTEGER PRIMARY KEY,
      originAttributes TEXT NOT NULL DEFAULT '',
      name TEXT,
      value TEXT,
      host TEXT,
      path TEXT,
      expiry INTEGER,
      isSecure INTEGER,
      isHttpOnly INTEGER
    );
  `);
  const insert = db.prepare(`
    INSERT INTO moz_cookies (originAttributes, name, value, host, path, expiry, isSecure, isHttpOnly)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const r of rows) {
    insert.run(
      r.originAttributes || '',
      r.name,
      r.value,
      r.host,
      r.path || '/',
      r.expiry !== undefined ? r.expiry : Math.floor(Date.now() / 1000) + 3600,
      r.isSecure !== undefined ? r.isSecure : 1,
      r.isHttpOnly !== undefined ? r.isHttpOnly : 1
    );
  }
  return db;
}

function createMockElectron({ cookies = [], executeJsResult = false } = {}) {
  const createdWindows = [];
  const createdPartitions = [];
  const app = new EventEmitter();

  const session = {
    fromPartition(partition, opts) {
      const ses = {
        partition,
        opts,
        clearedStorage: false,
        clearedCache: false,
        cookies: {
          get: async () => cookies
        },
        clearStorageData: async () => {
          ses.clearedStorage = true;
        },
        clearCache: async () => {
          ses.clearedCache = true;
        }
      };
      createdPartitions.push(ses);
      return ses;
    }
  };

  class MockBrowserWindow extends EventEmitter {
    constructor(config) {
      super();
      this.config = config;
      this._destroyed = false;
      this._url = 'about:blank';
      this._windowOpenHandler = null;
      const wc = new EventEmitter();
      wc.setWindowOpenHandler = (fn) => {
        this._windowOpenHandler = fn;
      };
      wc.getURL = () => this._url;
      wc.executeJavaScript = async () => executeJsResult;
      this.webContents = wc;
      createdWindows.push(this);
    }

    isDestroyed() {
      return this._destroyed;
    }

    destroy() {
      this._destroyed = true;
    }

    async loadURL(url) {
      this._url = url;
    }
  }

  return {
    electron: { BrowserWindow: MockBrowserWindow, session, app },
    createdWindows,
    createdPartitions,
    app
  };
}

// ============================================================================
// 1. Firefox Safe Snapshot (browser-cookie-reader.js)
// ============================================================================

test('Gecko snapshot: copies SQLite + WAL/SHM and reads EXTERNAL_WEB sp_dc', async () => {
  const profileDir = makeTempDir('gecko-prof-');
  const tmpRoot = makeTempDir('gecko-tmp-');
  const db = createGeckoCookieDb(profileDir, [
    { name: 'sp_dc', value: 'valid-sp-dc-wal-token', host: 'open.spotify.com', isSecure: 1 },
    { name: 'SAPISID', value: 'yt-sapisid', host: '.youtube.com', isSecure: 1 }
  ], { wal: true });

  try {
    assert.equal(fs.existsSync(path.join(profileDir, 'cookies.sqlite-wal')), true);
    const records = await readGeckoCookies(profileDir, BrowserLoginTarget.EXTERNAL_WEB, { tmpRoot });
    assert.equal(records.length, 1);
    assert.equal(records[0].name, 'sp_dc');
    assert.equal(records[0].value, 'valid-sp-dc-wal-token');
    assert.equal(records[0].domain, 'open.spotify.com');
    assert.deepEqual(fs.readdirSync(tmpRoot), []);
  } finally {
    db.close();
    fs.rmSync(profileDir, { recursive: true, force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Gecko snapshot: enforces maxCopyBytes size limit and cleans up temp dir', async () => {
  const profileDir = makeTempDir('gecko-size-');
  const tmpRoot = makeTempDir('gecko-tmp-');
  const db = createGeckoCookieDb(profileDir, [
    { name: 'sp_dc', value: 'x'.repeat(2048), host: 'open.spotify.com', isSecure: 1 }
  ]);
  db.close();

  try {
    await assert.rejects(
      () => readGeckoCookies(profileDir, BrowserLoginTarget.EXTERNAL_WEB, { tmpRoot, maxCopyBytes: 512 }),
      (err) => err instanceof BrowserLoginException && err.reason === BrowserLoginFailure.PROFILE_ACCESS_DENIED
    );
    assert.deepEqual(fs.readdirSync(tmpRoot), []);
  } finally {
    fs.rmSync(profileDir, { recursive: true, force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Gecko snapshot: retries on metadata race and succeeds once stable', async () => {
  const profileDir = makeTempDir('gecko-race-');
  const tmpRoot = makeTempDir('gecko-tmp-');
  const db = createGeckoCookieDb(profileDir, [
    { name: 'sp_dc', value: 'race-recovered-token', host: 'open.spotify.com', isSecure: 1 }
  ]);
  db.close();

  const dbPath = path.join(profileDir, 'cookies.sqlite');
  const origCopyFileSync = fs.copyFileSync;
  let copyCalls = 0;
  fs.copyFileSync = (src, dest, ...rest) => {
    origCopyFileSync.call(fs, src, dest, ...rest);
    if (src === dbPath && copyCalls === 0) {
      copyCalls += 1;
      const now = new Date(Date.now() + 5000);
      fs.utimesSync(dbPath, now, now);
    }
  };

  try {
    const records = await readGeckoCookies(profileDir, BrowserLoginTarget.EXTERNAL_WEB, {
      tmpRoot,
      maxRetries: 3
    });
    assert.equal(records.length, 1);
    assert.equal(records[0].value, 'race-recovered-token');
    assert.equal(copyCalls, 1);
    assert.deepEqual(fs.readdirSync(tmpRoot), []);
  } finally {
    fs.copyFileSync = origCopyFileSync;
    fs.rmSync(profileDir, { recursive: true, force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Gecko snapshot: succeeds when source DB is exclusively locked', async () => {
  const profileDir = makeTempDir('gecko-lock-');
  const tmpRoot = makeTempDir('gecko-tmp-');
  const db = createGeckoCookieDb(profileDir, [
    { name: 'sp_dc', value: 'locked-db-token', host: 'open.spotify.com', isSecure: 1 }
  ]);
  db.exec('BEGIN EXCLUSIVE;');

  try {
    const records = await readGeckoCookies(profileDir, BrowserLoginTarget.EXTERNAL_WEB, { tmpRoot });
    assert.equal(records.length, 1);
    assert.equal(records[0].value, 'locked-db-token');
    assert.deepEqual(fs.readdirSync(tmpRoot), []);
  } finally {
    try { db.exec('ROLLBACK;'); } catch (_) {}
    db.close();
    fs.rmSync(profileDir, { recursive: true, force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Gecko snapshot: rejects corrupt DB failing PRAGMA quick_check(1) and cleans up', async () => {
  const profileDir = makeTempDir('gecko-corrupt-');
  const tmpRoot = makeTempDir('gecko-tmp-');
  fs.writeFileSync(path.join(profileDir, 'cookies.sqlite'), Buffer.from('not-a-valid-sqlite-database-file'));

  try {
    await assert.rejects(
      () => readGeckoCookies(profileDir, BrowserLoginTarget.EXTERNAL_WEB, { tmpRoot }),
      (err) => err instanceof BrowserLoginException && err.reason === BrowserLoginFailure.INVALID_DATA
    );
    assert.deepEqual(fs.readdirSync(tmpRoot), []);
  } finally {
    fs.rmSync(profileDir, { recursive: true, force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Gecko snapshot: isolates private/container cookies unless explicitly allowed', async () => {
  const profileDir = makeTempDir('gecko-container-');
  const tmpRoot = makeTempDir('gecko-tmp-');
  const db = createGeckoCookieDb(profileDir, [
    { name: 'sp_dc', value: 'private-token', host: 'open.spotify.com', originAttributes: '^privateBrowsingId=1' },
    { name: 'SAPISID', value: 'container-yt', host: '.youtube.com', originAttributes: '^userContextId=2' }
  ]);
  db.close();

  try {
    await assert.rejects(
      () => readGeckoCookies(profileDir, BrowserLoginTarget.EXTERNAL_WEB, { tmpRoot }),
      (err) => err instanceof BrowserLoginException
    );
    const ytDefault = await readGeckoCookies(profileDir, BrowserLoginTarget.YOUTUBE, { tmpRoot });
    assert.equal(ytDefault.length, 0);

    const allowedExt = await readGeckoCookies(profileDir, BrowserLoginTarget.EXTERNAL_WEB, {
      tmpRoot,
      allowNonDefaultContainers: true
    });
    assert.equal(allowedExt.length, 1);
    assert.equal(allowedExt[0].value, 'private-token');

    const allowedYt = await readGeckoCookies(profileDir, BrowserLoginTarget.YOUTUBE, {
      tmpRoot,
      allowNonDefaultContainers: true
    });
    assert.equal(allowedYt.length, 1);
    assert.equal(allowedYt[0].value, 'container-yt');
  } finally {
    fs.rmSync(profileDir, { recursive: true, force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Gecko snapshot: enforces domain boundary for EXTERNAL_WEB', async () => {
  const profileDir = makeTempDir('gecko-domain-');
  const tmpRoot = makeTempDir('gecko-tmp-');
  const db = createGeckoCookieDb(profileDir, [
    { name: 'sp_dc', value: 'wrong-subdomain', host: 'accounts.spotify.com', isSecure: 1 },
    { name: 'sp_dc', value: 'lookalike-domain', host: 'evil-spotify.com', isSecure: 1 }
  ]);
  db.close();

  try {
    await assert.rejects(
      () => readGeckoCookies(profileDir, BrowserLoginTarget.EXTERNAL_WEB, { tmpRoot }),
      (err) => err instanceof BrowserLoginException
    );
    assert.deepEqual(fs.readdirSync(tmpRoot), []);
  } finally {
    fs.rmSync(profileDir, { recursive: true, force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Gecko snapshot: cleanupAbandonedGeckoSnapshots removes dead-PID and expired temp dirs', () => {
  const tmpRoot = makeTempDir('gecko-abandoned-');
  const deadPidDir = path.join(tmpRoot, `gecko-snap-999999-${Date.now()}-dead`);
  const expiredDir = path.join(tmpRoot, `gecko-snap-${process.pid}-1000-old`);
  const activeDir = path.join(tmpRoot, `gecko-snap-${process.pid}-${Date.now()}-live`);
  const unrelatedDir = path.join(tmpRoot, 'other-temp-dir');

  for (const d of [deadPidDir, expiredDir, activeDir, unrelatedDir]) {
    fs.mkdirSync(d, { recursive: true });
  }

  try {
    const removed = cleanupAbandonedGeckoSnapshots({ tmpRoot, maxAgeMs: 60000 });
    assert.equal(removed, 2);
    assert.equal(fs.existsSync(deadPidDir), false);
    assert.equal(fs.existsSync(expiredDir), false);
    assert.equal(fs.existsSync(activeDir), true);
    assert.equal(fs.existsSync(unrelatedDir), true);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 2. Isolated Login Window (external-login-window.js)
// ============================================================================

test('LoginWindow: uses non-persistent partition, sandbox/contextIsolation/nodeIntegration=false, and denies popups', async () => {
  const mock = createMockElectron({
    cookies: [{ name: 'sp_dc', value: 'win-sp-dc-123', domain: 'open.spotify.com', path: '/', secure: true }]
  });
  const loginWin = new ExternalLoginWindow({ electron: mock.electron, timeoutMs: 5000 });
  const promise = loginWin.open();

  assert.equal(mock.createdWindows.length, 1);
  const win = mock.createdWindows[0];
  const ses = mock.createdPartitions[0];

  assert.match(loginWin.partition, /^temp-ext-login-\d+-[0-9a-f]+$/);
  assert.deepEqual(ses.opts, { cache: false });
  assert.equal(win.config.webPreferences.partition, loginWin.partition);
  assert.equal(win.config.webPreferences.sandbox, true);
  assert.equal(win.config.webPreferences.contextIsolation, true);
  assert.equal(win.config.webPreferences.nodeIntegration, false);
  assert.equal(win.config.webPreferences.webSecurity, true);
  assert.equal(win.config.webPreferences.allowRunningInsecureContent, false);
  assert.deepEqual(win._windowOpenHandler({ url: 'https://open.spotify.com/' }), { action: 'deny' });

  win._url = 'https://open.spotify.com/';
  win.webContents.emit('did-navigate', {}, 'https://open.spotify.com/');

  const result = await promise;
  assert.equal(result.validatedCookie.name, 'sp_dc');
  assert.equal(result.validatedCookie.value, 'win-sp-dc-123');
  assert.equal(win.isDestroyed(), true);
  assert.equal(ses.clearedStorage, true);
  assert.equal(ses.clearedCache, true);
});

test('LoginWindow: blocks redirects/navigations outside allowlist and ignores landing without sp_dc', async () => {
  assert.equal(isAllowedNavigationUrl('https://accounts.spotify.com/authorize'), true);
  assert.equal(isAllowedNavigationUrl('https://accounts.google.com/o/oauth2/v2/auth'), true);
  assert.equal(isAllowedNavigationUrl('https://evil.example.com/phish'), false);
  assert.equal(isAllowedNavigationUrl('http://open.spotify.com/'), false);
  assert.equal(isDestinationLandingUrl('https://open.spotify.com/'), true);
  assert.equal(isDestinationLandingUrl('https://accounts.spotify.com/'), false);

  const mock = createMockElectron({ cookies: [] });
  const loginWin = new ExternalLoginWindow({ electron: mock.electron, timeoutMs: 5000 });
  const promise = loginWin.open();
  const win = mock.createdWindows[0];

  let blockedNav = false;
  win.webContents.emit('will-navigate', { preventDefault: () => { blockedNav = true; } }, 'https://evil.example.com/');
  assert.equal(blockedNav, true);

  let blockedRedirect = false;
  win.webContents.emit('will-redirect', { preventDefault: () => { blockedRedirect = true; } }, 'http://open.spotify.com/');
  assert.equal(blockedRedirect, true);

  let allowedNav = false;
  win.webContents.emit('will-navigate', { preventDefault: () => { allowedNav = true; } }, 'https://accounts.spotify.com/login');
  assert.equal(allowedNav, false);

  // Landing on open.spotify.com without sp_dc must not resolve
  win._url = 'https://open.spotify.com/';
  win.webContents.emit('did-navigate', {}, 'https://open.spotify.com/');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(loginWin.isActive(), true);

  loginWin.cancel('TEST_DONE');
  await assert.rejects(() => promise, (err) => err.code === 'TEST_DONE');
});

test('LoginWindow: handles user close, cancel, timeout, and app before-quit with full cleanup', async () => {
  // 1. User close
  {
    const mock = createMockElectron();
    const lw = new ExternalLoginWindow({ electron: mock.electron, timeoutMs: 5000 });
    const p = lw.open();
    mock.createdWindows[0].emit('closed');
    await assert.rejects(() => p, (err) => err.code === 'LOGIN_WINDOW_CLOSED');
    assert.equal(mock.createdPartitions[0].clearedStorage, true);
  }

  // 2. Timeout
  {
    const mock = createMockElectron();
    const lw = new ExternalLoginWindow({ electron: mock.electron, timeoutMs: 25 });
    const p = lw.open();
    await assert.rejects(() => p, (err) => err.code === 'LOGIN_WINDOW_TIMEOUT');
    assert.equal(mock.createdWindows[0].isDestroyed(), true);
    assert.equal(mock.createdPartitions[0].clearedStorage, true);
  }

  // 3. App before-quit
  {
    const mock = createMockElectron();
    const lw = new ExternalLoginWindow({ electron: mock.electron, timeoutMs: 5000 });
    const p = lw.open();
    mock.app.emit('before-quit');
    await assert.rejects(() => p, (err) => err.code === 'APP_EXIT');
    assert.equal(mock.createdWindows[0].isDestroyed(), true);
  }
});

test('LoginWindow: detects Google SSO disallowed_useragent via URL and DOM and returns actionable fallback', async () => {
  // URL signal
  {
    const mock = createMockElectron();
    const lw = new ExternalLoginWindow({ electron: mock.electron, timeoutMs: 5000 });
    const p = lw.open();
    let prevented = false;
    mock.createdWindows[0].webContents.emit(
      'will-navigate',
      { preventDefault: () => { prevented = true; } },
      'https://accounts.google.com/signin/oauth/error?errorCode=disallowed_useragent'
    );
    assert.equal(prevented, true);
    await assert.rejects(
      () => p,
      (err) => err.code === 'DISALLOWED_USERAGENT' && err.message === GOOGLE_DISALLOWED_UA_MESSAGE
    );
  }

  // DOM signal on accounts.google.com
  {
    const mock = createMockElectron({ executeJsResult: true });
    const lw = new ExternalLoginWindow({ electron: mock.electron, timeoutMs: 5000 });
    const p = lw.open();
    const win = mock.createdWindows[0];
    win._url = 'https://accounts.google.com/v3/signin/rejected';
    win.webContents.emit('did-finish-load');
    await assert.rejects(
      () => p,
      (err) => err.code === 'DISALLOWED_USERAGENT' && err.message === GOOGLE_DISALLOWED_UA_MESSAGE
    );
  }
});

test('LoginWindow + ExternalSessionService: verifies before persisting and never leaks credentials in status', async () => {
  const tmpDir = makeTempDir('ext-svc-win-');
  const vault = new ExternalSessionVault({
    vaultPath: path.join(tmpDir, 'vault.json'),
    allowInMemoryFallback: true
  });

  let verifyCalls = 0;
  const service = new ExternalSessionService({
    vault,
    verifier: {
      verify: async (creds) => {
        verifyCalls += 1;
        if (creds.cookies[0].value === 'bad-cookie') {
          return { status: ExternalSessionStatus.INVALID_COOKIE };
        }
        return {
          status: ExternalSessionStatus.VALID,
          displayName: 'Eclipse Listener',
          avatarUrl: 'https://example.com/avatar.png'
        };
      }
    },
    loginWindowFactory: (opts) => ({
      open: async () => ({
        cookies: [{ name: 'sp_dc', value: opts.cookieValue, domain: 'open.spotify.com', path: '/', secure: true }]
      }),
      cancel: () => {}
    })
  });

  try {
    const rejected = await service.openLoginWindow({ cookieValue: 'bad-cookie' });
    assert.equal(rejected.connected, false);
    assert.equal(rejected.sessionStatus, ExternalSessionStatus.INVALID_COOKIE);
    assert.equal(vault.load().data, null);

    const accepted = await service.openLoginWindow({ cookieValue: 'secret-sp-dc-value' });
    assert.equal(verifyCalls, 2);
    assert.equal(accepted.connected, true);
    assert.equal(accepted.connectionMethod, 'login_window');
    assert.equal(accepted.displayName, 'Eclipse Listener');
    assert.equal(JSON.stringify(accepted).includes('secret-sp-dc-value'), false);
    assert.equal(JSON.stringify(service.getStatus()).includes('secret-sp-dc-value'), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// 3. Settings Connection Center & Library Importer Isolation
// ============================================================================

test('Renderer & Main: Connection Center state machine/consent/disconnect exist and Library Importer is untouched', () => {
  const html = fs.readFileSync(path.join(ROOT_DIR, 'src/renderer/index.html'), 'utf8');
  const appJs = fs.readFileSync(path.join(ROOT_DIR, 'src/renderer/app.js'), 'utf8');
  const mainJs = fs.readFileSync(path.join(ROOT_DIR, 'src/main/main.js'), 'utf8');

  // Connection Center UI controls
  for (const id of [
    'external-session-dialog',
    'chk-external-consent',
    'ext-state-badge',
    'btn-ext-start-pkce',
    'btn-ext-start-pairing',
    'btn-ext-open-login-window',
    'btn-ext-disconnect',
    'btn-ext-reconnect',
    'btn-ext-manual-fallback'
  ]) {
    assert.ok(html.includes(`id="${id}"`), `Missing Connection Center element #${id}`);
  }

  // State machine states in app.js
  for (const state of [
    'not_installed',
    'unpaired',
    'pairing',
    'connected',
    'expired',
    'error',
    'reconnect',
    'disconnect',
    'manual_fallback'
  ]) {
    assert.ok(appJs.includes(`'${state}'`), `Missing state '${state}' in ExternalSessionController`);
  }

  // Consent gating & disconnect wiring
  assert.ok(appJs.includes('btnOpenLoginWindow.disabled = !consented || busy'));
  assert.ok(appJs.includes('api.externalSessionLogout()'));
  assert.ok(appJs.includes('api.externalSessionOpenLoginWindow'));

  // Library Importer / Transfer isolation
  assert.ok(html.includes('id="google-import-target"'));
  assert.ok(appJs.includes("populateTargetDropdown('google-import-target'"));
  assert.ok(mainJs.includes("ipcMain.handle('google-import-library'"));
  assert.ok(mainJs.includes("ipcMain.handle('external-session:open-login-window'"));
  assert.ok(mainJs.includes('externalSessionService.openLoginWindow'));
});
