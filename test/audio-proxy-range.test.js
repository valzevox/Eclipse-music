const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const stream = require('node:stream');

test('Audio Proxy: 256 KiB probe caches chunk and serves subsequent exact range', async () => {
  let upstreamHits = 0;
  const dummyAudio = Buffer.alloc(500000, 0x41); // 500 KB dummy audio

  // Mock upstream media server
  const upstreamServer = http.createServer((req, res) => {
    upstreamHits++;
    const range = req.headers['range'];
    if (range === 'bytes=0-262143') {
      res.writeHead(206, {
        'Content-Type': 'audio/mp4',
        'Content-Range': 'bytes 0-262143/500000',
        'Content-Length': '262144',
        'Accept-Ranges': 'bytes'
      });
      res.end(dummyAudio.subarray(0, 262144));
    } else {
      res.writeHead(200, {
        'Content-Type': 'audio/mp4',
        'Content-Length': '500000'
      });
      res.end(dummyAudio);
    }
  });

  await new Promise(r => upstreamServer.listen(0, '127.0.0.1', r));
  const upstreamPort = upstreamServer.address().port;
  const targetMediaUrl = `http://cdn.eclipsestream.org:${upstreamPort}/audio.mp4`;

  try {
    const { handleAudioProxy } = require('../src/server/server.js');

    const customPinLookup = async (hostname) => {
      return [{ address: '93.184.216.34', family: 4 }];
    };

    const customHttpClient = {
      request: (targetUrl, requestOpts, callback) => {
        const parsedTarget = new URL(targetUrl);
        return http.request({
          ...requestOpts,
          host: '127.0.0.1',
          port: upstreamPort,
          path: parsedTarget.pathname + parsedTarget.search
        }, callback);
      }
    };

    // 1. Initial 256 KiB probe
    const mockReq1 = new stream.PassThrough();
    mockReq1.method = 'GET';
    mockReq1.headers = { range: 'bytes=0-262143' };
    mockReq1.end();

    let statusCode1 = 0;
    let headers1 = {};
    const chunks1 = [];
    const mockRes1 = new stream.PassThrough();
    mockRes1.writeHead = (st, hdrs) => { statusCode1 = st; headers1 = hdrs; };
    mockRes1.on('data', (c) => chunks1.push(c));

    const done1 = new Promise((resolve) => {
      mockRes1.on('finish', resolve);
      mockRes1.on('end', resolve);
    });

    await handleAudioProxy(mockReq1, mockRes1, targetMediaUrl, 5, null, { lookup: customPinLookup, httpClient: customHttpClient });
    await done1;

    assert.strictEqual(statusCode1, 206);
    assert.strictEqual(chunks1.reduce((a, b) => a + b.length, 0), 262144);
    assert.strictEqual(upstreamHits, 1);

    // 2. Second request with exact range bytes=0-262143 should be served from memory cache
    const mockReq2 = new stream.PassThrough();
    mockReq2.method = 'GET';
    mockReq2.headers = { range: 'bytes=0-262143' };
    mockReq2.end();

    let statusCode2 = 0;
    let headers2 = {};
    const chunks2 = [];
    const mockRes2 = new stream.PassThrough();
    mockRes2.writeHead = (st, hdrs) => { statusCode2 = st; headers2 = hdrs; };
    mockRes2.on('data', (c) => chunks2.push(c));

    const done2 = new Promise((resolve) => {
      mockRes2.on('finish', resolve);
      mockRes2.on('end', resolve);
    });

    await handleAudioProxy(mockReq2, mockRes2, targetMediaUrl, 5, null, { lookup: customPinLookup, httpClient: customHttpClient });
    await done2;

    assert.strictEqual(statusCode2, 206);
    assert.strictEqual(chunks2.reduce((a, b) => a + b.length, 0), 262144);
    assert.strictEqual(upstreamHits, 1); // No second upstream request! Served from streamInitialChunkCache
  } finally {
    upstreamServer.close();
  }
});
