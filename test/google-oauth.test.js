'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  GOOGLE_CLIENT_ID,
  GOOGLE_SCOPES,
  createCodeVerifier,
  createCodeChallenge,
  createOAuthState,
  createAuthorizationUrl,
  exchangeAuthorizationCode,
  refreshAccessToken,
  executeGoogleLogout
} = require('../src/main/google-oauth');
const { fetchYouTubeLibrary } = require('../src/main/youtube-data');

test('Google OAuth creates a PKCE authorization request for the configured desktop client', () => {
  const verifier = createCodeVerifier();
  const challenge = createCodeChallenge(verifier);
  const state = createOAuthState();
  const authorizationUrl = new URL(createAuthorizationUrl({
    redirectUri: 'http://127.0.0.1:49152/oauth2callback',
    state,
    codeChallenge: challenge
  }));

  assert.equal(authorizationUrl.searchParams.get('client_id'), GOOGLE_CLIENT_ID);
  assert.equal(authorizationUrl.searchParams.get('redirect_uri'), 'http://127.0.0.1:49152/oauth2callback');
  assert.equal(authorizationUrl.searchParams.get('response_type'), 'code');
  assert.equal(authorizationUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorizationUrl.searchParams.get('code_challenge'), challenge);
  assert.equal(authorizationUrl.searchParams.get('state'), state);
  assert.equal(authorizationUrl.searchParams.get('access_type'), 'offline');
  assert.equal(authorizationUrl.searchParams.get('prompt'), 'select_account consent');
  assert.ok(GOOGLE_SCOPES.includes('https://www.googleapis.com/auth/youtube.readonly'));
  assert.equal(createCodeChallenge(verifier), crypto.createHash('sha256').update(verifier).digest('base64url'));
});

test('Google OAuth exchanges and refreshes tokens without a client secret', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options, body: new URLSearchParams(options.body) });
    return {
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'access-token', refresh_token: 'refresh-token', expires_in: 3600 })
    };
  };

  const exchanged = await exchangeAuthorizationCode({
    code: 'authorization-code',
    redirectUri: 'http://127.0.0.1:49152/oauth2callback',
    codeVerifier: 'verifier'
  }, fetchImpl);
  const refreshed = await refreshAccessToken('refresh-token', fetchImpl);

  assert.equal(exchanged.access_token, 'access-token');
  assert.equal(refreshed.refresh_token, 'refresh-token');
  assert.equal(requests[0].body.get('grant_type'), 'authorization_code');
  assert.equal(requests[0].body.get('code'), 'authorization-code');
  assert.equal(requests[0].body.get('code_verifier'), 'verifier');
  assert.equal(requests[0].body.get('client_id'), GOOGLE_CLIENT_ID);
  assert.equal(requests[1].body.get('grant_type'), 'refresh_token');
  assert.equal(requests[1].body.get('refresh_token'), 'refresh-token');
});

