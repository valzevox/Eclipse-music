'use strict';

const crypto = require('crypto');
const { BrowserLoginTarget, resolveTargetHost } = require('./browser-login-targets');
const { discoverBrowserProfiles } = require('./browser-profile-discovery');
const {
  BrowserLoginFailure,
  BrowserLoginException,
  BrowserProfileStatus
} = require('./browser-login-errors');

const RepositoryStatus = Object.freeze({
  SCANNING: 'SCANNING',
  COOKIES_FOUND: BrowserProfileStatus.COOKIES_FOUND,
  NO_COOKIES: BrowserProfileStatus.NO_COOKIES,
  PERMISSION_REQUIRED: BrowserProfileStatus.PERMISSION_REQUIRED,
  UNREADABLE: BrowserProfileStatus.UNREADABLE,
  UNSUPPORTED: BrowserProfileStatus.UNSUPPORTED,
  IMPORTING: 'IMPORTING',
  VERIFYING: 'VERIFYING',
  CONNECTED: 'CONNECTED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED'
});

const ALLOWED_TARGETS = Object.freeze([
  BrowserLoginTarget.YOUTUBE,
  BrowserLoginTarget.EXTERNAL_WEB || 'EXTERNAL_WEB'
]);

const ALLOWED_TARGET_SET = new Set(ALLOWED_TARGETS);

function validateTarget(target) {
  if (typeof target !== 'string' || !ALLOWED_TARGET_SET.has(target)) {
    throw new BrowserLoginException(
      BrowserLoginFailure.INVALID_DATA,
      `Unsupported browser login target: ${String(target)}`
    );
  }
  if (typeof resolveTargetHost === 'function' && BrowserLoginTarget[target]) {
    resolveTargetHost(target);
  }
  return target;
}

function normalizeProfileStatus(status) {
  switch (status) {
    case RepositoryStatus.COOKIES_FOUND:
    case RepositoryStatus.NO_COOKIES:
    case RepositoryStatus.PERMISSION_REQUIRED:
    case RepositoryStatus.UNREADABLE:
    case RepositoryStatus.UNSUPPORTED:
      return status;
    default:
      return RepositoryStatus.UNSUPPORTED;
  }
}

function createOpaqueProfileId(discoveryEpoch, index) {
  const randomPart = crypto.randomBytes(12).toString('hex');
  return `prof_${discoveryEpoch}_${index}_${randomPart}`;
}

function createOperationId() {
  return `op_${crypto.randomBytes(12).toString('hex')}`;
}

class BrowserProfileRepository {
  constructor(options = {}) {
    this._discoverProfiles = typeof options.discoverProfiles === 'function'
      ? options.discoverProfiles
      : discoverBrowserProfiles;
    this._activeTarget = null;
    this._discoveryEpoch = 0;
    this._status = null;
    this._publicProfiles = [];
    this._internalProfiles = new Map();
    this._activeImport = null;
    this._lastImportResult = null;
  }

  getStatus() {
    return this._status;
  }

  getActiveTarget() {
    return this._activeTarget;
  }

  _invalidateForTargetSwitch(nextTarget) {
    if (this._activeTarget === nextTarget) {
      return;
    }
    this._activeTarget = nextTarget;
    this._discoveryEpoch += 1;
    this._publicProfiles = [];
    this._internalProfiles.clear();
    this._lastImportResult = null;

    if (this._activeImport) {
      this._activeImport.cancelled = true;
      try {
        this._activeImport.abortController.abort();
      } catch (_) {}
      this._activeImport = null;
      this._status = RepositoryStatus.CANCELLED;
    } else {
      this._status = null;
    }
  }

  profiles(target) {
    const validTarget = validateTarget(target);
    if (this._activeTarget !== validTarget) {
      this._invalidateForTargetSwitch(validTarget);
    }
    return this._publicProfiles.map((p) => ({ ...p }));
  }

