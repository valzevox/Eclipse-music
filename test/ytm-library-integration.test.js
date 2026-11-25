// d:/Eclipse/eclipse-pc/test/ytm-library-integration.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const YtmAuthManager = require('../src/server/ytm-auth');
const { YtmLibraryService, buildActiveAccountHeaders } = require('../src/server/ytm-library-service');
const { WEB_REMIX_CLIENT } = require('../src/server/ytm-client-config');
const { BrowserCookieRecord, buildCookieHeader, extractSapisidCredential } = require('../src/main/browser-login/browser-cookie-record');

function makeTrackRenderer(videoId, title, artist, durationText) {
  return {
    musicResponsiveListItemRenderer: {
      playlistItemData: { videoId },
      flexColumns: [
        { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: title }] } } },
        { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: artist }, { text: ' • ' }, { text: durationText || '' }] } } }
      ]
    }
  };
}

function createTempAuthManager() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eclipse-ytm-lib-test-'));
  const auth = new YtmAuthManager(tmpDir);
  return { auth, tmpDir };
}

test('P0-1 & P1-1: Extension-only login active account drives library & album fetch with real authUser, optional pageId, and centralized WEB_REMIX config', async () => {
  const { auth, tmpDir } = createTempAuthManager();
  try {
    await auth.init();
    auth.accounts = [
      {
        id: 'acc-brand-1',
        name: 'Brand Channel',
        handle: '@brand',
        cookie: 'SAPISID=yt_secret_brand_1; SID=sid1',
        authUser: 2,
        pageId: '109876543210',
        isDefault: true
      },
      {
        id: 'acc-google-2',
        name: 'Personal Account',
        handle: '@personal',
        cookie: 'SAPISID=yt_secret_personal_2; SID=sid2',
        authUser: 1,
        pageId: null,
        isDefault: false
      }
    ];

    const capturedRequests = [];
    const mockFetch = async (url, init) => {
      const parsedBody = JSON.parse(init.body);
      capturedRequests.push({ url, headers: init.headers, body: parsedBody });
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        json: async () => ({
          contents: [makeTrackRenderer('vid_1', 'Track One', 'Artist A', '3:20')]
        })
      };
    };

    const lib = new YtmLibraryService(auth, { fetchImpl: mockFetch });
    const res1 = await lib.fetchTracksPaginated('PL_TEST_1');
    assert.strictEqual(res1.success, true);
    assert.strictEqual(res1.complete, true);
    assert.strictEqual(res1.accountId, 'acc-brand-1');
    assert.strictEqual(res1.tracks.length, 1);
    assert.strictEqual(res1.tracks[0].duration, 200);

    // Verify headers & WEB_REMIX config for account 1 (authUser=2, real pageId)
    assert.strictEqual(capturedRequests[0].headers['X-Goog-AuthUser'], '2');
    assert.strictEqual(capturedRequests[0].headers['X-Goog-PageId'], '109876543210');
    assert.strictEqual(capturedRequests[0].body.context.client.clientVersion, WEB_REMIX_CLIENT.clientVersion);
    assert.ok(capturedRequests[0].headers['Authorization'].startsWith('SAPISIDHASH '));

    // Ensure sanitized active account never leaks raw cookie
    const sanitized = auth.getActiveAccount();
    assert.strictEqual(sanitized.cookie, undefined);
    assert.strictEqual(JSON.stringify(res1).includes('yt_secret_brand_1'), false);

    // Switch to account 2 (authUser=1, pageId=null) -> X-Goog-PageId must be omitted
    auth.switchAccount('acc-google-2');
    const res2 = await lib.fetchTracksPaginated('PL_TEST_1');
    assert.strictEqual(res2.accountId, 'acc-google-2');
    assert.strictEqual(capturedRequests[1].headers['X-Goog-AuthUser'], '1');
    assert.strictEqual(capturedRequests[1].headers['X-Goog-PageId'], undefined);

    // Stale expectedAccountId is rejected with ACCOUNT_MISMATCH (409)
    const staleRes = await lib.fetchFullLibrary({ expectedAccountId: 'acc-brand-1' });
    assert.strictEqual(staleRes.success, false);
    assert.strictEqual(staleRes.errorCode, 'ACCOUNT_MISMATCH');
    assert.strictEqual(staleRes.httpStatus, 409);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('P0-3: Strict YouTube cookie scope excludes .google.com and accounts.google.com', () => {
  const records = [
    new BrowserCookieRecord({ name: 'SAPISID', value: 'google_only_secret', domain: '.google.com', path: '/', secure: true }),
    new BrowserCookieRecord({ name: 'SID', value: 'accounts_sid', domain: 'accounts.google.com', path: '/', secure: true }),
    new BrowserCookieRecord({ name: 'SAPISID', value: 'yt_valid_secret', domain: '.youtube.com', path: '/', secure: true }),
    new BrowserCookieRecord({ name: 'LOGIN_INFO', value: 'yt_login', domain: '.youtube.com', path: '/', secure: true })
  ];

  const header = buildCookieHeader(records, 'music.youtube.com', '/');
  const cred = extractSapisidCredential(records, 'music.youtube.com', '/getAccountSwitcherEndpoint');

  assert.ok(cred && cred.value === 'yt_valid_secret');
  assert.ok(header.includes('SAPISID=yt_valid_secret'));
  assert.strictEqual(header.includes('google_only_secret'), false);
  assert.strictEqual(header.includes('accounts_sid'), false);

  const headers = buildActiveAccountHeaders({ cookie: header, authUser: 0, pageId: null });
  assert.ok(headers && headers['Authorization'].startsWith('SAPISIDHASH '));
});

test('P1-3: Continuation deduplicates globally across pages, continues past empty page, and flags page cap incomplete', async () => {
  const { auth, tmpDir } = createTempAuthManager();
  try {
    await auth.init();
    auth.accounts = [{ id: 'acc-1', name: 'User', cookie: 'SAPISID=secret_ok', authUser: 0, pageId: null, isDefault: true }];

    // 3 pages: page 1 has v1,v2 + token1; page 2 has 0 tracks + token2; page 3 has duplicate v2 + new v3 + no token
    let callIdx = 0;
    const pages = [
      { contents: [makeTrackRenderer('v1', 'One', 'A', '2:00'), makeTrackRenderer('v2', 'Two', 'A', '3:00')], cont: { continuationCommand: { token: 'tok_2' } } },
      { contents: [], cont: { continuationCommand: { token: 'tok_3' } } },
      { contents: [makeTrackRenderer('v2', 'Two Dup', 'A', '3:00'), makeTrackRenderer('v3', 'Three', 'B', '')] }
    ];
    const lib = new YtmLibraryService(auth, {
      maxTrackPages: 5,
      fetchImpl: async () => ({ ok: true, status: 200, headers: new Map(), json: async () => pages[callIdx++] })
    });

    const res = await lib.fetchTracksPaginated('VLPL_DUP_TEST');
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.complete, true);
    assert.strictEqual(res.continuationRemaining, false);
    assert.strictEqual(res.pagesFetched, 3);
    assert.deepStrictEqual(res.tracks.map(t => t.id), ['v1', 'v2', 'v3']);
    assert.strictEqual(res.tracks[2].duration, null);

    // Page cap reached while continuation remains -> complete: false, continuationRemaining: true
    const capLib = new YtmLibraryService(auth, {
      maxTrackPages: 2,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: new Map(),
        json: async () => ({
          contents: [makeTrackRenderer('v_' + Math.random(), 'Song', 'A', '1:00')],
          cont: { continuationCommand: { token: 'next_' + Math.random() } }
        })
      })
    });
    const capRes = await capLib.fetchTracksPaginated('VLPL_CAP');
    assert.strictEqual(capRes.success, true);
    assert.strictEqual(capRes.complete, false);
    assert.strictEqual(capRes.continuationRemaining, true);
    assert.strictEqual(capRes.pagesFetched, 2);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('P1-4: HTTP 429 preserves Retry-After and cancelRequest aborts underlying fetch', async () => {
  const { auth, tmpDir } = createTempAuthManager();
  try {
    await auth.init();
    auth.accounts = [{ id: 'acc-1', name: 'User', cookie: 'SAPISID=secret_ok', authUser: 0, pageId: null, isDefault: true }];

    // HTTP 429 with Retry-After header
    const lib429 = new YtmLibraryService(auth, {
      fetchImpl: async () => ({
        ok: false,
        status: 429,
        headers: new Map([['retry-after', '75']]),
        json: async () => ({})
      })
    });
    const res429 = await lib429.fetchFullLibrary({ doLikes: true, doPlaylists: false, doAlbums: false });
    assert.strictEqual(res429.success, false);
    assert.strictEqual(res429.httpStatus, 429);
    assert.strictEqual(res429.retryAfter, 75);

    // Real cancellation via AbortController
    let aborted = false;
    const libCancel = new YtmLibraryService(auth, {
      fetchImpl: (url, init) => new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => {
          aborted = true;
          const e = new Error('Aborted');
          e.name = 'AbortError';
          reject(e);
        });
      })
    });
    const reqPromise = libCancel.fetchFullLibrary({ requestId: 'req_abort_1', doLikes: true, doPlaylists: false, doAlbums: false });
    const didCancel = libCancel.cancelRequest('req_abort_1');
    assert.strictEqual(didCancel, true);
    const cancelRes = await reqPromise;
    assert.strictEqual(aborted, true);
    assert.strictEqual(cancelRes.success, false);
    assert.strictEqual(cancelRes.errorCode, 'ABORTED');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
