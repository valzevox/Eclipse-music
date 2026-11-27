// src/server/network-diagnostics.js
// Local structured performance diagnostics (zero telemetry upload, zero secret logging)
'use strict';

class NetworkDiagnostics {
  constructor() {
    this.startedAt = Date.now();
    this.startupToUiMs = null;
    this.homeReadyMs = null;

    this.streamInfo = {
      cacheHits: 0,
      cacheMisses: 0,
      totalResolutions: 0,
      avgResolutionMs: 0,
      lastResolutionMs: 0,
      stages: {
        cacheLookupMs: 0,
        directResolverMs: 0,
        ytDlpFallbackMs: 0,
        probeMs: 0
      }
    };

    this.audioProxy = {
      requests: 0,
      cacheHits: 0,
      cacheMisses: 0,
      upstreamErrors: 0,
      lastUpstreamStatus: null,
      avgTtfbMs: 0,
      lastTtfbMs: 0,
      firstPlayingMs: null,
      firstBufferedMs: null,
      waitingCount: 0,
      waitingTotalMs: 0
    };

    this.bytesByCategory = {
      playback: 0,
      prefetch: 0,
      backgroundDownload: 0,
      artwork: 0
    };

    this.imageCache = {
      hits: 0,
      staleHits: 0,
      misses: 0,
      decodeFailures: 0
    };
  }

  recordStartupUi(ms) {
    if (Number.isFinite(ms) && ms >= 0) this.startupToUiMs = Math.round(ms);
  }

  recordHomeReady(ms) {
    if (Number.isFinite(ms) && ms >= 0) this.homeReadyMs = Math.round(ms);
  }

  recordStreamInfo({ hit = false, durationMs = 0, stage = null } = {}) {
    if (hit) this.streamInfo.cacheHits += 1;
    else this.streamInfo.cacheMisses += 1;

    const n = this.streamInfo.totalResolutions;
    this.streamInfo.totalResolutions = n + 1;
    this.streamInfo.lastResolutionMs = Math.round(durationMs);
    this.streamInfo.avgResolutionMs = Math.round(
      (this.streamInfo.avgResolutionMs * n + durationMs) / (n + 1)
    );

    if (stage && typeof stage === 'object') {
      for (const k of ['cacheLookupMs', 'directResolverMs', 'ytDlpFallbackMs', 'probeMs']) {
        if (Number.isFinite(stage[k])) {
          this.streamInfo.stages[k] = Math.round(stage[k]);
        }
      }
    }
  }

  recordProxyRequest({ cacheHit = false, upstreamStatus = null, ttfbMs = null, bytes = 0, category = 'playback' } = {}) {
    this.audioProxy.requests += 1;
    if (cacheHit) this.audioProxy.cacheHits += 1;
    else this.audioProxy.cacheMisses += 1;

    if (Number.isFinite(upstreamStatus)) {
      this.audioProxy.lastUpstreamStatus = upstreamStatus;
      if (upstreamStatus >= 400) this.audioProxy.upstreamErrors += 1;
    }

    if (Number.isFinite(ttfbMs) && ttfbMs >= 0) {
      const prevCount = Math.max(0, this.audioProxy.cacheMisses - 1);
      this.audioProxy.lastTtfbMs = Math.round(ttfbMs);
      this.audioProxy.avgTtfbMs = Math.round(
        (this.audioProxy.avgTtfbMs * prevCount + ttfbMs) / Math.max(1, this.audioProxy.cacheMisses)
      );
    }

    this.addBytes(category, bytes);
  }

  recordPlaybackTiming({ firstPlayingMs = null, firstBufferedMs = null, waitingDeltaMs = 0 } = {}) {
    if (Number.isFinite(firstPlayingMs) && firstPlayingMs >= 0) {
      this.audioProxy.firstPlayingMs = Math.round(firstPlayingMs);
    }
    if (Number.isFinite(firstBufferedMs) && firstBufferedMs >= 0) {
      this.audioProxy.firstBufferedMs = Math.round(firstBufferedMs);
    }
    if (Number.isFinite(waitingDeltaMs) && waitingDeltaMs > 0) {
      this.audioProxy.waitingCount += 1;
      this.audioProxy.waitingTotalMs += Math.round(waitingDeltaMs);
    }
  }

  addBytes(category, bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return;
    if (Object.prototype.hasOwnProperty.call(this.bytesByCategory, category)) {
      this.bytesByCategory[category] += Math.round(bytes);
    }
  }

  recordImageCache({ hit = false, stale = false, decodeFailed = false } = {}) {
    if (decodeFailed) {
      this.imageCache.decodeFailures += 1;
      return;
    }
    if (hit) {
      this.imageCache.hits += 1;
      if (stale) this.imageCache.staleHits += 1;
    } else {
      this.imageCache.misses += 1;
    }
  }

  classifyBottleneck() {
    if (this.bytesByCategory.backgroundDownload > this.bytesByCategory.playback && this.audioProxy.waitingCount > 0) {
      return 'background_contention';
    }
    if (this.streamInfo.avgResolutionMs > 1500) {
      return 'stream_extraction';
    }
    if (this.audioProxy.avgTtfbMs > 800) {
      return 'upstream_ttfb';
    }
    if (this.audioProxy.waitingCount >= 2 || this.audioProxy.waitingTotalMs > 2000) {
      return 'audio_transfer';
    }
    if (this.imageCache.misses > 20 && this.bytesByCategory.artwork > this.bytesByCategory.playback) {
      return 'artwork_burst';
    }
    return 'healthy';
  }

  getSummary() {
    return {
      uptimeMs: Date.now() - this.startedAt,
      startupToUiMs: this.startupToUiMs,
      homeReadyMs: this.homeReadyMs,
      bottleneck: this.classifyBottleneck(),
      streamInfo: { ...this.streamInfo, stages: { ...this.streamInfo.stages } },
      audioProxy: { ...this.audioProxy },
      bytesByCategory: { ...this.bytesByCategory },
      imageCache: { ...this.imageCache }
    };
  }
}

module.exports = { NetworkDiagnostics };
