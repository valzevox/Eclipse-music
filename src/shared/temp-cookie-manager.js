'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { cookieJarHasYtLogin } = require('./platform');

/**
 * Strict regex boundary check for permitted domains.
 * Matches:
 *  - youtube.com and subdomains (.youtube.com, music.youtube.com, www.youtube.com)
 *  - google.com and subdomains (.google.com, accounts.google.com)
 *  - googlevideo.com and subdomains (.googlevideo.com, rr1---sn-xxx.googlevideo.com)
 *  - youtubei.googleapis.com
 * Rejects attacker domains: youtube.com.attacker.test, google.com.fake.org, evil.com
 */
const ALLOWED_DOMAIN_REGEX = /^(?:[a-zA-Z0-9-]+\.)*(?:youtube\.com|google\.com|googlevideo\.com|youtubei\.googleapis\.com)$/i;

function isValidCookieDomain(domain) {
  if (!domain || typeof domain !== 'string') return false;
  const clean = domain.trim().toLowerCase().replace(/^\./, '');
  return ALLOWED_DOMAIN_REGEX.test(clean);
}

/**
 * Check if a cookie payload (either Netscape jar text or HTTP header string)
 * contains authentic YouTube login credentials (SAPISID/SID or LOGIN_INFO).
 */
function isCookiePayloadAuthenticated(payload) {
  if (!payload) return false;
  if (typeof payload === 'object' && Array.isArray(payload)) {
    let hasLoginInfo = false;
    let hasSapisid = false;
    let hasSid = false;
    for (const c of payload) {
      if (!c || !c.name || !c.value) continue;
      const dom = String(c.domain || '').trim().toLowerCase().replace(/^\./, '');
      const isYt = dom === 'youtube.com' || dom.endsWith('.youtube.com');
      if (c.name === 'LOGIN_INFO') {
        if (!dom || isYt) hasLoginInfo = true;
      } else if (c.name === 'SAPISID' || c.name === '__Secure-3PAPISID') {
        if (!dom || isYt || dom === 'google.com' || dom.endsWith('.google.com')) hasSapisid = true;
      } else if (c.name === 'SID' || c.name === '__Secure-3PSID') {
        if (!dom || isYt) hasSid = true;
      }
    }
    return hasLoginInfo || (hasSapisid && hasSid);
  }

  const str = String(payload).trim();
  if (!str) return false;

  // 1. If Netscape format
  if (str.startsWith('# Netscape') || str.includes('\t')) {
    return cookieJarHasYtLogin(str);
  }

  // 2. HTTP Cookie header format: name=val; name2=val2
  let hasLoginInfo = false;
  let hasSapisid = false;
  let hasSid = false;
  const pairs = str.split(';');
  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    const name = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    if (!name || !val) continue;
    if (name === 'LOGIN_INFO') hasLoginInfo = true;
    else if (name === 'SAPISID' || name === '__Secure-3PAPISID') hasSapisid = true;
    else if (name === 'SID') hasSid = true;
  }

  return hasLoginInfo || (hasSapisid && hasSid);
}

/**
 * Parse an HTTP Cookie header string into structured cookie objects.
 * Infers domain strictly: YouTube-specific cookies go to .youtube.com,
 * Google/SAPISID shared cookies go to .google.com and .youtube.com.
 */
function parseCookieHeader(headerStr, defaultDomain = '.youtube.com') {
  if (!headerStr || typeof headerStr !== 'string') return [];
  const str = headerStr.trim();
  if (!str) return [];
  const results = [];
  const now = Math.floor(Date.now() / 1000) + 86400 * 365;
  const pairs = str.split(';');

  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (!name || !value) continue;

    // Preserving appropriate domain scope:
    // If it's a Google authentication credential, keep it under google.com
    // If it's YouTube login/session, keep it under youtube.com
    let targetDomain = defaultDomain;
    if (name === 'SAPISID' || name === '__Secure-3PAPISID' || name === 'APISID' || name === 'SSID') {
      // Shared Google auth cookies: provide entries for both .google.com and .youtube.com
      results.push({
        domain: '.google.com',
        path: '/',
        secure: true,
        httpOnly: false,
        expirationDate: now,
        name,
        value
      });
      targetDomain = '.youtube.com';
    } else if (name.startsWith('__Secure-') || name === 'LOGIN_INFO' || name === 'VISITOR_INFO1_LIVE' || name === 'YSC') {
      targetDomain = '.youtube.com';
    }

    results.push({
      domain: targetDomain,
      path: '/',
      secure: true,
      httpOnly: name === 'LOGIN_INFO' || name === 'HSID' || name === 'SID',
      expirationDate: now,
      name,
      value
    });
  }

  return results;
}

