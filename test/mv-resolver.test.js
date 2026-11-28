const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');

const mvMappingStore = require('../src/server/mv-mapping-store');
const ytmMv = require('../src/server/ytm-mv');
const { startServer, stopServer, getServerToken } = require('../src/server/server');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'eclipse-mv-test-'));
}

function httpRequest(port, method, reqPath, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: reqPath,
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers
      }
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (_) {}
        resolve({ status: res.statusCode, json, raw: data });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

test('Phase A1: candidate scoring prefers official MV over lyric/cover and does not bypass 11-char audio ID', async () => {
  const dir = makeTempDir();
  mvMappingStore.configure({ userDataDir: dir });

  const mockInnertube = {
    music: {
      search: async () => ({
        contents: [{
          contents: [
            {
              id: 'lyric123456',
              title: 'Midnight City (Lyric Video)',
              author: { name: 'Random Lyrics Channel' },
              duration: '4:03'
            },
            {
              id: 'cover123456',
              title: 'Midnight City (Acoustic Cover)',
              author: { name: 'Cover Artist' },
              duration: '3:50'
            },
            {
              id: 'offic123456',
              title: 'Midnight City (Official Music Video)',
              author: { name: 'M83', is_official_artist_channel: true },
              duration: '4:04'
            }
          ]
        }]
      })
    }
  };

  // 11-char audio ID must NOT bypass search
  const res = await ytmMv.resolveMusicVideo({
    songId: 'audio123456',
    title: 'Midnight City',
    artist: 'M83',
    durationSec: 243,
    innertube: mockInnertube
  });

  assert.equal(res.found, true);
  assert.equal(res.videoId, 'offic123456');
  assert.equal(res.source, 'auto');
  assert.ok(res.confidence >= ytmMv.CONFIDENCE_THRESHOLD);
  assert.equal(res.candidates.length, 3);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('Phase A1: LOW_CONFIDENCE returns found: false with top candidates', async () => {
  const dir = makeTempDir();
  mvMappingStore.configure({ userDataDir: dir });

  const mockInnertube = {
    music: {
      search: async () => ({
        contents: [{
          contents: [
            {
              id: 'karaoke1234',
              title: 'Completely Different Song (Karaoke)',
              author: { name: 'Karaoke Hub' },
              duration: '2:10'
            }
          ]
        }]
      })
    }
  };

  const res = await ytmMv.resolveMusicVideo({
    songId: 'song-low-conf',
    title: 'Midnight City',
    artist: 'M83',
    durationSec: 243,
    innertube: mockInnertube
  });

  assert.equal(res.found, false);
  assert.equal(res.reason, 'LOW_CONFIDENCE');
  assert.equal(res.candidates.length, 1);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('Phase A1: mv-mapping-store atomic concurrent writes, TTL, offset binding per mvVideoId, and manual error 100 unavailable', async () => {
  const dir = makeTempDir();
  mvMappingStore.configure({ userDataDir: dir });
  assert.equal(mvMappingStore.getStorePath(), path.join(dir, 'mv-mappings.json'));

  // Concurrent writes must not lose any songId
  await Promise.all([
    mvMappingStore.saveAutoMapping('song-a', { mvVideoId: 'vidA1234567', confidence: 0.9 }),
    mvMappingStore.saveAutoMapping('song-b', { mvVideoId: 'vidB1234567', confidence: 0.88 }),
    mvMappingStore.saveManualOverride('song-c', { mvVideoId: 'vidC1234567', offsetMs: 1250 })
  ]);

  assert.equal(mvMappingStore.getMapping('song-a').mvVideoId, 'vidA1234567');
  assert.equal(mvMappingStore.getMapping('song-b').mvVideoId, 'vidB1234567');
  assert.equal(mvMappingStore.getMapping('song-c').offsetMs, 1250);

  // Offset binding: bound to songId + mvVideoId
  await mvMappingStore.saveManualOverride('song-offset', { mvVideoId: 'mvOld123456', offsetMs: 1500 });
  // Simulate auto mapping resolving to a DIFFERENT mvVideoId -> must NOT inherit 1500ms
  const diffAuto = await mvMappingStore.saveAutoMapping('song-offset', { mvVideoId: 'mvNew123456', confidence: 0.92 });
  assert.equal(diffAuto.offsetMs, 0);
  // Re-selecting mvOld123456 restores its 1500ms offset
  const sameAuto = await mvMappingStore.saveAutoMapping('song-offset', { mvVideoId: 'mvOld123456', confidence: 0.92 });
  assert.equal(sameAuto.offsetMs, 1500);

  // TTL check: auto expires after 7 days, manual never expires
  const future = Date.now() + mvMappingStore.AUTO_TTL_MS + 1000;
  assert.equal(mvMappingStore.getMapping('song-a', future).expired, true);
  assert.equal(mvMappingStore.getMapping('song-c', future).expired, false);

  // Manual mapping hitting error 100 -> marked unavailable: true, NOT deleted
  await mvMappingStore.invalidateMapping('song-c', { reason: 'error_100' });
  const invalidatedManual = mvMappingStore.getMapping('song-c');
  assert.equal(invalidatedManual.userOverride, true);
  assert.equal(invalidatedManual.unavailable, true);
  assert.equal(invalidatedManual.mvVideoId, 'vidC1234567');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('Phase A1: /api/ytm/mv* routes require X-Eclipse-Token and persist override/invalidate', async () => {
  const dir = makeTempDir();
  const port = await startServer(0, { userDataDir: dir });
  const token = getServerToken();

  try {
    const unauthGet = await httpRequest(port, 'GET', '/api/ytm/mv?songId=s1&title=Test&artist=Artist');
    assert.equal(unauthGet.status, 403);

    const unauthOverride = await httpRequest(port, 'POST', '/api/ytm/mv/override', {
      body: { songId: 's1', mvVideoId: 'abc12345678', offsetMs: 500 }
    });
    assert.equal(unauthOverride.status, 403);

    const unauthInvalidate = await httpRequest(port, 'POST', '/api/ytm/mv/invalidate', {
      body: { songId: 's1' }
    });
    assert.equal(unauthInvalidate.status, 403);

    const authOverride = await httpRequest(port, 'POST', '/api/ytm/mv/override', {
      headers: { 'X-Eclipse-Token': token },
      body: { songId: 's1', mvVideoId: 'abc12345678', offsetMs: 750 }
    });
    assert.equal(authOverride.status, 200);
    assert.equal(authOverride.json.success, true);
    assert.equal(authOverride.json.mapping.offsetMs, 750);

    const authGet = await httpRequest(port, 'GET', '/api/ytm/mv?songId=s1&title=Test&artist=Artist', {
      headers: { 'X-Eclipse-Token': token }
    });
    assert.equal(authGet.status, 200);
    assert.equal(authGet.json.found, true);
    assert.equal(authGet.json.videoId, 'abc12345678');
    assert.equal(authGet.json.offsetMs, 750);
    assert.equal(authGet.json.source, 'manual');

    const authInvalidate = await httpRequest(port, 'POST', '/api/ytm/mv/invalidate', {
      headers: { 'X-Eclipse-Token': token },
      body: { songId: 's1', reason: 'error_100' }
    });
    assert.equal(authInvalidate.status, 200);
    assert.equal(authInvalidate.json.mapping.unavailable, true);
  } finally {
    await stopServer();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
