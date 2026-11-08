// JavaScript / qr-session-transfer.js / PC & Mobile Session Transfer Handshake Engine
// Part of Eclipse Music Player — MIT License

const crypto = require('crypto');
const os = require('os');
const http = require('http');
const fs = require('fs');
const path = require('path');

const TRANSFER_TOKEN_TTL_MS = 5 * 60 * 1000; // 5 minutes
const pendingTransfers = new Map();

// Multi-process persistent anti-replay ledger on disk
function getLedgerDir() {
  if (process.env.ECLIPSE_DATA_DIR) return process.env.ECLIPSE_DATA_DIR;
  try {
    const defaultDir = path.join(os.homedir(), '.eclipse-music');
    fs.mkdirSync(defaultDir, { recursive: true });
    return defaultDir;
  } catch (_) {
    return os.tmpdir();
  }
}

function getLedgerPath() {
  return path.join(getLedgerDir(), '.consumed-transfers.json');
}

function isTransferConsumedOnDisk(transferId) {
  if (!transferId) return false;
  const ledgerPath = getLedgerPath();
  try {
    if (fs.existsSync(ledgerPath)) {
      const data = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
      if (data && data[transferId]) {
        if (Date.now() < Number(data[transferId])) {
          return true;
        }
      }
    }
  } catch (_) {}
  return false;
}

function markTransferConsumedOnDisk(transferId, expiresAt) {
  if (!transferId) return;
  const ledgerPath = getLedgerPath();
  try {
    let data = {};
    if (fs.existsSync(ledgerPath)) {
      try { data = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) || {}; } catch (_) {}
    }
    const now = Date.now();
    for (const [id, exp] of Object.entries(data)) {
      if (now > Number(exp)) delete data[id];
    }
    data[transferId] = Number(expiresAt) || (now + TRANSFER_TOKEN_TTL_MS);
    fs.writeFileSync(ledgerPath, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
  } catch (_) {}
}

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
  return null; // Never advertise loopback 127.0.0.1 as a LAN server
}

function deriveTransferCipherKey(secretKey, pin = '') {
  if (pin) {
    // Two-channel key derivation: PBKDF2 with out-of-band PIN protection
    return crypto.pbkdf2Sync(secretKey, `eclipse-pin::${pin}`, 5000, 32, 'sha256');
  }
  return crypto.createHash('sha256').update(`eclipse-qr-v2::${secretKey}`).digest();
}

