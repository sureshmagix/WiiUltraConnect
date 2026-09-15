import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';

const port = Number(process.env.PORT || 8787);
const dataPath = resolve(process.env.DATA_PATH || './data/devices.json');
const MAX_MESSAGE = 120 * 1024;
const MAX_ATTEMPTS_PER_MINUTE = 10;
const DEVICE_ID = /^wuc-[a-z0-9]{20,64}$/;
const USERNAME = /^[a-z][a-z0-9-]{2,63}$/;
const keyHash = value => createHash('sha256').update(value).digest('hex');
const equal = (a, b) => {
  const left = Buffer.from(String(a)), right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
};

function loadDevices() {
  try {
    const parsed = JSON.parse(readFileSync(dataPath, 'utf8'));
    return parsed && typeof parsed === 'object' && parsed.devices && typeof parsed.devices === 'object' ? parsed.devices : {};
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}
const devices = loadDevices();
function saveDevices() {
  mkdirSync(dirname(dataPath), { recursive: true });
  const temp = `${dataPath}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify({ devices }), { mode: 0o600 });
  renameSync(temp, dataPath);
}
function validDevice(value) { return DEVICE_ID.test(String(value)); }
function validUsername(value) { return USERNAME.test(String(value || '').trim().toLowerCase()); }
function usernameFor(value) { return String(value || '').trim().toLowerCase(); }
function message(socket, data) { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data)); }
function error(socket, text) { message(socket, { type: 'error', message: text }); }

const hosts = new Map();
const attempts = new Map();
const rate = new Map();
function removeHost(socket) { for (const [id, host] of hosts) if (host.socket === socket) hosts.delete(id); }
function removeAttempts(socket) { for (const [id, attempt] of attempts) if (attempt.host === socket || attempt.viewer === socket) attempts.delete(id); }
function allowed(socket, username) {
  const now = Date.now(), key = `${socket._socket.remoteAddress || 'unknown'}:${username}`;
  const current = (rate.get(key) || []).filter(time => now - time < 60_000);
  if (current.length >= MAX_ATTEMPTS_PER_MINUTE) return false;
  current.push(now); rate.set(key, current); return true;
}
function sendToAttempt(socket, type, body) {
  const attempt = attempts.get(body.attemptId);
  if (!attempt) return error(socket, 'This access request expired. Start again.');
  const expected = type === 'signal-offer' || type === 'access-decision' ? attempt.host : attempt.viewer;
  if (socket !== expected) return error(socket, 'This device is not allowed to send that message.');
  const recipient = expected === attempt.host ? attempt.viewer : attempt.host;
  if (recipient.readyState !== WebSocket.OPEN) return error(socket, 'The other device disconnected.');
  if (type === 'access-decision') {
    if (body.approved !== true) { message(recipient, { type: 'access-denied', attemptId: body.attemptId }); attempts.delete(body.attemptId); return; }
    attempt.approved = true;
    message(recipient, { type: 'access-approved', attemptId: body.attemptId });
    return;
  }
  if (!attempt.approved || typeof body.code !== 'string' || body.code.length > 110_000 || !body.code.startsWith('WUC-INTERNET-2.')) return error(socket, 'Invalid signaling payload.');
  message(recipient, { type, attemptId: body.attemptId, code: body.code });
  if (type === 'signal-answer') attempts.delete(body.attemptId);
}

const http = createServer((request, response) => {
  if (request.url === '/healthz') { response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify({ ok: true, hosts: hosts.size })); return; }
  response.writeHead(404); response.end();
});
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE });
http.on('upgrade', (request, socket, head) => {
  if (new URL(request.url, 'http://localhost').pathname !== '/ws') { socket.destroy(); return; }
  wss.handleUpgrade(request, socket, head, client => wss.emit('connection', client));
});
wss.on('connection', socket => {
  socket.on('message', raw => {
    if (raw.length > MAX_MESSAGE) return socket.close(1009, 'message too large');
    let body;
    try { body = JSON.parse(raw.toString()); } catch { return error(socket, 'Invalid JSON message.'); }
    if (!body || typeof body !== 'object' || typeof body.type !== 'string') return error(socket, 'Invalid signaling message.');
    if (body.type === 'host-register') {
      const username = usernameFor(body.username);
      if (!validDevice(body.deviceId) || !validUsername(username) || typeof body.deviceKey !== 'string' || body.deviceKey.length < 32 || body.deviceKey.length > 256) return error(socket, 'Invalid host registration.');
      const hash = keyHash(body.deviceKey), known = devices[body.deviceId];
      if (known && !equal(known.keyHash, hash)) return error(socket, 'This computer ID belongs to another device. Reset unattended access on the controlled computer.');
      const usedBy = Object.entries(devices).find(([id, device]) => id !== body.deviceId && device.username === username);
      if (usedBy) return error(socket, 'That username is already used by another computer. Choose a different username.');
      if (!known || known.username !== username) { devices[body.deviceId] = { keyHash: hash, username, createdAt: known?.createdAt || new Date().toISOString() }; saveDevices(); }
      const old = hosts.get(body.deviceId); if (old && old.socket !== socket) old.socket.close(4001, 'replaced by a newer host connection');
      hosts.set(body.deviceId, { socket, seenAt: Date.now(), username }); socket.deviceId = body.deviceId;
      return message(socket, { type: 'host-registered', username });
    }
    if (body.type === 'access-request') {
      const username = usernameFor(body.username);
      if (!validUsername(username) || typeof body.attemptId !== 'string' || body.attemptId.length < 16 || body.attemptId.length > 128 || typeof body.verifier !== 'string' || body.verifier.length < 32 || body.verifier.length > 128) return error(socket, 'Invalid unattended access request.');
      if (!allowed(socket, username)) return error(socket, 'Too many access attempts. Wait one minute and try again.');
      const deviceId = Object.entries(devices).find(([, device]) => device.username === username)?.[0];
      const host = deviceId && hosts.get(deviceId);
      if (!host || host.socket.readyState !== WebSocket.OPEN) return message(socket, { type: 'host-offline', attemptId: body.attemptId });
      const id = randomUUID();
      attempts.set(id, { host: host.socket, viewer: socket, expiresAt: Date.now() + 120_000, approved: false });
      message(host.socket, { type: 'access-request', attemptId: id, verifier: body.verifier });
      return message(socket, { type: 'access-pending', attemptId: body.attemptId, relayAttemptId: id });
    }
    if (body.type === 'access-decision' || body.type === 'signal-offer' || body.type === 'signal-answer') return sendToAttempt(socket, body.type, body);
    return error(socket, 'Unknown signaling message.');
  });
  socket.on('close', () => { removeHost(socket); removeAttempts(socket); });
  socket.on('error', () => {});
});
setInterval(() => { const now = Date.now(); for (const [id, attempt] of attempts) if (attempt.expiresAt < now) { message(attempt.host, { type: 'access-expired', attemptId: id }); message(attempt.viewer, { type: 'access-expired', attemptId: id }); attempts.delete(id); } }, 10_000).unref();
http.listen(port, '0.0.0.0', () => console.log(`WiiUltraConnect signaling server listening on ${port}`));
