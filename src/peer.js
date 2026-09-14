import { MAX_CHAT_LENGTH, determineRouteType } from './protocol.js';
import { FileTransfer } from './file-transfer.js';
import { decodePacket, encodePacket, offerFingerprint, validateAnswer, gatherComplete, INVITATION_TTL } from './direct-signaling.js';
import { connectionConfig, connectionDiagnostics, connectionFailure, hasTurn } from './connection-config.js';
import { CHANNELS, validSessionMessage, QUALITY } from './session-messages.js';

export class PeerSession extends EventTarget {
  constructor(config = {}, options = {}) {
    super();
    this.connectionMode = config.mode ?? 'direct';
    this.iceConfig = connectionConfig(config);
    this.options = options;
    this.channels = {};
    this.closed = false;
    this.setupAbort = new AbortController();
    this.phase = 'new';
    this.controlAllowed = false;
  }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  async createInvitation(stream, settings = {}) {
    if (this.phase !== 'new' || this.closed) throw new Error('Start a new session first.');
    if (!stream?.getVideoTracks().some(track => track.readyState === 'live')) throw new Error('Select and capture a display before creating an invitation.');
    this.phase = 'gathering'; this.role = 'host'; this.stream = stream; this.settings = settings;
    try {
      this.createPeer();
      await this.pc.setLocalDescription(await this.pc.createOffer());
      await this.gatherAddresses();
      if (this.closed) throw new Error('Connection setup was cancelled.');
      const issuedAt = Date.now();
      this.offer = { version: this.connectionMode === 'internet' ? 2 : 1, kind: 'offer', sessionId: crypto.randomUUID(), issuedAt, expiresAt: issuedAt + INVITATION_TTL, description: this.pc.localDescription.toJSON() };
      const code = encodePacket(this.offer);
      this.phase = 'awaiting-answer'; this.armExpiry();
      this.emit('diagnostics', connectionDiagnostics(this.offer.description.sdp, this.connectionMode, this.iceConfig));
      this.emit('status', 'Send the invitation to your partner, then paste their response.');
      this.emit('invitation', code);
      return code;
    } catch (error) { this.close(); throw error; }
  }
  async createResponse(invitation) {
    if (this.phase !== 'new' || this.closed) throw new Error('Start a new session first.');
    const offer = decodePacket(invitation, 'offer');
    if ((offer.version === 2 ? 'internet' : 'direct') !== this.connectionMode) throw new Error(`This invitation uses ${offer.version === 2 ? 'Internet' : 'Direct'} mode. Select that connection mode before creating a response. Both computers must use the same mode.`);
    this.phase = 'gathering'; this.role = 'viewer'; this.settings = {}; this.offer = offer;
    try {
      this.createPeer();
      await this.pc.setRemoteDescription(offer.description);
      await this.pc.setLocalDescription(await this.pc.createAnswer());
      await this.gatherAddresses();
      const answer = { ...offer, kind: 'answer', offerHash: await offerFingerprint(offer), description: this.pc.localDescription.toJSON() };
      const code = encodePacket(answer);
      if (this.closed) throw new Error('Connection setup was cancelled.');
      // ICE can connect while gathering. Never overwrite an already connected phase.
      if (this.phase !== 'connected') { this.phase = 'awaiting-host'; this.armExpiry(); }
      this.emit('diagnostics', connectionDiagnostics(answer.description.sdp, this.connectionMode, this.iceConfig));
      this.emit('status', 'Return this response to the host promptly to finish connecting.');
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
      if (this.phase !== 'connected') {
        this.phase = 'connecting';
        clearTimeout(this.expiryTimer);
        this.connectTimer = setTimeout(() => this.fail(new Error(this.failureMessage())), this.connectionMode === 'internet' ? 60_000 : 30_000);
        this.emit('status', 'Checking the connection to your partner…');
      }
    } finally { this.applying = false; }
  }
  armExpiry() {
    clearTimeout(this.expiryTimer);
    this.expiryTimer = setTimeout(() => this.fail(new Error('The invitation expired. Create and exchange a fresh invitation and response.')), Math.max(1, this.offer.expiresAt - Date.now()));
  }
  failureMessage() {
    return connectionFailure(this.connectionMode, this.iceConfig, this.pc?.localDescription?.sdp, this.pc?.remoteDescription?.sdp);
  }
  async gatherAddresses() {
    const internet = this.connectionMode === 'internet';
    const usable = hasTurn(this.iceConfig) ? /^a=candidate:.*\btyp\s+relay\b/im : /^a=candidate:.*\btyp\s+srflx\b/im;
    await gatherComplete(this.pc, this.setupAbort.signal, internet ? 45_000 : 15_000, internet ? { canExport: sdp => usable.test(sdp) } : {});
    const sdp = this.pc.localDescription?.sdp || '';
    if (this.connectionMode === 'internet' && !/^a=candidate:/m.test(sdp)) throw new Error(this.failureMessage());
  }
  createPeer() {
    if (this.pc) return this.pc;
    // Only explicitly selected local settings can configure services; codes never do.
    const pc = this.pc = new RTCPeerConnection(this.iceConfig);
    this.emit('status', this.connectionMode === 'internet' ? 'Gathering internet addresses using your STUN/TURN settings…' : 'Gathering direct network addresses…');
    pc.onicecandidateerror = event => {
      if (!this.closed && this.phase !== 'connected' && this.connectionMode === 'internet') this.emit('warning', `An ICE server request failed (code ${event.errorCode}). Check the STUN/TURN address, credentials and network access. Other configured paths may still work.`);
    };
    pc.onconnectionstatechange = () => {
      if (this.closed) return;
      if (pc.connectionState === 'connected') {
        const recovering = this.phase === 'reconnecting';
        this.phase = 'connected';
        clearTimeout(this.expiryTimer); clearTimeout(this.connectTimer); clearTimeout(this.disconnectTimer);
        if (this.role === 'host') void this.tuneVideo().catch(error => this.emit('warning', error.message));
        this.emit('status', recovering ? 'Connection recovered. The host can enable control again.' : 'Connected to your partner.');
        this.emit('connected');
      } else if (pc.connectionState === 'failed') {
        this.fail(new Error(this.failureMessage()));
      } else if (pc.connectionState === 'disconnected') {
        this.phase = 'reconnecting';
        this.setControl(false); this.emit('control-lost');
        this.emit('status', 'Connection interrupted. Waiting up to 15 seconds for the path to recover…');
        clearTimeout(this.disconnectTimer);
        this.disconnectTimer = setTimeout(() => this.fail(new Error('The connection was lost. Exchange new codes to reconnect.')), 15_000);
      }
    };
    pc.ontrack = event => {
      const stream = event.streams[0] || new MediaStream([event.track]);
      this.emit('stream', stream);
      event.track.onended = () => { if (!this.closed && event.track.kind === 'video') this.fail(new Error('The host stopped screen sharing.')); };
    };
    pc.ondatachannel = event => { if (this.role !== 'viewer') event.channel.close(); else this.attachChannel(event.channel); };
    if (this.role === 'host') {
      for (const track of this.stream.getTracks()) {
        if (track.kind === 'video') track.contentHint = 'detail';
        const sender = pc.addTrack(track, this.stream);
        if (track.kind === 'video') this.videoSender = sender;
      }
      for (const name of CHANNELS) this.attachChannel(pc.createDataChannel(name, { ordered: true }));
    }
    this.statsTimer = setInterval(() => { void this.stats().catch(() => {}); }, 2000);
    return pc;
  }
  async setStream(stream) {
    const track = stream?.getVideoTracks()[0];
    if (this.closed || this.role !== 'host' || !this.videoSender || !track || track.readyState !== 'live') throw new Error('No active display sender is available.');
    track.contentHint = 'detail';
    await this.videoSender.replaceTrack(track);
    if (this.closed) { stream.getTracks().forEach(t => t.stop()); return; }
    const old = this.stream;
    this.stream = stream;
    // Preserve the originally negotiated audio track when switching monitors.
    for (const audio of old.getAudioTracks()) if (audio.readyState === 'live' && !stream.getAudioTracks().includes(audio)) stream.addTrack(audio);
    for (const previous of old.getVideoTracks()) previous.stop();
  }
  async tuneVideo() {
    if (!this.videoSender || this.closed) return;
    const parameters = this.videoSender.getParameters();
    if (!parameters.encodings?.length) parameters.encodings = [{}];
    parameters.degradationPreference = 'balanced';
    parameters.encodings[0].maxBitrate = (this.settings.bitrate || 4) * 1_000_000;
    parameters.encodings[0].maxFramerate = this.settings.fps || 30;
    await this.videoSender.setParameters(parameters);
  }
  async setQuality(quality) {
    if (this.role !== 'host' || !Object.hasOwn(QUALITY, quality)) return;
    this.settings = { ...this.settings, ...QUALITY[quality] };
    await this.stream.getVideoTracks()[0].applyConstraints({ frameRate: { ideal: this.settings.fps, max: this.settings.fps } });
    await this.tuneVideo();
    this.sendSession({ type: 'quality', quality });
  }
  attachChannel(channel) {
    if (!CHANNELS.includes(channel.label) || this.channels[channel.label]) { channel.close(); return; }
    this.channels[channel.label] = channel;
    if (channel.label === 'files') {
      this.files = new FileTransfer(channel, { ...this.options.files, onError: error => this.emit('warning', error.message), maxMessageSize: () => this.pc?.sctp?.maxMessageSize || 65536 });
    } else {
      const cap = channel.label === 'input' ? 300 : channel.label === 'session' ? 10 : 60;
      let budget = cap, last = Date.now();
      channel.onmessage = event => {
        if (this.closed) return;
        try {
          const now = Date.now(); budget = Math.min(cap, budget + (now - last) * cap / 1000); last = now;
          if (--budget < 0) throw new Error('Peer sent messages too quickly.');
          if (typeof event.data !== 'string' || event.data.length > (channel.label === 'input' ? 512 : channel.label === 'session' ? 100_000 : 24000)) throw new Error('Invalid peer message.');
          const m = JSON.parse(event.data);
          if (!m || typeof m !== 'object') throw new Error('Invalid peer message.');
          if (channel.label === 'chat') {
            if (m.type !== 'chat' || typeof m.text !== 'string' || !m.text.trim() || m.text.length > MAX_CHAT_LENGTH) throw new Error('Invalid chat message.');
            this.emit('chat', m.text);
          } else if (channel.label === 'session') {
            if (!validSessionMessage(m, this.role)) throw new Error('Invalid session message.');
            if (m.type === 'display-request' && !this.controlAllowed) return;
            this.emit('session-message', m);
          } else if (m.type === 'control-state' && this.role === 'viewer' && typeof m.allowed === 'boolean') {
            this.controlAllowed = m.allowed; this.emit('control', m.allowed);
          } else if (this.role === 'host' && this.controlAllowed) this.emit('input', m);
        } catch (error) { this.fail(error); }
      };
    }
    channel.onopen = () => { if (channel.label === 'input' && this.role === 'host') this.setControl(false); this.emit('channels', this.ready); };
    channel.onclose = () => { if (!this.closed) { this.close(); this.emit('ended', 'Your partner disconnected.'); } };
    channel.onerror = () => this.fail(new Error(`The ${channel.label} channel disconnected. Exchange fresh codes to reconnect.`));
  }
  get ready() { return !this.closed && this.phase === 'connected' && CHANNELS.every(name => this.channels[name]?.readyState === 'open'); }
  sendChat(text) {
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_CHAT_LENGTH) throw new Error('Messages must be between 1 and 4,000 characters.');
    this.sendMessage('chat', { type: 'chat', text });
  }
  sendSession(message) {
    if (!validSessionMessage(message, this.role === 'host' ? 'viewer' : 'host')) throw new Error('Invalid session message.');
    this.sendMessage('session', message);
  }
  sendMessage(name, message) {
    const channel = this.channels[name];
    if (!this.ready || channel?.readyState !== 'open') throw new Error('Wait for the connection to finish.');
    if (channel.bufferedAmount > 128 * 1024) throw new Error('Connection is busy. Try again shortly.');
    const payload = JSON.stringify(message);
    const maximum = this.pc?.sctp?.maxMessageSize;
    if (maximum > 0 && new TextEncoder().encode(payload).byteLength > maximum) throw new Error('This text is too large for the connection. Send a smaller selection.');
    channel.send(payload);
  }
  setControl(allowed) {
    this.controlAllowed = Boolean(allowed && !this.closed);
    if (this.role === 'host' && this.channels.input?.readyState === 'open') {
      try { this.channels.input.send(JSON.stringify({ type: 'control-state', allowed: this.controlAllowed })); } catch { this.controlAllowed = false; }
    }
  }
  sendInput(m) {
    const channel = this.channels.input;
    if (this.role !== 'viewer' || !this.controlAllowed || !this.ready) return false;
    if (channel.bufferedAmount > 16 * 1024) {
      if (m.type === 'pointer' && m.action === 'move') return false;
      this.fail(new Error('Remote input stalled. Reconnect to resume control.')); return false;
    }
    channel.send(JSON.stringify(m)); return true;
  }
  async stats() {
    if (!this.pc || this.closed) return;
    const reports = await this.pc.getStats();
    const result = {};
    const selected = [...reports.values()].find(r => r.type === 'transport' && r.selectedCandidatePairId)?.selectedCandidatePairId;
    reports.forEach(report => {
      if (report.type === 'candidate-pair' && (selected ? report.id === selected : report.state === 'succeeded' && report.nominated)) {
        result.rtt = report.currentRoundTripTime == null ? undefined : Math.round(report.currentRoundTripTime * 1000);
        result.routeType = determineRouteType(report, reports.get(report.localCandidateId), reports.get(report.remoteCandidateId));
      }
      if (report.type === (this.role === 'host' ? 'outbound-rtp' : 'inbound-rtp') && report.kind === 'video') {
        result.fps = report.framesPerSecond; result.width = report.frameWidth; result.height = report.frameHeight;
        const bytes = this.role === 'host' ? report.bytesSent : report.bytesReceived;
        if (this.lastStats && report.timestamp > this.lastStats.time) result.mbps = Math.max(0, (bytes - this.lastStats.bytes) * 8 / (report.timestamp - this.lastStats.time) / 1000).toFixed(1);
        this.lastStats = { time: report.timestamp, bytes };
      }
    });
    this.emit('stats', result);
  }
  fail(error) { if (!this.closed) { this.close(); this.emit('error', error.message); } }
  close() {
    if (this.closed) return;
    this.closed = true; this.phase = 'closed'; this.setupAbort.abort(); this.controlAllowed = false;
    clearTimeout(this.expiryTimer); clearTimeout(this.connectTimer); clearTimeout(this.disconnectTimer); clearInterval(this.statsTimer);
    this.files?.dispose();
    for (const channel of Object.values(this.channels)) channel.close();
    this.pc?.close();
    for (const track of this.stream?.getTracks() || []) track.stop();
  }
}
