'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  formatNetscapeCookieLine,
  serializeToNetscapeJar,
  TempCookieManager
} = require('../src/shared/temp-cookie-manager');

test('TempCookieManager Netscape 7-column formatting and domain isolation', () => {
  // 1. Google / YouTube domain allowed and properly formatted
  const validCookie = {
    domain: '.youtube.com',
    name: 'SAPISID',
    value: 'secret_sapisid_value_123',
    path: '/',
    secure: true,
    httpOnly: false,
    expirationDate: 1750000000
  };
  const line = formatNetscapeCookieLine(validCookie);
  assert.ok(line);
  const parts = line.split('\t');
  assert.equal(parts.length, 7);
  assert.equal(parts[0], '.youtube.com');
  assert.equal(parts[1], 'TRUE'); // include subdomains
  assert.equal(parts[2], '/');
  assert.equal(parts[3], 'TRUE'); // secure
  assert.equal(parts[4], '1750000000');
  assert.equal(parts[5], 'SAPISID');
  assert.equal(parts[6], 'secret_sapisid_value_123');

  // 2. HttpOnly prefix correctly placed in first column
  const httpOnlyCookie = {
    domain: '.youtube.com',
    name: 'HSID',
    value: 'val',
    httpOnly: true
  };
  const httpOnlyLine = formatNetscapeCookieLine(httpOnlyCookie);
  assert.ok(httpOnlyLine.startsWith('#HttpOnly_.youtube.com'));

  // 3. Foreign domains (e.g. attacker or irrelevant cookies) MUST be rejected / filtered out
  const foreignCookie = {
    domain: '.facebook.com',
    name: 'c_user',
    value: '12345'
  };
  assert.equal(formatNetscapeCookieLine(foreignCookie), null, 'Foreign cookie domains must be excluded');
});

test('TempCookieManager serializes cookie list and verifies CRLF for Windows compatibility', () => {
  const cookies = [
    { domain: '.youtube.com', name: 'SAPISID', value: 'sap_val', secure: true },
    { domain: '.youtube.com', name: 'SID', value: 'sid_val', secure: true },
    { domain: '.evil.com', name: 'EVIL', value: 'bad' }
  ];

  const jarText = serializeToNetscapeJar(cookies);
  assert.ok(jarText.startsWith('# Netscape HTTP Cookie File'));
  assert.ok(jarText.includes('SAPISID\tsap_val'));
  assert.ok(jarText.includes('SID\tsid_val'));
  assert.ok(!jarText.includes('evil.com'), 'Evil domain must not appear in serialized jar');

  if (process.platform === 'win32') {
    assert.ok(jarText.includes('\r\n'), 'Windows must use CRLF for yt-dlp compatibility');
  }
});

test('TempCookieManager creates temporary jar, binds to child process, and unlinks on close/error', async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'eclipse-cookie-test-'));
  const manager = new TempCookieManager(tmpBase);

  try {
    const validCookies = [
      { domain: '.youtube.com', name: 'SAPISID', value: 'test_sap_123', secure: true },
      { domain: '.youtube.com', name: 'SID', value: 'test_sid_123', secure: true }
    ];

    // 1. Create temporary cookie jar
    const jarInfo = manager.createTemporaryCookieJar(validCookies);
    assert.ok(jarInfo, 'Jar must be created');
    assert.ok(fs.existsSync(jarInfo.jarPath), 'Jar file must exist on disk during invocation');
    assert.ok(fs.existsSync(jarInfo.dir), 'Jar directory must exist on disk');

    // 2. Simulate mock child process running
    let closeListener = null;
    let errorListener = null;
    const mockProc = {
      on: (event, handler) => {
        if (event === 'close') closeListener = handler;
        if (event === 'error') errorListener = handler;
      }
    };

    manager.attachToProcess(jarInfo, mockProc);
    assert.ok(closeListener, 'close listener must be attached');
    assert.ok(errorListener, 'error listener must be attached');

    // Jar remains while process is alive
    assert.ok(fs.existsSync(jarInfo.jarPath));

    // 3. Child process closes (exit 0, non-zero, or signal) -> jar is unlinked
    closeListener(0);

    assert.equal(fs.existsSync(jarInfo.jarPath), false, 'Jar file must be unlinked after process closes');
    assert.equal(fs.existsSync(jarInfo.dir), false, 'Jar directory must be removed after process closes');
    assert.equal(manager.activeJars.size, 0, 'Active jars tracker must be empty');

    // 4. Test Error handling branch: child process fails to spawn or crashes
    const jarInfo2 = manager.createTemporaryCookieJar(validCookies);
    assert.ok(fs.existsSync(jarInfo2.jarPath));

    let errListener2 = null;
    const mockProc2 = {
      on: (event, handler) => {
        if (event === 'error') errListener2 = handler;
      }
    };
    manager.attachToProcess(jarInfo2, mockProc2);
    errListener2(new Error('Spawn ENOENT'));

    assert.equal(fs.existsSync(jarInfo2.jarPath), false, 'Jar file must be unlinked on spawn error');
    assert.equal(fs.existsSync(jarInfo2.dir), false, 'Jar directory must be removed on spawn error');
  } finally {
    try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch (_) {}
  }
});

test('TempCookieManager sweeps stale orphan cookie jars on startup', () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'eclipse-cookie-sweep-'));
  const manager = new TempCookieManager(tmpBase);

  try {
    const tempDir = manager.getTempDir();
    const staleDir = path.join(tempDir, 'ytjar-99999-stale-test');
    fs.mkdirSync(staleDir, { recursive: true });
    const staleFile = path.join(staleDir, 'cookies.txt');
    fs.writeFileSync(staleFile, 'stale content', 'utf8');

    // Make mtime older than 5 minutes
    const oldTime = (Date.now() - 360000) / 1000;
    fs.utimesSync(staleFile, oldTime, oldTime);
    fs.utimesSync(staleDir, oldTime, oldTime);

    assert.ok(fs.existsSync(staleFile));

    // Run sweep
    manager.sweepStaleCookieJars();

    assert.equal(fs.existsSync(staleDir), false, 'Stale orphan directory must be cleaned up');
  } finally {
    try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch (_) {}
  }
});

test('Zero persistent plaintext cookie jar invariant', () => {
  const { DATA_DIR } = require('../src/shared/platform');
  const persistentCookieJar = path.join(DATA_DIR, 'yt-cookies.txt');
  assert.equal(fs.existsSync(persistentCookieJar), false, 'Persistent yt-cookies.txt must NOT exist on disk');
});
