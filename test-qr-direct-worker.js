// test-qr-direct-worker.js - Independent secondary process testing direct two-channel PIN QR claim without HTTP server
const pcQr = require('./src/server/qr-session-transfer');

const [,, transferId, secretKey, directPayloadJson, pin] = process.argv;

async function run() {
  try {
    const directPayload = JSON.parse(directPayloadJson);
    const acc = await pcQr.claimRemoteTransferSession(null, transferId, secretKey, directPayload, pin);
    if (acc && (acc.cookie === 'SAPISID=direct_concurrent_cookie')) {
      process.exit(0);
    } else {
      process.exit(2);
    }
  } catch (err) {
    // Replay blocked or lock contention
    process.exit(1);
  }
}

run();
