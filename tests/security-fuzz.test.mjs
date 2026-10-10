import test from 'node:test';
import assert from 'node:assert/strict';
import { decodePacket, validatePacket } from '../src/direct-signaling.js';
import { decodeChunk } from '../src/protocol.js';
import { validSessionMessage } from '../src/session-messages.js';

function random(seed) {
  let value = seed >>> 0;
  return () => { value = (value * 1664525 + 1013904223) >>> 0; return value; };
}

test('deterministic malformed-code/message fuzzing stays bounded and fails closed', () => {
  const next = random(0x5eed1234);
  for (let index = 0; index < 1000; index += 1) {
    const length = next() % 8192;
    let text = '';
    for (let byte = 0; byte < length; byte += 1) text += String.fromCharCode(32 + (next() % 95));
    try { decodePacket(text, 'offer', 1_800_000_000_000); } catch {}
    try { validatePacket(JSON.parse(text), 'offer', 1_800_000_000_000); } catch {}
    assert.equal(validSessionMessage({ type: `invalid-${text}`, text }, 'host'), false);

    const binaryLength = next() % (32 * 1024);
    const data = new Uint8Array(binaryLength);
    for (let byte = 0; byte < binaryLength; byte += 1) data[byte] = next() & 0xff;
    try { decodeChunk(data.buffer); } catch {}
  }
  assert.throws(() => decodePacket('x'.repeat(110_000), 'offer'), /too large/);
});
