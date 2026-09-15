const { extractFile, listPackage } = require('@electron/asar');
const { readFileSync, readdirSync } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const archive = process.argv[2] || 'release/win-unpacked/resources/app.asar';
function walk(dir) { return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]); }
for (const file of ['src', 'electron'].flatMap(walk)) assert.ok(extractFile(archive, file).equals(readFileSync(file)), `Packaged file differs: ${file}`);
const meta = JSON.parse(extractFile(archive, 'package.json'));
assert.equal(meta.productName, 'WiiUltraConnect');
assert.equal(meta.version, JSON.parse(readFileSync('package.json')).version);
assert.equal(meta.main, 'electron/main.cjs');
assert.equal(meta.dependencies?.ws, undefined);
assert.ok(!listPackage(archive).some(file => /^\/(server|scripts|tests)\//.test(file)), 'Server or test-only code must not ship');
console.log(`Packaged application matches current source: ${path.resolve(archive)}`);
