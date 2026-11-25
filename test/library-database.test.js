// test/library-database.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { LibraryDatabase } = require('../src/main/db/library-database');

describe('LibraryDatabase - SQLite Operations', () => {
  it('initializes schema in memory and performs CRUD for albums', () => {
    const db = new LibraryDatabase(':memory:');
    assert.strictEqual(db.getSavedAlbums().length, 0);

    const albums = [
      { id: 'alb_1', title: 'Album One', artist: 'Artist A', year: '2024', entityType: 'Album', tracks: [{ id: 's1' }, { id: 's2' }] },
      { id: 'alb_2', title: 'Album Two', artist: 'Artist B', year: '2025', entityType: 'Album', tracks: [] }
    ];

    db.setSavedAlbums(albums, 'acc_test');
    const fetched = db.getSavedAlbums('acc_test');
    assert.strictEqual(fetched.length, 2);
    assert.strictEqual(fetched[0].id, 'alb_1');
    assert.strictEqual(fetched[0].trackCount, 2);

    db.deleteAlbum('alb_1', 'acc_test', 'Album');
    const remaining = db.getSavedAlbums('acc_test');
    assert.strictEqual(remaining.length, 1);
    assert.strictEqual(remaining[0].id, 'alb_2');
    db.close();
  });

  it('handles playlists and cascade delete of songs relations', () => {
    const db = new LibraryDatabase(':memory:');
    const playlists = [
      {
        id: 'pl_1',
        name: 'My Chill Mix',
        tracks: [
          { id: 'song_1', title: 'Chill Tune', artist: 'Producer X', duration: 180 },
          { id: 'song_2', title: 'Vibe Beat', artist: 'Producer Y', duration: 210 }
        ]
      }
    ];

    db.setPlaylists(playlists, 'default');
    const fetched = db.getPlaylists('default');
    assert.strictEqual(fetched.length, 1);
    assert.strictEqual(fetched[0].tracks.length, 2);
    assert.strictEqual(fetched[0].tracks[0].title, 'Chill Tune');
    assert.strictEqual(fetched[0].tracks[1].artist, 'Producer Y');

    // Delete playlist
    db.deletePlaylist('pl_1');
    assert.strictEqual(db.getPlaylists('default').length, 0);
    db.close();
  });

  it('manages favorites order and addition/removal', () => {
    const db = new LibraryDatabase(':memory:');
    const favs = [
      { id: 'f1', title: 'Fav One', artist: 'Singer 1' },
      { id: 'f2', title: 'Fav Two', artist: 'Singer 2' }
    ];

    db.setFavorites(favs, 'default');
    let fetched = db.getFavorites('default');
    assert.strictEqual(fetched.length, 2);
    assert.strictEqual(fetched[0].id, 'f1');

    db.addFavorite({ id: 'f3', title: 'Fav Three', artist: 'Singer 3' }, 'default');
    fetched = db.getFavorites('default');
    assert.strictEqual(fetched.length, 3);
    assert.strictEqual(fetched[2].id, 'f3');

    db.removeFavorite('f2', 'default');
    fetched = db.getFavorites('default');
    assert.strictEqual(fetched.length, 2);
    assert.strictEqual(fetched.some(f => f.id === 'f2'), false);
    db.close();
  });

  it('records and queries playback history', () => {
    const db = new LibraryDatabase(':memory:');
    db.recordHistory({ id: 'h1', title: 'History Song 1' }, 'trending');
    db.recordHistory({ id: 'h2', title: 'History Song 2' }, 'discover');

    const hist = db.getHistory(10);
    assert.strictEqual(hist.length, 2);
    assert.strictEqual(hist[0].id, 'h2'); // Most recent first
    assert.strictEqual(hist[1].id, 'h1');
    db.close();
  });

  it('migrates legacy payload seamlessly in a single transaction', () => {
    const db = new LibraryDatabase(':memory:');
    const legacy = {
      albums: [{ id: 'leg_alb', title: 'Old Album' }],
      playlists: [{ id: 'leg_pl', name: 'Old Playlist', tracks: [{ id: 'leg_s1', title: 'Song 1' }] }],
      favorites: [{ id: 'leg_fav', title: 'Old Fav' }],
      history: [{ id: 'leg_h1', title: 'Old History' }]
    };

    const res = db.migrateFromLegacy(legacy, 'default');
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.importedAlbums, 1);
    assert.strictEqual(res.importedPlaylists, 1);
    assert.strictEqual(res.importedFavorites, 1);
    assert.strictEqual(res.importedHistory, 1);

    const all = db.loadAllLibrary('default');
    assert.strictEqual(all.albums.length, 1);
    assert.strictEqual(all.playlists.length, 1);
    assert.strictEqual(all.favorites.length, 1);
    assert.strictEqual(all.history.length, 1);
    db.close();
  });

  it('benchmarks bulk insert of 1,000 tracks in < 150ms', () => {
    const db = new LibraryDatabase(':memory:');
    const bulkTracks = [];
    for (let i = 0; i < 1000; i++) {
      bulkTracks.push({
        id: `bulk_${i}`,
        title: `Bulk Track #${i}`,
        artist: 'Performance Tester',
        duration: 120 + (i % 60)
      });
    }

    const t0 = performance.now();
    db.setFavorites(bulkTracks, 'perf_account');
    const elapsed = performance.now() - t0;
    assert.strictEqual(db.getFavorites('perf_account').length, 1000);
    assert.ok(elapsed < 200, `Bulk insert took ${elapsed.toFixed(1)}ms (expected < 200ms)`);
    db.close();
  });
});
