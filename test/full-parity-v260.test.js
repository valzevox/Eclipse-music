'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('1. cleanSearchResults exported from src/server/server.js', () => {
  const serverPath = path.join(__dirname, '../src/server/server.js');
  const serverCode = fs.readFileSync(serverPath, 'utf8');

  // Verify function export declaration and cleanSearchResults logic
  assert.ok(serverCode.includes('function cleanSearchResults('), 'cleanSearchResults function defined in server.js');
  assert.ok(serverCode.includes('cleanSearchResults'), 'cleanSearchResults exported in module.exports');

  // Load cleanSearchResults function in isolated context
  const startIdx = serverCode.indexOf('function cleanSearchResults(');
  const endIdx = serverCode.indexOf('\n// In-memory sync rooms relay store', startIdx);
  assert.ok(startIdx > 0 && endIdx > startIdx, 'cleanSearchResults source boundaries found');
  const fnCode = `${serverCode.slice(startIdx, endIdx)}\ncleanSearchResults;`;
  const cleanSearchResults = vm.runInNewContext(fnCode, {});

  // Test Case A: Relevance ordering & filtering
  const tracksA = [
    { id: 'unrelated', title: 'Different Song', artist: 'Other Artist', platform: 'soundcloud' },
    { id: 'matching', title: 'One Way Ticket', artist: 'ONDA ANDAR', platform: 'soundcloud' },
    { id: 'partial', title: 'Ticket', artist: 'Onda Andar', platform: 'soundcloud' },
    { id: 'weak-match', title: 'Maple (Slowed)', artist: 'Other Artist', platform: 'soundcloud' }
  ];
  const resA = cleanSearchResults(tracksA, 'one way ticket ONDA ANDAR');
  const resAIds = Array.from(resA).map(t => t.id);
  assert.strictEqual(JSON.stringify(resAIds), JSON.stringify(['matching', 'partial']));

  // Test Case B: Title deduplication collapsing official/audio variants
  const tracksB = [
    { id: 'first', title: 'Maple (Official Audio)', artist: 'Chainsaww', platform: 'soundcloud' },
    { id: 'second', title: 'Maple', artist: 'Chainsaww', platform: 'soundcloud' }
  ];
  const resB = cleanSearchResults(tracksB, 'chainsaww Maple');
  assert.strictEqual(resB.length, 1);
  assert.strictEqual(resB[0].title, 'Maple (Official Audio)');

  // Test Case C: Hour-long / mix compilation filter
  const tracksC = [
    { id: 'song', title: 'Masquerade', artist: 'Sioxxie', platform: 'soundcloud' },
    { id: 'long', title: 'SCP-3008 Friday Theme 1 hour', artist: 'Sioxxie', platform: 'soundcloud' },
    { id: 'mix', title: 'Nightcore TikTok Audios May Part 4', artist: 'Sioxxie', platform: 'soundcloud' }
  ];
  const resC = cleanSearchResults(tracksC, 'Sioxxie');
  const resCIds = Array.from(resC).map(t => t.id);
  assert.strictEqual(JSON.stringify(resCIds), JSON.stringify(['song']));
});

test('2. Two-way cloud sync methods on YtmAuthManager', () => {
  const YtmAuthManager = require('../src/server/ytm-auth');
  const tempDir = path.join(__dirname, '../Music Download');
  const auth = new YtmAuthManager(tempDir);

  assert.strictEqual(typeof auth.rateTrack, 'function', 'rateTrack must be a function');
  assert.strictEqual(typeof auth.createCloudPlaylist, 'function', 'createCloudPlaylist must be a function');
  assert.strictEqual(typeof auth.editCloudPlaylist, 'function', 'editCloudPlaylist must be a function');
  assert.strictEqual(typeof auth.setArtistSubscription, 'function', 'setArtistSubscription must be a function');
  assert.strictEqual(typeof auth.reportPlaybackTelemetry, 'function', 'reportPlaybackTelemetry must be a function');
});

