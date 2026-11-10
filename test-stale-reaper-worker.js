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
    } else if (msg.action === 'HOLD_EMPTY_ALIVE') {
      // Simulates process that created empty lock but got suspended / delayed (PID is still ALIVE)
      try {
        const reaperPath = `${targetLock}.reaper`;
        const fd = fs.openSync(reaperPath, 'wx');
        if (process.send) {
          process.send({ status: 'LOCKED', pid: process.pid });
        }
        // Keep process alive until explicitly released or terminated
        const timer = setInterval(() => {}, 1000);
        process.on('message', (m) => {
          if (m && m.action === 'RELEASE') {
            clearInterval(timer);
            try { fs.closeSync(fd); } catch (_) {}
            try { fs.unlinkSync(reaperPath); } catch (_) {}
            exitWith({ status: 'RELEASED', pid: process.pid }, 0);
          }
        });
      } catch (err) {
        exitWith({ status: 'ERROR', error: err.message, pid: process.pid }, 1);
      }
    } else if (msg.action === 'HOLD_REAPING_AND_DIE') {
      // Simulates reaper crash immediately after writing REAPING marker before unlinking
      try {
        const reaperPath = `${targetLock}.reaper`;
        const fd = fs.openSync(reaperPath, 'wx');
        fs.writeSync(fd, `REAPING:${process.pid}:${Date.now()}:crashed_reap_nonce`);
        try { fs.closeSync(fd); } catch (_) {}
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
    } else if (msg.action === 'CRASH_AT_STAGE') {
      // msg.stage: 1 (after open), 2 (after ftruncate), 3 (after write), 4 (after verify)
      try {
        const reaperPath = `${targetLock}.reaper`;
        const fd = fs.openSync(reaperPath, 'wx');
        if (msg.stage === 1) {
          // Crash after open FD
          process.exit(0);
        }
        fs.writeSync(fd, `${process.pid}:${Date.now()}:pre_stage`);
        if (msg.stage === 2) {
          fs.ftruncateSync(fd, 0);
          process.exit(0);
        }
        if (msg.stage === 3) {
          fs.ftruncateSync(fd, 0);
          fs.writeSync(fd, `REAPING:${process.pid}:${Date.now()}:stage3_nonce`);
          process.exit(0);
        }
        if (msg.stage === 4) {
          fs.ftruncateSync(fd, 0);
          fs.writeSync(fd, `REAPING:${process.pid}:${Date.now()}:stage4_nonce`);
          fs.fstatSync(fd);
          process.exit(0);
        }
      } catch (err) {
        exitWith({ status: 'ERROR', error: err.message, pid: process.pid }, 1);
      }
    } else if (msg.action === 'OS_LOCK_HOLD_AND_DIE') {
      (async () => {
        try {
          await qr.acquireOsLock(msg.lockKey || targetLock, 3000);
          if (process.send) {
            process.send({ status: 'LOCKED', pid: process.pid }, () => process.exit(0));
          } else {
            process.exit(0);
          }
        } catch (err) {
          exitWith({ status: 'ERROR', error: err.message, pid: process.pid }, 1);
        }
      })();
    } else if (msg.action === 'OS_LOCK_COMPETE') {
      (async () => {
        try {
          const lock = await qr.acquireOsLock(msg.lockKey || targetLock, 4000);
          const token = `${process.pid}:${Date.now()}:${Math.random()}`;
          if (process.send) process.send({ status: 'ENTERED', pid: process.pid, token });
          // Hold critical section briefly
          await new Promise(r => setTimeout(r, 40));
          if (process.send) process.send({ status: 'EXITED', pid: process.pid, token });
          lock.release();
          exitWith({ status: 'DONE', pid: process.pid, token }, 0);
        } catch (err) {
          exitWith({ status: 'ERROR', error: err.message, pid: process.pid }, 1);
        }
      })();
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
