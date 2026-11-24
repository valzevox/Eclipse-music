'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const EXT_DIR = path.join(__dirname, '../src/extensions/eclipse-connect');
const DIST_DIR = path.join(__dirname, '../dist/extension');
const OUT_ZIP = path.join(DIST_DIR, 'eclipse-connect.zip');

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
  if (!manifest.permissions.includes('cookies')) {
    throw new Error('Required permission "cookies" missing from manifest');
  }

  const requiredFiles = ['manifest.json', 'background.js', 'popup.html', 'popup.js', 'README.md'];
  for (const f of requiredFiles) {
    if (!fs.existsSync(path.join(EXT_DIR, f))) {
      throw new Error(`Required extension file missing: ${f}`);
    }
  }

  fs.mkdirSync(DIST_DIR, { recursive: true });
  if (fs.existsSync(OUT_ZIP)) {
    fs.unlinkSync(OUT_ZIP);
  }

  if (process.platform === 'win32') {
    // Use PowerShell Compress-Archive for zero external dependencies
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
