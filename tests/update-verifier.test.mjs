import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { MAX_UPDATE_ARTIFACT_SIZE, canonicalJson, compareVersions, verifyEnvelope, artifactFor, verifyArtifactFile } = require('../electron/update-verifier.cjs');
const { readUpdateState, writeUpdateState } = require('../electron/update-client.cjs');

function fixture() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const signed = {
    schema: 1,
    product: 'com.wiiultraconnect.desktop',
    channel: 'stable',
    version: '0.3.1',
    sequence: 11,
    publishedAt: '2026-10-09T00:00:00.000Z',
    artifacts: [{ target: 'desktop', platform: 'linux', arch: 'x64', format: 'deb', name: 'wiiultraconnect_0.3.1_amd64.deb', url: 'https://updates.example.test/wiiultraconnect_0.3.1_amd64.deb', sha256: '0'.repeat(64), size: 3 }]
  };
  const signature = sign(null, Buffer.from(canonicalJson(signed)), privateKey).toString('base64');
  return {
    signed,
    envelope: { signed, signatures: [{ keyId: 'test-key', algorithm: 'ed25519', signature }] },
    keyring: { schema: 1, keys: [{ keyId: 'test-key', algorithm: 'ed25519', publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }), purpose: 'release-metadata', notBefore: '2026-01-01T00:00:00.000Z', notAfter: '2027-01-01T00:00:00.000Z' }] }
  };
}

test('signed update metadata selects a target artifact and advances rollback state', () => {
  const { envelope, keyring } = fixture();
  const result = verifyEnvelope(envelope, keyring, { currentVersion: '0.3.0', highestSequence: 10, highestVersion: '0.3.0' });
  assert.equal(result.verifiedKeyId, 'test-key');
  assert.deepEqual(result.nextState, { highestSequence: 11, highestVersion: '0.3.1' });
  assert.equal(artifactFor(result.signed, { target: 'desktop', platform: 'linux', arch: 'x64', format: 'deb' }).name, 'wiiultraconnect_0.3.1_amd64.deb');
});

test('update verifier rejects changed bytes, stale sequences, and unsupported URLs', () => {
  const { envelope, keyring, signed } = fixture();
  assert.throws(() => verifyEnvelope({ ...envelope, signed: { ...signed, sequence: 9 } }, keyring, { highestSequence: 10 }), /signature|Rollback/);
  const altered = structuredClone(envelope); altered.signed.artifacts[0].url = 'http://updates.example.test/bad.deb';
  assert.throws(() => verifyEnvelope(altered, keyring), /HTTPS/);
  const oversized = structuredClone(envelope); oversized.signed.artifacts[0].size = MAX_UPDATE_ARTIFACT_SIZE + 1;
  assert.throws(() => verifyEnvelope(oversized, keyring), /size/);
  const unsafeName = structuredClone(envelope); unsafeName.signed.artifacts[0].name = '../outside.deb';
  assert.throws(() => verifyEnvelope(unsafeName, keyring), /name/);
});

test('semantic-version comparison rejects prerelease rollbacks numerically', () => {
  assert.ok(compareVersions('1.0.0-alpha.2', '1.0.0-alpha.10') < 0);
  assert.ok(compareVersions('1.0.0-alpha.10', '1.0.0-alpha.2') > 0);
  assert.ok(compareVersions('1.0.0-1', '1.0.0-alpha') < 0);
  assert.ok(compareVersions('1.0.0-alpha', '1.0.0') < 0);
  assert.throws(() => compareVersions('1.0.0-01', '1.0.0-1'), /Invalid semantic version/);
  assert.throws(() => compareVersions('9007199254740992.0.0', '1.0.0'), /Invalid semantic version/);
});

test('artifact verifier requires exact size and SHA-256', t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'wii-update-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const artifact = path.join(directory, 'artifact.deb');
  writeFileSync(artifact, 'abc');
  const descriptor = { name: 'artifact.deb', size: 3, sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' };
  assert.equal(verifyArtifactFile(artifact, descriptor), descriptor.sha256);
  assert.throws(() => verifyArtifactFile(artifact, { ...descriptor, size: 4 }), /size mismatch/);
});

test('rollback state persists atomically without treating a missing state as an error', t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'wii-update-state-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'nested', 'update-state.json');
  assert.deepEqual(readUpdateState(stateFile), {});
  writeUpdateState(stateFile, { highestSequence: 11, highestVersion: '0.3.1' });
  assert.deepEqual(readUpdateState(stateFile), { highestSequence: 11, highestVersion: '0.3.1' });
});
