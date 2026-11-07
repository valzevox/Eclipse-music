// JavaScript / ytm-charts.js / Node.js / PC & Mobile YouTube Music Charts Engine
// Part of Eclipse Music Player — MIT License

const fs = require('fs');
const path = require('path');
const { Innertube } = require('youtubei.js');

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const cacheMap = new Map();

// Supported Country Codes & Names
const SUPPORTED_COUNTRIES = [
  { code: 'VN', name: 'Vietnam', flag: '🇻🇳' },
  { code: 'GLOBAL', name: 'Global', flag: '🌐' },
  { code: 'US', name: 'United States', flag: '🇺🇸' },
  { code: 'GB', name: 'United Kingdom', flag: '🇬🇧' },
  { code: 'KR', name: 'South Korea', flag: '🇰🇷' },
  { code: 'JP', name: 'Japan', flag: '🇯🇵' },
  { code: 'TH', name: 'Thailand', flag: '🇹🇭' },
  { code: 'ID', name: 'Indonesia', flag: '🇮🇩' },
  { code: 'PH', name: 'Philippines', flag: '🇵🇭' },
  { code: 'IN', name: 'India', flag: '🇮🇳' },
  { code: 'FR', name: 'France', flag: '🇫🇷' },
  { code: 'DE', name: 'Germany', flag: '🇩🇪' },
  { code: 'BR', name: 'Brazil', flag: '🇧🇷' },
  { code: 'MX', name: 'Mexico', flag: '🇲🇽' },
  { code: 'CA', name: 'Canada', flag: '🇨🇦' },
  { code: 'AU', name: 'Australia', flag: '🇦🇺' }
];

async function getInnertube(gl = 'VN') {
  const normGl = gl.toUpperCase() === 'GLOBAL' ? 'US' : gl.toUpperCase();
  return await Innertube.create({
    gl: normGl,
    hl: normGl === 'VN' ? 'vi' : 'en'
  });
}

/**
 * Get cached item or execute fetcher
 */
async function withCache(cacheKey, fetcher) {
  const now = Date.now();
  const cached = cacheMap.get(cacheKey);
  if (cached && (now - cached.timestamp) < CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const data = await fetcher();
    if (data && (Array.isArray(data) ? data.length > 0 : Object.keys(data).length > 0)) {
      cacheMap.set(cacheKey, { timestamp: now, data });
    }
    return data;
  } catch (err) {
    if (cached) {
      console.warn(`[ytm-charts] Fetch failed for ${cacheKey}, serving stale cache:`, err.message);
      return cached.data;
    }
    throw err;
  }
}

/**
 * Fetch YouTube Music Trending Songs and MVs
 */
async function getTrending(country = 'VN') {
  const normCountry = country.toUpperCase();
  const cacheKey = `trending_${normCountry}`;

  return await withCache(cacheKey, async () => {
    const yt = await getInnertube(normCountry);
    const explore = await yt.music.getExplore();

    let trendingTracks = [];
    let trendingVideos = [];

    for (const section of (explore.sections || [])) {
      const headerTitle = (section.header?.title?.toString() || '').toLowerCase();
      
      // Trending Tracks
      if (headerTitle.includes('trending') || headerTitle.includes('thịnh hành')) {
        for (const item of (section.contents || [])) {
          if (!item.id && !item.videoId) continue;
          const trackId = item.id || item.videoId;
          const title = item.title?.toString() || '';
          const artists = (item.authors || item.artists || []).map(a => ({
            name: a.name || a.text || '',
            id: a.channel_id || a.id || ''
          }));
          const artistName = artists.map(a => a.name).filter(Boolean).join(', ') || 'Unknown Artist';
          const thumbnail = item.thumbnails?.[0]?.url || item.thumbnail?.[0]?.url || `https://i.ytimg.com/vi/${trackId}/hqdefault.jpg`;

          trendingTracks.push({
            id: trackId,
            title,
            artist: artistName,
            artists,
            album: item.album?.name || '',
            duration: item.duration?.seconds || 0,
            views: item.views?.toString() || '',
            thumbnail,
            type: 'song',
            source: 'ytm'
          });
        }
      }

      // Music Videos
      if (headerTitle.includes('video') || headerTitle.includes('music video')) {
        for (const item of (section.contents || [])) {
          if (!item.id && !item.videoId) continue;
          const videoId = item.id || item.videoId;
          const title = item.title?.toString() || '';
          const author = item.author?.name || item.author?.text || '';
          const thumbnail = item.thumbnail?.[0]?.url || item.thumbnails?.[0]?.url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

          trendingVideos.push({
            id: videoId,
            title,
            artist: author,
            thumbnail,
            views: item.views?.toString() || '',
            type: 'video',
            source: 'ytm'
          });
        }
      }
    }

    return {
      country: normCountry,
      timestamp: Date.now(),
      tracks: trendingTracks,
      videos: trendingVideos
    };
  });
}

