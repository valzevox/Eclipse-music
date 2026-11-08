// JavaScript / ytm-artist-full.js / Node.js / Full Artist Profile Parser via Innertube
// Part of Eclipse Music Player — MIT License

const { Innertube } = require('youtubei.js');

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const artistCache = new Map();

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
 * Clean and normalize browseId
 */
function normalizeBrowseId(id) {
  if (!id) return '';
  const clean = String(id).trim();
  const match = clean.match(/UC[\w-]{22}/);
  if (match) return match[0];
  return clean;
}

/**
 * Parse subscriber count from button text or accessibility label
 */
function parseSubscribers(subBtn) {
  if (!subBtn) return '';
  const label = subBtn.subscribe_accessibility_label || subBtn.unsubscribe_accessibility_label || '';
  const match = label.match(/[\d.,]+\s*(?:thousand|million|triệu|nghìn|K|M|B)?/i);
  if (match) return match[0];
  return subBtn.button_text?.toString() || '';
}

/**
 * Fetch Full Artist Profile by browseId
 */
async function getArtistProfile(browseId, country = 'VN') {
  const normId = normalizeBrowseId(browseId);
  if (!normId) {
    throw new Error('Invalid or missing artist browseId');
  }

  const cacheKey = `artist_${normId}_${country.toUpperCase()}`;
  const now = Date.now();
  const cached = artistCache.get(cacheKey);
  if (cached && (now - cached.timestamp) < CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const yt = await getInnertube(country);
    const artist = await yt.music.getArtist(normId);

    // Extract Header (Name, Avatar, Banner, Bio, Subs)
    const header = artist.header || {};
    const name = header.title?.toString() || '';
    const description = (header.description?.toString() || '').trim();
    const subs = parseSubscribers(header.subscription_button);

    // Banner & Avatar Images
    const bannerThumbnails = header.thumbnail?.contents || [];
    const banner = bannerThumbnails.length > 0 ? bannerThumbnails[0].url : '';
    const avatar = bannerThumbnails.length > 1 ? bannerThumbnails[bannerThumbnails.length - 1].url : banner;

    // Sections parsing
    let popularSongs = [];
    let albums = [];
    let singles = [];
    let videos = [];
    let featuredOn = [];
    let relatedArtists = [];

    for (const section of (artist.sections || [])) {
      const title = (section.header?.title?.toString() || section.type || '').toLowerCase();

      // Popular Songs
      if (title.includes('song') || title.includes('bài hát') || section.type === 'MusicShelf') {
        let rank = 1;
        for (const item of (section.contents || [])) {
          if (!item.id && !item.videoId) continue;
          const trackId = item.id || item.videoId;
          const trackTitle = item.title?.toString() || '';
          const artists = (item.authors || item.artists || []).map(a => ({
            name: a.name || a.text || '',
            id: a.channel_id || a.id || ''
          }));
          const artistName = artists.map(a => a.name).filter(Boolean).join(', ') || name || 'Unknown Artist';
          const thumb = item.thumbnails?.[0]?.url || item.thumbnail?.[0]?.url || `https://i.ytimg.com/vi/${trackId}/hqdefault.jpg`;

          popularSongs.push({
            rank: rank++,
            id: trackId,
            title: trackTitle,
            artist: artistName,
            artists,
            album: item.album?.name || '',
            duration: item.duration?.seconds || 0,
            views: item.views?.toString() || '',
            thumbnail: thumb,
            source: 'ytm'
          });
        }
      }

      // Albums
      else if (title.includes('album') && !title.includes('single')) {
        for (const item of (section.contents || [])) {
          const itemTitle = item.title?.toString() || '';
          const itemId = item.id || '';
          const thumb = item.thumbnail?.[0]?.url || item.thumbnails?.[0]?.url || '';
          const year = item.year || item.subtitle?.toString() || '';

          if (itemId && itemTitle) {
            albums.push({
              id: itemId,
              title: itemTitle,
              year,
              thumbnail: thumb,
              type: 'album'
            });
          }
        }
      }

      // Singles & EPs
      else if (title.includes('single') || title.includes('ep') || title.includes('đĩa đơn')) {
        for (const item of (section.contents || [])) {
          const itemTitle = item.title?.toString() || '';
          const itemId = item.id || '';
          const thumb = item.thumbnail?.[0]?.url || item.thumbnails?.[0]?.url || '';
          const year = item.year || item.subtitle?.toString() || '';

          if (itemId && itemTitle) {
            singles.push({
              id: itemId,
              title: itemTitle,
              year,
              thumbnail: thumb,
              type: 'single'
            });
          }
        }
      }

      // Music Videos
      else if (title.includes('video') || title.includes('mv')) {
        for (const item of (section.contents || [])) {
          const itemTitle = item.title?.toString() || '';
          const itemId = item.id || '';
          const thumb = item.thumbnail?.[0]?.url || item.thumbnails?.[0]?.url || '';
          const views = item.views?.toString() || '';

          if (itemId && itemTitle) {
            videos.push({
              id: itemId,
              title: itemTitle,
              views,
              thumbnail: thumb,
              type: 'video'
            });
          }
        }
      }

      // Featured On / Appears On
      else if (title.includes('featured') || title.includes('xuất hiện') || title.includes('appears on')) {
        for (const item of (section.contents || [])) {
          const itemTitle = item.title?.toString() || '';
          const itemId = item.id || '';
          const thumb = item.thumbnail?.[0]?.url || item.thumbnails?.[0]?.url || '';

          if (itemId && itemTitle) {
            featuredOn.push({
              id: itemId,
              title: itemTitle,
              thumbnail: thumb,
              type: 'playlist'
            });
          }
        }
      }

      // Fans Might Also Like / Similar Artists
      else if (title.includes('like') || title.includes('fan') || title.includes('nghệ sĩ tương tự') || title.includes('similar')) {
        for (const item of (section.contents || [])) {
          const artistName = item.title?.toString() || '';
          const artistId = item.id || '';
          const subsText = item.subscribers?.toString() || item.subtitle?.toString() || '';
          const thumb = item.thumbnail?.[0]?.url || item.thumbnails?.[0]?.url || '';

          if (artistId && artistName) {
            relatedArtists.push({
              id: artistId,
              name: artistName,
              subscribers: subsText,
              thumbnail: thumb,
              type: 'artist'
            });
          }
        }
      }
    }

    const result = {
      id: normId,
      name,
      bio: description,
      subscribers: subs,
      avatar,
      banner,
      bannerThumbnails,
      popularSongs,
      albums,
      singles,
      videos,
      featuredOn,
      relatedArtists,
      cachedAt: now
    };

    artistCache.set(cacheKey, { timestamp: now, data: result });
    return result;
  } catch (err) {
    if (cached) {
      console.warn(`[ytm-artist-full] Fetch failed for ${normId}, returning cached data:`, err.message);
      return cached.data;
    }
    throw err;
  }
}

module.exports = {
  getArtistProfile,
  normalizeBrowseId
};
