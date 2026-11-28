/**
 * Eclipse Desktop Frame Governor & In-App Diagnostic Log Viewer
 * Dynamically governs render loop FPS (60 focused / 30 blurred / 0 hidden)
 * and provides a 500-line redacted diagnostic ring buffer + exporter.
 */
(function () {
  'use strict';

  const MAX_LOG_LINES = 500;

  function redactSensitiveTokens(text) {
    if (typeof text !== 'string') return String(text || '');
    return text
      .replace(/(SAPISID|HSID|SSID|APISID|SID|__Secure-3PAPISID|__Secure-1PAPISID)\s*[=:]\s*[^\s;&"']+/gi, '$1=[REDACTED]')
      .replace(/(X-Eclipse-Token|X-Muriel-Token)\s*[=:]\s*[^\s,&"']+/gi, '$1=[REDACTED]')
      .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]')
      .replace(/([?&](?:token|t)=)[A-Za-z0-9\-._~+/]+/gi, '$1[REDACTED]');
  }

  class EclipseFrameGovernor {
    constructor(options = {}) {
      this.maxLogLines = options.maxLogLines || MAX_LOG_LINES;
      this.logBuffer = [];
      this.isFocused = true;
      this.isHidden = false;
      this.targetFps = 60;
      this._originalConsole = {};
      this._boundCheck = this.evaluateState.bind(this);

      if (options.autoAttach !== false && typeof window !== 'undefined') {
        this.attach();
      }
      if (options.captureConsole !== false) {
        this.installConsoleInterceptor();
      }
    }

    redact(input) {
      return redactSensitiveTokens(input);
    }

    computeTargetFps(state = {}) {
      const hidden = typeof state.hidden === 'boolean'
        ? state.hidden
        : (typeof document !== 'undefined' ? !!document.hidden : this.isHidden);
      const focused = typeof state.focused === 'boolean'
        ? state.focused
        : this.isFocused;

      if (hidden) return 0;
      if (!focused) return 30;
      return 60;
    }

    evaluateState(override = {}) {
      if (typeof override.hidden === 'boolean') {
        this.isHidden = override.hidden;
      } else if (typeof document !== 'undefined') {
        this.isHidden = !!document.hidden;
      }

      if (typeof override.focused === 'boolean') {
        this.isFocused = override.focused;
      }

      const prevFps = this.targetFps;
      this.targetFps = this.computeTargetFps({
        hidden: this.isHidden,
        focused: this.isFocused
      });

      this._applyDomThrottle();

      if (prevFps !== this.targetFps && typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        try {
          const evt = typeof CustomEvent === 'function'
            ? new CustomEvent('eclipse:frame-governor-change', {
                detail: {
                  targetFps: this.targetFps,
                  hidden: this.isHidden,
                  focused: this.isFocused
                }
              })
            : { type: 'eclipse:frame-governor-change', detail: { targetFps: this.targetFps, hidden: this.isHidden, focused: this.isFocused } };
          window.dispatchEvent(evt);
        } catch (_) {}
      }

      return this.targetFps;
    }

    _applyDomThrottle() {
      if (typeof document === 'undefined' || !document.documentElement) return;
      const root = document.documentElement;
      root.setAttribute('data-eclipse-fps', String(this.targetFps));
      if (this.targetFps === 0) {
        root.classList.add('eclipse-governor-paused');
        root.classList.remove('eclipse-governor-throttled');
      } else if (this.targetFps === 30) {
        root.classList.add('eclipse-governor-throttled');
        root.classList.remove('eclipse-governor-paused');
      } else {
        root.classList.remove('eclipse-governor-paused', 'eclipse-governor-throttled');
      }
    }

    attach() {
      if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
        document.addEventListener('visibilitychange', () => {
          this.evaluateState({ hidden: !!document.hidden });
        });
      }
      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('blur', () => {
          this.evaluateState({ focused: false });
        });
        window.addEventListener('focus', () => {
          this.evaluateState({ focused: true, hidden: typeof document !== 'undefined' ? !!document.hidden : false });
        });
      }

      // Inject CSS pause rules for background visualizers when hidden
      if (typeof document !== 'undefined' && document.head && !document.getElementById('eclipse-frame-governor-style')) {
        const style = document.createElement('style');
        style.id = 'eclipse-frame-governor-style';
        style.textContent = `
          html.eclipse-governor-paused *,
          html.eclipse-governor-paused *::before,
          html.eclipse-governor-paused *::after {
            animation-play-state: paused !important;
          }
          html.eclipse-governor-paused canvas.playbar-bg-visualizer,
          html.eclipse-governor-paused canvas#visualizer-canvas,
          html.eclipse-governor-paused canvas#particles-bg-canvas {
            opacity: 0 !important;
            pointer-events: none !important;
          }
        `;
        document.head.appendChild(style);
      }

      this.evaluateState();
    }

    recordLog(level, ...args) {
      const serialized = args.map(a => {
        if (a instanceof Error) return `${a.name}: ${a.message}`;
        if (typeof a === 'object' && a !== null) {
          try { return JSON.stringify(a); } catch (_) { return '[Object]'; }
        }
        return String(a);
      }).join(' ');

      const entry = {
        timestamp: new Date().toISOString(),
        level: String(level || 'info').toUpperCase(),
        message: redactSensitiveTokens(serialized)
      };

      this.logBuffer.push(entry);
      if (this.logBuffer.length > this.maxLogLines) {
        this.logBuffer.splice(0, this.logBuffer.length - this.maxLogLines);
      }
      return entry;
    }

    installConsoleInterceptor() {
      if (typeof console === 'undefined' || this._intercepted) return;
      this._intercepted = true;
      ['info', 'warn', 'error', 'log'].forEach(method => {
        const orig = typeof console[method] === 'function' ? console[method].bind(console) : null;
        this._originalConsole[method] = orig;
        console[method] = (...args) => {
          try {
            this.recordLog(method === 'log' ? 'info' : method, ...args);
          } catch (_) {}
          if (orig) orig(...args);
        };
      });
    }

    getLogs(filterQuery = '', levelFilter = 'ALL') {
      const q = String(filterQuery || '').trim().toLowerCase();
      const lvl = String(levelFilter || 'ALL').toUpperCase();
      return this.logBuffer.filter(item => {
        if (lvl !== 'ALL' && item.level !== lvl) return false;
        if (q && !item.message.toLowerCase().includes(q) && !item.level.toLowerCase().includes(q)) return false;
        return true;
      });
    }

    exportRedactedText(filterQuery = '', levelFilter = 'ALL') {
      const header = [
        '=== ECLIPSE DIAGNOSTIC LOG EXPORT (REDACTED) ===',
        `ExportedAt: ${new Date().toISOString()}`,
        `TargetFPS: ${this.targetFps} (Hidden: ${this.isHidden}, Focused: ${this.isFocused})`,
        `BufferCount: ${this.logBuffer.length}/${this.maxLogLines}`,
        '================================================'
      ].join('\n');

      const lines = this.getLogs(filterQuery, levelFilter).map(
        e => `[${e.timestamp}] [${e.level}] ${e.message}`
      );
      return `${header}\n${lines.join('\n')}`;
    }

    downloadDiagnosticsTxt(filterQuery = '', levelFilter = 'ALL') {
      const content = this.exportRedactedText(filterQuery, levelFilter);
      if (typeof document !== 'undefined') {
        const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `eclipse-diagnostics-${Date.now()}.txt`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
      }
      return content;
    }

    openDiagnosticsModal() {
      if (typeof document === 'undefined') return;
      let modal = document.getElementById('eclipse-diagnostics-modal');
      if (!modal) {
        modal = document.createElement('div');
        modal.id = 'eclipse-diagnostics-modal';
        modal.className = 'modal-backdrop';
        modal.style.cssText = 'position:fixed;inset:0;z-index:9995;display:flex;align-items:center;justify-content:center;background:rgba(5,5,10,0.78);backdrop-filter:blur(20px);';
        document.body.appendChild(modal);
      }
      modal.classList.remove('hidden');

      modal.innerHTML = `
        <div class="dialog-card" style="width:760px;max-width:95vw;max-height:88vh;display:flex;flex-direction:column;gap:14px;padding:22px;border-radius:22px;background:rgba(16,16,26,0.92);backdrop-filter:blur(20px);border:1px solid rgba(255,255,255,0.1);color:#fff;box-shadow:0 24px 64px rgba(0,0,0,0.65);">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;">
            <div>
              <span style="font-size:11px;color:#a855f7;font-weight:700;letter-spacing:1.2px;">FRAME GOVERNOR &amp; TELEMETRY</span>
              <h3 style="margin:2px 0 0;font-size:19px;">In-App Diagnostics Viewer</h3>
            </div>
            <div style="display:flex;align-items:center;gap:8px;">
              <span id="diag-fps-badge" style="padding:4px 10px;border-radius:999px;background:rgba(168,85,247,0.2);border:1px solid rgba(168,85,247,0.4);font-size:12px;font-weight:700;color:#e9d5ff;">Target: ${this.targetFps} FPS</span>
              <button type="button" id="btn-close-diag-modal" style="padding:6px 12px;border-radius:999px;border:1px solid rgba(255,255,255,0.15);background:transparent;color:#fff;cursor:pointer;">✕</button>
            </div>
          </div>

          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <input type="text" id="diag-search-input" placeholder="Search logs (tokens/cookies auto-redacted)..." style="flex:1;min-width:200px;padding:8px 14px;border-radius:999px;border:1px solid rgba(255,255,255,0.12);background:rgba(255,255,255,0.05);color:#fff;font-size:13px;">
            <select id="diag-level-select" style="padding:8px 14px;border-radius:999px;border:1px solid rgba(255,255,255,0.12);background:rgba(24,24,36,0.95);color:#fff;font-size:13px;">
              <option value="ALL">All Levels</option>
              <option value="INFO">INFO</option>
              <option value="WARN">WARN</option>
              <option value="ERROR">ERROR</option>
            </select>
            <button type="button" id="btn-export-diag-txt" style="padding:8px 16px;border-radius:999px;border:none;background:#a855f7;color:#fff;font-weight:700;font-size:12px;cursor:pointer;">Export .txt</button>
          </div>

          <pre id="diag-log-output" style="flex:1;min-height:300px;max-height:52vh;overflow-y:auto;margin:0;padding:14px;border-radius:14px;background:rgba(6,6,12,0.85);border:1px solid rgba(255,255,255,0.08);font-family:monospace;font-size:12px;line-height:1.5;color:#d8b4fe;white-space:pre-wrap;word-break:break-word;"></pre>
        </div>
      `;

      const outputEl = modal.querySelector('#diag-log-output');
      const searchEl = modal.querySelector('#diag-search-input');
      const levelEl = modal.querySelector('#diag-level-select');

      const refreshLogs = () => {
        const items = this.getLogs(searchEl.value, levelEl.value);
        outputEl.textContent = items.length
          ? items.map(e => `[${e.timestamp}] [${e.level}] ${e.message}`).join('\n')
          : 'No matching diagnostic entries.';
      };

      searchEl.addEventListener('input', refreshLogs);
      levelEl.addEventListener('change', refreshLogs);
      modal.querySelector('#btn-close-diag-modal').addEventListener('click', () => modal.classList.add('hidden'));
      modal.querySelector('#btn-export-diag-txt').addEventListener('click', () => {
        this.downloadDiagnosticsTxt(searchEl.value, levelEl.value);
      });

      refreshLogs();
    }
  }

  if (typeof window !== 'undefined') {
    window.EclipseFrameGovernor = EclipseFrameGovernor;
    if (!window.eclipseFrameGovernor) {
      window.eclipseFrameGovernor = new EclipseFrameGovernor();
    }
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { EclipseFrameGovernor, redactSensitiveTokens };
  }
})();
