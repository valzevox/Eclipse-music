// JavaScript / listen-together.js / Real-Time LAN & Tailscale Eclipse Sync Rooms Engine
// Part of Eclipse Music Player — MIT License

class ListenTogetherRoom {
  constructor(options = {}) {
    this.role = 'none'; // 'host' | 'guest'
    this.roomCode = null;
    this.peers = new Map(); // peerId -> connection/channel
    this.localTrack = null;
    this.audioElement = options.audioElement || null;
    this.onStateUpdate = options.onStateUpdate || null;
    this.onPeerCountChange = options.onPeerCountChange || null;
    this.onChatMessage = options.onChatMessage || null;
    this.syncToleranceMs = 200; // 200ms drift threshold

    this._hostServerUrl = options.hostServerUrl || null;
    this._pollIntervalMs = options.pollIntervalMs || 1000;
    this._pollTimer = null;
    this._clockOffsetMs = 0; // serverNow - Date.now()
    this._lastStateVersion = 0;
    this._isSyncing = false;
  }

  get hostServerUrl() {
    if (this._hostServerUrl) return this._hostServerUrl;
    const port = (typeof window !== 'undefined' && (
      window.state?.serverPort ||
      window.ECLIPSE_SERVER_PORT ||
      window.riffServerPort
    )) || 38472;
    return `http://127.0.0.1:${port}`;
  }

  set hostServerUrl(url) {
    this._hostServerUrl = url ? String(url).replace(/\/+$/, '') : null;
  }

  /**
   * Check whether an Eclipse Sync Room is currently active
   * Used by AutoMix to suppress crossfade and maintain sync
   */
  isActiveRoom() {
    return this.role === 'host' || this.role === 'guest';
  }

