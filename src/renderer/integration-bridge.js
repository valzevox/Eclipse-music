// integration-bridge.js — Robust, unified integration bridge for Phases 1-8
(function () {
  'use strict';

  function getInternalApiBase() {
    if (typeof window !== 'undefined' && window.electronAPI && window.electronAPI.serverPort) {
      return `http://127.0.0.1:${window.electronAPI.serverPort}`;
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
    if (typeof state !== 'undefined' && state && state.serverToken) {
      return state.serverToken;
    }
    return '';
  }

  function initEclipsePhasesBridge() {
    console.log('[EclipseBridge] Initializing Phases 1-8 integration bridge...');

    const apiBase = getInternalApiBase();
    const token = getInternalApiToken();
    const nativeAudio = document.getElementById('native-audio') || document.querySelector('audio');

    // 1. Phase 5: MV Player IFrame integration
    if (typeof window.EclipseMvPlayer !== 'undefined') {
      try {
        window.eclipseMvPlayerInstance = new window.EclipseMvPlayer({
          audioElement: nativeAudio,
          apiBase: apiBase
        });

        // Set initial track if available
        if (typeof state !== 'undefined' && state.currentTrack) {
          window.eclipseMvPlayerInstance.setTrack(state.currentTrack);
        }

        // Sync track changes from global playback state
        window.addEventListener('trackchanged', (e) => {
          if (e.detail && e.detail.track) {
            window.eclipseMvPlayerInstance.setTrack(e.detail.track);
          }
        });

        // Expose a helper to trigger from app.js or button clicks
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

    // 3. Phase 7: AutoMix DJ (Real Crossfade & Track Advance)
    if (typeof window.AutoMixDJ !== 'undefined') {
      try {
        window.autoMixDjInstance = new window.AutoMixDJ({
          enabled: true,
          durationSec: 6.0,
          mode: 'equal_power',
          bpm: 120
        });
        console.log('[EclipseBridge] AutoMixDJ initialized with Equal-Power crossfade.');

        let automixTriggeredForTrack = false;
        window.addEventListener('trackchanged', () => {
          automixTriggeredForTrack = false;
        });

        if (nativeAudio) {
          nativeAudio.addEventListener('timeupdate', () => {
            if (!window.autoMixDjInstance || !window.autoMixDjInstance.enabled || window.autoMixDjInstance.isCrossfading || automixTriggeredForTrack) return;
            const dur = nativeAudio.duration;
            const cur = nativeAudio.currentTime;
            const remaining = dur - cur;
            const threshold = window.autoMixDjInstance.durationSec || 6.0;

            if (dur > 20 && remaining <= threshold && remaining > 0.5) {
              automixTriggeredForTrack = true;
              console.log(`[EclipseBridge] AutoMix triggered (${remaining.toFixed(1)}s remaining). Initiating beat crossfade...`);
              
              // Fade out current audio smoothly
              const startVol = nativeAudio.volume;
              const fadeInterval = setInterval(() => {
                if (nativeAudio.volume > 0.1) {
                  nativeAudio.volume = Math.max(0, nativeAudio.volume - 0.15);
                } else {
                  clearInterval(fadeInterval);
                  nativeAudio.volume = startVol;
                  // Advance to next song seamlessly
                  if (typeof window._eclipsePlayNext === 'function') {
                    window._eclipsePlayNext();
                  } else if (typeof playNext === 'function') {
                    playNext();
                  }
                }
              }, 400);
            }
          });
        }
      } catch (err) {
        console.warn('[EclipseBridge] AutoMixDJ init error:', err.message);
      }
    }

    // 4. Phase 8: Listen Together P2P Room & Receipt
    if (typeof window.ListenTogetherRoom !== 'undefined') {
      try {
        window.listenTogetherRoomInstance = new window.ListenTogetherRoom();
        console.log('[EclipseBridge] ListenTogetherRoom initialized.');
      } catch (err) {
        console.warn('[EclipseBridge] ListenTogetherRoom init error:', err.message);
      }
    }

    // 5. Phase 6: Synced Lyrics Editor & Smart Downloads
    if (typeof window.SyncedLyricsEditor !== 'undefined') {
      try {
        window.syncedLyricsEditorInstance = new window.SyncedLyricsEditor();
        console.log('[EclipseBridge] SyncedLyricsEditor initialized.');
      } catch (err) {
        console.warn('[EclipseBridge] SyncedLyricsEditor init error:', err.message);
      }
    }

    if (typeof window.SmartDownloadManager !== 'undefined') {
      try {
        window.smartDownloadManagerInstance = new window.SmartDownloadManager({
          enabled: true,
          limit: 50,
          wifiOnly: true
        });

        // Trigger smart download sync if library is populated
        if (typeof state !== 'undefined' && Array.isArray(state.favorites) && state.favorites.length > 0) {
          const plan = window.smartDownloadManagerInstance.planDownloads(state.favorites, (track) => {
            return track && track.isCached;
          });
          console.log('[EclipseBridge] SmartDownload plan created for', plan.length, 'tracks');
        }
        console.log('[EclipseBridge] SmartDownloadManager initialized.');
      } catch (err) {
        console.warn('[EclipseBridge] SmartDownloadManager init error:', err.message);
      }
    }

    // 6. Hook into Storage Manager API for Settings view (Clear & Stats)
    const btnStorageClear = document.getElementById('btn-open-clear-cache');
    if (btnStorageClear && !btnStorageClear._hasStorageHook) {
      btnStorageClear._hasStorageHook = true;
      btnStorageClear.addEventListener('click', async () => {
        try {
          const authHeaders = {
            'X-Muriel-Token': token
          };
          const queryToken = token ? `?t=${encodeURIComponent(token)}&token=${encodeURIComponent(token)}` : '';
          
          // Clear temporary audio/image cache
          const clearRes = await fetch(`${apiBase}/api/storage/clear${queryToken}`, {
            method: 'POST',
            headers: authHeaders
          });
          const clearData = await clearRes.json();

          // Refresh storage stats
          const statsRes = await fetch(`${apiBase}/api/storage/stats${queryToken}`, {
            headers: authHeaders
          });
          const statsData = await statsRes.json();
          if (statsData && statsData.success) {
            console.log('[EclipseBridge] Cache cleared. Remaining storage:', statsData.formattedTotal || `${statsData.totalBytes || 0} bytes`);
            if (typeof showToast === 'function') {
              showToast(`Đã dọn dẹp bộ nhớ đệm: ${statsData.formattedTotal || '0 B'}`);
            }
          }
        } catch (err) {
          console.warn('[EclipseBridge] Storage operation error:', err.message);
        }
      });
    }

    console.log('[EclipseBridge] Phases 1-8 integration bridge ready.');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initEclipsePhasesBridge);
  } else {
    setTimeout(initEclipsePhasesBridge, 150);
  }
})();
