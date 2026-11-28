// src/renderer/modules/eq-editor.js
// Audio settings, HQ routing, loudness normalization, presets, and 10-band EQ editor.

let levelAvgDb = -120;
function normalizeEnabled() { return localStorage.getItem('eclipse_audio_normalize') === '1'; }
function resetLevelWatcher() { levelAvgDb = -120; if (audioEngine && audioEngine.setNormalizeGainDb) audioEngine.setNormalizeGainDb(0); }
setInterval(() => {
  const audio = typeof el !== 'undefined' ? el.nativeAudio : null;
  if (typeof audioEngine === 'undefined' || !audioEngine || !audioEngine.getLevelDb || !audio || audio.paused || typeof state === 'undefined' || !state.isPlaying) return;
  const db = audioEngine.getLevelDb();
  if (normalizeEnabled()) {
    if (db > -50) {
      levelAvgDb = levelAvgDb <= -120 ? db : levelAvgDb + (db - levelAvgDb) * 0.05;
      const gainDb = Math.max(-9, Math.min(9, -17 - levelAvgDb));
      audioEngine.setNormalizeGainDb(gainDb);
    }
  } else if (levelAvgDb > -120) {
    resetLevelWatcher();
  }
}, 100);

function initAudioContext() {
  audioEngine.init(el.nativeAudio);

  if (audioEngine.ctx && audioEngine.ctx.state === 'suspended') {
    audioEngine.ctx.resume().catch(() => {});
  }

  audioEngine.setHqEnabled(state.hqEnabled);
  audioEngine.setHqSettings(state.hqSettings);
  audioEngine.setAudioSettings(state.audioSettings);
  audioEngine.setVolume(state.volume, state.isMuted);

  startVisualizers();
}

function updateHqRouting() {
  audioEngine.setHqEnabled(state.hqEnabled);
  if (el.btnToggleHqAudio) el.btnToggleHqAudio.classList.toggle('active', !!state.hqEnabled);
  if (el.hqPanelWrapper) el.hqPanelWrapper.classList.toggle('expanded', !!state.hqEnabled);
  if (el.hqEnhancerCard) el.hqEnhancerCard.classList.toggle('is-expanded', !!state.hqEnabled);
}

let soundSettingsSaveTimer = null;
function persistSoundSettings() {
  if (!soundPersistenceEnabled) return;
  if (soundSettingsSaveTimer) clearTimeout(soundSettingsSaveTimer);
  soundSettingsSaveTimer = setTimeout(() => {
    soundSettingsSaveTimer = null;
    try {
      localStorage.setItem('eclipse_hq_enabled', state.hqEnabled ? '1' : '0');
      localStorage.setItem('eclipse_hq_settings', JSON.stringify(state.hqSettings));
      localStorage.setItem('eclipse_audio_settings', JSON.stringify(state.audioSettings));
      localStorage.setItem('eclipse_active_preset', state.activePresetId || '');
    } catch (e) {
      console.warn('Failed to save sound settings', e);
    }
  }, 300);
}

function applyHqSettings() {
  updateHqRouting();
  audioEngine.setHqSettings(state.hqSettings);
  persistSoundSettings();
}

function applyAudioSettings() {
  audioEngine.setAudioSettings(state.audioSettings);
  audioEngine.setVolume(state.volume, state.isMuted);
  audioEngine.applySettings(el.nativeAudio);
  persistSoundSettings();

  if (el.settingsModifiedDot) {
    if (audioEngine.isModified()) {
      el.settingsModifiedDot.classList.remove('hidden');
    } else {
      el.settingsModifiedDot.classList.add('hidden');
    }
  }
}

function getAllPresets() {
  return [...defaultPresets, ...state.customPresets];
}

