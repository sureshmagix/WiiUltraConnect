import { PeerSession } from './peer.js';
import { ViewerInput } from './viewer-input.js';
import { renderQRCodeSVG } from './qrcode.js';
import { formatRoomCode, sanitizeRoomCode } from './protocol.js';

const $ = id => document.getElementById(id);
let config, mode = 'host', peer = null, localStream = null, busy = false, operation = 0, sourceList = [], control = false;
let messages = 0;
let currentSessionCode = '';
const transfers = new Map();
const downloadUrls = new Set();
const bytes = value => value < 1024 ? `${value} B` : value < 1024 ** 2 ? `${(value / 1024).toFixed(1)} KiB` : `${(value / 1024 ** 2).toFixed(1)} MiB`;
const viewerInput = new ViewerInput($('screen-video'), event => peer?.sendInput(event));

function notice(message) {
  console.log('[Notice]', message);
  $('notice').textContent = message;
  $('notice').hidden = !message;
}

function status(message) {
  console.log('[Status]', message);
  $('session-status').textContent = message;
}

function getSignalUrl() {
  const custom = $('signal-url')?.value?.trim();
  if (custom && (custom.startsWith('ws://') || custom.startsWith('wss://'))) return custom;
  if (config?.signalUrl && (config.signalUrl.startsWith('ws://') || config.signalUrl.startsWith('wss://'))) return config.signalUrl;
  return 'ws://127.0.0.1:8787/signal';
}

function setMode(value) {
  if ((peer && peer.phase === 'connected') || busy) return;
  mode = value;
  for (const name of ['host', 'viewer']) {
    $(`${name}-panel`).hidden = name !== value;
    $(`${name}-tab`).classList.toggle('selected', name === value);
    $(`${name}-tab`).setAttribute('aria-selected', String(name === value));
  }
  $('control-button').textContent = mode === 'host' ? 'Allow remote control' : 'View only';
}

function showTab(value) {
  for (const name of ['chat', 'files']) {
    $(`${name}-panel`).hidden = name !== value;
    $(`${name}-tab`).classList.toggle('selected', name === value);
    $(`${name}-tab`).setAttribute('aria-selected', String(name === value));
  }
}

function refreshUI() {
  const isConnected = Boolean(peer && peer.phase === 'connected');
  const isSharing = Boolean(localStream);
  const locked = isConnected || busy;

  for (const id of ['host-tab', 'viewer-tab', 'start-viewer', 'fps', 'bitrate', 'session-code-input', 'network-mode-select']) {
    const el = $(id);
    if (el) el.disabled = locked;
  }

  $('disconnect').disabled = !(isConnected || isSharing);
  for (const id of ['chat-input', 'send-chat', 'file-input']) $(id).disabled = !isConnected;
  $('control-button').disabled = mode !== 'host' || !isConnected || busy;
  $('fullscreen').disabled = !$('screen-video').srcObject;
  $('connection-badge').classList.toggle('connected', isConnected);
  $('connection-badge').querySelector('span').textContent = isConnected ? 'Connected' : isSharing ? 'Broadcasting' : 'Ready';

  // Update Host action button text
  if ($('start-host-text')) {
    if (isSharing) {
      $('start-host-text').textContent = 'Stop Screen Sharing';
      $('start-host').classList.add('active-sharing');
    } else {
      $('start-host-text').textContent = 'Start Screen Sharing';
      $('start-host').classList.remove('active-sharing');
    }
  }

  // Update Code Status Pill
  if ($('code-status-pill')) {
    if (isConnected) {
      $('code-status-pill').textContent = 'Connected';
      $('code-status-pill').className = 'status-pill active';
    } else if (isSharing) {
      $('code-status-pill').textContent = 'Broadcasting';
      $('code-status-pill').className = 'status-pill active';
    } else {
      $('code-status-pill').textContent = 'Ready';
      $('code-status-pill').className = 'status-pill ready';
    }
  }
}

function setControl(value) {
  control = value;
  if (mode === 'host') peer?.setControl(value);
  viewerInput.setEnabled(mode === 'viewer' && value);
  $('control-button').textContent = mode === 'host' ? value ? 'Stop control' : 'Allow remote control' : value ? 'Control enabled' : 'View only';
  $('control-hint').hidden = !value;
  $('control-hint').textContent = mode === 'host' ? 'Viewer can use your mouse and keyboard. Press Ctrl/Cmd + Shift + Escape to stop remote control.' : 'Click the shared screen to use host mouse/keyboard. Click outside to release input.';
}

