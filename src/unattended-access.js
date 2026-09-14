const DEVICE_ID_PATTERN = /^wuc-[a-z0-9]{20,64}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const encoder = new TextEncoder();

export function normalizeBrokerUrl(value) {
  let url;
  try { url = new URL(String(value).trim()); } catch { throw new Error('Enter a valid signaling server URL.'); }
  if (!['ws:', 'wss:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error('Use a ws:// or wss:// signaling URL without credentials, query parameters or fragments.');
  }
  if (url.protocol === 'ws:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('Use wss:// for an internet signaling server. ws:// is only allowed for local development.');
  }
  url.pathname = url.pathname === '/' ? '/ws' : url.pathname.replace(/\/$/, '');
  if (url.pathname !== '/ws') throw new Error('The signaling server URL must end in /ws.');
  return url.href;
}

export function validDeviceId(value) {
  return DEVICE_ID_PATTERN.test(String(value));
}

export function validAccessVerifier(value) {
  return typeof value === 'string' && value.length >= 32 && value.length <= 128 && BASE64URL_PATTERN.test(value);
}

export function accessPasswordError(value) {
  if (typeof value !== 'string' || value.length < 12) return 'Use an unattended-access password with at least 12 characters.';
  if (value.length > 128) return 'The unattended-access password is too long.';
  return '';
}

function base64url(bytes) {
  let value = '';
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export async function accessVerifier(deviceId, password) {
  if (!validDeviceId(deviceId)) throw new Error('The computer ID is invalid.');
  const error = accessPasswordError(password);
  if (error) throw new Error(error);
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: encoder.encode(`WiiUltraConnect unattended ${deviceId}`), iterations: 210000 }, material, 256);
  return base64url(new Uint8Array(bits));
}
