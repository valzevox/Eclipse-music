'use strict';

const http = require('http');
const crypto = require('crypto');

const DEFAULT_AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';
const DEFAULT_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const DEFAULT_SCOPES = ['user-read-private', 'user-read-email', 'playlist-read-private', 'user-library-read'];

function toBase64Url(buffer) {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function generateCodeVerifier(byteLength = 64) {
  return toBase64Url(crypto.randomBytes(byteLength));
}

function generateCodeChallenge(codeVerifier) {
  if (typeof codeVerifier !== 'string' || codeVerifier.length < 43) {
    throw new Error('Invalid PKCE code verifier');
  }
  const digest = crypto.createHash('sha256').update(codeVerifier, 'ascii').digest();
  return toBase64Url(digest);
}

function generateStateNonce(byteLength = 32) {
  return toBase64Url(crypto.randomBytes(byteLength));
}

function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function assertHttpsUrl(rawUrl, label) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (_) {
    throw new Error(`Invalid ${label} URL`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`${label} URL must use HTTPS`);
  }
  return parsed;
}

class ExternalPkceAuth {
  constructor(options = {}) {
    this.clientId = typeof options.clientId === 'string' ? options.clientId.trim() : '';
    this.authorizeUrl = options.authorizeUrl || DEFAULT_AUTHORIZE_URL;
    this.tokenUrl = options.tokenUrl || DEFAULT_TOKEN_URL;
    this.scopes = Array.isArray(options.scopes) && options.scopes.length > 0
      ? options.scopes
      : DEFAULT_SCOPES;
    this.timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : 180000;
    this.fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : fetch;
    this.openExternal = typeof options.openExternal === 'function' ? options.openExternal : null;
    this.callbackPath = options.callbackPath || '/callback';

    this._server = null;
    this._timer = null;
    this._activeReject = null;
    this._cancelled = false;
  }

  isActive() {
    return Boolean(this._server);
  }

  cancel(reason = 'PKCE_CANCELLED') {
    this._cancelled = true;
    this._cleanup();
    if (this._activeReject) {
      const reject = this._activeReject;
      this._activeReject = null;
      const err = new Error('External PKCE authentication cancelled');
      err.code = reason;
      reject(err);
    }
  }

