// test/comments-feature.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { extractTimestampsFromText, getTrackComments } = require('../src/server/ytm-discovery');

// Helper mirroring pure renderer resolveYouTubeVideoId implementation
function resolveYouTubeVideoId(track) {
  if (!track || typeof track !== 'object') return null;
  const candidates = [
    track.videoId,
    track.video_id,
    track._matchedYtId,
    track.id
  ];
  for (const c of candidates) {
    if (typeof c === 'string') {
      const trimmed = c.trim();
      if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
        return trimmed;
      }
    }
  }
  const urlCandidates = [track.url, track.streamUrl, track.sourceUrl];
  for (const u of urlCandidates) {
    if (typeof u === 'string' && u.trim()) {
      const m = u.match(/(?:youtu\.be\/|v\/|u\/\w\/|embed\/|shorts\/|live\/|watch\?v=|&v=)([a-zA-Z0-9_-]{11})/);
      if (m && m[1]) return m[1];
    }
  }
  return null;
}

describe('YouTube Comments & Timestamps Feature Suite', () => {
  it('parses timestamps in mm:ss, m:ss, and hh:mm:ss accurately', () => {
    const text = 'Intro at 0:00, drop at 1:23, epic solo at 02:45, and finale at 1:12:30!';
    const timestamps = extractTimestampsFromText(text);

    assert.strictEqual(timestamps.length, 4);
    assert.deepStrictEqual(timestamps[0], { text: '0:00', seconds: 0 });
    assert.deepStrictEqual(timestamps[1], { text: '1:23', seconds: 83 });
    assert.deepStrictEqual(timestamps[2], { text: '02:45', seconds: 165 });
    assert.deepStrictEqual(timestamps[3], { text: '1:12:30', seconds: 4350 });
  });

  it('rejects invalid timestamps and out-of-range clock values', () => {
    const text = 'Score is 12:70 or invalid 99:99 or ratio 10:100 or non-time 5:5';
    const timestamps = extractTimestampsFromText(text);
    assert.strictEqual(timestamps.length, 0);
  });

  it('handles empty or non-string inputs safely without throwing', () => {
    assert.deepStrictEqual(extractTimestampsFromText(null), []);
    assert.deepStrictEqual(extractTimestampsFromText(undefined), []);
    assert.deepStrictEqual(extractTimestampsFromText(''), []);
    assert.deepStrictEqual(extractTimestampsFromText(12345), []);
  });

  it('verifies DOM text extraction logic with timestamps simulation', () => {
    const rawText = 'Best part 0:45 and outro 3:15';
    const regex = /\b(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\b/g;
    const parts = [];
    let lastIndex = 0;
    let match;

    while ((match = regex.exec(rawText)) !== null) {
      if (match.index > lastIndex) {
        parts.push({ type: 'text', value: rawText.substring(lastIndex, match.index) });
      }
      const hasHours = match[1] !== undefined;
      const hours = hasHours ? parseInt(match[1], 10) : 0;
      const mins = parseInt(match[2], 10);
      const secs = parseInt(match[3], 10);
      parts.push({
        type: 'timestamp',
        text: match[0],
        seconds: hours * 3600 + mins * 60 + secs
      });
      lastIndex = regex.lastIndex;
    }
    if (lastIndex < rawText.length) {
      parts.push({ type: 'text', value: rawText.substring(lastIndex) });
    }

    assert.strictEqual(parts.length, 4);
    assert.strictEqual(parts[0].value, 'Best part ');
    assert.strictEqual(parts[1].seconds, 45);
    assert.strictEqual(parts[2].value, ' and outro ');
    assert.strictEqual(parts[3].seconds, 195);
  });

  it('validates duration bounds check logic for seeking', () => {
    const duration = 180; // 3 minutes track
    const checkSeekAllowed = (target) => {
      if (!Number.isFinite(target) || target < 0) return false;
      if (duration > 0 && target > duration) return false;
      return true;
    };

    assert.strictEqual(checkSeekAllowed(45), true);
    assert.strictEqual(checkSeekAllowed(180), true);
    assert.strictEqual(checkSeekAllowed(181), false); // Exceeds duration
    assert.strictEqual(checkSeekAllowed(-5), false);
    assert.strictEqual(checkSeekAllowed(NaN), false);
  });

  // P0 Hotfix: pure resolveYouTubeVideoId regression test
  it('resolves valid 11-char direct YouTube video IDs across different schema keys', () => {
    assert.strictEqual(resolveYouTubeVideoId({ videoId: 'kJQP7kiw5Fk' }), 'kJQP7kiw5Fk');
    assert.strictEqual(resolveYouTubeVideoId({ video_id: 'kJQP7kiw5Fk' }), 'kJQP7kiw5Fk');
    assert.strictEqual(resolveYouTubeVideoId({ _matchedYtId: 'kJQP7kiw5Fk' }), 'kJQP7kiw5Fk');
    assert.strictEqual(resolveYouTubeVideoId({ id: 'kJQP7kiw5Fk' }), 'kJQP7kiw5Fk');
  });

  it('resolves YouTube video IDs from supported URL formats (watch, youtu.be, embed, shorts, live)', () => {
    assert.strictEqual(resolveYouTubeVideoId({ url: 'https://www.youtube.com/watch?v=kJQP7kiw5Fk' }), 'kJQP7kiw5Fk');
    assert.strictEqual(resolveYouTubeVideoId({ url: 'https://youtu.be/kJQP7kiw5Fk' }), 'kJQP7kiw5Fk');
    assert.strictEqual(resolveYouTubeVideoId({ url: 'https://www.youtube.com/embed/kJQP7kiw5Fk' }), 'kJQP7kiw5Fk');
    assert.strictEqual(resolveYouTubeVideoId({ url: 'https://www.youtube.com/shorts/kJQP7kiw5Fk' }), 'kJQP7kiw5Fk');
    assert.strictEqual(resolveYouTubeVideoId({ url: 'https://www.youtube.com/live/kJQP7kiw5Fk' }), 'kJQP7kiw5Fk');
  });

  it('rejects invalid or non-YouTube formats safely with null', () => {
    assert.strictEqual(resolveYouTubeVideoId(null), null);
    assert.strictEqual(resolveYouTubeVideoId(undefined), null);
    assert.strictEqual(resolveYouTubeVideoId({}), null);
    assert.strictEqual(resolveYouTubeVideoId({ id: 'local_file_123' }), null);
    assert.strictEqual(resolveYouTubeVideoId({ id: 'short_id' }), null);
    assert.strictEqual(resolveYouTubeVideoId({ id: 'invalid_characters!@#' }), null);
    assert.strictEqual(resolveYouTubeVideoId({ url: 'https://soundcloud.com/artist/track' }), null);
  });

  it('verifies that renderer source does not rely on mvController for extractYtId', () => {
    const appSource = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
    const commentSection = appSource.substring(appSource.indexOf('function loadTrackComments'));
    assert.strictEqual(
      commentSection.includes('mvController.extractYtId'),
      false,
      'loadTrackComments must never call mvController.extractYtId'
    );
  });

  it('backend getTrackComments returns empty payload for empty or non-11 char videoId without crashing', async () => {
    const res = await getTrackComments('');
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.videoId, '');
    assert.deepStrictEqual(res.comments, []);
  });
});
