const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const LyricsCardGenerator = require('../src/renderer/lyrics-card.js');

describe('Fullscreen Lyrics & Karaoke Parity Unit Tests', () => {
  test('P0 & P1: LyricsCardGenerator exports valid SVG markup with escapeXml', () => {
    const svg = LyricsCardGenerator.generateSvgCard({
      lines: ['Hello <world>', 'Eclipse & "Music"'],
      title: 'Track <1>',
      artist: 'Artist & Co'
    });

    assert.ok(svg.includes('<svg'), 'SVG tag must exist');
    assert.ok(svg.includes('Hello &lt;world&gt;'), 'HTML tags must be escaped in lyrics');
    assert.ok(svg.includes('Eclipse &amp; &quot;Music&quot;'), 'Quotes and ampersands must be escaped');
    assert.ok(svg.includes('Track &lt;1&gt;'), 'Title must be escaped');
    assert.ok(svg.includes('Artist &amp; Co'), 'Artist must be escaped');
    assert.ok(svg.includes('ECLIPSE MUSIC'), 'Header branding must exist');
  });

  test('P1: LyricsCardGenerator text wrapping works predictably', () => {
    const mockCtx = {
      measureText: (str) => ({ width: str.length * 10 })
    };
    const wrapped = LyricsCardGenerator.wrapText(mockCtx, 'One two three four five six', 120);
    assert.ok(Array.isArray(wrapped), 'Must return array of wrapped lines');
    assert.ok(wrapped.length > 1, 'Long text should wrap into multiple lines');
    assert.strictEqual(wrapped.join(' '), 'One two three four five six');
  });

  test('P0 & P2: HTML elements exist for TVK Offset, Zen Mode, and PiP Mini Player', () => {
    const html = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');

    // P0: TVK Offset capsule
    assert.ok(html.includes('id="tvk-offset-control"'), 'tvk-offset-control must exist in index.html');
    assert.ok(html.includes('id="btn-tvk-offset-toggle"'), 'btn-tvk-offset-toggle must exist in index.html');
    assert.ok(html.includes('id="btn-tvk-offset-minus"'), 'btn-tvk-offset-minus must exist in index.html');
    assert.ok(html.includes('id="btn-tvk-offset-badge"'), 'btn-tvk-offset-badge must exist in index.html');
    assert.ok(html.includes('id="btn-tvk-offset-plus"'), 'btn-tvk-offset-plus must exist in index.html');

    // P1: Share Lyrics
    assert.ok(html.includes('id="btn-share-lyrics"'), 'btn-share-lyrics must exist in index.html');
    assert.ok(html.includes('id="share-lyrics-modal"'), 'share-lyrics-modal must exist in index.html');
    assert.ok(html.includes('id="share-lyrics-canvas"'), 'share-lyrics-canvas must exist in index.html');

    // P2: Zen Mode & Auto-Zen
    assert.ok(html.includes('id="btn-tvk-zen"'), 'btn-tvk-zen must exist in index.html');
    assert.ok(html.includes('id="btn-tvk-auto-zen"'), 'btn-tvk-auto-zen must exist in index.html');

    // P3: TVK PiP toggle
    assert.ok(html.includes('id="btn-tvk-pip"'), 'btn-tvk-pip must exist in index.html');
  });

  test('P3: Floating Lyrics mini player HTML includes thumbnail, seekbar, fav, and mute', () => {
    const miniHtml = fs.readFileSync(path.join(__dirname, '../src/renderer/floating-lyrics.html'), 'utf8');

    assert.ok(miniHtml.includes('id="mini-cover"'), 'mini-cover img must exist in floating-lyrics.html');
    assert.ok(miniHtml.includes('id="mini-seek-bar"'), 'mini-seek-bar slider must exist in floating-lyrics.html');
    assert.ok(miniHtml.includes('id="btn-fav"'), 'btn-fav button must exist in floating-lyrics.html');
    assert.ok(miniHtml.includes('id="btn-mute"'), 'btn-mute button must exist in floating-lyrics.html');
    assert.ok(miniHtml.includes('seek-percent'), 'seek-percent command must be wired');
  });

  test('P3: Floating Lyrics mini player supports Square layout and Keyboard Shortcuts', () => {
    const miniHtml = fs.readFileSync(path.join(__dirname, '../src/renderer/floating-lyrics.html'), 'utf8');

    assert.ok(miniHtml.includes('square-mode'), 'square-mode CSS and DOM support must exist');
    assert.ok(miniHtml.includes('mini-track-meta'), 'mini-track-meta must exist for square mode');
    assert.ok(miniHtml.includes('mini-track-title'), 'mini-track-title must exist for square mode');
    assert.ok(miniHtml.includes('mini-track-artist'), 'mini-track-artist must exist for square mode');
    assert.ok(miniHtml.includes("e.code === 'Space'"), 'Space key shortcut must be wired');
    assert.ok(miniHtml.includes("e.code === 'ArrowLeft'"), 'ArrowLeft key shortcut must be wired');
    assert.ok(miniHtml.includes("e.code === 'ArrowRight'"), 'ArrowRight key shortcut must be wired');
    assert.ok(miniHtml.includes('aspectRatio <= 1.35'), 'aspect ratio threshold must evaluate square mode');
  });

  test('P3: Main process implements separate mini player bounds persistence', () => {
    const mainJs = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');

    assert.ok(mainJs.includes('mini-player-state.json'), 'Must use dedicated mini-player-state.json');
    assert.ok(mainJs.includes('loadMiniPlayerBounds'), 'loadMiniPlayerBounds must exist');
    assert.ok(mainJs.includes('saveMiniPlayerBounds'), 'saveMiniPlayerBounds must exist');
    assert.ok(mainJs.includes('screen.getAllDisplays()'), 'Must validate bounds against active displays');
  });

  test('P0-P3: CSS contains styles for TVK offset, zen mode, share lyrics modal, and mini player', () => {
    const css = fs.readFileSync(path.join(__dirname, '../src/renderer/styles.css'), 'utf8');

    assert.ok(css.includes('.tvk-offset-control'), 'tvk-offset-control CSS rule must exist');
    assert.ok(css.includes('.tvk-zen-mode'), 'tvk-zen-mode CSS rule must exist');
    assert.ok(css.includes('.share-lyrics-modal-card'), 'share-lyrics-modal-card CSS rule must exist');
    assert.ok(css.includes('.tvk-top-actions'), 'tvk-top-actions CSS rule must exist');
  });
});
