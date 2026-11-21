// src/renderer/automix/analysis-coordinator.js
/**
 * Eclipse AutoMix — Playlist / Album Analysis Coordinator
 *
 * Manages background batch audio analysis for a queue, playlist, or album
 * with bounded concurrency, priority ordering (current + next tracks first),
 * cancellation on context/mode switch, and isolated per-track error handling.
 *
 * Does NOT block playback. Integrates with TrackAnalyzer cache.
 */
(function (root) {
    'use strict';

    class AnalysisCoordinator {
        constructor(options = {}) {
            this.analyzer = options.analyzer || null;
            this.decodeAudio = options.decodeAudio || null; // async (track, signal) => { samples: Float32Array, sampleRate: number } | null
            this.concurrency = Math.max(1, Number(options.concurrency) || 2);
            this.onStatusChange = typeof options.onStatusChange === 'function' ? options.onStatusChange : null;

            this._activeJob = null;
            this._status = {
                state: 'idle', // idle | scanning | partial | ready | cancelled | error
                contextId: null,
                total: 0,
                completed: 0,
                cached: 0,
                failed: 0,
                activeWorkers: 0,
            };
        }

        getStatus() {
            return { ...this._status };
        }

        _emitStatus() {
            if (this.onStatusChange) {
                try { this.onStatusChange(this.getStatus()); } catch (_) { }
            }
        }

        /**
         * Cancel any active background scan cleanly.
         */
        cancel() {
            if (this._activeJob && !this._activeJob.cancelled) {
                this._activeJob.cancelled = true;
                if (this._activeJob.abortController) {
                    try { this._activeJob.abortController.abort(); } catch (_) { }
                }
                this._status.state = 'cancelled';
                this._status.activeWorkers = 0;
                this._emitStatus();
            }
        }

        /**
         * Scan a collection of tracks (queue, playlist, or album).
         * Prioritizes tracks starting at currentIndex, then lookahead, then remainder.
         *
         * @param {Array<object>} tracks
         * @param {string} contextId - stable identifier for the current queue/playlist
         * @param {object} [options] - { currentIndex?: number, maxTracks?: number }
         * @returns {Promise<object>} final status snapshot
         */
        async scanCollection(tracks, contextId, options = {}) {
            if (!Array.isArray(tracks) || tracks.length === 0) {
                this.cancel();
                this._status = {
                    state: 'idle',
                    contextId: contextId || null,
                    total: 0,
                    completed: 0,
                    cached: 0,
                    failed: 0,
                    activeWorkers: 0,
                };
                this._emitStatus();
                return this.getStatus();
            }

            // Cancel previous scan if a different context or restart is requested
            this.cancel();

            const maxTracks = Math.min(tracks.length, Number(options.maxTracks) || 50);
            const currentIndex = Math.max(0, Number(options.currentIndex) || 0);

            // Priority order: current track, next tracks after current, then preceding tracks
            const ordered = [];
            const seenIds = new Set();
            const pushUnique = (t) => {
                if (!t || ordered.length >= maxTracks) return;
                const key = (this.analyzer && typeof this.analyzer.getStableTrackId === 'function')
                    ? this.analyzer.getStableTrackId(t)
                    : (t.id || t.videoId || t.title);
                if (!key || seenIds.has(key)) return;
                seenIds.add(key);
                ordered.push(t);
            };

            for (let i = currentIndex; i < tracks.length && ordered.length < maxTracks; i++) {
                pushUnique(tracks[i]);
            }
            for (let i = 0; i < currentIndex && ordered.length < maxTracks; i++) {
                pushUnique(tracks[i]);
            }

            const abortController = typeof AbortController !== 'undefined' ? new AbortController() : null;
            const job = {
                id: `${contextId || 'queue'}_${Date.now()}`,
                cancelled: false,
                abortController,
            };
            this._activeJob = job;

            this._status = {
                state: 'scanning',
                contextId: contextId || null,
                total: ordered.length,
                completed: 0,
                cached: 0,
                failed: 0,
                activeWorkers: 0,
            };
            this._emitStatus();

            let cursor = 0;

            const worker = async () => {
                while (!job.cancelled) {
                    const idx = cursor++;
                    if (idx >= ordered.length) break;
                    const track = ordered[idx];

                    this._status.activeWorkers++;
                    try {
                        // Skip if already cached with audio-analysis
                        const existing = (this.analyzer && typeof this.analyzer.getCachedRecord === 'function')
                            ? this.analyzer.getCachedRecord(track)
                            : null;
                        if (existing && existing.bpmSource === 'audio-analysis' && existing.keySource === 'audio-analysis') {
                            this._status.cached++;
                            this._status.completed++;
                            this._emitStatus();
                            continue;
                        }

                        if (this.decodeAudio && this.analyzer) {
                            const pcm = await this.decodeAudio(track, abortController ? abortController.signal : undefined);
                            if (job.cancelled) break;
                            if (pcm && pcm.samples && pcm.sampleRate) {
                                this.analyzer.analyzeTrack(track, pcm.samples, pcm.sampleRate);
                            } else {
                                // Still record metadata-only analysis without fabricating BPM/key
                                this.analyzer.analyzeTrack(track, null, null);
                            }
                        } else if (this.analyzer) {
                            this.analyzer.analyzeTrack(track, null, null);
                        }

                        if (!job.cancelled) {
                            this._status.completed++;
                            this._emitStatus();
                        }
                    } catch (_) {
                        if (!job.cancelled) {
                            this._status.failed++;
                            this._status.completed++;
                            this._emitStatus();
                        }
                    } finally {
                        this._status.activeWorkers = Math.max(0, this._status.activeWorkers - 1);
                    }
                }
            };

            const workerCount = Math.min(this.concurrency, ordered.length);
            const workers = [];
            for (let w = 0; w < workerCount; w++) {
                workers.push(worker());
            }

            await Promise.all(workers);

            if (!job.cancelled && this._activeJob === job) {
                if (this._status.failed > 0 && this._status.failed === this._status.total) {
                    this._status.state = 'error';
                } else if (this._status.failed > 0) {
                    this._status.state = 'partial';
                } else {
                    this._status.state = 'ready';
                }
                this._status.activeWorkers = 0;
                this._emitStatus();
            }

            return this.getStatus();
        }
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { AnalysisCoordinator };
    }
    if (root) {
        root.EclipseAnalysisCoordinator = AnalysisCoordinator;
    }
})(typeof window !== 'undefined' ? window : globalThis);
