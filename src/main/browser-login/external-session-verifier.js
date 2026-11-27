'use strict';

const { validateExternalSessionCookies } = require('./external-cookie-validator');

const ExternalSessionStatus = Object.freeze({
  VALID: 'VALID',
  SIGNED_OUT: 'SIGNED_OUT',
  EXPIRED: 'EXPIRED',
  INVALID_COOKIE: 'INVALID_COOKIE',
  UNVERIFIED_WEB_SESSION: 'UNVERIFIED_WEB_SESSION',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  NETWORK_UNAVAILABLE: 'NETWORK_UNAVAILABLE',
  TEMP_REFUSAL: 'TEMP_REFUSAL',
  UNSUPPORTED_STORAGE: 'UNSUPPORTED_STORAGE'
});

const DEFAULT_WEB_TOKEN_URL = 'https://open.spotify.com/get_access_token?reason=transport&productType=web_player';
const DEFAULT_PROFILE_URL = 'https://api.spotify.com/v1/me';

function assertTlsEndpoint(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (_) {
    throw new Error('Invalid verification endpoint URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('Verification endpoint must use HTTPS/TLS');
  }
  return parsed.toString();
}

function sanitizeAvatarUrl(images) {
  if (!Array.isArray(images) || images.length === 0) return null;
  const first = images[0];
  if (!first || typeof first.url !== 'string') return null;
  try {
    const parsed = new URL(first.url);
    return parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch (_) {
    return null;
  }
}

function buildResult(status, extra = {}) {
  return {
    status,
    connected: status === ExternalSessionStatus.VALID,
    displayName: typeof extra.displayName === 'string' && extra.displayName ? extra.displayName : null,
    avatarUrl: typeof extra.avatarUrl === 'string' && extra.avatarUrl ? extra.avatarUrl : null,
    accountId: typeof extra.accountId === 'string' && extra.accountId ? extra.accountId : null,
    expiresAt: Number.isFinite(extra.expiresAt) ? extra.expiresAt : null,
    reason: typeof extra.reason === 'string' ? extra.reason : null
  };
}

class ExternalSessionVerifier {
  constructor(options = {}) {
    this.webTokenUrl = assertTlsEndpoint(options.webTokenUrl || DEFAULT_WEB_TOKEN_URL);
    this.profileUrl = assertTlsEndpoint(options.profileUrl || DEFAULT_PROFILE_URL);
    this.fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : fetch;
    this.nowFn = typeof options.nowFn === 'function' ? options.nowFn : () => Date.now();
  }

  async verify(credentials) {
    if (!credentials || typeof credentials !== 'object') {
      return buildResult(ExternalSessionStatus.SIGNED_OUT, { reason: 'No credentials provided' });
    }

    if (credentials.authType === 'pkce' || typeof credentials.accessToken === 'string') {
      return await this.verifyAccessToken(credentials);
    }

    if (credentials.authType === 'cookie' || Array.isArray(credentials.cookies) || typeof credentials.spDc === 'string') {
      return await this.verifyCookieSession(credentials);
    }

    return buildResult(ExternalSessionStatus.SIGNED_OUT, { reason: 'Unsupported credential format' });
  }

  async verifyAccessToken(credentials) {
    const accessToken = typeof credentials.accessToken === 'string' ? credentials.accessToken.trim() : '';
    if (!accessToken) {
      return buildResult(ExternalSessionStatus.SIGNED_OUT, { reason: 'Missing access token' });
    }

    const now = this.nowFn();
    if (Number.isFinite(credentials.expiresAt) && credentials.expiresAt <= now) {
      return buildResult(ExternalSessionStatus.EXPIRED, {
        expiresAt: credentials.expiresAt,
        reason: 'Access token expired'
      });
    }

    let res;
    try {
      res = await this.fetchImpl(this.profileUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json'
        },
        signal: AbortSignal.timeout(12000)
      });
    } catch (_) {
      return buildResult(ExternalSessionStatus.NETWORK_UNAVAILABLE, {
        reason: 'Network unavailable while verifying session'
      });
    }

    if (res.status === 401) {
      return buildResult(ExternalSessionStatus.EXPIRED, { reason: 'Access token rejected (401)' });
    }
    if (res.status === 403) {
      return buildResult(ExternalSessionStatus.PERMISSION_DENIED, { reason: 'Insufficient permissions (403)' });
    }
    if (res.status === 429 || res.status >= 500) {
      return buildResult(ExternalSessionStatus.TEMP_REFUSAL, { reason: `Upstream temporary refusal (${res.status})` });
    }
    if (!res.ok) {
      return buildResult(ExternalSessionStatus.SIGNED_OUT, { reason: `Unexpected HTTP status (${res.status})` });
    }

    let profile;
    try {
      profile = await res.json();
    } catch (_) {
      return buildResult(ExternalSessionStatus.SIGNED_OUT, { reason: 'Invalid JSON profile response' });
    }

    if (!profile || typeof profile !== 'object' || typeof profile.id !== 'string' || !profile.id.trim()) {
      return buildResult(ExternalSessionStatus.SIGNED_OUT, { reason: 'Profile schema validation failed' });
    }

    return buildResult(ExternalSessionStatus.VALID, {
      accountId: profile.id.trim(),
      displayName: typeof profile.display_name === 'string' && profile.display_name.trim()
        ? profile.display_name.trim()
        : profile.id.trim(),
      avatarUrl: sanitizeAvatarUrl(profile.images),
      expiresAt: Number.isFinite(credentials.expiresAt) ? credentials.expiresAt : null
    });
  }

  async verifyCookieSession(credentials) {
    try {
      const cookieList = Array.isArray(credentials.cookies)
        ? credentials.cookies
        : [{
            name: 'sp_dc',
            value: credentials.spDc,
            domain: 'open.spotify.com',
            path: '/',
            secure: true,
            httpOnly: true,
            hostOnly: true
          }];
      validateExternalSessionCookies(cookieList, {
        nowSeconds: Math.floor(this.nowFn() / 1000)
      });
    } catch (err) {
      return buildResult(ExternalSessionStatus.INVALID_COOKIE, {
        reason: err && err.message ? err.message : 'Invalid external session cookie'
      });
    }

    // sp_dc cookie bridge is strictly an unverified local web session;
    // Official OAuth PKCE + /v1/me is the only trusted account authentication.
    return buildResult(ExternalSessionStatus.UNVERIFIED_WEB_SESSION, {
      reason: 'Unverified local web session (Official OAuth PKCE required for account authentication)'
    });
  }
}

module.exports = {
  ExternalSessionVerifier,
  ExternalSessionStatus,
  DEFAULT_WEB_TOKEN_URL,
  DEFAULT_PROFILE_URL
};
