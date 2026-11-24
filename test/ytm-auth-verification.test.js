'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { Readable } = require('stream');

const {
  BrowserCookieRecord,
  buildCookieHeader,
  extractSapisidCredential
} = require('../src/main/browser-login/browser-cookie-record');
const { WEB_REMIX_CLIENT } = require('../src/server/ytm-client-config');
const YtmAuthManager = require('../src/server/ytm-auth');
const { handleInterceptCookie, validateBackendSapisidCredential } = require('../src/server/server');
const { BrowserLoginService } = require('../src/main/browser-login/browser-login-service');

function createReadableStreamFromText(text, chunkSize = 1024) {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      const end = Math.min(offset + chunkSize, bytes.length);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    }
  });
}

describe('YTM Auth Verification & Production Diagnostics Suite', () => {

  it('1. Cookie Scope: Parent .youtube.com matches music.youtube.com, but www.youtube.com & wrong path rejected', () => {
    const cookies = [
      new BrowserCookieRecord({ name: 'SAPISID', value: 'sapisid_parent', domain: '.youtube.com', path: '/', secure: true }),
      new BrowserCookieRecord({ name: 'SAPISID', value: 'sapisid_sub_www', domain: 'www.youtube.com', path: '/', secure: true, hostOnly: true }),
      new BrowserCookieRecord({ name: 'SAPISID', value: 'sapisid_wrong_path', domain: 'music.youtube.com', path: '/watch', secure: true }),
      new BrowserCookieRecord({ name: 'SAPISID', value: 'sapisid_google', domain: '.google.com', path: '/', secure: true })
    ];

    // Priority 1: Parent .youtube.com matching music.youtube.com & /getAccountSwitcherEndpoint
    const cred = extractSapisidCredential(cookies, 'music.youtube.com', '/getAccountSwitcherEndpoint');
    assert.ok(cred);
    assert.equal(cred.value, 'sapisid_parent');
    assert.equal(cred.scope, 'youtube');

    // Filtered cookie header for music.youtube.com must NOT contain www.youtube.com or .google.com
    const header = buildCookieHeader(cookies, 'music.youtube.com', '/getAccountSwitcherEndpoint');
    assert.ok(header.includes('sapisid_parent'));
    assert.ok(!header.includes('sapisid_sub_www'));
    assert.ok(!header.includes('sapisid_google'));
    assert.ok(!header.includes('sapisid_wrong_path'));
  });

  it('2. Google-scoped Credential is treated as separate compatibility path and kept out of Cookie header', () => {
    const googleOnlyCookies = [
      new BrowserCookieRecord({ name: 'SAPISID', value: 'google_only_token', domain: '.google.com', path: '/', secure: true }),
      new BrowserCookieRecord({ name: 'VISITOR_INFO1_LIVE', value: 'vis_token', domain: '.youtube.com', path: '/' })
    ];

    const cred = extractSapisidCredential(googleOnlyCookies, 'music.youtube.com', '/getAccountSwitcherEndpoint');
    assert.ok(cred);
    assert.equal(cred.value, 'google_only_token');
    assert.equal(cred.scope, 'google');

    const header = buildCookieHeader(googleOnlyCookies, 'music.youtube.com', '/getAccountSwitcherEndpoint');
    assert.ok(!header.includes('google_only_token'), 'Must NEVER insert .google.com token into YouTube Cookie header');
    assert.ok(header.includes('vis_token'));
  });

  it('3. Upstream HTTP 400 JSON: extracts safe allowlisted diagnostics and attaches request fingerprint', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytm-test-'));
    const manager = new YtmAuthManager(tempDir);

    const mockErrorPayload = JSON.stringify({
      error: {
        code: 400,
        status: 'INVALID_ARGUMENT',
        message: 'Request payload invalid or origin not permitted',
        errors: [{ reason: 'badRequest', location: 'header' }]
      }
    });

    manager._accountSwitcherTransport = async () => ({
      ok: false,
      status: 400,
      headers: new Headers({ 'content-type': 'application/json; charset=utf-8' }),
      body: createReadableStreamFromText(mockErrorPayload)
    });

    const cookieStr = 'SAPISID=test_sapisid; VISITOR_INFO1_LIVE=xyz';
    await assert.rejects(
      async () => {
        await manager.verifySessionWithAccountSwitcher(cookieStr, { name: 'SAPISID', value: 'test_sapisid', domain: '.youtube.com', scope: 'youtube' });
      },
      (err) => {
        assert.equal(err.code, 'ACCOUNT_SWITCHER_HTTP_REJECTED');
        assert.equal(err.upstreamStatus, 400);
        assert.equal(err.status, 502);
        assert.ok(err.upstreamDiagnostic);
        assert.equal(err.upstreamDiagnostic.status, 'INVALID_ARGUMENT');
        assert.equal(err.upstreamDiagnostic.reasons[0].reason, 'badRequest');
        // Verify request fingerprint presence and absence of secret values
        assert.ok(err.requestFingerprint);
        assert.equal(err.requestFingerprint.selectedCredentialName, 'SAPISID');
        assert.equal(err.requestFingerprint.hasYouTubeSapisidInCookieHeader, true);
        assert.ok(!JSON.stringify(err.requestFingerprint).includes('test_sapisid'), 'Fingerprint must not leak values');
        return true;
      }
    );

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('4. Upstream HTTP 400 HTML: sanitizes response without exposing raw HTML body', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytm-test-'));
    const manager = new YtmAuthManager(tempDir);

    const rawHtml = '<!DOCTYPE html><html><body><h1>400 Bad Request</h1><p>Secret server traceback...</p></body></html>';

    manager._accountSwitcherTransport = async () => ({
      ok: false,
      status: 400,
      headers: new Headers({ 'content-type': 'text/html' }),
      body: createReadableStreamFromText(rawHtml)
    });

    await assert.rejects(
      async () => {
        await manager.verifySessionWithAccountSwitcher('SAPISID=test_val');
      },
      (err) => {
        assert.equal(err.upstreamStatus, 400);
        assert.ok(err.upstreamDiagnostic);
        assert.equal(err.upstreamDiagnostic.isHtml, true);
        assert.ok(!JSON.stringify(err.upstreamDiagnostic).includes('Secret server traceback'));
        return true;
      }
    );

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('5. Diagnostic Body exceeding 8 KB cancels stream and preserves upstream status', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytm-test-'));
    const manager = new YtmAuthManager(tempDir);

    let cancelled = false;
    const hugeBodyStream = new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(2048));
      },
      cancel() {
        cancelled = true;
      }
    });

    manager._accountSwitcherTransport = async () => ({
      ok: false,
      status: 400,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: hugeBodyStream
    });

    await assert.rejects(
      async () => {
        await manager.verifySessionWithAccountSwitcher('SAPISID=test_val');
      },
      (err) => {
        assert.equal(err.upstreamStatus, 400);
        assert.ok(err.diagnosticReadError.includes('8192 bytes'));
        assert.equal(cancelled, true, 'Stream must be cancelled immediately when exceeding 8 KB');
        return true;
      }
    );

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('6. Fallback Allowlist: Upstream HTTP 400 strictly disallows Innertube fallback', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytm-test-'));
    const manager = new YtmAuthManager(tempDir);

    manager._accountSwitcherTransport = async () => ({
      ok: false,
      status: 400,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: createReadableStreamFromText(JSON.stringify({ error: { message: 'Invalid request' } }))
    });

    await assert.rejects(
      async () => {
        await manager.addAccountFromCookie('SAPISID=test_val');
      },
      (err) => {
        assert.equal(err.code, 'ACCOUNT_SWITCHER_HTTP_REJECTED');
        assert.equal(err.upstreamStatus, 400);
        assert.equal(err.fallbackError, undefined, 'Must NEVER trigger Innertube fallback on upstream 400');
        return true;
      }
    );

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('7. Backend Credential Re-validation: rejects invalid domain, insecure or expired credential with INVALID_CREDENTIAL', () => {
    assert.equal(validateBackendSapisidCredential(null), null);
    assert.equal(validateBackendSapisidCredential({ name: 'OTHER', value: '123' }), null);
    assert.equal(validateBackendSapisidCredential({ name: 'SAPISID', value: '123', domain: 'evil.com', secure: true }), null);
    assert.equal(validateBackendSapisidCredential({ name: 'SAPISID', value: '123', domain: '.youtube.com', secure: false }), null);
    assert.equal(validateBackendSapisidCredential({ name: 'SAPISID', value: '123', domain: '.youtube.com', secure: true, expiry: 1000 }), null);

    const valid = validateBackendSapisidCredential({
      name: 'SAPISID',
      value: 'secret_123',
      domain: '.youtube.com',
      path: '/getAccountSwitcherEndpoint',
      secure: true,
      expiry: Math.floor(Date.now() / 1000) + 3600
    });
    assert.ok(valid);
    assert.equal(valid.name, 'SAPISID');
    assert.equal(valid.scope, 'youtube');
  });

  it('8. Production Route Integration: BrowserLoginService -> production handleInterceptCookie -> YtmAuthManager', async () => {
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
                    accountName: { simpleText: 'Production Verified User' },
                    channelHandle: { simpleText: '@produser' },
                    accountPhoto: { thumbnails: [{ url: 'https://avatar.url' }] },
                    isSelected: true,
                    serviceEndpoint: {
                      selectActiveIdentityEndpoint: {
                        supportedTokens: [
                          { pageIdToken: { pageId: 'PAGE_PROD_999' } },
                          { accountSigninToken: { signinUrl: 'https://music.youtube.com?authuser=1' } }
                        ]
                      }
                    }
                  }
                }]
              }
            }]
          }
        }]
      }
    });

    manager._accountSwitcherTransport = async (url, opts) => {
      assert.ok(url.includes('/getAccountSwitcherEndpoint?prettyPrint=false'));
      assert.equal(opts.headers['Content-Type'], 'application/json');
      assert.equal(opts.headers['X-Goog-Api-Format-Version'], '1');
      assert.equal(opts.headers['X-YouTube-Client-Name'], '1');
      assert.equal(opts.headers['X-Goog-AuthUser'], '0');
      assert.equal(opts.headers['User-Agent'], WEB_REMIX_CLIENT.defaultUserAgent);
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        body: createReadableStreamFromText(mockResponsePayload)
      };
    };

    // Test the real handleInterceptCookie exported from server.js
    const server = http.createServer(async (req, res) => {
      if (req.url === '/api/ytm/intercept-cookie') {
        return handleInterceptCookie(req, res, { ytmAuth: manager });
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const service = new BrowserLoginService({ ytmAuthUrl: `http://127.0.0.1:${port}/api/ytm/intercept-cookie` });

    const records = [
      new BrowserCookieRecord({ name: 'SAPISID', value: 'secret_prod_sapisid', domain: '.youtube.com', secure: true }),
      new BrowserCookieRecord({ name: 'VISITOR_INFO1_LIVE', value: 'vis_token_prod', domain: '.youtube.com' })
    ];

    try {
      const authResult = await service.authenticateWithRecords(records);
      assert.ok(authResult.success);
      assert.equal(authResult.account.id, 'PAGE_PROD_999');
      assert.equal(authResult.account.name, 'Production Verified User');
      assert.equal(authResult.account.handle, '@produser');

      // Verify persistence is encrypted with zero leaks
      const encFile = path.join(tempDir, 'ytm-accounts.enc');
      assert.ok(fs.existsSync(encFile));
      const encRaw = fs.readFileSync(encFile, 'utf8');
      assert.ok(!encRaw.includes('secret_prod_sapisid'));

      // Verify second manager instance decrypts successfully
      const manager2 = new YtmAuthManager(tempDir);
      await manager2.init();
      const accounts = manager2.getAccounts();
      assert.equal(accounts.length, 1);
      assert.equal(accounts[0].id, 'PAGE_PROD_999');
    } finally {
      server.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

});
