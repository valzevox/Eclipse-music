// src/renderer/modules/lyrics.js
// Synced lyrics, word-level karaoke, gradient fill, translation/romanization, TV karaoke, custom lyrics editor, and sync mode.

function setRightPanelLyricsEmptySmooth(isEmpty) {
  const panel = el.rightPanel || document.getElementById('right-panel');
  if (typeof renderMiniLyrics === 'function') renderMiniLyrics();
  if (!panel) return;
  const currentlyEmpty = panel.classList.contains('lyrics-empty');
  if (currentlyEmpty === !!isEmpty) {
    if (typeof syncTvLayout === 'function') syncTvLayout(!!isEmpty);
    return;
  }

  const artworkBox = el.rightPanelArtworkBox || document.getElementById('right-panel-artwork-box');
  const headerActions = panel.querySelector('.lyrics-header-actions') || document.querySelector('.lyrics-header-actions');

  const elementsToAnimate = [artworkBox, headerActions].filter(Boolean);
  const firstTops = new Map();
  elementsToAnimate.forEach(elem => {
    firstTops.set(elem, elem.getBoundingClientRect().top);
  });

  panel.classList.toggle('lyrics-empty', !!isEmpty);
  if (typeof syncTvLayout === 'function') syncTvLayout(!!isEmpty);

  if (document.body.classList.contains('perf')) return;

  const animatedItems = [];
  elementsToAnimate.forEach(elem => {
    const firstTop = firstTops.get(elem);
    const lastTop = elem.getBoundingClientRect().top;
    const deltaY = firstTop - lastTop;
    if (Math.abs(deltaY) > 0.5) {
      elem.style.transition = 'none';
      elem.style.transform = `translateY(${deltaY}px)`;
      animatedItems.push(elem);
    }
  });

  if (animatedItems.length === 0) return;

  animatedItems.forEach(elem => elem.offsetHeight);

  requestAnimationFrame(() => {
    animatedItems.forEach(elem => {
      elem.style.transition = 'transform 320ms cubic-bezier(0.2, 0, 0, 1)';
      elem.style.transform = 'translateY(0)';

      let cleaned = false;
      const cleanUp = () => {
        if (cleaned) return;
        cleaned = true;
        elem.removeEventListener('transitionend', onEnd);
        elem.style.transition = '';
        elem.style.transform = '';
      };
      const onEnd = (e) => {
        if (e.target !== elem || e.propertyName !== 'transform') return;
        cleanUp();
      };
      elem.addEventListener('transitionend', onEnd);
      setTimeout(cleanUp, 380);
    });
  });
}

function setLyricsEmpty(isEmpty) {
  setRightPanelLyricsEmptySmooth(isEmpty);
}

const lyricsSessionCache = new Map();
const wordsSessionCache = new Map();

[lyricsSessionCache, wordsSessionCache].forEach(m => {
  const origSet = m.set.bind(m);
  m.set = function(k, v) {
    const res = origSet(k, v);
    if (typeof boundMap === 'function') boundMap(m, 30);
    return res;
  };
});

function parseEnhancedLrcWords(lineStr, lineStart, lineEnd) {
  const tagRegex = /<(\d+):(\d+(?:\.\d+)?)>/g;
  let m;
  const tags = [];
  while ((m = tagRegex.exec(lineStr)) !== null) {
    const min = parseInt(m[1], 10);
    const sec = parseFloat(m[2]);
    tags.push({ time: min * 60 + sec, startIdx: m.index, endIdx: m.index + m[0].length });
  }
  if (tags.length === 0) return null;
  const words = [];
  for (let i = 0; i < tags.length; i++) {
    const cur = tags[i];
    const nxt = tags[i + 1];
    const wText = lineStr.substring(cur.endIdx, nxt ? nxt.startIdx : lineStr.length).trim();
    if (wText) {
      const wStart = cur.time;
      const wEnd = nxt ? nxt.time : (lineEnd > wStart ? lineEnd : wStart + 0.5);
      words.push({ text: wText, start: wStart, end: wEnd });
    }
  }
  return words.length > 0 ? words : null;
}

function stringNormalizedSimilarity(a, b) {
  const normA = (a || '').toLowerCase().replace(/[^a-z0-9\u0400-\u04ff\u4e00-\u9fa5]/gi, '');
  const normB = (b || '').toLowerCase().replace(/[^a-z0-9\u0400-\u04ff\u4e00-\u9fa5]/gi, '');
  if (!normA && !normB) return 1;
  if (!normA || !normB) return 0;
  if (normA === normB) return 1;
  if (normA.includes(normB) || normB.includes(normA)) {
    return Math.min(normA.length, normB.length) / Math.max(normA.length, normB.length);
  }
  let common = 0;
  const minLen = Math.min(normA.length, normB.length);
  for (let i = 0; i < minLen; i++) {
    if (normA[i] === normB[i]) common++;
  }
  return common / Math.max(normA.length, normB.length);
}

async function fetchAndUpgradeWords(title, artist, trackId, token) {
  const wordSource = localStorage.getItem('eclipse_word_source') || 'auto';
  if (wordSource === 'estimate') return;

  const cachedWords = wordsSessionCache.get(trackId);
  if (cachedWords) {
    if (cachedWords.negative) {
      if (Date.now() - cachedWords.time < 600000) return;
    } else if (cachedWords.wordsByLine) {
      if (token !== state.loadToken || !state.currentTrack || (((state.currentTrack.id) || `${artist}:${title}`) !== trackId)) return;
      state.syncedLyrics.forEach((line, index) => {
        if (cachedWords.wordsByLine[index]) line.words = cachedWords.wordsByLine[index];
      });
      upgradeLyricsWordsInPlace();
      return;
    }
  }

  try {
    const duration = (state.currentTrack && state.currentTrack.duration) || (el.nativeAudio && el.nativeAudio.duration) || 0;
    const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/lyrics-words?title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}&duration=${encodeURIComponent(duration || '')}&wordSource=${encodeURIComponent(wordSource)}`);
    const data = await res.json();

    if (token !== state.loadToken || !state.currentTrack || (((state.currentTrack.id) || `${artist}:${title}`) !== trackId)) return;
    if (!data || !data.success || !data.lines || data.lines.length === 0) {
      wordsSessionCache.set(trackId, { negative: true, time: Date.now() });
      return;
    }

    const hasSync = state.syncedLyrics && state.syncedLyrics.some(p => p.time >= 0);
    if (state.isCustomLyrics && !hasSync) return;
    if (hasSync) {
      const countDiff = Math.abs(state.syncedLyrics.length - data.lines.length) / Math.max(state.syncedLyrics.length, data.lines.length);
      if (countDiff > 0.15) {
        wordsSessionCache.set(trackId, { negative: true, time: Date.now() });
        return;
      }

      let matched = 0;
      const neLines = data.lines;
      let neIdx = 0;
      const lineWordsMap = [];
      for (let i = 0; i < state.syncedLyrics.length; i++) {
        const pText = state.syncedLyrics[i].text;
        let bestSim = 0;
        let bestNe = -1;
        const startJ = Math.max(0, neIdx - 3);
        const endJ = Math.min(neLines.length, neIdx + 4);
        for (let j = startJ; j < endJ; j++) {
          const sim = stringNormalizedSimilarity(pText, neLines[j].text);
          if (sim > bestSim) {
            bestSim = sim;
            bestNe = j;
          }
        }
        if (bestNe !== -1 && bestSim >= 0.6) {
          matched++;
          neIdx = bestNe + 1;
          lineWordsMap[i] = neLines[bestNe].words;
        }
      }

      if (matched / state.syncedLyrics.length < 0.70) {
        wordsSessionCache.set(trackId, { negative: true, time: Date.now() });
        return;
      }

      for (let i = 0; i < state.syncedLyrics.length; i++) {
        if (lineWordsMap[i]) {
          state.syncedLyrics[i].words = lineWordsMap[i];
        }
      }
    } else {
      state.syncedLyrics = data.lines.map(l => ({ time: l.start, text: l.text, words: l.words }));
      renderLyricsView();
      setLyricsEmpty(false);
      wordsSessionCache.set(trackId, { wordsByLine: state.syncedLyrics.map(l => l.words), time: Date.now() });
      return;
    }

    upgradeLyricsWordsInPlace();
    wordsSessionCache.set(trackId, { wordsByLine: state.syncedLyrics.map(l => l.words), time: Date.now() });
  } catch (_) {
    wordsSessionCache.set(trackId, { negative: true, time: Date.now() });
  }
}

function tagWrappedLyricRows(container) {
  if (!container || !container.clientHeight) return;
  container.querySelectorAll('.lyric-line').forEach((lineEl) => {
    const words = lineEl.querySelectorAll('.lyric-word');
    if (words.length > 1) {
      let rowIdx = 0;
      let lastTop = words[0].offsetTop;
      words.forEach((w) => {
        if (w.offsetTop > lastTop + 4) { rowIdx++; lastTop = w.offsetTop; }
        w.style.setProperty('--subline', String(Math.min(rowIdx, 3)));
      });
    }
  });
}

function splitLyricParensToEnd(rawText) {
  const str = String(rawText || '').replace(/<[^>]+>/g, '').trim();
  if (!str) return { mainText: '', parenText: '', startRatio: 0.7, endRatio: 1.0 };
  const totalLen = Math.max(1, str.length);
  const parens = [];
  let firstStart = -1;
  let lastEnd = -1;
  const mainText = str.replace(/\(([^)]+)\)/g, (match, inner, offset) => {
    const cleanInner = inner.trim();
    if (cleanInner) {
      parens.push('(' + cleanInner + ')');
      if (firstStart === -1) firstStart = offset;
      lastEnd = offset + match.length;
    }
    return ' ';
  }).replace(/\s{2,}/g, ' ').trim();
  const startRatio = firstStart >= 0 ? Math.max(0.05, Math.min(0.85, firstStart / totalLen)) : 0.7;
  const endRatio = lastEnd > firstStart ? Math.max(startRatio + 0.12, Math.min(1.0, lastEnd / totalLen)) : 1.0;
  return {
    mainText: mainText || str,
    parenText: parens.length > 0 ? parens.join(' ') : '',
    startRatio,
    endRatio
  };
}

function upgradeLyricsWordsInPlace() {
  state.syncedLyrics.forEach((line, index) => {
    if (line.words && Array.isArray(line.words) && line.words.length > 0 && !line.isGap) {
      const buildWordNodes = () => {
        const fragment = document.createDocumentFragment();
        let inParen = false;
        line.words.forEach((wObj, wIdx) => {
          const wText = typeof wObj === 'string' ? wObj : (wObj ? (wObj.word || wObj.text || '') : '');
          if (!wText) return;
          if (/^[\(\[]/.test(wText)) inParen = true;
          const wSpan = document.createElement('span');
          wSpan.className = 'lyric-word' + (inParen ? ' lyric-paren' : '');
          wSpan.dataset.wordIdx = String(wIdx);
          wSpan.textContent = wText;
          fragment.appendChild(wSpan);
          if (wIdx < line.words.length - 1) {
            fragment.appendChild(document.createTextNode(' '));
          }
          if (/[\)\]]$/.test(wText)) inParen = false;
        });
        return fragment;
      };

      const mainDiv = document.getElementById(`lyric-line-${index}`);
      if (mainDiv && !isGradientMode() && getAdv('karaoke_words', true) && state.lyricsMode === 'word') {
        const trEl = mainDiv.querySelector('.lyric-translation');
        mainDiv.innerHTML = '';
        mainDiv.appendChild(buildWordNodes());
        if (trEl) {
          mainDiv.appendChild(trEl);
        }
      }
      const miniDiv = document.getElementById(`mini-lyric-line-${index}`);
      if (miniDiv) {
        miniDiv.innerHTML = '';
        miniDiv.appendChild(buildWordNodes());
      }
    }
  });
  if (el.nativeAudio) updateSyncedLyricsHighlight(el.nativeAudio.currentTime || 0);
  tagWrappedLyricRows(el.lyricsContainer);
}

async function loadSyncedLyrics(title, artist, token) {
  if (el.lyricsContainer) {
    el.lyricsContainer.scrollTop = 0;
    el.lyricsContainer.style.transition = 'opacity 200ms cubic-bezier(0.2, 0, 0, 1)';
    el.lyricsContainer.style.opacity = '0';
  }
  if (typeof lyricsScrollRaf !== 'undefined' && lyricsScrollRaf) {
    cancelAnimationFrame(lyricsScrollRaf);
    lyricsScrollRaf = 0;
  }
  state.lastActiveLyricIdx = -1;
  state.forceLyricsScroll = true;
  state.forceSnapLyrics = true;
  state.syncedLyrics = [];
  state.isCustomLyrics = false;
  if (typeof renderMiniLyrics === 'function') renderMiniLyrics();

  try {
    const source = localStorage.getItem('eclipse_lyrics_source') || 'auto';
    const trackId = (state.currentTrack && state.currentTrack.id) || `${artist}:${title}`;
    const lyricsCacheKey = `${trackId}:${source}`;

    if (!lyricsSessionCache.has(lyricsCacheKey)) {
      setRightPanelLyricsEmptySmooth(true);
    }

    let data = lyricsSessionCache.get(lyricsCacheKey);
    const pillEl = document.getElementById('lyrics-provider-pill');
    if (!data) {
      const onlineParam = getAdv('online_lyrics', true) ? '1' : '0';
      const durationParam = (state.currentTrack && state.currentTrack.duration) ? `&duration=${encodeURIComponent(state.currentTrack.duration)}` : '';
      const vidParam = (state.currentTrack && state.currentTrack.id) ? `&videoId=${encodeURIComponent(state.currentTrack.id)}` : '';
      if (pillEl) {
        pillEl.textContent = 'Fetching...';
        pillEl.style.opacity = '0.7';
      }
      if (el.lyricsContainer) {
        setRightPanelLyricsEmptySmooth(false);
        el.lyricsContainer.innerHTML = '<div class="lyrics-fetching-state"><div class="lyrics-spinner"></div><span style="margin-top:8px;font-size:12px;opacity:0.85;letter-spacing:0.3px;">Fetching synced lyrics...</span></div>';
        el.lyricsContainer.style.opacity = '1';
      }
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 9000);
      try {
        const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/lyrics?title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}&online=${onlineParam}&source=${encodeURIComponent(source)}${durationParam}${vidParam}`, { signal: controller.signal });
        data = await res.json();
        if (data && data.success && data.lyrics) {
          lyricsSessionCache.set(lyricsCacheKey, data);
          const provKey = (data.isCustom ? 'custom' : data.provider) || source;
          const provLabel = (typeof LYRICS_SOURCE_NAMES !== 'undefined' && LYRICS_SOURCE_NAMES[provKey]) || provKey.toUpperCase();
          showToast(`Lyrics found · ${provLabel}`, 'info');
        }
      } catch (fetchErr) {
        data = null;
      } finally {
        clearTimeout(timeoutId);
        if (pillEl) pillEl.style.opacity = '1';
      }
    }

    if (token !== state.loadToken || (state.currentTrack && (state.currentTrack.title || '') !== title)) return;

    if (data && (data.isExplicit || (typeof isLyricsExplicit === 'function' && isLyricsExplicit(data.lyrics))) && state.currentTrack) {
      state.currentTrack.isExplicit = true;
      const canId = (typeof getTrackCanonicalId === 'function' ? getTrackCanonicalId(state.currentTrack) : '') || state.currentTrack.id;
      if (canId && explicitTrackCache) explicitTrackCache.add(canId);
      updateNowPlayingUI(state.currentTrack);
      const activeRowArtistWrap = document.querySelector('.track-row.playing .track-row-artist-wrap');
      if (activeRowArtistWrap && !activeRowArtistWrap.querySelector('.explicit-badge')) {
        const b = document.createElement('span');
        b.className = 'explicit-badge';
        b.title = 'Explicit';
        b.textContent = 'E';
        activeRowArtistWrap.prepend(b);
      }
    }

    if (!data || !data.success || !data.lyrics) {
      if (typeof syncLyricsOffsetUI === 'function') syncLyricsOffsetUI(source);
      if (el.lyricsStatus) el.lyricsStatus.textContent = '';
      if (el.lyricsContainer) {
        el.lyricsContainer.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;min-height:140px;opacity:0.5;font-size:13px;"><span>No lyrics found</span></div>';
        el.lyricsContainer.scrollTop = 0;
        el.lyricsContainer.style.opacity = '1';
      }
      setRightPanelLyricsEmptySmooth(false);
      return;
    }

    state.isCustomLyrics = !!data.isCustom;
    if (typeof syncLyricsOffsetUI === 'function') {
      syncLyricsOffsetUI(data.provider || (data.isCustom ? 'custom' : source));
    }

    const raw = data.lyrics;
    const lines = raw.split('\n');
    let parsed = [];
    const lrcRegex = /\[(\d+):(\d+(\.\d+)?)\](.*)/;
    const headerRegex = /\[(?!(?:\d+:\d+|instrumental|music|intro|outro|solo)\b)[^\]]*\]/gi;

    const gapPattern1 = /^[\s♪♫\-–—.]*$/;
    const gapPattern2 = /^[\(\[]?\s*(?:instrumental|music|intro|outro|solo|interlude|break)\s*[\)\]]?$/i;

    for (const line of lines) {
      const match = lrcRegex.exec(line);
      if (match) {
        const min = parseInt(match[1], 10);
        const sec = parseFloat(match[2]);
        const rawText = match[4].replace(headerRegex, '').trim();
        const lineTime = min * 60 + sec;
        if (!rawText || gapPattern1.test(rawText) || gapPattern2.test(rawText)) {
          parsed.push({ time: lineTime, text: '', isGap: true });
          continue;
        }
        const cleanText = rawText.replace(/<[^>]+>/g, '').trim();
        const enhWords = parseEnhancedLrcWords(rawText, lineTime, lineTime + 4.0);
        parsed.push({ time: lineTime, text: cleanText, words: enhWords || undefined });
      } else {
        const cleanPlain = line.replace(headerRegex, '').trim();
        if (cleanPlain) {
          if (gapPattern1.test(cleanPlain) || gapPattern2.test(cleanPlain)) {
            parsed.push({ time: -1, text: '', isGap: true });
          } else {
            parsed.push({ time: -1, text: cleanPlain });
          }
        }
      }
    }

    const curOffsetSec = typeof getTrackLyricsOffsetSec === 'function' ? getTrackLyricsOffsetSec() : 0;
    if (curOffsetSec !== 0) {
      parsed.forEach(l => {
        if (l.time != null && l.time >= 0) {
          l.time = Math.max(0, l.time + curOffsetSec);
        }
        if (Array.isArray(l.words)) {
          l.words.forEach(w => {
            if (w.start != null) w.start = Math.max(0, w.start + curOffsetSec);
            if (w.end != null) w.end = Math.max(0, w.end + curOffsetSec);
          });
        }
      });
    }

    if (parsed.length === 0) {
      if (el.lyricsStatus) el.lyricsStatus.textContent = '';
      if (el.lyricsContainer) {
        el.lyricsContainer.innerHTML = '';
        el.lyricsContainer.scrollTop = 0;
        el.lyricsContainer.style.opacity = '1';
      }
      setRightPanelLyricsEmptySmooth(true);
      return;
    }

    const hasSyncTimes = parsed.some(p => p.time >= 0);
    if (hasSyncTimes) {
      for (let i = 0; i < parsed.length; i++) {
        const t = String(parsed[i].text || '').trim();
        if (!t || gapPattern1.test(t) || gapPattern2.test(t)) {
          parsed[i] = { ...parsed[i], text: '', isGap: true };
        }
      }
      if (parsed.length > 0 && parsed[0].time >= 6) {
        parsed.unshift({ time: 0, text: '', isGap: true });
      }
      const withGaps = [];
      for (let i = 0; i < parsed.length; i++) {
        withGaps.push(parsed[i]);
        if (i < parsed.length - 1 && parsed[i].time >= 0 && parsed[i + 1].time >= 0 && !parsed[i].isGap && !parsed[i + 1].isGap) {
          const line = parsed[i];
          const estEnd = (line.words && line.words.length && (line.words[line.words.length - 1].end || line.words[line.words.length - 1].endTime))
            ? (line.words[line.words.length - 1].end || line.words[line.words.length - 1].endTime)
            : (line.time + 4.0);
          if (parsed[i + 1].time - estEnd >= 6) {
            withGaps.push({ time: estEnd, text: '', isGap: true });
          }
        }
      }
      parsed = withGaps;
    }

    state.syncedLyrics = parsed;
    if (el.lyricsStatus) el.lyricsStatus.textContent = data.isCustom ? (hasSyncTimes ? 'Custom synced' : 'Custom') : (hasSyncTimes ? 'Synced' : 'Plain');
    if (state.trEnabled && (state.trAuto || state.trActive)) {
      state.trActive = true;
      fetchAndApplyTranslation();
    } else {
      state.trActive = false;
      state.currentTranslations = null;
    }
    updateLyricsTranslationUI();
    renderLyricsView();
    setRightPanelLyricsEmptySmooth(false);
    if (el.lyricsContainer) {
      el.lyricsContainer.scrollTop = 0;
      el.lyricsContainer.style.opacity = '0';
      requestAnimationFrame(() => {
        el.lyricsContainer.style.transition = 'opacity 250ms cubic-bezier(0.2, 0, 0, 1)';
        el.lyricsContainer.style.opacity = '1';
      });
    }
    state.lastActiveLyricIdx = -1;
    state.forceLyricsScroll = true;
    state.forceSnapLyrics = true;
    if (el.nativeAudio) updateSyncedLyricsHighlight(el.nativeAudio.currentTime || 0);

    fetchAndUpgradeWords(title, artist, trackId, token);
  } catch (e) {
    if (token === state.loadToken) {
      if (el.lyricsStatus) el.lyricsStatus.textContent = '';
      if (el.lyricsContainer) {
        el.lyricsContainer.innerHTML = '';
        el.lyricsContainer.style.opacity = '1';
      }
      setRightPanelLyricsEmptySmooth(true);
    }
  }
}

