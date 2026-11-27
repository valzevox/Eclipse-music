'use strict';

// Network/cookie boundary constants for External Web Session bridge
const EXTERNAL_WEB_ORIGIN = 'https://open.spotify.com/';
const EXTERNAL_WEB_ORIGIN_PATTERN = 'https://open.spotify.com/*';
const EXTERNAL_WEB_COOKIE_NAME = 'sp_dc';
const LOOPBACK_ORIGIN_PATTERN = 'http://127.0.0.1/*';

// Feature-detection compatibility helpers (no UA sniffing)
function getExtensionApi() {
  if (typeof globalThis.chrome !== 'undefined' && globalThis.chrome) {
    return globalThis.chrome;
  }
  if (typeof globalThis.browser !== 'undefined' && globalThis.browser) {
    return globalThis.browser;
  }
  return null;
}

function hasPermissionsApi(api) {
  return Boolean(api && api.permissions && typeof api.permissions.request === 'function');
}

function hasCookiesApi(api) {
  return Boolean(api && api.cookies && typeof api.cookies.getAll === 'function');
}

function openExternalTab(api, url) {
  if (api && api.tabs && typeof api.tabs.create === 'function') {
    api.tabs.create({ url });
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

function isStrictExternalWebDomain(rawDomain) {
  const clean = String(rawDomain || '').trim().toLowerCase().replace(/^\./, '');
  return clean === 'open.spotify.com' || clean === 'spotify.com';
}

document.addEventListener('DOMContentLoaded', () => {
  const api = getExtensionApi();
  const serviceSelect = document.getElementById('service');
  const cookieNotice = document.getElementById('cookie-notice');
  const portInput = document.getElementById('port');
  const nonceInput = document.getElementById('nonce');
  const btnPair = document.getElementById('btn-pair');
  const missingActions = document.getElementById('missing-session-actions');
  const btnOpenLogin = document.getElementById('btn-open-login');
  const btnScanAgain = document.getElementById('btn-scan-again');
  const statusEl = document.getElementById('status');

  const params = new URLSearchParams(window.location.search);
  if (params.get('port')) portInput.value = params.get('port');
  if (params.get('nonce')) nonceInput.value = params.get('nonce');
  if (params.get('service') === 'external_web') {
    serviceSelect.value = 'external_web';
  }

  function updateServiceUi() {
    const isExternal = serviceSelect.value === 'external_web';
    cookieNotice.style.display = isExternal ? 'block' : 'none';
    missingActions.style.display = 'none';
    showStatus('', '');
  }

  serviceSelect.addEventListener('change', updateServiceUi);
  updateServiceUi();

  btnOpenLogin.addEventListener('click', () => {
    openExternalTab(api, EXTERNAL_WEB_ORIGIN);
  });

  btnScanAgain.addEventListener('click', () => {
    btnPair.click();
  });

  btnPair.addEventListener('click', async () => {
    const service = serviceSelect.value;
    const port = parseInt(portInput.value, 10);
    const nonce = nonceInput.value.trim();

    missingActions.style.display = 'none';

    if (!port || port <= 1024 || port > 65535) {
      showStatus('Please enter a valid pairing port from Eclipse', 'error');
      return;
    }
    if (!nonce || nonce.length < 32) {
      showStatus('Please enter the one-time pairing nonce from Eclipse', 'error');
      return;
    }

    if (!hasPermissionsApi(api) || !hasCookiesApi(api)) {
      showStatus('This browser does not support required extension permissions or cookie APIs.', 'error');
      return;
    }

    // Call chrome.permissions.request synchronously inside click handler BEFORE any await
    const permissionRequest = service === 'external_web'
      ? { permissions: ['cookies'], origins: [LOOPBACK_ORIGIN_PATTERN, EXTERNAL_WEB_ORIGIN_PATTERN] }
      : { permissions: ['cookies'], origins: [LOOPBACK_ORIGIN_PATTERN] };

    const permissionPromise = api.permissions.request(permissionRequest);

    btnPair.disabled = true;
    showStatus('Requesting permissions...', 'loading');

    try {
      const granted = await permissionPromise;
      if (!granted) {
        showStatus('Required permissions were denied.', 'error');
        btnPair.disabled = false;
        return;
      }

      if (service === 'external_web') {
        await handleExternalWebPairing(api, port, nonce);
      } else {
        await handleYtmPairing(api, port, nonce);
      }
    } catch (err) {
      showStatus(`Connection failed: ${err.message}`, 'error');
      btnPair.disabled = false;
    }
  });

  async function handleExternalWebPairing(extApi, port, nonce) {
    showStatus('Checking External Web Session...', 'loading');

    const rawCookies = await extApi.cookies.getAll({ url: EXTERNAL_WEB_ORIGIN });
    const now = Math.floor(Date.now() / 1000);
    let matchedCookie = null;

    if (Array.isArray(rawCookies)) {
      for (const c of rawCookies) {
        if (!c || c.name !== EXTERNAL_WEB_COOKIE_NAME || typeof c.value !== 'string' || !c.value) continue;
        if (c.expirationDate && c.expirationDate <= now) continue;
        if (!isStrictExternalWebDomain(c.domain)) continue;

        const candidate = {
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: (c.path && c.path.startsWith('/')) ? c.path : '/',
          secure: Boolean(c.secure),
          httpOnly: Boolean(c.httpOnly),
          expirationDate: c.expirationDate || null,
          hostOnly: Boolean(c.hostOnly)
        };

        if (!matchedCookie) {
          matchedCookie = candidate;
        } else {
          const existingClean = String(matchedCookie.domain || '').replace(/^\./, '').toLowerCase();
          const currentClean = String(candidate.domain || '').replace(/^\./, '').toLowerCase();
          if (currentClean === 'open.spotify.com' && existingClean !== 'open.spotify.com') {
            matchedCookie = candidate;
          }
        }
      }
    }

    if (!matchedCookie) {
      showStatus('No active External Web Session found. Open the login page, sign in, then click Scan Again.', 'error');
      missingActions.style.display = 'block';
      btnPair.disabled = false;
      return;
    }

    await sendPairingPayload(port, nonce, {
      version: 1,
      target: 'EXTERNAL_WEB',
      cookies: [matchedCookie]
    });
  }

  async function handleYtmPairing(extApi, port, nonce) {
    showStatus('Extracting authentication cookies...', 'loading');

    const domains = ['.youtube.com', 'music.youtube.com'];
    const rawCookies = [];

    for (const d of domains) {
      const cookies = await extApi.cookies.getAll({ domain: d });
      if (Array.isArray(cookies)) {
        rawCookies.push(...cookies);
      }
    }

    const now = Math.floor(Date.now() / 1000);
    const eligibleCookies = [];

    for (const c of rawCookies) {
      if (!c || !c.name || typeof c.value !== 'string') continue;
      if (c.expirationDate && c.expirationDate <= now) continue;

      const dom = String(c.domain || '').trim().toLowerCase().replace(/^\./, '');
      if (dom !== 'music.youtube.com' && dom !== 'youtube.com' && !dom.endsWith('.youtube.com')) {
        continue;
      }

      const path = (c.path && c.path.startsWith('/')) ? c.path : '/';
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

    await sendPairingPayload(port, nonce, {
      nonce,
      cookies: selectedCookies
    });
  }

  async function sendPairingPayload(port, nonce, payload) {
    showStatus('Connecting to Eclipse loopback service...', 'loading');

    const pairEndpoint = `http://127.0.0.1:${port}/api/extension/pair`;
    const response = await fetch(pairEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Eclipse-Nonce': nonce
      },
      body: JSON.stringify(payload)
    });

    const resJson = await response.json().catch(() => ({}));

    if (response.ok && resJson.success) {
      showStatus('Connected successfully! You can close this popup.', 'success');
      nonceInput.value = '';
      setTimeout(() => { window.close(); }, 2500);
    } else {
      const errMsg = resJson.error || 'Failed to authenticate pairing with Eclipse';
      showStatus(`Error: ${errMsg}`, 'error');
      if (resJson && resJson.details) {
        const dc = document.getElementById('diag-container');
        const dt = document.getElementById('diag-text');
        if (dc && dt) {
          dt.value = JSON.stringify(resJson.details, null, 2);
          dc.style.display = 'block';
        }
      }
      btnPair.disabled = false;
    }
  }

  function showStatus(text, type) {
    statusEl.textContent = text;
    statusEl.className = type ? `status ${type}` : 'status';
  }
});

document.getElementById('btn-copy-diag')?.addEventListener('click', () => {
  const t = document.getElementById('diag-text');
  if (t && t.value) {
    navigator.clipboard.writeText(t.value).then(() => {
      const b = document.getElementById('btn-copy-diag');
      if (b) {
        b.textContent = 'Copied!';
        setTimeout(() => { b.textContent = 'Copy Diagnostic Info'; }, 2000);
      }
    });
  }
});
