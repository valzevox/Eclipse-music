'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

const {
  ExternalPkceAuth,
  generateCodeVerifier,
  generateCodeChallenge,
  generateStateNonce
} = require('../src/main/browser-login/external-pkce-auth');
const {
  ExternalSessionVerifier,
  ExternalSessionStatus
} = require('../src/main/browser-login/external-session-verifier');
const {
  ExternalSessionVault,
  VAULT_SCHEMA_VERSION,
  VaultStatus
} = require('../src/main/browser-login/external-session-vault');
const { ExternalSessionService } = require('../src/main/browser-login/external-session-service');

const ROOT_DIR = path.resolve(__dirname, '..');

function makeTempDir(prefix = 'eclipse-gate-b-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createMockSafeStorage({ available = true, backend = 'gnome_libsecret', platform = 'win32' } = {}) {
  const prefix = Buffer.from('ENCv1:');
  return {
    platform,
    api: {
      isEncryptionAvailable: () => available,
      getSelectedStorageBackend: () => backend,
      encryptString: (plaintext) => Buffer.concat([prefix, Buffer.from(plaintext, 'utf8')]),
      decryptString: (buf) => {
        const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
        if (!b.subarray(0, prefix.length).equals(prefix)) {
          throw new Error('Decryption failed');
        }
        return b.subarray(prefix.length).toString('utf8');
      }
    }
  };
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', reject);
  });
}

// ============================================================================
// 1. Official PKCE Flow
// ============================================================================

test('PKCE: S256 challenge matches RFC 7636 SHA-256 base64url and rejects short verifier', () => {
  const verifier = generateCodeVerifier();
  assert.ok(verifier.length >= 43);
  const expected = crypto
    .createHash('sha256')
    .update(verifier, 'ascii')
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
  assert.equal(generateCodeChallenge(verifier), expected);
  assert.throws(() => generateCodeChallenge('too-short'), /Invalid PKCE code verifier/);
  assert.ok(generateStateNonce().length >= 32);
});

const VALID_TEST_CLIENT_ID = '0123456789abcdef0123456789abcdef';

test('PKCE: full loopback authenticate() validates S256, state, and exchanges code', async () => {
  let capturedAuthUrl = null;
  let capturedTokenBody = null;

  const pkce = new ExternalPkceAuth({
    clientId: VALID_TEST_CLIENT_ID,
    timeoutMs: 5000,
    fetchImpl: async (url, init) => {
      capturedTokenBody = new URLSearchParams(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'pkce-access-token-123',
          refresh_token: 'pkce-refresh-token-456',
          token_type: 'Bearer',
          expires_in: 3600
        })
      };
    }
  });

  const result = await pkce.authenticate({
    onAuthUrl: async (authUrl) => {
      capturedAuthUrl = new URL(authUrl);
      const redirectUri = capturedAuthUrl.searchParams.get('redirect_uri');
      const state = capturedAuthUrl.searchParams.get('state');
      const cbRes = await httpGet(`${redirectUri}?code=auth-code-xyz&state=${encodeURIComponent(state)}`);
      assert.equal(cbRes.status, 200);
    }
  });

  assert.equal(capturedAuthUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(capturedAuthUrl.searchParams.get('code_challenge'));
  assert.equal(capturedTokenBody.get('grant_type'), 'authorization_code');
  assert.equal(capturedTokenBody.get('code'), 'auth-code-xyz');
  assert.equal(
    generateCodeChallenge(capturedTokenBody.get('code_verifier')),
    capturedAuthUrl.searchParams.get('code_challenge')
  );
  assert.equal(result.authType, 'pkce');
  assert.equal(result.accessToken, 'pkce-access-token-123');
  assert.equal(result.refreshToken, 'pkce-refresh-token-456');
  assert.equal(pkce.isActive(), false);
});

