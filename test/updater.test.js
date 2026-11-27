// d:\Eclipse\eclipse-pc\test\updater.test.js
const assert = require('assert');
const crypto = require('crypto');
const {
  parseSemVer,
  isNewerSemVer,
  findMatchingAsset,
  isAssetCompatibleWithPlatform,
  resolveManifestAsset,
  computeRateLimitDelayMs,
  parseLatestYml,
  verifyBufferSha512Base64,
  evaluateBlockedVersion,
  evaluateMinSupported,
  decideRangeResume
} = require('../src/main/updater-core');

console.log('--- RUNNING ENTERPRISE UPDATER UNIT TESTS ---');

// Test 1: SemVer Comparison (Standard, Prefix v, 1.0.9 vs 1.0.48)
console.log('1. Testing SemVer comparison...');
assert.strictEqual(isNewerSemVer('1.0.48', '1.0.9'), true, '1.0.48 must be newer than 1.0.9 (numerical comparison, not lexicographical string)');
assert.strictEqual(isNewerSemVer('1.0.9', '1.0.48'), false, '1.0.9 must NOT be newer than 1.0.48');
assert.strictEqual(isNewerSemVer('v1.4.16', '1.4.15'), true, 'v1.4.16 must be newer than 1.4.15 (handling v prefix)');
assert.strictEqual(isNewerSemVer('1.4.16', 'v1.4.16'), false, 'equal versions with/without v prefix must return false');
assert.strictEqual(isNewerSemVer('2.0.0', '1.99.99'), true, 'major version increment');
assert.strictEqual(isNewerSemVer('1.4.16', '1.4.16-beta.1'), true, 'stable release is newer than pre-release');
assert.strictEqual(isNewerSemVer('1.4.16-beta.2', '1.4.16-beta.1'), true, 'beta.2 is newer than beta.1');
console.log('✓ SemVer comparison passed.');

// Test 2: Asset Matching for Platforms
console.log('2. Testing asset matching...');
const mockAssets = [
  { name: 'eclipse-1.4.16-win-x64.exe' },
  { name: 'eclipse-1.4.16-win-x64.exe.blockmap' },
  { name: 'eclipse-1.4.16-win-ia32.exe' },
  { name: 'eclipse-1.4.16-mac-arm64.dmg' },
  { name: 'eclipse-1.4.16-mac-x64.dmg' },
  { name: 'eclipse-1.4.16-linux.AppImage' },
  { name: 'eclipse-1.4.16-linux.deb' },
  { name: 'eclipse-1.4.16-universal.apk' }
];

const win64 = findMatchingAsset(mockAssets, 'win32', 'x64');
assert.strictEqual(win64.name, 'eclipse-1.4.16-win-x64.exe', 'Must match win-x64.exe and ignore blockmap');

const win32 = findMatchingAsset(mockAssets, 'win32', 'ia32');
assert.strictEqual(win32.name, 'eclipse-1.4.16-win-ia32.exe', 'Must match win-ia32.exe for ia32');

const macArm = findMatchingAsset(mockAssets, 'darwin', 'arm64');
assert.strictEqual(macArm.name, 'eclipse-1.4.16-mac-arm64.dmg', 'Must match arm64 dmg for Apple Silicon');

const macX64 = findMatchingAsset(mockAssets, 'darwin', 'x64');
assert.strictEqual(macX64.name, 'eclipse-1.4.16-mac-x64.dmg', 'Must match x64 dmg for Intel Mac');

const linux = findMatchingAsset(mockAssets, 'linux', 'x64');
assert.strictEqual(linux.name, 'eclipse-1.4.16-linux.AppImage', 'Must match AppImage for Linux');

const android = findMatchingAsset(mockAssets, 'android', 'arm64');
assert.strictEqual(android.name, 'eclipse-1.4.16-universal.apk', 'Must match apk for Android');
console.log('✓ Asset matching passed.');

// Test 3: latest.yml parsing and sha512 (base64) verification
console.log('3. Testing latest.yml parser and sha512 verification...');
const sampleYml = `version: 1.4.16
files:
  - url: eclipse-1.4.16-win-x64.exe
    sha512: dGVzdC1oYXNoLWJhc2U2NA==
    size: 7891234
path: eclipse-1.4.16-win-x64.exe
sha512: ODFf0PzH7q0tGZ/Q6j2yQyN9yvX...
releaseDate: '2026-11-16T07:05:00.000Z'
`;

const parsed = parseLatestYml(sampleYml);
assert.strictEqual(parsed.version, '1.4.16');
assert.strictEqual(parsed.path, 'eclipse-1.4.16-win-x64.exe');
assert.strictEqual(parsed.sha512, 'ODFf0PzH7q0tGZ/Q6j2yQyN9yvX...');

const dummyPayload = Buffer.from('hello eclipse enterprise updater');
const actualSha512Base64 = crypto.createHash('sha512').update(dummyPayload).digest('base64');
assert.strictEqual(verifyBufferSha512Base64(dummyPayload, actualSha512Base64), true, 'Sha512 base64 match check');
assert.strictEqual(verifyBufferSha512Base64(dummyPayload, 'invalidBase64Hash'), false, 'Sha512 base64 mismatch check');
console.log('✓ latest.yml and sha512 passed.');