function renderPresets() {
  if (!el.presetsContainer) return;
  el.presetsContainer.innerHTML = '';
  const all = getAllPresets();
  all.forEach(p => {
    const chip = document.createElement('div');
    chip.className = 'preset-chip';
    if (state.activePresetId === p.id) chip.classList.add('active');

    const isCustom = p.id.startsWith('custom_');
    chip.dataset.isCustom = isCustom ? 'true' : 'false';
    chip.dataset.presetId = p.id;

    chip.innerHTML = `
      <span class="preset-name-label">${escapeHtml(p.name)}</span>
      ${isCustom ? `
        <div class="preset-actions">
          <button type="button" class="preset-btn-action btn-rename-p" title="Rename" aria-label="Rename preset">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>
          </button>
          <button type="button" class="preset-btn-action btn-delete-p" title="Delete" aria-label="Delete preset">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>` : ''}
    `;

    if (isCustom) {
      const btnRename = chip.querySelector('.btn-rename-p');
      const btnDelete = chip.querySelector('.btn-delete-p');
      if (btnRename) {
        btnRename.addEventListener('click', (e) => {
          e.stopPropagation();
          openRenamePresetModal(p);
        });
      }
      if (btnDelete) {
        btnDelete.addEventListener('click', (e) => {
          e.stopPropagation();
          openDeletePresetConfirm(p);
        });
      }
    }

    chip.addEventListener('click', (e) => {
      if (e.target.closest('.btn-delete-p') || e.target.closest('.btn-rename-p')) return;
      applyPreset(p);
    });

    el.presetsContainer.appendChild(chip);
  });
  updatePresetsFade();
}

function updateFade(targetEl) {
  if (!targetEl) return;
  targetEl.classList.toggle('fade-top', targetEl.scrollTop > 4);
  targetEl.classList.toggle('fade-bottom', targetEl.scrollTop + targetEl.clientHeight < targetEl.scrollHeight - 4);
}
window.updateFade = updateFade;

function updatePresetsFade() {
  updateFade(document.getElementById('presets-container'));
}

let activeTweenRaf = null;
function tweenSettings(from, to, ms, apply) {
  if (activeTweenRaf) cancelAnimationFrame(activeTweenRaf);
  const t0 = performance.now();
  (function step(t) {
    const k = Math.min(1, (t - t0) / ms), e = k * k * (3 - 2 * k);
    const cur = {};
    for (const key in to) {
      if (typeof to[key] === 'number') cur[key] = from[key] + (to[key] - from[key]) * e;
      else if (Array.isArray(to[key])) {
        cur[key] = to[key].map((v, idx) => (from[key]?.[idx] ?? 0) + (v - (from[key]?.[idx] ?? 0)) * e);
      } else if (typeof to[key] === 'object' && to[key] !== null) {
        cur[key] = { ...from[key] };
        for (const subKey in to[key]) cur[key][subKey] = (from[key]?.[subKey] ?? 0) + (to[key][subKey] - (from[key]?.[subKey] ?? 0)) * e;
      } else cur[key] = to[key];
    }
    apply(cur);
    if (k < 1) activeTweenRaf = requestAnimationFrame(step);
    else activeTweenRaf = null;
  })(t0);
}

function applyPreset(preset) {
  const normalized = normalizePreset(preset);
  if (!normalized) return;
  state.activePresetId = normalized.id;
  initAudioContext();
  renderPresets();
  if (activeTweenRaf) { cancelAnimationFrame(activeTweenRaf); activeTweenRaf = null; }
  if (localStorage.getItem('eclipse_smooth_presets') === 'false') {
    state.audioSettings = { ...normalized.settings };
    syncSettingsSlidersToState();
    applyAudioSettings();
    return;
  }
  const fromAudio = JSON.parse(JSON.stringify(state.audioSettings));
  const toAudio = JSON.parse(JSON.stringify(normalized.settings));
  tweenSettings(fromAudio, toAudio, 400, (cur) => {
    state.audioSettings = { ...state.audioSettings, ...cur };
    syncSettingsSlidersToState();
    applyAudioSettings();
  });
}

function saveCustomPreset(name) {
  if (!name || !name.trim()) return;
  const newPreset = {
    id: 'custom_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    name: name.trim(),
    settings: {
      ...state.audioSettings,
      eq: { ...(state.audioSettings.eq || {}) },
      eqBands: [...(state.audioSettings.eqBands || [0, 0, 0, 0, 0, 0, 0, 0, 0, 0])]
    }
  };
  state.customPresets.push(newPreset);
  state.activePresetId = newPreset.id;
  localStorage.setItem('devsize_custom_presets', JSON.stringify(state.customPresets));
  renderPresets();
  persistSoundSettings();
}

