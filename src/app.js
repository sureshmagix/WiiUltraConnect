import { PeerSession } from './peer.js';
import { ViewerInput } from './viewer-input.js';
const $ = id => document.getElementById(id);
let config, mode = 'host', peer, localStream, busy = false, operation = 0, sourceList = [], control = false;
let messages = 0;
const transfers = new Map();
const downloadUrls = new Set();
const bytes = value => value < 1024 ? `${value} B` : value < 1024 ** 2 ? `${(value / 1024).toFixed(1)} KiB` : `${(value / 1024 ** 2).toFixed(1)} MiB`;
const viewerInput = new ViewerInput($('screen-video'), event => peer?.sendInput(event));

function notice(message) { $('notice').textContent = message; $('notice').hidden = !message; }
function status(message) { $('session-status').textContent = message; }
function setMode(value) {
  if (peer || busy) return;
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
  const active = Boolean(peer), ready = Boolean(peer?.ready), locked = active || busy;
  for (const id of ['host-tab', 'viewer-tab', 'start-host', 'start-viewer', 'refresh-displays', 'fps', 'bitrate', 'display-select', 'signal-url', 'invitation-input']) $(id).disabled = locked;
  $('start-host').disabled ||= !sourceList.length;
  $('disconnect').disabled = !locked;
  for (const id of ['chat-input', 'send-chat', 'file-input']) $(id).disabled = !ready;
  $('control-button').disabled = mode !== 'host' || !ready || busy;
  $('fullscreen').disabled = !$('screen-video').srcObject;
  $('connection-badge').classList.toggle('connected', ready);
  $('connection-badge').querySelector('span').textContent = ready ? 'Connected' : active ? 'Connecting' : 'Offline';
}
function setControl(value) {
  control = value;
  if (mode === 'host') peer?.setControl(value);
  viewerInput.setEnabled(mode === 'viewer' && value);
  $('control-button').textContent = mode === 'host' ? value ? 'Stop control' : 'Allow remote control' : value ? 'Control enabled' : 'View only';
  $('control-hint').hidden = !value;
  $('control-hint').textContent = mode === 'host' ? 'Viewer can use your mouse and keyboard. Ctrl/Cmd + Shift + Escape stops remote control.' : 'Click the shared screen to use the host mouse and keyboard. Click outside it to release input.';
}
async function reset(message = 'Ready to connect') {
  ++operation;
  setControl(false);
  const old = peer; peer = null;
  old?.close();
  for (const track of localStream?.getTracks() || []) track.stop();
  localStream = null;
  busy = false;
  $('screen-video').srcObject = null;
  $('screen-video').hidden = true;
  $('screen-empty').hidden = false;
  $('live-label').hidden = true;
  $('invitation-card').hidden = true;
  $('invitation-output').value = '';
  $('session-title').textContent = 'Ready when you are';
  $('route-stat').textContent = 'No active connection';
  $('fps-stat').textContent = '— FPS';
  $('rtt-stat').textContent = '— ms';
  status(message);
  refreshUI();
  await window.wii.stopCapture();
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
  const row = document.createElement('div'); row.className = `message${mine ? ' mine' : ''}`;
  const byline = document.createElement('div'); byline.className = 'byline';
  byline.textContent = `${mine ? 'You' : 'Peer'} · ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  const bubble = document.createElement('div'); bubble.className = 'bubble'; bubble.textContent = text;
  row.append(byline, bubble); $('messages').append(row);
  if ($('messages').querySelectorAll('.message').length > 200) $('messages').querySelector('.message').remove();
  $('chat-count').textContent = String(++messages);
  $('messages').scrollTop = $('messages').scrollHeight;
}
function transferRow(t) {
  if (transfers.has(t.id)) return transfers.get(t.id);
  $('file-empty').hidden = true;
  const row = document.createElement('div'); row.className = 'file-row';
  const name = document.createElement('strong'); name.textContent = t.name;
  const meta = document.createElement('div'); meta.className = 'file-meta';
  const label = document.createElement('span'), amount = document.createElement('span'); meta.append(label, amount);
  const progress = document.createElement('progress'); progress.max = t.size || 1; progress.value = 0; progress.setAttribute('aria-label', `Transfer progress for ${t.name}`);
  const buttons = document.createElement('div'); buttons.className = 'file-buttons';
  const cancel = document.createElement('button'); cancel.className = 'text-button'; cancel.textContent = 'Cancel'; cancel.onclick = () => peer?.files?.cancel(t.id);
  buttons.append(cancel); row.append(name, meta, progress, buttons); $('file-list').prepend(row);
  const entry = { row, label, amount, progress, buttons, cancel, finished: false };
  transfers.set(t.id, entry); $('files-count').textContent = String(transfers.size);
  // Bound retained Blobs and DOM history, including completed download links.
  if (transfers.size > 20) {
    const oldest = [...transfers].find(([, v]) => v.finished);
    if (oldest) {
      if (oldest[1].url) { URL.revokeObjectURL(oldest[1].url); downloadUrls.delete(oldest[1].url); }
      oldest[1].row.remove(); transfers.delete(oldest[0]);
    }
  }
  return entry;
}
function progress(t) {
  const row = transferRow(t);
  const now = performance.now();
  if (row.lastStatus === t.status && ['Sending', 'Receiving'].includes(t.status) && now - row.updatedAt < 100 && t.bytes !== t.size) return;
  row.lastStatus = t.status; row.updatedAt = now;
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
    const accept = document.createElement('button'); accept.className = 'text-button'; accept.textContent = 'Accept file';
    const decline = document.createElement('button'); decline.className = 'text-button'; decline.textContent = 'Decline';
    const finish = value => { accept.remove(); decline.remove(); signal.removeEventListener('abort', aborted); resolve(value); };
    const aborted = () => finish(false);
    accept.onclick = () => finish(true); decline.onclick = () => finish(false);
    signal.addEventListener('abort', aborted, { once: true });
    row.buttons.prepend(accept, decline);
    if (signal.aborted) aborted();
  });
}
function receivedFile({ id, name, blob }) {
  const row = transfers.get(id);
  if (!row) return;
  let retainedBytes = [...transfers.values()].reduce((sum, item) => sum + (item.blobSize || 0), 0);
  for (const item of transfers.values()) {
    if (retainedBytes + blob.size <= 256 * 1024 * 1024) break;
    if (item.url) {
      URL.revokeObjectURL(item.url); downloadUrls.delete(item.url);
      item.buttons.replaceChildren(); item.label.textContent = 'Removed from recent files';
      retainedBytes -= item.blobSize; item.blobSize = 0; item.url = null;
    }
  }
  row.blobSize = blob.size;
  const url = URL.createObjectURL(blob); row.url = url; downloadUrls.add(url);
  const link = document.createElement('a'); link.href = url; link.download = name; link.textContent = 'Save file';
  const dismiss = document.createElement('button'); dismiss.className = 'text-button'; dismiss.textContent = 'Dismiss';
  dismiss.onclick = () => { URL.revokeObjectURL(url); downloadUrls.delete(url); transfers.delete(id); row.row.remove(); $('files-count').textContent = String(transfers.size); };
  row.buttons.append(link, dismiss);
}
function bindPeer(session) {
  const on = (type, fn) => session.addEventListener(type, event => { if (peer === session) fn(event.detail); });
  on('invitation', invitation => { $('invitation-output').value = invitation; $('invitation-card').hidden = false; $('session-title').textContent = 'Your screen is ready to share'; });
  on('status', status);
  on('connected', () => { $('session-title').textContent = mode === 'host' ? 'You’re sharing your desktop' : 'You’re connected to the host'; refreshUI(); });
  on('channels', refreshUI);
  on('stream', stream => displayStream(stream, false));
  on('chat', text => addMessage(text, false));
  on('warning', notice);
  on('error', message => { notice(message); void reset('Session ended'); });
  on('ended', message => { void reset(message); });
  on('input', value => window.wii.input(value));
  on('control', setControl);
  on('control-lost', () => { setControl(false); void window.wii.disableControl(); });
  on('stats', stats => {
    $('route-stat').textContent = stats.relay === undefined ? 'Negotiating route' : stats.relay ? 'TURN relay' : 'Direct peer connection';
    $('fps-stat').textContent = `${stats.fps ?? '—'} FPS`;
    $('rtt-stat').textContent = `${stats.rtt ?? '—'} ms`;
  });
}
async function start() {
  if (peer || busy) return;
  notice(''); busy = true; refreshUI();
  const current = ++operation;
  try {
    const settings = { fps: Number($('fps').value), bitrate: Number($('bitrate').value) };
    if (mode === 'host') {
      await window.wii.selectSource($('display-select').value);
      if (current !== operation) return;
      const stream = await navigator.mediaDevices.getDisplayMedia({ audio: false, video: { frameRate: { ideal: settings.fps }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
      if (current !== operation) { stream.getTracks().forEach(track => track.stop()); return; }
      localStream = stream;
      const track = stream.getVideoTracks()[0];
      track.contentHint = 'motion';
      await track.applyConstraints({ frameRate: { ideal: settings.fps, max: settings.fps }, width: { max: 1920 }, height: { max: 1080 } }).catch(error => notice(`Display started with default constraints: ${error.message}`));
      if (current !== operation) return;
      await window.wii.captureStarted();
      track.onended = () => { if (localStream === stream) void reset('Screen sharing stopped'); };
      displayStream(stream, true);
    }
    if (current !== operation) return;
    const session = peer = new PeerSession(config, { files: { accept: acceptFile, onProgress: progress, onFile: receivedFile } });
    bindPeer(session);
    await session.connect(mode, $('signal-url').value, $('invitation-input').value, localStream, settings);
    if (current !== operation) { session.close(); return; }
    busy = false; refreshUI();
  } catch (error) {
    if (current !== operation) return;
    notice(error.name === 'NotAllowedError' ? 'Screen sharing was denied. Allow screen recording in system privacy settings and try again.' : error.message);
    await reset('Connection could not start');
  }
}
async function refreshSources() {
  try {
    sourceList = await window.wii.sources();
    $('display-select').replaceChildren(...sourceList.map(source => new Option(source.name, source.id)));
    if (!sourceList.length) $('display-select').append(new Option('No displays available', ''));
    previewSource(); refreshUI();
  } catch (error) { notice(`Cannot list displays: ${error.message}`); }
}
function previewSource() {
  const source = sourceList.find(s => s.id === $('display-select').value);
  $('source-image').hidden = !source;
  $('source-placeholder').hidden = Boolean(source);
  if (source) $('source-image').src = source.thumbnail;
}
$('host-tab').onclick = () => setMode('host'); $('viewer-tab').onclick = () => setMode('viewer');
$('chat-tab').onclick = () => showTab('chat'); $('files-tab').onclick = () => showTab('files');
$('start-host').onclick = start; $('start-viewer').onclick = start;
$('refresh-displays').onclick = refreshSources; $('display-select').onchange = previewSource;
$('disconnect').onclick = () => { void reset('Session ended'); };
$('screen-video').onclick = () => { void $('screen-video').play().catch(error => notice(error.message)); };
$('fullscreen').onclick = () => { void (document.fullscreenElement ? document.exitFullscreen() : $('screen-stage').requestFullscreen()).catch(error => notice(error.message)); };
$('copy-invitation').onclick = async () => {
  try { await navigator.clipboard.writeText($('invitation-output').value); $('copy-invitation').textContent = 'Copied'; setTimeout(() => { $('copy-invitation').textContent = 'Copy'; }, 2000); }
  catch { $('invitation-output').select(); notice('Select and copy the invitation with Ctrl/Cmd + C.'); }
};
$('control-button').onclick = async () => {
  if (!peer?.ready || mode !== 'host') return;
  const session = peer;
  $('control-button').disabled = true;
  try {
    if (control) { setControl(false); await window.wii.disableControl(); }
    else { const granted = await window.wii.enableControl(); if (peer === session && session.ready) setControl(granted); else await window.wii.disableControl(); }
  } catch (error) { notice(error.message); }
  finally { refreshUI(); }
};
$('chat-form').onsubmit = event => {
  event.preventDefault();
  try { const text = $('chat-input').value.trim(); if (!text) return; peer.sendChat(text); addMessage(text, true); $('chat-input').value = ''; }
  catch (error) { notice(error.message); }
};
$('file-input').onchange = event => {
  try { const file = event.target.files[0]; if (file) { peer.files.send(file); showTab('files'); } }
  catch (error) { notice(error.message); }
  event.target.value = '';
};
window.wii?.onControlRevoked(reason => { setControl(false); if (reason !== 'Remote control stopped') notice(reason); });
window.addEventListener('beforeunload', () => { viewerInput.dispose(); peer?.close(); void window.wii.stopCapture(); for (const url of downloadUrls) URL.revokeObjectURL(url); });
try {
  if (!window.wii) throw new Error('Open WiiUltraConnect with npm run dev. The host requires Electron.');
  config = await window.wii.config();
  $('signal-url').value = config.signalUrl;
  $('platform-label').textContent = `${{ win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[config.platform] || 'Desktop'} workspace`;
  await refreshSources();
  refreshUI();
} catch (error) { notice(error.message); busy = true; refreshUI(); }
