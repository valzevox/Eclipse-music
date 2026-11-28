'use strict';

function hexToRgb(hex) {
  hex = hex.replace('#', '');
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  const num = parseInt(hex, 16);
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s, l = (max + min) / 2;
  if (max === min) { h = s = 0; }
  else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
  }
  return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
}

function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = n => { const k = (n + h / 30) % 12; return l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1); };
  return '#' + [f(0), f(8), f(4)].map(x => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
}

function getAdv(name, defaultVal = true) {
  const val = localStorage.getItem(`eclipse_adv_${name}`);
  if (val === null) return defaultVal;
  return val === 'true';
}

function setAdv(name, boolVal) {
  localStorage.setItem(`eclipse_adv_${name}`, boolVal ? 'true' : 'false');
}

function applyReducedMotionSetting() {
  const reduced = getAdv('reduce_motion', false);
  document.documentElement.classList.toggle('force-reduced-motion', reduced);
}

var PALETTE_STYLES = {
  classic: {
    label: 'Classic',
    secHueShift: 0,
    tertHueShift: 0,
    priSatScale: 1.0,
    surfSatScale: 1.0,
    contSatScale: 1.0
  },
  'tonal-spot': {
    label: 'Tonal spot',
    secHueShift: 0,
    tertHueShift: 60,
    priSatScale: 1.0,
    surfSatScale: 0.8,
    contSatScale: 0.9
  },
  expressive: {
    label: 'Expressive',
    secHueShift: 60,
    tertHueShift: 120,
    priSatScale: 1.25,
    surfSatScale: 1.5,
    contSatScale: 1.3
  },
  vibrant: {
    label: 'Vibrant',
    secHueShift: 0,
    tertHueShift: 60,
    priSatScale: 1.4,
    surfSatScale: 1.2,
    contSatScale: 1.4
  },
  neutral: {
    label: 'Neutral',
    secHueShift: 0,
    tertHueShift: 0,
    priSatScale: 0.35,
    surfSatScale: 0.2,
    contSatScale: 0.25
  }
};

var tint = (hex, v) => `color-mix(in srgb, ${hex} var(${v}), transparent)`;
var SURFACE_TOKENS = new Set([
  '--md-sys-color-background',
  '--md-sys-color-surface',
  '--md-sys-color-surface-dim',
  '--md-sys-color-surface-bright',
  '--md-sys-color-surface-container-lowest',
  '--md-sys-color-surface-container-low',
  '--md-sys-color-surface-container',
  '--md-sys-color-surface-container-high',
  '--md-sys-color-surface-container-highest'
]);
var TEXT_TOKENS = new Set([
  '--md-sys-color-on-surface',
  '--md-sys-color-on-surface-variant'
]);

