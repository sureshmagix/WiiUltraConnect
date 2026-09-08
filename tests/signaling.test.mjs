import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createSignalingServer } from '../server/signaling.mjs';
import { formatRoomCode, sanitizeRoomCode, isPrivateIP, determineRouteType } from '../src/protocol.js';

async function fixture(t) {
  const server = createSignalingServer();
  const addr = await server.listen(0, '127.0.0.1');
  const port = typeof addr === 'object' ? addr.port : 8787;
  const clients = [];

  t.after(async () => {
    for (const ws of clients) {
      try { ws.terminate(); } catch {}
    }
    await server.close();
  });

  const connect = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/signal`);
    clients.push(ws);
    const queue = [], waiters = [];
    ws.on('message', raw => {
      const m = JSON.parse(raw.toString());
      const waiter = waiters.shift();
      waiter ? waiter(m) : queue.push(m);
    });
    await once(ws, 'open');
    return {
      ws,
      send: m => ws.send(JSON.stringify(m)),
      next: () => queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Expected signaling message did not arrive')), 2500);
        waiters.push(m => { clearTimeout(timer); resolve(m); });
      })
    };
  };

  return { server, connect, port };
}

test('formatRoomCode and sanitizeRoomCode format 6 and 9 digit verbal codes', () => {
  assert.equal(formatRoomCode('482910'), '482-910');
  assert.equal(formatRoomCode('482-910'), '482-910');
  assert.equal(formatRoomCode('123456789'), '123-456-789');
  assert.equal(sanitizeRoomCode(' 482 910 '), '482-910');
  assert.equal(sanitizeRoomCode('482-910'), '482-910');
});

test('isPrivateIP and determineRouteType accurately differentiate LAN and WAN routes', () => {
  assert.equal(isPrivateIP('192.168.1.100'), true);
  assert.equal(isPrivateIP('10.0.0.5'), true);
  assert.equal(isPrivateIP('172.20.1.1'), true);
  assert.equal(isPrivateIP('127.0.0.1'), true);
  assert.equal(isPrivateIP('8.8.8.8'), false);
  assert.equal(isPrivateIP('142.250.190.46'), false);

  // Direct LAN candidate pair
  const lanPair = determineRouteType({}, { candidateType: 'host', address: '192.168.1.10' }, { candidateType: 'host', address: '192.168.1.20' });
  assert.equal(lanPair, 'Local LAN (Direct)');

  // Public WAN candidate pair
  const wanPair = determineRouteType({}, { candidateType: 'srflx', address: '142.250.1.1' }, { candidateType: 'srflx', address: '142.250.2.2' });
  assert.equal(wanPair, 'Internet WAN (STUN P2P)');

  // Relay candidate pair
  const relayPair = determineRouteType({}, { candidateType: 'relay', address: '142.250.1.1' }, { candidateType: 'host', address: '192.168.1.10' });
  assert.equal(relayPair, 'TURN Relay');
});

test('host creates 6-digit session code and viewer connects verbally', async t => {
  const { server, connect } = await fixture(t);
  const host = await connect(), viewer = await connect(), outsider = await connect();

  host.send({ type: 'create' });
  const created = await host.next();
  assert.equal(created.type, 'created');
  assert.match(created.code, /^[0-9]{3}-[0-9]{3}$/);

  // Viewer joins with sanitized 6-digit code
  viewer.send({ type: 'join', code: created.code.replace('-', '') });
  assert.equal((await viewer.next()).type, 'joined');
  assert.equal((await host.next()).type, 'peer-ready');

  // Third peer is rejected
  outsider.send({ type: 'join', code: created.code });
  assert.equal((await outsider.next()).code, 'ROOM_FULL');

  // Relaying offer, answer, and ICE candidate
  const offer = { type: 'offer', description: { type: 'offer', sdp: 'v=0\r\n' } };
  host.send(offer);
  assert.deepEqual(await viewer.next(), offer);

  const answer = { type: 'answer', description: { type: 'answer', sdp: 'v=0\r\n' } };
  viewer.send(answer);
  assert.deepEqual(await host.next(), answer);

  const ice = { type: 'ice', candidate: { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 } };
  host.send(ice);
  assert.deepEqual(await viewer.next(), ice);

  // Peer leaves
  viewer.send({ type: 'leave' });
  assert.equal((await host.next()).type, 'peer-left');
  assert.equal(server.rooms.size, 0);
});

test('invalid JSON and malformed messages do not crash server', async t => {
  const { connect } = await fixture(t);
  const a = await connect();

  a.ws.send('{');
  assert.equal((await a.next()).code, 'INVALID_MESSAGE');

  a.ws.send(Buffer.from('bad'));
  assert.equal((await a.next()).code, 'INVALID_MESSAGE');

  a.send({ type: 'join', code: '12' });
  assert.equal((await a.next()).code, 'INVALID_CODE');

  a.send({ type: 'create' });
  await a.next();
  a.send({ type: 'create' });
  assert.equal((await a.next()).code, 'ALREADY_JOINED');
});

test('abrupt socket closure cleans up room and notifies peer', async t => {
  const { connect, server } = await fixture(t);
  const host = await connect(), viewer = await connect();

  host.send({ type: 'create' });
  const created = await host.next();
  viewer.send({ type: 'join', code: created.code });
  await viewer.next();
  await host.next();

  host.ws.terminate();
  assert.equal((await viewer.next()).type, 'peer-left');
  assert.equal(server.rooms.size, 0);
});
