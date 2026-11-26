// d:\Eclipse\eclipse-pc\src\main\updater-core.js
// Platform-independent logic for Eclipse Enterprise Auto-Updater
const crypto = require('crypto');

function parseSemVer(v) {
  const str = String(v || '').trim().replace(/^v/i, '');
  const [main, prerelease] = str.split('-');
  const parts = main.split('.').map(n => parseInt(n, 10) || 0);
  while (parts.length < 3) parts.push(0);
  return {
    major: parts[0],
    minor: parts[1],
    patch: parts[2],
    prerelease: prerelease ? prerelease.trim().toLowerCase() : null,
    raw: str
  };
}

function isNewerSemVer(remote, local) {
  const r = parseSemVer(remote);
  const l = parseSemVer(local);

  if (r.major !== l.major) return r.major > l.major;
  if (r.minor !== l.minor) return r.minor > l.minor;
  if (r.patch !== l.patch) return r.patch > l.patch;

  // Same main version: standard release is newer than prerelease
  // e.g. 1.0.0 is newer than 1.0.0-beta.1
  if (l.prerelease && !r.prerelease) return true;
  if (!l.prerelease && r.prerelease) return false;
  if (l.prerelease && r.prerelease) {
    return r.prerelease.localeCompare(l.prerelease, undefined, { numeric: true }) > 0;
  }
  return false;
}

function findMatchingAsset(assets = [], platform = process.platform, arch = process.arch) {
  if (!Array.isArray(assets) || assets.length === 0) return null;
  const getName = (a) => String((a && (a.name || a.url)) || '');
  const validAssets = assets.filter(a => a && getName(a) && !/\.blockmap$/i.test(getName(a)));

  if (platform === 'win32') {
    const is64 = arch === 'x64' || arch === 'arm64' || (arch !== 'ia32' && !!process.env.ProgramFiles);
    if (is64) {
      return validAssets.find(a => /win-x64\.exe$/i.test(getName(a)) || /x64\.exe$/i.test(getName(a)))
        || validAssets.find(a => /win\.exe$/i.test(getName(a)))
        || validAssets.find(a => /\.exe$/i.test(getName(a)) && !/ia32/i.test(getName(a)))
        || null;
    }
    return validAssets.find(a => /win-ia32\.exe$/i.test(getName(a)) || /ia32\.exe$/i.test(getName(a)))
      || validAssets.find(a => /win\.exe$/i.test(getName(a)))
      || null;
  }

  if (platform === 'linux') {
    return validAssets.find(a => /\.AppImage$/i.test(getName(a)))
      || validAssets.find(a => /\.deb$/i.test(getName(a)))
      || validAssets.find(a => /linux.*\.tar\.gz$/i.test(getName(a)))
      || null;
  }

  if (platform === 'darwin') {
    const isArm = arch === 'arm64';
    if (isArm) {
      return validAssets.find(a => /(arm64|aarch64)\.dmg$/i.test(getName(a)))
        || validAssets.find(a => /(arm64|aarch64)\.zip$/i.test(getName(a)))
        || validAssets.find(a => /\.dmg$/i.test(getName(a)) && !/(x64|amd64)/i.test(getName(a)))
        || null;
    }
    return validAssets.find(a => /(x64|amd64)\.dmg$/i.test(getName(a)))
      || validAssets.find(a => /(x64|amd64)\.zip$/i.test(getName(a)))
      || validAssets.find(a => /\.dmg$/i.test(getName(a)) && !/(arm64|aarch64)/i.test(getName(a)))
      || null;
  }

  if (platform === 'android') {
    return validAssets.find(a => /\.apk$/i.test(getName(a))) || null;
  }

  return null;
}

function isAssetCompatibleWithPlatform(assetNameOrUrl, platform = process.platform, arch = process.arch) {
  const s = String(assetNameOrUrl || '');
  if (!s) return false;
  if (platform === 'win32') {
    if (!/\.exe$/i.test(s)) return false;
    if (arch === 'ia32' && /x64/i.test(s)) return false;
    if ((arch === 'x64' || arch === 'arm64') && /ia32/i.test(s)) return false;
    return true;
  }
  if (platform === 'linux') return /\.(AppImage|deb|tar\.gz)$/i.test(s) && !/\.exe$/i.test(s);
  if (platform === 'darwin') {
    if (!/\.(dmg|zip)$/i.test(s) || /\.exe$/i.test(s)) return false;
    if (arch === 'arm64' && /(x64|amd64)/i.test(s)) return false;
    if (arch === 'x64' && /(arm64|aarch64)/i.test(s)) return false;
    return true;
  }
  return true;
}

