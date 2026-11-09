// test-qr-direct-worker.js - Independent secondary process testing direct two-channel PIN QR claim via IPC handshake
const pcQr = require('./src/server/qr-session-transfer');

const [,, transferId, secretKey, directPayloadJson, pin] = process.argv;

function exitWith(msg, code) {
  if (process.send) {
    try {
      process.send(msg, () => {
        process.exit(code);
      });
      setTimeout(() => process.exit(code), 500).unref();
      return;
    } catch (_) {
      process.exit(code);
    }
  } else {
    process.exit(code);
  }
}

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
      exitWith({ status: 'CLAIM_SUCCESS' }, 0);
    } else {
      exitWith({ status: 'CLAIM_CORRUPT' }, 2);
    }
  } catch (err) {
    const reason = err.message.includes('replay') ? 'REPLAY_BLOCKED' : (err.message.includes('lock') ? 'LOCK_CONTENTION' : 'ERROR');
    exitWith({ status: 'CLAIM_REJECTED', reason, error: err.message }, 1);
  }
}

run().catch((err) => {
  exitWith({ status: 'HANDSHAKE_FAILED', error: err.message }, 1);
});
