import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

function waitFor(socket, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), 5_000);
    const listener = data => {
      const message = JSON.parse(data.toString());
      if (message.type === type) { clearTimeout(timer); socket.off('message', listener); resolve(message); }
    };
    socket.on('message', listener);
  });
}
function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

test('server authenticates a registered host and relays only its approved signaling exchange', async t => {
  const port = 19000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, ['server/index.mjs'], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), DATA_PATH: join(mkdtempSync(join(tmpdir(), 'wuc-signal-')), 'devices.json') }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server did not start')), 5_000);
    child.stdout.on('data', data => { if (data.toString().includes('listening')) { clearTimeout(timer); resolve(); } });
    child.once('error', reject);
  });
  const url = `ws://127.0.0.1:${port}/ws`;
  const host = await connect(url), viewer = await connect(url);
  t.after(() => { host.close(); viewer.close(); });
  const deviceId = 'wuc-0123456789abcdef0123456789abcdef', username = 'office-pc', deviceKey = 'a'.repeat(48), requested = crypto.randomUUID();
  const registered = waitFor(host, 'host-registered');
  host.send(JSON.stringify({ type: 'host-register', deviceId, username, deviceKey }));
  assert.equal((await registered).username, username);
  const incoming = waitFor(host, 'access-request');
  const pending = waitFor(viewer, 'access-pending');
  viewer.send(JSON.stringify({ type: 'access-request', username, attemptId: requested, verifier: 'b'.repeat(43) }));
  const request = await incoming;
  const requestState = await pending;
  assert.equal(requestState.attemptId, requested);
  assert.equal(request.attemptId, requestState.relayAttemptId);
  const approved = waitFor(viewer, 'access-approved');
  host.send(JSON.stringify({ type: 'access-decision', attemptId: request.attemptId, approved: true }));
  await approved;
  const offer = `WUC-INTERNET-2.${'x'.repeat(64)}`;
  const viewerOffer = waitFor(viewer, 'signal-offer');
  host.send(JSON.stringify({ type: 'signal-offer', attemptId: request.attemptId, code: offer }));
  assert.deepEqual(await viewerOffer, { type: 'signal-offer', attemptId: request.attemptId, code: offer });
  const answer = `WUC-INTERNET-2.${'y'.repeat(64)}`;
  const hostAnswer = waitFor(host, 'signal-answer');
  viewer.send(JSON.stringify({ type: 'signal-answer', attemptId: request.attemptId, code: answer }));
  assert.deepEqual(await hostAnswer, { type: 'signal-answer', attemptId: request.attemptId, code: answer });
});