  _cleanup() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (this._server) {
      try {
        this._server.close();
      } catch (_) {}
      this._server = null;
    }
  }

  async authenticate(options = {}) {
    const clientId = (typeof options.clientId === 'string' ? options.clientId.trim() : '') || this.clientId;
    if (!clientId) {
      const err = new Error('External OAuth client ID is not configured');
      err.code = 'PKCE_CLIENT_ID_MISSING';
      throw err;
    }

    assertHttpsUrl(this.authorizeUrl, 'authorize');
    assertHttpsUrl(this.tokenUrl, 'token');

    if (this._server) {
      this.cancel('PKCE_SUPERSEDED');
    }

    this._cancelled = false;
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);
    const expectedState = generateStateNonce();
    const openExternal = typeof options.openExternal === 'function' ? options.openExternal : this.openExternal;

    const { code, redirectUri } = await this._waitForCallback({
      clientId,
      codeChallenge,
      expectedState,
      openExternal,
      onAuthUrl: options.onAuthUrl
    });

    if (this._cancelled) {
      const err = new Error('External PKCE authentication cancelled');
      err.code = 'PKCE_CANCELLED';
      throw err;
    }

    return await this.exchangeCode({
      clientId,
      code,
      redirectUri,
      codeVerifier
    });
  }

  _waitForCallback({ clientId, codeChallenge, expectedState, openExternal, onAuthUrl }) {
    return new Promise((resolve, reject) => {
      this._activeReject = reject;
      let settled = false;

      const finishError = (code, message) => {
        if (settled) return;
        settled = true;
        this._activeReject = null;
        this._cleanup();
        const err = new Error(message);
        err.code = code;
        reject(err);
      };

      const finishSuccess = (result) => {
        if (settled) return;
        settled = true;
        this._activeReject = null;
        this._cleanup();
        resolve(result);
      };

      const server = http.createServer((req, res) => {
        try {
          const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
          if (reqUrl.pathname !== this.callbackPath) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Not found');
            return;
          }

          const oauthError = reqUrl.searchParams.get('error');
          const returnedState = reqUrl.searchParams.get('state');
          const code = reqUrl.searchParams.get('code');

          if (!constantTimeEqual(returnedState || '', expectedState)) {
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<html><body><h3>Authentication failed: invalid state.</h3></body></html>');
            finishError('PKCE_STATE_MISMATCH', 'OAuth state mismatch');
            return;
          }

          if (oauthError) {
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<html><body><h3>Authentication was denied or cancelled.</h3></body></html>');
            finishError('PKCE_ACCESS_DENIED', `OAuth authorization error: ${oauthError}`);
            return;
          }

          if (!code || typeof code !== 'string') {
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<html><body><h3>Authentication failed: missing authorization code.</h3></body></html>');
            finishError('PKCE_CODE_MISSING', 'Missing authorization code in callback');
            return;
          }

          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<html><body><h3>Eclipse connected. You may close this tab.</h3></body></html>');

          const addr = server.address();
          const redirectUri = `http://127.0.0.1:${addr.port}${this.callbackPath}`;
          finishSuccess({ code, redirectUri });
        } catch (_) {
          res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Bad request');
          finishError('PKCE_CALLBACK_ERROR', 'Malformed OAuth callback request');
        }
      });

      this._server = server;

      server.on('error', () => {
        finishError('PKCE_SERVER_ERROR', 'Failed to start loopback OAuth callback server');
      });

      server.listen(0, '127.0.0.1', async () => {
        if (settled || this._cancelled) return;
        const addr = server.address();
        const redirectUri = `http://127.0.0.1:${addr.port}${this.callbackPath}`;

        const authUrl = new URL(this.authorizeUrl);
        authUrl.searchParams.set('response_type', 'code');
        authUrl.searchParams.set('client_id', clientId);
        authUrl.searchParams.set('redirect_uri', redirectUri);
        authUrl.searchParams.set('code_challenge_method', 'S256');
        authUrl.searchParams.set('code_challenge', codeChallenge);
        authUrl.searchParams.set('state', expectedState);
        authUrl.searchParams.set('scope', this.scopes.join(' '));

        this._timer = setTimeout(() => {
          finishError('PKCE_TIMEOUT', 'External PKCE authentication timed out');
        }, this.timeoutMs);

        try {
          if (typeof onAuthUrl === 'function') {
            onAuthUrl(authUrl.toString(), { redirectUri });
          }
          if (typeof openExternal === 'function') {
            await openExternal(authUrl.toString());
          }
        } catch (_) {
          finishError('PKCE_BROWSER_LAUNCH_FAILED', 'Failed to open system browser for authentication');
        }
      });
    });
  }

  async exchangeCode({ clientId, code, redirectUri, codeVerifier }) {
    assertHttpsUrl(this.tokenUrl, 'token');

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: codeVerifier
    });

    let res;
    try {
      res = await this.fetchImpl(this.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(15000)
      });
    } catch (_) {
      const err = new Error('Network error during token exchange');
      err.code = 'NETWORK_UNAVAILABLE';
      throw err;
    }

    let data = null;
    try {
      data = await res.json();
    } catch (_) {
      data = null;
    }

    if (!res.ok || !data || typeof data.access_token !== 'string' || !data.access_token) {
      const err = new Error(`Token exchange failed with HTTP ${res.status}`);
      err.code = res.status === 401 || res.status === 400 ? 'PKCE_TOKEN_REJECTED' : 'TEMP_REFUSAL';
      err.httpStatus = res.status;
      throw err;
    }

    const expiresIn = Number(data.expires_in);
    const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0
      ? Date.now() + expiresIn * 1000
      : Date.now() + 3600 * 1000;

    return {
      authType: 'pkce',
      accessToken: data.access_token,
      refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : null,
      tokenType: typeof data.token_type === 'string' ? data.token_type : 'Bearer',
      scope: typeof data.scope === 'string' ? data.scope : this.scopes.join(' '),
      expiresAt
    };
  }

  async refreshAccessToken({ clientId, refreshToken }) {
    const resolvedClientId = (typeof clientId === 'string' ? clientId.trim() : '') || this.clientId;
    if (!resolvedClientId || typeof refreshToken !== 'string' || !refreshToken) {
      const err = new Error('Missing client ID or refresh token');
      err.code = 'EXPIRED';
      throw err;
    }

    assertHttpsUrl(this.tokenUrl, 'token');

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: resolvedClientId
    });

    let res;
    try {
      res = await this.fetchImpl(this.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(15000)
      });
    } catch (_) {
      const err = new Error('Network error during token refresh');
      err.code = 'NETWORK_UNAVAILABLE';
      throw err;
    }

    let data = null;
    try {
      data = await res.json();
    } catch (_) {
      data = null;
    }

    if (!res.ok || !data || typeof data.access_token !== 'string' || !data.access_token) {
      const err = new Error(`Token refresh failed with HTTP ${res.status}`);
      err.code = res.status === 400 || res.status === 401 ? 'EXPIRED' : 'TEMP_REFUSAL';
      err.httpStatus = res.status;
      throw err;
    }

    const expiresIn = Number(data.expires_in);
    const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0
      ? Date.now() + expiresIn * 1000
      : Date.now() + 3600 * 1000;

    return {
      authType: 'pkce',
      accessToken: data.access_token,
      refreshToken: typeof data.refresh_token === 'string' && data.refresh_token
        ? data.refresh_token
        : refreshToken,
      tokenType: typeof data.token_type === 'string' ? data.token_type : 'Bearer',
      scope: typeof data.scope === 'string' ? data.scope : this.scopes.join(' '),
      expiresAt
    };
  }
}

module.exports = {
  ExternalPkceAuth,
  generateCodeVerifier,
  generateCodeChallenge,
  generateStateNonce,
  DEFAULT_AUTHORIZE_URL,
  DEFAULT_TOKEN_URL
};
