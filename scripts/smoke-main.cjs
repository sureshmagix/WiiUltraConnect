const { app, BrowserWindow, session, dialog, clipboard, ipcMain } = require('electron');
const { mkdirSync, writeFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const path = require('node:path');
const assert = require('node:assert/strict');
const artifacts = path.join(__dirname, '../artifacts/serverless');
mkdirSync(artifacts, { recursive: true });
app.setPath('userData', path.join(artifacts, 'smoke-profile'));
// Exercise the real renderer → WebRTC → trusted IPC → InputController boundary,
// but replace the final OS input provider so tests cannot type into the user's apps.
const { InputController } = require('../electron/input-controller.cjs');
const realNative = require('@nut-tree-fork/nut-js');
const nativeCalls = [], clipboardWrites = [];
const fakeNative = {
  Key: realNative.Key, Button: realNative.Button, Point: realNative.Point,
  keyboard: { config: {}, pressKey: async key => nativeCalls.push(['key-down', key]), releaseKey: async key => nativeCalls.push(['key-up', key]) },
  mouse: { config: {}, setPosition: async point => nativeCalls.push(['move', point.x, point.y]), pressButton: async button => nativeCalls.push(['button-down', button]), releaseButton: async button => nativeCalls.push(['button-up', button]), scrollDown: async n => nativeCalls.push(['wheel-down', n]), scrollUp: async n => nativeCalls.push(['wheel-up', n]) }
};
require.cache[require.resolve('../electron/input-controller.cjs')].exports.InputController = class extends InputController {
  constructor(options) { super({ ...options, loadNative: async () => fakeNative }); }
};
let consent = 0;
dialog.showMessageBox = async () => ({ response: consent });
clipboard.readText = () => 'clipboard from host';
clipboard.writeText = text => clipboardWrites.push(['host', text]);
ipcMain.handle('smoke:clipboard', (_event, text) => clipboardWrites.push(['viewer', text]));
require('../electron/main.cjs');
const errors = [];
const serviceRequests = [];
const report = [];
function record(text) { report.push(text); console.log(`PASS ${text}`); }
function observe(win) {
  win.webContents.on('console-message', event => {
    if (event.level === 'error') errors.push(event.message);
  });
}
async function until(fn, message, timeout = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(message);
}
const js = (win, code) => win.webContents.executeJavaScript(code, true);
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
    serviceRequests.push(details.url); callback({ cancel: true });
  });
  await until(() => BrowserWindow.getAllWindows().length, 'App did not open');
  const host = BrowserWindow.getAllWindows()[0];
  observe(host);
  await until(async () => !host.webContents.isLoading() && await js(host, "Boolean(document.getElementById('platform-label')?.textContent.includes('Direct'))"), 'App did not initialize');
  await until(() => js(host, "document.getElementById('display-select').options.length && !document.getElementById('start-host').disabled"), 'No displays available');
  const initial = await js(host, "({title:document.title,notice:document.getElementById('notice').textContent,platform:document.getElementById('platform-label').textContent,overflow:document.documentElement.scrollWidth>innerWidth})");
  assert.equal(initial.notice, ''); assert.equal(initial.overflow, false); assert.match(initial.title, /WiiUltraConnect/);
  record('Electron starts with isolated preload and lists real display sources');
  const appConfig = await js(host, 'window.wii.config()');
  assert.equal(appConfig.signalUrl, undefined); assert.equal(appConfig.iceServers, undefined);
  assert.equal(await js(host, "Boolean(document.getElementById('signal-url'))"), false);
  await js(host, "window.WebSocket = class { constructor() { throw new Error('WebSocket forbidden in serverless test'); } }; void 0");
  // Use the actual viewer tab for the screenshot to keep the host display thumbnail out of the artifact.
  await js(host, "document.getElementById('viewer-tab').click()");
  await js(host, 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await new Promise(resolve => setTimeout(resolve, 200)); // Let the tab's 150 ms color transition finish.
  assert.equal(await js(host, "document.getElementById('viewer-tab').getAttribute('aria-selected')"), 'true');
  writeFileSync(path.join(artifacts, 'ui-ready.png'), (await host.webContents.capturePage()).toPNG());
  await js(host, `document.getElementById('host-tab').click(); document.getElementById('fps').value=${JSON.stringify(process.env.WII_SMOKE_FPS || '30')}; document.getElementById('start-host').click()`);
  await until(() => js(host, "Boolean(document.getElementById('invitation-output').value)"), 'Screen capture or offline invitation failed');
  const capture = await js(host, "document.getElementById('screen-video').srcObject.getVideoTracks()[0].getSettings()");
  assert.ok(capture.width > 0 && capture.height > 0); assert.ok(capture.frameRate <= 60);
  record(`Real desktopCapturer → getDisplayMedia track: ${capture.width}×${capture.height}, ${capture.frameRate} FPS`);
  const invitation = await js(host, "document.getElementById('invitation-output').value");
  assert.match(invitation, /^WUC-DIRECT-1\./);
  const viewerSession = session.fromPartition('smoke-viewer');
  viewerSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => { serviceRequests.push(details.url); callback({ cancel: true }); });
  const viewer = new BrowserWindow({ show: false, width: 1440, height: 960, webPreferences: { session: viewerSession, preload: path.join(__dirname, 'viewer-smoke-preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  observe(viewer);
  await viewer.loadFile(path.join(__dirname, '../src/index.html'));
  await until(() => js(viewer, "document.getElementById('platform-label').textContent.includes('Direct')"), 'Viewer did not load');
  await js(viewer, `(async()=>{
    const {PeerSession}=await import('../src/peer.js');
    const original=PeerSession.prototype.createResponse;
    PeerSession.prototype.createResponse=function(...args){window.harness={peer:this,errors:[],messages:[],received:[],progress:[],input:[]};
      const sendInput=this.sendInput.bind(this);this.sendInput=value=>{window.harness.input.push(value);return sendInput(value)};
      this.addEventListener('error',e=>window.harness.errors.push(e.detail));
      this.addEventListener('chat',e=>window.harness.messages.push(e.detail));
      const onFile=this.options.files.onFile;this.options.files.onFile=file=>{window.harness.received.push(file);onFile(file)};
      const onProgress=this.options.files.onProgress;this.options.files.onProgress=value=>{window.harness.progress.push(value);onProgress(value)};
      return original.apply(this,args)};
    document.getElementById('viewer-tab').click();
  })()`);
  await js(viewer, "window.WebSocket = class { constructor() { throw new Error('WebSocket forbidden in serverless test'); } }; void 0");
  await js(viewer, `document.getElementById('invitation-input').value=${JSON.stringify(invitation)};document.getElementById('start-viewer').click()`);
  await until(() => js(viewer, "Boolean(document.getElementById('response-output').value)"), 'Viewer UI did not generate a response');
  const response = await js(viewer, "document.getElementById('response-output').value");
  // A malformed response must leave the host invitation usable for a correction.
  await js(host, "document.getElementById('response-input').value='bad-code'; document.getElementById('apply-response').click()");
  await until(() => js(host, "!document.getElementById('apply-response').disabled"), 'Invalid response locked host setup');
  assert.equal(await js(host, "document.getElementById('invitation-output').value"), invitation);
  await js(host, `document.getElementById('response-input').value=${JSON.stringify(response)}; document.getElementById('apply-response').click()`);
  await until(() => js(viewer, 'window.harness.peer.ready'), 'WebRTC data channels did not connect');
  await until(() => js(viewer, "document.getElementById('screen-video').videoWidth > 0"), 'Viewer did not decode video');
  const video = await js(viewer, "({width:document.getElementById('screen-video').videoWidth,height:document.getElementById('screen-video').videoHeight})");
  assert.deepEqual(await js(viewer, 'window.harness.peer.pc.getConfiguration().iceServers'), []);
  const candidateTypes = await js(viewer, "(async()=>{const r=await window.harness.peer.pc.getStats();return [...r.values()].filter(v=>v.type==='local-candidate'||v.type==='remote-candidate').map(v=>v.candidateType)})()");
  assert.ok(candidateTypes.length >= 2); assert.ok(candidateTypes.every(type => type !== 'relay' && type !== 'srflx'));
  assert.equal(await js(viewer, 'Object.keys(window.harness.peer.channels).length'), 4);
  record(`Host and viewer app UI, offline exchange, no ICE servers, direct candidate pair, four channels, decoded ${video.width}×${video.height} video`);
  assert.equal(await js(viewer, "window.harness.peer.sendInput({type:'key',action:'down',code:'KeyA'})"), false);
  record('Remote input remains disabled before host approval');
  await js(host, "document.getElementById('chat-input').value='<hello> from host'; document.getElementById('chat-form').requestSubmit()");
  await until(() => js(viewer, "window.harness.messages.includes('<hello> from host')"), 'Host chat failed');
  await js(viewer, "window.harness.peer.sendChat('<b>hello from viewer</b>')");
  await until(() => js(host, "document.getElementById('messages').textContent.includes('<b>hello from viewer</b>')"), 'Viewer chat failed');
  assert.equal(await js(host, "document.querySelectorAll('.bubble b').length"), 0);
  record('Bidirectional chat renders untrusted text without HTML execution');
  await js(host, "{const d=new DataTransfer();d.items.add(new File([Uint8Array.from({length:131079},(_,i)=>i%251)],'smoke.bin'));const el=document.getElementById('file-input');el.files=d.files;el.dispatchEvent(new Event('change'));}");
  await until(() => js(viewer, "[...document.querySelectorAll('.file-buttons button')].some(b=>b.textContent==='Accept file')"), 'Viewer file acceptance UI did not appear');
  await js(viewer, "[...document.querySelectorAll('.file-buttons button')].find(b=>b.textContent==='Accept file').click()");
  await until(() => js(viewer, 'window.harness.received.length === 1'), 'Host file transfer failed');
  const hash = await js(viewer, "(async()=>{const d=await window.harness.received[0].blob.arrayBuffer();return [...new Uint8Array(await crypto.subtle.digest('SHA-256',d))].map(v=>v.toString(16).padStart(2,'0')).join('')})()");
  assert.equal(hash, createHash('sha256').update(Uint8Array.from({ length: 131079 }, (_, i) => i % 251)).digest('hex'));
  await until(() => js(host, "document.getElementById('file-list').textContent.includes('Delivered')"), 'Receipt acknowledgement failed');
  await js(viewer, "window.harness.peer.files.send(new File(['return from viewer'],'return.txt'))");
  await until(() => js(host, "[...document.querySelectorAll('.file-buttons button')].some(b=>b.textContent==='Accept file')"), 'Incoming acceptance UI did not appear');
  await js(host, "[...document.querySelectorAll('.file-buttons button')].find(b=>b.textContent==='Accept file').click()");
  await until(() => js(host, "document.querySelectorAll('a[download]').length === 1"), 'Received download was not offered');
  const returned = await js(host, "fetch(document.querySelector('a[download]').href).then(r=>r.text())");
  assert.equal(returned, 'return from viewer');
  record('Bidirectional file transfer, explicit host acceptance, SHA-256 byte comparison, receipt and save link');
  // Clipboard must not replace either device's clipboard before an explicit click.
  await js(viewer, "document.getElementById('send-clipboard').click()");
  await until(() => js(host, "!document.getElementById('clipboard-incoming').hidden"), 'Host did not receive clipboard offer');
  assert.deepEqual(clipboardWrites, []);
  await js(host, "document.getElementById('accept-clipboard').click()");
  await until(() => clipboardWrites.length === 1, 'Host clipboard acceptance failed');
  assert.deepEqual(clipboardWrites[0], ['host', 'clipboard from viewer']);
  await js(host, "document.getElementById('send-clipboard').click()");
  await until(() => js(viewer, "!document.getElementById('clipboard-incoming').hidden"), 'Viewer did not receive clipboard offer');
  await js(viewer, "document.getElementById('accept-clipboard').click()");
  await until(() => clipboardWrites.length === 2, 'Viewer clipboard acceptance failed');
  assert.deepEqual(clipboardWrites[1], ['viewer', 'clipboard from host']);
  record('Bidirectional clipboard sharing requires explicit recipient acceptance');
  await js(host, "document.getElementById('control-button').click()");
  await until(() => js(host, "!document.getElementById('control-button').disabled"), 'Denied consent did not finish');
  assert.equal(await js(viewer, 'window.harness.peer.controlAllowed'), false);
  consent = 1;
  await js(viewer, "document.getElementById('control-button').click()");
  await until(() => js(viewer, 'window.harness.peer.controlAllowed'), 'Remote control did not follow host consent');
  await js(viewer, "window.harness.peer.sendInput({type:'key',action:'down',code:'KeyA'});window.harness.peer.sendInput({type:'key',action:'up',code:'KeyA'})");
  await until(() => nativeCalls.some(c => c[0] === 'key-up'), 'Input did not reach host native adapter');
  assert.deepEqual(nativeCalls.slice(0, 2), [['key-down', realNative.Key.A], ['key-up', realNative.Key.A]]);
  await js(viewer, "window.fullscreenChanged=false;document.addEventListener('fullscreenchange',()=>{window.fullscreenChanged=true},{once:true});document.getElementById('fullscreen').click()");
  await until(() => js(viewer, "window.fullscreenChanged && document.fullscreenElement?.id==='session-panel'"), 'Viewer fullscreen failed').catch(async error => { console.error(await js(viewer, "({notice:document.getElementById('notice').textContent,enabled:document.fullscreenEnabled,hidden:document.hidden,focused:document.hasFocus(),fullscreen:document.fullscreenElement?.id})")); throw error; });
  const full = await js(viewer, "({width:document.getElementById('session-panel').getBoundingClientRect().width,height:document.getElementById('session-panel').getBoundingClientRect().height,innerWidth,innerHeight,toolbar:document.getElementById('disconnect').getBoundingClientRect().bottom,stage:document.getElementById('screen-stage').getBoundingClientRect().height})");
  assert.equal(full.width, full.innerWidth); assert.equal(full.height, full.innerHeight);
  assert.ok(full.stage > 300 && full.toolbar < full.innerHeight);
  // Native Chromium input events exercise pointer capture, focus, normalization and keyboard forwarding.
  viewer.webContents.focus();
  const center = await js(viewer, "(()=>{const r=document.getElementById('screen-video').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()");
  viewer.webContents.sendInputEvent({ type: 'mouseMove', ...center });
  viewer.webContents.sendInputEvent({ type: 'mouseDown', ...center, button: 'left', clickCount: 1 });
  viewer.webContents.sendInputEvent({ type: 'mouseUp', ...center, button: 'left', clickCount: 1 });
  await until(() => nativeCalls.some(c => c[0] === 'button-up'), 'Fullscreen pointer click did not reach the host');
  viewer.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'B' });
  viewer.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'B' });
  await until(() => nativeCalls.some(c => c[0] === 'key-up' && c[1] === realNative.Key.B), 'Fullscreen keyboard event did not reach the host');
  viewer.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'C' });
  await until(() => nativeCalls.some(c => c[0] === 'key-down' && c[1] === realNative.Key.C), 'Held key did not start');
  await new Promise(resolve => setTimeout(resolve, 3500));
  assert.equal(nativeCalls.some(c => c[0] === 'key-up' && c[1] === realNative.Key.C), false, 'Heartbeat must preserve a deliberately held key');
  await js(viewer, "document.getElementById('screen-video').blur()");
  await until(() => nativeCalls.some(c => c[0] === 'key-up' && c[1] === realNative.Key.C), 'Focus loss did not release the held key');
  record('Fullscreen Chromium mouse/keyboard events traverse ViewerInput, WebRTC and host native adapter');
  record('Held-key heartbeat prevents premature release; focus loss releases the native key');
  await js(viewer, "document.getElementById('view-scale').value='actual';document.getElementById('view-scale').dispatchEvent(new Event('change'))");
  await until(() => js(viewer, "document.getElementById('screen-stage').classList.contains('actual')"), 'Actual-size mode failed');
  const actual = await js(viewer, "({width:document.getElementById('screen-video').getBoundingClientRect().width,native:document.getElementById('screen-video').videoWidth})");
  assert.equal(actual.width, actual.native);
  await js(viewer, "document.getElementById('view-scale').value='fit';document.getElementById('view-scale').dispatchEvent(new Event('change'))");
  await js(viewer, "document.getElementById('toggle-tools').click()");
  assert.equal(await js(viewer, "document.getElementById('collaboration-area').hidden"), false);
  await js(viewer, "document.getElementById('control-button').click()");
  await until(() => js(viewer, '!window.harness.peer.controlAllowed'), 'Viewer release did not revoke host permission');
  record('Host consent/denial, request and revoke over WebRTC; native adapter receives ordered input (OS input mocked)');
  record('Viewer fullscreen fills the window, toolbar remains visible, actual-size and fit views work, chat opens in fullscreen');
  await js(viewer, "document.getElementById('fullscreen').click()");
  await until(() => js(viewer, '!document.fullscreenElement'), 'Exiting fullscreen failed');
  await js(viewer, "document.getElementById('quality').value='economy';document.getElementById('quality').dispatchEvent(new Event('change'))");
  await until(() => js(host, "document.getElementById('screen-video').srcObject.getVideoTracks()[0].getSettings().frameRate<=15"), 'Live quality adjustment failed');
  record('Viewer quality requests update host capture constraints during the session');
  // Recapture the selected display and replace its track without renegotiation.
  await js(host, "document.getElementById('switch-display').click()");
  await until(() => js(host, "document.getElementById('notice').textContent.includes('Display changed')"), 'Display recapture failed');
  assert.equal(await js(viewer, 'window.harness.peer.ready'), true);
  record('Live display recapture replaces the video track while preserving all data channels');
  await js(host, "document.getElementById('fullscreen').click()");
  await until(() => js(host, "document.fullscreenElement?.id==='session-panel'"), 'Production permission handler blocked fullscreen');
  await js(host, "document.getElementById('fullscreen').click()");
  await until(() => js(host, '!document.fullscreenElement'), 'Host fullscreen exit failed');
  record('Production Electron permission handler permits and exits fullscreen for the trusted app');
  const native = require('@nut-tree-fork/nut-js');
  const { KEY_NAMES } = require('../electron/input-controller.cjs');
  const missing = Object.values(KEY_NAMES).filter(name => native.Key[name] === undefined);
  assert.deepEqual(missing, [], 'Key mapping must use real native enum names');
  const point = await native.mouse.getPosition(); assert.ok(Number.isFinite(point.x));
  record('nut.js native binding loads inside Electron and all key mappings resolve (no input injected)');
  await js(host, "document.getElementById('disconnect').click()");
  await until(() => js(viewer, 'window.harness.peer.closed'), 'Viewer did not disconnect');
  assert.equal(await js(host, "document.getElementById('screen-video').srcObject"), null);
  assert.equal(await js(host, "document.getElementById('control-button').disabled"), true);
  record('End session stops capture, closes peer channels and disables input');
  assert.deepEqual(await js(viewer, 'window.harness.errors'), []);
  assert.deepEqual(errors, []);
  assert.deepEqual(serviceRequests, []);
  record('No HTTP, HTTPS or WebSocket service requests; legacy server settings ignored');
  const result = JSON.stringify({ passed: report, serviceRequests, targetFps: process.env.WII_SMOKE_FPS, platform: process.platform, electron: process.versions.electron }, null, 2);
  writeFileSync(path.join(artifacts, 'smoke-report.json'), result);
  writeFileSync(path.join(artifacts, `smoke-report-${process.env.WII_SMOKE_FPS || '30'}fps.json`), result);
  viewer.destroy(); app.quit();
}).catch(error => {
  console.error(error);
  console.error('Renderer errors:', errors);
  writeFileSync(path.join(artifacts, 'smoke-failure.txt'), `${error.stack}\n${errors.join('\n')}`);
  app.exit(1);
});
