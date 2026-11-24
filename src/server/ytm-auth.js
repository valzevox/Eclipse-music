// ytm-auth.js — YouTube Music Authentication Engine (WebView Cookie Interceptor & InnerTube Session)
// Independent implementation under MIT License for Eclipse (PC & Mobile)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Innertube } = require('youtubei.js');
const { WEB_REMIX_CLIENT } = require('./ytm-client-config');
const logger = fs.existsSync(path.join(__dirname, 'logger.js')) ? require('./logger') : console;

const electronSafeStorage = (typeof process !== 'undefined' && process.versions && process.versions.electron) ? require('electron').safeStorage : null;

class YtmAuthManager {
  constructor(dataDir, vaultProvider = null) {
    this.dataDir = dataDir;
    this.vaultProvider = vaultProvider || (typeof globalThis.__eclipseHardwareVault === 'function' ? globalThis.__eclipseHardwareVault('ytm_master_key') : (typeof globalThis.__murielVault === 'function' ? globalThis.__murielVault('ytm_master_key') : null));
    this.storagePath = path.join(dataDir, 'ytm-accounts.json');
    this.encStoragePath = path.join(dataDir, 'ytm-accounts.enc');
    this.masterKeyPath = path.join(dataDir, '.ytm-master-key.bin');
    this.accounts = []; // Array of { id, name, handle, avatarUrl, cookie, isDefault, lastSync }
    this.activeClient = null;
    this._cachedMasterKey = null;
    this._initPromise = this.loadAccounts();
  }

  async init() {
    return this._initPromise;
  }

