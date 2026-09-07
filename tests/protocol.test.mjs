import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizedPoint, parseInvitation, validateSignalUrl, encodeChunk, decodeChunk, safeFileName, validFileOffer, MAX_FILE_SIZE } from '../src/protocol.js';
test('pointer normalization excludes letterbox bars and clamps captured drags', () => {
  const rect = { left: 100, top: 50, width: 1000, height: 1000 };
  assert.deepEqual(normalizedPoint(600, 550, rect, 1920, 1080), { x: .5, y: .5 });
  assert.equal(normalizedPoint(600, 60, rect, 1920, 1080), null);
  assert.deepEqual(normalizedPoint(1500, 1500, rect, 1920, 1080, true), { x: 1, y: 1 });
  assert.equal(normalizedPoint(0, 0, rect, 0, 0), null);
});
test('file framing retains identity, offset and binary bytes', () => {
  const id = crypto.randomUUID(), bytes = new Uint8Array([0, 255, 1, 3]);
  const decoded = decodeChunk(encodeChunk(id, 4096, bytes.buffer));
  assert.equal(decoded.id, id); assert.equal(decoded.offset, 4096); assert.deepEqual(new Uint8Array(decoded.data), bytes);
  assert.throws(() => decodeChunk(new ArrayBuffer(10)));
});
test('invitations, URL schemes and file metadata are validated', () => {
  assert.deepEqual(parseInvitation(`012345abcdef.${'a'.repeat(32)}`), { roomId: '012345abcdef', secret: 'a'.repeat(32) });
  assert.throws(() => parseInvitation('12345'));
  assert.throws(() => validateSignalUrl('https://example.com'));
  assert.throws(() => validateSignalUrl('wss://user:password@example.com/signal'));
  assert.equal(safeFileName('../../report.txt'), 'report.txt');
  assert.equal(validFileOffer({ type: 'file-offer', id: crypto.randomUUID(), name: 'empty.txt', size: 0 }), true);
  assert.equal(validFileOffer({ type: 'file-offer', id: crypto.randomUUID(), name: 'huge', size: MAX_FILE_SIZE + 1 }), false);
});
