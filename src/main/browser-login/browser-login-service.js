'use strict';

const { BrowserLoginTarget, resolveTargetHost } = require('./browser-login-targets');
const { discoverBrowserProfiles } = require('./browser-profile-discovery');
const { readGeckoCookies } = require('./browser-cookie-reader');
const { BrowserPairingServer } = require('./browser-pairing-server');
const { buildCookieHeader, buildNetscapeJar, extractSapisidCredential } = require('./browser-cookie-record');
const { BrowserLoginFailure, BrowserLoginException } = require('./browser-login-errors');

class BrowserLoginService {
  constructor({ ytmAuthUrl }) {
    this.ytmAuthUrl = ytmAuthUrl || 'http://127.0.0.1:38472/api/ytm/intercept-cookie';
    this.activePairingServer = null;
  }

  async getProfiles(target = BrowserLoginTarget.YOUTUBE) {
    resolveTargetHost(target);
    return await discoverBrowserProfiles();
  }

  startPairingSession(onSuccess, onError) {
    if (this.activePairingServer) {
      this.activePairingServer.close();
    }

    this.activePairingServer = new BrowserPairingServer({
      onCookiesReceived: async (cookieRecords) => {
        try {
          const authResult = await this.authenticateWithRecords(cookieRecords);
          if (typeof onSuccess === 'function') onSuccess(authResult);
          return authResult;
        } catch (err) {
          if (typeof onError === 'function') onError(err);
          throw err;
        }
      }
    });

    return this.activePairingServer.start();
  }

  cancelPairingSession() {
    if (this.activePairingServer) {
      this.activePairingServer.close(BrowserLoginFailure.PAIRING_CANCELLED);
      this.activePairingServer = null;
    }
  }

  async importFromGeckoProfile(profilePath) {
    const records = await readGeckoCookies(profilePath);
    return await this.authenticateWithRecords(records);
  }

  async authenticateWithRecords(cookieRecords) {
    const targetHost = resolveTargetHost(BrowserLoginTarget.YOUTUBE);
    const cookieHeader = buildCookieHeader(cookieRecords, targetHost);
    const netscapeJar = buildNetscapeJar(cookieRecords, targetHost);
    const sapisidCredential = extractSapisidCredential(cookieRecords);

    if (!sapisidCredential && (!cookieHeader || (!cookieHeader.includes('SAPISID') && !cookieHeader.includes('LOGIN_INFO')))) {
      throw new BrowserLoginException(BrowserLoginFailure.NO_YOUTUBE_COOKIES, 'No valid YouTube Music login cookies found in payload');
    }

    // Call backend InnerTube verifier
    let res;
    try {
      res = await fetch(this.ytmAuthUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cookie: cookieHeader, netscapeJar, sapisidCredential }),
        signal: AbortSignal.timeout(20000)
      });
    } catch (err) {
      throw new BrowserLoginException(BrowserLoginFailure.SESSION_REJECTED, `Network error contacting YTM backend: ${err.message}`);
    }

    // Read the response body exactly once
    let responseText = '';
    try {
      responseText = await res.text();
    } catch (readErr) {
      throw new BrowserLoginException(BrowserLoginFailure.SESSION_REJECTED, `Failed to read YTM verification response: ${readErr.message}`);
    }

    let data = null;
    try {
      data = JSON.parse(responseText);
    } catch (_) {
      data = { error: responseText };
    }

    if (!res.ok) {
      const code = data?.code || 'HTTP_' + res.status;
      const stage = data?.stage ? ` [stage: ${data.stage}]` : '';
      const safeError = data?.error ? String(data.error).replace(/(?:SAPISID|__Secure-3PAPISID|SID|SSID)=[^;\s]+/gi, '[REDACTED]') : `HTTP ${res.status}`;
      throw new BrowserLoginException(
        BrowserLoginFailure.SESSION_REJECTED,
        `YTM verification rejected (${code}${stage}): ${safeError}`
      );
    }

    if (!data || !data.success || !data.account) {
      throw new BrowserLoginException(
        BrowserLoginFailure.ACCOUNT_PROFILE_UNAVAILABLE,
        (data && data.error) || 'Could not verify YouTube Music account profile'
      );
    }

    return {
      success: true,
      account: {
        id: data.account.id,
        name: data.account.name || 'YouTube User',
        handle: data.account.handle || '',
        avatarUrl: data.account.avatarUrl || ''
      }
    };
  }
}

module.exports = {
  BrowserLoginService
};
