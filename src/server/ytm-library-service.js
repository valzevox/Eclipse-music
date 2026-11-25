// d:/Eclipse/eclipse-pc/src/server/ytm-library-service.js
// JS / ytm-library-service.js / Node / Eclipse PC Backend
'use strict';

const crypto = require('crypto');
const { WEB_REMIX_CLIENT } = require('./ytm-client-config');

const MAX_TRACK_PAGES = 30;
const MAX_COLLECTION_PAGES = 20;

function extractText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (typeof node.simpleText === 'string') return node.simpleText;
  if (Array.isArray(node.runs)) return node.runs.map(r => (r && r.text) || '').join('');
  return '';
}

function parseDurationSec(val) {
  if (val === null || val === undefined || val === '') return null;
  if (typeof val === 'number') return Number.isFinite(val) && val > 0 ? Math.round(val) : null;
  const str = String(val).trim();
  const m = str.match(/(?:(\d+):)?(\d+):(\d+)/);
  if (m) {
    const sec = m[1]
      ? parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10)
      : parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
    return sec > 0 ? sec : null;
  }
  return null;
}

function extractTracksFromPage(root, globalSeenIds = new Set()) {
  const tracks = [];
  function walk(node, visited = new Set()) {
    if (!node || typeof node !== 'object') return;
    if (visited.has(node)) return;
    visited.add(node);
    if (node.musicResponsiveListItemRenderer) {
      const r = node.musicResponsiveListItemRenderer;
      let videoId = (r.playlistItemData && r.playlistItemData.videoId) ? r.playlistItemData.videoId : null;
      if (!videoId) {
        const findVid = (obj) => {
          if (!obj || typeof obj !== 'object') return null;
          if (obj.watchEndpoint && typeof obj.watchEndpoint.videoId === 'string') return obj.watchEndpoint.videoId;
          for (const k of Object.keys(obj)) {
            const v = findVid(obj[k]);
            if (v) return v;
          }
          return null;
        };
        videoId = findVid(r);
      }
      if (videoId && !globalSeenIds.has(videoId)) {
        globalSeenIds.add(videoId);
        const title = extractText(r.flexColumns && r.flexColumns[0] && r.flexColumns[0].musicResponsiveListItemFlexColumnRenderer && r.flexColumns[0].musicResponsiveListItemFlexColumnRenderer.text) || 'Untitled';
        let artist = '';
        if (r.flexColumns && r.flexColumns[1]) {
          const runs = r.flexColumns[1].musicResponsiveListItemFlexColumnRenderer && r.flexColumns[1].musicResponsiveListItemFlexColumnRenderer.text && r.flexColumns[1].musicResponsiveListItemFlexColumnRenderer.text.runs;
          if (Array.isArray(runs) && runs.length > 0) {
            artist = runs[0].text || '';
          } else {
            artist = extractText(r.flexColumns[1].musicResponsiveListItemFlexColumnRenderer && r.flexColumns[1].musicResponsiveListItemFlexColumnRenderer.text);
          }
        }
        let duration = null;
        const findDur = (obj) => {
          if (!obj || typeof obj !== 'object' || duration !== null) return;
          if (Array.isArray(obj.runs)) {
            for (const ru of obj.runs) {
              if (ru && ru.text && /^\d+:\d+(:\d+)?$/.test(ru.text.trim())) {
                duration = parseDurationSec(ru.text.trim());
                if (duration !== null) return;
              }
            }
          }
          for (const k of Object.keys(obj)) {
            if (duration === null) findDur(obj[k]);
          }
        };
        findDur(r);
        const thumbs = r.thumbnail && r.thumbnail.musicThumbnailRenderer && r.thumbnail.musicThumbnailRenderer.thumbnail && r.thumbnail.musicThumbnailRenderer.thumbnail.thumbnails;
        const cover = (Array.isArray(thumbs) && thumbs.length > 0) ? thumbs[thumbs.length - 1].url : '';
        tracks.push({
          id: videoId,
          videoId,
          title,
          artist,
          duration,
          url: `https://www.youtube.com/watch?v=${videoId}`,
          platform: 'ytmusic',
          cover,
          thumbnail: cover
        });
      }
    } else if (node.playlistVideoRenderer || node.videoRenderer || node.compactVideoRenderer) {
      const r = node.playlistVideoRenderer || node.videoRenderer || node.compactVideoRenderer;
      const videoId = r.videoId;
      if (videoId && !globalSeenIds.has(videoId)) {
        globalSeenIds.add(videoId);
        const title = extractText(r.title) || 'Untitled';
        const artist = extractText(r.shortBylineText) || extractText(r.ownerText) || '';
        const duration = r.lengthSeconds ? parseDurationSec(parseInt(r.lengthSeconds, 10)) : parseDurationSec(extractText(r.lengthText));
        const thumbs = (r.thumbnail && r.thumbnail.thumbnails) || (r.thumbnails && r.thumbnails[0] && r.thumbnails[0].thumbnails);
        const cover = (Array.isArray(thumbs) && thumbs.length > 0) ? thumbs[thumbs.length - 1].url : '';
        tracks.push({
          id: videoId,
          videoId,
          title,
          artist,
          duration,
          url: `https://www.youtube.com/watch?v=${videoId}`,
          platform: 'ytmusic',
          cover,
          thumbnail: cover
        });
      }
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, visited);
    } else {
      for (const k of Object.keys(node)) walk(node[k], visited);
    }
  }
  walk(root);
  return tracks;
}

