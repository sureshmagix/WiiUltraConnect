import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { InputController, validInput } = createRequire(import.meta.url)('../electron/input-controller.cjs');
function fixture(t) {
  const calls = [];
  const native = {
    Key: { A: 1, LeftControl: 2 }, Button: { LEFT: 0, MIDDLE: 1, RIGHT: 2 }, Point: class { constructor(x, y) { this.x = x; this.y = y; } },
    keyboard: { config: {}, pressKey: async key => calls.push(['down', key]), releaseKey: async key => calls.push(['up', key]) },
    mouse: { config: {}, setPosition: async point => calls.push(['move', point.x, point.y]), pressButton: async b => calls.push(['press', b]), releaseButton: async b => calls.push(['release', b]), scrollDown: async n => calls.push(['wheel', n]) }
  };
  const controller = new InputController({ loadNative: async () => native, toPoint: (b, x, y) => ({ x: b.x + x * (b.width - 1), y: b.y + y * (b.height - 1) }) });
  t.after(() => controller.dispose());
  return { controller, native, calls };
}
test('input requires host grant and rejects out-of-range coordinates and arbitrary keys', async t => {
  const { controller, calls } = fixture(t);
  assert.equal(controller.enqueue({ type: 'key', code: 'KeyA', action: 'down' }), false);
  assert.equal(validInput({ type: 'pointer', action: 'move', x: NaN, y: 1 }), false);
  assert.equal(validInput({ type: 'pointer', action: 'down', x: 1.1, y: .5, button: 0 }), false);
  assert.equal(validInput({ type: 'key', action: 'down', code: '__proto__' }), false);
  await controller.grant({ x: -1920, y: 0, width: 1920, height: 1080 });
  controller.enqueue({ type: 'pointer', action: 'down', x: 1, y: 1, button: 0 });
  controller.enqueue({ type: 'key', action: 'down', code: 'KeyA' });
  await controller.tail;
  await controller.revoke();
  assert.deepEqual(calls, [['move', -1, 1079], ['press', 0], ['down', 1], ['up', 1], ['release', 0]]);
});
test('revocation invalidates queued presses and releases an in-flight key', async t => {
  const { controller, native, calls } = fixture(t);
  let unblock;
  native.keyboard.pressKey = async key => { calls.push(['down', key]); await new Promise(resolve => { unblock = resolve; }); };
  await controller.grant({ x: 0, y: 0, width: 100, height: 100 });
  controller.enqueue({ type: 'key', action: 'down', code: 'ControlLeft' });
  await Promise.resolve();
  controller.enqueue({ type: 'key', action: 'down', code: 'KeyA' });
  const revoked = controller.revoke();
  unblock(); await revoked;
  assert.deepEqual(calls, [['down', 2], ['up', 2]]);
});
