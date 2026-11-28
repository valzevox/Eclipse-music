// JavaScript / mv-mapping-store.js / Node.js / Persistent MV Mapping Store
// Part of Eclipse Music Player — MIT License

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const SCHEMA_VERSION = 1;
const AUTO_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

let configuredUserDataDir = null;
let writeQueue = Promise.resolve();

function configure({ userDataDir } = {}) {
  if (typeof userDataDir === 'string' && userDataDir.trim()) {
    configuredUserDataDir = userDataDir.trim();
  }
}

function getStoreDir() {
  return configuredUserDataDir || path.join(os.tmpdir(), 'eclipse-mv-store');
}

function getStorePath() {
  return path.join(getStoreDir(), 'mv-mappings.json');
}

function createEmptyStore() {
  return { schemaVersion: SCHEMA_VERSION, mappings: {} };
}

function readStoreSync() {
  const filePath = getStorePath();
  try {
    if (!fs.existsSync(filePath)) return createEmptyStore();
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.mappings !== 'object') {
      return createEmptyStore();
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      mappings: parsed.mappings
    };
  } catch (_) {
    return createEmptyStore();
  }
}

async function atomicWriteStore(store) {
  const dir = getStoreDir();
  const filePath = getStorePath();
  await fs.promises.mkdir(dir, { recursive: true });
  const tmpPath = path.join(dir, `mv-mappings.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}.json`);
  const payload = JSON.stringify(store, null, 2);
  await fs.promises.writeFile(tmpPath, payload, 'utf8');
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

function getOffsetForVideo(songId, mvVideoId) {
  if (!songId || !mvVideoId) return 0;
  const store = readStoreSync();
  const entry = store.mappings[songId];
  const offsetEntry = entry?.offsetsByVideoId?.[mvVideoId];
  return Number.isFinite(offsetEntry?.offsetMs) ? offsetEntry.offsetMs : 0;
}

function getMapping(songId, now = Date.now()) {
  if (!songId) return null;
  const store = readStoreSync();
  const entry = store.mappings[songId];
  if (!entry || !entry.mvVideoId) return null;

  const isExpired = !entry.userOverride && Number.isFinite(entry.mappingExpiresAt) && now > entry.mappingExpiresAt;
  const offsetMs = Number.isFinite(entry.offsetsByVideoId?.[entry.mvVideoId]?.offsetMs)
    ? entry.offsetsByVideoId[entry.mvVideoId].offsetMs
    : 0;

  return {
    ...entry,
    offsetMs,
    expired: isExpired
  };
}

async function saveAutoMapping(songId, { mvVideoId, confidence = 0, ttlMs = AUTO_TTL_MS, now = Date.now() } = {}) {
  if (!songId || !mvVideoId) throw new Error('songId and mvVideoId are required');
  return enqueueMutation((store) => {
    const prev = store.mappings[songId] || {};
    const offsetsByVideoId = prev.offsetsByVideoId && typeof prev.offsetsByVideoId === 'object'
      ? { ...prev.offsetsByVideoId }
      : {};
    const next = {
      mvVideoId,
      source: 'auto',
      userOverride: false,
      unavailable: false,
      confidence,
      mappingExpiresAt: now + ttlMs,
      offsetsByVideoId,
      createdAt: prev.createdAt || now,
      updatedAt: now
    };
    store.mappings[songId] = next;
    const offsetMs = Number.isFinite(offsetsByVideoId[mvVideoId]?.offsetMs)
      ? offsetsByVideoId[mvVideoId].offsetMs
      : 0;
    return { ...next, offsetMs };
  });
}

async function saveManualOverride(songId, { mvVideoId, offsetMs, offsetUserOverride = true, now = Date.now() } = {}) {
  if (!songId || !/^[a-zA-Z0-9_-]{11}$/.test(String(mvVideoId || ''))) {
    throw new Error('Valid songId and 11-char mvVideoId are required');
  }
  return enqueueMutation((store) => {
    const prev = store.mappings[songId] || {};
    const offsetsByVideoId = prev.offsetsByVideoId && typeof prev.offsetsByVideoId === 'object'
      ? { ...prev.offsetsByVideoId }
      : {};
    if (Number.isFinite(offsetMs)) {
      offsetsByVideoId[mvVideoId] = {
        offsetMs,
        offsetUserOverride: Boolean(offsetUserOverride),
        updatedAt: now
      };
    }
    const next = {
      mvVideoId,
      source: 'manual',
      userOverride: true,
      unavailable: false,
      confidence: 1,
      mappingExpiresAt: null,
      offsetsByVideoId,
      createdAt: prev.createdAt || now,
      updatedAt: now
    };
    store.mappings[songId] = next;
    const resolvedOffset = Number.isFinite(offsetsByVideoId[mvVideoId]?.offsetMs)
      ? offsetsByVideoId[mvVideoId].offsetMs
      : 0;
    return { ...next, offsetMs: resolvedOffset };
  });
}

async function invalidateMapping(songId, { reason = 'unavailable', now = Date.now() } = {}) {
  if (!songId) return null;
  return enqueueMutation((store) => {
    const prev = store.mappings[songId];
    if (!prev) return null;
    if (prev.userOverride) {
      const next = {
        ...prev,
        unavailable: true,
        unavailableReason: reason,
        updatedAt: now
      };
      store.mappings[songId] = next;
      return next;
    }
    const next = {
      ...prev,
      mvVideoId: null,
      mappingExpiresAt: 0,
      unavailable: false,
      updatedAt: now
    };
    store.mappings[songId] = next;
    return next;
  });
}

module.exports = {
  SCHEMA_VERSION,
  AUTO_TTL_MS,
  configure,
  getStorePath,
  getMapping,
  getOffsetForVideo,
  saveAutoMapping,
  saveManualOverride,
  invalidateMapping
};
