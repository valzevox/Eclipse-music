# Eclipse PC v1.5.0 Release Notes

## Summary
Eclipse PC version 1.5.0 introduces **AutoMix DJ** — an intelligent DJ mixing engine featuring beat-aligned transitions, dual-deck WebAudio graph, Camelot wheel harmonic mixing, and frequency filter sweeps — alongside unified UI tokens and the **Dynamic Studio Palettes** design system.

---

## What's New

### 🎧 AutoMix DJ Engine (NEW)
- **Beat-Aligned Transitions & Dual-Deck Graph**: Dynamic WebAudio dual-deck graph architecture executing seamless crossfades aligned to track tempo (BPM) and beat grids.
- **Harmonic Blending & Camelot Compatibility**: Compatible key analysis prevents harmonic dissonance during transitions.
- **DJ Filter Sweeps**: Automatic resonant high-pass filter sweep on incoming tracks and low-pass exit filter for professional club-style blends.
- **Smart Song Suppression**: Automatic detection and bypass for gapless live albums and multi-part symphonic suites to preserve artistic intent.
- **Playbar DJ Toggle & Settings Panel**: Ergonomic playbar action pill harmonized with Shuffle/Repeat controls, complete with dedicated settings in Audio Settings.

### 🎨 Dynamic Studio Palettes & Visual Tokens
- **6 Signature Themes**: Unified palette presets across PC and Mobile (`eclipse_neon`, `emerald_flow`, `solar_amber`, `crimson_pulse`, `cyber_cyan`, and the new `vice_sunset`).
- **Dynamic CSS Color Mixing**: Fully migrated UI action states and highlights from static hex values to `var(--md-sys-color-primary)` and modern CSS `color-mix()`.
- **Feature Identity Badges**: Integrated gradient neon `NEW` indicators highlighting newly unlocked capabilities.

### 🛡️ System & Stability Hardening
- **Zero TOCTOU IPC Security**: Clean, validated IPC handlers preventing silent catch exceptions.
- **Memory Footprint Optimization**: WebAudio buffer clamping and lazy-loaded audio graph nodes.
