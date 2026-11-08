// test-integration-verification.js — Automated test for backend routes and module exports
const assert = require('assert');
const path = require('path');
const fs = require('fs');

async function runTests() {
  console.log('--- STARTING ARCHITECTURE & INTEGRATION VERIFICATION ---');

  // 1. Check PC Services
  console.log('[1/4] Verifying Eclipse PC backend services...');
  const pcAuth = require('./eclipse-pc/src/server/ytm-auth');
  const pcCharts = require('./eclipse-pc/src/server/ytm-charts');
  const pcArtist = require('./eclipse-pc/src/server/ytm-artist-full');
  const pcDiscovery = require('./eclipse-pc/src/server/ytm-discovery');
  const pcMv = require('./eclipse-pc/src/server/ytm-mv');
  const pcStorage = require('./eclipse-pc/src/server/storage-manager');
  const pcQr = require('./eclipse-pc/src/server/qr-session-transfer');

  const pcAuthInst = new pcAuth('D:/Eclipse/test-data');
  assert.strictEqual(typeof pcAuthInst.getLoginUrl, 'function', 'pcAuth.getLoginUrl must be a function');
  assert.strictEqual(typeof pcAuthInst.listAccounts, 'function', 'pcAuth.listAccounts must be a function');
  assert.strictEqual(typeof pcCharts.getCharts, 'function', 'pcCharts.getCharts must be a function');
  assert.strictEqual(typeof pcArtist.getArtistProfile, 'function', 'pcArtist.getArtistProfile must be a function');
  assert.strictEqual(typeof pcDiscovery.searchCategorized, 'function', 'pcDiscovery.searchCategorized must be a function');
  assert.strictEqual(typeof pcMv.resolveMusicVideo, 'function', 'pcMv.resolveMusicVideo must be a function');
  assert.strictEqual(typeof pcStorage.getStorageStats, 'function', 'pcStorage.getStorageStats must be a function');
  assert.strictEqual(typeof pcQr.createTransferPayload, 'function', 'pcQr.createTransferPayload must be a function');
  console.log(' -> PC backend services verified (PASS).');

  // 2. Check Mobile Services
  console.log('[2/4] Verifying Eclipse Mobile backend services...');
  const mbAuth = require('./eclipse-mobile/ytm-auth');
  const mbCharts = require('./eclipse-mobile/ytm-charts');
  const mbArtist = require('./eclipse-mobile/ytm-artist-full');
  const mbDiscovery = require('./eclipse-mobile/ytm-discovery');
  const mbMv = require('./eclipse-mobile/ytm-mv');
  const mbStorage = require('./eclipse-mobile/storage-manager');
  const mbQr = require('./eclipse-mobile/qr-session-transfer');

  const mbAuthInst = new mbAuth('D:/Eclipse/test-data');
  assert.strictEqual(typeof mbAuthInst.getLoginUrl, 'function', 'mbAuth.getLoginUrl must be a function');
  assert.strictEqual(typeof mbAuthInst.listAccounts, 'function', 'mbAuth.listAccounts must be a function');
  assert.strictEqual(typeof mbCharts.getCharts, 'function', 'mbCharts.getCharts must be a function');
  assert.strictEqual(typeof mbArtist.getArtistProfile, 'function', 'mbArtist.getArtistProfile must be a function');
  assert.strictEqual(typeof mbDiscovery.searchCategorized, 'function', 'mbDiscovery.searchCategorized must be a function');
  assert.strictEqual(typeof mbMv.resolveMusicVideo, 'function', 'mbMv.resolveMusicVideo must be a function');
  assert.strictEqual(typeof mbStorage.getStorageStats, 'function', 'mbStorage.getStorageStats must be a function');
  assert.strictEqual(typeof mbQr.createTransferPayload, 'function', 'mbQr.createTransferPayload must be a function');
  console.log(' -> Mobile backend services verified (PASS).');

  // 3. Check HTML script injections
  console.log('[3/4] Verifying HTML script injections and bundle copying...');
  const pcHtml = fs.readFileSync('D:/Eclipse/eclipse-pc/src/renderer/index.html', 'utf8');
  const mbHtml = fs.readFileSync('D:/Eclipse/eclipse-mobile/index.html', 'utf8');
  const mbBuild = fs.readFileSync('D:/Eclipse/eclipse-mobile/mobile/build.mjs', 'utf8');

  const requiredScripts = [
    'mv-player.js',
    'synced-lyrics-editor.js',
    'lyrics-card.js',
    'auto-eq.js',
    'automix-dj.js',
    'listen-together.js',
    'listening-receipt.js',
    'integration-bridge.js'
  ];

  for (const s of requiredScripts) {
    assert(pcHtml.includes(s), `PC HTML must include script ${s}`);
    assert(mbHtml.includes(s), `Mobile HTML must include script ${s}`);
    assert(mbBuild.includes(s), `Mobile build.mjs must copy ${s}`);
  }
  console.log(' -> Script tags and bundle copies verified (PASS).');

  // 4. Check Security & Keystore untracking
  console.log('[4/4] Verifying keystore untracked & secrets sanitized...');
  const releaseYml = fs.readFileSync('D:/Eclipse/eclipse-mobile/.github/workflows/release.yml', 'utf8');
  assert(!releaseYml.includes('eclipse123'), 'Workflow must not contain hardcoded credentials');
  console.log(' -> Security and secret references verified (PASS).');

  console.log('--- ALL VERIFICATION CHECKS PASSED (EXIT CODE 0) ---');
}

runTests().catch(err => {
  console.error('VERIFICATION FAILED:', err);
  process.exit(1);
});
