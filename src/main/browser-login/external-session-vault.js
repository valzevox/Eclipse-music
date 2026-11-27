'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VAULT_SCHEMA_VERSION = 1;

const VaultStatus = Object.freeze({
  OK: 'OK',
  EMPTY: 'EMPTY',
  UNSUPPORTED_STORAGE: 'UNSUPPORTED_STORAGE',
  CORRUPTED: 'CORRUPTED',
  IN_MEMORY_ONLY: 'IN_MEMORY_ONLY'
});

class ExternalSessionVault {
  constructor(options = {}) {
    this.vaultPath = typeof options.vaultPath === 'string' ? options.vaultPath : null;
    this.safeStorage = options.safeStorage || null;
    this.platform = options.platform || process.platform;
    this.allowInMemoryFallback = options.allowInMemoryFallback === true;
    this._memoryRecord = null;
  }

  checkStorageAvailability() {
    if (!this.safeStorage || typeof this.safeStorage.isEncryptionAvailable !== 'function') {
      return {
        available: false,
        reason: 'OS secure storage API is unavailable'
      };
    }

    let encryptedAvailable = false;
    try {
      encryptedAvailable = Boolean(this.safeStorage.isEncryptionAvailable());
    } catch (_) {
      encryptedAvailable = false;
    }

    if (!encryptedAvailable) {
      return {
        available: false,
        reason: 'OS credential encryption is not available'
      };
    }

    if (this.platform === 'linux') {
      if (typeof this.safeStorage.getSelectedStorageBackend === 'function') {
        const backend = this.safeStorage.getSelectedStorageBackend();
        if (backend === 'basic_text') {
          return {
            available: false,
            reason: 'Linux keyring backend is basic_text; refusing plaintext storage'
          };
        }
      }
    }

    if (typeof this.safeStorage.encryptString !== 'function' || typeof this.safeStorage.decryptString !== 'function') {
      return {
        available: false,
        reason: 'OS secure storage encrypt/decrypt methods are unavailable'
      };
    }

    return { available: true, reason: null };
  }

  save(sessionData) {
    if (!sessionData || typeof sessionData !== 'object') {
      throw new Error('Session data must be an object');
    }

    const availability = this.checkStorageAvailability();
    if (!availability.available) {
      if (this.allowInMemoryFallback) {
        this._memoryRecord = {
          schemaVersion: VAULT_SCHEMA_VERSION,
          updatedAt: Date.now(),
          data: { ...sessionData }
        };
        return {
          ok: true,
          status: VaultStatus.IN_MEMORY_ONLY,
          persisted: false,
          inMemoryOnly: true,
          storageWarning: availability.reason
        };
      }

      return {
        ok: false,
        status: VaultStatus.UNSUPPORTED_STORAGE,
        persisted: false,
        inMemoryOnly: false,
        storageWarning: availability.reason
      };
    }

    if (!this.vaultPath) {
      return {
        ok: false,
        status: VaultStatus.UNSUPPORTED_STORAGE,
        persisted: false,
        inMemoryOnly: false,
        storageWarning: 'Vault path is not configured'
      };
    }

    const plaintext = JSON.stringify(sessionData);
    const encryptedBuf = this.safeStorage.encryptString(plaintext);
    const envelope = {
      schemaVersion: VAULT_SCHEMA_VERSION,
      updatedAt: Date.now(),
      payload: Buffer.from(encryptedBuf).toString('base64')
    };

    const dir = path.dirname(this.vaultPath);
    fs.mkdirSync(dir, { recursive: true });

    const tmpPath = `${this.vaultPath}.tmp.${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
    const serialized = JSON.stringify(envelope);

    const fd = fs.openSync(tmpPath, 'w', 0o600);
    try {
      fs.writeFileSync(fd, serialized, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    fs.renameSync(tmpPath, this.vaultPath);
    this._memoryRecord = null;

    return {
      ok: true,
      status: VaultStatus.OK,
      persisted: true,
      inMemoryOnly: false,
      storageWarning: null
    };
  }

  load() {
    if (this._memoryRecord && this._memoryRecord.data) {
      return {
        ok: true,
        status: VaultStatus.IN_MEMORY_ONLY,
        persisted: false,
        data: { ...this._memoryRecord.data },
        storageWarning: 'Session is stored in memory only'
      };
    }

    if (!this.vaultPath || !fs.existsSync(this.vaultPath)) {
      return {
        ok: true,
        status: VaultStatus.EMPTY,
        persisted: false,
        data: null,
        storageWarning: null
      };
    }

    const availability = this.checkStorageAvailability();
    if (!availability.available) {
      return {
        ok: false,
        status: VaultStatus.UNSUPPORTED_STORAGE,
        persisted: false,
        data: null,
        storageWarning: availability.reason
      };
    }

    let raw;
    try {
      raw = fs.readFileSync(this.vaultPath, 'utf8');
    } catch (_) {
      const quarantinedPath = this._quarantineCorruptFile();
      return {
        ok: false,
        status: VaultStatus.CORRUPTED,
        persisted: false,
        data: null,
        quarantinedPath,
        storageWarning: 'Stored session could not be read and was quarantined'
      };
    }

    try {
      const envelope = JSON.parse(raw);
      if (
        !envelope ||
        typeof envelope !== 'object' ||
        envelope.schemaVersion !== VAULT_SCHEMA_VERSION ||
        typeof envelope.payload !== 'string' ||
        !envelope.payload
      ) {
        throw new Error('Invalid vault envelope');
      }

      const encryptedBuf = Buffer.from(envelope.payload, 'base64');
      const decrypted = this.safeStorage.decryptString(encryptedBuf);
      const parsed = JSON.parse(decrypted);
      if (!parsed || typeof parsed !== 'object') {
        throw new Error('Invalid decrypted session payload');
      }

      return {
        ok: true,
        status: VaultStatus.OK,
        persisted: true,
        data: parsed,
        storageWarning: null
      };
    } catch (_) {
      const quarantinedPath = this._quarantineCorruptFile();
      return {
        ok: false,
        status: VaultStatus.CORRUPTED,
        persisted: false,
        data: null,
        quarantinedPath,
        storageWarning: 'Stored session was corrupted and quarantined'
      };
    }
  }

  _quarantineCorruptFile() {
    if (!this.vaultPath || !fs.existsSync(this.vaultPath)) return null;
    const quarantinedPath = `${this.vaultPath}.corrupt.${Date.now()}`;
    try {
      fs.renameSync(this.vaultPath, quarantinedPath);
      return quarantinedPath;
    } catch (_) {
      try {
        fs.unlinkSync(this.vaultPath);
      } catch (_) {}
      return null;
    }
  }

  clear() {
    this._memoryRecord = null;
    if (this.vaultPath && fs.existsSync(this.vaultPath)) {
      try {
        fs.unlinkSync(this.vaultPath);
      } catch (_) {}
    }
    return { ok: true };
  }
}

module.exports = {
  ExternalSessionVault,
  VAULT_SCHEMA_VERSION,
  VaultStatus
};
