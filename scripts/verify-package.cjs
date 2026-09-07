const { extractFile } = require('@electron/asar');
const { readFileSync, readdirSync } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const archive = process.argv[2] || 'release/win-unpacked/resources/app.asar';
function walk(dir) { return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]); }
for (const file of ['src', 'electron'].flatMap(walk)) assert.ok(extractFile(archive, file).equals(readFileSync(file)), `Packaged file differs: ${file}`);
const meta = JSON.parse(extractFile(archive, 'package.json'));
assert.equal(meta.productName, 'WiiUltraConnect');
assert.equal(meta.main, 'electron/main.cjs');
console.log(`Packaged application matches current source: ${path.resolve(archive)}`);