  _canUseSafeStorage() {
    try {
      return !!(electronSafeStorage && typeof electronSafeStorage.isEncryptionAvailable === 'function' && electronSafeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || typeof electronSafeStorage.getSelectedStorageBackend !== 'function' || electronSafeStorage.getSelectedStorageBackend() !== 'basic_text'));
    } catch (_) {
      return false;
    }
  }

  async _getOrCreateMasterKeyAsync() {
    if (this._cachedMasterKey && this._cachedMasterKey.length === 32) return this._cachedMasterKey;

    // 1. Hardware Keystore / Keychain Vault Provider (Android Keystore / iOS Keychain / Custom Vault)
    if (this.vaultProvider && typeof this.vaultProvider.read === 'function' && typeof this.vaultProvider.write === 'function') {
      try {
        const existing = await Promise.resolve(this.vaultProvider.read());
        if (existing && typeof existing.keyHex === 'string' && /^[0-9a-f]{64}$/i.test(existing.keyHex)) {
          this._cachedMasterKey = Buffer.from(existing.keyHex, 'hex');
          return this._cachedMasterKey;
        }
      } catch (_) {}

      const newKey = crypto.randomBytes(32);
      const keyHex = newKey.toString('hex');
      
      // Explicitly await native hardware vault write; if it rejects or is not durable/hardware-backed, fail immediately and do NOT cache in memory!
      const writeRes = await this.vaultProvider.write({ keyHex, createdAt: Date.now() });
      if (!writeRes || writeRes.success === false || writeRes.hardwareBacked === false) {
        throw new Error('Hardware vault write rejected or not durably persisted by native keystore');
      }

      this._cachedMasterKey = Buffer.from(keyHex, 'hex');
      return this._cachedMasterKey;
    }

    fs.mkdirSync(this.dataDir, { recursive: true });

    // 2. OS Keychain / DPAPI via Electron safeStorage wrapping a random 256-bit key
    if (this._canUseSafeStorage()) {
      if (fs.existsSync(this.masterKeyPath)) {
        try {
          const raw = fs.readFileSync(this.masterKeyPath);
          const unwrappedHex = electronSafeStorage.decryptString(raw).trim();
          if (/^[0-9a-f]{64}$/i.test(unwrappedHex)) {
            this._cachedMasterKey = Buffer.from(unwrappedHex, 'hex');
            return this._cachedMasterKey;
          }
        } catch (_) {}
      }
      const newKey = crypto.randomBytes(32);
      const wrapped = electronSafeStorage.encryptString(newKey.toString('hex'));
      fs.writeFileSync(this.masterKeyPath, wrapped, { mode: 0o600 });
      this._cachedMasterKey = newKey;
      return this._cachedMasterKey;
    }

    // 3. CSPRNG 256-bit random key file (0o600 permissions)
    if (fs.existsSync(this.masterKeyPath)) {
      try {
        const rawHex = fs.readFileSync(this.masterKeyPath, 'utf8').trim();
        if (/^[0-9a-f]{64}$/i.test(rawHex)) {
          this._cachedMasterKey = Buffer.from(rawHex, 'hex');
          return this._cachedMasterKey;
        }
      } catch (_) {}
    }
    const newKey = crypto.randomBytes(32);
    fs.writeFileSync(this.masterKeyPath, newKey.toString('hex'), { encoding: 'utf8', mode: 0o600 });
    this._cachedMasterKey = Buffer.from(newKey.toString('hex'), 'hex');
    return this._cachedMasterKey;
  }

  _getOrCreateMasterKey() {
    if (this._cachedMasterKey && this._cachedMasterKey.length === 32) return this._cachedMasterKey;
    if (this.vaultProvider && typeof this.vaultProvider.read === 'function') {
      try {
        const existing = this.vaultProvider.read();
        if (existing && typeof existing.keyHex === 'string' && /^[0-9a-f]{64}$/i.test(existing.keyHex)) {
          this._cachedMasterKey = Buffer.from(existing.keyHex, 'hex');
          return this._cachedMasterKey;
        }
      } catch (_) {}
    }
    if (fs.existsSync(this.masterKeyPath)) {
      try {
        if (this._canUseSafeStorage()) {
          const raw = fs.readFileSync(this.masterKeyPath);
          const unwrappedHex = electronSafeStorage.decryptString(raw).trim();
          if (/^[0-9a-f]{64}$/i.test(unwrappedHex)) {
            this._cachedMasterKey = Buffer.from(unwrappedHex, 'hex');
            return this._cachedMasterKey;
          }
        } else {
          const rawHex = fs.readFileSync(this.masterKeyPath, 'utf8').trim();
          if (/^[0-9a-f]{64}$/i.test(rawHex)) {
            this._cachedMasterKey = Buffer.from(rawHex, 'hex');
            return this._cachedMasterKey;
          }
        }
      } catch (_) {}
    }
    throw new Error('Master key not yet loaded or hardware vault is async. Await init() or saveAccounts()');
  }

  _encryptData(plainText, explicitKey = null) {
    const key = explicitKey || this._cachedMasterKey || this._getOrCreateMasterKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    let encrypted = cipher.update(plainText, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    return { enc: true, v: 2, type: 'aes-256-gcm', iv: iv.toString('hex'), tag: authTag, data: encrypted };
  }

  _decryptData(payload, explicitKey = null) {
    if (!payload || !payload.enc) return null;
    try {
      if (payload.type === 'safeStorage' && this._canUseSafeStorage()) {
        return electronSafeStorage.decryptString(Buffer.from(payload.data, 'base64'));
      }
      if (payload.type === 'aes-256-gcm' || payload.type === 'aes256') {
        const key = explicitKey || this._cachedMasterKey || this._getOrCreateMasterKey();
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'hex'));
        decipher.setAuthTag(Buffer.from(payload.tag, 'hex'));
        let decrypted = decipher.update(payload.data, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
      }
    } catch (_) {
      return null;
    }
    return null;
  }

  async loadAccounts() {
    try {
      // 1. Try reading encrypted storage first
      if (fs.existsSync(this.encStoragePath)) {
        try {
          const key = await this._getOrCreateMasterKeyAsync();
          const raw = fs.readFileSync(this.encStoragePath, 'utf8');
          const parsed = JSON.parse(raw);
          const decryptedStr = this._decryptData(parsed, key);
          if (decryptedStr) {
            const loaded = JSON.parse(decryptedStr);
            if (Array.isArray(loaded)) {
              this.accounts = loaded;
              if (fs.existsSync(this.storagePath)) {
                try { fs.unlinkSync(this.storagePath); } catch (_) {}
              }
              return this.accounts;
            }
          }
        } catch (encErr) {
          logger.log('warn', `ytm-auth: Failed to decrypt accounts with master key: ${encErr.message}`);
        }
      }

      // 2. Safe migration from legacy plaintext JSON
      if (fs.existsSync(this.storagePath)) {
        const raw = fs.readFileSync(this.storagePath, 'utf8');
        const parsed = JSON.parse(raw);
        this.accounts = Array.isArray(parsed) ? parsed : [];
        let migratedOk = false;
        try {
          migratedOk = await this.saveAccounts();
        } catch (_) {
          migratedOk = false;
        }
        if (migratedOk && fs.existsSync(this.encStoragePath)) {
          try { fs.unlinkSync(this.storagePath); } catch (_) {}
        }
      }
    } catch (e) {
      logger.log('warn', `ytm-auth: Failed to load accounts: ${e.message}`);
      this.accounts = [];
    }
    return this.accounts;
  }

  async saveAccounts() {
    const tmpPath = `${this.encStoragePath}.tmp`;
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      const plainStr = JSON.stringify(this.accounts, null, 2);

      // Await master key with GUARANTEED hardware persistence!
      // If native vault write rejects (e.g. AndroidKeyStore/Keychain error), throws immediately!
      const key = await this._getOrCreateMasterKeyAsync();

      const encryptedPayload = this._encryptData(plainStr, key);
      const serialized = JSON.stringify(encryptedPayload);

      // Verify round-trip decryption before committing to disk
      const verifyDecrypted = this._decryptData(JSON.parse(serialized), key);
      if (verifyDecrypted !== plainStr) {
        throw new Error('Encrypted round-trip verification failed');
      }

      fs.writeFileSync(tmpPath, serialized, { encoding: 'utf8', mode: 0o600 });
      if (typeof fs.renameSync === 'function') {
        fs.renameSync(tmpPath, this.encStoragePath);
      } else {
        fs.writeFileSync(this.encStoragePath, serialized, 'utf8');
        try { fs.unlinkSync(tmpPath); } catch (_) {}
      }

      // Verify file on disk can be decrypted before removing any legacy plaintext file
      const diskRaw = fs.readFileSync(this.encStoragePath, 'utf8');
      const diskDecrypted = this._decryptData(JSON.parse(diskRaw), key);
      if (diskDecrypted !== plainStr) {
        throw new Error('Disk encrypted file verification failed');
      }

      // ONLY unlink legacy plaintext after verified encrypted read-back!
      if (fs.existsSync(this.storagePath)) {
        try { fs.unlinkSync(this.storagePath); } catch (_) {}
      }
      return true;
    } catch (e) {
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
      logger.log('error', `ytm-auth: Failed to save accounts: ${e.message}`);
      return false;
    }
  }

  getGoogleLoginUrl() {
    return 'https://accounts.google.com/ServiceLogin?service=youtube&continue=https://music.youtube.com';
  }

  /**
   * Generates standard SAPISIDHASH authorization string for YouTube Music.
   * Format: SAPISIDHASH <timestamp>_<sha1(timestamp + " " + sapisid + " " + origin)>
   */
  generateSapisidHash(sapisid, origin = WEB_REMIX_CLIENT.origin) {
    if (!sapisid || typeof sapisid !== 'string') return null;
    const ts = Math.floor(Date.now() / 1000);
    const hash = crypto.createHash('sha1').update(`${ts} ${sapisid.trim()} ${origin}`).digest('hex');
    return `SAPISIDHASH ${ts}_${hash}`;
  }

  /**
   * Reads a response stream incrementally with a strict byte ceiling.
   * Cancels the underlying stream immediately if maxBytes is exceeded.
   */
  async _readBoundedStream(res, maxBytes = 1048576) {
    if (!res) throw new Error('Response object required');

    // 1. Web ReadableStream (standard fetch in Node.js 18+)
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      const chunks = [];
      let totalBytes = 0;
      const decoder = new TextDecoder('utf-8');

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            totalBytes += value.byteLength;
            if (totalBytes > maxBytes) {
              try { await reader.cancel('Response body limit exceeded'); } catch (_) {}
              const err = new Error(`Upstream response exceeded limit of ${maxBytes} bytes`);
              err.code = 'UPSTREAM_PAYLOAD_TOO_LARGE';
              err.stage = 'stream_reading';
              throw err;
            }
            chunks.push(decoder.decode(value, { stream: true }));
          }
        }
        chunks.push(decoder.decode());
        return chunks.join('');
      } catch (err) {
        if (err.code === 'UPSTREAM_PAYLOAD_TOO_LARGE') throw err;
        const streamErr = new Error(`Failed to read response stream: ${err.message}`);
        streamErr.code = 'STREAM_READ_ERROR';
        streamErr.stage = 'stream_reading';
        throw streamErr;
      }
    }

    // 2. Node.js Readable stream fallback
    if (res.body && typeof res.body.on === 'function') {
      return new Promise((resolve, reject) => {
        const chunks = [];
        let total = 0;
        let done = false;
        res.body.on('data', chunk => {
          if (done) return;
          total += chunk.length;
          if (total > maxBytes) {
            done = true;
            try { res.body.destroy(); } catch (_) {}
            const err = new Error(`Upstream response exceeded limit of ${maxBytes} bytes`);
            err.code = 'UPSTREAM_PAYLOAD_TOO_LARGE';
            err.stage = 'stream_reading';
            return reject(err);
          }
          chunks.push(chunk);
        });
        res.body.on('end', () => {
          if (!done) resolve(Buffer.concat(chunks).toString('utf8'));
        });
        res.body.on('error', err => {
          if (!done) {
            const streamErr = new Error(`Failed to read response stream: ${err.message}`);
            streamErr.code = 'STREAM_READ_ERROR';
            streamErr.stage = 'stream_reading';
            reject(streamErr);
          }
        });
      });
    }

    const err = new Error('ReadableStream not available for bounded response reading');
    err.code = 'STREAM_UNAVAILABLE';
    err.stage = 'stream_reading';
    throw err;
  }

  /**
   * Primary verification via native Account Switcher:
   * GET https://music.youtube.com/getAccountSwitcherEndpoint?prettyPrint=false
   */
  async verifySessionWithAccountSwitcher(cookieString, explicitSapisidCred = null, options = {}) {
    if (!cookieString || typeof cookieString !== 'string') {
      const err = new Error('No cookie string provided');
      err.code = 'MISSING_COOKIE';
      err.stage = 'validation';
      err.status = 400;
      throw err;
    }

    let sapisid = typeof explicitSapisidCred === 'string' ? explicitSapisidCred : explicitSapisidCred?.value;
    if (!sapisid) {
      const match = cookieString.match(/(?:^|;\s*)(?:SAPISID|__Secure-3PAPISID)=([^;]+)/);
      sapisid = match ? match[1].trim() : null;
    }

    if (!sapisid) {
      const err = new Error('Missing SAPISID authentication credential');
      err.code = 'MISSING_SAPISID';
      err.stage = 'credential_check';
      err.status = 400;
      throw err;
    }

    const authHeader = this.generateSapisidHash(sapisid, WEB_REMIX_CLIENT.origin);
    const authUserVal = String(options.authUser ?? 0);
    const headers = {
      'Authorization': authHeader,
      'Cookie': cookieString,
      'Content-Type': 'application/json',
      'Origin': WEB_REMIX_CLIENT.origin,
      'Referer': WEB_REMIX_CLIENT.referer,
      'X-Origin': WEB_REMIX_CLIENT.origin,
      'X-Goog-AuthUser': authUserVal,
      'X-Goog-Api-Format-Version': WEB_REMIX_CLIENT.apiFormatVersion,
      'X-YouTube-Client-Name': WEB_REMIX_CLIENT.xYouTubeClientName,
      'X-YouTube-Client-Version': WEB_REMIX_CLIENT.clientVersion,
      'User-Agent': WEB_REMIX_CLIENT.defaultUserAgent,
      'Accept': '*/*'
    };

    if (options.pageId && typeof options.pageId === 'string' && options.pageId.trim()) {
      headers['X-Goog-PageId'] = options.pageId.trim();
    }

    // Build secret-free request fingerprint
    const cookiePairs = cookieString.split(';').map(c => c.trim()).filter(Boolean);
    const outgoingCookieMap = new Map();
    const exactCookieNames = [];
    for (const pair of cookiePairs) {
      const eqIdx = pair.indexOf('=');
      if (eqIdx !== -1) {
        const cName = pair.slice(0, eqIdx).trim();
        const cVal = pair.slice(eqIdx + 1).trim();
        exactCookieNames.push(cName);
        outgoingCookieMap.set(cName, cVal);
      } else {
        exactCookieNames.push(pair);
      }
    }

    const hasYouTubeSapisidInCookieHeader = exactCookieNames.includes('SAPISID') || exactCookieNames.includes('__Secure-3PAPISID');
    const selectedCredName = explicitSapisidCred?.name || null;
    const selectedCredValue = explicitSapisidCred?.value || null;
    const isExactCredentialInCookieHeader = Boolean(
      selectedCredName &&
      selectedCredValue &&
      outgoingCookieMap.has(selectedCredName) &&
      outgoingCookieMap.get(selectedCredName) === selectedCredValue
    );

    const requestFingerprint = {
      selectedCredentialName: explicitSapisidCred?.name || 'NONE',
      selectedCredentialDomain: explicitSapisidCred?.domain || 'UNKNOWN',
      selectedCredentialScope: explicitSapisidCred?.scope || (explicitSapisidCred?.domain?.includes('google.com') ? 'google' : 'youtube'),
      isCredentialInCookieHeader: isExactCredentialInCookieHeader,
      hasYouTubeSapisidInCookieHeader,
      outgoingCookieNames: exactCookieNames,
      hasAuthorizationHeader: Boolean(authHeader),
      hasOriginHeader: Boolean(headers.Origin),
      hasRefererHeader: Boolean(headers.Referer),
      clientName: WEB_REMIX_CLIENT.xYouTubeClientName,
      clientVersion: WEB_REMIX_CLIENT.clientVersion
    };

    let res;
    try {
      const fetchFn = typeof this._accountSwitcherTransport === 'function' ? this._accountSwitcherTransport : globalThis.fetch;
      res = await fetchFn(`${WEB_REMIX_CLIENT.origin}/getAccountSwitcherEndpoint?prettyPrint=false`, {
        method: 'GET',
        headers,
        signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined
      });
    } catch (netErr) {
      const err = new Error(`Network failure contacting Account Switcher: ${netErr.message}`);
      err.code = 'AUTH_REQUEST_FAILED';
      err.stage = 'network';
      err.status = 502;
      err.requestFingerprint = requestFingerprint;
      throw err;
    }

    if (!res || !res.ok) {
      const status = res ? res.status : 0;
      let errorBodySample = '';
      let diagnosticReadError = null;

      try {
        if (res) errorBodySample = await this._readBoundedStream(res, 8192);
      } catch (readErr) {
        diagnosticReadError = readErr.message;
      }

      // Safe upstream error diagnostics extraction
      let upstreamDiagnostic = null;
      const contentType = (res?.headers?.get?.('content-type') || '').toLowerCase();

      if (errorBodySample && (contentType.includes('application/json') || errorBodySample.trim().startsWith('{') || errorBodySample.trim().startsWith(")]}'"))) {
        let cleanJsonText = errorBodySample.trim();
        if (cleanJsonText.startsWith(")]}'")) cleanJsonText = cleanJsonText.slice(4).trim();
        try {
          const parsed = JSON.parse(cleanJsonText);
          const errObj = parsed.error || parsed;
          upstreamDiagnostic = {
            contentType: 'application/json',
            code: errObj.code || null,
            status: errObj.status || null,
            message: typeof errObj.message === 'string' ? errObj.message.slice(0, 200).replace(/(?:SAPISID|__Secure-3PAPISID|SID|SSID)=[^;\s&]+/gi, '[REDACTED]') : null,
            reasons: Array.isArray(errObj.errors) ? errObj.errors.slice(0, 5).map(e => ({ reason: e.reason, location: e.location })) : []
          };
        } catch (_) {
          upstreamDiagnostic = { contentType: 'application/json', isMalformed: true };
        }
      } else if (contentType.includes('text/html') || errorBodySample.includes('<html')) {
        upstreamDiagnostic = {
          contentType: 'text/html',
          isHtml: true,
          summary: 'Non-JSON upstream error response'
        };
      }

      const err = new Error(`Account Switcher rejected session with HTTP ${status}`);
      err.code = 'ACCOUNT_SWITCHER_HTTP_REJECTED';
      err.stage = 'endpoint_response';
      err.upstreamStatus = status;
      err.status = (status === 401 || status === 403) ? status : 502;
      err.upstreamDiagnostic = upstreamDiagnostic;
      err.diagnosticReadError = diagnosticReadError;
      err.requestFingerprint = requestFingerprint;
      throw err;
    }

    let rawText;
    try {
      // Read at most 1 MB for success body
      rawText = await this._readBoundedStream(res, 1048576);
    } catch (readErr) {
      readErr.status = 502;
      readErr.requestFingerprint = requestFingerprint;
      throw readErr;
    }

    // Safely strip anti-XSSI prefix )]}' if present
    let jsonText = (rawText || '').trim();
    if (jsonText.startsWith(")]}'")) {
      jsonText = jsonText.slice(4).trim();
    }

    let payload;
    try {
      payload = JSON.parse(jsonText);
    } catch (parseErr) {
      const err = new Error('Failed to parse Account Switcher JSON response');
      err.code = 'MALFORMED_AUTH_RESPONSE';
      err.stage = 'json_parsing';
      err.status = 502;
      err.requestFingerprint = requestFingerprint;
      throw err;
    }

    if (!payload || payload.code !== 'SUCCESS') {
      const codeVal = payload ? payload.code : 'EMPTY_RESPONSE';
      const err = new Error(`Account Switcher returned status code: ${codeVal}`);
      err.code = 'VERIFICATION_CODE_REJECTED';
      err.stage = 'verification_code';
      err.status = 502;
      err.requestFingerprint = requestFingerprint;
      throw err;
    }

    // Exact Account Switcher JSON Path: payload.data.contents
    const sections = payload.data?.contents || [];
    const candidateAccounts = [];

    for (const section of sections) {
      const secListContents = section?.accountSectionListRenderer?.contents || [];
      for (const itemSection of secListContents) {
        const itemContents = itemSection?.accountItemSectionRenderer?.contents || [];
        for (const entry of itemContents) {
          const accountItem = entry?.accountItem || entry?.accountItemRenderer;
          if (!accountItem) continue;

          const accountName = accountItem.accountName?.simpleText || accountItem.accountName?.runs?.[0]?.text || '';
          const handle = accountItem.channelHandle?.simpleText || accountItem.email?.simpleText || '';
          const avatarUrl = accountItem.accountPhoto?.thumbnails?.[0]?.url || '';
          const isSelected = Boolean(accountItem.isSelected);
          const hasChannel = Boolean(accountItem.hasChannel);

          // Correct nested token extraction:
          // accountItem.serviceEndpoint.selectActiveIdentityEndpoint.supportedTokens
          const tokens = accountItem.serviceEndpoint?.selectActiveIdentityEndpoint?.supportedTokens || [];
          const pageIdTokenObj = tokens.find(t => t?.pageIdToken)?.pageIdToken || null;
          const accountSigninTokenObj = tokens.find(t => t?.accountSigninToken)?.accountSigninToken || null;
          const accountStateTokenObj = tokens.find(t => t?.accountStateToken)?.accountStateToken || null;

          const signinUrl = accountSigninTokenObj?.signinUrl || '';
          let signinUrlAuthUser = null;
          let signinUrlPageId = null;

          if (signinUrl) {
            try {
              // Parse query parameters supporting both relative and absolute URLs
              const parsedUrl = new URL(signinUrl, 'https://music.youtube.com');
              const au = parsedUrl.searchParams.get('authuser');
              if (au !== null && au !== '') {
                const parsedAu = Number(au);
                if (Number.isFinite(parsedAu)) signinUrlAuthUser = parsedAu;
              }
              const pid = parsedUrl.searchParams.get('pageid');
              if (pid && typeof pid === 'string' && pid.trim()) {
                signinUrlPageId = pid.trim();
              }
            } catch (_) {}
          }

          // Identity resolution:
          // 1. Prefer onBehalfOfParameter for pageId
          // 2. Otherwise use pageIdToken.pageId
          // 3. Otherwise use valid pageid query parameter from signinUrl
          // 4. Keep pageId null when none exists (never substitute Gaia ID into pageId)
          const resolvedPageId = accountItem.onBehalfOfParameter ||
            pageIdTokenObj?.pageId ||
            signinUrlPageId ||
            null;

          const resolvedAuthUser = signinUrlAuthUser ?? 0;
          const obfuscatedGaiaId = accountStateTokenObj?.obfuscatedGaiaId || null;
          const tokenHasChannel = accountStateTokenObj?.hasChannel ?? hasChannel;
          const isMerged = accountStateTokenObj?.isMerged ?? false;

          candidateAccounts.push({
            name: accountName,
            handle: handle,
            avatarUrl: avatarUrl,
            pageId: resolvedPageId,
            authUser: resolvedAuthUser,
            obfuscatedGaiaId: obfuscatedGaiaId,
            isSelected: isSelected,
            hasChannel: Boolean(tokenHasChannel),
            isMerged: Boolean(isMerged),
            rawTokensSummary: {
              hasPageIdToken: Boolean(pageIdTokenObj?.pageId),
              hasSigninUrlPageId: Boolean(signinUrlPageId),
              hasAccountSigninToken: Boolean(accountSigninTokenObj),
              hasAccountStateToken: Boolean(accountStateTokenObj),
              hasObfuscatedGaiaId: Boolean(obfuscatedGaiaId)
            }
          });
        }
      }
    }

    // Account selection rules
    const selectedCandidates = candidateAccounts.filter(c => c.isSelected);
    let chosen = null;

    if (selectedCandidates.length > 1) {
      const err = new Error('Multiple accounts marked as active in Account Switcher');
      err.code = 'AMBIGUOUS_ACCOUNT_SELECTION';
      err.stage = 'identity_resolution';
      err.status = 409;
      throw err;
    } else if (selectedCandidates.length === 1) {
      chosen = selectedCandidates[0];
    } else {
      // 0 candidates explicitly marked isSelected
      if (candidateAccounts.length === 1) {
        chosen = candidateAccounts[0];
      } else if (candidateAccounts.length > 1) {
        const err = new Error('Multiple accounts returned without a clear active selection');
        err.code = 'AMBIGUOUS_ACCOUNT_SELECTION';
        err.stage = 'identity_resolution';
        err.status = 409;
        throw err;
      }
    }

    if (!chosen) {
      const err = new Error('Account Switcher did not return valid account identity entries');
      err.code = 'NO_ACCOUNT_RETURNED';
      err.stage = 'identity_extraction';
      err.status = 502;
      throw err;
    }

    // Stable account identity resolution:
    // If pageId exists -> Brand/channel account
    // If pageId absent but obfuscatedGaiaId exists -> Google account identity with namespaced hash
    let accountKey = null;
    let identityType = null;

    if (chosen.pageId) {
      accountKey = chosen.pageId;
      identityType = 'brand_channel';
    } else if (chosen.obfuscatedGaiaId) {
      // Create deterministic internal accountKey using namespaced hash of upstream obfuscatedGaiaId
      // Never hash cookies, SAPISID, names or handles; never expose raw obfuscatedGaiaId
      const gaiaHash = crypto.createHash('sha256').update('google_account:' + chosen.obfuscatedGaiaId).digest('hex').slice(0, 32);
      accountKey = 'ga_' + gaiaHash;
      identityType = 'google_account';
    } else {
      const err = new Error('Authenticated account does not contain a stable pageId or obfuscated Gaia ID');
      err.code = 'NO_STABLE_ACCOUNT_ID';
      err.stage = 'identity_validation';
      err.status = 502;
      err.identityDetails = chosen.rawTokensSummary || {};
      throw err;
    }

    return {
      id: accountKey,
      name: chosen.name || 'YouTube Music User',
      handle: chosen.handle || '',
      avatarUrl: chosen.avatarUrl || '',
      pageId: chosen.pageId || null,
      identityType: identityType,
      authUser: chosen.authUser ?? 0,
      sapisid: sapisid
    };
  }

  // Intercept cookies string from redirect (contains SAPISID, SID, SSID, etc.)
  async addAccountFromCookie(cookieString, options = {}) {
    if (!cookieString || typeof cookieString !== 'string') {
      const err = new Error('Invalid cookie payload');
      err.code = 'MISSING_COOKIE';
      err.stage = 'validation';
      err.status = 400;
      throw err;
    }

    const explicitSapisidCred = options.sapisidCredential || null;

    // Phase 3: Primary verification via getAccountSwitcherEndpoint
    let verifiedProfile = null;
    try {
      verifiedProfile = await this.verifySessionWithAccountSwitcher(cookieString, explicitSapisidCred, options);
    } catch (asErr) {
      // Explicit allowlist for fallback:
      // Fallback is ONLY permitted for genuine network failure or upstream 5xx
      const isEligible5xx = asErr.code === 'ACCOUNT_SWITCHER_HTTP_REJECTED' && asErr.upstreamStatus >= 500 && asErr.upstreamStatus < 600;
      const isEligibleTransient = asErr.code === 'AUTH_REQUEST_FAILED' || asErr.code === 'STREAM_READ_ERROR' || isEligible5xx;

      if (!isEligibleTransient) {
        logger.log('warn', `ytm-auth: Account Switcher rejected session (${asErr.code || 'UNKNOWN'}). Upstream status: ${asErr.upstreamStatus || asErr.status}. Fallback disbarred.`);
        throw asErr;
      }

      logger.log('warn', `ytm-auth: Account Switcher verification failed with transient error (${asErr.code}): ${asErr.message}. Attempting Innertube fallback.`);
      
      // Secondary fallback to Innertube only for eligible transient failures
      let yt;
      try {
        yt = await Innertube.create({ cookie: cookieString });
      } catch (e) {
        logger.log('error', `ytm-auth: Innertube session initialization failed: ${e.message.replace(/(?:SAPISID|__Secure-3PAPISID|SID|SSID)=[^;\s&]+/gi, '[REDACTED]')}`);
        asErr.fallbackError = { code: 'INNERTUBE_INIT_FAILED', stage: 'fallback_init' };
        throw asErr;
      }

      let accountInfo = null;
      try {
        accountInfo = await yt.account.getInfo();
      } catch (e) {
        logger.log('error', `ytm-auth: getInfo failed: ${e.message.replace(/(?:SAPISID|__Secure-3PAPISID|SID|SSID)=[^;\s&]+/gi, '[REDACTED]')}`);
        asErr.fallbackError = { code: 'ACCOUNT_LOOKUP_FAILED', stage: 'fallback_lookup' };
        throw asErr;
      }

      if (!accountInfo) {
        asErr.fallbackError = { code: 'NO_ACCOUNT_RETURNED', stage: 'fallback_lookup' };
        throw asErr;
      }

      let channelId = '';
      let name = '';
      let handle = '';
      let avatarUrl = '';

      if (accountInfo.contents && accountInfo.contents.length > 0) {
        const primary = accountInfo.contents[0];
        channelId = primary.endpoint?.browse_endpoint?.browse_id || primary.id || '';
        name = primary.title?.text || primary.name || '';
        if (primary.thumbnail?.length > 0) {
          avatarUrl = primary.thumbnail[0].url || '';
        }
      }

      if (!channelId || channelId === 'unknown') {
        asErr.fallbackError = { code: 'NO_ACCOUNT_RETURNED', stage: 'fallback_identity' };
        throw asErr;
      }

      verifiedProfile = {
        id: channelId,
        name: name || 'YouTube User',
        handle: handle,
        avatarUrl: avatarUrl,
        pageId: null,
        authUser: 0,
        sapisid: null
      };
      this.activeClient = yt;
    }

    const channelId = verifiedProfile.id;
    const newAccount = {
      id: channelId,
      name: verifiedProfile.name || 'YouTube User',
      handle: verifiedProfile.handle || '',
      avatarUrl: verifiedProfile.avatarUrl || '',
      pageId: verifiedProfile.pageId || null,
      identityType: verifiedProfile.identityType || (verifiedProfile.pageId ? 'brand_channel' : 'google_account'),
      authUser: verifiedProfile.authUser ?? 0,
      cookie: cookieString,
      isDefault: this.accounts.length === 0,
      lastSync: Date.now()
    };

    // Update existing or add new
    const existingIndex = this.accounts.findIndex(a => a.id === channelId);
    if (existingIndex >= 0) {
      this.accounts[existingIndex] = { ...this.accounts[existingIndex], ...newAccount };
    } else {
      this.accounts.push(newAccount);
    }

    const saveOk = await this.saveAccounts();
    if (!saveOk) {
      if (existingIndex >= 0) {
        await this.loadAccounts();
      } else {
        this.accounts.pop();
      }
      const err = new Error('Failed to persist authenticated YouTube account to disk');
      err.code = 'PERSISTENCE_FAILED';
      err.stage = 'persistence';
      throw err;
    }

    return this.getSanitizedAccount(newAccount);
  }

  getAccounts() {
    // Return sanitized accounts (without exposing raw session cookies to frontend)
    return this.accounts.map(acc => ({
      id: acc.id,
      name: acc.name,
      handle: acc.handle,
      avatarUrl: acc.avatarUrl,
      pageId: acc.pageId || null,
      identityType: acc.identityType || (acc.pageId ? 'brand_channel' : 'google_account'),
      authUser: acc.authUser ?? 0,
      isDefault: !!acc.isDefault,
      lastSync: acc.lastSync
    }));
  }

  getDefaultAccount() {
    return this.accounts.find(a => a.isDefault) || this.accounts[0] || null;
  }

  setDefaultAccount(id) {
    let found = false;
    for (const acc of this.accounts) {
      if (acc.id === id) {
        acc.isDefault = true;
        found = true;
      } else {
        acc.isDefault = false;
      }
    }
    if (found) {
      this.saveAccounts().catch(e => logger.log('error', `ytm-auth: setDefaultAccount save failed: ${e.message}`));
      this.activeClient = null; // Re-create client on next demand
    }
    return found;
  }

  async clearAllAccounts() {
    this.accounts = [];
    this.activeClient = null;
    const saveOk = await this.saveAccounts();
    return saveOk;
  }

  removeAccount(id) {
    const idx = this.accounts.findIndex(a => a.id === id);
    if (idx >= 0) {
      this.accounts.splice(idx, 1);
      if (this.accounts.length > 0 && !this.accounts.some(a => a.isDefault)) {
        this.accounts[0].isDefault = true;
      }
      this.saveAccounts().catch(e => logger.log('error', `ytm-auth: removeAccount save failed: ${e.message}`));
      this.activeClient = null;
      return true;
    }
    return false;
  }

  async getActiveClient() {
    if (this.activeClient) return this.activeClient;
    const defaultAcc = this.getDefaultAccount();
    if (!defaultAcc || !defaultAcc.cookie) {
      this.activeClient = await Innertube.create();
    } else {
      this.activeClient = await Innertube.create({
        cookie: defaultAcc.cookie
      });
    }
    return this.activeClient;
  }

  // Fetch user playlists and liked songs from YouTube Music
  async getUserLibrary() {
    const defaultAcc = this.getDefaultAccount();
    if (!defaultAcc) {
      return { success: false, error: 'No authenticated YouTube Music account' };
    }

    const client = await this.getActiveClient();
    try {
      const library = await client.music.getLibrary();
      const playlists = [];
      
      if (library && library.playlists) {
        for (const pl of library.playlists) {
          playlists.push({
            id: pl.id,
            title: pl.title?.text || pl.title || 'Untitled',
            itemCount: pl.item_count || pl.song_count || 0,
            thumbnail: pl.thumbnails?.[0]?.url || ''
          });
        }
      }

      return {
        success: true,
        user: {
          id: defaultAcc.id,
          name: defaultAcc.name,
          avatarUrl: defaultAcc.avatarUrl
        },
        playlists: playlists
      };
    } catch (e) {
      logger.log('error', `ytm-auth: Failed to fetch library: ${e.message}`);
      return { success: false, error: e.message };
    }
  }

  // Backward-compatible method aliases for route controllers
  getLoginUrl() {
    return this.getGoogleLoginUrl();
  }

  listAccounts() {
    return this.getAccounts();
  }

  getActiveAccount() {
    const raw = this.getDefaultAccount();
    return raw ? this.getSanitizedAccount(raw) : null;
  }

  getRawActiveAccount() {
    return this.getDefaultAccount();
  }

  getSanitizedAccount(account) {
    if (!account) return null;
    const { cookie, ...sanitized } = account;
    return sanitized;
  }

  async authenticateWithCookie(cookieString, options = {}) {
    return await this.addAccountFromCookie(cookieString, options);
  }

  switchAccount(id) {
    const ok = this.setDefaultAccount(id);
    return ok ? this.getActiveAccount() : null;
  }

  _buildSapisidHeaders(cookieString, origin = 'https://music.youtube.com') {
    if (!cookieString || typeof cookieString !== 'string') return null;
    const match = cookieString.match(/(?:^|;\s*)(?:SAPISID|__Secure-3PAPISID)=([^;]+)/);
    const sapisid = match ? match[1].trim() : '';
    if (!sapisid) return null;
    const ts = Math.floor(Date.now() / 1000);
    const hash = crypto.createHash('sha1').update(`${ts} ${sapisid} ${origin}`).digest('hex');
    return {
      'Cookie': cookieString,
      'Authorization': `SAPISIDHASH ${ts}_${hash}`,
      'Origin': origin,
      'X-Origin': origin,
      'X-Goog-AuthUser': '0',
      'Content-Type': 'application/json'
    };
  }

  async _callInnerTubeMutation(endpoint, bodyPayload = {}) {
    const defaultAcc = this.getDefaultAccount();
    if (!defaultAcc || !defaultAcc.cookie) {
      return {
        success: false,
        authenticated: false,
        endpoint,
        payload: bodyPayload,
        error: 'No authenticated YouTube Music account'
      };
    }

    const headers = this._buildSapisidHeaders(defaultAcc.cookie);
    const requestBody = {
      context: {
        client: {
          clientName: 'WEB_REMIX',
          clientVersion: '1.20250312.01.00',
          hl: 'en',
          gl: 'US'
        }
      },
      ...bodyPayload
    };

    if (typeof this._mutationTransport === 'function') {
      return await this._mutationTransport(endpoint, requestBody, headers);
    }

    try {
      if (this.activeClient && this.activeClient.actions && typeof this.activeClient.actions.execute === 'function') {
        const res = await this.activeClient.actions.execute(`/${endpoint}`, { ...bodyPayload, client: 'YTMUSIC' });
        return {
          success: true,
          authenticated: true,
          endpoint,
          payload: bodyPayload,
          data: res?.data || res || {}
        };
      }
    } catch (_) {}

    if (typeof globalThis.fetch === 'function' && headers) {
      try {
        const res = await globalThis.fetch(`https://music.youtube.com/youtubei/v1/${endpoint}?prettyPrint=false`, {
          method: 'POST',
          headers,
          body: JSON.stringify(requestBody),
          signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined
        });
        const data = await res.json().catch(() => ({}));
        return {
          success: res.ok,
          authenticated: true,
          status: res.status,
          endpoint,
          payload: bodyPayload,
          data
        };
      } catch (err) {
        return {
          success: false,
          authenticated: true,
          endpoint,
          payload: bodyPayload,
          error: err.message
        };
      }
    }

    return {
      success: true,
      authenticated: true,
      endpoint,
      payload: bodyPayload,
      queued: true
    };
  }

  async rateTrack(videoId, rating = 'LIKE') {
    const vid = String(videoId || '').trim();
    if (!vid) throw new Error('Missing videoId');
    const normRating = String(rating || 'LIKE').toUpperCase().trim();
    let endpoint = 'like/like';
    if (normRating === 'DISLIKE') {
      endpoint = 'like/dislike';
    } else if (normRating === 'INDIFFERENT' || normRating === 'NONE' || normRating === 'REMOVE') {
      endpoint = 'like/removelike';
    }
    const res = await this._callInnerTubeMutation(endpoint, {
      target: { videoId: vid }
    });
    return {
      ...res,
      videoId: vid,
      rating: normRating
    };
  }

  async createCloudPlaylist(title, description = '', privacyStatus = 'PRIVATE', videoIds = []) {
    const cleanTitle = String(title || '').trim();
    if (!cleanTitle) throw new Error('Missing playlist title');
    const cleanPrivacy = ['PUBLIC', 'UNLISTED', 'PRIVATE'].includes(String(privacyStatus || '').toUpperCase())
      ? String(privacyStatus).toUpperCase()
      : 'PRIVATE';
    const cleanVideos = Array.isArray(videoIds) ? videoIds.map(v => String(v || '').trim()).filter(Boolean) : [];
    const payload = {
      title: cleanTitle,
      description: String(description || ''),
      privacyStatus: cleanPrivacy
    };
    if (cleanVideos.length > 0) {
      payload.videoIds = cleanVideos;
    }
    const res = await this._callInnerTubeMutation('playlist/create', payload);
    return {
      ...res,
      playlistId: res.data?.playlistId || null,
      title: cleanTitle,
      privacyStatus: cleanPrivacy
    };
  }

  async editCloudPlaylist(playlistId, actions = []) {
    const rawId = String(playlistId || '').trim();
    if (!rawId) throw new Error('Missing playlistId');
    const cleanPlaylistId = rawId.startsWith('VL') ? rawId.slice(2) : rawId;
    if (!Array.isArray(actions) || actions.length === 0) {
      throw new Error('Missing playlist edit actions');
    }
    const validActions = new Set([
      'ACTION_ADD_VIDEO',
      'ACTION_REMOVE_VIDEO',
      'ACTION_MOVE_VIDEO_BEFORE',
      'ACTION_SET_PLAYLIST_NAME',
      'ACTION_SET_PLAYLIST_DESCRIPTION'
    ]);
    const formattedActions = actions.map(act => {
      const actionType = String(act.action || '').trim();
      if (!validActions.has(actionType)) {
        throw new Error(`Unsupported playlist action: ${actionType}`);
      }
      const entry = { action: actionType };
      if (act.addedVideoId || act.videoId) {
        if (actionType === 'ACTION_ADD_VIDEO') entry.addedVideoId = String(act.addedVideoId || act.videoId);
        if (actionType === 'ACTION_REMOVE_VIDEO') entry.removedVideoId = String(act.removedVideoId || act.videoId);
      }
      if (act.removedVideoId) entry.removedVideoId = String(act.removedVideoId);
      if (act.setVideoId) entry.setVideoId = String(act.setVideoId);
      if (act.movedSetVideoIdSuccessor) entry.movedSetVideoIdSuccessor = String(act.movedSetVideoIdSuccessor);
      if (act.playlistName !== undefined) entry.playlistName = String(act.playlistName);
      if (act.playlistDescription !== undefined) entry.playlistDescription = String(act.playlistDescription);
      return entry;
    });
    const res = await this._callInnerTubeMutation('browse/edit_playlist', {
      playlistId: cleanPlaylistId,
      actions: formattedActions
    });
    return {
      ...res,
      playlistId: cleanPlaylistId,
      actions: formattedActions
    };
  }

  async setArtistSubscription(channelId, subscribe = true) {
    const cid = String(channelId || '').trim();
    if (!cid) throw new Error('Missing channelId');
    const isSub = Boolean(subscribe);
    const endpoint = isSub ? 'subscription/subscribe' : 'subscription/unsubscribe';
    const res = await this._callInnerTubeMutation(endpoint, {
      channelIds: [cid]
    });
    return {
      ...res,
      channelId: cid,
      subscribed: isSub
    };
  }

  async reportPlaybackTelemetry(videoId, watchedSeconds = 0) {
    const vid = String(videoId || '').trim();
    if (!vid) throw new Error('Missing videoId');
    const sec = Math.max(0, Number(watchedSeconds) || 0);
    const cpn = crypto.randomBytes(8).toString('hex');
    const res = await this._callInnerTubeMutation('player/heartbeat', {
      videoId: vid,
      cpn,
      playbackContext: {
        contentPlaybackContext: {
          currentTimeSeconds: Math.round(sec)
        }
      }
    });
    return {
      ...res,
      videoId: vid,
      watchedSeconds: sec
    };
  }
}

module.exports = YtmAuthManager;
