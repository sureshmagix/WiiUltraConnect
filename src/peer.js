import { parseInvitation, validateSignalUrl, MAX_CHAT_LENGTH } from './protocol.js';
import { FileTransfer } from './file-transfer.js';

export class PeerSession extends EventTarget {
  constructor(config, options = {}) {
    super();
    this.config = config;
    this.options = options;
    this.channels = {};
    this.pendingIce = [];
    this.closed = false;
    this.signalQueue = Promise.resolve();
    this.controlAllowed = false;
  }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  async connect(role, url, invitation, stream, settings = {}) {
    this.role = role;
    this.stream = stream;
    this.settings = settings;
    const join = role === 'viewer' ? parseInvitation(invitation) : null;
    this.ws = new WebSocket(validateSignalUrl(url));
    this.ws.addEventListener('message', event => {
      this.signalQueue = this.signalQueue.then(() => this.handleSignal(JSON.parse(event.data))).catch(error => this.fail(error));
    });
    this.ws.addEventListener('close', () => { if (!this.closed) this.fail(new Error('Signaling disconnected. Reconnect to start a new session.')); });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.ws.close(); reject(new Error('Signaling connection timed out. Check the server address.')); }, 10_000);
      this.ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      this.ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Cannot reach the signaling server. Start npm run dev or check its address.')); }, { once: true });
      this.ws.addEventListener('close', () => { clearTimeout(timer); reject(new Error('Signaling connection closed.')); }, { once: true });
    });
    if (this.closed) throw new Error('Session was cancelled.');
    this.sendSignal(role === 'host' ? { type: 'create' } : { type: 'join', ...join });
    this.emit('status', role === 'host' ? 'Waiting for a viewer' : 'Joining the host');
  }
  sendSignal(m) {
    if (this.ws?.readyState !== WebSocket.OPEN) throw new Error('Signaling is disconnected.');
    this.ws.send(JSON.stringify(m));
  }
  async handleSignal(m) {
    if (this.closed) return;
    if (m.type === 'error') {
      const messages = { INVALID_INVITATION: 'Invitation is invalid or expired.', ROOM_FULL: 'This room already has a viewer.', ROOM_EXPIRED: 'The room expired. Start a new session.', SERVER_BUSY: 'The signaling server is full.' };
      throw new Error(messages[m.code] || `Signaling error: ${m.code}`);
    }
    if (m.type === 'created') return this.emit('invitation', m.invitation);
    if (m.type === 'joined') { this.createPeer(); return; }
    if (m.type === 'peer-left') { this.close(); return this.emit('ended', 'Your peer disconnected.'); }
    if (m.type === 'peer-ready' && this.role === 'host') {
      if (this.pc) throw new Error('Unexpected duplicate peer.');
      this.createPeer();
      await this.pc.setLocalDescription(await this.pc.createOffer());
      if (this.closed) return;
      this.sendSignal({ type: 'offer', description: this.pc.localDescription.toJSON() });
      return;
    }
    if (!this.pc) throw new Error('Received signaling before room membership.');
    if (m.type === 'offer' || m.type === 'answer') {
      if (m.type !== (this.role === 'host' ? 'answer' : 'offer')) throw new Error('Unexpected SDP role.');
      await this.pc.setRemoteDescription(m.description);
      for (const candidate of this.pendingIce.splice(0)) await this.pc.addIceCandidate(candidate);
      if (m.type === 'offer') {
        await this.pc.setLocalDescription(await this.pc.createAnswer());
        if (!this.closed) this.sendSignal({ type: 'answer', description: this.pc.localDescription.toJSON() });
      }
    } else if (m.type === 'ice') {
      if (this.pc.remoteDescription) await this.pc.addIceCandidate(m.candidate);
      else {
        if (this.pendingIce.length >= 256) throw new Error('Too many pending ICE candidates.');
        this.pendingIce.push(m.candidate);
      }
    }
  }
  createPeer() {
    const pc = this.pc = new RTCPeerConnection({ iceServers: this.config.iceServers, iceTransportPolicy: this.config.iceTransportPolicy, bundlePolicy: 'max-bundle' });
    this.emit('status', 'Connecting directly');
    this.connectTimer = setTimeout(() => this.fail(new Error('Peer connection timed out. Configure a TURN server for restrictive networks.')), 30_000);
    pc.onicecandidate = event => {
      if (event.candidate && !this.closed) {
        try { this.sendSignal({ type: 'ice', candidate: event.candidate.toJSON() }); } catch (error) { this.fail(error); }
      }
    };
    pc.onconnectionstatechange = () => {
      if (this.closed) return;
      this.emit('status', pc.connectionState);
      if (pc.connectionState === 'connected') {
        clearTimeout(this.connectTimer);
        clearTimeout(this.disconnectTimer);
        if (this.role === 'host') void this.tuneVideo().catch(error => this.emit('warning', error.message));
        this.emit('connected');
      }
      if (pc.connectionState === 'failed') this.fail(new Error('The peer connection failed. Check the network and TURN configuration.'));
      if (pc.connectionState === 'disconnected') {
        this.setControl(false);
        this.emit('control-lost');
        clearTimeout(this.disconnectTimer);
        this.disconnectTimer = setTimeout(() => this.fail(new Error('The peer connection was lost.')), 8000);
      }
    };
    pc.ontrack = event => {
      const stream = event.streams[0] || new MediaStream([event.track]);
      this.emit('stream', stream);
      event.track.onended = () => { if (!this.closed) this.fail(new Error('The host stopped screen sharing.')); };
    };
    pc.ondatachannel = event => {
      if (this.role !== 'viewer') { event.channel.close(); return; }
      this.attachChannel(event.channel);
    };
    if (this.role === 'host') {
      for (const track of this.stream.getVideoTracks()) {
        track.contentHint = 'motion';
        this.videoSender = pc.addTrack(track, this.stream);
      }
      for (const name of ['chat', 'files', 'input']) this.attachChannel(pc.createDataChannel(name, { ordered: true }));
    }
    this.statsTimer = setInterval(() => { void this.stats().catch(() => {}); }, 2000);
  }
  async tuneVideo() {
    if (!this.videoSender || this.closed) return;
    const parameters = this.videoSender.getParameters();
    if (!parameters.encodings?.length) parameters.encodings = [{}];
    parameters.degradationPreference = 'maintain-framerate';
    parameters.encodings[0].maxBitrate = (this.settings.bitrate || 4) * 1_000_000;
    parameters.encodings[0].maxFramerate = this.settings.fps || 30;
    parameters.encodings[0].priority = 'high';
    parameters.encodings[0].networkPriority = 'high';
    await this.videoSender.setParameters(parameters);
  }
  attachChannel(channel) {
    if (!['chat', 'files', 'input'].includes(channel.label) || this.channels[channel.label]) { channel.close(); return; }
    this.channels[channel.label] = channel;
    if (channel.label === 'files') {
      this.files = new FileTransfer(channel, { ...this.options.files, onError: error => this.emit('warning', error.message), maxMessageSize: () => this.pc?.sctp?.maxMessageSize || 65536 });
    } else {
      let budget = channel.label === 'input' ? 240 : 60, last = Date.now();
      channel.onmessage = event => {
        try {
          const now = Date.now(), cap = channel.label === 'input' ? 240 : 60;
          budget = Math.min(cap, budget + (now - last) * cap / 1000); last = now;
          if (--budget < 0) throw new Error('Peer sent messages too quickly.');
          if (typeof event.data !== 'string' || event.data.length > (channel.label === 'input' ? 512 : 8192)) throw new Error('Invalid peer message.');
          const m = JSON.parse(event.data);
          if (!m || typeof m !== 'object') throw new Error('Invalid peer message.');
          if (channel.label === 'chat') {
            if (m.type !== 'chat' || typeof m.text !== 'string' || !m.text.trim() || m.text.length > MAX_CHAT_LENGTH) throw new Error('Invalid chat message.');
            this.emit('chat', m.text);
          } else if (m.type === 'control-state' && this.role === 'viewer' && typeof m.allowed === 'boolean') {
            this.controlAllowed = m.allowed;
            this.emit('control', m.allowed);
          } else if (this.role === 'host' && this.controlAllowed) this.emit('input', m);
        } catch (error) { this.fail(error); }
      };
    }
    channel.onopen = () => { this.emit('channels', this.ready); if (channel.label === 'input' && this.role === 'host') this.setControl(false); };
    channel.onclose = () => {
      // SCTP close can arrive before the peer-left WebSocket message on a normal exit.
      if (!this.closed) { this.close(); this.emit('ended', 'Your peer disconnected.'); }
    };
    channel.onerror = () => {
      // Chromium can emit an SCTP error on the remote side of an intentional pc.close().
      // Treat a lost channel as an ended session; all tracks, transfers and input still stop.
      if (!this.closed) { this.close(); this.emit('ended', `Connection ended: the ${channel.label} channel disconnected.`); }
    };
  }
  get ready() { return ['chat', 'files', 'input'].every(name => this.channels[name]?.readyState === 'open'); }
  sendChat(text) {
    const channel = this.channels.chat;
    if (channel?.readyState !== 'open') throw new Error('Chat is not connected.');
    if (!text.trim() || text.length > MAX_CHAT_LENGTH) throw new Error('Messages must be between 1 and 4,000 characters.');
    if (channel.bufferedAmount > 64 * 1024) throw new Error('Chat is busy. Try again shortly.');
    channel.send(JSON.stringify({ type: 'chat', text }));
  }
  setControl(allowed) {
    this.controlAllowed = Boolean(allowed);
    if (this.role === 'host' && this.channels.input?.readyState === 'open') this.channels.input.send(JSON.stringify({ type: 'control-state', allowed: this.controlAllowed }));
  }
  sendInput(m) {
    const channel = this.channels.input;
    if (this.role !== 'viewer' || !this.controlAllowed || channel?.readyState !== 'open') return false;
    if (channel.bufferedAmount > 16 * 1024) {
      if (m.type === 'pointer' && m.action === 'move') return false;
      this.fail(new Error('Remote input stalled. Reconnect to resume control.'));
      return false;
    }
    channel.send(JSON.stringify(m));
    return true;
  }
  async stats() {
    if (!this.pc || this.closed) return;
    const reports = await this.pc.getStats();
    const result = {};
    reports.forEach(report => {
      if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated) {
        result.rtt = Math.round((report.currentRoundTripTime || 0) * 1000);
        result.relay = [reports.get(report.localCandidateId), reports.get(report.remoteCandidateId)].some(c => c?.candidateType === 'relay');
      }
      if (report.type === (this.role === 'host' ? 'outbound-rtp' : 'inbound-rtp') && report.kind === 'video') {
        result.fps = report.framesPerSecond;
        result.width = report.frameWidth;
        result.height = report.frameHeight;
      }
    });
    this.emit('stats', result);
  }
  fail(error) { if (!this.closed) { this.close(); this.emit('error', error.message); } }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.controlAllowed = false;
    clearTimeout(this.connectTimer);
    clearTimeout(this.disconnectTimer);
    clearInterval(this.statsTimer);
    this.files?.dispose();
    for (const channel of Object.values(this.channels)) channel.close();
    this.pc?.close();
    for (const track of this.stream?.getTracks() || []) track.stop();
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'leave' }));
    this.ws?.close();
    this.pendingIce = [];
  }
}
