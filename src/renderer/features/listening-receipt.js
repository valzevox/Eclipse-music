// JavaScript / listening-receipt.js / Thermal Receipt SVG & Data Generator
// Part of Eclipse Music Player — MIT License

class ListeningReceiptGenerator {
  /**
   * Generate an aesthetic Thermal Paper Receipt in SVG
   */
  static generateThermalReceipt(options = {}) {
    const username = options.username || 'ECLIPSE LISTENER';
    const period = options.period || 'ALL TIME';
    const tracks = Array.isArray(options.tracks) ? options.tracks.slice(0, 10) : [];
    const totalMinutes = options.totalMinutes || tracks.reduce((acc, t) => acc + (t.duration || 180) / 60, 0);

    const now = new Date();
    const dateStr = `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, '0')}.${String(now.getDate()).padStart(2, '0')}`;
    const orderNum = Math.floor(1000 + Math.random() * 9000);

    const width = 420;
    const baseHeight = 320 + tracks.length * 36;

    let trackRows = '';
    tracks.forEach((t, idx) => {
      const y = 200 + idx * 36;
      const rank = String(idx + 1).padStart(2, '0');
      const title = this.truncate(t.title || 'Untitled', 22);
      const artist = this.truncate(t.artist || 'Artist', 16);
      const plays = t.plays || t.playCount || Math.floor(Math.random() * 30 + 5);

      trackRows += `
      <g transform="translate(30, ${y})">
        <text x="0" y="0" font-family="'Courier New', Courier, monospace" font-size="13" font-weight="bold" fill="#111111">${rank}</text>
        <text x="28" y="0" font-family="'Courier New', Courier, monospace" font-size="13" font-weight="bold" fill="#111111">${this.escapeXml(title)}</text>
        <text x="28" y="15" font-family="'Courier New', Courier, monospace" font-size="11" fill="#666666">${this.escapeXml(artist)}</text>
        <text x="350" y="0" text-anchor="end" font-family="'Courier New', Courier, monospace" font-size="13" font-weight="bold" fill="#111111">${plays}x</text>
      </g>`;
    });

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${baseHeight}" width="${width}" height="${baseHeight}">
  <!-- Thermal Receipt Paper with Texture -->
  <defs>
    <filter id="paperShadow" x="-10%" y="-5%" width="120%" height="110%">
      <feDropShadow dx="0" dy="12" stdDeviation="16" flood-color="#000000" flood-opacity="0.35" />
    </filter>
  </defs>

  <rect x="15" y="15" width="${width - 30}" height="${baseHeight - 30}" rx="6" fill="#fdfbf7" filter="url(#paperShadow)" stroke="#ece8df" stroke-width="1" />

  <!-- Header Section -->
  <g transform="translate(210, 50)" text-anchor="middle">
    <text y="0" font-family="'Courier New', Courier, monospace" font-size="20" font-weight="900" letter-spacing="3" fill="#111111">ECLIPSE MUSIC</text>
    <text y="22" font-family="'Courier New', Courier, monospace" font-size="11" letter-spacing="1" fill="#666666">OFFICIAL LISTENING RECEIPT</text>
    <text y="38" font-family="'Courier New', Courier, monospace" font-size="11" fill="#888888">ORDER #${orderNum} • ${dateStr}</text>
  </g>

  <!-- Divider Line -->
  <line x1="30" y1="105" x2="390" y2="105" stroke="#111111" stroke-width="1.5" stroke-dasharray="4,3" />

  <!-- Customer & Period Info -->
  <g transform="translate(30, 130)" font-family="'Courier New', Courier, monospace" font-size="11" fill="#333333">
    <text x="0" y="0">LISTENER: ${this.escapeXml(username)}</text>
    <text x="0" y="16">PERIOD:   ${this.escapeXml(period)}</text>
  </g>

  <!-- Items Header -->
  <line x1="30" y1="160" x2="390" y2="160" stroke="#111111" stroke-width="1" />
  <g transform="translate(30, 175)" font-family="'Courier New', Courier, monospace" font-size="11" font-weight="bold" fill="#111111">
    <text x="0" y="0">QTY</text>
    <text x="28" y="0">TRACK / ARTIST</text>
    <text x="350" y="0" text-anchor="end">PLAYS</text>
  </g>
  <line x1="30" y1="185" x2="390" y2="185" stroke="#111111" stroke-width="1" />

  <!-- Tracks Rows -->
  ${trackRows}

  <!-- Total Section -->
  <g transform="translate(30, ${baseHeight - 110})">
    <line x1="0" y1="0" x2="360" y2="0" stroke="#111111" stroke-width="1.5" stroke-dasharray="4,3" />
    <text x="0" y="24" font-family="'Courier New', Courier, monospace" font-size="14" font-weight="bold" fill="#111111">TOTAL MINUTES:</text>
    <text x="360" y="24" text-anchor="end" font-family="'Courier New', Courier, monospace" font-size="14" font-weight="900" fill="#111111">${Math.round(totalMinutes)} MIN</text>
    <text x="0" y="44" font-family="'Courier New', Courier, monospace" font-size="11" fill="#666666">PAID BY: PASSION &amp; REPEAT</text>
    <line x1="0" y1="56" x2="360" y2="56" stroke="#111111" stroke-width="1.5" />
  </g>

  <!-- Barcode Footer -->
  <g transform="translate(210, ${baseHeight - 35})" text-anchor="middle">
    <text font-family="'Courier New', Courier, monospace" font-size="10" letter-spacing="4" fill="#333333">||||| | |||| ||| ||||||| || |||||</text>
    <text y="14" font-family="'Courier New', Courier, monospace" font-size="9" fill="#999999">THANK YOU FOR LISTENING WITH ECLIPSE</text>
  </g>
</svg>`;
  }

  static truncate(str, maxLen = 20) {
    const s = String(str || '');
    return s.length > maxLen ? s.slice(0, maxLen - 1) + '…' : s;
  }

  static escapeXml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
}

if (typeof module !== 'undefined') {
  module.exports = ListeningReceiptGenerator;
} else {
  window.ListeningReceiptGenerator = ListeningReceiptGenerator;
}