function getLyricsWordStyle() { return localStorage.getItem('eclipse_lyrics_word_style') === 'words' ? 'words' : 'gradient'; }
function isGradientMode() { return state.lyricsMode === 'word' && getAdv('karaoke_words', true) && getLyricsWordStyle() === 'gradient'; }

function renderLyricsView() {
  if (!el.lyricsContainer) return;
  if (state.syncedLyrics.length === 0) return;
  el.lyricsContainer.innerHTML = '';

  state.syncedLyrics.forEach((line, index) => {
    const div = document.createElement('div');
    div.className = 'lyric-line';
    div.id = `lyric-line-${index}`;

    if (line.isGap) {
      div.classList.add('lyric-gap');
      div.innerHTML = `
        <div class="lyric-gap-wrap">
          <div class="lyric-gap-bars">
            <span class="gap-bar"></span>
            <span class="gap-bar"></span>
            <span class="gap-bar"></span>
            <span class="gap-bar"></span>
          </div>
          <svg class="lyric-gap-note" width="15" height="15" viewBox="0 0 24 24" fill="#ffffff">
            <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
          </svg>
        </div>
      `;
    } else {
      const lineText = line.text || '';
      const isRtl = (typeof window.isRtlLanguageCode === 'function' && window.isRtlLanguageCode(state?.lyricsTranslationLang)) || (typeof RTL_CHAR_RE !== 'undefined' ? RTL_CHAR_RE.test(lineText) : (typeof isRtlText === 'function' && isRtlText(lineText)));
      if (isRtl) {
        div.setAttribute('dir', 'rtl');
        div.classList.add('rtl-line', 'rtl');
      }

      if (isGradientMode()) {
        const { mainText, parenText, startRatio, endRatio } = splitLyricParensToEnd(lineText);
        div.classList.add('gradient-line');
        const fillMain = document.createElement('span');
        fillMain.className = 'lyric-fill lyric-fill-main';
        fillMain.textContent = mainText;
        div.appendChild(fillMain);
        if (parenText) {
          const fillParen = document.createElement('span');
          fillParen.className = 'lyric-fill lyric-paren';
          fillParen.dataset.startRatio = String(startRatio.toFixed(3));
          fillParen.dataset.endRatio = String(endRatio.toFixed(3));
          fillParen.textContent = ' ' + parenText;
          div.appendChild(fillParen);
        }
      } else if (line.words && Array.isArray(line.words) && line.words.length > 0) {
        div.innerHTML = '';
        let inParen = false;
        line.words.forEach((wObj, wIdx) => {
          const wText = typeof wObj === 'string' ? wObj : (wObj ? (wObj.word || wObj.text || '') : '');
          if (!wText) return;
          if (/^[\(\[]/.test(wText)) inParen = true;
          const wSpan = document.createElement('span');
          wSpan.className = 'lyric-word' + (inParen ? ' lyric-paren' : '');
          wSpan.dataset.wordIdx = String(wIdx);
          wSpan.textContent = wText;
          div.appendChild(wSpan);
          if (wIdx < line.words.length - 1) {
            div.appendChild(document.createTextNode(' '));
          }
          if (/[\)\]]$/.test(wText)) inParen = false;
        });
      } else {
        div.innerHTML = '';
        let inParen = false;
        const tokens = String(lineText).trim().split(/\s+/).filter(Boolean);
        tokens.forEach((tok, wIdx) => {
          if (/^[\(\[]/.test(tok)) inParen = true;
          const wSpan = document.createElement('span');
          wSpan.className = 'lyric-word' + (inParen ? ' lyric-paren' : '');
          wSpan.dataset.wordIdx = String(wIdx);
          wSpan.textContent = tok;
          div.appendChild(wSpan);
          if (wIdx < tokens.length - 1) {
            div.appendChild(document.createTextNode(' '));
          }
          if (/[\)\]]$/.test(tok)) inParen = false;
        });
      }

      if (state.romActive && state.currentRomanized && state.currentRomanized[index] && state.currentRomanized[index] !== line.text) {
        const romDiv = document.createElement('div');
        romDiv.className = 'lyric-translation lyric-romaji';
        romDiv.dir = 'auto';
        romDiv.textContent = state.currentRomanized[index];
        div.appendChild(romDiv);
      }
      const trVal = (state.trActive && state.currentTranslations && state.currentTranslations[index]) || '';
      const origText = (line.text || '').trim().toLowerCase();
      const trClean = trVal.trim().toLowerCase();
      if (trClean && trClean !== origText) {
        const trDiv = document.createElement('div');
        trDiv.className = 'lyric-translation';
        trDiv.dir = 'auto';
        trDiv.textContent = trVal;
        div.appendChild(trDiv);
      }
    }

    if (line.time >= 0) {
      div.addEventListener('click', () => {
        abortAutoMixIfActive('seek');
        const seekTime = getLineStartTime(index);
        if (el.nativeAudio && seekTime >= 0) el.nativeAudio.currentTime = seekTime;
      });
    }
    el.lyricsContainer.appendChild(div);
  });
  updateLyricsPadding();
  state.lastActiveLyricIdx = -1;
  state.forceLyricsScroll = true;
  state.forceSnapLyrics = true;
  if (el.nativeAudio) updateSyncedLyricsHighlight(el.nativeAudio.currentTime || 0);
  renderMiniLyrics();
  tagWrappedLyricRows(el.lyricsContainer);
}

function renderMiniLyrics() {
  const container = document.getElementById('mini-lyrics-container');
  if (!container) return;
  if (!state.syncedLyrics || state.syncedLyrics.length === 0) {
    container.innerHTML = '<div class="mini-lyrics-empty">No lyrics</div>';
    return;
  }
  container.innerHTML = '';
  state.syncedLyrics.forEach((line, index) => {
    const div = document.createElement('div');
    div.className = 'mini-lyric-line';
    div.id = `mini-lyric-line-${index}`;
    div.setAttribute('dir', 'auto');
    if (line.isGap) {
      div.classList.add('lyric-gap');
      div.innerHTML = '<span class="lyric-gap-box"><i></i><i></i><i></i></span>';
    } else if (line.words && Array.isArray(line.words) && line.words.length > 0) {
      div.innerHTML = '';
      let inParen = false;
      line.words.forEach((wObj, wIdx) => {
        const wText = typeof wObj === 'string' ? wObj : (wObj ? (wObj.word || wObj.text || '') : '');
        if (!wText) return;
        if (/^[\(\[]/.test(wText)) inParen = true;
        const wSpan = document.createElement('span');
        wSpan.className = 'lyric-word' + (inParen ? ' lyric-paren' : '');
        wSpan.dataset.wordIdx = String(wIdx);
        wSpan.textContent = wText;
        div.appendChild(wSpan);
        if (wIdx < line.words.length - 1) {
          div.appendChild(document.createTextNode(' '));
        }
        if (/[\)\]]$/.test(wText)) inParen = false;
      });
    } else {
      div.innerHTML = '';
      let inParen = false;
      const tokens = String(line.text || '').trim().split(/\s+/).filter(Boolean);
      tokens.forEach((tok, wIdx) => {
        if (/^[\(\[]/.test(tok)) inParen = true;
        const wSpan = document.createElement('span');
        wSpan.className = 'lyric-word' + (inParen ? ' lyric-paren' : '');
        wSpan.dataset.wordIdx = String(wIdx);
        wSpan.textContent = tok;
        div.appendChild(wSpan);
        if (wIdx < tokens.length - 1) {
          div.appendChild(document.createTextNode(' '));
        }
        if (/[\)\]]$/.test(tok)) inParen = false;
      });
    }
    if (line.time >= 0) {
      div.addEventListener('click', () => {
        abortAutoMixIfActive('seek');
        const seekTime = getLineStartTime(index);
        if (el.nativeAudio && seekTime >= 0) el.nativeAudio.currentTime = seekTime;
      });
    }
    container.appendChild(div);
  });
}

