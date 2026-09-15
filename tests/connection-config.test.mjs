import test from 'node:test';
import assert from 'node:assert/strict';
import { connectionConfig, connectionDiagnostics, connectionFailure } from '../src/connection-config.js';
import { decodePacket, encodePacket, offerFingerprint, validateAnswer, INVITATION_TTL } from '../src/direct-signaling.js';
import { PeerSession } from '../src/peer.js';

const settings = { mode: 'internet', stunUrls: 'stun:stun.example.com:3478', turnUrls: 'turn:relay.example.com:3478?transport=udp\nturns:relay.example.com:5349?transport=tcp', username: 'test-user', credential: 'test-password' };
const sdp = `v=0\r\na=fingerprint:sha-256 ${Array(32).fill('AA').join(':')}\r\na=ice-ufrag:test\r\na=ice-pwd:testing-password\r\na=candidate:1 1 udp 123 8.8.8.8 55000 typ relay\r\n`;
function invitation(version = 2) {
  const issuedAt = Date.now();
  return { version, kind: 'offer', sessionId: crypto.randomUUID(), issuedAt, expiresAt: issuedAt + INVITATION_TTL, description: { type: 'offer', sdp: version === 1 ? sdp.replace('typ relay', 'typ host') : sdp } };
}

test('internet settings are opt-in and support STUN, authenticated TURN UDP/TLS and relay-only', () => {
  assert.deepEqual(connectionConfig({ ...settings, mode: 'direct', relayOnly: true }).iceServers, []);
  assert.deepEqual(connectionConfig({ iceServers: [{ urls: 'turn:ignored.example' }] }).iceServers, []);
  const config = connectionConfig(settings);
  assert.equal(config.iceServers.length, 2);
  assert.equal(config.iceServers[1].credential, settings.credential);
  assert.deepEqual(config.iceServers[1].urls, settings.turnUrls.split('\n'));
  assert.equal(config.iceTransportPolicy, 'all');
  assert.equal(connectionConfig({ ...settings, relayOnly: true }).iceTransportPolicy, 'relay');
  assert.equal(connectionConfig({ ...settings, stunUrls: '' }).iceServers.length, 1);
  assert.equal(connectionConfig({ ...settings, turnUrls: '' }).iceServers.length, 1);
  assert.deepEqual(connectionConfig({ ...settings, stunUrls: 'stun:[2001:4860::1]:3478,stun:[2001:4860::1]:3478' }).iceServers[0].urls, ['stun:[2001:4860::1]:3478']);
});

test('invalid endpoints and incomplete relay settings fail before a peer is created without echoing secrets', () => {
  for (const turnUrls of ['https://relay.example', 'turn://relay.example', 'turn:secret@relay.example', 'turn:relay.example/path', 'turn:relay.example:0', 'turn:relay.example:65536', 'turn:relay.example?credential=secret', 'turns:relay.example?transport=udp']) {
    assert.throws(() => new PeerSession({ ...settings, turnUrls }), error => /Invalid TURN URL/.test(error.message) && !error.message.includes('secret'));
  }
  assert.throws(() => connectionConfig({ ...settings, stunUrls: 'turn:relay.example' }), /Invalid STUN/);
  assert.throws(() => connectionConfig({ ...settings, credential: '' }), /username and password/);
  assert.throws(() => connectionConfig({ ...settings, username: ' ' }), /username and password/);
  assert.throws(() => connectionConfig({ ...settings, turnUrls: '', relayOnly: true }), /requires a TURN/);
  assert.throws(() => connectionConfig({ mode: 'internet' }), /requires a STUN or TURN/);
  assert.throws(() => connectionConfig({ mode: 'unknown' }), /Choose/);
});

