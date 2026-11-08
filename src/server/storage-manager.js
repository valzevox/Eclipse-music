// JavaScript / storage-manager.js / Node.js / Disk & Cache Storage Manager
// Part of Eclipse Music Player — MIT License

const fs = require('fs');
const path = require('path');

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

async function getDirStats(dirPath, extFilter = null) {
  let size = 0;
  let count = 0;

  try {
    if (!fs.existsSync(dirPath)) return { size: 0, count: 0, formatted: '0 B' };
    const files = await fs.promises.readdir(dirPath);
    for (const file of files) {
      if (extFilter && !extFilter.test(file)) continue;
      try {
        const stat = await fs.promises.stat(path.join(dirPath, file));
        if (stat.isFile()) {
          size += stat.size;
          count++;
        }
      } catch (_) {}
    }
  } catch (_) {}

  return { size, count, formatted: formatBytes(size) };
}

/**
 * Get comprehensive storage breakdown
 */
async function getStorageStats(paths = {}) {
  const cacheDir = paths.CACHE_DIR || '';
  const thumbnailsDir = paths.THUMBNAILS_DIR || '';
  const lyricsDir = paths.CUSTOM_LYRICS_DIR || paths.LYRICS_DIR || '';

  const audioStats = await getDirStats(cacheDir, /\.(opus|webm|m4a|mp3|aac)$/i);
  const thumbnailStats = await getDirStats(thumbnailsDir, /\.(jpg|jpeg|png|webp)$/i);
  const lyricsStats = await getDirStats(lyricsDir, /\.(lrc|txt|json)$/i);

  const totalBytes = audioStats.size + thumbnailStats.size + lyricsStats.size;

  return {
    audio: audioStats,
    thumbnails: thumbnailStats,
    lyrics: lyricsStats,
    totalBytes,
    formattedTotal: formatBytes(totalBytes)
  };
}

/**
 * Clear specific storage section
 */
async function clearStorage(type, paths = {}) {
  const results = { type, deletedCount: 0, freedBytes: 0 };
  const targetDir = type === 'thumbnails' ? paths.THUMBNAILS_DIR : (type === 'lyrics' ? (paths.CUSTOM_LYRICS_DIR || paths.LYRICS_DIR) : paths.CACHE_DIR);

  if (!targetDir || !fs.existsSync(targetDir)) return results;

  try {
    const files = await fs.promises.readdir(targetDir);
    const filter = type === 'audio' ? /\.(opus|webm|m4a|mp3|aac)$/i : (type === 'thumbnails' ? /\.(jpg|jpeg|png|webp)$/i : (type === 'lyrics' ? /\.(lrc|txt)$/i : null));

    for (const file of files) {
      if (filter && !filter.test(file)) continue;
      const fullPath = path.join(targetDir, file);
      try {
        const stat = await fs.promises.stat(fullPath);
        await fs.promises.unlink(fullPath);
        results.deletedCount++;
        results.freedBytes += stat.size;
      } catch (_) {}
    }
  } catch (_) {}

  results.formattedFreed = formatBytes(results.freedBytes);
  return results;
}

module.exports = {
  getStorageStats,
  clearStorage,
  formatBytes
};
