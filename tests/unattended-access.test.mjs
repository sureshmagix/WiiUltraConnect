import test from 'node:test';
import assert from 'node:assert/strict';
import { accessPasswordError, accessVerifier, normalizeBrokerUrl, normalizeUsername, validAccessVerifier, validUsername } from '../src/unattended-access.js';

const username = 'office-pc';

test('unattended signaling URLs require a safe websocket endpoint', () => {
  assert.equal(normalizeBrokerUrl('wss://remote.example.com'), 'wss://remote.example.com/ws');
  assert.equal(normalizeBrokerUrl('ws://localhost:8787/ws'), 'ws://localhost:8787/ws');
  for (const value of ['https://remote.example.com', 'ws://remote.example.com/ws', 'wss://user:pass@remote.example.com/ws', 'wss://remote.example.com/other']) assert.throws(() => normalizeBrokerUrl(value));
});

test('usernames and password proofs are bounded and deterministic', async () => {
  assert.equal(normalizeUsername(' Office-PC '), username);
  assert.equal(validUsername(username), true);
  assert.equal(validUsername('no'), false);
  assert.equal(validUsername('Office PC'), false);
  assert.match(accessPasswordError('short'), /at least 12/);
  const first = await accessVerifier(username, 'a secure unattended password');
  const second = await accessVerifier(username, 'a secure unattended password');
  const different = await accessVerifier(username, 'a different secure password');
  assert.equal(first, second);
  assert.notEqual(first, different);
  assert.equal(validAccessVerifier(first), true);
});
