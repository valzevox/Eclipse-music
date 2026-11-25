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

test('3. Dedup & Reconcile: keeps same-title different-ID playlists separate, preserves editions, reconciles removals & reorders', () => {
  const existing = [
    { id: 'VLPL_1', title: 'Chill', artist: 'User', type: 'Playlist', accountId: 'accA', sortMode: 'duration-desc', tracks: [{ id: 'v1', title: 'A', addedAt: 100 }, { id: 'v2', title: 'B', addedAt: 200 }] }
  ];
  const incoming = [
    { id: 'VLPL_1', title: 'Chill', artist: 'User', type: 'Playlist', accountId: 'accA', tracks: [{ id: 'v3', title: 'C' }, { id: 'v1', title: 'A' }] },
    { id: 'VLPL_2', title: 'Chill', artist: 'User', type: 'Playlist', accountId: 'accA', tracks: [{ id: 'v9', title: 'Z' }] }
  ];
  const merged = mergeSavedAlbumEntities(existing, incoming, 'accA');
  assert.strictEqual(merged.list.length, 2);
  assert.strictEqual(merged.list[0].sortMode, 'duration-desc');
  assert.deepStrictEqual(merged.list[0].tracks.map(t => t.id), ['v3', 'v1']);
  assert.strictEqual(merged.list[0].tracks[1].addedAt, 100);

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

  // Reconcile tracks
  const rec = reconcilePlaylistTracks([{ id: 'a' }, { id: 'b' }], [{ id: 'b' }, { id: 'c' }]);
  assert.deepStrictEqual(rec.tracks.map(t => t.id), ['b', 'c']);
  assert.strictEqual(rec.added, 1);
  assert.strictEqual(rec.removed, 1);
  assert.strictEqual(rec.reordered, true);
});

test('4. Background Sync Coordinator: single-flight join, account switch invalidation, HTTP 429 backoff, inactive skip', async () => {
  let activeAccount = 'acc1';
  let appActive = false;
  let calls = 0;
  let resolveCall;

  const coord = createLibrarySyncCoordinator({
    getActiveAccountId: () => activeAccount,
    isAppActive: () => appActive,
    baseBackoffMs: 1000,
    syncFn: () => {
      calls++;
      return new Promise(r => { resolveCall = r; });
    }
  });

  // Skips background sync when app inactive
  const skipped = await coord.runSync('background');
  assert.strictEqual(skipped.skipped, true);
  assert.strictEqual(calls, 0);

  // Manual sync joins active background sync (single-flight)
  appActive = true;
  const p1 = coord.runSync('background');
  const p2 = coord.runSync('manual');
  assert.strictEqual(calls, 1);
  assert.strictEqual(coord.getState().status, 'syncing');
  resolveCall({ success: true });
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.strictEqual(r1.success, true);
  assert.strictEqual(r2.success, true);
  assert.strictEqual(coord.getState().status, 'success');
  assert.ok(coord.getState().lastSync > 0);

  // Account switch during in-flight discards stale result
  const p3 = coord.runSync('manual');
  activeAccount = 'acc2';
  coord.invalidateAccount('account_switched');
  resolveCall({ success: true, stalePayload: true });
  const r3 = await p3;
  assert.strictEqual(r3.discarded, true);

  // HTTP 429 triggers backoff
  const p4 = coord.runSync('background');
  resolveCall({ success: false, status: 429, retryAfter: 60 });
  const r4 = await p4;
  assert.strictEqual(r4.rateLimited, true);
  assert.strictEqual(coord.getState().status, 'failed');
  const r5 = await coord.runSync('background');
  assert.strictEqual(r5.skipped, true);
  assert.strictEqual(r5.reason, 'backoff_active');
});
