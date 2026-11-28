'use strict';

let cachedTrackWidth = 0;
let cachedTrackHeight = 40;
let cachedTvkWidth = 0;
let cachedTvkHeight = 0;
let tvkSmoothedHeights = null;
let barBgSmoothedHeights = null;
let vizPrev = null;

function vizSettings() {
  const smooth = Math.min(0.95, Math.max(0, (parseInt(localStorage.getItem('eclipse_viz_smooth') || '55', 10)) / 100));
  const sens = Math.min(3, Math.max(0, (parseInt(localStorage.getItem('eclipse_viz_sens') || '100', 10)) / 100));
  return { smooth, sens };
}

var reducedMotionMql = (typeof window.matchMedia === 'function')
  ? window.matchMedia('(prefers-reduced-motion: reduce)')
  : null;
var prefersReducedMotion = !!(reducedMotionMql && reducedMotionMql.matches);
var isReducedMotionActive = () => document.body.classList.contains('perf') || prefersReducedMotion;

function updateAutomixRainbowBlend(nowMs) {
  const isAutomixingNow = document.body.classList.contains('is-automixing');
  const isReducedNow = isReducedMotionActive();
  if (typeof window._automixRainbowBlend !== 'number') window._automixRainbowBlend = 0;
  if (isReducedNow) {
    window._automixRainbowBlend = 0;
    window._automixRainbowLastMs = 0;
    return 0;
  }
  const targetBlend = isAutomixingNow ? 1 : 0;
  const dtMs = window._automixRainbowLastMs ? Math.min(100, nowMs - window._automixRainbowLastMs) : 16;
  window._automixRainbowLastMs = nowMs;
  if (window._automixRainbowBlend !== targetBlend) {
    const stepBlend = dtMs / 300;
    window._automixRainbowBlend = targetBlend > window._automixRainbowBlend
      ? Math.min(1, window._automixRainbowBlend + stepBlend)
      : Math.max(0, window._automixRainbowBlend - stepBlend);
  }
  return window._automixRainbowBlend;
}

function strokeSeekbarWave(ctx, { baseColor, rainbowBlend, nowMs, isReduced, isAutomixing, reducedAccentColor }) {
  if (rainbowBlend > 0.01 && !isReduced) {
    if (rainbowBlend < 0.99) {
      ctx.strokeStyle = baseColor;
      ctx.stroke();
    }
    const hue = ((nowMs % 1000) / 1000) * 360;
    ctx.save();
    ctx.globalAlpha = rainbowBlend;
    ctx.strokeStyle = `hsl(${hue.toFixed(1)}, 100%, 62%)`;
    ctx.stroke();
    ctx.restore();
  } else if (isAutomixing && isReduced) {
    ctx.strokeStyle = reducedAccentColor || baseColor;
    ctx.stroke();
  } else {
    ctx.strokeStyle = baseColor;
    ctx.stroke();
  }
}

function syncTvkTimeDisplay(curText, durText) {
  if (curText !== undefined) {
    if (el.tvkTimeCurrent && el.tvkTimeCurrent.textContent !== curText) el.tvkTimeCurrent.textContent = curText;
    const curDisp = document.getElementById('tvk-time-current-display');
    if (curDisp && curDisp.textContent !== curText) curDisp.textContent = curText;
  }
  if (durText !== undefined) {
    if (el.tvkTimeDuration && el.tvkTimeDuration.textContent !== durText) el.tvkTimeDuration.textContent = durText;
    const durDisp = document.getElementById('tvk-time-duration-display');
    if (durDisp && durDisp.textContent !== durText) durDisp.textContent = durText;
  }
}

