import { MAX_FILE_SIZE, CHUNK_SIZE, HEADER_SIZE, UUID, validFileOffer, safeFileName, encodeChunk, decodeChunk } from './protocol.js';
const HIGH_WATER = 256 * 1024;
const LOW_WATER = 64 * 1024;
const TIMEOUT = 60_000;

export function waitForCapacity(channel, signal) {
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      channel.removeEventListener('bufferedamountlow', check);
      channel.removeEventListener('close', closed);
      channel.removeEventListener('error', closed);
      signal?.removeEventListener('abort', aborted);
    };
    const finish = error => { cleanup(); error ? reject(error) : resolve(); };
    const closed = () => finish(new Error('File channel closed.'));
    const aborted = () => finish(new Error('Transfer cancelled.'));
    const check = () => {
      if (signal?.aborted) return aborted();
      if (channel.readyState !== 'open') return closed();
      if (channel.bufferedAmount <= LOW_WATER) finish();
    };
    channel.addEventListener('bufferedamountlow', check);
    channel.addEventListener('close', closed);
    channel.addEventListener('error', closed);
    signal?.addEventListener('abort', aborted, { once: true });
    timer = setTimeout(() => finish(new Error('File transfer stalled.')), TIMEOUT);
    check(); // Covers draining between the caller's check and listener registration.
  });
}

