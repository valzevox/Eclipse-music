// JavaScript / ytm-mv.js / Node.js / Music Video Resolver via Innertube
// Part of Eclipse Music Player — MIT License

const { Innertube } = require('youtubei.js');

const mvCache = new Map();
const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

let innertubePromise = null;
async function getInnertube() {
  if (!innertubePromise) {
    innertubePromise = Innertube.create({ gl: 'VN', hl: 'vi' });
  }
  return await innertubePromise;
}

/**
 * Resolve YouTube Music Video ID for a given track or search query
 */
async function resolveMusicVideo(videoId, title = '', artist = '') {
  // If videoId is already a valid 11-char ID, verify or return
  if (videoId && /^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return {
      videoId,
      title: title || 'Official Video',
      artist: artist || '',
      embedUrl: `https://www.youtube.com/embed/${videoId}?enablejsapi=1&autoplay=1&playsinline=1&rel=0&modestbranding=1`,
      source: 'direct'
    };
  }

  const query = `${artist} ${title} official music video`.trim();
  const cacheKey = query.toLowerCase();
  const cached = mvCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp) < TTL_MS) {
    return cached.data;
  }

  try {
    const yt = await getInnertube();
    // Search video category
    const searchRes = await yt.music.search(query, { type: 'video' });
    const items = searchRes.contents?.[0]?.contents || [];

    if (items.length > 0) {
      const topHit = items[0];
      const resolvedId = topHit.id || topHit.videoId;
      if (resolvedId && /^[a-zA-Z0-9_-]{11}$/.test(resolvedId)) {
        const result = {
          videoId: resolvedId,
          title: topHit.title?.toString() || title,
          artist: topHit.author?.name || topHit.author?.text || artist,
          views: topHit.views?.toString() || '',
          thumbnail: topHit.thumbnail?.[0]?.url || `https://i.ytimg.com/vi/${resolvedId}/hqdefault.jpg`,
          embedUrl: `https://www.youtube.com/embed/${resolvedId}?enablejsapi=1&autoplay=1&playsinline=1&rel=0&modestbranding=1`,
          source: 'ytm'
        };
        mvCache.set(cacheKey, { timestamp: Date.now(), data: result });
        return result;
      }
    }

    // Fallback: search all
    const generalSearch = await yt.music.search(query);
    for (const shelf of (generalSearch.contents || [])) {
      for (const item of (shelf.contents || [])) {
        const id = item.id || item.videoId;
        if (id && /^[a-zA-Z0-9_-]{11}$/.test(id)) {
          const result = {
            videoId: id,
            title: item.title?.toString() || title,
            artist: item.author?.name || artist,
            embedUrl: `https://www.youtube.com/embed/${id}?enablejsapi=1&autoplay=1&playsinline=1&rel=0&modestbranding=1`,
            source: 'ytm_fallback'
          };
          mvCache.set(cacheKey, { timestamp: Date.now(), data: result });
          return result;
        }
      }
    }

    throw new Error('No music video found for query: ' + query);
  } catch (err) {
    throw err;
  }
}

module.exports = {
  resolveMusicVideo
};
