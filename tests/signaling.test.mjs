import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createSignalingServer } from '../server/signaling.mjs';

async function fixture(t) {
  const server = createSignalingServer();
  const { port } = await server.listen(0);
  const clients = [];
  t.after(async () => { for (const ws of clients) ws.terminate(); await server.close(); });
  const connect = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/signal`, { origin: 'null' });
    clients.push(ws);
    const queue = [], waiters = [];
    ws.on('message', raw => { const m = JSON.parse(raw.toString()); const waiter = waiters.shift(); waiter ? waiter(m) : queue.push(m); });
    await once(ws, 'open');
    return { ws, send: m => ws.send(JSON.stringify(m)), next: () => queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Expected signaling message did not arrive')), 2000);
      waiters.push(m => { clearTimeout(timer); resolve(m); });
    }) };
  };
  return { server, connect, port };
}
test('private rooms forward offer/answer and early ICE, reject third peer, expire on leave', async t => {
  const { server, connect } = await fixture(t);
  const host = await connect(), viewer = await connect(), outsider = await connect();
  host.send({ type: 'create' });
  const room = await host.next();
  assert.equal(room.type, 'created');
  const [roomId, secret] = room.invitation.split('.');
  outsider.send({ type: 'join', roomId, secret: 'x'.repeat(32) });
  assert.equal((await outsider.next()).code, 'INVALID_INVITATION');
  viewer.send({ type: 'join', roomId, secret });
  assert.equal((await viewer.next()).type, 'joined');
  assert.equal((await host.next()).type, 'peer-ready');
  outsider.send({ type: 'join', roomId, secret });
  assert.equal((await outsider.next()).code, 'ROOM_FULL');
  const ice = { type: 'ice', candidate: { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 } };
  host.send(ice); assert.deepEqual(await viewer.next(), ice);
  const offer = { type: 'offer', description: { type: 'offer', sdp: 'v=0\r\n' } };
  host.send({ ...offer, to: 'arbitrary-ignored-target' }); assert.deepEqual(await viewer.next(), offer);
  viewer.send(offer); assert.equal((await viewer.next()).code, 'INVALID_SIGNAL');
  const answer = { type: 'answer', description: { type: 'answer', sdp: 'v=0\r\n' } };
  viewer.send(answer); assert.deepEqual(await host.next(), answer);
  viewer.send({ type: 'leave' });
  assert.equal((await host.next()).type, 'peer-left');
  assert.equal(server.rooms.size, 0);
  outsider.send({ type: 'join', roomId, secret });
  assert.equal((await outsider.next()).code, 'INVALID_INVITATION');
});
test('invalid JSON, malformed invitation objects, binary and cross-room signals do not crash server', async t => {
  const { connect } = await fixture(t);
  const a = await connect(), b = await connect();
  a.ws.send('{'); assert.equal((await a.next()).code, 'INVALID_MESSAGE');
  a.ws.send(Buffer.from('bad')); assert.equal((await a.next()).code, 'INVALID_MESSAGE');
  a.send({ type: 'join', roomId: { toString: 'bad' }, secret: {} }); assert.equal((await a.next()).code, 'INVALID_INVITATION');
  a.send({ type: 'create' }); await a.next();
  b.send({ type: 'create' }); await b.next();
  a.send({ type: 'offer', description: { type: 'offer', sdp: 'v=0' } }); assert.equal((await a.next()).code, 'PEER_UNAVAILABLE');
  a.send({ type: 'create' }); assert.equal((await a.next()).code, 'ALREADY_JOINED');
});
test('unknown browser origins are rejected', async t => {
  const { port } = await fixture(t);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/signal`, { origin: 'https://untrusted.example' });
  const [error] = await once(ws, 'error');
  assert.match(error.message, /403/);
});
test('abrupt socket closure cleans up room and notifies peer', async t => {
  const { connect, server } = await fixture(t);
  const host = await connect(), viewer = await connect();
  host.send({ type: 'create' });
  const [roomId, secret] = (await host.next()).invitation.split('.');
  viewer.send({ type: 'join', roomId, secret }); await viewer.next(); await host.next();
  host.ws.terminate();
  assert.equal((await viewer.next()).type, 'peer-left');
  assert.equal(server.rooms.size, 0);
});
