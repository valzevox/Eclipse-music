'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const { BrowserPairingServer } = require('../src/main/browser-login/browser-pairing-server');
const { BrowserLoginTarget } = require('../src/main/browser-login/browser-login-targets');
const { BrowserLoginFailure, BrowserLoginException } = require('../src/main/browser-login/browser-login-errors');
const {
  EXTERNAL_COOKIE_NAME,
  EXTERNAL_TARGET_HOST,
  isValidExternalCookieDomain,
  validateExternalSessionCookies
} = require('../src/main/browser-login/external-cookie-validator');
const {
  BrowserProfileRepository,
  RepositoryStatus,
  ALLOWED_TARGETS,
  validateTarget
} = require('../src/main/browser-login/browser-profile-repository');

const ROOT_DIR = path.resolve(__dirname, '..');
const EXT_DIR = path.join(ROOT_DIR, 'src', 'extensions', 'eclipse-connect');

function sendRawHttpRequest({ port, method = 'POST', reqPath = '/api/extension/pair', headers = {}, body = '' }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: reqPath,
        method,
        headers
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = raw ? JSON.parse(raw) : null;
          } catch (_) {}
          resolve({ status: res.statusCode, headers: res.headers, raw, json });
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ============================================================================
// 1. BrowserPairingServer
// ============================================================================

test('BrowserPairingServer: binds loopback-only and generates 32-byte hex nonce', async () => {
  const server = new BrowserPairingServer({ target: BrowserLoginTarget.EXTERNAL_WEB });
  try {
    const info = await server.start();
    assert.equal(server.server.address().address, '127.0.0.1');
    assert.equal(typeof info.port, 'number');
    assert.ok(info.port > 0);
    assert.match(info.nonce, /^[0-9a-f]{64}$/);
    assert.equal(info.target, BrowserLoginTarget.EXTERNAL_WEB);
  } finally {
    server.close();
  }
});

test('BrowserPairingServer: rejects non-loopback remoteAddress', async () => {
  const server = new BrowserPairingServer({ target: BrowserLoginTarget.EXTERNAL_WEB });
  await server.start();
  try {
    let statusCode = null;
    let body = '';
    const fakeReq = {
      socket: { remoteAddress: '192.168.1.50' },
      headers: { host: `127.0.0.1:${server.port}`, origin: 'null' },
      method: 'POST',
      url: '/api/extension/pair'
    };
    const fakeRes = {
      writeHead(code) { statusCode = code; },
      end(data) { body = data; }
    };
    server.handleRequest(fakeReq, fakeRes);
    assert.equal(statusCode, 403);
    assert.match(body, /loopback only/i);
  } finally {
    server.close();
  }
});

test('BrowserPairingServer: constant-time nonce comparison rejects wrong/short/prefix nonces', async () => {
  const src = fs.readFileSync(
    path.join(ROOT_DIR, 'src', 'main', 'browser-login', 'browser-pairing-server.js'),
    'utf8'
  );
  assert.ok(src.includes('crypto.timingSafeEqual'), 'must use crypto.timingSafeEqual');

  const server = new BrowserPairingServer({
    target: BrowserLoginTarget.EXTERNAL_WEB,
    isPackaged: false,
    allowNullOriginInDev: true
  });
  const { port, nonce } = await server.start();
  try {
    const wrongSameLen = (nonce[0] === 'a' ? 'b' : 'a') + nonce.slice(1);
    const res1 = await sendRawHttpRequest({
      port,
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: 'null',
        'Content-Type': 'application/json',
        'X-Eclipse-Nonce': wrongSameLen
      },
      body: JSON.stringify({ target: BrowserLoginTarget.EXTERNAL_WEB, cookies: [] })
    });
    assert.equal(res1.status, 401);

    const res2 = await sendRawHttpRequest({
      port,
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: 'null',
        'Content-Type': 'application/json',
        'X-Eclipse-Nonce': nonce.slice(0, 16)
      },
      body: JSON.stringify({ target: BrowserLoginTarget.EXTERNAL_WEB, cookies: [] })
    });
    assert.equal(res2.status, 401);
  } finally {
    server.close();
  }
});

