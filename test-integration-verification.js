// test-integration-verification.js — Comprehensive, self-contained verification for Eclipse PC
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

async function runTests() {
  console.log('--- STARTING ARCHITECTURE & INTEGRATION VERIFICATION (PC) ---');

  // 1. Check PC Services relative to current repo
  console.log('[1/8] Verifying Eclipse PC backend services...');
  const YtmAuth = require('./src/server/ytm-auth');
  const pcCharts = require('./src/server/ytm-charts');
  const pcArtist = require('./src/server/ytm-artist-full');
  const pcDiscovery = require('./src/server/ytm-discovery');
  const pcMv = require('./src/server/ytm-mv');
  const pcStorage = require('./src/server/storage-manager');
  const pcQr = require('./src/server/qr-session-transfer');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eclipse-pc-test-'));
  const pcAuthInst = new YtmAuth(tmpDir);
  assert.strictEqual(typeof pcAuthInst.getLoginUrl, 'function');
  assert.strictEqual(typeof pcAuthInst.listAccounts, 'function');
  assert.strictEqual(typeof pcAuthInst.getRawActiveAccount, 'function');
  assert.strictEqual(typeof pcCharts.getCharts, 'function');
  assert.strictEqual(typeof pcArtist.getArtistProfile, 'function');
  assert.strictEqual(typeof pcDiscovery.searchCategorized, 'function');
  assert.strictEqual(typeof pcMv.resolveMusicVideo, 'function');
  assert.strictEqual(typeof pcStorage.getStorageStats, 'function');
  assert.strictEqual(typeof pcQr.createTransferPayload, 'function');
  assert.strictEqual(typeof pcQr.claimRemoteTransferSession, 'function');
  console.log(' -> PC backend services verified (PASS).');

  // 2. Check HTML script injections
  console.log('[2/8] Verifying HTML script injections...');
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
  console.log('[3/8] Verifying cookie sanitization in Auth responses...');
  const dummyAcc = { id: 'test1234', name: 'Test User', cookie: 'SECRET_COOKIE_DATA' };
  const sanitized = pcAuthInst.getSanitizedAccount(dummyAcc);
  assert.strictEqual(sanitized.cookie, undefined, 'Sanitized account must not expose cookie');
  assert.strictEqual(sanitized.id, 'test1234');
  console.log(' -> Sanitization verified (PASS).');

  // 4. Verify Vault-Backed AES-256-GCM Encryption Round-Trip & Safe Plaintext Migration
  console.log('[4/8] Verifying Vault-backed AES-256-GCM encryption round-trip & migration...');
  const migDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eclipse-pc-mig-'));
  const legacyJson = path.join(migDir, 'ytm-accounts.json');
  const encFile = path.join(migDir, 'ytm-accounts.enc');
  fs.writeFileSync(legacyJson, JSON.stringify([
    { id: 'mig_user', name: 'Migrated User', cookie: 'SAPISID=secret_999; SID=abc', isDefault: true }
  ]), 'utf8');
  let vaultMem = null;
  const mockVault = {
    read: () => vaultMem,
    write: (v) => { vaultMem = v; }
  };
  const authMig = new YtmAuth(migDir, mockVault);
  assert(vaultMem && /^[0-9a-f]{64}$/i.test(vaultMem.keyHex), 'Vault must store random 256-bit key');
  assert(!fs.existsSync(legacyJson), 'Legacy plaintext JSON must be removed after verified migration');
  assert(fs.existsSync(encFile), 'Encrypted .enc file must exist on disk');
  const rawEncOnDisk = fs.readFileSync(encFile, 'utf8');
  assert(!rawEncOnDisk.includes('SAPISID=secret_999'), 'Encrypted file on disk must not contain plaintext cookie');

  const authReloaded = new YtmAuth(migDir, mockVault);
  assert.strictEqual(authReloaded.getRawActiveAccount().cookie, 'SAPISID=secret_999; SID=abc', 'Reloaded account must decrypt original cookie');
  assert.strictEqual(authReloaded.getActiveAccount().cookie, undefined, 'Public getActiveAccount must strip cookie');
  console.log(' -> Encryption round-trip & safe migration verified (PASS).');

  // 5. Verify Cross-Device HTTP Server-to-Server QR Session Transfer (PC Server -> Remote Mobile Client)
  console.log('[5/8] Verifying Cross-Device HTTP QR Session Transfer over network socket...');
  const mockPcServer = http.createServer((req, res) => {
    if (req.url === '/api/ytm/session-transfer/claim' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const p = JSON.parse(body);
          const encryptedAccount = pcQr.claimTransferSession(p.transferId, p.secretKey, { encryptForTransit: true });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, encryptedAccount }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
      });
    }
  });
  await new Promise(r => mockPcServer.listen(0, '127.0.0.1', r));
  const srvPort = mockPcServer.address().port;
  const createdTicket = pcQr.createTransferPayload({ id: 'lan_u1', name: 'LAN User', cookie: 'SAPISID=lan_cookie_val' }, srvPort);
  const claimedOverHttp = await pcQr.claimRemoteTransferSession(`http://127.0.0.1:${srvPort}`, createdTicket.transferId, createdTicket.secretKey);
  assert.strictEqual(claimedOverHttp.cookie, 'SAPISID=lan_cookie_val', 'Remote HTTP claim must decrypt and restore cookie');
  // Ensure one-time token burn
  let replayFailed = false;
  try {
    await pcQr.claimRemoteTransferSession(`http://127.0.0.1:${srvPort}`, createdTicket.transferId, createdTicket.secretKey);
  } catch (_) {
    replayFailed = true;
  }
  assert(replayFailed, 'Second claim on burnt token must be rejected');
  await new Promise(r => mockPcServer.close(r));
  console.log(' -> Cross-device HTTP QR transfer & one-time token burn verified (PASS).');

  // 6. Verify Smart Downloads Real Execution
  console.log('[6/8] Verifying SmartDownloads real batch execution...');
  const SmartDownloadManager = require('./src/renderer/smart-downloads');
  const sdm = new SmartDownloadManager({ enabled: true, limit: 10, wifiOnly: true, delayMs: 5 });
  const tracks = [
    { id: 't1', title: 'Song 1', isCached: true },
    { id: 't2', title: 'Song 2', isCached: false },
    { id: 't3', title: 'Song 3', isCached: false }
  ];
  const planned = sdm.planDownloads(tracks, (id, tr) => !!tr.isCached);
  assert.strictEqual(planned.length, 2, 'Must plan 2 uncached tracks');
  const downloadedIds = [];
  const syncRes = await sdm.startSync(async (tr) => { downloadedIds.push(tr.id); }, () => true);
  assert.strictEqual(syncRes.downloaded, 2);
  assert.deepStrictEqual(downloadedIds, ['t2', 't3']);
  console.log(' -> SmartDownloads execution verified (PASS).');

  // 7. Verify AutoMix DJ Two-Source Equal-Power Crossfade
  console.log('[7/8] Verifying AutoMix DJ two-source crossfade...');
  const AutoMixDJ = require('./src/renderer/automix-dj');
  const dj = new AutoMixDJ({ enabled: true, durationSec: 0.15, mode: 'equal_power' });
  const outgoingMock = { volume: 1.0, paused: false, pause() { this.paused = true; } };
  const incomingMock = { volume: 1.0, paused: true, async play() { this.paused = false; } };
  const xfadeOk = await dj.executeCrossfade(outgoingMock, incomingMock, 0.15);
  assert.strictEqual(xfadeOk, true, 'executeCrossfade must complete and return true');
  assert.strictEqual(outgoingMock.paused, true, 'Outgoing audio must be paused at end of crossfade');
  assert.strictEqual(incomingMock.paused, false, 'Incoming audio must be playing');
  assert.strictEqual(incomingMock.volume, 1.0, 'Incoming audio volume must reach 1.0');
  console.log(' -> AutoMix DJ two-source crossfade verified (PASS).');

  // 8. Verify Integration Bridge has no duplicate #btn-confirm-clear-cache listener
  console.log('[8/8] Verifying single-source Storage Manager clear listener...');
  const bridgeSrc = fs.readFileSync(path.join(__dirname, 'src/renderer/integration-bridge.js'), 'utf8');
  assert(!bridgeSrc.includes("getElementById('btn-confirm-clear-cache')"), 'integration-bridge.js must not attach duplicate click listener on btn-confirm-clear-cache');
  assert(bridgeSrc.includes('executeCrossfade(nativeAudio, auxAudio'), 'integration-bridge.js must invoke dual-source executeCrossfade');
  console.log(' -> Single-source Storage clear & bridge wiring verified (PASS).');

  console.log('--- ALL 8/8 VERIFICATION CHECKS PASSED (EXIT CODE 0) ---');
}

runTests().catch(err => {
  console.error('VERIFICATION FAILED:', err);
  process.exit(1);
});
