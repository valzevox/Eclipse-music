// Standalone release-manifest verification for build/release pipeline
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const ymlPath = path.join(root, 'dist', 'latest.yml');
assert.ok(fs.existsSync(ymlPath), `Missing ${ymlPath}`);
const ymlText = fs.readFileSync(ymlPath, 'utf8');

const legacyCode = execFileSync('git', ['show', 'v1.5.0:src/main/updater-core.js'], { cwd: root, encoding: 'utf8' });
const legacyMod = { exports: {} };
vm.runInNewContext(legacyCode, { module: legacyMod, exports: legacyMod.exports, require, process, Buffer });
const parsed = legacyMod.exports.parseLatestYml(ymlText);
assert.ok(parsed && parsed.version && parsed.files.length >= 5, 'Invalid dist/latest.yml');

for (const entry of parsed.files) {
  const candidates = [path.join(root, 'dist', entry.name), path.join(root, 'output', entry.name)];
  const filePath = candidates.find((p) => fs.existsSync(p));
  assert.ok(filePath, `Missing built binary for ${entry.name}`);
  const buf = fs.readFileSync(filePath);
  assert.strictEqual(buf.length, entry.size, `Size mismatch for ${entry.name}`);
  const sha512 = crypto.createHash('sha512').update(buf).digest('base64');
  assert.strictEqual(sha512, entry.sha512, `SHA-512 mismatch for ${entry.name}`);
}

console.log(`VERIFIED ${parsed.files.length} RELEASE MANIFEST ASSETS IN dist/latest.yml`);