function resizeCanvases() {
  const dpr = window.devicePixelRatio || 1;
  if (el.scrubberTrack) {
    let scrubberCanvas = document.getElementById('squiggly-canvas');
    if (!scrubberCanvas) {
      scrubberCanvas = document.createElement('canvas');
      scrubberCanvas.id = 'squiggly-canvas';
      scrubberCanvas.className = 'squiggly-canvas';
      el.scrubberTrack.appendChild(scrubberCanvas);
    }
    const rect = el.scrubberTrack.getBoundingClientRect();
    cachedTrackWidth = rect.width;
    cachedTrackHeight = Math.max(40, rect.height);
    hasDrawnPausedFrame = false;
    scrubberCanvas.width = rect.width * dpr;
    scrubberCanvas.height = Math.max(40, rect.height) * dpr;
    scrubberCanvas.style.width = `${rect.width}px`;
    scrubberCanvas.style.height = `${Math.max(40, rect.height)}px`;
    const ctx = scrubberCanvas.getContext('2d');
    ctx.resetTransform();
    ctx.scale(dpr, dpr);
  }
  if (el.visualizerCanvas) {
    el.visualizerCanvas.width = 60 * dpr;
    el.visualizerCanvas.height = 24 * dpr;
    el.visualizerCanvas.style.width = '60px';
    el.visualizerCanvas.style.height = '24px';
    const ctx = el.visualizerCanvas.getContext('2d');
    ctx.resetTransform();
    ctx.scale(dpr, dpr);
  }
  const tvkCanvas = document.getElementById('tvk-visualizer-canvas');
  if (tvkCanvas) {
    const cssW = Math.min(760, Math.max(360, Math.round(window.innerWidth * 0.64)));
    const cssH = Math.min(84, Math.max(52, Math.round(window.innerHeight * 0.085)));
    cachedTvkWidth = cssW;
    cachedTvkHeight = cssH;
    tvkCanvas.width = Math.round(cssW * dpr);
    tvkCanvas.height = Math.round(cssH * dpr);
    tvkCanvas.style.width = `${cssW}px`;
    tvkCanvas.style.height = `${cssH}px`;
    const ctx = tvkCanvas.getContext('2d');
    if (ctx) {
      ctx.resetTransform();
      ctx.scale(dpr, dpr);
    }
  }
  const barBgCanvas = document.getElementById('bottom-visualizer') || document.getElementById('playbar-bg-visualizer');
  if (barBgCanvas && el.playbar) {
    const bw = Math.max(200, el.playbar.clientWidth - 32);
    const bh = 36;
    barBgCanvas.width = Math.round(bw * dpr);
    barBgCanvas.height = Math.round(bh * dpr);
    const bctx = barBgCanvas.getContext('2d');
    if (bctx) { bctx.resetTransform(); bctx.scale(dpr, dpr); }
  }
  const tvkTrack = document.getElementById('tvk-scrubber-track') || document.getElementById('tvk-progress-row') || document.querySelector('.tvk-progress-row');
  if (tvkTrack) {
    let tvkSquiggly = document.getElementById('tvk-squiggly-canvas');
    if (!tvkSquiggly) {
      tvkSquiggly = document.createElement('canvas');
      tvkSquiggly.id = 'tvk-squiggly-canvas';
      tvkSquiggly.className = 'tvk-squiggly-canvas';
      tvkTrack.appendChild(tvkSquiggly);
    } else if (tvkSquiggly.parentElement !== tvkTrack) {
      tvkTrack.appendChild(tvkSquiggly);
    }
    tvkSquiggly.style.width = '';
    tvkSquiggly.style.height = '';
    const rect = tvkTrack.getBoundingClientRect();
    const rw = rect.width || tvkTrack.clientWidth || 0;
    const rh = 36;
    if (rw > 0) {
      const targetW = Math.round(rw * dpr);
      const targetH = Math.round(rh * dpr);
      if (tvkSquiggly.width !== targetW || tvkSquiggly.height !== targetH) {
        tvkSquiggly.width = targetW;
        tvkSquiggly.height = targetH;
      }
      const tctx = tvkSquiggly.getContext('2d');
      if (tctx) {
        tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
    }
    if (!tvkTrack._tvkResizeObserver && typeof ResizeObserver === 'function') {
      tvkTrack._tvkResizeObserver = new ResizeObserver(() => {
        if (state.isTvKaraokeOpen) resizeCanvases();
      });
      tvkTrack._tvkResizeObserver.observe(tvkTrack);
    }
  }
}

var smoothAmplitude = 0;
var smoothPhase = 0;
var scrubPhase = 0;
var scrubProgress = 0;
var scrubPrevKnobX = null;
var scrubKnobAnim = 0;
var scrubLastTime = 0;
var lastDisplayedSec = -1;
var lastTimeupdateSec = -1;

function stopVisualizers() {
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
  const miniCanvas = el.visualizerCanvas;
  const miniCtx = miniCanvas ? miniCanvas.getContext('2d') : null;
  if (miniCtx && miniCanvas) miniCtx.clearRect(0, 0, 60, 24);
  const tvkCanvas = document.getElementById('tvk-visualizer-canvas');
  const tvkCtx = tvkCanvas ? tvkCanvas.getContext('2d') : null;
  if (tvkCtx && tvkCanvas) {
    const w = cachedTvkWidth || (tvkCanvas.width / (window.devicePixelRatio || 1)) || 500;
    const h = cachedTvkHeight || (tvkCanvas.height / (window.devicePixelRatio || 1)) || 64;
    tvkCtx.clearRect(0, 0, w, h);
  }
  if (audioEngine && audioEngine.setAnalyserEnabled) {
    audioEngine.setAnalyserEnabled(false);
  }
  if (el.coverContainer && el.coverContainer.style.transform) {
    el.coverContainer.style.transform = '';
  }
}

function isVizConnectedMode() {
  return localStorage.getItem('eclipse_viz_connected') === '1';
}

var liquidWavePhase = 0;
var liquidSpringNodes = new Float32Array(36);
var liquidVelocityNodes = new Float32Array(36);

function drawConnectedLiquidWave(ctx, w, h, heights, color) {
  const rawN = heights.length;
  if (!rawN || w <= 0 || h <= 0) return;
  liquidWavePhase += 0.075;

  const count = 34;
  if (!ctx.canvas._springNodes || ctx.canvas._springNodes.length !== count) {
    ctx.canvas._springNodes = new Float32Array(count);
  }
  const springNodes = ctx.canvas._springNodes;

  let peakEnergy = 0;
  for (let i = 0; i < rawN; i++) {
    if (heights[i] > peakEnergy) peakEnergy = heights[i];
  }
  const maxRef = Math.max(h * 0.85, 22);

  for (let i = 0; i < count; i++) {
    const normX = i / (count - 1);
    const centerDist = Math.abs(normX - 0.5) * 2;
    const isRightSide = normX >= 0.5;
    const mappedBin = isRightSide
      ? Math.pow(centerDist, 0.82) * Math.min(rawN - 1, 18)
      : Math.pow(centerDist, 0.78) * Math.min(rawN - 1, 15);
    const b0 = Math.floor(mappedBin);
    const b1 = Math.min(rawN - 1, b0 + 1);
    const frac = mappedBin - b0;
    const rawH = (heights[b0] || 0) * (1 - frac) + (heights[b1] || 0) * frac;

    const cleanSignal = Math.max(0, rawH - 1.8);
    const normSig = Math.min(1, cleanSignal / maxRef);
    const boosted = Math.pow(normSig, 0.62) * h * 1.18;

    const windowEnv = Math.pow(Math.sin(normX * Math.PI), 0.58);
    const harmonic = boosted > 0.6
      ? (Math.sin(i * 0.65 + liquidWavePhase) * 0.14 + Math.cos(i * 0.35 - liquidWavePhase * 1.3) * 0.09) * boosted
      : 0;
    const target = Math.max(0, Math.min(h - 1.5, (boosted + harmonic) * windowEnv));

    const cur = springNodes[i] || 0;
    if (target > cur) {
      springNodes[i] = cur + (target - cur) * 0.68;
    } else {
      springNodes[i] = cur + (target - cur) * 0.22;
    }
    if (springNodes[i] < 0.15) springNodes[i] = 0;
  }

  const pts = [{ x: 0, y: h }];
  const stepX = w / (count + 1);
  for (let i = 0; i < count; i++) {
    const nPrev = springNodes[Math.max(0, i - 1)];
    const nCur = springNodes[i];
    const nNext = springNodes[Math.min(count - 1, i + 1)];
    const val = nPrev * 0.2 + nCur * 0.6 + nNext * 0.2;
    pts.push({ x: (i + 1) * stepX, y: Math.max(1, h - val) });
  }
  pts.push({ x: w, y: h });

  ctx.save();
  if (color) ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, h);
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const tension = 0.18;
    const cp1x = p1.x + (p2.x - p0.x) * tension;
    const cp1y = Math.max(0.5, Math.min(h, p1.y + (p2.y - p0.y) * tension));
    const cp2x = p2.x - (p3.x - p1.x) * tension;
    const cp2y = Math.max(0.5, Math.min(h, p2.y - (p3.y - p1.y) * tension));
    ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
  }
  ctx.lineTo(w, h);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

var lastFrameTime = 0;

