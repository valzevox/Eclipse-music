'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { cookieJarHasYtLogin } = require('./platform');

/**
 * Format cookie entry as Mozilla/Netscape 7-column format.
 * Format: domain \t includeSubdomains \t path \t secure \t expiry \t name \t value
 */
function formatNetscapeCookieLine(cookie) {
  if (!cookie || !cookie.name) return null;
  let domain = String(cookie.domain || '').trim();
  if (!domain) domain = '.youtube.com';

  // Domain security check: only Google and YouTube domains
  const lowDom = domain.toLowerCase();
  const isGoogleOrYt = lowDom.includes('youtube.com') ||
                       lowDom.includes('google.com') ||
                       lowDom.includes('googlevideo.com') ||
                       lowDom.includes('youtubei.googleapis.com');
  if (!isGoogleOrYt) return null;

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
          const lowDom = dom.toLowerCase();
          if (lowDom.includes('youtube.com') || lowDom.includes('google.com') || lowDom.includes('googlevideo.com')) {
            lines.push(trimmed);
          }
        }
      }
    } else {
      // It's a "name=val; name2=val2" cookie header string
      const pairs = raw.split(';');
      const now = Math.floor(Date.now() / 1000) + 86400 * 365;
      for (const pair of pairs) {
        const idx = pair.indexOf('=');
        if (idx > 0) {
          const name = pair.slice(0, idx).trim();
          const val = pair.slice(idx + 1).trim();
          if (name) {
            lines.push(`.youtube.com\tTRUE\t/\tTRUE\t${now}\t${name}\t${val}`);
          }
        }
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
    this.activeJars = new Map(); // jarPath -> { dir, childProc }
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
   * Sweeps stale temporary cookie files from previous app instances.
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
          // If directory is older than 5 minutes or not tracked in current activeJars, clean it
          const isTracked = Array.from(this.activeJars.values()).some(j => j.dir === fullPath || j.jarPath === fullPath);
          if (!isTracked && (Date.now() - stat.mtimeMs > 60000 || !stat.isDirectory())) {
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
  formatNetscapeCookieLine,
  serializeToNetscapeJar,
  TempCookieManager,
  getTempCookieManager
};