test('BrowserPairingServer: exact Host + Origin validation in production vs dev', async () => {
  const prodAllowedId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const devOnlyId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

  const prodServer = new BrowserPairingServer({
    target: BrowserLoginTarget.EXTERNAL_WEB,
    isPackaged: true,
    allowedExtensionIds: [prodAllowedId]
  });
  const prodInfo = await prodServer.start();
  try {
    // Wrong Host header
    const badHost = await sendRawHttpRequest({
      port: prodInfo.port,
      headers: {
        Host: 'evil.example:1234',
        Origin: `chrome-extension://${prodAllowedId}`,
        'Content-Type': 'application/json'
      },
      body: '{}'
    });
    assert.equal(badHost.status, 403);

    // Production rejects Origin: null, missing, malformed, unknown ID
    for (const badOrigin of [
      'null',
      undefined,
      'https://open.spotify.com',
      'chrome-extension://not-valid!',
      `chrome-extension://${devOnlyId}`
    ]) {
      const headers = {
        Host: `127.0.0.1:${prodInfo.port}`,
        'Content-Type': 'application/json'
      };
      if (badOrigin !== undefined) headers.Origin = badOrigin;
      const res = await sendRawHttpRequest({ port: prodInfo.port, headers, body: '{}' });
      assert.equal(res.status, 403, `Expected 403 for origin=${String(badOrigin)}`);
      assert.equal(res.json.error, BrowserLoginFailure.ORIGIN_REJECTED);
    }

    // Production allows configured extension ID
    const okPreflight = await sendRawHttpRequest({
      port: prodInfo.port,
      method: 'OPTIONS',
      headers: {
        Host: `127.0.0.1:${prodInfo.port}`,
        Origin: `chrome-extension://${prodAllowedId}`
      }
    });
    assert.equal(okPreflight.status, 204);
  } finally {
    prodServer.close();
  }

  // Packaged build with empty allowedExtensionIds allows valid [a-p]{32} Chrome extension IDs with exact nonce,
  // while rejecting Origin: null, missing Origin, and non-[a-p]{32} extension IDs
  const packagedUnpackedServer = new BrowserPairingServer({
    target: BrowserLoginTarget.EXTERNAL_WEB,
    isPackaged: true,
    allowedExtensionIds: []
  });
  const pkgInfo = await packagedUnpackedServer.start();
  try {
    for (const badOrigin of [
      'null',
      undefined,
      'chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz',
      'chrome-extension://shortid'
    ]) {
      const headers = { Host: `127.0.0.1:${pkgInfo.port}`, 'Content-Type': 'application/json' };
      if (badOrigin !== undefined) headers.Origin = badOrigin;
      const res = await sendRawHttpRequest({ port: pkgInfo.port, headers, body: '{}' });
      assert.equal(res.status, 403, `Expected 403 for origin=${String(badOrigin)}`);
    }

    const okRes = await sendRawHttpRequest({
      port: pkgInfo.port,
      headers: {
        Host: `127.0.0.1:${pkgInfo.port}`,
        Origin: `chrome-extension://${devOnlyId}`,
        'Content-Type': 'application/json',
        'X-Eclipse-Nonce': pkgInfo.nonce
      },
      body: JSON.stringify({
        target: BrowserLoginTarget.EXTERNAL_WEB,
        cookies: [{ name: 'sp_dc', value: 'valid-sp-dc', domain: 'open.spotify.com', path: '/', secure: true }]
      })
    });
    assert.equal(okRes.status, 200);
    assert.equal(okRes.json.success, true);
  } finally {
    packagedUnpackedServer.close();
  }

  // Dev mode allows dev extension IDs and null origin only when !isPackaged
  const devServer = new BrowserPairingServer({
    target: BrowserLoginTarget.EXTERNAL_WEB,
    isPackaged: false,
    allowNullOriginInDev: true
  });
  const devInfo = await devServer.start();
  try {
    const devExtPreflight = await sendRawHttpRequest({
      port: devInfo.port,
      method: 'OPTIONS',
      headers: {
        Host: `127.0.0.1:${devInfo.port}`,
        Origin: `chrome-extension://${devOnlyId}`
      }
    });
    assert.equal(devExtPreflight.status, 204);

    const devNullPreflight = await sendRawHttpRequest({
      port: devInfo.port,
      method: 'OPTIONS',
      headers: {
        Host: `127.0.0.1:${devInfo.port}`,
        Origin: 'null'
      }
    });
    assert.equal(devNullPreflight.status, 204);
  } finally {
    devServer.close();
  }
});

