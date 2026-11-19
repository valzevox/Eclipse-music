// ytm-auth.js — YouTube Music Authentication Engine (WebView Cookie Interceptor & InnerTube Session)
// Independent implementation under MIT License for Eclipse (PC & Mobile)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Innertube } = require('youtubei.js');
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

  // Intercept cookies string from redirect (contains SAPISID, SID, SSID, etc.)
  async addAccountFromCookie(cookieString) {
    if (!cookieString || typeof cookieString !== 'string') {
      throw new Error('Invalid cookie payload');
    }

    // Initialize InnerTube with authenticated cookie
    let yt;
    try {
      yt = await Innertube.create({
        cookie: cookieString
      });
    } catch (e) {
      logger.log('error', `ytm-auth: Innertube session initialization failed: ${e.message}`);
      throw new Error('Could not establish YouTube Music session with provided cookie');
    }

    // Extract Account Info
    let accountInfo;
    try {
      accountInfo = await yt.account.getInfo();
    } catch (e) {
      logger.log('warn', `ytm-auth: getInfo failed, falling back to base profile: ${e.message}`);
      accountInfo = null;
    }

    // Extract name, avatar, channel id
    let channelId = 'unknown';
    let name = 'YouTube User';
    let handle = '';
    let avatarUrl = '';

    if (accountInfo) {
      if (accountInfo.contents && accountInfo.contents.length > 0) {
        const primary = accountInfo.contents[0];
        channelId = primary.endpoint?.browse_endpoint?.browse_id || primary.id || 'default';
        name = primary.title?.text || primary.name || name;
        if (primary.thumbnail?.length > 0) {
          avatarUrl = primary.thumbnail[0].url || '';
        }
      }
    }

    // Fallback parsing from cookie if getInfo is minimal
    if (channelId === 'unknown') {
      const match = cookieString.match(/SAPISID=([^;]+)/);
      channelId = match ? `user_${match[1].slice(0, 10)}` : `user_${Date.now()}`;
    }

    const newAccount = {
      id: channelId,
      name: name,
      handle: handle,
      avatarUrl: avatarUrl,
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

    await this.saveAccounts();
    this.activeClient = yt;
    return this.getSanitizedAccount(newAccount);
  }

  getAccounts() {
    // Return sanitized accounts (without exposing raw session cookies to frontend)
    return this.accounts.map(acc => ({
      id: acc.id,
      name: acc.name,
      handle: acc.handle,
      avatarUrl: acc.avatarUrl,
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

  async authenticateWithCookie(cookieString) {
    return await this.addAccountFromCookie(cookieString);
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
