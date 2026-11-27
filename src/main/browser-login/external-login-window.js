'use strict';

const crypto = require('crypto');
const { BrowserLoginFailure, BrowserLoginException } = require('./browser-login-errors');
const {
  EXTERNAL_TARGET_HOST,
  validateExternalSessionCookies
} = require('./external-cookie-validator');

const EXTERNAL_LOGIN_URL = `https://${EXTERNAL_TARGET_HOST}/`;
const GOOGLE_DISALLOWED_UA_MESSAGE =
  'Open in Chrome/Edge and connect using Eclipse Connect, or use Official OAuth PKCE in your system browser';

const ALLOWED_AUTH_HOSTS = new Set([
  EXTERNAL_TARGET_HOST,
  'accounts.spotify.com',
  'login.spotify.com',
  'accounts.google.com',
  'appleid.apple.com',
  'www.facebook.com',
  'm.facebook.com'
]);

function isAllowedNavigationUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl) return false;
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (_) {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  if (ALLOWED_AUTH_HOSTS.has(host)) return true;
  if (host.endsWith('.spotify.com')) return true;
  return false;
}

function isDestinationLandingUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl) return false;
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'https:' && parsed.hostname.toLowerCase() === EXTERNAL_TARGET_HOST;
  } catch (_) {
    return false;
  }
}

function hasDisallowedUserAgentSignal(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl) return false;
  return /disallowed_useragent/i.test(rawUrl);
}

