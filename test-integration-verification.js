// test-integration-verification.js — Self-contained, portable verification for Eclipse PC
const assert = require('assert');
const path = require('path');
const fs = require('fs');

async function runTests() {
  console.log('--- STARTING ARCHITECTURE & INTEGRATION VERIFICATION (PC) ---');

  // 1. Check PC Services relative to current repo
  console.log('[1/4] Verifying Eclipse PC backend services...');
  const pcAuth = require('./src/server/ytm-auth');
  const pcCharts = require('./src/server/ytm-charts');
  const pcArtist = require('./src/server/ytm-artist-full');
  const pcDiscovery = require('./src/server/ytm-discovery');
  const pcMv = require('./src/server/ytm-mv');
  const pcStorage = require('./src/server/storage-manager');
  const pcQr = require('./src/server/qr-session-transfer');

  const pcAuthInst = new pcAuth(path.join(__dirname, 'test-data'));
  assert.strictEqual(typeof pcAuthInst.getLoginUrl, 'function', 'pcAuth.getLoginUrl must be a function');
  assert.strictEqual(typeof pcAuthInst.listAccounts, 'function', 'pcAuth.listAccounts must be a function');
  assert.strictEqual(typeof pcAuthInst.getRawActiveAccount, 'function', 'pcAuth.getRawActiveAccount must be a function');
  assert.strictEqual(typeof pcCharts.getCharts, 'function', 'pcCharts.getCharts must be a function');
  assert.strictEqual(typeof pcArtist.getArtistProfile, 'function', 'pcArtist.getArtistProfile must be a function');
  assert.strictEqual(typeof pcDiscovery.searchCategorized, 'function', 'pcDiscovery.searchCategorized must be a function');
  assert.strictEqual(typeof pcMv.resolveMusicVideo, 'function', 'pcMv.resolveMusicVideo must be a function');
  assert.strictEqual(typeof pcStorage.getStorageStats, 'function', 'pcStorage.getStorageStats must be a function');
  assert.strictEqual(typeof pcQr.createTransferPayload, 'function', 'pcQr.createTransferPayload must be a function');
  console.log(' -> PC backend services verified (PASS).');

  // 2. Check HTML script injections
  console.log('[2/4] Verifying HTML script injections...');
  const pcHtml = fs.readFileSync(path.join(__dirname, 'src/renderer/index.html'), 'utf8');

  const requiredScripts = [
    'mv-player.js',
    'smart-downloads.js',
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
  }
  console.log(' -> Script tags verified (PASS).');

  // 3. Check Cookie Sanitization
  console.log('[3/4] Verifying cookie sanitization in Auth responses...');
  const dummyAcc = { id: 'test1234', name: 'Test User', cookie: 'SECRET_COOKIE_DATA' };
  const sanitized = pcAuthInst.getSanitizedAccount(dummyAcc);
  assert.strictEqual(sanitized.cookie, undefined, 'Sanitized account must not expose cookie');
  assert.strictEqual(sanitized.id, 'test1234');
  console.log(' -> Sanitization verified (PASS).');

  // 4. Verify QR Transfer payload with raw account
  console.log('[4/4] Verifying QR session transfer handshake...');
  const transfer = pcQr.createTransferPayload({ id: 'acc1', name: 'User 1', cookie: 'SESSION_VAL' });
  assert(transfer.transferId, 'Transfer payload must have transferId');
  assert(transfer.secretKey, 'Transfer payload must have secretKey');
  const claimed = pcQr.claimTransferSession(transfer.transferId, transfer.secretKey);
  assert.strictEqual(claimed.cookie, 'SESSION_VAL', 'Claimed session must restore cookie');
  console.log(' -> QR session handshake verified (PASS).');

  console.log('--- ALL VERIFICATION CHECKS PASSED (EXIT CODE 0) ---');
}

runTests().catch(err => {
  console.error('VERIFICATION FAILED:', err);
  process.exit(1);
});
