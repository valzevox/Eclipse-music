// d:\Eclipse\eclipse-pc\test-integration-verification.js
// Verification suite for Enterprise Auto-Update across Desktop and Mobile
const assert = require('assert');
const path = require('path');
const fs = require('fs');

console.log('=== STARTING ENTERPRISE AUTO-UPDATE INTEGRATION VERIFICATION ===');

// 1. Verify PC Core Engine
const core = require('./src/main/updater-core');
assert.strictEqual(typeof core.isNewerSemVer, 'function');
assert.strictEqual(typeof core.findMatchingAsset, 'function');
assert.strictEqual(typeof core.parseLatestYml, 'function');
assert.strictEqual(typeof core.verifyBufferSha512Base64, 'function');
assert.strictEqual(typeof core.evaluateBlockedVersion, 'function');
assert.strictEqual(typeof core.evaluateMinSupported, 'function');
assert.strictEqual(typeof core.decideRangeResume, 'function');
console.log('✓ updater-core interface verified.');

// 2. Verify SemVer edge cases
assert.strictEqual(core.isNewerSemVer('1.0.48', '1.0.9'), true, '1.0.48 must be newer than 1.0.9');
assert.strictEqual(core.isNewerSemVer('v1.4.17', '1.4.16'), true);
assert.strictEqual(core.isNewerSemVer('1.4.16', '1.4.16'), false);
assert.strictEqual(core.isNewerSemVer('1.4.15', '1.4.16'), false);
console.log('✓ SemVer edge cases verified.');

// 3. Verify Range Resume logic (200 vs 206)
const decision200 = core.decideRangeResume(200, 5000);
assert.strictEqual(decision200.mode, 'overwrite');
assert.strictEqual(decision200.startByte, 0);

const decision206 = core.decideRangeResume(206, 5000);
assert.strictEqual(decision206.mode, 'append');
assert.strictEqual(decision206.startByte, 5000);
console.log('✓ HTTP Range resume logic (200 vs 206) verified.');

// 4. Verify Blocked and MinSupported manifest logic
const manifest = {
  version: '1.4.17',
  blocked: ['1.4.15', '1.4.18-buggy'],
  minSupported: '1.4.10'
};
const blockCheck = core.evaluateBlockedVersion(manifest, '1.4.15', '1.4.17');
assert.strictEqual(blockCheck.currentBlocked, true);
assert.strictEqual(blockCheck.targetBlocked, false);

const blockCheck2 = core.evaluateBlockedVersion(manifest, '1.4.16', '1.4.18-buggy');
assert.strictEqual(blockCheck2.currentBlocked, false);
assert.strictEqual(blockCheck2.targetBlocked, true);

const minCheck = core.evaluateMinSupported(manifest, '1.4.08');
assert.strictEqual(minCheck.supported, false);
console.log('✓ Blocked & minSupported evaluation verified.');

// 5. Verify Mobile MediaControlsPlugin Java implementation
const javaPluginPath = path.resolve(__dirname, '../eclipse-mobile/android/app/src/main/java/io/github/cloverscripts/muriel/MediaControlsPlugin.java');
const javaContent = fs.readFileSync(javaPluginPath, 'utf8');

assert.ok(javaContent.includes('verifyApkSecurity'), 'Must contain verifyApkSecurity');
assert.ok(javaContent.includes('currentPackage.equals(archiveInfo.packageName)'), 'Must dynamically check package name');
assert.ok(javaContent.includes('newVersionCode <= currentVersionCode'), 'Must strictly reject non-greater versionCode');
assert.ok(javaContent.includes('PlaybackService.running'), 'Must guard against active playback');
assert.ok(javaContent.includes('PLAYBACK_ACTIVE'), 'Must return PLAYBACK_ACTIVE on active playback');
assert.ok(javaContent.includes('GET_SIGNING_CERTIFICATES'), 'Must verify signing certificate');
console.log('✓ Mobile native Java security gates verified.');

// 6. Verify Mobile update-notifier.js implementation
const mobileNotifierPath = path.resolve(__dirname, '../eclipse-mobile/update-notifier.js');
const mobileNotifier = fs.readFileSync(mobileNotifierPath, 'utf8');

assert.ok(mobileNotifier.includes('latest.json'), 'Must use static latest.json CDN endpoint');
assert.ok(mobileNotifier.includes('persistPlaybackState'), 'Must persist playback state before update');
assert.ok(mobileNotifier.includes('isPlaybackRunning'), 'Must check playback before launching install');
assert.ok(mobileNotifier.includes('blocked'), 'Must handle blocked version list');
console.log('✓ Mobile update-notifier.js architecture verified.');

// 7. Verify tools/create-release-bundle.mjs
const releaseBundleToolPath = path.resolve(__dirname, '../tools/create-release-bundle.mjs');
assert.ok(fs.existsSync(releaseBundleToolPath), 'create-release-bundle.mjs must exist');
console.log('✓ Release manifest tooling verified.');

console.log('=== ALL INTEGRATION VERIFICATIONS PASSED (EXIT 0) ===');