function openRenamePresetModal(preset) {
  state.presetToRenameId = preset.id;
  if (el.renamePresetName) el.renamePresetName.value = preset.name;
  if (el.renamePresetModal) openModal(el.renamePresetModal);
  if (el.renamePresetName) el.renamePresetName.focus();
}

function renameCustomPreset(id, newName) {
  if (!newName || !newName.trim()) return;
  const p = state.customPresets.find(x => x.id === id);
  if (p) {
    p.name = newName.trim();
    localStorage.setItem('devsize_custom_presets', JSON.stringify(state.customPresets));
    renderPresets();
  }
}

function deleteCustomPreset(id) {
  state.customPresets = state.customPresets.filter(p => p.id !== id);
  if (state.activePresetId === id) state.activePresetId = 'p_default';
  localStorage.setItem('devsize_custom_presets', JSON.stringify(state.customPresets));
  renderPresets();
  persistSoundSettings();
}

function openDeletePresetConfirm(preset) {
  state.presetToDeleteId = preset.id;
  const msg = document.getElementById('delete-preset-msg');
  if (msg) msg.textContent = `Delete preset "${preset.name}"?`;
  const modal = document.getElementById('delete-preset-modal');
  if (modal) openModal(modal);
}

function init10BandEqUI() {
  if (!el.eqBands) return;

  el.eqBands.innerHTML = '';
  const currentBands = state.audioSettings.eqBands || [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  EQ_BAND_LABELS.forEach((freqLabel, i) => {
    const col = document.createElement('div');
    col.className = 'eq-band';

    const valSpan = document.createElement('span');
    valSpan.className = 'eq-band-val';
    const initialVal = currentBands[i] !== undefined ? currentBands[i] : 0;
    valSpan.textContent = `${initialVal > 0 ? '+' : ''}${initialVal} dB`;

    const sliderBox = document.createElement('div');
    sliderBox.className = 'eq-slider-box';

    const input = document.createElement('input');
    input.type = 'range';
    input.className = 'eq-band-range';
    input.min = '-12';
    input.max = '12';
    input.step = '1';
    input.value = String(initialVal);
    sliderBox.appendChild(input);

    const freqSpan = document.createElement('span');
    freqSpan.className = 'eq-band-freq';
    freqSpan.textContent = freqLabel;

    input.addEventListener('input', (e) => {
      initAudioContext();
      const val = parseInt(e.target.value, 10);
      if (!Array.isArray(state.audioSettings.eqBands)) {
        state.audioSettings.eqBands = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
      }
      state.audioSettings.eqBands[i] = val;
      valSpan.textContent = `${val > 0 ? '+' : ''}${val} dB`;
      state.activePresetId = null;
      applyAudioSettings();
      renderPresets();
    });

    input.addEventListener('dblclick', () => {
      initAudioContext();
      input.value = '0';
      if (!Array.isArray(state.audioSettings.eqBands)) {
        state.audioSettings.eqBands = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
      }
      state.audioSettings.eqBands[i] = 0;
      valSpan.textContent = '0 dB';
      state.activePresetId = null;
      applyAudioSettings();
      renderPresets();
    });

    col.appendChild(valSpan);
    col.appendChild(sliderBox);
    col.appendChild(freqSpan);
    el.eqBands.appendChild(col);
  });

  if (el.btnResetEqBands) {
    el.btnResetEqBands.addEventListener('click', () => {
      initAudioContext();
      state.audioSettings.eqBands = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
      const inputs = el.eqBands.querySelectorAll('.eq-band-range');
      const valLabels = el.eqBands.querySelectorAll('.eq-band-val');
      inputs.forEach((input, i) => {
        input.value = '0';
        if (valLabels[i]) valLabels[i].textContent = '0 dB';
      });
      state.activePresetId = null;
      applyAudioSettings();
      renderPresets();
    });
  }
}
