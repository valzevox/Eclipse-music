// src/server/ssrf-guard.js
// Shared SSRF & media target URL validator for /api/analyze-pcm and /api/audio-proxy.
// Blocks loopback, RFC1918, link-local, IPv6 ULA, IPv4-mapped IPv6, and DNS resolving to non-public IPs.
// Prevents nested /api/audio-proxy?url=... pivot bypasses.

const dns = require('dns');
const net = require('net');

const APPROVED_SELF_DIRECT_PATHS = new Set([
  '/api/local-track',
  '/api/library-file',
  '/api/downloaded-track'
]);

function isPrivateOrReservedIpv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0) return true;                          // 0.0.0.0/8 (unspecified)
  if (a === 10) return true;                         // 10.0.0.0/8 (RFC1918)
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
  if (a === 127) return true;                        // 127.0.0.0/8 (loopback)
  if (a === 169 && b === 254) return true;           // 169.254.0.0/16 (link-local / cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16.0.0/12 (RFC1918)
  if (a === 192 && b === 168) return true;           // 192.168.0.0/16 (RFC1918)
  if (a >= 224) return true;                         // Multicast & reserved
  return false;
}

function isPrivateOrReservedIp(rawIp) {
  if (!rawIp || typeof rawIp !== 'string') return true;
  const ip = rawIp.replace(/^\[|\]$/g, '').split('%')[0].toLowerCase();

  if (net.isIPv4(ip)) {
    return isPrivateOrReservedIpv4(ip);
  }

  if (net.isIPv6(ip)) {
    if (ip === '::' || ip === '::1') return true;
    // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1 or ::ffff:7f00:1)
    if (ip.startsWith('::ffff:')) {
      const mapped = ip.slice(7);
      if (net.isIPv4(mapped)) return isPrivateOrReservedIpv4(mapped);
      const hexParts = mapped.split(':');
      if (hexParts.length === 2) {
        const hi = parseInt(hexParts[0], 16);
        const lo = parseInt(hexParts[1], 16);
        if (!Number.isNaN(hi) && !Number.isNaN(lo)) {
          return isPrivateOrReservedIpv4(`${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`);
        }
      }
      return true;
    }
    // IPv6 ULA (fc00::/7 -> fc.. or fd..)
    if (/^f[cd][0-9a-f]{2}:/i.test(ip)) return true;
    // IPv6 link-local (fe80::/10 -> fe80..febf)
    if (/^fe[89ab][0-9a-f]:/i.test(ip)) return true;
    // IPv6 multicast (ff00::/8)
    if (ip.startsWith('ff')) return true;
    return false;
  }

  return true;
}

/**
 * Validate a media target URL for /api/analyze-pcm and /api/audio-proxy.
 *
 * @param {string} rawUrl
 * @param {object} [options]
 * @param {number|string} [options.activePort] - Eclipse local server port
 * @param {boolean} [options.allowSelfMedia] - Allow approved local Eclipse media endpoints
 * @param {Function} [options.lookup] - Optional DNS lookup override for testing
 * @param {number} [options._depth] - Internal recursion guard
 * @returns {Promise<{ ok: boolean, reason?: string, url?: URL, pinnedAddress?: string, isApprovedSelfMedia?: boolean }>}
 */
async function validateMediaTargetUrl(rawUrl, options = {}) {
  const depth = options._depth || 0;
  if (depth > 2) return { ok: false, reason: 'Nested proxy URL depth exceeded' };
  if (!rawUrl || typeof rawUrl !== 'string') return { ok: false, reason: 'Missing URL' };

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (_) {
    return { ok: false, reason: 'Invalid URL syntax' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: `Unsupported protocol: ${parsed.protocol}` };
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const activePort = options.activePort ? String(options.activePort) : '';
  const isSelfLoopback = (host === '127.0.0.1' && activePort && parsed.port === activePort);

  if (isSelfLoopback && options.allowSelfMedia) {
    // Direct local Eclipse media endpoints are explicitly allowed
    if (APPROVED_SELF_DIRECT_PATHS.has(parsed.pathname)) {
      return { ok: true, url: parsed, pinnedAddress: '127.0.0.1', isApprovedSelfMedia: true };
    }
    // /api/audio-proxy MUST NOT be a pivot to private/loopback destinations: recursively validate nested ?url=
    if (parsed.pathname === '/api/audio-proxy') {
      const nestedUrl = parsed.searchParams.get('url') || '';
      const nestedCheck = await validateMediaTargetUrl(nestedUrl, {
        ...options,
        allowSelfMedia: false,
        _depth: depth + 1
      });
      if (!nestedCheck.ok) {
        return { ok: false, reason: `Blocked nested audio-proxy target: ${nestedCheck.reason}` };
      }
      return { ok: true, url: parsed, pinnedAddress: '127.0.0.1', isApprovedSelfMedia: true };
    }
    return { ok: false, reason: `Disallowed local endpoint: ${parsed.pathname}` };
  }

  // Block explicit localhost / private IPs immediately
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return { ok: false, reason: 'Blocked localhost target' };
  }
  if (net.isIP(host)) {
    if (isPrivateOrReservedIp(host)) {
      return { ok: false, reason: `Blocked private/reserved IP: ${host}` };
    }
    return { ok: true, url: parsed, pinnedAddress: host, isApprovedSelfMedia: false };
  }

  // Resolve DNS and verify EVERY returned address is public
  const lookupFn = typeof options.lookup === 'function'
    ? options.lookup
    : (hostname) => dns.promises.lookup(hostname, { all: true });

  let records;
  try {
    records = await lookupFn(host);
  } catch (err) {
    return { ok: false, reason: `DNS resolution failed for ${host}: ${err.message}` };
  }

  const list = Array.isArray(records) ? records : (records ? [records] : []);
  if (list.length === 0) {
    return { ok: false, reason: `No DNS records for ${host}` };
  }

  for (const rec of list) {
    const addr = typeof rec === 'string' ? rec : rec.address;
    if (isPrivateOrReservedIp(addr)) {
      return { ok: false, reason: `DNS resolved to private/reserved IP: ${addr}` };
    }
  }

  const firstAddr = typeof list[0] === 'string' ? list[0] : list[0].address;
  return { ok: true, url: parsed, pinnedAddress: firstAddr, isApprovedSelfMedia: false };
}

module.exports = {
  validateMediaTargetUrl,
  isPrivateOrReservedIp,
  isPrivateOrReservedIpv4,
  APPROVED_SELF_DIRECT_PATHS
};
