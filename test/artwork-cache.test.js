// test/artwork-cache.test.js
// Unit & regression tests for StaleFirstArtworkCache (disk mtimeMs seeding, real network refresh, failure preservation)
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { StaleFirstArtworkCache } = require('../src/server/artwork-cache');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('StaleFirstArtworkCache: stale disk image triggers real network refresh and preserves stale copy on failure', async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'eclipse-art-'));
  const diskFile = path.join(tmpDir, 'cover.jpg');
  const staleBuf = Buffer.alloc(1024, 0x11);
  const freshBuf = Buffer.alloc(1024, 0x22);

  try {
    await fs.promises.writeFile(diskFile, staleBuf);
    const oldTime = new Date(Date.now() - 10_000);
    await fs.promises.utimes(diskFile, oldTime, oldTime);
    const st = await fs.promises.stat(diskFile);

    const cache = new StaleFirstArtworkCache({ ttlMs: 1000, failureCooldownMs: 50, maxConcurrent: 2 });
    const url = 'https://example.com/art/cover.jpg';
    cache.seedFromDisk(url, staleBuf, 'image/jpeg', st.mtimeMs);

    // 1. Failing network refresh must return stale immediately AND preserve stale entry + original timestamp
    let failCalls = 0;
    const res1 = await cache.getOrFetch(url, async () => {
      failCalls += 1;
      throw new Error('network_down');
    });
    assert.equal(res1.stale, true);
    assert.deepEqual(res1.buffer, staleBuf);
    await sleep(30);
    assert.equal(failCalls, 1, 'Stale disk entry must trigger real network refresh');
    assert.equal(cache.cache.get(url).timestamp, st.mtimeMs, 'Failed refresh must preserve original stale timestamp');

    // 2. After cooldown, succeeding network refresh updates memory with fresh buffer
    await sleep(60);
    let okCalls = 0;
    const res2 = await cache.getOrFetch(url, async () => {
      okCalls += 1;
      return { buffer: freshBuf, contentType: 'image/jpeg' };
    });
    assert.equal(res2.stale, true, 'Stale-first returns stale immediately while refreshing in background');
    await sleep(30);
    assert.equal(okCalls, 1);

    const res3 = await cache.getOrFetch(url, async () => {
      throw new Error('should_not_fetch_when_fresh');
    });
    assert.equal(res3.stale, false);
    assert.deepEqual(res3.buffer, freshBuf);
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  }
});

test('StaleFirstArtworkCache: deduplicates concurrent in-flight fetches per URL and bounds concurrency', async () => {
  const cache = new StaleFirstArtworkCache({ ttlMs: 5000, maxConcurrent: 2 });
  let active = 0;
  let maxActive = 0;
  let totalCalls = 0;

  const fetcher = async (url) => {
    totalCalls += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    await sleep(40);
    active -= 1;
    return { buffer: Buffer.from(url.padEnd(600, 'x')), contentType: 'image/jpeg' };
  };

  const results = await Promise.all([
    cache.getOrFetch('https://example.com/1.jpg', fetcher),
    cache.getOrFetch('https://example.com/1.jpg', fetcher),
    cache.getOrFetch('https://example.com/2.jpg', fetcher),
    cache.getOrFetch('https://example.com/3.jpg', fetcher),
    cache.getOrFetch('https://example.com/4.jpg', fetcher)
  ]);

  assert.equal(results.length, 5);
  assert.equal(totalCalls, 4, 'Duplicate URL must be deduplicated');
  assert.ok(maxActive <= 2, `Concurrency must be bounded to 2, got ${maxActive}`);
});