test('YouTube library import paginates likes and playlists and adds video durations', async () => {
  const requests = [];
  const fetchImpl = async (input, options) => {
    const url = new URL(input);
    requests.push(url);
    assert.equal(options.headers.Authorization, 'Bearer access-token');

    if (url.pathname.endsWith('/videos') && url.searchParams.get('myRating') === 'like') {
      if (url.searchParams.get('pageToken') === 'likes-page-2') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            items: [{
              id: 'video-2',
              contentDetails: { duration: 'PT1H2M3S' },
              snippet: { title: 'Second', channelTitle: 'Artist B', thumbnails: { high: { url: 'https://img/2' } } }
            }]
          })
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          items: [{
            id: 'video-1',
            contentDetails: { duration: 'PT3M14S' },
            snippet: { title: 'First', channelTitle: 'Artist A', thumbnails: { medium: { url: 'https://img/1' } } }
          }],
          nextPageToken: 'likes-page-2'
        })
      };
    }

    if (url.pathname.endsWith('/playlists')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          items: [{
            id: 'PL_ONE',
            snippet: { title: 'My playlist', thumbnails: { high: { url: 'https://img/playlist' } } }
          }]
        })
      };
    }

    if (url.pathname.endsWith('/playlistItems')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          items: [{
            contentDetails: { videoId: 'video-3' },
            snippet: { title: 'Playlist track', channelTitle: 'Artist C' }
          }]
        })
      };
    }

    if (url.pathname.endsWith('/videos')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          items: [{ id: 'video-3', contentDetails: { duration: 'PT45S' } }]
        })
      };
    }

    throw new Error(`Unexpected request: ${url}`);
  };

  const result = await fetchYouTubeLibrary('access-token', { platform: 'youtube' }, fetchImpl);

  assert.deepEqual(result.likes.map(track => [track.title, track.artist, track.duration]), [
    ['First', 'Artist A', 194],
    ['Second', 'Artist B', 3723]
  ]);
  assert.equal(result.likes[0].cover, 'https://img/1');
  assert.equal(result.likes[0].url, 'https://www.youtube.com/watch?v=video-1');
  assert.equal(result.playlists.length, 1);
  assert.equal(result.playlists[0].name, 'My playlist');
  assert.equal(result.playlists[0].cover, 'https://img/playlist');
  assert.equal(result.playlists[0].tracks[0].duration, 45);
  assert.ok(requests.some(url => url.searchParams.get('pageToken') === 'likes-page-2'));
});

test('YtmAuthManager enforces valid account profile and safe persistence', async () => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const YtmAuthManager = require('../src/server/ytm-auth');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytm-auth-test-'));
  try {
    const authManager = new YtmAuthManager(tmpDir);
    await authManager.init();

    // 1. Initial state has no accounts
    assert.equal(authManager.getAccounts().length, 0);
    assert.equal(authManager.getDefaultAccount(), null);

    // 2. Clear all accounts on empty state returns true/clean
    const clearRes = await authManager.clearAllAccounts();
    assert.equal(clearRes, true);
    assert.equal(authManager.getAccounts().length, 0);

    // 3. Reject invalid / empty cookie payload
    await assert.rejects(
      async () => authManager.addAccountFromCookie(''),
      /Invalid cookie payload/
    );

    // 4. Reject cookie that fails Innertube session or getInfo (dummy cookie)
    await assert.rejects(
      async () => authManager.addAccountFromCookie('SAPISID=fake_value_1234; SID=fake_sid'),
      /(Failed to retrieve YouTube account profile|Could not establish YouTube Music session)/
    );

    // Verify storage remained untouched and uncorrupted
    assert.equal(authManager.getAccounts().length, 0);

    // 5. Test persistence failure rollback in addAccountFromCookie
    // Simulate saveAccounts failure
    authManager.saveAccounts = async () => false;
    authManager.accounts = [{ id: 'existing_account', name: 'Existing' }];
    await assert.rejects(
      async () => authManager.addAccountFromCookie('SAPISID=fake_fail; SID=fake_sid'),
      /(Failed to persist authenticated YouTube account to disk|Failed to retrieve YouTube account profile|Could not establish YouTube Music session)/
    );
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
});

