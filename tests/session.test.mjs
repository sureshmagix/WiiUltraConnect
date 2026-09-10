import test from 'node:test';
import assert from 'node:assert/strict';
import { PeerSession } from '../src/peer.js';
import { CHANNELS, validSessionMessage, MAX_CLIPBOARD } from '../src/session-messages.js';
import { addressScope, networkSummary } from '../src/protocol.js';
import { candidateAddresses } from '../src/direct-signaling.js';

class Channel extends EventTarget {
  constructor(label) { super(); this.label = label; this.readyState = 'connecting'; this.bufferedAmount = 0; this.sent = []; }
  send(value) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = 'closed'; this.onclose?.(); }
  open() { this.readyState = 'open'; this.onopen?.(); }
  receive(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
}
function fixture(t, role = 'host') {
  const old = globalThis.RTCPeerConnection;
  class FakePeer {
    constructor(config) { this.config = config; this.connectionState = 'new'; this.signalingState = 'stable'; }
    createDataChannel(name) { return new Channel(name); }
    addTrack(track) { return { track, replaceTrack: async next => { this.replaced = next; }, getParameters: () => ({ encodings: [{}] }), setParameters: async () => {} }; }
    close() { this.connectionState = 'closed'; }
  }
  globalThis.RTCPeerConnection = FakePeer;
  const track = { kind: 'video', readyState: 'live', stop() { this.readyState = 'ended'; } };
  const stream = { getVideoTracks: () => [track], getAudioTracks: () => [], getTracks: () => [track] };
  const peer = new PeerSession({ iceServers: [{ urls: 'turn:must-not-be-used.example' }] });
  peer.role = role; peer.stream = stream; peer.settings = {};
  peer.createPeer();
  if (role === 'viewer') for (const name of CHANNELS) peer.attachChannel(new Channel(name));
  t.after(() => { peer.close(); globalThis.RTCPeerConnection = old; });
  return { peer, track, stream, connect() { for (const c of Object.values(peer.channels)) c.open(); peer.pc.connectionState = 'connected'; peer.pc.onconnectionstatechange(); } };
}
test('host refuses an invitation before live display capture', async () => {
  const peer = new PeerSession();
  await assert.rejects(peer.createInvitation(null), /capture/);
  assert.equal(peer.phase, 'new');
});
test('configured external services are ignored and ready waits for every channel and the peer', t => {
  const { peer, connect } = fixture(t);
  assert.deepEqual(peer.pc.config.iceServers, []);
  for (const c of Object.values(peer.channels)) c.open();
  assert.equal(peer.ready, false);
  connect(); assert.equal(peer.ready, true);
  peer.channels.session.readyState = 'connecting'; assert.equal(peer.ready, false);
});
test('host rejects unapproved input, disconnect revokes permission and recovery does not restore it', t => {
  const { peer, connect } = fixture(t); connect();
  const events = []; peer.addEventListener('input', e => events.push(e.detail));
  const key = { type: 'key', action: 'down', code: 'KeyA' };
  peer.channels.input.receive(key); assert.deepEqual(events, []);
  peer.setControl(true); peer.channels.input.receive(key); assert.deepEqual(events, [key]);
  peer.pc.connectionState = 'disconnected'; peer.pc.onconnectionstatechange();
  assert.equal(peer.controlAllowed, false); assert.equal(peer.ready, false);
  peer.pc.connectionState = 'connected'; peer.pc.onconnectionstatechange();
  assert.equal(peer.controlAllowed, false); assert.equal(peer.ready, true);
});
test('viewer cannot send input without consent or after channel failure', t => {
  const { peer, connect } = fixture(t, 'viewer'); connect();
  assert.equal(peer.sendInput({ type: 'release' }), false);
  peer.channels.input.receive({ type: 'control-state', allowed: true });
  assert.equal(peer.sendInput({ type: 'release' }), true);
  peer.channels.session.close();
  assert.equal(peer.closed, true); assert.equal(peer.sendInput({ type: 'release' }), false);
});
test('monitor replacement awaits negotiation-safe replaceTrack before stopping old capture', async t => {
  const { peer, track, connect } = fixture(t); connect();
  let done;
  peer.videoSender.replaceTrack = () => new Promise(resolve => { done = resolve; });
  const next = { kind: 'video', readyState: 'live', stop() {} };
  const stream = { getVideoTracks: () => [next], getAudioTracks: () => [], getTracks: () => [next] };
  const replacing = peer.setStream(stream);
  assert.equal(track.readyState, 'live'); done(); await replacing;
  assert.equal(track.readyState, 'ended'); assert.equal(peer.stream, stream);
});
test('session commands enforce direction, known quality, consent for display switching and clipboard bounds', t => {
  assert.equal(validSessionMessage({ type: 'quality-request', quality: '__proto__' }, 'host'), false);
  assert.equal(validSessionMessage({ type: 'displays', selected: 'x', displays: [] }, 'host'), false);
  assert.equal(validSessionMessage({ type: 'clipboard', text: 'x'.repeat(MAX_CLIPBOARD + 1) }, 'host'), false);
  const { peer, connect } = fixture(t); connect();
  const events = []; peer.addEventListener('session-message', e => events.push(e.detail));
  const request = { type: 'display-request', id: 'screen:0:0' };
  peer.channels.session.receive(request); assert.deepEqual(events, []);
  peer.setControl(true); peer.channels.session.receive(request); assert.deepEqual(events, [request]);
  peer.channels.session.receive({ type: 'clipboard', text: 42 }); assert.equal(peer.closed, true);
});
test('network diagnostics distinguish LAN/CGNAT/link-local from possible public routes without probes', () => {
  for (const ip of ['192.168.1.2', '10.0.0.1', '172.16.0.5', '100.64.2.5', '169.254.1.4', 'fe80::abc%3', 'fd00::abc', '::1', 'device.local']) assert.equal(addressScope(ip), 'local', ip);
  assert.equal(addressScope('2001:4860:4860::8888'), 'public-ipv6');
  assert.equal(addressScope('8.8.8.8'), 'public-ipv4');
  assert.equal(addressScope('999.1.1.1'), 'unknown');
  assert.equal(networkSummary(['10.0.0.1']).publicAddress, false);
  assert.equal(networkSummary(['2001:4860::1']).publicAddress, true);
  assert.deepEqual(candidateAddresses('a=candidate:1 1 udp 123 192.168.1.2 55000 typ host\r\na=candidate:2 1 udp 123 2001:4860::1 55001 typ host\r\n'), ['192.168.1.2', '2001:4860::1']);
});