function generateM3Palette(hexColor, mode, intensity, brightness) {
  if (!hexColor) hexColor = '#6750A4';
  const rgb = hexToRgb(hexColor);
  const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
  const h = hsl.h;
  const s = hsl.s || 60;
  const intensityFactor = (typeof intensity === 'number' ? intensity : 100) / 100;
  const root = document.documentElement;
  const applyBgIntensity = getAdv('intensity_bg', false);

  const setToken = (prop, val) => {
    if (SURFACE_TOKENS.has(prop)) {
      root.style.setProperty(prop, tint(val, '--ui-alpha'));
      root.style.setProperty(`${prop}-solid`, val);
    } else if (TEXT_TOKENS.has(prop)) {
      root.style.setProperty(prop, tint(val, '--text-alpha'));
      root.style.setProperty(`${prop}-solid`, val);
    } else {
      root.style.setProperty(prop, val);
    }
  };

  const setSurfaceToken = (prop, val) => {
    root.style.setProperty(prop, tint(val, '--ui-alpha'));
    root.style.setProperty(`${prop}-solid`, val);
  };

  const styleKey = state.paletteStyle || 'classic';
  const style = PALETTE_STYLES[styleKey] || PALETTE_STYLES.classic;
  const surfSat = applyBgIntensity ? Math.min(85, Math.round(s * intensityFactor * (style.surfSatScale * 2.4))) : 0;

  const hSec = (h + style.secHueShift) % 360;
  const hTert = (h + style.tertHueShift) % 360;

  const isMonochrome = intensityFactor < 0.08 || (styleKey === 'neutral' && intensityFactor < 0.05);
  const br = (typeof brightness === 'number' ? brightness : 50) / 100;

  if (mode === 'light') {
    const LB = (v) => Math.max(0, Math.min(100, Math.round(v + (br - 0.5) * 24)));
    if (isMonochrome) {
      setToken('--md-sys-color-primary', '#111111');
      setToken('--md-sys-color-on-primary', '#FFFFFF');
      setSurfaceToken('--md-sys-color-primary-container', hslToHex(0, 0, LB(90)));
      setToken('--md-sys-color-on-primary-container', '#111111');
      setToken('--md-sys-color-secondary', '#444444');
      setSurfaceToken('--md-sys-color-secondary-container', hslToHex(0, 0, LB(90)));
      setToken('--md-sys-color-on-secondary-container', '#111111');
      setToken('--md-sys-color-tertiary', '#444444');
      setSurfaceToken('--md-sys-color-tertiary-container', hslToHex(0, 0, LB(90)));
      setToken('--md-sys-color-background', hslToHex(0, 0, LB(99)));
      setToken('--md-sys-color-surface', hslToHex(0, 0, LB(98)));
      setToken('--md-sys-color-surface-dim', hslToHex(0, 0, LB(87)));
      setToken('--md-sys-color-surface-bright', hslToHex(0, 0, LB(98)));
      setToken('--md-sys-color-surface-container-lowest', hslToHex(0, 0, LB(100)));
      setToken('--md-sys-color-surface-container-low', hslToHex(0, 0, LB(96)));
      setToken('--md-sys-color-surface-container', hslToHex(0, 0, LB(94)));
      setToken('--md-sys-color-surface-container-high', hslToHex(0, 0, LB(92)));
      setToken('--md-sys-color-surface-container-highest', hslToHex(0, 0, LB(90)));
      setToken('--md-sys-color-on-surface', '#111111');
      setToken('--md-sys-color-on-surface-variant', '#444444');
      setToken('--md-sys-color-outline', '#777777');
      setSurfaceToken('--md-sys-color-outline-variant', '#CFCFCF');
      setToken('--md-sys-color-error', '#777777');
      setToken('--md-sys-color-on-error', '#FFFFFF');
    } else {
      const sat = Math.min(100, Math.round(48 * intensityFactor * style.priSatScale));
      const satHi = Math.min(100, Math.round(80 * intensityFactor * style.contSatScale));
      const satMed = Math.min(100, Math.round(55 * intensityFactor * style.priSatScale));
      const satLow = Math.min(100, Math.round(30 * intensityFactor * style.contSatScale));
      const satLow2 = Math.min(100, Math.round(20 * intensityFactor * style.contSatScale));

      setToken('--md-sys-color-primary', hslToHex(h, sat, 40));
      setToken('--md-sys-color-on-primary', '#FEFBFF');
      setToken('--md-sys-color-primary-container', hslToHex(h, satHi, LB(90)));
      setToken('--md-sys-color-on-primary-container', hslToHex(h, satMed, 18));
      setToken('--md-sys-color-secondary', hslToHex(hSec, satLow, 45));
      setToken('--md-sys-color-secondary-container', hslToHex(hSec, satLow, LB(90)));
      setToken('--md-sys-color-on-secondary-container', hslToHex(hSec, satLow2, 15));
      setToken('--md-sys-color-tertiary', hslToHex(hTert, satLow, 45));
      setToken('--md-sys-color-tertiary-container', hslToHex(hTert, satLow, LB(90)));
      setToken('--md-sys-color-background', hslToHex(h, surfSat, LB(99)));
      setToken('--md-sys-color-surface', hslToHex(h, surfSat, LB(98)));
      setToken('--md-sys-color-surface-dim', hslToHex(h, surfSat, LB(87)));
      setToken('--md-sys-color-surface-bright', hslToHex(h, surfSat, LB(98)));
      setToken('--md-sys-color-surface-container-lowest', hslToHex(h, surfSat, LB(100)));
      setToken('--md-sys-color-surface-container-low', hslToHex(h, surfSat, LB(96)));
      setToken('--md-sys-color-surface-container', hslToHex(h, surfSat, LB(94)));
      setToken('--md-sys-color-surface-container-high', hslToHex(h, surfSat, LB(92)));
      setToken('--md-sys-color-surface-container-highest', hslToHex(h, surfSat, LB(90)));
      setToken('--md-sys-color-on-surface', '#1C1B1F');
      setToken('--md-sys-color-on-surface-variant', '#49454F');
      setToken('--md-sys-color-outline', '#79747E');
      setToken('--md-sys-color-outline-variant', '#CAC4D0');
    }
  } else {
    if (isMonochrome) {
      const B = (v) => Math.max(0, Math.min(100, Math.round(v * (br * 2))));
      setToken('--md-sys-color-primary', '#FFFFFF');
      setToken('--md-sys-color-on-primary', '#121212');
      setSurfaceToken('--md-sys-color-primary-container', hslToHex(0, 0, B(24)));
      setToken('--md-sys-color-on-primary-container', '#FFFFFF');
      setToken('--md-sys-color-secondary', '#D0D0D0');
      setSurfaceToken('--md-sys-color-secondary-container', hslToHex(0, 0, B(24)));
      setToken('--md-sys-color-on-secondary-container', '#FFFFFF');
      setToken('--md-sys-color-tertiary', '#D0D0D0');
      setSurfaceToken('--md-sys-color-tertiary-container', hslToHex(0, 0, B(24)));
      setToken('--md-sys-color-background', hslToHex(0, 0, B(7)));
      setToken('--md-sys-color-surface', hslToHex(0, 0, B(7)));
      setToken('--md-sys-color-surface-dim', hslToHex(0, 0, B(7)));
      setToken('--md-sys-color-surface-bright', hslToHex(0, 0, B(19)));
      setToken('--md-sys-color-surface-container-lowest', hslToHex(0, 0, B(5)));
      setToken('--md-sys-color-surface-container-low', hslToHex(0, 0, B(10)));
      setToken('--md-sys-color-surface-container', hslToHex(0, 0, B(13)));
      setToken('--md-sys-color-surface-container-high', hslToHex(0, 0, B(16)));
      setToken('--md-sys-color-surface-container-highest', hslToHex(0, 0, B(20)));
      setToken('--md-sys-color-on-surface', '#FFFFFF');
      setToken('--md-sys-color-on-surface-variant', '#CFCFCF');
      setToken('--md-sys-color-outline', '#8A8A8A');
      setSurfaceToken('--md-sys-color-outline-variant', '#3A3A3A');
      setToken('--md-sys-color-error', '#8A8A8A');
      setToken('--md-sys-color-on-error', '#121212');
    } else {
      const sat = Math.min(100, Math.round(60 * intensityFactor * style.priSatScale));
      const satHi = Math.min(100, Math.round(60 * intensityFactor * style.contSatScale));
      const satMed = Math.min(100, Math.round(50 * intensityFactor * style.priSatScale));
      const satLow = Math.min(100, Math.round(15 * intensityFactor * style.contSatScale));
      const satLow2 = Math.min(100, Math.round(30 * intensityFactor * style.contSatScale));
      const priHex = hslToHex(h, sat, 75);
      const priRgb = hexToRgb(priHex);
      setToken('--md-sys-color-primary', priHex);
      setToken('--md-sys-color-on-primary', hslToHex(h, satMed, 20));
      setToken('--md-sys-color-primary-container', `rgba(${priRgb.r}, ${priRgb.g}, ${priRgb.b}, 0.18)`);
      setToken('--md-sys-color-on-primary-container', priHex);
      setToken('--md-sys-color-secondary', hslToHex(hSec, satLow2, 75));
      setToken('--md-sys-color-secondary-container', hslToHex(hSec, satLow, 22));
      setToken('--md-sys-color-on-secondary-container', hslToHex(hSec, satLow2, 85));
      setToken('--md-sys-color-tertiary', hslToHex(hTert, satLow2, 75));
      setToken('--md-sys-color-tertiary-container', hslToHex(hTert, satLow, 22));
      const B = (v) => Math.max(0, Math.min(100, Math.round(v * (br * 2))));
      setToken('--md-sys-color-background', hslToHex(h, surfSat, B(7)));
      setToken('--md-sys-color-surface', hslToHex(h, surfSat, B(8)));
      setToken('--md-sys-color-surface-dim', hslToHex(h, surfSat, B(7)));
      setToken('--md-sys-color-surface-bright', hslToHex(h, surfSat, B(24)));
      setToken('--md-sys-color-surface-container-lowest', hslToHex(h, surfSat, B(5)));
      setToken('--md-sys-color-surface-container-low', hslToHex(h, surfSat, B(10)));
      setToken('--md-sys-color-surface-container', hslToHex(h, surfSat, B(13)));
      setToken('--md-sys-color-surface-container-high', hslToHex(h, surfSat, B(16)));
      setToken('--md-sys-color-surface-container-highest', hslToHex(h, surfSat, B(20)));
      setToken('--md-sys-color-on-surface', '#e2e2e9');
      setToken('--md-sys-color-on-surface-variant', '#c4c6d0');
      setToken('--md-sys-color-outline', '#8e9099');
      setToken('--md-sys-color-outline-variant', '#282a33');
    }
  }
}

function extractDominantColor(imgSrc) {
  return new Promise((resolve) => {
    if (!imgSrc) return resolve('#6750A4');
    const img = new Image();
    img.crossOrigin = 'Anonymous';
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      canvas.width = 10;
      canvas.height = 10;
      ctx.drawImage(img, 0, 0, 10, 10);
      const data = ctx.getImageData(0, 0, 10, 10).data;
      let r = 0, g = 0, b = 0;
      for (let i = 0; i < data.length; i += 4) {
        r += data[i]; g += data[i + 1]; b += data[i + 2];
      }
      const count = data.length / 4;
      r = Math.floor(r / count);
      g = Math.floor(g / count);
      b = Math.floor(b / count);
      const hex = '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
      resolve(hex);
    };
    img.onerror = () => resolve('#6750A4');
    img.src = imgSrc;
  });
}

