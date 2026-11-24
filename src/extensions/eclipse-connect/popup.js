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
    showStatus('Reading YouTube session cookies...', 'loading');

    try {
      // Query cookies with chrome.cookies API strictly for YouTube and Google auth domains
      const domains = ['.youtube.com', 'music.youtube.com', '.google.com'];
      const allCookies = [];

      for (const d of domains) {
        const cookies = await chrome.cookies.getAll({ domain: d });
        if (Array.isArray(cookies)) {
          allCookies.push(...cookies);
        }
      }

      // Filter only relevant authentication and session cookies
      const relevantNames = new Set([
        'SAPISID', '__Secure-3PAPISID', 'APISID', 'SSID', 'SID',
        '__Secure-3PSID', 'LOGIN_INFO', 'VISITOR_INFO1_LIVE', 'YSC', 'HSID'
      ]);

      const selectedCookies = allCookies.filter(c => relevantNames.has(c.name)).map(c => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        expirationDate: c.expirationDate,
        hostOnly: c.hostOnly
      }));

      if (selectedCookies.length === 0 || !selectedCookies.some(c => c.name === 'SAPISID' || c.name === 'LOGIN_INFO')) {
        showStatus('No active YouTube Music login found in this browser. Please log in to music.youtube.com first.', 'error');
        btnPair.disabled = false;
        return;
      }

      // Request localhost permission dynamically if optional_host_permissions declared
      if (chrome.permissions && chrome.permissions.request) {
        try {
          const granted = await chrome.permissions.request({
            origins: ['http://127.0.0.1/*']
          });
          if (!granted) {
            showStatus('Permission to connect to local Eclipse service was denied.', 'error');
            btnPair.disabled = false;
            return;
          }
        } catch (_) {}
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
        setTimeout(() => {
          window.close();
        }, 2000);
      } else {
        showStatus(`Pairing failed: ${resJson.error || response.statusText}`, 'error');
        btnPair.disabled = false;
      }
    } catch (err) {
      showStatus(`Connection error: ${err.message}. Make sure Eclipse is open.`, 'error');
      btnPair.disabled = false;
    }
  });

  function showStatus(msg, type) {
    statusEl.textContent = msg;
    statusEl.className = `status ${type}`;
  }
});