/**
 * Fetch YouTube Music Charts (Top Songs, Top MVs, Top Artists)
 */
async function getCharts(country = 'VN') {
  const normCountry = country.toUpperCase();
  const cacheKey = `charts_${normCountry}`;

  return await withCache(cacheKey, async () => {
    const yt = await getInnertube(normCountry);
    const explore = await yt.music.getExplore();

    let chartPlaylists = [];
    let topArtists = [];

    // Locate Charts entry button
    const chartBtn = explore.top_buttons?.find(b => b.endpoint?.payload?.browseId === 'FEmusic_charts');
    if (chartBtn) {
      try {
        const res = await chartBtn.endpoint.call(yt.actions, { client: 'YTMUSIC' });
        const tabs = res.data?.contents?.singleColumnBrowseResultsRenderer?.tabs || [];
        const sections = tabs[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];

        for (const sec of sections) {
          const carousel = sec.musicCarouselShelfRenderer;
          if (!carousel) continue;

          const title = carousel.header?.musicCarouselShelfBasicHeaderRenderer?.title?.runs?.map(r => r.text).join('') || '';

          // Playlists (Video charts / Trending lists)
          if (title.toLowerCase().includes('chart') || title.toLowerCase().includes('video')) {
            for (const item of (carousel.contents || [])) {
              const twoRow = item.musicTwoRowItemRenderer;
              if (twoRow) {
                const plTitle = twoRow.title?.runs?.map(r => r.text).join('') || '';
                const plSubtitle = twoRow.subtitle?.runs?.map(r => r.text).join('') || '';
                const browseId = twoRow.navigationEndpoint?.browseEndpoint?.browseId || '';
                const playlistId = browseId.replace(/^VL/, '');
                const thumb = twoRow.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails?.slice(-1)[0]?.url || '';

                if (playlistId) {
                  chartPlaylists.push({
                    id: playlistId,
                    title: plTitle,
                    subtitle: plSubtitle,
                    thumbnail: thumb,
                    type: 'chart_playlist'
                  });
                }
              }
            }
          }

          // Top Artists
          if (title.toLowerCase().includes('artist') || title.toLowerCase().includes('nghệ sĩ')) {
            let rank = 1;
            for (const item of (carousel.contents || [])) {
              const row = item.musicResponsiveListItemRenderer;
              if (row) {
                const name = row.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.text || '';
                const subs = row.flexColumns?.[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.text || '';
                const browseId = row.navigationEndpoint?.browseEndpoint?.browseId || '';
                const thumb = row.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails?.slice(-1)[0]?.url || '';

                if (name) {
                  topArtists.push({
                    rank: rank++,
                    name,
                    subscribers: subs,
                    browseId,
                    thumbnail: thumb,
                    type: 'artist'
                  });
                }
              }
            }
          }
        }
      } catch (callErr) {
        console.warn('[ytm-charts] Charts button call failed:', callErr.message);
      }
    }

    return {
      country: normCountry,
      timestamp: Date.now(),
      playlists: chartPlaylists,
      artists: topArtists
    };
  });
}

/**
 * Fetch Top Songs playlist tracks (e.g. Trending 20 or Top 100)
 */
async function getChartPlaylistTracks(playlistId) {
  const normId = playlistId.replace(/^VL/, '');
  const cacheKey = `chart_pl_${normId}`;

  return await withCache(cacheKey, async () => {
    const yt = await getInnertube('VN');
    const pl = await yt.music.getPlaylist(normId);

    const tracks = (pl.items || []).map((t, idx) => ({
      rank: idx + 1,
      id: t.id || t.videoId,
      title: t.title?.toString() || '',
      artist: (t.artists || t.authors || []).map(a => a.name || a.text || '').filter(Boolean).join(', ') || t.author?.name || 'Unknown Artist',
      artists: (t.artists || t.authors || []).map(a => ({ name: a.name || a.text || '', id: a.channel_id || a.id || '' })),
      album: t.album?.name || '',
      duration: t.duration?.seconds || 0,
      thumbnail: t.thumbnails?.[0]?.url || `https://i.ytimg.com/vi/${t.id || t.videoId}/hqdefault.jpg`,
      views: t.views?.toString() || '',
      source: 'ytm'
    }));

    return {
      id: normId,
      title: pl.header?.title?.toString() || '',
      subtitle: pl.header?.subtitle?.toString() || '',
      thumbnail: pl.header?.thumbnails?.[0]?.url || '',
      trackCount: tracks.length,
      tracks
    };
  });
}

module.exports = {
  SUPPORTED_COUNTRIES,
  getTrending,
  getCharts,
  getChartPlaylistTracks
};
