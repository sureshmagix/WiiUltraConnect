import test from 'node:test';
import assert from 'node:assert/strict';
import { FileTransfer, waitForCapacity } from '../src/file-transfer.js';
import { encodeChunk } from '../src/protocol.js';
class Channel extends EventTarget {
  readyState = 'open'; bufferedAmount = 0; sent = [];
  send(data) { this.sent.push(data); queueMicrotask(() => { if (this.peer?.readyState === 'open') this.peer.dispatchEvent(new MessageEvent('message', { data })); }); }
  close() { this.readyState = 'closed'; this.dispatchEvent(new Event('close')); }
}
const until = async fn => { for (let i = 0; i < 200; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 5)); } throw new Error('Timed out waiting for transfer'); };
function pair(t, accept = async () => true) {
  const a = new Channel(), b = new Channel(); a.peer = b; b.peer = a;
  const received = [], events = [], errors = [];
  const sender = new FileTransfer(a, { accept, onFile: file => received.push(file), onProgress: e => events.push(e), onError: e => errors.push(e) });
  const receiver = new FileTransfer(b, { accept, onFile: file => received.push(file), onProgress: e => events.push(e), onError: e => errors.push(e) });
  t.after(() => { sender.dispose(); receiver.dispose(); });
  return { sender, receiver, a, b, received, events, errors };
}
test('chunked binary transfer reassembles exactly and acknowledges receipt', async t => {
  const { sender, received, events, errors } = pair(t);
  const data = Uint8Array.from({ length: 90000 }, (_, i) => i % 251);
  sender.send(new File([data], 'example.bin'));
  await until(() => events.some(e => e.status === 'Delivered'));
  assert.deepEqual(new Uint8Array(await received[0].blob.arrayBuffer()), data);
  assert.equal(errors.length, 0);
  assert.ok(events.some(e => e.status === 'Waiting for receipt'));
});
test('zero-byte files complete and simultaneous transfers work in both directions', async t => {
  const { sender, receiver, received, events } = pair(t);
  sender.send(new File([], 'zero.bin')); receiver.send(new File(['hello'], 'return.txt'));
  await until(() => events.filter(e => e.status === 'Delivered').length === 2);
  assert.equal(received.length, 2);
  assert.deepEqual(received.map(v => v.blob.size).sort((a, b) => a - b), [0, 5]);
});
test('declining an offer sends no file bytes', async t => {
  const { sender, a, events } = pair(t, async () => false);
  sender.send(new File(['private'], 'decline.txt'));
  await until(() => !sender.outgoing);
  assert.ok(events.some(e => e.status === 'Declined'));
  assert.ok(a.sent.every(m => typeof m === 'string'));
});
test('backpressure waits for drain and rejects on abort or channel closure', async () => {
  const channel = new Channel(); channel.bufferedAmount = 500000;
  let resolved = false;
  const waiting = waitForCapacity(channel).then(() => { resolved = true; });
  await Promise.resolve(); assert.equal(resolved, false);
  channel.bufferedAmount = 0; channel.dispatchEvent(new Event('bufferedamountlow'));
  await waiting; assert.equal(resolved, true);
  channel.bufferedAmount = 500000;
  const abort = new AbortController(); const cancelled = waitForCapacity(channel, abort.signal); abort.abort();
  await assert.rejects(cancelled, /cancelled/);
  const closed = waitForCapacity(channel); channel.close(); await assert.rejects(closed, /closed/);
});
test('receiver rejects corrupt offsets and releases partial data', async t => {
  const channel = new Channel();
  const receiver = new FileTransfer(channel, { accept: async () => true }); t.after(() => receiver.dispose());
  const id = crypto.randomUUID();
  await receiver.receive(JSON.stringify({ type: 'file-offer', id, name: 'broken', size: 4 }));
  await assert.rejects(receiver.receive(encodeChunk(id, 1, new Uint8Array([1]).buffer)), /does not match/);
  receiver.dispose(); assert.equal(receiver.incoming, null);
});
test('cancellation during acceptance ignores late acceptance and permits a fresh transfer', async t => {
  let answer;
  const { sender, receiver, received } = pair(t, () => new Promise(resolve => { answer = resolve; }));
  const id = sender.send(new File(['cancel'], 'test.txt'));
  await until(() => Boolean(answer));
  sender.cancel(id); await until(() => !receiver.incoming);
  answer(true); await Promise.resolve();
  assert.equal(sender.outgoing, null); assert.equal(receiver.incoming, null);
  receiver.accept = async () => true;
  sender.send(new File(['fresh transfer'], 'new.txt'));
  await until(() => received.length === 1);
  assert.equal(await received[0].blob.text(), 'fresh transfer');
});