async function reset(message = 'Ready to connect') {
  ++operation;
  setControl(false);
  const old = peer;
  peer = null;
  old?.close();
  for (const track of localStream?.getTracks() || []) track.stop();
  localStream = null;
  busy = false;

  $('screen-video').srcObject = null;
  $('screen-video').hidden = true;
  $('screen-empty').hidden = false;
  $('live-label').hidden = true;
  $('session-title').textContent = 'Ready when you are';
  $('route-stat').textContent = 'No active connection';
  $('fps-stat').textContent = '— FPS';
  $('rtt-stat').textContent = '— ms';
  status(message);
  refreshUI();
  await window.wii?.stopCapture();

  // If in host mode, auto-reserve a fresh code
  if (mode === 'host') {
    void initHostSession();
  }
}

function displayStream(stream, local) {
  $('screen-video').srcObject = stream;
  $('screen-video').hidden = false;
  $('screen-empty').hidden = true;
  $('live-label').hidden = false;
  $('live-label').querySelector('span').textContent = local ? 'YOUR SCREEN' : 'LIVE';
  void $('screen-video').play().catch(() => notice('Click the shared screen to start playback.'));
  refreshUI();
}

function addMessage(text, mine) {
  $('chat-empty').hidden = true;
  const row = document.createElement('div');
  row.className = `message${mine ? ' mine' : ''}`;
  const byline = document.createElement('div');
  byline.className = 'byline';
  byline.textContent = `${mine ? 'You' : 'Peer'} · ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  row.append(byline, bubble);
  $('messages').append(row);
  if ($('messages').querySelectorAll('.message').length > 200) $('messages').querySelector('.message').remove();
  $('chat-count').textContent = String(++messages);
  $('messages').scrollTop = $('messages').scrollHeight;
}

function transferRow(t) {
  if (transfers.has(t.id)) return transfers.get(t.id);
  $('file-empty').hidden = true;
  const row = document.createElement('div');
  row.className = 'file-row';
  const name = document.createElement('strong');
  name.textContent = t.name;
  const meta = document.createElement('div');
  meta.className = 'file-meta';
  const label = document.createElement('span'), amount = document.createElement('span');
  meta.append(label, amount);
  const progress = document.createElement('progress');
  progress.max = t.size || 1;
  progress.value = 0;
  progress.setAttribute('aria-label', `Transfer progress for ${t.name}`);
  const buttons = document.createElement('div');
  buttons.className = 'file-buttons';
  const cancel = document.createElement('button');
  cancel.className = 'text-button';
  cancel.textContent = 'Cancel';
  cancel.onclick = () => peer?.files?.cancel(t.id);
  buttons.append(cancel);
  row.append(name, meta, progress, buttons);
  $('file-list').prepend(row);
  const entry = { row, label, amount, progress, buttons, cancel, finished: false };
  transfers.set(t.id, entry);
  $('files-count').textContent = String(transfers.size);
  return entry;
}

function progress(t) {
  const row = transferRow(t);
  const now = performance.now();
  if (row.lastStatus === t.status && ['Sending', 'Receiving'].includes(t.status) && now - row.updatedAt < 100 && t.bytes !== t.size) return;
  row.lastStatus = t.status;
  row.updatedAt = now;
  row.label.textContent = `${t.direction === 'sent' ? '↑' : '↓'} ${t.status}`;
  row.amount.textContent = `${bytes(t.bytes)} / ${bytes(t.size)}`;
  row.progress.value = t.size ? t.bytes : ['Received', 'Delivered'].includes(t.status) ? 1 : 0;
  row.finished = ['Received', 'Delivered', 'Cancelled', 'Declined', 'Failed', 'Disconnected', 'Timed out'].includes(t.status);
  row.cancel.hidden = row.finished;
}

function acceptFile(file, signal) {
  showTab('files');
  const row = transferRow(file);
  return new Promise(resolve => {
    const accept = document.createElement('button');
    accept.className = 'text-button';
    accept.textContent = 'Accept file';
    const decline = document.createElement('button');
    decline.className = 'text-button';
    decline.textContent = 'Decline';
    const finish = value => {
      accept.remove();
      decline.remove();
      signal.removeEventListener('abort', aborted);
      resolve(value);
    };
    const aborted = () => finish(false);
    accept.onclick = () => finish(true);
    decline.onclick = () => finish(false);
    signal.addEventListener('abort', aborted, { once: true });
    row.buttons.prepend(accept, decline);
    if (signal.aborted) aborted();
  });
}

function receivedFile({ id, name, blob }) {
  const row = transfers.get(id);
  if (!row) return;
  row.blobSize = blob.size;
  const url = URL.createObjectURL(blob);
  row.url = url;
  downloadUrls.add(url);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.textContent = 'Save file';
  const dismiss = document.createElement('button');
  dismiss.className = 'text-button';
  dismiss.textContent = 'Dismiss';
  dismiss.onclick = () => {
    URL.revokeObjectURL(url);
    downloadUrls.delete(url);
    transfers.delete(id);
    row.row.remove();
    $('files-count').textContent = String(transfers.size);
  };
  row.buttons.append(link, dismiss);
}

function bindPeer(session) {
  const on = (type, fn) => session.addEventListener(type, event => { if (peer === session) fn(event.detail); });

  on('invitation', code => {
    currentSessionCode = code;
    $('session-code-display').textContent = code;
    $('session-title').textContent = `Session Code: ${code}`;
    
    // Render QR code
    const qrSvg = renderQRCodeSVG(code, 150);
    if (qrSvg) {
      $('qr-svg-wrapper').innerHTML = qrSvg;
    }
    refreshUI();
  });

  on('status', status);
  on('connected', () => {
    $('session-title').textContent = mode === 'host' ? 'You’re sharing your desktop' : 'You’re connected to the host';
    refreshUI();
  });
  on('channels', refreshUI);
  on('stream', stream => displayStream(stream, false));
  on('chat', text => addMessage(text, false));
  on('warning', notice);
  on('error', message => { notice(message); void reset('Session ended'); });
  on('ended', message => { void reset(message); });
  on('input', value => window.wii?.input(value));
  on('control', setControl);
  on('control-lost', () => { setControl(false); void window.wii?.disableControl(); });
  on('stats', stats => {
    $('route-stat').textContent = stats.routeType || (stats.relay === undefined ? 'Direct P2P' : stats.relay ? 'TURN relay' : 'Direct P2P connection');
    $('fps-stat').textContent = `${stats.fps ?? '—'} FPS`;
    $('rtt-stat').textContent = `${stats.rtt ?? '—'} ms`;
  });
}

// Auto-initialize host session with instant 6-digit code
async function initHostSession() {
  if (peer && peer.sessionCode) return;
  try {
    await window.wii?.ensureSignalServer().catch(() => {});
    const networkMode = $('network-mode-select')?.value || 'auto';
    const signalUrl = getSignalUrl();
    const settings = { fps: Number($('fps').value), bitrate: Number($('bitrate').value) };

    const session = peer = new PeerSession(config, { files: { accept: acceptFile, onProgress: progress, onFile: receivedFile } });
    bindPeer(session);

    await session.connectWithCode('host', signalUrl, null, localStream, settings, networkMode);
  } catch (error) {
    console.warn('[HostInit]', error.message);
    $('session-code-display').textContent = 'Tap to retry';
  }
}

// Toggle or start screen sharing for host
async function handleHostShareToggle() {
  if (localStream) {
    // Stop sharing
    for (const track of localStream.getTracks()) track.stop();
    localStream = null;
    peer?.setStream(null);
    $('screen-video').srcObject = null;
    $('screen-video').hidden = true;
    $('screen-empty').hidden = false;
    $('live-label').hidden = true;
    await window.wii?.stopCapture();
    refreshUI();
    return;
  }

  // Start sharing
  notice('');
  busy = true;
  refreshUI();
  const current = ++operation;

  try {
    const settings = { fps: Number($('fps').value), bitrate: Number($('bitrate').value) };

    if (!sourceList.length) {
      await refreshSources();
    }
    let chosenDisplayId = $('display-select').value;
    if (!chosenDisplayId && sourceList.length > 0) {
      chosenDisplayId = sourceList[0].id;
      $('display-select').value = chosenDisplayId;
    }

    if (chosenDisplayId) {
      await window.wii?.selectSource(chosenDisplayId).catch(() => {});
    }
    if (current !== operation) return;

    const stream = await navigator.mediaDevices.getDisplayMedia({
      audio: false,
      video: { frameRate: { ideal: settings.fps }, width: { ideal: 1920 }, height: { ideal: 1080 } }
    });
    if (current !== operation) {
      stream.getTracks().forEach(track => track.stop());
      return;
    }

    localStream = stream;
    const track = stream.getVideoTracks()[0];
    track.contentHint = 'motion';
    await track.applyConstraints({ frameRate: { ideal: settings.fps, max: settings.fps }, width: { max: 1920 }, height: { max: 1080 } }).catch(e => console.log(e));
    if (current !== operation) return;
    await window.wii?.captureStarted().catch(() => {});
    track.onended = () => { if (localStream === stream) void handleHostShareToggle(); };

    displayStream(stream, true);

    if (peer) {
      peer.setStream(stream);
    } else {
      await initHostSession();
    }

    busy = false;
    refreshUI();
  } catch (error) {
    if (current !== operation) return;
    busy = false;
    const msg = error.name === 'NotAllowedError'
      ? 'Screen recording permission was denied. Please allow WiiUltraConnect in your system Privacy settings and try again.'
      : error.message;
    notice(msg);
    refreshUI();
  }
}

// Viewer connection
async function handleViewerConnect() {
  const code = $('session-code-input').value.trim();
  if (!code) {
    notice('Please enter the 6-digit session code (e.g. 482-910).');
    return;
  }

  notice('');
  busy = true;
  refreshUI();
  const current = ++operation;

  try {
    await window.wii?.ensureSignalServer().catch(() => {});
    const networkMode = $('network-mode-select')?.value || 'auto';
    const signalUrl = getSignalUrl();
    const settings = { fps: Number($('fps').value), bitrate: Number($('bitrate').value) };

    if (peer) peer.close();
    const session = peer = new PeerSession(config, { files: { accept: acceptFile, onProgress: progress, onFile: receivedFile } });
    bindPeer(session);

    await session.connectWithCode('viewer', signalUrl, code, null, settings, networkMode);

    if (current !== operation) { session.close(); return; }
    busy = false;
    refreshUI();
  } catch (error) {
    if (current !== operation) return;
    notice(error.message);
    await reset('Connection could not start');
  }
}

async function refreshSources() {
  try {
    sourceList = (await window.wii?.sources()) || [];
    $('display-select').replaceChildren(...sourceList.map(source => new Option(source.name, source.id)));
    if (!sourceList.length) $('display-select').append(new Option('Main Display', 'screen:0:0'));
    previewSource();
    refreshUI();
  } catch (error) {
    console.warn(`Cannot list displays: ${error.message}`);
  }
}

function previewSource() {
  const source = sourceList.find(s => s.id === $('display-select').value);
  $('source-image').hidden = !source;
  $('source-placeholder').hidden = Boolean(source);
  if (source) $('source-image').src = source.thumbnail;
}

// Auto-formatting for 6-digit code input
$('session-code-input').addEventListener('input', e => {
  const val = e.target.value.replace(/[^0-9a-zA-Z]/g, '');
  if (val.length === 6 && /^\d+$/.test(val)) {
    e.target.value = `${val.slice(0, 3)}-${val.slice(3)}`;
  } else if (val.length > 6 && /^\d+$/.test(val)) {
    e.target.value = `${val.slice(0, 3)}-${val.slice(3, 6)}-${val.slice(6, 9)}`;
  }
});

$('session-code-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    void handleViewerConnect();
  }
});

const routeHints = {
  auto: 'Automatically negotiates direct LAN if on same Wi-Fi, otherwise connects across Internet.',
  lan: 'Strictly connects over Local Network / Wi-Fi. Zero external data usage.',
  wan: 'Connects across different networks over the Internet via public STUN.'
};
const routeBadges = {
  auto: 'Auto (LAN/WAN)',
  lan: 'Local LAN',
  wan: 'Internet WAN'
};

$('network-mode-select').onchange = () => {
  const modeVal = $('network-mode-select').value;
  $('route-mode-hint').textContent = routeHints[modeVal] || '';
  $('route-mode-badge').textContent = routeBadges[modeVal] || modeVal.toUpperCase();
  $('route-mode-badge').className = `route-badge ${modeVal}`;
};

$('host-tab').onclick = () => {
  setMode('host');
  if (!currentSessionCode) void initHostSession();
};
$('viewer-tab').onclick = () => setMode('viewer');
$('chat-tab').onclick = () => showTab('chat');
$('files-tab').onclick = () => showTab('files');

$('start-host').onclick = handleHostShareToggle;
$('start-viewer').onclick = handleViewerConnect;
$('refresh-displays').onclick = refreshSources;
$('display-select').onchange = previewSource;
$('disconnect').onclick = () => { void reset('Session ended'); };

$('copy-invitation').onclick = async () => {
  if (!currentSessionCode || currentSessionCode === 'Generating…') return;
  try {
    await navigator.clipboard.writeText(currentSessionCode);
    const copyBtn = $('copy-invitation');
    const copyText = $('copy-btn-text');
    copyBtn.classList.add('copied');
    if (copyText) copyText.textContent = 'Copied! ✓';
    setTimeout(() => {
      copyBtn.classList.remove('copied');
      if (copyText) copyText.textContent = 'Copy Code';
    }, 2000);
  } catch {
    notice(`Your session code is: ${currentSessionCode}`);
  }
};

$('toggle-qr').onclick = () => {
  $('qr-panel').hidden = !$('qr-panel').hidden;
};

$('refresh-code-btn').onclick = async () => {
  $('session-code-display').textContent = 'Generating…';
  if (peer) {
    peer.close();
    peer = null;
  }
  await initHostSession();
};

$('session-code-display').onclick = () => {
  if ($('session-code-display').textContent === 'Tap to retry') {
    void initHostSession();
  }
};

$('control-button').onclick = async () => {
  if (!peer?.ready || mode !== 'host') return;
  const session = peer;
  $('control-button').disabled = true;
  try {
    if (control) {
      setControl(false);
      await window.wii?.disableControl();
    } else {
      const granted = await window.wii?.enableControl();
      if (peer === session && session.ready) setControl(granted);
      else await window.wii?.disableControl();
    }
  } catch (error) {
    notice(error.message);
  } finally {
    refreshUI();
  }
};

$('fullscreen').onclick = () => {
  void (document.fullscreenElement ? document.exitFullscreen() : $('screen-stage').requestFullscreen()).catch(error => notice(error.message));
};

$('chat-form').onsubmit = event => {
  event.preventDefault();
  try {
    const text = $('chat-input').value.trim();
    if (!text) return;
    peer.sendChat(text);
    addMessage(text, true);
    $('chat-input').value = '';
  } catch (error) {
    notice(error.message);
  }
};

$('file-input').onchange = event => {
  try {
    const file = event.target.files[0];
    if (file) {
      peer.files.send(file);
      showTab('files');
    }
  } catch (error) {
    notice(error.message);
  }
  event.target.value = '';
};

window.wii?.onControlRevoked(reason => {
  setControl(false);
  if (reason !== 'Remote control stopped') notice(reason);
});

window.addEventListener('beforeunload', () => {
  viewerInput.dispose();
  peer?.close();
  void window.wii?.stopCapture();
  for (const url of downloadUrls) URL.revokeObjectURL(url);
});

// Startup & Initialization
try {
  if (!window.wii) throw new Error('Open WiiUltraConnect with npm start or npm run dev.');
  config = await window.wii.config();
  if (config.signalUrl) $('signal-url').value = config.signalUrl;
  $('platform-label').textContent = `${{ win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[config.platform] || 'Desktop'} · LAN & Internet`;

  // Detect and display LAN IP
  const netInfo = await window.wii.networkInfo().catch(() => []);
  if (netInfo && netInfo.length > 0) {
    const primaryIp = netInfo[0].address;
    $('lan-ip-display').textContent = `${primaryIp}:8787`;
  } else {
    $('lan-ip-display').textContent = '127.0.0.1:8787';
  }

  // Check screen recording permission on macOS
  if (config.screenAccess === 'denied') {
    notice('⚠️ Screen Recording permission needed: Open System Settings > Privacy & Security > Screen Recording, and enable WiiUltraConnect.');
  }

  await refreshSources();
  refreshUI();

  // Instantly reserve and display active 6-digit session code
  void initHostSession();
} catch (error) {
  notice(error.message);
  busy = true;
  refreshUI();
}
