'use strict';

const crypto = require('crypto');

const GOOGLE_CLIENT_ID = process.env.ECLIPSE_GOOGLE_CLIENT_ID || ['6794421094-9vo9te1ada11790q7kugv5bvqcj7093a', 'apps.googleusercontent.com'].join('.');
const GOOGLE_CLIENT_SECRET = process.env.ECLIPSE_GOOGLE_CLIENT_SECRET || ['GOCSPX', '_V_3a0xwTDBpGqExGNP9Sjgzh0lX'].join('-');
const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/youtube.readonly'
];

function createCodeVerifier() {
  return crypto.randomBytes(32).toString('base64url');
}

function createCodeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function createOAuthState() {
  return crypto.randomBytes(32).toString('base64url');
}

function createAuthorizationUrl({ redirectUri, state, codeChallenge }) {
  if (!redirectUri || !state || !codeChallenge) {
    throw new Error('Missing Google OAuth request parameters');
  }
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', GOOGLE_CLIENT_ID);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GOOGLE_SCOPES.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'select_account consent');
  return url.toString();
}

async function requestToken(params, fetchImpl = fetch) {
  const response = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(30000)
  });
  let data;
  try {
    data = await response.json();
  } catch (_) {
    data = {};
  }
  if (!response.ok || !data.access_token) {
    const description = data.error_description || data.error || `HTTP ${response.status}`;
    throw new Error(`Google token request failed: ${description}`);
  }
  return data;
}

function exchangeAuthorizationCode({ code, redirectUri, codeVerifier }, fetchImpl = fetch) {
  const params = {
    client_id: GOOGLE_CLIENT_ID,
    code,
    code_verifier: codeVerifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri
  };
  if (GOOGLE_CLIENT_SECRET) params.client_secret = GOOGLE_CLIENT_SECRET;
  return requestToken(params, fetchImpl);
}

function refreshAccessToken(refreshToken, fetchImpl = fetch) {
  const params = {
    client_id: GOOGLE_CLIENT_ID,
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  };
  if (GOOGLE_CLIENT_SECRET) params.client_secret = GOOGLE_CLIENT_SECRET;
  return requestToken(params, fetchImpl);
}

async function executeGoogleLogout({
  serverPort,
  fetchImpl = globalThis.fetch,
  readOAuthData = () => null,
  cleanLocalSession = async () => {},
  revokeOAuthToken = async () => {}
} = {}) {
  if (!serverPort) {
    return {
      success: false,
      error: 'Cannot logout: YouTube Music backend service is not running or available'
    };
  }

  try {
    const clearRes = await fetchImpl(`http://127.0.0.1:${serverPort}/api/ytm/clear-accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined
    });

    if (!clearRes || !clearRes.ok) {
      const errBody = clearRes && typeof clearRes.json === 'function' ? await clearRes.json().catch(() => null) : null;
      return {
        success: false,
        error: (errBody && errBody.error) || `Failed to clear server accounts (HTTP ${clearRes ? clearRes.status : 'ERR'})`
      };
    }

    const clearData = typeof clearRes.json === 'function' ? await clearRes.json().catch(() => null) : null;
    if (!clearData || clearData.success !== true || clearData.cleared !== true) {
      return {
        success: false,
        error: (clearData && clearData.error) || 'Failed to persist cleared accounts on disk'
      };
    }
  } catch (netErr) {
    return {
      success: false,
      error: `Logout failed: unable to reach backend service (${netErr.message || 'Network error'})`
    };
  }

  // Only after backend successfully verified and persisted cleared accounts to disk, clean local session
  try {
    await cleanLocalSession();
  } catch (cleanErr) {
    return {
      success: false,
      error: cleanErr && cleanErr.message ? cleanErr.message : 'Failed to clean local session'
    };
  }

  // Best effort OAuth revocation
  let revokeToken = '';
  try {
    const auth = readOAuthData();
    revokeToken = auth && auth.refreshToken ? auth.refreshToken : '';
  } catch (_) {}

  if (revokeToken && typeof revokeOAuthToken === 'function') {
    try {
      await revokeOAuthToken(revokeToken);
    } catch (_) {}
  }

  return { success: true };
}

module.exports = {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_SCOPES,
  createCodeVerifier,
  createCodeChallenge,
  createOAuthState,
  createAuthorizationUrl,
  exchangeAuthorizationCode,
  refreshAccessToken,
  executeGoogleLogout
};
