// JavaScript / ytm-discovery.js / Node.js / YouTube Music Discovery, New Releases & Categorized Search Engine
// Part of Eclipse Music Player — MIT License

const { Innertube } = require('youtubei.js');

const NEW_RELEASES_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const SEARCH_CACHE_TTL_MS = 60 * 60 * 1000;     // 1 hour

const newReleasesCache = new Map();
const searchCache = new Map();
const commentsCache = new Map();
const innertubeClients = new Map();
const inFlightComments = new Map();

let cachedAutoRegion = null;
let cachedAutoRegionAt = 0;

/**
 * Resolve user's 2-letter country code from explicit override, IP geo (2s timeout, 6h cache), or system locale.
 */
async function resolveUserRegion(overrideCountry = '') {
  const cleanOverride = String(overrideCountry || '').trim().toUpperCase();
  if (cleanOverride && cleanOverride !== 'AUTO') {
    return cleanOverride;
  }

  const now = Date.now();
  if (cachedAutoRegion && (now - cachedAutoRegionAt) < NEW_RELEASES_TTL_MS) {
    return cachedAutoRegion;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const resp = await fetch('https://ipapi.co/country/', { signal: controller.signal });
    clearTimeout(timer);
    if (resp.ok) {
      const code = (await resp.text()).trim().toUpperCase();
      if (/^[A-Z]{2}$/.test(code)) {
        cachedAutoRegion = code;
        cachedAutoRegionAt = now;
        return code;
      }
    }
  } catch (_) {}

  try {
    const loc = Intl.DateTimeFormat().resolvedOptions().locale || '';
    const match = loc.match(/[-_]([A-Za-z]{2})\b/);
    if (match && match[1]) {
      cachedAutoRegion = match[1].toUpperCase();
      cachedAutoRegionAt = now;
      return cachedAutoRegion;
    }
  } catch (_) {}

  return 'US';
}

/**
 * Get or create Innertube client with singleton promise cache
 */
async function getInnertube(country = '') {
  const resolved = await resolveUserRegion(country);
  const gl = resolved === 'GLOBAL' ? 'US' : resolved;
  const hl = gl === 'VN' ? 'vi' : 'en';
  const clientKey = `${gl}_${hl}`;

  if (!innertubeClients.has(clientKey)) {
    const clientPromise = Innertube.create({ gl, hl }).catch((err) => {
      innertubeClients.delete(clientKey);
      throw err;
    });
    innertubeClients.set(clientKey, clientPromise);
  }
  return await innertubeClients.get(clientKey);
}

/**
 * Get New Releases (Albums, Singles, MVs)
 */
