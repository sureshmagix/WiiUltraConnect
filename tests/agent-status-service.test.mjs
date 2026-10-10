import test from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ensurePrivateRuntimeDir, prepareSocketPath } = require('../agent/runtime.cjs');
const { startLocalStatusService, MAX_REQUEST_BYTES } = require('../agent/status-service.cjs');

const privateDirectory = prefix => {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  const runtime = path.join(root, 'runtime');
  mkdirSync(runtime, { mode: 0o700 });
  return runtime;
};
const waitForListening = server => new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
const stop = service => new Promise((resolve, reject) => service.stop(error => error ? reject(error) : resolve()));
const request = (socketPath, text) => new Promise((resolve, reject) => {
  const socket = net.createConnection(socketPath);
  let response = '';
  socket.setEncoding('utf8');
  socket.once('connect', () => socket.end(text));
  socket.on('data', chunk => { response += chunk; });
  socket.once('end', () => resolve(response));
  socket.once('error', reject);
});

test('agent runtime refuses symlinked directories and preserves non-socket entries', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wii-agent-runtime-'));
  const target = path.join(root, 'target'); mkdirSync(target, { mode: 0o700 });
  const link = path.join(root, 'link'); symlinkSync(target, link);
  assert.throws(() => ensurePrivateRuntimeDir(link), /not a real directory/);

  const runtime = privateDirectory('wii-agent-runtime-');
  const entry = path.join(runtime, 'wiiultraconnect-agent.sock');
  writeFileSync(entry, 'do-not-delete');
  assert.throws(() => prepareSocketPath(runtime), /non-socket/);
  assert.equal(readFileSync(entry, 'utf8'), 'do-not-delete');
});

test('local status service handles bounded input and can recover after a crash-style stop', async t => {
  const runtime = privateDirectory('wii-agent-service-');
  const state = { product: 'test-agent', networkListener: false };
  let service = startLocalStatusService({ runtimeDir: runtime, socketName: 's', status: () => state });
  t.after(async () => { try { await stop(service); } catch {} });
  await waitForListening(service.server);
  assert.equal(lstatSync(service.socketPath).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await request(service.socketPath, 'status\n')), state);
  const flood = net.createConnection(service.socketPath);
  await new Promise((resolve, reject) => { flood.once('connect', () => flood.end(`x${'a'.repeat(MAX_REQUEST_BYTES)}\n`)); flood.once('close', resolve); flood.once('error', reject); });
  assert.deepEqual(JSON.parse(await request(service.socketPath, 'status\n')), state);

  await stop(service);
  service = startLocalStatusService({ runtimeDir: runtime, socketName: 's', status: () => state });
  await waitForListening(service.server);
  assert.deepEqual(JSON.parse(await request(service.socketPath, 'status\r\n')), state);
});
