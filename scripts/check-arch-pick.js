// d:\Eclipse\eclipse-pc\scripts\check-arch-pick.js
// node scripts/check-arch-pick.js — asserts latest.yml files[] parsing + per-arch installer selection.
const assert = require('assert');
const { parseLatestYml, findMatchingAsset } = require('../src/main/updater-core');

const yml = `version: 1.4.22
files:
  - url: eclipse-1.4.22-win.exe
    sha512: UNIV==
    size: 284182111
  - url: eclipse-1.4.22-win-ia32.exe
    sha512: IA32==
    size: 135944638
  - url: eclipse-1.4.22-win-x64.exe
    sha512: X64==
    size: 148818310
path: eclipse-1.4.22-win.exe
sha512: UNIV==
`;
const p = parseLatestYml(yml.replace(/\n/g, '\r\n').replace(/\r\n/g, '\n'));
assert.strictEqual(p.files.length, 3);
assert.strictEqual(findMatchingAsset(p.files, 'win32', 'x64').name, 'eclipse-1.4.22-win-x64.exe');
assert.strictEqual(findMatchingAsset(p.files, 'win32', 'x64').sha512, 'X64==');
assert.strictEqual(findMatchingAsset(p.files, 'win32', 'ia32').name, 'eclipse-1.4.22-win-ia32.exe');
assert.strictEqual(parseLatestYml(yml.replace(/\n/g, '\r\n')).files.length, 3, 'CRLF yml');
console.log('arch pick OK');