var hasDrawnPausedFrame = false;
var cachedPrimaryColor = '';
var cachedDimColor = '';
var animationFrameId = null;

function refreshCachedThemeColors() {
  const rootStyle = getComputedStyle(document.documentElement);
  cachedPrimaryColor = rootStyle.getPropertyValue('--md-sys-color-primary').trim() || '#6750A4';
  cachedDimColor = rootStyle.getPropertyValue('--md-sys-color-on-surface').trim() || '#E6E0E9';
  hasDrawnPausedFrame = false;
}

function boundMap(map, maxSize = 30) {
  if (!map) return;
  if (map instanceof Map) {
    while (map.size > maxSize) {
      const firstKey = map.keys().next().value;
      map.delete(firstKey);
    }
  } else if (typeof map === 'object') {
    const keys = Object.keys(map);
    if (keys.length > maxSize) {
      for (let i = 0; i < keys.length - maxSize; i++) {
        delete map[keys[i]];
      }
    }
  }
}

var coverAnalysisCache = new Map();

function analyzeCover(imgSrc) {
  return new Promise((resolve) => {
    if (!imgSrc) {
      return resolve({ accent: '#6750A4', accent2: '#9A82DB', luminance: 0.2, saturation: 0.5 });
    }
    if (coverAnalysisCache.has(imgSrc)) {
      const cached = coverAnalysisCache.get(imgSrc);
      coverAnalysisCache.delete(imgSrc);
      coverAnalysisCache.set(imgSrc, cached);
      return resolve(cached);
    }

    const img = new Image();
    img.crossOrigin = 'Anonymous';
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 48;
        canvas.height = 48;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, 48, 48);
        const data = ctx.getImageData(0, 0, 48, 48).data;

        let totalLuminance = 0;
        let nonGraySatSum = 0;
        let nonGraySatCount = 0;

        const bins = Array.from({ length: 24 }, (_, i) => ({
          idx: i,
          centerHue: (i + 0.5) * 15,
          weight: 0,
          rSum: 0,
          gSum: 0,
          bSum: 0,
          count: 0
        }));

        let fallbackR = 0, fallbackG = 0, fallbackB = 0;
        const totalPixels = data.length / 4;

        for (let i = 0; i < data.length; i += 4) {
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          fallbackR += r;
          fallbackG += g;
          fallbackB += b;

          const rN = r / 255;
          const gN = g / 255;
          const bN = b / 255;

          const lum = 0.2126 * rN + 0.7152 * gN + 0.0722 * bN;
          totalLuminance += lum;

          const max = Math.max(rN, gN, bN);
          const min = Math.min(rN, gN, bN);
          const d = max - min;
          const l = (max + min) / 2;
          const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));

          if (s >= 0.15) {
            nonGraySatSum += s;
            nonGraySatCount++;

            if (l >= 0.10 && l <= 0.90) {
              let hDeg = 0;
              if (d > 0) {
                if (max === rN) {
                  hDeg = ((gN - bN) / d + (gN < bN ? 6 : 0)) * 60;
                } else if (max === gN) {
                  hDeg = ((bN - rN) / d + 2) * 60;
                } else {
                  hDeg = ((rN - gN) / d + 4) * 60;
                }
              }
              const binIdx = Math.min(23, Math.max(0, Math.floor(hDeg / 15)));
              const bin = bins[binIdx];
              bin.weight += s;
              bin.rSum += r;
              bin.gSum += g;
              bin.bSum += b;
              bin.count++;
            }
          }
        }

        const meanLuminance = totalLuminance / totalPixels;
        const meanSaturation = nonGraySatCount > 0 ? (nonGraySatSum / nonGraySatCount) : 0;

        let bestBin = null;
        for (let i = 0; i < 24; i++) {
          if (bins[i].count > 0) {
            if (!bestBin || bins[i].weight > bestBin.weight) {
              bestBin = bins[i];
            }
          }
        }

        let accentHex = '';
        let accentR = 0, accentG = 0, accentB = 0;

        if (bestBin && bestBin.count > 0) {
          accentR = Math.round(bestBin.rSum / bestBin.count);
          accentG = Math.round(bestBin.gSum / bestBin.count);
          accentB = Math.round(bestBin.bSum / bestBin.count);
          accentHex = '#' + [accentR, accentG, accentB].map(x => x.toString(16).padStart(2, '0')).join('');
        } else {
          accentR = Math.round(fallbackR / totalPixels);
          accentG = Math.round(fallbackG / totalPixels);
          accentB = Math.round(fallbackB / totalPixels);
          accentHex = '#' + [accentR, accentG, accentB].map(x => x.toString(16).padStart(2, '0')).join('');
        }

        let bestBin2 = null;
        if (bestBin) {
          for (let i = 0; i < 24; i++) {
            if (bins[i].count > 0 && i !== bestBin.idx) {
              const diff = Math.abs(bins[i].centerHue - bestBin.centerHue);
              const dist = Math.min(diff, 360 - diff);
              if (dist >= 60) {
                if (!bestBin2 || bins[i].weight > bestBin2.weight) {
                  bestBin2 = bins[i];
                }
              }
            }
          }
        }

        let accent2Hex = '';
        if (bestBin2 && bestBin2.count > 0) {
          const r2 = Math.round(bestBin2.rSum / bestBin2.count);
          const g2 = Math.round(bestBin2.gSum / bestBin2.count);
          const b2 = Math.round(bestBin2.bSum / bestBin2.count);
          accent2Hex = '#' + [r2, g2, b2].map(x => x.toString(16).padStart(2, '0')).join('');
        } else {
          const hslAcc = rgbToHsl(accentR, accentG, accentB);
          const h2 = (hslAcc.h + 40) % 360;
          accent2Hex = hslToHex(h2, hslAcc.s, hslAcc.l);
        }

        const result = {
          accent: accentHex,
          accent2: accent2Hex,
          luminance: meanLuminance,
          saturation: meanSaturation
        };

        coverAnalysisCache.set(imgSrc, result);
        boundMap(coverAnalysisCache, 30);
        resolve(result);
      } catch (err) {
        resolve({ accent: '#6750A4', accent2: '#9A82DB', luminance: 0.2, saturation: 0.5 });
      }
    };
    img.onerror = () => {
      resolve({ accent: '#6750A4', accent2: '#9A82DB', luminance: 0.2, saturation: 0.5 });
    };
    img.src = imgSrc;
  });
}

var activeMeshLayer = 'a';
var lastMeshKey = '';
var lastMeshArgs = null;
var meshCoverColors = null;

