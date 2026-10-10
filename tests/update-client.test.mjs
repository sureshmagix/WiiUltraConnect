import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { downloadVerifiedArtifact } = require('../electron/update-client.cjs');

function artifact(data) {
  return {
    name: 'WiiUltraConnect-test.dmg',
    url: 'https://updates.example.test/WiiUltraConnect-test.dmg',
    size: data.length,
    sha256: createHash('sha256').update(data).digest('hex')
  };
}

function responseRequester({ chunks, statusCode = 200, contentLength } = {}) {
  return (_url, _options, callback) => {
    const request = new EventEmitter();
    request.destroy = error => queueMicrotask(() => request.emit('error', error));
    queueMicrotask(() => {
      const response = new EventEmitter();
      response.statusCode = statusCode;
      response.headers = contentLength === undefined ? {} : { 'content-length': String(contentLength) };
      response.resume = () => {};
      callback(response);
      for (const chunk of chunks || []) response.emit('data', chunk);
      response.emit('end');
    });
    return request;
  };
}

test('verified update download streams chunks, verifies them, and never retains a partial file', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'wii-update-download-'));
  const bytes = Buffer.from('a chunked, verified installer payload');
  const destination = path.join(directory, 'WiiUltraConnect-test.dmg');
  const result = await downloadVerifiedArtifact({
    artifact: artifact(bytes), destination,
    requester: responseRequester({ chunks: [bytes.subarray(0, 7), bytes.subarray(7)], contentLength: bytes.length })
  });
  assert.equal(result.destination, destination);
  assert.deepEqual(readFileSync(destination), bytes);
  assert.deepEqual(readdirSync(directory), ['WiiUltraConnect-test.dmg']);
});

test('update download rejects bad size/hash and removes its private partial file', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'wii-update-download-'));
  const bytes = Buffer.from('tampered');
  const target = artifact(Buffer.from('expected'));
  const destination = path.join(directory, target.name);
  await assert.rejects(downloadVerifiedArtifact({ artifact: target, destination, requester: responseRequester({ chunks: [bytes] }) }), /unexpected size|SHA-256/);
  assert.equal(existsSync(destination), false);
  assert.deepEqual(readdirSync(directory), []);
});

test('update download refuses both existing destinations and a racing destination', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'wii-update-download-'));
  const bytes = Buffer.from('expected');
  const target = artifact(bytes);
  const destination = path.join(directory, target.name);
  writeFileSync(destination, 'existing');
  let contacted = false;
  await assert.rejects(downloadVerifiedArtifact({ artifact: target, destination, requester: () => { contacted = true; } }), /Refusing to overwrite/);
  assert.equal(contacted, false);

  const racing = path.join(directory, 'racing.dmg');
  const raceRequester = (_url, _options, callback) => {
    const request = new EventEmitter();
    request.destroy = error => queueMicrotask(() => request.emit('error', error));
    queueMicrotask(() => {
      const response = new EventEmitter(); response.statusCode = 200; response.headers = {}; response.resume = () => {};
      callback(response); response.emit('data', bytes); writeFileSync(racing, 'racer'); response.emit('end');
    });
    return request;
  };
  await assert.rejects(downloadVerifiedArtifact({ artifact: target, destination: racing, requester: raceRequester }), /Refusing to overwrite/);
  assert.equal(readFileSync(racing, 'utf8'), 'racer');
  assert.deepEqual(readdirSync(directory).sort(), ['WiiUltraConnect-test.dmg', 'racing.dmg']);
});
