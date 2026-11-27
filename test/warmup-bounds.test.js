// test/warmup-bounds.test.js
// P0 tests: strictly bounded Range warm-up (HTTP 206 only, Content-Range validation, hard byte cap, no false verified markers)
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { EclipsePreloadManager } = require('../src/renderer/preload-manager');
const { PreloadManager } = require('../src/renderer/automix/preload-manager');

test('Warm-up Bounds: accepts valid 206, rejects HTTP 200 multi-MB, bad Content-Range, and empty responses', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/valid-206') {
      const buf = Buffer.alloc(65536, 0x41);
      res.writeHead(206, {
        'Content-Type': 'audio/mp4',
        'Content-Range': 'bytes 0-65535/524288',
        'Content-Length': '65536'
      });
      return res.end(buf);
    }
    if (req.url === '/full-200') {
      // Simulate server ignoring Range and sending 2 MB HTTP 200
      res.writeHead(200, { 'Content-Type': 'audio/mp4', 'Content-Length': String(2 * 1024 * 1024) });
      return res.end(Buffer.alloc(2 * 1024 * 1024, 0x42));
    }
    if (req.url === '/bad-range') {
      res.writeHead(206, {
        'Content-Type': 'audio/mp4',
        'Content-Range': 'bytes 100-200/524288',
        'Content-Length': '101'
      });
      return res.end(Buffer.alloc(101, 0x43));
    }
    if (req.url === '/empty-206') {
      res.writeHead(206, {
        'Content-Type': 'audio/mp4',
        'Content-Range': 'bytes 0-0/524288',
        'Content-Length': '0'
      });
      return res.end();
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  try {
    globalThis.__eclipseWarmedState = { inflight: new Map(), verified: new Map() };
    const ep = new EclipsePreloadManager({ serverPort: port, rangeWarmUpBytes: 65536 });
    const am = new PreloadManager({ apiBase: base });

    // 1. Valid 206
    assert.equal(await ep._warmUpRange(`${base}/valid-206`), true);
    assert.equal(globalThis.__eclipseWarmedState.verified.has(`${base}/valid-206`), true);

    // 2. HTTP 200 multi-MB must be rejected and NOT marked verified
    assert.equal(await ep._warmUpRange(`${base}/full-200`), false);
    assert.equal(globalThis.__eclipseWarmedState.verified.has(`${base}/full-200`), false);
    assert.equal(await am.warmUpBuffer(`${base}/full-200`), false);
    assert.equal(globalThis.__eclipseWarmedState.verified.has(`${base}/full-200`), false);

    // 3. Incorrect Content-Range must be rejected and NOT marked verified
    assert.equal(await ep._warmUpRange(`${base}/bad-range`), false);
    assert.equal(globalThis.__eclipseWarmedState.verified.has(`${base}/bad-range`), false);

    // 4. Empty response must be rejected and NOT marked verified
    assert.equal(await ep._warmUpRange(`${base}/empty-206`), false);
    assert.equal(globalThis.__eclipseWarmedState.verified.has(`${base}/empty-206`), false);

    // 5. Truncated 206 body (declares 0-65535 but sends only 1024 bytes) must be rejected
    const truncServer = http.createServer((req, res) => {
      res.writeHead(206, {
        'Content-Type': 'audio/mp4',
        'Content-Range': 'bytes 0-65535/524288',
        'Content-Length': '1024'
      });
      res.end(Buffer.alloc(1024, 0x44));
    });
    await new Promise((r) => truncServer.listen(0, '127.0.0.1', r));
    const truncUrl = `http://127.0.0.1:${truncServer.address().port}/trunc`;
    try {
      assert.equal(await ep._warmUpRange(truncUrl), false);
      assert.equal(globalThis.__eclipseWarmedState.verified.has(truncUrl), false);
    } finally {
      await new Promise((r) => truncServer.close(r));
    }

    // 6. Missing getReader() must return false and cancel body rather than buffering unboundedly
    const origFetch = globalThis.fetch;
    let cancelled = false;
    globalThis.fetch = async () => ({
      status: 206,
      headers: { get: (k) => (k.toLowerCase() === 'content-range' ? 'bytes 0-65535/524288' : null) },
      body: { cancel: async () => { cancelled = true; } },
      arrayBuffer: async () => { throw new Error('arrayBuffer must not be called'); }
    });
    try {
      assert.equal(await ep._warmUpRange(`${base}/no-reader`), false);
      assert.equal(cancelled, true);
      assert.equal(globalThis.__eclipseWarmedState.verified.has(`${base}/no-reader`), false);
    } finally {
      globalThis.fetch = origFetch;
    }
  } finally {
    await new Promise((r) => server.close(r));
  }
});