test('BrowserPairingServer: CORS/OPTIONS preflight headers and invalid origin rejection', async () => {
  const extId = 'cccccccccccccccccccccccccccccccc';
  const server = new BrowserPairingServer({
    target: BrowserLoginTarget.EXTERNAL_WEB,
    isPackaged: true,
    allowedExtensionIds: [extId]
  });
  const { port } = await server.start();
  try {
    const valid = await sendRawHttpRequest({
      port,
      method: 'OPTIONS',
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: `chrome-extension://${extId}`
      }
    });
    assert.equal(valid.status, 204);
    assert.equal(valid.headers['access-control-allow-origin'], `chrome-extension://${extId}`);
    assert.match(valid.headers['access-control-allow-methods'], /POST/);
    assert.match(valid.headers['access-control-allow-headers'], /X-Eclipse-Nonce/i);
    assert.equal(valid.headers['vary'], 'Origin');

    const invalid = await sendRawHttpRequest({
      port,
      method: 'OPTIONS',
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: 'https://attacker.example'
      }
    });
    assert.equal(invalid.status, 403);
    assert.equal(invalid.headers['access-control-allow-origin'], undefined);
  } finally {
    server.close();
  }
});

test('BrowserPairingServer: rate limit returns 429 after exceeding rateLimitMax', async () => {
  const server = new BrowserPairingServer({
    target: BrowserLoginTarget.EXTERNAL_WEB,
    isPackaged: false,
    rateLimitMax: 3,
    rateLimitWindowMs: 60000
  });
  const { port } = await server.start();
  try {
    for (let i = 0; i < 3; i += 1) {
      const res = await sendRawHttpRequest({
        port,
        headers: {
          Host: `127.0.0.1:${port}`,
          Origin: 'null',
          'Content-Type': 'application/json',
          'X-Eclipse-Nonce': '0'.repeat(64)
        },
        body: '{}'
      });
      assert.equal(res.status, 401);
    }
    const limited = await sendRawHttpRequest({
      port,
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: 'null',
        'Content-Type': 'application/json',
        'X-Eclipse-Nonce': '0'.repeat(64)
      },
      body: '{}'
    });
    assert.equal(limited.status, 429);
  } finally {
    server.close();
  }
});

test('BrowserPairingServer: maxRedeemAttempts locks pairing and closes server', async () => {
  const server = new BrowserPairingServer({
    target: BrowserLoginTarget.EXTERNAL_WEB,
    isPackaged: false,
    maxRedeemAttempts: 2,
    rateLimitMax: 50
  });
  const { port } = await server.start();
  try {
    const r1 = await sendRawHttpRequest({
      port,
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: 'null',
        'Content-Type': 'application/json',
        'X-Eclipse-Nonce': '1'.repeat(64)
      },
      body: '{}'
    });
    assert.equal(r1.status, 401);

    const r2 = await sendRawHttpRequest({
      port,
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: 'null',
        'Content-Type': 'application/json',
        'X-Eclipse-Nonce': '2'.repeat(64)
      },
      body: '{}'
    });
    assert.equal(r2.status, 429);
    assert.equal(server.locked, true);
  } finally {
    server.close();
  }
});

test('BrowserPairingServer: bounded streaming body rejects >512KB payload', async () => {
  const server = new BrowserPairingServer({
    target: BrowserLoginTarget.EXTERNAL_WEB,
    isPackaged: false
  });
  const { port, nonce } = await server.start();
  try {
    const oversized = JSON.stringify({
      target: BrowserLoginTarget.EXTERNAL_WEB,
      pad: 'x'.repeat(520 * 1024)
    });
    await assert.rejects(
      () => sendRawHttpRequest({
        port,
        headers: {
          Host: `127.0.0.1:${port}`,
          Origin: 'null',
          'Content-Type': 'application/json',
          'X-Eclipse-Nonce': nonce
        },
        body: oversized
      }),
      (err) => err && (err.code === 'ECONNRESET' || err.code === 'EPIPE' || /socket hang up/i.test(err.message))
    );
  } finally {
    server.close();
  }
});

