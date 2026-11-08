// JavaScript / mv-player.js / Browser & Electron / YouTube IFrame MV Player Engine
// Part of Eclipse Music Player — MIT License

(function () {
  class EclipseMvPlayer {
    constructor(options = {}) {
      this.mode = 'song'; // 'song' | 'video'
      this.currentTrack = null;
      this.currentVideoId = null;
      const getEl = (id) => (typeof document !== 'undefined' && id ? document.getElementById(id) : null);
      this.audioElement = options.audioElement || null;
      this.wrapper = options.wrapper || getEl(options.wrapperId || 'mv-player-wrapper');
      this.coverContainer = options.coverContainer || getEl(options.coverContainerId || 'cover-container');
      this.btnSong = options.btnSong || getEl(options.btnSongId || 'btn-av-song');
      this.btnVideo = options.btnVideo || getEl(options.btnVideoId || 'btn-av-video');
      this.btnToggleMv = options.btnToggleMv || getEl(options.btnToggleMvId || 'btn-toggle-mv');
      this.loadingOverlay = options.loadingOverlay || getEl(options.loadingOverlayId || 'mv-loading-overlay');
      this.onNextTrack = options.onNextTrack || null;
      this.iframe = null;
      this.lastTimestamp = 0;
      this.apiBase = options.apiBase || '';

      if (typeof window !== 'undefined') {
        this.init();
      }
    }

    init() {
      if (this.btnSong) {
        this.btnSong.addEventListener('click', () => this.switchToSong());
      }
      if (this.btnVideo) {
        this.btnVideo.addEventListener('click', () => this.switchToVideo());
      }
      if (this.btnToggleMv) {
        this.btnToggleMv.addEventListener('click', () => this.toggle());
      }

      // Handle YouTube IFrame postMessage events (end of video, playback state)
      window.addEventListener('message', (event) => {
        if (!event.data || typeof event.data !== 'string') return;
        try {
          const msg = JSON.parse(event.data);
          // YouTube Player state change: 0 = ENDED, 1 = PLAYING, 2 = PAUSED
          if (msg.event === 'onStateChange' && msg.info === 0) {
            if (typeof this.onNextTrack === 'function') {
              this.onNextTrack();
            }
          }
        } catch (_) {}
      });
    }

    setAudioElement(audio) {
      this.audioElement = audio;
    }

    setTrack(track) {
      this.currentTrack = track;
      if (this.mode === 'video') {
        this.loadVideoForCurrentTrack();
      }
    }

    toggle() {
      if (this.mode === 'video') {
        this.switchToSong();
      } else {
        this.switchToVideo();
      }
    }

    async switchToVideo() {
      if (!this.currentTrack) return;
      this.mode = 'video';

      // 1. Sync timestamp from audio
      let startTime = 0;
      if (this.audioElement) {
        startTime = Math.floor(this.audioElement.currentTime || 0);
        try { this.audioElement.pause(); } catch (_) {}
      }
      this.lastTimestamp = startTime;

      // 2. Update UI Switch Buttons
      if (this.btnVideo) this.btnVideo.classList.add('active');
      if (this.btnSong) this.btnSong.classList.remove('active');
      if (this.btnToggleMv) this.btnToggleMv.classList.add('active');
      if (this.coverContainer) this.coverContainer.classList.add('hidden');
      if (this.wrapper) this.wrapper.classList.remove('hidden');

      // 3. Load Video
      await this.loadVideoForCurrentTrack(startTime);
    }

    switchToSong() {
      this.mode = 'song';

      // 1. Read estimated or last timestamp
      const resumeTime = this.lastTimestamp || 0;

      // 2. Hide Video and stop IFrame
      if (this.iframe) {
        try {
          this.iframe.contentWindow.postMessage('{"event":"command","func":"pauseVideo","args":""}', '*');
        } catch (_) {}
      }

      if (this.btnVideo) this.btnVideo.classList.remove('active');
      if (this.btnSong) this.btnSong.classList.add('active');
      if (this.btnToggleMv) this.btnToggleMv.classList.remove('active');
      if (this.wrapper) this.wrapper.classList.add('hidden');
      if (this.coverContainer) this.coverContainer.classList.remove('hidden');

      // 3. Resume Audio playback at synced timestamp
      if (this.audioElement) {
        try {
          this.audioElement.currentTime = resumeTime;
          this.audioElement.play().catch(() => {});
        } catch (_) {}
      }
    }

    async loadVideoForCurrentTrack(startTime = 0) {
      if (!this.currentTrack) return;
      const track = this.currentTrack;

      if (this.loadingOverlay) this.loadingOverlay.classList.remove('hidden');

      try {
        const id = track.id || '';
        const title = track.title || '';
        const artist = track.artist || (track.artists && track.artists[0]?.name) || '';

        // Query backend for verified MV
        const url = `${this.apiBase}/api/ytm/mv?id=${encodeURIComponent(id)}&title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}`;
        const resp = await fetch(url);
        const data = await resp.json();

        if (data && data.success && data.videoId) {
          this.currentVideoId = data.videoId;
          this.renderIframe(data.videoId, startTime);
        } else {
          // Fallback to track ID directly if 11 chars
          const fallbackId = /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : 'dQw4w9WgXcQ';
          this.renderIframe(fallbackId, startTime);
        }
      } catch (err) {
        console.error('[EclipseMvPlayer] Failed to load MV:', err);
      } finally {
        if (this.loadingOverlay) this.loadingOverlay.classList.add('hidden');
      }
    }

    renderIframe(videoId, startTime = 0) {
      if (!this.wrapper) return;

      const aspectBox = this.wrapper.querySelector('.mv-player-aspect') || this.wrapper;
      let existingIframe = aspectBox.querySelector('iframe#mv-youtube-iframe');

      const embedSrc = `https://www.youtube.com/embed/${videoId}?enablejsapi=1&autoplay=1&start=${startTime}&playsinline=1&modestbranding=1&rel=0&iv_load_policy=3`;

      if (!existingIframe) {
        existingIframe = document.createElement('iframe');
        existingIframe.id = 'mv-youtube-iframe';
        existingIframe.style.width = '100%';
        existingIframe.style.height = '100%';
        existingIframe.style.border = 'none';
        existingIframe.style.borderRadius = '12px';
        existingIframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture';
        existingIframe.allowFullscreen = true;
        aspectBox.appendChild(existingIframe);
      }

      existingIframe.src = embedSrc;
      this.iframe = existingIframe;
    }
  }

  if (typeof module !== 'undefined') {
    module.exports = EclipseMvPlayer;
  } else {
    window.EclipseMvPlayer = EclipseMvPlayer;
  }
})();