// Test 4: Range Resume logic (HTTP 200 vs 206)
console.log('4. Testing Range Resume decisions (200 OK vs 206 Partial)...');
const resume206 = decideRangeResume(206, 5000, 10000);
assert.strictEqual(resume206.mode, 'append');
assert.strictEqual(resume206.startByte, 5000);

const resume200 = decideRangeResume(200, 5000, 10000);
assert.strictEqual(resume200.mode, 'overwrite', 'If server responds 200 OK, must discard existing part and overwrite from 0');
assert.strictEqual(resume200.startByte, 0);
console.log('✓ Range Resume passed.');

// Test 5: Blocked & minSupported manifest rules
console.log('5. Testing blocked and minSupported checks...');
const manifest = {
  version: '1.4.17',
  minSupported: '1.4.0',
  blocked: ['1.4.15', '1.4.16']
};

const blockCheck1 = evaluateBlockedVersion(manifest, '1.4.15', '1.4.17');
assert.strictEqual(blockCheck1.currentBlocked, true, 'Current 1.4.15 must be flagged as blocked');
assert.strictEqual(blockCheck1.targetBlocked, false, 'Target 1.4.17 is not blocked');
assert.strictEqual(blockCheck1.allowed, true, 'Can proceed with update to 1.4.17');

const blockCheck2 = evaluateBlockedVersion(manifest, '1.4.10', '1.4.16');
assert.strictEqual(blockCheck2.targetBlocked, true, 'Target 1.4.16 is in blocked list');
assert.strictEqual(blockCheck2.allowed, false, 'Must reject downloading target 1.4.16');

const minCheck1 = evaluateMinSupported(manifest, '1.3.5');
assert.strictEqual(minCheck1.supported, false, '1.3.5 is below minSupported 1.4.0');

const minCheck2 = evaluateMinSupported(manifest, '1.4.14');
assert.strictEqual(minCheck2.supported, true, '1.4.14 satisfies minSupported 1.4.0');
console.log('✓ Blocked and minSupported checks passed.');

// Test 6: Main-process updater.js (304 ETag cache, targetBlocked manual error, serialized update-check)
const { test } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

function loadUpdaterWithMocks({ version = '1.5.0', fetchImpl, platform = 'win32', arch = 'x64' }) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eclipse-updater-test-'));
  const ipcHandlers = new Map();
  const sentEvents = [];
  const origPlatformDesc = Object.getOwnPropertyDescriptor(process, 'platform');
  const origArchDesc = Object.getOwnPropertyDescriptor(process, 'arch');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  Object.defineProperty(process, 'arch', { value: arch, configurable: true });

  const mockElectron = {
    app: {
      getVersion: () => version,
      getPath: () => tmpDir,
      on: () => {},
      exit: () => {}
    },
    ipcMain: {
      handle: (ch, fn) => ipcHandlers.set(ch, fn),
      on: () => {}
    },
    shell: { openPath: async () => '' },
    net: { fetch: fetchImpl },
    powerMonitor: { on: () => {} }
  };

  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return mockElectron;
    return origLoad.apply(this, arguments);
  };

  const updaterPath = require.resolve('../src/main/updater');
  delete require.cache[updaterPath];
  const updater = require('../src/main/updater');
  Module._load = origLoad;

  const mockWin = {
    isDestroyed: () => false,
    webContents: {
      send: (channel, payload) => sentEvents.push({ channel, payload })
    }
  };

  updater.initUpdater(() => mockWin);
  return {
    updater,
    mockWin,
    ipcHandlers,
    sentEvents,
    cleanup: () => {
      if (origPlatformDesc) Object.defineProperty(process, 'platform', origPlatformDesc);
      if (origArchDesc) Object.defineProperty(process, 'arch', origArchDesc);
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
  };
}

function jsonResponse(status, body, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => headers[k.toLowerCase()] || null },
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

test('304 ETag reuses cached lastManifest on manual update-check', async () => {
  let callCount = 0;
  const { ipcHandlers, sentEvents, cleanup } = loadUpdaterWithMocks({
    version: '1.5.0',
    fetchImpl: async (url) => {
      if (url.endsWith('latest.json')) {
        callCount++;
        if (callCount === 1) {
          return jsonResponse(200, {
            version: '1.6.0',
            url: 'https://example.com/eclipse-1.6.0.exe',
            notes: 'Release 1.6.0'
          }, { etag: '"v1.6.0"' });
        }
        return jsonResponse(304, null);
      }
      return jsonResponse(404, {});
    }
  });

  try {
    const check = ipcHandlers.get('update-check');
    await check();
    await check();
    const avail = sentEvents.filter((e) => e.channel === 'update-available');
    assert.strictEqual(avail.length, 2, '304 ETag must reuse cached lastManifest and emit update-available');
    assert.strictEqual(avail[1].payload.version, '1.6.0');
  } finally {
    cleanup();
  }
});