function extractAlbumsFromPage(root, seenIds = new Set()) {
  const albums = [];
  function walk(node, visited = new Set()) {
    if (!node || typeof node !== 'object') return;
    if (visited.has(node)) return;
    visited.add(node);
    if (node.musicTwoRowItemRenderer) {
      const r = node.musicTwoRowItemRenderer;
      const title = extractText(r.title);
      const browseId = r.navigationEndpoint && r.navigationEndpoint.browseEndpoint && r.navigationEndpoint.browseEndpoint.browseId;
      if (browseId && !seenIds.has(browseId)) {
        seenIds.add(browseId);
        let artist = '';
        let year = '';
        if (r.subtitle) {
          const rawSub = extractText(r.subtitle);
          const yearMatch = rawSub.match(/\b(19|20)\d{2}\b/);
          if (yearMatch) year = yearMatch[0];
          artist = rawSub.replace(/^Album\s*•\s*/i, '').replace(/\s*•\s*(19|20)\d{2}.*$/, '').trim();
        }
        const thumbs = r.thumbnailRenderer && r.thumbnailRenderer.musicThumbnailRenderer && r.thumbnailRenderer.musicThumbnailRenderer.thumbnail && r.thumbnailRenderer.musicThumbnailRenderer.thumbnail.thumbnails;
        const cover = (Array.isArray(thumbs) && thumbs.length > 0) ? thumbs[thumbs.length - 1].url : '';
        albums.push({ id: browseId, title: title || 'Album', artist, year, cover, type: 'Album', entityType: 'album', platform: 'ytmusic' });
      }
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, visited);
    } else {
      for (const k of Object.keys(node)) walk(node[k], visited);
    }
  }
  walk(root);
  return albums;
}

function extractPlaylistsFromPage(root, seenIds = new Set()) {
  const playlists = [];
  function walk(node, visited = new Set()) {
    if (!node || typeof node !== 'object') return;
    if (visited.has(node)) return;
    visited.add(node);
    if (node.musicTwoRowItemRenderer) {
      const r = node.musicTwoRowItemRenderer;
      const title = extractText(r.title);
      let browseId = r.navigationEndpoint && r.navigationEndpoint.browseEndpoint && r.navigationEndpoint.browseEndpoint.browseId;
      if (!browseId) {
        const findBrowse = (obj) => {
          if (!obj || typeof obj !== 'object') return null;
          if (obj.browseEndpoint && typeof obj.browseEndpoint.browseId === 'string') return obj.browseEndpoint.browseId;
          for (const k of Object.keys(obj)) {
            const b = findBrowse(obj[k]);
            if (b) return b;
          }
          return null;
        };
        browseId = findBrowse(r);
      }
      if (browseId && !seenIds.has(browseId) && (browseId.startsWith('VL') || browseId.startsWith('PL') || browseId.startsWith('MPREb_') || browseId.includes('playlist') || browseId.startsWith('RD'))) {
        seenIds.add(browseId);
        const thumbs = r.thumbnailRenderer && r.thumbnailRenderer.musicThumbnailRenderer && r.thumbnailRenderer.musicThumbnailRenderer.thumbnail && r.thumbnailRenderer.musicThumbnailRenderer.thumbnail.thumbnails;
        const cover = (Array.isArray(thumbs) && thumbs.length > 0) ? thumbs[thumbs.length - 1].url : '';
        playlists.push({ id: browseId, name: title || 'Playlist', cover });
      }
    } else if (node.gridPlaylistRenderer || node.playlistRenderer || node.compactPlaylistRenderer) {
      const r = node.gridPlaylistRenderer || node.playlistRenderer || node.compactPlaylistRenderer;
      const id = r.playlistId || (r.navigationEndpoint && r.navigationEndpoint.browseEndpoint && r.navigationEndpoint.browseEndpoint.browseId);
      const title = extractText(r.title);
      if (id && !seenIds.has(id)) {
        seenIds.add(id);
        const thumbs = (r.thumbnail && r.thumbnail.thumbnails) || (r.thumbnails && r.thumbnails[0] && r.thumbnails[0].thumbnails);
        const cover = (Array.isArray(thumbs) && thumbs.length > 0) ? thumbs[thumbs.length - 1].url : '';
        playlists.push({ id, name: title || 'Playlist', cover });
      }
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, visited);
    } else {
      for (const k of Object.keys(node)) walk(node[k], visited);
    }
  }
  walk(root);
  return playlists;
}

