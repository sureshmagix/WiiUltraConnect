// Explicit-update helper.  Nothing calls the network implicitly: the desktop
// UI/release channel must opt in before invoking this module.
const https = require('node:https');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { verifyEnvelope, artifactFor } = require('./update-verifier.cjs');

function updateUrl(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) throw new Error('Update endpoint must be a credential-free HTTPS URL without a fragment');
  return parsed;
}

function declaredLength(response, maximum) {
  const header = response.headers['content-length'];
  if (header === undefined) return undefined;
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error('Update response has an invalid Content-Length');
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length > maximum) throw new Error('Update response exceeds its declared limit');
  return length;
}

function httpsGet(url, { maxBytes, timeoutMs = 15_000 }) {
  const parsed = updateUrl(url);
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = error => { if (!settled) { settled = true; reject(error); } };
    const request = https.get(parsed, { timeout: timeoutMs, headers: { Accept: 'application/json, application/octet-stream' } }, response => {
      if (response.statusCode !== 200) { response.resume(); return fail(new Error(`Update endpoint returned HTTP ${response.statusCode}`)); }
      try { declaredLength(response, maxBytes); } catch (error) { response.resume(); return fail(error); }
      const chunks = []; let received = 0;
      response.on('data', chunk => {
        received += chunk.length;
        if (received > maxBytes) { request.destroy(new Error('Update response exceeds its declared limit')); return; }
        chunks.push(chunk);
      });
      response.on('error', fail);
      response.on('end', () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks)); } });
    });
    request.once('timeout', () => request.destroy(new Error('Update request timed out')));
    request.once('error', fail);
  });
}

async function checkForVerifiedUpdate({ metadataUrl, keyring, state, target = 'desktop', platform, arch, format }) {
  const raw = await httpsGet(metadataUrl, { maxBytes: 512 * 1024 });
  let envelope;
  try { envelope = JSON.parse(raw.toString('utf8')); } catch { throw new Error('Update metadata is not JSON'); }
  const verified = verifyEnvelope(envelope, keyring, state);
  return { ...verified, artifact: artifactFor(verified.signed, { target, platform, arch, format }) };
}

function writeAll(fd, chunk) {
  for (let offset = 0; offset < chunk.length;) offset += fs.writeSync(fd, chunk, offset, chunk.length - offset);
}

function artifactWriter({ artifact, destination }) {
  if (fs.existsSync(destination)) throw new Error(`Refusing to overwrite an existing download: ${destination}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  // A random O_EXCL temporary name prevents a pre-existing partial file or
  // symlink from being followed.  The final hard-link is an atomic no-clobber
  // commit on the same filesystem, so a racing process cannot replace an
  // existing download between the check above and completion.
  const temporary = `${destination}.${randomUUID()}.partial`;
  let fd;
  let closed = false;
  let finished = false;
  let bytes = 0;
  const hash = createHash('sha256');
  try { fd = fs.openSync(temporary, 'wx', 0o600); } catch (error) { throw new Error(`Cannot create private update download: ${error.message}`); }

  const close = () => {
    if (!closed) { fs.closeSync(fd); closed = true; }
  };
  const abort = () => {
    try { close(); } catch {}
    try { fs.unlinkSync(temporary); } catch {}
  };
  return {
    write(chunk) {
      if (finished) throw new Error('Update download has already finished');
      if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
      bytes += chunk.length;
      if (bytes > artifact.size) throw new Error(`Downloaded ${artifact.name} exceeds its expected size`);
      hash.update(chunk);
      writeAll(fd, chunk);
    },
    finish() {
      if (finished) throw new Error('Update download has already finished');
      finished = true;
      if (bytes !== artifact.size) throw new Error(`Downloaded ${artifact.name} has an unexpected size`);
      const digest = hash.digest('hex');
      if (digest !== artifact.sha256) throw new Error(`Downloaded ${artifact.name} fails SHA-256 verification`);
      fs.fsyncSync(fd);
      close();
      try {
        // link(2) fails with EEXIST instead of replacing a racing final path.
        fs.linkSync(temporary, destination);
        fs.unlinkSync(temporary);
      } catch (error) {
        abort();
        if (error.code === 'EEXIST') throw new Error(`Refusing to overwrite an existing download: ${destination}`);
        throw error;
      }
      return { destination, digest };
    },
    abort
  };
}

async function downloadVerifiedArtifact({ artifact, destination, requester = https.get }) {
  if (fs.existsSync(destination)) throw new Error(`Refusing to overwrite an existing download: ${destination}`);
  const parsed = updateUrl(artifact.url);
  const writer = artifactWriter({ artifact, destination });
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      writer.abort();
      reject(error);
    };
    let request;
    try {
      request = requester(parsed, { timeout: 30_000, headers: { Accept: 'application/octet-stream' } }, response => {
        if (response.statusCode !== 200) { response.resume(); return fail(new Error(`Update endpoint returned HTTP ${response.statusCode}`)); }
        try {
          const length = declaredLength(response, artifact.size);
          if (length !== undefined && length !== artifact.size) throw new Error(`Downloaded ${artifact.name} has an unexpected size`);
        } catch (error) { response.resume(); return fail(error); }
        response.on('data', chunk => {
          try { writer.write(chunk); } catch (error) { request.destroy(error); fail(error); }
        });
        response.once('error', fail);
        response.once('end', () => {
          try { const result = writer.finish(); if (!settled) { settled = true; resolve(result); } } catch (error) { fail(error); }
        });
      });
      request.once('timeout', () => request.destroy(new Error('Update request timed out')));
      request.once('error', fail);
    } catch (error) { fail(error); }
  });
}

function readUpdateState(file) {
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!state || typeof state !== 'object') throw new Error('not an object');
    return { highestSequence: state.highestSequence, highestVersion: state.highestVersion };
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error(`Cannot read update rollback state: ${error.message}`);
  }
}

function writeUpdateState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.partial`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify({ ...state, acceptedAt: new Date().toISOString() })}\n`);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(temporary, file);
  } catch (error) {
    try { if (fd !== undefined) fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

module.exports = { checkForVerifiedUpdate, downloadVerifiedArtifact, artifactWriter, readUpdateState, writeUpdateState };
