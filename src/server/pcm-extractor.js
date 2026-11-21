// src/server/pcm-extractor.js
// Server-side bounded PCM extraction for Smart AutoMix DJ.
// Fetches a strictly bounded byte window with HTTP Range (206) & Content-Range validation,
// rejects HLS/404/oversized/inconsistent responses, and decodes to mono Float32Array PCM
// via native WAV parser (preserving source sample rate) or bounded FFmpeg pipe/URL seek
// (supporting MP3, faststart M4A, and moov-at-end M4A) with full AbortSignal + timeout kill.

const http = require('http');
const https = require('https');
const { spawn } = require('child_process');

const DEFAULT_TARGET_SAMPLE_RATE = 22050;
const DEFAULT_MAX_DURATION_SEC = 20;
const DEFAULT_MAX_INPUT_BYTES = 524288; // 512 KB initial probe cap
const DEFAULT_MAX_AGGREGATE_INPUT_BYTES = 2097152; // 2 MB aggregate cap for seek fallback (moov-at-EOF M4A)
const DEFAULT_TIMEOUT_MS = 12000;

/**
 * Parse and strictly validate an HTTP Content-Range header.
 * Must be `bytes <start>-<end>/<total|*>` with start === 0, end >= start, and valid total.
 * Returns { start, end, total, expectedLength } or null if invalid.
 */
function parseContentRange(header) {
  if (!header || typeof header !== 'string') return null;
  const m = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(header.trim());
  if (!m) return null;
  const start = Number(m[1]);
  const end = Number(m[2]);
  const total = m[3] === '*' ? null : Number(m[3]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) return null;
  if (total !== null && (!Number.isFinite(total) || total <= 0 || end >= total)) return null;
  return { start, end, total, expectedLength: end - start + 1 };
}

/**
 * Parse a standard RIFF/WAVE PCM buffer (16-bit int or 32-bit float) into mono Float32Array.
 * Note: Preserves the WAV source sample rate (e.g. 22050 Hz or 44100 Hz); TrackAnalyzer
 * handles arbitrary sample rates directly without resampling distortion.
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
 * Enforces Range: bytes=0-(maxInputBytes-1), strictly validates 206 Content-Range & Content-Length,
 * rejects HLS/404/oversized 200 OK/truncated payloads, and aborts immediately on signal or timeout.
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
      const rawContentLength = res.headers['content-length'];
      const contentLength = rawContentLength !== undefined ? Number(rawContentLength) : null;
      const contentRangeHeader = String(res.headers['content-range'] || '');

      if (contentType.includes('mpegurl') || contentType.includes('application/vnd.apple')) {
        res.destroy();
        return finish(new Error('HLS stream rejected'));
      }

      if (status !== 206 && status !== 200) {
        res.destroy();
        return finish(new Error(`Upstream HTTP ${status}`));
      }

      let rangeInfo = null;
      if (status === 206) {
        rangeInfo = parseContentRange(contentRangeHeader);
        if (!rangeInfo) {
          res.destroy();
          return finish(new Error(`Invalid or missing Content-Range on HTTP 206: "${contentRangeHeader}"`));
        }
        if (rangeInfo.start !== 0) {
          res.destroy();
          return finish(new Error(`Unexpected Content-Range start offset: ${rangeInfo.start} (expected 0)`));
        }
        if (contentLength !== null && Number.isFinite(contentLength) && contentLength !== rangeInfo.expectedLength) {
          res.destroy();
          return finish(new Error(`Inconsistent Content-Length (${contentLength}) vs Content-Range (${rangeInfo.expectedLength})`));
        }
      } else if (status === 200) {
        // If server ignored Range and returned 200 with a huge file (> 4x cap), refuse to download unbounded
        if (contentLength !== null && Number.isFinite(contentLength) && contentLength > maxInputBytes * 4) {
          res.destroy();
          return finish(new Error(`Server ignored Range (HTTP 200, Content-Length ${contentLength} exceeds safe bound)`));
        }
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

        // Hard stop once byte cap is reached (protects against 200 OK without Content-Length)
        if (totalRead >= maxInputBytes) {
          res.destroy();
          const buffer = Buffer.concat(chunks, totalRead);
          finish(null, {
            buffer,
            bytesRead: totalRead,
            statusCode: status,
            rangeSupported: status === 206 && rangeInfo !== null,
            partial: true,
            totalSize: rangeInfo ? rangeInfo.total : contentLength,
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
        // Detect mid-stream truncation when declared Content-Length/Content-Range was not satisfied
        const expected = rangeInfo ? Math.min(rangeInfo.expectedLength, maxInputBytes) : (contentLength ? Math.min(contentLength, maxInputBytes) : null);
        if (expected !== null && totalRead < expected) {
          return finish(new Error(`Truncated audio payload: received ${totalRead} of ${expected} bytes`));
        }
        finish(null, {
          buffer,
          bytesRead: totalRead,
          statusCode: status,
          rangeSupported: status === 206 && rangeInfo !== null,
          partial: rangeInfo !== null && rangeInfo.total !== null && totalRead < rangeInfo.total,
          totalSize: rangeInfo ? rangeInfo.total : contentLength,
          contentType
        });
      });

      res.on('error', (err) => finish(err));
    });

    req.on('error', (err) => finish(err));
  });
}

function runFfmpegDecode(ffmpegBin, args, inputBuffer, options = {}) {
  const targetSampleRate = Number(options.targetSampleRate) || DEFAULT_TARGET_SAMPLE_RATE;
  const maxDurationSec = Number(options.maxDurationSec) || DEFAULT_MAX_DURATION_SEC;
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const maxPcmBytes = targetSampleRate * maxDurationSec * 4;
  const signal = options.signal || null;

  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new Error('Aborted before ffmpeg'));

    let proc;
    try {
      proc = spawn(ffmpegBin, args, { stdio: [inputBuffer ? 'pipe' : 'ignore', 'pipe', 'pipe'], windowsHide: true });
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

    if (inputBuffer && proc.stdin) {
      proc.stdin.on('error', () => {});
      proc.stdin.end(inputBuffer);
    }
  });
}

/**
 * Decode compressed audio bytes (MP3/faststart M4A/Opus/Ogg) to mono Float32Array PCM via FFmpeg pipe.
 */
