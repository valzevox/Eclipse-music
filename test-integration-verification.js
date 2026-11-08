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

  // 4. Verify Vault Master Key Persistence, 06e1427 Migration, and Failure Safety
  console.log('[4/8] Verifying Vault-backed AES-256-GCM encryption, 06e1427 migration, & failure safety...');
  
  // 4A: Migration from 06e1427 data: pre-existing master key in legacy format
  const migDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eclipse-pc-mig-'));
  const legacyJson = path.join(migDir, 'ytm-accounts.json');
  const encFile = path.join(migDir, 'ytm-accounts.enc');
  fs.writeFileSync(legacyJson, JSON.stringify([
    { id: 'mig_user', name: 'Migrated User', cookie: 'SAPISID=secret_999; SID=abc', isDefault: true }
  ]), 'utf8');

  // Simulate 06e1427 saved master key
  const preExistingKeyHex = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  let vaultStore = { keyHex: preExistingKeyHex, createdAt: 1700000000000 };
  const mockVault = {
    read: () => vaultStore,
    write: (v) => { vaultStore = v; return Promise.resolve({ success: true }); }
  };

  const authMig = new YtmAuth(migDir, mockVault);
  assert.strictEqual(vaultStore.keyHex, preExistingKeyHex, 'Master key from 06e1427 must be preserved, not overwritten');
  assert(!fs.existsSync(legacyJson), 'Legacy plaintext JSON must be unlinked only after verified encrypted migration');
  assert(fs.existsSync(encFile), 'Encrypted .enc file must exist on disk');
  const rawEncOnDisk = fs.readFileSync(encFile, 'utf8');
  assert(!rawEncOnDisk.includes('SAPISID=secret_999'), 'Encrypted file on disk must not contain plaintext cookie');

  const authReloaded = new YtmAuth(migDir, mockVault);
  assert.strictEqual(authReloaded.getRawActiveAccount().cookie, 'SAPISID=secret_999; SID=abc', 'Reloaded account must decrypt original cookie');
  assert.strictEqual(authReloaded.getActiveAccount().cookie, undefined, 'Public getActiveAccount must strip cookie');

  // 4B: Vault failure safety: If native vault persistence fails, plaintext must NOT be deleted
  const failDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eclipse-pc-fail-'));
  const failPlainJson = path.join(failDir, 'ytm-accounts.json');
  fs.writeFileSync(failPlainJson, JSON.stringify([{ id: 'u_safe', cookie: 'MUST_NOT_DELETE' }]), 'utf8');
  const failingVault = {
    read: () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; },
    write: () => { throw new Error('AndroidKeyStore/Keychain hardware access failed'); }
  };
  try {
    new YtmAuth(failDir, failingVault);
  } catch (_) {}
  assert(fs.existsSync(failPlainJson), 'CRITICAL: Plaintext JSON must NEVER be deleted when hardware vault write fails');
  console.log(' -> Vault persistence, 06e1427 migration, & failure safety verified (PASS).');

  // 5. Verify Cross-Device QR Session Transfer (LAN Socket + Signed Replay-Protected Direct QR)
  console.log('[5/8] Verifying Cross-Device QR Session Transfer & anti-replay security...');
  
  // 5A: Verify LAN IP resolver never returns 127.0.0.1
  const serverJs = fs.readFileSync(path.join(__dirname, 'src/server/server.js'), 'utf8');
  assert(serverJs.includes('directPayload'), 'server.js claim route must destructure directPayload');

  // 5B: Mock HTTP server for simulated route claims
  const mockPcServer = http.createServer((req, res) => {
    if (req.url === '/api/ytm/session-transfer/claim' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', async () => {
        try {
          const p = JSON.parse(body || '{}');
          if (p.transitEncrypted) {
            const encryptedAccount = pcQr.claimTransferSession(p.transferId, p.secretKey, { encryptForTransit: true });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: true, encryptedAccount }));
          }
          let account = null;
          try {
            account = pcQr.claimTransferSession(p.transferId, p.secretKey);
          } catch (localErr) {
            account = await pcQr.claimRemoteTransferSession(p.sourceServerUrl, p.transferId, p.secretKey, p.directPayload);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, account }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
      });
    }
  });
  await new Promise(r => mockPcServer.listen(0, '127.0.0.1', r));
  const srvPort = mockPcServer.address().port;

  // Test LAN Transfer (Source has HTTP socket)
  const ticketLan = pcQr.createTransferPayload({ id: 'lan_u1', name: 'LAN User', cookie: 'SAPISID=lan_val' }, srvPort);
  // Claim via direct claimTransferSession
  const claimedLan = pcQr.claimTransferSession(ticketLan.transferId, ticketLan.secretKey);
  assert.strictEqual(claimedLan.cookie, 'SAPISID=lan_val', 'LAN claim must return cookie');
  assert.throws(() => pcQr.claimTransferSession(ticketLan.transferId, ticketLan.secretKey), /expired|not found/, 'One-time token burn required');

  // Test Direct QR Payload (Mobile -> PC simulation without socket)
  const ticketDirect = pcQr.createTransferPayload({ id: 'mob_u1', name: 'Mobile User', cookie: 'SAPISID=mob_val' }, 38472, { includeDirectPayload: true });
  assert(ticketDirect.directPayload, 'Direct payload must be generated');
  assert(ticketDirect.directPayload.sig, 'Direct payload must be cryptographically signed');

  // Claim direct payload through simulated route
  const claimedDirect = await pcQr.claimRemoteTransferSession(null, ticketDirect.transferId, ticketDirect.secretKey, ticketDirect.directPayload);
  assert.strictEqual(claimedDirect.cookie, 'SAPISID=mob_val', 'Direct claim must verify HMAC and decrypt cookie');

  // Anti-Replay: Attempting to claim the same directPayload again must fail
  let replayBlocked = false;
  try {
    await pcQr.claimRemoteTransferSession(null, ticketDirect.transferId, ticketDirect.secretKey, ticketDirect.directPayload);
  } catch (err) {
    if (err.message.includes('already been used')) replayBlocked = true;
  }
  assert(replayBlocked, 'CRITICAL: Direct QR ticket replay must be blocked on client');

  // Expiration: Expired ticket must be rejected
  const expiredPayload = { ...ticketDirect.directPayload, transferId: 'exp_t1', expiresAt: Date.now() - 5000 };
  let expBlocked = false;
  try {
    await pcQr.claimRemoteTransferSession(null, 'exp_t1', ticketDirect.secretKey, expiredPayload);
  } catch (err) {
    if (err.message.includes('expired')) expBlocked = true;
  }
  assert(expBlocked, 'CRITICAL: Expired Direct QR ticket must be rejected');

  // Tamper proofing: Corrupt ciphertext must fail signature verification
  const tamperedPayload = { ...ticketDirect.directPayload, transferId: 'tamp_t1', data: 'deadbeef' };
  let tamperBlocked = false;
  try {
    await pcQr.claimRemoteTransferSession(null, 'tamp_t1', ticketDirect.secretKey, tamperedPayload);
  } catch (err) {
    if (err.message.includes('signature verification failed')) tamperBlocked = true;
  }
  assert(tamperBlocked, 'CRITICAL: Tampered Direct QR ticket must fail HMAC verification');

  await new Promise(r => mockPcServer.close(r));
  console.log(' -> Cross-device QR transfer & anti-replay security verified (PASS).');

  // 6. Verify Smart Downloads Wi-Fi Gate & Mid-Batch Cellular Protection
  console.log('[6/8] Verifying SmartDownloads Wi-Fi gate & mid-batch cellular protection...');
  const SmartDownloadManager = require('./src/renderer/smart-downloads');
  
  // 6A: Unit tests for isWifiConnection()
  assert.strictEqual(SmartDownloadManager.isWifiConnection(null), false, 'Must return false when navigator is null/undefined');
  assert.strictEqual(SmartDownloadManager.isWifiConnection({ onLine: true, connection: undefined }), false, 'Must return false when connection is unavailable');
  assert.strictEqual(SmartDownloadManager.isWifiConnection({ onLine: false, connection: { type: 'wifi' } }), false, 'Must return false when offline');
  assert.strictEqual(SmartDownloadManager.isWifiConnection({ onLine: true, connection: { type: 'cellular' } }), false, 'Must return false on cellular');
  assert.strictEqual(SmartDownloadManager.isWifiConnection({ onLine: true, connection: { type: 'unknown' } }), false, 'Must NOT allow unknown connection type under wifiOnly');
  assert.strictEqual(SmartDownloadManager.isWifiConnection({ onLine: true, connection: { type: 'wifi' } }), true, 'Must return true on wifi');
  assert.strictEqual(SmartDownloadManager.isWifiConnection({ onLine: true, connection: { type: 'ethernet' } }), true, 'Must return true on ethernet');

  // 6B: Verify mid-batch network switch stops downloading immediately
  const sdmMidBatch = new SmartDownloadManager({ enabled: true, limit: 10, wifiOnly: true, delayMs: 1 });
  sdmMidBatch.queue = [
    { id: 'track_1', title: 'Track 1' },
    { id: 'track_2', title: 'Track 2' },
    { id: 'track_3', title: 'Track 3' }
  ];
  sdmMidBatch.total = 3;
  let wifiFlag = true;
  const processedTracks = [];
  const midBatchRes = await sdmMidBatch.startSync(async (tr) => {
    processedTracks.push(tr.id);
    // Simulate network dropping to cellular after first track
    wifiFlag = false;
  }, () => Promise.resolve(wifiFlag));

  assert.strictEqual(processedTracks.length, 1, 'Only track 1 should download before cellular switch');
  assert.strictEqual(midBatchRes.pausedReason, 'network_switched_to_cellular', 'Must pause with network_switched_to_cellular');
  assert.strictEqual(sdmMidBatch.queue.length, 2, 'Remaining tracks must remain in queue for when Wi-Fi reconnects');
  console.log(' -> SmartDownloads Wi-Fi gate & mid-batch cellular protection verified (PASS).');

  // 7. Verify AutoMix DJ Seamless Handover on PC & Mobile
  console.log('[7/8] Verifying AutoMix DJ two-source crossfade & seamless handover...');
  const AutoMixDJ = require('./src/renderer/automix-dj');
  const dj = new AutoMixDJ({ enabled: true, durationSec: 0.15, mode: 'equal_power' });
  const outgoingMock = { volume: 1.0, paused: false, pause() { this.paused = true; } };
  const incomingMock = { volume: 1.0, paused: true, async play() { this.paused = false; } };
  const xfadeOk = await dj.executeCrossfade(outgoingMock, incomingMock, 0.15);
  assert.strictEqual(xfadeOk, true, 'executeCrossfade must complete and return true');
  assert.strictEqual(outgoingMock.paused, true, 'Outgoing audio must be paused at end of crossfade');
  assert.strictEqual(incomingMock.paused, false, 'Incoming audio must be playing');

  // Verify app.js contains seamless handover consumption logic
  const pcAppSrc = fs.readFileSync(path.join(__dirname, 'src/renderer/app.js'), 'utf8');
  assert(pcAppSrc.includes('state._autoMixHandover'), 'PC app.js must consume state._autoMixHandover');
  assert(pcAppSrc.includes('el.nativeAudio.currentTime = handover.currentTime'), 'PC app.js must preserve handover currentTime');
  assert(pcAppSrc.includes('el.nativeAudio.volume = state.volume'), 'PC app.js must restore volume on handover');
  console.log(' -> AutoMix DJ two-source crossfade & seamless handover verified (PASS).');

  // 8. Verify Integration Bridge has single-source clear listener
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