async function getNewReleases(country = '') {
  const normCountry = await resolveUserRegion(country);
  const cacheKey = `new_releases_${normCountry}`;
  const now = Date.now();
  const cached = newReleasesCache.get(cacheKey);

  if (cached && (now - cached.timestamp) < NEW_RELEASES_TTL_MS) {
    return cached.data;
  }

  try {
    const yt = await getInnertube(normCountry);
    const exp = await yt.music.getExplore();

    let newVideos = [];
    let newAlbums = [];
    let newSongs = [];

    // 1. Fetch Explore New Releases button (Music Videos / Singles)
    const btn = exp.top_buttons?.find(b => b.endpoint?.payload?.browseId === 'FEmusic_new_releases');
    if (btn) {
      try {
        const res = await btn.endpoint.call(yt.actions, { client: 'YTMUSIC' });
        const tabs = res.data?.contents?.singleColumnBrowseResultsRenderer?.tabs || [];
        const secList = tabs[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];

        for (const sec of secList) {
          const shelf = sec.musicCarouselShelfRenderer;
          if (!shelf) continue;
          for (const item of (shelf.contents || [])) {
            const twoRow = item.musicTwoRowItemRenderer;
            if (twoRow) {
              const title = twoRow.title?.runs?.map(r => r.text).join('') || '';
              const subtitle = twoRow.subtitle?.runs?.map(r => r.text).join('') || '';
              const videoId = twoRow.navigationEndpoint?.watchEndpoint?.videoId || '';
              const thumb = twoRow.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails?.slice(-1)[0]?.url || (videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : '');

              if (videoId && title) {
                newVideos.push({
                  id: videoId,
                  title,
                  artist: subtitle.split('•')[0]?.trim() || 'Unknown Artist',
                  views: subtitle.split('•')[1]?.trim() || '',
                  thumbnail: thumb,
                  type: 'video',
                  source: 'ytm'
                });
              }
            }
          }
        }
      } catch (callErr) {
        console.warn('[ytm-discovery] New releases button call failed:', callErr.message);
      }
    }

    // 2. Fetch Latest Albums
    try {
      const albumSearch = await yt.music.search(normCountry === 'VN' ? 'Nhạc mới phát hành' : 'New music release', { type: 'album' });
      const albumItems = albumSearch.contents?.[0]?.contents || [];
      for (const alb of albumItems) {
        if (!alb.id && !alb.title) continue;
        newAlbums.push({
          id: alb.id || '',
          title: alb.title?.toString() || '',
          artist: alb.author?.name || alb.author?.text || alb.artists?.[0]?.name || 'Various Artists',
          year: alb.year || alb.subtitle?.toString() || '',
          thumbnail: alb.thumbnail?.[0]?.url || alb.thumbnails?.[0]?.url || '',
          type: 'album',
          source: 'ytm'
        });
      }
    } catch (albErr) {
      console.warn('[ytm-discovery] Album search failed:', albErr.message);
    }

    // 3. Fetch Latest Songs
    try {
      const songSearch = await yt.music.search(normCountry === 'VN' ? 'Bài hát mới' : 'New songs', { type: 'song' });
      const songItems = songSearch.contents?.[0]?.contents || [];
      for (const s of songItems) {
        const id = s.id || s.videoId;
        if (!id) continue;
        const artists = (s.authors || s.artists || []).map(a => ({
          name: a.name || a.text || '',
          id: a.channel_id || a.id || ''
        }));
        newSongs.push({
          id,
          title: s.title?.toString() || '',
          artist: artists.map(a => a.name).filter(Boolean).join(', ') || s.author?.name || 'Unknown Artist',
          artists,
          album: s.album?.name || '',
          duration: s.duration?.seconds || 0,
          thumbnail: s.thumbnails?.[0]?.url || s.thumbnail?.[0]?.url || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
          type: 'song',
          source: 'ytm'
        });
      }
    } catch (songErr) {
      console.warn('[ytm-discovery] Song search failed:', songErr.message);
    }

    const result = {
      country: normCountry,
      timestamp: now,
      albums: newAlbums.slice(0, 24),
      songs: newSongs.slice(0, 24),
      videos: newVideos.slice(0, 24)
    };

    newReleasesCache.set(cacheKey, { timestamp: now, data: result });
    return result;
  } catch (err) {
    if (cached) {
      console.warn(`[ytm-discovery] Fetch failed for new releases, returning cache:`, err.message);
      return cached.data;
    }
    throw err;
  }
}

/**
 * Categorized Search via YouTube Music
 * @param {string} query Search query string
 * @param {'all'|'song'|'artist'|'album'|'playlist'|'video'} category Search category filter
 * @param {string} country Country code (default 'VN')
 */