class ExternalLoginWindow {
  constructor(options = {}) {
    this.electron = options.electron || require('electron');
    this.parentWindow = options.parentWindow || null;
    this.loginUrl = options.loginUrl || EXTERNAL_LOGIN_URL;
    this.timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : 300000;
    this.partition = `temp-ext-login-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;

    this._window = null;
    this._session = null;
    this._timer = null;
    this._settled = false;
    this._resolve = null;
    this._reject = null;
    this._beforeQuitHandler = null;
    this._checkingCookies = false;
  }

  isActive() {
    return Boolean(this._window && !this._window.isDestroyed() && !this._settled);
  }

  open() {
    if (this._window) {
      return Promise.reject(new Error('Login window is already open'));
    }

    const { BrowserWindow, session, app } = this.electron;
    if (!BrowserWindow || !session) {
      return Promise.reject(new Error('Electron BrowserWindow/session unavailable'));
    }

    return new Promise((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;

      const ses = session.fromPartition(this.partition, { cache: false });
      this._session = ses;

      const win = new BrowserWindow({
        width: 520,
        height: 720,
        show: true,
        modal: false,
        parent: this.parentWindow && !this.parentWindow.isDestroyed() ? this.parentWindow : undefined,
        autoHideMenuBar: true,
        title: 'Eclipse — External Account Sign In',
        webPreferences: {
          partition: this.partition,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
          allowRunningInsecureContent: false
        }
      });
      this._window = win;

      const wc = win.webContents;

      wc.setWindowOpenHandler(() => ({ action: 'deny' }));

      wc.on('will-navigate', (event, targetUrl) => {
        if (hasDisallowedUserAgentSignal(targetUrl)) {
          event.preventDefault();
          this._fail(this._createDisallowedUaError());
          return;
        }
        if (!isAllowedNavigationUrl(targetUrl)) {
          event.preventDefault();
        }
      });

      wc.on('will-redirect', (event, targetUrl) => {
        if (hasDisallowedUserAgentSignal(targetUrl)) {
          event.preventDefault();
          this._fail(this._createDisallowedUaError());
          return;
        }
        if (!isAllowedNavigationUrl(targetUrl)) {
          event.preventDefault();
        }
      });

      const handleLandingCheck = async (targetUrl) => {
        if (this._settled) return;
        if (hasDisallowedUserAgentSignal(targetUrl)) {
          this._fail(this._createDisallowedUaError());
          return;
        }
        if (isDestinationLandingUrl(targetUrl)) {
          await this._tryExtractAndResolve();
        }
      };

      wc.on('did-navigate', (_event, targetUrl) => {
        handleLandingCheck(targetUrl).catch(() => {});
      });

      wc.on('did-redirect-navigation', (_event, targetUrl) => {
        handleLandingCheck(targetUrl).catch(() => {});
      });

      wc.on('did-finish-load', async () => {
        if (this._settled || win.isDestroyed()) return;
        const currentUrl = wc.getURL();
        if (hasDisallowedUserAgentSignal(currentUrl)) {
          this._fail(this._createDisallowedUaError());
          return;
        }
        try {
          const parsed = new URL(currentUrl);
          if (parsed.hostname.toLowerCase() === 'accounts.google.com') {
            const hasDisallowed = await wc.executeJavaScript(
              'Boolean(document.body && /disallowed_useragent/i.test(document.body.innerText || ""))',
              true
            ).catch(() => false);
            if (hasDisallowed) {
              this._fail(this._createDisallowedUaError());
              return;
            }
          }
        } catch (_) {}

        if (isDestinationLandingUrl(currentUrl)) {
          await this._tryExtractAndResolve();
        }
      });

      win.on('closed', () => {
        if (!this._settled) {
          const err = new BrowserLoginException(
            BrowserLoginFailure.PAIRING_CANCELLED,
            'Login window closed by user'
          );
          err.code = 'LOGIN_WINDOW_CLOSED';
          this._fail(err);
        }
      });

      if (app && typeof app.on === 'function') {
        this._beforeQuitHandler = () => {
          this.cancel('APP_EXIT');
        };
        app.on('before-quit', this._beforeQuitHandler);
      }

      this._timer = setTimeout(() => {
        const err = new BrowserLoginException(
          BrowserLoginFailure.PAIRING_EXPIRED,
          'Login window timed out'
        );
        err.code = 'LOGIN_WINDOW_TIMEOUT';
        this._fail(err);
      }, this.timeoutMs);

      win.loadURL(this.loginUrl).catch((err) => {
        if (!this._settled) {
          this._fail(err || new Error('Failed to load external login page'));
        }
      });
    });
  }

  cancel(reason = 'LOGIN_WINDOW_CANCELLED') {
    if (this._settled) return;
    const err = new BrowserLoginException(
      BrowserLoginFailure.PAIRING_CANCELLED,
      'External login window cancelled'
    );
    err.code = reason;
    this._fail(err);
  }

  _createDisallowedUaError() {
    const err = new BrowserLoginException(
      BrowserLoginFailure.SESSION_REJECTED,
      GOOGLE_DISALLOWED_UA_MESSAGE
    );
    err.code = 'DISALLOWED_USERAGENT';
    return err;
  }

  async _tryExtractAndResolve() {
    if (this._settled || this._checkingCookies || !this._session) return;
    this._checkingCookies = true;
    try {
      const cookies = await this._session.cookies.get({ url: `https://${EXTERNAL_TARGET_HOST}` });
      if (!Array.isArray(cookies) || cookies.length === 0) return;

      let validated;
      try {
        validated = validateExternalSessionCookies(cookies);
      } catch (_) {
        return;
      }

      if (validated && !this._settled) {
        this._succeed({
          cookies: [validated],
          validatedCookie: validated
        });
      }
    } finally {
      this._checkingCookies = false;
    }
  }

  _succeed(result) {
    if (this._settled) return;
    this._settled = true;
    const resolve = this._resolve;
    this._cleanup();
    if (resolve) resolve(result);
  }

  _fail(err) {
    if (this._settled) return;
    this._settled = true;
    const reject = this._reject;
    this._cleanup();
    if (reject) reject(err);
  }

  _cleanup() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }

    const { app } = this.electron || {};
    if (app && this._beforeQuitHandler && typeof app.removeListener === 'function') {
      app.removeListener('before-quit', this._beforeQuitHandler);
      this._beforeQuitHandler = null;
    }

    const win = this._window;
    this._window = null;
    if (win && !win.isDestroyed()) {
      try {
        win.destroy();
      } catch (_) {}
    }

    const ses = this._session;
    this._session = null;
    if (ses) {
      try {
        if (typeof ses.clearStorageData === 'function') {
          ses.clearStorageData().catch(() => {});
        }
        if (typeof ses.clearCache === 'function') {
          ses.clearCache().catch(() => {});
        }
      } catch (_) {}
    }

    this._resolve = null;
    this._reject = null;
  }
}

module.exports = {
  ExternalLoginWindow,
  EXTERNAL_LOGIN_URL,
  GOOGLE_DISALLOWED_UA_MESSAGE,
  isAllowedNavigationUrl,
  isDestinationLandingUrl,
  hasDisallowedUserAgentSignal
};
