// JavaScript / qr-session-transfer.js / PC & Mobile Session Transfer Handshake Engine
// Part of Eclipse Music Player — MIT License

const crypto = require('crypto');
const os = require('os');
const http = require('http');

const TRANSFER_TOKEN_TTL_MS = 5 * 60 * 1000; // 5 minutes
const pendingTransfers = new Map();
const consumedDirectTransfers = new Map(); // Anti-replay cache: transferId -> expiresAt

function getPrimaryLocalIp() {
  try {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets || {})) {
      for (const net of (nets[name] || [])) {
        if (net.family === 'IPv4' && !net.internal && net.address !== '127.0.0.1') {
          return net.address;
        }
      }
    }
  } catch (_) {}
  return null; // Never advertise 127.0.0.1 as a LAN address
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

function signDirectPayload(data, iv, tag, transferId, expiresAt, secretKey) {
  const hmac = crypto.createHmac('sha256', secretKey);
  hmac.update(`${data}:${iv}:${tag}:${transferId}:${expiresAt}`);
  return hmac.digest('hex');
}

function verifyAndClaimDirectPayload(directPayload, secretKey) {
  if (!directPayload || typeof directPayload !== 'object') {
    throw new Error('Invalid direct payload');
  }
  const { enc, iv, tag, data, transferId, expiresAt, sig } = directPayload;
  if (!enc || !iv || !tag || !data || !transferId || !expiresAt || !sig) {
    throw new Error('Malformed direct transfer bundle');
  }

  // 1. Strict Expiration Check
  if (Date.now() > Number(expiresAt)) {
    throw new Error('Direct transfer ticket has expired');
  }

  // 2. Anti-Replay Check (One-Time Burn on Client)
  if (consumedDirectTransfers.has(transferId)) {
    throw new Error('Direct transfer ticket has already been used');
  }

  // 3. Cryptographic Signature Verification
  const expectedSig = signDirectPayload(data, iv, tag, transferId, expiresAt, secretKey);
  const bufExpected = Buffer.from(expectedSig);
  const bufActual = Buffer.from(String(sig));
  if (bufExpected.length !== bufActual.length || !crypto.timingSafeEqual(bufExpected, bufActual)) {
    throw new Error('Direct transfer signature verification failed');
  }

  // 4. Burn the ticket in replay cache with TTL cleanup
  consumedDirectTransfers.set(transferId, expiresAt);
  const cleanTimer = setTimeout(() => {
    consumedDirectTransfers.delete(transferId);
  }, Math.max(1000, Number(expiresAt) - Date.now() + 60000));
  if (cleanTimer && typeof cleanTimer.unref === 'function') cleanTimer.unref();

  // 5. Decrypt payload
  return decryptAccountFromTransit({ enc: true, iv, tag, data }, secretKey);
}

/**
 * Generate secure session handoff payload and QR link
 */
function createTransferPayload(accountData = {}, port = 38472, options = {}) {
  const transferId = crypto.randomBytes(16).toString('hex');
  const secretKey = crypto.randomBytes(24).toString('base64url');
  const expiresAt = Date.now() + TRANSFER_TOKEN_TTL_MS;
  const hostIp = getPrimaryLocalIp();
  const sourceServerUrl = hostIp ? `http://${hostIp}:${port}` : null;

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

  // Encrypt & sign direct payload with expiration and anti-replay
  let directPayload = null;
  if (options && options.includeDirectPayload !== false) {
    const rawEnc = encryptAccountForTransit(payload.account, secretKey);
    const sig = signDirectPayload(rawEnc.data, rawEnc.iv, rawEnc.tag, transferId, expiresAt, secretKey);
    directPayload = {
      ...rawEnc,
      transferId,
      expiresAt,
      sig
    };
  }

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
  return new Promise(async (resolve, reject) => {
    // 1. If sourceServerUrl is a genuine non-loopback LAN URL, attempt burn-on-source claim first
    if (sourceServerUrl && /^https?:\/\//i.test(sourceServerUrl)) {
      try {
        const parsed = new URL(sourceServerUrl);
        if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
          const targetUrl = `${sourceServerUrl.replace(/\/+$/, '')}/api/ytm/session-transfer/claim`;
          const reqBody = JSON.stringify({
            transferId,
            secretKey,
            transitEncrypted: true
          });

          if (typeof globalThis.__murielFetch === 'function') {
            const r = await globalThis.__murielFetch(targetUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: reqBody
            });
            const data = await r.json();
            if (data && data.success) {
              const acc = data.encryptedAccount
                ? decryptAccountFromTransit(data.encryptedAccount, secretKey)
                : data.account;
              return resolve(acc);
            }
          } else {
            const lanResult = await new Promise((resLan, rejLan) => {
              const req = http.request({
                hostname: parsed.hostname,
                port: parsed.port || 80,
                path: parsed.pathname + parsed.search,
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Content-Length': Buffer.byteLength(reqBody)
                },
                timeout: 5000
              }, (res) => {
                let raw = '';
                res.on('data', chunk => { raw += chunk; });
                res.on('end', () => {
                  try {
                    const data = JSON.parse(raw || '{}');
                    if (data && data.success) {
                      const acc = data.encryptedAccount
                        ? decryptAccountFromTransit(data.encryptedAccount, secretKey)
                        : data.account;
                      return resLan(acc);
                    }
                    rejLan(new Error((data && data.error) || 'LAN transfer failed'));
                  } catch (e) {
                    rejLan(e);
                  }
                });
              });
              req.on('error', rejLan);
              req.on('timeout', () => { req.destroy(new Error('LAN transfer timed out')); });
              req.write(reqBody);
              req.end();
            });
            if (lanResult) return resolve(lanResult);
          }
        }
      } catch (_) {
        // Fall through to directPayload
      }
    }

    // 2. Fallback to direct signed & replay-protected payload
    if (directPayload && secretKey) {
      try {
        const acc = verifyAndClaimDirectPayload(directPayload, secretKey);
        if (acc && (acc.cookie || acc.id)) {
          return resolve(acc);
        }
      } catch (err) {
        return reject(err);
      }
    }

    return reject(new Error('No reachable transfer source or valid direct QR payload'));
  });
}

module.exports = {
  createTransferPayload,
  claimTransferSession,
  claimRemoteTransferSession,
  verifyAndClaimDirectPayload,
  encryptAccountForTransit,
  decryptAccountFromTransit
};