function updateMiniLyricsHighlight(currentTime) {
  if (!document.body.classList.contains('mini') || !document.body.classList.contains('mini-lyrics-on')) return;
  if (!state.syncedLyrics || state.syncedLyrics.length === 0 || !state.isWindowVisible) return;
  const container = document.getElementById('mini-lyrics-container');
  if (!container) return;

  let activeIndex = -1;
  const validLines = [];
  for (let i = 0; i < state.syncedLyrics.length; i++) {
    const startTime = getLineStartTime(i);
    if (startTime >= 0) validLines.push({ time: startTime, index: i });
  }
  const lookAhead = state.isCustomLyrics ? 0.25 : 0.0;
  const matchTime = currentTime + lookAhead;
  for (let i = 0; i < validLines.length; i++) {
    const current = validLines[i];
    const next = validLines[i + 1];
    const nextTime = next ? next.time : Infinity;
    if (matchTime >= current.time && matchTime < nextTime) {
      activeIndex = current.index;
      break;
    }
  }

  const prevActive = container.querySelector('.mini-lyric-line.active');
  const prevIndex = prevActive ? parseInt(prevActive.id.replace('mini-lyric-line-', ''), 10) : -1;
  if (activeIndex !== prevIndex) {
    if (prevActive) {
      prevActive.classList.remove('active');
      prevActive.querySelectorAll('.lyric-word').forEach((w) => {
        const isP = w.classList.contains('lyric-paren') ? ' lyric-paren' : '';
        w.className = (prevIndex < activeIndex ? 'lyric-word past-word' : 'lyric-word') + isP;
      });
    }
    if (activeIndex >= 0) {
      const activeEl = document.getElementById(`mini-lyric-line-${activeIndex}`);
      if (activeEl) {
        activeEl.classList.add('active');
        const targetY = activeEl.offsetTop - (container.clientHeight / 2) + (activeEl.clientHeight / 2);
        container.scrollTo({ top: Math.max(0, targetY), behavior: 'smooth' });
      }
    }
  }

  if (activeIndex >= 0) {
    const activeEl = document.getElementById(`mini-lyric-line-${activeIndex}`);
    if (activeEl) {
      const line = state.syncedLyrics[activeIndex];
      if (line && line.words && Array.isArray(line.words) && line.words.length > 0) {
        const wordSpans = activeEl.querySelectorAll('.lyric-word');
        wordSpans.forEach((wSpan, wIdx) => {
          const w = line.words[wIdx];
          const wStart = w ? (w.time !== undefined ? w.time : (w.start || 0)) : (line.words[line.words.length - 1] ? (line.words[line.words.length - 1].endTime || line.words[line.words.length - 1].end || getLineEndTime(activeIndex)) : 0);
          const wEnd = w ? (w.endTime !== undefined ? w.endTime : (w.end || (line.words[wIdx + 1] ? (line.words[wIdx + 1].time || line.words[wIdx + 1].start) : getLineEndTime(activeIndex)))) : getLineEndTime(activeIndex);
          const isP = wSpan.classList.contains('lyric-paren') ? ' lyric-paren' : '';
          if (currentTime >= wEnd) {
            wSpan.className = 'lyric-word past-word' + isP;
          } else if (currentTime >= wStart) {
            wSpan.className = 'lyric-word active-word' + isP;
          } else {
            wSpan.className = 'lyric-word' + isP;
          }
        });
      } else if (getAdv('karaoke_words', true) && state.lyricsMode === 'word') {
        const currentLineTime = getLineStartTime(activeIndex);
        const nextLineTime = getLineEndTime(activeIndex);
        const lineDur = Math.max(0.5, nextLineTime - currentLineTime);
        const progress = Math.min(Math.max((matchTime - currentLineTime) / lineDur, 0), 0.999);
        if (window.electronAPI && window.electronAPI.updateFloatingLyrics) {
          const nextLineObj = state.syncedLyrics && state.syncedLyrics[activeIndex + 1];
          const floatProgress = progress * 100;
          let wordsPayload = null;
          if (line && line.words && Array.isArray(line.words) && line.words.length > 0) {
            wordsPayload = line.words.map(w => ({
              word: w.word || w.text || '',
              start: w.time !== undefined ? w.time : (w.start || 0),
              end: w.endTime !== undefined ? w.endTime : (w.end || 0)
            }));
          }
          const durSec3 = getReliableTrackDuration();
          const isFav3 = state.currentTrack && state.favorites ? state.favorites.some(f => isSameTrack(f, state.currentTrack)) : false;
          const cleanLineText = line && line.text ? line.text.replace(/<[^>]+>/g, '').trim() : '';
          window.electronAPI.updateFloatingLyrics({
            current: cleanLineText || (state.currentTrack ? state.currentTrack.title : 'Eclipse'),
            next: nextLineObj ? nextLineObj.text : '',
            progress: floatProgress,
            currentTime: matchTime,
            startTime: currentLineTime,
            endTime: nextLineTime,
            words: wordsPayload,
            isPlaying: state.isPlaying,
            duration: durSec3,
            thumbnail: state.currentTrack ? (state.currentTrack.artwork || state.currentTrack.coverUrl || '') : '',
            title: state.currentTrack ? state.currentTrack.title : '',
            artist: state.currentTrack ? state.currentTrack.artist : '',
            isLiked: isFav3,
            isMuted: !!state.isMuted,
            primaryColor: cachedPrimaryColor || '#a78bfa',
            isAutomixing: document.body.classList.contains('is-automixing'),
            perfMode: document.body.classList.contains('perf')
          });
        }
        const wordSpans = activeEl.querySelectorAll('.lyric-word');
        const currentWordIndex = Math.floor(progress * wordSpans.length);
        wordSpans.forEach((wSpan, wIdx) => {
          const isP = wSpan.classList.contains('lyric-paren') ? ' lyric-paren' : '';
          if (wIdx < currentWordIndex) {
            wSpan.className = 'lyric-word past-word' + isP;
          } else if (wIdx === currentWordIndex) {
            wSpan.className = 'lyric-word active-word' + isP;
          } else {
            wSpan.className = 'lyric-word' + isP;
          }
        });
      }
    }
  }
}

function updateLyricsPadding() {
  const c = el.lyricsContainer;
  if (!c || !c.clientHeight) return;
  const pad = Math.round(c.clientHeight * 0.42);
  c.style.paddingTop = `${pad}px`;
  c.style.paddingBottom = `${pad}px`;
  tagWrappedLyricRows(c);
}

const lyricsRomanizeCache = new Map();
async function fetchAndApplyRomanize() {
  if (!state.currentTrack || !state.syncedLyrics || state.syncedLyrics.length === 0) return;
  const track = state.currentTrack;
  const cacheKey = `${track.title || ''}|${track.artist || ''}`.toLowerCase();
  if (lyricsRomanizeCache.has(cacheKey)) {
    state.currentRomanized = lyricsRomanizeCache.get(cacheKey);
    renderLyricsView();
    if (el.nativeAudio) updateSyncedLyricsHighlight(el.nativeAudio.currentTime || 0);
    return;
  }
  const texts = state.syncedLyrics.map(l => l.text);
  try {
    const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/romanize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts })
    });
    const data = await res.json();
    if (data && data.success && Array.isArray(data.romanized)) {
      lyricsRomanizeCache.set(cacheKey, data.romanized);
      const curKey = `${(state.currentTrack && state.currentTrack.title) || ''}|${(state.currentTrack && state.currentTrack.artist) || ''}`.toLowerCase();
      if (curKey === cacheKey && state.romActive) {
        state.currentRomanized = data.romanized;
        renderLyricsView();
        if (el.nativeAudio) updateSyncedLyricsHighlight(el.nativeAudio.currentTime || 0);
      }
      return;
    }
  } catch (e) {
    console.error('Romanization error:', e);
  }
  if (typeof window !== 'undefined' && window.EclipseRomanizer && typeof window.EclipseRomanizer.romanize === 'function') {
    const offline = texts.map(t => window.EclipseRomanizer.romanize(t));
    const curKey = `${(state.currentTrack && state.currentTrack.title) || ''}|${(state.currentTrack && state.currentTrack.artist) || ''}`.toLowerCase();
    if (curKey === cacheKey && state.romActive) {
      state.currentRomanized = offline;
      renderLyricsView();
      if (el.nativeAudio) updateSyncedLyricsHighlight(el.nativeAudio.currentTime || 0);
    }
  }
}

const lyricsTranslationCache = new Map();
async function fetchAndApplyTranslation() {
  if (!state.currentTrack || !state.syncedLyrics || state.syncedLyrics.length === 0) return;
  const track = state.currentTrack;
  const lang = state.trLang || 'en';
  const textSample = (state.syncedLyrics || []).slice(0, 3).map(l => l.text).join('|');
  const cacheKey = `${track.title || ''}|${track.artist || ''}|${lang}|${(state.syncedLyrics || []).length}|${textSample}`.toLowerCase();

  if (lyricsTranslationCache.has(cacheKey)) {
    state.currentTranslations = lyricsTranslationCache.get(cacheKey);
    renderLyricsView();
    if (el.nativeAudio) updateSyncedLyricsHighlight(el.nativeAudio.currentTime || 0);
    return;
  }

  const texts = state.syncedLyrics.map(l => l.text);
  try {
    const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts, targetLang: lang })
    });
    const data = await res.json();
    if (data && data.success && Array.isArray(data.translations)) {
      lyricsTranslationCache.set(cacheKey, data.translations);
      const curKey = `${(state.currentTrack && state.currentTrack.title) || ''}|${(state.currentTrack && state.currentTrack.artist) || ''}|${state.trLang || 'en'}`.toLowerCase();
      if (curKey === cacheKey && state.trActive) {
        state.currentTranslations = data.translations;
        renderLyricsView();
        if (el.nativeAudio) updateSyncedLyricsHighlight(el.nativeAudio.currentTime || 0);
      }
    }
  } catch (e) {
    console.error('Translation error:', e);
  }
}

function updateLyricsTranslationUI() {
  if (el.btnTrEnabled) el.btnTrEnabled.classList.toggle('active', !!state.trEnabled);
  if (el.selectTrLang) el.selectTrLang.value = state.trLang || 'en';
  const trLangMenu = document.getElementById('tr-lang-menu');
  const trLangLabel = document.getElementById('tr-lang-label');
  const curLang = state.trLang || 'en';
  if (trLangMenu) {
    trLangMenu.querySelectorAll('.m3-dropdown-option').forEach(opt => {
      const isSel = opt.dataset.value === curLang;
      opt.classList.toggle('selected', isSel);
      if (isSel && trLangLabel) trLangLabel.textContent = opt.textContent;
    });
  }
  if (trLangLabel && (!trLangMenu || !trLangMenu.querySelector('.m3-dropdown-option.selected'))) {
    const found = TRANSLATION_LANGUAGES.find(l => l.code === curLang);
    if (found) trLangLabel.textContent = `${found.flag} ${found.name} (${found.code})`;
  }
  if (el.btnTrAuto) el.btnTrAuto.classList.toggle('active', !!state.trAuto);
  if (el.btnRomanizeLyrics) {
    const hasCjk = (state.syncedLyrics || []).some(l => /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/.test(l.text || ''));
    el.btnRomanizeLyrics.classList.toggle('hidden', !hasCjk);
    el.btnRomanizeLyrics.classList.toggle('active', !!state.romActive);
  }
  if (el.btnTranslateLyrics) {
    el.btnTranslateLyrics.classList.toggle('hidden', !state.trEnabled);
    el.btnTranslateLyrics.classList.toggle('active', !!state.trActive);
  }
}

const CUSTOM_SHIFT_LEAD_SECONDS = 4.0;

function updateActiveGapProgress(gapEl, time) {
  if (!gapEl || !state.syncedLyrics) return;
  const lineIdx = gapEl.id ? parseInt(gapEl.id.replace('lyric-line-', ''), 10) : -1;
  if (lineIdx < 0 || !state.syncedLyrics[lineIdx]?.isGap) return;
  const start = typeof getLineStartTime === 'function' ? getLineStartTime(lineIdx) : 0;
  const end = typeof getLineEndTime === 'function' ? getLineEndTime(lineIdx) : (start + 4.0);
  const dur = Math.max(0.1, end - start);
  const effectiveTime = (time !== undefined && time !== null) ? time : ((el.nativeAudio ? el.nativeAudio.currentTime : 0));
  const progress = Math.min(1, Math.max(0, (effectiveTime - start) / dur));
  const pct = progress >= 0.999 ? '100%' : (progress * 100).toFixed(2) + '%';
  if (gapEl.style.getPropertyValue('--gap-pct') !== pct) {
    gapEl.style.setProperty('--gap-pct', pct);
  }
}

function getLineStartTime(idx) {
  const lines = state.syncedLyrics;
  if (idx < 0 || idx >= lines.length) return -1;
  const raw = lines[idx].time;
  if (raw < 0) return -1;
  if (!state.isCustomLyrics) return raw;
  for (let j = idx - 1; j >= 0; j--) {
    if (lines[j].time >= 0) return lines[j].time;
  }
  return Math.max(0, raw - CUSTOM_SHIFT_LEAD_SECONDS);
}

function getLineEndTime(idx) {
  const start = getLineStartTime(idx);
  const lines = state.syncedLyrics;
  for (let j = idx + 1; j < lines.length; j++) {
    const t = getLineStartTime(j);
    if (t >= 0) return t;
  }
  return start + 4.0;
}

function customBezierEase(t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  let s = t;
  for (let i = 0; i < 8; i++) {
    const inv = 1 - s;
    const currentX = (3 * inv * inv * s * 0.722) + (s * s * s);
    const dx = (3 * inv * inv * 0.722) - (6 * inv * s * 0.722) + (3 * s * s);
    if (Math.abs(currentX - t) < 1e-5 || Math.abs(dx) < 1e-5) break;
    s -= (currentX - t) / dx;
  }
  s = Math.max(0, Math.min(1, s));
  const inv = 1 - s;
  return (3 * inv * inv * s * 0.679) + (3 * inv * s * s * 1.008) + (s * s * s);
}

const LYRIC_EASINGS = {
  inout: { css: 'cubic-bezier(0.722, 0.679, 0, 1.008)', fn: customBezierEase },
  quad: { css: 'cubic-bezier(0.45, 0, 0.55, 1)', fn: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2) },
  sine: { css: 'cubic-bezier(0.37, 0, 0.63, 1)', fn: (t) => -(Math.cos(Math.PI * t) - 1) / 2 },
  out: { css: 'cubic-bezier(0.22, 1, 0.36, 1)', fn: (t) => 1 - Math.pow(1 - t, 4) },
  outsine: { css: 'cubic-bezier(0.39, 0.575, 0.565, 1)', fn: (t) => Math.sin((t * Math.PI) / 2) },
  expo: { css: 'cubic-bezier(0.16, 1, 0.3, 1)', fn: (t) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t)) },
  linear: { css: 'linear', fn: (t) => t }
};

function getLyricsEase() {
  const v = localStorage.getItem('eclipse_lyrics_ease');
  return LYRIC_EASINGS[v] ? v : 'inout';
}