function mixHex(a, b, t) {
  const c1 = hexToRgb(a);
  const c2 = hexToRgb(b);
  const r = Math.round(c1.r + (c2.r - c1.r) * t);
  const g = Math.round(c1.g + (c2.g - c1.g) * t);
  const bl = Math.round(c1.b + (c2.b - c1.b) * t);
  return '#' + [r, g, bl].map(x => Math.max(0, Math.min(255, x)).toString(16).padStart(2, '0')).join('');
}

function colorToHex(c) {
  if (!c) return '#9E9E9E';
  if (typeof c === 'string' && c.startsWith('#')) return c;
  const match = typeof c === 'string' && c.match(/rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/i);
  if (match) {
    const r = parseInt(match[1], 10);
    const g = parseInt(match[2], 10);
    const b = parseInt(match[3], 10);
    return '#' + [r, g, b].map(x => Math.max(0, Math.min(255, x)).toString(16).padStart(2, '0')).join('');
  }
  return c;
}

async function refreshMeshCover() {
  if (!getAdv('mesh_cover_color', false) || !state.currentTrack) {
    meshCoverColors = null;
    return;
  }
  const trackBefore = state.currentTrack;
  const thumbUrl = (typeof getTrackThumbUrl === 'function' ? getTrackThumbUrl(state.currentTrack) : state.currentTrack.thumbnail) || '';
  if (!thumbUrl) {
    meshCoverColors = null;
    lastMeshKey = '';
    if (lastMeshArgs) updateMeshGradient(...lastMeshArgs);
    return;
  }
  try {
    const [a, b] = await getCoverDominantColors(thumbUrl);
    const currentUrl = (state.currentTrack && (typeof getTrackThumbUrl === 'function' ? getTrackThumbUrl(state.currentTrack) : state.currentTrack.thumbnail)) || '';
    if (!state.currentTrack || (state.currentTrack !== trackBefore && state.currentTrack.id !== trackBefore?.id) || currentUrl !== thumbUrl) return;
    meshCoverColors = [colorToHex(a), colorToHex(b || a)];
    lastMeshKey = '';
    if (lastMeshArgs) updateMeshGradient(...lastMeshArgs);
  } catch (_) {}
}

var coverBgIdx = 0;
var activeCoverBgUrl = '';

function setCoverBg(url) {
  const enabled = getAdv('cover_bg', true);
  const layers = document.querySelectorAll('#cover-bg .cover-bg-layer');
  if (!enabled || !url) {
    activeCoverBgUrl = '';
    document.body.classList.remove('cover-bg-on');
    layers.forEach(l => l.classList.remove('on'));
    return;
  }

  activeCoverBgUrl = url;
  document.body.classList.add('cover-bg-on');

  const img = new Image();
  img.crossOrigin = 'Anonymous';
  img.onload = () => {
    if (activeCoverBgUrl !== url) return;
    if (layers.length < 2) return;
    const nextIdx = 1 - coverBgIdx;
    const nextLayer = layers[nextIdx];
    const prevLayer = layers[coverBgIdx];

    nextLayer.style.backgroundImage = `url(${JSON.stringify(url)})`;
    nextLayer.classList.add('on');
    prevLayer.classList.remove('on');
    coverBgIdx = nextIdx;
  };
  img.src = url;
}

var fxItems = [];
function registerFx(el, kind, viewEl) {
  if (!el || fxItems.some(i => i.el === el)) return;
  fxItems.push({ el, kind, view: viewEl || null, home: { parent: el.parentNode, next: el.nextSibling } });
  el.dataset.fx = kind;
}

function applyFxClip() {
  const free = document.body.classList.contains('no-clip-fx');
  const root = document.getElementById('fx-root');
  fxItems.forEach(i => {
    if (free) {
      if (root) root.appendChild(i.el);
      i.el.classList.add('fx-free');
    } else {
      if (i.home && i.home.parent) {
        i.home.parent.insertBefore(i.el, i.home.next && i.home.next.parentNode === i.home.parent ? i.home.next : null);
      }
      i.el.classList.remove('fx-free');
    }
  });
  updateFxVisibility();
}

function updateFxVisibility() {
  const free = document.body.classList.contains('no-clip-fx');
  fxItems.forEach(i => {
    const isHidden = (free && i.view && !i.view.classList.contains('active'));
    i.el.classList.toggle('fx-hidden', !!isHidden);
    i.el.style.display = '';
  });
}

function updateMeshGradient(accentHex, accent2Hex, mode) {
  lastMeshArgs = [accentHex, accent2Hex, mode];
  const meshA = document.getElementById('bg-mesh-a');
  const meshB = document.getElementById('bg-mesh-b');
  if (!meshA || !meshB) return;

  const isEnabled = getAdv('mesh_gradient', false) && (state.meshBrightness > 0);
  if (!isEnabled) {
    meshA.style.opacity = '0';
    meshB.style.opacity = '0';
    lastMeshKey = '';
    return;
  }

  let c1 = accentHex;
  let c2 = accent2Hex;
  const useCover = getAdv('mesh_cover_color', false);
  if (useCover && meshCoverColors) {
    c1 = meshCoverColors[0];
    c2 = meshCoverColors[1];
  }
  const followIntensity = getAdv('mesh_follow_intensity', true);
  if (followIntensity) {
    const k = Math.max(0, Math.min(1, (Number.isFinite(state.themeIntensity) ? state.themeIntensity : 100) / 100));
    c1 = mixHex(c1, '#9E9E9E', 1 - k);
    c2 = mixHex(c2, '#9E9E9E', 1 - k);
  }

  const meshKey = `${c1}_${c2}_${mode}_${state.meshBrightness}_${followIntensity}_${useCover}`;
  if (meshKey === lastMeshKey) return;
  lastMeshKey = meshKey;

  const rgb1 = hexToRgb(c1);
  const rgb2 = hexToRgb(c2);

  const brightnessScale = Math.max(0, Math.min(100, state.meshBrightness)) / 100;
  const a1 = (mode === 'light' ? 0.22 : 0.55) * brightnessScale;
  const a2 = (mode === 'light' ? 0.18 : 0.45) * brightnessScale;

  const accentRgba = `rgba(${rgb1.r}, ${rgb1.g}, ${rgb1.b}, ${a1})`;
  const accent2Rgba = `rgba(${rgb2.r}, ${rgb2.g}, ${rgb2.b}, ${a2})`;

  const gradient = `linear-gradient(to bottom, transparent 35%, var(--md-sys-color-background) 85%), ` +
    `radial-gradient(ellipse at var(--mesh-p1x, 20%) var(--mesh-p1y, 0%), ${accentRgba} 0%, transparent 70%), ` +
    `radial-gradient(ellipse at var(--mesh-p2x, 85%) var(--mesh-p2y, 5%), ${accent2Rgba} 0%, transparent 65%), ` +
    `var(--md-sys-color-background)`;

  const target = activeMeshLayer === 'a' ? meshB : meshA;
  const current = activeMeshLayer === 'a' ? meshA : meshB;

  target.style.background = gradient;
  target.style.opacity = '1';
  current.style.opacity = '0';

  const previewBg = document.getElementById('mesh-preview-bg');
  if (previewBg) {
    previewBg.style.background = gradient;
  }

  activeMeshLayer = activeMeshLayer === 'a' ? 'b' : 'a';
}

