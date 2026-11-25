// src/main/db/library-database.js
// Eclipse SQLite Library Database Repository (zero native dependency via node:sqlite)

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

class LibraryDatabase {
  constructor(dbPath = ':memory:') {
    this.dbPath = dbPath;
    if (this.dbPath !== ':memory:') {
      const dir = path.dirname(this.dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
    this.db = new DatabaseSync(this.dbPath);
    this._initPragmas();
    this._initSchema();
    this._prepareStatements();
  }

  _initPragmas() {
    try {
      this.db.exec('PRAGMA foreign_keys = ON;');
      if (this.dbPath !== ':memory:') {
        this.db.exec('PRAGMA journal_mode = WAL;');
        this.db.exec('PRAGMA synchronous = NORMAL;');
      }
    } catch (e) {
      console.warn('[LibraryDatabase] Pragma init warning:', e.message);
    }
  }

  _initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS songs (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        artist TEXT,
        duration INTEGER DEFAULT 0,
        cover TEXT,
        platform TEXT DEFAULT 'ytmusic',
        album_id TEXT,
        album_title TEXT,
        raw_json TEXT,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS albums (
        id TEXT NOT NULL,
        account_id TEXT NOT NULL DEFAULT 'default',
        entity_type TEXT NOT NULL DEFAULT 'Album',
        title TEXT NOT NULL,
        artist TEXT,
        cover TEXT,
        year TEXT,
        platform TEXT DEFAULT 'ytmusic',
        track_count INTEGER DEFAULT 0,
        duration INTEGER DEFAULT 0,
        fetch_meta TEXT,
        added_at INTEGER NOT NULL,
        PRIMARY KEY (id, account_id, entity_type)
      );
      CREATE INDEX IF NOT EXISTS idx_albums_account ON albums(account_id);

      CREATE TABLE IF NOT EXISTS playlists (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL DEFAULT 'default',
        name TEXT NOT NULL,
        cover TEXT,
        yt_id TEXT,
        is_favorite_collection INTEGER DEFAULT 0,
        added_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_playlists_account ON playlists(account_id);

      CREATE TABLE IF NOT EXISTS playlist_songs (
        playlist_id TEXT NOT NULL,
        song_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        added_at INTEGER NOT NULL,
        PRIMARY KEY (playlist_id, position),
        FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
        FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_playlist_songs_lookup ON playlist_songs(playlist_id, song_id);

      CREATE TABLE IF NOT EXISTS favorites (
        account_id TEXT NOT NULL DEFAULT 'default',
        song_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        added_at INTEGER NOT NULL,
        PRIMARY KEY (account_id, song_id),
        FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_favorites_account ON favorites(account_id, position);

      CREATE TABLE IF NOT EXISTS playback_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        song_id TEXT NOT NULL,
        played_at INTEGER NOT NULL,
        context_source TEXT,
        FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_history_played ON playback_history(played_at DESC, id DESC);
    `);
  }

  _prepareStatements() {
    this.stmtUpsertSong = this.db.prepare(`
      INSERT INTO songs (id, title, artist, duration, cover, platform, album_id, album_title, raw_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        artist = excluded.artist,
        duration = CASE WHEN excluded.duration > 0 THEN excluded.duration ELSE songs.duration END,
        cover = CASE WHEN excluded.cover IS NOT NULL AND excluded.cover != '' THEN excluded.cover ELSE songs.cover END,
        platform = excluded.platform,
        album_id = CASE WHEN excluded.album_id IS NOT NULL THEN excluded.album_id ELSE songs.album_id END,
        album_title = CASE WHEN excluded.album_title IS NOT NULL THEN excluded.album_title ELSE songs.album_title END,
        raw_json = excluded.raw_json,
        updated_at = excluded.updated_at
    `);

    this.stmtUpsertAlbum = this.db.prepare(`
      INSERT INTO albums (id, account_id, entity_type, title, artist, cover, year, platform, track_count, duration, fetch_meta, added_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id, account_id, entity_type) DO UPDATE SET
        title = excluded.title,
        artist = excluded.artist,
        cover = excluded.cover,
        year = excluded.year,
        platform = excluded.platform,
        track_count = excluded.track_count,
        duration = excluded.duration,
        fetch_meta = excluded.fetch_meta,
        added_at = excluded.added_at
    `);

    this.stmtDeleteAlbum = this.db.prepare(`
      DELETE FROM albums WHERE id = ? AND account_id = ? AND entity_type = ?
    `);

    this.stmtGetAlbums = this.db.prepare(`
      SELECT * FROM albums WHERE account_id = ? ORDER BY added_at DESC
    `);

    this.stmtGetAllAlbums = this.db.prepare(`
      SELECT * FROM albums ORDER BY added_at DESC
    `);

    this.stmtUpsertPlaylist = this.db.prepare(`
      INSERT INTO playlists (id, account_id, name, cover, yt_id, is_favorite_collection, added_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        cover = excluded.cover,
        yt_id = excluded.yt_id,
        is_favorite_collection = excluded.is_favorite_collection,
        updated_at = excluded.updated_at
    `);

    this.stmtDeletePlaylist = this.db.prepare(`
      DELETE FROM playlists WHERE id = ?
    `);

    this.stmtGetPlaylists = this.db.prepare(`
      SELECT * FROM playlists WHERE account_id = ? ORDER BY updated_at DESC
    `);

    this.stmtGetAllPlaylists = this.db.prepare(`
      SELECT * FROM playlists ORDER BY updated_at DESC
    `);

    this.stmtClearPlaylistSongs = this.db.prepare(`
      DELETE FROM playlist_songs WHERE playlist_id = ?
    `);

    this.stmtInsertPlaylistSong = this.db.prepare(`
      INSERT INTO playlist_songs (playlist_id, song_id, position, added_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(playlist_id, position) DO UPDATE SET
        song_id = excluded.song_id,
        added_at = excluded.added_at
    `);

    this.stmtGetPlaylistTracks = this.db.prepare(`
      SELECT s.id, s.title, s.artist, s.duration, s.cover, s.platform, s.album_id, s.album_title, s.raw_json, ps.added_at, ps.position
      FROM playlist_songs ps
      JOIN songs s ON ps.song_id = s.id
      WHERE ps.playlist_id = ?
      ORDER BY ps.position ASC
    `);

    this.stmtUpsertFavorite = this.db.prepare(`
      INSERT INTO favorites (account_id, song_id, position, added_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(account_id, song_id) DO UPDATE SET
        position = excluded.position,
        added_at = excluded.added_at
    `);

    this.stmtDeleteFavorite = this.db.prepare(`
      DELETE FROM favorites WHERE account_id = ? AND song_id = ?
    `);

    this.stmtGetFavorites = this.db.prepare(`
      SELECT s.id, s.title, s.artist, s.duration, s.cover, s.platform, s.album_id, s.album_title, s.raw_json, f.added_at, f.position
      FROM favorites f
      JOIN songs s ON f.song_id = s.id
      WHERE f.account_id = ?
      ORDER BY f.position ASC
    `);

    this.stmtInsertHistory = this.db.prepare(`
      INSERT INTO playback_history (song_id, played_at, context_source)
      VALUES (?, ?, ?)
    `);

    this.stmtGetHistory = this.db.prepare(`
      SELECT s.id, s.title, s.artist, s.duration, s.cover, s.platform, s.album_id, s.album_title, s.raw_json, h.played_at, h.context_source
      FROM playback_history h
      JOIN songs s ON h.song_id = s.id
      ORDER BY h.played_at DESC, h.id DESC
      LIMIT ?
    `);
  }

  _sanitizeTrack(track) {
    if (!track || typeof track !== 'object') return null;
    const id = String(track.id || track.videoId || '').trim();
    if (!id) return null;

    const title = String(track.title || 'Unknown Title').trim();
    const artist = String(track.artist || track.author || '').trim();
    const duration = typeof track.duration === 'number' ? track.duration : parseInt(track.duration || 0, 10) || 0;
    const cover = String(track.thumbnail || track.cover || '').trim();
    const platform = String(track.platform || 'ytmusic').trim();
    const album_id = track.album_id || track.albumId || null;
    const album_title = track.album_title || track.albumTitle || track.album || null;

    let raw_json = null;
    try {
      raw_json = JSON.stringify(track);
    } catch (_) {}

    return {
      id,
      title,
      artist,
      duration,
      cover,
      platform,
      album_id: album_id ? String(album_id) : null,
      album_title: album_title ? String(album_title) : null,
      raw_json,
      updated_at: Date.now()
    };
  }

  upsertSong(track) {
    const s = this._sanitizeTrack(track);
    if (!s) return false;
    this.stmtUpsertSong.run(
      s.id,
      s.title,
      s.artist,
      s.duration,
      s.cover,
      s.platform,
      s.album_id,
      s.album_title,
      s.raw_json,
      s.updated_at
    );
    return true;
  }

  // --- ALBUMS ---
  getSavedAlbums(accountId = null) {
    const rows = accountId ? this.stmtGetAlbums.all(String(accountId)) : this.stmtGetAllAlbums.all();
    return rows.map(r => {
      let meta = null;
      if (r.fetch_meta) {
        try { meta = JSON.parse(r.fetch_meta); } catch (_) {}
      }
      return {
        id: r.id,
        accountId: r.account_id,
        entityType: r.entity_type,
        title: r.title,
        artist: r.artist || '',
        cover: r.cover || '',
        year: r.year || '',
        platform: r.platform || 'ytmusic',
        trackCount: r.track_count || 0,
        duration: r.duration || 0,
        fetchMeta: meta,
        addedAt: r.added_at
      };
    });
  }

  setSavedAlbums(albums, accountId = 'default') {
    if (!Array.isArray(albums)) return false;
    const now = Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const a of albums) {
        if (!a || !a.id) continue;
        const id = String(a.id);
        const accId = String(a.accountId || accountId || 'default');
        const entityType = String(a.entityType || 'Album');
        const title = String(a.title || 'Untitled');
        const artist = String(a.artist || '');
        const cover = String(a.cover || a.thumbnail || '');
        const year = String(a.year || '');
        const platform = String(a.platform || 'ytmusic');
        const trackCount = typeof a.trackCount === 'number' ? a.trackCount : (Array.isArray(a.tracks) ? a.tracks.length : 0);
        const duration = typeof a.duration === 'number' ? a.duration : 0;
        const fetchMeta = a.fetchMeta ? JSON.stringify(a.fetchMeta) : (a.fetch_meta ? JSON.stringify(a.fetch_meta) : null);
        const addedAt = typeof a.addedAt === 'number' ? a.addedAt : (typeof a.added_at === 'number' ? a.added_at : now);

        this.stmtUpsertAlbum.run(
          id,
          accId,
          entityType,
          title,
          artist,
          cover,
          year,
          platform,
          trackCount,
          duration,
          fetchMeta,
          addedAt
        );
      }
      this.db.exec('COMMIT');
      return true;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  deleteAlbum(id, accountId = 'default', entityType = 'Album') {
    this.stmtDeleteAlbum.run(String(id), String(accountId), String(entityType));
    return true;
  }

  // --- PLAYLISTS ---
  getPlaylists(accountId = null) {
    const rows = accountId ? this.stmtGetPlaylists.all(String(accountId)) : this.stmtGetAllPlaylists.all();
    return rows.map(pl => {
      const trackRows = this.stmtGetPlaylistTracks.all(pl.id);
      const tracks = trackRows.map(tr => {
        let parsed = null;
        if (tr.raw_json) {
          try { parsed = JSON.parse(tr.raw_json); } catch (_) {}
        }
        return {
          id: tr.id,
          title: tr.title,
          artist: tr.artist || '',
          duration: tr.duration || 0,
          thumbnail: tr.cover || '',
          platform: tr.platform || 'ytmusic',
          addedAt: tr.added_at,
          ...(parsed || {})
        };
      });

      return {
        id: pl.id,
        accountId: pl.account_id,
        name: pl.name,
        cover: pl.cover || '',
        ytId: pl.yt_id || null,
        isFavoriteCollection: !!pl.is_favorite_collection,
        addedAt: pl.added_at,
        updatedAt: pl.updated_at,
        tracks
      };
    });
  }

  setPlaylists(playlists, accountId = 'default') {
    if (!Array.isArray(playlists)) return false;
    const now = Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const pl of playlists) {
        if (!pl || !pl.id) continue;
        const id = String(pl.id);
        const accId = String(pl.accountId || accountId || 'default');
        const name = String(pl.name || 'Untitled Playlist');
        const cover = String(pl.cover || pl.thumbnail || '');
        const ytId = pl.ytId ? String(pl.ytId) : (pl.yt_id ? String(pl.yt_id) : null);
        const isFav = pl.isFavoriteCollection ? 1 : 0;
        const addedAt = typeof pl.addedAt === 'number' ? pl.addedAt : now;
        const updatedAt = typeof pl.updatedAt === 'number' ? pl.updatedAt : now;

        this.stmtUpsertPlaylist.run(id, accId, name, cover, ytId, isFav, addedAt, updatedAt);

        if (Array.isArray(pl.tracks)) {
          this.stmtClearPlaylistSongs.run(id);
          let pos = 0;
          for (const track of pl.tracks) {
            const s = this._sanitizeTrack(track);
            if (!s) continue;
            this.stmtUpsertSong.run(
              s.id,
              s.title,
              s.artist,
              s.duration,
              s.cover,
              s.platform,
              s.album_id,
              s.album_title,
              s.raw_json,
              s.updated_at
            );
            const trackAddedAt = typeof track.addedAt === 'number' ? track.addedAt : now;
            this.stmtInsertPlaylistSong.run(id, s.id, pos++, trackAddedAt);
          }
        }
      }
      this.db.exec('COMMIT');
      return true;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  deletePlaylist(id) {
    this.stmtDeletePlaylist.run(String(id));
    return true;
  }

  // --- FAVORITES ---
  getFavorites(accountId = 'default') {
    const rows = this.stmtGetFavorites.all(String(accountId || 'default'));
    return rows.map(r => {
      let parsed = null;
      if (r.raw_json) {
        try { parsed = JSON.parse(r.raw_json); } catch (_) {}
      }
      return {
        id: r.id,
        title: r.title,
        artist: r.artist || '',
        duration: r.duration || 0,
        thumbnail: r.cover || '',
        platform: r.platform || 'ytmusic',
        addedAt: r.added_at,
        ...(parsed || {})
      };
    });
  }

  setFavorites(tracks, accountId = 'default') {
    if (!Array.isArray(tracks)) return false;
    const now = Date.now();
    const accId = String(accountId || 'default');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM favorites WHERE account_id = ?').run(accId);
      let pos = 0;
      for (const track of tracks) {
        const s = this._sanitizeTrack(track);
        if (!s) continue;
        this.stmtUpsertSong.run(
          s.id,
          s.title,
          s.artist,
          s.duration,
          s.cover,
          s.platform,
          s.album_id,
          s.album_title,
          s.raw_json,
          s.updated_at
        );
        const trackAddedAt = typeof track.addedAt === 'number' ? track.addedAt : now;
        this.stmtUpsertFavorite.run(accId, s.id, pos++, trackAddedAt);
      }
      this.db.exec('COMMIT');
      return true;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  addFavorite(track, accountId = 'default') {
    const s = this._sanitizeTrack(track);
    if (!s) return false;
    const accId = String(accountId || 'default');
    const now = Date.now();

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.stmtUpsertSong.run(
        s.id,
        s.title,
        s.artist,
        s.duration,
        s.cover,
        s.platform,
        s.album_id,
        s.album_title,
        s.raw_json,
        s.updated_at
      );
      const countRow = this.db.prepare('SELECT COUNT(*) as count FROM favorites WHERE account_id = ?').get(accId);
      const pos = (countRow && countRow.count) ? countRow.count : 0;
      this.stmtUpsertFavorite.run(accId, s.id, pos, now);
      this.db.exec('COMMIT');
      return true;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  removeFavorite(trackId, accountId = 'default') {
    const id = String(trackId || '').trim();
    if (!id) return false;
    const accId = String(accountId || 'default');
    this.stmtDeleteFavorite.run(accId, id);
    return true;
  }

  // --- HISTORY ---
  getHistory(limit = 100) {
    const rows = this.stmtGetHistory.all(Math.max(1, parseInt(limit, 10) || 50));
    return rows.map(r => {
      let parsed = null;
      if (r.raw_json) {
        try { parsed = JSON.parse(r.raw_json); } catch (_) {}
      }
      return {
        id: r.id,
        title: r.title,
        artist: r.artist || '',
        duration: r.duration || 0,
        thumbnail: r.cover || '',
        platform: r.platform || 'ytmusic',
        playedAt: r.played_at,
        contextSource: r.context_source || null,
        ...(parsed || {})
      };
    });
  }

  recordHistory(track, source = null) {
    const s = this._sanitizeTrack(track);
    if (!s) return false;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.stmtUpsertSong.run(
        s.id,
        s.title,
        s.artist,
        s.duration,
        s.cover,
        s.platform,
        s.album_id,
        s.album_title,
        s.raw_json,
        s.updated_at
      );
      this.stmtInsertHistory.run(s.id, Date.now(), source ? String(source) : null);
      this.db.exec('COMMIT');
      return true;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // --- COMPREHENSIVE LOAD ALL ---
  loadAllLibrary(accountId = 'default') {
    return {
      albums: this.getSavedAlbums(accountId),
      playlists: this.getPlaylists(accountId),
      favorites: this.getFavorites(accountId),
      history: this.getHistory(100)
    };
  }

  // --- MIGRATION FROM LEGACY PAYLOAD ---
  migrateFromLegacy(payload, accountId = 'default') {
    if (!payload || typeof payload !== 'object') return { success: false, error: 'Invalid payload' };
    let importedAlbums = 0;
    let importedPlaylists = 0;
    let importedFavorites = 0;
    let importedHistory = 0;

    if (Array.isArray(payload.albums) && payload.albums.length > 0) {
      this.setSavedAlbums(payload.albums, accountId);
      importedAlbums = payload.albums.length;
    }
    if (Array.isArray(payload.playlists) && payload.playlists.length > 0) {
      this.setPlaylists(payload.playlists, accountId);
      importedPlaylists = payload.playlists.length;
    }
    if (Array.isArray(payload.favorites) && payload.favorites.length > 0) {
      this.setFavorites(payload.favorites, accountId);
      importedFavorites = payload.favorites.length;
    }
    if (Array.isArray(payload.history) && payload.history.length > 0) {
      for (const t of payload.history) {
        if (t && t.id) {
          this.recordHistory(t, 'legacy_import');
          importedHistory++;
        }
      }
    }

    return {
      success: true,
      importedAlbums,
      importedPlaylists,
      importedFavorites,
      importedHistory
    };
  }

  close() {
    try {
      this.db.close();
    } catch (_) {}
  }
}

module.exports = { LibraryDatabase };
