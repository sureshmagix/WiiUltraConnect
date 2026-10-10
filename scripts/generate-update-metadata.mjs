import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, createHash, sign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
function values(name) { return args.flatMap((value, index) => value === name && args[index + 1] ? [args[index + 1]] : []); }
function value(name) { return values(name)[0]; }
function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  });
}
function canonicalJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  throw new Error(`Cannot canonicalize ${typeof value}`);
}

function classify(file) {
  const name = path.basename(file);
  const agent = /wiiultraconnect-agent/i.test(name) || /agent-linux-/.test(file);
  const target = agent ? 'agent' : 'desktop';
  if (/windows-x64-setup\.exe$/i.test(name)) return { target, platform: 'win32', arch: 'x64', format: 'nsis' };
  const mac = /-mac-(x64|arm64)\.(dmg|zip)$/i.exec(name);
  if (mac) return { target, platform: 'darwin', arch: mac[1], format: mac[2] };
  const deb = /_(amd64|x64|arm64)\.deb$/i.exec(name);
  if (deb) return { target, platform: 'linux', arch: ['amd64', 'x64'].includes(deb[1]) ? 'x64' : 'arm64', format: 'deb' };
  return undefined;
}

const inputs = values('--input').map(input => path.resolve(input));
const output = path.resolve(value('--output') || 'release/update');
assert.ok(inputs.length > 0, 'Specify one or more --input release directories.');
const artifacts = inputs.flatMap(input => {
  assert.ok(existsSync(input), `Input does not exist: ${input}`);
  return walk(input).map(file => ({ file, descriptor: classify(file) })).filter(item => item.descriptor);
});
assert.ok(artifacts.length > 0, 'No known installer artifacts were found.');

const packageMetadata = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const baseUrl = process.env.WII_UPDATE_BASE_URL;
const privateKeyPem = process.env.WII_UPDATE_SIGNING_KEY;
mkdirSync(output, { recursive: true });

if (!privateKeyPem) {
  const developmentRecord = {
    status: 'UNSIGNED-DEVELOPMENT-ONLY',
    message: 'This file is intentionally not trusted by the application and must never be published as update metadata.',
    version: packageMetadata.version,
    artifacts: artifacts.map(({ file, descriptor }) => ({ ...descriptor, name: path.basename(file), sha256: createHash('sha256').update(readFileSync(file)).digest('hex'), size: statSync(file).size }))
  };
  writeFileSync(path.join(output, 'UNSIGNED-DEVELOPMENT-ONLY.json'), `${JSON.stringify(developmentRecord, null, 2)}\n`);
  console.log(`Wrote unsigned development-only metadata to ${path.join(output, 'UNSIGNED-DEVELOPMENT-ONLY.json')}`);
  process.exit(0);
}

assert.ok(baseUrl && /^https:\/\//.test(baseUrl), 'WII_UPDATE_BASE_URL must be a HTTPS URL when signing metadata.');
const sequence = Number(process.env.WII_UPDATE_SEQUENCE);
assert.ok(Number.isSafeInteger(sequence) && sequence > 0, 'WII_UPDATE_SEQUENCE must be a positive integer when signing metadata.');
const publishedAt = process.env.WII_UPDATE_PUBLISHED_AT || (process.env.SOURCE_DATE_EPOCH ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString() : undefined);
assert.ok(publishedAt && !Number.isNaN(Date.parse(publishedAt)), 'Set WII_UPDATE_PUBLISHED_AT or SOURCE_DATE_EPOCH when signing metadata.');
const keyring = JSON.parse(readFileSync(path.join(root, 'build/update-keys.json'), 'utf8'));
const keyId = process.env.WII_UPDATE_KEY_ID || keyring.keys[0]?.keyId;
const key = keyring.keys.find(candidate => candidate.keyId === keyId);
assert.ok(key, `No embedded public key named ${keyId}`);
const privateKey = createPrivateKey(privateKeyPem);
const derivedPublic = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
assert.equal(derivedPublic, key.publicKeyPem, 'WII_UPDATE_SIGNING_KEY does not match the embedded public key. Rotate the public key in a prior signed release before using it.');

const normalizedBase = baseUrl.replace(/\/$/, '');
const signed = {
  schema: 1,
  product: 'com.wiiultraconnect.desktop',
  channel: process.env.WII_UPDATE_CHANNEL || 'stable',
  version: packageMetadata.version,
  sequence,
  publishedAt,
  artifacts: artifacts.map(({ file, descriptor }) => {
    const name = path.basename(file);
    return { ...descriptor, name, url: `${normalizedBase}/${encodeURIComponent(name)}`, sha256: createHash('sha256').update(readFileSync(file)).digest('hex'), size: statSync(file).size };
  }).sort((a, b) => `${a.target}/${a.platform}/${a.arch}/${a.format}`.localeCompare(`${b.target}/${b.platform}/${b.arch}/${b.format}`))
};
const signature = sign(null, Buffer.from(canonicalJson(signed), 'utf8'), privateKey).toString('base64');
const envelope = { signed, signatures: [{ keyId, algorithm: 'ed25519', signature }] };
const destination = path.join(output, 'wiiultraconnect-update.json');
writeFileSync(destination, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o644 });
console.log(`Wrote signed update metadata to ${destination} without printing signing material.`);
