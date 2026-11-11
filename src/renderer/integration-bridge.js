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
        window.autoMixDjInstance = new window.AutoMixDJ({
          enabled: true,
          durationSec: 6.0,
          mode: 'equal_power',
          bpm: 120
        });

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

        console.log('[EclipseBridge] AutoMixDJ initialized with dual-source Equal-Power crossfade.');

        let automixTriggeredForTrack = false;
        window.addEventListener('trackchanged', () => {
          automixTriggeredForTrack = false;
        });

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
            if (!window.autoMixDjInstance || !window.autoMixDjInstance.enabled || window.autoMixDjInstance.isCrossfading || automixTriggeredForTrack) return;
            const dur = nativeAudio.duration;
            const cur = nativeAudio.currentTime;
            const remaining = dur - cur;
            const threshold = window.autoMixDjInstance.durationSec || 6.0;

            if (dur > 20 && remaining <= threshold && remaining > 0.8) {
              automixTriggeredForTrack = true;
              const st = getCoreState();
              let nextTrack = null;
              if (st && Array.isArray(st.queue) && st.queue.length > 0) {
                if (typeof st.findAutoMixNextTrack === 'function') {
                  const autoNext = st.findAutoMixNextTrack();
                  if (autoNext) nextTrack = autoNext;
                }
                if (!nextTrack && st.queueIndex + 1 < st.queue.length) {
                  nextTrack = st.queue[st.queueIndex + 1];
                }
              }

              if (nextTrack) {
                try {
                  const nextStreamUrl = await resolveNextTrackStreamUrl(nextTrack);
                  if (nextStreamUrl) {
                    auxAudio.src = nextStreamUrl;
                    auxAudio.currentTime = 0;
                  }
                } catch (_) {}
              }

              console.log(`[EclipseBridge] AutoMix executing dual-source crossfade (${remaining.toFixed(1)}s remaining)...`);
              await window.autoMixDjInstance.executeCrossfade(nativeAudio, auxAudio, threshold);
              
              // Seamless Handover: transfer playback offset and audio source without restarting nextTrack at 0:00
              const handoverTime = (auxAudio && !isNaN(auxAudio.currentTime)) ? auxAudio.currentTime : 0;
              const handoverSrc = (auxAudio && auxAudio.src) ? auxAudio.src : '';
              const curCoreState = getCoreState();
              if (curCoreState && nextTrack) {
                curCoreState._autoMixHandover = {
                  src: handoverSrc,
                  currentTime: handoverTime,
                  trackId: nextTrack.id || nextTrack.videoId
                };
              }

              try {
                if (auxAudio) {
                  auxAudio.pause();
                  auxAudio.currentTime = 0;
                }
              } catch (_) {}

              if (typeof window._eclipsePlayNext === 'function') {
                window._eclipsePlayNext();
              }
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

    console.log('[EclipseBridge] Phases 1-8 integration bridge ready.');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initEclipsePhasesBridge);
  } else {
    setTimeout(initEclipsePhasesBridge, 150);
  }
})();