function getLyricsSpeed() {
  const v = parseFloat(localStorage.getItem('eclipse_lyrics_speed'));
  return (v >= 0.5 && v <= 2.5) ? v : 1.0;
}

function applyLyricsEase() {
  const ease = LYRIC_EASINGS[getLyricsEase()] || LYRIC_EASINGS.inout;
  document.documentElement.style.setProperty('--lyric-ease', ease.css);
  const speed = getLyricsSpeed();
  const baseDuration = getLyricsEase() === 'inout' ? 0.48 : 0.45;
  document.documentElement.style.setProperty('--lyric-duration', `${(baseDuration / speed).toFixed(2)}s`);
}

function getLyricsGradientTightness() {
  const v = parseInt(localStorage.getItem('eclipse_lyrics_gradient_tightness') || localStorage.getItem('eclipse_gradient_tight'), 10);
  return (v >= 0 && v <= 40) ? v : 2;
}

function applyLyricsGradientTightness() {
  const span = getLyricsGradientTightness();
  document.documentElement.style.setProperty('--lyric-gradient-span', `${span}%`);
  document.documentElement.style.setProperty('--lyric-gradient-full', `${100 + span}%`);
  document.documentElement.style.setProperty('--lyric-fw', `${span}%`);
}

let lyricsScrollRaf = 0;
function animateLyricsScroll(container, target) {
  cancelAnimationFrame(lyricsScrollRaf);
  const from = container.scrollTop;
  const delta = target - from;
  if (Math.abs(delta) < 1) return;
  const isInOut = getLyricsEase() === 'inout';
  const ease = (LYRIC_EASINGS[getLyricsEase()] || LYRIC_EASINGS.inout).fn;
  const speed = getLyricsSpeed();
  const baseDur = isInOut ? 480 : 420;
  const maxDur = isInOut ? 700 : 750;
  const duration = Math.max(120, Math.min(maxDur, Math.max(baseDur, Math.abs(delta) * 1.15)) / speed);
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / duration);
    container.scrollTop = from + delta * ease(t);
    if (t < 1) lyricsScrollRaf = requestAnimationFrame(step);
  };
  lyricsScrollRaf = requestAnimationFrame(step);
}

const PUNCT_OR_SPACE_REGEX = /^[\s\p{P}]$/u;
const CJK_REGEX = /^[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}]$/u;
const MARK_REGEX = /^\p{M}$/u;
const CYRILLIC_VOWELS = new Set('аеёиоуыэюяєіїўѣѵѫѧѩѭ');
const LATIN_VOWEL_EXTRA = new Set(['æ', 'ø', 'œ', 'ı']);

function getCharBaseWeight(c) {
  if (PUNCT_OR_SPACE_REGEX.test(c)) return 0.4;
  if (CJK_REGEX.test(c)) return 3.0;
  if (MARK_REGEX.test(c)) return 3.0;
  const lower = c.toLowerCase();
  if (CYRILLIC_VOWELS.has(lower)) return 3.0;
  const base = c.normalize('NFD')[0].toLowerCase();
  if ('aeiouy'.includes(base) || LATIN_VOWEL_EXTRA.has(lower)) return 3.0;
  return 1.0;
}

let gradientLineCache = {
  lineEl: null,
  lineIdx: -1,
  text: '',
  N: 0,
  cumWeights: null,
  totalWeight: 0
};

function getLineGradientWeights(lineEl, idx, text) {
  if (gradientLineCache.lineEl === lineEl && gradientLineCache.lineIdx === idx && gradientLineCache.text === text) {
    return gradientLineCache;
  }
  const chars = Array.from(text);
  const N = chars.length;
  if (N === 0) {
    gradientLineCache = { lineEl, lineIdx: idx, text, N: 0, cumWeights: null, totalWeight: 0 };
    return gradientLineCache;
  }
  const outroStart = Math.floor(N * 0.8);
  const cumWeights = new Float64Array(N + 1);
  cumWeights[0] = 0;
  let total = 0;
  for (let i = 0; i < N; i++) {
    const baseW = getCharBaseWeight(chars[i]);
    const w = (i >= outroStart) ? baseW * 1.6 : baseW;
    total += w;
    cumWeights[i + 1] = total;
  }
  gradientLineCache = {
    lineEl,
    lineIdx: idx,
    text,
    N,
    cumWeights,
    totalWeight: total
  };
  return gradientLineCache;
}

let gradientRaf = 0;
function updateActiveGradient() {
  const lineEl = document.querySelector('.lyric-line.active.gradient-line');
  if (!lineEl || !el.nativeAudio) return;
  const fillMain = lineEl.querySelector('.lyric-fill-main') || lineEl.firstElementChild;
  if (!fillMain) return;
  const fillParen = lineEl.querySelector('.lyric-fill.lyric-paren');

  const idx = parseInt(lineEl.id.replace('lyric-line-', ''), 10);
  const start = getLineStartTime(idx);
  const dur = Math.max(0.5, getLineEndTime(idx) - start);
  const t = el.nativeAudio.currentTime + (state.isCustomLyrics ? 0.25 : 0);
  const tau = Math.min(1, Math.max(0, (t - start) / dur));

  const mainStr = fillMain.textContent || '';
  const parenStr = fillParen ? (fillParen.textContent || '') : '';
  const fullText = mainStr + parenStr;
  const cache = getLineGradientWeights(lineEl, idx, fullText);

  let k = tau;
  if (cache.N > 0 && cache.totalWeight > 0) {
    if (tau <= 0) k = 0;
    else if (tau >= 1) k = 1;
    else {
      const tw = tau * cache.totalWeight;
      const cw = cache.cumWeights;
      const N = cache.N;
      let low = 0, high = N - 1, i = 0;
      while (low <= high) {
        const mid = (low + high) >> 1;
        if (cw[mid + 1] <= tw) low = mid + 1;
        else if (cw[mid] > tw) high = mid - 1;
        else { i = mid; break; }
      }
      const charWeight = cw[i + 1] - cw[i];
      const pi = charWeight > 0 ? (tw - cw[i]) / charWeight : 0;
      k = Math.min(1, Math.max(0, (i + pi) / N));
    }
  }

  if (fillParen && parenStr.length > 0) {
    const pStart = parseFloat(fillParen.dataset.startRatio || '0.7');
    const pEnd = Math.max(pStart + 0.1, parseFloat(fillParen.dataset.endRatio || '1.0'));
    const kMain = Math.min(1, Math.max(0, k));
    const kParen = Math.min(1, Math.max(0, (k - pStart) / (pEnd - pStart)));
    fillMain.style.setProperty('--k', kMain.toFixed(4));
    fillParen.style.setProperty('--k', kParen.toFixed(4));
  } else {
    fillMain.style.setProperty('--k', k.toFixed(4));
  }
}

function startGradientLoop() {
  if (gradientRaf) return;
  const tick = () => {
    gradientRaf = 0;
    if (!state.isPlaying || !state.isWindowVisible || !isGradientMode()) return;
    updateActiveGradient();
    gradientRaf = requestAnimationFrame(tick);
  };
  gradientRaf = requestAnimationFrame(tick);
}

function getLyricTargetScroll(activeEl, parent) {
  if (!activeEl || !parent) return 0;
  let top = 0;
  let curr = activeEl;
  let reachedParent = false;
  while (curr) {
    if (curr === parent) {
      reachedParent = true;
      break;
    }
    top += curr.offsetTop;
    curr = curr.offsetParent;
  }
  const parentH = parent.clientHeight;
  const lineH = activeEl.offsetHeight;
  if (!reachedParent) {
    const pR = parent.getBoundingClientRect(), lR = activeEl.getBoundingClientRect();
    if (pR.height > 0) {
      return Math.max(0, parent.scrollTop + (lR.top - pR.top) - (pR.height / 2) + (lR.height / 2));
    }
    return 0;
  }
  return Math.max(0, top - (parentH / 2) + (lineH / 2));
}

function sendFloatingLyricsUpdate(currentTime) {
  if (!state.isFloatingLyricsOpen || !window.electronAPI || !window.electronAPI.updateFloatingLyrics) return;
  const cur = typeof currentTime === 'number' ? currentTime : (el.nativeAudio ? el.nativeAudio.currentTime || 0 : 0);

  if (state.syncedLyrics && state.syncedLyrics.length > 0) {
    let activeIndex = -1;
    const validLines = [];
    for (let i = 0; i < state.syncedLyrics.length; i++) {
      const startTime = getLineStartTime(i);
      if (startTime >= 0) validLines.push({ time: startTime, index: i });
    }
    for (let i = 0; i < validLines.length; i++) {
      const current = validLines[i];
      const next = validLines[i + 1];
      const nextTime = next ? next.time : Infinity;
      if (cur >= current.time && cur < nextTime) {
        activeIndex = current.index;
        break;
      }
    }

    if (activeIndex >= 0) {
      const curLine = state.syncedLyrics[activeIndex];
      const nextLine = state.syncedLyrics[activeIndex + 1];
      const curLineTime = getLineStartTime(activeIndex);
      const nextLineTime = getLineEndTime(activeIndex);
      const lineDur = Math.max(0.5, nextLineTime - curLineTime);
      const progress = Math.min(Math.max((cur - curLineTime) / lineDur, 0), 1);
      const cleanCur = (curLine.text || '').replace(/<[^>]+>/g, '').trim();
      const cleanNext = nextLine ? (nextLine.text || '').replace(/<[^>]+>/g, '').trim() : '';

      const trCur = (state.trActive && state.currentTranslations && state.currentTranslations[activeIndex]) || '';
      const displayNext = trCur ? `[${trCur}] ${cleanNext}` : cleanNext;

      const durSec = getReliableTrackDuration();
      const isFav = state.currentTrack && state.favorites ? state.favorites.some(f => isSameTrack(f, state.currentTrack)) : false;
      window.electronAPI.updateFloatingLyrics({
        current: cleanCur || (state.currentTrack ? state.currentTrack.title : 'Eclipse'),
        next: displayNext,
        progress: progress * 100,
        isPlaying: state.isPlaying,
        currentTime: cur,
        duration: durSec,
        thumbnail: state.currentTrack ? (state.currentTrack.artwork || state.currentTrack.coverUrl || '') : '',
        title: state.currentTrack ? state.currentTrack.title : '',
        artist: state.currentTrack ? state.currentTrack.artist : '',
        isLiked: isFav,
        isMuted: !!state.isMuted,
        primaryColor: cachedPrimaryColor || '#a78bfa',
        isAutomixing: document.body.classList.contains('is-automixing'),
        perfMode: document.body.classList.contains('perf')
      });
      return;
    }
  }

  if (state.currentTrack) {
    const durSec = getReliableTrackDuration();
    const isFav = state.favorites ? state.favorites.some(f => isSameTrack(f, state.currentTrack)) : false;
    window.electronAPI.updateFloatingLyrics({
      current: state.currentTrack.title || 'Eclipse',
      next: state.currentTrack.artist || '',
      progress: 0,
      isPlaying: state.isPlaying,
      currentTime: cur,
      duration: durSec,
      thumbnail: state.currentTrack.artwork || state.currentTrack.coverUrl || '',
      title: state.currentTrack.title || '',
      artist: state.currentTrack.artist || '',
      isLiked: isFav,
      isMuted: !!state.isMuted,
      primaryColor: cachedPrimaryColor || '#a78bfa',
      isAutomixing: document.body.classList.contains('is-automixing'),
      perfMode: document.body.classList.contains('perf')
    });
  }
}

function updateSyncedLyricsHighlight(currentTime) {
  if (typeof updateMiniLyricsHighlight === 'function') updateMiniLyricsHighlight(currentTime);
  if (state.isFloatingLyricsOpen) {
    sendFloatingLyricsUpdate(currentTime);
  }
  if (state.syncedLyrics.length === 0 || (!state.isWindowVisible && !state.isFloatingLyricsOpen)) return;
  let activeIndex = -1;

  const validLines = [];
  for (let i = 0; i < state.syncedLyrics.length; i++) {
    const startTime = getLineStartTime(i);
    if (startTime >= 0) {
      validLines.push({ time: startTime, index: i });
    }
  }

  const lookAhead = state.isCustomLyrics ? 0.25 : 0.0;
  const matchTime = currentTime + lookAhead;

  for (let i = 0; i < validLines.length; i++) {
    const current = validLines[i];
    const next = validLines[i + 1];
    const nextTime = next ? next.time : Infinity;
    if (matchTime >= current.time && matchTime < nextTime) {
      activeIndex = current.index;
      break;
    }
  }

  if (activeIndex >= 0 && state.isPlaying) {
    const currentLineTime = getLineStartTime(activeIndex);
    const nextLineTime = getLineEndTime(activeIndex);
    const lineDur = Math.max(0.5, nextLineTime - currentLineTime);
    const progress = Math.min(Math.max((matchTime - currentLineTime) / lineDur, 0), 0.999);

    const cleanText = state.syncedLyrics[activeIndex].text.replace(/<[^>]+>/g, '').trim();
    const words = cleanText.split(/\s+/).filter(Boolean);
    const totalWords = words.length;
    const currentWordIndex = totalWords > 0 ? Math.floor(progress * totalWords) : 0;
    const activeWordText = totalWords > 0 ? words[currentWordIndex] : '';

    const stateKey = `${activeIndex}-${currentWordIndex}`;
    if (state.lastBroadcastStateKey !== stateKey) {
      state.lastBroadcastStateKey = stateKey;
      sendStateToServer(activeWordText, currentWordIndex, activeIndex);
    }
  }

  const parent = el.lyricsContainer;
  const hasLayout = !!(parent && parent.clientHeight >= 40);
  const lineChanged = state.lastActiveLyricIdx !== activeIndex || state.forceLyricsScroll;
  const shouldSnap = state.forceSnapLyrics;
  let targetY = null;
  if (hasLayout && (lineChanged || shouldSnap) && getAdv('lyrics_autoscroll', true)) {
    if (activeIndex >= 0) {
      const activeEl = document.getElementById(`lyric-line-${activeIndex}`);
      if (activeEl) {
        targetY = getLyricTargetScroll(activeEl, parent);
        state.forceLyricsScroll = false;
        state.forceSnapLyrics = false;
        state.lastActiveLyricIdx = activeIndex;
      }
    } else {
      targetY = 0;
      state.forceLyricsScroll = false;
      state.forceSnapLyrics = false;
      state.lastActiveLyricIdx = activeIndex;
    }
  } else if (hasLayout && !state.forceLyricsScroll) {
    state.lastActiveLyricIdx = activeIndex;
  }

  document.querySelectorAll('.lyric-line').forEach((lineEl, idx) => {
    const line = state.syncedLyrics[idx];
    if (line && line.isGap) {
      if (idx < activeIndex) {
        lineEl.classList.add('past-gap');
      } else {
        lineEl.classList.remove('past-gap');
      }
    }
    if (lineChanged) lineEl.style.setProperty('--dist', activeIndex >= 0 ? Math.abs(idx - activeIndex) : 0);
    if (idx === activeIndex) {
      if (!lineEl.classList.contains('active')) lineEl.classList.add('active');

      if (isGradientMode()) {
        updateActiveGradient();
        startGradientLoop();
      } else if (getAdv('karaoke_words', true) && state.lyricsMode === 'word') {
        const curLine = state.syncedLyrics[idx];
        if (curLine && curLine.words && Array.isArray(curLine.words) && curLine.words.length > 0) {
          const wordSpans = lineEl.querySelectorAll('.lyric-word');
          wordSpans.forEach((wSpan, wIdx) => {
            const w = curLine.words[wIdx];
            const wStart = w ? (w.start !== undefined ? w.start : (w.time || 0)) : (curLine.words[curLine.words.length - 1] ? (curLine.words[curLine.words.length - 1].end || curLine.words[curLine.words.length - 1].endTime || getLineEndTime(idx)) : 0);
            const wEnd = w ? (w.end !== undefined ? w.end : (w.endTime || (curLine.words[wIdx + 1] ? (curLine.words[wIdx + 1].start || curLine.words[wIdx + 1].time) : getLineEndTime(idx)))) : getLineEndTime(idx);
            const isP = wSpan.classList.contains('lyric-paren') ? ' lyric-paren' : '';
            if (currentTime >= wEnd) {
              wSpan.className = 'lyric-word past-word' + isP;
            } else if (currentTime >= wStart) {
              wSpan.className = 'lyric-word active-word' + isP;
            } else {
              wSpan.className = 'lyric-word' + isP;
            }
          });
        } else {
          const currentLineTime = getLineStartTime(idx);
          const nextLineTime = getLineEndTime(idx);
          const lineDur = Math.max(0.5, nextLineTime - currentLineTime);
          const progress = Math.min(Math.max((matchTime - currentLineTime) / lineDur, 0), 0.999);

          const wordSpans = lineEl.querySelectorAll('.lyric-word');
          const totalWords = wordSpans.length;
          const currentWordIndex = Math.floor(progress * totalWords);

          wordSpans.forEach((wSpan, wIdx) => {
            const isP = wSpan.classList.contains('lyric-paren') ? ' lyric-paren' : '';
            if (wIdx < currentWordIndex) {
              wSpan.className = 'lyric-word past-word' + isP;
            } else if (wIdx === currentWordIndex) {
              wSpan.className = 'lyric-word active-word' + isP;
            } else {
              wSpan.className = 'lyric-word' + isP;
            }
          });
        }
      }
    } else {
      lineEl.classList.remove('active');
      if (lineEl.classList.contains('gradient-line')) {
        lineEl.querySelectorAll('.lyric-fill').forEach(f => f.style.setProperty('--k', '0'));
      }
      if (!isGradientMode() && getAdv('karaoke_words', true) && state.lyricsMode === 'word') {
        lineEl.querySelectorAll('.lyric-word').forEach(wSpan => {
          const isP = wSpan.classList.contains('lyric-paren') ? ' lyric-paren' : '';
          wSpan.className = (idx < activeIndex ? 'lyric-word past-word' : 'lyric-word') + isP;
        });
      }
    }
  });
  if (targetY !== null && parent) {
    if (shouldSnap) {
      cancelAnimationFrame(lyricsScrollRaf);
      parent.scrollTop = targetY;
    } else {
      animateLyricsScroll(parent, targetY);
    }
  }
}

