'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { BrowserCookieRecord } = require('./browser-cookie-record');
const { BrowserLoginTarget, resolveTargetHost } = require('./browser-login-targets');
const { BrowserLoginFailure, BrowserLoginException } = require('./browser-login-errors');
const { validateExternalSessionCookies } = require('./external-cookie-validator');

const DEFAULT_MAX_COPY_BYTES = 50 * 1024 * 1024; // 50 MB
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_ABANDONED_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
const SNAPSHOT_DIR_PREFIX = 'gecko-snap-';

let snapshotQueue = Promise.resolve();

function enqueueSnapshot(fn) {
  const run = snapshotQueue.then(fn, fn);
  snapshotQueue = run.catch(() => {});
  return run;
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

/**
 * Remove abandoned Gecko snapshot temp directories from os.tmpdir().
 */
function cleanupAbandonedGeckoSnapshots(options = {}) {
  const tmpRoot = options.tmpRoot || os.tmpdir();
  const maxAgeMs = Number.isFinite(options.maxAgeMs) ? options.maxAgeMs : DEFAULT_ABANDONED_MAX_AGE_MS;
  const force = options.force === true;
  const now = Date.now();
  let removed = 0;

  let entries;
  try {
    entries = fs.readdirSync(tmpRoot, { withFileTypes: true });
  } catch (_) {
    return 0;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(SNAPSHOT_DIR_PREFIX)) continue;
    const fullPath = path.join(tmpRoot, entry.name);
    const match = /^gecko-snap-(\d+)-(\d+)-/.exec(entry.name);
    const pid = match ? Number(match[1]) : NaN;
    const createdAt = match ? Number(match[2]) : NaN;

    let shouldRemove = force;
    if (!shouldRemove && Number.isInteger(pid) && pid !== process.pid && !isProcessAlive(pid)) {
      shouldRemove = true;
    }
    if (!shouldRemove && Number.isFinite(createdAt) && (now - createdAt) > maxAgeMs) {
      shouldRemove = true;
    }
    if (!shouldRemove && !match) {
      try {
        const st = fs.statSync(fullPath);
        if ((now - st.mtimeMs) > maxAgeMs) shouldRemove = true;
      } catch (_) {}
    }

    if (shouldRemove) {
      try {
        fs.rmSync(fullPath, { recursive: true, force: true });
        removed++;
      } catch (_) {}
    }
  }

  return removed;
}

function statSnapshotSources(dbPath) {
  const files = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
  const meta = [];
  let totalBytes = 0;

  for (const filePath of files) {
    if (!fs.existsSync(filePath)) {
      meta.push({ filePath, exists: false, size: 0, mtimeMs: 0 });
      continue;
    }
    const st = fs.statSync(filePath);
    if (!st.isFile()) {
      throw new BrowserLoginException(
        BrowserLoginFailure.PROFILE_ACCESS_DENIED,
        `Expected regular file for Gecko cookie store: ${path.basename(filePath)}`
      );
    }
    totalBytes += st.size;
    meta.push({ filePath, exists: true, size: st.size, mtimeMs: st.mtimeMs });
  }

  return { meta, totalBytes };
}

function metadataMatches(before, after) {
  if (before.length !== after.length) return false;
  for (let i = 0; i < before.length; i++) {
    const a = before[i];
    const b = after[i];
    if (a.exists !== b.exists || a.size !== b.size || a.mtimeMs !== b.mtimeMs) {
      return false;
    }
  }
  return true;
}

function clearSnapshotFiles(snapDb) {
  for (const f of [snapDb, `${snapDb}-wal`, `${snapDb}-shm`]) {
    try {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch (_) {}
  }
}

function copySnapshotWithRetries(dbPath, snapDb, maxCopyBytes, maxRetries) {
  let lastErr = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    clearSnapshotFiles(snapDb);

    let before;
    try {
      before = statSnapshotSources(dbPath);
    } catch (err) {
      if (err instanceof BrowserLoginException) throw err;
      lastErr = err;
      continue;
    }

    if (!before.meta[0].exists) {
      throw new BrowserLoginException(BrowserLoginFailure.NO_YOUTUBE_COOKIES, 'cookies.sqlite not found');
    }

    if (before.totalBytes > maxCopyBytes) {
      throw new BrowserLoginException(
        BrowserLoginFailure.PROFILE_ACCESS_DENIED,
        `Gecko cookie store exceeds max snapshot size (${before.totalBytes} > ${maxCopyBytes} bytes)`
      );
    }

    try {
      let copiedBytes = 0;
      for (const item of before.meta) {
        if (!item.exists) continue;
        const suffix = item.filePath.slice(dbPath.length);
        const dest = snapDb + suffix;
        fs.copyFileSync(item.filePath, dest);
        copiedBytes += fs.statSync(dest).size;
      }

      if (copiedBytes > maxCopyBytes) {
        throw new BrowserLoginException(
          BrowserLoginFailure.PROFILE_ACCESS_DENIED,
          `Gecko cookie snapshot exceeds max size (${copiedBytes} > ${maxCopyBytes} bytes)`
        );
      }

      const after = statSnapshotSources(dbPath);
      if (metadataMatches(before.meta, after.meta)) {
        return;
      }
      lastErr = new Error('Gecko cookie database metadata changed during snapshot copy');
    } catch (err) {
      if (err instanceof BrowserLoginException) throw err;
      lastErr = err;
    }
  }

  throw new BrowserLoginException(
    BrowserLoginFailure.PROFILE_ACCESS_DENIED,
    lastErr ? lastErr.message : 'Failed to capture consistent Gecko cookie snapshot'
  );
}

