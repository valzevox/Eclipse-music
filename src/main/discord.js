
const RPC = require('discord-rpc');

let currentClientId = process.env.ECLIPSE_DISCORD_CLIENT_ID || '1564857196334940162';
function setClientId(newId) {
  if (newId && typeof newId === 'string' && newId.trim()) {
    currentClientId = newId.trim();
  }
}
function getClientId() {
  return currentClientId;
}
const RECONNECT_DELAY_MS = 15000;

let rpcClient = null;
let isConnected = false;
let isEnabled = true;
let lastTrackInfo = null;
let reconnectTimer = null;
let isDestroying = false;

function initRPC() {
  if (rpcClient || isDestroying) return;

  rpcClient = new RPC.Client({ transport: 'ipc' });

  rpcClient.on('ready', () => {
    isConnected = true;
    console.log('[Discord RPC] Connected as', rpcClient.user?.username || 'unknown');
    if (lastTrackInfo && isEnabled) {
      _setActivity(lastTrackInfo);
    }
  });

  rpcClient.on('disconnected', () => {
    console.log('[Discord RPC] Disconnected');
    isConnected = false;
    rpcClient = null;
    scheduleReconnect();
  });

  rpcClient.login({ clientId: currentClientId }).catch(err => {
    console.warn('[Discord RPC] Login failed:', err.message || err);
    isConnected = false;
    rpcClient = null;
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  if (reconnectTimer || isDestroying || !isEnabled) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (isEnabled && !isDestroying) {
      initRPC();
    }
  }, RECONNECT_DELAY_MS);
}

function _setActivity(trackInfo) {
  if (!rpcClient || !isConnected || !trackInfo) return;
  const isPaused = !!trackInfo.isPaused;
  if (isPaused && trackInfo.showPaused === false) {
    rpcClient.clearActivity().catch(() => {});
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  const posSec = Math.max(0, Math.floor(Number(trackInfo.position) || 0));
  const startEpoch = trackInfo.startTimestamp || (now - posSec);
  const displayMode = trackInfo.statusDisplayType || (trackInfo.artistInStatus !== false ? 'artist' : 'app');
  const cleanTitle = String(trackInfo.title || 'Unknown Track').substring(0, 128).padEnd(2, ' ');
  const rawArtist = String(trackInfo.artist || 'Unknown Artist').substring(0, 120);
  const cleanArtist = (isPaused ? `${rawArtist} (Paused)` : rawArtist).substring(0, 128).padEnd(2, ' ');

  let detailsText = cleanTitle;
  let stateText = cleanArtist;
  let statusDisplayType = 1;
  if (displayMode === 'title') {
    detailsText = cleanArtist;
    stateText = cleanTitle;
    statusDisplayType = 1;
  } else if (displayMode === 'app') {
    detailsText = cleanTitle;
    stateText = (`by ${rawArtist}${isPaused ? ' (Paused)' : ''}`).substring(0, 128).padEnd(2, ' ');
    statusDisplayType = 0;
  }

  const baseActivity = {
    type: 2,
    details: detailsText,
    state: stateText,
    instance: false,
  };
  if (!isPaused && trackInfo.showTime !== false) {
    baseActivity.timestamps = { start: startEpoch };
    if (trackInfo.duration && trackInfo.duration > 0) {
      baseActivity.timestamps.end = startEpoch + Math.floor(trackInfo.duration);
    }
  }
      if (trackInfo.showArtwork !== false) {
    if (trackInfo.thumbnail) {
      baseActivity.assets = {
        large_image: trackInfo.thumbnail,
        large_text: cleanTitle
      };
    } else {
      baseActivity.assets = {
        large_image: 'https://cdn.discordapp.com/app-icons/1564857196334940162/06788ca983d419ecc17e87522bd4cb36.png?size=512',
        large_text: 'Eclipse'
      };
    }
  }
  if (trackInfo.showButton !== false && trackInfo.url && typeof trackInfo.url === 'string' && trackInfo.url.startsWith('https://') && trackInfo.url.length <= 512) {
    baseActivity.buttons = [{ label: 'Listen', url: trackInfo.url }];
  }
  const primaryActivity = statusDisplayType === 1
    ? Object.assign({}, baseActivity, { status_display_type: 1 })
    : baseActivity;
  rpcClient.request('SET_ACTIVITY', { pid: process.pid, activity: primaryActivity }).catch(() => {
    if (rpcClient && isConnected) {
      rpcClient.request('SET_ACTIVITY', { pid: process.pid, activity: baseActivity }).catch(err => {
        console.warn('[Discord RPC] SET_ACTIVITY error:', err.message || err);
      });
    }
  });
}


function updatePresence(trackInfo) {
  if (!trackInfo) return;

  lastTrackInfo = trackInfo;

  if (!isEnabled) return;

  if (isConnected && rpcClient) {
    _setActivity(trackInfo);
  } else if (!rpcClient && !reconnectTimer) {
    initRPC();
  }
}

function clearPresence() {
  lastTrackInfo = null;
  if (rpcClient && isConnected) {
    rpcClient.clearActivity().catch(() => {});
  }
}

function setEnabled(enabled) {
  isEnabled = !!enabled;

  if (isEnabled) {
    if (!rpcClient) {
      initRPC();
    } else if (lastTrackInfo) {
      _setActivity(lastTrackInfo);
    }
  } else {
    if (rpcClient && isConnected) {
      rpcClient.clearActivity().catch(() => {});
    }
    destroyRPC();
  }
}

function getEnabled() {
  return isEnabled;
}

function getConnected() {
  return isConnected;
}

function destroyRPC() {
  isDestroying = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (rpcClient) {
    try {
      rpcClient.destroy().catch(() => {});
    } catch (e) {}
    rpcClient = null;
  }
  isConnected = false;
  setTimeout(() => { isDestroying = false; }, 500);
}

function reconnectRPC() {
  destroyRPC();
  setTimeout(() => initRPC(), 600);
}

module.exports = {
  setClientId,
  getClientId,
  initRPC,
  updatePresence,
  clearPresence,
  setEnabled,
  getEnabled,
  getConnected,
  destroyRPC,
  reconnectRPC,
};