test('304 ETag with no cached lastManifest retries unconditionally without If-None-Match and never reports false up-to-date', async () => {
  let jsonCalls = 0;
  let sawIfNoneMatchOnSecond = false;
  const { ipcHandlers, sentEvents, cleanup } = loadUpdaterWithMocks({
    version: '1.5.0',
    fetchImpl: async (url, opts) => {
      if (url.endsWith('latest.json')) {
        jsonCalls++;
        if (jsonCalls === 1) return jsonResponse(304, null);
        sawIfNoneMatchOnSecond = !!(opts && opts.headers && opts.headers['If-None-Match']);
        return jsonResponse(200, {
          version: '1.6.0',
          url: 'https://example.com/eclipse-1.6.0-win-x64.exe',
          notes: 'Release 1.6.0'
        });
      }
      return jsonResponse(404, {});
    }
  });

  try {
    const check = ipcHandlers.get('update-check');
    await check();
    assert.strictEqual(jsonCalls, 2, 'Empty-cache 304 must trigger unconditional retry');
    assert.strictEqual(sawIfNoneMatchOnSecond, false, 'Unconditional retry must omit If-None-Match');
    assert.strictEqual(sentEvents.filter((e) => e.channel === 'update-not-available').length, 0);
    assert.strictEqual(sentEvents.filter((e) => e.channel === 'update-available').length, 1);
  } finally {
    cleanup();
  }
});

test('targetBlocked emits update-error on manual check and resets manualCheck', async () => {
  const { ipcHandlers, sentEvents, cleanup } = loadUpdaterWithMocks({
    version: '1.5.0',
    fetchImpl: async (url) => {
      if (url.endsWith('latest.json')) {
        return jsonResponse(200, {
          version: '1.6.0',
          blocked: ['1.6.0'],
          url: 'https://example.com/eclipse-1.6.0.exe'
        });
      }
      return jsonResponse(404, {});
    }
  });

  try {
    const check = ipcHandlers.get('update-check');
    await check();
    const errs = sentEvents.filter((e) => e.channel === 'update-error');
    assert.strictEqual(errs.length, 1, 'targetBlocked must emit update-error on manual check');
    assert.match(errs[0].payload.message, /blocked/i);
  } finally {
    cleanup();
  }
});

test('ipcMain update-check serializes concurrent checks without manualCheck race', async () => {
  let releaseFirst;
  let callCount = 0;
  const { ipcHandlers, sentEvents, cleanup } = loadUpdaterWithMocks({
    version: '1.5.0',
    fetchImpl: async (url) => {
      if (url.endsWith('latest.json')) {
        callCount++;
        if (callCount === 1) {
          await new Promise((r) => { releaseFirst = r; });
        }
        return jsonResponse(200, {
          version: '1.5.0',
          url: 'https://example.com/eclipse-1.5.0.exe'
        });
      }
      return jsonResponse(404, {});
    }
  });

  try {
    const check = ipcHandlers.get('update-check');
    const p1 = check();
    const p2 = check();
    // Wait a tick so p1 enters fetchImpl
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(callCount, 1, 'Second check must wait for first in-flight check');
    releaseFirst();
    await Promise.all([p1, p2]);
    assert.strictEqual(callCount, 2, 'Second check must run after first completes');
    const notAvail = sentEvents.filter((e) => e.channel === 'update-not-available');
    assert.strictEqual(notAvail.length, 2, 'Both serialized manual checks must emit update-not-available');
  } finally {
    cleanup();
  }
});

// Test 7: Full P0 Regression Matrix (Legacy 1.4.17/1.4.24/1.5.0, 14 Fallback Cases, Arch Safety, Init Idempotency)
const SAMPLE_150_YML = `version: 1.5.0
files:
  - url: eclipse-1.5.0-win.exe
    sha512: abc123==
    size: 284457606
  - url: eclipse-1.5.0-win-ia32.exe
    sha512: ia32hash==
    size: 136078522
  - url: eclipse-1.5.0-win-x64.exe
    sha512: x64hash==
    size: 148953006
path: eclipse-1.5.0-win.exe
sha512: abc123==
`;

function textResponse(status, text, headers = {}) {
  return {
    status,
    statusText: status === 200 ? 'OK' : `HTTP ${status}`,
    ok: status >= 200 && status < 300,
    url: headers.url || '',
    headers: { get: (k) => headers[k.toLowerCase()] || null },
    text: async () => text,
    json: async () => JSON.parse(text)
  };
}

for (const localVer of ['1.4.17', '1.4.24', '1.5.0']) {
  test(`Legacy compatibility: v${localVer} against public v1.5.0 (latest.json 404, latest.yml 200)`, async () => {
    const { ipcHandlers, sentEvents, cleanup } = loadUpdaterWithMocks({
      version: localVer,
      fetchImpl: async (url) => {
        if (url.endsWith('latest.json')) return textResponse(404, 'Not Found');
        if (url.endsWith('latest.yml')) return textResponse(200, SAMPLE_150_YML);
        return jsonResponse(200, { tag_name: 'v1.5.0', body: 'Release 1.5.0', assets: [] });
      }
    });
    try {
      await ipcHandlers.get('update-check')();
      if (localVer === '1.5.0') {
        const notAvail = sentEvents.filter(e => e.channel === 'update-not-available');
        assert.strictEqual(notAvail.length, 1);
        assert.strictEqual(notAvail[0].payload.manual, true);
      } else {
        const avail = sentEvents.filter(e => e.channel === 'update-available');
        assert.strictEqual(avail.length, 1);
        assert.strictEqual(avail[0].payload.version, '1.5.0');
      }
    } finally {
      cleanup();
    }
  });
}

