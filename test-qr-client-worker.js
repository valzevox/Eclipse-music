// test-qr-client-worker.js — Independent secondary process testing cross-process QR session claim
const pcQr = require('./src/server/qr-session-transfer');

const [,, serverUrl, transferId, secretKey] = process.argv;

async function run() {
  try {
    const acc = await pcQr.claimRemoteTransferSession(serverUrl, transferId, secretKey);
    if (acc && acc.cookie === 'SAPISID=multi_process_secret') {
      process.exit(0);
    } else {
      process.exit(2);
    }
  } catch (err) {
    console.error('Worker claim error:', err.message);
    process.exit(1);
  }
}

run();