function startVisualizers() {
  if (!state.isWindowVisible) return;
  if (animationFrameId) cancelAnimationFrame(animationFrameId);

  const analyserNode = audioEngine && audioEngine.getAnalyserNode ? audioEngine.getAnalyserNode() : null;
  const miniCanvas = el.visualizerCanvas;
  const miniCtx = miniCanvas ? miniCanvas.getContext('2d') : null;
  const tvkCanvas = document.getElementById('tvk-visualizer-canvas');
  const tvkCtx = tvkCanvas ? tvkCanvas.getContext('2d') : null;
  const barBgCanvas = document.getElementById('bottom-visualizer') || document.getElementById('playbar-bg-visualizer');
  const barBgCtx = barBgCanvas ? barBgCanvas.getContext('2d') : null;

  let bufferLength = analyserNode ? analyserNode.frequencyBinCount : 0;
  let freqData = bufferLength > 0 ? new Uint8Array(bufferLength) : null;

  function renderLoop(timestamp) {
    if (document.hidden || !state.isWindowVisible) {
      animationFrameId = null;
      if (audioEngine && audioEngine.setAnalyserEnabled) audioEngine.setAnalyserEnabled(false);
      return;
    }

    if (!state.isPlaying && !isDraggingScrubber) {
      if (hasDrawnPausedFrame) {
        animationFrameId = null;
        if (audioEngine && audioEngine.setAnalyserEnabled) audioEngine.setAnalyserEnabled(false);
        return;
      }
      hasDrawnPausedFrame = true;
    } else {
      hasDrawnPausedFrame = false;
    }

    animationFrameId = requestAnimationFrame(renderLoop);

    try {
      const activeTrim = state.currentTrack ? getTrackTrim(state.currentTrack) : null;
      if (activeTrim && Number.isFinite(activeTrim.end) && activeTrim.end > (activeTrim.start || 0) + 1.5 && el.nativeAudio && !isDraggingScrubber) {
        if (activeTrim.start > 0 && el.nativeAudio.currentTime < activeTrim.start - 0.25) {
          el.nativeAudio.currentTime = activeTrim.start;
        } else if (activeTrim.end > activeTrim.start && el.nativeAudio.currentTime >= activeTrim.end) {
          if (state.isRepeat) {
            el.nativeAudio.currentTime = activeTrim.start;
            playSmooth();
          } else {
            state._isNaturalEnding = true;
            try { playNext(); } finally { state._isNaturalEnding = false; }
          }
          return;
        }
      }
    } catch (_) {}
    const ccPlayhead = document.getElementById('cc-playhead');
    if (ccPlayhead && typeof trackToDownload !== 'undefined' && trackToDownload && isSameTrack(state.currentTrack, trackToDownload) && typeof trimDraft !== 'undefined' && trimDraft && trimDraft.dur > 0) {
      const cur = el.nativeAudio ? (el.nativeAudio.currentTime || 0) : 0;
      const pct = Math.max(0, Math.min(100, (cur / trimDraft.dur) * 100));
      ccPlayhead.style.left = `${pct}%`;
    }

    if (document.body.classList.contains('perf') && timestamp - lastFrameTime < 33) return;
    lastFrameTime = timestamp;

    const isVisualizerVisible = miniCanvas && miniCanvas.offsetParent !== null && !document.hidden;
    const isTvkVisualizerVisible = state.isTvKaraokeOpen && tvkCanvas && tvkCanvas.offsetParent !== null && !document.hidden;
    const isBehindVizVisible = (document.body.classList.contains('bar-viz-behind') || isVizConnectedMode()) && localStorage.getItem('eclipse_bar_wave') !== '0' && !document.body.classList.contains('mini') && !document.hidden;
    const needBassPulse = !!(state.vfx && state.vfx.bassPulse);
    const isTvkBassPulse = state.isTvKaraokeOpen && !document.body.classList.contains('perf') && getTvk().bassPulse;
    const activeGap = document.querySelector('.lyric-line.lyric-gap.active');
    if (activeGap && state.isPlaying && state.syncedLyrics) {
      updateActiveGapProgress(activeGap, el.nativeAudio ? el.nativeAudio.currentTime : 0);
    }

    if (!document.body.classList.contains('perf') && (isVisualizerVisible || isTvkVisualizerVisible || isBehindVizVisible || needBassPulse || isTvkBassPulse || activeGap)) {
      if (!freqData && audioEngine && audioEngine.getAnalyserNode) {
        const an = audioEngine.getAnalyserNode();
        if (an && an.frequencyBinCount) {
          freqData = new Uint8Array(an.frequencyBinCount);
        }
      }
      if (freqData && audioEngine && audioEngine.getFrequencyData) {
        audioEngine.getFrequencyData(freqData);

        if (activeGap) {
          const bars = activeGap.querySelectorAll('.gap-bar');
          if (bars.length >= 4) {
            const isTvk = !!activeGap.closest('.tv-karaoke-content');
            const maxH = isTvk ? 46 : 22;
            const minH = isTvk ? 6 : 3;
            if (state.isPlaying && freqData) {
              const h0 = Math.max(minH, Math.min(maxH, Math.round(((freqData[1] || 0) / 255) * maxH)));
              const h1 = Math.max(minH, Math.min(maxH, Math.round(((freqData[3] || 0) / 255) * maxH)));
              const h2 = Math.max(minH, Math.min(maxH, Math.round(((freqData[5] || 0) / 255) * maxH)));
              const h3 = Math.max(minH, Math.min(maxH, Math.round(((freqData[7] || 0) / 255) * maxH)));
              bars[0].style.height = `${h0}px`;
              bars[1].style.height = `${h1}px`;
              bars[2].style.height = `${h2}px`;
              bars[3].style.height = `${h3}px`;
            } else {
              bars.forEach(b => { b.style.height = `${minH}px`; });
            }
          }
        }

        let bassEnergy = 0;
        if (freqData.length) {
          const sampleRate = (audioEngine && audioEngine.ctx && audioEngine.ctx.sampleRate) || 44100;
          const binWidth = sampleRate / (freqData.length * 2);
          const minBin = Math.max(1, Math.floor(40 / binWidth));
          const maxBin = Math.min(freqData.length - 1, Math.ceil(160 / binWidth));
          let sum = 0;
          let count = 0;
          for (let b = minBin; b <= maxBin; b++) {
            sum += freqData[b];
            count++;
          }
          bassEnergy = count > 0 ? (sum / (count * 255)) : 0;
        }
        if (isTvkBassPulse && window.KaraokeMotionController) {
          window.KaraokeMotionController.triggerBassPulse(bassEnergy);
        }

        if (needBassPulse) {
          const scaleMul = 1.0 + (bassEnergy * 0.035);
          const targetTransform = `scale(${scaleMul.toFixed(3)})`;
          if (el.coverContainer && el.coverContainer.style.transform !== targetTransform) {
            el.coverContainer.style.transform = targetTransform;
          }
        } else {
          if (el.coverContainer && el.coverContainer.style.transform) el.coverContainer.style.transform = '';
        }

        try {
          if (miniCtx && miniCanvas && isVisualizerVisible && !state.isTvKaraokeOpen) {
            miniCtx.clearRect(0, 0, 60, 24);
            if (state.isPlaying) {
              const barCount = 12;
              const barWidth = 3;
              const gap = 2;
              const startX = (60 - (barCount * (barWidth + gap))) / 2;
              const isConnected = isVizConnectedMode();
              const miniHeights = isConnected ? [] : null;

              for (let i = 0; i < barCount; i++) {
                const val = freqData[i * 2] || 0;
                let barHeight = (val / 255) * (24 - 4);
                if (barHeight < 2) barHeight = 2;

                if (isConnected) {
                  miniHeights.push(barHeight);
                } else {
                  const x = startX + i * (barWidth + gap);
                  const y = 24 - barHeight;

                  miniCtx.fillStyle = '#ffffff';
                  miniCtx.beginPath();
                  miniCtx.roundRect(x, y, barWidth, barHeight, 2);
                  miniCtx.fill();
                }
              }
              if (isConnected && miniHeights) {
                drawConnectedLiquidWave(miniCtx, 52, 24, miniHeights, '#ffffff');
              }
            }
          }
        } catch (_) {}

        try {
          if (tvkCtx && tvkCanvas && isTvkVisualizerVisible) {
            if (!cachedTvkWidth && typeof resizeCanvases === 'function') {
              resizeCanvases();
            }
            const w = cachedTvkWidth || (tvkCanvas.width / (window.devicePixelRatio || 1)) || 600;
            const h = cachedTvkHeight || (tvkCanvas.height / (window.devicePixelRatio || 1)) || 64;

            tvkCtx.clearRect(0, 0, w, h);

            if (state.isPlaying && freqData) {
              const data = freqData;
              const { smooth, sens } = vizSettings();
              if (!vizPrev || vizPrev.length !== data.length) vizPrev = new Float32Array(data.length);
              for (let i = 0; i < data.length; i++) {
                const v = Math.min(255, data[i] * sens);
                vizPrev[i] = vizPrev[i] * smooth + v * (1 - smooth);
              }

              const barCount = 28;
              if (!tvkSmoothedHeights || tvkSmoothedHeights.length !== barCount) {
                tvkSmoothedHeights = new Float32Array(barCount);
              }

              const gap = Math.max(3, Math.min(6, Math.round(w / 115)));
              const totalGap = gap * (barCount - 1);
              const barWidth = Math.max(4, Math.floor((w - totalGap) / barCount));
              const usedWidth = barCount * barWidth + totalGap;
              const startX = Math.max(0, (w - usedWidth) / 2);
              const minHeight = 4;
              const usableHeight = Math.max(10, h - minHeight - 2);

              const isConn = isVizConnectedMode();
              for (let i = 0; i < barCount; i++) {
                const b0 = i * 2;
                const b1 = Math.min(63, b0 + 1);
                const raw = ((vizPrev[b0] || 0) + (vizPrev[b1] || 0)) * 0.5;

                const norm = raw / 255;
                const compressed = Math.pow(norm, 1.3) * 0.78;
                const targetHeight = minHeight + compressed * usableHeight;

                const barH = targetHeight;
                tvkSmoothedHeights[i] = barH;

                if (!isConn) {
                  const x = startX + i * (barWidth + gap);
                  const y = h - barH;

                  tvkCtx.fillStyle = '#ffffff';
                  tvkCtx.beginPath();
                  tvkCtx.roundRect(x, y, barWidth, barH, Math.min(barWidth / 2, 3));
                  tvkCtx.fill();
                }
              }
              if (isConn) {
                tvkCtx.save();
                tvkCtx.translate(startX, 0);
                drawConnectedLiquidWave(tvkCtx, usedWidth, h, tvkSmoothedHeights, '#ffffff');
                tvkCtx.restore();
              }
            } else if (tvkSmoothedHeights) {
              let anyActive = false;
              const barCount = tvkSmoothedHeights.length;
              const gap = Math.max(3, Math.min(6, Math.round(w / 115)));
              const totalGap = gap * (barCount - 1);
              const barWidth = Math.max(4, Math.floor((w - totalGap) / barCount));
              const usedWidth = barCount * barWidth + totalGap;
              const startX = Math.max(0, (w - usedWidth) / 2);
              const minHeight = 4;

              const isConn = isVizConnectedMode();
              for (let i = 0; i < barCount; i++) {
                tvkSmoothedHeights[i] += (minHeight - tvkSmoothedHeights[i]) * 0.15;
                if (tvkSmoothedHeights[i] > minHeight + 0.5) anyActive = true;

                if (!isConn) {
                  const barH = tvkSmoothedHeights[i];
                  const x = startX + i * (barWidth + gap);
                  const y = h - barH;

                  tvkCtx.fillStyle = '#ffffff';
                  tvkCtx.beginPath();
                  tvkCtx.roundRect(x, y, barWidth, barH, Math.min(barWidth / 2, 3));
                  tvkCtx.fill();
                }
              }
              if (isConn) {
                tvkCtx.save();
                tvkCtx.translate(startX, 0);
                drawConnectedLiquidWave(tvkCtx, usedWidth, h, tvkSmoothedHeights, '#ffffff');
                tvkCtx.restore();
              }
              if (!anyActive) {
                tvkSmoothedHeights = null;
              }
            }
          }
        } catch (_) {}

        try {
          if (barBgCtx && barBgCanvas && isBehindVizVisible && !state.isTvKaraokeOpen) {
            if (isVizConnectedMode()) {
              barBgCanvas.style.display = 'block';
            }
            const bw = Math.max(200, (barBgCanvas.width / (window.devicePixelRatio || 1)) || (el.playbar ? el.playbar.clientWidth - 32 : 200));
            const bh = 36;
            barBgCtx.clearRect(0, 0, bw, bh);

            if (state.isPlaying && freqData) {
              const { smooth, sens } = vizSettings();
              const halfCount = 26;
              if (!barBgSmoothedHeights || barBgSmoothedHeights.length !== halfCount) {
                barBgSmoothedHeights = new Float32Array(halfCount);
              }
              const usableHeight = bh - 6;
              const minHeight = 3;
              for (let i = 0; i < halfCount; i++) {
                const b0 = i * 2;
                const b1 = Math.min(freqData.length - 1, b0 + 1);
                const raw = (((freqData[b0] || 0) + (freqData[b1] || 0)) * 0.5) * sens;
                const norm = Math.min(1, Math.max(0, raw / 255));
                const targetH = minHeight + Math.pow(norm, 1.25) * usableHeight;
                barBgSmoothedHeights[i] = barBgSmoothedHeights[i] * smooth + targetH * (1 - smooth);
              }

              const symCount = halfCount * 2;
              const symHeights = new Float32Array(symCount);
              for (let i = 0; i < halfCount; i++) {
                const hVal = barBgSmoothedHeights[i];
                symHeights[halfCount - 1 - i] = hVal;
                symHeights[halfCount + i] = hVal;
              }

              const isConn = isVizConnectedMode();
              const color = cachedPrimaryColor || '#ffffff';
              barBgCtx.fillStyle = color;
              if (isConn) {
                drawConnectedLiquidWave(barBgCtx, bw, bh, symHeights);
              } else {
                const gap = 2;
                const totalGap = gap * (symCount - 1);
                const barW = Math.max(2, (bw - totalGap) / symCount);
                const actualTotal = symCount * barW + totalGap;
                const startX = Math.max(0, (bw - actualTotal) / 2);
                for (let i = 0; i < symCount; i++) {
                  const barH = Math.max(2, Math.min(bh - 2, symHeights[i]));
                  const x = startX + i * (barW + gap);
                  barBgCtx.beginPath();
                  barBgCtx.roundRect(x, bh - barH, barW, barH, 3);
                  barBgCtx.fill();
                }
              }
            } else if (barBgSmoothedHeights) {
              let anyActive = false;
              const halfCount = 26;
              const minHeight = 3;
              for (let i = 0; i < halfCount; i++) {
                barBgSmoothedHeights[i] += (minHeight - barBgSmoothedHeights[i]) * 0.15;
                if (barBgSmoothedHeights[i] > minHeight + 0.5) anyActive = true;
              }
              const symCount = halfCount * 2;
              const symHeights = new Float32Array(symCount);
              for (let i = 0; i < halfCount; i++) {
                const hVal = barBgSmoothedHeights[i];
                symHeights[halfCount - 1 - i] = hVal;
                symHeights[halfCount + i] = hVal;
              }
              const isConn = isVizConnectedMode();
              const color = cachedPrimaryColor || '#ffffff';
              barBgCtx.fillStyle = color;
              if (isConn) {
                drawConnectedLiquidWave(barBgCtx, bw, bh, symHeights);
              } else {
                const gap = 2;
                const totalGap = gap * (symCount - 1);
                const barW = Math.max(2, (bw - totalGap) / symCount);
                const actualTotal = symCount * barW + totalGap;
                const startX = Math.max(0, (bw - actualTotal) / 2);
                for (let i = 0; i < symCount; i++) {
                  const barH = Math.max(2, Math.min(bh - 2, symHeights[i]));
                  const x = startX + i * (barW + gap);
                  barBgCtx.beginPath();
                  barBgCtx.roundRect(x, bh - barH, barW, barH, 3);
                  barBgCtx.fill();
                }
              }
              if (!anyActive) {
                barBgSmoothedHeights = null;
              }
            }
          }
        } catch (_) {}
      }
    } else {
      if (audioEngine && audioEngine.setAnalyserEnabled && !needBassPulse && !activeGap) audioEngine.setAnalyserEnabled(false);
      if (el.coverContainer && el.coverContainer.style.transform) el.coverContainer.style.transform = '';
      try { if (miniCtx && miniCanvas) miniCtx.clearRect(0, 0, 60, 24); } catch (_) {}
      try {
        if (tvkCtx && tvkCanvas) {
          const w = cachedTvkWidth || (tvkCanvas.width / (window.devicePixelRatio || 1)) || 500;
          const h = cachedTvkHeight || (tvkCanvas.height / (window.devicePixelRatio || 1)) || 64;
          tvkCtx.clearRect(0, 0, w, h);
        }
      } catch (_) {}
      try {
        if (barBgCtx && barBgCanvas) {
          const bw = Math.max(200, (barBgCanvas.width / (window.devicePixelRatio || 1)) || 200);
          barBgCtx.clearRect(0, 0, bw, 36);
        }
      } catch (_) {}
    }

    let scrubberCanvas = document.getElementById('squiggly-canvas');
    if (scrubberCanvas && el.scrubberTrack) {
      const sCtx = scrubberCanvas.getContext('2d');
      const sw = (el.scrubberTrack && el.scrubberTrack.clientWidth) ? el.scrubberTrack.clientWidth : (cachedTrackWidth || 0);
      const sh = cachedTrackHeight || 40;
      if (!state.isTvKaraokeOpen) sCtx.clearRect(0, 0, sw, sh);

      const dt = scrubLastTime === 0 ? 0.016 : Math.min((timestamp - scrubLastTime) / 1000, 0.1);
      scrubLastTime = timestamp;

      const dur = getReliableTrackDuration();
      let cur = (el.nativeAudio && Number.isFinite(el.nativeAudio.currentTime)) ? el.nativeAudio.currentTime : 0;
      if (window._autoMixSuppressVolumeSync) {
        const auxEl = document.getElementById('eclipse-aux-audio');
        if (auxEl && !auxEl.paused && Number.isFinite(auxEl.currentTime)) {
          cur = auxEl.currentTime;
        }
      }
      if (isPauseFading) {
        cur = frozenCurTime;
      }

      if (isDraggingScrubber && state.scrubberDragTargetTime !== undefined) {
        cur = state.scrubberDragTargetTime;
        const t = formatDuration(cur);
        if (el.timeCurrent && el.timeCurrent.textContent !== t) el.timeCurrent.textContent = t;
        if (el.tvkTimeCurrent && el.tvkTimeCurrent.textContent !== t) el.tvkTimeCurrent.textContent = t;
        { const _d = document.getElementById('tvk-time-current-display'); if (_d && _d.textContent !== t) _d.textContent = t; }
        if (el.tvkSeekSlider && !isDraggingTvkSeek && dur > 0) {
          const val = Math.round((cur / dur) * 1000);
          if (el.tvkSeekSlider.value != val) el.tvkSeekSlider.value = val;
        }
      } else if (state.isPlaying) {
        const roundedSec = Math.floor(cur);
        if (lastDisplayedSec !== roundedSec) {
          lastDisplayedSec = roundedSec;
          const t = formatDuration(cur);
          if (el.timeCurrent && el.timeCurrent.textContent !== t) el.timeCurrent.textContent = t;
          syncTvkTimeDisplay(t, undefined);
        }
        if (dur > 0) {
          const d = formatDuration(dur);
          if (el.timeDuration && el.timeDuration.textContent !== d) el.timeDuration.textContent = d;
          syncTvkTimeDisplay(undefined, d);
        }
        if (el.tvkSeekSlider && !isDraggingTvkSeek && dur > 0) {
          const val = Math.round((cur / dur) * 1000);
          if (el.tvkSeekSlider.value != val) el.tvkSeekSlider.value = val;
        }
        if (cur > 5 && !state.nextTrackPrefetched) {
          state.nextTrackPrefetched = true;
          prefetchNextQueueTrack();
        }
        if (state.isRightPanelOpen || state.isTvKaraokeOpen || state.isFloatingLyricsOpen) {
          updateSyncedLyricsHighlight(cur);
        }
      }

      const frameNowMs = performance.now();
      const frameRainbowBlend = updateAutomixRainbowBlend(frameNowMs);
      const frameReducedNow = isReducedMotionActive();
      const frameAutomixingNow = document.body.classList.contains('is-automixing');

      if (!state.isTvKaraokeOpen) {
        const targetProgress = dur > 0 ? Math.max(0, Math.min(1, cur / dur)) : 0;
        const followSpeed = isDraggingScrubber ? 32 : 45;
        scrubProgress += (targetProgress - scrubProgress) * Math.min(1, dt * followSpeed);
        scrubProgress = Math.max(0, Math.min(1, Number.isFinite(scrubProgress) ? scrubProgress : 0));

        const targetAnim = isDraggingScrubber ? 1 : 0;
        scrubKnobAnim += (targetAnim - scrubKnobAnim) * Math.min(1, dt * 16);
        const curKnobW = 7.5 + (9.0 - 7.5) * scrubKnobAnim;
        const curKnobH = 24 + (32 - 24) * scrubKnobAnim;
        const curKnobR = 3.75 + (4.5 - 3.75) * scrubKnobAnim;

        const padLeft = 5.5;
        const padRight = 5.5;
        const trackWidth = sw - padLeft - padRight;
        const knobCenterX = Math.max(padLeft, Math.min(sw - padRight, padLeft + scrubProgress * trackWidth));

        if (scrubPrevKnobX === null) scrubPrevKnobX = knobCenterX;
        const deltaX = knobCenterX - scrubPrevKnobX;
        scrubPrevKnobX = knobCenterX;

        const k = (2 * Math.PI) / 42;

        if (isDraggingScrubber) {
          scrubPhase += deltaX * k;
        } else if (state.isPlaying) {
          scrubPhase += 3.5 * dt;
        }

        const noKnob = document.body.classList.contains('no-knob');
        const capRadius = 9.5 / 2;
        const knobLeft = knobCenterX - curKnobW / 2;
        const waveStart = padLeft;
        const waveEnd = noKnob ? knobCenterX : (knobLeft - 4.5 - capRadius);

        const bgStartX = noKnob ? knobCenterX : (knobCenterX + (curKnobW / 2) + 4);
        const bgEndX = sw - padRight;

        if (!cachedPrimaryColor) refreshCachedThemeColors();
        const primaryColor = cachedPrimaryColor;
        const dimColor = cachedDimColor;

        const centerY = sh / 2;

        const showProgressBg = localStorage.getItem('eclipse_progress_bg') === 'true';
        if (showProgressBg && bgStartX < bgEndX - 1) {
          sCtx.save();
          sCtx.globalAlpha = 0.3;
          sCtx.beginPath();
          sCtx.lineWidth = 11;
          sCtx.lineCap = 'round';
          sCtx.strokeStyle = dimColor;
          sCtx.moveTo(bgStartX, centerY);
          sCtx.lineTo(bgEndX, centerY);
          sCtx.stroke();
          sCtx.restore();
        }

        if (waveEnd > waveStart) {
          sCtx.beginPath();
          sCtx.lineWidth = 9.5;
          sCtx.lineCap = 'round';
          sCtx.lineJoin = 'round';

          if (document.body.classList.contains('no-wavy')) {
            sCtx.moveTo(waveStart, centerY);
            sCtx.lineTo(waveEnd, centerY);
          } else {
            const step = 2;
            for (let x = waveStart; x <= waveEnd; x += step) {
              const angle = scrubPhase - (waveEnd - x) * k;
              const y = centerY + Math.sin(angle) * 5;
              if (x === waveStart) {
                sCtx.moveTo(x, y);
              } else {
                sCtx.lineTo(x, y);
              }
            }

            const finalY = centerY + Math.sin(scrubPhase) * 5;
            sCtx.lineTo(waveEnd, finalY);
          }
          strokeSeekbarWave(sCtx, {
            baseColor: primaryColor,
            rainbowBlend: frameRainbowBlend,
            nowMs: frameNowMs,
            isReduced: frameReducedNow,
            isAutomixing: frameAutomixingNow,
            reducedAccentColor: primaryColor
          });
        }

        if (!noKnob) {
          sCtx.beginPath();
          sCtx.roundRect(knobLeft, centerY - curKnobH / 2, curKnobW, curKnobH, curKnobR);
          sCtx.fillStyle = primaryColor;
          sCtx.fill();
        }
      } else {
        const tvkScrubber = document.getElementById('tvk-squiggly-canvas');
        if (tvkScrubber) {
          const tCtx = tvkScrubber.getContext('2d');
          const tvkTrack = document.getElementById('tvk-scrubber-track') || document.getElementById('tvk-progress-row');
          const tw = (tvkTrack && tvkTrack.clientWidth) ? tvkTrack.clientWidth : (tvkScrubber.clientWidth || 240);
          const th = 36;
          const dpr = window.devicePixelRatio || 1;
          const expectedW = Math.round(tw * dpr);
          const expectedH = Math.round(th * dpr);
          if (tw > 0 && (tvkScrubber.width !== expectedW || tvkScrubber.height !== expectedH)) {
            tvkScrubber.width = expectedW;
            tvkScrubber.height = expectedH;
            tCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
          }
          tCtx.clearRect(0, 0, tw, th);

          if (!cachedPrimaryColor) refreshCachedThemeColors();
          const primaryColor = cachedPrimaryColor || '#a855f7';

          const targetProgress = dur > 0 ? Math.max(0, Math.min(1, cur / dur)) : 0;
          const followSpeed = isDraggingScrubber ? 32 : 45;
          scrubProgress += (targetProgress - scrubProgress) * Math.min(1, dt * followSpeed);

          const targetAnim = isDraggingScrubber ? 1 : 0;
          scrubKnobAnim += (targetAnim - scrubKnobAnim) * Math.min(1, dt * 16);
          const curKnobW = 7.5 + (9.0 - 7.5) * scrubKnobAnim;
          const curKnobH = 22 + (28 - 22) * scrubKnobAnim;
          const curKnobR = 3.75 + (4.5 - 3.75) * scrubKnobAnim;

          const padLeft = 5.5;
          const padRight = 5.5;
          const trackWidth = tw - padLeft - padRight;
          const knobCenterX = padLeft + scrubProgress * trackWidth;

          if (scrubPrevKnobX === null) scrubPrevKnobX = knobCenterX;
          const deltaX = knobCenterX - scrubPrevKnobX;
          scrubPrevKnobX = knobCenterX;

          const k = (2 * Math.PI) / 42;

          if (isDraggingScrubber) {
            scrubPhase += deltaX * k;
          } else if (state.isPlaying) {
            scrubPhase += 3.5 * dt;
          }

          const noKnob = document.body.classList.contains('no-knob');
          const capRadius = 9.5 / 2;
          const knobLeft = knobCenterX - curKnobW / 2;
          const waveStart = padLeft;
          const waveEnd = noKnob ? knobCenterX : (knobLeft - 4.5 - capRadius);

          const bgStartX = noKnob ? knobCenterX : (knobCenterX + (curKnobW / 2) + 4);
          const bgEndX = tw - padRight;

          const centerY = th / 2;

          if (bgStartX < bgEndX - 1) {
            tCtx.save();
            tCtx.beginPath();
            tCtx.lineWidth = 9.5;
            tCtx.lineCap = 'round';
            tCtx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
            tCtx.moveTo(bgStartX, centerY);
            tCtx.lineTo(bgEndX, centerY);
            tCtx.stroke();
            tCtx.restore();
          }

          if (waveEnd > waveStart) {
            tCtx.beginPath();
            tCtx.lineWidth = 9.5;
            tCtx.lineCap = 'round';
            tCtx.lineJoin = 'round';

            if (document.body.classList.contains('no-wavy')) {
              tCtx.moveTo(waveStart, centerY);
              tCtx.lineTo(waveEnd, centerY);
            } else {
              const step = 2;
              for (let x = waveStart; x <= waveEnd; x += step) {
                const angle = scrubPhase - (waveEnd - x) * k;
                const y = centerY + Math.sin(angle) * 5;
                if (x === waveStart) {
                  tCtx.moveTo(x, y);
                } else {
                  tCtx.lineTo(x, y);
                }
              }

              const finalY = centerY + Math.sin(scrubPhase) * 5;
              tCtx.lineTo(waveEnd, finalY);
            }
            strokeSeekbarWave(tCtx, {
              baseColor: primaryColor,
              rainbowBlend: frameRainbowBlend,
              nowMs: frameNowMs,
              isReduced: frameReducedNow,
              isAutomixing: frameAutomixingNow,
              reducedAccentColor: primaryColor
            });
          }

          if (!noKnob) {
            tCtx.beginPath();
            tCtx.roundRect(knobLeft, centerY - curKnobH / 2, curKnobW, curKnobH, curKnobR);
            tCtx.fillStyle = primaryColor;
            tCtx.fill();
          }
        }
      }
    }
  }
  renderLoop(0);
}