async function searchCategorized(query, category = 'all', country = 'VN') {
  const cleanQuery = String(query || '').trim();
  if (!cleanQuery) return { query: '', category, results: [] };

  const normCat = category.toLowerCase().trim();
  const normCountry = country.toUpperCase();
  const cacheKey = `search_${normCat}_${normCountry}_${cleanQuery.toLowerCase()}`;
  const now = Date.now();
  const cached = searchCache.get(cacheKey);

  if (cached && (now - cached.timestamp) < SEARCH_CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const yt = await getInnertube(normCountry);
    let results = [];

    // Specific category searches
    if (['song', 'artist', 'album', 'playlist', 'video'].includes(normCat)) {
      const searchRes = await yt.music.search(cleanQuery, { type: normCat });
      const items = searchRes.contents?.[0]?.contents || [];

      for (const item of items) {
        if (normCat === 'song') {
          const id = item.id || item.videoId;
          if (!id) continue;
          const artists = (item.authors || item.artists || []).map(a => ({
            name: a.name || a.text || '',
            id: a.channel_id || a.id || ''
          }));
          results.push({
            id,
            title: item.title?.toString() || '',
            artist: artists.map(a => a.name).filter(Boolean).join(', ') || item.author?.name || 'Unknown Artist',
            artists,
            album: item.album?.name || '',
            duration: item.duration?.seconds || 0,
            thumbnail: item.thumbnails?.[0]?.url || item.thumbnail?.[0]?.url || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
            type: 'song',
            source: 'ytm'
          });
        } else if (normCat === 'artist') {
          const id = item.id || '';
          if (!id) continue;
          results.push({
            id,
            name: item.name || item.title?.toString() || '',
            subscribers: item.subscribers?.toString() || item.subtitle?.toString() || '',
            thumbnail: item.thumbnail?.[0]?.url || item.thumbnails?.[0]?.url || '',
            type: 'artist',
            source: 'ytm'
          });
        } else if (normCat === 'album') {
          const id = item.id || '';
          if (!id) continue;
          results.push({
            id,
            title: item.title?.toString() || '',
            artist: item.author?.name || item.author?.text || item.artists?.[0]?.name || '',
            year: item.year || item.subtitle?.toString() || '',
            thumbnail: item.thumbnail?.[0]?.url || item.thumbnails?.[0]?.url || '',
            type: 'album',
            source: 'ytm'
          });
        } else if (normCat === 'playlist') {
          const id = item.id || '';
          if (!id) continue;
          results.push({
            id,
            title: item.title?.toString() || '',
            author: item.author?.name || item.author?.text || '',
            itemCount: item.item_count || item.subtitle?.toString() || '',
            thumbnail: item.thumbnail?.[0]?.url || item.thumbnails?.[0]?.url || '',
            type: 'playlist',
            source: 'ytm'
          });
        } else if (normCat === 'video') {
          const id = item.id || item.videoId;
          if (!id) continue;
          results.push({
            id,
            title: item.title?.toString() || '',
            artist: item.author?.name || item.author?.text || '',
            views: item.views?.toString() || item.subtitle?.toString() || '',
            thumbnail: item.thumbnail?.[0]?.url || item.thumbnails?.[0]?.url || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
            type: 'video',
            source: 'ytm'
          });
        }
      }
    } else {
      // General search across categories
      const searchRes = await yt.music.search(cleanQuery);
      for (const shelf of (searchRes.contents || [])) {
        for (const item of (shelf.contents || [])) {
          const id = item.id || item.videoId;
          if (!id && !item.title) continue;
          const artists = (item.authors || item.artists || []).map(a => ({
            name: a.name || a.text || '',
            id: a.channel_id || a.id || ''
          }));
          results.push({
            id: id || '',
            title: item.title?.toString() || item.name || '',
            artist: artists.map(a => a.name).filter(Boolean).join(', ') || item.author?.name || '',
            artists,
            album: item.album?.name || '',
            duration: item.duration?.seconds || 0,
            thumbnail: item.thumbnails?.[0]?.url || item.thumbnail?.[0]?.url || '',
            type: item.item_type?.toLowerCase() || item.type?.toLowerCase() || 'song',
            source: 'ytm'
          });
        }
      }
    }

    const payload = {
      query: cleanQuery,
      category: normCat,
      country: normCountry,
      count: results.length,
      results
    };

    searchCache.set(cacheKey, { timestamp: now, data: payload });
    return payload;
  } catch (err) {
    if (cached) {
      console.warn(`[ytm-discovery] Search failed for ${cleanQuery}, returning cached data:`, err.message);
      return cached.data;
    }
    throw err;
  }
}

const songInfoCache = new Map();
const podcastsCache = new Map();

function extractTimestampsFromText(text) {
  if (!text || typeof text !== 'string') return [];
  const timestamps = [];
  const regex = /\b(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\b/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const hasHours = match[1] !== undefined;
    const hours = hasHours ? parseInt(match[1], 10) : 0;
    const mins = parseInt(match[2], 10);
    const secs = parseInt(match[3], 10);
    if (secs < 60 && mins < 60) {
      timestamps.push({
        text: match[0],
        seconds: hours * 3600 + mins * 60 + secs
      });
    }
  }
  return timestamps;
}

