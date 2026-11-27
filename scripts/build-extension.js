'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const EXT_DIR = path.join(__dirname, '../src/extensions/eclipse-connect');
const DIST_DIR = path.join(__dirname, '../dist/extension');
const OUT_ZIP = path.join(DIST_DIR, 'eclipse-connect.zip');

const FORBIDDEN_SOURCE_PATTERNS = [
  { label: 'dev config reference', regex: /\bdev[-_]?config\b/i },
  { label: 'debug endpoint', regex: /\/api\/debug\b|debug[-_]?endpoint/i },
  { label: 'dev extension ID', regex: /\bdev[-_]?extension[-_]?id\b|chrome-extension:\/\/[a-p]{32}/i },
  { label: 'localhost URL', regex: /https?:\/\/localhost\b/i },
  { label: 'wildcard spotify host permission', regex: /\*\.spotify\.com/i }
];

function validateExtensionSource(extDir) {
  const entries = fs.readdirSync(extDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(extDir, entry.name);
    if (entry.isDirectory()) {
      validateExtensionSource(fullPath);
      continue;
    }
    if (entry.name.startsWith('.env') || /\.dev\./i.test(entry.name)) {
      throw new Error(`Forbidden dev config file in extension source: ${entry.name}`);
    }
    const content = fs.readFileSync(fullPath, 'utf8');
    for (const rule of FORBIDDEN_SOURCE_PATTERNS) {
      if (rule.regex.test(content)) {
        throw new Error(`Forbidden ${rule.label} found in ${entry.name}`);
      }
    }
  }
}

function buildExtensionZip() {
  console.log('[build-extension] Validating Manifest V3 extension...');
  const manifestPath = path.join(EXT_DIR, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error('manifest.json not found in ' + EXT_DIR);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.manifest_version !== 3) {
    throw new Error('Expected manifest_version 3, got ' + manifest.manifest_version);
  }
  if (Array.isArray(manifest.permissions) && manifest.permissions.includes('cookies')) {
    throw new Error('"cookies" must be in optional_permissions, not permissions');
  }
  if (!Array.isArray(manifest.optional_permissions) || !manifest.optional_permissions.includes('cookies')) {
    throw new Error('Required optional_permission "cookies" missing from manifest');
  }
  if (!Array.isArray(manifest.optional_host_permissions) ||
      !manifest.optional_host_permissions.includes('http://127.0.0.1/*') ||
      !manifest.optional_host_permissions.includes('https://open.spotify.com/*')) {
    throw new Error('optional_host_permissions must include http://127.0.0.1/* and https://open.spotify.com/*');
  }
  if (manifest.optional_host_permissions.some(p => p.includes('*.spotify.com')) ||
      (Array.isArray(manifest.host_permissions) && manifest.host_permissions.some(p => p.includes('*.spotify.com')))) {
    throw new Error('Wildcard *.spotify.com host permission is forbidden');
  }

  const requiredFiles = ['manifest.json', 'background.js', 'popup.html', 'popup.js', 'README.md'];
  for (const f of requiredFiles) {
    if (!fs.existsSync(path.join(EXT_DIR, f))) {
      throw new Error(`Required extension file missing: ${f}`);
    }
  }

  validateExtensionSource(EXT_DIR);

  fs.mkdirSync(DIST_DIR, { recursive: true });
  if (fs.existsSync(OUT_ZIP)) {
    fs.unlinkSync(OUT_ZIP);
  }

  if (process.platform === 'win32') {
    const cmd = `Compress-Archive -Path "${EXT_DIR}\\*" -DestinationPath "${OUT_ZIP}" -Force`;
    cp.execSync(`powershell -NoProfile -Command "${cmd}"`);
  } else {
    cp.execSync(`zip -r -j "${OUT_ZIP}" "${EXT_DIR}"/*`);
  }

  console.log(`[build-extension] Successfully created ${OUT_ZIP} (${fs.statSync(OUT_ZIP).size} bytes)`);
  return OUT_ZIP;
}

if (require.main === module) {
  try {
    buildExtensionZip();
  } catch (err) {
    console.error('[build-extension] Error:', err);
    process.exit(1);
  }
}

module.exports = {
  buildExtensionZip
};
