// d:/Eclipse/eclipse-pc/test/album-sync-engine.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  computeAlbumMetadata,
  formatAlbumMetaLine,
  getTrackDedupKey,
  reconcilePlaylistTracks,
  getEntityIdentityKey,
  mergeSavedAlbumEntities,
  createLibrarySyncCoordinator
} = require('../src/renderer/album-sync-engine');

const { sortTracks, TRACK_SORT_MODES } = require('../src/renderer/track-sort');

test('1. Album Sort: all 5 modes work, missing duration goes last in asc & desc, original order preserved', () => {
  assert.ok(TRACK_SORT_MODES.includes('manual'));
  assert.ok(TRACK_SORT_MODES.includes('title-asc'));
  assert.ok(TRACK_SORT_MODES.includes('artist-asc'));
  assert.ok(TRACK_SORT_MODES.includes('duration-asc'));
  assert.ok(TRACK_SORT_MODES.includes('duration-desc'));

  const original = [
    { id: 't1', title: 'Zebra', artist: 'B-Artist', duration: 200 },
    { id: 't2', title: 'Alpha', artist: 'A-Artist', duration: null },
    { id: 't3', title: 'Middle', artist: 'C-Artist', duration: 90 },
    { id: 't4', title: 'Beta', artist: 'A-Artist', duration: 310 }
  ];
  const snapshot = original.map(t => t.id);

  assert.deepStrictEqual(sortTracks(original, 'title-asc').map(t => t.id), ['t2', 't4', 't3', 't1']);
  assert.deepStrictEqual(sortTracks(original, 'artist-asc').map(t => t.id), ['t2', 't4', 't1', 't3']);
  assert.deepStrictEqual(sortTracks(original, 'duration-asc').map(t => t.id), ['t3', 't1', 't4', 't2']);
  assert.deepStrictEqual(sortTracks(original, 'duration-desc').map(t => t.id), ['t4', 't1', 't3', 't2']);
  assert.deepStrictEqual(sortTracks(original, 'manual').map(t => t.id), snapshot);
  assert.deepStrictEqual(original.map(t => t.id), snapshot);
});

test('2. Album Metadata: distinguishes loading, unknown, empty, and ignores null durations', () => {
  assert.strictEqual(formatAlbumMetaLine({ type: 'Album', status: 'loading', trackCount: null }), 'Album • Đang tải bài hát...');
  assert.strictEqual(formatAlbumMetaLine({ type: 'Album', status: 'unknown', trackCount: null }), 'Album • Chưa rõ số bài');
  assert.strictEqual(formatAlbumMetaLine({ type: 'Album', status: 'empty', trackCount: 0 }), 'Album • 0 bản nhạc (trống)');

  const meta = computeAlbumMetadata([
    { id: '1', duration: 180 },
    { id: '2', duration: null },
    { id: '3', durationMs: 120000 }
  ]);
  assert.strictEqual(meta.trackCount, 3);
  assert.strictEqual(meta.totalDurationSec, 300);
  assert.strictEqual(meta.missingDurationCount, 1);
  assert.strictEqual(
    formatAlbumMetaLine({ type: 'Album', year: '2026', status: 'ready', trackCount: meta.trackCount, totalDurationSec: meta.totalDurationSec }),
    'Album • 2026 • 3 bản nhạc • 5 phút'
  );
});