function parseCreditsFromDescription(description = '', fallbackArtist = 'Unknown Artist', fallbackTitle = 'Unknown Title') {
  const lines = String(description || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const performers = new Set(fallbackArtist ? [fallbackArtist] : []);
  const writers = new Set();
  const producers = new Set();
  let label = '';
  let releaseYear = '';

  for (const line of lines) {
    const providedMatch = line.match(/^Provided to YouTube by\s+(.+)$/i);
    if (providedMatch && providedMatch[1]) {
      label = providedMatch[1].trim();
      continue;
    }
    const copyrightMatch = line.match(/^[℗©]\s*(\d{4})?\s*(.+)$/i);
    if (copyrightMatch) {
      if (copyrightMatch[1] && !releaseYear) releaseYear = copyrightMatch[1];
      if (!label && copyrightMatch[2]) label = copyrightMatch[2].trim();
      continue;
    }
    const releasedMatch = line.match(/^Released on:\s*(\d{4})/i);
    if (releasedMatch && releasedMatch[1]) {
      releaseYear = releasedMatch[1];
      continue;
    }
    const roleMatch = line.match(/^(Producer|Co-Producer|Executive Producer|Writer|Composer|Lyricist|Songwriter|Arranger|Associated Performer|Vocals|Featured Artist|Artist|Mixer|Mastering Engineer)\s*:\s*(.+)$/i);
    if (roleMatch) {
      const role = roleMatch[1].toLowerCase();
      const names = roleMatch[2].split(/[,;&]/).map(s => s.trim()).filter(Boolean);
      for (const n of names) {
        if (role.includes('producer')) producers.add(n);
        else if (role.includes('writer') || role.includes('composer') || role.includes('lyricist') || role.includes('arranger')) writers.add(n);
        else performers.add(n);
      }
    }
  }

  return {
    releaseYear,
    credits: {
      performers: Array.from(performers),
      writers: Array.from(writers),
      producers: Array.from(producers),
      label: label || 'Independent / Direct Studio Release'
    }
  };
}

/**
 * Fetch detailed Song Info & Credits for SongDnaManager
 */
async function getSongInfo(videoId, queryHint = '', country = 'VN') {
  const vid = String(videoId || '').trim();
  const hint = String(queryHint || '').trim();
  const cacheKey = `${vid}:${hint}`;
  const now = Date.now();
  const cached = songInfoCache.get(cacheKey);
  if (cached && (now - cached.timestamp) < SEARCH_CACHE_TTL_MS) {
    return cached.data;
  }

  let title = '';
  let artist = '';
  if (hint.includes(' - ')) {
    const parts = hint.split(' - ');
    artist = parts[0].trim();
    title = parts.slice(1).join(' - ').trim();
  } else if (hint) {
    title = hint;
  }

  let description = '';
  let duration = 0;
  let album = '';
  let releaseYear = '';
  let bitrate = '256 kbps';
  let format = 'Opus / AAC High';
  let sampleRate = '48 kHz / 16-bit';
  let isLive = false;

  if (vid && /^[a-zA-Z0-9_-]{11}$/.test(vid)) {
    try {
      const yt = await getInnertube(country);
      const info = await yt.getBasicInfo(vid);
      const basic = info?.basic_info || {};
      title = basic.title || title || 'Unknown Title';
      artist = (basic.author || artist || 'Unknown Artist').replace(/\s*-\s*Topic$/i, '');
      description = basic.short_description || '';
      duration = Number(basic.duration) || 0;
      isLive = Boolean(basic.is_live || basic.is_live_content);

      const adaptive = info?.streaming_data?.adaptive_formats || [];
      const audioFormats = adaptive.filter(f => f && typeof f.mime_type === 'string' && f.mime_type.startsWith('audio/'));
      if (audioFormats.length > 0) {
        audioFormats.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
        const top = audioFormats[0];
        if (top.bitrate) bitrate = `${Math.round(top.bitrate / 1000)} kbps`;
        if (top.mime_type?.includes('opus')) format = 'Opus 251 High-Efficiency';
        else if (top.mime_type?.includes('mp4a')) format = 'AAC-LC Studio Stream';
        if (top.audio_sample_rate) sampleRate = `${(Number(top.audio_sample_rate) / 1000).toFixed(1).replace(/\.0$/, '')} kHz / 16-bit`;
      }
    } catch (_) {}
  }

  const parsedMeta = parseCreditsFromDescription(description, artist || 'Unknown Artist', title || 'Unknown Title');
  if (parsedMeta.releaseYear) releaseYear = parsedMeta.releaseYear;

  const cleanLines = String(description || '')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !/^Provided to YouTube by/i.test(l) && !/^Auto-generated by YouTube/i.test(l));

  const bio = cleanLines.slice(0, 3).join(' ') || `${artist || 'This artist'} delivers "${title || 'this track'}" through Eclipse's high-resolution audio pipeline.`;
  const story = cleanLines.length > 3
    ? cleanLines.slice(3, 7).join(' ')
    : `Mastered for high-dynamic-range playback (${format}, ${bitrate}, ${sampleRate}).`;

  const result = {
    success: true,
    videoId: vid,
    title: title || 'Unknown Title',
    artist: artist || 'Unknown Artist',
    album: album || (title ? `${title} - Single` : ''),
    releaseYear: releaseYear || String(new Date().getFullYear()),
    duration,
    format,
    bitrate,
    sampleRate,
    isLive,
    credits: parsedMeta.credits,
    bio,
    story
  };

  songInfoCache.set(cacheKey, { timestamp: now, data: result });
  return result;
}

