// integration-bridge.js — Connect Phases 1-8 modules into Eclipse DOM & Audio Engine
(function () {
  'use strict';

  function initEclipsePhasesBridge() {
    console.log('[EclipseBridge] Initializing Phases 1-8 integration bridge...');

    // 1. Phase 5: MV Player IFrame integration
    if (typeof window.EclipseMvPlayer !== 'undefined') {
      try {
        const audioEl = document.getElementById('audio') || (typeof el !== 'undefined' && el.nativeAudio);
        window.eclipseMvPlayerInstance = new window.EclipseMvPlayer({
          audioElement: audioEl,
          apiBase: ''
        });
        console.log('[EclipseBridge] EclipseMvPlayer bound.');
      } catch (err) {
        console.warn('[EclipseBridge] MvPlayer init error:', err.message);
      }
    }

    // 2. Phase 7: AutoEQ integration
    if (typeof window.AutoEqManager !== 'undefined') {
      try {
        window.autoEqManagerInstance = new window.AutoEqManager();
        console.log('[EclipseBridge] AutoEqManager initialized. Profiles:', window.autoEqManagerInstance.listProfiles().length);
      } catch (err) {
        console.warn('[EclipseBridge] AutoEqManager init error:', err.message);
      }
    }

    // 3. Phase 7: AutoMix DJ
    if (typeof window.AutoMixDJ !== 'undefined') {
      try {
        window.autoMixDjInstance = new window.AutoMixDJ({
          crossfadeSec: 6,
          detectBpm: true
        });
        console.log('[EclipseBridge] AutoMixDJ initialized.');
      } catch (err) {
        console.warn('[EclipseBridge] AutoMixDJ init error:', err.message);
      }
    }

    // 4. Phase 8: Listen Together & Receipt
    if (typeof window.ListenTogetherRoom !== 'undefined') {
      try {
        window.listenTogetherRoomInstance = new window.ListenTogetherRoom();
        console.log('[EclipseBridge] ListenTogetherRoom initialized.');
      } catch (err) {
        console.warn('[EclipseBridge] ListenTogetherRoom init error:', err.message);
      }
    }

    // 5. Phase 6: Synced Lyrics Editor
    if (typeof window.SyncedLyricsEditor !== 'undefined') {
      try {
        window.syncedLyricsEditorInstance = new window.SyncedLyricsEditor();
        console.log('[EclipseBridge] SyncedLyricsEditor initialized.');
      } catch (err) {
        console.warn('[EclipseBridge] SyncedLyricsEditor init error:', err.message);
      }
    }

    // 6. Hook into Storage Manager API for Settings view
    const btnStorageClear = document.getElementById('btn-open-clear-cache');
    if (btnStorageClear && !btnStorageClear._hasStorageHook) {
      btnStorageClear._hasStorageHook = true;
      btnStorageClear.addEventListener('click', async () => {
        try {
          const res = await fetch('/api/storage/stats');
          const data = await res.json();
          if (data && data.success) {
            console.log('[EclipseBridge] Current storage stats:', data.stats);
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
