'use strict';

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

class BrowserCookieRecord {
  constructor({
    name,
    value,
    domain,
    path = '/',
    secure = true,
    httpOnly = false,
    expiry = null,
    hostOnly = false
  }) {
    if (!name || typeof name !== 'string') throw new Error('Cookie name required');
    if (typeof value !== 'string') throw new Error('Cookie value required');

    this.name = name.trim();
    this.value = value;
    let dom = String(domain || '').trim().toLowerCase();
    this.hostOnly = !!hostOnly;
    if (!this.hostOnly && !dom.startsWith('.')) {
      dom = '.' + dom;
    }
    this.domain = dom;
    this.path = (path && path.startsWith('/')) ? path : '/';
    this.secure = secure !== false;
    this.httpOnly = !!httpOnly;
    this.expiry = Number.isFinite(Number(expiry)) && Number(expiry) > 0 ? Math.floor(Number(expiry)) : null;
  }

  isExpired(nowSeconds = Math.floor(Date.now() / 1000)) {
    if (!this.expiry) return false;
    return this.expiry < nowSeconds;
  }

  matchesHost(requestHost) {
    if (!requestHost || typeof requestHost !== 'string') return false;
    const req = requestHost.toLowerCase().trim();
    const cookieDom = this.domain.toLowerCase().replace(/^\./, '');

    if (this.hostOnly) {
      return req === cookieDom;
    }

    if (req === cookieDom) return true;
    return req.endsWith('.' + cookieDom);
  }

  matchesPath(requestPath = '/') {
    const req = (requestPath || '/').trim();
    const cPath = this.path;
    if (cPath === '/' || req === cPath) return true;
    if (req.startsWith(cPath)) {
      if (cPath.endsWith('/') || req[cPath.length] === '/') return true;
    }
    return false;
  }

  /**
   * Secret redaction: never leak credential values in string representation.
   */
  toString() {
    return `BrowserCookieRecord(${this.name} for ${this.domain}${this.path}, secure=${this.secure}, httpOnly=${this.httpOnly}, value=[REDACTED])`;
  }

  toNetscapeLine() {
    const prefix = this.httpOnly ? '#HttpOnly_' : '';
    const includeSub = this.domain.startsWith('.') ? 'TRUE' : 'FALSE';
    const isSec = this.secure ? 'TRUE' : 'FALSE';
    const exp = this.expiry || (Math.floor(Date.now() / 1000) + 365 * 86400);
    return `${prefix}${this.domain}\t${includeSub}\t${this.path}\t${isSec}\t${exp}\t${this.name}\t${this.value}`;
  }
}

/**
 * Filter, validate and deduplicate cookie records for a specific target host.
 */
function filterCookiesForHost(records, targetHost = 'music.youtube.com', requestPath = '/') {
  if (!Array.isArray(records)) return [];
  const now = Math.floor(Date.now() / 1000);
  const eligible = [];

  for (const r of records) {
    if (!(r instanceof BrowserCookieRecord)) continue;
    if (r.isExpired(now)) continue;
    if (!isValidCookieDomain(r.domain)) continue;
    if (!r.matchesHost(targetHost)) continue;
    if (!r.matchesPath(requestPath)) continue;
    eligible.push(r);
  }

  // Deduplicate when names collide: more specific domain & longer path wins
  const byName = new Map();
  for (const c of eligible) {
    const existing = byName.get(c.name);
    if (!existing) {
      byName.set(c.name, c);
    } else {
      const existingClean = existing.domain.replace(/^\./, '');
      const currentClean = c.domain.replace(/^\./, '');
      // If current is exact match to targetHost or has more domain labels
      const existingSpecificity = existingClean.split('.').length;
      const currentSpecificity = currentClean.split('.').length;

      if (currentClean === targetHost && existingClean !== targetHost) {
        byName.set(c.name, c);
      } else if (currentSpecificity > existingSpecificity) {
        byName.set(c.name, c);
      } else if (currentSpecificity === existingSpecificity && c.path.length > existing.path.length) {
        byName.set(c.name, c);
      }
    }
  }

  return Array.from(byName.values());
}

function buildCookieHeader(records, targetHost = 'music.youtube.com', requestPath = '/') {
  const filtered = filterCookiesForHost(records, targetHost, requestPath);
  return filtered.map(c => `${c.name}=${c.value}`).join('; ');
}

function buildNetscapeJar(records, targetHost = 'music.youtube.com') {
  const filtered = filterCookiesForHost(records, targetHost, '/');
  const lines = [
    '# Netscape HTTP Cookie File',
    '# Generated by Eclipse Browser Login (WebRemix Architecture)',
    ''
  ];
  for (const c of filtered) {
    lines.push(c.toNetscapeLine());
  }
  const eol = process.platform === 'win32' ? '\r\n' : '\n';
  return lines.join(eol) + eol;
}

const SAPISID_ALLOWED_DOMAIN_REGEX = /^(?:music\.youtube\.com|\.?youtube\.com)$/i;

/**
 * Extracts SAPISID or __Secure-3PAPISID credential without polluting
 * the outgoing Cookie header for music.youtube.com.
 * Strictly validates:
 *  - exact cookie name ('SAPISID' or '__Secure-3PAPISID')
 *  - non-empty string value
 *  - non-expired record
 *  - secure flag (secure === true)
 *  - valid request-host ('music.youtube.com') and request-path ('/getAccountSwitcherEndpoint')
 *  - narrow SAPISID allowed domain policy (.youtube.com or music.youtube.com only)
 * Rejects Google-scoped credentials (.google.com, accounts.google.com).
 * Returns { name, value, domain, path, secure, expiry, scope } or null.
 */
function extractSapisidCredential(records, targetHost = 'music.youtube.com', targetPath = '/getAccountSwitcherEndpoint') {
  if (!Array.isArray(records)) return null;
  const now = Math.floor(Date.now() / 1000);

  const candidates = [];
  for (const r of records) {
    if (!(r instanceof BrowserCookieRecord)) continue;
    if (r.isExpired(now)) continue;
    if (!r.value || typeof r.value !== 'string' || !r.value.trim()) continue;
    if (r.secure !== true) continue;
    if (r.name !== 'SAPISID' && r.name !== '__Secure-3PAPISID') continue;

    const cleanDom = r.domain.toLowerCase().replace(/^\./, '');
    if (!SAPISID_ALLOWED_DOMAIN_REGEX.test(cleanDom)) continue;

    // Strict host and path matching for YouTube-scoped credential only
    if (r.matchesHost(targetHost) && r.matchesPath(targetPath)) {
      candidates.push({
        priority: r.name === 'SAPISID' ? 1 : 2,
        scope: 'youtube',
        record: r
      });
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.priority - b.priority);
  const best = candidates[0];
  return {
    name: best.record.name,
    value: best.record.value,
    domain: best.record.domain,
    path: best.record.path,
    secure: best.record.secure,
    expiry: best.record.expiry,
    scope: best.scope
  };
}

module.exports = {
  isValidCookieDomain,
  BrowserCookieRecord,
  filterCookiesForHost,
  buildCookieHeader,
  buildNetscapeJar,
  extractSapisidCredential
};