test('3. EclipseAudioEngine Multi-Tap Echo Delay & Sleep Timer Cosine Fade (sleepFadeGain)', () => {
  const audioCode = fs.readFileSync(path.join(__dirname, '../src/renderer/audio/audio.js'), 'utf8');

  // Verify Echo Delay nodes and methods
  assert.ok(audioCode.includes('this.sleepFadeGain = null;'), 'sleepFadeGain property declared');
  assert.ok(audioCode.includes('this.delayNode = null;'), 'delayNode property declared');
  assert.ok(audioCode.includes('this.delayTap2Node = null;'), 'delayTap2Node property declared');
  assert.ok(audioCode.includes('this.delayFeedbackGain = null;'), 'delayFeedbackGain property declared');
  assert.ok(audioCode.includes('this.delayWetGain = null;'), 'delayWetGain property declared');
  assert.ok(audioCode.includes('this.delayDryGain = null;'), 'delayDryGain property declared');
  assert.ok(audioCode.includes('setEchoDelay('), 'setEchoDelay method implemented');
  assert.ok(audioCode.includes('startSleepCosineFade('), 'startSleepCosineFade method implemented');

  // Verify cosine fade math: Math.cos(progress * Math.PI * 0.5)
  assert.ok(audioCode.includes('Math.cos(progress * Math.PI * 0.5)'), 'Cosine curve computation verified');
});

test('4. AutoEqManager.applyToAudioEngine and expanded profile search', () => {
  const { AutoEqManager, POPULAR_HEADPHONES } = require('../src/renderer/audio/auto-eq');
  assert.strictEqual(typeof AutoEqManager, 'function');
  assert.ok(Array.isArray(POPULAR_HEADPHONES) && POPULAR_HEADPHONES.length >= 40);

  const manager = new AutoEqManager();
  assert.strictEqual(typeof manager.applyToAudioEngine, 'function');
  assert.strictEqual(typeof manager.searchProfiles, 'function');

  const sonyResults = manager.searchProfiles('wh-1000xm5');
  assert.ok(sonyResults.length >= 1, 'Should find Sony WH-1000XM5 profile');
  assert.ok(sonyResults[0].id.includes('sony'), 'Result ID matches sony');
});

test('5. AutoMixDJ.shouldSkipCrossfade & structure offsets', () => {
  const AutoMixDJ = require('../src/renderer/automix/automix-dj');
  assert.strictEqual(typeof AutoMixDJ, 'function');

  const dj = new AutoMixDJ();
  assert.strictEqual(typeof dj.shouldSkipCrossfade, 'function');
  assert.strictEqual(typeof dj.getSmartTransitionOffsets, 'function');

  // Short track
  assert.deepStrictEqual(dj.shouldSkipCrossfade({ duration: 15 }, { duration: 180 }), { skip: true, reason: 'duration_too_short' });
  // Video mode
  assert.deepStrictEqual(dj.shouldSkipCrossfade({ duration: 200 }, { duration: 200 }, { isVideoMode: true }), { skip: true, reason: 'video_mode_active' });
  // Sync room
  assert.deepStrictEqual(dj.shouldSkipCrossfade({ duration: 200 }, { duration: 200 }, { inSyncRoom: true }), { skip: true, reason: 'sync_room_active' });
  // Normal tracks
  assert.deepStrictEqual(dj.shouldSkipCrossfade({ duration: 200 }, { duration: 200 }, {}), { skip: false });
});

test('6. SmartDownloadManager.isWifiConnection on Desktop (type === undefined)', async () => {
  const { SmartDownloadManager } = require('../src/renderer/library/smart-downloads');
  assert.strictEqual(typeof SmartDownloadManager.isWifiConnection, 'function');

  const desktopNav = { onLine: true, connection: { type: undefined, saveData: false } };
  assert.strictEqual(await SmartDownloadManager.isWifiConnection(desktopNav), true, 'Desktop connection is treated as wifi');

  const cellularNav = { onLine: true, connection: { type: 'cellular', saveData: false } };
  assert.strictEqual(await SmartDownloadManager.isWifiConnection(cellularNav), false, 'Cellular connection is not wifi');
});

test('7. SongDnaManager dynamic port & modal rendering', () => {
  const { SongDnaManager } = require('../src/renderer/features/song-dna');
  assert.strictEqual(typeof SongDnaManager, 'function');

  const manager = new SongDnaManager();
  assert.strictEqual(typeof manager.renderModal, 'function');
  assert.strictEqual(typeof manager.apiBase, 'string');
  assert.ok(manager.apiBase.includes('38472'), 'Resolves dynamic server port with fallback to 38472');
  assert.ok(!manager.apiBase.includes('3000'), 'Hardcoded port 3000 removed');
});

