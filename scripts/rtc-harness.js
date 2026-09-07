import { PeerSession } from '../src/peer.js';
window.harness = {
  errors: [], messages: [], received: [], progress: [], input: [],
  async connect(config, invitation) {
    const session = this.peer = new PeerSession(config, { files: {
      accept: async () => true,
      onFile: file => this.received.push(file),
      onProgress: value => this.progress.push(value)
    } });
    session.addEventListener('error', e => this.errors.push(e.detail));
    session.addEventListener('warning', e => this.errors.push(e.detail));
    session.addEventListener('chat', e => this.messages.push(e.detail));
    session.addEventListener('input', e => this.input.push(e.detail));
    session.addEventListener('stream', e => { document.getElementById('remote').srcObject = e.detail; });
    await session.connect('viewer', config.signalUrl, invitation);
  }
};