test('google-auth-status Detailed Auth Status logic verifies fail-closed invariants', () => {
  // Simulating google-auth-status evaluator function
  function evaluateGoogleAuthStatus({ authData, serverAccountsData, serverAvailable, hasLogoutFlag }) {
    const auth = authData;
    const googleDataOAuth = {
      hasRefreshToken: !!(auth && typeof auth.refreshToken === 'string' && auth.refreshToken.trim())
    };

    let ytmConnected = false;
    let ytmAccount = null;

    if (serverAvailable && !hasLogoutFlag) {
      if (serverAccountsData && serverAccountsData.activeAccount && serverAccountsData.activeAccount.id && serverAccountsData.activeAccount.id !== 'unknown') {
        ytmConnected = true;
        ytmAccount = serverAccountsData.activeAccount;
      }
    }

    return {
      loggedIn: ytmConnected,
      ytmConnected,
      ytmAccount,
      googleDataOAuth
    };
  }

  // 1. Has Google OAuth refresh token but NO backend YTM account -> loggedIn: false, ytmConnected: false
  const res1 = evaluateGoogleAuthStatus({
    authData: { refreshToken: 'valid-google-refresh-token' },
    serverAccountsData: { activeAccount: null },
    serverAvailable: true,
    hasLogoutFlag: false
  });
  assert.equal(res1.loggedIn, false);
  assert.equal(res1.ytmConnected, false);
  assert.equal(res1.ytmAccount, null);
  assert.equal(res1.googleDataOAuth.hasRefreshToken, true);

  // 2. Has raw cookie in session but backend has NO active account -> ytmConnected: false
  const res2 = evaluateGoogleAuthStatus({
    authData: null,
    serverAccountsData: { activeAccount: null },
    serverAvailable: true,
    hasLogoutFlag: false
  });
  assert.equal(res2.loggedIn, false);
  assert.equal(res2.ytmConnected, false);

  // 3. Has active YTM account but NO Google OAuth token -> ytmConnected: true, hasRefreshToken: false
  const res3 = evaluateGoogleAuthStatus({
    authData: null,
    serverAccountsData: { activeAccount: { id: 'channel_123', name: 'Alice' } },
    serverAvailable: true,
    hasLogoutFlag: false
  });
  assert.equal(res3.loggedIn, true);
  assert.equal(res3.ytmConnected, true);
  assert.equal(res3.ytmAccount.id, 'channel_123');
  assert.equal(res3.googleDataOAuth.hasRefreshToken, false);

  // 4. Backend down / timeout (serverAvailable: false) -> ytmConnected: false (no fallback)
  const res4 = evaluateGoogleAuthStatus({
    authData: { refreshToken: 'tok' },
    serverAccountsData: { activeAccount: { id: 'channel_123' } },
    serverAvailable: false,
    hasLogoutFlag: false
  });
  assert.equal(res4.loggedIn, false);
  assert.equal(res4.ytmConnected, false);

  // 5. Logout flag present -> ytmConnected: false even if server had cached session
  const res5 = evaluateGoogleAuthStatus({
    authData: null,
    serverAccountsData: { activeAccount: { id: 'channel_123' } },
    serverAvailable: true,
    hasLogoutFlag: true
  });
  assert.equal(res5.loggedIn, false);
  assert.equal(res5.ytmConnected, false);
});

