// JavaScript / synced-lyrics-editor.js / LRC Parser, Serializer & Tap-to-Sync State Machine
// Part of Eclipse Music Player — MIT License

class SyncedLyricsEditor {
  constructor(options = {}) {
    this.lines = []; // Array of { timeMs: number, timeStr: string, text: string }
    this.currentLineIndex = 0;
    this.isSyncing = false;
    this.audioElement = options.audioElement || null;
    this.onLineChange = options.onLineChange || null;
  }

  /**
   * Parse standard LRC text into timecoded line objects
   */
  parseLrc(lrcText = '') {
    const rawLines = String(lrcText || '').split(/\r?\n/);
    const parsed = [];

    const lrcRegex = /^\[(\d{2}):(\d{2})\.?(\d{2,3})?\](.*)$/;

    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i].trim();
      if (!line) continue;

      const match = line.match(lrcRegex);
      if (match) {
        const mins = parseInt(match[1], 10);
        const secs = parseInt(match[2], 10);
        const msRaw = match[3] || '00';
        const ms = parseInt(msRaw.padEnd(3, '0').slice(0, 3), 10);
        const timeMs = mins * 60 * 1000 + secs * 1000 + ms;
        const text = match[4].trim();

        parsed.push({
          id: i,
          timeMs,
          timeStr: `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(Math.floor(ms / 10)).padStart(2, '0')}`,
          text
        });
      } else if (!line.startsWith('[ti:') && !line.startsWith('[ar:') && !line.startsWith('[al:')) {
        // Plain text line without timestamp
        parsed.push({
          id: i,
          timeMs: null,
          timeStr: '--:--.--',
          text: line
        });
      }
    }

    this.lines = parsed;
    this.currentLineIndex = 0;
    return this.lines;
  }

  /**
   * Format milliseconds into [mm:ss.xx]
   */
  formatTime(ms) {
    if (ms === null || ms === undefined || isNaN(ms)) return '--:--.--';
    const totalSecs = Math.max(0, ms / 1000);
    const mins = Math.floor(totalSecs / 60);
    const secs = Math.floor(totalSecs % 60);
    const centis = Math.floor((totalSecs % 1) * 100);
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(centis).padStart(2, '0')}`;
  }

  /**
   * Export structured lines to standard .lrc file string
   */
  exportLrc(metadata = {}) {
    const headerLines = [];
    if (metadata.title) headerLines.push(`[ti:${metadata.title}]`);
    if (metadata.artist) headerLines.push(`[ar:${metadata.artist}]`);
    if (metadata.album) headerLines.push(`[al:${metadata.album}]`);
    headerLines.push('[by:Eclipse Synced Lyrics Editor]');

    const contentLines = this.lines.map(line => {
      const tag = line.timeMs !== null ? `[${this.formatTime(line.timeMs)}]` : '[00:00.00]';
      return `${tag} ${line.text}`;
    });

    return [...headerLines, ...contentLines].join('\n');
  }

  /**
   * Start Tap-to-Sync session
   */
  startTapSync(audio) {
    if (audio) this.audioElement = audio;
    this.isSyncing = true;
    this.currentLineIndex = 0;
    if (this.audioElement) {
      this.audioElement.currentTime = 0;
      this.audioElement.play().catch(() => {});
    }
  }

  /**
   * User taps button / spacebar as the current lyric is sung
   */
  stampCurrentLine(overrideTimeMs = null) {
    if (this.currentLineIndex >= this.lines.length) {
      this.isSyncing = false;
      return null;
    }

    const stampMs = overrideTimeMs !== null 
      ? overrideTimeMs 
      : (this.audioElement ? Math.floor(this.audioElement.currentTime * 1000) : 0);

    const targetLine = this.lines[this.currentLineIndex];
    targetLine.timeMs = stampMs;
    targetLine.timeStr = this.formatTime(stampMs);

    const stampedIndex = this.currentLineIndex;
    this.currentLineIndex++;

    if (this.currentLineIndex >= this.lines.length) {
      this.isSyncing = false;
    }

    if (typeof this.onLineChange === 'function') {
      this.onLineChange(stampedIndex, targetLine, this.currentLineIndex);
    }

    return targetLine;
  }

  /**
   * Shift all timestamps by offsetMs (positive or negative delay adjustment)
   */
  adjustOffset(offsetMs) {
    for (const line of this.lines) {
      if (line.timeMs !== null) {
        line.timeMs = Math.max(0, line.timeMs + offsetMs);
        line.timeStr = this.formatTime(line.timeMs);
      }
    }
  }
}

if (typeof module !== 'undefined') {
  module.exports = SyncedLyricsEditor;
} else {
  window.SyncedLyricsEditor = SyncedLyricsEditor;
}