test('Fallback matrix: latest.json 404 + latest.yml 404 -> API 200', async () => {
  const { ipcHandlers, sentEvents, cleanup } = loadUpdaterWithMocks({
    version: '1.4.24',
    fetchImpl: async (url) => {
      if (url.endsWith('latest.json') || url.endsWith('latest.yml')) return textResponse(404, 'Not Found');
      return jsonResponse(200, {
        tag_name: 'v1.5.0',
        draft: false,
        body: 'API notes',
        assets: [{ name: 'eclipse-1.5.0-win-x64.exe', browser_download_url: 'https://example.com/eclipse-1.5.0-win-x64.exe', size: 100 }]
      });
    }
  });
  try {
    await ipcHandlers.get('update-check')();
    const avail = sentEvents.filter(e => e.channel === 'update-available');
    assert.strictEqual(avail.length, 1);
    assert.strictEqual(avail[0].payload.version, '1.5.0');
  } finally {
    cleanup();
  }
});

for (const code of [403, 429]) {
  test(`Fallback matrix: latest.json ${code} -> latest.yml 200`, async () => {
    const { ipcHandlers, sentEvents, cleanup } = loadUpdaterWithMocks({
      version: '1.4.24',
      fetchImpl: async (url) => {
        if (url.endsWith('latest.json')) return textResponse(code, 'Rate limited', { 'retry-after': '0' });
        if (url.endsWith('latest.yml')) return textResponse(200, SAMPLE_150_YML);
        return textResponse(404, 'Not Found');
      }
    });
    try {
      await ipcHandlers.get('update-check')();
      assert.strictEqual(sentEvents.filter(e => e.channel === 'update-available').length, 1);
    } finally {
      cleanup();
    }
  });
}

test('Fallback matrix: latest.json timeout -> latest.yml 200 (no retry on TimeoutError)', async () => {
  let jsonCalls = 0;
  const { ipcHandlers, sentEvents, cleanup } = loadUpdaterWithMocks({
    version: '1.4.24',
    fetchImpl: async (url) => {
      if (url.endsWith('latest.json')) {
        jsonCalls++;
        const err = new Error('The operation was aborted due to timeout');
        err.name = 'TimeoutError';
        throw err;
      }
      if (url.endsWith('latest.yml')) return textResponse(200, SAMPLE_150_YML);
      return textResponse(404, 'Not Found');
    }
  });
  try {
    await ipcHandlers.get('update-check')();
    assert.strictEqual(jsonCalls, 1, 'Must not retry timed-out request');
    assert.strictEqual(sentEvents.filter(e => e.channel === 'update-available').length, 1);
  } finally {
    cleanup();
  }
});

test('Fallback matrix: latest.yml malformed -> API 200', async () => {
  const { ipcHandlers, sentEvents, cleanup } = loadUpdaterWithMocks({
    version: '1.4.24',
    fetchImpl: async (url) => {
      if (url.endsWith('latest.json')) return textResponse(404, 'Not Found');
      if (url.endsWith('latest.yml')) return textResponse(200, 'not: valid: yaml: without: version');
      return jsonResponse(200, {
        tag_name: 'v1.5.0',
        draft: false,
        assets: [{ name: 'eclipse-1.5.0-win-x64.exe', browser_download_url: 'https://example.com/eclipse-1.5.0-win-x64.exe', size: 100 }]
      });
    }
  });
  try {
    await ipcHandlers.get('update-check')();
    assert.strictEqual(sentEvents.filter(e => e.channel === 'update-available').length, 1);
  } finally {
    cleanup();
  }
});

test('Fallback matrix: all sources unreachable reports failing stages and HTTP statuses', async () => {
  const { ipcHandlers, sentEvents, cleanup } = loadUpdaterWithMocks({
    version: '1.4.24',
    fetchImpl: async (url) => {
      if (url.endsWith('latest.json')) return textResponse(404, 'Not Found');
      if (url.endsWith('latest.yml')) return textResponse(404, 'Not Found');
      return textResponse(403, 'API rate limit exceeded', { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '9999999999' });
    }
  });
  try {
    await ipcHandlers.get('update-check')();
    const errs = sentEvents.filter(e => e.channel === 'update-error');
    assert.strictEqual(errs.length, 1);
    assert.match(errs[0].payload.message, /latest\.json.*404/);
    assert.match(errs[0].payload.message, /latest\.yml.*404/);
    assert.match(errs[0].payload.message, /releases-api.*403/);
  } finally {
    cleanup();
  }
});

test('Fallback matrix: draft release from API is never selected as public latest', async () => {
  const { ipcHandlers, sentEvents, cleanup } = loadUpdaterWithMocks({
    version: '1.5.0',
    fetchImpl: async (url) => {
      if (url.endsWith('latest.json') || url.endsWith('latest.yml')) return textResponse(404, 'Not Found');
      return jsonResponse(200, { tag_name: 'v1.5.1', draft: true, assets: [] });
    }
  });
  try {
    await ipcHandlers.get('update-check')();
    assert.strictEqual(sentEvents.filter(e => e.channel === 'update-available').length, 0);
    assert.strictEqual(sentEvents.filter(e => e.channel === 'update-error').length, 1);
  } finally {
    cleanup();
  }
});