test('BrowserPairingServer: challenge expiry and cancel', async () => {
  const server = new BrowserPairingServer({
    target: BrowserLoginTarget.EXTERNAL_WEB,
    isPackaged: false,
    timeoutMs: 5000
  });
  const { port, nonce } = await server.start();
  try {
    server.expiresAt = Date.now() - 10;
    const expiredRes = await sendRawHttpRequest({
      port,
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: 'null',
        'Content-Type': 'application/json',
        'X-Eclipse-Nonce': nonce
      },
      body: JSON.stringify({ target: BrowserLoginTarget.EXTERNAL_WEB, cookies: [] })
    });
    assert.equal(expiredRes.status, 400);
    assert.equal(expiredRes.json.error, BrowserLoginFailure.PAIRING_EXPIRED);

    server.close(BrowserLoginFailure.PAIRING_CANCELLED);
    assert.equal(server.active, false);
  } finally {
    server.close();
  }
});

test('BrowserPairingServer: wrong target rejected, valid EXTERNAL_WEB accepted once, zero cookie leakage', async () => {
  const secretCookieValue = 'SECRET_SP_DC_TOKEN_DO_NOT_LEAK_987654';
  let receivedRecords = null;

  const server = new BrowserPairingServer({
    target: BrowserLoginTarget.EXTERNAL_WEB,
    isPackaged: false,
    onCookiesReceived: async (records) => {
      receivedRecords = records;
      return { account: { displayName: 'Test User' } };
    }
  });
  const { port, nonce } = await server.start();
  try {
    // Wrong target rejected
    const wrongTarget = await sendRawHttpRequest({
      port,
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: 'null',
        'Content-Type': 'application/json',
        'X-Eclipse-Nonce': nonce
      },
      body: JSON.stringify({
        version: 1,
        target: BrowserLoginTarget.YOUTUBE,
        cookies: [{ name: 'sp_dc', value: secretCookieValue, domain: 'open.spotify.com', secure: true }]
      })
    });
    assert.equal(wrongTarget.status, 400);
    assert.equal(wrongTarget.json.error, BrowserLoginFailure.INVALID_DATA);
    assert.equal(wrongTarget.raw.includes(secretCookieValue), false);

    // Valid EXTERNAL_WEB payload accepted once
    const validRes = await sendRawHttpRequest({
      port,
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: 'null',
        'Content-Type': 'application/json',
        'X-Eclipse-Nonce': nonce
      },
      body: JSON.stringify({
        version: 1,
        target: BrowserLoginTarget.EXTERNAL_WEB,
        cookies: [{
          name: 'sp_dc',
          value: secretCookieValue,
          domain: 'open.spotify.com',
          path: '/',
          secure: true,
          httpOnly: true,
          hostOnly: true
        }]
      })
    });
    assert.equal(validRes.status, 200);
    assert.equal(validRes.json.success, true);
    assert.equal(validRes.raw.includes(secretCookieValue), false);
    assert.ok(Array.isArray(receivedRecords) && receivedRecords.length === 1);
    assert.equal(receivedRecords[0].name, 'sp_dc');

    // Replay rejected
    const replayRes = await sendRawHttpRequest({
      port,
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: 'null',
        'Content-Type': 'application/json',
        'X-Eclipse-Nonce': nonce
      },
      body: JSON.stringify({
        version: 1,
        target: BrowserLoginTarget.EXTERNAL_WEB,
        cookies: [{ name: 'sp_dc', value: secretCookieValue, domain: 'open.spotify.com', secure: true }]
      })
    });
    assert.equal(replayRes.status, 400);
    assert.equal(replayRes.json.error, BrowserLoginFailure.PAIRING_REPLAYED);
    assert.equal(replayRes.raw.includes(secretCookieValue), false);
  } finally {
    server.close();
  }
});

// ============================================================================
// 2. external-cookie-validator.js
// ============================================================================