test('3. Dedup & Reconcile: keeps same-title different-ID & different-account playlists separate, preserves editions', () => {
  const existing = [
    { id: 'VLPL_1', title: 'Chill', artist: 'User', type: 'Playlist', accountId: 'accA', sortMode: 'duration-desc', tracks: [{ id: 'v1', title: 'A', addedAt: 100 }, { id: 'v2', title: 'B', addedAt: 200 }] }
  ];
  const incoming = [
    { id: 'VLPL_1', title: 'Chill', artist: 'User', type: 'Playlist', accountId: 'accA', complete: true, failed: false, tracks: [{ id: 'v3', title: 'C' }, { id: 'v1', title: 'A' }] },
    { id: 'VLPL_2', title: 'Chill', artist: 'User', type: 'Playlist', accountId: 'accA', complete: true, failed: false, tracks: [{ id: 'v9', title: 'Z' }] }
  ];
  const merged = mergeSavedAlbumEntities(existing, incoming, 'accA');
  assert.strictEqual(merged.list.length, 2);
  assert.strictEqual(merged.list[0].sortMode, 'duration-desc');
  assert.deepStrictEqual(merged.list[0].tracks.map(t => t.id), ['v3', 'v1']);
  assert.strictEqual(merged.list[0].tracks[1].addedAt, 100);

  // Account A vs Account B with same-name fallback playlist (no ID) stay separate
  const accAKey = getEntityIdentityKey({ title: 'Favorites', type: 'Playlist', accountId: 'accA' }, 'accA');
  const accBKey = getEntityIdentityKey({ title: 'Favorites', type: 'Playlist', accountId: 'accB' }, 'accB');
  assert.notStrictEqual(accAKey, accBKey);

  // Same album title, different artists without ID stay separate
  const k1 = getEntityIdentityKey({ title: 'Greatest Hits', artist: 'Artist A', type: 'Album' }, 'accA');
  const k2 = getEntityIdentityKey({ title: 'Greatest Hits', artist: 'Artist B', type: 'Album' }, 'accA');
  assert.notStrictEqual(k1, k2);

  // Track dedup fallback distinguishes live/remix/remaster/explicit
  const tOrig = getTrackDedupKey({ title: 'Song', artist: 'Singer' });
  const tLive = getTrackDedupKey({ title: 'Song (Live)', artist: 'Singer' });
  const tRemix = getTrackDedupKey({ title: 'Song (Remix)', artist: 'Singer' });
  const tExp = getTrackDedupKey({ title: 'Song', artist: 'Singer', isExplicit: true });
  assert.strictEqual(new Set([tOrig, tLive, tRemix, tExp]).size, 4);
});

test('4. P0-2 Non-Destructive Reconciliation: preserves local tracks on failed/timeout/partial/page-cap, allows removal on complete empty', () => {
  const local = [{ id: 'v1', title: 'Track 1' }, { id: 'v2', title: 'Track 2' }];

  // Failed playlist fetch
  const onFail = reconcilePlaylistTracks(local, [], { complete: false, failed: true, errorCode: 'HTTP_500' });
  assert.strictEqual(onFail.preservedDueToIncompleteFetch, true);
  assert.deepStrictEqual(onFail.tracks.map(t => t.id), ['v1', 'v2']);

  // Timeout
  const onTimeout = reconcilePlaylistTracks(local, [], { complete: false, failed: true, errorCode: 'ABORTED' });
  assert.strictEqual(onTimeout.preservedDueToIncompleteFetch, true);
  assert.deepStrictEqual(onTimeout.tracks.map(t => t.id), ['v1', 'v2']);

  // Partial continuation
  const onPartial = reconcilePlaylistTracks(local, [{ id: 'v1', title: 'Track 1' }], { complete: false, failed: false, continuationRemaining: true });
  assert.strictEqual(onPartial.preservedDueToIncompleteFetch, true);
  assert.deepStrictEqual(onPartial.tracks.map(t => t.id), ['v1', 'v2']);

  // Page cap exhaustion
  const onCap = reconcilePlaylistTracks(local, [{ id: 'v1', title: 'Track 1' }], { complete: false, failed: false, pagesFetched: 30, continuationRemaining: true });
  assert.strictEqual(onCap.preservedDueToIncompleteFetch, true);
  assert.deepStrictEqual(onCap.tracks.map(t => t.id), ['v1', 'v2']);

  // Truly empty, fully fetched upstream playlist removes local tracks
  const onRealEmpty = reconcilePlaylistTracks(local, [], { complete: true, failed: false, continuationRemaining: false });
  assert.strictEqual(onRealEmpty.preservedDueToIncompleteFetch, undefined);
  assert.deepStrictEqual(onRealEmpty.tracks, []);
  assert.strictEqual(onRealEmpty.removed, 2);

  // Complete reorder & deletion
  const onReorder = reconcilePlaylistTracks(local, [{ id: 'v2', title: 'Track 2' }, { id: 'v3', title: 'Track 3' }], { complete: true, failed: false, continuationRemaining: false });
  assert.deepStrictEqual(onReorder.tracks.map(t => t.id), ['v2', 'v3']);
  assert.strictEqual(onReorder.added, 1);
  assert.strictEqual(onReorder.removed, 1);
  assert.strictEqual(onReorder.reordered, true);

  // mergeSavedAlbumEntities also preserves tracks when incoming playlist is failed/incomplete
  const existingAlb = [{ id: 'VLPL_1', title: 'Mix', type: 'Playlist', accountId: 'accA', tracks: local, trackCount: 2 }];
  const mergedFail = mergeSavedAlbumEntities(existingAlb, [{ id: 'VLPL_1', title: 'Mix', type: 'Playlist', accountId: 'accA', tracks: [], complete: false, failed: true }], 'accA');
  assert.strictEqual(mergedFail.list[0].tracks.length, 2);
  assert.strictEqual(mergedFail.list[0].trackCount, 2);
});

