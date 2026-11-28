// JavaScript / ytm-mv.js / Node.js / Music Video Resolver via Innertube
// Part of Eclipse Music Player — MIT License

const { Innertube } = require('youtubei.js');
const mvMappingStore = require('./mv-mapping-store');

const CONFIDENCE_THRESHOLD = 0.75;
const VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;

let innertubePromise = null;
async function getInnertube() {
  if (!innertubePromise) {
    innertubePromise = Innertube.create({ gl: 'VN', hl: 'vi' });
  }
  return await innertubePromise;
}

function normalizeText(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/\((?:official\s*(?:music\s*)?video|mv|m\/v|hd|4k|explicit|clean)[^)]*\)/gi, ' ')
    .replace(/\[(?:official\s*(?:music\s*)?video|mv|m\/v|hd|4k)[^\]]*\]/gi, ' ')
    .replace(/\b(?:feat\.?|ft\.?|featuring)\b/gi, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenOverlap(a, b) {
  const ta = new Set(normalizeText(a).split(' ').filter(Boolean));
  const tb = new Set(normalizeText(b).split(' ').filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let hits = 0;
  for (const t of ta) {
    if (tb.has(t)) hits++;
  }
  return hits / Math.max(ta.size, tb.size);
}

function parseDurationSec(raw) {
  if (Number.isFinite(raw)) return raw;
  if (raw && Number.isFinite(raw.seconds)) return raw.seconds;
  const text = typeof raw === 'string' ? raw : raw?.text;
  if (!text || typeof text !== 'string') return null;
  const parts = text.trim().split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

function buildEmbedUrl(videoId) {
  return `https://www.youtube.com/embed/${videoId}?enablejsapi=1&autoplay=1&playsinline=1&rel=0&modestbranding=1`;
}

function scoreCandidate(candidate, track = {}) {
  const candTitleRaw = String(candidate.title?.toString?.() || candidate.title || '');
  const candTitleLower = candTitleRaw.toLowerCase();
  const candArtistRaw = String(candidate.author?.name || candidate.author?.text || candidate.artist || '');
  const trackTitle = String(track.title || '');
  const trackArtist = String(track.artist || '');
  const trackTitleLower = trackTitle.toLowerCase();

  let score = 0;

  // Title similarity (up to +0.45)
  const titleSim = tokenOverlap(candTitleRaw, trackTitle);
  score += titleSim * 0.45;

  // Artist / channel match (up to +0.25)
  const artistSim = Math.max(
    tokenOverlap(candArtistRaw, trackArtist),
    trackArtist && candTitleLower.includes(normalizeText(trackArtist)) ? 0.8 : 0
  );
  score += artistSim * 0.25;

  // Official channel / VEVO bonus (+0.15)
  const isOfficialChannel = Boolean(
    candidate.author?.is_verified ||
    candidate.author?.is_official_artist_channel ||
    /vevo|official/i.test(candArtistRaw)
  );
  if (isOfficialChannel) score += 0.15;

  // Official MV keyword bonus (+0.15)
  if (/\b(official\s*(music\s*)?video|official\s*mv|m\/v)\b/i.test(candTitleLower)) {
    score += 0.15;
  }

  // Duration proximity (+0.10 / +0.05 / -0.20)
  const candDur = parseDurationSec(candidate.duration);
  const trackDur = parseDurationSec(track.durationSec);
  if (Number.isFinite(candDur) && Number.isFinite(trackDur) && trackDur > 0) {
    const diff = Math.abs(candDur - trackDur);
    if (diff <= 15) score += 0.10;
    else if (diff <= 30) score += 0.05;
    else if (diff > 90) score -= 0.20;
  }

  // Negative penalties unless original track title explicitly contains them
  const penalties = [
    [/\b(lyric\s*video|lyrics)\b/i, 0.35],
    [/\b(official\s*audio|audio\s*only)\b/i, 0.35],
    [/\b(karaoke|instrumental)\b/i, 0.45],
    [/\bcover\b/i, 0.40],
    [/\blive\b/i, 0.25],
    [/\b(sped\s*up|slowed|reverb)\b/i, 0.40],
    [/\bremix\b/i, 0.30],
    [/\b(reaction|teaser|trailer)\b/i, 0.45]
  ];
  for (const [re, penalty] of penalties) {
    if (re.test(candTitleLower) && !re.test(trackTitleLower)) {
      score -= penalty;
    }
  }

  return Math.max(0, Math.min(1, Number(score.toFixed(4))));
}

function normalizeCandidate(item, track) {
  const videoId = item.id || item.videoId;
  if (!videoId || !VIDEO_ID_RE.test(videoId)) return null;
  const title = item.title?.toString?.() || item.title || track.title || '';
  const artist = item.author?.name || item.author?.text || item.artist || track.artist || '';
  const durationSec = parseDurationSec(item.duration);
  const thumbnail = item.thumbnail?.[0]?.url || item.thumbnails?.[0]?.url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
  return {
    videoId,
    title,
    artist,
    durationSec,
    thumbnail,
    score: scoreCandidate(item, track)
  };
}

async function resolveMusicVideo(input, legacyTitle = '', legacyArtist = '') {
  const opts = (input && typeof input === 'object')
    ? input
    : { songId: input, title: legacyTitle, artist: legacyArtist };

  const songId = String(opts.songId || opts.id || '').trim();
  const title = String(opts.title || '').trim();
  const artist = String(opts.artist || '').trim();
  const durationSec = parseDurationSec(opts.durationSec);
  const forceRefresh = Boolean(opts.forceRefresh);
  const trustedVideoId = opts.trustedVideoId && VIDEO_ID_RE.test(opts.trustedVideoId) ? opts.trustedVideoId : null;

  // 1. Check persistent mapping store (manual override or valid auto mapping)
  let manualUnavailable = false;
  let unavailableVideoId = null;
  if (songId) {
    const stored = mvMappingStore.getMapping(songId);
    if (stored) {
      if (stored.userOverride && !stored.unavailable && VIDEO_ID_RE.test(stored.mvVideoId)) {
        return {
          found: true,
          videoId: stored.mvVideoId,
          title,
          artist,
          confidence: 1,
          offsetMs: stored.offsetMs || 0,
          source: 'manual',
          userOverride: true,
          embedUrl: buildEmbedUrl(stored.mvVideoId),
          candidates: []
        };
      }
      if (stored.userOverride && stored.unavailable) {
        manualUnavailable = true;
        unavailableVideoId = stored.mvVideoId;
      } else if (!forceRefresh && !stored.expired && VIDEO_ID_RE.test(stored.mvVideoId)) {
        return {
          found: true,
          videoId: stored.mvVideoId,
          title,
          artist,
          confidence: stored.confidence ?? CONFIDENCE_THRESHOLD,
          offsetMs: stored.offsetMs || 0,
          source: 'auto',
          userOverride: false,
          embedUrl: buildEmbedUrl(stored.mvVideoId),
          candidates: []
        };
      }
    }
  }

  // 2. Server-verified video asset (never from renderer isVideoAsset flag)
  if (trustedVideoId && !manualUnavailable) {
    const offsetMs = songId ? mvMappingStore.getOffsetForVideo(songId, trustedVideoId) : 0;
    return {
      found: true,
      videoId: trustedVideoId,
      title: title || 'Official Video',
      artist,
      confidence: 1,
      offsetMs,
      source: 'trusted_video',
      userOverride: false,
      embedUrl: buildEmbedUrl(trustedVideoId),
      candidates: []
    };
  }

  // 3. Search candidates via Innertube and score them
  const query = `${artist} ${title} official music video`.trim();
  if (!query) {
    return {
      found: false,
      reason: 'EMPTY_QUERY',
      confidenceThreshold: CONFIDENCE_THRESHOLD,
      bestScore: 0,
      candidates: []
    };
  }

  const yt = opts.innertube || await getInnertube();
  const searchRes = await yt.music.search(query, { type: 'video' });
  const rawItems = [];
  for (const shelf of (searchRes?.contents || [])) {
    for (const item of (shelf?.contents || [])) {
      rawItems.push(item);
    }
  }

  const seen = new Set();
  const scored = [];
  for (const item of rawItems) {
    const norm = normalizeCandidate(item, { title, artist, durationSec });
    if (!norm || seen.has(norm.videoId)) continue;
    seen.add(norm.videoId);
    scored.push(norm);
  }
  scored.sort((a, b) => b.score - a.score);
  const top5 = scored.slice(0, 5);
  const best = top5[0] || null;

  if (manualUnavailable) {
    return {
      found: false,
      reason: 'MANUAL_UNAVAILABLE',
      unavailableVideoId,
      confidenceThreshold: CONFIDENCE_THRESHOLD,
      bestScore: best?.score ?? 0,
      candidates: top5
    };
  }

  if (!best || best.score < CONFIDENCE_THRESHOLD) {
    return {
      found: false,
      reason: 'LOW_CONFIDENCE',
      confidenceThreshold: CONFIDENCE_THRESHOLD,
      bestScore: best?.score ?? 0,
      candidates: top5
    };
  }

  let offsetMs = 0;
  if (songId) {
    const saved = await mvMappingStore.saveAutoMapping(songId, {
      mvVideoId: best.videoId,
      confidence: best.score
    });
    offsetMs = saved.offsetMs || 0;
  }

  return {
    found: true,
    videoId: best.videoId,
    title: best.title,
    artist: best.artist,
    thumbnail: best.thumbnail,
    confidence: best.score,
    offsetMs,
    source: 'auto',
    userOverride: false,
    embedUrl: buildEmbedUrl(best.videoId),
    candidates: top5
  };
}

module.exports = {
  CONFIDENCE_THRESHOLD,
  resolveMusicVideo,
  scoreCandidate,
  normalizeText
};
