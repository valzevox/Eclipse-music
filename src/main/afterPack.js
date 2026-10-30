const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

module.exports = async function (context) {
  if (context.electronPlatformName !== 'win32') return;
  const exePath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  const icoPath = path.resolve(__dirname, '../../assets/icon.ico');
  const rcedit = path.resolve(__dirname, '../../node_modules/electron-winstaller/vendor/rcedit.exe');
  if (!fs.existsSync(exePath) || !fs.existsSync(icoPath) || !fs.existsSync(rcedit)) return;

  const tmpExe = path.join(os.tmpdir(), `eclipse_rcedit_${Date.now()}.exe`);
  fs.copyFileSync(exePath, tmpExe);
  try {
    execFileSync(rcedit, [tmpExe, '--set-icon', icoPath]);
  } catch (e) {
    try { fs.unlinkSync(tmpExe); } catch (_) {}
    return;
  }

  // Retry copy back with backoff to prevent antivirus / signtool locks
  let copied = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.copyFileSync(tmpExe, exePath);
      copied = true;
      break;
    } catch (err) {
      if (attempt < 4) {
        await new Promise(r => setTimeout(r, 600));
      }
    }
  }
  try { fs.unlinkSync(tmpExe); } catch (_) {}
};
