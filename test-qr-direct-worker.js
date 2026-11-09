// test-qr-direct-worker.js - Independent secondary process testing direct two-channel PIN QR claim without HTTP server
const pcQr = require('./src/server/qr-session-transfer');
const fs = require('fs');

const [,, transferId, secretKey, directPayloadJson, pin, barrierFile] = process.argv;

async function run() {
  try {
    // If barrier file is specified, wait for barrier signal before claiming
    if (barrierFile) {
      const deadline = Date.now() + 5000;
      while (!fs.existsSync(barrierFile) && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 10));
      }
    }
    const directPayload = JSON.parse(directPayloadJson);
    const acc = await pcQr.claimRemoteTransferSession(null, transferId, secretKey, directPayload, pin);
    if (acc && (acc.cookie === 'SAPISID=direct_concurrent_cookie')) {
      process.exit(0);
    } else {
      process.exit(2);
    }
  } catch (err) {
    // Replay blocked, fail-closed or lock contention
    process.exit(1);
  }
}

run();