test('PKCE: rejects invalid or non-32-hex clientId with PKCE_CLIENT_ID_MISSING', async () => {
  for (const badClientId of ['', 'eclipse-test-client', '0123456789abcdef', 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz']) {
    const pkce = new ExternalPkceAuth({
      clientId: badClientId,
      timeoutMs: 5000
    });
    await assert.rejects(
      () => pkce.authenticate({ onAuthUrl: () => {} }),
      (err) => err && err.code === 'PKCE_CLIENT_ID_MISSING'
    );
    assert.equal(pkce.isActive(), false);
  }
});

test('PKCE: rejects state mismatch on callback', async () => {
  const pkce = new ExternalPkceAuth({
    clientId: VALID_TEST_CLIENT_ID,
    timeoutMs: 5000,
    fetchImpl: async () => {
      throw new Error('Token endpoint must not be called on state mismatch');
    }
  });

  await assert.rejects(
    () =>
      pkce.authenticate({
        onAuthUrl: async (authUrl) => {
          const parsed = new URL(authUrl);
          const redirectUri = parsed.searchParams.get('redirect_uri');
          const cbRes = await httpGet(`${redirectUri}?code=auth-code-xyz&state=wrong-state-value`);
          assert.equal(cbRes.status, 400);
        }
      }),
    (err) => err && err.code === 'PKCE_STATE_MISMATCH'
  );
  assert.equal(pkce.isActive(), false);
});

test('PKCE: rejects duplicate code or state parameters on callback', async () => {
  const pkce = new ExternalPkceAuth({
    clientId: VALID_TEST_CLIENT_ID,
    timeoutMs: 5000,
    fetchImpl: async () => {
      throw new Error('Token endpoint must not be called on duplicate params');
    }
  });

  await assert.rejects(
    () =>
      pkce.authenticate({
        onAuthUrl: async (authUrl) => {
          const parsed = new URL(authUrl);
          const redirectUri = parsed.searchParams.get('redirect_uri');
          const state = parsed.searchParams.get('state');
          const cbRes = await httpGet(`${redirectUri}?code=a&code=b&state=${encodeURIComponent(state)}`);
          assert.equal(cbRes.status, 400);
        }
      }),
    (err) => err && err.code === 'PKCE_DUPLICATE_PARAMS'
  );
  assert.equal(pkce.isActive(), false);
});

test('PKCE: cancel() aborts active flow and closes loopback server', async () => {
  const pkce = new ExternalPkceAuth({
    clientId: VALID_TEST_CLIENT_ID,
    timeoutMs: 5000
  });

  const authPromise = pkce.authenticate({
    onAuthUrl: () => {
      assert.equal(pkce.isActive(), true);
      pkce.cancel('PKCE_CANCELLED');
    }
  });

  await assert.rejects(authPromise, (err) => err && err.code === 'PKCE_CANCELLED');
  assert.equal(pkce.isActive(), false);
});

test('PKCE: timeout rejects with PKCE_TIMEOUT and closes loopback server', async () => {
  const pkce = new ExternalPkceAuth({
    clientId: VALID_TEST_CLIENT_ID,
    timeoutMs: 60
  });

  await assert.rejects(
    () => pkce.authenticate({ onAuthUrl: () => {} }),
    (err) => err && err.code === 'PKCE_TIMEOUT'
  );
  assert.equal(pkce.isActive(), false);
});

// ============================================================================
// 2. Converging ExternalSessionVerifier (all 8 outcomes + schema/leakage)
// ============================================================================

test('ExternalSessionVerifier: covers all 8 ExternalSessionStatus outcomes', async () => {
  const expectedStatuses = [
    'VALID',
    'SIGNED_OUT',
    'EXPIRED',
    'INVALID_COOKIE',
    'UNVERIFIED_WEB_SESSION',
    'PERMISSION_DENIED',
    'NETWORK_UNAVAILABLE',
    'TEMP_REFUSAL',
    'UNSUPPORTED_STORAGE'
  ];
  assert.deepEqual(Object.keys(ExternalSessionStatus).sort(), [...expectedStatuses].sort());

  const now = 1_700_000_000_000;

  // 1. VALID (PKCE)
  const validVerifier = new ExternalSessionVerifier({
    nowFn: () => now,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'acct-1',
        display_name: 'Eclipse Listener',
        images: [{ url: 'https://cdn.example.com/avatar.png' }]
      })
    })
  });
  const validRes = await validVerifier.verify({
    authType: 'pkce',
    accessToken: 'secret-token-abc',
    expiresAt: now + 60_000
  });
  assert.equal(validRes.status, ExternalSessionStatus.VALID);
  assert.equal(validRes.connected, true);
  assert.equal(validRes.displayName, 'Eclipse Listener');

  // 2. SIGNED_OUT
  const signedOutRes = await validVerifier.verify(null);
  assert.equal(signedOutRes.status, ExternalSessionStatus.SIGNED_OUT);
  assert.equal(signedOutRes.connected, false);

  // 3. EXPIRED
  const expiredRes = await validVerifier.verify({
    authType: 'pkce',
    accessToken: 'secret-token-expired',
    expiresAt: now - 1000
  });
  assert.equal(expiredRes.status, ExternalSessionStatus.EXPIRED);
  assert.equal(expiredRes.connected, false);

  // 4. INVALID_COOKIE
  const invalidCookieRes = await validVerifier.verify({
    authType: 'cookie',
    cookies: [{ name: 'other', value: 'x', domain: 'open.spotify.com', path: '/', secure: true }]
  });
  assert.equal(invalidCookieRes.status, ExternalSessionStatus.INVALID_COOKIE);
  assert.equal(invalidCookieRes.connected, false);

  // 5. PERMISSION_DENIED (403)
  const deniedVerifier = new ExternalSessionVerifier({
    nowFn: () => now,
    fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) })
  });
  const deniedRes = await deniedVerifier.verify({
    authType: 'pkce',
    accessToken: 'secret-token-403',
    expiresAt: now + 60_000
  });
  assert.equal(deniedRes.status, ExternalSessionStatus.PERMISSION_DENIED);

  // 6. NETWORK_UNAVAILABLE
  const netVerifier = new ExternalSessionVerifier({
    nowFn: () => now,
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    }
  });
  const netRes = await netVerifier.verify({
    authType: 'pkce',
    accessToken: 'secret-token-net',
    expiresAt: now + 60_000
  });
  assert.equal(netRes.status, ExternalSessionStatus.NETWORK_UNAVAILABLE);

  // 7. TEMP_REFUSAL (429 / 503)
  const tempVerifier = new ExternalSessionVerifier({
    nowFn: () => now,
    fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({}) })
  });
  const tempRes = await tempVerifier.verify({
    authType: 'pkce',
    accessToken: 'secret-token-429',
    expiresAt: now + 60_000
  });
  assert.equal(tempRes.status, ExternalSessionStatus.TEMP_REFUSAL);

  // 8. UNSUPPORTED_STORAGE (surfaced by ExternalSessionService when vault fails closed)
  const { api: unavailableStorage } = createMockSafeStorage({ available: false });
  const tmpDir = makeTempDir();
  try {
    const svc = new ExternalSessionService({
      vaultPath: path.join(tmpDir, 'vault.json'),
      safeStorage: unavailableStorage,
      verifier: validVerifier,
      pkceAuth: {
        authenticate: async () => ({
          authType: 'pkce',
          accessToken: 'secret-token-abc',
          refreshToken: 'secret-refresh-abc',
          expiresAt: now + 60_000
        }),
        cancel: () => {}
      }
    });
    const svcRes = await svc.startPkceLogin();
    assert.equal(svcRes.sessionStatus, ExternalSessionStatus.UNSUPPORTED_STORAGE);
    assert.equal(svcRes.connected, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('ExternalSessionVerifier: rejects HTTP 200 with invalid schema or expired token and leaks zero secrets', async () => {
  const now = 1_700_000_000_000;
  const secretCookie = 'super-secret-sp-dc-value-999';
  const secretToken = 'super-secret-access-token-888';

  // HTTP 200 with invalid profile schema (missing id)
  const badSchemaVerifier = new ExternalSessionVerifier({
    nowFn: () => now,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ display_name: 'No ID' })
    })
  });
  const badSchemaRes = await badSchemaVerifier.verify({
    authType: 'pkce',
    accessToken: secretToken,
    expiresAt: now + 60_000
  });
  assert.equal(badSchemaRes.status, ExternalSessionStatus.SIGNED_OUT);
  assert.equal(badSchemaRes.connected, false);
  assert.ok(!JSON.stringify(badSchemaRes).includes(secretToken));

  // Valid-looking sp_dc cookie must NEVER produce VALID / connected: true (strictly UNVERIFIED_WEB_SESSION)
  const cookieVerifier = new ExternalSessionVerifier({
    nowFn: () => now,
    fetchImpl: async () => {
      throw new Error('Must not call /get_access_token for sp_dc');
    }
  });
  const cookieRes = await cookieVerifier.verify({
    authType: 'cookie',
    cookies: [{ name: 'sp_dc', value: secretCookie, domain: 'open.spotify.com', path: '/', secure: true }]
  });
  assert.equal(cookieRes.status, ExternalSessionStatus.UNVERIFIED_WEB_SESSION);
  assert.equal(cookieRes.connected, false);
  const serialized = JSON.stringify(cookieRes);
  assert.ok(!serialized.includes(secretCookie));
  assert.ok(!serialized.includes(secretToken));
});