test('external-cookie-validator: accepts valid sp_dc and preserves session cookie null expiry', () => {
  const now = 1700000000;
  const valid = validateExternalSessionCookies([
    {
      name: EXTERNAL_COOKIE_NAME,
      value: 'valid_token_abc',
      domain: EXTERNAL_TARGET_HOST,
      path: '/',
      secure: true,
      httpOnly: true,
      hostOnly: true,
      expirationDate: now + 3600
    }
  ], { nowSeconds: now });

  assert.equal(valid.name, 'sp_dc');
  assert.equal(valid.value, 'valid_token_abc');
  assert.equal(valid.domain, 'open.spotify.com');
  assert.equal(valid.secure, true);
  assert.equal(valid.expiry, now + 3600);

  // Session cookie (null/undefined expiry preserved as null)
  const sessionCookie = validateExternalSessionCookies([
    {
      name: EXTERNAL_COOKIE_NAME,
      value: 'session_token_xyz',
      domain: '.spotify.com',
      path: '/',
      secure: true,
      httpOnly: true,
      hostOnly: false
    }
  ], { nowSeconds: now });
  assert.equal(sessionCookie.expiry, null);
  assert.equal(sessionCookie.domain, '.spotify.com');
});

test('external-cookie-validator: rejects missing, empty, insecure, invalid domain, expired, conflicting duplicates', () => {
  const now = 1700000000;
  const secret = 'SENSITIVE_COOKIE_VALUE_12345';

  // Missing
  assert.throws(
    () => validateExternalSessionCookies([]),
    (err) => err instanceof BrowserLoginException && err.reason === BrowserLoginFailure.COOKIE_FORMAT_INVALID
  );
  assert.throws(
    () => validateExternalSessionCookies([{ name: 'other', value: 'x', domain: 'open.spotify.com', secure: true }]),
    (err) => err instanceof BrowserLoginException && err.reason === BrowserLoginFailure.COOKIE_FORMAT_INVALID
  );

  // Empty
  assert.throws(
    () => validateExternalSessionCookies([{ name: 'sp_dc', value: '   ', domain: 'open.spotify.com', secure: true }]),
    (err) => err instanceof BrowserLoginException && err.reason === BrowserLoginFailure.COOKIE_FORMAT_INVALID
  );

  // Insecure
  assert.throws(
    () => validateExternalSessionCookies([{ name: 'sp_dc', value: secret, domain: 'open.spotify.com', secure: false }]),
    (err) => err instanceof BrowserLoginException && err.reason === BrowserLoginFailure.COOKIE_FORMAT_INVALID && !err.message.includes(secret)
  );

  // Invalid domain boundary
  assert.equal(isValidExternalCookieDomain('spotify.com.attacker.example'), false);
  assert.equal(isValidExternalCookieDomain('evilspotify.com'), false);
  assert.throws(
    () => validateExternalSessionCookies([{ name: 'sp_dc', value: secret, domain: 'spotify.com.attacker.example', secure: true }]),
    (err) => err instanceof BrowserLoginException && err.reason === BrowserLoginFailure.COOKIE_FORMAT_INVALID && !err.message.includes(secret)
  );

  // Expired
  assert.throws(
    () => validateExternalSessionCookies([{
      name: 'sp_dc',
      value: secret,
      domain: 'open.spotify.com',
      secure: true,
      expiry: now - 10
    }], { nowSeconds: now }),
    (err) => err instanceof BrowserLoginException && err.reason === BrowserLoginFailure.COOKIE_FORMAT_INVALID
  );

  // Conflicting duplicates
  assert.throws(
    () => validateExternalSessionCookies([
      { name: 'sp_dc', value: 'val_one', domain: 'open.spotify.com', secure: true },
      { name: 'sp_dc', value: 'val_two', domain: '.spotify.com', secure: true }
    ], { nowSeconds: now }),
    (err) => err instanceof BrowserLoginException && err.reason === BrowserLoginFailure.COOKIE_FORMAT_INVALID
  );
});

// ============================================================================
// 3. BrowserProfileRepository
// ============================================================================

