const { app, BrowserWindow, session } = require('electron');
const { mkdirSync, writeFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const path = require('node:path');
const assert = require('node:assert/strict');
const artifacts = path.join(__dirname, '../artifacts/serverless');
mkdirSync(artifacts, { recursive: true });
app.setPath('userData', path.join(artifacts, 'smoke-profile'));
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
  const viewer = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  observe(viewer);
  await viewer.loadFile(path.join(__dirname, 'rtc-harness.html'));
  await until(() => js(viewer, 'Boolean(window.harness)'), 'Viewer did not load');
  await js(viewer, "window.WebSocket = class { constructor() { throw new Error('WebSocket forbidden in serverless test'); } }; void 0");
  const response = await js(viewer, `window.harness.connect({}, ${JSON.stringify(invitation)})`);
  // A malformed response must leave the host invitation usable for a correction.
  await js(host, "document.getElementById('response-input').value='bad-code'; document.getElementById('apply-response').click()");
  await until(() => js(host, "!document.getElementById('apply-response').disabled"), 'Invalid response locked host setup');
  assert.equal(await js(host, "document.getElementById('invitation-output').value"), invitation);
  await js(host, `document.getElementById('response-input').value=${JSON.stringify(response)}; document.getElementById('apply-response').click()`);
  await until(() => js(viewer, 'window.harness.peer.ready'), 'WebRTC data channels did not connect');
  await until(() => js(viewer, "document.getElementById('remote').videoWidth > 0"), 'Viewer did not decode video');
  const video = await js(viewer, "({width:document.getElementById('remote').videoWidth,height:document.getElementById('remote').videoHeight})");
  assert.deepEqual(await js(viewer, 'window.harness.peer.pc.getConfiguration().iceServers'), []);
  const candidateTypes = await js(viewer, "(async()=>{const r=await window.harness.peer.pc.getStats();return [...r.values()].filter(v=>v.type==='local-candidate'||v.type==='remote-candidate').map(v=>v.candidateType)})()");
  assert.ok(candidateTypes.length >= 2); assert.ok(candidateTypes.every(type => type !== 'relay' && type !== 'srflx'));
  record(`Offline offer/response exchange, no ICE servers, direct candidate pair, three data channels, decoded ${video.width}×${video.height} video`);
  assert.equal(await js(viewer, "window.harness.peer.sendInput({type:'key',action:'down',code:'KeyA'})"), false);
  record('Remote input remains disabled before host approval');
  await js(host, "document.getElementById('chat-input').value='<hello> from host'; document.getElementById('chat-form').requestSubmit()");
  await until(() => js(viewer, "window.harness.messages.includes('<hello> from host')"), 'Host chat failed');
  await js(viewer, "window.harness.peer.sendChat('<b>hello from viewer</b>')");
  await until(() => js(host, "document.getElementById('messages').textContent.includes('<b>hello from viewer</b>')"), 'Viewer chat failed');
  assert.equal(await js(host, "document.querySelectorAll('.bubble b').length"), 0);
  record('Bidirectional chat renders untrusted text without HTML execution');
  await js(host, "{const d=new DataTransfer();d.items.add(new File([Uint8Array.from({length:131079},(_,i)=>i%251)],'smoke.bin'));const el=document.getElementById('file-input');el.files=d.files;el.dispatchEvent(new Event('change'));}");
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
