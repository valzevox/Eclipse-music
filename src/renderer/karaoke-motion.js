// src/renderer/karaoke-motion.js
// Eclipse PC — Fullscreen Karaoke & AutoMix Cinematic Motion Engine

(function () {
  'use strict';

  class KaraokeMotionController {
    constructor() {
      this.state = {
        phase: 'idle', // 'idle' | 'mixing' | 'dominance' | 'settled' | 'cancelled' | 'error'
        transitionId: null,
        toTrack: null,
        durationSec: 0,
        progress: 0.0,
        outBpm: 120
      };

      this._subscribers = new Set();
      this._domPill = null;
      this._domUpNext = null;
      this._lastBassTime = -999999;
      this._bassPulseTimer = null;
      this._bassPulseGeneration = 0;
      this._terminalCleanupTimer = null;
      this._isSubscribed = false;
      this._onAutomixState = null;
      this._onAutomixProgress = null;
    }

    init() {
      if (this._isSubscribed) return;
      this._isSubscribed = true;

      if (typeof window !== 'undefined') {
        this._onAutomixState = (ev) => {
          this.handleAutomixState(ev.detail);
        };
        this._onAutomixProgress = (ev) => {
          this.handleAutomixProgress(ev.detail);
        };

        window.addEventListener('eclipse:automix-state', this._onAutomixState);
        window.addEventListener('eclipse:automix-progress', this._onAutomixProgress);
      }

      this._ensureDomElements();
    }

    dispose() {
      if (this._terminalCleanupTimer) {
        clearTimeout(this._terminalCleanupTimer);
        this._terminalCleanupTimer = null;
      }
      if (this._bassPulseTimer) {
        clearTimeout(this._bassPulseTimer);
        this._bassPulseTimer = null;
      }

      if (this._isSubscribed && typeof window !== 'undefined') {
        if (this._onAutomixState) {
          window.removeEventListener('eclipse:automix-state', this._onAutomixState);
          this._onAutomixState = null;
        }
        if (this._onAutomixProgress) {
          window.removeEventListener('eclipse:automix-progress', this._onAutomixProgress);
          this._onAutomixProgress = null;
        }
      }

      this._isSubscribed = false;
      this.state.phase = 'idle';
      this.state.transitionId = null;
      this._subscribers.clear();
    }

    _ensureDomElements() {
      if (typeof document === 'undefined') return;
      const tvkMeta = document.getElementById('tv-karaoke-meta');
      if (tvkMeta && !document.getElementById('tvk-automix-pill')) {
        const pill = document.createElement('div');
        pill.id = 'tvk-automix-pill';
        pill.className = 'tvk-automix-pill hidden';
        pill.innerHTML = '<div class="tvk-automix-dot"></div><span class="tvk-automix-label">MIXING</span><div class="tvk-automix-progress-bar"><div class="tvk-automix-progress-fill"></div></div>';
        tvkMeta.parentNode.insertBefore(pill, tvkMeta.nextSibling);
        this._domPill = pill;
      }

      if (tvkMeta && !document.getElementById('tvk-up-next-chip')) {
        const chip = document.createElement('div');
        chip.id = 'tvk-up-next-chip';
        chip.className = 'tvk-up-next-chip hidden';
        chip.innerHTML = '<img class="tvk-up-next-thumb hidden" src="" alt=""><div class="tvk-up-next-info"><div class="tvk-up-next-header"><span class="tvk-up-next-prefix">UP NEXT</span><span class="tvk-up-next-badge">AUTOMIX</span></div><span class="tvk-up-next-title"></span><span class="tvk-up-next-artist"></span></div>';
        tvkMeta.appendChild(chip);
        this._domUpNext = chip;
      }
    }

    _renderUpNextChip(phase, detail) {
      if (!this._domUpNext) return;
      const track = (detail && detail.nextTrack) || this.state.toTrack;
      if (!track || !track.title) {
        this._domUpNext.classList.add('hidden');
        this._domUpNext.classList.remove('is-preparing', 'is-ready', 'is-mixing', 'is-dominance');
        return;
      }

      this._domUpNext.classList.remove('hidden', 'is-preparing', 'is-ready', 'is-mixing', 'is-dominance');
      this._domUpNext.classList.add(`is-${phase}`);

      const img = this._domUpNext.querySelector('.tvk-up-next-thumb');
      const title = this._domUpNext.querySelector('.tvk-up-next-title');
      const artist = this._domUpNext.querySelector('.tvk-up-next-artist');
      const prefix = this._domUpNext.querySelector('.tvk-up-next-prefix');
      const badge = this._domUpNext.querySelector('.tvk-up-next-badge');

      const thumbUrl = track.thumbnail || track.cover || '';
      if (img) {
        if (thumbUrl) {
          img.src = thumbUrl;
          img.classList.remove('hidden');
        } else {
          img.removeAttribute('src');
          img.classList.add('hidden');
        }
      }
      if (title) title.textContent = track.title || '';
      if (artist) {
        artist.textContent = track.artist || '';
        artist.classList.toggle('hidden', !track.artist);
      }
      if (badge) {
        const mode = (detail && detail.mode) || this.state.mode || 'equal_power';
        badge.textContent = mode === 'tempo_synced' ? 'BEAT MIX' : 'AUTOMIX';
      }
      if (prefix) {
        if (phase === 'preparing') prefix.textContent = 'UP NEXT';
        else if (phase === 'ready') prefix.textContent = 'UP NEXT · READY';
        else if (phase === 'mixing') prefix.textContent = 'CROSSFADING';
        else if (phase === 'dominance') prefix.textContent = 'NOW MIXING';
      }
    }

    syncDomFromState() {
      this._ensureDomElements();
      const tvk = typeof document !== 'undefined' ? document.getElementById('tv-karaoke') : null;
      const phase = this.state.phase;
      const isActive = phase === 'preparing' || phase === 'ready' || phase === 'mixing' || phase === 'dominance';

      if (!isActive) {
        if (this._domPill) {
          this._domPill.classList.remove('visible');
          this._domPill.classList.add('hidden');
        }
        if (this._domUpNext) {
          this._domUpNext.classList.add('hidden');
          this._domUpNext.classList.remove('is-preparing', 'is-ready', 'is-mixing', 'is-dominance');
        }
        if (tvk) tvk.classList.remove('is-automix-blend', 'is-automix-dominance');
        return;
      }

      this._renderUpNextChip(phase, { nextTrack: this.state.toTrack, mode: this.state.mode });

      if (phase === 'mixing' || phase === 'dominance') {
        if (tvk) {
          tvk.classList.toggle('is-automix-blend', phase === 'mixing');
          tvk.classList.toggle('is-automix-dominance', phase === 'dominance');
        }
        if (this._domPill) {
          this._domPill.classList.remove('hidden');
          this._domPill.classList.add('visible');
          const lbl = this._domPill.querySelector('.tvk-automix-label');
          if (lbl) lbl.textContent = this.state.mode === 'tempo_synced' ? 'BEAT MIX' : 'AUTOMIX';
          const fill = this._domPill.querySelector('.tvk-automix-progress-fill');
          if (fill) fill.style.width = `${(Math.max(0, Math.min(1, this.state.progress || 0)) * 100).toFixed(1)}%`;
        }
      } else {
        if (tvk) tvk.classList.remove('is-automix-blend', 'is-automix-dominance');
        if (this._domPill) {
          this._domPill.classList.remove('visible');
          this._domPill.classList.add('hidden');
        }
      }
    }

    handleAutomixState(detail) {
      if (!detail) return;
      this._ensureDomElements();

      const tvk = typeof document !== 'undefined' ? document.getElementById('tv-karaoke') : null;
      const phase = detail.phase || (detail.active ? 'mixing' : (detail.failed ? 'failed' : (detail.aborted ? 'cancelled' : 'settled')));
      const active = typeof detail.active === 'boolean'
        ? detail.active
        : (phase === 'preparing' || phase === 'ready' || phase === 'mixing' || phase === 'dominance');

      if (!active) {
        const activeId = this.state.transitionId || null;
        const incomingId = (detail.transitionId && String(detail.transitionId).trim()) || null;

        // Terminal event is invalid if controller is idle or lacks an active transition
        if (!activeId || this.state.phase === 'idle') {
          return;
        }

        // Terminal event without valid token or mismatching active transition MUST be ignored
        if (!incomingId || incomingId !== activeId) {
          return;
        }

        // Idempotency: if already terminal for this transition, ignore duplicate terminal dispatch
        if (this.state.phase === 'settled' || this.state.phase === 'cancelled' || this.state.phase === 'error') {
          return;
        }

        if (detail.failed || phase === 'failed') {
          this.state.phase = 'error';
        } else if (detail.aborted || phase === 'cancelled') {
          this.state.phase = 'cancelled';
        } else {
          this.state.phase = 'settled';
          this.state.progress = 1.0;
        }

        const terminalTxId = this.state.transitionId;

        if (this._terminalCleanupTimer) {
          clearTimeout(this._terminalCleanupTimer);
          this._terminalCleanupTimer = null;
        }

        if (this._domPill) {
          this._domPill.classList.remove('visible');
          this._terminalCleanupTimer = setTimeout(() => {
            // Timer from transition A must never clean up transition B
            if (this.state.transitionId !== terminalTxId) return;
            if (this.state.phase === 'settled' || this.state.phase === 'cancelled' || this.state.phase === 'error') {
              if (this._domPill) this._domPill.classList.add('hidden');
              this.state.phase = 'idle';
              this.state.transitionId = null;
              this.state.toTrack = null;
              this._terminalCleanupTimer = null;
            }
          }, 350);
        } else {
          this.state.phase = 'idle';
          this.state.transitionId = null;
          this.state.toTrack = null;
        }

        if (this._domUpNext) {
          this._domUpNext.classList.add('hidden');
          this._domUpNext.classList.remove('is-preparing', 'is-ready', 'is-mixing', 'is-dominance');
        }
        if (tvk) {
          tvk.classList.remove('is-automix-blend', 'is-automix-dominance');
        }
        this._notify();
        return;
      }

      // Active phase: clear any pending terminal timer from older transitions
      if (this._terminalCleanupTimer) {
        clearTimeout(this._terminalCleanupTimer);
        this._terminalCleanupTimer = null;
      }

      const incomingTxId = detail.transitionId || detail.token || ('tx-' + Date.now());
      const isSameTx = this.state.transitionId === incomingTxId;

      // Ignore stale ready/preparing if already mixing/dominance for the same transition
      if (isSameTx && (this.state.phase === 'mixing' || this.state.phase === 'dominance') && (phase === 'preparing' || phase === 'ready')) {
        return;
      }

      this.state.transitionId = incomingTxId;
      this.state.mode = detail.mode || this.state.mode || 'equal_power';
      if (detail.nextTrack) this.state.toTrack = detail.nextTrack;
      else if (!isSameTx) this.state.toTrack = null;
      this.state.durationSec = detail.durationSec || this.state.durationSec || 6.0;
      this.state.outBpm = detail.bpm || this.state.outBpm || 120;

      if (phase === 'preparing' || phase === 'ready') {
        this.state.phase = phase;
        this.state.progress = 0.0;
        if (tvk) tvk.classList.remove('is-automix-blend', 'is-automix-dominance');
        if (this._domPill) {
          this._domPill.classList.remove('visible');
          this._domPill.classList.add('hidden');
        }
        this._renderUpNextChip(phase, detail);
        this._notify();
        return;
      }

      if (phase === 'dominance') {
        const prevPhase = this.state.phase;
        this.state.phase = 'dominance';
        if (typeof detail.progress === 'number') {
          this.state.progress = Math.max(0, Math.min(1, detail.progress));
        }
        if (tvk) {
          tvk.classList.remove('is-automix-blend');
          tvk.classList.add('is-automix-dominance');
        }
        this._renderUpNextChip('dominance', detail);
        if (prevPhase !== 'dominance' && typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('eclipse:karaoke-dominant-switch', {
            detail: {
              transitionId: this.state.transitionId,
              toTrack: this.state.toTrack,
              progress: this.state.progress
            }
          }));
        }
        this._notify();
        return;
      }

      // Default active phase: 'mixing'
      this.state.phase = 'mixing';
      this.state.progress = typeof detail.progress === 'number' ? Math.max(0, Math.min(1, detail.progress)) : 0.0;

      if (tvk) {
        tvk.classList.remove('is-automix-dominance');
        tvk.classList.add('is-automix-blend');
      }

      if (this._domPill) {
        this._domPill.classList.remove('hidden');
        this._domPill.classList.add('visible');
        const lbl = this._domPill.querySelector('.tvk-automix-label');
        if (lbl) lbl.textContent = this.state.mode === 'tempo_synced' ? 'BEAT MIX' : 'AUTOMIX';
        const fill = this._domPill.querySelector('.tvk-automix-progress-fill');
        if (fill) fill.style.width = `${(this.state.progress * 100).toFixed(1)}%`;
      }

      this._renderUpNextChip('mixing', detail);
      this._notify();
    }

    handleAutomixProgress(detail) {
      if (!detail) return;
      if (this.state.phase !== 'mixing' && this.state.phase !== 'dominance') {
        return; // Transition not active
      }

      // Fail-closed guard: progress event MUST provide a non-empty token matching active transition
      const incomingTxId = (detail.transitionId && String(detail.transitionId).trim()) || null;
      if (!incomingTxId || !this.state.transitionId || incomingTxId !== this.state.transitionId) {
        return;
      }

      const progress = Math.max(0, Math.min(1, Number(detail.progress) || 0));
      this.state.progress = progress;

      if (this._domPill) {
        const fill = this._domPill.querySelector('.tvk-automix-progress-fill');
        if (fill) fill.style.width = `${(progress * 100).toFixed(1)}%`;
      }

      const tvk = typeof document !== 'undefined' ? document.getElementById('tv-karaoke') : null;
      if (progress >= 0.60 && this.state.phase !== 'dominance') {
        this.state.phase = 'dominance';
        if (tvk) {
          tvk.classList.remove('is-automix-blend');
          tvk.classList.add('is-automix-dominance');
        }
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('eclipse:karaoke-dominant-switch', {
            detail: {
              transitionId: this.state.transitionId,
              toTrack: this.state.toTrack,
              progress
            }
          }));
        }
      }

      this._notify();
    }

    // Process real audio bass energy from analyser for Bass Pulse with generation token
    triggerBassPulse(energy) {
      if (typeof document !== 'undefined') {
        if (document.body && document.body.classList.contains('perf')) return;
        if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      }

      const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      if (this._lastBassTime > 0 && (now - this._lastBassTime < 140)) return; // 140ms gate

      if (energy > 0.45) {
        this._lastBassTime = now;
        this._bassPulseGeneration += 1;
        const currentGen = this._bassPulseGeneration;

        if (this._bassPulseTimer) {
          clearTimeout(this._bassPulseTimer);
          this._bassPulseTimer = null;
        }

        const pulseRatio = Math.min(0.06, (energy - 0.45) * 0.10); // 4-6% scale
        const tvkBg = typeof document !== 'undefined' ? document.getElementById('tvk-ambient-bg') : null;
        if (tvkBg) {
          tvkBg.style.transform = `scale(${4 * (1.0 + pulseRatio)}) translateZ(0)`;
          this._bassPulseTimer = setTimeout(() => {
            if (this._bassPulseGeneration !== currentGen) return;
            if (tvkBg) tvkBg.style.transform = 'scale(4) translateZ(0)';
          }, 160);
        }
      }
    }

    subscribe(fn) {
      this._subscribers.add(fn);
      return () => this._subscribers.delete(fn);
    }

    _notify() {
      for (const fn of this._subscribers) {
        try { fn(this.state); } catch (_) {}
      }
    }
  }

  const instance = new KaraokeMotionController();
  if (typeof window !== 'undefined') {
    window.KaraokeMotionController = instance;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { KaraokeMotionController, instance };
  }
})();