/**
 * Format cookie entry as Mozilla/Netscape 7-column format.
 * Format: domain \t includeSubdomains \t path \t secure \t expiry \t name \t value
 */
function formatNetscapeCookieLine(cookie) {
  if (!cookie || !cookie.name) return null;
  let domain = String(cookie.domain || '').trim();
  if (!domain) domain = '.youtube.com';

  // Strict domain boundary check
  if (!isValidCookieDomain(domain)) return null;

  const isHttpOnly = !!(cookie.httpOnly || cookie.httponly);
  const includeSub = domain.startsWith('.') ? 'TRUE' : 'FALSE';
  const cPath = cookie.path || '/';
  const isSecure = (cookie.secure !== undefined) ? (cookie.secure ? 'TRUE' : 'FALSE') : 'TRUE';
  const expiry = cookie.expirationDate ? Math.floor(cookie.expirationDate) : (Math.floor(Date.now() / 1000) + 86400 * 365);
  const name = String(cookie.name).trim();
  const val = String(cookie.value !== undefined ? cookie.value : '').trim();

  const prefix = isHttpOnly ? '#HttpOnly_' : '';
  return `${prefix}${domain}\t${includeSub}\t${cPath}\t${isSecure}\t${expiry}\t${name}\t${val}`;
}

/**
 * Convert a list of cookies or cookie header string into Netscape HTTP Cookie File text.
 */
function serializeToNetscapeJar(cookiesOrHeader) {
  const lines = [
    '# Netscape HTTP Cookie File',
    '# Generated on-demand by Eclipse (temporary jar)',
    ''
  ];

  if (Array.isArray(cookiesOrHeader)) {
    for (const c of cookiesOrHeader) {
      const line = formatNetscapeCookieLine(c);
      if (line) lines.push(line);
    }
  } else if (typeof cookiesOrHeader === 'string' && cookiesOrHeader.trim()) {
    const raw = cookiesOrHeader.trim();
    // Check if it's already a Netscape formatted text
    if (raw.startsWith('# Netscape') || raw.includes('\t')) {
      const rows = raw.split(/\r?\n/);
      for (const row of rows) {
        const trimmed = row.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith('#') && !trimmed.startsWith('#HttpOnly_')) continue;
        const parts = trimmed.split('\t');
        if (parts.length >= 7) {
          const dom = parts[0].replace(/^#HttpOnly_/, '');
          if (isValidCookieDomain(dom)) {
            lines.push(trimmed);
          }
        }
      }
    } else {
      // It's a "name=val; name2=val2" cookie header string
      const parsed = parseCookieHeader(raw);
      for (const c of parsed) {
        const line = formatNetscapeCookieLine(c);
        if (line) lines.push(line);
      }
    }
  }

  // Windows yt-dlp compatibility: CRLF newline separator
  const eol = process.platform === 'win32' ? '\r\n' : '\n';
  return lines.join(eol) + eol;
}

class TempCookieManager {
  constructor(baseDir) {
    this.baseDir = baseDir || path.join(os.tmpdir(), 'eclipse-cookies');
    this.activeJars = new Map(); // jarPath -> { dir, jarPath, childProc, cleaned }
  }