function updateLyricsModeButton() {
  if (!el.btnLyricsMode) return;
  const isWordEnabled = getAdv('karaoke_words', true);
  if (!isWordEnabled && state.lyricsMode === 'word') {
    state.lyricsMode = 'line';
  }
  const lblEl = el.btnLyricsMode.querySelector('span');
  tSet(lblEl, state.lyricsMode === 'word' ? 'Word' : 'Line');
}

let lyricsContainerParent = null;
let lyricsContainerSibling = null;
let tvIdleTimer = null;

function resetTvIdleTimer() {
  if (!state.isTvKaraokeOpen || !el.tvKaraoke) return;
  el.tvKaraoke.classList.remove('tv-idle');
  clearTimeout(tvIdleTimer);
  tvIdleTimer = setTimeout(() => {
    const tvkPanel = document.getElementById('tvk-panel');
    if (tvkPanel && tvkPanel.classList.contains('open')) return;
    if (state.isTvKaraokeOpen && el.tvKaraoke) {
      el.tvKaraoke.classList.add('tv-idle');
      if (localStorage.getItem('eclipse_tvk_auto_zen') === '1' && !el.tvKaraoke.classList.contains('tvk-zen-mode')) {
        el.tvKaraoke.classList.add('tvk-zen-mode');
        const btnZen = document.getElementById('btn-tvk-zen');
        if (btnZen) btnZen.classList.add('active');
      }
    }
  }, 4000);
}

let activeTvBannerKey = '';
let activeTvLayerIdx = 0;
let tvBannerTransitionTimer = null;

function syncTvBanner() {
  const tvBg = el.tvBg || document.getElementById('tv-bg');
  if (!tvBg) return;

  let layerA = document.getElementById('tv-bg-layer-a');
  let layerB = document.getElementById('tv-bg-layer-b');
  if (!layerA || !layerB) {
    tvBg.innerHTML = '<div class="tv-bg-layer active" id="tv-bg-layer-a"></div><div class="tv-bg-layer" id="tv-bg-layer-b"></div>';
    layerA = document.getElementById('tv-bg-layer-a');
    layerB = document.getElementById('tv-bg-layer-b');
    activeTvLayerIdx = 0;
    activeTvBannerKey = '';
  }

  const banner = document.getElementById('right-panel-banner');
  let bannerType = 'none';
  let bannerSrc = '';

  if (banner && banner.style.display !== 'none' && banner.style.opacity !== '0') {
    const bannerImg = banner.querySelector('.banner-image');
    const video = banner.querySelector('video');
    const img = banner.querySelector('img');
    if (video && video.src) {
      bannerType = 'video';
      bannerSrc = video.src;
    } else if (img && img.src) {
      bannerType = 'img';
      bannerSrc = img.src;
    } else if (bannerImg && bannerImg.style.backgroundImage && bannerImg.style.backgroundImage !== 'none') {
      bannerType = 'bg';
      bannerSrc = bannerImg.style.backgroundImage;
    } else if (banner.style.backgroundImage && banner.style.backgroundImage !== 'none') {
      bannerType = 'bg';
      bannerSrc = banner.style.backgroundImage;
    }
  }

  if (bannerType === 'none') {
    const thumb = getTrackThumbUrl(state.currentTrack);
    if (thumb) {
      bannerType = 'fallback';
      bannerSrc = thumb;
    }
  }

  const newKey = `${bannerType}:${bannerSrc}`;
  if (newKey === activeTvBannerKey) return;

  const layers = [layerA, layerB];
  const prevLayer = layers[activeTvLayerIdx];
  const nextIdx = 1 - activeTvLayerIdx;
  const nextLayer = layers[nextIdx];

  if (tvBannerTransitionTimer) {
    clearTimeout(tvBannerTransitionTimer);
    tvBannerTransitionTimer = null;
  }

  nextLayer.innerHTML = '';
  nextLayer.style.backgroundImage = '';
  nextLayer.classList.remove('fallback');

  let transitionDone = false;
  const activateNext = () => {
    if (transitionDone) return;
    transitionDone = true;
    nextLayer.classList.add('active');
    prevLayer.classList.remove('active');
    activeTvLayerIdx = nextIdx;
    activeTvBannerKey = newKey;

    tvBannerTransitionTimer = setTimeout(() => {
      prevLayer.innerHTML = '';
      prevLayer.style.backgroundImage = '';
      prevLayer.classList.remove('fallback');
      tvBannerTransitionTimer = null;
    }, 550);
  };

  if (bannerType === 'video') {
    const vid = document.createElement('video');
    vid.autoplay = true;
    vid.loop = true;
    vid.muted = true;
    vid.playsInline = true;
    vid.src = bannerSrc;
    vid.onloadeddata = () => {
      vid.play().catch(() => {});
      activateNext();
    };
    vid.onerror = () => activateNext();
    nextLayer.appendChild(vid);
  } else if (bannerType === 'img') {
    const img = document.createElement('img');
    img.onload = () => activateNext();
    img.onerror = () => activateNext();
    img.src = bannerSrc;
    nextLayer.appendChild(img);
  } else if (bannerType === 'bg') {
    nextLayer.style.backgroundImage = bannerSrc;
    activateNext();
  } else if (bannerType === 'fallback') {
    nextLayer.classList.add('fallback');
    const img = new Image();
    img.onload = () => {
      nextLayer.style.backgroundImage = `url("${bannerSrc}")`;
      activateNext();
    };
    img.onerror = () => {
      nextLayer.style.backgroundImage = `url("${bannerSrc}")`;
      activateNext();
    };
    img.src = bannerSrc;
  } else {
    activateNext();
  }
}

function syncTvLayout(forcedNoLyrics) {
  const tv = el.tvKaraoke || document.getElementById('tv-karaoke');
  if (!tv) return;
  const panel = el.rightPanel || document.getElementById('right-panel');
  const noLyrics = typeof forcedNoLyrics === 'boolean'
    ? forcedNoLyrics
    : (panel ? panel.classList.contains('lyrics-empty') : (!state.syncedLyrics || state.syncedLyrics.length === 0));
  const wasNoLyrics = tv.classList.contains('tv-nolyrics');
  tv.classList.toggle('tv-nolyrics', !!noLyrics);
  if (wasNoLyrics !== !!noLyrics && typeof resizeCanvases === 'function') {
    requestAnimationFrame(resizeCanvases);
  }
}

let activeTvkAmbientCover = '';
const tvkPaletteCache = new Map();
const tvkBakedCoverCache = new Map();

[tvkPaletteCache].forEach(m => {
  const origSet = m.set.bind(m);
  m.set = function(k, v) {
    const res = origSet(k, v);
    if (typeof boundMap === 'function') boundMap(m, 30);
    return res;
  };
});

function extract10CoverColors(imgSrc) {
  const defaultMono = [
    [22, 22, 26], [34, 34, 40], [48, 48, 56], [28, 28, 34], [42, 42, 50],
    [18, 18, 22], [58, 58, 68], [30, 30, 36], [40, 40, 46], [25, 25, 30]
  ];
  if (!imgSrc) return Promise.resolve(defaultMono);
  if (tvkPaletteCache.has(imgSrc)) return Promise.resolve(tvkPaletteCache.get(imgSrc));

  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'Anonymous';
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = 40;
        c.height = 40;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0, 40, 40);
        const data = ctx.getImageData(0, 0, 40, 40).data;

        const colorful = [];
        for (let i = 0; i < data.length; i += 8) {
          const r = data[i], g = data[i + 1], b = data[i + 2];
          const hsl = rgbToHsl(r, g, b);
          if (hsl.l >= 12 && hsl.l <= 88 && hsl.s >= 18) {
            const weight = (hsl.s / 100) * (1 - Math.abs(hsl.l - 50) / 55);
            colorful.push({ r, g, b, h: hsl.h, s: hsl.s, l: hsl.l, weight });
          }
        }

        if (colorful.length < 12) {
          const monoPicked = [];
          for (let k = 0; k < 10; k++) {
            const v = 18 + Math.round((k / 9) * 52);
            monoPicked.push([v, v, Math.min(255, v + 3)]);
          }
          tvkPaletteCache.set(imgSrc, monoPicked);
          return resolve(monoPicked);
        }

        colorful.sort((a, b) => b.weight - a.weight);
        const pickedHsl = [];
        let minHueDiff = 22;
        while (pickedHsl.length < 6 && minHueDiff >= 4) {
          for (const p of colorful) {
            if (pickedHsl.length >= 6) break;
            const close = pickedHsl.some(ex => {
              const d = Math.abs(ex.h - p.h);
              return Math.min(d, 360 - d) < minHueDiff && Math.abs(ex.l - p.l) < 15;
            });
            if (!close) pickedHsl.push(p);
          }
          minHueDiff -= 6;
        }

        const finalRgb = [];
        for (let i = 0; i < 10; i++) {
          const base = pickedHsl[i % pickedHsl.length];
          const targetS = Math.max(35, Math.min(88, base.s));
          const lShift = (i >= pickedHsl.length) ? ((i % 2 === 0) ? 10 : -10) : 0;
          const targetL = Math.max(22, Math.min(56, base.l + lShift));
          const hex = hslToHex(base.h, targetS, targetL);
          const rgb = hexToRgb(hex);
          finalRgb.push([rgb.r, rgb.g, rgb.b]);
        }

        if (tvkPaletteCache.size >= 80) tvkPaletteCache.delete(tvkPaletteCache.keys().next().value);
        tvkPaletteCache.set(imgSrc, finalRgb);
        resolve(finalRgb);
      } catch (_) {
        resolve(defaultMono);
      }
    };
    img.onerror = () => resolve(defaultMono);
    img.src = imgSrc;
  });
}

