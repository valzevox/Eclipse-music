/**
 * Eclipse Browser Extension Manager
 * Handles browser executable discovery, transactional extension package export,
 * archive validation, and extension manager launching with dependency injection.
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn, execFileSync } = require('child_process');
const { dialog, shell, app, BrowserWindow } = require('electron');

function createBrowserExtensionManager(injectedDeps = {}) {
  const deps = {
    fs: injectedDeps.fs || fs,
    path: injectedDeps.path || path,
    os: injectedDeps.os || os,
    spawn: injectedDeps.spawn || spawn,
    execFileSync: injectedDeps.execFileSync || execFileSync,
    dialog: injectedDeps.dialog || dialog,
    shell: injectedDeps.shell || shell,
    app: injectedDeps.app || app,
    BrowserWindow: injectedDeps.BrowserWindow || BrowserWindow,
    getExtensionZipPath: injectedDeps.getExtensionZipPath || (() => null),
    processPlatform: injectedDeps.processPlatform || process.platform,
    env: injectedDeps.env || process.env
  };

  let lastExportedExtensionPath = null;

  function resolveBrowserExecutable(browser) {
    const norm = String(browser || '').toLowerCase().trim();
    const defs = {
      chrome: {
        regName: 'chrome.exe',
        extUrl: 'chrome://extensions',
        paths: [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          deps.path.join(deps.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe')
        ]
      },
      edge: {
        regName: 'msedge.exe',
        extUrl: 'edge://extensions',
        paths: [
          'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
          'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
          deps.path.join(deps.env.LOCALAPPDATA || '', 'Microsoft\\Edge\\Application\\msedge.exe')
        ]
      },
      brave: {
        regName: 'brave.exe',
        extUrl: 'brave://extensions',
        paths: [
          'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
          'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
          deps.path.join(deps.env.LOCALAPPDATA || '', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe')
        ]
      }
    };

    const target = defs[norm];
    if (!target) return null;

    if (deps.processPlatform === 'win32') {
      for (const p of target.paths) {
        if (p && deps.fs.existsSync(p)) return { exe: p, extUrl: target.extUrl };
      }

      const queryReg = (key) => {
        try {
          const stdout = deps.execFileSync('reg', ['query', key, '/ve'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            windowsHide: true
          });
          const match = stdout.match(/REG_SZ\s+(.*)/i);
          if (match && match[1]) {
            let val = match[1].trim();
            if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
            return val;
          }
        } catch (_) {}
        return null;
      };

      const hkcu = queryReg(`HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${target.regName}`);
      if (hkcu && deps.fs.existsSync(hkcu)) return { exe: hkcu, extUrl: target.extUrl };

      const hklm = queryReg(`HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${target.regName}`);
      if (hklm && deps.fs.existsSync(hklm)) return { exe: hklm, extUrl: target.extUrl };
    }

    return null;
  }

  function validateExtensionZipArchive(zipPath) {
    if (!deps.fs.existsSync(zipPath)) {
      throw new Error(`Extension package not found at: ${zipPath}`);
    }

    const tmpDir = deps.path.join(deps.os.tmpdir(), `eclipse-ext-verify-${Date.now()}-${Math.floor(Math.random() * 100000)}`);
    deps.fs.mkdirSync(tmpDir, { recursive: true });
    try {
      if (deps.processPlatform === 'win32') {
        deps.execFileSync('tar.exe', ['-xf', zipPath, '-C', tmpDir], { windowsHide: true });
      } else {
        deps.execFileSync('unzip', ['-q', zipPath, '-d', tmpDir]);
      }
      const manifestPath = deps.path.join(tmpDir, 'manifest.json');
      if (!deps.fs.existsSync(manifestPath)) {
        throw new Error('manifest.json missing inside extension archive');
      }
      // Guard against zip-slip: verify manifest path resolves inside tmpDir
      const relative = deps.path.relative(tmpDir, manifestPath);
      if (relative.startsWith('..') || deps.path.isAbsolute(relative)) {
        throw new Error('Path traversal detected in extension archive');
      }
      const manifest = JSON.parse(deps.fs.readFileSync(manifestPath, 'utf8'));
      if (!manifest || manifest.manifest_version !== 3) {
        throw new Error('Invalid manifest.json in extension archive (must be Manifest V3)');
      }
      return { valid: true, manifest };
    } catch (err) {
      throw new Error(`Extension archive validation failed: ${err.message}`);
    } finally {
      try { deps.fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
  }

  async function openExtensionManager(browser) {
    try {
      const validBrowsers = ['chrome', 'edge', 'brave'];
      const norm = String(browser || '').toLowerCase().trim();
      if (!validBrowsers.includes(norm)) {
        return { success: false, error: `Invalid browser: ${browser}. Supported: chrome, edge, brave.` };
      }

      const resolved = resolveBrowserExecutable(norm);
      if (!resolved || !resolved.exe) {
        return { success: false, error: `Browser executable not found for ${norm}.` };
      }

      return await new Promise((resolve) => {
        let settled = false;
        let child;
        try {
          child = deps.spawn(resolved.exe, [resolved.extUrl], {
            shell: false,
            detached: true,
            stdio: 'ignore',
            windowsHide: true
          });
        } catch (err) {
          return resolve({ success: false, error: err.message });
        }

        child.once('spawn', () => {
          if (!settled) {
            settled = true;
            try { child.unref(); } catch (_) {}
            resolve({ success: true });
          }
        });

        child.once('error', (err) => {
          if (!settled) {
            settled = true;
            resolve({ success: false, error: err.message });
          }
        });
      });
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async function exportExtension(event, mainWindow) {
    try {
      let win = null;
      if (deps.BrowserWindow && event && event.sender && deps.BrowserWindow.fromWebContents) {
        win = deps.BrowserWindow.fromWebContents(event.sender);
      }
      if (!win) win = mainWindow;

      // 1. Explicitly resolve bundled source ZIP path
      const sourceZip = typeof deps.getExtensionZipPath === 'function' ? deps.getExtensionZipPath() : null;
      if (!sourceZip || !deps.fs.existsSync(sourceZip)) {
        return { success: false, error: 'Extension package (eclipse-connect.zip) not found' };
      }

      // 2. Validate bundled source ZIP archive
      validateExtensionZipArchive(sourceZip);

      const defaultDownloadDir = deps.app && deps.app.getPath ? deps.app.getPath('downloads') : deps.os.tmpdir();
      const defaultSavePath = deps.path.join(defaultDownloadDir, 'eclipse-connect.zip');

      // 3. Show native Save Dialog
      const saveResult = await deps.dialog.showSaveDialog(win, {
        title: 'Export Eclipse Connect Extension',
        defaultPath: defaultSavePath,
        filters: [{ name: 'ZIP Archive', extensions: ['zip'] }]
      });

      // Cancellation preserves previous lastExportedExtensionPath
      if (saveResult.canceled || !saveResult.filePath) {
        return { canceled: true };
      }

      const destinationPath = saveResult.filePath;
      if (!destinationPath.toLowerCase().endsWith('.zip')) {
        return { success: false, error: 'Destination path must have a .zip extension' };
      }

      // 4. Transactional export: write to a temp file in destination directory
      const destDir = deps.path.dirname(destinationPath);
      const tempFileName = `.eclipse-ext-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp.zip`;
      const tempFilePath = deps.path.join(destDir, tempFileName);

      let backupFilePath = null;
      try {
        deps.fs.copyFileSync(sourceZip, tempFilePath);

        // Verify temp file existence, file type, extension, and archive integrity
        if (!deps.fs.existsSync(tempFilePath)) {
          throw new Error('Temporary export file was not created');
        }
        const tempStat = deps.fs.statSync(tempFilePath);
        if (!tempStat.isFile()) {
          throw new Error('Temporary export path is not a file');
        }
        validateExtensionZipArchive(tempFilePath);

        // Atomic replacement with rollback strategy
        const destExists = deps.fs.existsSync(destinationPath);
        if (destExists) {
          backupFilePath = deps.path.join(destDir, `.eclipse-dest-backup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`);
          deps.fs.renameSync(destinationPath, backupFilePath);
        }

        try {
          deps.fs.renameSync(tempFilePath, destinationPath);
        } catch (renameErr) {
          // Rollback destination from backup if rename failed
          if (backupFilePath && deps.fs.existsSync(backupFilePath)) {
            try { deps.fs.renameSync(backupFilePath, destinationPath); } catch (_) {}
          }
          throw renameErr;
        }

        // Clean up backup file upon successful replacement
        if (backupFilePath && deps.fs.existsSync(backupFilePath)) {
          try { deps.fs.unlinkSync(backupFilePath); } catch (_) {}
        }
      } catch (transErr) {
        // Clean up any remaining temp files on error
        if (deps.fs.existsSync(tempFilePath)) {
          try { deps.fs.unlinkSync(tempFilePath); } catch (_) {}
        }
        if (backupFilePath && deps.fs.existsSync(backupFilePath) && !deps.fs.existsSync(destinationPath)) {
          try { deps.fs.renameSync(backupFilePath, destinationPath); } catch (_) {}
        }
        return { success: false, error: `Failed to export extension: ${transErr.message}` };
      }

      // 5. Update state and reveal only after replacement succeeds
      lastExportedExtensionPath = destinationPath;

      if (deps.shell && deps.shell.showItemInFolder) {
        deps.shell.showItemInFolder(destinationPath);
      }

      return { success: true, filePath: destinationPath };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async function revealExportedExtension() {
    try {
      if (!lastExportedExtensionPath) {
        return { success: false, error: 'No exported extension found. Please download the extension first.' };
      }
      if (!deps.fs.existsSync(lastExportedExtensionPath)) {
        return { success: false, error: 'Exported extension file no longer exists. Please download it again.' };
      }
      const stat = deps.fs.statSync(lastExportedExtensionPath);
      if (!stat.isFile()) {
        return { success: false, error: 'Exported path is not a file.' };
      }
      if (!lastExportedExtensionPath.toLowerCase().endsWith('.zip')) {
        return { success: false, error: 'Exported path is not a valid zip archive.' };
      }
      if (deps.shell && deps.shell.showItemInFolder) {
        deps.shell.showItemInFolder(lastExportedExtensionPath);
      }
      return { success: true, filePath: lastExportedExtensionPath };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  function getLastExportedExtensionPath() {
    return lastExportedExtensionPath;
  }

  function setLastExportedExtensionPath(newPath) {
    lastExportedExtensionPath = newPath;
  }

  return {
    resolveBrowserExecutable,
    validateExtensionZipArchive,
    openExtensionManager,
    launchBrowserExtensionManager: openExtensionManager,
    exportExtension,
    exportExtensionPackage: exportExtension,
    revealExportedExtension,
    getLastExportedExtensionPath,
    setLastExportedExtensionPath
  };
}

module.exports = {
  createBrowserExtensionManager
};
