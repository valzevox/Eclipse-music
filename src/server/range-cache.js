// src/server/range-cache.js
// Seek-aware bounded LRU audio range cache for Eclipse audio proxy (clean-room MIT)
'use strict';

function parseRangeHeader(rangeHdr) {
  if (!rangeHdr || typeof rangeHdr !== 'string') return null;
  const m = /^bytes=(\d+)-(\d*)$/i.exec(rangeHdr.trim());
  if (!m) return null;
  const start = Number(m[1]);
  const end = m[2] !== '' ? Number(m[2]) : null;
  if (!Number.isFinite(start) || start < 0) return null;
  if (end !== null && (!Number.isFinite(end) || end < start)) return null;
  return { start, end, openEnded: end === null };
}

function extractUpstreamExpiryMs(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  try {
    const parsed = new URL(rawUrl);
    const exp = parsed.searchParams.get('expire');
    if (exp && /^\d+$/.test(exp)) {
      const sec = Number(exp);
      if (Number.isFinite(sec) && sec > 1_000_000_000) {
        return sec * 1000;
      }
    }
  } catch (_) {}
  return null;
}

class AdaptiveRangeCache {
  constructor(options = {}) {
    this.maxTotalBytes = Number.isFinite(options.maxTotalBytes) && options.maxTotalBytes > 0
      ? options.maxTotalBytes
      : 32 * 1024 * 1024;
    this.maxEntries = Number.isFinite(options.maxEntries) && options.maxEntries > 0
      ? options.maxEntries
      : 64;
    this.ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0
      ? options.ttlMs
      : 30 * 60 * 1000;

    this.entries = new Map(); // url -> { spans: [{ start, buffer }], contentType, totalLength, timestamp, totalBytes }
    this.totalBytes = 0;
  }

  _evictIfNeeded() {
    while (this.entries.size > this.maxEntries || this.totalBytes > this.maxTotalBytes) {
      const oldestKey = this.entries.keys().next().value;
      if (!oldestKey) break;
      this.delete(oldestKey);
    }
  }

  delete(url) {
    const entry = this.entries.get(url);
    if (!entry) return;
    this.totalBytes = Math.max(0, this.totalBytes - entry.totalBytes);
    this.entries.delete(url);
  }

  put(url, { start = 0, buffer, contentType = 'audio/mp4', totalLength = '*' } = {}) {
    if (!url || !Buffer.isBuffer(buffer) || buffer.length === 0) return;
    if (buffer.length > this.maxTotalBytes) return;

    let entry = this.entries.get(url);
    if (!entry) {
      entry = {
        spans: [],
        contentType,
        totalLength: totalLength || '*',
        timestamp: Date.now(),
        totalBytes: 0
      };
    } else {
      this.entries.delete(url);
      entry.timestamp = Date.now();
      if (contentType) entry.contentType = contentType;
      if (totalLength && totalLength !== '*') entry.totalLength = totalLength;
    }

    const end = start + buffer.length - 1;
    // Merge overlapping or adjacent spans
    const nextSpans = [];
    let mergedStart = start;
    let mergedBuf = buffer;

    for (const sp of entry.spans) {
      const spEnd = sp.start + sp.buffer.length - 1;
      if (spEnd + 1 < mergedStart || sp.start > mergedStart + mergedBuf.length) {
        nextSpans.push(sp);
      } else {
        const newStart = Math.min(sp.start, mergedStart);
        const newEnd = Math.max(spEnd, mergedStart + mergedBuf.length - 1);
        const combined = Buffer.allocUnsafe(newEnd - newStart + 1);
        sp.buffer.copy(combined, sp.start - newStart);
        mergedBuf.copy(combined, mergedStart - newStart);
        mergedStart = newStart;
        mergedBuf = combined;
      }
    }
    nextSpans.push({ start: mergedStart, buffer: mergedBuf });
    nextSpans.sort((a, b) => a.start - b.start);

    const newEntryBytes = nextSpans.reduce((acc, s) => acc + s.buffer.length, 0);
    this.totalBytes = Math.max(0, this.totalBytes - entry.totalBytes) + newEntryBytes;
    entry.spans = nextSpans;
    entry.totalBytes = newEntryBytes;

    this.entries.set(url, entry);
    this._evictIfNeeded();
  }

  get(url, rangeHdr) {
    const parsed = parseRangeHeader(rangeHdr);
    if (!parsed) return null;

    const entry = this.entries.get(url);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.delete(url);
      return null;
    }

    let reqEnd = parsed.end;
    if (parsed.openEnded) {
      const totalNum = Number(entry.totalLength);
      if (!Number.isFinite(totalNum) || totalNum <= 0) {
        return null;
      }
      reqEnd = totalNum - 1;
    }

    if (reqEnd < parsed.start) return null;

    for (const sp of entry.spans) {
      const spEnd = sp.start + sp.buffer.length - 1;
      if (parsed.start >= sp.start && reqEnd <= spEnd) {
        // Refresh LRU position
        this.entries.delete(url);
        this.entries.set(url, entry);
        const slice = sp.buffer.subarray(parsed.start - sp.start, reqEnd - sp.start + 1);
        return {
          buffer: slice,
          start: parsed.start,
          end: reqEnd,
          contentType: entry.contentType,
          totalLength: entry.totalLength
        };
      }
    }

    return null;
  }

  evictUrl(url) {
    return this.delete(url);
  }
}

module.exports = {
  AdaptiveRangeCache,
  parseRangeHeader,
  extractUpstreamExpiryMs
};