var currentEffectiveMode = (typeof state !== 'undefined' && state.themeMode) ? (state.themeMode === 'auto' ? 'dark' : state.themeMode) : 'dark';
var lastEffectiveMode = null;

function onEffectiveModeChanged(mode) {
  if (lastEffectiveMode === null) {
    lastEffectiveMode = mode;
    return;
  }
  if (lastEffectiveMode !== mode) {
    if (mode === 'light') {
      const now = currentUiAlpha();
      if (now < 100) {
        localStorage.setItem('eclipse_ui_alpha_light_prev', String(now));
        localStorage.setItem('eclipse_ui_alpha_light_auto', '100');
        setUiAlphaViaSlider(100);
      }
    } else if (lastEffectiveMode === 'light') {
      const auto = localStorage.getItem('eclipse_ui_alpha_light_auto'), prev = localStorage.getItem('eclipse_ui_alpha_light_prev');
      if (auto !== null && prev !== null && currentUiAlpha() === Number(auto)) setUiAlphaViaSlider(Number(prev));
      localStorage.removeItem('eclipse_ui_alpha_light_auto');
      localStorage.removeItem('eclipse_ui_alpha_light_prev');
    }
    lastEffectiveMode = mode;
  }
}

function relLuminance(hex) {
  const c = hexToRgb(hex);
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}

function contrastRatio(a, b) {
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}

function computeButtonColors(accentHex, mode) {
  const rgb = hexToRgb(accentHex);
  const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
  const s = hsl.s;
  const dark = mode === 'dark';
  let l = dark ? Math.min(74, Math.max(52, hsl.l)) : Math.min(46, Math.max(32, hsl.l));
  const lumAt = (L) => relLuminance(hslToHex(hsl.h, s, L));
  while (lumAt(l) > 0.42 && l > 26) l -= 1;
  const mid = lumAt(l);
  if (mid > 0.18 && mid < 0.23) {
    while (lumAt(l) > 0.18 && l > 22) l -= 1;
  }
  const bg = hslToHex(hsl.h, s, l);
  const bgLum = relLuminance(bg);
  const darkText = '#1B1B1F';
  const fg = contrastRatio(bgLum, 1) >= contrastRatio(bgLum, relLuminance(darkText)) ? '#FFFFFF' : darkText;
  const hover = hslToHex(hsl.h, s, Math.max(0, Math.min(100, l + (dark ? 5 : -5))));
  return { bg, fg, hover, bgLum };
}

function applyButtonAccent(hexColor, mode, mono) {
  const root = document.documentElement.style;
  root.setProperty('--btn-primary-bg', 'var(--md-sys-color-primary)');
  root.setProperty('--btn-primary-fg', 'var(--md-sys-color-on-primary)');
  root.setProperty('--btn-primary-hover', 'color-mix(in srgb, var(--md-sys-color-on-primary) 8%, var(--md-sys-color-primary))');
}

function applyTheme(hexColor, mode, intensity = state.themeIntensity, brightness = state.themeBrightness, accent2 = null, isAuto = false) {
  currentEffectiveMode = mode;
  generateM3Palette(hexColor, mode, intensity, brightness);
  const themeAccent = document.documentElement.style.getPropertyValue('--md-sys-color-primary')?.trim() || hexColor;
  applyButtonAccent(themeAccent, mode, intensity < 8);
  document.body.classList.toggle('theme-light', mode === 'light');
  document.body.classList.toggle('light', mode === 'light');
  document.body.setAttribute('data-theme', mode);
  document.body.classList.toggle('theme-dark', mode === 'dark');
  document.body.classList.toggle('intensity-zero', state.themeIntensity < 8);
  onEffectiveModeChanged(mode);
  if (el.themeSwatches) {
    el.themeSwatches.forEach(sw => sw.classList.toggle('active', !!(state.themeAccent && sw.dataset.color && sw.dataset.color.toLowerCase() === state.themeAccent.toLowerCase())));
  }
  if (el.customColorInput && document.activeElement !== el.customColorInput) el.customColorInput.value = hexColor;

  const rgb = hexToRgb(hexColor);
  const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
  if (el.sliderHue) el.sliderHue.value = hsl.h;
  if (el.valHue) el.valHue.textContent = hsl.h + '°';

  if (el.sliderIntensity) {
    el.sliderIntensity.disabled = isAuto;
    el.sliderIntensity.value = intensity;
    const parent = el.sliderIntensity.closest('.setting-item');
    if (parent) parent.classList.toggle('is-disabled', isAuto);
  }
  if (el.valIntensity) el.valIntensity.textContent = intensity + '%';

  if (el.sliderBrightness) {
    el.sliderBrightness.disabled = isAuto;
    el.sliderBrightness.value = brightness;
    const parent = el.sliderBrightness.closest('.setting-item');
    if (parent) parent.classList.toggle('is-disabled', isAuto);
  }
  if (el.valBrightness) el.valBrightness.textContent = brightness + '%';

  let resolvedAccent2 = accent2;
  if (!resolvedAccent2) {
    const h2 = (hsl.h + 40) % 360;
    resolvedAccent2 = hslToHex(h2, hsl.s, hsl.l);
  }

  const mono = intensity < 8;
  updateMeshGradient(mono ? '#9E9E9E' : hexColor, mono ? '#757575' : resolvedAccent2, mode);
  refreshCachedThemeColors();
  updateLikedCoverTint(hexColor, mode, intensity, brightness);
}

var _likedBaseImg = null;
var _likedBaseCanvas = null;
var _likedBaseData = null;
var _lastLikedTintKey = '';

function hslToRgbTuple(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = ((h % 360) + 360) % 360 / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r1 = 0, g1 = 0, b1 = 0;
  if (hp < 1) { r1 = c; g1 = x; }
  else if (hp < 2) { r1 = x; g1 = c; }
  else if (hp < 3) { g1 = c; b1 = x; }
  else if (hp < 4) { g1 = x; b1 = c; }
  else if (hp < 5) { r1 = x; b1 = c; }
  else { r1 = c; b1 = x; }
  const m = l - c / 2;
  return [
    Math.round(Math.max(0, Math.min(1, r1 + m)) * 255),
    Math.round(Math.max(0, Math.min(1, g1 + m)) * 255),
    Math.round(Math.max(0, Math.min(1, b1 + m)) * 255)
  ];
}

