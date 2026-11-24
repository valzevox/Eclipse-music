'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { BrowserProfileStatus } = require('./browser-login-errors');

function getGeckoBaseDirs() {
  const dirs = [];
  const platform = process.platform;
  const home = os.homedir();

  if (platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    dirs.push({ browser: 'Firefox', type: 'gecko', base: path.join(appData, 'Mozilla', 'Firefox') });
    dirs.push({ browser: 'Zen', type: 'gecko', base: path.join(appData, 'zen') });
    dirs.push({ browser: 'LibreWolf', type: 'gecko', base: path.join(appData, 'librewolf') });
  } else if (platform === 'darwin') {
    const appSupport = path.join(home, 'Library', 'Application Support');
    dirs.push({ browser: 'Firefox', type: 'gecko', base: path.join(appSupport, 'Firefox') });
    dirs.push({ browser: 'Zen', type: 'gecko', base: path.join(appSupport, 'zen') });
    dirs.push({ browser: 'LibreWolf', type: 'gecko', base: path.join(appSupport, 'librewolf') });
  } else {
    dirs.push({ browser: 'Firefox', type: 'gecko', base: path.join(home, '.mozilla', 'firefox') });
    dirs.push({ browser: 'Zen', type: 'gecko', base: path.join(home, '.zen') });
    dirs.push({ browser: 'LibreWolf', type: 'gecko', base: path.join(home, '.librewolf') });
  }

  return dirs;
}

function getChromiumInstallations() {
  const list = [];
  const platform = process.platform;
  const home = os.homedir();

  if (platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    list.push({ browser: 'Microsoft Edge', type: 'chromium', dir: path.join(local, 'Microsoft', 'Edge', 'User Data') });
    list.push({ browser: 'Google Chrome', type: 'chromium', dir: path.join(local, 'Google', 'Chrome', 'User Data') });
    list.push({ browser: 'Brave Browser', type: 'chromium', dir: path.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data') });
  } else if (platform === 'darwin') {
    const appSupport = path.join(home, 'Library', 'Application Support');
    list.push({ browser: 'Microsoft Edge', type: 'chromium', dir: path.join(appSupport, 'Microsoft Edge') });
    list.push({ browser: 'Google Chrome', type: 'chromium', dir: path.join(appSupport, 'Google', 'Chrome') });
    list.push({ browser: 'Brave Browser', type: 'chromium', dir: path.join(appSupport, 'BraveSoftware', 'Brave-Browser') });
  } else {
    const config = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
    list.push({ browser: 'Microsoft Edge', type: 'chromium', dir: path.join(config, 'microsoft-edge') });
    list.push({ browser: 'Google Chrome', type: 'chromium', dir: path.join(config, 'google-chrome') });
    list.push({ browser: 'Brave Browser', type: 'chromium', dir: path.join(config, 'BraveSoftware', 'Brave-Browser') });
  }

  return list;
}

function parseProfilesIni(iniPath, browserBaseDir) {
  if (!fs.existsSync(iniPath)) return [];
  try {
    const content = fs.readFileSync(iniPath, 'utf8');
    const lines = content.split(/\r?\n/);
    const profiles = [];
    let current = null;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#') || line.startsWith(';')) continue;
      if (line.startsWith('[') && line.endsWith(']')) {
        if (current && current.Path) profiles.push(current);
        current = { section: line.slice(1, -1) };
        continue;
      }
      if (!current) continue;
      const idx = line.indexOf('=');
      if (idx > 0) {
        const k = line.slice(0, idx).trim();
        const v = line.slice(idx + 1).trim();
        current[k] = v;
      }
    }
    if (current && current.Path) profiles.push(current);

    return profiles.filter(p => p.section.toLowerCase().startsWith('profile')).map(p => {
      const isRelative = p.IsRelative === '1';
      const fullPath = isRelative ? path.join(browserBaseDir, p.Path) : path.resolve(p.Path);
      return {
        name: p.Name || path.basename(fullPath),
        path: fullPath,
        isDefault: p.Default === '1'
      };
    });
  } catch (_) {
    return [];
  }
}

async function discoverBrowserProfiles() {
  const discovered = [];

  // 1. Gecko-based browsers (Firefox, Zen, LibreWolf)
  const geckoBases = getGeckoBaseDirs();
  for (const b of geckoBases) {
    if (!fs.existsSync(b.base)) continue;
    const iniPath = path.join(b.base, 'profiles.ini');
    const profiles = parseProfilesIni(iniPath, b.base);

    for (const p of profiles) {
      const cookiesSqlite = path.join(p.path, 'cookies.sqlite');
      let status = BrowserProfileStatus.NO_COOKIES;
      if (fs.existsSync(cookiesSqlite)) {
        try {
          fs.accessSync(cookiesSqlite, fs.constants.R_OK);
          status = BrowserProfileStatus.COOKIES_FOUND;
        } catch (_) {
          status = BrowserProfileStatus.PERMISSION_REQUIRED;
        }
      }

      discovered.push({
        id: `gecko:${b.browser.toLowerCase()}:${path.basename(p.path)}`,
        browser: b.browser,
        type: 'gecko',
        profileName: p.name,
        profilePath: p.path,
        cookiesPath: cookiesSqlite,
        isDefault: !!p.isDefault,
        status
      });
    }
  }

  // 2. Chromium-based browsers (Edge, Chrome, Brave)
  // Exposed for Eclipse Extension Pairing Flow
  const chromiumInstalls = getChromiumInstallations();
  for (const c of chromiumInstalls) {
    if (!fs.existsSync(c.dir)) continue;
    // Check if profiles exist (e.g. Default, Profile 1, etc.)
    try {
      const entries = fs.readdirSync(c.dir);
      const profileDirs = entries.filter(e => e === 'Default' || /^Profile \d+$/i.test(e));
      if (profileDirs.length === 0) {
        profileDirs.push('Default');
      }

      for (const pName of profileDirs) {
        discovered.push({
          id: `chromium:${c.browser.toLowerCase().replace(/\s+/g, '_')}:${pName.toLowerCase().replace(/\s+/g, '_')}`,
          browser: c.browser,
          type: 'chromium',
          profileName: pName,
          profilePath: path.join(c.dir, pName),
          status: BrowserProfileStatus.COOKIES_FOUND,
          requiresExtension: true
        });
      }
    } catch (_) {}
  }

  return discovered;
}

module.exports = {
  getGeckoBaseDirs,
  getChromiumInstallations,
  parseProfilesIni,
  discoverBrowserProfiles
};