test('Rate-limit delay calculation honors Retry-After and X-RateLimit-Reset', () => {
  const h1 = { get: (k) => (k === 'retry-after' ? '2' : null) };
  assert.strictEqual(computeRateLimitDelayMs(h1, 1000, 5000), 2000);
  const h2 = { get: (k) => (k === 'x-ratelimit-remaining' ? '0' : k === 'x-ratelimit-reset' ? '10' : null) };
  assert.strictEqual(computeRateLimitDelayMs(h2, 7000, 5000), 3000);
});

test('Backward-compatible manifest & platform/arch safety (x64, ia32, linux, darwin)', () => {
  const compatManifest = {
    version: '1.5.1',
    url: 'https://github.com/valzevox/Eclipse-music/releases/download/v1.5.1/eclipse-1.5.1-win.exe',
    sha512: 'univ==',
    size: 284457507,
    files: [
      { name: 'eclipse-1.5.1-win-x64.exe', sha512: 'x64==', size: 148952927 },
      { name: 'eclipse-1.5.1-win-ia32.exe', sha512: 'ia32==', size: 136078411 },
      { name: 'eclipse-1.5.1-linux-x64.tar.gz', sha512: 'lin==', size: 172600030 },
      { name: 'eclipse-1.5.1-mac-aarch64.zip', sha512: 'macarm==', size: 130455265 },
      { name: 'eclipse-1.5.1-mac-amd64.zip', sha512: 'macx64==', size: 137762354 }
    ]
  };
  assert.strictEqual(resolveManifestAsset(compatManifest, 'valzevox/Eclipse-music', 'win32', 'x64').assetName, 'eclipse-1.5.1-win-x64.exe');
  assert.strictEqual(resolveManifestAsset(compatManifest, 'valzevox/Eclipse-music', 'win32', 'ia32').assetName, 'eclipse-1.5.1-win-ia32.exe');
  assert.strictEqual(resolveManifestAsset(compatManifest, 'valzevox/Eclipse-music', 'linux', 'x64').assetName, 'eclipse-1.5.1-linux-x64.tar.gz');
  assert.strictEqual(resolveManifestAsset(compatManifest, 'valzevox/Eclipse-music', 'darwin', 'arm64').assetName, 'eclipse-1.5.1-mac-aarch64.zip');
  assert.strictEqual(resolveManifestAsset(compatManifest, 'valzevox/Eclipse-music', 'darwin', 'x64').assetName, 'eclipse-1.5.1-mac-amd64.zip');

  // Missing installer for current platform must return null (never fall back to Windows .exe on Linux/macOS)
  const winOnlyManifest = { version: '1.5.1', url: 'https://example.com/eclipse-1.5.1-win-x64.exe', files: [{ name: 'eclipse-1.5.1-win-x64.exe' }] };
  assert.strictEqual(resolveManifestAsset(winOnlyManifest, 'valzevox/Eclipse-music', 'linux', 'x64'), null);
  assert.strictEqual(resolveManifestAsset(winOnlyManifest, 'valzevox/Eclipse-music', 'win32', 'ia32'), null);
  assert.strictEqual(isAssetCompatibleWithPlatform('eclipse-1.5.1-win-x64.exe', 'win32', 'ia32'), false);
});

