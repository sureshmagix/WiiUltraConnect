import test from 'node:test';
import assert from 'node:assert/strict';
import { directIceConfig, decodePacket, encodePacket, offerFingerprint, sessionVerificationCode, validateAnswer, validatePacket, gatherComplete, INVITATION_TTL } from '../src/direct-signaling.js';
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
test('session verification display binds both invitation and response', async () => {
  const original = offer();
  const response = { ...original, kind: 'answer', offerHash: await offerFingerprint(original), description: { type: 'answer', sdp } };
  const code = await sessionVerificationCode(original, response);
  assert.match(code, /^(?:[0-9A-F]{4}-){5}[0-9A-F]{4}$/);
  assert.equal(await sessionVerificationCode(structuredClone(original), structuredClone(response)), code);
  const changed = structuredClone(original); changed.description.sdp += 'a=changed:1\r\n';
  assert.notEqual(await sessionVerificationCode(changed, response), code);
  const changedResponse = structuredClone(response); changedResponse.description.sdp += 'a=changed:1\r\n';
  assert.notEqual(await sessionVerificationCode(original, changedResponse), code);
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
test('a malformed response flood leaves an invitation available and never reaches the peer connection', async t => {
  const peer = new PeerSession({}); let calls = 0;
  peer.role = 'host'; peer.phase = 'awaiting-answer'; peer.offer = offer();
  peer.offer.issuedAt = Date.now(); peer.offer.expiresAt = peer.offer.issuedAt + INVITATION_TTL;
  peer.pc = { setRemoteDescription: async () => { ++calls; }, close() {} };
  t.after(() => peer.close());
  for (let index = 0; index < 400; index += 1) await assert.rejects(peer.applyResponse(`WUC-DIRECT-1.${index}`), /connection code|damaged|valid viewer response/);
  assert.equal(calls, 0);
  assert.equal(peer.phase, 'awaiting-answer');
});
test('host review validates an answer without applying it and derives the viewer code', async t => {
  const peer = new PeerSession({});
  peer.role = 'host'; peer.phase = 'awaiting-answer'; peer.offer = offer();
  peer.offer.issuedAt = Date.now(); peer.offer.expiresAt = peer.offer.issuedAt + INVITATION_TTL;
  peer.pc = { setRemoteDescription: async () => assert.fail('review must not set a remote description'), close() {} };
  t.after(() => peer.close());
  const answer = { ...peer.offer, kind: 'answer', offerHash: await offerFingerprint(peer.offer), description: { type: 'answer', sdp } };
  const code = encodePacket(answer);
  assert.equal(await peer.reviewResponse(code), await sessionVerificationCode(peer.offer, answer));
  assert.equal(peer.phase, 'awaiting-answer');
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
