const KEY_NAMES = {
  Enter: 'Enter', Escape: 'Escape', Backspace: 'Backspace', Tab: 'Tab', Space: 'Space',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  ShiftLeft: 'LeftShift', ShiftRight: 'RightShift', ControlLeft: 'LeftControl', ControlRight: 'RightControl',
  AltLeft: 'LeftAlt', AltRight: 'RightAlt', MetaLeft: 'LeftSuper', MetaRight: 'RightSuper',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Delete: 'Delete', Insert: 'Insert',
  CapsLock: 'CapsLock', Minus: 'Minus', Equal: 'Equal', BracketLeft: 'LeftBracket', BracketRight: 'RightBracket',
  Backslash: 'Backslash', Semicolon: 'Semicolon', Quote: 'Quote', Backquote: 'Grave', Comma: 'Comma', Period: 'Period', Slash: 'Slash'
};
for (let i = 65; i <= 90; i++) KEY_NAMES[`Key${String.fromCharCode(i)}`] = String.fromCharCode(i);
for (let i = 0; i < 10; i++) KEY_NAMES[`Digit${i}`] = `Num${i}`;
for (let i = 1; i <= 12; i++) KEY_NAMES[`F${i}`] = `F${i}`;

function validInput(m) {
  if (!m || typeof m !== 'object') return false;
  if (m.type === 'release' || m.type === 'heartbeat') return true;
  if (m.type === 'key') return Object.hasOwn(KEY_NAMES, m.code) && ['down', 'up'].includes(m.action);
  if (m.type === 'wheel') return Number.isFinite(m.dy) && Math.abs(m.dy) <= 1200;
  if (m.type !== 'pointer' || !['move', 'down', 'up'].includes(m.action)) return false;
  return Number.isFinite(m.x) && m.x >= 0 && m.x <= 1 && Number.isFinite(m.y) && m.y >= 0 && m.y <= 1 &&
    (m.action === 'move' || [0, 1, 2].includes(m.button));
}

class InputController {
  constructor({ loadNative, toPoint, onError = () => {} }) {
    this.loadNative = loadNative;
    this.toPoint = toPoint;
    this.onError = onError;
    this.enabled = false;
    this.epoch = 0;
    this.pending = 0;
    this.tail = Promise.resolve();
    this.keys = new Set();
    this.buttons = new Set();
    this.lastEvent = 0;
    this.watchdog = setInterval(() => {
      if (this.enabled && Date.now() - this.lastEvent > 2500 && (this.keys.size || this.buttons.size)) this.enqueue({ type: 'release' });
    }, 1000);
    this.watchdog.unref();
  }
  async grant(bounds) {
    await this.revoke();
    this.native ||= await this.loadNative();
    this.native.keyboard.config.autoDelayMs = 0;
    this.native.mouse.config.autoDelayMs = 0;
    this.bounds = bounds;
    this.enabled = true;
    this.lastEvent = Date.now();
  }
  async releaseHeld() {
    if (!this.native) return;
    const errors = [];
    for (const key of this.keys) {
      try { await this.native.keyboard.releaseKey(key); this.keys.delete(key); } catch (error) { errors.push(error); }
    }
    for (const button of this.buttons) {
      try { await this.native.mouse.releaseButton(button); this.buttons.delete(button); } catch (error) { errors.push(error); }
    }
    if (errors.length) this.onError(new Error('Some held inputs could not be released. Check the host keyboard and mouse.'));
  }
  revoke() {
    this.enabled = false;
    ++this.epoch; // Invalidates queued input before awaiting any native operation.
    this.tail = this.tail.catch(() => {}).then(() => this.releaseHeld());
    return this.tail;
  }
  enqueue(m) {
    if (!this.enabled || !validInput(m)) return false;
    if (m.type === 'heartbeat') { this.lastEvent = Date.now(); return true; }
    if (this.pending >= 128) { void this.revoke(); this.onError(new Error('Remote control stopped: input queue overflow.')); return false; }
    const epoch = this.epoch;
    ++this.pending;
    this.lastEvent = Date.now();
    this.tail = this.tail.then(async () => {
      if (!this.enabled || epoch !== this.epoch) return;
      const n = this.native;
      if (m.type === 'release') return this.releaseHeld();
      if (m.type === 'pointer') {
        const point = this.toPoint(this.bounds, m.x, m.y);
        await n.mouse.setPosition(new n.Point(point.x, point.y));
        if (!this.enabled || epoch !== this.epoch) return;
        const button = [n.Button.LEFT, n.Button.MIDDLE, n.Button.RIGHT][m.button];
        if (m.action === 'down' && !this.buttons.has(button)) { this.buttons.add(button); await n.mouse.pressButton(button); }
        if (m.action === 'up' && this.buttons.has(button)) { await n.mouse.releaseButton(button); this.buttons.delete(button); }
      } else if (m.type === 'key') {
        const key = n.Key[KEY_NAMES[m.code]];
        if (key === undefined) return;
        if (m.action === 'down' && !this.keys.has(key)) { this.keys.add(key); await n.keyboard.pressKey(key); }
        if (m.action === 'up' && this.keys.has(key)) { await n.keyboard.releaseKey(key); this.keys.delete(key); }
      } else if (m.type === 'wheel' && m.dy !== 0) {
        await n.mouse[m.dy > 0 ? 'scrollDown' : 'scrollUp'](Math.max(1, Math.min(10, Math.round(Math.abs(m.dy) / 100))));
      }
    }).catch(async error => {
      this.enabled = false;
      ++this.epoch;
      await this.releaseHeld();
      this.onError(error);
    }).finally(() => { --this.pending; });
    return true;
  }
  async dispose() { clearInterval(this.watchdog); await this.revoke(); }
}
module.exports = { InputController, validInput, KEY_NAMES };