export class FileTransfer {
  constructor(channel, { accept = async () => false, onProgress = () => {}, onFile = () => {}, onError = () => {}, maxMessageSize = () => 65536 } = {}) {
    this.channel = channel;
    this.accept = accept;
    this.onProgress = onProgress;
    this.onFile = onFile;
    this.onError = onError;
    this.maxMessageSize = maxMessageSize;
    this.incoming = null;
    this.outgoing = null;
    this.disposed = false;
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = LOW_WATER;
    this.listener = event => { void this.receive(event.data).catch(error => { this.onError(error); this.dispose(); channel.close(); }); };
    this.closeListener = () => this.dispose();
    channel.addEventListener('message', this.listener);
    channel.addEventListener('close', this.closeListener);
    channel.addEventListener('error', this.closeListener);
  }
  sendControl(message) {
    if (this.channel.readyState !== 'open') throw new Error('File channel is not connected.');
    if (this.channel.bufferedAmount > HIGH_WATER * 2) throw new Error('File channel is congested.');
    this.channel.send(JSON.stringify(message));
  }
  progress(t, status) { this.onProgress({ id: t.id, name: t.name, size: t.size, bytes: t.bytes, direction: t.direction, status }); }
  touch(t) {
    clearTimeout(t.timer);
    t.timer = setTimeout(() => this.cancel(t.id, 'Timed out'), TIMEOUT);
  }
  send(file) {
    if (this.disposed || this.channel.readyState !== 'open') throw new Error('Connect a peer before sending a file.');
    if (this.outgoing) throw new Error('Finish or cancel the current outgoing transfer first.');
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_FILE_SIZE) throw new Error('Files are limited to 128 MiB per transfer.');
    const t = { id: crypto.randomUUID(), file, name: safeFileName(file.name), size: file.size, bytes: 0, direction: 'sent', abort: new AbortController(), started: false };
    this.outgoing = t;
    try {
      this.sendControl({ type: 'file-offer', id: t.id, name: t.name, size: t.size });
      this.progress(t, 'Awaiting acceptance');
      this.touch(t);
    } catch (error) { this.outgoing = null; throw error; }
    return t.id;
  }
  async pump(t) {
    if (t.started) return;
    t.started = true;
    const maximum = this.maxMessageSize();
    const chunkSize = Math.min(CHUNK_SIZE, (maximum > 0 ? maximum : 65536) - HEADER_SIZE);
    if (chunkSize < 1) throw new Error('Negotiated file message size is too small.');
    try {
      for (let offset = 0; offset < t.size;) {
        if (t.abort.signal.aborted || this.outgoing !== t) return;
        if (this.channel.bufferedAmount > HIGH_WATER) await waitForCapacity(this.channel, t.abort.signal);
        const data = await t.file.slice(offset, offset + chunkSize).arrayBuffer();
        if (t.abort.signal.aborted || this.outgoing !== t) return;
        this.channel.send(encodeChunk(t.id, offset, data));
        offset += data.byteLength;
        t.bytes = offset;
        this.touch(t);
        this.progress(t, 'Sending');
      }
      await waitForCapacity(this.channel, t.abort.signal);
      if (this.outgoing !== t) return;
      this.sendControl({ type: 'file-end', id: t.id });
      t.ended = true;
      this.progress(t, 'Waiting for receipt');
      this.touch(t);
    } catch (error) {
      if (this.outgoing === t) { this.cancel(t.id, 'Failed'); this.onError(error); }
    }
  }
  async receive(raw) {
    if (this.disposed) return;
    if (typeof raw !== 'string') {
      const { id, offset, data } = decodeChunk(raw);
      const t = this.incoming;
      // Old packets may still be queued when either peer cancels a transfer.
      if (!t || t.id !== id) return;
      if (!t.accepted || offset !== t.bytes || t.bytes + data.byteLength > t.size) throw new Error('File data does not match the accepted transfer.');
      t.chunks.push(data);
      t.bytes += data.byteLength;
      this.progress(t, 'Receiving');
      this.touch(t);
      return;
    }
    if (raw.length > 4096) throw new Error('Oversized file control message.');
    const m = JSON.parse(raw);
    if (!m || !UUID.test(m.id)) throw new Error('Invalid file message.');
    if (m.type === 'file-offer') {
      if (!validFileOffer(m)) throw new Error('Invalid file offer.');
      if (this.incoming) { this.sendControl({ type: 'file-reject', id: m.id }); return; }
      const t = { ...m, name: safeFileName(m.name), bytes: 0, chunks: [], direction: 'received', accepted: false, abort: new AbortController() };
      this.incoming = t;
      this.touch(t);
      this.progress(t, 'Awaiting acceptance');
      const accepted = await this.accept({ id: t.id, name: t.name, size: t.size }, t.abort.signal);
      if (this.incoming !== t || this.disposed) return;
      if (!accepted) { this.sendControl({ type: 'file-reject', id: t.id }); this.finish(t, 'Declined'); return; }
      t.accepted = true;
      this.sendControl({ type: 'file-accept', id: t.id });
      this.progress(t, 'Receiving');
      this.touch(t);
    } else if (m.type === 'file-accept' && this.outgoing?.id === m.id) {
      void this.pump(this.outgoing).catch(error => { this.cancel(m.id, 'Failed'); this.onError(error); });
    } else if (m.type === 'file-end' && this.incoming?.id === m.id) {
      const t = this.incoming;
      if (!t.accepted || t.bytes !== t.size) throw new Error('The received file is incomplete.');
      const blob = new Blob(t.chunks, { type: 'application/octet-stream' });
      this.sendControl({ type: 'file-complete', id: t.id });
      this.finish(t, 'Received');
      this.onFile({ id: t.id, name: t.name, blob });
    } else if (m.type === 'file-complete' && this.outgoing?.id === m.id) {
      if (!this.outgoing.ended) throw new Error('Premature transfer acknowledgement.');
      this.finish(this.outgoing, 'Delivered');
    } else if (['file-cancel', 'file-reject'].includes(m.type)) {
      for (const t of [this.incoming, this.outgoing]) if (t?.id === m.id) this.finish(t, m.type === 'file-reject' ? 'Declined' : 'Cancelled');
    }
  }
  finish(t, status) {
    clearTimeout(t.timer);
    t.abort?.abort();
    t.chunks = [];
    if (this.incoming === t) this.incoming = null;
    if (this.outgoing === t) this.outgoing = null;
    this.progress(t, status);
  }
  cancel(id, status = 'Cancelled') {
    const t = [this.incoming, this.outgoing].find(v => v?.id === id);
    if (!t) return;
    try { this.sendControl({ type: 'file-cancel', id }); } catch { /* Local cleanup still runs. */ }
    this.finish(t, status);
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const t of [this.incoming, this.outgoing]) if (t) this.finish(t, 'Disconnected');
    this.channel.removeEventListener('message', this.listener);
    this.channel.removeEventListener('close', this.closeListener);
    this.channel.removeEventListener('error', this.closeListener);
  }
}