function resolveManifestAsset(manifest, repo, platform = process.platform, arch = process.arch) {
  if (!manifest || !manifest.version) return null;
  const ver = String(manifest.version).replace(/^v/i, '').trim();
  if (Array.isArray(manifest.files) && manifest.files.length > 0) {
    const pick = findMatchingAsset(manifest.files, platform, arch);
    if (pick) {
      const name = pick.name || (pick.url ? pick.url.split('/').pop() : null);
      const url = (pick.url && /^https?:\/\//i.test(pick.url))
        ? pick.url
        : (name ? `https://github.com/${repo}/releases/download/v${ver}/${name}` : null);
      return {
        url,
        assetName: name,
        sha512: pick.sha512 || manifest.sha512 || null,
        size: pick.size || manifest.size || 0
      };
    }
  }
  if (manifest.url && isAssetCompatibleWithPlatform(manifest.url, platform, arch)) {
    return {
      url: manifest.url,
      assetName: manifest.assetName || manifest.url.split('/').pop(),
      sha512: manifest.sha512 || null,
      size: manifest.size || 0
    };
  }
  return null;
}

function computeRateLimitDelayMs(headers, nowMs = Date.now(), maxWaitMs = 5000) {
  if (!headers || typeof headers.get !== 'function') return 0;
  const retryAfter = headers.get('retry-after');
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs >= 0) {
      return Math.min(Math.max(0, secs * 1000), maxWaitMs);
    }
    const dateMs = Date.parse(retryAfter);
    if (Number.isFinite(dateMs)) {
      return Math.min(Math.max(0, dateMs - nowMs), maxWaitMs);
    }
  }
  const remaining = headers.get('x-ratelimit-remaining');
  const reset = headers.get('x-ratelimit-reset');
  if (remaining === '0' && reset) {
    const resetSec = Number(reset);
    if (Number.isFinite(resetSec)) {
      return Math.min(Math.max(0, resetSec * 1000 - nowMs), maxWaitMs);
    }
  }
  return 0;
}

function parseLatestYml(ymlContent) {
  if (!ymlContent || typeof ymlContent !== 'string') return null;
  const versionMatch = ymlContent.match(/^version:\s*(.+)$/m);
  const pathMatch = ymlContent.match(/^path:\s*(.+)$/m);
  const sha512Match = ymlContent.match(/^sha512:\s*(.+)$/m);

  if (!versionMatch || !sha512Match) return null;

  // files[] entries: "- url: X" followed by "sha512: Y" and "size: N"
  const files = [];
  const re = /-\s+url:\s*(\S+)\s*\n\s+sha512:\s*(\S+)\s*\n\s+size:\s*(\d+)/g;
  let m;
  while ((m = re.exec(ymlContent))) files.push({ name: m[1], sha512: m[2], size: Number(m[3]) });

  return {
    version: versionMatch[1].trim().replace(/^v/i, ''),
    path: pathMatch ? pathMatch[1].trim() : null,
    sha512: sha512Match[1].trim(),
    files
  };
}

function verifyBufferSha512Base64(buffer, expectedSha512Base64) {
  if (!buffer || !expectedSha512Base64) return false;
  const actualHash = crypto.createHash('sha512').update(buffer).digest('base64');
  return actualHash === expectedSha512Base64.trim();
}

function evaluateBlockedVersion(manifest, currentVer, targetVer) {
  if (!manifest) return { allowed: true, currentBlocked: false, targetBlocked: false, status: 'ok' };
  const blockedList = Array.isArray(manifest.blocked)
    ? manifest.blocked.map(v => String(v).replace(/^v/i, '').trim())
    : [];

  const cur = String(currentVer || '').replace(/^v/i, '').trim();
  const tgt = String(targetVer || '').replace(/^v/i, '').trim();

  const currentBlocked = blockedList.includes(cur);
  const targetBlocked = blockedList.includes(tgt);

  let status = 'ok';
  let reason = '';

  if (currentBlocked && targetBlocked) {
    status = 'no-safe-target';
    reason = 'Bản hiện tại bị thu hồi và bản mục tiêu cũng nằm trong danh sách lỗi. Vui lòng quay lại sau.';
  } else if (currentBlocked) {
    status = 'current-blocked';
    reason = 'Phiên bản hiện tại gặp lỗi nghiêm trọng đã bị thu hồi. Cần cập nhật bản vá ngay.';
  } else if (targetBlocked) {
    status = 'target-blocked';
    reason = 'Bản phát hành mục tiêu đã bị đánh dấu lỗi và tạm dừng phân phối.';
  }

  return {
    allowed: !targetBlocked,
    currentBlocked,
    targetBlocked,
    status,
    reason
  };
}

function evaluateMinSupported(manifest, currentVer) {
  if (!manifest || !manifest.minSupported) return { supported: true };
  const minVer = String(manifest.minSupported).replace(/^v/i, '').trim();
  const cur = String(currentVer || '').replace(/^v/i, '').trim();

  // If minVer is newer than curVer, curVer is outdated / unsupported
  if (isNewerSemVer(minVer, cur)) {
    return { supported: false, minSupported: minVer };
  }
  return { supported: true, minSupported: minVer };
}

function decideRangeResume(statusCode, existingBytes, totalBytes) {
  // If server returns 200 OK (ignores Range request):
  // Must discard existing part file and write from start (0 offset).
  if (statusCode === 200) {
    return { mode: 'overwrite', startByte: 0 };
  }
  // If server returns 206 Partial Content:
  // Can resume from existingBytes.
  if (statusCode === 206) {
    return { mode: 'append', startByte: existingBytes };
  }
  throw new Error(`Unexpected HTTP status for download: ${statusCode}`);
}

module.exports = {
  parseSemVer,
  isNewerSemVer,
  findMatchingAsset,
  isAssetCompatibleWithPlatform,
  resolveManifestAsset,
  computeRateLimitDelayMs,
  parseLatestYml,
  verifyBufferSha512Base64,
  evaluateBlockedVersion,
  evaluateMinSupported,
  decideRangeResume
};
