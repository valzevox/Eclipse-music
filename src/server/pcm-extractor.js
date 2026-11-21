// src/server/pcm-extractor.js
// Server-side bounded PCM extraction for Smart AutoMix DJ.
// Fetches a strictly bounded byte window with HTTP Range (206) enforcement,
// rejects HLS/404/oversized streams, and decodes to mono Float32Array PCM
// via native WAV parser or bounded FFmpeg pipe with full AbortSignal + timeout kill.

const http = require('http');
const https = require('https');
const { spawn } = require('child_process');

const DEFAULT_TARGET_SAMPLE_RATE = 22050;
const DEFAULT_MAX_DURATION_SEC = 20;
const DEFAULT_MAX_INPUT_BYTES = 524288; // 512 KB cap
const DEFAULT_TIMEOUT_MS = 12000;

/**
 * Parse a standard RIFF/WAVE PCM buffer (16-bit int or 32-bit float) into mono Float32Array.
 * Returns null if buffer is not a valid WAV header.
 */
function tryParseWavToMonoFloat32(buf, maxDurationSec = DEFAULT_MAX_DURATION_SEC) {
  if (!buf || buf.length < 44) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    return null;
  }

  let offset = 12;
  let audioFormat = 0;
  let numChannels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString('ascii', offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;

    if (chunkId === 'fmt ' && bodyStart + 16 <= buf.length) {
      audioFormat = buf.readUInt16LE(bodyStart);
      numChannels = buf.readUInt16LE(bodyStart + 2);
      sampleRate = buf.readUInt32LE(bodyStart + 4);
      bitsPerSample = buf.readUInt16LE(bodyStart + 14);
    } else if (chunkId === 'data') {
      dataOffset = bodyStart;
      dataSize = Math.min(chunkSize, buf.length - bodyStart);
      break;
    }
    offset = bodyStart + chunkSize + (chunkSize % 2);
  }

  if (dataOffset < 0 || !sampleRate || !numChannels || (audioFormat !== 1 && audioFormat !== 3)) {
    return null;
  }

  const bytesPerSample = bitsPerSample / 8;
  const frameSize = bytesPerSample * numChannels;
  if (frameSize <= 0 || dataSize < frameSize) return null;

  const availableFrames = Math.floor(dataSize / frameSize);
  const maxFrames = Math.min(availableFrames, Math.floor(sampleRate * maxDurationSec));
  const mono = new Float32Array(maxFrames);

  for (let i = 0; i < maxFrames; i++) {
    let sum = 0;
    const framePos = dataOffset + i * frameSize;
    for (let ch = 0; ch < numChannels; ch++) {
      const pos = framePos + ch * bytesPerSample;
      if (audioFormat === 3 && bitsPerSample === 32) {
        sum += buf.readFloatLE(pos);
      } else if (audioFormat === 1 && bitsPerSample === 16) {
        sum += buf.readInt16LE(pos) / 32768;
      } else {
        return null;
      }
    }
    mono[i] = sum / numChannels;
  }

  return { samples: mono, sampleRate };
}

/**
 * Fetch a strictly bounded byte window from an HTTP/HTTPS URL.
 * Enforces Range: bytes=0-(maxInputBytes-1), rejects HLS/404/oversized 200 OK,
 * and aborts immediately on signal or timeout.
 */
function fetchBoundedAudioBytes(sourceUrl, options = {}) {
  const maxInputBytes = Math.max(4096, Number(options.maxInputBytes) || DEFAULT_MAX_INPUT_BYTES);
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const signal = options.signal || null;

  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      return reject(new Error('Aborted before fetch'));
    }

    let parsed;
    try {
      parsed = new URL(sourceUrl);
    } catch (_) {
      return reject(new Error('Invalid source URL'));
    }

    if (/\.m3u8(\?|$)/i.test(parsed.pathname)) {
      return reject(new Error('HLS playlists (.m3u8) are not supported for bounded PCM extraction'));
    }

    const client = parsed.protocol === 'https:' ? https : http;
    let settled = false;
    let req = null;
    let timer = null;

    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve(result);
    };

    const onAbort = () => {
      try { if (req) req.destroy(); } catch (_) {}
      finish(new Error('Aborted'));
    };

    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    timer = setTimeout(() => {
      try { if (req) req.destroy(); } catch (_) {}
      finish(new Error('Fetch timeout'));
    }, timeoutMs);

    req = client.get(parsed, {
      headers: {
        Range: `bytes=0-${maxInputBytes - 1}`,
        'User-Agent': 'Eclipse-AutoMix-Analyzer/1.0'
      }
    }, (res) => {
      const status = res.statusCode || 0;
      const contentType = String(res.headers['content-type'] || '').toLowerCase();
      const contentLength = Number(res.headers['content-length'] || 0);
      const contentRange = String(res.headers['content-range'] || '');

      if (contentType.includes('mpegurl') || contentType.includes('application/vnd.apple')) {
        res.destroy();
        return finish(new Error('HLS stream rejected'));
      }

      if (status !== 206 && status !== 200) {
        res.destroy();
        return finish(new Error(`Upstream HTTP ${status}`));
      }

      // If server ignored Range and returned 200 with a huge file (> 4x cap), refuse to download unbounded
      if (status === 200 && contentLength > maxInputBytes * 4) {
        res.destroy();
        return finish(new Error(`Server ignored Range (HTTP 200, Content-Length ${contentLength} exceeds safe bound)`));
      }

      const chunks = [];
      let totalRead = 0;

      res.on('data', (chunk) => {
        if (settled) return;
        const remaining = maxInputBytes - totalRead;
        if (remaining <= 0) {
          res.destroy();
          return;
        }
        const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
        chunks.push(slice);
        totalRead += slice.length;

        // Hard stop once byte cap is reached
        if (totalRead >= maxInputBytes) {
          res.destroy();
          const buffer = Buffer.concat(chunks, totalRead);
          finish(null, {
            buffer,
            bytesRead: totalRead,
            statusCode: status,
            rangeSupported: status === 206 && contentRange.length > 0,
            contentType
          });
        }
      });

      res.on('end', () => {
        if (settled) return;
        const buffer = Buffer.concat(chunks, totalRead);
        if (totalRead < 1024) {
          return finish(new Error(`Truncated audio response (${totalRead} bytes)`));
        }
        finish(null, {
          buffer,
          bytesRead: totalRead,
          statusCode: status,
          rangeSupported: status === 206 && contentRange.length > 0,
          contentType
        });
      });

      res.on('error', (err) => finish(err));
    });

    req.on('error', (err) => finish(err));
  });
}

