// src/renderer/karaoke-motion.js
// Eclipse PC — Fullscreen Karaoke & AutoMix Cinematic Motion Engine

(function () {
  'use strict';

  class KaraokeMotionController {
    constructor() {
      this.state = {
        phase: 'idle', // 'idle' | 'preparing' | 'mixing' | 'dominance' | 'settled' | 'cancelled' | 'error'
        transitionId: null,
        fromTrack: null,
        toTrack: null,
        durationSec: 0,
        progress: 0.0,
        outBpm: 120,
        inBpm: 120,
        tempoRatio: 1.0,
        incomingPositionSec: 0,
        countdownBeats: null
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
        chip.innerHTML = '<img class="tvk-up-next-thumb" src="" alt=""><div class="tvk-up-next-info"><span class="tvk-up-next-prefix">Up Next</span><span class="tvk-up-next-title"></span></div>';
        tvkMeta.appendChild(chip);
        this._domUpNext = chip;
      }
    }

    handleAutomixState(detail) {
      if (!detail) return;
      this._ensureDomElements();

      const tvk = typeof document !== 'undefined' ? document.getElementById('tv-karaoke') : null;
      const active = !!detail.active;

      if (!active) {
        const activeId = this.state.transitionId || null;
        const incomingId = detail.transitionId || null;

        // Terminal event lacking ownership token MUST NOT terminate an active transition with ID
        if (activeId && !incomingId) {
          return;
        }

        // Stale or different transitionId
        if (activeId && incomingId && incomingId !== activeId) {
          return;
        }

        // Idempotency: if already terminal for this transition, ignore duplicate terminal dispatch
        if (this.state.phase === 'settled' || this.state.phase === 'cancelled' || this.state.phase === 'error') {
          return;
        }

        if (detail.aborted) {
          this.state.phase = 'cancelled';
        } else if (detail.failed) {
          this.state.phase = 'error';
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
              this._terminalCleanupTimer = null;
            }
          }, 350);
        }

        if (this._domUpNext) {
          this._domUpNext.classList.add('hidden');
        }
        if (tvk) {
          tvk.classList.remove('is-automix-blend', 'is-automix-dominance');
        }
        this._notify();
        return;
      }

      // Mix Active - Clear any pending terminal timer from older transitions
      if (this._terminalCleanupTimer) {
        clearTimeout(this._terminalCleanupTimer);
        this._terminalCleanupTimer = null;
      }

      const incomingTxId = detail.transitionId || detail.token || ('tx-' + Date.now());
      this.state.transitionId = incomingTxId;
      this.state.phase = 'mixing';
      this.state.toTrack = detail.nextTrack || null;
      this.state.durationSec = detail.durationSec || 6.0;
      this.state.progress = 0.0;
      this.state.outBpm = detail.bpm || 120;

      if (tvk) tvk.classList.add('is-automix-blend');

      if (this._domPill) {
        this._domPill.classList.remove('hidden');
        this._domPill.classList.add('visible');
        const lbl = this._domPill.querySelector('.tvk-automix-label');
        if (lbl) lbl.textContent = detail.mode === 'tempo_synced' ? 'BEAT MIX' : (detail.mode === 'dj_mix' ? 'DJ MIX' : 'AUTOMIX');
        const fill = this._domPill.querySelector('.tvk-automix-progress-fill');
        if (fill) fill.style.width = '0%';
      }

      if (this._domUpNext && detail.nextTrack) {
        this._domUpNext.classList.remove('hidden');
        const img = this._domUpNext.querySelector('.tvk-up-next-thumb');
        const title = this._domUpNext.querySelector('.tvk-up-next-title');
        const prefix = this._domUpNext.querySelector('.tvk-up-next-prefix');
        if (img) img.src = detail.nextTrack.thumbnail || detail.nextTrack.cover || '';
        if (title) title.textContent = detail.nextTrack.title || '';
        if (prefix) prefix.textContent = 'Mixing into';
      }

      this._notify();
    }

    handleAutomixProgress(detail) {
      if (!detail) return;
      // Guard against stale progress from older transitions
      if (detail.transitionId && this.state.transitionId && detail.transitionId !== this.state.transitionId) {
        return;
      }
      if (this.state.phase !== 'mixing' && this.state.phase !== 'dominance') {
        return; // Transition not active
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