function handleVisibilityChange(visible) {
  state.isWindowVisible = visible;
  syncBgVideoPlayback();
  if (audioEngine && audioEngine.setHidden) audioEngine.setHidden(!visible);
  if (!visible) {
    if (typeof lyricsScrollRaf !== 'undefined' && lyricsScrollRaf) {
      cancelAnimationFrame(lyricsScrollRaf);
      lyricsScrollRaf = 0;
    }
    if (typeof gradientRaf !== 'undefined' && gradientRaf) {
      cancelAnimationFrame(gradientRaf);
      gradientRaf = 0;
    }
    if (animationFrameId) {
      cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }
    if (typeof cacheRafId !== 'undefined' && cacheRafId) {
      cancelAnimationFrame(cacheRafId);
      cacheRafId = 0;
    }
    document.body.classList.add('app-paused');
    document.body.classList.add('hidden-window');
    if (typeof updateCoverAnimVisibility === 'function') updateCoverAnimVisibility();
    window.electronAPI?.clearWebFrameCache?.();
  } else {
    document.body.classList.remove('app-paused');
    document.body.classList.remove('hidden-window');
    if (typeof updateCoverAnimVisibility === 'function') updateCoverAnimVisibility();
    resizeCanvases();
    hasDrawnPausedFrame = false;
    if (state.isPlaying || isDraggingScrubber) startVisualizers();
    if (typeof cacheModal !== 'undefined' && cacheModal && cacheModal.classList.contains('visible') && typeof cacheRafId !== 'undefined' && !cacheRafId) {
      cacheRafId = requestAnimationFrame(cacheFrame);
    }
    if (typeof updateLyricsPadding === 'function') {
      const syncOnRestore = () => {
        updateLyricsPadding();
        state.forceSnapLyrics = true;
        state.forceLyricsScroll = true;
        state.lastActiveLyricIdx = -1;
        if (el.nativeAudio) updateSyncedLyricsHighlight(el.nativeAudio.currentTime || 0);
      };
      syncOnRestore();
      requestAnimationFrame(syncOnRestore);
      setTimeout(syncOnRestore, 80);
      setTimeout(syncOnRestore, 220);
    }
  }
}