function paintTvkLayerCanvas(canvas, colors, seedOffset = 0) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const c0 = colors[0] || [28, 28, 32];
  const c1 = colors[1] || c0;
  const c2 = colors[2] || c0;

  const baseGrad = ctx.createLinearGradient(0, 0, w, h);
  baseGrad.addColorStop(0, `rgb(${c0[0]}, ${c0[1]}, ${c0[2]})`);
  baseGrad.addColorStop(0.5, `rgb(${c1[0]}, ${c1[1]}, ${c1[2]})`);
  baseGrad.addColorStop(1, `rgb(${c2[0]}, ${c2[1]}, ${c2[2]})`);
  ctx.fillStyle = baseGrad;
  ctx.fillRect(0, 0, w, h);

  const positions = [
    [0.12, 0.18], [0.85, 0.15], [0.22, 0.82], [0.82, 0.78], [0.48, 0.32],
    [0.55, 0.68], [0.18, 0.48], [0.88, 0.46], [0.36, 0.14], [0.66, 0.88]
  ];
  for (let i = 0; i < 10; i++) {
    const pos = positions[(i + seedOffset) % positions.length];
    const cx = pos[0] * w;
    const cy = pos[1] * h;
    const rad = (0.48 + (i % 3) * 0.12) * Math.max(w, h);
    const col = colors[(i + seedOffset) % colors.length] || c0;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
    g.addColorStop(0, `rgba(${col[0]}, ${col[1]}, ${col[2]}, 0.92)`);
    g.addColorStop(0.45, `rgba(${col[0]}, ${col[1]}, ${col[2]}, 0.48)`);
    g.addColorStop(1, `rgba(${col[0]}, ${col[1]}, ${col[2]}, 0)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.fillStyle = 'rgba(0, 0, 0, 0.18)';
  ctx.fillRect(0, 0, w, h);
}

function syncTvkAmbientBg() {
  const container = document.getElementById('tvk-ambient-bg');
  if (!container) return;
  if (!container.querySelector('.tvk-ambient-blob.b4')) {
    container.innerHTML = '<div class="tvk-ambient-blob b1"></div><div class="tvk-ambient-blob b2"></div><div class="tvk-ambient-blob b3"></div><div class="tvk-ambient-blob b4"></div>';
  }
  const curTrack = state.currentTrack;
  const thumb = curTrack ? getTrackThumbUrl(curTrack) : '';

  if (tvkBakedCoverCache) {
    for (const [key, val] of tvkBakedCoverCache.entries()) {
      if (key !== thumb) {
        if (val && val.canvas) {
          try {
            val.canvas.width = 1;
            val.canvas.height = 1;
            val.canvas = null;
          } catch (_) {}
        }
        if (val && typeof val.getContext === 'function') {
          try {
            val.width = 1;
            val.height = 1;
          } catch (_) {}
        }
        tvkBakedCoverCache.delete(key);
      }
    }
    if (thumb && !tvkBakedCoverCache.has(thumb)) {
      tvkBakedCoverCache.set(thumb, { thumb, timestamp: Date.now() });
    }
    if (typeof boundMap === 'function') boundMap(tvkBakedCoverCache, 1);
  }

  if (thumb === activeTvkAmbientCover && container.dataset.painted === '1') return;
  activeTvkAmbientCover = thumb;
  container.dataset.painted = '1';
  const blobs = container.querySelectorAll('.tvk-ambient-blob');
  if (!thumb) {
    blobs.forEach(b => { b.style.backgroundImage = 'none'; });
    return;
  }
  const cssUrl = `url(${JSON.stringify(thumb)})`;
  blobs.forEach(b => { b.style.backgroundImage = cssUrl; });
}

function syncTvkAmbientPlayback() {
  const tv = el.tvKaraoke || document.getElementById('tv-karaoke');
  if (!tv) return;
  const paused = !state.isTvKaraokeOpen || tv.classList.contains('hidden') || tv.classList.contains('closing') || document.hidden || document.body.classList.contains('perf');
  tv.classList.toggle('tvk-bg-paused', paused);
}

let lastTvMetaTrackKey = '';
function updateTvKaraokeMeta() {
  const curTrack = state.currentTrack;
  const isExp = typeof isTrackExplicit === 'function' && isTrackExplicit(curTrack);
  const trackKey = curTrack ? `${curTrack.id || ''}:${curTrack.title || ''}:${curTrack.artist || ''}:${isExp ? '1' : '0'}` : '';
  const isNew = trackKey !== lastTvMetaTrackKey;
  lastTvMetaTrackKey = trackKey;

  const titleText = (curTrack && curTrack.title) || 'No track';
  const artistText = (curTrack && curTrack.artist) || '';

  if (el.tvKaraokeTitle) {
    if (isNew && el.tvKaraokeTitle.textContent !== titleText) {
      el.tvKaraokeTitle.style.opacity = '0';
      el.tvKaraokeTitle.style.transform = 'translateY(6px)';
      setTimeout(() => {
        el.tvKaraokeTitle.textContent = titleText;
        el.tvKaraokeTitle.style.opacity = '1';
        el.tvKaraokeTitle.style.transform = 'none';
      }, 120);
    } else {
      el.tvKaraokeTitle.textContent = titleText;
    }
  }
  if (el.tvKaraokeArtist) {
    const renderArtist = () => {
      renderClickableArtists(el.tvKaraokeArtist, artistText);
      if (isExp) {
        const badge = document.createElement('span');
        badge.className = 'explicit-badge';
        badge.title = 'Explicit';
        badge.textContent = 'E';
        el.tvKaraokeArtist.prepend(badge);
      }
    };

    if (isNew) {
      el.tvKaraokeArtist.style.opacity = '0';
      el.tvKaraokeArtist.style.transform = 'translateY(6px)';
      setTimeout(() => {
        renderArtist();
        el.tvKaraokeArtist.style.opacity = '1';
        el.tvKaraokeArtist.style.transform = 'none';
      }, 120);
    } else {
      renderArtist();
    }
  }

  const coverEl = el.tvCover || document.getElementById('tv-cover');
  if (coverEl) {
    if (typeof bindCoverHoldZoom === 'function') bindCoverHoldZoom(coverEl);
    const thumb = getTrackThumbUrl(curTrack);
    if (thumb) {
      if (coverEl.dataset.currentThumb !== thumb) {
        coverEl.dataset.currentThumb = thumb;
        const preImg = new Image();
        preImg.onload = () => {
          if (coverEl.dataset.currentThumb === thumb) {
            coverEl.style.opacity = '0';
            setTimeout(() => {
              coverEl.src = thumb;
              coverEl.style.display = 'block';
              coverEl.style.opacity = '1';
            }, 150);
          }
        };
        preImg.onerror = () => {
          coverEl.src = thumb;
          coverEl.style.display = 'block';
          coverEl.style.opacity = '1';
          coverEl.style.transform = 'scale(1)';
        };
        preImg.src = thumb;
      }
    } else {
      coverEl.dataset.currentThumb = '';
      coverEl.style.display = 'none';
      coverEl.src = '';
    }
  }
  syncTvBanner();
  syncTvLayout();
  syncTvkAmbientBg();
}

let tvkOutputInterval = null;
async function updateTvkOutput() {
  const nameEl = document.getElementById('tvk-output-name');
  const batteryEl = document.getElementById('tvk-battery');
  const batteryPctEl = document.getElementById('tvk-battery-pct');
  const batteryLevelEl = document.getElementById('tvk-battery-level');
  const outputContainer = document.getElementById('tvk-output');
  if (!nameEl) return;

  let deviceName = '';
  let batteryLevel = null;

  if (window.electronAPI && typeof window.electronAPI.getAudioOutputInfo === 'function') {
    try {
      const info = await window.electronAPI.getAudioOutputInfo();
      if (info && info.name && info.name !== 'Default output') {
        deviceName = info.name;
      }
      if (info && typeof info.battery === 'number') {
        batteryLevel = info.battery;
      }
    } catch (e) {}
  }

  if (!deviceName) {
    try {
      const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/audio-output-info`);
      if (res.ok) {
        const info = await res.json();
        if (info && info.name && info.name !== 'Default output') {
          deviceName = info.name;
        }
        if (info && typeof info.battery === 'number') {
          batteryLevel = info.battery;
        }
      }
    } catch (e) {}
  }

  if (!deviceName && !window.electronAPI?.getAudioOutputInfo && navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioOutputs = devices.filter(d => d.kind === 'audiooutput');
      const audioEl = el.nativeAudio || document.getElementById('native-audio');
      const sinkId = (audioEl && audioEl.sinkId) ? audioEl.sinkId : '';

      let matched = null;
      if (sinkId) {
        matched = audioOutputs.find(d => d.deviceId === sinkId);
      }
      if (!matched) {
        matched = audioOutputs.find(d => d.deviceId === 'default') || audioOutputs[0];
      }

      let label = matched && matched.label ? matched.label.trim() : '';
      label = label.replace(/^Default\s*[-–—:]\s*/i, '').trim();
      if (label && label.toLowerCase() !== 'default') {
        deviceName = label;
      }
    } catch (e) {}
  }

  const finalName = t(deviceName || 'Default output');
  nameEl.textContent = finalName;
  if (outputContainer) outputContainer.title = finalName;

  if (batteryEl && batteryPctEl && batteryLevelEl) {
    if (batteryLevel !== null && !isNaN(batteryLevel) && batteryLevel >= 0) {
      const clampedPct = Math.max(0, Math.min(100, Math.round(batteryLevel)));
      batteryPctEl.textContent = `${clampedPct}%`;
      const fillH = Math.max(clampedPct > 0 ? 1 : 0, Math.min(12, Math.round(12 * (clampedPct / 100))));
      const fillY = 19 - fillH;
      batteryLevelEl.setAttribute('y', fillY);
      batteryLevelEl.setAttribute('height', fillH);
      batteryLevelEl.setAttribute('x', '8');
      batteryLevelEl.setAttribute('width', '8');
      batteryEl.classList.remove('hidden');
      batteryEl.classList.toggle('battery-low', clampedPct <= 20);
      batteryEl.title = `Battery level: ${clampedPct}%`;
    } else {
      batteryEl.classList.add('hidden');
    }
  }
}

function openTvKaraoke() {
  if (!el.tvKaraoke || !el.lyricsContainer) return;
  if (state.isTvKaraokeOpen) return;
  state.isTvKaraokeOpen = true;

  lyricsContainerParent = el.lyricsContainer.parentElement;
  lyricsContainerSibling = el.lyricsContainer.nextSibling;

  if (el.tvKaraokeContent) {
    el.tvKaraokeContent.appendChild(el.lyricsContainer);
  }
  if (el.lyricsContainer) {
    el.lyricsContainer.style.paddingTop = '';
    el.lyricsContainer.style.paddingBottom = '';
    el.lyricsContainer.scrollTop = 0;
  }
  updateTvKaraokeMeta();
  syncTvBanner();
  syncTvLayout();
  syncTvkAmbientBg();
  el.tvKaraoke.classList.remove('closing');
  el.tvKaraoke.classList.remove('hidden');
  syncTvkAmbientPlayback();
  applyTvk();
  syncTvkUI();
  if (window.KaraokeMotionController && typeof window.KaraokeMotionController.syncDomFromState === 'function') {
    window.KaraokeMotionController.syncDomFromState();
  }
  resetTvIdleTimer();
  resizeCanvases();
  if (state.isPlaying) {
    if (audioEngine && audioEngine.setAnalyserEnabled) audioEngine.setAnalyserEnabled(true);
    startVisualizers();
  }

  cancelAnimationFrame(lyricsScrollRaf);
  renderLyricsView();
  const syncTvLyrics = () => {
    updateLyricsPadding();
    state.forceSnapLyrics = true;
    state.forceLyricsScroll = true;
    state.lastActiveLyricIdx = -1;
    if (el.nativeAudio) {
      const cur = el.nativeAudio.currentTime || 0;
      const dur = el.nativeAudio.duration || (state.currentTrack ? state.currentTrack.duration : 0);
      updateSyncedLyricsHighlight(cur);
      syncTvkTimeDisplay(formatDuration(cur), formatDuration(dur));
      if (el.tvkSeekSlider && dur > 0) el.tvkSeekSlider.value = Math.round((cur / dur) * 1000);
    }
  };
  syncTvLyrics();
  requestAnimationFrame(syncTvLyrics);
  setTimeout(syncTvLyrics, 50);
  setTimeout(syncTvLyrics, 150);
  const isTvPlaying = !!(state.isPlaying && el.nativeAudio && !el.nativeAudio.paused);
  updatePlayPauseButton(isTvPlaying, state.isBuffering);
  setPlayPauseState(isTvPlaying, false);
  updateTvkOutput();
  if (tvkOutputInterval) clearInterval(tvkOutputInterval);
  tvkOutputInterval = setInterval(updateTvkOutput, 30000);
}

function closeTvKaraoke() {
  if (!state.isTvKaraokeOpen || !el.tvKaraoke) return;
  state.isTvKaraokeOpen = false;
  syncTvkAmbientPlayback();
  clearTimeout(tvIdleTimer);
  if (tvkOutputInterval) {
    clearInterval(tvkOutputInterval);
    tvkOutputInterval = null;
  }
  const tvkPanel = document.getElementById('tvk-panel');
  if (tvkPanel) {
    tvkPanel.classList.remove('open');
    const btnSettings = document.getElementById('btn-tvk-settings');
    if (btnSettings) btnSettings.classList.remove('open');
  }
  el.tvKaraoke.classList.remove('tv-idle');
  el.tvKaraoke.classList.add('closing');
  setTimeout(() => {
    el.tvKaraoke.classList.remove('closing');
    el.tvKaraoke.classList.add('hidden');
    syncTvkAmbientPlayback();
  }, 320);

  const targetParent = (lyricsContainerParent && lyricsContainerParent.isConnected)
    ? lyricsContainerParent
    : (document.querySelector('.lyrics-section') || (el.rightPanel && el.rightPanel.querySelector('.lyrics-section')));
  if (targetParent && el.lyricsContainer) {
    if (lyricsContainerSibling && lyricsContainerSibling.parentNode === targetParent) {
      targetParent.insertBefore(el.lyricsContainer, lyricsContainerSibling);
    } else {
      targetParent.appendChild(el.lyricsContainer);
    }
  }
  if (el.lyricsContainer) {
    el.lyricsContainer.style.paddingTop = '';
    el.lyricsContainer.style.paddingBottom = '';
    el.lyricsContainer.scrollTop = 0;
  }

  cancelAnimationFrame(lyricsScrollRaf);
  renderLyricsView();
  const syncSidebarLyrics = () => {
    updateLyricsPadding();
    state.forceSnapLyrics = true;
    state.forceLyricsScroll = true;
    state.lastActiveLyricIdx = -1;
    if (el.nativeAudio) updateSyncedLyricsHighlight(el.nativeAudio.currentTime || 0);
  };
  syncSidebarLyrics();
  requestAnimationFrame(syncSidebarLyrics);
  setTimeout(syncSidebarLyrics, 50);
  setTimeout(syncSidebarLyrics, 150);
  setTimeout(syncSidebarLyrics, 300);
}

window.openTvKaraoke = openTvKaraoke;
window.closeTvKaraoke = closeTvKaraoke;

function toggleTvkZenMode() {
  if (!el.tvKaraoke) return;
  const isZen = el.tvKaraoke.classList.toggle('tvk-zen-mode');
  const btnZen = document.getElementById('btn-tvk-zen');
  if (btnZen) btnZen.classList.toggle('active', isZen);
  showToast(isZen ? 'Zen mode activated' : 'Zen mode deactivated', 'info');
}

const TVK_DEFAULTS = {
  font: 'inherit',
  align: 'center',
  size: 100,
  weight: 700,
  gap: 16,
  anim: 'focus',
  speed: 900,
  bassPulse: true
};

const TVK_FONTS = {
  'default': 'inherit',
  'inherit': 'inherit',
  'sf': typeof SF_FONT_STACK !== 'undefined' ? SF_FONT_STACK : 'system-ui, sans-serif',
  'SF Pro': typeof SF_FONT_STACK !== 'undefined' ? SF_FONT_STACK : 'system-ui, sans-serif',
  'serif': "Georgia, 'Times New Roman', serif",
  "Georgia, 'Times New Roman', serif": "Georgia, 'Times New Roman', serif",
  'rounded': "ui-rounded, 'Nunito', system-ui, sans-serif",
  "ui-rounded, 'Nunito', system-ui, sans-serif": "ui-rounded, 'Nunito', system-ui, sans-serif",
  'mono': "ui-monospace, 'JetBrains Mono', monospace",
  "ui-monospace, 'JetBrains Mono', monospace": "ui-monospace, 'JetBrains Mono', monospace",
  'condensed': "'Arial Narrow', 'Roboto Condensed', sans-serif",
  "'Arial Narrow', 'Roboto Condensed', sans-serif": "'Arial Narrow', 'Roboto Condensed', sans-serif"
};
if (typeof SF_FONT_STACK !== 'undefined') {
  TVK_FONTS[SF_FONT_STACK] = SF_FONT_STACK;
}

