// Release Preflight Gate (C1 + C8): enforces version consistency, clean git state, tag/commit alignment, and manifest verification.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const getArg = (flag) => {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
};
const hasFlag = (flag) => args.includes(flag);

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));

assert.ok(pkg.version && /^\d+\.\d+\.\d+$/.test(pkg.version), `Invalid package.json version: ${pkg.version}`);
assert.strictEqual(lock.version, pkg.version, `package-lock.json version (${lock.version}) !== package.json (${pkg.version})`);
assert.strictEqual(lock.packages && lock.packages[''] && lock.packages[''].version, pkg.version, 'package-lock.json packages[""].version mismatch');

if (!hasFlag('--allow-dirty')) {
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim();
  assert.strictEqual(dirty, '', `Working tree must be clean before release:\n${dirty}`);
}

const expectedTag = getArg('--tag');
const expectedCommit = getArg('--commit');
if (expectedTag) {
  assert.strictEqual(expectedTag, `v${pkg.version}`, `Tag (${expectedTag}) must match v${pkg.version}`);
  if (expectedCommit) {
    const tagCommit = execFileSync('git', ['rev-parse', `${expectedTag}^{commit}`], { cwd: root, encoding: 'utf8' }).trim();
    assert.strictEqual(tagCommit, expectedCommit, `Tag ${expectedTag} points to ${tagCommit}, expected ${expectedCommit}`);
  }
}

const ymlPath = path.join(root, 'dist', 'latest.yml');
if (hasFlag('--require-manifest') || fs.existsSync(ymlPath)) {
  assert.ok(fs.existsSync(ymlPath), `Missing ${ymlPath}`);
  execFileSync(process.execPath, [path.join(__dirname, 'verify-release-manifest.js')], { cwd: root, stdio: 'inherit' });
}

console.log(`RELEASE PREFLIGHT PASSED for v${pkg.version}`);
