export const MAX_FILE_SIZE = 128 * 1024 * 1024;
export const CHUNK_SIZE = 16 * 1024;
export const HEADER_SIZE = 20;
export const MAX_CHAT_LENGTH = 4000;
export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const ROOM_CODE_REGEX = /^[0-9]{3}-?[0-9]{3}$|^[0-9]{3}-?[0-9]{3}-?[0-9]{3}$|^[a-zA-Z0-9_-]{4,16}$/;

export function formatRoomCode(code) {
  const digits = String(code || '').replace(/[^0-9]/g, '');
  if (digits.length === 6) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
  if (digits.length === 9) return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  return String(code || '').trim();
}

export function sanitizeRoomCode(code) {
  if (!code || typeof code !== 'string') return '';
  const digits = code.replace(/[^0-9]/g, '');
  if (digits.length === 6) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
  if (digits.length === 9) return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  return code.trim();
}

export function isPrivateIP(ip) {
  if (!ip || typeof ip !== 'string') return false;
  return ip.startsWith('192.168.') ||
         ip.startsWith('10.') ||
         ip.startsWith('127.') ||
         /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip) ||
         ip === '::1' ||
         ip.startsWith('fe80:');
}

export function determineRouteType(candidatePair, localCandidate, remoteCandidate) {
  if (!candidatePair) return 'Direct P2P';
  if (localCandidate?.candidateType === 'relay' || remoteCandidate?.candidateType === 'relay') {
    return 'TURN Relay';
  }
  const localIp = localCandidate?.address || localCandidate?.ip;
  const remoteIp = remoteCandidate?.address || remoteCandidate?.ip;
  if (localCandidate?.candidateType === 'host' && remoteCandidate?.candidateType === 'host') {
    if (isPrivateIP(localIp) && isPrivateIP(remoteIp)) {
      return 'Local LAN (Direct)';
    }
  }
  if (localCandidate?.candidateType === 'srflx' || remoteCandidate?.candidateType === 'srflx') {
    return 'Internet WAN (STUN P2P)';
  }
  return 'Direct P2P';
}

export function safeFileName(name) {
  return String(name).split(/[\\/]/).pop().replace(/[\x00-\x1f<>:"|?*]/g, '_').slice(0, 180) || 'received-file';
}

export function validFileOffer(m) {
  return m?.type === 'file-offer' && UUID.test(m.id) && typeof m.name === 'string' && m.name.length <= 255 &&
    Number.isSafeInteger(m.size) && m.size >= 0 && m.size <= MAX_FILE_SIZE;
}

export function encodeChunk(id, offset, buffer) {
  if (!UUID.test(id)) throw new Error('Invalid transfer ID');
  const bytes = id.replaceAll('-', '').match(/../g).map(v => parseInt(v, 16));
  const packet = new Uint8Array(HEADER_SIZE + buffer.byteLength);
  packet.set(bytes);
  new DataView(packet.buffer).setUint32(16, offset);
  packet.set(new Uint8Array(buffer), HEADER_SIZE);
  return packet.buffer;
}

export function decodeChunk(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength <= HEADER_SIZE || buffer.byteLength > HEADER_SIZE + CHUNK_SIZE) throw new Error('Invalid binary chunk');
  const hex = [...new Uint8Array(buffer, 0, 16)].map(v => v.toString(16).padStart(2, '0')).join('');
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return { id, offset: new DataView(buffer).getUint32(16), data: buffer.slice(HEADER_SIZE) };
}

// object-fit: contain leaves letterboxing; normalize against the actual video image.
export function normalizedPoint(clientX, clientY, rect, videoWidth, videoHeight, clamp = false) {
  if (!videoWidth || !videoHeight || !rect.width || !rect.height) return null;
  const scale = Math.min(rect.width / videoWidth, rect.height / videoHeight);
  const width = videoWidth * scale, height = videoHeight * scale;
  const x = (clientX - rect.left - (rect.width - width) / 2) / width;
  const y = (clientY - rect.top - (rect.height - height) / 2) / height;
  if (!clamp && (x < 0 || x > 1 || y < 0 || y > 1)) return null;
  return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
}
