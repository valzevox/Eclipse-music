// Release Manifest Verification Gate (C3 + C4):
// Loads real parsers from v1.4.21, v1.4.22, v1.4.23, v1.4.24, v1.5.0, v1.5.1, and current HEAD,
// and verifies dist/latest.yml + all required cross-platform assets, sizes, SHA-512s, and URLs.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const args = process.argv.slice(2);
const getArg = (flag, fallback = null) => {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
};

const ymlPath = getArg('--manifest', path.join(root, 'dist', 'latest.yml'));
const expectedVersion = getArg('--version', pkg.version);
const repo = 'valzevox/Eclipse-music';

assert.ok(fs.existsSync(ymlPath), `Missing manifest: ${ymlPath}`);
const ymlText = fs.readFileSync(ymlPath, 'utf8');

function loadCoreFromTag(tag) {
  const code = execFileSync('git', ['show', `${tag}:src/main/updater-core.js`], { cwd: root, encoding: 'utf8' });
  const mod = { exports: {} };
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, process, Buffer });
  return mod.exports;
}

const legacyTags = ['v1.4.21', 'v1.4.22', 'v1.4.23', 'v1.4.24', 'v1.5.0', 'v1.5.1'];
const currentCore = require(path.join(root, 'src', 'main', 'updater-core.js'));

// 1. Verify v1.4.21 & v1.4.22 top-level path/sha512 (universal Windows NSIS)
for (const tag of ['v1.4.21', 'v1.4.22']) {
  const core = loadCoreFromTag(tag);
  const parsed = core.parseLatestYml(ymlText);
  assert.ok(parsed, `${tag} parseLatestYml failed`);
  assert.strictEqual(parsed.version, expectedVersion, `${tag} version mismatch`);
  assert.strictEqual(parsed.path, `eclipse-${expectedVersion}-win.exe`, `${tag} top-level path must be universal Windows NSIS`);
  assert.ok(parsed.sha512 && parsed.sha512.length >= 80, `${tag} top-level sha512 missing`);
}

// 2. Verify v1.4.23, v1.4.24, v1.5.0, v1.5.1, and current HEAD files[] selection across all platforms
const matrix = [
  { platform: 'win32', arch: 'x64', pattern: new RegExp(`^eclipse-${expectedVersion}-win-x64\\.exe$`, 'i'), label: 'Windows x64 EXE' },
  { platform: 'win32', arch: 'ia32', pattern: new RegExp(`^eclipse-${expectedVersion}-win-ia32\\.exe$`, 'i'), label: 'Windows ia32 EXE' },
  { platform: 'linux', arch: 'x64', pattern: /\.(AppImage|deb)$/i, label: 'Linux AppImage/DEB' },
  { platform: 'darwin', arch: 'arm64', pattern: /arm64\.dmg$/i, label: 'macOS arm64 DMG' },
  { platform: 'darwin', arch: 'x64', pattern: /x64\.dmg$/i, label: 'macOS x64 DMG' }
];

let canonicalParsed = null;
for (const tag of ['v1.4.23', 'v1.4.24', 'v1.5.0', 'v1.5.1', 'HEAD']) {
  const core = tag === 'HEAD' ? currentCore : loadCoreFromTag(tag);
  const parsed = core.parseLatestYml(ymlText);
  assert.ok(parsed && parsed.version === expectedVersion, `${tag} version mismatch`);
  assert.ok(Array.isArray(parsed.files) && parsed.files.length >= 5, `${tag} files[] incomplete`);
  if (tag === 'HEAD') canonicalParsed = parsed;

  for (const { platform, arch, pattern, label } of matrix) {
    const asset = core.findMatchingAsset(parsed.files, platform, arch);
    assert.ok(asset, `${tag} failed to select ${label}`);
    assert.match(asset.name, pattern, `${tag} ${label} mismatch: ${asset.name}`);
    assert.doesNotMatch(asset.name, /\.blockmap$/i, `${tag} must never select .blockmap`);
    if (platform !== 'win32') {
      assert.doesNotMatch(asset.name, /\.exe$/i, `${tag} must never select Windows .exe on ${platform}`);
    }
    const url = `https://github.com/${repo}/releases/download/v${expectedVersion}/${asset.name}`;
    assert.ok(url.startsWith(`https://github.com/${repo}/releases/download/v${expectedVersion}/`));
  }
}

// 3. Verify every file in files[] + top-level path exists on disk with exact byte size and SHA-512
const allEntries = [...canonicalParsed.files];
if (!allEntries.some((e) => e.name === canonicalParsed.path)) {
  allEntries.push({ name: canonicalParsed.path, sha512: canonicalParsed.sha512, size: null });
}

for (const entry of allEntries) {
  assert.doesNotMatch(entry.name, /\.blockmap$/i, `files[] must not contain .blockmap: ${entry.name}`);
  const candidates = [path.join(root, 'dist', entry.name), path.join(root, 'output', entry.name)];
  const filePath = candidates.find((p) => fs.existsSync(p));
  assert.ok(filePath, `Missing built binary on disk for ${entry.name}`);
  const buf = fs.readFileSync(filePath);
  if (entry.size !== null) {
    assert.strictEqual(buf.length, entry.size, `Size mismatch for ${entry.name}: disk=${buf.length}, yml=${entry.size}`);
  }
  const sha512 = crypto.createHash('sha512').update(buf).digest('base64');
  assert.strictEqual(sha512, entry.sha512, `SHA-512 mismatch for ${entry.name}`);
}

console.log(`VERIFIED ${canonicalParsed.files.length} ASSETS ACROSS ${legacyTags.length + 1} PARSERS (v1.4.21..HEAD) FOR v${expectedVersion}`);
