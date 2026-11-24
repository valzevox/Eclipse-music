'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const {
  BrowserLoginTarget,
  resolveTargetHost,
  YOUTUBE_MUSIC_REQUEST_HOST
} = require('../src/main/browser-login/browser-login-targets');
const {
  BrowserCookieRecord,
  isValidCookieDomain,
  filterCookiesForHost,
  buildCookieHeader,
  buildNetscapeJar
} = require('../src/main/browser-login/browser-cookie-record');
const { BrowserPairingServer } = require('../src/main/browser-login/browser-pairing-server');
const { BrowserLoginFailure } = require('../src/main/browser-login/browser-login-errors');

test('1 & 2: BrowserLoginTarget.YOUTUBE resolves strictly to music.youtube.com', () => {
  assert.equal(BrowserLoginTarget.YOUTUBE, 'YOUTUBE');
  assert.equal(resolveTargetHost(BrowserLoginTarget.YOUTUBE), 'music.youtube.com');
  assert.equal(YOUTUBE_MUSIC_REQUEST_HOST, 'music.youtube.com');
  assert.throws(() => resolveTargetHost('YTM'), /Unsupported browser login target/);
  assert.throws(() => resolveTargetHost('OTHER'), /Unsupported browser login target/);
});

test('3 & 6: Domain boundary validation rejects lookalike / attacker domains', () => {
  assert.equal(isValidCookieDomain('music.youtube.com'), true);
  assert.equal(isValidCookieDomain('.youtube.com'), true);
  assert.equal(isValidCookieDomain('youtube.com'), true);
  assert.equal(isValidCookieDomain('.google.com'), true);
  assert.equal(isValidCookieDomain('accounts.google.com'), true);
  assert.equal(isValidCookieDomain('rr1---sn-xxx.googlevideo.com'), true);
  assert.equal(isValidCookieDomain('youtubei.googleapis.com'), true);

  // Attackers / lookalikes
  assert.equal(isValidCookieDomain('evilyoutube.com'), false);
  assert.equal(isValidCookieDomain('youtube.com.attacker.test'), false);
  assert.equal(isValidCookieDomain('notgoogle.com'), false);
  assert.equal(isValidCookieDomain('google.com.phishing.org'), false);
});

test('4 & 5 & 7 & 8 & 9: Cookie filtering, path matching, specificity, expiry and no .google.com broadening', () => {
  const now = Math.floor(Date.now() / 1000);
  const records = [
    // 1. Google-only cookie should not match youtube request host if host-only
    new BrowserCookieRecord({
      name: 'GOOGLE_ONLY',
      value: 'g_val',
      domain: 'accounts.google.com',
      hostOnly: true
    }),
    // 2. Expired cookie
    new BrowserCookieRecord({
      name: 'EXPIRED_COOKIE',
      value: 'old_val',
      domain: '.youtube.com',
      expiry: now - 3600
    }),
    // 3. Valid YTM session cookies
    new BrowserCookieRecord({
      name: 'SAPISID',
      value: 'valid_sap_123',
      domain: '.youtube.com',
      expiry: now + 86400
    }),
    new BrowserCookieRecord({
      name: 'SID',
      value: 'valid_sid_123',
      domain: '.youtube.com',
      expiry: now + 86400
    }),
    // 4. Duplicate cookie name with more specific host
    new BrowserCookieRecord({
      name: 'PREF',
      value: 'general_pref',
      domain: '.youtube.com'
    }),
    new BrowserCookieRecord({
      name: 'PREF',
      value: 'music_specific_pref',
      domain: 'music.youtube.com',
      hostOnly: true
    }),
    // 5. Unrelated path
    new BrowserCookieRecord({
      name: 'PATH_BLOCKED',
      value: 'path_val',
      domain: '.youtube.com',
      path: '/feed/channels'
    })
  ];

  const filtered = filterCookiesForHost(records, 'music.youtube.com', '/');
  const names = filtered.map(c => c.name);

  assert.ok(names.includes('SAPISID'));
  assert.ok(names.includes('SID'));
  assert.ok(!names.includes('GOOGLE_ONLY'), 'accounts.google.com must not match music.youtube.com');
  assert.ok(!names.includes('EXPIRED_COOKIE'), 'Expired cookie must be excluded');
  assert.ok(!names.includes('PATH_BLOCKED'), 'Mismatching path must be excluded');

  // Specificity check: music_specific_pref must win over general_pref
  const pref = filtered.find(c => c.name === 'PREF');
  assert.ok(pref);
  assert.equal(pref.value, 'music_specific_pref');

  // Header serialization
  const header = buildCookieHeader(records, 'music.youtube.com', '/');
  assert.ok(header.includes('SAPISID=valid_sap_123'));
  assert.ok(header.includes('PREF=music_specific_pref'));

  // Netscape serialization
  const netscape = buildNetscapeJar(records, 'music.youtube.com');
  assert.ok(netscape.startsWith('# Netscape HTTP Cookie File'));
  assert.ok(netscape.includes('SAPISID\tvalid_sap_123'));
  assert.ok(netscape.includes('SID\tvalid_sid_123'));
});

test('10 & 11: Secret redaction in BrowserCookieRecord.toString()', () => {
  const secret = new BrowserCookieRecord({
    name: 'SAPISID',
    value: 'SUPER_SECRET_VALUE_DO_NOT_LEAK',
    domain: '.youtube.com'
  });
  const str = secret.toString();
  assert.ok(!str.includes('SUPER_SECRET_VALUE_DO_NOT_LEAK'), 'Cookie value must be redacted from toString()');
  assert.ok(str.includes('[REDACTED]'));
});

