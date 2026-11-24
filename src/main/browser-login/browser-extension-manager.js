/**
 * Eclipse Browser Extension Manager
 * Handles browser executable discovery, extension package export, archive validation,
 * and extension manager launching with dependency injection.
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
    processPlatform: injectedDeps.processPlatform || process.platform,
    env: injectedDeps.env || process.env,
    buildExtensionZip: injectedDeps.buildExtensionZip || (() => {
      try {
        const { buildExtensionZip } = require('../../scripts/build-extension');
        return buildExtensionZip();
      } catch (_) {
        return null;
      }
    })
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

    const tmpDir = deps.path.join(deps.os.tmpdir(), `eclipse-ext-verify-${Date.now()}-${Math.floor(Math.random() * 10000)}`);
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

      const appPath = deps.app && deps.app.getAppPath ? deps.app.getAppPath() : process.cwd();
      const resourcesPath = (deps.process && deps.process.resourcesPath) || process.resourcesPath || '';

      const candidates = [
        deps.path.join(resourcesPath, 'extension', 'eclipse-connect.zip'),
        deps.path.join(appPath, 'dist', 'extension', 'eclipse-connect.zip'),
        deps.path.join(__dirname, '..', '..', 'dist', 'extension', 'eclipse-connect.zip')
      ];

      let sourceZip = candidates.find(c => c && deps.fs.existsSync(c));
      if (!sourceZip) {
        // Lazy build fallback in dev environment
        try {
          sourceZip = deps.buildExtensionZip();
        } catch (_) {}
      }

      if (!sourceZip || !deps.fs.existsSync(sourceZip)) {
        return { success: false, error: 'Extension package (eclipse-connect.zip) not found' };
      }

      // Pre-export validation
      validateExtensionZipArchive(sourceZip);

      const defaultDownloadDir = deps.app && deps.app.getPath ? deps.app.getPath('downloads') : deps.os.tmpdir();
      const defaultSavePath = deps.path.join(defaultDownloadDir, 'eclipse-connect.zip');

      const saveResult = await deps.dialog.showSaveDialog(win, {
        title: 'Export Eclipse Connect Extension',
        defaultPath: defaultSavePath,
        filters: [{ name: 'ZIP Archive', extensions: ['zip'] }]
      });

      // Cancellation preserves any previously successful export path
      if (saveResult.canceled || !saveResult.filePath) {
        return { canceled: true };
      }

      const targetPath = saveResult.filePath;
      deps.fs.copyFileSync(sourceZip, targetPath);

      // Verify destination post-copy
      if (!deps.fs.existsSync(targetPath)) {
        return { success: false, error: 'Failed to verify exported extension: file does not exist after copy' };
      }

      const stat = deps.fs.statSync(targetPath);
      if (!stat.isFile()) {
        return { success: false, error: 'Failed to verify exported extension: destination is not a file' };
      }

      if (!targetPath.toLowerCase().endsWith('.zip')) {
        return { success: false, error: 'Failed to verify exported extension: destination must end in .zip' };
      }

      // Only update state after full verification succeeds
      lastExportedExtensionPath = targetPath;

      if (deps.shell && deps.shell.showItemInFolder) {
        deps.shell.showItemInFolder(targetPath);
      }

      return { success: true, filePath: targetPath };
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
    exportExtension,
    revealExportedExtension,
    getLastExportedExtensionPath,
    setLastExportedExtensionPath
  };
}

module.exports = {
  createBrowserExtensionManager
};
