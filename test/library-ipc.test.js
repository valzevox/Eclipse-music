// test/library-ipc.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { LibraryDatabase } = require('../src/main/db/library-database');

describe('LibraryDatabase - Main IPC & Migration Integration', () => {
  it('simulates main process IPC handlers flow', async () => {
    const db = new LibraryDatabase(':memory:');

    // 1. Simulate migration from legacy localStorage snapshot
    const legacyDump = {
      albums: [
        { id: 'alb_legacy_1', title: 'Classic Album', artist: 'Classic Artist', year: '1999', entityType: 'Album' }
      ],
      playlists: [
        {
          id: 'pl_legacy_1',
          name: 'Golden Hits',
          tracks: [
            { id: 'gh_1', title: 'Song One', artist: 'Artist One', duration: 200 }
          ]
        }
      ],
      favorites: [
        { id: 'fav_legacy_1', title: 'Loved Track', artist: 'Loved Singer' }
      ],
      history: [
        { id: 'hist_legacy_1', title: 'Yesterday Song' }
      ]
    };

    const migResult = db.migrateFromLegacy(legacyDump, 'default');
    assert.strictEqual(migResult.success, true);
    assert.strictEqual(migResult.importedAlbums, 1);
    assert.strictEqual(migResult.importedPlaylists, 1);
    assert.strictEqual(migResult.importedFavorites, 1);
    assert.strictEqual(migResult.importedHistory, 1);

    // 2. Load all back as frontend does on startup
    const loaded = db.loadAllLibrary('default');
    assert.strictEqual(loaded.albums.length, 1);
    assert.strictEqual(loaded.albums[0].title, 'Classic Album');
    assert.strictEqual(loaded.playlists.length, 1);
    assert.strictEqual(loaded.playlists[0].tracks.length, 1);
    assert.strictEqual(loaded.favorites.length, 1);
    assert.strictEqual(loaded.favorites[0].title, 'Loved Track');
    assert.strictEqual(loaded.history.length, 1);

    // 3. Update playlists from frontend setItem
    const updatedPlaylists = [
      ...loaded.playlists,
      {
        id: 'pl_new_2',
        name: 'Fresh Playlist',
        tracks: [{ id: 'fresh_1', title: 'Fresh Sound', artist: 'New Wave' }]
      }
    ];
    db.setPlaylists(updatedPlaylists, 'default');
    const playlistsAfter = db.getPlaylists('default');
    assert.strictEqual(playlistsAfter.length, 2);

    // 4. Update favorites
    db.addFavorite({ id: 'fav_new_2', title: 'Second Favorite' }, 'default');
    const favsAfter = db.getFavorites('default');
    assert.strictEqual(favsAfter.length, 2);

    // 5. Delete album
    db.deleteAlbum('alb_legacy_1', 'default', 'Album');
    assert.strictEqual(db.getSavedAlbums('default').length, 0);

    db.close();
  });
});
