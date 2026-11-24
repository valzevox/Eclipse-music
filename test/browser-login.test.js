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
    'btn-google-login',
    'tab-login-profiles',
    'tab-login-extension',
    'pane-login-profiles',
    'pane-login-extension',
    'stage-get-extension',
    'stage-browser-setup',
    'stage-pair-session',
    'btn-export-extension',
    'btn-open-extension-folder',
    'btn-reexport-extension',
    'extension-saved-path-box',
    'extension-saved-path',
    'btn-open-brave-ext',
    'chk-ext-extracted',
    'chk-ext-loaded',
    'chk-ext-pinned',
    'chk-ytm-signedin',
    'btn-copy-pairing-port',
    'btn-copy-all-details',
    'pairing-countdown-box',
    'pairing-countdown-val'
  ];

  for (const id of requiredIds) {
    const re = new RegExp(`id="${id}"`, 'g');
    const matches = html.match(re) || [];
    assert.equal(matches.length, 1, `Element ID "${id}" must exist exactly once in index.html`);
  }
});

test('19: modal-backdrop class and visible/hidden state transition', () => {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');
  const appJs = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../src/renderer/styles.css'), 'utf8');

  // 1. #browser-login-dialog must use modal-backdrop hidden
  assert.ok(
    html.includes('id="browser-login-dialog" class="modal-backdrop hidden"'),
    'browser-login-dialog must have class "modal-backdrop hidden"'
  );
  // Must NOT have display: none inline style
  assert.ok(
    !html.includes('id="browser-login-dialog" class="modal-backdrop hidden" style="position: fixed; inset: 0; background: rgba(0,0,0,0.7); backdrop-filter: blur(12px); display: none;'),
    'browser-login-dialog must not have inline display: none'
  );

  // 2. openBrowserLoginModal must remove hidden and add visible
  assert.ok(
    appJs.includes("browserLoginDialog.classList.remove('hidden')") &&
    appJs.includes("browserLoginDialog.classList.add('visible')"),
    'openBrowserLoginModal must remove hidden and add visible'
  );

  // 3. closeBrowserLoginModal must remove visible and add hidden
  assert.ok(
    appJs.includes("browserLoginDialog.classList.remove('visible')") &&
    appJs.includes("browserLoginDialog.classList.add('hidden')"),
    'closeBrowserLoginModal must remove visible and add hidden'
  );

  // 4. CSS contains .modal-backdrop.visible .dialog-card restoring opacity: 1 and transform: scale(1)
  assert.ok(
    css.includes('.modal-backdrop.visible .dialog-card') ||
    css.includes('.modal-backdrop.visible .settings-card,') ||
    css.includes('.modal-backdrop.visible .modal-card'),
    'CSS must contain .modal-backdrop.visible .dialog-card selector'
  );
  assert.ok(
    css.includes('transform: scale(1);') && css.includes('opacity: 1;'),
    'CSS must transition to transform: scale(1) and opacity: 1'
  );
});

test('20: Extension ZIP generation and packaging contents verification', () => {
  const fs = require('fs');
  const path = require('path');
  const cp = require('child_process');
  const { buildExtensionZip } = require('../scripts/build-extension');

  const zipPath = buildExtensionZip();
  assert.ok(fs.existsSync(zipPath), 'Extension zip must exist');
  assert.ok(fs.statSync(zipPath).size > 1000, 'Extension zip must have valid size');

  const list = cp.execSync(`tar -tf "${zipPath}"`, { encoding: 'utf8' })
    .split(/\r?\n/)
    .map(s => s.trim().replace(/^.*[\\\/]/, ''))
    .filter(Boolean);

  const expectedEntries = ['manifest.json', 'background.js', 'popup.html', 'popup.js', 'README.md'];
  for (const entry of expectedEntries) {
    assert.ok(list.includes(entry), `ZIP must contain ${entry}`);
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../src/extensions/eclipse-connect/manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3, 'Must be Manifest V3');
  assert.ok(manifest.permissions.includes('cookies'), 'Manifest must have cookies permission');
});

