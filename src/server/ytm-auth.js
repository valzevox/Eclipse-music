// ytm-auth.js — YouTube Music Authentication Engine (WebView Cookie Interceptor & InnerTube Session)
// Independent implementation under MIT License for Eclipse (PC & Mobile)
const fs = require('fs');
const path = require('path');
const { Innertube } = require('youtubei.js');
const logger = fs.existsSync(path.join(__dirname, 'logger.js')) ? require('./logger') : (fs.existsSync(path.join(__dirname, '../shared/logger.js')) ? require('../shared/logger') : console);

class YtmAuthManager {
  constructor(dataDir, vaultProvider = null) {
    this.dataDir = dataDir;
    this.vaultProvider = vaultProvider;
    this.storagePath = path.join(dataDir, 'ytm-accounts.json');
    this.accounts = []; // Array of { id, name, handle, avatarUrl, cookie, isDefault, lastSync }
    this.activeClient = null;
    this.loadAccounts();
  }

  loadAccounts() {
    try {
      if (fs.existsSync(this.storagePath)) {
        const raw = fs.readFileSync(this.storagePath, 'utf8');
        this.accounts = JSON.parse(raw);
        if (!Array.isArray(this.accounts)) this.accounts = [];
      }
    } catch (e) {
      logger.log('warn', `ytm-auth: Failed to load accounts: ${e.message}`);
      this.accounts = [];
    }
  }

  saveAccounts() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(this.storagePath, JSON.stringify(this.accounts, null, 2), 'utf8');
    } catch (e) {
      logger.log('error', `ytm-auth: Failed to save accounts: ${e.message}`);
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

    this.saveAccounts();
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
      this.saveAccounts();
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
      this.saveAccounts();
      this.activeClient = null;
      return true;
    }
    return false;
  }

  async getActiveClient() {
    if (this.activeClient) return this.activeClient;
    const defaultAcc = this.getDefaultAccount();
    if (!defaultAcc || !defaultAcc.cookie) {
      // Unauthenticated client
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

  getSanitizedAccount(account) {
    if (!account) return null;
    return {
      id: account.id,
      name: account.name,
      handle: account.handle,
      avatarUrl: account.avatarUrl,
      isDefault: !!account.isDefault,
      lastSync: account.lastSync
    };
  }

  getSanitizedActiveAccount() {
    return this.getSanitizedAccount(this.getDefaultAccount());
  }

  getActiveAccount() {
    return this.getSanitizedActiveAccount();
  }

  async authenticateWithCookie(cookieString) {
    return this.addAccountFromCookie(cookieString);
  }

  switchAccount(id) {
    return this.setDefaultAccount(id);
  }
}

module.exports = YtmAuthManager;