function applyVisualEffects() {
  const v = state.vfx;

  if (el.coverContainer) {
    el.coverContainer.classList.toggle('vinyl-mode', !!v.vinylSpin);
    el.coverContainer.classList.toggle('spinning', !!v.vinylSpin && state.isPlaying);
  }
  document.body.classList.toggle('vfx-spotlight-on', !!v.lyricsSpotlight);
  syncVisualSettingsUI();
}

function syncVisualSettingsUI() {
  const v = state.vfx;
  const vfxList = [
    { id: 'vfx-pulse', key: 'bassPulse' },
    { id: 'vfx-vinyl', key: 'vinylSpin' },
    { id: 'vfx-spotlight', key: 'lyricsSpotlight' }
  ];

  vfxList.forEach(item => {
    const card = document.getElementById(`card-${item.id}`);
    const badge = document.getElementById(`badge-${item.id}`);
    const btn = document.getElementById(`toggle-${item.id}`);
    const isEnabled = v[item.key];

    if (card) card.classList.toggle('enabled', !!isEnabled);
    if (badge) badge.textContent = isEnabled ? 'on' : 'off';
    if (btn) {
      btn.classList.toggle('active', !!isEnabled);
    }
  });
}

function updateWavyProgressUI() {
  const btnWavyProgress = document.getElementById('btn-wavy-progress');
  const isWavy = localStorage.getItem('eclipse_wavy_progress') !== 'false';
  const isPerf = localStorage.getItem('eclipse_perf_mode') === '1' || localStorage.getItem('eclipse_perf_mode') === 'true';
  document.body.classList.toggle('no-wavy', isPerf ? true : !isWavy);
  if (btnWavyProgress) {
    btnWavyProgress.classList.toggle('active', isWavy);
  }
}

