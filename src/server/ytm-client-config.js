'use strict';

/**
 * Centralized WEB_REMIX client configuration for YouTube Music.
 * Single source of truth across Eclipse PC and Mobile backend services,
 * consistent with standard Eclipse WebRemix client architecture.
 */
const WEB_REMIX_CLIENT = Object.freeze({
  clientName: 'WEB_REMIX',
  clientVersion: '1.20260304.03.00',
  xYouTubeClientName: '1',
  origin: 'https://music.youtube.com',
  referer: 'https://music.youtube.com/',
  defaultUserAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  apiFormatVersion: '1'
});

module.exports = {
  WEB_REMIX_CLIENT
};
