// test-stale-reaper-worker.js — Independent process for concurrency regression tests on stale lock recovery
const fs = require('fs');
const path = require('path');

const [,, targetLock] = process.argv;

const qr = fs.existsSync(path.join(__dirname, 'src/server/qr-session-transfer.js'))
  ? require('./src/server/qr-session-transfer')
  : require('./qr-session-transfer');

function exitWith(msg, code) {
  if (process.send) {
    try {
      process.send(msg, () => process.exit(code));
      setTimeout(() => process.exit(code), 500).unref();
      return;
    } catch (_) {
      process.exit(code);
    }
  } else {
    process.exit(code);
  }
}

if (process.send) {
  process.send({ status: 'READY', pid: process.pid });
  process.on('message', (msg) => {
    if (!msg || !msg.action) return;

    if (msg.action === 'REAP') {
      try {
        const reaped = qr.breakStaleLock(targetLock);
        exitWith({ status: 'DONE', reaped, pid: process.pid }, 0);
      } catch (err) {
        exitWith({ status: 'ERROR', error: err.message, pid: process.pid }, 1);
      }
    } else if (msg.action === 'HOLD_REAPER_AND_DIE') {
      // Simulates sudden process crash while holding .reaper with written PID
      try {
        const reaperPath = `${targetLock}.reaper`;
        const fd = fs.openSync(reaperPath, 'wx');
        fs.writeSync(fd, `${process.pid}:${Date.now()}:reaper_crash_token`);
        // Notify parent lock is acquired, then crash immediately without unlinking in finally
        if (process.send) {
          process.send({ status: 'LOCKED', pid: process.pid }, () => {
            process.exit(0);
          });
        } else {
          process.exit(0);
        }
      } catch (err) {
        exitWith({ status: 'ERROR', error: err.message, pid: process.pid }, 1);
      }
    } else if (msg.action === 'HOLD_EMPTY_AND_DIE') {
      // Simulates sudden process crash right after openSync('wx') before writing token
      try {
        const reaperPath = `${targetLock}.reaper`;
        const fd = fs.openSync(reaperPath, 'wx');
        // Do not write anything (empty lock)
        if (process.send) {
          process.send({ status: 'LOCKED', pid: process.pid }, () => {
            process.exit(0);
          });
        } else {
          process.exit(0);
        }
      } catch (err) {
        exitWith({ status: 'ERROR', error: err.message, pid: process.pid }, 1);
      }
    }
  });
} else {
  // Direct CLI invocation fallback
  try {
    const reaped = qr.breakStaleLock(targetLock);
    process.exit(reaped ? 0 : 2);
  } catch (_) {
    process.exit(1);
  }
}
