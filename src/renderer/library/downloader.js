// JavaScript / downloader.js / Production Batch Track Downloader Service
// Part of Eclipse Music Player — MIT License

async function downloadTrackBatch(tracks, options = {}) {
  const list = Array.isArray(tracks) ? tracks : [];
  if (list.length === 0) return { done: [], failed: [] };

  const getTkn = options.getInternalApiToken || (typeof globalThis.getInternalApiToken === 'function' ? globalThis.getInternalApiToken : () => '');
  const getBase = options.getInternalApiBase || (typeof globalThis.getInternalApiBase === 'function' ? globalThis.getInternalApiBase : () => 'http://127.0.0.1:38472');
  const tkn = getTkn();
  const base = getBase();
  const signal = options && options.signal ? options.signal : null;

  const downloadOne = async (t) => {
    if (signal && signal.aborted) {
      const err = new Error('AbortError');
      err.name = 'AbortError';
      throw err;
    }
    const thumbUrl = t.thumbnail || t.cover || '';
    const dlUrl = `${base}/api/download?url=${encodeURIComponent(t.url || '')}&id=${encodeURIComponent(t.id || '')}&title=${encodeURIComponent(t.title || '')}&artist=${encodeURIComponent(t.artist || '')}&format=m4a&quality=high&thumbnail=${encodeURIComponent(thumbUrl)}&token=${encodeURIComponent(tkn)}&t=${encodeURIComponent(tkn)}`;
    const fetchOpts = { headers: { 'X-Eclipse-Token': tkn, 'X-Muriel-Token': tkn } };
    if (signal) fetchOpts.signal = signal;
    const res = await fetch(dlUrl, fetchOpts);
    const data = await res.json();
    if (!data || !data.success) {
      const err = new Error((data && data.error) || 'Failed to download track');
      err.status = res.status;
      throw err;
    }
    t.isCached = true;
    return data;
  };

  const done = [];
  const failed = [];
  for (const item of list) {
    try {
      await downloadOne(item);
      done.push(item);
    } catch (error) {
      failed.push({ item, error });
      if (signal && signal.aborted) break;
    }
  }
  return { done, failed };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { downloadTrackBatch };
}
if (typeof window !== 'undefined') {
  window.downloadTrackBatch = downloadTrackBatch;
}