function findContinuationToken(root) {
  let found = null;
  function walk(node, visited = new Set()) {
    if (!node || typeof node !== 'object' || found) return;
    if (visited.has(node)) return;
    visited.add(node);
    if (node.continuationCommand && typeof node.continuationCommand.token === 'string' && node.continuationCommand.token) {
      found = node.continuationCommand.token;
      return;
    }
    if (node.nextContinuationData && typeof node.nextContinuationData.continuation === 'string' && node.nextContinuationData.continuation) {
      found = node.nextContinuationData.continuation;
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, visited);
    } else {
      for (const k of Object.keys(node)) walk(node[k], visited);
    }
  }
  walk(root);
  return found;
}

function parseRetryAfterSeconds(headerVal) {
  if (!headerVal) return null;
  const trimmed = String(headerVal).trim();
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  const ts = Date.parse(trimmed);
  if (Number.isFinite(ts)) {
    return Math.max(1, Math.ceil((ts - Date.now()) / 1000));
  }
  return null;
}

function buildActiveAccountHeaders(account) {
  if (!account || typeof account.cookie !== 'string' || !account.cookie.trim()) {
    return null;
  }
  const cookieStr = account.cookie.trim();
  const match = cookieStr.match(/(?:^|;\s*)(?:SAPISID|__Secure-3PAPISID)=([^;]+)/);
  const sapisid = match ? match[1].trim() : '';
  if (!sapisid) return null;

  const ts = Math.floor(Date.now() / 1000);
  const origin = WEB_REMIX_CLIENT.origin;
  const hash = crypto.createHash('sha1').update(`${ts} ${sapisid} ${origin}`).digest('hex');
  const headers = {
    'Cookie': cookieStr,
    'Authorization': `SAPISIDHASH ${ts}_${hash}`,
    'Content-Type': 'application/json',
    'Origin': origin,
    'Referer': WEB_REMIX_CLIENT.referer,
    'X-Origin': origin,
    'X-YouTube-Client-Name': WEB_REMIX_CLIENT.xYouTubeClientName,
    'X-YouTube-Client-Version': WEB_REMIX_CLIENT.clientVersion,
    'X-Goog-AuthUser': String(account.authUser ?? 0),
    'User-Agent': WEB_REMIX_CLIENT.defaultUserAgent
  };
  if (account.pageId && String(account.pageId).trim()) {
    headers['X-Goog-PageId'] = String(account.pageId).trim();
  }
  return headers;
}

class YtmLibraryService {
  constructor(ytmAuth, options = {}) {
    this.ytmAuth = ytmAuth;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.maxTrackPages = options.maxTrackPages || MAX_TRACK_PAGES;
    this.maxCollectionPages = options.maxCollectionPages || MAX_COLLECTION_PAGES;
    this.activeControllers = new Map();
  }