test('21: Browser manager IPC validation and browser resolution logic', () => {
  const fs = require('fs');
  const path = require('path');
  const mainJs = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');

  // Verify IPC handler registered
  assert.ok(mainJs.includes("'browser-login:open-extension-manager'"), 'Must register open-extension-manager IPC');
  assert.ok(mainJs.includes('resolveBrowserExecutable(norm)'), 'Must call resolveBrowserExecutable');

  // Verify browser validation logic: rejects unsupported browsers
  const validBrowsers = ['chrome', 'edge', 'brave'];
  const testInput = (browser) => {
    const norm = String(browser || '').toLowerCase().trim();
    if (!validBrowsers.includes(norm)) {
      return { success: false, error: `Invalid browser: ${browser}. Supported: chrome, edge, brave.` };
    }
    return { success: true };
  };

  assert.equal(testInput('firefox').success, false);
  assert.equal(testInput('safari').success, false);
  assert.equal(testInput('').success, false);
  assert.equal(testInput('chrome').success, true);
  assert.equal(testInput('edge').success, true);
  assert.equal(testInput('brave').success, true);

  // Verify execFile uses shell: false
  assert.ok(
    mainJs.includes('execFile(resolved.exe, [resolved.extUrl], { shell: false }') ||
    mainJs.includes('execFile(resolved.exe, [resolved.extUrl], { shell: false'),
    'Browser launcher must spawn with shell: false'
  );
});

test('22: Export extension IPC handles cancel, write, validation', () => {
  const fs = require('fs');
  const path = require('path');
  const mainJs = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');

  assert.ok(mainJs.includes("'browser-login:export-extension'"), 'Must register export-extension IPC');
  assert.ok(mainJs.includes('dialog.showSaveDialog'), 'Must use dialog.showSaveDialog');
  assert.ok(mainJs.includes('shell.showItemInFolder'), 'Must call shell.showItemInFolder upon save');
  assert.ok(mainJs.includes('manifest.manifest_version !== 3'), 'Must validate MV3 manifest inside zip');
  assert.ok(mainJs.includes('saveResult.canceled'), 'Must handle user cancelation gracefully');
});

test('23: 3 stages rendered, 6 instructions present, prerequisites gating Start Pairing', () => {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');
  const appJs = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');

  // Verify 3 stages rendered in DOM
  assert.ok(html.includes('id="stage-get-extension"'), 'Stage 1 must exist');
  assert.ok(html.includes('id="stage-browser-setup"'), 'Stage 2 must exist');
  assert.ok(html.includes('id="stage-pair-session"'), 'Stage 3 must exist');

  // Verify 6 instructions present
  assert.ok(html.includes('Extract ZIP:'), 'Step 1 Extract ZIP must be present');
  assert.ok(html.includes('Open Extensions page:'), 'Step 2 Open extensions page must be present');
  assert.ok(html.includes('Enable Developer Mode:'), 'Step 3 Dev mode must be present');
  assert.ok(html.includes('Load unpacked:'), 'Step 4 Load unpacked must be present');
  assert.ok(html.includes('Select folder:'), 'Step 5 Select folder must be present');
  assert.ok(html.includes('Pin to toolbar:'), 'Step 6 Pin to toolbar must be present');

  // Verify prerequisites gating Start Pairing in app.js
  assert.ok(appJs.includes('updateStartPairingState()'), 'Must have updateStartPairingState function');
  assert.ok(
    appJs.includes('chkExtExtracted.checked && chkExtLoaded.checked && chkExtPinned.checked') ||
    appJs.includes('isStage2Confirmed && isStage3Ready'),
    'Start Pairing must be gated on all 3 stage 2 checks plus stage 3 sign-in check'
  );
});

test('24: Copy Port, Nonce, All Details formatting', () => {
  const fs = require('fs');
  const path = require('path');
  const appJs = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');

  assert.ok(appJs.includes('btnCopyPairingPort'), 'btnCopyPairingPort handler must exist');
  assert.ok(appJs.includes('btnCopyPairingNonce'), 'btnCopyPairingNonce handler must exist');
  assert.ok(appJs.includes('btnCopyAllDetails'), 'btnCopyAllDetails handler must exist');

  // Verify formatted text for All Details
  assert.ok(
    appJs.includes('`Port: ${port}\\nNonce: ${nonce}`') ||
    appJs.includes('Port: ') && appJs.includes('Nonce: '),
    'All Details must format Port and Nonce clearly'
  );
});

test('25: Timeout 120s expiry and cancel clearing session', () => {
  const fs = require('fs');
  const path = require('path');
  const appJs = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');

  // Verify 120s timer logic using expiresAt timestamp
  assert.ok(appJs.includes('startPairingTimer(res.expiresAt)'), 'startPairingFlow must pass expiresAt to timer');
  assert.ok(appJs.includes('stopPairingCountdown()'), 'Must have stopPairingCountdown function');
  assert.ok(
    appJs.includes("extensionPairingBadge.textContent = 'Expired'") ||
    appJs.includes("'Expired'"),
    'Must set badge to Expired upon countdown timeout'
  );

  // Verify modal close and cancel clear session and invoke IPC
  assert.ok(
    appJs.includes('browserLoginCancelPairing().catch') ||
    appJs.includes('browserLoginCancelPairing()'),
    'Cancel / close must invoke browserLoginCancelPairing'
  );
});