test('internet codes carry relay SDP and bind responses to mode and invitation', async () => {
  const offer = invitation(), code = encodePacket(offer);
  assert.match(code, /^WUC-INTERNET-2\./);
  assert.deepEqual(decodePacket(code, 'offer'), offer);
  const answer = { ...offer, kind: 'answer', offerHash: await offerFingerprint(offer), description: { type: 'answer', sdp } };
  await validateAnswer(decodePacket(encodePacket(answer), 'answer'), offer);
  const changed = { ...answer, version: 1, description: { type: 'answer', sdp: sdp.replace('typ relay', 'typ host') } };
  await assert.rejects(validateAnswer(changed, offer), /different invitation/);
  assert.throws(() => decodePacket(code.replace('WUC-INTERNET-2.', 'WUC-DIRECT-1.')), /mode/);
  assert.throws(() => encodePacket({ ...offer, version: 1 }), /Relay/);
});

test('remote invitations cannot enable internet services in a direct session or silently change modes', async () => {
  const direct = new PeerSession();
  await assert.rejects(direct.createResponse(encodePacket(invitation())), /Select that connection mode/);
  assert.equal(direct.pc, undefined);
  const internet = new PeerSession(settings);
  await assert.rejects(internet.createResponse(encodePacket(invitation(1))), /Select that connection mode/);
  assert.equal(internet.pc, undefined);
  direct.close(); internet.close();
});

test('host and viewer pass local internet settings into WebRTC and never put relay credentials in codes', async t => {
  const original = globalThis.RTCPeerConnection;
  class FakePeer extends EventTarget {
    constructor(config) { super(); this.config = config; this.iceGatheringState = 'complete'; this.connectionState = 'new'; }
    addTrack() { return {}; }
    createDataChannel(label) { return Object.assign(new EventTarget(), { label, readyState: 'connecting', close() {} }); }
    async createOffer() { return { type: 'offer', sdp }; }
    async createAnswer() { return { type: 'answer', sdp }; }
    async setLocalDescription(description) { this.localDescription = { ...description, toJSON: () => description }; }
    async setRemoteDescription(description) { this.remoteDescription = description; }
    close() { this.connectionState = 'closed'; }
  }
  globalThis.RTCPeerConnection = FakePeer;
  const host = new PeerSession({ ...settings, relayOnly: true }), viewer = new PeerSession(settings);
  t.after(() => { host.close(); viewer.close(); globalThis.RTCPeerConnection = original; });
  const track = { kind: 'video', readyState: 'live', stop() {} };
  const offerCode = await host.createInvitation({ getVideoTracks: () => [track], getTracks: () => [track] });
  const answerCode = await viewer.createResponse(offerCode);
  await host.applyResponse(answerCode);
  assert.equal(host.pc.config.iceTransportPolicy, 'relay');
  assert.equal(viewer.pc.config.iceServers[1].credential, settings.credential);
  for (const [code, kind] of [[offerCode, 'offer'], [answerCode, 'answer']]) {
    const packet = JSON.stringify(decodePacket(code, kind));
    assert.ok(!packet.includes(settings.credential));
    assert.ok(!packet.includes(settings.username));
    assert.ok(!packet.includes('iceServers'));
  }
  host.pc.connectionState = 'failed';
  const errors = []; host.addEventListener('error', e => errors.push(e.detail)); host.pc.onconnectionstatechange();
  assert.match(errors[0], /despite an available relay/);
  assert.equal(host.closed, true);
});

test('diagnostics distinguish STUN-only, missing TURN allocations and usable relay candidates', () => {
  const turn = connectionConfig(settings), stun = connectionConfig({ ...settings, turnUrls: '' });
  assert.equal(connectionDiagnostics(sdp, 'internet', turn).relay, true);
  assert.match(connectionDiagnostics(sdp.replace('typ relay', 'typ srflx'), 'internet', stun).message, /STUN discovered/);
  assert.match(connectionDiagnostics('', 'internet', turn).message, /No TURN relay address/);
  assert.match(connectionFailure('internet', stun), /without a TURN relay/);
  assert.match(connectionFailure('internet', turn), /did not provide a relay/);
  assert.match(connectionFailure('internet', turn, sdp), /despite an available relay/);
  assert.match(connectionFailure('direct', connectionConfig()), /New codes alone cannot fix/);
});