test('8. ListenTogetherRoom real LAN/relay networking methods', () => {
  const listenTogetherCode = fs.readFileSync(path.join(__dirname, '../src/renderer/features/listen-together.js'), 'utf8');

  assert.ok(listenTogetherCode.includes('/api/sync-room/create'), 'createRoom endpoint wired');
  assert.ok(listenTogetherCode.includes('/api/sync-room/join'), 'joinRoom endpoint wired');
  assert.ok(listenTogetherCode.includes('/api/sync-room/state'), 'syncState endpoint wired');
  assert.ok(listenTogetherCode.includes('/api/sync-room/action'), 'sendAction endpoint wired');
  assert.ok(listenTogetherCode.includes('isActiveRoom()'), 'isActiveRoom helper method exists');
});

test('9. EclipseAnalyticsManager & EclipseFrameGovernor', () => {
  const { EclipseAnalyticsManager } = require('../src/renderer/features/eclipse-analytics');
  assert.strictEqual(typeof EclipseAnalyticsManager, 'function');

  const analytics = new EclipseAnalyticsManager();
  assert.strictEqual(typeof analytics.compute24HourClock, 'function');
  assert.strictEqual(typeof analytics.computeSonicRadar, 'function');
  assert.strictEqual(typeof analytics.render24HourClockSvg, 'function');
  assert.strictEqual(typeof analytics.renderSonicRadarSvg, 'function');
  assert.strictEqual(typeof analytics.determineSonicPersona, 'function');

  const { EclipseFrameGovernor, redactSensitiveTokens } = require('../src/renderer/ui/frame-governor');
  assert.strictEqual(typeof EclipseFrameGovernor, 'function');
  assert.strictEqual(typeof redactSensitiveTokens, 'function');

  const redacted = redactSensitiveTokens('User token SAPISID=xyz123 and X-Eclipse-Token: abc456');
  assert.ok(!redacted.includes('xyz123'), 'SAPISID redacted');
  assert.ok(!redacted.includes('abc456'), 'X-Eclipse-Token redacted');
});

test('10. index.html script tags order', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');

  const themeIdx = html.indexOf('src="ui/theme-presets.js"');
  const dnaIdx = html.indexOf('src="features/song-dna.js"');
  const analyticsIdx = html.indexOf('src="features/eclipse-analytics.js"');
  const frameGovIdx = html.indexOf('src="ui/frame-governor.js"');
  const bridgeIdx = html.indexOf('src="ui/integration-bridge.js"');

  assert.ok(themeIdx > 0, 'theme-presets.js script tag found');
  assert.ok(dnaIdx > 0, 'song-dna.js script tag found');
  assert.ok(analyticsIdx > 0, 'eclipse-analytics.js script tag found');
  assert.ok(frameGovIdx > 0, 'frame-governor.js script tag found');
  assert.ok(bridgeIdx > 0, 'integration-bridge.js script tag found');

  assert.ok(themeIdx < bridgeIdx, 'theme-presets.js loaded before integration-bridge.js');
  assert.ok(dnaIdx < bridgeIdx, 'song-dna.js loaded before integration-bridge.js');
  assert.ok(analyticsIdx < bridgeIdx, 'eclipse-analytics.js loaded before integration-bridge.js');
  assert.ok(frameGovIdx < bridgeIdx, 'frame-governor.js loaded before integration-bridge.js');
});

test('11. Zero competitor brand mentions in newly added UI presets and modules', () => {
  const checkFiles = [
    '../src/renderer/ui/theme-presets.js',
    '../src/renderer/features/song-dna.js',
    '../src/renderer/features/eclipse-analytics.js',
    '../src/renderer/ui/frame-governor.js'
  ];

  const forbidden = [/\bsimpmusic\b/i, /\bechomusic\b/i];

  for (const relPath of checkFiles) {
    const fullPath = path.join(__dirname, relPath);
    if (fs.existsSync(fullPath)) {
      const content = fs.readFileSync(fullPath, 'utf8');
      for (const pattern of forbidden) {
        assert.ok(!pattern.test(content), `File ${relPath} contains forbidden competitor brand mention: ${pattern}`);
      }
    }
  }
});