function updateProgressKnobUI() {
  const btnProgressKnob = document.getElementById('btn-progress-knob');
  const isEnabled = localStorage.getItem('eclipse_progress_knob') === 'true';
  document.body.classList.toggle('no-knob', !isEnabled);
  if (btnProgressKnob) {
    btnProgressKnob.classList.toggle('active', isEnabled);
  }
}

function updateProgressBgUI() {
  const btnProgressBg = document.getElementById('btn-progress-bg');
  const isEnabled = localStorage.getItem('eclipse_progress_bg') === 'true';
  document.body.classList.toggle('no-progress-bg', !isEnabled);
  if (btnProgressBg) {
    btnProgressBg.classList.toggle('active', isEnabled);
  }
}

var COVER_PX = 70;
var CANVAS_PX = 120;
var RING_GAP = 5;
var RING_W = 2.4;

var m3cCoverAnim = null;
var m3cRateTweenRaf = 0;

function ensureM3cCoverAnimation() {
  const wrap = document.getElementById('m3c-wrap');
  if (wrap) wrap.style.transform = 'none';
  if (m3cCoverAnim) {
    if (m3cRateTweenRaf) {
      cancelAnimationFrame(m3cRateTweenRaf);
      m3cRateTweenRaf = 0;
    }
    try { m3cCoverAnim.cancel(); } catch (e) {}
    m3cCoverAnim = null;
  }
  return null;
}

