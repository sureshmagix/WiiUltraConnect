export const CHANNELS = ['chat', 'files', 'input', 'session'];
export const MAX_CLIPBOARD = 16000;
export const QUALITY = Object.freeze({ economy: { bitrate: 2, fps: 15 }, balanced: { bitrate: 4, fps: 30 }, smooth: { bitrate: 8, fps: 60 } });

export function validSessionMessage(m, role) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return false;
  if (m.type === 'clipboard') return typeof m.text === 'string' && m.text.length > 0 && m.text.length <= MAX_CLIPBOARD;
  if (m.type === 'control-request' || m.type === 'control-release') return role === 'host';
  if (m.type === 'display-request') return role === 'host' && typeof m.id === 'string' && m.id.length <= 256;
  if (m.type === 'quality-request') return role === 'host' && Object.hasOwn(QUALITY, m.quality);
  if (m.type === 'displays') return role === 'viewer' && Array.isArray(m.displays) && m.displays.length <= 32 && m.displays.every(d => typeof d.id === 'string' && d.id.length <= 256 && typeof d.name === 'string' && d.name.length <= 256) && typeof m.selected === 'string' && m.selected.length <= 256;
  if (m.type === 'quality') return role === 'viewer' && (m.quality === 'custom' || Object.hasOwn(QUALITY, m.quality));
  return false;
}