function decodeWithFfmpeg(audioBuffer, options = {}) {
  const ffmpegBin = options.ffmpegBin || 'ffmpeg';
  const targetSampleRate = Number(options.targetSampleRate) || DEFAULT_TARGET_SAMPLE_RATE;
  const maxDurationSec = Number(options.maxDurationSec) || DEFAULT_MAX_DURATION_SEC;
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
  return runFfmpegDecode(ffmpegBin, args, audioBuffer, options);
}

/**
 * Bounded seek-capable FFmpeg URL decode for M4A/MP4 containers whose moov atom is at EOF.
 * Routes FFmpeg through an ephemeral local loopback accounting proxy that enforces one
 * aggregate input byte budget across initial probe + all subsequent HTTP Range/seek requests.
 */
async function decodeUrlWithFfmpeg(sourceUrl, options = {}) {
  const ffmpegBin = options.ffmpegBin || 'ffmpeg';
  const targetSampleRate = Number(options.targetSampleRate) || DEFAULT_TARGET_SAMPLE_RATE;
  const maxDurationSec = Number(options.maxDurationSec) || DEFAULT_MAX_DURATION_SEC;
  const initialBytesRead = Math.max(0, Number(options.initialBytesRead) || 0);
  const maxAggregateBytes = Math.max(4096, Number(options.maxAggregateInputBytes || options.maxInputBytes) || DEFAULT_MAX_INPUT_BYTES);
  const outerSignal = options.signal || null;

  let parsedUpstream;
  try {
    parsedUpstream = new URL(sourceUrl);
  } catch (_) {
    throw new Error('Invalid source URL');
  }
  const client = parsedUpstream.protocol === 'https:' ? https : http;

  const internalAc = new AbortController();
  const onOuterAbort = () => internalAc.abort();
  if (outerSignal) {
    if (outerSignal.aborted) throw new Error('Aborted before seek decode');
    outerSignal.addEventListener('abort', onOuterAbort, { once: true });
  }

  let aggregateBytesRead = initialBytesRead;
  let budgetExceeded = false;
  const activeUpstreamReqs = new Set();

  const proxyServer = http.createServer((req, res) => {
    if (budgetExceeded || internalAc.signal.aborted) {
      res.writeHead(499);
      return res.end();
    }

    const headers = { 'User-Agent': 'Eclipse-AutoMix-Analyzer/1.0' };
    if (req.headers.range) headers.Range = req.headers.range;

    const upReq = client.get(parsedUpstream, { headers }, (upRes) => {
      const status = upRes.statusCode || 502;
      const outHeaders = {};
      if (upRes.headers['content-type']) outHeaders['content-type'] = upRes.headers['content-type'];
      if (upRes.headers['content-range']) outHeaders['content-range'] = upRes.headers['content-range'];
      if (upRes.headers['content-length']) outHeaders['content-length'] = upRes.headers['content-length'];
      if (upRes.headers['accept-ranges']) outHeaders['accept-ranges'] = upRes.headers['accept-ranges'];
      res.writeHead(status, outHeaders);

      upRes.on('data', (chunk) => {
        if (budgetExceeded || internalAc.signal.aborted) {
          upRes.destroy();
          res.destroy();
          return;
        }
        // Always count the full received upstream chunk (never under-report)
        aggregateBytesRead += chunk.length;
        if (aggregateBytesRead > maxAggregateBytes) {
          budgetExceeded = true;
          upRes.destroy();
          res.destroy();
          internalAc.abort();
          return;
        }
        if (!res.writableEnded) res.write(chunk);
      });

      upRes.on('end', () => { if (!res.writableEnded) res.end(); });
      upRes.on('error', () => { if (!res.writableEnded) res.destroy(); });
    });

    activeUpstreamReqs.add(upReq);
    upReq.on('close', () => activeUpstreamReqs.delete(upReq));
    upReq.on('error', () => { if (!res.writableEnded) { res.writeHead(502); res.end(); } });
    req.on('close', () => { try { upReq.destroy(); } catch (_) {} });
  });

  await new Promise((resolve) => proxyServer.listen(0, '127.0.0.1', resolve));
  const proxyUrl = `http://127.0.0.1:${proxyServer.address().port}/audio`;

  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-i', proxyUrl,
    '-t', String(maxDurationSec),
    '-ac', '1',
    '-ar', String(targetSampleRate),
    '-f', 'f32le',
    'pipe:1'
  ];

  try {
    const decoded = await runFfmpegDecode(ffmpegBin, args, null, {
      ...options,
      signal: internalAc.signal
    });
    if (budgetExceeded) {
      throw new Error(`Aggregate input byte budget exceeded (${aggregateBytesRead} > ${maxAggregateBytes})`);
    }
    return {
      samples: decoded.samples,
      sampleRate: decoded.sampleRate,
      bytesRead: aggregateBytesRead
    };
  } catch (err) {
    if (budgetExceeded) {
      throw new Error(`Aggregate input byte budget exceeded (${aggregateBytesRead}/${maxAggregateBytes} bytes)`);
    }
    throw err;
  } finally {
    if (outerSignal) outerSignal.removeEventListener('abort', onOuterAbort);
    for (const r of activeUpstreamReqs) { try { r.destroy(); } catch (_) {} }
    await new Promise((resolve) => proxyServer.close(resolve));
  }
}