function setCoverRotationRate(isPlaying) {
  if (m3c) m3c.targetRate = isPlaying ? 1 : 0.25;
  if (typeof m3cEnabled === 'function' && m3cEnabled()) m3cStart();
}

function updateCoverAnimVisibility() {
  const isHidden = document.hidden || document.body.classList.contains('hidden-window');
  const playbar = el.playbar || document.getElementById('playbar');
  const isBarHidden = playbar && playbar.offsetParent === null;
  if (isHidden || isBarHidden) {
    if (m3c && m3c.raf) {
      cancelAnimationFrame(m3c.raf);
      m3c.raf = 0;
    }
  } else if (typeof m3cEnabled === 'function' && m3cEnabled()) {
    m3cStart();
  }
}

function m3cEnabled() {
  const barOn = localStorage.getItem('eclipse_m3_cover') !== '0';
  const heroOn = localStorage.getItem('eclipse_m3_hero_covers') === '1';
  return (barOn || heroOn) && !document.body.classList.contains('perf');
}

function m3cInit() {
  m3c.canvas = document.getElementById('m3c-canvas');
  if (!m3c.canvas) return;
  const dpr = window.devicePixelRatio || 1;
  m3c.canvas.width = CANVAS_PX * dpr;
  m3c.canvas.height = CANVAS_PX * dpr;
  m3c.ctx = m3c.canvas.getContext('2d');
  m3c.ctx.scale(dpr, dpr);
  m3c.ctx.imageSmoothingEnabled = true;
  m3c.ctx.imageSmoothingQuality = 'high';
  m3c.img.onload = () => { m3c.imgReady = true; m3cDraw(performance.now()); };
  if (el.playbarArtwork && el.playbarArtwork.src) {
    m3cSetImage(el.playbarArtwork.src);
  } else if (state.currentTrack) {
    m3cSetImage(getTrackThumbUrl(state.currentTrack));
  }
  const wrap = document.getElementById('playbar-artwork-wrapper');
  if (wrap && !wrap._m3cHoverBound) {
    wrap._m3cHoverBound = true;
    wrap.addEventListener('mouseenter', () => {
      m3c.isHovered = true;
      m3cStart();
    });
    wrap.addEventListener('mouseleave', () => {
      m3c.isHovered = false;
      m3cStart();
    });
  }
  applyM3Cover();
}

function m3cSetImage(url) {
  m3c.imgReady = false;
  if (url) m3c.img.src = url;
}

function m3cShapeRadii(now) {
  const S = window.RiffShapes;
  if (!S || !S.ready()) return null;
  if (!m3c.start) { m3c.start = now; m3c.from = 0; m3c.to = 0; }
  if (now - m3c.start >= S.HOLD_MS) { m3c.from = m3c.to; m3c.to = S.next(m3c.from); m3c.start = now; }
  const t = Math.min(1, (now - m3c.start) / S.MORPH_MS);
  return { a: S.profile(m3c.from), b: S.profile(m3c.to), e: S.ease(t) };
}

