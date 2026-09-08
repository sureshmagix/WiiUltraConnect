import { createServer } from 'node:http';
import { randomInt } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { ROOM_CODE_REGEX, formatRoomCode, sanitizeRoomCode } from '../src/protocol.js';

export { formatRoomCode, sanitizeRoomCode };

const object = value => value && typeof value === 'object' && !Array.isArray(value);

function generateNumericCode(existingRooms) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const num = randomInt(100000, 999999);
    const code = `${String(num).slice(0, 3)}-${String(num).slice(3)}`;
    if (!existingRooms.has(code)) return code;
  }
  const part1 = randomInt(100, 999);
  const part2 = randomInt(100, 999);
  const part3 = randomInt(100, 999);
  return `${part1}-${part2}-${part3}`;
}

export function validSignal(message, role) {
  if (message.type === 'offer' || message.type === 'answer') {
    return message.type === (role === 'host' ? 'offer' : 'answer') &&
      object(message.description) && message.description.type === message.type &&
      typeof message.description.sdp === 'string' && message.description.sdp.length <= 128 * 1024;
  }
  if (message.type !== 'ice' || !object(message.candidate)) return false;
  const c = message.candidate;
  return typeof c.candidate === 'string' && c.candidate.length <= 8192 &&
    (c.sdpMid == null || (typeof c.sdpMid === 'string' && c.sdpMid.length < 256)) &&
    (c.sdpMLineIndex == null || (Number.isInteger(c.sdpMLineIndex) && c.sdpMLineIndex >= 0 && c.sdpMLineIndex < 128)) &&
    (c.usernameFragment == null || (typeof c.usernameFragment === 'string' && c.usernameFragment.length < 256));
}

export function createSignalingServer({ maxRooms = 5000, maxClients = 10000, allowedOrigins = ['null', 'file://'], roomTtlMs = 15 * 60 * 1000 } = {}) {
  const rooms = new Map();
  const http = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.url === '/health' || req.url === '/') {
      res.writeHead(200);
      res.end(JSON.stringify({ app: 'WiiUltraConnect', status: 'ok', activeRooms: rooms.size }));
    } else {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 160 * 1024, perMessageDeflate: false });
  const send = (ws, value) => {
    if (ws?.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 512 * 1024) return ws.close(1008, 'Slow signaling consumer');
    ws.send(JSON.stringify(value));
  };
  const fail = (ws, code, message) => send(ws, { type: 'error', code, message });

  function leave(ws) {
    const room = rooms.get(ws.roomId);
    ws.roomId = null;
    if (!room) return;
    rooms.delete(room.id);
    for (const member of [room.host, room.viewer]) {
      if (member && member !== ws) {
        member.roomId = null;
        send(member, { type: 'peer-left' });
      }
    }
  }

  http.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });

  wss.on('connection', ws => {
    ws.alive = true;
    ws.tokens = 200;
    ws.lastRefill = Date.now();
    ws.connectedAt = Date.now();
    ws.failures = 0;

    ws.on('error', () => leave(ws));
    ws.on('pong', () => { ws.alive = true; });
    ws.on('close', () => leave(ws));

    ws.on('message', (raw, binary) => {
      const now = Date.now();
      ws.tokens = Math.min(200, ws.tokens + (now - ws.lastRefill) * 0.1);
      ws.lastRefill = now;
      if (--ws.tokens < 0) return ws.close(1008, 'Rate limit exceeded');

      let m;
      try {
        if (binary) throw new Error();
        m = JSON.parse(raw.toString());
      } catch {
        return fail(ws, 'INVALID_MESSAGE', 'Malformed JSON payload');
      }

      if (!object(m)) return fail(ws, 'INVALID_MESSAGE', 'Message must be a JSON object');

      if (m.type === 'ping') {
        return send(ws, { type: 'pong' });
      }

      if (m.type === 'leave') {
        return leave(ws);
      }

      if (m.type === 'create') {
        if (ws.roomId) return fail(ws, 'ALREADY_JOINED', 'Already host of a session');
        if (rooms.size >= maxRooms) return fail(ws, 'SERVER_BUSY', 'Server is full, please try later');

        const code = generateNumericCode(rooms);
        rooms.set(code, { id: code, host: ws, viewer: null, created: now });
        ws.roomId = code;
        ws.role = 'host';
        return send(ws, { type: 'created', roomId: code, code, role: 'host' });
      }

      if (m.type === 'join') {
        if (ws.roomId) return fail(ws, 'ALREADY_JOINED', 'Already connected to a session');
        const rawCode = m.roomId || m.code;
        const code = sanitizeRoomCode(rawCode);
        if (!code || !ROOM_CODE_REGEX.test(code)) {
          fail(ws, 'INVALID_CODE', 'Please enter a valid 6-digit session code (e.g. 482-910)');
          if (++ws.failures >= 10) ws.close(1008, 'Too many invalid attempts');
          return;
        }

        const room = rooms.get(code);
        if (!room) {
          fail(ws, 'ROOM_NOT_FOUND', 'Session code not found or expired. Check the code and try again.');
          if (++ws.failures >= 10) ws.close(1008, 'Too many invalid attempts');
          return;
        }

        if (room.viewer) return fail(ws, 'ROOM_FULL', 'Session already has a connected viewer.');

        room.viewer = ws;
        ws.roomId = room.id;
        ws.role = 'viewer';
        send(ws, { type: 'joined', roomId: room.id, role: 'viewer' });
        return send(room.host, { type: 'peer-ready' });
      }

      const room = rooms.get(ws.roomId);
      if (!room) return fail(ws, 'NOT_JOINED', 'You have not joined a session');
      if (!validSignal(m, ws.role)) return fail(ws, 'INVALID_SIGNAL', 'Invalid signaling message format');

      const peer = ws.role === 'host' ? room.viewer : room.host;
      if (!peer) return fail(ws, 'PEER_UNAVAILABLE', 'Peer is not connected');

      send(peer, m.type === 'ice' ? { type: 'ice', candidate: m.candidate } : { type: m.type, description: m.description });
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive || (!ws.roomId && Date.now() - ws.connectedAt > 60_000)) {
        ws.terminate();
        continue;
      }
      ws.alive = false;
      ws.ping();
    }
    for (const room of rooms.values()) {
      if (Date.now() - room.created > roomTtlMs) {
        fail(room.host, 'ROOM_EXPIRED', 'Session code expired');
        leave(room.host);
      }
    }
  }, 30_000);
  heartbeat.unref();

  return {
    http,
    wss,
    rooms,
    listen(port = 8787, host = '0.0.0.0') {
      return new Promise((resolve, reject) => {
        http.once('error', reject);
        http.listen(port, host, () => {
          http.off('error', reject);
          resolve(http.address());
        });
      });
    },
    close() {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      return new Promise(resolve => wss.close(() => http.close(resolve)));
    }
  };
}
