'use strict';

const http = require('http');
const crypto = require('crypto');
const { BrowserLoginFailure } = require('./browser-login-errors');
const { BrowserCookieRecord } = require('./browser-cookie-record');
const { BrowserLoginTarget, resolveTargetHost } = require('./browser-login-targets');

const MAX_BODY_BYTES = 512 * 1024;
const CHROME_EXT_ORIGIN_RE = /^chrome-extension:\/\/([a-z0-9]+)$/i;
const MOZ_EXT_ORIGIN_RE = /^moz-extension:\/\/([a-z0-9-]+)$/i;

function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

class BrowserPairingServer {
  constructor({
    target = BrowserLoginTarget.YOUTUBE,
    onCookiesReceived,
    timeoutMs = 120000,
    allowedExtensionIds = [],
    isPackaged = false,
    allowNullOriginInDev = true,
    maxRedeemAttempts = 5,
    rateLimitWindowMs = 60000,
    rateLimitMax = 20
  } = {}) {
    resolveTargetHost(target);
    Object.defineProperty(this, 'target', {
      value: target,
      writable: false,
      enumerable: true,
      configurable: false
    });

    this.server = null;
    this.port = null;
    this.nonce = null;
    this.expiresAt = null;
    this.consumed = false;
    this.timeoutMs = timeoutMs;
    this.timer = null;
    this.onCookiesReceived = onCookiesReceived;
    this.active = false;

    this.allowedExtensionIds = Array.isArray(allowedExtensionIds)
      ? allowedExtensionIds.map(id => String(id).trim().toLowerCase()).filter(Boolean)
      : [];
    this.isPackaged = !!isPackaged;
    this.allowNullOriginInDev = allowNullOriginInDev !== false;
    this.maxRedeemAttempts = Number.isFinite(maxRedeemAttempts) && maxRedeemAttempts > 0 ? maxRedeemAttempts : 5;
    this.rateLimitWindowMs = Number.isFinite(rateLimitWindowMs) && rateLimitWindowMs > 0 ? rateLimitWindowMs : 60000;
    this.rateLimitMax = Number.isFinite(rateLimitMax) && rateLimitMax > 0 ? rateLimitMax : 20;

    this.redeemAttempts = 0;
    this.locked = false;
    this.rateLimitMap = new Map();
  }