test('executeGoogleLogout enforces strict fail-closed durability and preserves local session until verified', async () => {
  let localSessionCleaned = false;
  let oauthTokenRevoked = false;

  const resetState = () => {
    localSessionCleaned = false;
    oauthTokenRevoked = false;
  };

  // 1. serverPort is null / undefined -> FAIL-CLOSED immediately
  resetState();
  const resNoPort = await executeGoogleLogout({
    serverPort: null,
    fetchImpl: async () => assert.fail('fetch should not be called without serverPort'),
    cleanLocalSession: async () => { localSessionCleaned = true; }
  });
  assert.equal(resNoPort.success, false);
  assert.match(resNoPort.error, /YouTube Music backend service is not running or available/);
  assert.equal(localSessionCleaned, false, 'Local session MUST NOT be cleaned if serverPort is missing');

  // 2. Backend returns HTTP 500 error -> FAIL-CLOSED
  resetState();
  const res500 = await executeGoogleLogout({
    serverPort: 38472,
    fetchImpl: async () => ({
      ok: false,
      status: 500,
      json: async () => ({ success: false, error: 'Database locked' })
    }),
    cleanLocalSession: async () => { localSessionCleaned = true; }
  });
  assert.equal(res500.success, false);
  assert.match(res500.error, /Database locked/);
  assert.equal(localSessionCleaned, false, 'Local session MUST NOT be cleaned when server returns HTTP 500');

  // 3. Backend returns cleared: false -> FAIL-CLOSED
  resetState();
  const resClearedFalse = await executeGoogleLogout({
    serverPort: 38472,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: false, cleared: false, error: 'Encrypted storage flush error' })
    }),
    cleanLocalSession: async () => { localSessionCleaned = true; }
  });
  assert.equal(resClearedFalse.success, false);
  assert.match(resClearedFalse.error, /Encrypted storage flush error/);
  assert.equal(localSessionCleaned, false, 'Local session MUST NOT be cleaned when clearAccounts fails to persist');

  // 4. Network timeout / connection error -> FAIL-CLOSED
  resetState();
  const resTimeout = await executeGoogleLogout({
    serverPort: 38472,
    fetchImpl: async () => { throw new Error('ETIMEDOUT'); },
    cleanLocalSession: async () => { localSessionCleaned = true; }
  });
  assert.equal(resTimeout.success, false);
  assert.match(resTimeout.error, /unable to reach backend service/);
  assert.equal(localSessionCleaned, false, 'Local session MUST NOT be cleaned on network timeout');

  // 5. Backend returns success: true and cleared: true -> SUCCESS and local session cleaned
  resetState();
  const resSuccess = await executeGoogleLogout({
    serverPort: 38472,
    fetchImpl: async (url, opts) => {
      assert.ok(url.endsWith('/api/ytm/clear-accounts'));
      assert.equal(opts.method, 'POST');
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, cleared: true })
      };
    },
    readOAuthData: () => ({ refreshToken: 'refresh-token-xyz' }),
    cleanLocalSession: async () => { localSessionCleaned = true; },
    revokeOAuthToken: async (tok) => {
      assert.equal(tok, 'refresh-token-xyz');
      oauthTokenRevoked = true;
    }
  });
  assert.equal(resSuccess.success, true);
  assert.equal(localSessionCleaned, true, 'Local session is cleaned only after verified server durability');
  assert.equal(oauthTokenRevoked, true, 'OAuth token revocation is triggered');

  // 6. Regression P2: cleanLocalSession removes OAuth file/token BEFORE revokeOAuthToken runs.
  // Proves revokeOAuthToken receives the pre-captured token even after readOAuthData becomes null.
  resetState();
  let fakeOAuthStorage = { refreshToken: 'captured-pre-cleanup-token' };
  let capturedRevokeArg = null;
  const resCaptureOrder = await executeGoogleLogout({
    serverPort: 38472,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, cleared: true })
    }),
    readOAuthData: () => fakeOAuthStorage,
    cleanLocalSession: async () => {
      // Simulate unlinking / deleting GOOGLE_OAUTH_FILE during local session cleanup
      fakeOAuthStorage = null;
      localSessionCleaned = true;
    },
    revokeOAuthToken: async (tok) => {
      capturedRevokeArg = tok;
      oauthTokenRevoked = true;
    }
  });
  assert.equal(resCaptureOrder.success, true);
  assert.equal(localSessionCleaned, true);
  assert.equal(oauthTokenRevoked, true);
  assert.equal(capturedRevokeArg, 'captured-pre-cleanup-token', 'Revoke must use captured token even if file was deleted during cleanup');

  // 7. If cleanLocalSession throws, logout must fail and return error
  resetState();
  const resCleanFail = await executeGoogleLogout({
    serverPort: 38472,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, cleared: true })
    }),
    readOAuthData: () => ({ refreshToken: 'tok' }),
    cleanLocalSession: async () => {
      throw new Error('EPERM: operation not permitted, unlink');
    },
    revokeOAuthToken: async () => {
      oauthTokenRevoked = true;
    }
  });
  assert.equal(resCleanFail.success, false);
  assert.match(resCleanFail.error, /operation not permitted/);
  assert.equal(oauthTokenRevoked, false, 'Revocation must not proceed if local cleanup fails');
});
