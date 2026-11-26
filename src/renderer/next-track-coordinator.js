// src/renderer/next-track-coordinator.js
// JavaScript / next-track-coordinator.js / Web / Eclipse PC
// Single source of truth for next-track selection (Normal Queue, Shuffle, AutoMix DJ) with reserve/peek/commit/cancel lifecycle.

class NextTrackCoordinator {
  constructor(options = {}) {
    this.getState = options.getState || (() => ({ queue: [], queueIndex: -1, queueHistory: [], repeatMode: 'off' }));
    this.getAutoMix = options.getAutoMix || (() => null);
    this.getTrackAnalyzer = options.getTrackAnalyzer || (() => null);
    this.getShuffleProvider = options.getShuffleProvider || (() => null);
    this.isTrackBlocked = options.isTrackBlocked || (() => false);
    this.isArtistBlocked = options.isArtistBlocked || (() => false);
    this.isSameTrack = options.isSameTrack || ((a, b) => !!(a && b && (a === b || (a.id && a.id === b.id))));
    this.onCancel = options.onCancel || null;

    this.generation = 0;
    this.reservation = null;
    this._pendingReservePromise = null;
  }

  getActivePolicy() {
    const st = this.getState() || {};
    const am = this.getAutoMix();
    const queue = Array.isArray(st.queue) ? st.queue : [];
    return {
      autoMixEnabled: !!(am && am.enabled),
      autoMixMode: (am && am.mode) || 'equal_power',
      isShuffle: !!st.isShuffle,
      repeatMode: st.repeatMode || 'off',
      queueIndex: typeof st.queueIndex === 'number' ? st.queueIndex : -1,
      queueLength: queue.length
    };
  }

  _policySignature(p) {
    return `${p.autoMixEnabled}:${p.autoMixMode}:${p.isShuffle}:${p.repeatMode}:${p.queueIndex}:${p.queueLength}`;
  }

  peek() {
    if (!this.reservation || this.reservation.committed) return null;
    if (this.reservation.generation !== this.generation) return null;
    const sig = this._policySignature(this.getActivePolicy());
    if (this.reservation.policySig !== sig) return null;
    const st = this.getState() || {};
    const queue = Array.isArray(st.queue) ? st.queue : [];
    const t = queue[this.reservation.targetIndex];
    if (!t || !this.isSameTrack(t, this.reservation.track)) return null;
    return this.reservation;
  }

  cancel(reason = 'invalidated') {
    this.generation += 1;
    this._pendingReservePromise = null;
    const hadReservation = !!(this.reservation && !this.reservation.committed);
    this.reservation = null;
    if (hadReservation) {
      const provider = this.getShuffleProvider();
      if (provider && typeof provider.cancel === 'function') {
        try { provider.cancel(reason); } catch (_) {}
      }
    }
    if (typeof this.onCancel === 'function') {
      try { this.onCancel(reason); } catch (_) {}
    }
  }

  _pickNormalNext(st) {
    const queue = Array.isArray(st.queue) ? st.queue : [];
    if (queue.length === 0) return null;
    let nextIdx = (typeof st.queueIndex === 'number' ? st.queueIndex : -1) + 1;
    let attempts = 0;
    while (attempts < queue.length) {
      if (nextIdx >= queue.length) {
        if (st.repeatMode === 'all') {
          nextIdx = 0;
        } else {
          return null;
        }
      }
      const candidate = queue[nextIdx];
      if (candidate && (this.isTrackBlocked(candidate) || this.isArtistBlocked(candidate.artist))) {
        nextIdx += 1;
        attempts += 1;
        continue;
      }
      if (candidate) {
        return { policy: 'normal', targetIndex: nextIdx, track: candidate, compatible: true };
      }
      break;
    }
    return null;
  }

