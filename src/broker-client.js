import { normalizeBrokerUrl, validAccessVerifier, validDeviceId } from './unattended-access.js';

const MAX_MESSAGE = 120 * 1024;

export class BrokerClient extends EventTarget {
  constructor(url) {
    super();
    this.url = normalizeBrokerUrl(url);
    this.closed = false;
  }

  connect(timeoutMs = 12_000) {
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.connecting = null;
        error ? reject(error) : resolve();
      };
      const timer = setTimeout(() => { this.socket?.close(); finish(new Error('The signaling server did not respond in time.')); }, timeoutMs);
      try {
        const socket = this.socket = new WebSocket(this.url);
        socket.onopen = () => finish();
        socket.onerror = () => finish(new Error('Could not reach the signaling server. Check its URL, TLS certificate and firewall.'));
        socket.onclose = () => {
          if (!settled) finish(new Error('The signaling server closed the connection.'));
          if (!this.closed) this.dispatchEvent(new CustomEvent('close'));
        };
        socket.onmessage = event => this.receive(event.data);
      } catch (error) { finish(error); }
    });
    return this.connecting;
  }

  receive(raw) {
    if (typeof raw !== 'string' || raw.length > MAX_MESSAGE) return this.fail('Invalid response from the signaling server.');
    try {
      const message = JSON.parse(raw);
      if (!message || typeof message !== 'object' || typeof message.type !== 'string') throw new Error();
      if (message.type === 'error') return this.dispatchEvent(new CustomEvent('error', { detail: String(message.message || 'The signaling server rejected the request.') }));
      this.dispatchEvent(new CustomEvent('message', { detail: message }));
    } catch { this.fail('Invalid response from the signaling server.'); }
  }

  send(message) {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('The signaling server is not connected.');
    const data = JSON.stringify(message);
    if (data.length > MAX_MESSAGE) throw new Error('The signaling message is too large.');
    this.socket.send(data);
  }

  registerHost({ deviceId, deviceKey }) {
    if (!validDeviceId(deviceId) || typeof deviceKey !== 'string' || deviceKey.length < 32 || deviceKey.length > 256) throw new Error('The unattended device configuration is invalid.');
    this.send({ type: 'host-register', deviceId, deviceKey });
  }

  requestAccess({ deviceId, attemptId, verifier }) {
    if (!validDeviceId(deviceId) || typeof attemptId !== 'string' || attemptId.length < 16 || !validAccessVerifier(verifier)) throw new Error('The unattended access request is invalid.');
    this.send({ type: 'access-request', deviceId, attemptId, verifier });
  }

  decideAccess({ attemptId, approved }) {
    this.send({ type: 'access-decision', attemptId, approved: approved === true });
  }

  sendOffer({ attemptId, code }) { this.sendSignal('signal-offer', attemptId, code); }
  sendAnswer({ attemptId, code }) { this.sendSignal('signal-answer', attemptId, code); }

  sendSignal(type, attemptId, code) {
    if (typeof attemptId !== 'string' || attemptId.length < 16 || typeof code !== 'string' || !code.startsWith('WUC-INTERNET-2.') || code.length > 110_000) throw new Error('The signaling payload is invalid.');
    this.send({ type, attemptId, code });
  }

  fail(message) { this.dispatchEvent(new CustomEvent('error', { detail: message })); this.close(); }
  close() { this.closed = true; this.socket?.close(); this.socket = null; }
}