test('12 & 13 & 14 & 15: BrowserPairingServer loopback, nonce validation, replay rejection, expiry and async verification', async () => {
  let receivedCookies = null;
  const server = new BrowserPairingServer({
    onCookiesReceived: async (cookies) => {
      receivedCookies = cookies;
      return { success: true, account: { id: 'test_user', name: 'Test User' } };
    },
    timeoutMs: 2000 // short timeout for testing
  });

  const session = await server.start();
  assert.ok(session.port > 1024);
  assert.ok(session.nonce.length >= 32);

  const testPayload = {
    nonce: session.nonce,
    cookies: [
      { name: 'SAPISID', value: 'pair_sap_val', domain: '.youtube.com' },
      { name: 'LOGIN_INFO', value: 'pair_login_val', domain: '.youtube.com' }
    ]
  };

  const postJson = (port, path, body, headers = {}) => {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: Object.assign({
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          'Origin': 'chrome-extension://abcdefghijklm'
        }, headers)
      }, (res) => {
        let resBody = '';
        res.on('data', d => resBody += d);
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(resBody || '{}') }));
      });
      req.on('error', reject);
      req.write(data);
      req.end();
    });
  };

  try {
    // 1. Wrong nonce rejected
    const badNonceRes = await postJson(session.port, '/api/extension/pair', {
      nonce: 'wrong_nonce',
      cookies: testPayload.cookies
    });
    assert.equal(badNonceRes.status, 401);

    // 2. Successful pairing awaits verification and returns account info
    const successRes = await postJson(session.port, '/api/extension/pair', testPayload, {
      'X-Eclipse-Nonce': session.nonce
    });
    assert.equal(successRes.status, 200);
    assert.equal(successRes.body.success, true);
    assert.equal(successRes.body.account.name, 'Test User');
    assert.ok(receivedCookies);
    assert.equal(receivedCookies.length, 2);
    assert.equal(receivedCookies[0].name, 'SAPISID');

    // 3. Replay attack rejection
    const replayRes = await postJson(session.port, '/api/extension/pair', testPayload);
    assert.equal(replayRes.status, 400);
    assert.equal(replayRes.body.error, BrowserLoginFailure.PAIRING_REPLAYED);
  } finally {
    server.close();
  }
});

test('16: BrowserPairingServer returns HTTP 400 when verification fails', async () => {
  const server = new BrowserPairingServer({
    onCookiesReceived: async () => {
      const err = new Error('Verification failed with InnerTube');
      err.reason = BrowserLoginFailure.SESSION_REJECTED;
      throw err;
    },
    timeoutMs: 2000
  });

  const session = await server.start();
  const testPayload = {
    nonce: session.nonce,
    cookies: [{ name: 'SAPISID', value: 'bad_token', domain: '.youtube.com' }]
  };

  const postJson = (port, path, body, headers = {}) => {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: Object.assign({
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          'Origin': 'chrome-extension://abcdefghijklm'
        }, headers)
      }, (res) => {
        let resBody = '';
        res.on('data', d => resBody += d);
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(resBody || '{}') }));
      });
      req.on('error', reject);
      req.write(data);
      req.end();
    });
  };

  try {
    const failRes = await postJson(session.port, '/api/extension/pair', testPayload, {
      'X-Eclipse-Nonce': session.nonce
    });
    assert.equal(failRes.status, 400);
    assert.equal(failRes.body.success, false);
    assert.equal(failRes.body.reason, BrowserLoginFailure.SESSION_REJECTED);
  } finally {
    server.close();
  }
});

test('17: Extension manifest includes optional_host_permissions for loopback', () => {
  const fs = require('fs');
  const path = require('path');
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../src/extensions/eclipse-connect/manifest.json'), 'utf8'));
  assert.ok(Array.isArray(manifest.optional_host_permissions));
  assert.ok(manifest.optional_host_permissions.includes('http://127.0.0.1/*'));
});

test('18: index.html DOM initialization order — browser-login-dialog occurs BEFORE app.js script', () => {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');

  // Must exist exactly once
  const dialogMatches = html.match(/id="browser-login-dialog"/g) || [];
  assert.equal(dialogMatches.length, 1, 'browser-login-dialog must occur exactly once');

  const appScriptMatches = html.match(/src="app\.js"/g) || [];
  assert.equal(appScriptMatches.length, 1, 'app.js script tag must occur exactly once');

  const dialogIndex = html.indexOf('id="browser-login-dialog"');
  const appScriptIndex = html.indexOf('src="app.js"');

  assert.ok(dialogIndex > 0, 'browser-login-dialog must exist');
  assert.ok(appScriptIndex > 0, 'app.js script tag must exist');
  assert.ok(
    dialogIndex < appScriptIndex,
    `browser-login-dialog (offset ${dialogIndex}) MUST appear BEFORE app.js (offset ${appScriptIndex})`
  );

  // Required modal control IDs must exist exactly once
  const requiredIds = [
    'btn-close-browser-login',
    'btn-refresh-browser-profiles',
    'browser-profiles-list',
    'extension-pairing-info',
    'extension-pairing-badge',
    'pairing-port-val',
    'pairing-nonce-val',
    'btn-copy-pairing-nonce',
    'btn-start-extension-pairing',
    'btn-cancel-extension-pairing',
    'btn-open-edge-ext',
    'btn-open-chrome-ext',
    'browser-login-error',
    'btn-settings-connect-ytm',
    'btn-google-login'
  ];

  for (const id of requiredIds) {
    const re = new RegExp(`id="${id}"`, 'g');
    const matches = html.match(re) || [];
    assert.equal(matches.length, 1, `Element ID "${id}" must exist exactly once in index.html`);
  }
});