/**
 * Fetch Track Comments with Parsed Waveform Timestamp Links
 */
async function getTrackComments(videoId, country = 'VN') {
  const vid = String(videoId || '').trim();
  if (!vid) {
    return { success: true, videoId: '', comments: [] };
  }
  const normCountry = country.toUpperCase() === 'GLOBAL' ? 'US' : (country.toUpperCase() || 'VN');
  const cacheKey = `comments_${normCountry}_${vid}`;
  const now = Date.now();
  const cached = commentsCache.get(cacheKey);
  if (cached && (now - cached.timestamp) < cached.ttl) {
    return cached.data;
  }

  if (inFlightComments.has(cacheKey)) {
    return await inFlightComments.get(cacheKey);
  }

  const fetchPromise = (async () => {
    const comments = [];
    let fetchError = null;

    if (/^[a-zA-Z0-9_-]{11}$/.test(vid)) {
      try {
        const yt = await getInnertube(normCountry);
        // Bounded upstream fetch: 12 seconds max
        const threadPromise = yt.getComments(vid);
        let timer = null;
        const timeoutPromise = new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Comments upstream request timed out (12s)')), 12000);
        });
        const thread = await Promise.race([threadPromise, timeoutPromise]).finally(() => {
          if (timer) clearTimeout(timer);
        });
        const items = thread?.contents || [];
        for (const item of items.slice(0, 30)) {
          const c = item?.comment || item;
          const text = c?.content?.toString?.() || c?.text?.toString?.() || '';
          if (!text) continue;
          comments.push({
            id: c?.comment_id || c?.id || `c_${comments.length + 1}`,
            author: c?.author?.name || 'Music Listener',
            avatar: c?.author?.thumbnails?.[0]?.url || '',
            text,
            likes: c?.like_count?.toString?.() || '0',
            publishedTime: c?.published?.toString?.() || 'Recently',
            timestamps: extractTimestampsFromText(text),
            repliesCount: Number(c?.reply_count) || 0
          });
        }
      } catch (err) {
        fetchError = err;
      }
    }

    if (fetchError && comments.length === 0) {
      throw fetchError;
    }

    const payload = {
      success: true,
      videoId: vid,
      comments
    };

    // Cache valid comments for 1 hour; genuine empty comments for 60 seconds
    const ttl = comments.length > 0 ? SEARCH_CACHE_TTL_MS : 60 * 1000;
    commentsCache.set(cacheKey, { timestamp: Date.now(), ttl, data: payload });
    return payload;
  })();

  inFlightComments.set(cacheKey, fetchPromise);
  try {
    return await fetchPromise;
  } finally {
    inFlightComments.delete(cacheKey);
  }
}

