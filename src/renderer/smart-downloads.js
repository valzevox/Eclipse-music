// JavaScript / smart-downloads.js / Node.js & Browser / Background Smart Downloads Service
// Part of Eclipse Music Player — MIT License

class SmartDownloadManager {
  constructor(options = {}) {
    this.enabled = options.enabled ?? false;
    this.limit = options.limit || 50; // 25, 50, or 100
    this.wifiOnly = options.wifiOnly ?? true;
    this.delayMs = typeof options.delayMs === 'number' ? options.delayMs : 1500;
    this.inProgress = false;
    this.queue = [];
    this.downloaded = 0;
    this.total = 0;
    this.statusListeners = new Set();
  }

  configure(config = {}) {
    if (typeof config.enabled === 'boolean') this.enabled = config.enabled;
    if (typeof config.limit === 'number') this.limit = Math.min(100, Math.max(10, config.limit));
    if (typeof config.wifiOnly === 'boolean') this.wifiOnly = config.wifiOnly;
    return this.getConfig();
  }

  getConfig() {
    return {
      enabled: this.enabled,
      limit: this.limit,
      wifiOnly: this.wifiOnly,
      inProgress: this.inProgress,
      progress: {
        downloaded: this.downloaded,
        total: this.total,
        percentage: this.total > 0 ? Math.round((this.downloaded / this.total) * 100) : 0
      }
    };
  }

  onStatus(callback) {
    if (typeof callback === 'function') {
      this.statusListeners.add(callback);
      callback(this.getConfig());
    }
  }

  emitStatus(extra = {}) {
    const status = { ...this.getConfig(), ...extra };
    for (const listener of this.statusListeners) {
      try { listener(status); } catch (_) {}
    }
  }

  /**
   * Plan Smart Downloads from user's most played tracks and favorites
   * Filters out already cached tracks and enqueues top N
   */
  planDownloads(candidateTracks = [], isCachedFn) {
    if (!this.enabled || !Array.isArray(candidateTracks)) {
      return [];
    }

    // Sort by play count descending if available
    const sorted = [...candidateTracks].sort((a, b) => {
      const playsA = (a.stats && a.stats.plays) || a.playCount || 0;
      const playsB = (b.stats && b.stats.plays) || b.playCount || 0;
      return playsB - playsA;
    });

    const targetList = sorted.slice(0, this.limit);
    const toDownload = [];

    for (const track of targetList) {
      const trackId = track.id || track.cleanId || '';
      const cached = typeof isCachedFn === 'function' ? isCachedFn(trackId, track) : false;
      if (!cached) {
        toDownload.push(track);
      }
    }

    this.queue = toDownload;
    this.total = toDownload.length;
    this.downloaded = 0;

    return toDownload;
  }

  /**
   * Check whether current device connection satisfies Wi-Fi constraint
   */
  static isWifiConnection() {
    if (typeof navigator === 'undefined') return true;
    if (navigator.onLine === false) return false;
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (conn) {
      if (typeof conn.type === 'string') {
        const t = conn.type.toLowerCase();
        return t === 'wifi' || t === 'ethernet' || t === 'unknown';
      }
      if (conn.saveData) return false;
    }
    return true;
  }

  /**
   * Start executing smart download queue with concurrency and rate limiting
   */
  async startSync(downloadFn, isWifiFn = SmartDownloadManager.isWifiConnection) {
    if (!this.enabled || this.inProgress || this.queue.length === 0) {
      return;
    }

    // Check Wi-Fi constraint if requested
    if (this.wifiOnly) {
      const checkWifi = typeof isWifiFn === 'function' ? isWifiFn : SmartDownloadManager.isWifiConnection;
      const onWifi = await checkWifi();
      if (!onWifi) {
        this.emitStatus({ pausedReason: 'waiting_for_wifi' });
        return { downloaded: 0, total: this.total, pausedReason: 'waiting_for_wifi' };
      }
    }

    this.inProgress = true;
    this.emitStatus({ inProgress: true });

    try {
      while (this.queue.length > 0) {
        if (!this.enabled) break;

        const currentTrack = this.queue.shift();
        this.emitStatus({ currentTrack });

        try {
          if (typeof downloadFn === 'function') {
            await downloadFn(currentTrack);
          }
          this.downloaded++;
          this.emitStatus({ downloaded: this.downloaded, total: this.total });
        } catch (err) {
          console.warn('[SmartDownloads] Failed to cache track:', currentTrack?.title, err.message);
        }

        // Brief delay between downloads to prevent YouTube throttling
        if (this.delayMs > 0) {
          await new Promise(resolve => setTimeout(resolve, this.delayMs));
        }
      }
    } finally {
      this.inProgress = false;
      this.emitStatus({ inProgress: false, completed: true });
    }
    return { downloaded: this.downloaded, total: this.total };
  }
}

if (typeof module !== 'undefined') {
  module.exports = SmartDownloadManager;
} else {
  window.SmartDownloadManager = SmartDownloadManager;
}
