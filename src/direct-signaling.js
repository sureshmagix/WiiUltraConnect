// Offline, non-trickle signaling. No socket, HTTP request or listener is created here.
const PREFIX = 'WUC-DIRECT-1.';
const MAX_SDP = 64 * 1024;
const MAX_CODE = 100 * 1024;
export const INVITATION_TTL = 10 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const object = value => value && typeof value === 'object' && !Array.isArray(value);

export function directIceConfig() {
  return {
    // Strict zero-service version: configuration cannot inject STUN or TURN endpoints.
    iceServers: [],
    iceTransportPolicy: 'all', bundlePolicy: 'max-bundle'
  };
}

export function candidateAddresses(sdp) {
  return [...String(sdp).matchAll(/^a=candidate:\S+\s+\d+\s+\S+\s+\d+\s+(\S+)\s+\d+/gm)].map(match => match[1]);
}
export function validatePacket(packet, expectedKind, now = Date.now()) {
  if (!object(packet) || packet.version !== 1 || !['offer', 'answer'].includes(packet.kind) || (expectedKind && packet.kind !== expectedKind)) throw new Error(`Paste a valid ${expectedKind === 'answer' ? 'viewer response' : 'host invitation'} from WiiUltraConnect Direct.`);
  if (typeof packet.sessionId !== 'string' || !UUID.test(packet.sessionId)) throw new Error('Invalid direct session ID.');
  if (!Number.isSafeInteger(packet.issuedAt) || !Number.isSafeInteger(packet.expiresAt) || packet.issuedAt > now + 60_000 || packet.expiresAt <= now || packet.expiresAt <= packet.issuedAt || packet.expiresAt - packet.issuedAt > INVITATION_TTL) throw new Error('The invitation has expired or its clock is invalid. Create a new invitation and check both device clocks.');
  const description = packet.description;
  if (!object(description) || description.type !== packet.kind || typeof description.sdp !== 'string' || description.sdp.length > MAX_SDP || !description.sdp.startsWith('v=0') || !/^a=fingerprint:sha-256 (?:[0-9a-f]{2}:){31}[0-9a-f]{2}\r?$/im.test(description.sdp) || !/^a=ice-ufrag:/m.test(description.sdp) || !/^a=ice-pwd:/m.test(description.sdp)) throw new Error('Invalid or incomplete WebRTC connection description.');
  if (!/^a=candidate:/m.test(description.sdp)) throw new Error('No network addresses were found. Check the network and create a new invitation.');
  if (/^a=candidate:.*\btyp\s+relay\b/im.test(description.sdp)) throw new Error('Relay candidates are not allowed in the direct version.');
  if (packet.kind === 'answer' && (typeof packet.offerHash !== 'string' || !/^[0-9a-f]{64}$/.test(packet.offerHash))) throw new Error('The viewer response is missing its invitation fingerprint.');
  return packet;
}
export function encodePacket(packet, now = Date.now()) {
  validatePacket(packet, packet.kind, now);
  const bytes = new TextEncoder().encode(JSON.stringify(packet));
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  const code = PREFIX + btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  if (code.length > MAX_CODE) throw new Error('Connection code is too large.');
  return code;
}
export function decodePacket(code, expectedKind, now = Date.now()) {
  if (typeof code !== 'string' || code.length > MAX_CODE + 1024) throw new Error('Connection code is too large.');
  const compact = code.replace(/\s/g, ''); // Supports wrapped clipboard/email text.
  if (!compact.startsWith(PREFIX) || compact.length > MAX_CODE || !/^[A-Za-z0-9_-]+$/.test(compact.slice(PREFIX.length))) throw new Error('Paste the complete WiiUltraConnect Direct connection code.');
  let packet;
  try {
    const binary = atob(compact.slice(PREFIX.length).replaceAll('-', '+').replaceAll('_', '/'));
    packet = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, c => c.charCodeAt(0))));
  } catch { throw new Error('The connection code is damaged or incomplete. Copy it again.'); }
  return validatePacket(packet, expectedKind, now);
}
export async function offerFingerprint(offer) {
  // Bind the response to the exact session, lifetime and SDP that the host generated.
  const canonical = JSON.stringify([offer.version, offer.sessionId, offer.issuedAt, offer.expiresAt, offer.description.sdp]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export async function validateAnswer(answer, offer, now = Date.now()) {
  validatePacket(answer, 'answer', now);
  validatePacket(offer, 'offer', now);
  if (answer.sessionId !== offer.sessionId || answer.issuedAt !== offer.issuedAt || answer.expiresAt !== offer.expiresAt || answer.offerHash !== await offerFingerprint(offer)) throw new Error('This response belongs to a different invitation. Ask the viewer to use your current invitation.');
}
export function gatherComplete(pc, signal, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', check);
      pc.removeEventListener('connectionstatechange', check);
      signal?.removeEventListener('abort', aborted);
    };
    const finish = error => { cleanup(); error ? reject(error) : resolve(); };
    const aborted = () => finish(new Error('Direct connection setup was cancelled.'));
    const check = () => {
      if (signal?.aborted || pc.connectionState === 'closed') return aborted();
      if (pc.iceGatheringState === 'complete') finish();
    };
    pc.addEventListener('icegatheringstatechange', check);
    pc.addEventListener('connectionstatechange', check);
    signal?.addEventListener('abort', aborted, { once: true });
    timer = setTimeout(() => finish(new Error('Network address discovery timed out. Check the network and try again.')), timeoutMs);
    check();
  });
}