  async refreshProfiles(target) {
    const validTarget = validateTarget(target);
    if (this._activeTarget !== validTarget) {
      this._invalidateForTargetSwitch(validTarget);
    }

    const epoch = ++this._discoveryEpoch;
    this._status = RepositoryStatus.SCANNING;

    const rawProfiles = await this._discoverProfiles(validTarget);

    // Discard stale discovery results if target switched or a newer refresh started
    if (this._activeTarget !== validTarget || this._discoveryEpoch !== epoch) {
      return [];
    }

    const nextPublic = [];
    const nextInternal = new Map();
    const list = Array.isArray(rawProfiles) ? rawProfiles : [];

    for (let i = 0; i < list.length; i += 1) {
      const raw = list[i];
      if (!raw || typeof raw !== 'object') continue;

      const profileId = createOpaqueProfileId(epoch, i);
      const status = normalizeProfileStatus(raw.status);

      const publicEntry = {
        profileId,
        target: validTarget,
        browser: String(raw.browser || 'Unknown'),
        type: String(raw.type || 'unknown'),
        profileName: String(raw.profileName || 'Default'),
        isDefault: Boolean(raw.isDefault),
        requiresExtension: Boolean(raw.requiresExtension),
        status
      };

      nextPublic.push(publicEntry);
      nextInternal.set(profileId, {
        ...raw,
        profileId,
        target: validTarget,
        status
      });
    }

    this._publicProfiles = nextPublic;
    this._internalProfiles = nextInternal;
    this._status = nextPublic.some((p) => p.status === RepositoryStatus.COOKIES_FOUND)
      ? RepositoryStatus.COOKIES_FOUND
      : RepositoryStatus.NO_COOKIES;

    return nextPublic.map((p) => ({ ...p }));
  }

  async importSelectedProfile(profileId, target, importerFn) {
    const validTarget = validateTarget(target);

    if (this._activeTarget !== validTarget) {
      this._invalidateForTargetSwitch(validTarget);
      this._status = RepositoryStatus.REJECTED;
      throw new BrowserLoginException(
        BrowserLoginFailure.INVALID_DATA,
        'Target changed; stale profile selection invalidated'
      );
    }

    if (this._activeImport) {
      throw new BrowserLoginException(
        BrowserLoginFailure.INVALID_DATA,
        'An import operation is already in progress'
      );
    }

    if (typeof profileId !== 'string' || !this._internalProfiles.has(profileId)) {
      this._status = RepositoryStatus.REJECTED;
      throw new BrowserLoginException(
        BrowserLoginFailure.INVALID_DATA,
        'Unknown or stale profileId'
      );
    }

    if (typeof importerFn !== 'function') {
      this._status = RepositoryStatus.REJECTED;
      throw new BrowserLoginException(
        BrowserLoginFailure.INVALID_DATA,
        'importerFn must be a function'
      );
    }

    const internalProfile = this._internalProfiles.get(profileId);
    const operationId = createOperationId();
    const abortController = new AbortController();
    const importState = {
      operationId,
      target: validTarget,
      profileId,
      cancelled: false,
      abortController
    };

    this._activeImport = importState;
    this._status = RepositoryStatus.IMPORTING;

    const setVerifying = () => {
      if (this._activeImport === importState && !importState.cancelled) {
        this._status = RepositoryStatus.VERIFYING;
      }
    };

    try {
      const result = await importerFn(
        { ...internalProfile },
        {
          operationId,
          target: validTarget,
          signal: abortController.signal,
          setVerifying
        }
      );

      if (importState.cancelled || this._activeTarget !== validTarget) {
        this._status = RepositoryStatus.CANCELLED;
        return {
          operationId,
          profileId,
          target: validTarget,
          status: RepositoryStatus.CANCELLED,
          connected: false
        };
      }

      this._status = RepositoryStatus.VERIFYING;

      if (!result || result.success === false) {
        this._status = RepositoryStatus.REJECTED;
        return {
          operationId,
          profileId,
          target: validTarget,
          status: RepositoryStatus.REJECTED,
          connected: false,
          error: (result && result.error) || 'Session verification rejected'
        };
      }

      this._status = RepositoryStatus.CONNECTED;
      const connectedResult = {
        operationId,
        profileId,
        target: validTarget,
        status: RepositoryStatus.CONNECTED,
        connected: true,
        account: result.account || null
      };
      this._lastImportResult = connectedResult;
      return connectedResult;
    } catch (err) {
      if (importState.cancelled || this._activeTarget !== validTarget) {
        this._status = RepositoryStatus.CANCELLED;
        return {
          operationId,
          profileId,
          target: validTarget,
          status: RepositoryStatus.CANCELLED,
          connected: false
        };
      }
      this._status = RepositoryStatus.REJECTED;
      throw err;
    } finally {
      if (this._activeImport === importState) {
        this._activeImport = null;
      }
    }
  }

  cancelImport(operationId) {
    if (!this._activeImport) {
      return false;
    }
    if (operationId && this._activeImport.operationId !== operationId) {
      return false;
    }
    this._activeImport.cancelled = true;
    try {
      this._activeImport.abortController.abort();
    } catch (_) {}
    this._activeImport = null;
    this._status = RepositoryStatus.CANCELLED;
    return true;
  }
}

module.exports = {
  BrowserProfileRepository,
  RepositoryStatus,
  ALLOWED_TARGETS,
  validateTarget
};