function openReadonlySqlite(snapDb) {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(snapDb, { readOnly: true });
    return {
      kind: 'node:sqlite',
      get(sql) {
        return db.prepare(sql).get();
      },
      all(sql) {
        return db.prepare(sql).all();
      },
      close() {
        db.close();
      }
    };
  } catch (_) {}

  try {
    const BetterSqlite3 = require('better-sqlite3');
    const db = BetterSqlite3(snapDb, { readonly: true, fileMustExist: true });
    return {
      kind: 'better-sqlite3',
      get(sql) {
        return db.prepare(sql).get();
      },
      all(sql) {
        return db.prepare(sql).all();
      },
      close() {
        db.close();
      }
    };
  } catch (_) {}

  throw new BrowserLoginException(
    BrowserLoginFailure.UNSUPPORTED_ENCRYPTION,
    'Native Gecko cookie reading requires SQLite driver. Please use the Eclipse Extension to connect your session.'
  );
}

function isNonDefaultContainer(originAttributes) {
  if (!originAttributes || typeof originAttributes !== 'string') return false;
  const trimmed = originAttributes.trim();
  if (!trimmed) return false;
  return /(?:^|\^)(?:privateBrowsingId|userContextId)=/i.test(trimmed);
}

function buildTargetWhereClause(target) {
  if (target === BrowserLoginTarget.YOUTUBE) {
    return "(host LIKE '%youtube.com' OR host LIKE '%google.com' OR host LIKE '%googlevideo.com')";
  }
  if (target === BrowserLoginTarget.EXTERNAL_WEB) {
    return "(host LIKE '%spotify.com')";
  }
  throw new BrowserLoginException(
    BrowserLoginFailure.INVALID_DATA,
    `Unsupported browser login target: ${target}`
  );
}

/**
 * Read cookies from a Gecko cookies.sqlite database using an immutable, serialized snapshot.
 * Copies sqlite db and -wal/-shm files to an owner-only temp folder to avoid DB locks and source mutation.
 */
async function readGeckoCookies(profilePath, target = BrowserLoginTarget.YOUTUBE, options = {}) {
  resolveTargetHost(target);

  return enqueueSnapshot(async () => {
    const dbPath = path.join(profilePath, 'cookies.sqlite');
    if (!fs.existsSync(dbPath)) {
      throw new BrowserLoginException(BrowserLoginFailure.NO_YOUTUBE_COOKIES, 'cookies.sqlite not found');
    }

    const maxCopyBytes = Number.isFinite(options.maxCopyBytes) && options.maxCopyBytes > 0
      ? options.maxCopyBytes
      : DEFAULT_MAX_COPY_BYTES;
    const maxRetries = Number.isInteger(options.maxRetries) && options.maxRetries > 0
      ? options.maxRetries
      : DEFAULT_MAX_RETRIES;
    const allowNonDefaultContainers = options.allowNonDefaultContainers === true || options.allowPrivateContainers === true;

    const tmpRoot = options.tmpRoot || os.tmpdir();
    const tmpDir = path.join(
      tmpRoot,
      `${SNAPSHOT_DIR_PREFIX}${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
    );
    fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(tmpDir, 0o700); } catch (_) {}

    const snapDb = path.join(tmpDir, 'cookies.sqlite');

    try {
      copySnapshotWithRetries(dbPath, snapDb, maxCopyBytes, maxRetries);

      const db = openReadonlySqlite(snapDb);
      const records = [];
      try {
        let quickCheckRow;
        try {
          quickCheckRow = db.get('PRAGMA quick_check(1)');
        } catch (err) {
          throw new BrowserLoginException(
            BrowserLoginFailure.INVALID_DATA,
            `Gecko cookie snapshot integrity check failed: ${err.message}`
          );
        }

        const quickCheckVal = quickCheckRow ? Object.values(quickCheckRow)[0] : null;
        if (String(quickCheckVal).toLowerCase() !== 'ok') {
          throw new BrowserLoginException(
            BrowserLoginFailure.INVALID_DATA,
            `Gecko cookie snapshot failed PRAGMA quick_check(1): ${quickCheckVal}`
          );
        }

        const columns = db.all('PRAGMA table_info(moz_cookies)');
        const hasOriginAttributes = Array.isArray(columns) && columns.some(c => c && c.name === 'originAttributes');
        const selectCols = hasOriginAttributes
          ? 'host, name, value, path, expiry, isSecure, isHttpOnly, originAttributes'
          : 'host, name, value, path, expiry, isSecure, isHttpOnly';
        const whereClause = buildTargetWhereClause(target);

        const rows = db.all(`SELECT ${selectCols} FROM moz_cookies WHERE ${whereClause}`);
        for (const row of rows) {
          if (!allowNonDefaultContainers && hasOriginAttributes && isNonDefaultContainer(row.originAttributes)) {
            continue;
          }
          records.push(new BrowserCookieRecord({
            name: row.name,
            value: row.value,
            domain: row.host,
            path: row.path,
            secure: row.isSecure === 1,
            httpOnly: row.isHttpOnly === 1,
            expiry: row.expiry,
            hostOnly: !String(row.host || '').startsWith('.')
          }));
        }
      } finally {
        try { db.close(); } catch (_) {}
      }

      if (target === BrowserLoginTarget.EXTERNAL_WEB) {
        const validated = validateExternalSessionCookies(records, options);
        return [new BrowserCookieRecord(validated)];
      }

      return records;
    } catch (err) {
      if (err instanceof BrowserLoginException) throw err;
      throw new BrowserLoginException(BrowserLoginFailure.PROFILE_ACCESS_DENIED, err.message);
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
  });
}

module.exports = {
  readGeckoCookies,
  cleanupAbandonedGeckoSnapshots,
  DEFAULT_MAX_COPY_BYTES,
  DEFAULT_MAX_RETRIES
};
