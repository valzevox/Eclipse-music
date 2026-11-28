// JavaScript / track-source-store.js / Node.js / Persistent Audio Source Mapping Store
// Part of Eclipse Music Player — MIT License

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const SCHEMA_VERSION = 1;
const MAX_BLOCKED_SOURCES = 20;

let configuredUserDataDir = null;
let writeQueue = Promise.resolve();

function configure({ userDataDir } = {}) {
  if (typeof userDataDir === 'string' && userDataDir.trim()) {
    configuredUserDataDir = userDataDir.trim();
  }
}

function getStoreDir() {
  return configuredUserDataDir || path.join(os.tmpdir(), 'eclipse-track-source-store');
}

function getStorePath() {
  return path.join(getStoreDir(), 'track-source-mappings.json');
}

function normalizePart(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/\s*-\s*topic$/i, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeTrackKey(artist, title) {
  const a = normalizePart(artist);
  const t = normalizePart(title);
  if (!a && !t) return '';
  return `${a}::${t}`;
}

function createEmptyStore() {
  return { schemaVersion: SCHEMA_VERSION, tracks: {} };
}

function readStoreSync() {
  const filePath = getStorePath();
  try {
    if (!fs.existsSync(filePath)) return createEmptyStore();
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.tracks !== 'object') {
      return createEmptyStore();
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      tracks: parsed.tracks
    };
  } catch (_) {
    return createEmptyStore();
  }
}

async function atomicWriteStore(store) {
  const dir = getStoreDir();
  const filePath = getStorePath();
  await fs.promises.mkdir(dir, { recursive: true });
  const tmpPath = path.join(dir, `track-source.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}.json`);
  await fs.promises.writeFile(tmpPath, JSON.stringify(store, null, 2), 'utf8');
  await fs.promises.rename(tmpPath, filePath);
}

function enqueueMutation(mutator) {
  const run = writeQueue.then(async () => {
    const store = readStoreSync();
    const result = await mutator(store);
    await atomicWriteStore(store);
    return result;
  });
  writeQueue = run.catch(() => {});
  return run;
}

function sanitizeCanonicalUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return '';
  const trimmed = rawUrl.trim();
  if (!trimmed) return '';
  // Never persist expiring signed stream URLs
  if (/googlevideo\.com|\/api\/audio-proxy|\.m3u8/i.test(trimmed)) return '';
  return trimmed;
}

function getSavedTrackSource(artist, title) {
  const key = normalizeTrackKey(artist, title);
  if (!key) return null;
  const store = readStoreSync();
  const entry = store.tracks[key];
  if (!entry) return null;
  return {
    normalizedTrackKey: key,
    selectedSource: entry.selectedSource || null,
    blockedSourceIds: Array.isArray(entry.blockedSourceIds) ? [...entry.blockedSourceIds] : []
  };
}

async function saveTrackSource(artist, title, { provider = 'youtube', sourceId, canonicalUrl = '', sourceMeta = {}, selection = 'manual', now = Date.now() } = {}) {
  const key = normalizeTrackKey(artist, title);
  const cleanSourceId = String(sourceId || '').trim();
  if (!key || !cleanSourceId) {
    throw new Error('artist/title and sourceId are required');
  }
  return enqueueMutation((store) => {
    const prev = store.tracks[key] || { normalizedTrackKey: key, blockedSourceIds: [] };
    const blocked = Array.isArray(prev.blockedSourceIds)
      ? prev.blockedSourceIds.filter((id) => id !== cleanSourceId)
      : [];
    const next = {
      normalizedTrackKey: key,
      selectedSource: {
        provider: String(provider || 'youtube').trim(),
        sourceId: cleanSourceId,
        canonicalUrl: sanitizeCanonicalUrl(canonicalUrl),
        sourceMeta: {
          title: String(sourceMeta?.title || title || '').trim(),
          artist: String(sourceMeta?.artist || artist || '').trim(),
          thumbnail: String(sourceMeta?.thumbnail || '').trim()
        },
        selection: selection === 'auto' ? 'auto' : 'manual',
        updatedAt: now
      },
      blockedSourceIds: blocked
    };
    store.tracks[key] = next;
    return next;
  });
}

async function blockTrackSource(artist, title, sourceId) {
  const key = normalizeTrackKey(artist, title);
  const cleanSourceId = String(sourceId || '').trim();
  if (!key || !cleanSourceId) {
    throw new Error('artist/title and sourceId are required');
  }
  return enqueueMutation((store) => {
    const prev = store.tracks[key] || { normalizedTrackKey: key, selectedSource: null, blockedSourceIds: [] };
    const blocked = Array.isArray(prev.blockedSourceIds)
      ? prev.blockedSourceIds.filter((id) => id !== cleanSourceId)
      : [];
    blocked.push(cleanSourceId);
    while (blocked.length > MAX_BLOCKED_SOURCES) {
      blocked.shift();
    }
    const selectedSource = prev.selectedSource && prev.selectedSource.sourceId === cleanSourceId
      ? null
      : (prev.selectedSource || null);
    const next = {
      normalizedTrackKey: key,
      selectedSource,
      blockedSourceIds: blocked
    };
    store.tracks[key] = next;
    return next;
  });
}

async function resetTrackSource(artist, title) {
  const key = normalizeTrackKey(artist, title);
  if (!key) return null;
  return enqueueMutation((store) => {
    delete store.tracks[key];
    return { normalizedTrackKey: key, selectedSource: null, blockedSourceIds: [] };
  });
}

module.exports = {
  SCHEMA_VERSION,
  MAX_BLOCKED_SOURCES,
  configure,
  getStorePath,
  normalizeTrackKey,
  getSavedTrackSource,
  saveTrackSource,
  blockTrackSource,
  resetTrackSource
};
