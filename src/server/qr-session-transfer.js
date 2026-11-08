// JavaScript / qr-session-transfer.js / PC & Mobile Session Transfer Handshake Engine
// Part of Eclipse Music Player — MIT License

const crypto = require('crypto');
const os = require('os');
const http = require('http');

const TRANSFER_TOKEN_TTL_MS = 5 * 60 * 1000; // 5 minutes
const pendingTransfers = new Map();

function getPrimaryLocalIp() {
  try {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets || {})) {
      for (const net of (nets[name] || [])) {
        if (net.family === 'IPv4' && !net.internal) {
          return net.address;
        }
      }
    }
  } catch (_) {}
  return '127.0.0.1';
}

function deriveTransferCipherKey(secretKey) {
  return crypto.createHash('sha256').update(`eclipse-qr-v2::${secretKey}`).digest();
}

function encryptAccountForTransit(accountObj, secretKey) {
  const key = deriveTransferCipherKey(secretKey);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plain = JSON.stringify(accountObj || {});
  let encrypted = cipher.update(plain, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return { enc: true, iv: iv.toString('hex'), tag, data: encrypted };
}

function decryptAccountFromTransit(encBundle, secretKey) {
  if (!encBundle || !encBundle.enc) return encBundle;
  const key = deriveTransferCipherKey(secretKey);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(encBundle.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(encBundle.tag, 'hex'));
  let decrypted = decipher.update(encBundle.data, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return JSON.parse(decrypted);
}

/**
 * Generate secure session handoff payload and QR link
 */
function createTransferPayload(accountData = {}, port = 38472, options = {}) {
  const transferId = crypto.randomBytes(16).toString('hex');
  const secretKey = crypto.randomBytes(24).toString('base64url');
  const expiresAt = Date.now() + TRANSFER_TOKEN_TTL_MS;
  const hostIp = getPrimaryLocalIp();
  const sourceServerUrl = `http://${hostIp}:${port}`;

  const payload = {
    transferId,
    secretKey,
    account: {
      id: accountData.id || '',
      name: accountData.name || '',
      avatar: accountData.avatar || accountData.avatarUrl || '',
      cookie: accountData.cookie || ''
    },
    expiresAt
  };

  pendingTransfers.set(transferId, payload);

  // Auto clean up after expiration
  const timer = setTimeout(() => {
    pendingTransfers.delete(transferId);
  }, TRANSFER_TOKEN_TTL_MS + 1000);
  if (timer && typeof timer.unref === 'function') timer.unref();

  // Encrypt transit payload for direct QR embedding (enables Mobile -> PC without inbound socket)
  const directPayload = (options && options.includeDirectPayload !== false)
    ? encryptAccountForTransit(payload.account, secretKey)
    : null;

  // Return transfer ticket for QR Code encoding
  return {
    transferId,
    secretKey,
    expiresAt,
    sourceServerUrl,
    directPayload,
    qrData: JSON.stringify({
      app: 'eclipse-music',
      action: 'session_transfer',
      transferId,
      secretKey,
      sourceServerUrl,
      directPayload,
      v: 2
    })
  };
}

/**
 * Claim session from local pendingTransfers (burns token on first valid claim)
 */
function claimTransferSession(transferId, secretKey, options = {}) {
  const pending = pendingTransfers.get(transferId);
  if (!pending) {
    throw new Error('Transfer token not found or expired');
  }

  if (Date.now() > pending.expiresAt) {
    pendingTransfers.delete(transferId);
    throw new Error('Transfer token has expired');
  }

  const expectedBuf = Buffer.from(String(pending.secretKey));
  const givenBuf = Buffer.from(String(secretKey || ''));
  if (expectedBuf.length !== givenBuf.length || !crypto.timingSafeEqual(expectedBuf, givenBuf)) {
    throw new Error('Invalid transfer credentials');
  }

  // Valid handshake: retrieve account data and burn token (one-time use)
  const account = pending.account;
  pendingTransfers.delete(transferId);

  if (options && options.encryptForTransit) {
    return encryptAccountForTransit(account, secretKey);
  }
  return account;
}

/**
 * Claim session across devices/processes from remote sourceServerUrl over LAN (or via direct QR payload)
 */
function claimRemoteTransferSession(sourceServerUrl, transferId, secretKey, directPayload = null) {
  // If direct transit-encrypted payload was embedded in the QR (e.g. Mobile -> PC)
  if (directPayload && secretKey) {
    try {
      const acc = decryptAccountFromTransit(directPayload, secretKey);
      if (acc && (acc.cookie || acc.id)) {
        return Promise.resolve(acc);
      }
    } catch (_) {}
  }

  return new Promise((resolve, reject) => {
    if (!sourceServerUrl || !/^https?:\/\//i.test(sourceServerUrl)) {
      return reject(new Error('Invalid sourceServerUrl'));
    }
    const targetUrl = `${sourceServerUrl.replace(/\/+$/, '')}/api/ytm/session-transfer/claim`;
    const reqBody = JSON.stringify({
      transferId,
      secretKey,
      transitEncrypted: true
    });

    if (typeof globalThis.__murielFetch === 'function') {
      globalThis.__murielFetch(targetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: reqBody
      })
        .then(r => r.json())
        .then(data => {
          if (!data || !data.success) {
            throw new Error((data && data.error) || 'Remote session transfer failed');
          }
          const acc = data.encryptedAccount
            ? decryptAccountFromTransit(data.encryptedAccount, secretKey)
            : data.account;
          resolve(acc);
        })
        .catch(reject);
      return;
    }

    const parsed = new URL(targetUrl);
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port || 80,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(reqBody)
      },
      timeout: 8000
    }, (res) => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        try {
          const data = JSON.parse(raw || '{}');
          if (!data || !data.success) {
            return reject(new Error((data && data.error) || 'Remote session transfer failed'));
          }
          const acc = data.encryptedAccount
            ? decryptAccountFromTransit(data.encryptedAccount, secretKey)
            : data.account;
          resolve(acc);
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('Remote session transfer timed out')); });
    req.write(reqBody);
    req.end();
  });
}

module.exports = {
  createTransferPayload,
  claimTransferSession,
  claimRemoteTransferSession,
  encryptAccountForTransit,
  decryptAccountFromTransit
};
