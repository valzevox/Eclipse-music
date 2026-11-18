// d:\Eclipse\eclipse-pc\src\main\updater-logger.js
const fs = require('fs');
const path = require('path');

let logFilePath = null;

function initLogger(userDataPath) {
  try {
    const logsDir = path.join(userDataPath || process.cwd(), 'logs');
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    logFilePath = path.join(logsDir, 'eclipse-update.log');
    
    // Rotate log file if > 2MB
    if (fs.existsSync(logFilePath)) {
      const stat = fs.statSync(logFilePath);
      if (stat.size > 2 * 1024 * 1024) {
        const oldLog = path.join(logsDir, 'eclipse-update.old.log');
        try { fs.unlinkSync(oldLog); } catch (_) {}
        fs.renameSync(logFilePath, oldLog);
      }
    }
  } catch (err) {
    console.warn('[updater-logger] init failed:', err.message);
  }
}

function logStage(stage, message, data = null) {
  const ts = new Date().toISOString();
  const dataStr = data ? ' | ' + (typeof data === 'object' ? JSON.stringify(data) : String(data)) : '';
  const line = `[${ts}] [STAGE:${stage.toUpperCase()}] ${message}${dataStr}\n`;
  console.log(`[updater] [${stage}] ${message}`, data || '');

  if (logFilePath) {
    try {
      fs.appendFileSync(logFilePath, line, 'utf8');
    } catch (_) {}
  }
}

function getLogPath() {
  return logFilePath;
}

module.exports = {
  initLogger,
  logStage,
  getLogPath
};