/**
 * Decode compressed audio bytes (MP3/M4A/Opus/Ogg) to mono Float32Array PCM via FFmpeg pipe.
 */
function decodeWithFfmpeg(audioBuffer, options = {}) {
  const ffmpegBin = options.ffmpegBin || 'ffmpeg';
  const targetSampleRate = Number(options.targetSampleRate) || DEFAULT_TARGET_SAMPLE_RATE;
  const maxDurationSec = Number(options.maxDurationSec) || DEFAULT_MAX_DURATION_SEC;
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const maxPcmBytes = targetSampleRate * maxDurationSec * 4;
  const signal = options.signal || null;

  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new Error('Aborted before ffmpeg'));

    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-i', 'pipe:0',
      '-t', String(maxDurationSec),
      '-ac', '1',
      '-ar', String(targetSampleRate),
      '-f', 'f32le',
      'pipe:1'
    ];

    let proc;
    try {
      proc = spawn(ffmpegBin, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      return reject(err);
    }

    let settled = false;
    let totalOut = 0;
    const outChunks = [];
    let stderrText = '';

    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve(result);
    };

    const killProc = () => {
      try { proc.kill('SIGKILL'); } catch (_) {}
    };

    const onAbort = () => {
      killProc();
      finish(new Error('Aborted'));
    };

    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    const timer = setTimeout(() => {
      killProc();
      finish(new Error('FFmpeg decode timeout'));
    }, timeoutMs);

    proc.stdout.on('data', (chunk) => {
      if (settled) return;
      const remaining = maxPcmBytes - totalOut;
      if (remaining <= 0) {
        killProc();
        return;
      }
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      outChunks.push(slice);
      totalOut += slice.length;
    });

    proc.stderr.on('data', (d) => {
      if (stderrText.length < 512) stderrText += d.toString();
    });

    proc.on('error', (err) => finish(err));

    proc.on('close', (code) => {
      if (settled) return;
      if (totalOut < 4096) {
        return finish(new Error(`FFmpeg produced insufficient PCM (${totalOut} bytes, code ${code}): ${stderrText.trim()}`));
      }
      const alignedLen = totalOut - (totalOut % 4);
      const raw = Buffer.concat(outChunks, totalOut).subarray(0, alignedLen);
      const samples = new Float32Array(raw.buffer, raw.byteOffset, alignedLen / 4);
      finish(null, { samples, sampleRate: targetSampleRate });
    });

    proc.stdin.on('error', () => {});
    proc.stdin.end(audioBuffer);
  });
}

/**
 * Full bounded extraction pipeline: fetch bounded bytes -> decode WAV or FFmpeg -> mono Float32Array.
 */
async function extractBoundedPcm(sourceUrl, options = {}) {
  const fetched = await fetchBoundedAudioBytes(sourceUrl, options);
  const maxDurationSec = Number(options.maxDurationSec) || DEFAULT_MAX_DURATION_SEC;

  // 1. Fast path: native WAV parser (zero subprocess overhead, works on all platforms)
  const wav = tryParseWavToMonoFloat32(fetched.buffer, maxDurationSec);
  if (wav && wav.samples.length > 0) {
    return {
      samples: wav.samples,
      sampleRate: wav.sampleRate,
      bytesRead: fetched.bytesRead,
      statusCode: fetched.statusCode,
      rangeSupported: fetched.rangeSupported,
      decoder: 'wav'
    };
  }

  // 2. Compressed containers (MP3/M4A/Opus/Ogg): server-side bounded FFmpeg pipe
  const decoded = await decodeWithFfmpeg(fetched.buffer, options);
  return {
    samples: decoded.samples,
    sampleRate: decoded.sampleRate,
    bytesRead: fetched.bytesRead,
    statusCode: fetched.statusCode,
    rangeSupported: fetched.rangeSupported,
    decoder: 'ffmpeg'
  };
}

module.exports = {
  extractBoundedPcm,
  fetchBoundedAudioBytes,
  tryParseWavToMonoFloat32,
  decodeWithFfmpeg,
  DEFAULT_TARGET_SAMPLE_RATE,
  DEFAULT_MAX_DURATION_SEC,
  DEFAULT_MAX_INPUT_BYTES,
  DEFAULT_TIMEOUT_MS
};