  _getActiveAccountOrThrow(expectedAccountId = null) {
    const acc = this.ytmAuth && typeof this.ytmAuth.getRawActiveAccount === 'function'
      ? this.ytmAuth.getRawActiveAccount()
      : null;
    if (!acc || !acc.cookie) {
      const err = new Error('No authenticated YouTube Music account');
      err.code = 'NOT_AUTHENTICATED';
      err.httpStatus = 401;
      throw err;
    }
    if (expectedAccountId && String(acc.id) !== String(expectedAccountId)) {
      const err = new Error('Active account changed during request');
      err.code = 'ACCOUNT_MISMATCH';
      err.httpStatus = 409;
      throw err;
    }
    const headers = buildActiveAccountHeaders(acc);
    if (!headers) {
      const err = new Error('Active account is missing a valid YouTube SAPISID credential');
      err.code = 'INVALID_CREDENTIAL';
      err.httpStatus = 401;
      throw err;
    }
    return { account: acc, headers };
  }

  cancelRequest(requestId) {
    if (!requestId) return false;
    const ctrl = this.activeControllers.get(String(requestId));
    if (ctrl) {
      ctrl.abort();
      this.activeControllers.delete(String(requestId));
      return true;
    }
    return false;
  }

  async _postBrowse(headers, browseId, continuationToken = null, signal = null) {
    const body = {
      context: {
        client: {
          clientName: WEB_REMIX_CLIENT.clientName,
          clientVersion: WEB_REMIX_CLIENT.clientVersion,
          hl: 'en'
        }
      }
    };
    let targetUrl = `${WEB_REMIX_CLIENT.origin}/youtubei/v1/browse?prettyPrint=false`;
    if (continuationToken) {
      body.continuation = continuationToken;
      targetUrl = `${targetUrl}&continuation=${encodeURIComponent(continuationToken)}`;
    } else if (browseId) {
      body.browseId = browseId;
    }

    const res = await this.fetchImpl(targetUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: signal || undefined
    });