  getTempDir() {
    const dir = path.join(this.baseDir, 'temp-cookies');
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
    } catch (_) {}
    return dir;
  }

  /**
   * Safe Sweeper: Only removes orphan temporary cookie jars.
   * If a jar directory belongs to a running process PID, it will NOT be deleted,
   * allowing safe multi-instance concurrency on shared DATA_DIR.
   */
  sweepStaleCookieJars() {
    try {
      const tempDir = this.getTempDir();
      if (!fs.existsSync(tempDir)) return;
      const entries = fs.readdirSync(tempDir);
      for (const entry of entries) {
        const fullPath = path.join(tempDir, entry);
        try {
          const stat = fs.statSync(fullPath);
          if (!stat.isDirectory()) {
            fs.unlinkSync(fullPath);
            continue;
          }

          // Check if tracked by current instance
          const isTracked = Array.from(this.activeJars.values()).some(j => j.dir === fullPath || j.jarPath === fullPath);
          if (isTracked) continue;

          // Check owner PID from directory name pattern: ytjar-<ownerPid>-<timestamp>-<rand>
          const pidMatch = entry.match(/^ytjar-(\d+)-/);
          if (pidMatch && pidMatch[1]) {
            const ownerPid = parseInt(pidMatch[1], 10);
            let ownerAlive = false;
            try {
              process.kill(ownerPid, 0);
              ownerAlive = true;
            } catch (err) {
              ownerAlive = err.code === 'EPERM'; // Alive if EPERM, dead if ESRCH
            }

            if (ownerAlive) {
              // Owner process is still actively running; leave it alone
              continue;
            }
          }

          // Process is dead or orphan jar older than 60s
          if (Date.now() - stat.mtimeMs > 60000 || (pidMatch && !isTracked)) {
            fs.rmSync(fullPath, { recursive: true, force: true });
          }
        } catch (_) {}
      }
    } catch (_) {}
  }

  /**
   * Creates a dedicated temporary Netscape cookie jar file for a yt-dlp execution.
   */
  createTemporaryCookieJar(cookiePayload) {
    if (!isCookiePayloadAuthenticated(cookiePayload)) {
      return null;
    }

    const netscapeText = serializeToNetscapeJar(cookiePayload);
    if (!cookieJarHasYtLogin(netscapeText)) {
      return null;
    }

    const tempRoot = this.getTempDir();
    const uniqueId = `ytjar-${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
    const jarDir = path.join(tempRoot, uniqueId);
    fs.mkdirSync(jarDir, { recursive: true, mode: 0o700 });

    const jarPath = path.join(jarDir, 'cookies.txt');
    fs.writeFileSync(jarPath, netscapeText, { encoding: 'utf8', mode: 0o600 });

    const jarInfo = {
      dir: jarDir,
      jarPath,
      childProc: null,
      cleaned: false
    };

    this.activeJars.set(jarPath, jarInfo);
    return jarInfo;
  }

  /**
   * Binds a child process to the temporary cookie jar so it unlinks immediately on 'close' or 'error'.
   */
  attachToProcess(jarInfo, proc) {
    if (!jarInfo || jarInfo.cleaned) return;
    jarInfo.childProc = proc;

    const cleanup = () => {
      this.cleanupJar(jarInfo);
    };

    if (proc && typeof proc.on === 'function') {
      proc.on('close', cleanup);
      proc.on('error', cleanup);
    }
  }

  /**
   * Idempotent cleanup of temporary cookie jar and its isolated parent directory.
   */
  cleanupJar(jarInfo) {
    if (!jarInfo || jarInfo.cleaned) return;
    jarInfo.cleaned = true;
    this.activeJars.delete(jarInfo.jarPath);

    try {
      if (fs.existsSync(jarInfo.jarPath)) {
        fs.unlinkSync(jarInfo.jarPath);
      }
    } catch (_) {}

    try {
      if (fs.existsSync(jarInfo.dir)) {
        fs.rmSync(jarInfo.dir, { recursive: true, force: true });
      }
    } catch (_) {}
  }

  /**
   * Clean all active jars on process exit.
   */
  cleanupAll() {
    for (const jarInfo of this.activeJars.values()) {
      this.cleanupJar(jarInfo);
    }
  }
}

let defaultManager = null;
function getTempCookieManager(baseDir) {
  if (!defaultManager) {
    defaultManager = new TempCookieManager(baseDir);
  }
  return defaultManager;
}

module.exports = {
  isValidCookieDomain,
  isCookiePayloadAuthenticated,
  parseCookieHeader,
  formatNetscapeCookieLine,
  serializeToNetscapeJar,
  TempCookieManager,
  getTempCookieManager
};