function isIsoBmffContainer(buf, contentType) {
  if (contentType && (contentType.includes('mp4') || contentType.includes('m4a'))) return true;
  if (buf && buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp') return true;
  return false;
}

/**
 * Full bounded extraction pipeline: fetch bounded bytes -> decode WAV or FFmpeg -> mono Float32Array.
 */
async function extractBoundedPcm(sourceUrl, options = {}) {
  const fetched = await fetchBoundedAudioBytes(sourceUrl, options);
  const maxDurationSec = Number(options.maxDurationSec) || DEFAULT_MAX_DURATION_SEC;

  // 1. Fast path: native WAV parser (preserves source sample rate; zero subprocess overhead)
  const wav = tryParseWavToMonoFloat32(fetched.buffer, maxDurationSec);
  if (wav && wav.samples.length > 0) {
    return {
      samples: wav.samples,
      sampleRate: wav.sampleRate,
      bytesRead: fetched.bytesRead,
      statusCode: fetched.statusCode,
      rangeSupported: fetched.rangeSupported,
      partial: fetched.partial,
      decoder: 'wav'
    };
  }

  // 2. Compressed containers (MP3/M4A/Opus/Ogg): server-side bounded FFmpeg pipe
  try {
    const decoded = await decodeWithFfmpeg(fetched.buffer, options);
    return {
      samples: decoded.samples,
      sampleRate: decoded.sampleRate,
      bytesRead: fetched.bytesRead,
      statusCode: fetched.statusCode,
      rangeSupported: fetched.rangeSupported,
      partial: fetched.partial,
      decoder: 'ffmpeg'
    };
  } catch (pipeErr) {
    // 3. M4A/MP4 with moov atom at EOF: use bounded seek-capable FFmpeg HTTP Range proxy
    //    accounting for EVERY byte across initial probe + all seek requests.
    if (isIsoBmffContainer(fetched.buffer, fetched.contentType) && fetched.rangeSupported) {
      const seekBudget = Number(options.maxAggregateInputBytes)
        || Math.max(DEFAULT_MAX_AGGREGATE_INPUT_BYTES, (Number(options.maxInputBytes) || DEFAULT_MAX_INPUT_BYTES) * 2);
      const seekDecoded = await decodeUrlWithFfmpeg(sourceUrl, {
        ...options,
        initialBytesRead: fetched.bytesRead,
        maxAggregateInputBytes: seekBudget
      });
      return {
        samples: seekDecoded.samples,
        sampleRate: seekDecoded.sampleRate,
        bytesRead: seekDecoded.bytesRead,
        statusCode: fetched.statusCode,
        rangeSupported: fetched.rangeSupported,
        partial: true,
        decoder: 'ffmpeg-seek'
      };
    }
    throw pipeErr;
  }
}

module.exports = {
  extractBoundedPcm,
  fetchBoundedAudioBytes,
  parseContentRange,
  tryParseWavToMonoFloat32,
  decodeWithFfmpeg,
  decodeUrlWithFfmpeg,
  DEFAULT_TARGET_SAMPLE_RATE,
  DEFAULT_MAX_DURATION_SEC,
  DEFAULT_MAX_INPUT_BYTES,
  DEFAULT_MAX_AGGREGATE_INPUT_BYTES,
  DEFAULT_TIMEOUT_MS
};
