'use strict';

const { BrowserLoginTarget } = require('./browser-login-targets');
const { BrowserPairingServer } = require('./browser-pairing-server');
const { BrowserProfileRepository } = require('./browser-profile-repository');
const { BrowserLoginFailure } = require('./browser-login-errors');
const { ExternalPkceAuth } = require('./external-pkce-auth');
const { ExternalSessionVerifier, ExternalSessionStatus } = require('./external-session-verifier');
const { ExternalSessionVault, VaultStatus } = require('./external-session-vault');
const { ExternalLoginWindow } = require('./external-login-window');

function createDefaultState() {
  return {
    connected: false,
    displayName: null,
    avatarUrl: null,
    connectionMethod: null,
    authType: null,
    lastVerifiedAt: null,
    sessionStatus: ExternalSessionStatus.SIGNED_OUT,
    webSessionStatus: null,
    persisted: false,
    storageWarning: null
  };
}

class ExternalSessionService {
  constructor(options = {}) {
    this.isPackaged = Boolean(options.isPackaged);
    this.allowedExtensionIds = Array.isArray(options.allowedExtensionIds) ? options.allowedExtensionIds : [];
    this.onStateChange = typeof options.onStateChange === 'function' ? options.onStateChange : null;

    this.pkceAuth = options.pkceAuth || new ExternalPkceAuth({
      clientId: options.clientId || '',
      openExternal: options.openExternal,
      fetchImpl: options.fetchImpl
    });

    this.verifier = options.verifier || new ExternalSessionVerifier({
      fetchImpl: options.fetchImpl
    });

    this.vault = options.vault || new ExternalSessionVault({
      vaultPath: options.vaultPath,
      safeStorage: options.safeStorage,
      allowInMemoryFallback: options.allowInMemoryFallback === true
    });

    this.profileRepository = options.profileRepository || new BrowserProfileRepository();
    this.loginWindowFactory = typeof options.loginWindowFactory === 'function' ? options.loginWindowFactory : null;
    this.activePairingServer = null;
    this.activeLoginWindow = null;
    this._generation = 0;
    this._state = createDefaultState();
    this._credentials = null;
  }

  getStatus() {
    return { ...this._state };
  }

  _setState(nextState) {
    this._state = {
      connected: Boolean(nextState.connected),
      displayName: nextState.displayName || null,
      avatarUrl: nextState.avatarUrl || null,
      connectionMethod: nextState.connectionMethod || null,
      authType: nextState.authType || null,
      lastVerifiedAt: Number.isFinite(nextState.lastVerifiedAt) ? nextState.lastVerifiedAt : null,
      sessionStatus: nextState.sessionStatus || ExternalSessionStatus.SIGNED_OUT,
      webSessionStatus: nextState.webSessionStatus || null,
      persisted: Boolean(nextState.persisted),
      storageWarning: nextState.storageWarning || null
    };
    if (this.onStateChange) {
      try {
        this.onStateChange(this.getStatus());
      } catch (_) {}
    }
    return this.getStatus();
  }

  async initialize() {
    const gen = ++this._generation;
    const loaded = this.vault.load();

    if (gen !== this._generation) {
      return this.getStatus();
    }

    if (!loaded.ok) {
      const status = loaded.status === VaultStatus.UNSUPPORTED_STORAGE
        ? ExternalSessionStatus.UNSUPPORTED_STORAGE
        : ExternalSessionStatus.SIGNED_OUT;
      return this._setState({
        ...createDefaultState(),
        sessionStatus: status,
        storageWarning: loaded.storageWarning || null
      });
    }

    if (!loaded.data || loaded.data.authType !== 'pkce') {
      if (loaded.data && loaded.data.authType !== 'pkce') {
        this.vault.clear();
      }
      return this._setState(createDefaultState());
    }

    this._credentials = loaded.data;
    return await this._verifyAndApply(loaded.data, {
      generation: gen,
      connectionMethod: loaded.data.connectionMethod || null,
      persisted: loaded.persisted,
      storageWarning: loaded.storageWarning || null
    });
  }

  async startPkceLogin(options = {}) {
    const gen = ++this._generation;
    this.cancelPairingSession();
    this.cancelLoginWindow();

    const tokenData = await this.pkceAuth.authenticate(options);
    if (gen !== this._generation) {
      return this.getStatus();
    }

    const credentials = {
      authType: 'pkce',
      connectionMethod: 'pkce',
      accessToken: tokenData.accessToken,
      refreshToken: tokenData.refreshToken,
      expiresAt: tokenData.expiresAt
    };

    return await this._commitVerifiedSession(credentials, gen);
  }

