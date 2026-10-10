const { createPublicKey, verify, createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');

const PRODUCT = 'com.wiiultraconnect.desktop';
const SUPPORTED_PLATFORMS = new Set(['win32', 'darwin', 'linux']);
const SUPPORTED_ARCHITECTURES = new Set(['x64', 'arm64']);
const MAX_UPDATE_ARTIFACT_SIZE = 1024 * 1024 * 1024;

function canonicalJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Metadata contains a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw new Error(`Metadata contains unsupported ${typeof value}`);
}

function parseVersion(value) {
  if (typeof value !== 'string') throw new Error('Version must be a string');
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/.exec(value);
  if (!match) throw new Error(`Invalid semantic version: ${value}`);
  const pre = match[4] ? match[4].split('.') : [];
  if (pre.some(identifier => !identifier || (/^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith('0')))) throw new Error(`Invalid semantic version: ${value}`);
  const [major, minor, patch] = match.slice(1, 4).map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) throw new Error(`Invalid semantic version: ${value}`);
  return { major, minor, patch, pre };
}

function compareNumericIdentifiers(left, right) {
  return left.length === right.length ? (left < right ? -1 : left > right ? 1 : 0) : left.length < right.length ? -1 : 1;
}

function compareVersions(left, right) {
  const a = parseVersion(left); const b = parseVersion(right);
  for (const key of ['major', 'minor', 'patch']) if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1;
  for (let index = 0; index < Math.min(a.pre.length, b.pre.length); index += 1) {
    const aIdentifier = a.pre[index], bIdentifier = b.pre[index];
    if (aIdentifier === bIdentifier) continue;
    const aNumeric = /^\d+$/.test(aIdentifier), bNumeric = /^\d+$/.test(bIdentifier);
    if (aNumeric && bNumeric) return compareNumericIdentifiers(aIdentifier, bIdentifier);
    if (aNumeric) return -1;
    if (bNumeric) return 1;
    return aIdentifier < bIdentifier ? -1 : 1;
  }
  return a.pre.length === b.pre.length ? 0 : a.pre.length < b.pre.length ? -1 : 1;
}

function assertIsoDate(value, name) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new Error(`${name} must be an ISO-8601 date`);
  return Date.parse(value);
}

function normalizeKeyring(keyring) {
  if (!keyring || keyring.schema !== 1 || !Array.isArray(keyring.keys)) throw new Error('Invalid embedded update keyring');
  const result = new Map();
  for (const key of keyring.keys) {
    if (!key || key.algorithm !== 'ed25519' || typeof key.keyId !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(key.keyId) || typeof key.publicKeyPem !== 'string') throw new Error('Invalid update key entry');
    if (key.purpose !== 'release-metadata') throw new Error(`Update key ${key.keyId} has an invalid purpose`);
    const entry = { ...key, notBeforeMs: assertIsoDate(key.notBefore, 'Key notBefore'), notAfterMs: assertIsoDate(key.notAfter, 'Key notAfter') };
    if (entry.notBeforeMs > entry.notAfterMs || result.has(entry.keyId)) throw new Error(`Invalid validity period or duplicate for update key ${entry.keyId}`);
    result.set(entry.keyId, entry);
  }
  return result;
}

function assertArtifact(artifact) {
  if (!artifact || typeof artifact !== 'object') throw new Error('Invalid update artifact');
  if (!['desktop', 'agent'].includes(artifact.target)) throw new Error('Artifact target must be desktop or agent');
  if (!SUPPORTED_PLATFORMS.has(artifact.platform) || !SUPPORTED_ARCHITECTURES.has(artifact.arch)) throw new Error('Artifact has unsupported platform or architecture');
  if (typeof artifact.format !== 'string' || !/^[a-z0-9.]{1,16}$/.test(artifact.format)) throw new Error('Artifact format is invalid');
  if (typeof artifact.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,179}$/.test(artifact.name)) throw new Error('Artifact name is invalid');
  if (typeof artifact.url !== 'string') throw new Error('Artifact URL must use HTTPS');
  let parsedUrl;
  try { parsedUrl = new URL(artifact.url); } catch { throw new Error('Artifact URL must use HTTPS'); }
  if (parsedUrl.protocol !== 'https:' || parsedUrl.username || parsedUrl.password || parsedUrl.hash) throw new Error('Artifact URL must use HTTPS without credentials or fragments');
  if (!/^[a-f0-9]{64}$/.test(artifact.sha256)) throw new Error('Artifact SHA-256 is invalid');
  if (!Number.isSafeInteger(artifact.size) || artifact.size < 1 || artifact.size > MAX_UPDATE_ARTIFACT_SIZE) throw new Error('Artifact size is invalid');
}

