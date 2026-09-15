import test from 'node:test';
import assert from 'node:assert/strict';
import { directIceConfig, decodePacket, encodePacket, offerFingerprint, validateAnswer, validatePacket, gatherComplete, INVITATION_TTL } from '../src/direct-signaling.js';
import { PeerSession } from '../src/peer.js';
const now = 1_800_000_000_000;
const sdp = `v=0\r\na=fingerprint:sha-256 ${Array(32).fill('AA').join(':')}\r\na=ice-ufrag:test\r\na=ice-pwd:testing-password\r\na=candidate:1 1 udp 123 192.168.1.2 55000 typ host\r\n`;
const offer = () => ({ version: 1, kind: 'offer', sessionId: crypto.randomUUID(), issuedAt: now, expiresAt: now + INVITATION_TTL, description: { type: 'offer', sdp } });
test('offline codes round-trip complete SDP and accept wrapped clipboard text', () => {
  const original = offer(), code = encodePacket(original, now);
  assert.deepEqual(decodePacket(`\n ${code.slice(0, 100)}\n${code.slice(100)} `, 'offer', now), original);
  assert.throws(() => decodePacket(code, 'answer', now), /valid viewer response/);
  assert.throws(() => decodePacket('bad', 'offer', now));
  assert.throws(() => decodePacket('WUC-DIRECT-1.e30', 'offer', now));
});
test('expired, oversized, incomplete and relayed descriptions are rejected', () => {
  assert.throws(() => validatePacket(offer(), 'offer', now + INVITATION_TTL), /expired/);
  const invalid = offer(); invalid.description.sdp = 'v=0\r\n';
  assert.throws(() => validatePacket(invalid, 'offer', now), /incomplete/);
  const relay = offer(); relay.description.sdp = sdp.replace('typ host', 'typ relay');
  assert.throws(() => validatePacket(relay, 'offer', now), /Relay/);
  assert.throws(() => decodePacket('x'.repeat(110_000), 'offer', now), /too large/);
  const future = offer(); future.issuedAt += 70_000; future.expiresAt += 70_000;
  assert.throws(() => validatePacket(future, 'offer', now), /clock/);
});
test('answer is bound to the exact invitation and rejects another session or changed SDP', async () => {
  const original = offer();
  const response = { ...original, kind: 'answer', description: { type: 'answer', sdp }, offerHash: await offerFingerprint(original) };
  await validateAnswer(decodePacket(encodePacket(response, now), 'answer', now), original, now);
  await assert.rejects(validateAnswer(response, offer(), now), /different invitation/);
  const changed = structuredClone(original); changed.description.sdp += 'a=changed:1\r\n';
  await assert.rejects(validateAnswer(response, changed, now), /different invitation/);
});
test('ICE configuration never includes external services even when legacy settings are supplied', () => {
  const config = directIceConfig({ iceServers: [{ urls: 'turn:untrusted.example' }] });
  assert.deepEqual(config.iceServers, []);
  assert.equal(config.iceTransportPolicy, 'all');
});
test('host rejects concurrent and repeated responses and does not reapply remote SDP', async t => {
  const original = offer(); original.issuedAt = Date.now(); original.expiresAt = original.issuedAt + INVITATION_TTL;
  const response = { ...original, kind: 'answer', description: { type: 'answer', sdp }, offerHash: await offerFingerprint(original) };
  const peer = new PeerSession({}); let calls = 0, release;
  peer.role = 'host'; peer.phase = 'awaiting-answer'; peer.offer = original;
  peer.pc = { setRemoteDescription: async () => { ++calls; await new Promise(resolve => { release = resolve; }); }, close() {} };
  t.after(() => peer.close());
  const code = encodePacket(response);
  const applying = peer.applyResponse(code);
  await assert.rejects(peer.applyResponse(code), /no longer waiting/);
  while (!release) await new Promise(resolve => setTimeout(resolve, 1));
  release(); await applying;
  await assert.rejects(peer.applyResponse(code), /no longer waiting/);
  assert.equal(calls, 1);
});
class FakePeer extends EventTarget { iceGatheringState = 'gathering'; connectionState = 'new'; }
test('ICE export waits for gathering completion, including already-complete state', async () => {
  const pc = new FakePeer(); let done = false;
  const wait = gatherComplete(pc).then(() => { done = true; });
  await Promise.resolve(); assert.equal(done, false);
  pc.iceGatheringState = 'complete'; pc.dispatchEvent(new Event('icegatheringstatechange'));
  await wait; assert.equal(done, true);
  await gatherComplete(pc);
});
test('cancelling, closing or timing out gathering rejects without leaving a pending wait', async () => {
  const pc = new FakePeer(), abort = new AbortController();
  const wait = gatherComplete(pc, abort.signal); abort.abort(); await assert.rejects(wait, /cancelled/);
  await assert.rejects(gatherComplete(pc, undefined, 5), /timed out/);
  const closing = gatherComplete(pc); pc.connectionState = 'closed'; pc.dispatchEvent(new Event('connectionstatechange'));
  await assert.rejects(closing, /cancelled/);
});

test('internet gathering exports a usable snapshot before stalled interfaces exhaust connection checks', async () => {
  const pc = new FakePeer(); pc.localDescription = { sdp: '' };
  let finished = false;
  const wait = gatherComplete(pc, undefined, 1000, { canExport: sdp => sdp.includes('typ relay'), settleMs: 5 }).then(() => { finished = true; });
  pc.localDescription.sdp = 'a=candidate:1 1 udp 1 10.0.0.1 5000 typ host';
  pc.dispatchEvent(new Event('icecandidate'));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(finished, false);
  pc.localDescription.sdp += '\na=candidate:2 1 udp 1 8.8.8.8 5001 typ relay';
  pc.dispatchEvent(new Event('icecandidate'));
  await wait;
  assert.equal(pc.iceGatheringState, 'gathering');
  assert.equal(finished, true);
});

test('cancellation still wins while an internet candidate snapshot is settling', async () => {
  const pc = new FakePeer(), abort = new AbortController();
  const wait = gatherComplete(pc, abort.signal, 1000, { canExport: () => true, settleMs: 10 });
  abort.abort();
  await assert.rejects(wait, /cancelled/);
});
