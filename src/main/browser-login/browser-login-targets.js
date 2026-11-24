'use strict';

const BrowserLoginTarget = Object.freeze({
  YOUTUBE: 'YOUTUBE'
});

const TARGET_HOST_MAP = Object.freeze({
  [BrowserLoginTarget.YOUTUBE]: 'music.youtube.com'
});

const YOUTUBE_MUSIC_REQUEST_HOST = 'music.youtube.com';

function resolveTargetHost(target) {
  if (target !== BrowserLoginTarget.YOUTUBE) {
    throw new Error(`Unsupported browser login target: ${target}`);
  }
  return TARGET_HOST_MAP[target] || YOUTUBE_MUSIC_REQUEST_HOST;
}

module.exports = {
  BrowserLoginTarget,
  TARGET_HOST_MAP,
  YOUTUBE_MUSIC_REQUEST_HOST,
  resolveTargetHost
};
