// src/server/artwork-cache.js
// Stale-first artwork cache with per-URL deduplication, bounded concurrency, and failure cooldown (clean-room MIT)
'use strict';

class StaleFirstArtworkCache {
  constructor(options = {}) {
    this.ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : 24 * 60 * 60 * 1000;
    this.maxEntries = Number.isFinite(options.maxEntries) && options.maxEntries > 0 ? options.maxEntries : 200;
    this.maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : 24 * 1024 * 1024;
    this.maxItemBytes = Number.isFinite(options.maxItemBytes) && options.maxItemBytes > 0 ? options.maxItemBytes : 2 * 1024 * 1024;
    this.failureCooldownMs = Number.isFinite(options.failureCooldownMs) && options.failureCooldownMs > 0 ? options.failureCooldownMs : 60 * 1000;
    this.maxConcurrent = Number.isFinite(options.maxConcurrent) && options.maxConcurrent > 0 ? options.maxConcurrent : 4;

    this.cache = new Map(); // url -> { buffer, contentType, timestamp }
    this.totalBytes = 0;
    this.inflight = new Map(); // url -> Promise
    this.failedAt = new Map(); // url -> timestamp
    this.activeCount = 0;
    this.waitQueue = [];
  }

  _evictIfNeeded() {
    while (this.cache.size > this.maxEntries || this.totalBytes > this.maxBytes) {
      const oldest = this.cache.keys().next().value;
      if (!oldest) break;
      const item = this.cache.get(oldest);
      if (item) this.totalBytes = Math.max(0, this.totalBytes - item.buffer.length);
      this.cache.delete(oldest);
    }
  }

  _set(url, buffer, contentType, timestamp = Date.now()) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > this.maxItemBytes) return false;
    const prev = this.cache.get(url);
    if (prev) {
      this.totalBytes = Math.max(0, this.totalBytes - prev.buffer.length);
      this.cache.delete(url);
    }
    this.cache.set(url, { buffer, contentType: contentType || 'image/jpeg', timestamp });
    this.totalBytes += buffer.length;
    this._evictIfNeeded();
    return true;
  }

  seedFromDisk(url, buffer, contentType, mtimeMs) {
    if (!url || !Buffer.isBuffer(buffer) || buffer.length === 0) return false;
    if (this.cache.has(url)) return true;
    const ts = Number.isFinite(mtimeMs) && mtimeMs > 0 ? mtimeMs : 0;
    return this._set(url, buffer, contentType, ts);
  }

  _withConcurrency(fn) {
    return new Promise((resolve, reject) => {
      const run = () => {
        this.activeCount += 1;
        Promise.resolve()
          .then(fn)
          .then(
            (v) => { this.activeCount -= 1; this._drain(); resolve(v); },
            (e) => { this.activeCount -= 1; this._drain(); reject(e); }
          );
      };
      if (this.activeCount < this.maxConcurrent) run();
      else this.waitQueue.push(run);
    });
  }

  _drain() {
    while (this.activeCount < this.maxConcurrent && this.waitQueue.length > 0) {
      const next = this.waitQueue.shift();
      next();
    }
  }

  async getOrFetch(url, fetcher, { validateImage = null } = {}) {
    if (!url || typeof fetcher !== 'function') return null;

    const existing = this.cache.get(url);
    const now = Date.now();
    if (existing) {
      const isFresh = (now - existing.timestamp) < this.ttlMs;
      if (isFresh) {
        return { buffer: existing.buffer, contentType: existing.contentType, stale: false, hit: true };
      }
      // Stale-first: return stale immediately and refresh in background if not in cooldown
      const lastFail = this.failedAt.get(url) || 0;
      if (now - lastFail >= this.failureCooldownMs && !this.inflight.has(url)) {
        this._refresh(url, fetcher, validateImage).catch(() => {});
      }
      return { buffer: existing.buffer, contentType: existing.contentType, stale: true, hit: true };
    }

    const lastFail = this.failedAt.get(url) || 0;
    if (now - lastFail < this.failureCooldownMs) {
      return null;
    }

    const refreshed = await this._refresh(url, fetcher, validateImage);
    if (!refreshed) return null;
    return { buffer: refreshed.buffer, contentType: refreshed.contentType, stale: false, hit: false };
  }

  _refresh(url, fetcher, validateImage) {
    if (this.inflight.has(url)) return this.inflight.get(url);

    const p = this._withConcurrency(async () => {
      try {
        const res = await fetcher(url);
        if (!res || !Buffer.isBuffer(res.buffer) || res.buffer.length === 0) {
          this.failedAt.set(url, Date.now());
          return null;
        }
        if (typeof validateImage === 'function' && !validateImage(res.buffer, res.contentType)) {
          this.failedAt.set(url, Date.now());
          return null;
        }
        const stored = this._set(url, res.buffer, res.contentType);
        if (!stored) {
          this.failedAt.set(url, Date.now());
          return null;
        }
        this.failedAt.delete(url);
        return { buffer: res.buffer, contentType: res.contentType || 'image/jpeg' };
      } catch (_) {
        this.failedAt.set(url, Date.now());
        return null;
      } finally {
        this.inflight.delete(url);
      }
    });

    this.inflight.set(url, p);
    return p;
  }
}

module.exports = { StaleFirstArtworkCache };