function updateLikedCoverTint(hexColor, mode, intensity, brightness) {
  const styleKey = state.paletteStyle || 'classic';
  const monoBr = typeof state.monoBrightness === 'number' ? state.monoBrightness : 100;
  const key = `${hexColor}_${mode}_${intensity}_${brightness}_${styleKey}_${monoBr}`;
  if (key === _lastLikedTintKey) return;

  const runTransform = () => {
    if (!_likedBaseData || !_likedBaseCanvas) return;
    _lastLikedTintKey = key;
    const rgb = hexToRgb(hexColor || '#5247d1');
    const targetHsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
    const style = PALETTE_STYLES[styleKey] || PALETTE_STYLES.classic;
    const intensityFactor = Math.max(0, Math.min(1, (typeof intensity === 'number' ? intensity : 85) / 100));
    const isMono = intensityFactor < 0.08 || (styleKey === 'neutral' && intensityFactor < 0.05);
    const brFactor = (typeof brightness === 'number' ? brightness : 20) / 100;
    const monoFactor = monoBr / 100;

    const w = _likedBaseCanvas.width;
    const h = _likedBaseCanvas.height;
    const ctx = _likedBaseCanvas.getContext('2d');
    const outImg = ctx.createImageData(w, h);
    const src = _likedBaseData;
    const dst = outImg.data;
    const baseRefHue = 252;
    const hueSpread = style.secHueShift ? 0.55 : 0.35;
    const satBoost = (style.priSatScale || 1.0) * intensityFactor * (0.65 + (targetHsl.s / 100) * 0.65);

    for (let i = 0; i < src.length; i += 4) {
      const r = src[i] / 255;
      const g = src[i + 1] / 255;
      const b = src[i + 2] / 255;
      const a = src[i + 3];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const d = max - min;
      const l = (max + min) / 2;
      const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
      let hDeg = 0;
      if (d > 0) {
        if (max === r) hDeg = ((g - b) / d + (g < b ? 6 : 0)) * 60;
        else if (max === g) hDeg = ((b - r) / d + 2) * 60;
        else hDeg = ((r - g) / d + 4) * 60;
      }

      const heartPreserve = Math.max(0, Math.min(1, Math.pow(Math.max(0, (l - 0.58) / 0.42), 1.35) * Math.pow(Math.max(0, 1 - s * 1.35), 1.2)));

      let newH, newS, newL;
      if (isMono) {
        newH = 0;
        newS = 0;
        const mScale = mode === 'light' ? (0.45 + monoFactor * 0.45) : (0.35 + monoFactor * 0.55);
        newL = Math.max(0.05, Math.min(0.96, l * mScale));
      } else {
        let deltaH = ((hDeg - baseRefHue + 540) % 360) - 180;
        newH = (targetHsl.h + deltaH * hueSpread + (style.secHueShift || 0) * (l * 0.25) + 360) % 360;
        newS = Math.max(0, Math.min(1, s * satBoost * 1.15));
        const lOffset = (brFactor - 0.3) * 0.14;
        newL = Math.max(0.04, Math.min(0.95, l + lOffset * (1 - Math.abs(2 * l - 1))));
      }

      const [tr, tg, tb] = hslToRgbTuple(newH, newS, newL);
      dst[i]     = Math.round(tr * (1 - heartPreserve) + src[i] * heartPreserve);
      dst[i + 1] = Math.round(tg * (1 - heartPreserve) + src[i + 1] * heartPreserve);
      dst[i + 2] = Math.round(tb * (1 - heartPreserve) + src[i + 2] * heartPreserve);
      dst[i + 3] = a;
    }

    ctx.putImageData(outImg, 0, 0);
    const dataUrl = _likedBaseCanvas.toDataURL('image/png');
    document.documentElement.style.setProperty('--liked-cover-img', `url("${dataUrl}")`);
    const heroHex = isMono
      ? hslToHex(0, 0, Math.round(25 + monoFactor * 35))
      : hslToHex(targetHsl.h, Math.min(100, Math.round(65 * intensityFactor * (style.priSatScale || 1))), mode === 'light' ? 52 : 42);
    document.documentElement.style.setProperty('--liked-hero-accent', heroHex);
  };

  if (_likedBaseData) {
    runTransform();
  } else if (!_likedBaseImg) {
    const initProceduralBase = () => {
      try {
        const size = 200;
        _likedBaseCanvas = document.createElement('canvas');
        _likedBaseCanvas.width = size;
        _likedBaseCanvas.height = size;
        const ctx = _likedBaseCanvas.getContext('2d');
        const grad = ctx.createLinearGradient(0, 0, size, size);
        grad.addColorStop(0, '#450af5');
        grad.addColorStop(1, '#8e8ee5');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, size, size);
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.moveTo(100, 142);
        ctx.bezierCurveTo(100, 142, 52, 112, 52, 80);
        ctx.bezierCurveTo(52, 62, 66, 50, 82, 50);
        ctx.bezierCurveTo(92, 50, 98, 56, 100, 62);
        ctx.bezierCurveTo(102, 56, 108, 50, 118, 50);
        ctx.bezierCurveTo(134, 50, 148, 62, 148, 80);
        ctx.bezierCurveTo(148, 112, 100, 142, 100, 142);
        ctx.closePath();
        ctx.fill();
        _likedBaseData = new Uint8ClampedArray(ctx.getImageData(0, 0, size, size).data);
        runTransform();
      } catch (_) {}
    };
    _likedBaseImg = new Image();
    _likedBaseImg.crossOrigin = 'Anonymous';
    _likedBaseImg.onload = () => {
      try {
        const size = 200;
        _likedBaseCanvas = document.createElement('canvas');
        _likedBaseCanvas.width = size;
        _likedBaseCanvas.height = size;
        const ctx = _likedBaseCanvas.getContext('2d');
        ctx.drawImage(_likedBaseImg, 0, 0, size, size);
        _likedBaseData = new Uint8ClampedArray(ctx.getImageData(0, 0, size, size).data);
        runTransform();
      } catch (_) {
        initProceduralBase();
      }
    };
    _likedBaseImg.onerror = initProceduralBase;
    _likedBaseImg.src = '../../assets/liked.png';
  }
}

function updateThemeFromState() {
  if (state.themeMode === 'auto') {
    const coverThumb = (state.currentTrack && (typeof getTrackThumbUrl === 'function' ? getTrackThumbUrl(state.currentTrack) : state.currentTrack.thumbnail)) || '';
    if (coverThumb) {
      analyzeCover(coverThumb).then(analysis => {
        if (state.themeMode !== 'auto') return;

        const derivedMode = analysis.luminance > 0.58 ? 'light' : 'dark';
        const derivedIntensity = Math.min(85, Math.max(20, Math.round(analysis.saturation * 100 * 0.9)));
        let derivedBrightness;
        if (derivedMode === 'dark') {
          derivedBrightness = Math.min(60, Math.max(40, Math.round(40 + (Math.min(0.58, analysis.luminance) / 0.58) * 20)));
        } else {
          const normLum = Math.max(0, Math.min(1, (analysis.luminance - 0.58) / (1 - 0.58)));
          derivedBrightness = Math.min(75, Math.max(55, Math.round(55 + normLum * 20)));
        }

        applyTheme(analysis.accent, derivedMode, derivedIntensity, derivedBrightness, analysis.accent2, true);
      });
    } else {
      applyTheme(state.themeAccent, 'dark', state.themeIntensity, state.themeBrightness, null, true);
    }
  } else {
    applyTheme(state.themeAccent, state.themeMode, state.themeIntensity, state.themeBrightness, null, false);
  }

  if (el.themeModeBtns) {
    el.themeModeBtns.forEach(btn => btn.classList.toggle('active', btn.dataset.themeMode === state.themeMode));
  }
}

