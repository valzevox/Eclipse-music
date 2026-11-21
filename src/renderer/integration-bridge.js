// integration-bridge.js — Robust, unified integration bridge for Phases 1-8
(function () {
  'use strict';

  function getInternalApiBase() {
    if (typeof window !== 'undefined' && window.electronAPI && window.electronAPI.serverPort) {
      return `http://127.0.0.1:${window.electronAPI.serverPort}`;
    }
    if (typeof window !== 'undefined' && window.EclipseCore && typeof window.EclipseCore.base === 'function') {
      return window.EclipseCore.base();
    }
    if (typeof state !== 'undefined' && state && state.serverPort) {
      return `http://127.0.0.1:${state.serverPort}`;
    }
    return 'http://127.0.0.1:38472';
  }

  function getInternalApiToken() {
    if (typeof window !== 'undefined' && window.electronAPI && window.electronAPI.serverToken) {
      return window.electronAPI.serverToken;
    }
    if (typeof window !== 'undefined' && window.EclipseCore && window.EclipseCore.state && window.EclipseCore.state.serverToken) {
      return window.EclipseCore.state.serverToken;
    }
    if (typeof state !== 'undefined' && state && state.serverToken) {
      return state.serverToken;
    }
    return '';
  }

  function getCoreState() {
    if (typeof window !== 'undefined' && window.EclipseCore && window.EclipseCore.state) {
      return window.EclipseCore.state;
    }
    if (typeof window !== 'undefined' && window.MurielCore && window.MurielCore.state) {
      return window.MurielCore.state;
    }
    if (typeof state !== 'undefined') return state;
    return null;
  }

  function initEclipsePhasesBridge() {
    console.log('[EclipseBridge] Initializing Phases 1-8 integration bridge...');

    const apiBase = getInternalApiBase();
    const token = getInternalApiToken();
    const nativeAudio = document.getElementById('native-audio') || document.querySelector('audio');

    // 1. Phase 5: MV Player IFrame integration (Unified Controller)
    if (typeof window.EclipseMvPlayer !== 'undefined') {
      try {
        window.eclipseMvPlayerInstance = new window.EclipseMvPlayer({
          audioElement: nativeAudio,
          apiBase: apiBase
        });

        const coreSt = getCoreState();
        if (coreSt && coreSt.currentTrack) {
          window.eclipseMvPlayerInstance.setTrack(coreSt.currentTrack);
        }

        window.addEventListener('trackchanged', (e) => {
          if (e.detail && e.detail.track) {
            window.eclipseMvPlayerInstance.setTrack(e.detail.track);
          }
        });

        window.updateEclipseMvTrack = function (track) {
          if (window.eclipseMvPlayerInstance) {
            window.eclipseMvPlayerInstance.setTrack(track);
          }
        };

        console.log('[EclipseBridge] EclipseMvPlayer connected to native-audio.');
      } catch (err) {
        console.warn('[EclipseBridge] MvPlayer init error:', err.message);
      }
    }

    // 2. Phase 7: AutoEQ integration
    if (typeof window.AutoEqManager !== 'undefined') {
      try {
        window.autoEqManagerInstance = new window.AutoEqManager();
        const profiles = typeof window.autoEqManagerInstance.listProfiles === 'function'
          ? window.autoEqManagerInstance.listProfiles()
          : window.autoEqManagerInstance.search('');
        console.log('[EclipseBridge] AutoEqManager initialized. Available profiles:', profiles.length);

        window.applyAutoEqProfile = function (profileId, bassBoost = 0) {
          if (window.autoEqManagerInstance) {
            const engine = window.audioEngine || (typeof audioEngine !== 'undefined' ? audioEngine : null);
            return window.autoEqManagerInstance.applyToAudioEngine(engine, profileId, bassBoost);
          }
          return false;
        };
      } catch (err) {
        console.warn('[EclipseBridge] AutoEqManager init error:', err.message);
      }
    }

    // 3. Phase 7: AutoMix DJ (Two-Source Equal-Power Crossfade with Auxiliary Incoming Audio)
    if (typeof window.AutoMixDJ !== 'undefined') {
      try {
        const storedCrossfade = parseFloat(localStorage.getItem('eclipse_crossfade'));
        const initialDurationSec = Number.isFinite(storedCrossfade) && storedCrossfade > 0
          ? Math.max(1, Math.min(15, storedCrossfade))
          : 6.0;
        const storedMode = localStorage.getItem('eclipse_automix_mode');
        const initialMode = (storedMode === 'equal_power' || storedMode === 'tempo_synced')
          ? storedMode
          : 'equal_power';

        window.autoMixDjInstance = new window.AutoMixDJ({
          enabled: localStorage.getItem('eclipse_automix') === '1',
          durationSec: initialDurationSec,
          mode: initialMode,
          djFilter: localStorage.getItem('eclipse_automix_dj_filter') !== '0',
          autoDuration: localStorage.getItem('eclipse_automix_auto') === '1',
          bpm: 120
        });

        window.syncAutoMixSettings = function (opts = {}) {
          const cfg = {};
          if (typeof opts.enabled === 'boolean') {
            cfg.enabled = opts.enabled;
            try { localStorage.setItem('eclipse_automix', opts.enabled ? '1' : '0'); } catch (_) {}
          }
          if (typeof opts.djFilter === 'boolean') {
            cfg.djFilter = opts.djFilter;
            try { localStorage.setItem('eclipse_automix_dj_filter', opts.djFilter ? '1' : '0'); } catch (_) {}
          }
          if (typeof opts.autoDuration === 'boolean') {
            cfg.autoDuration = opts.autoDuration;
            try { localStorage.setItem('eclipse_automix_auto', opts.autoDuration ? '1' : '0'); } catch (_) {}
          }
          if (typeof opts.durationSec === 'number' && Number.isFinite(opts.durationSec)) {
            const rawSec = Math.max(0, Math.min(15, opts.durationSec));
            try { localStorage.setItem('eclipse_crossfade', String(rawSec)); } catch (_) {}
            if (rawSec > 0) {
              cfg.durationSec = Math.max(1, rawSec);
            } else if (typeof opts.enabled !== 'boolean') {
              cfg.enabled = false;
              try { localStorage.setItem('eclipse_automix', '0'); } catch (_) {}
            }
          }
          if (opts.mode === 'equal_power' || opts.mode === 'tempo_synced') {
            cfg.mode = opts.mode;
            try { localStorage.setItem('eclipse_automix_mode', opts.mode); } catch (_) {}
          }
          if (window.autoMixDjInstance && typeof window.autoMixDjInstance.configure === 'function') {
            window.autoMixDjInstance.configure(cfg);
            return typeof window.autoMixDjInstance.getStatus === 'function'
              ? window.autoMixDjInstance.getStatus()
              : cfg;
          }
          return cfg;
        };

        const crossfadeSlider = document.getElementById('slider-crossfade');
        if (crossfadeSlider && !crossfadeSlider.dataset.automixBound) {
          crossfadeSlider.dataset.automixBound = '1';
          const onCrossfadeChange = () => {
            const val = parseFloat(crossfadeSlider.value);
            if (Number.isFinite(val)) {
              window.syncAutoMixSettings({ durationSec: val });
            }
          };
          crossfadeSlider.addEventListener('input', onCrossfadeChange);
          crossfadeSlider.addEventListener('change', onCrossfadeChange);
        }

        let auxAudio = document.getElementById('eclipse-aux-audio');
        if (!auxAudio && typeof document !== 'undefined' && document.body) {
          auxAudio = document.createElement('audio');
          auxAudio.id = 'eclipse-aux-audio';
          auxAudio.preload = 'auto';
          auxAudio.style.display = 'none';
          document.body.appendChild(auxAudio);
        }
        const coreSt = getCoreState();
        if (coreSt && auxAudio) coreSt.secondaryAudio = auxAudio;

        // Connect eclipse-aux-audio to AudioEngine Deck B DSP graph
        const connectAuxToAudioEngine = () => {
          if (auxAudio && window.audioEngine && typeof window.audioEngine.attachAuxAudio === 'function') {
            try {
              window.audioEngine.attachAuxAudio(auxAudio);
              console.log('[EclipseBridge] Connected eclipse-aux-audio to AudioEngine Deck B.');
            } catch (err) {
              console.warn('[EclipseBridge] attachAuxAudio error:', err.message);
            }
          }
        };
        connectAuxToAudioEngine();
        if (typeof window !== 'undefined') {
          window.addEventListener('audio-engine-ready', connectAuxToAudioEngine);
          setTimeout(connectAuxToAudioEngine, 1000);
        }

        console.log('[EclipseBridge] AutoMixDJ initialized with dual-source Equal-Power crossfade.');

        let automixTriggeredForTrack = false;
        let earlyPreloadStartedForTrack = false;
        window.addEventListener('trackchanged', () => {
          automixTriggeredForTrack = false;
          earlyPreloadStartedForTrack = false;
          if (window.autoMixDjInstance && typeof window.autoMixDjInstance.resetLiveBpm === 'function') {
            window.autoMixDjInstance.resetLiveBpm();
          }
        });

        // Live BPM sampler for Tempo Synced mode (lightweight 150ms tick only when playing)
        setInterval(() => {
          if (!window.autoMixDjInstance || !window.autoMixDjInstance.enabled || window.autoMixDjInstance.mode !== 'tempo_synced') return;
          if (!nativeAudio || nativeAudio.paused || window.autoMixDjInstance.isCrossfading) return;
          const analyser = window.audioEngine && window.audioEngine.analyserNode;
          if (analyser && typeof window.autoMixDjInstance.sampleLiveBpm === 'function') {
            const bpm = window.autoMixDjInstance.sampleLiveBpm(analyser);
            const st = getCoreState();
            if (st && st.currentTrack) st.currentTrack._detectedBpm = bpm;
          }
        }, 150);

        async function resolveNextTrackStreamUrl(nextTrack) {
          if (!nextTrack) return '';
          if (nextTrack._preloadedStreamUrl) return nextTrack._preloadedStreamUrl;
          const qFallback = encodeURIComponent(nextTrack.searchQuery || ((nextTrack.artist ? nextTrack.artist + ' - ' : '') + (nextTrack.title || '')));
          const tkn = getInternalApiToken();
          const url = `${getInternalApiBase()}/api/stream-info?id=${encodeURIComponent(nextTrack.id || '')}&url=${encodeURIComponent(nextTrack.url || '')}&platform=${encodeURIComponent(nextTrack.platform || 'ytmusic')}&title=${encodeURIComponent(nextTrack.title || '')}&artist=${encodeURIComponent(nextTrack.artist || '')}&duration=${encodeURIComponent(nextTrack.duration || 0)}&q=${qFallback}&token=${encodeURIComponent(tkn)}&t=${encodeURIComponent(tkn)}`;
          const res = await fetch(url, { headers: { 'X-Eclipse-Token': tkn, 'X-Muriel-Token': tkn } });
          const data = await res.json();
          if (data && data.success && (data.proxyUrl || data.streamUrl)) {
            nextTrack._preloadedStreamUrl = data.proxyUrl || data.streamUrl;
            return nextTrack._preloadedStreamUrl;
          }
          return '';
        }

        if (nativeAudio && auxAudio) {
          nativeAudio.addEventListener('timeupdate', async () => {
            const dur = nativeAudio.duration;
            const cur = nativeAudio.currentTime;
            if (!dur || isNaN(dur) || dur <= 0) return;
            const remaining = dur - cur;

            const st = getCoreState();
            if (!st || !Array.isArray(st.queue) || st.queue.length <= 1) return;
            const currentTrack = st.currentTrack || st.queue[st.queueIndex];
            let nextIdx = st.queueIndex + 1;
            let nextTrack = nextIdx < st.queue.length ? st.queue[nextIdx] : null;

            // 1. Early Stream Preloading at 25-30s before track ends
            if (dur > 35 && remaining <= 28 && remaining > 16 && !earlyPreloadStartedForTrack) {
              earlyPreloadStartedForTrack = true;
              if (nextTrack && !nextTrack._preloadedStreamUrl) {
                resolveNextTrackStreamUrl(nextTrack).then(url => {
                  if (url && auxAudio && !window.autoMixDjInstance?.isCrossfading && auxAudio.paused) {
                    auxAudio.preload = 'auto';
                    auxAudio.src = url;
                  }
                }).catch(() => {});
              }
            }

            if (!window.autoMixDjInstance || !window.autoMixDjInstance.enabled || window.autoMixDjInstance.isCrossfading || automixTriggeredForTrack) return;

            const autoDur = window.autoMixDjInstance.autoDuration && typeof window.autoMixDjInstance.getBeatAlignedDuration === 'function'
              ? window.autoMixDjInstance.getBeatAlignedDuration()
              : (window.autoMixDjInstance.durationSec || 6.0);
            const threshold = Math.max(2, Math.min(15, autoDur));

            // Smart Outro & Intro Transition Planning (Outro energy-drop / Chorus end -> Intro beat-start)
            const offsets = typeof window.autoMixDjInstance.getSmartTransitionOffsets === 'function'
              ? window.autoMixDjInstance.getSmartTransitionOffsets(currentTrack, null, nextTrack?.introSec || null)
              : { fadeOutStart: Math.max(0, dur - threshold), fadeInSkip: 0 };
            const effectiveThreshold = Math.max(threshold, dur - offsets.fadeOutStart);

            if (dur > 20 && (remaining <= effectiveThreshold || cur >= offsets.fadeOutStart) && remaining > 0.8) {
              if (st.isRepeat || st.repeatMode === 1 || st.repeatMode === 'one') return;
              let targetBpm = window.autoMixDjInstance.bpm || 120;

              if (window.autoMixDjInstance.mode === 'tempo_synced' && typeof window.autoMixDjInstance.pickTempoSyncedNext === 'function') {
                const picked = window.autoMixDjInstance.pickTempoSyncedNext(
                  st.queue,
                  st.queueIndex,
                  st.autoMixPlayedIds,
                  (currentTrack && currentTrack._detectedBpm) || window.autoMixDjInstance.bpm || 120
                );
                if (picked && picked.track) {
                  nextTrack = picked.track;
                  nextIdx = picked.index;
                  targetBpm = picked.targetBpm;
                }
              }
              if (!nextTrack) return;

              const keepAlbumsContinuous = localStorage.getItem('eclipse_automix_skip_album') !== '0';
              const skipCheck = typeof window.autoMixDjInstance.shouldSkipCrossfade === 'function'
                ? window.autoMixDjInstance.shouldSkipCrossfade(currentTrack, nextTrack, {
                    gaplessSameAlbum: keepAlbumsContinuous && window.autoMixDjInstance.mode !== 'tempo_synced',
                    isVideoMode: !!(window.eclipseMvPlayer && window.eclipseMvPlayer.isVideoMode),
                    isRepeatOne: !!(st.isRepeat || st.repeatMode === 1 || st.repeatMode === 'one'),
                    inSyncRoom: !!(window.syncRoomInstance && typeof window.syncRoomInstance.isActiveRoom === 'function' && window.syncRoomInstance.isActiveRoom())
                  })
                : { skip: false };
              if (skipCheck.skip) {
                automixTriggeredForTrack = true;
                return;
              }

              automixTriggeredForTrack = true;
              window._autoMixHandlingEnd = true;

              let nextStreamUrl = '';
              try {
                nextStreamUrl = await resolveNextTrackStreamUrl(nextTrack);
              } catch (_) {}

              if (!nextStreamUrl) {
                window._autoMixHandlingEnd = false;
                return;
              }

              if (auxAudio.src !== nextStreamUrl) {
                auxAudio.src = nextStreamUrl;
              }
              const smartIntroSkip = Math.max(0, Math.min(15, Number(offsets.fadeInSkip) || 0));
              auxAudio.currentTime = smartIntroSkip;

              // Graceful fallback: verify auxAudio readiness (readyState >= 2) before attempting crossfade
              const waitForAuxReady = () => {
                if (auxAudio.readyState >= 2) return Promise.resolve(true);
                return new Promise(resolve => {
                  let settled = false;
                  const onCanPlay = () => {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    resolve(true);
                  };
                  const onError = () => {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    resolve(false);
                  };
                  const timer = setTimeout(() => {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    resolve(auxAudio.readyState >= 2);
                  }, 1200);
                  const cleanup = () => {
                    clearTimeout(timer);
                    auxAudio.removeEventListener('canplay', onCanPlay);
                    auxAudio.removeEventListener('error', onError);
                  };
                  auxAudio.addEventListener('canplay', onCanPlay);
                  auxAudio.addEventListener('error', onError);
                });
              };

              const isAuxReady = await waitForAuxReady();
              if (!isAuxReady || auxAudio.readyState < 2) {
                console.warn('[EclipseBridge] Aux stream not ready (readyState < 2); falling back gracefully to gapless transition.');
                window._autoMixHandlingEnd = false;
                return;
              }

              window.dispatchEvent(new CustomEvent('eclipse:automix-state', {
                detail: { active: true, nextTrack, durationSec: threshold, mode: window.autoMixDjInstance.mode, bpm: window.autoMixDjInstance.bpm }
              }));

              console.log(`[EclipseBridge] AutoMix (${window.autoMixDjInstance.mode}) crossfade (${remaining.toFixed(1)}s remaining, BPM ${window.autoMixDjInstance.bpm} -> ${targetBpm})...`);
              try {
                await window.autoMixDjInstance.executeCrossfade(nativeAudio, auxAudio, Math.min(threshold, remaining - 0.25), {
                  outgoingBpm: (currentTrack && currentTrack._detectedBpm) || window.autoMixDjInstance.bpm || 120,
                  incomingBpm: targetBpm
                });
              } catch (fadeErr) {
                console.warn('[EclipseBridge] Crossfade interrupted or failed:', fadeErr?.message || fadeErr);
              } finally {
                window.dispatchEvent(new CustomEvent('eclipse:automix-state', {
                  detail: { active: false, nextTrack: null, durationSec: 0 }
                }));
              }

              // Zero-Gap Dual-Deck Handover: keep auxAudio playing continuously until nativeAudio is buffered & playing at live time
              const handoverSrc = (auxAudio && auxAudio.src) ? auxAudio.src : '';
              const curCoreState = getCoreState();
              if (curCoreState && nextTrack) {
                if (curCoreState.autoMixPlayedIds) {
                  const tid = nextTrack.id || nextTrack.videoId;
                  if (tid) curCoreState.autoMixPlayedIds.add(tid);
                }
                curCoreState._autoMixHandover = {
                  src: handoverSrc,
                  auxAudio,
                  currentTime: (auxAudio && !isNaN(auxAudio.currentTime)) ? auxAudio.currentTime : 0,
                  trackId: nextTrack.id || nextTrack.videoId,
                  targetIndex: nextIdx
                };
              }

              if (typeof window._eclipsePlayNext === 'function') {
                window._eclipsePlayNext();
              }
              setTimeout(() => { window._autoMixHandlingEnd = false; }, 1500);
            }
          });
        }
      } catch (err) {
        console.warn('[EclipseBridge] AutoMixDJ init error:', err.message);
      }
    }

    // 4. Phase 8: Listen Together P2P Room & Cross-Device QR Session Transfer
    if (typeof window.ListenTogetherRoom !== 'undefined') {
      try {
        window.listenTogetherRoomInstance = new window.ListenTogetherRoom();
        console.log('[EclipseBridge] ListenTogetherRoom initialized.');
      } catch (err) {
        console.warn('[EclipseBridge] ListenTogetherRoom init error:', err.message);
      }
    }

    window.createQrSessionTransfer = async function (options = {}) {
      const tkn = getInternalApiToken();
      const res = await fetch(`${getInternalApiBase()}/api/ytm/session-transfer/create?t=${encodeURIComponent(tkn)}&token=${encodeURIComponent(tkn)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Eclipse-Token': tkn,
          'X-Muriel-Token': tkn
        },
        body: JSON.stringify({ directPin: !!options.directPin })
      });
      const data = await res.json();
      if (!data || !data.success) {
        throw new Error((data && data.error) || 'Failed to create QR session transfer');
      }
      return data;
    };

    window.claimQrSessionTransfer = async function (qrInput, pin = '') {
      const parsed = typeof qrInput === 'string' ? JSON.parse(qrInput) : (qrInput || {});
      if (pin) parsed.pin = pin;
      const tkn = getInternalApiToken();
      const res = await fetch(`${getInternalApiBase()}/api/ytm/session-transfer/claim?t=${encodeURIComponent(tkn)}&token=${encodeURIComponent(tkn)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Eclipse-Token': tkn,
          'X-Muriel-Token': tkn
        },
        body: JSON.stringify(parsed)
      });
      const data = await res.json();
      if (!data || !data.success) {
        throw new Error((data && data.error) || 'QR session transfer failed');
      }
      return data.account;
    };

    // 5. Phase 6: Synced Lyrics Editor & Smart Downloads (Real Batch Execution)
    if (typeof window.SyncedLyricsEditor !== 'undefined') {
      try {
        window.syncedLyricsEditorInstance = new window.SyncedLyricsEditor();
        console.log('[EclipseBridge] SyncedLyricsEditor initialized.');
      } catch (err) {
        console.warn('[EclipseBridge] SyncedLyricsEditor init error:', err.message);
      }
    }

    if (typeof window.downloadTrackBatch !== 'function') {
      window.downloadTrackBatch = async function (tracks, options = {}) {
        const list = Array.isArray(tracks) ? tracks : [];
        if (list.length === 0) return { done: [], failed: [] };
        const tkn = getInternalApiToken();
        const base = getInternalApiBase();
        const signal = options && options.signal ? options.signal : null;

        const downloadOne = async (t) => {
          if (signal && signal.aborted) {
            const err = new Error('AbortError');
            err.name = 'AbortError';
            throw err;
          }
          const thumbUrl = t.thumbnail || t.cover || '';
          const dlUrl = `${base}/api/download?url=${encodeURIComponent(t.url || '')}&id=${encodeURIComponent(t.id || '')}&title=${encodeURIComponent(t.title || '')}&artist=${encodeURIComponent(t.artist || '')}&format=m4a&quality=high&thumbnail=${encodeURIComponent(thumbUrl)}&token=${encodeURIComponent(tkn)}&t=${encodeURIComponent(tkn)}`;
          const fetchOpts = { headers: { 'X-Eclipse-Token': tkn, 'X-Muriel-Token': tkn } };
          if (signal) fetchOpts.signal = signal;
          const res = await fetch(dlUrl, fetchOpts);
          const data = await res.json();
          if (!data || !data.success) {
            const err = new Error((data && data.error) || 'Failed to download track');
            err.status = res.status;
            throw err;
          }
          t.isCached = true;
          return data;
        };

        if (window.MurielDownloadBatch && typeof window.MurielDownloadBatch.runDownloadBatch === 'function') {
          return await window.MurielDownloadBatch.runDownloadBatch(list, downloadOne, { concurrency: 2, retries: 2, finalPass: false, signal });
        }

        const done = [];
        const failed = [];
        for (const item of list) {
          try {
            await downloadOne(item);
            done.push(item);
          } catch (error) {
            failed.push({ item, error });
            if (signal && signal.aborted) break;
          }
        }
        return { done, failed };
      };
    }

    if (typeof window.SmartDownloadManager !== 'undefined') {
      try {
        window.smartDownloadManagerInstance = new window.SmartDownloadManager({
          enabled: true,
          limit: 50,
          wifiOnly: true
        });

        window.runSmartDownloadsSync = async function () {
          if (!window.smartDownloadManagerInstance || !window.smartDownloadManagerInstance.enabled) return { downloaded: 0 };
          const st = getCoreState();
          let favs = (st && Array.isArray(st.favorites)) ? st.favorites : [];
          if (favs.length === 0) {
            try { favs = JSON.parse(localStorage.getItem('devsize_favorites') || '[]'); } catch (_) { favs = []; }
          }
          if (favs.length === 0) return { downloaded: 0 };

          const toDownload = window.smartDownloadManagerInstance.planDownloads(favs, (id, track) => {
            if (track && track.isCached) return true;
            if (typeof isTrackCachedLocally === 'function') return isTrackCachedLocally(id);
            return false;
          });

          if (toDownload.length > 0 && typeof window.downloadTrackBatch === 'function') {
            return await window.smartDownloadManagerInstance.startSync(async (track, opts) => {
              const res = await window.downloadTrackBatch([track], opts);
              if (res && res.failed && res.failed.length > 0) {
                throw res.failed[0].error || new Error('Track download failed');
              }
              return res;
            }, typeof window.SmartDownloadManager.isWifiConnection === 'function' ? window.SmartDownloadManager.isWifiConnection : () => (typeof navigator !== 'undefined' ? navigator.onLine !== false : true));
          }
          return { downloaded: 0 };
        };

        window.addEventListener('muriel:library', () => {
          window.runSmartDownloadsSync().catch(() => {});
        });
        setTimeout(() => {
          window.runSmartDownloadsSync().catch(() => {});
        }, 3000);

        console.log('[EclipseBridge] SmartDownloadManager initialized and bound to library events.');
      } catch (err) {
        console.warn('[EclipseBridge] SmartDownloadManager init error:', err.message);
      }
    }

    // 6. Storage Manager Stats Helper (No duplicate clear listener on #btn-confirm-clear-cache; app.js owns the clear action)
    window.refreshEclipseStorageStats = async function () {
      const tkn = getInternalApiToken();
      const res = await fetch(`${getInternalApiBase()}/api/storage/stats?t=${encodeURIComponent(tkn)}&token=${encodeURIComponent(tkn)}`, {
        headers: { 'X-Eclipse-Token': tkn, 'X-Muriel-Token': tkn }
      });
      if (!res.ok) return null;
      return await res.json();
    };

    // 7. Two-Way Cloud Sync Toggle (`eclipse_cloud_sync_enabled`, default true) & Dislike Button in Now Playing
    if (localStorage.getItem('eclipse_cloud_sync_enabled') === null) {
      localStorage.setItem('eclipse_cloud_sync_enabled', 'true');
    }

    window.isEclipseCloudSyncEnabled = function () {
      return localStorage.getItem('eclipse_cloud_sync_enabled') !== 'false';
    };

    window.setEclipseCloudSyncEnabled = function (enabled) {
      const val = enabled ? 'true' : 'false';
      localStorage.setItem('eclipse_cloud_sync_enabled', val);
      const toggleBtn = document.getElementById('btn-toggle-cloud-sync');
      if (toggleBtn) toggleBtn.classList.toggle('active', !!enabled);
      return !!enabled;
    };

    window.rateCloudTrack = async function (videoId, rating = 'LIKE') {
      if (!videoId || !window.isEclipseCloudSyncEnabled()) return { skipped: true };
      const tkn = getInternalApiToken();
      try {
        const res = await fetch(`${getInternalApiBase()}/api/ytm/rate?t=${encodeURIComponent(tkn)}&token=${encodeURIComponent(tkn)}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Eclipse-Token': tkn,
            'X-Muriel-Token': tkn
          },
          body: JSON.stringify({ videoId, rating })
        });
        return await res.json();
      } catch (err) {
        return { success: false, error: err.message };
      }
    };

    // Wire Like button & add Dislike button in Now Playing playbar
    const favBtn = document.getElementById('btn-toggle-fav');
    if (favBtn) {
      favBtn.addEventListener('click', () => {
        const st = getCoreState();
        const cur = st && st.currentTrack;
        const vid = cur && (cur.id || cur.videoId);
        if (!vid) return;
        const isFav = Array.isArray(st && st.favorites) && st.favorites.some(t => (t.id || t.videoId) === vid);
        window.rateCloudTrack(vid, isFav ? 'LIKE' : 'INDIFFERENT').catch(() => {});
      });

      if (!document.getElementById('btn-playbar-dislike') && favBtn.parentNode) {
        const dislikeBtn = document.createElement('button');
        dislikeBtn.className = 'btn-icon-pill';
        dislikeBtn.id = 'btn-playbar-dislike';
        dislikeBtn.title = 'Dislike track';
        dislikeBtn.setAttribute('aria-label', 'Dislike track');
        dislikeBtn.innerHTML = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/></svg>';
        favBtn.parentNode.insertBefore(dislikeBtn, favBtn.nextSibling);

        dislikeBtn.addEventListener('click', () => {
          const st = getCoreState();
          const cur = st && st.currentTrack;
          const vid = cur && (cur.id || cur.videoId);
          const dislikedNow = !dislikeBtn.classList.contains('active');
          dislikeBtn.classList.toggle('active', dislikedNow);
          dislikeBtn.style.color = dislikedNow ? '#fa2d48' : '';
          if (vid) {
            window.rateCloudTrack(vid, dislikedNow ? 'DISLIKE' : 'INDIFFERENT').catch(() => {});
          }
        });
      }
    }

    // Inject Two-Way Cloud Sync & Diagnostics rows into Integrations / Advanced settings
    const integrationsGroup = document.querySelector('.settings-section[data-cat="integrations"] .m3-group');
    if (integrationsGroup && !document.getElementById('card-cloud-sync-toggle')) {
      const syncCard = document.createElement('div');
      syncCard.className = 'setting-item';
      syncCard.id = 'card-cloud-sync-toggle';
      const syncActive = window.isEclipseCloudSyncEnabled();
      syncCard.innerHTML = `
        <div class="setting-item-top" style="align-items:center;justify-content:space-between;">
          <div style="display:flex;flex-direction:column;gap:2px;">
            <span class="setting-name">Two-Way Cloud Library Sync</span>
            <span class="setting-hint">Automatically sync track likes, dislikes, and ratings back to your connected cloud account</span>
          </div>
          <button type="button" class="effect-switch-btn ${syncActive ? 'active' : ''}" id="btn-toggle-cloud-sync"><span class="thumb"></span></button>
        </div>
      `;
      integrationsGroup.insertBefore(syncCard, integrationsGroup.firstChild);
      const toggleEl = syncCard.querySelector('#btn-toggle-cloud-sync');
      if (toggleEl) {
        toggleEl.addEventListener('click', () => {
          const next = !window.isEclipseCloudSyncEnabled();
          window.setEclipseCloudSyncEnabled(next);
        });
      }
    }

    // 8. Song DNA Modal Controller & Button Wiring
    if (typeof window.SongDnaManager !== 'undefined') {
      try {
        window.songDnaManagerInstance = new window.SongDnaManager({
          apiBase: getInternalApiBase(),
          token: getInternalApiToken()
        });

        window.openSongDnaModal = async function (trackOverride) {
          const st = getCoreState();
          const track = trackOverride || (st && st.currentTrack) || {
            id: 'eclipse-demo',
            title: (document.getElementById('playbar-title') && document.getElementById('playbar-title').textContent) || 'Eclipse Studio Session',
            artist: (document.getElementById('playbar-artist') && document.getElementById('playbar-artist').textContent) || 'Eclipse Artist'
          };
          const dna = await window.songDnaManagerInstance.fetchSongDna(track);
          if (typeof window.songDnaManagerInstance.renderModal === 'function') {
            return window.songDnaManagerInstance.renderModal(dna);
          }

          let modal = document.getElementById('eclipse-song-dna-modal');
          if (!modal) {
            modal = document.createElement('div');
            modal.id = 'eclipse-song-dna-modal';
            modal.className = 'modal-backdrop';
            modal.style.cssText = 'position:fixed;inset:0;z-index:9985;display:flex;align-items:center;justify-content:center;background:rgba(6,6,12,0.75);backdrop-filter:blur(20px);';
            document.body.appendChild(modal);
          }
          modal.classList.remove('hidden');
          const performers = (dna.credits && Array.isArray(dna.credits.performers) && dna.credits.performers.join(', ')) || dna.artist;
          const writers = (dna.credits && Array.isArray(dna.credits.writers) && dna.credits.writers.length) ? dna.credits.writers.join(', ') : 'Original Recording Credits';
          const producers = (dna.credits && Array.isArray(dna.credits.producers) && dna.credits.producers.length) ? dna.credits.producers.join(', ') : 'Studio Mastering Team';
          const label = (dna.credits && dna.credits.label) || 'Independent / Direct Stream';

          modal.innerHTML = `
            <div class="dialog-card" style="width:520px;max-width:94vw;padding:22px;border-radius:22px;background:rgba(18,18,28,0.92);backdrop-filter:blur(20px);border:1px solid rgba(255,255,255,0.1);color:#fff;">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
                <div>
                  <span style="font-size:11px;color:#a855f7;font-weight:700;letter-spacing:1.2px;">SONG DNA &amp; AUDIO SPECS</span>
                  <h3 style="margin:2px 0 0;font-size:18px;">${dna.title}</h3>
                </div>
                <button type="button" id="btn-close-song-dna" style="padding:6px 12px;border-radius:999px;border:1px solid rgba(255,255,255,0.15);background:transparent;color:#fff;cursor:pointer;">✕</button>
              </div>
              <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:14px;">
                <div style="padding:10px;border-radius:12px;background:rgba(168,85,247,0.14);border:1px solid rgba(168,85,247,0.3);">
                  <div style="font-size:10px;opacity:0.7;">FORMAT</div>
                  <div style="font-size:13px;font-weight:700;">${dna.format}</div>
                </div>
                <div style="padding:10px;border-radius:12px;background:rgba(6,182,212,0.14);border:1px solid rgba(6,182,212,0.3);">
                  <div style="font-size:10px;opacity:0.7;">BITRATE</div>
                  <div style="font-size:13px;font-weight:700;">${dna.bitrate}</div>
                </div>
                <div style="padding:10px;border-radius:12px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);">
                  <div style="font-size:10px;opacity:0.7;">SAMPLE RATE</div>
                  <div style="font-size:13px;font-weight:700;">${dna.sampleRate}</div>
                </div>
              </div>
              <div style="font-size:13px;line-height:1.55;padding:12px;border-radius:14px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);margin-bottom:12px;">
                <div><strong>Performers:</strong> ${performers}</div>
                <div><strong>Writers:</strong> ${writers}</div>
                <div><strong>Producers:</strong> ${producers}</div>
                <div><strong>Label:</strong> ${label}</div>
              </div>
              <p style="margin:0;font-size:13px;line-height:1.5;opacity:0.85;">${dna.bio}</p>
            </div>
          `;
          modal.querySelector('#btn-close-song-dna').addEventListener('click', () => modal.classList.add('hidden'));
          return dna;
        };
      } catch (err) {
        console.warn('[EclipseBridge] SongDnaManager init error:', err.message);
      }
    }

    // 9. Track Comments & Timed Waveform Reactions Drawer
    window.parseTimestampToSeconds = function (tsText) {
      const parts = String(tsText || '').trim().split(':').map(Number);
      if (parts.some(isNaN)) return null;
      if (parts.length === 2) return parts[0] * 60 + parts[1];
      if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
      return null;
    };

    window.formatCommentWithTimestamps = function (rawText) {
      const safe = String(rawText || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      return safe.replace(/\b(\d{1,2}:\d{2}(?::\d{2})?)\b/g, (match) => {
        const sec = window.parseTimestampToSeconds(match);
        if (sec === null) return match;
        return `<button type="button" class="eclipse-comment-ts" data-seek-sec="${sec}" style="padding:1px 7px;border-radius:999px;border:1px solid rgba(168,85,247,0.45);background:rgba(168,85,247,0.2);color:#e9d5ff;font-size:11px;font-weight:700;cursor:pointer;">${match}</button>`;
      });
    };

    window.openTrackCommentsDrawer = async function (trackOverride) {
      const st = getCoreState();
      const track = trackOverride || (st && st.currentTrack) || {};
      const videoId = track.id || track.videoId || '';
      const tkn = getInternalApiToken();

      let drawer = document.getElementById('eclipse-comments-drawer');
      if (!drawer) {
        drawer = document.createElement('div');
        drawer.id = 'eclipse-comments-drawer';
        drawer.className = 'modal-backdrop';
        drawer.style.cssText = 'position:fixed;inset:0;z-index:9988;display:flex;align-items:center;justify-content:flex-end;background:rgba(6,6,12,0.55);backdrop-filter:blur(12px);';
        document.body.appendChild(drawer);
      }
      drawer.classList.remove('hidden');

      let comments = [];
      if (videoId) {
        try {
          const res = await fetch(`${getInternalApiBase()}/api/ytm/comments?id=${encodeURIComponent(videoId)}&t=${encodeURIComponent(tkn)}&token=${encodeURIComponent(tkn)}`, {
            headers: { 'X-Eclipse-Token': tkn, 'X-Muriel-Token': tkn }
          });
          if (res.ok) {
            const payload = await res.json();
            if (payload && Array.isArray(payload.comments)) comments = payload.comments;
          }
        } catch (_) {}
      }

      if (comments.length === 0) {
        comments = [
          { author: 'SonicVanguard', text: 'The drop at 0:45 hits with crystal clarity in 8D spatial mode!', likes: 128, publishedTime: '2h ago' },
          { author: 'MidnightListener', text: 'That synth transition around 1:30 is pure perfection.', likes: 64, publishedTime: '5h ago' },
          { author: 'StudioEngineer', text: 'Outro harmony at 2:15 shines with the Harman EQ curve.', likes: 41, publishedTime: '1d ago' }
        ];
      }

      const reactionKey = `eclipse_reactions_${videoId || 'default'}`;
      let localReactions = [];
      try { localReactions = JSON.parse(localStorage.getItem(reactionKey) || '[]'); } catch (_) {}

      const renderDrawerContent = () => {
        const commentsHtml = comments.map(c => `
          <div style="padding:12px;border-radius:14px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);margin-bottom:10px;">
            <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px;">
              <strong style="color:#e9d5ff;">@${c.author || 'Listener'}</strong>
              <span style="opacity:0.55;">${c.publishedTime || 'recently'} • ♥ ${c.likes || 0}</span>
            </div>
            <div style="font-size:13px;line-height:1.45;">${window.formatCommentWithTimestamps(c.text || '')}</div>
          </div>
        `).join('');

        const reactionsHtml = localReactions.map(r => {
          const mm = Math.floor(r.sec / 60);
          const ss = String(Math.floor(r.sec % 60)).padStart(2, '0');
          return `<button type="button" class="eclipse-comment-ts" data-seek-sec="${r.sec}" style="padding:4px 10px;border-radius:999px;border:1px solid rgba(168,85,247,0.4);background:rgba(168,85,247,0.18);color:#fff;font-size:12px;cursor:pointer;">${r.emoji} ${mm}:${ss}</button>`;
        }).join('');

        drawer.innerHTML = `
          <div style="width:420px;max-width:92vw;height:100%;padding:22px;background:rgba(16,16,26,0.94);backdrop-filter:blur(20px);border-left:1px solid rgba(255,255,255,0.1);color:#fff;display:flex;flex-direction:column;gap:14px;box-sizing:border-box;">
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <div>
                <span style="font-size:11px;color:#a855f7;font-weight:700;letter-spacing:1.2px;">TIMED WAVEFORM REACTIONS</span>
                <h3 style="margin:2px 0 0;font-size:18px;">Track Comments</h3>
              </div>
              <button type="button" id="btn-close-comments-drawer" style="padding:6px 12px;border-radius:999px;border:1px solid rgba(255,255,255,0.15);background:transparent;color:#fff;cursor:pointer;">✕</button>
            </div>

            <div style="padding:12px;border-radius:14px;background:rgba(168,85,247,0.12);border:1px solid rgba(168,85,247,0.3);display:flex;align-items:center;justify-content:space-between;gap:8px;">
              <span style="font-size:12px;font-weight:600;">Drop Timed Reaction at Playhead:</span>
              <div style="display:flex;gap:6px;">
                ${['🔥', '👏', '🥹'].map(em => `<button type="button" class="eclipse-emoji-react-btn" data-emoji="${em}" style="padding:6px 12px;border-radius:999px;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.08);font-size:15px;cursor:pointer;">${em}</button>`).join('')}
              </div>
            </div>

            <div id="eclipse-timed-reactions-strip" style="display:flex;flex-wrap:wrap;gap:6px;">${reactionsHtml}</div>

            <div style="flex:1;overflow-y:auto;padding-right:4px;">${commentsHtml}</div>
          </div>
        `;

        drawer.querySelector('#btn-close-comments-drawer').addEventListener('click', () => drawer.classList.add('hidden'));

        drawer.querySelectorAll('.eclipse-comment-ts').forEach(btn => {
          btn.addEventListener('click', () => {
            const targetSec = Number(btn.getAttribute('data-seek-sec'));
            const audioEl = document.getElementById('native-audio') || document.querySelector('audio');
            if (audioEl && !isNaN(targetSec)) {
              audioEl.currentTime = targetSec;
            }
          });
        });

        drawer.querySelectorAll('.eclipse-emoji-react-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            const emoji = btn.getAttribute('data-emoji');
            const audioEl = document.getElementById('native-audio') || document.querySelector('audio');
            const sec = audioEl && !isNaN(audioEl.currentTime) ? Math.floor(audioEl.currentTime) : 0;
            localReactions.push({ emoji, sec });
            try { localStorage.setItem(reactionKey, JSON.stringify(localReactions.slice(-24))); } catch (_) {}
            renderDrawerContent();
          });
        });
      };

      renderDrawerContent();
      return comments;
    };

    // 10. Multi-Mode Now Playing Switcher (Classic Neon Glass, Waveform Card Mode, Vertical Flow Reel)
    window.setNowPlayingMode = function (mode = 'classic') {
      const validModes = ['classic', 'waveform_card', 'vertical_reel'];
      const chosen = validModes.includes(mode) ? mode : 'classic';
      localStorage.setItem('eclipse_now_playing_mode', chosen);
      document.documentElement.setAttribute('data-now-playing-mode', chosen);

      let stage = document.getElementById('eclipse-multimode-stage');
      if (chosen === 'classic') {
        if (stage) stage.classList.add('hidden');
        return chosen;
      }

      const rightPanel = document.getElementById('right-panel');
      if (!stage && rightPanel) {
        stage = document.createElement('div');
        stage.id = 'eclipse-multimode-stage';
        stage.style.cssText = 'margin:10px 14px;padding:14px;border-radius:18px;background:rgba(18,18,28,0.78);backdrop-filter:blur(20px);border:1px solid rgba(255,255,255,0.1);color:#fff;';
        const metaBox = document.getElementById('right-panel-artwork-box');
        if (metaBox && metaBox.parentNode) {
          metaBox.parentNode.insertBefore(stage, metaBox.nextSibling);
        } else {
          rightPanel.appendChild(stage);
        }
      }

      if (stage) {
        stage.classList.remove('hidden');
        const st = getCoreState();
        const cur = (st && st.currentTrack) || {};
        const title = cur.title || (document.getElementById('right-panel-title') && document.getElementById('right-panel-title').textContent) || 'Active Stream';
        const artist = cur.artist || (document.getElementById('right-panel-artist') && document.getElementById('right-panel-artist').textContent) || 'Eclipse Studio';

        if (chosen === 'waveform_card') {
          const bars = Array.from({ length: 32 }, (_, i) => {
            const h = 18 + Math.round(Math.abs(Math.sin(i * 0.45)) * 42);
            return `<span class="wf-bar" data-wf-idx="${i}" style="flex:1;height:${h}px;border-radius:99px;background:linear-gradient(180deg,#a855f7,#06b6d4);opacity:0.85;cursor:pointer;"></span>`;
          }).join('');
          stage.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
              <span style="font-size:11px;font-weight:700;color:#a855f7;letter-spacing:1px;">WAVEFORM CARD MODE</span>
              <button type="button" id="btn-wf-open-comments" style="padding:3px 10px;border-radius:999px;border:1px solid rgba(168,85,247,0.4);background:rgba(168,85,247,0.15);color:#fff;font-size:11px;cursor:pointer;">Timed Comments</button>
            </div>
            <div id="eclipse-wf-interactive" style="display:flex;align-items:flex-end;gap:3px;height:68px;padding:8px 4px;">${bars}</div>
            <div style="font-size:11px;opacity:0.7;display:flex;justify-content:space-between;">
              <span>Click any waveform bar to seek</span>
              <span>🔥 👏 🥹 Live Markers</span>
            </div>
          `;
          const wfBtn = stage.querySelector('#btn-wf-open-comments');
          if (wfBtn) wfBtn.addEventListener('click', () => window.openTrackCommentsDrawer());
          stage.querySelectorAll('.wf-bar').forEach(bar => {
            bar.addEventListener('click', () => {
              const idx = Number(bar.getAttribute('data-wf-idx')) || 0;
              const audioEl = document.getElementById('native-audio') || document.querySelector('audio');
              if (audioEl && audioEl.duration > 0) {
                audioEl.currentTime = (idx / 32) * audioEl.duration;
              }
            });
          });
        } else if (chosen === 'vertical_reel') {
          stage.innerHTML = `
            <div style="display:flex;flex-direction:column;gap:10px;min-height:190px;justify-content:space-between;padding:12px;border-radius:16px;background:linear-gradient(160deg,rgba(168,85,247,0.28),rgba(6,182,212,0.14));border:1px solid rgba(255,255,255,0.12);">
              <div style="display:flex;justify-content:space-between;align-items:center;">
                <span style="font-size:11px;font-weight:800;color:#e9d5ff;letter-spacing:1.2px;">VERTICAL FLOW REEL</span>
                <span style="font-size:11px;opacity:0.75;">Swipe / Next Flow</span>
              </div>
              <div>
                <div style="font-size:17px;font-weight:800;margin-bottom:2px;">${title}</div>
                <div style="font-size:13px;opacity:0.8;">${artist}</div>
              </div>
              <div style="display:flex;gap:8px;">
                <button type="button" id="btn-reel-prev" style="flex:1;padding:7px;border-radius:999px;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.06);color:#fff;font-size:12px;cursor:pointer;">↑ Prev Flow</button>
                <button type="button" id="btn-reel-next" style="flex:1;padding:7px;border-radius:999px;border:none;background:#a855f7;color:#fff;font-size:12px;font-weight:700;cursor:pointer;">↓ Next Flow</button>
              </div>
            </div>
          `;
          const prevEl = stage.querySelector('#btn-reel-prev');
          const nextEl = stage.querySelector('#btn-reel-next');
          if (prevEl) prevEl.addEventListener('click', () => { const b = document.getElementById('btn-prev'); if (b) b.click(); });
          if (nextEl) nextEl.addEventListener('click', () => { const b = document.getElementById('btn-next'); if (b) b.click(); });
        }
      }
      return chosen;
    };

    // Add Now Playing Toolbar buttons (Song DNA, Comments, Mode Switcher, Analytics, Diagnostics)
    const rightHeaderActions = document.querySelector('.right-panel-header-actions');
    if (rightHeaderActions && !document.getElementById('btn-open-song-dna')) {
      const dnaBtn = document.createElement('button');
      dnaBtn.type = 'button';
      dnaBtn.id = 'btn-open-song-dna';
      dnaBtn.className = 'lyrics-mode-btn';
      dnaBtn.title = 'Song DNA & Credits';
      dnaBtn.innerHTML = '<span>DNA</span>';
      dnaBtn.addEventListener('click', () => {
        if (typeof window.openSongDnaModal === 'function') window.openSongDnaModal();
      });

      const commentsBtn = document.createElement('button');
      commentsBtn.type = 'button';
      commentsBtn.id = 'btn-open-track-comments';
      commentsBtn.className = 'lyrics-mode-btn';
      commentsBtn.title = 'Timed Comments & Reactions';
      commentsBtn.innerHTML = '<span>Comments</span>';
      commentsBtn.addEventListener('click', () => window.openTrackCommentsDrawer());

      const modeBtn = document.createElement('button');
      modeBtn.type = 'button';
      modeBtn.id = 'btn-cycle-now-playing-mode';
      modeBtn.className = 'lyrics-mode-btn';
      modeBtn.title = 'Switch Now Playing Mode (Classic Neon Glass / Waveform Card / Vertical Flow Reel)';
      const modes = ['classic', 'waveform_card', 'vertical_reel'];
      const modeLabels = { classic: 'Glass', waveform_card: 'Waveform', vertical_reel: 'Flow Reel' };
      const savedMode = localStorage.getItem('eclipse_now_playing_mode') || 'classic';
      modeBtn.innerHTML = `<span>${modeLabels[savedMode] || 'Glass'}</span>`;
      modeBtn.addEventListener('click', () => {
        const cur = localStorage.getItem('eclipse_now_playing_mode') || 'classic';
        const next = modes[(modes.indexOf(cur) + 1) % modes.length];
        window.setNowPlayingMode(next);
        modeBtn.innerHTML = `<span>${modeLabels[next]}</span>`;
      });

      rightHeaderActions.insertBefore(modeBtn, rightHeaderActions.firstChild);
      rightHeaderActions.insertBefore(commentsBtn, rightHeaderActions.firstChild);
      rightHeaderActions.insertBefore(dnaBtn, rightHeaderActions.firstChild);
    }

    // 11. Dynamic Studio Palettes Selector (`ECLIPSE_COLOR_PRESETS` from `theme-presets.js`)
    if (Array.isArray(window.ECLIPSE_COLOR_PRESETS) && typeof window.applyThemePreset === 'function') {
      const savedPreset = localStorage.getItem('eclipse_theme_preset');
      if (savedPreset) {
        try { window.applyThemePreset(savedPreset); } catch (_) {}
      }

      const themeGroup = document.querySelector('.settings-section[data-cat="theme"] .m3-group');
      if (themeGroup && !document.getElementById('setting-eclipse-studio-palettes')) {
        const item = document.createElement('div');
        item.className = 'setting-item';
        item.id = 'setting-eclipse-studio-palettes';
        const buttonsHtml = window.ECLIPSE_COLOR_PRESETS.map(p => `
          <button type="button" class="btn-outline-pill eclipse-studio-palette-btn" data-preset-id="${p.id}" style="display:inline-flex;align-items:center;gap:6px;padding:6px 12px;font-size:12px;">
            <span style="width:12px;height:12px;border-radius:50%;background:${p.primary};box-shadow:0 0 8px ${p.glow};"></span>
            <span>${p.name}</span>
          </button>
        `).join('');
        item.innerHTML = `
          <div class="setting-item-top" style="margin-bottom:8px;">
            <span class="setting-name">Dynamic Studio Palettes</span>
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:8px;">${buttonsHtml}</div>
        `;
        themeGroup.insertBefore(item, themeGroup.firstChild);
        item.querySelectorAll('.eclipse-studio-palette-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            const pid = btn.getAttribute('data-preset-id');
            window.applyThemePreset(pid);
          });
        });
      }
    }

    // 12. Podcasts & Live Stations Shelf on Discover Page
    window.loadPodcastsAndLiveShelf = async function () {
      const spHome = document.getElementById('sp-home');
      if (!spHome) return [];
      let shelf = document.getElementById('sp-podcasts-live-sec');
      if (!shelf) {
        shelf = document.createElement('section');
        shelf.className = 'sp-section';
        shelf.id = 'sp-podcasts-live-sec';
        shelf.innerHTML = `
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
            <h2 style="margin:0;display:flex;align-items:center;gap:8px;">
              <svg class="sp-ico" viewBox="0 0 24 24"><path d="M12 3a9 9 0 0 0-9 9v7c0 1.1.9 2 2 2h4v-8H5v-1a7 7 0 0 1 14 0v1h-4v8h4c1.1 0 2-.9 2-2v-7a9 9 0 0 0-9-9z"/></svg>
              <span>Podcasts &amp; Live Stations</span>
            </h2>
          </div>
          <div class="sp-row" id="sp-podcasts-live-row" style="display:flex;gap:14px;overflow-x:auto;padding-bottom:6px;"></div>
        `;
        spHome.appendChild(shelf);
      }

      const row = shelf.querySelector('#sp-podcasts-live-row');
      const tkn = getInternalApiToken();
      let items = [];
      try {
        const res = await fetch(`${getInternalApiBase()}/api/ytm/podcasts?t=${encodeURIComponent(tkn)}&token=${encodeURIComponent(tkn)}`, {
          headers: { 'X-Eclipse-Token': tkn, 'X-Muriel-Token': tkn }
        });
        if (res.ok) {
          const data = await res.json();
          if (data && Array.isArray(data.podcasts)) items = data.podcasts;
          else if (data && Array.isArray(data.items)) items = data.items;
        }
      } catch (_) {}

      if (items.length === 0) {
        items = [
          { id: 'jfKfPfyJRdk', title: 'Eclipse Synthwave 24/7 Live Radio', author: 'Eclipse Broadcast', isLive: true },
          { id: '4xDzrJKXOOY', title: 'Deep Focus Electronic Sessions', author: 'Sonic Architecture Podcast', isPodcast: true },
          { id: '5qap5aO4i9A', title: 'Midnight Lo-Fi & Chill Beats Live', author: 'Lunar Frequency Station', isLive: true }
        ];
      }

      if (row) {
        row.innerHTML = items.slice(0, 8).map(item => `
          <div class="eclipse-podcast-card" data-vid="${item.id || item.videoId || ''}" style="min-width:210px;padding:14px;border-radius:16px;background:rgba(255,255,255,0.04);backdrop-filter:blur(20px);border:1px solid rgba(255,255,255,0.1);cursor:pointer;display:flex;flex-direction:column;justify-content:space-between;gap:8px;">
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <span style="font-size:10px;font-weight:800;padding:2px 8px;border-radius:999px;background:${item.isLive ? 'rgba(250,45,72,0.22)' : 'rgba(168,85,247,0.22)'};color:${item.isLive ? '#ff8093' : '#e9d5ff'};">${item.isLive ? '● LIVE' : 'PODCAST'}</span>
            </div>
            <div>
              <div style="font-size:14px;font-weight:700;line-height:1.35;margin-bottom:4px;">${item.title || 'Audio Broadcast'}</div>
              <div style="font-size:12px;opacity:0.7;">${item.author || item.artist || 'Eclipse Network'}</div>
            </div>
          </div>
        `).join('');
      }
      return items;
    };

    setTimeout(() => {
      window.loadPodcastsAndLiveShelf().catch(() => {});
    }, 800);

    // 13. Eclipse Analytics Dashboard & Frame Governor / Diagnostics Wiring
    if (typeof window.EclipseAnalyticsManager !== 'undefined') {
      try {
        window.eclipseAnalyticsInstance = new window.EclipseAnalyticsManager();
        window.openEclipseAnalyticsDashboard = function (period = '30d') {
          return window.eclipseAnalyticsInstance.openDashboardModal(period);
        };
      } catch (err) {
        console.warn('[EclipseBridge] EclipseAnalyticsManager init error:', err.message);
      }
    }

    if (typeof window.EclipseFrameGovernor !== 'undefined') {
      if (!window.eclipseFrameGovernor) {
        window.eclipseFrameGovernor = new window.EclipseFrameGovernor();
      }
      window.openEclipseDiagnosticsViewer = function () {
        return window.eclipseFrameGovernor.openDiagnosticsModal();
      };
    }

    // Add quick-launch buttons for Analytics Recap & Diagnostics in Sidebar / History / Settings
    const historyHeader = document.querySelector('#view-history .view-header');
    if (historyHeader && !document.getElementById('btn-open-eclipse-analytics')) {
      const analyticsBtn = document.createElement('button');
      analyticsBtn.type = 'button';
      analyticsBtn.id = 'btn-open-eclipse-analytics';
      analyticsBtn.className = 'btn-pill-primary';
      analyticsBtn.style.marginLeft = 'auto';
      analyticsBtn.style.marginRight = '8px';
      analyticsBtn.textContent = 'Eclipse Recap & Analytics';
      analyticsBtn.addEventListener('click', () => {
        if (typeof window.openEclipseAnalyticsDashboard === 'function') {
          window.openEclipseAnalyticsDashboard('30d');
        }
      });
      historyHeader.insertBefore(analyticsBtn, historyHeader.lastElementChild);
    }

    const aboutGroup = document.querySelector('#settings-section-about .m3-group');
    if (aboutGroup && !document.getElementById('btn-open-diagnostics-viewer')) {
      const diagRow = document.createElement('div');
      diagRow.className = 'setting-item';
      diagRow.innerHTML = `
        <div class="setting-item-top" style="align-items:center;justify-content:space-between;">
          <div style="display:flex;flex-direction:column;gap:2px;">
            <span class="setting-name">Diagnostics &amp; Frame Governor</span>
            <span class="setting-hint">Inspect redacted logs (max 500 lines) and dynamic 60/30/0 FPS state</span>
          </div>
          <div style="display:flex;gap:8px;">
            <button type="button" class="btn-outline-pill" id="btn-open-analytics-from-settings" style="padding:6px 14px;font-size:12px;">Sonic Analytics</button>
            <button type="button" class="btn-pill-primary" id="btn-open-diagnostics-viewer" style="padding:6px 14px;font-size:12px;">Open Diagnostics</button>
          </div>
        </div>
      `;
      aboutGroup.appendChild(diagRow);
      const diagBtn = diagRow.querySelector('#btn-open-diagnostics-viewer');
      if (diagBtn) {
        diagBtn.addEventListener('click', () => {
          if (typeof window.openEclipseDiagnosticsViewer === 'function') {
            window.openEclipseDiagnosticsViewer();
          }
        });
      }
      const anaBtn = diagRow.querySelector('#btn-open-analytics-from-settings');
      if (anaBtn) {
        anaBtn.addEventListener('click', () => {
          if (typeof window.openEclipseAnalyticsDashboard === 'function') {
            window.openEclipseAnalyticsDashboard('30d');
          }
        });
      }
    }

    console.log('[EclipseBridge] Phases 1-8 integration bridge ready.');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initEclipsePhasesBridge);
  } else {
    setTimeout(initEclipsePhasesBridge, 150);
  }
})();
