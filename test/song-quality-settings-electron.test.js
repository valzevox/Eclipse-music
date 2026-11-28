const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

test('Electron UI: Song quality setting persists across wait, Settings reopen, renderer reload, and transitions', async (t) => {
    let electronPath = null;
    try {
        electronPath = require('electron');
    } catch (_) {
        electronPath = null;
    }
    if (!electronPath || typeof electronPath !== 'string' || !fs.existsSync(electronPath)) {
        t.skip('Electron binary not available in this environment');
        return;
    }
    if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
        t.skip('Headless Linux CI without display server');
        return;
    }

    const repoRoot = path.resolve(__dirname, '..');
    const preloadPath = path.join(repoRoot, 'src', 'main', 'preload.js');
    const indexHtmlPath = path.join(repoRoot, 'src', 'renderer', 'index.html');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eclipse-song-quality-test-'));
    const userDataDir = path.join(tmpDir, 'userData');
    const appDataDir = path.join(tmpDir, 'appData');
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.mkdirSync(appDataDir, { recursive: true });

    const storageFile = path.join(userDataDir, 'storage.json');
    fs.writeFileSync(storageFile, JSON.stringify({ eclipse_audio_quality: 'medium' }, null, 2), 'utf8');

    const mainScript = path.join(tmpDir, 'main.js');
    fs.writeFileSync(mainScript, `
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, session } = require('electron');

const USER_DATA_DIR = ${JSON.stringify(userDataDir)};
const APP_DATA_DIR = ${JSON.stringify(appDataDir)};
const STORAGE_FILE = ${JSON.stringify(storageFile)};
const PRELOAD_PATH = ${JSON.stringify(preloadPath)};
const INDEX_HTML_PATH = ${JSON.stringify(indexHtmlPath)};

app.setPath('userData', USER_DATA_DIR);
app.setPath('appData', APP_DATA_DIR);
app.commandLine.appendSwitch('mute-audio');

let storageFlushTimer = null;
let latestStorageSnapshot = null;
let storageDirty = false;

function readStorageDiskSync() {
    try {
        if (fs.existsSync(STORAGE_FILE)) {
            const raw = fs.readFileSync(STORAGE_FILE, 'utf8').trim();
            if (raw) {
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed === 'object') return parsed;
            }
        }
    } catch (_) {}
    return {};
}

function writeStorageDiskSync(data) {
    if (!data || typeof data !== 'object') return;
    const tmpFile = STORAGE_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmpFile, STORAGE_FILE);
}

ipcMain.on('get-server-token-sync', (event) => { event.returnValue = 'test-token'; });
ipcMain.on('get-i18n-dict-sync', (event) => { event.returnValue = {}; });
ipcMain.on('storage-get-all-sync', (event) => {
    event.returnValue = latestStorageSnapshot || readStorageDiskSync();
});
ipcMain.on('storage-save-batch', (_event, data) => {
    if (!data || typeof data !== 'object') return;
    latestStorageSnapshot = data;
    storageDirty = true;
    if (storageFlushTimer) clearTimeout(storageFlushTimer);
    storageFlushTimer = setTimeout(() => {
        storageFlushTimer = null;
        storageDirty = false;
        writeStorageDiskSync(latestStorageSnapshot);
    }, 250);
});
ipcMain.on('storage-save-sync', (event, data) => {
    if (storageFlushTimer) { clearTimeout(storageFlushTimer); storageFlushTimer = null; }
    if (data && typeof data === 'object') {
        latestStorageSnapshot = data;
        storageDirty = false;
        writeStorageDiskSync(latestStorageSnapshot);
    }
    event.returnValue = true;
});

const noopInvokeHandlers = {
    'get-server-port': 0,
    'get-server-token': 'test-token',
    'get-app-version': '0.0.0-test',
    'get-cache-size': 0,
    'get-data-dir': USER_DATA_DIR,
    'get-download-dir': USER_DATA_DIR,
    'get-multi-instance': false,
    'get-gpu-compositing': true,
    'get-audio-output-info': {},
    'discord-rpc-get-enabled': false,
    'discord-rpc-get-connected': false,
    'discord-rpc-get-client-id': '',
    'google-auth-status': { connected: false },
    'external-session:get-status': { connected: false },
    'external-session:get-profiles': [],
    'browser-login:get-profiles': [],
    'themes-list': [],
    'plugins-list': [],
    'launcher-info': { installed: false },
    'get-i18n-dict': {},
    'library-db:load-all': { albums: [], playlists: [], favorites: [] },
    'library-db:get-history': [],
    'library-db:save-albums': true,
    'library-db:save-playlists': true,
    'library-db:save-favorites': true,
    'update-check': null,
};
for (const [ch, val] of Object.entries(noopInvokeHandlers)) {
    ipcMain.handle(ch, async () => val);
}

function waitForLoad(win) {
    return new Promise((resolve) => {
        win.webContents.once('did-finish-load', () => resolve());
    });
}

async function run() {
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
        if (details.url.startsWith('file://') || details.url.startsWith('data:') || details.url.startsWith('blob:')) {
            callback({ cancel: false });
        } else {
            callback({ cancel: true });
        }
    });

    const win = new BrowserWindow({
        show: false,
        width: 1280,
        height: 800,
        webPreferences: {
            preload: PRELOAD_PATH,
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    win.webContents.on('did-fail-load', (_e, code, desc, url) => {
        process.stderr.write('did-fail-load: ' + code + ' ' + desc + ' ' + url + '\\n');
    });

    await win.loadFile(INDEX_HTML_PATH);

    const exec = (fnStr) => win.webContents.executeJavaScript('(' + fnStr + ')()', true);

    const assertState = async (expectedVal, expectedLabel, stepName) => {
        const state = await exec(() => {
            const label = document.getElementById('label-song-quality');
            const menu = document.getElementById('menu-song-quality');
            const selected = menu ? Array.from(menu.querySelectorAll('.m3-dropdown-option.selected')).map(o => o.dataset.val) : [];
            return {
                labelText: label ? label.textContent.trim() : null,
                selected,
                lsVal: localStorage.getItem('eclipse_audio_quality'),
            };
        });
        if (state.labelText !== expectedLabel || state.selected.length !== 1 || state.selected[0] !== expectedVal || state.lsVal !== expectedVal) {
            throw new Error(stepName + ' mismatch: expected (' + expectedVal + '/' + expectedLabel + '), got ' + JSON.stringify(state));
        }
    };

    const openSettingsAdvanced = async () => {
        await exec(() => {
            const navSettings = document.getElementById('nav-settings');
            if (!navSettings) throw new Error('Missing #nav-settings');
            navSettings.click();
            const advBtn = document.querySelector('#settings-nav .settings-nav-btn[data-cat="advanced"]');
            if (advBtn) advBtn.click();
        });
    };

    const closeSettings = async () => {
        await exec(() => {
            const navDiscover = document.getElementById('nav-discover');
            if (!navDiscover) throw new Error('Missing #nav-discover');
            navDiscover.click();
        });
    };

    const selectQuality = async (val) => {
        await exec(\`() => {
            const drop = document.getElementById('dropdown-song-quality');
            const trigger = document.getElementById('btn-song-quality-trigger');
            const menu = document.getElementById('menu-song-quality');
            if (!drop || !trigger || !menu) throw new Error('Missing song quality dropdown elements');
            trigger.click();
            if (!drop.classList.contains('open')) throw new Error('Dropdown did not open on trigger click');
            const opt = menu.querySelector('.m3-dropdown-option[data-val="\${val}"]');
            if (!opt) throw new Error('Missing option for ' + '\${val}');
            opt.click();
        }\`);
    };

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // 1. Start with Medium
    await openSettingsAdvanced();
    await assertState('medium', 'Medium', 'Step 1 (initial Medium)');

    // 2-6. Test High
    await selectQuality('high');
    await assertState('high', 'High', 'Step 3 (click High)');
    await sleep(350);
    await assertState('high', 'High', 'Step 4 (after >=300ms wait for High)');
    await closeSettings();
    await openSettingsAdvanced();
    await assertState('high', 'High', 'Step 5 (reopen Settings for High)');

    const reloadHigh = waitForLoad(win);
    win.webContents.reload();
    await reloadHigh;
    await openSettingsAdvanced();
    await assertState('high', 'High', 'Step 6 (after renderer reload for High)');

    // 7. Repeat complete test for Max
    await selectQuality('max');
    await assertState('max', 'Max', 'Step 7a (click Max)');
    await sleep(350);
    await assertState('max', 'Max', 'Step 7b (after >=300ms wait for Max)');
    await closeSettings();
    await openSettingsAdvanced();
    await assertState('max', 'Max', 'Step 7c (reopen Settings for Max)');

    const reloadMax = waitForLoad(win);
    win.webContents.reload();
    await reloadMax;
    await openSettingsAdvanced();
    await assertState('max', 'Max', 'Step 7d (after renderer reload for Max)');

    // 8. Switch Max -> High -> Medium -> Max and verify every transition
    await selectQuality('high');
    await assertState('high', 'High', 'Step 8a (Max -> High)');
    await selectQuality('medium');
    await assertState('medium', 'Medium', 'Step 8b (High -> Medium)');
    await selectQuality('max');
    await assertState('max', 'Max', 'Step 8c (Medium -> Max)');

    await sleep(350);
    const diskData = readStorageDiskSync();
    if (diskData.eclipse_audio_quality !== 'max') {
        throw new Error('Disk storage.json mismatch: expected max, got ' + JSON.stringify(diskData.eclipse_audio_quality));
    }

    process.stdout.write('ECLIPSE_SONG_QUALITY_PASS\\n');
    app.exit(0);
}

app.whenReady().then(() => {
    run().catch((err) => {
        process.stderr.write((err && err.stack ? err.stack : String(err)) + '\\n');
        app.exit(1);
    });
});

setTimeout(() => {
    process.stderr.write('ECLIPSE_SONG_QUALITY_TIMEOUT\\n');
    app.exit(2);
}, 25000);
`);

    try {
        const result = await new Promise((resolve, reject) => {
            const child = spawn(electronPath, [mainScript], {
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
            });
            let stdout = '';
            let stderr = '';
            child.stdout.on('data', (d) => { stdout += d.toString(); });
            child.stderr.on('data', (d) => { stderr += d.toString(); });
            child.on('error', reject);
            child.on('close', (code) => resolve({ code, stdout, stderr }));
        });

        assert.equal(
            result.code,
            0,
            `Electron song quality test failed (code=${result.code}): stdout=${result.stdout} stderr=${result.stderr}`
        );
        assert.ok(
            result.stdout.includes('ECLIPSE_SONG_QUALITY_PASS'),
            `Expected ECLIPSE_SONG_QUALITY_PASS marker, got: ${result.stdout}`
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});
