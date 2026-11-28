const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');

const trackSourceStore = require('../src/server/track-source-store');
const { startServer, stopServer, getServerToken } = require('../src/server/server');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'eclipse-track-source-test-'));
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
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

test('TrackSourceStore: persists manual source, strips expiring stream URLs, bounds blocklist, and resets cleanly', async () => {
  const dir = makeTempDir();
  trackSourceStore.configure({ userDataDir: dir });

  const saved = await trackSourceStore.saveTrackSource('M83', 'Midnight City', {
    provider: 'youtube',
    sourceId: 'dX3k_QDnzHE',
    canonicalUrl: 'https://rr1---sn-abc.googlevideo.com/videoplayback?expire=123',
    sourceMeta: { title: 'Midnight City', artist: 'M83' }
  });
  assert.equal(saved.selectedSource.sourceId, 'dX3k_QDnzHE');
  assert.equal(saved.selectedSource.canonicalUrl, ''); // expiring stream URL stripped

  // Blocklist bounded to MAX_BLOCKED_SOURCES
  for (let i = 0; i < 25; i++) {
    await trackSourceStore.blockTrackSource('M83', 'Midnight City', `bad_${i}`);
  }
  const afterBlock = trackSourceStore.getSavedTrackSource('M83', 'Midnight City');
  assert.equal(afterBlock.blockedSourceIds.length, trackSourceStore.MAX_BLOCKED_SOURCES);
  assert.equal(afterBlock.blockedSourceIds[0], 'bad_5');

  // Blocking the selected source clears selectedSource
  await trackSourceStore.blockTrackSource('M83', 'Midnight City', 'dX3k_QDnzHE');
  const cleared = trackSourceStore.getSavedTrackSource('M83', 'Midnight City');
  assert.equal(cleared.selectedSource, null);

  // Reset clears everything
  await trackSourceStore.resetTrackSource('M83', 'Midnight City');
  assert.equal(trackSourceStore.getSavedTrackSource('M83', 'Midnight City'), null);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('TrackSourceStore HTTP API: requires X-Eclipse-Token and persists save/block/reset', async () => {
  const dir = makeTempDir();
  const port = await startServer(0, { userDataDir: dir });
  const token = getServerToken();

  try {
    const unauth = await httpRequest(port, 'GET', '/api/track-source?artist=M83&title=Midnight%20City');
    assert.equal(unauth.status, 403);

    const saveRes = await httpRequest(port, 'POST', '/api/track-source', {
      headers: { 'X-Eclipse-Token': token },
      body: {
        artist: 'M83',
        title: 'Midnight City',
        provider: 'youtube',
        sourceId: 'dX3k_QDnzHE',
        canonicalUrl: 'https://www.youtube.com/watch?v=dX3k_QDnzHE'
      }
    });
    assert.equal(saveRes.status, 200);
    assert.equal(saveRes.json.data.selectedSource.sourceId, 'dX3k_QDnzHE');

    const getRes = await httpRequest(port, 'GET', '/api/track-source?artist=M83&title=Midnight%20City', {
      headers: { 'X-Eclipse-Token': token }
    });
    assert.equal(getRes.status, 200);
    assert.equal(getRes.json.data.selectedSource.canonicalUrl, 'https://www.youtube.com/watch?v=dX3k_QDnzHE');

    const blockRes = await httpRequest(port, 'POST', '/api/track-source/block', {
      headers: { 'X-Eclipse-Token': token },
      body: { artist: 'M83', title: 'Midnight City', sourceId: 'dX3k_QDnzHE' }
    });
    assert.equal(blockRes.status, 200);
    assert.equal(blockRes.json.data.selectedSource, null);

    const resetRes = await httpRequest(port, 'POST', '/api/track-source/reset', {
      headers: { 'X-Eclipse-Token': token },
      body: { artist: 'M83', title: 'Midnight City' }
    });
    assert.equal(resetRes.status, 200);
    assert.equal(resetRes.json.data.selectedSource, null);
  } finally {
    await stopServer();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
