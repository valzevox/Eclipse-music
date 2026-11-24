'use strict';

const http = require('http');
const crypto = require('crypto');
const { BrowserLoginFailure, BrowserLoginException } = require('./browser-login-errors');
const { BrowserCookieRecord } = require('./browser-cookie-record');

class BrowserPairingServer {
  constructor({ onCookiesReceived, timeoutMs = 120000 }) {
    this.server = null;
    this.port = null;
    this.nonce = null;
    this.expiresAt = null;
    this.consumed = false;
    this.timeoutMs = timeoutMs;
    this.timer = null;
    this.onCookiesReceived = onCookiesReceived;
    this.active = false;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.nonce = crypto.randomBytes(32).toString('hex');
      this.expiresAt = Date.now() + this.timeoutMs;
      this.consumed = false;
      this.active = true;

      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      // Strict loopback binding on ephemeral port
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server.address();
        this.port = addr.port;

        this.timer = setTimeout(() => {
          this.close(BrowserLoginFailure.PAIRING_EXPIRED);
        }, this.timeoutMs);

        resolve({
          port: this.port,
          nonce: this.nonce,
          expiresAt: this.expiresAt
        });
      });

      this.server.on('error', (err) => {
        this.close();
        reject(err);
      });
    });
  }

  handleRequest(req, res) {
    const remote = req.socket.remoteAddress;
    // Strict loopback enforcement: only IPv4 127.0.0.1 or IPv6 ::1
    if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: 'Forbidden: loopback only' }));
    }

    // CORS: strictly validate extension origins, no wildcard
    const origin = req.headers.origin || '';
    const isExtensionOrigin = /^chrome-extension:\/\/[a-z0-9]+$/i.test(origin) ||
                              /^moz-extension:\/\/[a-z0-9-]+$/i.test(origin) ||
                              origin === 'null';

    // Allow Preflight
    if (req.method === 'OPTIONS') {
      if (isExtensionOrigin) {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-Eclipse-Nonce',
          'Access-Control-Max-Age': '300'
        });
      } else {
        res.writeHead(403);
      }
      return res.end();
    }

    if (req.method !== 'POST' || req.url !== '/api/extension/pair') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: 'Not found' }));
    }

    // Check expiry
    if (Date.now() > this.expiresAt) {
      res.writeHead(400, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': origin
      });
      return res.end(JSON.stringify({ success: false, error: BrowserLoginFailure.PAIRING_EXPIRED }));
    }

    // Check replay
    if (this.consumed) {
      res.writeHead(400, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': origin
      });
      return res.end(JSON.stringify({ success: false, error: BrowserLoginFailure.PAIRING_REPLAYED }));
    }

    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 512 * 1024) { // max 512KB for cookies
        req.socket.destroy();
      }
    });

    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const headerNonce = req.headers['x-eclipse-nonce'] || payload.nonce;

        if (!headerNonce || headerNonce !== this.nonce) {
          res.writeHead(401, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': origin
          });
          return res.end(JSON.stringify({ success: false, error: 'Invalid pairing nonce' }));
        }

        // Consume nonce immediately
        this.consumed = true;

        const rawCookies = payload.cookies;
        if (!Array.isArray(rawCookies) || rawCookies.length === 0) {
          res.writeHead(400, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': origin
          });
          return res.end(JSON.stringify({ success: false, error: BrowserLoginFailure.NO_YOUTUBE_COOKIES }));
        }

        const cookieRecords = [];
        for (const c of rawCookies) {
          if (!c || !c.name || typeof c.value !== 'string') continue;
          cookieRecords.push(new BrowserCookieRecord({
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path || '/',
            secure: c.secure !== false,
            httpOnly: !!c.httpOnly,
            expiry: c.expirationDate || c.expiry,
            hostOnly: !!c.hostOnly
          }));
        }

        // Verify with callback first before returning HTTP 200 (fail-closed)
        if (typeof this.onCookiesReceived === 'function') {
          try {
            const authResult = await this.onCookiesReceived(cookieRecords);
            res.writeHead(200, {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': origin
            });
            res.end(JSON.stringify({ success: true, account: authResult && authResult.account }));

            // Auto close server upon successful verification
            setTimeout(() => this.close(), 1000);
          } catch (verifyErr) {
            res.writeHead(400, {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': origin
            });
            res.end(JSON.stringify({
              success: false,
              error: verifyErr && verifyErr.message ? verifyErr.message : BrowserLoginFailure.SESSION_REJECTED,
              reason: verifyErr && verifyErr.reason ? verifyErr.reason : BrowserLoginFailure.SESSION_REJECTED
            }));
            setTimeout(() => this.close(BrowserLoginFailure.SESSION_REJECTED), 1000);
          }
        } else {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': origin
          });
          res.end(JSON.stringify({ success: true }));
          setTimeout(() => this.close(), 1000);
        }
      } catch (err) {
        res.writeHead(400, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': origin
        });
        res.end(JSON.stringify({ success: false, error: BrowserLoginFailure.COOKIE_FORMAT_INVALID }));
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