// ============================================================================
// 3. ExternalSessionVault
// ============================================================================

test('ExternalSessionVault: safeStorage round-trip, atomic write, and logout clear()', () => {
  const tmpDir = makeTempDir();
  const vaultPath = path.join(tmpDir, 'external-session.vault.json');
  const { api } = createMockSafeStorage({ available: true });
  const vault = new ExternalSessionVault({ vaultPath, safeStorage: api, platform: 'win32' });

  try {
    const secretPayload = {
      authType: 'pkce',
      connectionMethod: 'pkce',
      accessToken: 'vault-secret-access-token',
      refreshToken: 'vault-secret-refresh-token',
      expiresAt: Date.now() + 3600_000
    };

    const saveRes = vault.save(secretPayload);
    assert.equal(saveRes.ok, true);
    assert.equal(saveRes.status, VaultStatus.OK);
    assert.equal(saveRes.persisted, true);

    // Atomic write: no leftover .tmp files
    const files = fs.readdirSync(tmpDir);
    assert.deepEqual(files, ['external-session.vault.json']);

    // Disk file must not contain plaintext secret
    const rawDisk = fs.readFileSync(vaultPath, 'utf8');
    assert.ok(!rawDisk.includes('vault-secret-access-token'));
    const envelope = JSON.parse(rawDisk);
    assert.equal(envelope.schemaVersion, VAULT_SCHEMA_VERSION);

    const loadRes = vault.load();
    assert.equal(loadRes.ok, true);
    assert.equal(loadRes.status, VaultStatus.OK);
    assert.deepEqual(loadRes.data, secretPayload);

    vault.clear();
    assert.equal(fs.existsSync(vaultPath), false);
    const afterClear = vault.load();
    assert.equal(afterClear.ok, true);
    assert.equal(afterClear.status, VaultStatus.EMPTY);
    assert.equal(afterClear.data, null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('ExternalSessionVault: detects corruption and quarantines corrupt file', () => {
  const tmpDir = makeTempDir();
  const vaultPath = path.join(tmpDir, 'external-session.vault.json');
  const { api } = createMockSafeStorage({ available: true });
  const vault = new ExternalSessionVault({ vaultPath, safeStorage: api, platform: 'win32' });

  try {
    fs.writeFileSync(vaultPath, '{corrupt-json', 'utf8');
    const loadRes = vault.load();
    assert.equal(loadRes.ok, false);
    assert.equal(loadRes.status, VaultStatus.CORRUPTED);
    assert.equal(loadRes.data, null);
    assert.equal(fs.existsSync(vaultPath), false);
    assert.ok(loadRes.quarantinedPath && fs.existsSync(loadRes.quarantinedPath));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('ExternalSessionVault: safeStorage unavailable fails closed with zero plaintext file written', () => {
  const tmpDir = makeTempDir();
  const vaultPath = path.join(tmpDir, 'external-session.vault.json');
  const { api } = createMockSafeStorage({ available: false });
  const vault = new ExternalSessionVault({ vaultPath, safeStorage: api, platform: 'win32' });

  try {
    const saveRes = vault.save({ authType: 'pkce', accessToken: 'must-not-write-plaintext' });
    assert.equal(saveRes.ok, false);
    assert.equal(saveRes.status, VaultStatus.UNSUPPORTED_STORAGE);
    assert.equal(saveRes.persisted, false);
    assert.equal(fs.existsSync(vaultPath), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('ExternalSessionVault: Linux basic_text backend is rejected with zero plaintext file written', () => {
  const tmpDir = makeTempDir();
  const vaultPath = path.join(tmpDir, 'external-session.vault.json');
  const { api } = createMockSafeStorage({ available: true, backend: 'basic_text', platform: 'linux' });
  const vault = new ExternalSessionVault({ vaultPath, safeStorage: api, platform: 'linux' });

  try {
    const avail = vault.checkStorageAvailability();
    assert.equal(avail.available, false);
    assert.match(avail.reason, /basic_text/);

    const saveRes = vault.save({ authType: 'pkce', accessToken: 'must-not-write-basic-text' });
    assert.equal(saveRes.ok, false);
    assert.equal(saveRes.status, VaultStatus.UNSUPPORTED_STORAGE);
    assert.equal(saveRes.persisted, false);
    assert.equal(fs.existsSync(vaultPath), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// 4. ExternalSessionService (generation-token & NETWORK_UNAVAILABLE preservation)
// ============================================================================

test('ExternalSessionService: generation-token prevents stale async op from overwriting newer login', async () => {
  const tmpDir = makeTempDir();
  const vaultPath = path.join(tmpDir, 'external-session.vault.json');
  const { api } = createMockSafeStorage({ available: true });

  let resolveSlowPkce;
  const slowPkceAuth = {
    authenticate: () =>
      new Promise((resolve) => {
        resolveSlowPkce = resolve;
      }),
    cancel: () => {}
  };

  const verifier = new ExternalSessionVerifier({
    fetchImpl: async (url, init) => {
      if (url.includes('get_access_token')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            isAnonymous: false,
            accessToken: 'newer-cookie-token',
            accessTokenExpirationTimestampMs: Date.now() + 3600_000
          })
        };
      }
      const authHeader = init && init.headers ? init.headers.Authorization : '';
      const isNewer = authHeader.includes('newer-cookie-token');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: isNewer ? 'newer-user' : 'stale-user',
          display_name: isNewer ? 'Newer User' : 'Stale User'
        })
      };
    }
  });

  const service = new ExternalSessionService({
    vaultPath,
    safeStorage: api,
    pkceAuth: slowPkceAuth,
    verifier
  });

  try {
    const stalePkcePromise = service.startPkceLogin();
    // Newer unverified web session completes while stale PKCE is still pending
    const newerStatus = await service.importFromCookies(
      [{ name: 'sp_dc', value: 'newer-cookie', domain: 'open.spotify.com', path: '/', secure: true }],
      'extension_pairing'
    );
    assert.equal(newerStatus.connected, false);
    assert.equal(newerStatus.webSessionStatus, 'spotify_web_session_unverified');

    // Now resolve the stale PKCE op; it must NOT overwrite newer generation
    resolveSlowPkce({
      authType: 'pkce',
      accessToken: 'stale-pkce-token',
      refreshToken: 'stale-refresh',
      expiresAt: Date.now() + 3600_000
    });
    await stalePkcePromise;

    const finalStatus = service.getStatus();
    assert.equal(finalStatus.connected, false);
    assert.equal(finalStatus.webSessionStatus, 'spotify_web_session_unverified');
    assert.equal(finalStatus.connectionMethod, null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('ExternalSessionService: NETWORK_UNAVAILABLE does not erase valid stored credentials', async () => {
  const tmpDir = makeTempDir();
  const vaultPath = path.join(tmpDir, 'external-session.vault.json');
  const { api } = createMockSafeStorage({ available: true });

  let networkDown = false;
  const verifier = new ExternalSessionVerifier({
    fetchImpl: async () => {
      if (networkDown) {
        throw new Error('Network offline');
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: 'user-1', display_name: 'Persisted User' })
      };
    }
  });

  const service = new ExternalSessionService({
    vaultPath,
    safeStorage: api,
    verifier,
    pkceAuth: {
      authenticate: async () => ({
        authType: 'pkce',
        accessToken: 'valid-token',
        refreshToken: 'valid-refresh',
        expiresAt: Date.now() + 3600_000
      }),
      cancel: () => {}
    }
  });

  try {
    const loginStatus = await service.startPkceLogin();
    assert.equal(loginStatus.connected, true);
    assert.equal(fs.existsSync(vaultPath), true);

    // Simulate offline verification on restart
    networkDown = true;
    const serviceRestarted = new ExternalSessionService({
      vaultPath,
      safeStorage: api,
      verifier
    });
    const offlineStatus = await serviceRestarted.initialize();
    assert.equal(offlineStatus.sessionStatus, ExternalSessionStatus.NETWORK_UNAVAILABLE);
    assert.equal(offlineStatus.connected, true);
    assert.equal(fs.existsSync(vaultPath), true, 'vault file must remain intact when offline');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// 5. IPC Sender Validation & Zero Secret Leakage in main.js / preload.js
// ============================================================================

test('IPC: main.js enforces sender/frame validation and sanitizes all external-session responses', () => {
  const mainSrc = fs.readFileSync(path.join(ROOT_DIR, 'src', 'main', 'main.js'), 'utf8');
  const preloadSrc = fs.readFileSync(path.join(ROOT_DIR, 'src', 'main', 'preload.js'), 'utf8');

  // Sender + mainFrame validation
  assert.match(mainSrc, /function isValidMainWindowIpcSender\(event\)/);
  assert.match(mainSrc, /event\.sender !== wc/);
  assert.match(mainSrc, /frame !== wc\.mainFrame/);

  const channels = [
    'external-session:start-pkce',
    'external-session:start-pairing',
    'external-session:cancel-pairing',
    'external-session:get-status',
    'external-session:logout',
    'external-session:open-login-window',
    'external-session:get-profiles'
  ];

  for (const ch of channels) {
    const idx = mainSrc.indexOf(`ipcMain.handle('${ch}'`);
    assert.ok(idx !== -1, `Missing IPC handler for ${ch}`);
    const snippet = mainSrc.slice(idx, idx + 260);
    assert.ok(
      snippet.includes('isValidMainWindowIpcSender(event)'),
      `Handler ${ch} must validate sender via isValidMainWindowIpcSender(event)`
    );
  }

  // Sanitizer whitelist must not leak tokens, cookies, or vault paths
  const sanitizerMatch = mainSrc.match(/function sanitizeExternalSessionStatus\(status\)\s*\{[\s\S]*?\n\s*\}/);
  assert.ok(sanitizerMatch, 'sanitizeExternalSessionStatus must exist');
  const sanitizerBody = sanitizerMatch[0];
  for (const forbidden of ['accessToken', 'refreshToken', 'cookies', 'spDc', 'vaultPath']) {
    assert.ok(!sanitizerBody.includes(forbidden), `Sanitizer must not expose ${forbidden}`);
  }

  // Preload exposes expected APIs without raw ipcRenderer
  for (const apiName of [
    'externalSessionStartPkce',
    'externalSessionStartPairing',
    'externalSessionCancelPairing',
    'externalSessionGetStatus',
    'externalSessionLogout',
    'externalSessionOpenLoginWindow',
    'externalSessionGetProfiles',
    'onExternalSessionResult'
  ]) {
    assert.ok(preloadSrc.includes(`${apiName}:`), `preload.js missing ${apiName}`);
  }
});

test('Integration: Frontend ExternalSessionController -> Main external-session:start-pkce -> ExternalSessionService -> ExternalPkceAuth', async () => {
  const vm = require('node:vm');
  const appSrc = fs.readFileSync(path.join(ROOT_DIR, 'src', 'renderer', 'app.js'), 'utf8');
  const mainSrc = fs.readFileSync(path.join(ROOT_DIR, 'src', 'main', 'main.js'), 'utf8');

  // Extract initExternalSessionController IIFE from app.js
  const iifeStart = appSrc.indexOf('(function initExternalSessionController()');
  assert.ok(iifeStart !== -1, 'initExternalSessionController must exist in app.js');
  const iifeEnd = appSrc.indexOf('})();', iifeStart);
  assert.ok(iifeEnd !== -1, 'initExternalSessionController IIFE end must exist');
  const controllerCode = appSrc.slice(iifeStart, iifeEnd + 5);

  // Extract real external-session:start-pkce handler from main.js
  const handlerStart = mainSrc.indexOf("ipcMain.handle('external-session:start-pkce'");
  assert.ok(handlerStart !== -1, 'external-session:start-pkce handler must exist in main.js');
  const handlerEnd = mainSrc.indexOf("ipcMain.handle('external-session:start-pairing'", handlerStart);
  assert.ok(handlerEnd !== -1, 'external-session:start-pairing handler must follow start-pkce');
  const handlerSnippet = mainSrc.slice(handlerStart, handlerEnd);

  const tmpDir = makeTempDir('eclipse-pkce-int-');
  const vaultPath = path.join(tmpDir, 'external-session.vault.json');
  const { api: safeStorageApi } = createMockSafeStorage({ available: true });

  let openedAuthUrl = null;
  let startPkceIpcCalls = 0;

  const pkceAuth = new ExternalPkceAuth({
    timeoutMs: 5000,
    openExternal: async (authUrl) => {
      openedAuthUrl = authUrl;
      const parsed = new URL(authUrl);
      const redirectUri = parsed.searchParams.get('redirect_uri');
      const state = parsed.searchParams.get('state');
      await httpGet(`${redirectUri}?code=int-auth-code&state=${encodeURIComponent(state)}`);
    },
    fetchImpl: async (url) => {
      if (String(url).includes('/api/token')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'int-access-token',
            refresh_token: 'int-refresh-token',
            token_type: 'Bearer',
            expires_in: 3600
          })
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: 'int-user-1', display_name: 'Integration User' })
      };
    }
  });

  const verifier = new ExternalSessionVerifier({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: 'int-user-1', display_name: 'Integration User' })
    })
  });

  const externalSessionService = new ExternalSessionService({
    vaultPath,
    safeStorage: safeStorageApi,
    pkceAuth,
    verifier
  });

  let registeredStartPkceHandler = null;
  const mainSandbox = {
    ipcMain: {
      handle: (channel, fn) => {
        if (channel === 'external-session:start-pkce') {
          registeredStartPkceHandler = fn;
        }
      }
    },
    isValidMainWindowIpcSender: () => true,
    activeExternalOpId: null,
    externalSessionService,
    sanitizeExternalSessionStatus: (s) => s
  };
  vm.runInNewContext(handlerSnippet, mainSandbox);
  assert.equal(typeof registeredStartPkceHandler, 'function');

  // Minimal DOM + localStorage for ExternalSessionController
  function makeEl(id) {
    const classes = new Set(['hidden']);
    const listeners = {};
    return {
      id,
      value: '',
      checked: false,
      disabled: false,
      textContent: '',
      innerHTML: '',
      style: {},
      dataset: {},
      classList: {
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        toggle: (c, force) => (force === undefined ? (classes.has(c) ? classes.delete(c) : classes.add(c)) : (force ? classes.add(c) : classes.delete(c))),
        contains: (c) => classes.has(c)
      },
      addEventListener: (ev, fn) => {
        listeners[ev] = listeners[ev] || [];
        listeners[ev].push(fn);
      },
      click: () => (listeners.click || []).forEach((fn) => fn())
    };
  }

  const elements = new Map();
  for (const id of [
    'external-session-dialog',
    'chk-external-consent',
    'ext-session-error',
    'btn-ext-start-pkce',
    'sp-client-id',
    'ext-badge-pkce',
    'ext-badge-bridge',
    'ext-state-badge'
  ]) {
    elements.set(id, makeEl(id));
  }
  elements.get('chk-external-consent').checked = true;

  const storageMap = new Map();
  const windowObj = {
    eclipseAPI: {
      externalSessionGetStatus: async () => ({ state: 'unpaired', connected: false }),
      externalSessionStartPkce: async (opts) => {
        startPkceIpcCalls += 1;
        return registeredStartPkceHandler({}, opts);
      }
    }
  };

  const rendererSandbox = {
    window: windowObj,
    document: {
      getElementById: (id) => elements.get(id) || null,
      createElement: () => makeEl('dynamic')
    },
    localStorage: {
      getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
      setItem: (k, v) => storageMap.set(k, String(v))
    },
    navigator: {},
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout
  };

  try {
    vm.runInNewContext(controllerCode, rendererSandbox);
    const controller = windowObj.ExternalSessionController;
    assert.ok(controller, 'ExternalSessionController must be attached to window');
    await controller.syncStatus();

    // a) Missing/invalid Client ID shows actionable error in #ext-session-error and does NOT call IPC or openExternal
    storageMap.set('eclipse_spotify_client_id', 'invalid-short-id');
    await controller.startPkce();
    const errorBox = elements.get('ext-session-error');
    assert.match(errorBox.textContent, /32-character hex Client ID/i);
    assert.equal(errorBox.classList.contains('hidden'), false);
    assert.equal(startPkceIpcCalls, 0);
    assert.equal(openedAuthUrl, null);

    // b) Valid 32-hex Client ID reaches Main -> ExternalSessionService -> ExternalPkceAuth
    storageMap.set('eclipse_spotify_client_id', VALID_TEST_CLIENT_ID);
    await controller.startPkce();
    assert.equal(startPkceIpcCalls, 1);
    assert.ok(openedAuthUrl, 'openExternal must be called with authorization URL');

    const parsedAuth = new URL(openedAuthUrl);
    assert.equal(parsedAuth.searchParams.get('client_id'), VALID_TEST_CLIENT_ID);
    assert.equal(parsedAuth.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(parsedAuth.searchParams.get('state'));
    assert.match(parsedAuth.searchParams.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    assert.equal(controller.state, 'connected');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
