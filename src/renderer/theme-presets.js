/**
 * App Theme Color Presets & Waveform Audio Styles (SimpMusic v2.6.0 parity)
 */
const ECLIPSE_COLOR_PRESETS = [
  { id: 'eclipse_neon', name: 'Eclipse Neon (Default)', primary: '#a855f7', glow: 'rgba(168, 85, 247, 0.45)' },
  { id: 'spotify_green', name: 'Spotify Green', primary: '#1ed760', glow: 'rgba(30, 215, 96, 0.45)' },
  { id: 'soundcloud_orange', name: 'SoundCloud Orange', primary: '#ff5500', glow: 'rgba(255, 85, 0, 0.45)' },
  { id: 'apple_music_red', name: 'Apple Music Red', primary: '#fa2d48', glow: 'rgba(250, 45, 72, 0.45)' },
  { id: 'cyber_cyan', name: 'Cyber Cyan', primary: '#06b6d4', glow: 'rgba(6, 182, 212, 0.45)' }
];

function applyThemePreset(presetId) {
  const preset = ECLIPSE_COLOR_PRESETS.find(p => p.id === presetId) || ECLIPSE_COLOR_PRESETS[0];
  if (typeof document !== 'undefined') {
    document.documentElement.style.setProperty('--md-sys-color-primary', preset.primary);
    document.documentElement.style.setProperty('--accent-glow', preset.glow);
    document.documentElement.style.setProperty('--playlist-accent-color', preset.primary);
    localStorage.setItem('eclipse_theme_preset', preset.id);
  }
  return preset;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ECLIPSE_COLOR_PRESETS, applyThemePreset };
} else {
  window.ECLIPSE_COLOR_PRESETS = ECLIPSE_COLOR_PRESETS;
  window.applyThemePreset = applyThemePreset;
}