function assertSignedPayload(signed) {
  if (!signed || signed.schema !== 1 || signed.product !== PRODUCT) throw new Error('Metadata has an unsupported schema or product');
  if (!['stable', 'beta'].includes(signed.channel)) throw new Error('Metadata channel is invalid');
  parseVersion(signed.version);
  assertIsoDate(signed.publishedAt, 'Metadata publishedAt');
  if (!Number.isSafeInteger(signed.sequence) || signed.sequence < 1) throw new Error('Metadata sequence must be a positive integer');
  if (signed.minimumVersion !== undefined) parseVersion(signed.minimumVersion);
  if (!Array.isArray(signed.artifacts) || signed.artifacts.length === 0 || signed.artifacts.length > 16) throw new Error('Metadata must include one to sixteen artifacts');
  const ids = new Set();
  for (const artifact of signed.artifacts) {
    assertArtifact(artifact);
    const id = `${artifact.target}/${artifact.platform}/${artifact.arch}/${artifact.format}`;
    if (ids.has(id)) throw new Error(`Duplicate artifact ${id}`);
    ids.add(id);
  }
}

function verifyEnvelope(envelope, keyring, state = {}) {
  if (!envelope || typeof envelope !== 'object' || !envelope.signed || !Array.isArray(envelope.signatures) || envelope.signatures.length === 0) throw new Error('Malformed signed update metadata');
  assertSignedPayload(envelope.signed);
  const keys = normalizeKeyring(keyring);
  const message = Buffer.from(canonicalJson(envelope.signed), 'utf8');
  const signedAt = Date.parse(envelope.signed.publishedAt);
  let verifiedKeyId;
  for (const signature of envelope.signatures) {
    if (!signature || signature.algorithm !== 'ed25519' || typeof signature.keyId !== 'string' || typeof signature.signature !== 'string') continue;
    const key = keys.get(signature.keyId);
    if (!key || signedAt < key.notBeforeMs || signedAt > key.notAfterMs) continue;
    try {
      if (verify(null, message, createPublicKey(key.publicKeyPem), Buffer.from(signature.signature, 'base64'))) {
        verifiedKeyId = key.keyId;
        break;
      }
    } catch {
      // A malformed signature or public key must never become an accepted update.
    }
  }
  if (!verifiedKeyId) throw new Error('Update metadata has no valid trusted Ed25519 signature');

  const priorSequence = state.highestSequence ?? 0;
  if (!Number.isSafeInteger(priorSequence) || priorSequence < 0) throw new Error('Stored update sequence is invalid');
  if (envelope.signed.sequence < priorSequence) throw new Error(`Rollback rejected: metadata sequence ${envelope.signed.sequence} is below accepted sequence ${priorSequence}`);
  if (state.highestVersion && compareVersions(envelope.signed.version, state.highestVersion) < 0) throw new Error(`Rollback rejected: ${envelope.signed.version} is below accepted version ${state.highestVersion}`);
  if (envelope.signed.minimumVersion && state.currentVersion && compareVersions(state.currentVersion, envelope.signed.minimumVersion) < 0) throw new Error(`Update requires ${envelope.signed.minimumVersion} or newer as a starting version`);

  return { signed: envelope.signed, verifiedKeyId, nextState: { highestSequence: Math.max(priorSequence, envelope.signed.sequence), highestVersion: state.highestVersion && compareVersions(state.highestVersion, envelope.signed.version) > 0 ? state.highestVersion : envelope.signed.version } };
}

function artifactFor(signed, { target = 'desktop', platform, arch, format }) {
  const artifact = signed.artifacts.find(candidate => candidate.target === target && candidate.platform === platform && candidate.arch === arch && (!format || candidate.format === format));
  if (!artifact) throw new Error(`No trusted ${target} artifact for ${platform}/${arch}${format ? `/${format}` : ''}`);
  return artifact;
}

function verifyArtifactFile(file, artifact) {
  const data = readFileSync(file);
  if (data.length !== artifact.size) throw new Error(`Artifact size mismatch for ${artifact.name}`);
  const digest = createHash('sha256').update(data).digest('hex');
  if (digest !== artifact.sha256) throw new Error(`Artifact SHA-256 mismatch for ${artifact.name}`);
  return digest;
}

module.exports = { PRODUCT, MAX_UPDATE_ARTIFACT_SIZE, canonicalJson, compareVersions, verifyEnvelope, artifactFor, verifyArtifactFile };
