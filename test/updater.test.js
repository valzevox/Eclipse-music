// d:\Eclipse\eclipse-pc\test\updater.test.js
const assert = require('assert');
const crypto = require('crypto');
const {
  parseSemVer,
  isNewerSemVer,
  findMatchingAsset,
  parseLatestYml,
  verifyBufferSha512Base64,
  evaluateBlockedVersion,
  evaluateMinSupported,
  decideRangeResume
} = require('../src/main/updater-core');

console.log('--- RUNNING ENTERPRISE UPDATER UNIT TESTS ---');

// Test 1: SemVer Comparison (Standard, Prefix v, 1.0.9 vs 1.0.48)
console.log('1. Testing SemVer comparison...');
assert.strictEqual(isNewerSemVer('1.0.48', '1.0.9'), true, '1.0.48 must be newer than 1.0.9 (numerical comparison, not lexicographical string)');
assert.strictEqual(isNewerSemVer('1.0.9', '1.0.48'), false, '1.0.9 must NOT be newer than 1.0.48');
assert.strictEqual(isNewerSemVer('v1.4.16', '1.4.15'), true, 'v1.4.16 must be newer than 1.4.15 (handling v prefix)');
assert.strictEqual(isNewerSemVer('1.4.16', 'v1.4.16'), false, 'equal versions with/without v prefix must return false');
assert.strictEqual(isNewerSemVer('2.0.0', '1.99.99'), true, 'major version increment');
assert.strictEqual(isNewerSemVer('1.4.16', '1.4.16-beta.1'), true, 'stable release is newer than pre-release');
assert.strictEqual(isNewerSemVer('1.4.16-beta.2', '1.4.16-beta.1'), true, 'beta.2 is newer than beta.1');
console.log('✓ SemVer comparison passed.');

// Test 2: Asset Matching for Platforms
console.log('2. Testing asset matching...');
const mockAssets = [
  { name: 'eclipse-1.4.16-win-x64.exe' },
  { name: 'eclipse-1.4.16-win-x64.exe.blockmap' },
  { name: 'eclipse-1.4.16-win-ia32.exe' },
  { name: 'eclipse-1.4.16-mac-arm64.dmg' },
  { name: 'eclipse-1.4.16-mac-x64.dmg' },
  { name: 'eclipse-1.4.16-linux.AppImage' },
  { name: 'eclipse-1.4.16-linux.deb' },
  { name: 'eclipse-1.4.16-universal.apk' }
];

const win64 = findMatchingAsset(mockAssets, 'win32', 'x64');
assert.strictEqual(win64.name, 'eclipse-1.4.16-win-x64.exe', 'Must match win-x64.exe and ignore blockmap');

const win32 = findMatchingAsset(mockAssets, 'win32', 'ia32');
assert.strictEqual(win32.name, 'eclipse-1.4.16-win-ia32.exe', 'Must match win-ia32.exe for ia32');

const macArm = findMatchingAsset(mockAssets, 'darwin', 'arm64');
assert.strictEqual(macArm.name, 'eclipse-1.4.16-mac-arm64.dmg', 'Must match arm64 dmg for Apple Silicon');

const macX64 = findMatchingAsset(mockAssets, 'darwin', 'x64');
assert.strictEqual(macX64.name, 'eclipse-1.4.16-mac-x64.dmg', 'Must match x64 dmg for Intel Mac');

const linux = findMatchingAsset(mockAssets, 'linux', 'x64');
assert.strictEqual(linux.name, 'eclipse-1.4.16-linux.AppImage', 'Must match AppImage for Linux');

const android = findMatchingAsset(mockAssets, 'android', 'arm64');
assert.strictEqual(android.name, 'eclipse-1.4.16-universal.apk', 'Must match apk for Android');
console.log('✓ Asset matching passed.');

// Test 3: latest.yml parsing and sha512 (base64) verification
console.log('3. Testing latest.yml parser and sha512 verification...');
const sampleYml = `version: 1.4.16
files:
  - url: eclipse-1.4.16-win-x64.exe
    sha512: dGVzdC1oYXNoLWJhc2U2NA==
    size: 7891234
path: eclipse-1.4.16-win-x64.exe
sha512: ODFf0PzH7q0tGZ/Q6j2yQyN9yvX...
releaseDate: '2026-11-16T07:05:00.000Z'
`;

const parsed = parseLatestYml(sampleYml);
assert.strictEqual(parsed.version, '1.4.16');
assert.strictEqual(parsed.path, 'eclipse-1.4.16-win-x64.exe');
assert.strictEqual(parsed.sha512, 'ODFf0PzH7q0tGZ/Q6j2yQyN9yvX...');

const dummyPayload = Buffer.from('hello eclipse enterprise updater');
const actualSha512Base64 = crypto.createHash('sha512').update(dummyPayload).digest('base64');
assert.strictEqual(verifyBufferSha512Base64(dummyPayload, actualSha512Base64), true, 'Sha512 base64 match check');
assert.strictEqual(verifyBufferSha512Base64(dummyPayload, 'invalidBase64Hash'), false, 'Sha512 base64 mismatch check');
console.log('✓ latest.yml and sha512 passed.');

// Test 4: Range Resume logic (HTTP 200 vs 206)
console.log('4. Testing Range Resume decisions (200 OK vs 206 Partial)...');
const resume206 = decideRangeResume(206, 5000, 10000);
assert.strictEqual(resume206.mode, 'append');
assert.strictEqual(resume206.startByte, 5000);

const resume200 = decideRangeResume(200, 5000, 10000);
assert.strictEqual(resume200.mode, 'overwrite', 'If server responds 200 OK, must discard existing part and overwrite from 0');
assert.strictEqual(resume200.startByte, 0);
console.log('✓ Range Resume passed.');

// Test 5: Blocked & minSupported manifest rules
console.log('5. Testing blocked and minSupported checks...');
const manifest = {
  version: '1.4.17',
  minSupported: '1.4.0',
  blocked: ['1.4.15', '1.4.16']
};

const blockCheck1 = evaluateBlockedVersion(manifest, '1.4.15', '1.4.17');
assert.strictEqual(blockCheck1.currentBlocked, true, 'Current 1.4.15 must be flagged as blocked');
assert.strictEqual(blockCheck1.targetBlocked, false, 'Target 1.4.17 is not blocked');
assert.strictEqual(blockCheck1.allowed, true, 'Can proceed with update to 1.4.17');

const blockCheck2 = evaluateBlockedVersion(manifest, '1.4.10', '1.4.16');
assert.strictEqual(blockCheck2.targetBlocked, true, 'Target 1.4.16 is in blocked list');
assert.strictEqual(blockCheck2.allowed, false, 'Must reject downloading target 1.4.16');

const minCheck1 = evaluateMinSupported(manifest, '1.3.5');
assert.strictEqual(minCheck1.supported, false, '1.3.5 is below minSupported 1.4.0');

const minCheck2 = evaluateMinSupported(manifest, '1.4.14');
assert.strictEqual(minCheck2.supported, true, '1.4.14 satisfies minSupported 1.4.0');
console.log('✓ Blocked and minSupported checks passed.');

console.log('ALL PHASE 0 UNIT TESTS PASSED SUCCESSFULLY (EXIT 0)');