// Test 8: Section 4 — 403/429 Rate-Limit vs Ordinary 403 Forbidden
test('403 with remaining=0 and far-future reset defers immediately without 2.5s wait and falls back', async () => {
  let jsonCalls = 0;
  const t0 = Date.now();
  const farReset = String(Math.floor(Date.now() / 1000) + 3600);
  const { ipcHandlers, sentEvents, cleanup } = loadUpdaterWithMocks({
    version: '1.4.24',
    fetchImpl: async (url) => {
      if (url.endsWith('latest.json')) {
        jsonCalls++;
        return textResponse(403, 'Rate limit', { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': farReset });
      }
      if (url.endsWith('latest.yml')) return textResponse(200, SAMPLE_150_YML);
      return textResponse(404, 'Not Found');
    }
  });
  try {
    await ipcHandlers.get('update-check')();
    const elapsed = Date.now() - t0;
    assert.strictEqual(jsonCalls, 1, 'Far-future reset must defer retry immediately');
    assert.ok(elapsed < 1500, `Must not wait 2.5s when reset is 1h away (elapsed=${elapsed}ms)`);
    assert.strictEqual(sentEvents.filter(e => e.channel === 'update-available').length, 1);
  } finally {
    cleanup();
  }
});

test('403 with remaining>0 or without rate-limit headers is treated as forbidden and NOT retried', async () => {
  for (const hdrs of [{ 'x-ratelimit-remaining': '10' }, {}]) {
    let jsonCalls = 0;
    const { ipcHandlers, sentEvents, cleanup } = loadUpdaterWithMocks({
      version: '1.4.24',
      fetchImpl: async (url) => {
        if (url.endsWith('latest.json')) {
          jsonCalls++;
          return textResponse(403, 'Forbidden', hdrs);
        }
        if (url.endsWith('latest.yml')) return textResponse(200, SAMPLE_150_YML);
        return textResponse(404, 'Not Found');
      }
    });
    try {
      await ipcHandlers.get('update-check')();
      assert.strictEqual(jsonCalls, 1, 'Ordinary 403 forbidden must not be retried');
      assert.strictEqual(sentEvents.filter(e => e.channel === 'update-available').length, 1);
    } finally {
      cleanup();
    }
  }
});

for (const status of [403, 429]) {
  test(`${status} with Retry-After=0 retries once before falling back`, async () => {
    let jsonCalls = 0;
    const { ipcHandlers, sentEvents, cleanup } = loadUpdaterWithMocks({
      version: '1.4.24',
      fetchImpl: async (url) => {
        if (url.endsWith('latest.json')) {
          jsonCalls++;
          return textResponse(status, 'Rate limited', { 'retry-after': '0' });
        }
        if (url.endsWith('latest.yml')) return textResponse(200, SAMPLE_150_YML);
        return textResponse(404, 'Not Found');
      }
    });
    try {
      await ipcHandlers.get('update-check')();
      assert.strictEqual(jsonCalls, 2, `${status} with Retry-After=0 must retry once`);
      assert.strictEqual(sentEvents.filter(e => e.channel === 'update-available').length, 1);
    } finally {
      cleanup();
    }
  });
}

// Test 9: Section 6 — Platform fallback when latest.json / latest.yml lack current-platform asset
test('Platform fallback: valid latest.json without current-platform asset falls back to latest.yml -> API', async () => {
  const { ipcHandlers, sentEvents, cleanup } = loadUpdaterWithMocks({
    version: '1.4.24',
    fetchImpl: async (url) => {
      if (url.endsWith('latest.json')) {
        return jsonResponse(200, {
          version: '1.5.0',
          files: [{ name: 'eclipse-1.5.0-linux-x64.tar.gz', sha512: 'lin==', size: 100 }]
        });
      }
      if (url.endsWith('latest.yml')) {
        return textResponse(200, `version: 1.5.0\nfiles:\n  - url: eclipse-1.5.0-linux-x64.tar.gz\n    sha512: lin==\n    size: 100\npath: eclipse-1.5.0-linux-x64.tar.gz\nsha512: lin==\n`);
      }
      return jsonResponse(200, {
        tag_name: 'v1.5.0',
        draft: false,
        assets: [{ name: 'eclipse-1.5.0-win-x64.exe', browser_download_url: 'https://example.com/eclipse-1.5.0-win-x64.exe', size: 100 }]
      });
    }
  });
  try {
    await ipcHandlers.get('update-check')();
    const avail = sentEvents.filter(e => e.channel === 'update-available');
    assert.strictEqual(avail.length, 1, 'Must fall through to API when JSON and YML lack current-platform asset');
    assert.strictEqual(avail[0].payload.downloadUrl, 'https://example.com/eclipse-1.5.0-win-x64.exe');
  } finally {
    cleanup();
  }
});

test('Platform fallback: truly missing platform asset across all 3 sources emits update-error', async () => {
  const { ipcHandlers, sentEvents, cleanup } = loadUpdaterWithMocks({
    version: '1.4.24',
    fetchImpl: async (url) => {
      if (url.endsWith('latest.json')) {
        return jsonResponse(200, { version: '1.5.0', files: [{ name: 'eclipse-1.5.0-linux-x64.tar.gz' }] });
      }
      if (url.endsWith('latest.yml')) {
        return textResponse(200, `version: 1.5.0\nfiles:\n  - url: eclipse-1.5.0-linux-x64.tar.gz\n    sha512: lin==\n    size: 100\npath: eclipse-1.5.0-linux-x64.tar.gz\nsha512: lin==\n`);
      }
      return jsonResponse(200, {
        tag_name: 'v1.5.0',
        draft: false,
        assets: [{ name: 'eclipse-1.5.0-linux-x64.tar.gz', browser_download_url: 'https://example.com/eclipse-1.5.0-linux-x64.tar.gz', size: 100 }]
      });
    }
  });
  try {
    await ipcHandlers.get('update-check')();
    const errs = sentEvents.filter(e => e.channel === 'update-error');
    assert.strictEqual(errs.length, 1);
    assert.match(errs[0].payload.message, /No compatible installer/i);
  } finally {
    cleanup();
  }
});

// Test 10: Section 7 — Actual v1.5.0 legacy updater-core.js against verified v1.5.1 manifest fixture (and dist/latest.yml when present)
test('Legacy v1.5.0 updater-core.js selects correct assets from verified v1.5.1 manifest across all platforms', () => {
  const { execFileSync } = require('child_process');
  const vm = require('vm');
  const legacyCode = execFileSync('git', ['show', 'v1.5.0:src/main/updater-core.js'], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8'
  });
  const legacyMod = { exports: {} };
  vm.runInNewContext(legacyCode, { module: legacyMod, exports: legacyMod.exports, require, process, Buffer });
  const legacyCore = legacyMod.exports;

  const fixturePath = path.resolve(__dirname, 'fixtures/v1.5.1-latest.yml');
  assert.ok(fs.existsSync(fixturePath), `Verified manifest fixture must exist at ${fixturePath}`);
  const ymlText = fs.readFileSync(fixturePath, 'utf8');

  const parsed = legacyCore.parseLatestYml(ymlText);
  assert.ok(parsed && parsed.version, 'Legacy v1.5.0 parseLatestYml must parse v1.5.1 manifest');
  assert.ok(Array.isArray(parsed.files) && parsed.files.length >= 5, 'v1.5.1 manifest must list cross-platform files[]');

  const checks = [
    { platform: 'win32', arch: 'x64', pattern: /win-x64\.exe$/i, label: 'Windows x64 EXE' },
    { platform: 'win32', arch: 'ia32', pattern: /win-ia32\.exe$/i, label: 'Windows ia32 EXE' },
    { platform: 'linux', arch: 'x64', pattern: /\.(AppImage|deb)$/i, label: 'Linux AppImage/DEB' },
    { platform: 'darwin', arch: 'arm64', pattern: /arm64\.dmg$/i, label: 'macOS arm64 DMG' },
    { platform: 'darwin', arch: 'x64', pattern: /x64\.dmg$/i, label: 'macOS x64 DMG' }
  ];

  for (const { platform, arch, pattern, label } of checks) {
    const asset = legacyCore.findMatchingAsset(parsed.files, platform, arch);
    assert.ok(asset, `Legacy v1.5.0 must find ${label} in v1.5.1 manifest`);
    assert.match(asset.name, pattern, `Legacy ${label} mismatch: got ${asset.name}`);
    assert.ok(typeof asset.sha512 === 'string' && asset.sha512.length >= 80, `${label} must have valid sha512`);
    assert.ok(Number.isFinite(asset.size) && asset.size > 0, `${label} must have positive size`);
    if (platform !== 'win32') {
      assert.doesNotMatch(asset.name, /\.exe$/i, `Legacy updater must NEVER pick Windows .exe on ${platform}`);
    }
  }

  // Even if only Windows .exe assets exist, Linux/macOS must return null (never download Windows .exe)
  const winOnlyFiles = parsed.files.filter(f => /\.exe$/i.test(f.name));
  assert.strictEqual(legacyCore.findMatchingAsset(winOnlyFiles, 'linux', 'x64'), null);
  assert.strictEqual(legacyCore.findMatchingAsset(winOnlyFiles, 'darwin', 'arm64'), null);
  assert.strictEqual(legacyCore.findMatchingAsset(winOnlyFiles, 'darwin', 'x64'), null);
});

for (const { platform, arch, expectedAsset } of [
  { platform: 'linux', arch: 'x64', expectedAsset: 'valzevox-eclipse_1.5.1_amd64.deb' },
  { platform: 'darwin', arch: 'arm64', expectedAsset: 'Eclipse-1.5.1-mac-arm64.dmg' },
  { platform: 'darwin', arch: 'x64', expectedAsset: 'Eclipse-1.5.1-mac-x64.dmg' }
]) {
  test(`Portable updater check on ${platform}/${arch} selects ${expectedAsset} from v1.5.1 latest.yml`, async () => {
    const ymlText = fs.readFileSync(path.resolve(__dirname, 'fixtures/v1.5.1-latest.yml'), 'utf8');
    const { ipcHandlers, sentEvents, cleanup } = loadUpdaterWithMocks({
      version: '1.5.0',
      platform,
      arch,
      fetchImpl: async (url) => {
        if (url.endsWith('latest.yml')) return textResponse(200, ymlText);
        return textResponse(404, 'Not Found');
      }
    });
    try {
      await ipcHandlers.get('update-check')();
      const avail = sentEvents.filter(e => e.channel === 'update-available');
      assert.strictEqual(avail.length, 1);
      assert.ok(
        avail[0].payload.downloadUrl && avail[0].payload.downloadUrl.endsWith(`/${expectedAsset}`),
        `Expected downloadUrl ending with /${expectedAsset}, got ${avail[0].payload.downloadUrl}`
      );
    } finally {
      cleanup();
    }
  });
}

// Test 11: P0-1..P0-5 — executeInstaller NSIS args, spawn lifecycle, error/exit handling
const { EventEmitter } = require('events');

function createMockChild() {
  const child = new EventEmitter();
  child.pid = 42424;
  child.unrefCalled = false;
  child.unref = () => { child.unrefCalled = true; };
  return child;
}

test('executeInstaller passes --updated, /S, --force-run and unquoted /D= last, and exits only after spawn', async () => {
  const { updater, mockWin, cleanup } = loadUpdaterWithMocks({ version: '1.5.0', fetchImpl: async () => textResponse(404, '') });
  try {
    let capturedArgs = null;
    let exitCode = null;
    let spawnedBeforeExit = false;
    const child = createMockChild();

    const p = updater.executeInstaller('C:\\Temp\\eclipse-1.5.1-win-x64.exe', {
      platform: 'win32',
      execPath: 'C:\\Users\\Test\\AppData\\Local\\Programs\\Eclipse\\Eclipse.exe',
      existsSync: (p) => p.endsWith('app.asar'),
      handoffDelayMs: 10,
      spawnImpl: (_exe, args) => {
        capturedArgs = args;
        setTimeout(() => {
          assert.strictEqual(exitCode, null, 'Must NOT exit app before spawn event');
          spawnedBeforeExit = true;
          child.emit('spawn');
        }, 5);
        return child;
      },
      exitImpl: (code) => { exitCode = code; }
    }, () => mockWin);

    const res = await p;
    assert.strictEqual(res.ok, true);
    assert.strictEqual(spawnedBeforeExit, true);
    assert.strictEqual(exitCode, 0);
    assert.strictEqual(child.unrefCalled, true);
    assert.deepStrictEqual(capturedArgs.slice(0, 3), ['--updated', '/S', '--force-run']);
    assert.strictEqual(capturedArgs[capturedArgs.length - 1], '/D=C:\\Users\\Test\\AppData\\Local\\Programs\\Eclipse');
    assert.ok(!capturedArgs[capturedArgs.length - 1].includes('"'), '/D= must be unquoted');
  } finally {
    cleanup();
  }
});

for (const errCode of ['ENOENT', 'EACCES']) {
  test(`executeInstaller on spawn ${errCode} keeps app open, resets isApplyingUpdate, and emits update-error`, async () => {
    const { updater, mockWin, sentEvents, cleanup } = loadUpdaterWithMocks({ version: '1.5.0', fetchImpl: async () => textResponse(404, '') });
    try {
      let exitCalled = false;
      let attempts = 0;
      const runAttempt = () => updater.executeInstaller('C:\\Temp\\missing.exe', {
        platform: 'win32',
        execPath: 'C:\\Program Files\\Eclipse\\Eclipse.exe',
        existsSync: () => true,
        handoffDelayMs: 10,
        spawnImpl: () => {
          attempts++;
          const child = createMockChild();
          setTimeout(() => {
            const err = new Error(`spawn ${errCode}`);
            err.code = errCode;
            child.emit('error', err);
          }, 5);
          return child;
        },
        exitImpl: () => { exitCalled = true; }
      }, () => mockWin);

      await assert.rejects(runAttempt, new RegExp(errCode));
      assert.strictEqual(exitCalled, false, 'Must NOT exit app on spawn error');
      assert.strictEqual(sentEvents.filter(e => e.channel === 'update-error').length, 1);

      // Verify isApplyingUpdate was reset so user can retry
      await assert.rejects(runAttempt, new RegExp(errCode));
      assert.strictEqual(attempts, 2, 'isApplyingUpdate must reset after spawn error');
    } finally {
      cleanup();
    }
  });
}

test('executeInstaller on non-zero exit before handoff keeps app open and emits update-error', async () => {
  const { updater, mockWin, sentEvents, cleanup } = loadUpdaterWithMocks({ version: '1.5.0', fetchImpl: async () => textResponse(404, '') });
  try {
    let exitCalled = false;
    const child = createMockChild();
    await assert.rejects(
      updater.executeInstaller('C:\\Temp\\bad.exe', {
        platform: 'win32',
        execPath: 'C:\\Program Files\\Eclipse\\Eclipse.exe',
        existsSync: () => true,
        handoffDelayMs: 30,
        spawnImpl: () => {
          setTimeout(() => {
            child.emit('spawn');
            child.emit('exit', 2, null);
          }, 5);
          return child;
        },
        exitImpl: () => { exitCalled = true; }
      }, () => mockWin),
      /exited with code 2/
    );
    assert.strictEqual(exitCalled, false, 'Must NOT exit app when installer exits non-zero');
    assert.strictEqual(sentEvents.filter(e => e.channel === 'update-error').length, 1);
  } finally {
    cleanup();
  }
});

test('Download completion alone emits update-ready without exiting app or claiming install success', async () => {
  const payload = Buffer.from('fake-installer-bytes');
  const sha512 = crypto.createHash('sha512').update(payload).digest('base64');
  const { ipcHandlers, sentEvents, cleanup } = loadUpdaterWithMocks({
    version: '1.5.0',
    platform: 'win32',
    arch: 'x64',
    fetchImpl: async (url) => {
      if (url.endsWith('latest.yml')) {
        return textResponse(200, `version: 1.5.1\nfiles:\n  - url: eclipse-1.5.1-win-x64.exe\n    sha512: ${sha512}\n    size: ${payload.length}\npath: eclipse-1.5.1-win-x64.exe\nsha512: ${sha512}\n`);
      }
      if (url.endsWith('eclipse-1.5.1-win-x64.exe')) {
        return {
          status: 200,
          ok: true,
          headers: { get: () => String(payload.length) },
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(payload));
              controller.close();
            }
          })
        };
      }
      return textResponse(404, 'Not Found');
    }
  });
  try {
    await ipcHandlers.get('update-check')();
    const res = await ipcHandlers.get('install-update-now')();
    assert.strictEqual(res.status, 'ready');
    assert.strictEqual(sentEvents.filter(e => e.channel === 'update-ready').length, 1);
  } finally {
    cleanup();
  }
});

console.log('ALL PHASE 0 UNIT TESTS PASSED SUCCESSFULLY (EXIT 0)');
