import { PeerSession } from './peer.js';
import { ViewerInput } from './viewer-input.js';
import { networkSummary } from './protocol.js';
import { QUALITY, MAX_CLIPBOARD } from './session-messages.js';

const $ = id => document.getElementById(id);
let config, mode = 'host', peer = null, localStream = null, busy = false, operation = 0, sourceList = [], control = false, granting = false;
let messages = 0, pendingClipboard = '', changingDisplay = false;
const transfers = new Map(), downloadUrls = new Set();
const bytes = value => value < 1024 ? value + ' B' : value < 1024 ** 2 ? (value / 1024).toFixed(1) + ' KiB' : (value / 1024 ** 2).toFixed(1) + ' MiB';
const video = $('screen-video');
const viewerInput = new ViewerInput(video, event => peer?.sendInput(event));
function notice(message) { $('notice').textContent = message; $('notice').hidden = !message; }
function status(message) { $('session-status').textContent = message; }
function setMode(value) {
  if (peer || busy) return;
  mode = value;
  for (const name of ['host', 'viewer']) {
    $(name + '-panel').hidden = name !== value;
    $(name + '-tab').classList.toggle('selected', name === value);
    $(name + '-tab').setAttribute('aria-selected', String(name === value));
  }
  setControl(false); refreshUI();
}
function showTab(value) {
  $('collaboration-area').hidden = false;
  for (const name of ['chat', 'files']) {
    $(name + '-panel').hidden = name !== value;
    $(name + '-tab').classList.toggle('selected', name === value);
    $(name + '-tab').setAttribute('aria-selected', String(name === value));
  }
}
function refreshUI() {
  const active = Boolean(peer), connected = Boolean(peer?.ready), stream = Boolean(video.srcObject);
  for (const id of ['host-tab', 'viewer-tab', 'start-viewer', 'fps', 'bitrate', 'share-audio', 'invitation-input']) $(id).disabled = active || busy;
  $('share-audio').disabled ||= !config?.systemAudio;
  $('start-host').disabled = active || busy || !sourceList.length;
  $('start-host').textContent = busy && !active ? 'Preparing display…' : active ? 'Session active' : 'Create invitation ↗';
  $('apply-response').disabled = busy || peer?.phase !== 'awaiting-answer';
  $('response-input').disabled = busy || peer?.phase !== 'awaiting-answer';
  $('disconnect').disabled = !active && !localStream && !busy;
  $('display-select').disabled = busy || changingDisplay || active && !connected;
  $('refresh-displays').disabled = busy || changingDisplay;
  $('switch-display').hidden = mode !== 'host' || !connected;
  $('switch-display').disabled = busy || changingDisplay;
  for (const id of ['chat-input', 'send-chat', 'file-input', 'send-clipboard', 'quality']) $(id).disabled = !connected;
  $('control-button').disabled = !connected || busy || granting;
  $('remote-display').hidden = mode !== 'viewer' || !connected;
  $('remote-display').disabled = !connected || !control;
  $('shortcut').disabled = mode !== 'viewer' || !connected || !control;
  for (const id of ['fullscreen', 'view-scale', 'screenshot']) $(id).disabled = !stream;
  $('audio-toggle').disabled = mode !== 'viewer' || !stream;
  $('connection-badge').classList.toggle('connected', connected);
  $('connection-badge').querySelector('span').textContent = connected ? 'Connected' : active ? peer.phase === 'reconnecting' ? 'Reconnecting' : 'Connecting' : 'Ready';
  if (connected) { $('host-exchange').hidden = true; $('viewer-exchange').hidden = true; }
}
function setControl(value) {
  control = Boolean(value);
  if (mode === 'host') peer?.setControl(control);
  viewerInput.setEnabled(mode === 'viewer' && control);
  $('control-button').textContent = mode === 'host' ? control ? 'Stop control' : 'Allow control' : control ? 'Release control' : 'Request control';
  $('control-hint').hidden = !control;
  $('control-hint').textContent = mode === 'host'
    ? 'Remote control is active. Ctrl/Cmd + Alt + Shift + F12 immediately stops access.'
    : 'Click the desktop to control it. F11 toggles fullscreen. Ctrl/Cmd + Shift + Escape releases input. OS secure screens and reserved shortcuts may require the host.';
  refreshUI();
}
async function reset(message = 'Ready to connect') {
  const current = ++operation;
  busy = true; setControl(false);
  const old = peer; peer = null; old?.close();
  for (const track of localStream?.getTracks() || []) track.stop();
  localStream = null; granting = false; changingDisplay = false;
  lastControlRequest = 0; lastQualityRequest = 0;
  video.srcObject = null; video.hidden = true; video.muted = true;
  $('audio-toggle').textContent = 'Unmute';
  $('screen-empty').hidden = false; $('live-label').hidden = true;
  $('session-title').textContent = 'Ready when you are'; $('session-id').textContent = '';
  $('route-stat').textContent = 'No active connection'; $('fps-stat').textContent = '— FPS'; $('rtt-stat').textContent = '— ms';
  $('resolution-stat').textContent = ''; $('bandwidth-stat').textContent = '';
  for (const id of ['invitation-output', 'response-input', 'response-output']) $(id).value = '';
  $('host-exchange').hidden = true; $('viewer-exchange').hidden = true;
  $('clipboard-incoming').hidden = true; pendingClipboard = ''; $('clipboard-preview').textContent = '';
  $('screen-stage').classList.remove('actual'); $('view-scale').value = 'fit';
  if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
  status(message); refreshUI();
  await window.wii?.stopCapture();
  if (current === operation) { busy = false; refreshUI(); }
}
function displayStream(stream, local) {
  video.srcObject = stream; video.muted = true;
  video.hidden = false; $('screen-empty').hidden = true; $('live-label').hidden = false;
  $('live-label').querySelector('span').textContent = local ? 'YOUR SCREEN' : 'LIVE';
  void video.play().catch(() => notice('Click the shared desktop to start playback.'));
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
  for (const [id, entry] of transfers) {
    if (transfers.size < 80) break;
    if (entry.finished) {
      if (entry.url) { URL.revokeObjectURL(entry.url); downloadUrls.delete(entry.url); }
      entry.row.remove(); transfers.delete(id);
    }
  }
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
  let retained = [...transfers.values()].reduce((sum, entry) => sum + (entry.blobSize || 0), 0);
  for (const [oldId, entry] of transfers) {
    if (retained + blob.size <= 256 * 1024 * 1024) break;
    if (!entry.url || oldId === id) continue;
    URL.revokeObjectURL(entry.url); downloadUrls.delete(entry.url);
    retained -= entry.blobSize || 0; entry.row.remove(); transfers.delete(oldId);
  }
  $('files-count').textContent = String(transfers.size);
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


function newPeer() {
  const session = new PeerSession({}, { files: { accept: acceptFile, onProgress: progress, onFile: receivedFile } });
  peer = session;
  const on = (type, fn) => session.addEventListener(type, event => {
    if (peer !== session) return;
    Promise.resolve().then(() => { if (peer === session) return fn(event.detail); }).catch(error => { if (peer === session) notice(error.message); });
  });
  on('invitation', code => { $('invitation-output').value = code; $('host-exchange').hidden = false; $('session-id').textContent = session.offer.sessionId.slice(0, 8); refreshUI(); });
  on('response', code => { $('response-output').value = code; $('viewer-exchange').hidden = false; $('session-id').textContent = session.offer.sessionId.slice(0, 8); refreshUI(); });
  on('status', text => { status(text); refreshUI(); });
  on('diagnostics', value => { $('network-summary').textContent = value.message; });
  on('connected', async () => {
    $('session-title').textContent = mode === 'host' ? 'You’re sharing your desktop' : 'Your partner’s desktop';
    await window.wii.sessionActive(true);
    refreshUI(); publishDisplays();
  });
  on('channels', () => { refreshUI(); publishDisplays(); });
  on('stream', stream => displayStream(stream, false));
  on('chat', text => { addMessage(text, false); $('collaboration-area').hidden = false; });
  on('warning', notice);
  on('error', async message => { notice(message); await reset('Session ended'); });
  on('ended', message => reset(message));
  on('input', value => window.wii.input(value));
  on('control', setControl);
  on('control-lost', async () => { setControl(false); await window.wii.sessionActive(false); });
  on('session-message', handleSessionMessage);
  on('stats', stats => {
    $('route-stat').textContent = stats.routeType || 'Direct route';
    $('fps-stat').textContent = (stats.fps ?? '—') + ' FPS';
    $('rtt-stat').textContent = (stats.rtt ?? '—') + ' ms';
    $('resolution-stat').textContent = stats.width ? stats.width + ' × ' + stats.height : '';
    $('bandwidth-stat').textContent = stats.mbps ? stats.mbps + ' Mbps' : '';
  });
  return session;
}
function publishDisplays() {
  if (mode !== 'host' || !peer?.ready) return;
  peer.sendSession({ type: 'displays', displays: sourceList.slice(0, 32).map(s => ({ id: s.id, name: s.name })), selected: selectedDisplay });
  const quality = Object.entries(QUALITY).find(([, value]) => value.fps === peer.settings.fps && value.bitrate === peer.settings.bitrate)?.[0] || 'custom';
  $('quality').value = quality;
  peer.sendSession({ type: 'quality', quality });
}
let selectedDisplay = '';
async function captureDisplay(id, settings, current, switching = false) {
  if (!id) throw new Error('No display is available. Refresh displays and check screen recording permissions.');
  await window.wii.selectSource(id, !switching && $('share-audio').checked);
  if (current !== operation) return null;
  const stream = await navigator.mediaDevices.getDisplayMedia({
    audio: !switching && $('share-audio').checked,
    video: { frameRate: { ideal: settings.fps, max: settings.fps } }
  });
  if (current !== operation) { stream.getTracks().forEach(t => t.stop()); return null; }
  try {
    const track = stream.getVideoTracks()[0];
    await track.applyConstraints({ frameRate: { ideal: settings.fps, max: settings.fps }, width: { max: 3840 }, height: { max: 2160 } });
    if (current !== operation) { stream.getTracks().forEach(t => t.stop()); return null; }
    await window.wii.captureStarted();
    if (current !== operation) { stream.getTracks().forEach(t => t.stop()); return null; }
    track.onended = () => { if (localStream === stream) void reset('Screen sharing stopped'); };
    return stream;
  } catch (error) { stream.getTracks().forEach(t => t.stop()); throw error; }
}
async function startHost() {
  if (peer || busy) return;
  notice(''); busy = true; const current = ++operation; refreshUI();
  try {
    const settings = { fps: Number($('fps').value), bitrate: Number($('bitrate').value) };
    if (!sourceList.length) await refreshSources();
    const stream = await captureDisplay($('display-select').value, settings, current);
    if (!stream) return;
    localStream = stream; selectedDisplay = $('display-select').value; displayStream(stream, true);
    const session = newPeer();
    await session.createInvitation(stream, settings);
    if (current !== operation) { session.close(); return; }
  } catch (error) {
    if (current === operation) { notice(error.message); await reset('Could not start screen sharing'); }
  } finally { if (current === operation) { busy = false; refreshUI(); } }
}
async function startViewer() {
  if (peer || busy) return;
  notice(''); busy = true; const current = ++operation; refreshUI();
  const session = newPeer();
  try {
    await session.createResponse($('invitation-input').value);
    if (current !== operation) session.close();
  } catch (error) {
    if (current === operation) { notice(error.message); await reset('Could not create a response'); }
  } finally { if (current === operation) { busy = false; refreshUI(); } }
}
async function applyResponse() {
  if (!peer || busy || peer.phase !== 'awaiting-answer') return;
  notice(''); busy = true; const session = peer; refreshUI();
  try { await session.applyResponse($('response-input').value); }
  catch (error) { notice(error.message); }
  finally { if (peer === session) { busy = false; refreshUI(); } }
}
async function changeDisplay(id, remote = false) {
  if (mode !== 'host' || !peer?.ready || busy || changingDisplay || !sourceList.some(s => s.id === id)) return;
  const session = peer, current = operation;
  changingDisplay = true; refreshUI();
  let stream;
  try {
    if (remote && !await window.wii.confirmDisplaySwitch(id)) return;
    if (peer !== session || current !== operation) return;
    setControl(false);
    stream = await captureDisplay(id, session.settings, current, true);
    if (!stream) return;
    if (peer !== session || !session.ready) { stream.getTracks().forEach(t => t.stop()); return; }
    await session.setStream(stream);
    if (peer !== session) return;
    localStream = stream; selectedDisplay = id; $('display-select').value = id;
    displayStream(stream, true); previewSource(); publishDisplays();
    notice('Display changed. Enable remote control again after checking the new display.');
  } catch (error) {
    stream?.getTracks().forEach(t => t.stop());
    if (peer === session) { notice(error.message); await reset('Display capture could not continue'); }
  } finally { changingDisplay = false; refreshUI(); }
}
async function grantControl() {
  if (!peer?.ready || granting || mode !== 'host') return;
  const session = peer; granting = true; refreshUI();
  try {
    if (control) { setControl(false); await window.wii.disableControl(); }
    else {
      const granted = await window.wii.enableControl();
      if (peer === session && session.ready) setControl(granted);
      else await window.wii.disableControl();
    }
  } catch (error) { notice(error.message); }
  finally { granting = false; refreshUI(); }
}
let lastControlRequest = 0, lastQualityRequest = 0;
async function handleSessionMessage(message) {
  if (message.type === 'control-release') {
    setControl(false); await window.wii.disableControl();
  } else if (message.type === 'control-request') {
    if (Date.now() - lastControlRequest < 10_000 || control || granting) return;
    lastControlRequest = Date.now(); await grantControl();
  } else if (message.type === 'display-request') await changeDisplay(message.id, true);
  else if (message.type === 'displays') {
    $('remote-display').replaceChildren(...message.displays.map(s => new Option(s.name, s.id)));
    $('remote-display').value = message.selected; refreshUI();
  } else if (message.type === 'clipboard') {
    pendingClipboard = message.text; $('clipboard-preview').textContent = message.text;
    $('clipboard-incoming').hidden = false;
  } else if (message.type === 'quality-request') {
    if (Date.now() - lastQualityRequest < 2000) return;
    lastQualityRequest = Date.now();
    const session = peer;
    await session.setQuality(message.quality);
    if (peer === session) $('quality').value = message.quality;
  } else if (message.type === 'quality') $('quality').value = message.quality;
}
async function refreshSources() {
  const previous = $('display-select').value || selectedDisplay;
  sourceList = await window.wii.sources();
  $('display-select').replaceChildren(...sourceList.map(s => new Option(s.name, s.id)));
  if (sourceList.some(s => s.id === previous)) $('display-select').value = previous;
  if (!sourceList.length) $('display-select').append(new Option('No displays available', ''));
  previewSource(); refreshUI(); publishDisplays();
}
function previewSource() {
  const source = sourceList.find(s => s.id === $('display-select').value);
  $('source-image').hidden = !source; $('source-placeholder').hidden = Boolean(source);
  if (source) $('source-image').src = source.thumbnail;
}
async function checkNetwork() {
  const info = await window.wii.networkInfo();
  $('network-summary').textContent = networkSummary(info.map(i => i.address)).message;
  $('network-addresses').textContent = info.map(i => i.family + ' · ' + i.address).join('\n');
}
async function copyCode(id) {
  const value = $(id).value;
  if (!value) return;
  // Connection codes exceed the separate 16K shared-clipboard limit.
  await navigator.clipboard.writeText(value);
  status('Code copied. Send it privately to your partner.');
}
async function toggleFullscreen() {
  if (!video.srcObject) return;
  viewerInput.release();
  if (document.fullscreenElement) await document.exitFullscreen();
  else { $('collaboration-area').hidden = true; await $('session-panel').requestFullscreen(); }
  if (mode === 'viewer' && control) video.focus();
}
function handle(id, fn, event = 'click') {
  $(id).addEventListener(event, e => { Promise.resolve().then(() => fn(e)).catch(error => notice(error.message)); });
}
handle('host-tab', () => setMode('host')); handle('viewer-tab', () => setMode('viewer'));
handle('chat-tab', () => showTab('chat')); handle('files-tab', () => showTab('files'));
handle('start-host', startHost); handle('start-viewer', startViewer); handle('apply-response', applyResponse);
handle('refresh-displays', refreshSources); handle('refresh-network', checkNetwork);
handle('display-select', previewSource, 'change'); handle('switch-display', () => changeDisplay($('display-select').value));
handle('remote-display', () => peer.sendSession({ type: 'display-request', id: $('remote-display').value }), 'change');
handle('disconnect', () => reset('Session ended')); handle('copy-invitation', () => copyCode('invitation-output'));
handle('copy-response', () => copyCode('response-output'));
handle('control-button', async () => {
  if (mode === 'host') return grantControl();
  if (control) { peer.sendSession({ type: 'control-release' }); setControl(false); video.blur(); return; }
  peer.sendSession({ type: 'control-request' }); status('Control requested. Your partner must approve it.');
});
handle('fullscreen', toggleFullscreen);
document.addEventListener('fullscreenchange', () => {
  $('fullscreen').textContent = document.fullscreenElement ? '⛶ Exit fullscreen' : '⛶ Fullscreen';
  viewerInput.release();
  if (!document.fullscreenElement) $('collaboration-area').hidden = false;
});
window.addEventListener('keydown', event => {
  if (event.code === 'F11') { event.preventDefault(); if (!event.repeat) void toggleFullscreen().catch(error => notice(error.message)); }
});
handle('view-scale', () => { viewerInput.release(); $('screen-stage').classList.toggle('actual', $('view-scale').value === 'actual'); }, 'change');
handle('quality', async () => {
  if (mode === 'host') await peer.setQuality($('quality').value);
  else peer.sendSession({ type: 'quality-request', quality: $('quality').value });
}, 'change');
handle('shortcut', () => {
  const shortcuts = { desktop: ['MetaLeft', 'KeyD'], switch: ['AltLeft', 'Tab'], files: ['MetaLeft', 'KeyE'], escape: ['Escape'] };
  if (Object.hasOwn(shortcuts, $('shortcut').value)) viewerInput.shortcut(shortcuts[$('shortcut').value]);
  $('shortcut').value = '';
}, 'change');
handle('toggle-tools', () => { $('collaboration-area').hidden = !$('collaboration-area').hidden; });
handle('audio-toggle', () => { video.muted = !video.muted; $('audio-toggle').textContent = video.muted ? 'Unmute' : 'Mute'; });
handle('send-clipboard', async () => {
  const session = peer;
  const text = (await window.wii.readClipboard()).slice(0, MAX_CLIPBOARD);
  if (!text) return notice('Your text clipboard is empty.');
  if (peer === session && session.ready) { session.sendSession({ type: 'clipboard', text }); status('Clipboard sent. Your partner can accept it.'); }
});
handle('accept-clipboard', async () => {
  const text = pendingClipboard;
  await window.wii.writeClipboard(text);
  if (pendingClipboard === text) { pendingClipboard = ''; $('clipboard-incoming').hidden = true; $('clipboard-preview').textContent = ''; }
});
handle('dismiss-clipboard', () => { pendingClipboard = ''; $('clipboard-incoming').hidden = true; $('clipboard-preview').textContent = ''; });
handle('screenshot', () => {
  if (!video.videoWidth) throw new Error('Wait for a video frame before taking a screenshot.');
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth; canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  canvas.toBlob(blob => {
    if (!blob) return;
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    downloadUrls.add(url); link.href = url;
    link.download = 'WiiUltraConnect-' + new Date().toISOString().replace(/[:.]/g, '-') + '.png'; link.click();
    setTimeout(() => { URL.revokeObjectURL(url); downloadUrls.delete(url); }, 30_000);
  }, 'image/png');
});
$('chat-form').onsubmit = event => {
  event.preventDefault();
  try { const text = $('chat-input').value.trim(); if (text) { peer.sendChat(text); addMessage(text, true); $('chat-input').value = ''; } }
  catch (error) { notice(error.message); }
};
handle('file-input', event => {
  const file = event.target.files[0]; event.target.value = '';
  if (file) { peer.files.send(file); showTab('files'); }
}, 'change');
video.addEventListener('click', () => { if (video.paused) void video.play().catch(error => notice(error.message)); });
window.wii?.onControlRevoked(reason => { setControl(false); if (reason !== 'Remote control stopped') notice(reason); });
window.wii?.onCaptureEnded(reason => { notice(reason); void reset(reason); });
window.addEventListener('beforeunload', () => {
  viewerInput.dispose(); peer?.close(); void window.wii?.stopCapture();
  for (const url of downloadUrls) URL.revokeObjectURL(url);
});
try {
  if (!window.wii) throw new Error('Open WiiUltraConnect with npm start or the installed desktop app.');
  config = await window.wii.config();
  $('platform-label').textContent = ({ win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[config.platform] || 'Desktop') + ' · Direct';
  $('app-version').textContent = 'v' + config.version;
  if (!config.systemAudio) $('share-audio').checked = false;
  if (config.screenAccess === 'denied') notice('Enable Screen Recording for WiiUltraConnect in System Settings, then restart the app.');
  await Promise.all([refreshSources(), checkNetwork()]);
  refreshUI();
} catch (error) { notice(error.message); busy = true; refreshUI(); }