  start() {
    return new Promise((resolve, reject) => {
      this.nonce = crypto.randomBytes(32).toString('hex');
      this.expiresAt = Date.now() + this.timeoutMs;
      this.consumed = false;
      this.redeemAttempts = 0;
      this.locked = false;
      this.rateLimitMap.clear();
      this.active = true;

      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server.address();
        this.port = addr.port;

        this.timer = setTimeout(() => {
          this.close(BrowserLoginFailure.PAIRING_EXPIRED);
        }, this.timeoutMs);

        resolve({
          port: this.port,
          nonce: this.nonce,
          expiresAt: this.expiresAt,
          target: this.target
        });
      });

      this.server.on('error', (err) => {
        this.close();
        reject(err);
      });
    });
  }

  isValidHostHeader(hostHeader) {
    if (!hostHeader || typeof hostHeader !== 'string' || !this.port) return false;
    const normalized = hostHeader.trim().toLowerCase();
    return normalized === `127.0.0.1:${this.port}` || normalized === `localhost:${this.port}`;
  }

  isValidOrigin(origin) {
    if (!origin || typeof origin !== 'string') return false;
    if (origin === 'null') {
      return !this.isPackaged && this.allowNullOriginInDev;
    }

    const chromeMatch = CHROME_EXT_ORIGIN_RE.exec(origin);
    const mozMatch = MOZ_EXT_ORIGIN_RE.exec(origin);
    const match = chromeMatch || mozMatch;
    if (!match) return false;

    const extId = match[1].toLowerCase();
    if (this.isPackaged) {
      return this.allowedExtensionIds.includes(extId);
    }
    if (this.allowedExtensionIds.length > 0) {
      return this.allowedExtensionIds.includes(extId);
    }
    return true;
  }

  checkRateLimit(remoteIp) {
    const now = Date.now();
    const entry = this.rateLimitMap.get(remoteIp);
    if (!entry || now >= entry.resetAt) {
      this.rateLimitMap.set(remoteIp, { count: 1, resetAt: now + this.rateLimitWindowMs });
      return true;
    }
    if (entry.count >= this.rateLimitMax) {
      return false;
    }
    entry.count += 1;
    return true;
  }

  sendJson(res, statusCode, payload, origin = null) {
    const headers = { 'Content-Type': 'application/json' };
    if (origin) {
      headers['Access-Control-Allow-Origin'] = origin;
      headers['Vary'] = 'Origin';
    }
    res.writeHead(statusCode, headers);
    res.end(JSON.stringify(payload));
  }

  handleRequest(req, res) {
    const remote = req.socket.remoteAddress;
    if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
      return this.sendJson(res, 403, { success: false, error: 'Forbidden: loopback only' });
    }

    if (!this.isValidHostHeader(req.headers.host)) {
      return this.sendJson(res, 403, { success: false, error: 'Forbidden: invalid host' });
    }

    const origin = req.headers.origin;
    const originValid = this.isValidOrigin(origin);

    if (req.method === 'OPTIONS') {
      if (originValid) {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-Eclipse-Nonce',
          'Access-Control-Max-Age': '300',
          'Vary': 'Origin'
        });
      } else {
        res.writeHead(403);
      }
      return res.end();
    }

    if (!originValid) {
      return this.sendJson(res, 403, { success: false, error: BrowserLoginFailure.ORIGIN_REJECTED });
    }

    if (!this.checkRateLimit(remote)) {
      return this.sendJson(res, 429, { success: false, error: 'Too many requests' }, origin);
    }

    if (req.method !== 'POST' || req.url !== '/api/extension/pair') {
      return this.sendJson(res, 404, { success: false, error: 'Not found' }, origin);
    }

    if (this.locked) {
      return this.sendJson(res, 429, { success: false, error: 'Pairing locked due to too many failed attempts' }, origin);
    }

    if (Date.now() > this.expiresAt) {
      return this.sendJson(res, 400, { success: false, error: BrowserLoginFailure.PAIRING_EXPIRED }, origin);
    }

    if (this.consumed) {
      return this.sendJson(res, 400, { success: false, error: BrowserLoginFailure.PAIRING_REPLAYED }, origin);
    }

    const chunks = [];
    let totalBytes = 0;
    let aborted = false;

    req.on('data', chunk => {
      if (aborted) return;
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        aborted = true;
        req.socket.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', async () => {
      if (aborted) return;
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        const payload = JSON.parse(body || '{}');
        const headerNonce = req.headers['x-eclipse-nonce'] || payload.nonce;

        if (!constantTimeEqual(headerNonce, this.nonce)) {
          this.redeemAttempts += 1;
          if (this.redeemAttempts >= this.maxRedeemAttempts) {
            this.locked = true;
            this.sendJson(res, 429, { success: false, error: 'Pairing locked due to too many failed attempts' }, origin);
            setTimeout(() => this.close(BrowserLoginFailure.PAIRING_CANCELLED), 50);
            return;
          }
          return this.sendJson(res, 401, { success: false, error: 'Invalid pairing nonce' }, origin);
        }

        if (payload.target !== undefined && payload.target !== this.target) {
          return this.sendJson(res, 400, { success: false, error: BrowserLoginFailure.INVALID_DATA }, origin);
        }
        if (this.target !== BrowserLoginTarget.YOUTUBE && payload.target !== this.target) {
          return this.sendJson(res, 400, { success: false, error: BrowserLoginFailure.INVALID_DATA }, origin);
        }

        this.consumed = true;

        const rawCookies = payload.cookies;
        if (!Array.isArray(rawCookies) || rawCookies.length === 0) {
          return this.sendJson(res, 400, { success: false, error: BrowserLoginFailure.NO_YOUTUBE_COOKIES }, origin);
        }

        const cookieRecords = [];
        for (const c of rawCookies) {
          if (!c || !c.name || typeof c.value !== 'string') continue;
          cookieRecords.push(new BrowserCookieRecord({
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path || '/',
            secure: typeof c.secure === 'boolean' ? c.secure : (this.target === BrowserLoginTarget.YOUTUBE),
            httpOnly: !!c.httpOnly,
            expiry: c.expirationDate !== undefined ? c.expirationDate : c.expiry,
            hostOnly: !!c.hostOnly
          }));
        }

        if (typeof this.onCookiesReceived === 'function') {
          try {
            const authResult = await this.onCookiesReceived(cookieRecords);
            this.sendJson(res, 200, { success: true, account: authResult && authResult.account }, origin);
            setTimeout(() => this.close(), 1000);
          } catch (verifyErr) {
            this.sendJson(res, 400, {
              success: false,
              error: verifyErr && verifyErr.message ? verifyErr.message : BrowserLoginFailure.SESSION_REJECTED,
              reason: verifyErr && verifyErr.reason ? verifyErr.reason : BrowserLoginFailure.SESSION_REJECTED,
              details: verifyErr && verifyErr.details ? verifyErr.details : null
            }, origin);
            setTimeout(() => this.close(BrowserLoginFailure.SESSION_REJECTED), 1000);
          }
        } else {
          this.sendJson(res, 200, { success: true }, origin);
          setTimeout(() => this.close(), 1000);
        }
      } catch (_) {
        this.sendJson(res, 400, { success: false, error: BrowserLoginFailure.COOKIE_FORMAT_INVALID }, origin);
      }
    });
  }

  close(reason = null) {
    if (!this.active) return;
    this.active = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.server) {
      try { this.server.close(); } catch (_) {}
      this.server = null;
    }
  }
}

module.exports = {
  BrowserPairingServer
};