    if (!res.ok) {
      const err = new Error(`Innertube browse failed: HTTP ${res.status}`);
      err.httpStatus = res.status;
      err.status = res.status;
      err.code = res.status === 429 ? 'RATE_LIMITED' : `HTTP_${res.status}`;
      if (res.headers && typeof res.headers.get === 'function') {
        const ra = parseRetryAfterSeconds(res.headers.get('retry-after'));
        if (ra !== null) err.retryAfter = ra;
      }
      throw err;
    }
    return await res.json();
  }

  async fetchTracksPaginated(browseId, opts = {}) {
    const { account, headers } = this._getActiveAccountOrThrow(opts.expectedAccountId || null);
    const effectiveBrowseId = (String(browseId).startsWith('PL') && !String(browseId).startsWith('VLPL'))
      ? `VL${browseId}`
      : String(browseId);
    const globalSeenIds = new Set();
    const seenTokens = new Set();
    let tracks = [];
    let pagesFetched = 0;
    let continuationRemaining = false;

    try {
      const initial = await this._postBrowse(headers, effectiveBrowseId, null, opts.signal);
      pagesFetched++;
      tracks = tracks.concat(extractTracksFromPage(initial, globalSeenIds));
      let token = findContinuationToken(initial);

      while (token) {
        if (seenTokens.has(token)) break;
        if (pagesFetched >= this.maxTrackPages) {
          continuationRemaining = true;
          break;
        }
        seenTokens.add(token);
        const contData = await this._postBrowse(headers, null, token, opts.signal);
        pagesFetched++;
        const pageTracks = extractTracksFromPage(contData, globalSeenIds);
        if (pageTracks.length > 0) {
          tracks = tracks.concat(pageTracks);
        }
        const nextToken = findContinuationToken(contData);
        if (!nextToken || nextToken === token) {
          token = null;
        } else {
          token = nextToken;
        }
      }

      return {
        success: true,
        accountId: account.id,
        tracks,
        complete: !continuationRemaining,
        failed: false,
        errorCode: null,
        pagesFetched,
        continuationRemaining
      };
    } catch (err) {
      return {
        success: false,
        accountId: account.id,
        tracks,
        complete: false,
        failed: true,
        error: err.message,
        errorCode: err.code || (err.name === 'AbortError' ? 'ABORTED' : 'FETCH_ERROR'),
        httpStatus: err.httpStatus || err.status || null,
        retryAfter: err.retryAfter || null,
        pagesFetched,
        continuationRemaining: true
      };
    }
  }

  async fetchLikedTracks(opts = {}) {
    return await this.fetchTracksPaginated('VLLM', opts);
  }

  async fetchLikedAlbums(opts = {}) {
    const { account, headers } = this._getActiveAccountOrThrow(opts.expectedAccountId || null);
    const seenIds = new Set();
    const seenTokens = new Set();
    let albums = [];
    let pagesFetched = 0;
    let continuationRemaining = false;

    try {
      const initial = await this._postBrowse(headers, 'FEmusic_liked_albums', null, opts.signal);
      pagesFetched++;
      albums = albums.concat(extractAlbumsFromPage(initial, seenIds));
      let token = findContinuationToken(initial);
      while (token) {
        if (seenTokens.has(token)) break;
        if (pagesFetched >= this.maxCollectionPages) {
          continuationRemaining = true;
          break;
        }
        seenTokens.add(token);
        const contData = await this._postBrowse(headers, null, token, opts.signal);
        pagesFetched++;
        albums = albums.concat(extractAlbumsFromPage(contData, seenIds));
        const nextToken = findContinuationToken(contData);
        token = (nextToken && nextToken !== token) ? nextToken : null;
      }
      return {
        success: true,
        accountId: account.id,
        albums,
        complete: !continuationRemaining,
        failed: false,
        errorCode: null,
        pagesFetched,
        continuationRemaining
      };
    } catch (err) {
      return {
        success: false,
        accountId: account.id,
        albums,
        complete: false,
        failed: true,
        error: err.message,
        errorCode: err.code || (err.name === 'AbortError' ? 'ABORTED' : 'FETCH_ERROR'),
        httpStatus: err.httpStatus || err.status || null,
        retryAfter: err.retryAfter || null,
        pagesFetched,
        continuationRemaining: true
      };
    }
  }

  async fetchLikedPlaylists(opts = {}) {
    const { account, headers } = this._getActiveAccountOrThrow(opts.expectedAccountId || null);
    const seenIds = new Set();
    const seenTokens = new Set();
    let rawPlaylists = [];
    let pagesFetched = 0;
    let continuationRemaining = false;

    try {
      const initial = await this._postBrowse(headers, 'FEmusic_liked_playlists', null, opts.signal);
      pagesFetched++;
      rawPlaylists = rawPlaylists.concat(extractPlaylistsFromPage(initial, seenIds));
      let token = findContinuationToken(initial);
      while (token) {
        if (seenTokens.has(token)) break;
        if (pagesFetched >= this.maxCollectionPages) {
          continuationRemaining = true;
          break;
        }
        seenTokens.add(token);
        const contData = await this._postBrowse(headers, null, token, opts.signal);
        pagesFetched++;
        rawPlaylists = rawPlaylists.concat(extractPlaylistsFromPage(contData, seenIds));
        const nextToken = findContinuationToken(contData);
        token = (nextToken && nextToken !== token) ? nextToken : null;
      }

      const playlists = [];
      const batchSize = 4;
      for (let i = 0; i < rawPlaylists.length; i += batchSize) {
        const chunk = rawPlaylists.slice(i, i + batchSize);
        const settled = await Promise.all(chunk.map(async (pl) => {
          const trackRes = await this.fetchTracksPaginated(pl.id, opts);
          return {
            id: pl.id,
            name: pl.name,
            cover: pl.cover,
            tracks: trackRes.tracks || [],
            complete: trackRes.complete,
            failed: trackRes.failed,
            errorCode: trackRes.errorCode,
            pagesFetched: trackRes.pagesFetched,
            continuationRemaining: trackRes.continuationRemaining
          };
        }));
        playlists.push(...settled);
      }

      return {
        success: true,
        accountId: account.id,
        playlists,
        complete: !continuationRemaining,
        failed: false,
        errorCode: null,
        pagesFetched,
        continuationRemaining
      };
    } catch (err) {
      return {
        success: false,
        accountId: account.id,
        playlists: [],
        complete: false,
        failed: true,
        error: err.message,
        errorCode: err.code || (err.name === 'AbortError' ? 'ABORTED' : 'FETCH_ERROR'),
        httpStatus: err.httpStatus || err.status || null,
        retryAfter: err.retryAfter || null,
        pagesFetched,
        continuationRemaining: true
      };
    }
  }

  async fetchFullLibrary(opts = {}) {
    const requestId = opts.requestId ? String(opts.requestId) : null;
    const controller = new AbortController();
    if (requestId) this.activeControllers.set(requestId, controller);
    const mergedOpts = { ...opts, signal: opts.signal || controller.signal };

    try {
      const { account } = this._getActiveAccountOrThrow(opts.expectedAccountId || null);
      const doLikes = opts.doLikes !== false;
      const doPlaylists = opts.doPlaylists !== false;
      const doAlbums = opts.doAlbums !== false;

      const [likesRes, playlistsRes, albumsRes] = await Promise.all([
        doLikes ? this.fetchLikedTracks(mergedOpts) : Promise.resolve({ success: true, tracks: [], complete: true, failed: false, errorCode: null, pagesFetched: 0, continuationRemaining: false }),
        doPlaylists ? this.fetchLikedPlaylists(mergedOpts) : Promise.resolve({ success: true, playlists: [], complete: true, failed: false, errorCode: null, pagesFetched: 0, continuationRemaining: false }),
        doAlbums ? this.fetchLikedAlbums(mergedOpts) : Promise.resolve({ success: true, albums: [], complete: true, failed: false, errorCode: null, pagesFetched: 0, continuationRemaining: false })
      ]);

      const rateLimitedRes = [likesRes, playlistsRes, albumsRes].find(r => r && r.httpStatus === 429);
      if (rateLimitedRes) {
        return {
          success: false,
          accountId: account.id,
          status: 429,
          httpStatus: 429,
          retryAfter: rateLimitedRes.retryAfter || null,
          errorCode: 'RATE_LIMITED',
          error: rateLimitedRes.error || 'HTTP 429 rate limited'
        };
      }

      const abortedRes = [likesRes, playlistsRes, albumsRes].find(r => r && r.errorCode === 'ABORTED');
      if (abortedRes || (mergedOpts.signal && mergedOpts.signal.aborted)) {
        return {
          success: false,
          accountId: account.id,
          status: 499,
          httpStatus: 499,
          errorCode: 'ABORTED',
          error: (abortedRes && abortedRes.error) || 'Request aborted'
        };
      }

      const requestedResults = [
        doLikes ? likesRes : null,
        doPlaylists ? playlistsRes : null,
        doAlbums ? albumsRes : null
      ].filter(Boolean);
      const allFailed = requestedResults.length > 0 && requestedResults.every(r => r.failed);
      if (allFailed) {
        const firstErr = requestedResults[0];
        return {
          success: false,
          accountId: account.id,
          status: firstErr.httpStatus || 502,
          httpStatus: firstErr.httpStatus || 502,
          errorCode: firstErr.errorCode || 'FETCH_ERROR',
          error: firstErr.error || 'Failed to fetch YouTube Music library'
        };
      }

      return {
        success: true,
        accountId: account.id,
        likes: likesRes.tracks || [],
        likesMeta: {
          complete: likesRes.complete,
          failed: likesRes.failed,
          errorCode: likesRes.errorCode,
          pagesFetched: likesRes.pagesFetched,
          continuationRemaining: likesRes.continuationRemaining
        },
        playlists: playlistsRes.playlists || [],
        playlistsMeta: {
          complete: playlistsRes.complete,
          failed: playlistsRes.failed,
          errorCode: playlistsRes.errorCode,
          pagesFetched: playlistsRes.pagesFetched,
          continuationRemaining: playlistsRes.continuationRemaining
        },
        albums: albumsRes.albums || [],
        albumsMeta: {
          complete: albumsRes.complete,
          failed: albumsRes.failed,
          errorCode: albumsRes.errorCode,
          pagesFetched: albumsRes.pagesFetched,
          continuationRemaining: albumsRes.continuationRemaining
        }
      };
    } catch (err) {
      return {
        success: false,
        status: err.httpStatus || err.status || 500,
        httpStatus: err.httpStatus || err.status || 500,
        retryAfter: err.retryAfter || null,
        errorCode: err.code || (err.name === 'AbortError' ? 'ABORTED' : 'FETCH_ERROR'),
        error: err.message
      };
    } finally {
      if (requestId) this.activeControllers.delete(requestId);
    }
  }
}

module.exports = {
  YtmLibraryService,
  buildActiveAccountHeaders,
  extractTracksFromPage,
  extractAlbumsFromPage,
  extractPlaylistsFromPage,
  findContinuationToken,
  parseDurationSec,
  parseRetryAfterSeconds
};