  async startPairingSession(options = {}) {
    const gen = ++this._generation;
    this.cancelPairingSession();
    this.cancelLoginWindow();

    const server = new BrowserPairingServer({
      target: BrowserLoginTarget.EXTERNAL_WEB,
      isPackaged: this.isPackaged,
      allowedExtensionIds: this.allowedExtensionIds,
      timeoutMs: options.timeoutMs || 120000,
      onCookiesReceived: async (cookieRecords) => {
        if (gen !== this._generation) {
          throw new Error('Pairing session superseded');
        }
        const status = await this.importFromCookies(cookieRecords, 'extension_pairing', gen);
        if (!status.connected && status.webSessionStatus !== 'spotify_web_session_unverified') {
          const err = new Error(status.sessionStatus || BrowserLoginFailure.SESSION_REJECTED);
          err.reason = status.sessionStatus || BrowserLoginFailure.SESSION_REJECTED;
          throw err;
        }
        return {
          account: status,
          webSessionUnverified: status.webSessionStatus === 'spotify_web_session_unverified'
        };
      }
    });

    this.activePairingServer = server;
    return await server.start();
  }

  async openLoginWindow(options = {}) {
    const gen = ++this._generation;
    this.cancelPairingSession();
    this.cancelLoginWindow();

    const loginWindow = this.loginWindowFactory
      ? this.loginWindowFactory(options)
      : new ExternalLoginWindow(options);
    this.activeLoginWindow = loginWindow;

    let result;
    try {
      result = await loginWindow.open();
    } finally {
      if (this.activeLoginWindow === loginWindow) {
        this.activeLoginWindow = null;
      }
    }

    if (gen !== this._generation) {
      return this.getStatus();
    }

    const credentials = {
      authType: 'cookie',
      connectionMethod: 'login_window',
      cookies: result && Array.isArray(result.cookies) ? result.cookies : []
    };

    return await this._commitVerifiedSession(credentials, gen);
  }

  cancelLoginWindow(reason = 'LOGIN_WINDOW_CANCELLED') {
    if (this.activeLoginWindow) {
      try {
        this.activeLoginWindow.cancel(reason);
      } catch (_) {}
      this.activeLoginWindow = null;
    }
  }

  cancelPairingSession() {
    if (this.activePairingServer) {
      this.activePairingServer.close(BrowserLoginFailure.PAIRING_CANCELLED);
      this.activePairingServer = null;
    }
  }

  cancelActiveAuth() {
    this._generation += 1;
    this.cancelPairingSession();
    this.cancelLoginWindow();
    if (this.pkceAuth && typeof this.pkceAuth.cancel === 'function') {
      this.pkceAuth.cancel('PKCE_CANCELLED');
    }
    return this.getStatus();
  }

  async importFromCookies(cookieRecords, connectionMethod = 'extension_pairing', expectedGen = null) {
    const gen = expectedGen !== null ? expectedGen : ++this._generation;
    const credentials = {
      authType: 'cookie',
      connectionMethod,
      cookies: Array.isArray(cookieRecords) ? cookieRecords : []
    };
    return await this._commitVerifiedSession(credentials, gen);
  }

  async verifyCurrentSession() {
    const gen = ++this._generation;
    if (!this._credentials) {
      return this._setState(createDefaultState());
    }
    return await this._verifyAndApply(this._credentials, {
      generation: gen,
      connectionMethod: this._credentials.connectionMethod || this._state.connectionMethod,
      persisted: this._state.persisted,
      storageWarning: this._state.storageWarning
    });
  }

