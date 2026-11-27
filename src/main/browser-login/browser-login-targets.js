'use strict';

const BrowserLoginTarget = Object.freeze({
  YOUTUBE: 'YOUTUBE',
  EXTERNAL_WEB: 'EXTERNAL_WEB'
});

const TARGET_HOST_MAP = Object.freeze({
  [BrowserLoginTarget.YOUTUBE]: 'music.youtube.com',
  [BrowserLoginTarget.EXTERNAL_WEB]: 'open.spotify.com'
});

const YOUTUBE_MUSIC_REQUEST_HOST = 'music.youtube.com';

function resolveTargetHost(target) {
  if (!Object.prototype.hasOwnProperty.call(TARGET_HOST_MAP, target)) {
    throw new Error(`Unsupported browser login target: ${target}`);
  }
  return TARGET_HOST_MAP[target];
}

module.exports = {
  BrowserLoginTarget,
  TARGET_HOST_MAP,
  YOUTUBE_MUSIC_REQUEST_HOST,
  resolveTargetHost
};
