'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const {
  BrowserCookieRecord,
  buildCookieHeader,
  extractSapisidCredential
} = require('../src/main/browser-login/browser-cookie-record');
const { WEB_REMIX_CLIENT } = require('../src/server/ytm-client-config');
const YtmAuthManager = require('../src/server/ytm-auth');
const { BrowserLoginService } = require('../src/main/browser-login/browser-login-service');
const { BrowserLoginFailure, BrowserLoginException } = require('../src/main/browser-login/browser-login-errors');

describe('YTM Auth Verification & Reference Schema Suite', () => {

  it('1. Cookie Scoping: .google.com cookies are NOT injected into music.youtube.com Cookie header', () => {
    const cookies = [
      new BrowserCookieRecord({ name: 'SAPISID', value: 'secret_sapisid_google', domain: '.google.com' }),
      new BrowserCookieRecord({ name: 'SSID', value: 'secret_ssid_google', domain: '.google.com' }),
      new BrowserCookieRecord({ name: 'VISITOR_INFO1_LIVE', value: 'yt_visitor_123', domain: '.youtube.com' }),
      new BrowserCookieRecord({ name: 'SAPISID', value: 'secret_sapisid_yt', domain: '.youtube.com' }),
      new BrowserCookieRecord({ name: 'YSC', value: 'ysc_val', domain: 'music.youtube.com', hostOnly: true })
    ];

    const header = buildCookieHeader(cookies, 'music.youtube.com');
    assert.ok(header.includes('VISITOR_INFO1_LIVE=yt_visitor_123'));
    assert.ok(header.includes('SAPISID=secret_sapisid_yt'));
    assert.ok(header.includes('YSC=ysc_val'));
    // Crucial invariant: .google.com cookies must NOT appear in the Cookie header destined for music.youtube.com
    assert.ok(!header.includes('secret_sapisid_google'));
    assert.ok(!header.includes('secret_ssid_google'));
  });

  it('2. SAPISID Extraction: validates eligibility, non-empty, secure, and preserves metadata', () => {
    const cookies = [
      new BrowserCookieRecord({ name: 'SAPISID', value: 'sapisid_from_google', domain: '.google.com', secure: true }),
      new BrowserCookieRecord({ name: 'VISITOR_INFO1_LIVE', value: 'yt_visitor', domain: '.youtube.com' })
    ];

    const cred = extractSapisidCredential(cookies);
    assert.ok(cred);
    assert.equal(cred.name, 'SAPISID');
    assert.equal(cred.value, 'sapisid_from_google');
    assert.equal(cred.domain, '.google.com');
    assert.equal(cred.secure, true);

    // Insecure or expired credentials must be rejected
    const expiredCookies = [
      new BrowserCookieRecord({ name: 'SAPISID', value: 'expired_val', domain: '.youtube.com', expiry: 1000 })
    ];
    assert.equal(extractSapisidCredential(expiredCookies), null);

    const insecureCookies = [
      new BrowserCookieRecord({ name: 'SAPISID', value: 'insecure_val', domain: '.youtube.com', secure: false })
    ];
    assert.equal(extractSapisidCredential(insecureCookies), null);
  });

  it('3. Centralized WEB_REMIX Configuration: exact reference values and macOS Chrome 140 User-Agent', () => {
    assert.equal(WEB_REMIX_CLIENT.clientName, 'WEB_REMIX');
    assert.equal(WEB_REMIX_CLIENT.xYouTubeClientName, '1');
    assert.equal(WEB_REMIX_CLIENT.clientVersion, '1.20260304.03.00');
    assert.equal(WEB_REMIX_CLIENT.apiFormatVersion, '1');
    assert.equal(WEB_REMIX_CLIENT.origin, 'https://music.youtube.com');
    assert.equal(WEB_REMIX_CLIENT.referer, 'https://music.youtube.com/');
    assert.ok(WEB_REMIX_CLIENT.defaultUserAgent.includes('Chrome/140.0.0.0'));
    assert.ok(WEB_REMIX_CLIENT.defaultUserAgent.includes('Macintosh; Intel Mac OS X 10_15_7'));
  });

  it('4. Real Reference Schema: extracts active account from payload.data.contents with nested tokens', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytm-test-'));
    const manager = new YtmAuthManager(tempDir);

    const mockResponsePayload = ")]}'\n" + JSON.stringify({
      code: 'SUCCESS',
      data: {
        contents: [
          {
            accountSectionListRenderer: {
              contents: [
                {
                  accountItemSectionRenderer: {
                    contents: [
                      {
                        accountItem: {
                          accountName: { simpleText: 'Taylor Swift Official' },
                          channelHandle: { simpleText: '@TaylorSwift' },
                          accountPhoto: { thumbnails: [{ url: 'https://lh3.googleusercontent.com/avatar_ts' }] },
                          isSelected: true,
                          hasChannel: true,
                          serviceEndpoint: {
                            selectActiveIdentityEndpoint: {
                              supportedTokens: [
                                { pageIdToken: { pageId: 'PAGE_TS_1989' } },
                                { accountSigninToken: { signinUrl: 'https://music.youtube.com?authuser=2' } }
                              ]
                            }
                          }
                        }
                      }
                    ]
                  }
                }
              ]
            }
          }
        ]
      }
    });

    manager._accountSwitcherTransport = async (url, opts) => {
      assert.ok(url.includes('/getAccountSwitcherEndpoint'));
      assert.ok(opts.headers.Authorization.startsWith('SAPISIDHASH '));
      assert.equal(opts.headers['X-YouTube-Client-Name'], '1');
      assert.equal(opts.headers['X-YouTube-Client-Version'], '1.20260304.03.00');
      assert.equal(opts.headers['X-Goog-Api-Format-Version'], '1');
      assert.equal(opts.headers['User-Agent'], WEB_REMIX_CLIENT.defaultUserAgent);
      return {
        ok: true,
        status: 200,
        text: async () => mockResponsePayload
      };
    };

    const cookieStr = 'SAPISID=test_sapisid; other=123';
    const profile = await manager.verifySessionWithAccountSwitcher(cookieStr);
    assert.equal(profile.name, 'Taylor Swift Official');
    assert.equal(profile.handle, '@TaylorSwift');
    assert.equal(profile.avatarUrl, 'https://lh3.googleusercontent.com/avatar_ts');
    assert.equal(profile.pageId, 'PAGE_TS_1989');
    assert.equal(profile.id, 'PAGE_TS_1989');
    assert.equal(profile.authUser, 2);

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('5. Ambiguous Account Selection: rejects if multiple accounts have isSelected=true or none selected among multiple', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytm-test-'));
    const manager = new YtmAuthManager(tempDir);

    // Case A: Multiple accounts marked isSelected=true
    const mockMultiSelected = ")]}'\n" + JSON.stringify({
      code: 'SUCCESS',
      data: {
        contents: [{
          accountSectionListRenderer: {
            contents: [{
              accountItemSectionRenderer: {
                contents: [
                  { accountItem: { isSelected: true, accountName: { simpleText: 'Acc 1' }, onBehalfOfParameter: 'P1' } },
                  { accountItem: { isSelected: true, accountName: { simpleText: 'Acc 2' }, onBehalfOfParameter: 'P2' } }
                ]
              }
            }]
          }
        }]
      }
    });

    manager._accountSwitcherTransport = async () => ({
      ok: true,
      status: 200,
      text: async () => mockMultiSelected
    });

    await assert.rejects(
      async () => {
        await manager.verifySessionWithAccountSwitcher('SAPISID=test_sapisid');
      },
      (err) => {
        assert.equal(err.code, 'AMBIGUOUS_ACCOUNT_SELECTION');
        assert.equal(err.status, 409);
        return true;
      }
    );

    // Case B: Multiple accounts, none selected
    const mockMultiNoneSelected = ")]}'\n" + JSON.stringify({
      code: 'SUCCESS',
      data: {
        contents: [{
          accountSectionListRenderer: {
            contents: [{
              accountItemSectionRenderer: {
                contents: [
                  { accountItem: { isSelected: false, accountName: { simpleText: 'Acc 1' }, onBehalfOfParameter: 'P1' } },
                  { accountItem: { isSelected: false, accountName: { simpleText: 'Acc 2' }, onBehalfOfParameter: 'P2' } }
                ]
              }
            }]
          }
        }]
      }
    });

    manager._accountSwitcherTransport = async () => ({
      ok: true,
      status: 200,
      text: async () => mockMultiNoneSelected
    });

    await assert.rejects(
      async () => {
        await manager.verifySessionWithAccountSwitcher('SAPISID=test_sapisid');
      },
      (err) => {
        assert.equal(err.code, 'AMBIGUOUS_ACCOUNT_SELECTION');
        assert.equal(err.status, 409);
        return true;
      }
    );

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('6. Missing Stable Identity: rejects when account lacks pageId (no fabricated hash ID)', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytm-test-'));
    const manager = new YtmAuthManager(tempDir);

    const mockNoPageId = ")]}'\n" + JSON.stringify({
      code: 'SUCCESS',
      data: {
        contents: [{
          accountSectionListRenderer: {
            contents: [{
              accountItemSectionRenderer: {
                contents: [
                  { accountItem: { isSelected: true, accountName: { simpleText: 'Nameless User' } } }
                ]
              }
            }]
          }
        }]
      }
    });

    manager._accountSwitcherTransport = async () => ({
      ok: true,
      status: 200,
      text: async () => mockNoPageId
    });

    await assert.rejects(
      async () => {
        await manager.verifySessionWithAccountSwitcher('SAPISID=test_sapisid');
      },
      (err) => {
        assert.equal(err.code, 'NO_ACCOUNT_RETURNED');
        assert.equal(err.stage, 'identity_validation');
        assert.equal(err.status, 502);
        return true;
      }
    );

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('7. Upstream HTTP 401/403 blocks Innertube fallback and preserves exact status', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytm-test-'));
    const manager = new YtmAuthManager(tempDir);

    manager._accountSwitcherTransport = async () => ({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized'
    });

    await assert.rejects(
      async () => {
        await manager.addAccountFromCookie('SAPISID=invalid_sapisid');
      },
      (err) => {
        assert.equal(err.code, 'ACCOUNT_SWITCHER_HTTP_REJECTED');
        assert.equal(err.upstreamStatus, 401);
        assert.equal(err.status, 401);
        assert.equal(err.fallbackError, undefined, 'Must not run Innertube fallback on 401');
        return true;
      }
    );

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('8. Bounded Stream Reader: throws UPSTREAM_PAYLOAD_TOO_LARGE when body exceeds byte limit', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytm-test-'));
    const manager = new YtmAuthManager(tempDir);

    // Synthetic large response exceeding 1 MB
    const hugeText = 'x'.repeat(1048576 + 50);
    const mockRes = {
      ok: true,
      status: 200,
      text: async () => hugeText
    };

    await assert.rejects(
      async () => {
        await manager._readBoundedStream(mockRes, 1048576);
      },
      (err) => {
        assert.equal(err.code, 'UPSTREAM_PAYLOAD_TOO_LARGE');
        return true;
      }
    );

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('9. End-to-End Integration: BrowserLoginService -> /api/ytm/intercept-cookie -> YtmAuthManager', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytm-test-'));
    const manager = new YtmAuthManager(tempDir);

    const mockResponsePayload = ")]}'\n" + JSON.stringify({
      code: 'SUCCESS',
      data: {
        contents: [{
          accountSectionListRenderer: {
            contents: [{
              accountItemSectionRenderer: {
                contents: [{
                  accountItem: {
                    accountName: { simpleText: 'Integrated User' },
                    channelHandle: { simpleText: '@integrated' },
                    accountPhoto: { thumbnails: [{ url: 'https://avatar' }] },
                    isSelected: true,
                    onBehalfOfParameter: 'PAGE_INTEGRATED_101'
                  }
                }]
              }
            }]
          }
        }]
      }
    });

    manager._accountSwitcherTransport = async (url, opts) => ({
      ok: true,
      status: 200,
      text: async () => mockResponsePayload
    });

    // Start a lightweight loopback server mimicking server.js /api/ytm/intercept-cookie
    const server = http.createServer(async (req, res) => {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body || '{}');
          const cookie = payload.cookie || '';
          const sapisidCredential = payload.sapisidCredential || null;
          const account = await manager.authenticateWithCookie(cookie, { sapisidCredential });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, account }));
        } catch (e) {
          const status = e.status || 502;
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, code: e.code, stage: e.stage, error: e.message }));
        }
      });
    });

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const service = new BrowserLoginService({ ytmAuthUrl: `http://127.0.0.1:${port}/api/ytm/intercept-cookie` });

    const records = [
      new BrowserCookieRecord({ name: 'SAPISID', value: 'secret_sapisid_token', domain: '.google.com', secure: true }),
      new BrowserCookieRecord({ name: 'VISITOR_INFO1_LIVE', value: 'vis_token', domain: '.youtube.com' })
    ];

    try {
      const authResult = await service.authenticateWithRecords(records);
      assert.ok(authResult.success);
      assert.equal(authResult.account.id, 'PAGE_INTEGRATED_101');
      assert.equal(authResult.account.name, 'Integrated User');
      assert.equal(authResult.account.handle, '@integrated');

      // Verify encrypted persistence and lack of plaintext leaks
      const encFile = path.join(tempDir, 'ytm-accounts.enc');
      assert.ok(fs.existsSync(encFile));
      const encRaw = fs.readFileSync(encFile, 'utf8');
      assert.ok(!encRaw.includes('secret_sapisid_token'), 'Must never leak raw credentials into persistence');
    } finally {
      server.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

});
