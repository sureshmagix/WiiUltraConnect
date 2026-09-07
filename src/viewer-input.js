import { normalizedPoint } from './protocol.js';

export class ViewerInput {
  constructor(video, send) {
    this.video = video;
    this.send = send;
    this.enabled = false;
    this.abort = new AbortController();
    this.buttons = new Set();
    const listen = (target, name, fn, options = {}) => target.addEventListener(name, fn, { ...options, signal: this.abort.signal });
    const point = event => normalizedPoint(event.clientX, event.clientY, video.getBoundingClientRect(), video.videoWidth, video.videoHeight, this.buttons.size > 0);
    const flush = () => { if (this.move) { this.send(this.move); this.move = null; } };
    listen(video, 'pointermove', event => {
      if (!this.enabled) return;
      const p = point(event);
      if (!p) return;
      this.move = { type: 'pointer', action: 'move', ...p };
      if (!this.frame) this.frame = requestAnimationFrame(() => { this.frame = null; flush(); });
    });
    for (const [name, action] of [['pointerdown', 'down'], ['pointerup', 'up']]) listen(video, name, event => {
      if (!this.enabled || ![0, 1, 2].includes(event.button)) return;
      const p = point(event);
      if (!p) return;
      event.preventDefault();
      video.focus();
      flush();
      if (action === 'down') { this.buttons.add(event.button); video.setPointerCapture(event.pointerId); }
      this.send({ type: 'pointer', action, button: event.button, ...p });
      if (action === 'up') { this.buttons.delete(event.button); if (!this.buttons.size && video.hasPointerCapture(event.pointerId)) video.releasePointerCapture(event.pointerId); }
    });
    listen(video, 'pointercancel', () => this.release());
    listen(video, 'lostpointercapture', () => { if (this.buttons.size) this.release(); });
    listen(video, 'contextmenu', event => { if (this.enabled) event.preventDefault(); });
    listen(video, 'wheel', event => {
      if (!this.enabled || document.activeElement !== video) return;
      event.preventDefault();
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? video.clientHeight : 1;
      this.send({ type: 'wheel', dy: Math.max(-1200, Math.min(1200, event.deltaY * scale)) });
    }, { passive: false });
    for (const [name, action] of [['keydown', 'down'], ['keyup', 'up']]) listen(video, name, event => {
      if (!this.enabled || document.activeElement !== video) return;
      event.preventDefault();
      if (event.code === 'Escape' && (event.ctrlKey || event.metaKey) && event.shiftKey) { this.release(); video.blur(); return; }
      if (!event.repeat) this.send({ type: 'key', action, code: event.code });
    });
    listen(video, 'blur', () => this.release());
    listen(window, 'blur', () => this.release());
    listen(document, 'visibilitychange', () => { if (document.hidden) this.release(); });
  }
  release() {
    cancelAnimationFrame(this.frame);
    this.frame = null;
    this.move = null;
    this.buttons.clear();
    if (this.enabled) this.send({ type: 'release' });
  }
  setEnabled(enabled) {
    if (!enabled) this.release();
    this.enabled = enabled;
    this.video.classList.toggle('remote-active', enabled);
  }
  dispose() { this.setEnabled(false); this.abort.abort(); }
}