  async _commitVerifiedSession(credentials, gen) {
    const verification = await this.verifier.verify(credentials);
    if (gen !== this._generation) {
      return this.getStatus();
    }

    if (credentials.authType !== 'pkce') {
      if (verification.status === ExternalSessionStatus.UNVERIFIED_WEB_SESSION) {
        return this._setState({
          ...this._state,
          connected: Boolean(this._state.connected && this._state.authType === 'pkce'),
          webSessionStatus: 'spotify_web_session_unverified',
          sessionStatus: this._state.connected && this._state.authType === 'pkce'
            ? this._state.sessionStatus
            : ExternalSessionStatus.UNVERIFIED_WEB_SESSION
        });
      }
      return this._setState({
        ...createDefaultState(),
        connectionMethod: credentials.connectionMethod || null,
        authType: credentials.authType || null,
        sessionStatus: verification.status
      });
    }

    if (verification.status !== ExternalSessionStatus.VALID) {
      if (verification.status === ExternalSessionStatus.NETWORK_UNAVAILABLE && this._credentials) {
        return this._setState({
          ...this._state,
          sessionStatus: ExternalSessionStatus.NETWORK_UNAVAILABLE
        });
      }
      return this._setState({
        ...createDefaultState(),
        connectionMethod: credentials.connectionMethod || null,
        authType: credentials.authType || null,
        sessionStatus: verification.status
      });
    }

    const saveResult = this.vault.save(credentials);
    if (gen !== this._generation) {
      return this.getStatus();
    }

    if (!saveResult.ok) {
      this._credentials = null;
      return this._setState({
        ...createDefaultState(),
        connectionMethod: credentials.connectionMethod || null,
        authType: credentials.authType || null,
        sessionStatus: ExternalSessionStatus.UNSUPPORTED_STORAGE,
        persisted: false,
        storageWarning: saveResult.storageWarning || 'Secure storage unavailable'
      });
    }

    this._credentials = credentials;
    return this._setState({
      connected: true,
      displayName: verification.displayName,
      avatarUrl: verification.avatarUrl,
      connectionMethod: credentials.connectionMethod || null,
      authType: credentials.authType || null,
      lastVerifiedAt: Date.now(),
      sessionStatus: ExternalSessionStatus.VALID,
      persisted: saveResult.persisted,
      storageWarning: saveResult.storageWarning || null
    });
  }

  async _verifyAndApply(credentials, { generation, connectionMethod, persisted, storageWarning }) {
    let verification = await this.verifier.verify(credentials);
    if (generation !== this._generation) {
      return this.getStatus();
    }

    if (
      verification.status === ExternalSessionStatus.EXPIRED &&
      credentials.authType === 'pkce' &&
      credentials.refreshToken &&
      typeof this.pkceAuth.refreshAccessToken === 'function'
    ) {
      try {
        const refreshed = await this.pkceAuth.refreshAccessToken({
          refreshToken: credentials.refreshToken
        });
        if (generation !== this._generation) {
          return this.getStatus();
        }
        const updatedCreds = {
          ...credentials,
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken,
          expiresAt: refreshed.expiresAt
        };
        return await this._commitVerifiedSession(updatedCreds, generation);
      } catch (err) {
        if (generation !== this._generation) {
          return this.getStatus();
        }
        if (err && err.code === 'NETWORK_UNAVAILABLE') {
          verification = { status: ExternalSessionStatus.NETWORK_UNAVAILABLE };
        }
      }
    }

    if (verification.status === ExternalSessionStatus.NETWORK_UNAVAILABLE) {
      return this._setState({
        ...this._state,
        connected: Boolean(this._state.connected || this._credentials),
        connectionMethod: connectionMethod || this._state.connectionMethod,
        authType: credentials.authType || this._state.authType,
        sessionStatus: ExternalSessionStatus.NETWORK_UNAVAILABLE,
        persisted: Boolean(persisted),
        storageWarning: storageWarning || null
      });
    }

    if (verification.status !== ExternalSessionStatus.VALID) {
      this._credentials = null;
      this.vault.clear();
      return this._setState({
        ...createDefaultState(),
        connectionMethod: connectionMethod || null,
        authType: credentials.authType || null,
        sessionStatus: verification.status,
        storageWarning: storageWarning || null
      });
    }

    return this._setState({
      connected: true,
      displayName: verification.displayName,
      avatarUrl: verification.avatarUrl,
      connectionMethod: connectionMethod || null,
      authType: credentials.authType || null,
      lastVerifiedAt: Date.now(),
      sessionStatus: ExternalSessionStatus.VALID,
      persisted: Boolean(persisted),
      storageWarning: storageWarning || null
    });
  }

  async getProfiles() {
    return await this.profileRepository.refreshProfiles(BrowserLoginTarget.EXTERNAL_WEB);
  }

  logout() {
    this._generation += 1;
    this.cancelPairingSession();
    this.cancelLoginWindow('LOGIN_WINDOW_LOGOUT');
    if (this.pkceAuth && typeof this.pkceAuth.cancel === 'function') {
      this.pkceAuth.cancel('PKCE_LOGOUT');
    }
    this._credentials = null;
    this.vault.clear();
    return this._setState(createDefaultState());
  }
}

module.exports = {
  ExternalSessionService,
  ExternalSessionStatus
};