  async _pickShuffleNext(st) {
    const queue = Array.isArray(st.queue) ? st.queue : [];
    if (queue.length === 0) return null;
    const provider = this.getShuffleProvider();
    let nextIdx = -1;
    if (provider) {
      try {
        const ctx = {
          queue: queue.slice(),
          queueIndex: st.queueIndex,
          context: st.currentTrackContext,
          current: st.currentTrack
        };
        const pick = typeof provider.reserve === 'function'
          ? await provider.reserve(ctx)
          : (typeof provider.fn === 'function' ? await provider.fn(ctx) : null);
        if (pick) {
          const found = queue.findIndex(track => this.isSameTrack(track, pick));
          if (found >= 0 && !this.isTrackBlocked(queue[found]) && !this.isArtistBlocked(queue[found]?.artist)) {
            nextIdx = found;
          }
        }
      } catch (e) {
        console.warn('[NextTrackCoordinator] shuffle provider error:', e && e.message ? e.message : e);
      }
    }
    if (nextIdx < 0) {
      const eligible = queue
        .map((_, index) => index)
        .filter(index => !this.isTrackBlocked(queue[index]) && !this.isArtistBlocked(queue[index]?.artist));
      if (eligible.length === 0) return null;
      const history = Array.isArray(st.queueHistory) ? st.queueHistory : [];
      const recent = new Set(history.slice(-Math.max(1, Math.floor(eligible.length / 2))));
      const pool = eligible.filter(index => !recent.has(index));
      const candidates = pool.length ? pool : eligible;
      nextIdx = candidates[Math.floor(Math.random() * candidates.length)];
    }
    if (nextIdx < 0 || nextIdx >= queue.length) return null;
    return { policy: 'shuffle', targetIndex: nextIdx, track: queue[nextIdx], compatible: true };
  }

  async reserve() {
    const existing = this.peek();
    if (existing) return existing;
    if (this._pendingReservePromise) return this._pendingReservePromise;

    const myGen = this.generation;
    const policy = this.getActivePolicy();
    const policySig = this._policySignature(policy);

    this._pendingReservePromise = (async () => {
      try {
        const st = this.getState() || {};
        const queue = Array.isArray(st.queue) ? st.queue : [];
        if (queue.length === 0) return null;

        const am = this.getAutoMix();
        const analyzer = this.getTrackAnalyzer();
        let chosen = null;

        // 1. AutoMix Tempo Synced takes priority when enabled
        if (policy.autoMixEnabled && policy.autoMixMode === 'tempo_synced' && am && typeof am.pickTempoSyncedNext === 'function') {
          const curTrack = st.currentTrack || queue[st.queueIndex];
          const curBpm = (analyzer && typeof analyzer.getEffectiveBpm === 'function')
            ? analyzer.getEffectiveBpm(curTrack)
            : ((curTrack && curTrack._detectedBpm) || null);
          const picked = am.pickTempoSyncedNext(
            queue,
            st.queueIndex,
            st.autoMixPlayedIds,
            curBpm,
            { analyzer }
          );
          if (picked && picked.track && picked.compatible !== false) {
            chosen = {
              policy: 'tempo_synced',
              targetIndex: picked.index,
              track: picked.track,
              compatible: true
            };
          } else if (policy.isShuffle) {
            // Fallback to Shuffle if Tempo Synced found no compatible candidate and Shuffle is active
            chosen = await this._pickShuffleNext(st);
          } else if (picked && picked.track) {
            chosen = {
              policy: 'tempo_synced_fallback',
              targetIndex: picked.index,
              track: picked.track,
              compatible: false
            };
          }
        }

        // 2. Shuffle (including Equal Power + Shuffle)
        if (!chosen && policy.isShuffle) {
          chosen = await this._pickShuffleNext(st);
        }

        // 3. Normal Queue (including Equal Power without Shuffle)
        if (!chosen) {
          chosen = this._pickNormalNext(st);
        }

        if (myGen !== this.generation || !chosen || !chosen.track) return null;

        const plan = {
          token: `ntc_${myGen}_${Date.now()}`,
          generation: myGen,
          policySig,
          policy: chosen.policy,
          targetIndex: chosen.targetIndex,
          track: chosen.track,
          trackId: chosen.track.id || chosen.track.videoId || '',
          platform: String(chosen.track.platform || 'ytmusic').trim().toLowerCase(),
          compatible: chosen.compatible !== false,
          committed: false,
          createdAt: Date.now()
        };
        this.reservation = plan;
        return plan;
      } finally {
        if (this._pendingReservePromise) {
          this._pendingReservePromise = null;
        }
      }
    })();

    return this._pendingReservePromise;
  }

  commit(expectedToken = null) {
    const plan = this.peek();
    if (!plan) return null;
    if (expectedToken && plan.token !== expectedToken) return null;
    plan.committed = true;
    this.reservation = null;
    const provider = this.getShuffleProvider();
    if (provider && typeof provider.commit === 'function') {
      try { provider.commit(plan.track, plan.token); } catch (_) {}
    }
    return plan;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { NextTrackCoordinator };
}
if (typeof window !== 'undefined') {
  window.NextTrackCoordinator = NextTrackCoordinator;
}