  /**
   * Generate a random 6-digit room code
   */
  generateRoomCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  /**
   * Host starts a listening room
   */
  async createRoom(customCode = null) {
    this.role = 'host';
    this.roomCode = customCode || this.generateRoomCode();
    this.peers.clear();
    this._startPoller();

    try {
      const res = await fetch(`${this.hostServerUrl}/api/sync-room/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomCode: this.roomCode,
          hostClientTime: Date.now()
        })
      }).catch(() => null);

      if (res && res.ok) {
        const data = await res.json().catch(() => null);
        if (data && typeof data.serverNow === 'number') {
          this._clockOffsetMs = data.serverNow - Date.now();
        }
      }
    } catch (_) {}

    return {
      role: 'host',
      roomCode: this.roomCode
    };
  }

  /**
   * Guest joins a listening room
   */
  async joinRoom(roomCode, hostServerUrl = null) {
    this.role = 'guest';
    this.roomCode = String(roomCode).trim();
    if (hostServerUrl) {
      this.hostServerUrl = hostServerUrl;
    }
    this.peers.clear();
    this._startPoller();

    try {
      const res = await fetch(`${this.hostServerUrl}/api/sync-room/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomCode: this.roomCode,
          clientTime: Date.now()
        })
      }).catch(() => null);

      if (res && res.ok) {
        const data = await res.json().catch(() => null);
        if (data && typeof data.serverNow === 'number') {
          this._clockOffsetMs = data.serverNow - Date.now();
        }
        if (data && data.state) {
          this.receiveHostState(data.state);
        }
      }
    } catch (_) {}

    return {
      role: 'guest',
      roomCode: this.roomCode
    };
  }

  leaveRoom() {
    this._stopPoller();
    this.broadcast({ type: 'LEAVE', role: this.role });
    this.peers.clear();
    this.role = 'none';
    this.roomCode = null;
    this._clockOffsetMs = 0;
  }

  _startPoller() {
    this._stopPoller();
    this._pollTimer = setInterval(() => {
      this._pollServerState().catch(() => {});
    }, this._pollIntervalMs);
  }

  _stopPoller() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  async _pollServerState() {
    if (!this.roomCode || this.role === 'none' || this._isSyncing) return;
    this._isSyncing = true;
    try {
      const url = `${this.hostServerUrl}/api/sync-room/state?roomCode=${encodeURIComponent(this.roomCode)}&role=${this.role}`;
      const res = await fetch(url).catch(() => null);
      if (res && res.ok) {
        const data = await res.json().catch(() => null);
        if (data) {
          if (typeof data.serverNow === 'number') {
            this._clockOffsetMs = data.serverNow - Date.now();
          }
          if (typeof data.peerCount === 'number' && typeof this.onPeerCountChange === 'function') {
            this.onPeerCountChange(data.peerCount);
          }
          if (this.role === 'guest' && data.state) {
            this.receiveHostState(data.state);
          }
        }
      }
    } catch (_) {} finally {
      this._isSyncing = false;
    }
  }

  /**
   * Host broadcasts playback state to all guests
   */
  async broadcastPlaybackState(state = {}) {
    if (this.role !== 'host') return;

    const payload = {
      type: 'SYNC_STATE',
      roomCode: this.roomCode,
      timestamp: Date.now() + this._clockOffsetMs,
      currentTime: state.currentTime || (this.audioElement ? this.audioElement.currentTime : 0),
      isPlaying: state.isPlaying ?? (this.audioElement ? !this.audioElement.paused : false),
      track: state.track || this.localTrack || null
    };

    this.broadcast(payload);

    // Relay state to server endpoint
    try {
      await fetch(`${this.hostServerUrl}/api/sync-room/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomCode: this.roomCode,
          action: 'SYNC_STATE',
          state: payload
        })
      }).catch(() => {});
    } catch (_) {}
  }

  /**
   * Guest receives state from host and synchronizes playback
   */
  receiveHostState(state) {
    if (this.role !== 'guest' || !state) return;

    // 1. Calculate one-way network latency estimation using calibrated clock offset
    const nowServerTime = Date.now() + this._clockOffsetMs;
    const networkLatencySec = Math.max(0, (nowServerTime - (state.timestamp || nowServerTime)) / 1000);
    const targetTime = (state.currentTime || 0) + (state.isPlaying ? networkLatencySec : 0);

    // 2. Sync track if different
    if (state.track && (!this.localTrack || this.localTrack.id !== state.track.id)) {
      this.localTrack = state.track;
      if (typeof this.onStateUpdate === 'function') {
        this.onStateUpdate({ type: 'TRACK_CHANGE', track: state.track, targetTime });
      }
    }

    // 3. Sync position if drift exceeds tolerance
    if (this.audioElement) {
      const current = this.audioElement.currentTime || 0;
      const drift = Math.abs(current - targetTime);

      if (drift > (this.syncToleranceMs / 1000)) {
        this.audioElement.currentTime = targetTime;
      }

      if (state.isPlaying && this.audioElement.paused) {
        this.audioElement.play().catch(() => {});
      } else if (!state.isPlaying && !this.audioElement.paused) {
        this.audioElement.pause();
      }
    }

    if (typeof this.onStateUpdate === 'function') {
      this.onStateUpdate({ type: 'PLAYBACK_SYNC', ...state, targetTime });
    }
  }

  /**
   * Send chat message inside the listening room
   */
  async sendChat(message, senderName = 'Guest') {
    const chat = {
      type: 'CHAT',
      roomCode: this.roomCode,
      sender: senderName,
      text: message,
      time: Date.now() + this._clockOffsetMs
    };
    this.broadcast(chat);

    try {
      await fetch(`${this.hostServerUrl}/api/sync-room/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomCode: this.roomCode,
          action: 'CHAT',
          chat
        })
      }).catch(() => {});
    } catch (_) {}

    return chat;
  }

  broadcast(message) {
    const raw = typeof message === 'string' ? message : JSON.stringify(message);
    for (const [peerId, channel] of this.peers) {
      try {
        if (channel && channel.readyState === 'open') {
          channel.send(raw);
        }
      } catch (_) {}
    }
  }
}

if (typeof module !== 'undefined') {
  module.exports = ListenTogetherRoom;
} else {
  window.ListenTogetherRoom = ListenTogetherRoom;
}
