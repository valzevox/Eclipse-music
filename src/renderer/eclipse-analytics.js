/**
 * Eclipse Analytics Dashboard & Sonic Persona Engine
 * Computes 24h Radial Listening Clock, 5-Axis Sonic Fingerprint Radar,
 * Top Tracks/Artists/Decades, and Eclipse Recap Story Reel & Sonic Persona Card.
 */
(function () {
  'use strict';

  const PERIOD_MS = {
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
    '90d': 90 * 24 * 60 * 60 * 1000,
    'all': Infinity
  };

  const SONIC_PERSONAS = [
    {
      id: 'midnight_synth_explorer',
      title: 'Midnight Synth Explorer',
      badge: 'Nocturnal Vanguard',
      tagline: 'Thrives in late-hour sonic landscapes with deep exploratory instincts.',
      accent: '#a855f7'
    },
    {
      id: 'high_fidelity_purist',
      title: 'High-Fidelity Purist',
      badge: 'Audiophile Architect',
      tagline: 'Deep replay loyalty and laser-focused sessions on signature masters.',
      accent: '#06b6d4'
    },
    {
      id: 'dynamic_vibe_curator',
      title: 'Dynamic Vibe Curator',
      badge: 'Spectrum Weaver',
      tagline: 'Balances high artist diversity with steady daily listening rituals.',
      accent: '#1ed760'
    },
    {
      id: 'hyper_horizon_drifter',
      title: 'Hyper-Horizon Drifter',
      badge: 'Sonic Nomad',
      tagline: 'Constantly seeks fresh releases and eclectic cross-era sounds.',
      accent: '#ff5500'
    },
    {
      id: 'crimson_rhythm_devotee',
      title: 'Crimson Rhythm Devotee',
      badge: 'Pulse Anchor',
      tagline: 'High-intensity replay cycles anchored around core anthems.',
      accent: '#fa2d48'
    }
  ];

  class EclipseAnalyticsManager {
    constructor(options = {}) {
      this.storage = options.storage || (typeof localStorage !== 'undefined' ? localStorage : null);
      this.currentPeriod = options.defaultPeriod || '30d';
    }

    _readJsonList(keys) {
      if (!this.storage || typeof this.storage.getItem !== 'function') return [];
      for (const k of keys) {
        try {
          const raw = this.storage.getItem(k);
          if (raw) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed) && parsed.length > 0) return parsed;
          }
        } catch (_) {}
      }
      return [];
    }

    getRawHistory(customHistory) {
      if (Array.isArray(customHistory)) return customHistory;
      const fromStorage = this._readJsonList(['eclipse_history', 'devsize_history', 'muriel_history']);
      if (fromStorage.length > 0) return fromStorage;
      if (typeof window !== 'undefined') {
        const st = (window.EclipseCore && window.EclipseCore.state) || window.state;
        if (st && Array.isArray(st.history) && st.history.length > 0) return st.history;
      }
      return [];
    }

    getRawFavorites(customFavorites) {
      if (Array.isArray(customFavorites)) return customFavorites;
      const fromStorage = this._readJsonList(['eclipse_favorites', 'devsize_favorites', 'muriel_favorites']);
      if (fromStorage.length > 0) return fromStorage;
      if (typeof window !== 'undefined') {
        const st = (window.EclipseCore && window.EclipseCore.state) || window.state;
        if (st && Array.isArray(st.favorites) && st.favorites.length > 0) return st.favorites;
      }
      return [];
    }

    _normalizeEntry(item, index = 0, now = Date.now()) {
      if (!item || typeof item !== 'object') return null;
      const tsRaw = item.playedAt || item.timestamp || item.addedAt || item.dateAdded || 0;
      let timestamp = typeof tsRaw === 'number' && tsRaw > 0 ? tsRaw : Date.parse(tsRaw);
      if (!timestamp || isNaN(timestamp)) {
        // Spread fallback deterministically across recent days so clock/consistency work on legacy entries
        timestamp = now - (index * 3600 * 1000 * 3.5);
      }
      const durationSec = Number(item.duration) > 0 ? Number(item.duration) : 210;
      const plays = Math.max(1, Number(item.plays || item.playCount || 1));
      const yearMatch = String(item.releaseYear || item.year || item.album || item.title || '').match(/\b(19[5-9]\d|20[0-2]\d)\b/);
      const year = yearMatch ? Number(yearMatch[1]) : 2020;
      const decade = `${Math.floor(year / 10) * 10}s`;

      return {
        id: String(item.id || item.videoId || `${item.title || 'track'}-${item.artist || 'artist'}`),
        title: String(item.title || 'Untitled Track').trim(),
        artist: String(item.artist || item.author || 'Unknown Artist').trim(),
        album: String(item.album || '').trim(),
        thumbnail: item.thumbnail || item.cover || '',
        durationSec,
        plays,
        timestamp,
        year,
        decade
      };
    }

    computeAnalytics(period = this.currentPeriod, customData = {}) {
      const now = customData.now || Date.now();
      const windowMs = PERIOD_MS[period] || PERIOD_MS['30d'];
      const rawHistory = this.getRawHistory(customData.history);
      const rawFavorites = this.getRawFavorites(customData.favorites);

      const combinedRaw = rawHistory.length > 0 ? rawHistory : rawFavorites;
      const normalized = combinedRaw
        .map((item, idx) => this._normalizeEntry(item, idx, now))
        .filter(Boolean);

      const currentItems = windowMs === Infinity
        ? normalized
        : normalized.filter(e => (now - e.timestamp) <= windowMs);

      const previousItems = windowMs === Infinity
        ? []
        : normalized.filter(e => {
            const age = now - e.timestamp;
            return age > windowMs && age <= windowMs * 2;
          });

      const activeSet = currentItems.length > 0 ? currentItems : normalized;

      const hourlyClock = this.compute24HourClock(activeSet);
      const radar = this.computeSonicRadar(activeSet, period);
      const topTracks = this.computeTopTracks(activeSet, 8);
      const topArtists = this.computeTopArtists(activeSet, 8);
      const decades = this.computeDecadeBreakdown(activeSet);

      const totalPlays = activeSet.reduce((sum, e) => sum + e.plays, 0);
      const totalMinutes = Math.round(activeSet.reduce((sum, e) => sum + (e.durationSec * e.plays) / 60, 0));
      const prevPlays = previousItems.reduce((sum, e) => sum + e.plays, 0);
      const prevMinutes = Math.round(previousItems.reduce((sum, e) => sum + (e.durationSec * e.plays) / 60, 0));

      const playsDeltaPct = prevPlays > 0 ? Math.round(((totalPlays - prevPlays) / prevPlays) * 100) : (totalPlays > 0 ? 100 : 0);
      const minutesDeltaPct = prevMinutes > 0 ? Math.round(((totalMinutes - prevMinutes) / prevMinutes) * 100) : (totalMinutes > 0 ? 100 : 0);

      const persona = this.determineSonicPersona(hourlyClock, radar, topArtists, decades);

      return {
        period,
        totalPlays,
        totalMinutes,
        uniqueTracks: new Set(activeSet.map(e => e.id)).size,
        uniqueArtists: new Set(activeSet.map(e => e.artist.toLowerCase())).size,
        delta: {
          playsPct: playsDeltaPct,
          minutesPct: minutesDeltaPct
        },
        hourlyClock,
        radar,
        topTracks,
        topArtists,
        decades,
        persona
      };
    }

    compute24HourClock(entries = []) {
      const hours = new Array(24).fill(0);
      const minutesByHour = new Array(24).fill(0);

      for (const e of entries) {
        const d = new Date(e.timestamp || Date.now());
        const h = isNaN(d.getHours()) ? 20 : d.getHours();
        hours[h] += e.plays || 1;
        minutesByHour[h] += Math.round(((e.durationSec || 210) * (e.plays || 1)) / 60);
      }

      const maxCount = Math.max(1, ...hours);
      let peakHour = 0;
      for (let i = 0; i < 24; i++) {
        if (hours[i] > hours[peakHour]) peakHour = i;
      }

      return {
        hours,
        minutesByHour,
        normalized: hours.map(c => Number((c / maxCount).toFixed(3))),
        peakHour,
        peakLabel: `${String(peakHour).padStart(2, '0')}:00`
      };
    }

    computeSonicRadar(entries = [], period = '30d') {
      if (!entries || entries.length === 0) {
        return {
          discovery: 65,
          replay: 50,
          concentration: 55,
          consistency: 60,
          diversity: 70
        };
      }

      const totalPlays = entries.reduce((acc, e) => acc + (e.plays || 1), 0);
      const trackCounts = new Map();
      const artistCounts = new Map();
      const activeDays = new Set();

      for (const e of entries) {
        const p = e.plays || 1;
        trackCounts.set(e.id, (trackCounts.get(e.id) || 0) + p);
        const artKey = (e.artist || 'unknown').toLowerCase();
        artistCounts.set(artKey, (artistCounts.get(artKey) || 0) + p);
        const dayStr = new Date(e.timestamp || Date.now()).toISOString().slice(0, 10);
        activeDays.add(dayStr);
      }

      const uniqueTracks = trackCounts.size;
      const uniqueArtists = artistCounts.size;

      // 1. Discovery (0-100): ratio of unique tracks to total plays
      const discoveryRatio = uniqueTracks / Math.max(1, totalPlays);
      const discovery = Math.min(100, Math.max(15, Math.round(discoveryRatio * 115)));

      // 2. Replay (0-100): intensity of repeat plays per track
      const avgPlaysPerTrack = totalPlays / Math.max(1, uniqueTracks);
      const replay = Math.min(100, Math.max(10, Math.round(Math.min(1, (avgPlaysPerTrack - 0.7) / 4.5) * 100)));

      // 3. Concentration (0-100): top 3 artists share of total plays
      const sortedArtistPlays = Array.from(artistCounts.values()).sort((a, b) => b - a);
      const top3Plays = sortedArtistPlays.slice(0, 3).reduce((a, b) => a + b, 0);
      const concentration = Math.min(100, Math.max(15, Math.round((top3Plays / Math.max(1, totalPlays)) * 100)));

      // 4. Consistency (0-100): active days ratio within period
      const targetDays = period === '7d' ? 7 : (period === '30d' ? 20 : 30);
      const consistency = Math.min(100, Math.max(20, Math.round((activeDays.size / targetDays) * 100)));

      // 5. Diversity (0-100): Shannon entropy / artist spread
      const diversityRatio = uniqueArtists / Math.max(1, uniqueTracks);
      const diversity = Math.min(100, Math.max(20, Math.round(diversityRatio * 110)));

      return {
        discovery,
        replay,
        concentration,
        consistency,
        diversity
      };
    }

    computeTopTracks(entries = [], limit = 8) {
      const map = new Map();
      for (const e of entries) {
        const existing = map.get(e.id) || {
          id: e.id,
          title: e.title,
          artist: e.artist,
          thumbnail: e.thumbnail,
          plays: 0,
          minutes: 0
        };
        existing.plays += e.plays || 1;
        existing.minutes += Math.round(((e.durationSec || 210) * (e.plays || 1)) / 60);
        map.set(e.id, existing);
      }
      return Array.from(map.values())
        .sort((a, b) => b.plays - a.plays || b.minutes - a.minutes)
        .slice(0, limit);
    }

    computeTopArtists(entries = [], limit = 8) {
      const map = new Map();
      for (const e of entries) {
        const key = (e.artist || 'Unknown Artist').toLowerCase();
        const existing = map.get(key) || {
          artist: e.artist || 'Unknown Artist',
          thumbnail: e.thumbnail || '',
          plays: 0,
          minutes: 0,
          trackCount: 0
        };
        existing.plays += e.plays || 1;
        existing.minutes += Math.round(((e.durationSec || 210) * (e.plays || 1)) / 60);
        existing.trackCount += 1;
        map.set(key, existing);
      }
      return Array.from(map.values())
        .sort((a, b) => b.plays - a.plays || b.minutes - a.minutes)
        .slice(0, limit);
    }

    computeDecadeBreakdown(entries = []) {
      const counts = new Map();
      let total = 0;
      for (const e of entries) {
        const dec = e.decade || '2020s';
        const p = e.plays || 1;
        counts.set(dec, (counts.get(dec) || 0) + p);
        total += p;
      }
      if (total === 0) {
        return [{ decade: '2020s', count: 1, percentage: 100 }];
      }
      return Array.from(counts.entries())
        .map(([decade, count]) => ({
          decade,
          count,
          percentage: Math.round((count / total) * 100)
        }))
        .sort((a, b) => b.count - a.count);
    }

    determineSonicPersona(hourlyClock, radar, topArtists = [], decades = []) {
      const peak = hourlyClock ? hourlyClock.peakHour : 22;
      const isNightListener = peak >= 21 || peak <= 4;

      if (isNightListener && radar.discovery >= 60) {
        return { ...SONIC_PERSONAS[0], peakHourLabel: hourlyClock.peakLabel };
      }
      if (radar.replay >= 70 || radar.concentration >= 75) {
        return { ...SONIC_PERSONAS[1], peakHourLabel: hourlyClock.peakLabel };
      }
      if (radar.diversity >= 72 && radar.consistency >= 55) {
        return { ...SONIC_PERSONAS[2], peakHourLabel: hourlyClock.peakLabel };
      }
      if (radar.discovery >= 75 || decades.length >= 3) {
        return { ...SONIC_PERSONAS[3], peakHourLabel: hourlyClock.peakLabel };
      }
      return {
        ...SONIC_PERSONAS[4],
        peakHourLabel: hourlyClock ? hourlyClock.peakLabel : '21:00',
        topArtist: topArtists[0] ? topArtists[0].artist : 'Eclipse Studio'
      };
    }

    render24HourClockSvg(hourlyClock, size = 240) {
      const cx = size / 2;
      const cy = size / 2;
      const innerR = size * 0.22;
      const maxOuterR = size * 0.44;
      const norm = (hourlyClock && Array.isArray(hourlyClock.normalized))
        ? hourlyClock.normalized
        : new Array(24).fill(0.25);

      let wedges = '';
      for (let h = 0; h < 24; h++) {
        const val = Math.max(0.12, norm[h] || 0.12);
        const rOut = innerR + val * (maxOuterR - innerR);
        const startDeg = h * 15 - 90 + 1.2;
        const endDeg = (h + 1) * 15 - 90 - 1.2;
        const startRad = (startDeg * Math.PI) / 180;
        const endRad = (endDeg * Math.PI) / 180;

        const x1 = cx + innerR * Math.cos(startRad);
        const y1 = cy + innerR * Math.sin(startRad);
        const x2 = cx + rOut * Math.cos(startRad);
        const y2 = cy + rOut * Math.sin(startRad);
        const x3 = cx + rOut * Math.cos(endRad);
        const y3 = cy + rOut * Math.sin(endRad);
        const x4 = cx + innerR * Math.cos(endRad);
        const y4 = cy + innerR * Math.sin(endRad);

        const isPeak = hourlyClock && hourlyClock.peakHour === h;
        const fill = isPeak ? '#a855f7' : `rgba(168, 85, 247, ${(0.25 + val * 0.65).toFixed(2)})`;

        wedges += `<path d="M ${x1.toFixed(1)} ${y1.toFixed(1)} L ${x2.toFixed(1)} ${y2.toFixed(1)} A ${rOut.toFixed(1)} ${rOut.toFixed(1)} 0 0 1 ${x3.toFixed(1)} ${y3.toFixed(1)} L ${x4.toFixed(1)} ${y4.toFixed(1)} A ${innerR.toFixed(1)} ${innerR.toFixed(1)} 0 0 0 ${x1.toFixed(1)} ${y1.toFixed(1)} Z" fill="${fill}" />`;
      }

      const peakText = (hourlyClock && hourlyClock.peakLabel) || '22:00';
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" class="eclipse-radial-clock-svg">
        <circle cx="${cx}" cy="${cy}" r="${maxOuterR}" fill="none" stroke="rgba(255,255,255,0.08)" stroke-dasharray="3,3" />
        <circle cx="${cx}" cy="${cy}" r="${innerR}" fill="rgba(18,18,28,0.85)" stroke="rgba(168,85,247,0.35)" />
        ${wedges}
        <text x="${cx}" y="${cy - 4}" text-anchor="middle" fill="#ffffff" font-size="13" font-weight="700">${peakText}</text>
        <text x="${cx}" y="${cy + 12}" text-anchor="middle" fill="rgba(255,255,255,0.55)" font-size="9">PEAK HOUR</text>
      </svg>`;
    }

    renderSonicRadarSvg(radar = {}, size = 240) {
      const cx = size / 2;
      const cy = size / 2;
      const maxR = size * 0.36;
      const axes = [
        { key: 'discovery', label: 'Discovery' },
        { key: 'replay', label: 'Replay' },
        { key: 'concentration', label: 'Focus' },
        { key: 'consistency', label: 'Ritual' },
        { key: 'diversity', label: 'Diversity' }
      ];

      const pointFor = (idx, pct) => {
        const angle = ((idx * 72 - 90) * Math.PI) / 180;
        const r = (Math.max(5, Math.min(100, pct)) / 100) * maxR;
        return [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
      };

      const gridRings = [25, 50, 75, 100].map(level => {
        const pts = axes.map((_, idx) => pointFor(idx, level).map(n => n.toFixed(1)).join(',')).join(' ');
        return `<polygon points="${pts}" fill="none" stroke="rgba(255,255,255,0.1)" stroke-width="1" />`;
      }).join('');

      const polyPoints = axes.map((a, idx) => pointFor(idx, radar[a.key] || 50).map(n => n.toFixed(1)).join(',')).join(' ');

      const labels = axes.map((a, idx) => {
        const [lx, ly] = pointFor(idx, 125);
        const score = radar[a.key] || 50;
        return `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle" dominant-baseline="middle" fill="rgba(255,255,255,0.85)" font-size="10" font-weight="600">${a.label} (${score})</text>`;
      }).join('');

      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" class="eclipse-sonic-radar-svg">
        ${gridRings}
        <polygon points="${polyPoints}" fill="rgba(168, 85, 247, 0.32)" stroke="#a855f7" stroke-width="2" />
        ${labels}
      </svg>`;
    }

    async exportPersonaCardPng(analyticsData) {
      const data = analyticsData || this.computeAnalytics();
      if (typeof document === 'undefined') return null;

      const canvas = document.createElement('canvas');
      canvas.width = 720;
      canvas.height = 960;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;

      // Background Dark Neon gradient
      const grad = ctx.createLinearGradient(0, 0, 720, 960);
      grad.addColorStop(0, '#0c0a18');
      grad.addColorStop(0.5, '#17112e');
      grad.addColorStop(1, '#090910');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 720, 960);

      // Border frame
      ctx.strokeStyle = 'rgba(168, 85, 247, 0.45)';
      ctx.lineWidth = 3;
      ctx.strokeRect(24, 24, 672, 912);

      // Header
      ctx.fillStyle = '#a855f7';
      ctx.font = 'bold 20px sans-serif';
      ctx.fillText('ECLIPSE RECAP • SONIC PERSONA', 56, 80);

      // Persona Archetype
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 42px sans-serif';
      ctx.fillText(data.persona.title, 56, 145);

      ctx.fillStyle = 'rgba(255,255,255,0.72)';
      ctx.font = '18px sans-serif';
      ctx.fillText(data.persona.tagline, 56, 185);

      // Stats grid
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.fillRect(56, 225, 608, 120);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 30px sans-serif';
      ctx.fillText(`${data.totalMinutes} MIN`, 84, 280);
      ctx.fillText(`${data.totalPlays} PLAYS`, 290, 280);
      ctx.fillText(`${data.hourlyClock.peakLabel}`, 500, 280);

      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.font = '14px sans-serif';
      ctx.fillText('LISTENING TIME', 84, 312);
      ctx.fillText('TOTAL SESSIONS', 290, 312);
      ctx.fillText('PEAK HOUR', 500, 312);

      // Radar Metrics
      ctx.fillStyle = '#a855f7';
      ctx.font = 'bold 18px sans-serif';
      ctx.fillText('5-AXIS SONIC FINGERPRINT', 56, 395);

      const axes = [
        ['Discovery', data.radar.discovery],
        ['Replay Loyalty', data.radar.replay],
        ['Focus & Concentration', data.radar.concentration],
        ['Daily Consistency', data.radar.consistency],
        ['Sonic Diversity', data.radar.diversity]
      ];
      axes.forEach(([label, score], idx) => {
        const y = 435 + idx * 42;
        ctx.fillStyle = '#ffffff';
        ctx.font = '16px sans-serif';
        ctx.fillText(`${label}: ${score}/100`, 56, y);
        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        ctx.fillRect(280, y - 14, 360, 14);
        ctx.fillStyle = '#a855f7';
        ctx.fillRect(280, y - 14, Math.round((score / 100) * 360), 14);
      });

      // Top Tracks
      ctx.fillStyle = '#a855f7';
      ctx.font = 'bold 18px sans-serif';
      ctx.fillText('TOP TRACKS', 56, 675);
      (data.topTracks || []).slice(0, 5).forEach((t, i) => {
        const y = 712 + i * 38;
        ctx.fillStyle = '#ffffff';
        ctx.font = '16px sans-serif';
        ctx.fillText(`${i + 1}. ${t.title} — ${t.artist} (${t.plays}x)`, 56, y);
      });

      const dataUrl = canvas.toDataURL('image/png');
      const link = document.createElement('a');
      link.download = `eclipse-recap-${data.period}.png`;
      link.href = dataUrl;
      link.click();
      return dataUrl;
    }

    openDashboardModal(period = this.currentPeriod) {
      if (typeof document === 'undefined') return null;
      this.currentPeriod = period;
      const data = this.computeAnalytics(period);

      let modal = document.getElementById('eclipse-analytics-modal');
      if (!modal) {
        modal = document.createElement('div');
        modal.id = 'eclipse-analytics-modal';
        modal.className = 'modal-backdrop';
        modal.style.cssText = 'position:fixed;inset:0;z-index:9990;display:flex;align-items:center;justify-content:center;background:rgba(6,6,12,0.76);backdrop-filter:blur(20px);';
        document.body.appendChild(modal);
      }
      modal.classList.remove('hidden');

      const deltaSign = data.delta.minutesPct >= 0 ? '+' : '';
      const topTracksHtml = (data.topTracks.length ? data.topTracks : [{ title: 'Play tracks to build analytics', artist: 'Eclipse Studio', plays: 1 }])
        .slice(0, 5)
        .map((t, idx) => `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.06);font-size:13px;">
          <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:75%;"><strong>#${idx + 1}</strong> ${t.title} <span style="opacity:0.6;">• ${t.artist}</span></span>
          <span style="color:#a855f7;font-weight:700;">${t.plays}x</span>
        </div>`).join('');

      const topArtistsHtml = (data.topArtists.length ? data.topArtists : [{ artist: 'Eclipse Artist', plays: 1 }])
        .slice(0, 5)
        .map((a, idx) => `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.06);font-size:13px;">
          <span><strong>#${idx + 1}</strong> ${a.artist}</span>
          <span style="color:#06b6d4;font-weight:700;">${a.plays} plays</span>
        </div>`).join('');

      const decadesHtml = data.decades.map(d => `<div style="display:flex;align-items:center;gap:8px;font-size:12px;margin-top:6px;">
        <span style="width:48px;font-weight:600;">${d.decade}</span>
        <div style="flex:1;height:8px;background:rgba(255,255,255,0.08);border-radius:99px;overflow:hidden;">
          <div style="width:${d.percentage}%;height:100%;background:linear-gradient(90deg,#a855f7,#06b6d4);"></div>
        </div>
        <span style="width:36px;text-align:right;opacity:0.75;">${d.percentage}%</span>
      </div>`).join('');

      modal.innerHTML = `
        <div class="dialog-card" style="width:820px;max-width:95vw;max-height:90vh;overflow-y:auto;padding:24px;border-radius:24px;background:rgba(18,18,28,0.88);backdrop-filter:blur(20px);border:1px solid rgba(255,255,255,0.1);color:#fff;box-shadow:0 24px 64px rgba(0,0,0,0.65);">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:12px;">
            <div>
              <span style="font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#a855f7;font-weight:700;">ECLIPSE ANALYTICS &amp; RECAP</span>
              <h3 style="margin:4px 0 0;font-size:22px;font-weight:800;">Sonic Intelligence Studio</h3>
            </div>
            <div style="display:flex;align-items:center;gap:6px;">
              ${['7d', '30d', '90d', 'all'].map(p => `<button type="button" class="eclipse-period-btn" data-period="${p}" style="padding:6px 12px;border-radius:999px;border:1px solid rgba(255,255,255,0.12);background:${p === period ? '#a855f7' : 'rgba(255,255,255,0.05)'};color:#fff;font-size:12px;font-weight:600;cursor:pointer;">${p.toUpperCase()}</button>`).join('')}
              <button type="button" id="btn-close-eclipse-analytics" style="margin-left:8px;padding:6px 12px;border-radius:999px;border:1px solid rgba(255,255,255,0.15);background:transparent;color:#fff;cursor:pointer;">✕</button>
            </div>
          </div>

          <!-- Persona Hero Banner -->
          <div style="padding:18px 20px;border-radius:18px;background:linear-gradient(135deg,rgba(168,85,247,0.22),rgba(6,182,212,0.12));border:1px solid rgba(255,255,255,0.1);margin-bottom:18px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;">
            <div>
              <span style="font-size:11px;padding:3px 10px;border-radius:999px;background:rgba(168,85,247,0.3);color:#e9d5ff;font-weight:700;">${data.persona.badge}</span>
              <h4 style="margin:8px 0 4px;font-size:20px;font-weight:800;">${data.persona.title}</h4>
              <p style="margin:0;font-size:13px;opacity:0.8;">${data.persona.tagline}</p>
            </div>
            <div style="display:flex;gap:16px;align-items:center;">
              <div style="text-align:right;">
                <div style="font-size:22px;font-weight:800;">${data.totalMinutes} min</div>
                <div style="font-size:11px;color:#1ed760;">${deltaSign}${data.delta.minutesPct}% vs prior period</div>
              </div>
              <button type="button" id="btn-export-persona-png" style="padding:10px 16px;border-radius:999px;border:none;background:#a855f7;color:#fff;font-weight:700;font-size:12px;cursor:pointer;">Export Recap PNG</button>
            </div>
          </div>

          <!-- Radial Clock & 5-Axis Radar -->
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px;margin-bottom:18px;">
            <div style="padding:16px;border-radius:18px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);display:flex;flex-direction:column;align-items:center;">
              <span style="font-size:13px;font-weight:700;margin-bottom:8px;">24-Hour Radial Listening Clock</span>
              ${this.render24HourClockSvg(data.hourlyClock, 220)}
            </div>
            <div style="padding:16px;border-radius:18px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);display:flex;flex-direction:column;align-items:center;">
              <span style="font-size:13px;font-weight:700;margin-bottom:8px;">5-Axis Sonic Fingerprint Radar</span>
              ${this.renderSonicRadarSvg(data.radar, 220)}
            </div>
          </div>

          <!-- Top Tracks, Top Artists, Decades -->
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;">
            <div style="padding:16px;border-radius:18px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);">
              <span style="font-size:13px;font-weight:700;display:block;margin-bottom:8px;">Top Tracks</span>
              ${topTracksHtml}
            </div>
            <div style="padding:16px;border-radius:18px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);">
              <span style="font-size:13px;font-weight:700;display:block;margin-bottom:8px;">Top Artists</span>
              ${topArtistsHtml}
            </div>
            <div style="padding:16px;border-radius:18px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);">
              <span style="font-size:13px;font-weight:700;display:block;margin-bottom:8px;">Music by Decade</span>
              ${decadesHtml}
            </div>
          </div>
        </div>
      `;

      modal.querySelectorAll('.eclipse-period-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          this.openDashboardModal(btn.getAttribute('data-period'));
        });
      });

      const closeBtn = modal.querySelector('#btn-close-eclipse-analytics');
      if (closeBtn) {
        closeBtn.addEventListener('click', () => modal.classList.add('hidden'));
      }

      const exportBtn = modal.querySelector('#btn-export-persona-png');
      if (exportBtn) {
        exportBtn.addEventListener('click', () => this.exportPersonaCardPng(data));
      }

      return data;
    }
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { EclipseAnalyticsManager, SONIC_PERSONAS };
  } else if (typeof window !== 'undefined') {
    window.EclipseAnalyticsManager = EclipseAnalyticsManager;
    window.SONIC_PERSONAS = SONIC_PERSONAS;
  }
})();