function m3cDraw(now) {
  const ctx = m3c.ctx;
  const S = window.RiffShapes;
  if (!ctx || !S) return;
  const sh = m3cShapeRadii(now);
  if (!sh) return;
  const K = S.K;
  const hoverScale = 1 + m3c.hoverProgress * 0.16;
  const hoverLift = m3c.hoverProgress * 4;
  const cx = CANVAS_PX / 2;
  const cy = CANVAS_PX / 2 - hoverLift;
  const currentCover = COVER_PX * hoverScale;
  const scale = (currentCover / 2) / 160 * 1.02;
  const rot = m3c.rotation || 0;
  const rawRadiusAt = (shapeAngle) => {
    const f = ((shapeAngle + Math.PI) / (Math.PI * 2)) * K;
    const i0 = ((Math.floor(f) % K) + K) % K;
    const i1 = (i0 + 1) % K;
    const w = f - Math.floor(f);
    const r0 = sh.a[i0] + (sh.b[i0] - sh.a[i0]) * sh.e;
    const r1 = sh.a[i1] + (sh.b[i1] - sh.a[i1]) * sh.e;
    return r0 + (r1 - r0) * w;
  };
  const radiusAt = (shapeAngle) => rawRadiusAt(shapeAngle) * scale;
  ctx.clearRect(0, 0, CANVAS_PX, CANVAS_PX);
  ctx.save();
  ctx.beginPath();
  for (let k = 0; k <= K; k++) {
    const th = -Math.PI + (Math.PI * 2 * (k % K)) / K;
    const r = radiusAt(th);
    const x = cx + Math.cos(th + rot) * r;
    const y = cy + Math.sin(th + rot) * r;
    if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.clip();
  const heroPath = document.getElementById('m3-hero-shape-path');
  if (heroPath && document.body.classList.contains('m3-hero-covers-on')) {
    let heroD = '';
    for (let k = 0; k <= K; k++) {
      const th = -Math.PI + (Math.PI * 2 * (k % K)) / K;
      const baseScale = (typeof COVER_PX !== 'undefined' ? (COVER_PX / 2) / 160 * 1.02 : 1);
      const r = (typeof rawRadiusAt === 'function' ? rawRadiusAt(th) : radiusAt(th)) * baseScale;
      const nx = Math.max(0, Math.min(1, 0.5 + (Math.cos(th + rot) * r) / (COVER_PX * 1.05)));
      const ny = Math.max(0, Math.min(1, 0.5 + (Math.sin(th + rot) * r) / (COVER_PX * 1.05)));
      if (k === 0) heroD += `M ${nx.toFixed(4)} ${ny.toFixed(4)}`;
      else heroD += ` L ${nx.toFixed(4)} ${ny.toFixed(4)}`;
    }
    heroPath.setAttribute('d', heroD + ' Z');
  }
  if (m3c.imgReady) {
    const iw = m3c.img.naturalWidth;
    const ih = m3c.img.naturalHeight;
    const side = Math.min(iw, ih);
    const imgSize = Math.ceil(currentCover * 1.06);
    ctx.drawImage(m3c.img, (iw - side) / 2, (ih - side) / 2, side, side, cx - imgSize / 2, cy - imgSize / 2, imgSize, imgSize);
  } else {
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--md-sys-color-surface-container-highest-solid') || '#444';
    ctx.fillRect(0, 0, CANVAS_PX, CANVAS_PX);
  }
  ctx.restore();
  const audio = el.nativeAudio;
  const dur = audio && isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
  const p = dur ? Math.min(1, Math.max(0, audio.currentTime / dur)) : 0;
  const primary = (getComputedStyle(document.documentElement).getPropertyValue('--md-sys-color-primary') || '#d0bcff').trim();
  const STEPS = 240;
  const ringPoint = (phi, wave) => {
    const r = radiusAt(phi - rot) + RING_GAP + RING_W / 2 + wave;
    return [cx + Math.cos(phi) * r, cy + Math.sin(phi) * r];
  };
  const startPhi = -Math.PI / 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = RING_W;
  ctx.setLineDash([0.1, 5.5]);
  ctx.strokeStyle = primary;
  ctx.globalAlpha = 0.4;
  ctx.beginPath();
  const restFrom = Math.round(p * STEPS);
  for (let s = restFrom; s <= STEPS; s++) {
    const [x, y] = ringPoint(startPhi + (Math.PI * 2 * s) / STEPS, 0);
    if (s === restFrom) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  if (p > 0) {
    ctx.beginPath();
    const playedSteps = Math.max(2, Math.round(p * STEPS));
    for (let s = 0; s <= playedSteps; s++) {
      const phi = startPhi + (Math.PI * 2 * s) / STEPS;
      const [x, y] = ringPoint(phi, Math.sin(phi * 26 + m3c.phase) * 1.5);
      if (s === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}

function m3cLoop(now) {
  m3c.raf = 0;
  if (!m3cEnabled() || document.hidden) return;

  const targetHover = m3c.isHovered ? 1 : 0;
  const diff = targetHover - m3c.hoverProgress;
  const isHoverAnimating = Math.abs(diff) > 0.002;
  if (isHoverAnimating) {
    m3c.hoverProgress += diff * 0.2;
  } else {
    m3c.hoverProgress = targetHover;
  }

  const rateDiff = m3c.targetRate - m3c.rotRate;
  if (Math.abs(rateDiff) > 0.01) {
    m3c.rotRate += rateDiff * 0.1;
  } else {
    m3c.rotRate = m3c.targetRate;
  }

  if (!m3c.last) m3c.last = now;
  const delta = Math.min(64, Math.max(0, now - m3c.last));
  m3c.last = now;

  const baseSpeed = (2 * Math.PI) / 14000;
  m3c.rotation = (m3c.rotation + baseSpeed * m3c.rotRate * delta) % (Math.PI * 2);

  if (state.isPlaying) m3c.phase += 0.0075 * delta;

  m3cDraw(now);
  m3c.raf = requestAnimationFrame(m3cLoop);
}

function m3cStart() {
  if (m3c && !m3c.raf) m3c.raf = requestAnimationFrame(m3cLoop);
}

function applyM3Cover() {
  const on = m3cEnabled();
  document.body.classList.toggle('m3-cover-on', on);
  ensureM3cCoverAnimation();
  if (on) {
    m3c.targetRate = state.isPlaying ? 1 : 0.25;
    m3cDraw(performance.now());
    m3cStart();
  } else {
    if (m3c.raf) {
      cancelAnimationFrame(m3c.raf);
      m3c.raf = 0;
    }
  }
}

function applyPerfMode(on) {
  document.body.classList.toggle('perf', !!on);
  const isWavy = localStorage.getItem('eclipse_wavy_progress') !== 'false';
  document.body.classList.toggle('no-wavy', on ? true : !isWavy);
  syncBgVideoPlayback();
  applyM3Cover();
}

function applyBarWave(on) {
  const vc = document.getElementById('visualizer-container');
  if (vc) {
    vc.style.display = on ? '' : 'none';
    vc.style.pointerEvents = on ? '' : 'none';
  }
  const canvas = document.getElementById('visualizer-canvas');
  if (canvas) {
    canvas.style.pointerEvents = on ? '' : 'none';
    if (!on) {
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }
  const needBassPulse = !!(state.vfx && state.vfx.bassPulse);
  if (!on) {
    if (audioEngine && audioEngine.setAnalyserEnabled && !needBassPulse) {
      audioEngine.setAnalyserEnabled(false);
    }
  } else {
    if (audioEngine && audioEngine.setAnalyserEnabled && state.isPlaying) {
      audioEngine.setAnalyserEnabled(true);
    }
    if (state.isPlaying) {
      startVisualizers();
    }
  }
}

function applyBarVizPos(pos) {
  const barVizPosGroup = document.getElementById('bar-viz-pos-group');
  document.body.classList.toggle('bar-viz-behind', pos === 'behind');
  if (barVizPosGroup) {
    barVizPosGroup.querySelectorAll('.theme-mode-btn').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-bar-viz-pos') === pos);
    });
  }
  if (typeof resizeCanvases === 'function') resizeCanvases();
}

function applyBarVizOpacity(v) {
  const sliderBarVizOpacity = document.getElementById('slider-bar-viz-opacity');
  const valBarVizOpacity = document.getElementById('val-bar-viz-opacity');
  const num = parseInt(v, 10);
  document.documentElement.style.setProperty('--bar-viz-opacity', (num / 100).toString());
  if (valBarVizOpacity) valBarVizOpacity.textContent = `${num}%`;
  if (sliderBarVizOpacity) sliderBarVizOpacity.value = num;
}

function syncVizConnectedUI() {
  const btnVizConnected = document.getElementById('btn-viz-connected');
  const btnTvkVizConnected = document.getElementById('btn-tvk-viz-connected');
  const isConn = localStorage.getItem('eclipse_viz_connected') === '1';
  if (btnVizConnected) btnVizConnected.classList.toggle('active', isConn);
  if (btnTvkVizConnected) btnTvkVizConnected.classList.toggle('active', isConn);
  document.body.classList.toggle('viz-connected', isConn);
  const bottomViz = document.getElementById('bottom-visualizer') || document.getElementById('playbar-bg-visualizer');
  if (bottomViz && isConn) {
    bottomViz.style.display = 'block';
  }
}

function toggleVizConnected() {
  const isConn = localStorage.getItem('eclipse_viz_connected') === '1';
  const next = !isConn;
  localStorage.setItem('eclipse_viz_connected', next ? '1' : '0');
  syncVizConnectedUI();
  const bottomViz = document.getElementById('bottom-visualizer') || document.getElementById('playbar-bg-visualizer');
  if (bottomViz) {
    if (next) {
      bottomViz.style.display = 'block';
    } else if (!document.body.classList.contains('bar-viz-behind')) {
      bottomViz.style.display = '';
    }
  }
}
