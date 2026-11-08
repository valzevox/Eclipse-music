// JavaScript / lyrics-card.js / Glassmorphism Lyrics Card Generator (SVG & Canvas)
// Part of Eclipse Music Player — MIT License

class LyricsCardGenerator {
  /**
   * Generate an SVG markup string for a shareable lyrics card
   */
  static generateSvgCard(options = {}) {
    const lines = Array.isArray(options.lines) ? options.lines : [options.lines || ''];
    const title = options.title || 'Unknown Title';
    const artist = options.artist || 'Unknown Artist';
    const coverUrl = options.coverUrl || '';
    const width = options.width || 600;
    const height = options.height || 750;

    const formattedLines = lines.map((line, idx) => {
      const y = 280 + idx * 42;
      return `<text x="50" y="${y}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="22" font-weight="600" fill="#ffffff" filter="drop-shadow(0 2px 4px rgba(0,0,0,0.5))">${this.escapeXml(line)}</text>`;
    }).join('\n');

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
  <defs>
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#140b24" />
      <stop offset="50%" stop-color="#0c0717" />
      <stop offset="100%" stop-color="#05030a" />
    </linearGradient>
    <linearGradient id="neonGlow" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#8b5cf6" />
      <stop offset="100%" stop-color="#ec4899" />
    </linearGradient>
    <filter id="glassBlur">
      <feGaussianBlur stdDeviation="15" />
      <feColorMatrix type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -7" />
    </filter>
  </defs>

  <!-- Background Base -->
  <rect width="${width}" height="${height}" rx="24" fill="url(#bgGrad)" />

  <!-- Ambient Light Orbs -->
  <circle cx="120" cy="180" r="140" fill="#8b5cf6" opacity="0.25" filter="url(#glassBlur)" />
  <circle cx="480" cy="580" r="160" fill="#ec4899" opacity="0.2" filter="url(#glassBlur)" />

  <!-- Glass Card Container -->
  <rect x="25" y="25" width="${width - 50}" height="${height - 50}" rx="20" fill="rgba(255, 255, 255, 0.04)" stroke="rgba(255, 255, 255, 0.12)" stroke-width="1.5" />

  <!-- Header Branding -->
  <g transform="translate(50, 65)">
    <circle cx="10" cy="10" r="10" fill="url(#neonGlow)" />
    <text x="32" y="16" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="14" font-weight="700" fill="#a78bfa" letter-spacing="2">ECLIPSE MUSIC</text>
  </g>

  <!-- Lyrics Body -->
  <g>
    ${formattedLines}
  </g>

  <!-- Footer Track Info -->
  <g transform="translate(50, ${height - 110})">
    <!-- Neon Accent Bar -->
    <rect x="0" y="0" width="4" height="48" rx="2" fill="url(#neonGlow)" />
    <text x="18" y="20" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="18" font-weight="700" fill="#ffffff">${this.escapeXml(title)}</text>
    <text x="18" y="42" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="14" font-weight="500" fill="#9ca3af">${this.escapeXml(artist)}</text>
  </g>
</svg>`;
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
  module.exports = LyricsCardGenerator;
} else {
  window.LyricsCardGenerator = LyricsCardGenerator;
}
