import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

const ID = /^[a-f0-9]{12}$/;
const SECRET = /^[A-Za-z0-9_-]{32}$/;
const object = value => value && typeof value === 'object' && !Array.isArray(value);

export function validSignal(message, role) {
  if (message.type === 'offer' || message.type === 'answer') {
    return message.type === (role === 'host' ? 'offer' : 'answer') &&
      object(message.description) && message.description.type === message.type &&
      typeof message.description.sdp === 'string' && message.description.sdp.length <= 64 * 1024;
  }
  if (message.type !== 'ice' || !object(message.candidate)) return false;
  const c = message.candidate;
  return typeof c.candidate === 'string' && c.candidate.length <= 4096 &&
    (c.sdpMid == null || (typeof c.sdpMid === 'string' && c.sdpMid.length < 256)) &&
    (c.sdpMLineIndex == null || (Number.isInteger(c.sdpMLineIndex) && c.sdpMLineIndex >= 0 && c.sdpMLineIndex < 128)) &&
    (c.usernameFragment == null || (typeof c.usernameFragment === 'string' && c.usernameFragment.length < 256));
}

export function createSignalingServer({ maxRooms = 1000, maxClients = 2000, allowedOrigins = ['null', 'file://'], roomTtlMs = 8 * 60 * 60 * 1000 } = {}) {
  const rooms = new Map();
  const http = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.writeHead(req.url === '/health' ? 200 : 404);
    res.end(JSON.stringify(req.url === '/health' ? { app: 'WiiUltraConnect', status: 'ok' } : { error: 'Not found' }));
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 72 * 1024, perMessageDeflate: false });
  const send = (ws, value) => {
    if (ws?.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 256 * 1024) return ws.close(1008, 'Slow signaling consumer');
    ws.send(JSON.stringify(value));
  };
  const fail = (ws, code) => send(ws, { type: 'error', code });
  function leave(ws) {
    const room = rooms.get(ws.roomId);
    ws.roomId = null;
    if (!room) return;
    rooms.delete(room.id); // Every disconnect invalidates the invitation and session.
    for (const member of [room.host, room.viewer]) {
      if (member && member !== ws) {
        member.roomId = null;
        send(member, { type: 'peer-left' });
      }
    }
  }
  http.on('upgrade', (req, socket, head) => {
    const origin = req.headers.origin;
    if (req.url !== '/signal' || (origin && !allowedOrigins.includes(origin)) || wss.clients.size >= maxClients) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });
  wss.on('connection', ws => {
    ws.alive = true;
    ws.tokens = 160;
    ws.lastRefill = Date.now();
    ws.connectedAt = Date.now();
    ws.failures = 0;
    ws.on('error', () => leave(ws));
    ws.on('pong', () => { ws.alive = true; });
    ws.on('close', () => leave(ws));
    ws.on('message', (raw, binary) => {
      const now = Date.now();
      ws.tokens = Math.min(160, ws.tokens + (now - ws.lastRefill) * 0.04);
      ws.lastRefill = now;
      if (--ws.tokens < 0) return ws.close(1008, 'Rate limit');
      let m;
      try { if (binary) throw Error(); m = JSON.parse(raw.toString()); } catch { return fail(ws, 'INVALID_MESSAGE'); }
      if (!object(m)) return fail(ws, 'INVALID_MESSAGE');
      if (m.type === 'leave') return leave(ws);
      if (m.type === 'create') {
        if (ws.roomId) return fail(ws, 'ALREADY_JOINED');
        if (rooms.size >= maxRooms) return fail(ws, 'SERVER_BUSY');
        const id = randomBytes(6).toString('hex');
        const secret = randomBytes(24).toString('base64url');
        rooms.set(id, { id, secret, host: ws, viewer: null, created: now });
        ws.roomId = id;
        ws.role = 'host';
        return send(ws, { type: 'created', roomId: id, invitation: `${id}.${secret}`, role: 'host' });
      }
      if (m.type === 'join') {
        if (ws.roomId) return fail(ws, 'ALREADY_JOINED');
        const room = typeof m.roomId === 'string' && ID.test(m.roomId) ? rooms.get(m.roomId) : null;
        if (!room || typeof m.secret !== 'string' || !SECRET.test(m.secret) || !timingSafeEqual(Buffer.from(room.secret), Buffer.from(m.secret))) {
          fail(ws, 'INVALID_INVITATION');
          if (++ws.failures >= 5) ws.close(1008, 'Too many attempts');
          return;
        }
        if (room.viewer) return fail(ws, 'ROOM_FULL');
        room.viewer = ws;
        ws.roomId = room.id;
        ws.role = 'viewer';
        send(ws, { type: 'joined', roomId: room.id, role: 'viewer' });
        return send(room.host, { type: 'peer-ready' });
      }
      const room = rooms.get(ws.roomId);
      if (!room) return fail(ws, 'NOT_JOINED');
      if (!validSignal(m, ws.role)) return fail(ws, 'INVALID_SIGNAL');
      const peer = ws.role === 'host' ? room.viewer : room.host;
      if (!peer) return fail(ws, 'PEER_UNAVAILABLE');
      // No client-supplied destination: membership determines the only recipient.
      send(peer, m.type === 'ice' ? { type: 'ice', candidate: m.candidate } : { type: m.type, description: m.description });
    });
  });
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive || (!ws.roomId && Date.now() - ws.connectedAt > 60_000)) { ws.terminate(); continue; }
      ws.alive = false;
      ws.ping();
    }
    for (const room of rooms.values()) {
      if (Date.now() - room.created > roomTtlMs) {
        fail(room.host, 'ROOM_EXPIRED');
        leave(room.host);
      }
    }
  }, 30_000);
  heartbeat.unref();
  return {
    http, wss, rooms,
    listen(port = 8787, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        http.once('error', reject);
        http.listen(port, host, () => { http.off('error', reject); resolve(http.address()); });
      });
    },
    close() {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      return new Promise(resolve => wss.close(() => http.close(resolve)));
    }
  };
}
