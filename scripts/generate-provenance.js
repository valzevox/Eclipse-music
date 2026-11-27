// Immutable Build Provenance Generator (C2)
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const args = process.argv.slice(2);
const getArg = (flag, fallback = null) => {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
};

const commitSha = getArg('--commit', execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim());
const gitTag = getArg('--tag', `v${pkg.version}`);
const workflowRunId = getArg('--run-id', process.env.GITHUB_RUN_ID || 'local');
const runnerOs = getArg('--runner-os', process.env.RUNNER_OS || process.platform);
const outPath = getArg('--out', path.join(root, 'dist', 'release-provenance.json'));

const electronPkg = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'electron', 'package.json'), 'utf8'));
const builderPkg = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'electron-builder', 'package.json'), 'utf8'));

const assetDirs = [path.join(root, 'dist'), path.join(root, 'output')];
const seen = new Set();
const assets = [];

for (const dir of assetDirs) {
  if (!fs.existsSync(dir)) continue;
  for (const name of fs.readdirSync(dir)) {
    if (!/\.(exe|zip|deb|AppImage|tar\.gz|dmg|blockmap|yml)$/i.test(name)) continue;
    if (seen.has(name)) continue;
    const full = path.join(dir, name);
    if (!fs.statSync(full).isFile()) continue;
    seen.add(name);
    const buf = fs.readFileSync(full);
    assets.push({
      filename: name,
      size: buf.length,
      sha256: crypto.createHash('sha256').update(buf).digest('hex'),
      sha512: crypto.createHash('sha512').update(buf).digest('base64')
    });
  }
}

const provenance = {
  version: pkg.version,
  commitSha,
  gitTag,
  workflowRunId,
  runnerOs,
  nodeVersion: process.version,
  electronVersion: electronPkg.version,
  electronBuilderVersion: builderPkg.version,
  generatedAt: new Date().toISOString(),
  assets: assets.sort((a, b) => a.filename.localeCompare(b.filename))
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(provenance, null, 2), 'utf8');
console.log(`GENERATED PROVENANCE (${assets.length} assets) -> ${outPath}`);
