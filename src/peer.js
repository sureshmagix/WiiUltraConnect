import { MAX_CHAT_LENGTH } from './protocol.js';
import { FileTransfer } from './file-transfer.js';
import { directIceConfig, decodePacket, encodePacket, offerFingerprint, validateAnswer, gatherComplete, INVITATION_TTL } from './direct-signaling.js';

export class PeerSession extends EventTarget {
  constructor(config, options = {}) {
    super();
    this.config = config;
    this.options = options;
    this.channels = {};
    this.closed = false;
    this.setupAbort = new AbortController();
    this.phase = 'new';
    this.controlAllowed = false;
  }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  async createInvitation(stream, settings = {}) {
    if (this.phase !== 'new' || this.closed) throw new Error('Start a new direct session first.');
    this.phase = 'gathering';
    this.role = 'host';
    this.stream = stream;
    this.settings = settings;
    try {
      this.createPeer();
      await this.pc.setLocalDescription(await this.pc.createOffer());
      await gatherComplete(this.pc, this.setupAbort.signal);
      const issuedAt = Date.now();
      this.offer = { version: 1, kind: 'offer', sessionId: crypto.randomUUID(), issuedAt, expiresAt: issuedAt + INVITATION_TTL, description: this.pc.localDescription.toJSON() };
      const code = encodePacket(this.offer);
      this.phase = 'awaiting-answer';
      this.armExpiry();
      this.emit('status', 'Send the invitation, then paste the viewer response');
      this.emit('invitation', code);
      return code;
    } catch (error) { this.close(); throw error; }
  }
  async createResponse(invitation) {
    if (this.phase !== 'new' || this.closed) throw new Error('Start a new direct session first.');
    const offer = decodePacket(invitation, 'offer');
    this.phase = 'gathering';
    this.role = 'viewer';
    this.settings = {};
    this.offer = offer;
    try {
      this.createPeer();
      await this.pc.setRemoteDescription(offer.description);
      await this.pc.setLocalDescription(await this.pc.createAnswer());
      await gatherComplete(this.pc, this.setupAbort.signal);
      const answer = { ...offer, kind: 'answer', offerHash: await offerFingerprint(offer), description: this.pc.localDescription.toJSON() };
      const code = encodePacket(answer);
      if (this.closed) throw new Error('Direct connection setup was cancelled.');
      this.phase = 'awaiting-host';
      this.armExpiry();
      this.emit('status', 'Send your response back to the host promptly');
      this.emit('response', code);
      return code;
    } catch (error) { this.close(); throw error; }
  }
  async applyResponse(code) {
    if (this.closed || this.role !== 'host' || this.phase !== 'awaiting-answer' || this.applying) throw new Error('This invitation is no longer waiting for a response.');
    this.applying = true;
    try {
      const answer = decodePacket(code, 'answer');
      await validateAnswer(answer, this.offer);
      if (this.closed) throw new Error('This invitation was cancelled.');
      await this.pc.setRemoteDescription(answer.description);
      this.phase = 'connecting';
      clearTimeout(this.expiryTimer);
      this.connectTimer = setTimeout(() => this.fail(new Error('Direct connection timed out. Check peer reachability, NAT and firewall settings. No relay fallback is used.')), 30_000);
      this.emit('status', 'Connecting directly to the viewer');
    } finally { this.applying = false; }
  }
  armExpiry() {
    clearTimeout(this.expiryTimer);
    this.expiryTimer = setTimeout(() => this.fail(new Error('The invitation expired. Create a new direct session.')), Math.max(1, this.offer.expiresAt - Date.now()));
  }
  createPeer() {
    const pc = this.pc = new RTCPeerConnection(directIceConfig());
    this.emit('status', 'Gathering direct network addresses');
    // Local SDP is exported only after ICE gathering completes. No trickle/signaling server.
    pc.onconnectionstatechange = () => {
      if (this.closed) return;
      this.emit('status', pc.connectionState);
      if (pc.connectionState === 'connected') {
        this.phase = 'connected';
        clearTimeout(this.expiryTimer);
        clearTimeout(this.connectTimer);
        clearTimeout(this.disconnectTimer);
        if (this.role === 'host') void this.tuneVideo().catch(error => this.emit('warning', error.message));
        this.emit('connected');
      }
      if (pc.connectionState === 'failed') this.fail(new Error('The direct connection failed. Create fresh codes and check NAT/firewall reachability. This version never uses a relay.'));
      if (pc.connectionState === 'disconnected') {
        this.setControl(false);
        this.emit('control-lost');
        clearTimeout(this.disconnectTimer);
        this.disconnectTimer = setTimeout(() => this.fail(new Error('The direct peer connection was lost.')), 8000);
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
        if (this.closed) return;
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
      // A closed SCTP channel ends the direct session without a signaling service.
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
    this.phase = 'closed';
    this.setupAbort.abort();
    this.controlAllowed = false;
    clearTimeout(this.expiryTimer);
    clearTimeout(this.connectTimer);
    clearTimeout(this.disconnectTimer);
    clearInterval(this.statsTimer);
    this.files?.dispose();
    for (const channel of Object.values(this.channels)) channel.close();
    this.pc?.close();
    for (const track of this.stream?.getTracks() || []) track.stop();
  }
}
