// JavaScript / mv-sync-controller.js / Browser & Node / MV Sync & Handoff Controller
// Part of Eclipse Music Player — MIT License

(function () {
  class MvSyncController {
    constructor(options = {}) {
      this.preferredMode = 'song'; // 'song' | 'video'
      this.activeMode = 'song';    // 'song' | 'video'
      this.generation = 0;
      this.currentTrack = null;
      this.currentVideoId = null;
      this.offsetMs = 0;
      this.handoffTimeoutMs = Number.isFinite(options.handoffTimeoutMs) ? options.handoffTimeoutMs : 8000;

      this.audioElement = options.audioElement || null;
      this.engine = options.engine || null;
      this.resolveMv = options.resolveMv || null;
      this.invalidateMapping = options.invalidateMapping || null;
      this.onAdvanceQueue = options.onAdvanceQueue || null;
      this.onAbortAutoMix = options.onAbortAutoMix || null;
      this.onStateChange = options.onStateChange || null;
      this.onCandidates = options.onCandidates || null;
      this.onErrorNotice = options.onErrorNotice || null;

      this._unsubEngine = null;
      this._endedHandledGen = -1;
      this._disposed = false;
    }

    isMvActive() {
      return this.activeMode === 'video';
    }

    setAudioElement(audio) {
      this.audioElement = audio;
    }

    setEngine(engine) {
      if (this._unsubEngine) {
        try { this._unsubEngine(); } catch (_) {}
        this._unsubEngine = null;
      }
      this.engine = engine;
    }

    setOffsetMs(offsetMs) {
      this.offsetMs = Number.isFinite(offsetMs) ? offsetMs : 0;
    }

    _emitState() {
      if (typeof this.onStateChange === 'function') {
        this.onStateChange({
          preferredMode: this.preferredMode,
          activeMode: this.activeMode,
          videoId: this.currentVideoId,
          offsetMs: this.offsetMs,
          generation: this.generation
        });
      }
    }

    _detachEngineListeners() {
      if (this._unsubEngine) {
        try { this._unsubEngine(); } catch (_) {}
        this._unsubEngine = null;
      }
    }

    _stopOldEngine() {
      this._detachEngineListeners();
      if (this.engine) {
        try { this.engine.setMuted(true); } catch (_) {}
        try { this.engine.pause(); } catch (_) {}
      }
      this.activeMode = 'song';
      this.currentVideoId = null;
    }

    _isAudioPlaying() {
      return Boolean(this.audioElement && !this.audioElement.paused);
    }

    _getSongTimeMs() {
      return Math.max(0, (this.audioElement?.currentTime || 0) * 1000);
    }

    async setTrack(track, options = {}) {
      if (this._disposed) return;
      const gen = ++this.generation;
      this._endedHandledGen = -1;

      // Rule: On Next/Prev or queue change while Video is active, pause/mute old MV
      // and disable old track callbacks BEFORE new track's Song backup plays.
      this._stopOldEngine();
      this.currentTrack = track || null;
      this._emitState();

      if (!track || this.preferredMode !== 'video') {
        return;
      }

      const shouldPlay = options.wasPlaying !== undefined ? Boolean(options.wasPlaying) : this._isAudioPlaying();
      await this._resolveAndHandoff(track, gen, shouldPlay);
    }

    async switchToVideo() {
      if (this._disposed || !this.currentTrack) return;
      this.preferredMode = 'video';
      const gen = ++this.generation;
      this._endedHandledGen = -1;
      const shouldPlay = this._isAudioPlaying();
      this._emitState();
      await this._resolveAndHandoff(this.currentTrack, gen, shouldPlay);
    }

    switchToSong({ keepPreferred = false, resumePlayback } = {}) {
      if (!keepPreferred) {
        this.preferredMode = 'song';
      }
      const gen = ++this.generation;
      const wasVideoActive = this.activeMode === 'video';
      const wasEnginePlaying = this.engine && typeof this.engine.getState === 'function'
        ? this.engine.getState() === 'PLAYING'
        : false;

      let resumeSec = this._getSongTimeMs() / 1000;
      if (wasVideoActive && this.engine && typeof this.engine.getPosition === 'function') {
        const videoTimeMs = (this.engine.getPosition() || 0) * 1000;
        resumeSec = Math.max(0, (videoTimeMs - this.offsetMs) / 1000);
      }

      this._stopOldEngine();
      this._emitState();

      if (this.audioElement && wasVideoActive) {
        try {
          this.audioElement.currentTime = resumeSec;
          const shouldResume = resumePlayback !== undefined ? Boolean(resumePlayback) : wasEnginePlaying;
          if (shouldResume) {
            const p = this.audioElement.play();
            if (p && typeof p.catch === 'function') p.catch(() => {});
          }
        } catch (_) {}
      }
      return gen;
    }

    async _resolveAndHandoff(track, gen, shouldPlay) {
      if (typeof this.resolveMv !== 'function' || !this.engine) return;

      let resolved;
      try {
        resolved = await this.resolveMv(track, gen);
      } catch (_) {
        return;
      }

      if (this._disposed || gen !== this.generation) return;

      if (!resolved || !resolved.found || !resolved.videoId) {
        this.activeMode = 'song';
        this._emitState();
        if (typeof this.onCandidates === 'function') {
          this.onCandidates({
            reason: resolved?.reason || 'LOW_CONFIDENCE',
            candidates: resolved?.candidates || [],
            track
          });
        }
        return;
      }

      this.currentVideoId = resolved.videoId;
      this.offsetMs = Number.isFinite(resolved.offsetMs) ? resolved.offsetMs : 0;

      // Attach engine listeners for this generation
      this._detachEngineListeners();
      const unsubs = [];
      if (typeof this.engine.on === 'function') {
        unsubs.push(this.engine.on('ended', () => {
          if (this._disposed || gen !== this.generation || this._endedHandledGen === gen) return;
          this._endedHandledGen = gen;
          if (typeof this.onAdvanceQueue === 'function') {
            this.onAdvanceQueue();
          }
        }));
        unsubs.push(this.engine.on('error', (code) => {
          if (this._disposed || gen !== this.generation) return;
          this._handleEngineError(code, track, resolved);
        }));
      }
      this._unsubEngine = () => {
        for (const u of unsubs) {
          try { if (typeof u === 'function') u(); } catch (_) {}
        }
      };

      // Handoff rule:
      // 1. Song keeps playing during resolve.
      // 2. Initialize Video muted and start playback (if shouldPlay).
      // 3. Wait for PLAYING + position advancing (or READY if paused).
      // 4. Read latest songTimeMs, seek Video to songTimeMs + offsetMs.
      // 5. Pause Song, then unmute Video, and abort AutoMix crossfade ('mv_active').
      const initialStartSec = Math.max(0, (this._getSongTimeMs() + this.offsetMs) / 1000);
      try {
        this.engine.setMuted(true);
        await this.engine.load({ type: 'iframe', videoId: resolved.videoId }, initialStartSec);
        if (this._disposed || gen !== this.generation) return;

        if (shouldPlay) {
          const prePlayPos = this.engine.getPosition?.() ?? 0;
          const waitPromise = this._waitForPlayingAndProgress(gen, prePlayPos);
          await this.engine.play();
          const confirmed = await waitPromise;
          if (!confirmed || this._disposed || gen !== this.generation) {
            this._stopOldEngine();
            this._emitState();
            return;
          }
        } else {
          this.engine.pause();
        }

        const latestSongMs = this._getSongTimeMs();
        const targetVideoSec = Math.max(0, (latestSongMs + this.offsetMs) / 1000);
        if (typeof this.engine.seek === 'function') {
          this.engine.seek(targetVideoSec);
        }

        if (this.audioElement) {
          try { this.audioElement.pause(); } catch (_) {}
        }
        this.engine.setMuted(false);
        this.activeMode = 'video';
        this._emitState();

        if (typeof this.onAbortAutoMix === 'function') {
          this.onAbortAutoMix('mv_active');
        }
      } catch (_) {
        if (gen === this.generation) {
          this._stopOldEngine();
          this._emitState();
        }
      }
    }

    _waitForPlayingAndProgress(gen, prePlayPos) {
      return new Promise((resolve) => {
        if (!this.engine || gen !== this.generation) return resolve(false);

        let settled = false;
        let sawPlaying = this.engine.getState?.() === 'PLAYING';
        let initialPos = Number.isFinite(prePlayPos) ? prePlayPos : (this.engine.getPosition?.() ?? 0);
        let unsubState = null;
        let unsubTime = null;

        const finish = (ok) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try { if (unsubState) unsubState(); } catch (_) {}
          try { if (unsubTime) unsubTime(); } catch (_) {}
          resolve(ok);
        };

        const check = () => {
          if (this._disposed || gen !== this.generation) return finish(false);
          const state = this.engine.getState?.();
          const pos = this.engine.getPosition?.() ?? 0;
          if (state === 'PLAYING') sawPlaying = true;
          if (sawPlaying && pos > initialPos) {
            return finish(true);
          }
        };

        const timer = setTimeout(() => finish(false), this.handoffTimeoutMs);

        if (typeof this.engine.on === 'function') {
          unsubState = this.engine.on('stateChange', (st) => {
            if (st === 'PLAYING') {
              sawPlaying = true;
              initialPos = this.engine.getPosition?.() ?? initialPos;
            }
            check();
          });
          unsubTime = this.engine.on('timeupdate', () => check());
        }
        check();
      });
    }

    _handleEngineError(code, track, resolved) {
      const numCode = Number(code);
      const songId = track?.id || track?.songId || '';
      if (numCode === 100 && songId && typeof this.invalidateMapping === 'function') {
        Promise.resolve(this.invalidateMapping(songId, 'error_100')).catch(() => {});
      }
      // 101/150: embed restricted -> keep mapping, fallback to Song
      // 2/5: player/param error -> keep mapping, fallback to Song
      this.switchToSong({ keepPreferred: true, resumePlayback: true });
      if (typeof this.onErrorNotice === 'function') {
        this.onErrorNotice({ code: numCode, track, resolved });
      }
    }

    dispose() {
      if (this._disposed) return;
      this._disposed = true;
      this.generation++;
      this._stopOldEngine();
      if (this.engine && typeof this.engine.dispose === 'function') {
        try { this.engine.dispose(); } catch (_) {}
      }
    }
  }

  if (typeof module !== 'undefined') {
    module.exports = MvSyncController;
  } else {
    window.MvSyncController = MvSyncController;
  }
})();
