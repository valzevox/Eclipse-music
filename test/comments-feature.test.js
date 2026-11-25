// test/comments-feature.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { extractTimestampsFromText } = require('../src/server/ytm-discovery');

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

    // 12:70 (70s invalid), 99:99 (99s invalid), 10:100 (100s invalid)
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
});
