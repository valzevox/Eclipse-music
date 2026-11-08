// JavaScript / ytm-discovery.js / Node.js / YouTube Music Discovery, New Releases & Categorized Search Engine
// Part of Eclipse Music Player — MIT License

const { Innertube } = require('youtubei.js');

const NEW_RELEASES_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const SEARCH_CACHE_TTL_MS = 60 * 60 * 1000;     // 1 hour

const newReleasesCache = new Map();
const searchCache = new Map();

/**
 * Get or create Innertube client
 */
async function getInnertube(country = 'VN') {
  return await Innertube.create({
    gl: country.toUpperCase() === 'GLOBAL' ? 'US' : country.toUpperCase(),
    hl: country.toUpperCase() === 'VN' ? 'vi' : 'en'
  });
}

/**
 * Get New Releases (Albums, Singles, MVs)
 */
async function getNewReleases(country = 'VN') {
  const normCountry = country.toUpperCase();
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

module.exports = {
  getNewReleases,
  searchCategorized
};