test('BrowserProfileRepository: opaque profileId, target allowlist, target switch invalidation, serialized imports, COOKIES_FOUND !== CONNECTED', async () => {
  const nativePath = 'C:\\Users\\TestUser\\AppData\\Local\\Google\\Chrome\\User Data\\Default';
  const repo = new BrowserProfileRepository({
    discoverProfiles: async (target) => [
      {
        browser: 'Chrome',
        type: 'chromium',
        profileName: 'Default',
        profilePath: nativePath,
        cookieDbPath: path.join(nativePath, 'Network', 'Cookies'),
        isDefault: true,
        requiresExtension: false,
        status: RepositoryStatus.COOKIES_FOUND,
        target
      }
    ]
  });

  // Target allowlist
  assert.deepEqual(ALLOWED_TARGETS, [BrowserLoginTarget.YOUTUBE, BrowserLoginTarget.EXTERNAL_WEB]);
  assert.equal(validateTarget(BrowserLoginTarget.EXTERNAL_WEB), BrowserLoginTarget.EXTERNAL_WEB);
  assert.throws(() => validateTarget('https://evil.example'), BrowserLoginException);
  assert.throws(() => validateTarget('OTHER'), BrowserLoginException);

  // Opaque profileId (no native path exposed) and COOKIES_FOUND !== CONNECTED
  const list = await repo.refreshProfiles(BrowserLoginTarget.EXTERNAL_WEB);
  assert.equal(list.length, 1);
  assert.match(list[0].profileId, /^prof_/);
  assert.equal(JSON.stringify(list).includes(nativePath), false);
  assert.equal(list[0].profilePath, undefined);
  assert.equal(list[0].cookieDbPath, undefined);
  assert.equal(repo.getStatus(), RepositoryStatus.COOKIES_FOUND);
  assert.notEqual(repo.getStatus(), RepositoryStatus.CONNECTED);

  // Serialized concurrent imports: second call while first is active must reject
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const firstImport = repo.importSelectedProfile(list[0].profileId, BrowserLoginTarget.EXTERNAL_WEB, async () => {
    await firstGate;
    return { success: true, account: { id: 'u1' } };
  });

  await assert.rejects(
    () => repo.importSelectedProfile(list[0].profileId, BrowserLoginTarget.EXTERNAL_WEB, async () => ({ success: true })),
    (err) => err instanceof BrowserLoginException && err.reason === BrowserLoginFailure.INVALID_DATA
  );

  releaseFirst();
  const firstResult = await firstImport;
  assert.equal(firstResult.status, RepositoryStatus.CONNECTED);
  assert.equal(firstResult.connected, true);
  assert.equal(repo.getStatus(), RepositoryStatus.CONNECTED);

  // Target switch invalidates stale results
  const staleId = list[0].profileId;
  const switched = repo.profiles(BrowserLoginTarget.YOUTUBE);
  assert.deepEqual(switched, []);
  await assert.rejects(
    () => repo.importSelectedProfile(staleId, BrowserLoginTarget.YOUTUBE, async () => ({ success: true })),
    (err) => err instanceof BrowserLoginException && err.reason === BrowserLoginFailure.INVALID_DATA
  );
});

// ============================================================================
// 4. Extension MV3 & build-extension.js
// ============================================================================

test('Extension MV3 manifest, popup.js permission timing & zero storage, and build-extension.js', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.ok(Array.isArray(manifest.optional_permissions) && manifest.optional_permissions.includes('cookies'));
  assert.equal(Array.isArray(manifest.permissions) && manifest.permissions.includes('cookies'), false);
  assert.ok(Array.isArray(manifest.optional_host_permissions));
  assert.ok(manifest.optional_host_permissions.includes('http://127.0.0.1/*'));
  assert.ok(manifest.optional_host_permissions.includes('https://open.spotify.com/*'));
  assert.equal(manifest.optional_host_permissions.some((p) => p.includes('*.spotify.com')), false);
  assert.equal((manifest.host_permissions || []).some((p) => p.includes('*.spotify.com')), false);

  const popupSrc = fs.readFileSync(path.join(EXT_DIR, 'popup.js'), 'utf8');
  const clickIdx = popupSrc.indexOf("btnPair.addEventListener('click'");
  const reqIdx = popupSrc.indexOf('api.permissions.request(', clickIdx);
  const firstAwaitIdx = popupSrc.indexOf('await ', clickIdx);
  assert.ok(clickIdx !== -1 && reqIdx !== -1 && firstAwaitIdx !== -1);
  assert.ok(reqIdx < firstAwaitIdx, 'permissions.request must be called synchronously before any await');

  // Never stores cookies in storage
  assert.equal(/localStorage|sessionStorage|chrome\.storage|browser\.storage/.test(popupSrc), false);

  // build-extension.js exports buildExtensionZip and validates MV3 rules
  const buildExtSrc = fs.readFileSync(path.join(ROOT_DIR, 'scripts', 'build-extension.js'), 'utf8');
  assert.ok(buildExtSrc.includes('optional_permissions'));
  assert.ok(buildExtSrc.includes('optional_host_permissions'));
  assert.ok(buildExtSrc.includes('*.spotify.com'));
});

