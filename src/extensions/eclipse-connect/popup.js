'use strict';

document.addEventListener('DOMContentLoaded', () => {
  const portInput = document.getElementById('port');
  const nonceInput = document.getElementById('nonce');
  const btnPair = document.getElementById('btn-pair');
  const statusEl = document.getElementById('status');

  // Pre-fill port or nonce if passed in query string or clipboard
  const params = new URLSearchParams(window.location.search);
  if (params.get('port')) portInput.value = params.get('port');
  if (params.get('nonce')) nonceInput.value = params.get('nonce');

  btnPair.addEventListener('click', async () => {
    const port = parseInt(portInput.value, 10);
    const nonce = nonceInput.value.trim();

    if (!port || port <= 1024 || port > 65535) {
      showStatus('Please enter a valid pairing port from Eclipse', 'error');
      return;
    }
    if (!nonce || nonce.length < 32) {
      showStatus('Please enter the one-time pairing nonce from Eclipse', 'error');
      return;
    }

    btnPair.disabled = true;
    showStatus('Requesting permissions...', 'loading');

    try {
      // P1-2: chrome.permissions.request MUST be called synchronously inside user click gesture BEFORE any await
      if (chrome.permissions && chrome.permissions.request) {
        const granted = await chrome.permissions.request({
          origins: ['http://127.0.0.1/*']
        });
        if (!granted) {
          showStatus('Permission to connect to local Eclipse service was denied.', 'error');
          btnPair.disabled = false;
          return;
        }
      }

      showStatus('Extracting authentication cookies...', 'loading');

      // P0-4: Query cookies strictly for YouTube target domains matching music.youtube.com
      // Do NOT query or include .google.com cookies in this YTM authentication request
      const domains = ['.youtube.com', 'music.youtube.com'];
      const rawCookies = [];

      for (const d of domains) {
        const cookies = await chrome.cookies.getAll({ domain: d });
        if (Array.isArray(cookies)) {
          rawCookies.push(...cookies);
        }
      }

      // Filter and deduplicate all applicable cookies matching music.youtube.com and root path /
      // Collect ALL cookies from YouTube target domains, not a short hardcoded allowlist
      const now = Math.floor(Date.now() / 1000);
      const eligibleCookies = [];

      for (const c of rawCookies) {
        if (!c || !c.name || typeof c.value !== 'string') continue;
        if (c.expirationDate && c.expirationDate <= now) continue;

        const dom = String(c.domain || '').trim().toLowerCase().replace(/^\./, '');
        // Must match music.youtube.com (either music.youtube.com or parent youtube.com)
        if (dom !== 'music.youtube.com' && dom !== 'youtube.com' && !dom.endsWith('.youtube.com')) {
          continue;
        }

        const path = (c.path && c.path.startsWith('/')) ? c.path : '/';
        // Account Switcher request is at /getAccountSwitcherEndpoint, so cookie path must match root / or target endpoint
        if (path !== '/' && path !== '/getAccountSwitcherEndpoint') {
          continue;
        }

        eligibleCookies.push({
          name: c.name.trim(),
          value: c.value,
          domain: c.domain,
          path: path,
          secure: Boolean(c.secure),
          httpOnly: Boolean(c.httpOnly),
          expirationDate: c.expirationDate || null,
          hostOnly: Boolean(c.hostOnly)
        });
      }

      // Deduplicate deterministically by cookie name (exact music.youtube.com wins over .youtube.com)
      const byName = new Map();
      for (const c of eligibleCookies) {
        const existing = byName.get(c.name);
        if (!existing) {
          byName.set(c.name, c);
        } else {
          const existingClean = existing.domain.replace(/^\./, '').toLowerCase();
          const currentClean = c.domain.replace(/^\./, '').toLowerCase();
          if (currentClean === 'music.youtube.com' && existingClean !== 'music.youtube.com') {
            byName.set(c.name, c);
          } else if (c.path.length > existing.path.length) {
            byName.set(c.name, c);
          }
        }
      }

      const selectedCookies = Array.from(byName.values());

      const hasSigningCred = selectedCookies.some(c => c.name === 'SAPISID' || c.name === '__Secure-3PAPISID');
      const hasLoginCookie = selectedCookies.some(c => c.name === 'LOGIN_INFO');

      if (selectedCookies.length === 0 || (!hasSigningCred && !hasLoginCookie)) {
        showStatus('No active YouTube Music login found in this browser. Please log in to music.youtube.com first.', 'error');
        btnPair.disabled = false;
        return;
      }
      if (!hasSigningCred && hasLoginCookie) {
        showStatus('Session cookie (LOGIN_INFO) found, but missing SAPISID or __Secure-3PAPISID credential needed to sign SAPISIDHASH.', 'error');
        btnPair.disabled = false;
        return;
      }

      showStatus('Connecting to Eclipse loopback service...', 'loading');

      const pairEndpoint = `http://127.0.0.1:${port}/api/extension/pair`;
      const response = await fetch(pairEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Eclipse-Nonce': nonce
        },
        body: JSON.stringify({
          nonce,
          cookies: selectedCookies
        })
      });

      const resJson = await response.json().catch(() => ({}));

      if (response.ok && resJson.success) {
        showStatus('Connected successfully! You can close this popup.', 'success');
        // Clear sensitive inputs
        nonceInput.value = '';
        setTimeout(() => { window.close(); }, 2500);
      } else {
        const errMsg = resJson.error || 'Failed to authenticate pairing with Eclipse';
        showStatus(`Error: ${errMsg}`, 'error');
        if (resJson && resJson.details) {
          const dc = document.getElementById("diag-container");
          const dt = document.getElementById("diag-text");
          if (dc && dt) {
            dt.value = JSON.stringify(resJson.details, null, 2);
            dc.style.display = "block";
          }
        }
        btnPair.disabled = false;
      }
    } catch (err) {
      showStatus(`Connection failed: ${err.message}`, 'error');
      btnPair.disabled = false;
    }
  });

  function showStatus(text, type) {
    statusEl.textContent = text;
    statusEl.className = `status ${type}`;
  }
});


document.getElementById("btn-copy-diag")?.addEventListener("click", () => {
  const t = document.getElementById("diag-text");
  if (t && t.value) {
    navigator.clipboard.writeText(t.value).then(() => {
      const b = document.getElementById("btn-copy-diag");
      if (b) {
        b.textContent = "Copied!";
        setTimeout(() => { b.textContent = "Copy Diagnostic Info"; }, 2000);
      }
    });
  }
});