function syncDocumentDirection(langCode) {
  const baseLang = String(langCode || 'en').toLowerCase().split(/[-_]/)[0];
  const isRtl = RTL_UI_LANGS.has(baseLang);
  document.documentElement.setAttribute('dir', isRtl ? 'rtl' : 'ltr');
  document.documentElement.setAttribute('lang', baseLang || 'en');
  document.body.classList.toggle('rtl-ui', isRtl);
}

function applyIconPack(pack) {
  if (!['material', 'sf', 'lucide', 'solar'].includes(pack)) pack = 'material';
  document.body.setAttribute('data-icon-pack', pack);

  const allSelectors = new Set([
    ...Object.keys(ICON_PACKS.sf),
    ...Object.keys(ICON_PACKS.lucide),
    ...Object.keys(ICON_PACKS.solar)
  ]);

  allSelectors.forEach(sel => {
    const elSvg = document.querySelector(sel);
    if (!elSvg) return;
    if (!elSvg.dataset.origSvg) {
      elSvg.dataset.origSvg = elSvg.innerHTML;
    }
    if (pack === 'material') {
      elSvg.innerHTML = elSvg.dataset.origSvg;
    } else {
      const packDef = ICON_PACKS[pack];
      if (packDef && packDef[sel]) {
        elSvg.innerHTML = packDef[sel];
      }
    }
  });

  const packLabels = {
    material: 'Google Symbols (Default)',
    sf: 'iOS / SF Symbols',
    lucide: 'Lucide Crisp',
    solar: 'Solar Duotone'
  };
  const labelEl = document.getElementById('icon-pack-label');
  if (labelEl) labelEl.textContent = packLabels[pack] || packLabels.material;

  const menu = document.getElementById('icon-pack-menu');
  if (menu) {
    menu.querySelectorAll('.m3-dropdown-option').forEach(opt => {
      opt.classList.toggle('selected', opt.dataset.value === pack);
    });
  }
}

function applySearchPos(pos) {
  if (!['left', 'middle', 'right'].includes(pos)) pos = 'middle';
  const topNav = document.querySelector('.top-nav');
  if (topNav) {
    topNav.classList.remove('search-pos-left', 'search-pos-middle', 'search-pos-right');
    topNav.classList.add(`search-pos-${pos}`);
  }
  const select = document.getElementById('select-search-pos');
  if (select) select.value = pos;
  const label = document.getElementById('search-pos-label');
  if (label) label.textContent = pos.charAt(0).toUpperCase() + pos.slice(1);
  const menu = document.getElementById('search-pos-menu');
  if (menu) {
    menu.querySelectorAll('.m3-dropdown-option').forEach(opt => {
      opt.classList.toggle('selected', opt.dataset.value === pos);
    });
  }
}

function applyBannerFit(fit) {
  const root = document.documentElement;
  const val = fit || 'zoom';
  if (val === 'fit') {
    root.style.setProperty('--banner-fit', 'contain');
    root.style.setProperty('--banner-object-fit', 'contain');
    root.style.setProperty('--banner-scale', 'none');
  } else if (val === 'stretch') {
    root.style.setProperty('--banner-fit', '100% 100%');
    root.style.setProperty('--banner-object-fit', 'fill');
    root.style.setProperty('--banner-scale', 'none');
  } else {
    root.style.setProperty('--banner-fit', 'cover');
    root.style.setProperty('--banner-object-fit', 'cover');
    root.style.setProperty('--banner-scale', 'scale(1.06)');
  }
}

function syncBgVideoPlayback() {
  const v = document.querySelector('#custom-bg video');
  if (!v) return;
  const hidden = document.hidden || document.body.classList.contains('perf');
  if (hidden) v.pause(); else v.play().catch(() => {});
}

function updateCustomBg() {
  const bgUrl = localStorage.getItem('eclipse_bg_url') || '';
  const opacityVal = parseInt(localStorage.getItem('eclipse_bg_opacity') ?? '100', 10);
  const blurVal = parseInt(localStorage.getItem('eclipse_bg_blur') ?? '0', 10);
  const isVideo = /\.(mp4|webm)($|\?)/i.test(bgUrl);
  document.body.classList.toggle('has-video-bg', isVideo && !!bgUrl);

  const sliderBgOpacity = document.getElementById('slider-bg-opacity');
  const valBgOpacity = document.getElementById('val-bg-opacity');
  const sliderBgBlur = document.getElementById('slider-bg-blur');
  const valBgBlur = document.getElementById('val-bg-blur');
  const btnRemoveCustomBg = document.getElementById('btn-remove-custom-bg');

  if (sliderBgOpacity) sliderBgOpacity.value = opacityVal;
  if (valBgOpacity) valBgOpacity.textContent = `${opacityVal}%`;
  if (sliderBgBlur) sliderBgBlur.value = blurVal;
  if (valBgBlur) valBgBlur.textContent = `${blurVal}px`;

  const customBg = document.getElementById('custom-bg');
  if (!customBg) return;

  if (!bgUrl) {
    customBg.innerHTML = '';
    customBg.style.display = 'none';
    if (btnRemoveCustomBg) btnRemoveCustomBg.disabled = true;
    syncBgVideoPlayback();
    return;
  }

  if (btnRemoveCustomBg) btnRemoveCustomBg.disabled = false;
  customBg.style.display = 'block';
  customBg.style.opacity = (opacityVal / 100).toString();
  customBg.style.filter = 'none';

  const currentMedia = customBg.firstElementChild;
  const tag = isVideo ? 'VIDEO' : 'IMG';

  if (!currentMedia || currentMedia.tagName !== tag || currentMedia.src !== bgUrl) {
    customBg.innerHTML = '';
    if (isVideo) {
      const vid = document.createElement('video');
      vid.src = bgUrl;
      vid.preload = 'auto';
      vid.autoplay = true;
      vid.loop = true;
      vid.muted = true;
      vid.playsInline = true;
      vid.disablePictureInPicture = true;
      vid.setAttribute('disableRemotePlayback', '');
      vid.addEventListener('loadedmetadata', () => {
        if (vid.videoWidth * vid.videoHeight > 1920 * 1080 * 1.2) {
          showToast('This background video is larger than 1080p and may stutter. A 1080p file plays smoother.', 'info');
        }
      }, { once: true });
      vid.play().catch(() => {});
      customBg.appendChild(vid);
    } else {
      const img = document.createElement('img');
      img.src = bgUrl;
      customBg.appendChild(img);
    }
  }

  const media = customBg.firstElementChild;
  if (media) {
    const q = blurVal > 0 ? 4 : 1;
    media.style.width = `${100 / q}%`;
    media.style.height = `${100 / q}%`;
    media.style.transformOrigin = '0 0';
    media.style.transform = q > 1 ? `scale(${q * 1.06}) translate(-3%, -3%)` : 'none';
    media.style.filter = blurVal > 0 ? `blur(${blurVal / q}px)` : 'none';
  }
  syncBgVideoPlayback();
}

