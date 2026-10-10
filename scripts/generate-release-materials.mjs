import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { extractFile, listPackage } = require('@electron/asar');

const args = process.argv.slice(2);
function values(name) { return args.flatMap((value, index) => value === name && args[index + 1] ? [args[index + 1]] : []); }
function value(name) { return values(name)[0]; }
function walk(directory) { return readdirSync(directory, { withFileTypes: true }).flatMap(entry => { const item = path.join(directory, entry.name); return entry.isDirectory() ? walk(item) : [item]; }); }
function packageInfo(packagePath) {
  try { return JSON.parse(readFileSync(packagePath, 'utf8')); } catch { return {}; }
}
function packageLocation(archivePath) {
  const parts = archivePath.split('/').filter(Boolean);
  const index = parts.lastIndexOf('node_modules');
  if (index === -1 || !parts.at(-1)?.endsWith('.json')) return undefined;
  const first = parts[index + 1];
  if (!first) return undefined;
  const segmentCount = first.startsWith('@') ? 2 : 1;
  if (parts.length < index + 1 + segmentCount + 1) return undefined;
  return parts.slice(index, index + 1 + segmentCount).join('/');
}
function packagedComponents(inputs, lock) {
  const archives = inputs.flatMap(input => walk(input).filter(file => path.basename(file) === 'app.asar'));
  assert.ok(archives.length, 'No unpacked Electron app.asar was found in the input release directories. Build and inspect the target before generating release materials.');
  const components = new Map();
  for (const archive of archives) {
    for (const file of listPackage(archive).filter(candidate => candidate.endsWith('/package.json'))) {
      const location = packageLocation(file);
      if (!location || components.has(location)) continue;
      try {
        // Files marked as unpacked are read from app.asar.unpacked. This also
        // excludes native platform directories that after-pack pruning removed.
        const manifest = JSON.parse(extractFile(archive, file.replace(/^\//, '')));
        const entry = lock.packages?.[location] || {};
        if (!manifest.name || !manifest.version) continue;
        components.set(location, { name: manifest.name, version: manifest.version, license: manifest.license || 'NOASSERTION', integrity: entry.integrity || 'NOASSERTION' });
      } catch {
        // A pruned asar-unpacked entry is deliberately not in the final app.
      }
    }
  }
  return [...components.values()].sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
}
function npmPurl(name, version) {
  const parts = name.split('/');
  const encodedName = name.startsWith('@')
    ? `%40${encodeURIComponent(parts[0].slice(1))}/${encodeURIComponent(parts[1])}`
    : encodeURIComponent(name);
  return `pkg:npm/${encodedName}@${encodeURIComponent(version)}`;
}

const inputs = values('--input').map(input => path.resolve(input));
const output = path.resolve(value('--output') || 'release/materials');
const timestamp = process.env.SOURCE_DATE_EPOCH ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString() : new Date().toISOString();
if (process.env.SOURCE_DATE_EPOCH) assert.ok(!Number.isNaN(Date.parse(timestamp)), 'SOURCE_DATE_EPOCH must be a Unix-seconds timestamp.');
assert.ok(inputs.length > 0, 'Specify one or more --input release directories.');
const artifactFiles = inputs.flatMap(input => {
  assert.ok(existsSync(input), `Input does not exist: ${input}`);
  return walk(input).filter(file => /\.(exe|dmg|zip|deb)$/i.test(file));
}).sort();
assert.ok(artifactFiles.length, 'No installer artifacts found.');
mkdirSync(output, { recursive: true });

const checksums = artifactFiles.map(file => `${createHash('sha256').update(readFileSync(file)).digest('hex')}  ${path.relative(process.cwd(), file)}`);
writeFileSync(path.join(output, 'SHA256SUMS'), `${checksums.join('\n')}\n`);

const lock = packageInfo('package-lock.json');
const packages = packagedComponents(inputs, lock);

const notices = [
  '# WiiUltraConnect third-party notices',
  '',
  `Generated from the packaged Electron application archives. ${packages.length} npm packages are present in at least one supplied runtime. License identifiers are supplied by each packaged manifest; NOASSERTION means the package did not declare one locally.`,
  '',
  '| Package | Version | License |',
  '| --- | --- | --- |',
  ...packages.map(item => `| ${item.name} | ${item.version} | ${item.license} |`),
  ''
];
writeFileSync(path.join(output, 'THIRD_PARTY_NOTICES.md'), notices.join('\n'));

const app = packageInfo('package.json');
const sbom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  serialNumber: `urn:uuid:${createHash('sha256').update(`${app.name}@${app.version}`).digest('hex').slice(0, 8)}-${createHash('sha256').update(`${app.name}@${app.version}`).digest('hex').slice(8, 12)}-5000-8000-${createHash('sha256').update(`${app.name}@${app.version}`).digest('hex').slice(12, 24)}`,
  version: 1,
  metadata: { timestamp, component: { type: 'application', name: app.name, version: app.version, properties: [{ name: 'wiiultraconnect:component-scope', value: 'packaged npm runtime' }] } },
  components: packages.map(item => ({ type: 'library', name: item.name, version: item.version, purl: npmPurl(item.name, item.version), licenses: [{ license: { id: item.license } }], hashes: item.integrity === 'NOASSERTION' ? undefined : [{ alg: 'SHA-512', content: item.integrity.replace(/^sha512-/, '') }] }))
};
writeFileSync(path.join(output, 'wiiultraconnect.sbom.cdx.json'), `${JSON.stringify(sbom, null, 2)}\n`);
console.log(`Generated checksums, notices, and CycloneDX SBOM for ${packages.length} packaged npm components in ${output}.`);
