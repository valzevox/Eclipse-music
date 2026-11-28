// JavaScript / mv-player.js / Browser & Electron / YouTube IFrame MV Player Engine
// Part of Eclipse Music Player — MIT License

(function () {
  const ALLOWED_YT_ORIGINS = new Set([
    'https://www.youtube.com',
    'https://www.youtube-nocookie.com'
  ]);

  class IFrameEngine {
    constructor(options = {}) {
      this.wrapper = options.wrapper || null;
      this.iframe = null;
      this.state = 'IDLE'; // 'IDLE' | 'LOADING' | 'PLAYING' | 'PAUSED' | 'ENDED' | 'ERROR'
      this.position = 0;
      this.volume = 1.0;
      this.muted = false;
      this._listeners = new Map();
      this._disposed = false;
      this._widgetId = 1;
      this._receivedDelivery = false;
      this._handshakeTimer = null;
      this._onWindowMessage = this._handleWindowMessage.bind(this);

      if (typeof window !== 'undefined') {
        window.addEventListener('message', this._onWindowMessage);
      }
    }

    on(event, handler) {
      if (typeof handler !== 'function') return () => {};
      if (!this._listeners.has(event)) this._listeners.set(event, new Set());
      const set = this._listeners.get(event);
      set.add(handler);
      return () => {
        set.delete(handler);
      };
    }

    _emit(event, payload) {
      const set = this._listeners.get(event);
      if (!set) return;
      for (const fn of Array.from(set)) {
        try { fn(payload); } catch (_) {}
      }
    }

    _postCommand(func, args = '') {
      if (!this.iframe || !this.iframe.contentWindow) return;
      try {
        this.iframe.contentWindow.postMessage(JSON.stringify({ event: 'command', func, args }), '*');
      } catch (_) {}
    }

    _handleWindowMessage(event) {
      if (this._disposed || !this.iframe) return;
      if (!ALLOWED_YT_ORIGINS.has(event.origin)) return;
      if (event.source !== this.iframe.contentWindow) return;
      if (!event.data) return;

      let msg = null;
      if (typeof event.data === 'string') {
        try { msg = JSON.parse(event.data); } catch (_) {}
      } else if (typeof event.data === 'object') {
        msg = event.data;
      }
      if (!msg) return;
      this._receivedDelivery = true;
      if (this._handshakeTimer) {
        clearInterval(this._handshakeTimer);
        this._handshakeTimer = null;
      }

      const applyPlayerState = (rawState) => {
        if (rawState === 1 && this.state !== 'PLAYING') {
          this.state = 'PLAYING';
          this._emit('stateChange', 'PLAYING');
        } else if (rawState === 2 && this.state !== 'PAUSED') {
          this.state = 'PAUSED';
          this._emit('stateChange', 'PAUSED');
        } else if (rawState === 0 && this.state !== 'ENDED') {
          this.state = 'ENDED';
          this._emit('stateChange', 'ENDED');
          this._emit('ended');
        }
      };

      if ((msg.event === 'infoDelivery' || msg.event === 'initialDelivery') && msg.info) {
        if (typeof msg.info.currentTime === 'number') {
          this.position = msg.info.currentTime;
          this._emit('timeupdate', this.position);
        }
        if (typeof msg.info.playerState === 'number') {
          applyPlayerState(msg.info.playerState);
        }
      }

      if (msg.event === 'onStateChange') {
        applyPlayerState(msg.info);
      }

      if (msg.event === 'onError') {
        this.state = 'ERROR';
        this._emit('error', msg.info);
      }
    }

    _sendListeningHandshake() {
      if (this._disposed || !this.iframe || !this.iframe.contentWindow) return;
      try {
        this.iframe.contentWindow.postMessage(
          JSON.stringify({ event: 'listening', id: this._widgetId, channel: 'widget' }),
          '*'
        );
      } catch (_) {}
    }

    async load(source, startSec = 0) {
      if (this._disposed || !source || source.type !== 'iframe' || !source.videoId) return;
      this.state = 'LOADING';
      this.position = Math.max(0, Math.floor(startSec || 0));
      this._receivedDelivery = false;
      if (this._handshakeTimer) {
        clearInterval(this._handshakeTimer);
        this._handshakeTimer = null;
      }

      if (!this.wrapper || typeof document === 'undefined') return;
      const aspectBox = this.wrapper.querySelector('.mv-player-aspect') || this.wrapper;
      let existingIframe = aspectBox.querySelector('iframe#mv-youtube-iframe');

      const pageOrigin = (typeof window !== 'undefined' && window.location && /^https?:\/\//i.test(window.location.origin))
        ? window.location.origin
        : 'https://www.youtube.com';
      const embedSrc = `https://www.youtube.com/embed/${source.videoId}?enablejsapi=1&autoplay=1&mute=${this.muted ? 1 : 0}&start=${this.position}&playsinline=1&modestbranding=1&rel=0&iv_load_policy=3&origin=${encodeURIComponent(pageOrigin)}`;

      if (!existingIframe) {
        existingIframe = document.createElement('iframe');
        existingIframe.id = 'mv-youtube-iframe';
        existingIframe.style.width = '100%';
        existingIframe.style.height = '100%';
        existingIframe.style.border = 'none';
        existingIframe.style.borderRadius = '12px';
        existingIframe.referrerPolicy = 'strict-origin-when-cross-origin';
        existingIframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture';
        existingIframe.allowFullscreen = true;
        aspectBox.appendChild(existingIframe);
      }

      existingIframe.onload = () => {
        this._sendListeningHandshake();
        let attempts = 0;
        if (this._handshakeTimer) clearInterval(this._handshakeTimer);
        this._handshakeTimer = setInterval(() => {
          attempts++;
          if (this._disposed || this._receivedDelivery || attempts >= 12) {
            clearInterval(this._handshakeTimer);
            this._handshakeTimer = null;
            return;
          }
          this._sendListeningHandshake();
        }, 250);
      };

      existingIframe.src = embedSrc;
      this.iframe = existingIframe;
    }

    play() {
      this._postCommand('playVideo');
    }

    pause() {
      this._postCommand('pauseVideo');
      if (this.state === 'PLAYING') {
        this.state = 'PAUSED';
        this._emit('stateChange', 'PAUSED');
      }
    }

    seek(sec) {
      const target = Math.max(0, Number(sec) || 0);
      this.position = target;
      this._postCommand('seekTo', [target, true]);
    }

    setVolume(vol) {
      const clamped = Math.max(0, Math.min(1, Number(vol) || 0));
      this.volume = clamped;
      this._postCommand('setVolume', [Math.round(clamped * 100)]);
    }

    setMuted(muted) {
      this.muted = Boolean(muted);
      this._postCommand(this.muted ? 'mute' : 'unMute');
    }

    getPosition() {
      return this.position;
    }

    getState() {
      return this.state;
    }

    dispose() {
      if (this._disposed) return;
      this._disposed = true;
      if (typeof window !== 'undefined') {
        window.removeEventListener('message', this._onWindowMessage);
      }
      if (this._handshakeTimer) {
        clearInterval(this._handshakeTimer);
        this._handshakeTimer = null;
      }
      this._listeners.clear();
      if (this.iframe && this.iframe.parentNode) {
        try { this.iframe.parentNode.removeChild(this.iframe); } catch (_) {}
      }
      this.iframe = null;
      this.state = 'IDLE';
    }
  }

  class EclipseMvPlayer {
    constructor(options = {}) {
      const getEl = (id) => (typeof document !== 'undefined' && id ? document.getElementById(id) : null);
      this.audioElement = options.audioElement || null;
      this.wrapper = options.wrapper || getEl(options.wrapperId || 'mv-player-wrapper');
      this.coverContainer = options.coverContainer || getEl(options.coverContainerId || 'cover-container');
      this.btnSong = options.btnSong || getEl(options.btnSongId || 'btn-av-song');
      this.btnVideo = options.btnVideo || getEl(options.btnVideoId || 'btn-av-video');
      this.btnToggleMv = options.btnToggleMv || getEl(options.btnToggleMvId || 'btn-toggle-mv');
      this.loadingOverlay = options.loadingOverlay || getEl(options.loadingOverlayId || 'mv-loading-overlay');
      this.apiBase = options.apiBase || '';
      this.apiToken = options.apiToken || '';
      this.onOpenPanel = options.onOpenPanel || null;

      this.engine = new IFrameEngine({ wrapper: this.wrapper });
      const SyncCtrl = typeof window !== 'undefined' && window.MvSyncController
        ? window.MvSyncController
        : (typeof require === 'function' ? require('./mv-sync-controller') : null);

      this.sync = new SyncCtrl({
        audioElement: this.audioElement,
        engine: this.engine,
        resolveMv: (track) => this._fetchMv(track),
        invalidateMapping: (songId, reason) => this._invalidateMv(songId, reason),
        onAdvanceQueue: options.onAdvanceQueue || options.onNextTrack || null,
        onAbortAutoMix: options.onAbortAutoMix || null,
        onStateChange: (st) => this._syncUi(st),
        onCandidates: (info) => this._showCandidatePicker(info),
        onErrorNotice: ({ code }) => {
          if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
            const msg = (code === 101 || code === 150)
              ? 'Music Video embedding is restricted, switched to audio mode'
              : 'Music video unavailable, switched to audio mode';
            window.showToast(msg, 'info');
          }
        }
      });

      if (typeof window !== 'undefined') {
        this.init();
      }
    }

    get mode() {
      return this.sync.activeMode;
    }

    isMvActive() {
      return this.sync.isMvActive();
    }

    init() {
      if (this.btnSong) this.btnSong.addEventListener('click', () => this.switchToSong());
      if (this.btnVideo) this.btnVideo.addEventListener('click', () => this.switchToVideo());
      if (this.btnToggleMv) this.btnToggleMv.addEventListener('click', () => this.toggle());
    }

    setAudioElement(audio) {
      this.audioElement = audio;
      this.sync.setAudioElement(audio);
    }

    setTrack(track) {
      return this.sync.setTrack(track);
    }

    toggle() {
      if (this.sync.preferredMode === 'video') {
        return this.switchToSong();
      }
      return this.switchToVideo();
    }

    switchToVideo() {
      if (typeof this.onOpenPanel === 'function') {
        try { this.onOpenPanel(); } catch (_) {}
      }
      return this.sync.switchToVideo();
    }

    switchToSong() {
      return this.sync.switchToSong({ keepPreferred: false });
    }

    seekSongTime(songSec) {
      if (!this.isMvActive()) return;
      const target = Math.max(0, (Number(songSec) || 0) + ((this.sync.offsetMs || 0) / 1000));
      this.engine.seek(target);
    }

    _authHeaders() {
      return this.apiToken ? { 'X-Eclipse-Token': this.apiToken } : {};
    }

    async _fetchMv(track) {
      if (!track) return { found: false };
      if (this.loadingOverlay) this.loadingOverlay.classList.remove('hidden');
      try {
        const songId = track.id || track.songId || '';
        const title = track.title || '';
        const artist = track.artist || (track.artists && track.artists[0]?.name) || '';
        const durationSec = Number.isFinite(track.duration) ? track.duration : '';
        const url = `${this.apiBase}/api/ytm/mv?songId=${encodeURIComponent(songId)}&title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}&durationSec=${encodeURIComponent(durationSec)}`;
        const resp = await fetch(url, { headers: this._authHeaders() });
        return await resp.json();
      } finally {
        if (this.loadingOverlay) this.loadingOverlay.classList.add('hidden');
      }
    }

    async _invalidateMv(songId, reason) {
      if (!songId) return;
      await fetch(`${this.apiBase}/api/ytm/mv/invalidate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this._authHeaders() },
        body: JSON.stringify({ songId, reason })
      });
    }

    async selectCandidate(songId, mvVideoId, offsetMs = 0) {
      if (!songId || !mvVideoId) return;
      await fetch(`${this.apiBase}/api/ytm/mv/override`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this._authHeaders() },
        body: JSON.stringify({ songId, mvVideoId, offsetMs, offsetUserOverride: true })
      });
      await this.sync.switchToVideo();
    }

    _syncUi(st) {
      const isVideo = st.activeMode === 'video';
      if (this.btnVideo) this.btnVideo.classList.toggle('active', isVideo);
      if (this.btnSong) this.btnSong.classList.toggle('active', !isVideo);
      if (this.btnToggleMv) this.btnToggleMv.classList.toggle('active', isVideo);
      if (this.coverContainer) this.coverContainer.classList.toggle('hidden', isVideo);
      if (this.wrapper) this.wrapper.classList.toggle('hidden', !isVideo);
    }

    _showCandidatePicker({ candidates = [], track }) {
      if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
        window.showToast('No confident MV match found — keeping audio playing', 'info');
      }
      if (typeof document === 'undefined' || !candidates.length) return;
      let modal = document.getElementById('mv-candidate-picker-modal');
      if (!modal) {
        modal = document.createElement('div');
        modal.id = 'mv-candidate-picker-modal';
        modal.className = 'mv-candidate-picker-modal hidden';
        modal.style.cssText = 'position:fixed;right:24px;bottom:96px;z-index:9999;width:340px;max-height:360px;overflow:auto;padding:14px;border-radius:16px;background:rgba(18,18,28,0.88);backdrop-filter:blur(20px);border:1px solid rgba(255,255,255,0.12);color:#fff;';
        document.body.appendChild(modal);
      }
      modal.innerHTML = '';
      const header = document.createElement('div');
      header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;font-weight:600;font-size:13px;';
      header.textContent = 'Select Music Video';
      const closeBtn = document.createElement('button');
      closeBtn.textContent = '×';
      closeBtn.style.cssText = 'background:none;border:none;color:#fff;font-size:18px;cursor:pointer;';
      closeBtn.onclick = () => modal.classList.add('hidden');
      header.appendChild(closeBtn);
      modal.appendChild(header);

      for (const c of candidates) {
        const row = document.createElement('button');
        row.style.cssText = 'display:flex;flex-direction:column;align-items:flex-start;width:100%;text-align:left;padding:8px 10px;margin-bottom:6px;border-radius:10px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.08);color:#fff;cursor:pointer;';
        const t = document.createElement('span');
        t.style.cssText = 'font-size:12px;font-weight:600;';
        t.textContent = c.title || c.videoId;
        const sub = document.createElement('span');
        sub.style.cssText = 'font-size:11px;opacity:0.7;';
        sub.textContent = `${c.artist || ''} • ${Math.round((c.score || 0) * 100)}%`;
        row.appendChild(t);
        row.appendChild(sub);
        row.onclick = () => {
          modal.classList.add('hidden');
          this.selectCandidate(track?.id || track?.songId, c.videoId, 0);
        };
        modal.appendChild(row);
      }
      modal.classList.remove('hidden');
    }
  }

  if (typeof module !== 'undefined') {
    module.exports = { EclipseMvPlayer, IFrameEngine, ALLOWED_YT_ORIGINS };
  } else {
    window.IFrameEngine = IFrameEngine;
    window.EclipseMvPlayer = EclipseMvPlayer;
  }
})();