function currentUiAlpha() {
  return Number(document.getElementById('slider-ui-alpha').value);
}

function setUiAlphaViaSlider(v) {
  const s = document.getElementById('slider-ui-alpha');
  if (!s) return;
  s.value = v;
  s.dispatchEvent(new Event('input', { bubbles: true }));
}

function backgroundActive() {
  return !!localStorage.getItem('eclipse_bg_url') || getAdv('cover_bg', true);
}

function onBackgroundChanged(kind, enabled) {
  if (document.body.classList.contains('light') || document.body.getAttribute('data-theme') === 'light') return;
  if (!getAdv('ui_alpha_auto', true)) return;
  if (enabled) {
    const now = currentUiAlpha();
    if (now > 50) {
      localStorage.setItem('eclipse_ui_alpha_prev', String(now));
      setUiAlphaViaSlider(50);
      localStorage.setItem('eclipse_ui_alpha_auto', '50');
    }
  } else if (!backgroundActive()) {
    const auto = localStorage.getItem('eclipse_ui_alpha_auto'), prev = localStorage.getItem('eclipse_ui_alpha_prev');
    if (auto !== null && prev !== null && currentUiAlpha() === Number(auto)) setUiAlphaViaSlider(Number(prev));
    localStorage.removeItem('eclipse_ui_alpha_auto');
    localStorage.removeItem('eclipse_ui_alpha_prev');
  }
}

var DEFAULT_MESH_CFG = {
  p1: { x: 20, y: 0 },
  p2: { x: 85, y: 5 },
  speed: 0,
  blur: 0
};

var meshCfg = { ...DEFAULT_MESH_CFG };

function applyMeshCfg(cfg, save = true) {
  meshCfg = cfg;
  const root = document.documentElement;
  root.style.setProperty('--mesh-p1x', `${cfg.p1.x}%`);
  root.style.setProperty('--mesh-p1y', `${cfg.p1.y}%`);
  root.style.setProperty('--mesh-p2x', `${cfg.p2.x}%`);
  root.style.setProperty('--mesh-p2y', `${cfg.p2.y}%`);
  const speedDur = cfg.speed > 0 ? `${(120 / (cfg.speed * 0.2 + 1)).toFixed(1)}s` : '0s';
  root.style.setProperty('--mesh-speed', speedDur);
  root.style.setProperty('--mesh-blur', `${cfg.blur}px`);

  const d1 = document.getElementById('mesh-dot-1');
  const d2 = document.getElementById('mesh-dot-2');
  if (d1) {
    d1.style.left = `${cfg.p1.x}%`;
    d1.style.top = `${cfg.p1.y}%`;
  }
  if (d2) {
    d2.style.left = `${cfg.p2.x}%`;
    d2.style.top = `${cfg.p2.y}%`;
  }

  const slSpeed = document.getElementById('slider-mesh-speed');
  const vlSpeed = document.getElementById('val-mesh-speed');
  if (slSpeed) slSpeed.value = cfg.speed;
  if (vlSpeed) vlSpeed.textContent = cfg.speed === 0 ? '0 (static)' : `${cfg.speed}`;

  const slBlur = document.getElementById('slider-mesh-blur');
  const vlBlur = document.getElementById('val-mesh-blur');
  if (slBlur) slBlur.value = cfg.blur;
  if (vlBlur) vlBlur.textContent = `${cfg.blur}px`;

  if (save) {
    localStorage.setItem('eclipse_mesh_cfg', JSON.stringify(cfg));
  }
}

function openMeshModal() {
  const meshModal = document.getElementById('mesh-customizer-modal');
  if (!meshModal) return;
  const card = meshModal.querySelector('.settings-card') || meshModal;
  if (card) {
    card.classList.remove('liquid-surface', 'liquid-x', 'liquid-y', 'liquid-open', 'liquid-closing');
  }
  const previewBg = document.getElementById('mesh-preview-bg');
  const meshA = document.getElementById('bg-mesh-a');
  const meshB = document.getElementById('bg-mesh-b');
  const curBg = (activeMeshLayer === 'a' ? meshB : meshA)?.style.background || meshA?.style.background;
  if (previewBg && curBg) previewBg.style.background = curBg;

  applyMeshCfg(meshCfg, false);
  openModal(meshModal);
}

function closeMeshModal() {
  const meshModal = document.getElementById('mesh-customizer-modal');
  if (!meshModal) return;
  const card = meshModal.querySelector('.settings-card') || meshModal;
  if (card) {
    card.classList.remove('liquid-surface', 'liquid-x', 'liquid-y', 'liquid-open', 'liquid-closing');
  }
  closeModal(meshModal);
}

function attachDotDrag(dotEl, key) {
  const previewBox = document.getElementById('mesh-preview-box');
  if (!dotEl || !previewBox) return;
  let isDragging = false;

  dotEl.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    isDragging = true;
    dotEl.setPointerCapture(e.pointerId);
    dotEl.style.cursor = 'grabbing';
    dotEl.focus();
  });

  dotEl.addEventListener('pointermove', (e) => {
    if (!isDragging) return;
    const rect = previewBox.getBoundingClientRect();
    const x = Math.max(0, Math.min(100, Math.round(((e.clientX - rect.left) / rect.width) * 100)));
    const y = Math.max(0, Math.min(100, Math.round(((e.clientY - rect.top) / rect.height) * 100)));
    meshCfg[key] = { x, y };
    applyMeshCfg(meshCfg, true);
  });

  const endDrag = (e) => {
    if (isDragging) {
      isDragging = false;
      try { dotEl.releasePointerCapture(e.pointerId); } catch (_) {}
      dotEl.style.cursor = 'grab';
    }
  };
  dotEl.addEventListener('pointerup', endDrag);
  dotEl.addEventListener('pointercancel', endDrag);

  dotEl.addEventListener('keydown', (e) => {
    let dx = 0, dy = 0;
    if (e.key === 'ArrowLeft') dx = -1;
    else if (e.key === 'ArrowRight') dx = 1;
    else if (e.key === 'ArrowUp') dy = -1;
    else if (e.key === 'ArrowDown') dy = 1;
    else return;
    e.preventDefault();
    const cur = meshCfg[key];
    const x = Math.max(0, Math.min(100, cur.x + dx));
    const y = Math.max(0, Math.min(100, cur.y + dy));
    meshCfg[key] = { x, y };
    applyMeshCfg(meshCfg, true);
  });
}

function updateShowLocalUI(animate = false) {
  const btnShowLocal = document.getElementById('btn-show-local');
  const show = localStorage.getItem('eclipse_show_local') !== 'false';
  if (el.navLocal) el.navLocal.classList.toggle('nav-collapsed', !show);
  if (btnShowLocal) btnShowLocal.classList.toggle('active', show);
  if (!show && state.currentView === 'local') {
    switchView('discover');
  }
  if (animate) {
    const t0 = performance.now();
    (function f() {
      refreshStacks();
      updateNavIndicator(false);
      if (performance.now() - t0 < 350) requestAnimationFrame(f);
    })();
  } else {
    refreshStacks();
    updateNavIndicator(false);
  }
}
