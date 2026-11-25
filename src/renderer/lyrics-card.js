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

  /**
   * Helper to wrap text into lines fitting max width
   */
  static wrapText(ctx, text, maxWidth) {
    if (!text) return [''];
    const words = text.split(/\s+/);
    const lines = [];
    let currentLine = words[0] || '';

    for (let i = 1; i < words.length; i++) {
      const word = words[i];
      const width = ctx.measureText(currentLine + ' ' + word).width;
      if (width < maxWidth) {
        currentLine += ' ' + word;
      } else {
        lines.push(currentLine);
        currentLine = word;
      }
    }
    if (currentLine) lines.push(currentLine);
    return lines;
  }

  /**
   * Helper to draw rounded rectangle on canvas
   */
  static roundRect(ctx, x, y, width, height, radius) {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + width - radius, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    ctx.lineTo(x + width, y + height - radius);
    ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    ctx.lineTo(x + radius, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
  }

  /**
   * Render high-resolution glassmorphism lyrics card to HTMLCanvasElement
   */
  static async generateCanvasCard(options = {}) {
    const rawLines = Array.isArray(options.lines) ? options.lines : [options.lines || ''];
    const title = options.title || 'Unknown Title';
    const artist = options.artist || 'Unknown Artist';
    const coverUrl = options.coverUrl || '';
    const width = options.width || 800;
    const height = options.height || 1000;

    let canvas;
    if (typeof OffscreenCanvas !== 'undefined') {
      canvas = new OffscreenCanvas(width, height);
    } else if (typeof document !== 'undefined' && document.createElement) {
      canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
    } else {
      throw new Error('Canvas rendering environment unavailable');
    }

    const ctx = canvas.getContext('2d');

    // 1. Deep Space Neon Gradient Base
    const bgGrad = ctx.createLinearGradient(0, 0, width, height);
    bgGrad.addColorStop(0, '#140b24');
    bgGrad.addColorStop(0.5, '#0c0717');
    bgGrad.addColorStop(1, '#05030a');
    ctx.fillStyle = bgGrad;
    this.roundRect(ctx, 0, 0, width, height, 32);
    ctx.fill();

    // 2. Ambient Glow Spheres
    ctx.save();
    const orb1 = ctx.createRadialGradient(160, 220, 10, 160, 220, 260);
    orb1.addColorStop(0, 'rgba(139, 92, 246, 0.42)');
    orb1.addColorStop(1, 'rgba(139, 92, 246, 0)');
    ctx.fillStyle = orb1;
    ctx.beginPath();
    ctx.arc(160, 220, 260, 0, Math.PI * 2);
    ctx.fill();

    const orb2 = ctx.createRadialGradient(width - 160, height - 260, 10, width - 160, height - 260, 300);
    orb2.addColorStop(0, 'rgba(236, 72, 153, 0.32)');
    orb2.addColorStop(1, 'rgba(236, 72, 153, 0)');
    ctx.fillStyle = orb2;
    ctx.beginPath();
    ctx.arc(width - 160, height - 260, 300, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // 3. Frosted Glass Inner Container
    const pad = 36;
    const innerW = width - pad * 2;
    const innerH = height - pad * 2;
    ctx.save();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.04)';
    this.roundRect(ctx, pad, pad, innerW, innerH, 26);
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    this.roundRect(ctx, pad, pad, innerW, innerH, 26);
    ctx.stroke();
    ctx.restore();

    // 4. Header Branding (Eclipse Logo Pill)
    ctx.save();
    const logoX = pad + 32;
    const logoY = pad + 40;
    const neonGrad = ctx.createLinearGradient(logoX, logoY, logoX + 22, logoY + 22);
    neonGrad.addColorStop(0, '#8b5cf6');
    neonGrad.addColorStop(1, '#ec4899');
    ctx.fillStyle = neonGrad;
    ctx.beginPath();
    ctx.arc(logoX + 10, logoY + 10, 10, 0, Math.PI * 2);
    ctx.fill();

    ctx.font = '700 16px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillStyle = '#a78bfa';
    ctx.fillText('ECLIPSE MUSIC', logoX + 32, logoY + 16);
    ctx.restore();

    // 5. Lyrics Section (Centered Vertical Balance with Auto-Wrapping)
    ctx.save();
    ctx.font = '600 28px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.65)';
    ctx.shadowBlur = 12;
    ctx.shadowOffsetY = 3;

    const lyricsMaxW = innerW - 80;
    const wrappedLines = [];
    rawLines.forEach(l => {
      const clean = String(l || '').trim();
      if (clean) {
        const sub = this.wrapText(ctx, clean, lyricsMaxW);
        wrappedLines.push(...sub);
      }
    });

    const lineHeight = 46;
    const totalLyricsH = wrappedLines.length * lineHeight;
    const availableAreaTop = pad + 100;
    const availableAreaBottom = height - pad - 140;
    const startY = Math.max(availableAreaTop + 40, (availableAreaTop + availableAreaBottom - totalLyricsH) / 2 + 20);

    wrappedLines.forEach((lineText, idx) => {
      ctx.fillText(lineText, pad + 40, startY + idx * lineHeight);
    });
    ctx.restore();

    // 6. Footer: Loaded Album Cover + Track Info + Neon Accent
    const footerY = height - pad - 100;
    const footerX = pad + 40;
    const coverSize = 72;

    if (coverUrl && typeof Image !== 'undefined') {
      try {
        const img = await new Promise((resolve, reject) => {
          const image = new Image();
          image.crossOrigin = 'anonymous';
          image.onload = () => resolve(image);
          image.onerror = () => reject(new Error('Image load failed'));
          image.src = coverUrl;
        });

        ctx.save();
        this.roundRect(ctx, footerX, footerY, coverSize, coverSize, 14);
        ctx.clip();
        ctx.drawImage(img, footerX, footerY, coverSize, coverSize);
        ctx.restore();

        ctx.save();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
        ctx.lineWidth = 1;
        this.roundRect(ctx, footerX, footerY, coverSize, coverSize, 14);
        ctx.stroke();
        ctx.restore();
      } catch (_) {
        // Fallback: Neon Accent Bar
        ctx.save();
        ctx.fillStyle = neonGrad;
        this.roundRect(ctx, footerX, footerY + 8, 6, 56, 3);
        ctx.fill();
        ctx.restore();
      }
    } else {
      // Accent Bar fallback
      ctx.save();
      const barGrad = ctx.createLinearGradient(footerX, footerY, footerX, footerY + 60);
      barGrad.addColorStop(0, '#8b5cf6');
      barGrad.addColorStop(1, '#ec4899');
      ctx.fillStyle = barGrad;
      this.roundRect(ctx, footerX, footerY + 8, 6, 56, 3);
      ctx.fill();
      ctx.restore();
    }

    const textOffset = (coverUrl && typeof Image !== 'undefined') ? coverSize + 18 : 22;
    ctx.save();
    ctx.font = '700 22px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(title, footerX + textOffset, footerY + 30);

    ctx.font = '500 16px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillStyle = '#9ca3af';
    ctx.fillText(artist, footerX + textOffset, footerY + 58);
    ctx.restore();

    return canvas;
  }

  /**
   * Export card directly as a PNG Blob
   */
  static async generatePngBlob(options = {}) {
    const canvas = await this.generateCanvasCard(options);
    if (typeof canvas.convertToBlob === 'function') {
      return await canvas.convertToBlob({ type: 'image/png' });
    }
    return new Promise((resolve) => {
      canvas.toBlob((blob) => resolve(blob), 'image/png');
    });
  }
}

if (typeof module !== 'undefined') {
  module.exports = LyricsCardGenerator;
} else {
  window.LyricsCardGenerator = LyricsCardGenerator;
}