function encryptAccountForTransit(accountObj, secretKey, pin = '') {
  const key = deriveTransferCipherKey(secretKey, pin);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plain = JSON.stringify(accountObj || {});
  let encrypted = cipher.update(plain, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return { enc: true, iv: iv.toString('hex'), tag, data: encrypted, pinProtected: !!pin };
}

function decryptAccountFromTransit(encBundle, secretKey, pin = '') {
  if (!encBundle || !encBundle.enc) return encBundle;
  const key = deriveTransferCipherKey(secretKey, pin);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(encBundle.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(encBundle.tag, 'hex'));
  let decrypted = decipher.update(encBundle.data, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return JSON.parse(decrypted);
}

/**
 * Generate secure session handoff payload and QR link
 * In standard LAN mode: QR code contains ONLY ticket metadata (NO cookies inside QR).
 * In direct PIN mode: QR code contains ciphertext encrypted with an out-of-band screen PIN.
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

  const timer = setTimeout(() => {
    pendingTransfers.delete(transferId);
  }, TRANSFER_TOKEN_TTL_MS + 1000);
  if (timer && typeof timer.unref === 'function') timer.unref();

  // If two-channel direct mode is requested, generate out-of-band PIN
  let pin = null;
  let directPayload = null;
  if (options && options.directPin) {
    pin = String(Math.floor(100000 + Math.random() * 900000));
    const enc = encryptAccountForTransit(payload.account, secretKey, pin);
    directPayload = {
      ...enc,
      transferId,
      expiresAt
    };
  }

  // Standard QR contains ONLY ticket coordinates (Zero credentials)
  const qrObject = {
    app: 'eclipse-music',
    action: 'session_transfer',
    transferId,
    secretKey,
    sourceServerUrl,
    expiresAt,
    v: 2
  };
  if (directPayload) {
    qrObject.directPayload = directPayload;
  }

  return {
    transferId,
    secretKey,
    pin, // Displayed on sender screen only!
    expiresAt,
    sourceServerUrl,
    directPayload,
    qrData: JSON.stringify(qrObject)
  };
}

/**
 * Claim session from local pendingTransfers (burns token on first valid claim)
 */
function claimTransferSession(transferId, secretKey, options = {}) {
  // Check multi-process persistent ledger
  if (isTransferConsumedOnDisk(transferId)) {
    throw new Error('Transfer token has already been claimed (replay blocked)');
  }

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

  const account = pending.account;
  pendingTransfers.delete(transferId);
  markTransferConsumedOnDisk(transferId, pending.expiresAt);

  if (options && options.encryptForTransit) {
    return encryptAccountForTransit(account, secretKey, options.pin || '');
  }
  return account;
}

/**
 * Claim session across devices/processes from remote sourceServerUrl over LAN (or via PIN-protected direct payload)
 */
function claimRemoteTransferSession(sourceServerUrl, transferId, secretKey, directPayload = null, pin = '') {
  return new Promise(async (resolve, reject) => {
    // Multi-process persistent anti-replay check
    if (isTransferConsumedOnDisk(transferId)) {
      return reject(new Error('Transfer token has already been claimed (replay blocked across processes)'));
    }

    // 1. LAN Network Claim (Primary & Standard Flow)
    if (sourceServerUrl && /^https?:\/\//i.test(sourceServerUrl)) {
      try {
        const targetUrl = `${sourceServerUrl.replace(/\/+$/, '')}/api/ytm/session-transfer/claim`;
        const parsed = new URL(targetUrl);
        const isLoopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
        
        const reqBody = JSON.stringify({
          transferId,
          secretKey,
          transitEncrypted: true,
          pin: pin || ''
        });

        if (typeof globalThis.__murielFetch === 'function' && !isLoopback) {
          const r = await globalThis.__murielFetch(targetUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: reqBody
          });
          const data = await r.json();
          if (data && data.success) {
            const acc = data.encryptedAccount
              ? decryptAccountFromTransit(data.encryptedAccount, secretKey, pin)
              : data.account;
            markTransferConsumedOnDisk(transferId, Date.now() + TRANSFER_TOKEN_TTL_MS);
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
              timeout: 6000
            }, (res) => {
              let raw = '';
              res.on('data', chunk => { raw += chunk; });
              res.on('end', () => {
                try {
                  const data = JSON.parse(raw || '{}');
                  if (data && data.success) {
                    const acc = data.encryptedAccount
                      ? decryptAccountFromTransit(data.encryptedAccount, secretKey, pin)
                      : data.account;
                    return resLan(acc);
                  }
                  rejLan(new Error((data && data.error) || 'LAN transfer claim failed'));
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
          if (lanResult) {
            markTransferConsumedOnDisk(transferId, Date.now() + TRANSFER_TOKEN_TTL_MS);
            return resolve(lanResult);
          }
        }
      } catch (err) {
        if (!directPayload) return reject(err);
      }
    }

    // 2. Direct Two-Channel PIN Claim (When sender has no TCP listening socket)
    if (directPayload && secretKey) {
      try {
        if (Date.now() > Number(directPayload.expiresAt)) {
          throw new Error('Direct transfer ticket has expired');
        }
        if (directPayload.pinProtected && !pin) {
          throw new Error('PIN required to decrypt direct transfer ticket');
        }
        const acc = decryptAccountFromTransit(directPayload, secretKey, pin);
        if (!acc || (!acc.cookie && !acc.id)) {
          throw new Error('Invalid PIN or corrupt payload');
        }
        markTransferConsumedOnDisk(transferId, directPayload.expiresAt);
        return resolve(acc);
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
  encryptAccountForTransit,
  decryptAccountFromTransit,
  isTransferConsumedOnDisk,
  markTransferConsumedOnDisk
};
