// test-qr-direct-worker.js - Independent secondary process testing direct two-channel PIN QR claim via IPC handshake
const pcQr = require('./src/server/qr-session-transfer');

const [,, transferId, secretKey, directPayloadJson, pin] = process.argv;

async function run() {
  // If IPC channel is available, perform strict handshake with parent
  if (process.send) {
    process.send({ status: 'READY', pid: process.pid });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Timed out waiting for parent GO signal'));
      }, 5000);
      process.on('message', (msg) => {
        if (msg && msg.action === 'GO') {
          clearTimeout(timer);
          resolve();
        }
      });
    });
  }

  try {
    const directPayload = JSON.parse(directPayloadJson);
    const acc = await pcQr.claimRemoteTransferSession(null, transferId, secretKey, directPayload, pin);
    if (acc && acc.cookie === 'SAPISID=direct_concurrent_cookie') {
      if (process.send) process.send({ status: 'CLAIM_SUCCESS' });
      process.exit(0);
    } else {
      if (process.send) process.send({ status: 'CLAIM_CORRUPT' });
      process.exit(2);
    }
  } catch (err) {
    const reason = err.message.includes('replay') ? 'REPLAY_BLOCKED' : (err.message.includes('lock') ? 'LOCK_CONTENTION' : 'ERROR');
    if (process.send) process.send({ status: 'CLAIM_REJECTED', reason, error: err.message });
    process.exit(1);
  }
}

run().catch((err) => {
  if (process.send) process.send({ status: 'HANDSHAKE_FAILED', error: err.message });
  process.exit(1);
});