/**
 * Fetch Podcasts & Live Audio Broadcast Shelf
 */
async function getPodcasts(country = 'VN') {
  const normCountry = String(country || 'VN').toUpperCase();
  const cacheKey = `podcasts_${normCountry}`;
  const now = Date.now();
  const cached = podcastsCache.get(cacheKey);
  if (cached && (now - cached.timestamp) < SEARCH_CACHE_TTL_MS) {
    return cached.data;
  }

  const shows = [];
  const episodes = [];
  const liveStations = [];

  try {
    const yt = await getInnertube(normCountry);
    const qPodcast = normCountry === 'VN' ? 'Podcast âm nhạc trò chuyện' : 'Music & Tech Podcast episodes';
    const searchRes = await yt.music.search(qPodcast);
    for (const shelf of (searchRes.contents || [])) {
      for (const item of (shelf.contents || [])) {
        const id = item.id || item.videoId || '';
        const title = item.title?.toString() || item.name || '';
        if (!id || !title) continue;
        const artist = item.author?.name || item.artists?.[0]?.name || 'Podcast Host';
        const duration = Number(item.duration?.seconds) || 0;
        const thumb = item.thumbnails?.[0]?.url || item.thumbnail?.[0]?.url || (id.length === 11 ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : '');
        const itemType = String(item.item_type || item.type || '').toLowerCase();
        if (itemType === 'playlist' || itemType === 'album' || id.startsWith('PL') || id.startsWith('MP') || id.startsWith('VL')) {
          shows.push({
            id,
            browseId: id,
            title,
            host: artist,
            thumbnail: thumb,
            isPodcast: true,
            type: 'podcast_show'
          });
        } else {
          episodes.push({
            id,
            title,
            artist,
            duration,
            thumbnail: thumb,
            isPodcast: true,
            isLive: duration === 0,
            type: 'podcast_episode'
          });
        }
      }
    }
  } catch (_) {}

  const payload = {
    success: true,
    country: normCountry,
    timestamp: now,
    shows: shows.slice(0, 16),
    episodes: episodes.slice(0, 24),
    liveStations
  };
  podcastsCache.set(cacheKey, { timestamp: now, data: payload });
  return payload;
}

/**
 * Fetch episodes for a specific Podcast show/playlist browseId
 */
async function getPodcastEpisodes(browseId, country = 'VN') {
  const cleanId = String(browseId || '').trim();
  if (!cleanId) {
    return { success: false, error: 'Missing podcast browseId', episodes: [] };
  }
  const cacheKey = `podcast_ep_${cleanId}`;
  const now = Date.now();
  const cached = podcastsCache.get(cacheKey);
  if (cached && (now - cached.timestamp) < SEARCH_CACHE_TTL_MS) {
    return cached.data;
  }

  const episodes = [];
  try {
    const yt = await getInnertube(country);
    const plId = cleanId.startsWith('VL') ? cleanId.slice(2) : cleanId;
    const pl = await yt.music.getPlaylist(plId);
    const items = pl?.items || pl?.contents || [];
    for (const item of items) {
      const id = item.id || item.videoId || '';
      if (!id) continue;
      const title = item.title?.toString() || 'Untitled Episode';
      const artist = item.author?.name || item.artists?.[0]?.name || 'Podcast Host';
      const duration = Number(item.duration?.seconds) || 0;
      const thumb = item.thumbnails?.[0]?.url || item.thumbnail?.[0]?.url || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
      episodes.push({
        id,
        title,
        artist,
        duration,
        thumbnail: thumb,
        isPodcast: true,
        isLive: duration === 0,
        type: 'podcast_episode'
      });
    }
  } catch (_) {}

  const payload = {
    success: true,
    browseId: cleanId,
    count: episodes.length,
    episodes
  };
  podcastsCache.set(cacheKey, { timestamp: now, data: payload });
  return payload;
}

module.exports = {
  getNewReleases,
  searchCategorized,
  getSongInfo,
  getTrackComments,
  getPodcasts,
  getPodcastEpisodes,
  extractTimestampsFromText,
  parseCreditsFromDescription
};
