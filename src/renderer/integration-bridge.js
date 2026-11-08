// integration-bridge.js — Robust, unified integration bridge for Phases 1-8
(function () {
  'use strict';

  function getInternalApiBase() {
    // 1. Electron / PC desktop environment
    if (typeof window !== 'undefined' && window.electronAPI && window.electronAPI.serverPort) {
      return `http://127.0.0.1:${window.electronAPI.serverPort}`;
    }
    // 2. Global state from app.js
    if (typeof state !== 'undefined' && state && state.serverPort) {
      return `http://127.0.0.1:${state.serverPort}`;
    }
    // 3. Fallback to default port
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

        // Connect to audio engine if available
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

    // 3. Phase 7: AutoMix DJ
    if (typeof window.AutoMixDJ !== 'undefined') {
      try {
        window.autoMixDjInstance = new window.AutoMixDJ({
          enabled: true,
          durationSec: 6.0,
          mode: 'equal_power',
          bpm: 120
        });
        console.log('[EclipseBridge] AutoMixDJ initialized with Equal-Power crossfade.');

        // Hook into audio timeupdate for auto-mixing near track end
        if (nativeAudio) {
          nativeAudio.addEventListener('timeupdate', () => {
            if (!window.autoMixDjInstance || !window.autoMixDjInstance.enabled || window.autoMixDjInstance.isCrossfading) return;
            const dur = nativeAudio.duration;
            const cur = nativeAudio.currentTime;
            if (dur && cur && (dur - cur) <= (window.autoMixDjInstance.durationSec || 6) && (dur - cur) > 0.5) {
              if (typeof window.onAutoMixTriggered === 'function') {
                window.onAutoMixTriggered();
              }
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
        console.log('[EclipseBridge] SmartDownloadManager initialized.');
      } catch (err) {
        console.warn('[EclipseBridge] SmartDownloadManager init error:', err.message);
      }
    }

    // 6. Hook into Storage Manager API for Settings view
    const btnStorageClear = document.getElementById('btn-open-clear-cache');
    if (btnStorageClear && !btnStorageClear._hasStorageHook) {
      btnStorageClear._hasStorageHook = true;
      btnStorageClear.addEventListener('click', async () => {
        try {
          const authQuery = token ? `?token=${encodeURIComponent(token)}` : '';
          const res = await fetch(`${apiBase}/api/storage/stats${authQuery}`);
          const data = await res.json();
          if (data && data.success) {
            console.log('[EclipseBridge] Storage usage:', data.formattedTotal || `${data.totalBytes || 0} bytes`);
          }
        } catch (_) {}
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