function getTvk() {
  try {
    const raw = localStorage.getItem('eclipse_tvk');
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        font: parsed.font || TVK_DEFAULTS.font,
        align: ['left', 'center', 'right'].includes(parsed.align) ? parsed.align : TVK_DEFAULTS.align,
        size: Number(parsed.size) || TVK_DEFAULTS.size,
        weight: Number(parsed.weight) || TVK_DEFAULTS.weight,
        gap: (parsed.gap !== undefined && !isNaN(Number(parsed.gap))) ? Number(parsed.gap) : TVK_DEFAULTS.gap,
        anim: parsed.anim || TVK_DEFAULTS.anim,
        speed: Number(parsed.speed) || TVK_DEFAULTS.speed,
        bassPulse: parsed.bassPulse !== undefined ? !!parsed.bassPulse : TVK_DEFAULTS.bassPulse
      };
    }
  } catch (_) {}
  return { ...TVK_DEFAULTS };
}

function saveTvk(settings) {
  try {
    localStorage.setItem('eclipse_tvk', JSON.stringify(settings));
  } catch (_) {}
}

function updateTvkVisualizerSetting(enabled) {
  const on = enabled !== false && enabled !== 'false';
  localStorage.setItem('eclipse_tvk_visualizer', on ? 'true' : 'false');
  const tv = document.getElementById('tv-karaoke');
  if (tv) {
    tv.classList.toggle('no-tvk-visualizer', !on);
  }
  const btnTvkVis = document.getElementById('btn-tvk-visualizer');
  if (btnTvkVis) btnTvkVis.classList.toggle('active', on);
  const btnTvkVisSetting = document.getElementById('btn-tvk-visualizer-setting');
  if (btnTvkVisSetting) btnTvkVisSetting.classList.toggle('active', on);
  if (on && state.isPlaying) {
    if (audioEngine && audioEngine.setAnalyserEnabled) audioEngine.setAnalyserEnabled(true);
    startVisualizers();
  }
}

function updateTvkVisualizerLyricsSetting(enabled) {
  const on = enabled !== false && enabled !== 'false';
  localStorage.setItem('eclipse_tvk_visualizer_lyrics', on ? 'true' : 'false');
  const tv = document.getElementById('tv-karaoke');
  if (tv) {
    tv.classList.toggle('tvk-show-lyrics-visualizer', on);
  }
  const btnTvkVisLyrics = document.getElementById('btn-tvk-visualizer-lyrics');
  if (btnTvkVisLyrics) btnTvkVisLyrics.classList.toggle('active', on);
  const btnTvkVisLyricsSetting = document.getElementById('btn-tvk-visualizer-lyrics-setting');
  if (btnTvkVisLyricsSetting) btnTvkVisLyricsSetting.classList.toggle('active', on);
  if (on && state.isPlaying) {
    if (audioEngine && audioEngine.setAnalyserEnabled) audioEngine.setAnalyserEnabled(true);
    startVisualizers();
  }
}

function updateTvkVisualizerOpacity(opacityVal) {
  let val = parseInt(opacityVal, 10);
  if (isNaN(val)) val = 85;
  val = Math.max(10, Math.min(100, val));
  localStorage.setItem('eclipse_tvk_visualizer_opacity', val.toString());

  const norm = (val / 100).toFixed(2);
  const tv = document.getElementById('tv-karaoke');
  if (tv) {
    tv.style.setProperty('--tvk-vis-opacity', norm);
  }

  const sliderPanel = document.getElementById('tvk-vis-opacity');
  if (sliderPanel && parseInt(sliderPanel.value, 10) !== val) sliderPanel.value = val;
  const valPanel = document.getElementById('val-tvk-vis-opacity');
  if (valPanel) valPanel.textContent = `${val}%`;

  const sliderSetting = document.getElementById('slider-tvk-vis-opacity-setting');
  if (sliderSetting && parseInt(sliderSetting.value, 10) !== val) sliderSetting.value = val;
  const valSetting = document.getElementById('val-tvk-vis-opacity-setting');
  if (valSetting) valSetting.textContent = `${val}%`;
}

function applyTvk() {
  const tv = document.getElementById('tv-karaoke');
  if (!tv) return;
  const s = getTvk();
  const font = TVK_FONTS[s.font] || s.font || 'inherit';
  if (s.font === 'sf' || font.includes('SF Pro')) {
    ensureSfFontLoaded();
  }
  const align = ['left', 'center', 'right'].includes(s.align) ? s.align : 'center';
  const scale = (Number(s.size) || 100) / 100;
  const weight = Number(s.weight) || 700;
  const gap = (s.gap !== undefined && !isNaN(Number(s.gap))) ? Number(s.gap) : 16;
  const speed = Number(s.speed) || 900;
  const anim = ['focus', 'smooth', 'slide', 'fade', 'pop', 'none'].includes(s.anim) ? s.anim : 'focus';

  tv.style.setProperty('--tvk-font', font);
  tv.style.setProperty('--tvk-scale', String(scale));
  tv.style.setProperty('--tvk-weight', String(weight));
  tv.style.setProperty('--tvk-gap', `${gap}px`);
  tv.style.setProperty('--tvk-speed', `${speed}ms`);
  tv.setAttribute('data-tvk-anim', anim);
  tv.setAttribute('data-tvk-align', align);

  const tvkVisOn = localStorage.getItem('eclipse_tvk_visualizer') !== 'false';
  tv.classList.toggle('no-tvk-visualizer', !tvkVisOn);
  const tvkVisLyricsOn = localStorage.getItem('eclipse_tvk_visualizer_lyrics') !== 'false';
  tv.classList.toggle('tvk-show-lyrics-visualizer', tvkVisLyricsOn);
  const visOpacity = parseInt(localStorage.getItem('eclipse_tvk_visualizer_opacity') || '85', 10);
  tv.style.setProperty('--tvk-vis-opacity', (Math.max(10, Math.min(100, visOpacity)) / 100).toFixed(2));
  tv.classList.toggle('tvk-bass-pulse-enabled', !!s.bassPulse);
}

function syncTvkUI() {
  const s = getTvk();
  const selFont = document.getElementById('tvk-font');
  const sliderSize = document.getElementById('tvk-size');
  const sliderWeight = document.getElementById('tvk-weight');
  const sliderGap = document.getElementById('tvk-gap');
  const selAnim = document.getElementById('tvk-anim');
  const sliderSpeed = document.getElementById('tvk-speed');

  const valSize = document.getElementById('val-tvk-size');
  const valWeight = document.getElementById('val-tvk-weight');
  const valGap = document.getElementById('val-tvk-gap');
  const valSpeed = document.getElementById('val-tvk-speed');

  const fontVal = TVK_FONTS[s.font] || s.font;
  if (selFont) {
    selFont.value = fontVal;
    if (!selFont.value) selFont.value = s.font;
  }
  const fontLabel = document.getElementById('tvk-font-label');
  const fontMenu = document.getElementById('tvk-font-menu');
  if (fontMenu) {
    const options = fontMenu.querySelectorAll('.m3-dropdown-option');
    let matched = false;
    options.forEach(opt => {
      const isMatch = opt.dataset.value === s.font || opt.dataset.value === fontVal;
      opt.classList.toggle('selected', isMatch);
      if (isMatch) {
        if (fontLabel) fontLabel.textContent = opt.textContent;
        matched = true;
      }
    });
    if (!matched && fontLabel) fontLabel.textContent = 'Default';
  }

  const alignGroup = document.getElementById('tvk-align-group');
  if (alignGroup) {
    alignGroup.querySelectorAll('.tvk-pill-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.value === s.align);
    });
  }

  const animGroup = document.getElementById('tvk-anim-group');
  if (animGroup) {
    animGroup.querySelectorAll('.tvk-pill-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.value === s.anim);
    });
  }
  if (selAnim) selAnim.value = s.anim;

  if (sliderSize) sliderSize.value = s.size;
  if (sliderWeight) sliderWeight.value = s.weight;
  if (sliderGap) sliderGap.value = s.gap;
  if (sliderSpeed) sliderSpeed.value = s.speed;

  if (valSize) valSize.textContent = `${s.size}%`;
  if (valWeight) valWeight.textContent = `${s.weight}`;
  if (valGap) valGap.textContent = `${s.gap}px`;
  if (valSpeed) valSpeed.textContent = `${s.speed}ms`;

  const tvkVisOn = localStorage.getItem('eclipse_tvk_visualizer') !== 'false';
  const btnTvkVis = document.getElementById('btn-tvk-visualizer');
  if (btnTvkVis) btnTvkVis.classList.toggle('active', tvkVisOn);
  const btnTvkVisSetting = document.getElementById('btn-tvk-visualizer-setting');
  if (btnTvkVisSetting) btnTvkVisSetting.classList.toggle('active', tvkVisOn);

  const btnTvkBassPulse = document.getElementById('btn-tvk-bass-pulse');
  if (btnTvkBassPulse) btnTvkBassPulse.classList.toggle('active', !!s.bassPulse);

  const tvkVisLyricsOn = localStorage.getItem('eclipse_tvk_visualizer_lyrics') !== 'false';
  const btnTvkVisLyrics = document.getElementById('btn-tvk-visualizer-lyrics');
  if (btnTvkVisLyrics) btnTvkVisLyrics.classList.toggle('active', tvkVisLyricsOn);
  const btnTvkVisLyricsSetting = document.getElementById('btn-tvk-visualizer-lyrics-setting');
  if (btnTvkVisLyricsSetting) btnTvkVisLyricsSetting.classList.toggle('active', tvkVisLyricsOn);

  const btnTvkVizConnectedEl = document.getElementById('btn-tvk-viz-connected');
  if (btnTvkVizConnectedEl) btnTvkVizConnectedEl.classList.toggle('active', localStorage.getItem('eclipse_viz_connected') === '1');

  const visOpacity = parseInt(localStorage.getItem('eclipse_tvk_visualizer_opacity') || '85', 10);
  const sliderTvkVisOpacity = document.getElementById('tvk-vis-opacity');
  if (sliderTvkVisOpacity) sliderTvkVisOpacity.value = visOpacity;
  const valTvkVisOpacity = document.getElementById('val-tvk-vis-opacity');
  if (valTvkVisOpacity) valTvkVisOpacity.textContent = `${visOpacity}%`;

  const sliderTvkVisOpacitySetting = document.getElementById('slider-tvk-vis-opacity-setting');
  if (sliderTvkVisOpacitySetting) sliderTvkVisOpacitySetting.value = visOpacity;
  const valTvkVisOpacitySetting = document.getElementById('val-tvk-vis-opacity-setting');
  if (valTvkVisOpacitySetting) valTvkVisOpacitySetting.textContent = `${visOpacity}%`;
}

