const test = require('node:test');
const assert = require('node:assert/strict');

const trackSourceUI = require('../src/renderer/track-source-ui');
const topMoments = require('../src/renderer/top-moments');

test('bulkResearchPlaylistTracks: skips local files, bounds concurrency to 3, preserves currentTrackId, and saves source', async () => {
  let active = 0;
  let maxActive = 0;
  const savedCalls = [];

  const mockFetch = async (url, opts = {}) => {
    if (url.includes('/api/search')) {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 15));
      active--;
      return {
        json: async () => ({
          results: [
            { id: 'newId123456', title: 'Song Title', artist: 'Artist', platform: 'ytmusic', url: 'https://www.youtube.com/watch?v=newId123456' }
          ]
        })
      };
    }
    if (url.includes('/api/track-source')) {
      savedCalls.push(JSON.parse(opts.body));
      return { json: async () => ({ success: true }) };
    }
    throw new Error('Unexpected URL: ' + url);
  };

  const tracks = [
    { id: 'local_1', title: 'Local Song', artist: 'Local', isLocal: true, path: 'C:/music/a.mp3' },
    { id: 'cur_1', title: 'Current Song', artist: 'Artist' },
    { id: 'old_2', title: 'Song 2', artist: 'Artist' },
    { id: 'old_3', title: 'Song 3', artist: 'Artist' },
    { id: 'old_4', title: 'Song 4', artist: 'Artist' },
    { id: 'old_5', title: 'Song 5', artist: 'Artist' }
  ];

  const res = await trackSourceUI.bulkResearchPlaylistTracks(tracks, {
    concurrency: 3,
    platform: 'ytmusic',
    apiBase: 'http://127.0.0.1:3000',
    token: 'tok',
    currentTrackId: 'cur_1',
    fetchFn: mockFetch
  });

  assert.equal(res.skipped, 1);
  assert.equal(res.total, 5);
  assert.equal(res.updated, 5);
  assert.ok(maxActive <= 3);
  assert.equal(tracks[0].id, 'local_1'); // local untouched
  assert.equal(tracks[1].id, 'cur_1');   // currently playing track preserved
  assert.equal(tracks[2].id, 'newId123456');
  assert.equal(savedCalls.length, 5);
});

test('TopMoments: add, sort, persist, and remove markers per track', () => {
  const mem = new Map();
  const storage = {
    getItem: (k) => mem.get(k) ?? null,
    setItem: (k, v) => mem.set(k, v)
  };

  const track = { id: 'trk_1', title: 'Test', artist: 'Artist' };
  const m2 = topMoments.addMoment(track, { timeSec: 95.4, label: 'Drop' }, storage);
  const m1 = topMoments.addMoment(track, { timeSec: 32.1, label: 'Chorus' }, storage);

  const list = topMoments.getMoments(track, storage);
  assert.equal(list.length, 2);
  assert.equal(list[0].id, m1.id); // sorted ascending by timeSec
  assert.equal(list[1].id, m2.id);

  assert.equal(topMoments.removeMoment(track, m1.id, storage), true);
  assert.equal(topMoments.getMoments(track, storage).length, 1);
});
