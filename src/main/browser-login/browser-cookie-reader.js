'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { BrowserCookieRecord } = require('./browser-cookie-record');
const { BrowserLoginFailure, BrowserLoginException } = require('./browser-login-errors');

/**
 * Read cookies from a Gecko (Firefox) cookies.sqlite database using an immutable snapshot.
 * Copies sqlite db and wal/shm files to a temporary folder to avoid DB locks and prevent mutating source.
 */
async function readGeckoCookies(profilePath) {
  const dbPath = path.join(profilePath, 'cookies.sqlite');
  if (!fs.existsSync(dbPath)) {
    throw new BrowserLoginException(BrowserLoginFailure.NO_YOUTUBE_COOKIES, 'cookies.sqlite not found');
  }

  // Create isolated temp directory for snapshot
  const tmpDir = path.join(os.tmpdir(), `gecko-snap-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
  const snapDb = path.join(tmpDir, 'cookies.sqlite');

  try {
    fs.copyFileSync(dbPath, snapDb);
    const wal = dbPath + '-wal';
    const shm = dbPath + '-shm';
    if (fs.existsSync(wal)) fs.copyFileSync(wal, snapDb + '-wal');
    if (fs.existsSync(shm)) fs.copyFileSync(shm, snapDb + '-shm');

    // Parse records using better-sqlite3 or sqlite3 if available, or fallback parser
    let sqlite3 = null;
    try {
      sqlite3 = require('better-sqlite3');
    } catch (_) {
      try { sqlite3 = require('sqlite3'); } catch (_) {}
    }

    if (!sqlite3) {
      throw new BrowserLoginException(BrowserLoginFailure.UNSUPPORTED_ENCRYPTION, 'SQLite driver unavailable in runtime');
    }

    const records = [];
    if (typeof sqlite3 === 'function') { // better-sqlite3
      const db = sqlite3(snapDb, { readonly: true, fileMustExist: true });
      try {
        const rows = db.prepare(`
          SELECT host, name, value, path, expiry, isSecure, isHttpOnly
          FROM moz_cookies
          WHERE host LIKE '%youtube.com' OR host LIKE '%google.com' OR host LIKE '%googlevideo.com'
        `).all();

        for (const row of rows) {
          records.push(new BrowserCookieRecord({
            name: row.name,
            value: row.value,
            domain: row.host,
            path: row.path,
            secure: row.isSecure === 1,
            httpOnly: row.isHttpOnly === 1,
            expiry: row.expiry,
            hostOnly: !row.host.startsWith('.')
          }));
        }
      } finally {
        try { db.close(); } catch (_) {}
      }
    }

    return records;
  } catch (err) {
    if (err instanceof BrowserLoginException) throw err;
    throw new BrowserLoginException(BrowserLoginFailure.PROFILE_ACCESS_DENIED, err.message);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

module.exports = {
  readGeckoCookies
};