function initTvk() {
  applyTvk();
  syncTvkUI();
  syncTvkAmbientBg();
  syncTvkAmbientPlayback();

  const btnSettings = document.getElementById('btn-tvk-settings');
  const panel = document.getElementById('tvk-panel');
  const btnReset = document.getElementById('btn-tvk-reset');

  const selFont = document.getElementById('tvk-font');
  const fontDropdown = document.getElementById('tvk-font-dropdown');
  const fontTrigger = document.getElementById('tvk-font-trigger');
  const fontMenu = document.getElementById('tvk-font-menu');

  const alignGroup = document.getElementById('tvk-align-group');
  const animGroup = document.getElementById('tvk-anim-group');

  const sliderSize = document.getElementById('tvk-size');
  const sliderWeight = document.getElementById('tvk-weight');
  const sliderGap = document.getElementById('tvk-gap');
  const selAnim = document.getElementById('tvk-anim');
  const sliderSpeed = document.getElementById('tvk-speed');

  const valSize = document.getElementById('val-tvk-size');
  const valWeight = document.getElementById('val-tvk-weight');
  const valGap = document.getElementById('val-tvk-gap');
  const valSpeed = document.getElementById('val-tvk-speed');

  let tvkCloseTimer = null;
  const openTvkPanel = () => {
    if (tvkCloseTimer) { clearTimeout(tvkCloseTimer); tvkCloseTimer = null; }
    if (panel) panel.classList.add('open');
    if (btnSettings) btnSettings.classList.add('open');
  };
  const closeTvkPanel = () => {
    if (panel) panel.classList.remove('open');
    if (btnSettings) btnSettings.classList.remove('open');
    const fd = document.getElementById('tvk-font-dropdown');
    if (fd) fd.classList.remove('open');
    resetTvIdleTimer();
  };
  const scheduleCloseTvkPanel = () => {
    if (tvkCloseTimer) clearTimeout(tvkCloseTimer);
    tvkCloseTimer = setTimeout(() => {
      const fd = document.getElementById('tvk-font-dropdown');
      if (fd && fd.classList.contains('open')) return;
      closeTvkPanel();
    }, 320);
  };

  const topZone = document.getElementById('tvk-top-hover-zone');
  if (topZone) {
    topZone.addEventListener('mouseenter', openTvkPanel);
    topZone.addEventListener('mouseleave', scheduleCloseTvkPanel);
  }
  if (panel) {
    panel.addEventListener('mouseenter', openTvkPanel);
    panel.addEventListener('mouseleave', scheduleCloseTvkPanel);
  }

  if (btnSettings && panel) {
    btnSettings.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = panel.classList.contains('open');
      if (!isOpen) {
        openTvkPanel();
      } else {
        closeTvkPanel();
      }
    });
  }

  document.addEventListener('click', (e) => {
    if (!panel || !panel.classList.contains('open')) return;
    if (!panel.contains(e.target) && (!btnSettings || !btnSettings.contains(e.target))) {
      closeTvkPanel();
    }
  });

  if (fontTrigger && fontDropdown) {
    fontTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      fontDropdown.classList.toggle('open');
    });
  }

  if (fontMenu) {
    fontMenu.querySelectorAll('.m3-dropdown-option').forEach(opt => {
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        const val = opt.dataset.value;
        if (selFont) selFont.value = val;
        const current = getTvk();
        current.font = val;
        saveTvk(current);
        applyTvk();
        syncTvkUI();
        if (fontDropdown) fontDropdown.classList.remove('open');
        if (panel && !panel.matches(':hover') && (!topZone || !topZone.matches(':hover'))) {
          scheduleCloseTvkPanel();
        }
      });
    });
  }

  if (alignGroup) {
    alignGroup.querySelectorAll('.tvk-pill-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const val = btn.dataset.value;
        const current = getTvk();
        current.align = val;
        saveTvk(current);
        applyTvk();
        syncTvkUI();
      });
    });
  }

  if (animGroup) {
    animGroup.querySelectorAll('.tvk-pill-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const val = btn.dataset.value;
        if (selAnim) selAnim.value = val;
        const current = getTvk();
        current.anim = val;
        saveTvk(current);
        applyTvk();
        syncTvkUI();
      });
    });
  }

  const onTvkInput = () => {
    const current = getTvk();
    const tvk = {
      font: (selFont && selFont.value) || current.font || 'inherit',
      align: current.align || 'center',
      size: Number(sliderSize && sliderSize.value) || 100,
      weight: Number(sliderWeight && sliderWeight.value) || 700,
      gap: (sliderGap && sliderGap.value !== undefined) ? Number(sliderGap.value) : 16,
      anim: (selAnim && selAnim.value) || current.anim || 'smooth',
      speed: Number(sliderSpeed && sliderSpeed.value) || 350
    };
    saveTvk(tvk);
    applyTvk();
    if (valSize) valSize.textContent = `${tvk.size}%`;
    if (valWeight) valWeight.textContent = `${tvk.weight}`;
    if (valGap) valGap.textContent = `${tvk.gap}px`;
    if (valSpeed) valSpeed.textContent = `${tvk.speed}ms`;
  };

  [selFont, sliderSize, sliderWeight, sliderGap, selAnim, sliderSpeed].forEach(input => {
    if (!input) return;
    input.addEventListener('input', onTvkInput);
    input.addEventListener('change', onTvkInput);
  });

  const btnTvkVis = document.getElementById('btn-tvk-visualizer');
  if (btnTvkVis) {
    btnTvkVis.addEventListener('click', () => {
      const cur = localStorage.getItem('eclipse_tvk_visualizer') !== 'false';
      updateTvkVisualizerSetting(!cur);
    });
  }
  const btnTvkBassPulse = document.getElementById('btn-tvk-bass-pulse');
  if (btnTvkBassPulse) {
    btnTvkBassPulse.addEventListener('click', () => {
      const cur = getTvk();
      cur.bassPulse = !cur.bassPulse;
      saveTvk(cur);
      applyTvk();
      syncTvkUI();
    });
  }
  const btnTvkVisSetting = document.getElementById('btn-tvk-visualizer-setting');
  if (btnTvkVisSetting) {
    btnTvkVisSetting.addEventListener('click', () => {
      const cur = localStorage.getItem('eclipse_tvk_visualizer') !== 'false';
      updateTvkVisualizerSetting(!cur);
    });
  }

  const btnTvkVisLyrics = document.getElementById('btn-tvk-visualizer-lyrics');
  if (btnTvkVisLyrics) {
    btnTvkVisLyrics.addEventListener('click', () => {
      const cur = localStorage.getItem('eclipse_tvk_visualizer_lyrics') !== 'false';
      updateTvkVisualizerLyricsSetting(!cur);
    });
  }
  const btnTvkVisLyricsSetting = document.getElementById('btn-tvk-visualizer-lyrics-setting');
  if (btnTvkVisLyricsSetting) {
    btnTvkVisLyricsSetting.addEventListener('click', () => {
      const cur = localStorage.getItem('eclipse_tvk_visualizer_lyrics') !== 'false';
      updateTvkVisualizerLyricsSetting(!cur);
    });
  }

  const sliderTvkVisOpacity = document.getElementById('tvk-vis-opacity');
  if (sliderTvkVisOpacity) {
    const onOpInput = (e) => {
      updateTvkVisualizerOpacity(e.target.value);
    };
    sliderTvkVisOpacity.addEventListener('input', onOpInput);
    sliderTvkVisOpacity.addEventListener('change', onOpInput);
  }
  const sliderTvkVisOpacitySetting = document.getElementById('slider-tvk-vis-opacity-setting');
  if (sliderTvkVisOpacitySetting) {
    const onOpInput = (e) => {
      updateTvkVisualizerOpacity(e.target.value);
    };
    sliderTvkVisOpacitySetting.addEventListener('input', onOpInput);
    sliderTvkVisOpacitySetting.addEventListener('change', onOpInput);
  }

  const sliderVizSmooth = document.getElementById('slider-viz-smooth');
  const valVizSmooth = document.getElementById('val-viz-smooth');
  const sliderBarVizSmooth = document.getElementById('slider-bar-viz-smooth');
  const valBarVizSmooth = document.getElementById('val-bar-viz-smooth');
  const initialVizSmooth = localStorage.getItem('eclipse_viz_smooth') || '55';
  function syncSmooth(v) {
    if (sliderVizSmooth) sliderVizSmooth.value = v;
    if (valVizSmooth) valVizSmooth.textContent = `${v}%`;
    if (sliderBarVizSmooth) sliderBarVizSmooth.value = v;
    if (valBarVizSmooth) valBarVizSmooth.textContent = `${v}%`;
  }
  syncSmooth(initialVizSmooth);
  const onSmoothInput = (e) => {
    const v = e.target.value;
    localStorage.setItem('eclipse_viz_smooth', v);
    syncSmooth(v);
  };
  if (sliderVizSmooth) {
    sliderVizSmooth.addEventListener('input', onSmoothInput);
    sliderVizSmooth.addEventListener('change', onSmoothInput);
  }
  if (sliderBarVizSmooth) {
    sliderBarVizSmooth.addEventListener('input', onSmoothInput);
    sliderBarVizSmooth.addEventListener('change', onSmoothInput);
  }

  const sliderVizSens = document.getElementById('slider-viz-sens');
  const valVizSens = document.getElementById('val-viz-sens');
  const sliderBarVizSens = document.getElementById('slider-bar-viz-sens');
  const valBarVizSens = document.getElementById('val-bar-viz-sens');
  const initialVizSens = localStorage.getItem('eclipse_viz_sens') || '100';
  function syncSens(v) {
    if (sliderVizSens) sliderVizSens.value = v;
    if (valVizSens) valVizSens.textContent = `${v}%`;
    if (sliderBarVizSens) sliderBarVizSens.value = v;
    if (valBarVizSens) valBarVizSens.textContent = `${v}%`;
  }
  syncSens(initialVizSens);
  const onSensInput = (e) => {
    const v = e.target.value;
    localStorage.setItem('eclipse_viz_sens', v);
    syncSens(v);
  };
  if (sliderVizSens) {
    sliderVizSens.addEventListener('input', onSensInput);
    sliderVizSens.addEventListener('change', onSensInput);
  }
  if (sliderBarVizSens) {
    sliderBarVizSens.addEventListener('input', onSensInput);
    sliderBarVizSens.addEventListener('change', onSensInput);
  }

  if (btnReset) {
    btnReset.addEventListener('click', () => {
      saveTvk(TVK_DEFAULTS);
      updateTvkVisualizerSetting(true);
      updateTvkVisualizerLyricsSetting(true);
      updateTvkVisualizerOpacity(85);
      applyTvk();
      syncTvkUI();
    });
  }
}

function openCustomLyricsEditor() {
  if (!state.currentTrack) {
    showToast('Play a track first to add lyrics', 'info');
    return;
  }
  if (el.customLyricsTrackTitle) el.customLyricsTrackTitle.textContent = (state.currentTrack.title || 'untitled');
  if (el.customLyricsTrackArtist) el.customLyricsTrackArtist.textContent = (state.currentTrack.artist || '');

  function formatTimeTag(seconds) {
    if (seconds == null || seconds < 0) return '';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    const cs = Math.floor((seconds % 1) * 100);
    return `[${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}] `;
  }

  if (state.syncedLyrics && state.syncedLyrics.length > 0 && el.customLyricsTextarea) {
    el.customLyricsTextarea.value = state.syncedLyrics.map(l => {
      if (l.isGap) return '[Instrumental]';
      const tag = (l.time != null && l.time >= 0) ? formatTimeTag(l.time) : '';
      return `${tag}${l.text || ''}`;
    }).join('\n');
  } else {
    if (el.customLyricsTextarea) el.customLyricsTextarea.value = '';
  }
  if (el.customLyricsModal) {
    openModal(el.customLyricsModal);
    if (el.customLyricsTextarea) setTimeout(() => el.customLyricsTextarea.focus(), 100);
  }
}

function closeCustomLyricsEditor() {
  if (el.customLyricsModal) closeModal(el.customLyricsModal);
}

async function saveCustomLyrics() {
  if (!state.currentTrack || !el.customLyricsTextarea) return;
  const rawText = el.customLyricsTextarea.value;
  const text = rawText.trim();

  const title = state.currentTrack.title || '';
  const artist = state.currentTrack.artist || '';

  try {
    const sToken = (window.electronAPI && window.electronAPI.serverToken) || state.serverToken || '';
    const res = await fetch(
      `http://127.0.0.1:${state.serverPort}/api/save-custom-lyrics?title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Eclipse-Token': sToken
        },
        body: JSON.stringify({ lyrics: text })
      }
    );
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Save failed');

    showToast(text ? 'Lyrics saved successfully' : 'Lyrics removed', 'info');
    closeCustomLyricsEditor();
    lyricsSessionCache.clear();
    lyricsTranslationCache.clear();
    wordsSessionCache.clear();
    state.lastActiveLyricIdx = -1;
    state.forceLyricsScroll = true;
    state.forceSnapLyrics = true;

    const lines = rawText.split('\n');
    const lrcRegex = /\[(\d+):(\d+(\.\d+)?)\](.*)/;
    const parsed = [];
    for (const line of lines) {
      const m = lrcRegex.exec(line);
      if (m) {
        const min = parseInt(m[1], 10);
        const sec = parseFloat(m[2]);
        parsed.push({ time: min * 60 + sec, text: m[4].trim() });
      }
    }
    if (parsed.length > 0) {
      state.syncedLyrics = parsed;
    } else {
      state.syncedLyrics = rawText.split('\n').map(l => l.trim()).filter(Boolean).map(t => ({ time: -1, text: t }));
    }
    renderLyricsView();
    await loadSyncedLyrics(title, artist, state.loadToken);
  } catch (e) {
    showToast('Failed to save lyrics: ' + e.message, 'error');
  }
}

const syncState = {
  active: false,
  track: null,
  lines: [],
  currentIndex: 0
};

function openSyncMode() {
  if (!state.currentTrack) {
    showToast('Play a track first to sync lyrics', 'info');
    return;
  }

  if (state.syncedLyrics.length === 0) {
    showToast('Add lyrics first using the edit button, then sync them', 'info');
    return;
  }

  const defaultPreset = (Array.isArray(defaultPresets) && defaultPresets.find(p => p.id === 'p_default')) || defaultPresets[0];
  if (defaultPreset && typeof applyPreset === 'function') {
    applyPreset(defaultPreset);
  }
  if (el.nativeAudio) {
    el.nativeAudio.playbackRate = 1.0;
    el.nativeAudio.currentTime = 0;
  }

  syncState.active = true;
  syncState.track = { ...state.currentTrack };
  syncState.lines = state.syncedLyrics.map(l => {
    const isGap = !!l.isGap || /^\[?\s*(?:instrumental|music|intro|outro|solo)\s*\]?$/i.test(l.text || '');
    const text = isGap ? '[Instrumental]' : (l.text || '').trim();
    return { text, isGap, time: null };
  }).filter(l => l.text);
  syncState.currentIndex = 0;

  renderSyncLines();
  if (el.syncModeOverlay) openModal(el.syncModeOverlay);

  playSmooth();

  showToast('Click or tap each line when you hear it', 'info');
}

function updateSyncProgress() {
  const synced = syncState.lines.filter(l => l.time !== null).length;
  const total = syncState.lines.length;
  if (el.syncProgressText) el.syncProgressText.textContent = `${synced} / ${total} lines synced`;
}

function renderSyncLines() {
  if (!el.syncModeLyrics) return;
  const prevTop = el.syncModeLyrics.scrollTop;
  el.syncModeLyrics.innerHTML = '';
  syncState.lines.forEach((line, idx) => {
    const div = document.createElement('div');
    div.className = 'sync-line';
    div.textContent = line.text;

    if (line.isGap || line.text === '[Instrumental]') {
      div.classList.add('sync-line-gap');
      div.innerHTML = `<span class="sync-gap-tag"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:middle;margin-right:4px;"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>[Instrumental]</span>`;
    }

    if (line.time !== null) {
      div.classList.add('synced');
      const min = Math.floor(line.time / 60);
      const sec = (line.time % 60).toFixed(2);
      div.setAttribute('data-time', `[${min}:${sec.padStart(5, '0')}]`);
    }

    if (idx === syncState.currentIndex && line.time === null) {
      div.classList.add('next-line');
    }

    div.addEventListener('click', () => handleSyncLineClick(idx));
    el.syncModeLyrics.appendChild(div);
  });

  el.syncModeLyrics.scrollTop = prevTop;
  updateSyncProgress();

  const nextEl = el.syncModeLyrics.querySelector('.next-line');
  if (nextEl) {
    const c = el.syncModeLyrics;
    const cr = c.getBoundingClientRect(), nr = nextEl.getBoundingClientRect();
    animateLyricsScroll(c, c.scrollTop + (nr.top - cr.top) - c.clientHeight / 2 + nr.height / 2);
  }
}

function handleSyncLineClick(idx) {
  if (!syncState.active || !el.nativeAudio) return;

  const currentTime = el.nativeAudio.currentTime || 0;
  syncState.lines[idx].time = currentTime;

  let next = -1;
  for (let i = idx + 1; i < syncState.lines.length; i++) {
    if (syncState.lines[i].time === null) {
      next = i;
      break;
    }
  }
  syncState.currentIndex = next >= 0 ? next : syncState.lines.length;

  renderSyncLines();
}

function restartSync() {
  syncState.lines.forEach(l => l.time = null);
  syncState.currentIndex = 0;
  if (el.nativeAudio) el.nativeAudio.currentTime = 0;
  renderSyncLines();
  showToast('Sync restarted', 'info');
}

async function saveSyncAndExit() {
  const targetTrack = syncState.track || state.currentTrack;
  if (!targetTrack) return;

  const lrcLines = syncState.lines.map(line => {
    if (line.time !== null) {
      const min = Math.floor(line.time / 60);
      const sec = (line.time % 60).toFixed(2);
      return `[${min}:${sec.padStart(5, '0')}]${line.text}`;
    }
    return line.text;
  });
  const lrcContent = lrcLines.join('\n');

  const title = targetTrack.title || '';
  const artist = targetTrack.artist || '';

  try {
    const sToken = (window.electronAPI && window.electronAPI.serverToken) || state.serverToken || '';
    const res = await fetch(
      `http://127.0.0.1:${state.serverPort}/api/save-custom-lyrics?title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Eclipse-Token': sToken
        },
        body: JSON.stringify({ lyrics: lrcContent })
      }
    );
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Save failed');

    showToast('Synced lyrics saved', 'info');
    closeSyncMode();
    lyricsSessionCache.clear();
    lyricsTranslationCache.clear();
    wordsSessionCache.clear();
    state.lastActiveLyricIdx = -1;
    state.forceLyricsScroll = true;
    state.forceSnapLyrics = true;
    await loadSyncedLyrics(title, artist, state.loadToken);
  } catch (e) {
    showToast('Failed to save synced lyrics: ' + e.message, 'error');
  }
}

function closeSyncMode() {
  syncState.active = false;
  syncState.track = null;
  syncState.lines = [];
  syncState.currentIndex = 0;
  if (el.syncModeOverlay) {
    closeModal(el.syncModeOverlay);
    el.syncModeOverlay.classList.remove('visible');
    el.syncModeOverlay.classList.add('hidden');
  }
}
