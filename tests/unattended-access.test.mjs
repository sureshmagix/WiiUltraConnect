import test from 'node:test';
import assert from 'node:assert/strict';
import { accessPasswordError, accessVerifier, normalizeBrokerUrl, validDeviceId, validAccessVerifier } from '../src/unattended-access.js';

const deviceId = 'wuc-0123456789abcdef0123456789abcdef';

test('unattended signaling URLs require a safe websocket endpoint', () => {
  assert.equal(normalizeBrokerUrl('wss://remote.example.com'), 'wss://remote.example.com/ws');
  assert.equal(normalizeBrokerUrl('ws://localhost:8787/ws'), 'ws://localhost:8787/ws');
  for (const value of ['https://remote.example.com', 'ws://remote.example.com/ws', 'wss://user:pass@remote.example.com/ws', 'wss://remote.example.com/other']) assert.throws(() => normalizeBrokerUrl(value));
});

test('computer IDs and password proofs are bounded and deterministic', async () => {
  assert.equal(validDeviceId(deviceId), true);
  assert.equal(validDeviceId('wuc-short'), false);
  assert.match(accessPasswordError('short'), /at least 12/);
  const first = await accessVerifier(deviceId, 'a secure unattended password');
  const second = await accessVerifier(deviceId, 'a secure unattended password');
  const different = await accessVerifier(deviceId, 'a different secure password');
  assert.equal(first, second);
  assert.notEqual(first, different);
  assert.equal(validAccessVerifier(first), true);
});
