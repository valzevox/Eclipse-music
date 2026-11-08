// JavaScript / listen-together.js / WebRTC P2P Live Listening Room Engine
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
  createRoom(customCode = null) {
    this.role = 'host';
    this.roomCode = customCode || this.generateRoomCode();
    this.peers.clear();
    return {
      role: 'host',
      roomCode: this.roomCode
    };
  }

  /**
   * Guest joins a listening room
   */
  joinRoom(roomCode) {
    this.role = 'guest';
    this.roomCode = String(roomCode).trim();
    this.peers.clear();
    return {
      role: 'guest',
      roomCode: this.roomCode
    };
  }

  leaveRoom() {
    this.broadcast({ type: 'LEAVE', role: this.role });
    this.peers.clear();
    this.role = 'none';
    this.roomCode = null;
  }

  /**
   * Host broadcasts playback state to all guests
   */
  broadcastPlaybackState(state = {}) {
    if (this.role !== 'host') return;

    const payload = {
      type: 'SYNC_STATE',
      roomCode: this.roomCode,
      timestamp: Date.now(),
      currentTime: state.currentTime || (this.audioElement ? this.audioElement.currentTime : 0),
      isPlaying: state.isPlaying ?? (this.audioElement ? !this.audioElement.paused : false),
      track: state.track || this.localTrack || null
    };

    this.broadcast(payload);
  }

  /**
   * Guest receives state from host and synchronizes playback
   */
  receiveHostState(state) {
    if (this.role !== 'guest' || !state) return;

    // 1. Calculate one-way network latency estimation
    const networkLatencySec = Math.max(0, (Date.now() - (state.timestamp || Date.now())) / 1000);
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
  sendChat(message, senderName = 'Guest') {
    const chat = {
      type: 'CHAT',
      roomCode: this.roomCode,
      sender: senderName,
      text: message,
      time: Date.now()
    };
    this.broadcast(chat);
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