test('BrowserPairingServer: returns UNVERIFIED_WEB_SESSION payload when onCookiesReceived returns webSessionUnverified: true', async () => {
  const server = new BrowserPairingServer({
    target: BrowserLoginTarget.EXTERNAL_WEB,
    isPackaged: false,
    onCookiesReceived: async () => ({
      account: { displayName: 'Unverified Web', webSessionStatus: 'spotify_web_session_unverified' },
      webSessionUnverified: true
    })
  });
  const { port, nonce } = await server.start();
  try {
    const res = await sendRawHttpRequest({
      port,
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: 'null',
        'Content-Type': 'application/json',
        'X-Eclipse-Nonce': nonce
      },
      body: JSON.stringify({
        version: 1,
        target: BrowserLoginTarget.EXTERNAL_WEB,
        cookies: [{ name: 'sp_dc', value: 'unverified-cookie-val', domain: 'open.spotify.com', secure: true }]
      })
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.success, true);
    assert.equal(res.json.transferAccepted, true);
    assert.equal(res.json.authenticated, false);
    assert.equal(res.json.sessionStatus, 'UNVERIFIED_WEB_SESSION');
  } finally {
    server.close();
  }
});

test('Extension popup.js: displays unverified warning instead of Connected successfully! when transferAccepted and unverified', async () => {
  const vm = require('node:vm');
  const popupSrc = fs.readFileSync(path.join(EXT_DIR, 'popup.js'), 'utf8');

  assert.ok(
    popupSrc.includes("resJson.transferAccepted && (resJson.authenticated === false || resJson.sessionStatus === 'UNVERIFIED_WEB_SESSION')"),
    'popup.js must check transferAccepted and unverified session flags'
  );

  function makeEl(id, initialValue = '') {
    const listeners = {};
    return {
      id,
      value: initialValue,
      disabled: false,
      textContent: '',
      className: '',
      style: {},
      addEventListener: (ev, fn) => {
        listeners[ev] = listeners[ev] || [];
        listeners[ev].push(fn);
      },
      click: async () => {
        for (const fn of listeners.click || []) {
          await fn();
        }
      }
    };
  }

  const els = {
    service: makeEl('service', 'external_web'),
    'cookie-notice': makeEl('cookie-notice'),
    port: makeEl('port', '25123'),
    nonce: makeEl('nonce', 'a'.repeat(64)),
    'btn-pair': makeEl('btn-pair'),
    'missing-session-actions': makeEl('missing-session-actions'),
    'btn-open-login': makeEl('btn-open-login'),
    'btn-scan-again': makeEl('btn-scan-again'),
    status: makeEl('status')
  };

  let domReadyHandler = null;
  const sandbox = {
    chrome: {
      permissions: { request: async () => true },
      cookies: {
        getAll: async () => [{
          name: 'sp_dc',
          value: 'test-sp-dc',
          domain: 'open.spotify.com',
          path: '/',
          secure: true,
          httpOnly: true,
          hostOnly: true
        }]
      }
    },
    window: {
      location: { search: '' },
      close: () => {}
    },
    document: {
      getElementById: (id) => els[id] || null,
      addEventListener: (ev, fn) => {
        if (ev === 'DOMContentLoaded') domReadyHandler = fn;
      }
    },
    fetch: async () => ({
      ok: true,
      json: async () => ({
        success: true,
        transferAccepted: true,
        authenticated: false,
        sessionStatus: 'UNVERIFIED_WEB_SESSION'
      })
    }),
    URLSearchParams,
    setTimeout,
    clearTimeout
  };

  vm.runInNewContext(popupSrc, sandbox);
  assert.equal(typeof domReadyHandler, 'function');
  domReadyHandler();

  await els['btn-pair'].click();
  assert.match(els.status.textContent, /unverified/i);
  assert.equal(els.status.textContent.includes('Connected successfully!'), false);
  assert.equal(els.status.className, 'status warning');
});
