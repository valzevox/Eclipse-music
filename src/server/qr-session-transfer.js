// JavaScript / qr-session-transfer.js / PC & Mobile Session Transfer Handshake Engine
// Part of Eclipse Music Player — MIT License

const crypto = require('crypto');
const os = require('os');

const TRANSFER_TOKEN_TTL_MS = 5 * 60 * 1000; // 5 minutes
const pendingTransfers = new Map();

function getPrimaryLocalIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return '127.0.0.1';
}

/**
 * Generate secure session handoff payload and QR link
 */
function createTransferPayload(accountData = {}, port = 38472) {
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
      avatar: accountData.avatar || '',
      cookie: accountData.cookie || ''
    },
    expiresAt
  };

  pendingTransfers.set(transferId, payload);

  // Auto clean up after expiration
  setTimeout(() => {
    pendingTransfers.delete(transferId);
  }, TRANSFER_TOKEN_TTL_MS + 1000);

  // Return transfer ticket for QR Code encoding
  return {
    transferId,
    secretKey,
    expiresAt,
    sourceServerUrl,
    qrData: JSON.stringify({
      app: 'eclipse-music',
      action: 'session_transfer',
      transferId,
      secretKey,
      sourceServerUrl,
      v: 2
    })
  };
}

/**
 * Mobile claims session using transferId & secretKey
 */
function claimTransferSession(transferId, secretKey) {
  const pending = pendingTransfers.get(transferId);
  if (!pending) {
    throw new Error('Transfer token not found or expired');
  }

  if (Date.now() > pending.expiresAt) {
    pendingTransfers.delete(transferId);
    throw new Error('Transfer token has expired');
  }

  if (pending.secretKey !== secretKey) {
    throw new Error('Invalid transfer credentials');
  }

  // Valid handshake: retrieve account data and burn token (one-time use)
  const account = pending.account;
  pendingTransfers.delete(transferId);

  return account;
}

module.exports = {
  createTransferPayload,
  claimTransferSession
};