test('5. Background Sync Coordinator: single-flight join, real timeout cancellation, account switch invalidation, HTTP 429 Retry-After', async () => {
  let activeAccount = 'acc1';
  let appActive = false;
  let calls = 0;
  let cancelledIds = [];
  let lastReceivedAccount = null;
  let resolveCall;

  const coord = createLibrarySyncCoordinator({
    getActiveAccountId: () => activeAccount,
    isAppActive: () => appActive,
    timeoutMs: 40,
    baseBackoffMs: 1000,
    cancelFn: (reqId) => { cancelledIds.push(reqId); },
    syncFn: ({ accountId }) => {
      calls++;
      lastReceivedAccount = accountId;
      return new Promise(r => { resolveCall = r; });
    }
  });

  // Skips background sync when app inactive
  const skipped = await coord.runSync('background');
  assert.strictEqual(skipped.skipped, true);
  assert.strictEqual(calls, 0);

  // Manual sync joins active background sync (single-flight) & propagates accountId
  appActive = true;
  const p1 = coord.runSync('background');
  const p2 = coord.runSync('manual');
  assert.strictEqual(calls, 1);
  assert.strictEqual(lastReceivedAccount, 'acc1');
  assert.strictEqual(coord.getState().status, 'syncing');
  resolveCall({ success: true });
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.strictEqual(r1.success, true);
  assert.strictEqual(r2.success, true);
  assert.strictEqual(coord.getState().status, 'success');
  assert.ok(coord.getState().lastSync > 0);

  // Timeout triggers real cancelFn with requestId
  const timeoutRes = await coord.runSync('manual');
  assert.strictEqual(timeoutRes.success, false);
  assert.strictEqual(timeoutRes.errorCode, 'SYNC_TIMEOUT');
  assert.strictEqual(cancelledIds.length, 1);

  // Account switch during in-flight cancels & discards stale result
  const p3 = coord.runSync('manual');
  activeAccount = 'acc2';
  coord.invalidateAccount('account_switched');
  assert.strictEqual(cancelledIds.length, 2);
  resolveCall({ success: true, stalePayload: true });
  const r3 = await p3;
  assert.strictEqual(r3.discarded, true);

  // HTTP 429 honors Retry-After
  const p4 = coord.runSync('background');
  resolveCall({ success: false, status: 429, retryAfter: 120 });
  const r4 = await p4;
  assert.strictEqual(r4.rateLimited, true);
  assert.strictEqual(r4.retryAfter, 120);
  assert.strictEqual(coord.getState().status, 'failed');
  const r5 = await coord.runSync('background');
  assert.strictEqual(r5.skipped, true);
  assert.strictEqual(r5.reason, 'backoff_active');
});
