import { MAX_CHAT_LENGTH, sanitizeRoomCode, determineRouteType } from './protocol.js';
import { FileTransfer } from './file-transfer.js';
import { directIceConfig, decodePacket, encodePacket, offerFingerprint, validateAnswer, gatherComplete, INVITATION_TTL } from './direct-signaling.js';

export class PeerSession extends EventTarget {
  constructor(config = {}, options = {}) {
    super();
    this.config = config;
    this.options = options;
    this.channels = {};
    this.closed = false;
    this.setupAbort = new AbortController();
    this.phase = 'new';
    this.controlAllowed = false;
    this.iceCandidatesQueue = [];
    this.networkMode = 'auto'; // 'auto' | 'lan' | 'wan'
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  // --- Short-code WebSocket Automated Signaling ---
  async connectWithCode(role, signalUrl, sessionCode, localStream, settings = {}, networkMode = 'auto') {
    if (this.phase !== 'new' || this.closed) throw new Error('Start a new session first.');
    this.role = role;
    this.stream = localStream;
    this.settings = settings;
    this.networkMode = networkMode;
    this.signalUrl = signalUrl || 'ws://127.0.0.1:8787/signal';

    return new Promise((resolve, reject) => {
      let resolved = false;
      const finish = err => {
        if (!resolved) {
          resolved = true;
          if (err) {
            this.close();
            reject(err);
          } else {
            resolve();
          }
        }
      };

      try {
        this.emit('status', `Connecting to signaling service (${networkMode.toUpperCase()})...`);
        const ws = this.ws = new WebSocket(this.signalUrl);

        ws.onopen = () => {
          if (this.closed) return ws.close();
          this.emit('status', role === 'host' ? 'Registering session code...' : 'Joining session...');
          if (role === 'host') {
            ws.send(JSON.stringify({ type: 'create' }));
          } else {
            const cleanCode = sanitizeRoomCode(sessionCode);
            if (!cleanCode) return finish(new Error('Please enter a valid session code (e.g. 482-910).'));
            ws.send(JSON.stringify({ type: 'join', code: cleanCode }));
          }
        };

        ws.onerror = () => {
          if (!this.closed && this.phase !== 'connected') {
            finish(new Error(`Could not reach signaling server at ${this.signalUrl}. Check if server is running or verify network route.`));
          }
        };

        ws.onclose = () => {
          if (this.phase !== 'connected' && !this.closed) {
            finish(new Error('Signaling connection closed before WebRTC peer connection established.'));
          }
        };

        ws.onmessage = async event => {
          if (this.closed) return;
          let m;
          try {
            m = JSON.parse(event.data);
          } catch {
            return;
          }

          if (m.type === 'error') {
            return finish(new Error(m.message || m.code || 'Signaling error'));
          }

          if (m.type === 'created' && role === 'host') {
            this.sessionCode = m.code || m.roomId;
            this.phase = 'awaiting-peer';
            this.emit('status', `Ready! Share code ${this.sessionCode} with viewer`);
            this.emit('invitation', this.sessionCode);
            finish(); // Host registration complete, now waiting for viewer
          }

          if (m.type === 'joined' && role === 'viewer') {
            this.sessionCode = m.code || m.roomId;
            this.phase = 'joined';
            this.emit('status', 'Connected to session! Waiting for host screen...');
            this.createPeer(false, this.networkMode);
            finish();
          }

          if (m.type === 'peer-ready' && role === 'host') {
            this.emit('status', 'Viewer joined! Starting direct connection...');
            await this.initiateOffer();
          }

          if (m.type === 'offer' && role === 'viewer') {
            this.emit('status', 'Received host offer. Preparing response...');
            await this.handleRemoteOffer(m.description);
          }

          if (m.type === 'answer' && role === 'host') {
            this.emit('status', 'Connecting directly to viewer...');
            await this.handleRemoteAnswer(m.description);
          }

          if (m.type === 'ice') {
            await this.handleRemoteCandidate(m.candidate);
          }

          if (m.type === 'peer-left') {
            this.fail(new Error('Your peer left the session.'));
          }
        };
      } catch (err) {
        finish(err);
      }
    });
  }

  async initiateOffer() {
    this.createPeer(false, this.networkMode);
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.sendSignal({ type: 'offer', description: this.pc.localDescription.toJSON() });
  }

  async handleRemoteOffer(description) {
    if (!this.pc) this.createPeer(false, this.networkMode);
    await this.pc.setRemoteDescription(description);
    while (this.iceCandidatesQueue.length) {
      await this.pc.addIceCandidate(this.iceCandidatesQueue.shift()).catch(() => {});
    }
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this.sendSignal({ type: 'answer', description: this.pc.localDescription.toJSON() });
  }

  async handleRemoteAnswer(description) {
    if (!this.pc || this.pc.signalingState === 'stable') return;
    await this.pc.setRemoteDescription(description);
    while (this.iceCandidatesQueue.length) {
      await this.pc.addIceCandidate(this.iceCandidatesQueue.shift()).catch(() => {});
    }
  }

  async handleRemoteCandidate(candidate) {
    if (!candidate) return;
    if (this.pc && this.pc.remoteDescription && this.pc.remoteDescription.type) {
      await this.pc.addIceCandidate(candidate).catch(() => {});
    } else {
      this.iceCandidatesQueue.push(candidate);
    }
  }

  sendSignal(msg) {
    if (this.ws && this.ws.readyState === (window?.WebSocket?.OPEN ?? 1)) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  // --- Offline Manual Fallback (for air-gapped setups) ---
  async createInvitation(stream, settings = {}) {
    if (this.phase !== 'new' || this.closed) throw new Error('Start a new direct session first.');
    this.phase = 'gathering';
    this.role = 'host';
    this.stream = stream;
    this.settings = settings;
    try {
      this.createPeer(true, 'lan');
      await this.pc.setLocalDescription(await this.pc.createOffer());
      await gatherComplete(this.pc, this.setupAbort.signal);
      const issuedAt = Date.now();
      this.offer = { version: 1, kind: 'offer', sessionId: crypto.randomUUID(), issuedAt, expiresAt: issuedAt + INVITATION_TTL, description: this.pc.localDescription.toJSON() };
      const code = encodePacket(this.offer);
      this.phase = 'awaiting-answer';
      this.armExpiry();
      this.emit('status', 'Send the offline code, then paste the viewer response');
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
      this.createPeer(true, 'lan');
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
      this.connectTimer = setTimeout(() => this.fail(new Error('Direct connection timed out. Check peer reachability, NAT and firewall settings.')), 30_000);
      this.emit('status', 'Connecting directly to the viewer');
    } finally { this.applying = false; }
  }

  armExpiry() {
    clearTimeout(this.expiryTimer);
    if (this.offer) {
      this.expiryTimer = setTimeout(() => this.fail(new Error('The invitation expired. Create a new session.')), Math.max(1, this.offer.expiresAt - Date.now()));
    }
  }

  createPeer(isManualOffline = false, networkMode = 'auto') {
    if (this.pc) return this.pc;
    let iceServers = [];

    if (isManualOffline || networkMode === 'lan') {
      // LAN Only: no external STUN servers
      iceServers = [];
    } else {
      // Auto / WAN: Use public STUN servers for WAN discovery alongside local LAN host candidates
      iceServers = this.config.iceServers || [
        { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
        { urls: ['stun:stun.cloudflare.com:3478'] }
      ];
    }

    const pc = this.pc = new RTCPeerConnection({
      iceServers,
      iceTransportPolicy: 'all',
      bundlePolicy: 'max-bundle'
    });

    this.emit('status', networkMode === 'lan' ? 'Discovering local LAN route...' : 'Discovering LAN/WAN route...');

    pc.onicecandidate = event => {
      if (this.ws && this.ws.readyState === (window?.WebSocket?.OPEN ?? 1) && event.candidate) {
        this.sendSignal({ type: 'ice', candidate: event.candidate.toJSON() });
      }
    };

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
      if (pc.connectionState === 'failed') this.fail(new Error('The peer connection failed. Check network reachability and firewall settings.'));
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
      if (this.stream) {
        for (const track of this.stream.getVideoTracks()) {
          track.contentHint = 'motion';
          this.videoSender = pc.addTrack(track, this.stream);
        }
      }
      for (const name of ['chat', 'files', 'input']) this.attachChannel(pc.createDataChannel(name, { ordered: true }));
    }

    this.statsTimer = setInterval(() => { void this.stats().catch(() => {}); }, 2000);
    return pc;
  }

  setStream(stream) {
    this.stream = stream;
    if (this.pc) {
      const senders = this.pc.getSenders();
      const videoSender = senders.find(s => s.track?.kind === 'video');
      const videoTrack = stream?.getVideoTracks?.()[0];
      if (videoSender && videoTrack) {
        videoTrack.contentHint = 'motion';
        void videoSender.replaceTrack(videoTrack);
      } else if (videoTrack) {
        videoTrack.contentHint = 'motion';
        this.videoSender = this.pc.addTrack(videoTrack, stream);
      }
    }
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
      if (!this.closed) { this.close(); this.emit('ended', 'Your peer disconnected.'); }
    };
    channel.onerror = () => {
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
        const localCand = reports.get(report.localCandidateId);
        const remoteCand = reports.get(report.remoteCandidateId);
        result.routeType = determineRouteType(report, localCand, remoteCand);
        result.localAddress = localCand?.address || localCand?.ip;
        result.remoteAddress = remoteCand?.address || remoteCand?.ip;
        result.relay = localCand?.candidateType === 'relay' || remoteCand?.candidateType === 'relay';
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
    if (this.ws) {
      try {
        if (this.ws.readyState === (window?.WebSocket?.OPEN ?? 1)) this.ws.send(JSON.stringify({ type: 'leave' }));
        this.ws.close();
      } catch {}
    }
    this.files?.dispose();
    for (const channel of Object.values(this.channels)) channel.close();
    this.pc?.close();
    for (const track of this.stream?.getTracks() || []) track.stop();
  }
}
