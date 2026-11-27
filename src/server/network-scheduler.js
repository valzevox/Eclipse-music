// src/server/network-scheduler.js
// Central Network Priority Scheduler for Eclipse PC (clean-room MIT)
'use strict';

const Priority = Object.freeze({
  PLAYBACK_AUDIO: 1,
  PLAYBACK_SEEK: 2,
  PLAYBACK_META: 3,
  NEXT_TRACK_PREP: 4,
  VISIBLE_ARTWORK_LYRICS: 5,
  SPECULATIVE_PRELOAD: 6,
  BACKGROUND_DOWNLOAD: 7
});

const PROFILE_CONFIG = Object.freeze({
  constrained: {
    maxConcurrent: 2,
    firstBlockBytes: 64 * 1024,
    blockBytes: 128 * 1024,
    rangeWorkers: 1,
    artworkConcurrent: 2,
    allowSpeculative: false,
    allowAutoBackgroundDownload: false
  },
  normal: {
    maxConcurrent: 4,
    firstBlockBytes: 64 * 1024,
    blockBytes: 256 * 1024,
    rangeWorkers: 2,
    artworkConcurrent: 4,
    allowSpeculative: true,
    allowAutoBackgroundDownload: true
  },
  fast: {
    maxConcurrent: 6,
    firstBlockBytes: 64 * 1024,
    blockBytes: 256 * 1024,
    rangeWorkers: 4,
    artworkConcurrent: 8,
    allowSpeculative: true,
    allowAutoBackgroundDownload: true
  }
});

class NetworkPriorityScheduler {
  constructor(options = {}) {
    this.profile = PROFILE_CONFIG[options.profile] ? options.profile : 'normal';
    this.maxQueueSize = Number.isFinite(options.maxQueueSize) && options.maxQueueSize > 0 ? options.maxQueueSize : 64;
    this.autoCacheEnabled = Boolean(options.autoCacheEnabled);
    this.playbackBuffering = false;
    this.generation = 0;

    this._queue = [];
    this._active = new Map();
    this._inflightByKey = new Map();
    this._seq = 0;
  }

  getProfileConfig() {
    return { ...PROFILE_CONFIG[this.profile], profile: this.profile };
  }

  setProfile(profile) {
    if (PROFILE_CONFIG[profile]) {
      this.profile = profile;
      this._drain();
    }
  }

  setAutoCacheEnabled(enabled) {
    this.autoCacheEnabled = Boolean(enabled);
  }

  setPlaybackBuffering(isBuffering) {
    const next = Boolean(isBuffering);
    if (this.playbackBuffering === next) return;
    this.playbackBuffering = next;
    if (next) {
      for (const [id, task] of this._active.entries()) {
        if (task.priority >= Priority.SPECULATIVE_PRELOAD && task.abortController) {
          try { task.abortController.abort(new Error('preempted_by_playback_buffering')); } catch (_) {}
          this._active.delete(id);
        }
      }
    } else {
      this._drain();
    }
  }

  bumpGeneration() {
    this.generation += 1;
    this._queue = this._queue.filter((item) => {
      if (item.priority >= Priority.NEXT_TRACK_PREP && item.generation !== this.generation) {
        item.reject(Object.assign(new Error('stale_generation'), { code: 'STALE_GENERATION' }));
        return false;
      }
      return true;
    });
    return this.generation;
  }

  canRunBackgroundDownload({ explicitOptIn = false } = {}) {
    if (!explicitOptIn && !this.autoCacheEnabled) return false;
    if (this.playbackBuffering) return false;
    if (this.profile === 'constrained' && !explicitOptIn) return false;
    return true;
  }

  schedule({
    priority = Priority.SPECULATIVE_PRELOAD,
    key = null,
    generation = this.generation,
    explicitOptIn = false,
    fn
  }) {
    if (typeof fn !== 'function') {
      return Promise.reject(new Error('Scheduler task requires fn'));
    }

    if (priority === Priority.BACKGROUND_DOWNLOAD && !this.canRunBackgroundDownload({ explicitOptIn })) {
      return Promise.resolve({ skipped: true, reason: 'background_download_deferred' });
    }

    if (key && this._inflightByKey.has(key)) {
      return this._inflightByKey.get(key);
    }

    const promise = new Promise((resolve, reject) => {
      const entry = {
        id: ++this._seq,
        priority,
        key,
        generation,
        fn,
        resolve,
        reject,
        abortController: new AbortController()
      };

      if (this._queue.length >= this.maxQueueSize) {
        this._queue.sort((a, b) => a.priority - b.priority || a.id - b.id);
        const tail = this._queue[this._queue.length - 1];
        if (tail && tail.priority > priority) {
          this._queue.pop();
          tail.reject(Object.assign(new Error('queue_evicted'), { code: 'QUEUE_EVICTED' }));
        } else {
          reject(Object.assign(new Error('queue_full'), { code: 'QUEUE_FULL' }));
          return;
        }
      }

      this._queue.push(entry);
      this._queue.sort((a, b) => a.priority - b.priority || a.id - b.id);
      this._drain();
    });

    if (key) {
      this._inflightByKey.set(key, promise);
      promise.finally(() => {
        if (this._inflightByKey.get(key) === promise) {
          this._inflightByKey.delete(key);
        }
      }).catch(() => {});
    }

    return promise;
  }

  _drain() {
    const cfg = PROFILE_CONFIG[this.profile];
    while (this._active.size < cfg.maxConcurrent && this._queue.length > 0) {
      const nextIdx = this._queue.findIndex((item) => {
        if (this.playbackBuffering && item.priority >= Priority.SPECULATIVE_PRELOAD) {
          return false;
        }
        if (item.priority === Priority.BACKGROUND_DOWNLOAD && !this.canRunBackgroundDownload({ explicitOptIn: true })) {
          return false;
        }
        return true;
      });
      if (nextIdx === -1) break;

      const item = this._queue.splice(nextIdx, 1)[0];
      if (item.priority >= Priority.NEXT_TRACK_PREP && item.generation !== this.generation) {
        item.reject(Object.assign(new Error('stale_generation'), { code: 'STALE_GENERATION' }));
        continue;
      }

      this._active.set(item.id, item);
      Promise.resolve()
        .then(() => item.fn(item.abortController.signal))
        .then(
          (res) => {
            this._active.delete(item.id);
            item.resolve(res);
            this._drain();
          },
          (err) => {
            this._active.delete(item.id);
            item.reject(err);
            this._drain();
          }
        );
    }
  }

  getStats() {
    return {
      profile: this.profile,
      playbackBuffering: this.playbackBuffering,
      generation: this.generation,
      activeCount: this._active.size,
      queuedCount: this._queue.length,
      inflightKeys: this._inflightByKey.size
    };
  }
}

module.exports = {
  NetworkPriorityScheduler,
  Priority,
  PROFILE_CONFIG
};
