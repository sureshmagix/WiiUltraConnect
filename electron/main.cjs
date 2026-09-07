const { app, BrowserWindow, desktopCapturer, ipcMain, session, screen, dialog, globalShortcut, systemPreferences } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { InputController } = require('./input-controller.cjs');

app.setName('WiiUltraConnect');
const page = pathToFileURL(path.join(__dirname, '../src/index.html')).href;
let win;
let selected = null;
let capturing = false;
let captureGranted = false;
let grantEpoch = 0;
let quitting = false;
const input = new InputController({
  loadNative: async () => {
    if (process.platform === 'linux' && process.env.XDG_SESSION_TYPE === 'wayland') throw new Error('Remote input requires a Linux X11 session. Screen sharing is still available.');
    try { return require('@nut-tree/nut-js'); } catch {
      try { return require('@nut-tree-fork/nut-js'); } catch { throw new Error('Native input is unavailable. Install the optional nut.js provider and restart WiiUltraConnect.'); }
    }
  },
  toPoint: (bounds, x, y) => {
    const point = { x: Math.round(bounds.x + x * (bounds.width - 1)), y: Math.round(bounds.y + y * (bounds.height - 1)) };
    return process.platform === 'win32' ? screen.dipToScreenPoint(point) : point;
  },
  onError: error => {
    ++grantEpoch;
    globalShortcut.unregister('CommandOrControl+Shift+Escape');
    if (win && !win.isDestroyed()) win.webContents.send('control:revoked', error.message);
  }
});
function trusted(event) {
  return win && !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame && event.senderFrame.url === page;
}
function handle(name, fn) {
  ipcMain.handle(name, (event, ...args) => { if (!trusted(event)) throw new Error('Untrusted frame'); return fn(...args); });
}
async function revokeControl(reason = 'Remote control stopped') {
  ++grantEpoch;
  globalShortcut.unregister('CommandOrControl+Shift+Escape');
  const pending = input.revoke();
  if (win && !win.isDestroyed()) win.webContents.send('control:revoked', reason);
  await pending;
}
async function stopCapture() {
  selected = null;
  capturing = false;
  captureGranted = false;
  await revokeControl();
}
function config() {
  let iceServers;
  try { iceServers = JSON.parse(process.env.WII_ICE_SERVERS || '[{"urls":"stun:stun.l.google.com:19302"}]'); }
  catch { throw new Error('WII_ICE_SERVERS must be a JSON array.'); }
  if (!Array.isArray(iceServers)) throw new Error('WII_ICE_SERVERS must be a JSON array.');
  return { platform: process.platform, version: app.getVersion(), signalUrl: process.env.WII_SIGNAL_URL || 'ws://127.0.0.1:8787/signal', iceServers, iceTransportPolicy: process.env.WII_RELAY_ONLY === '1' ? 'relay' : 'all' };
}
app.whenReady().then(() => {
  session.defaultSession.setPermissionCheckHandler((contents, permission) => contents === win?.webContents && ['media', 'display-capture'].includes(permission));
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => callback(contents === win?.webContents && contents.getURL() === page && ['media', 'display-capture'].includes(permission)));
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    const chosen = selected;
    if (!chosen || !request.videoRequested || request.frame !== win?.webContents.mainFrame || request.frame.url !== page) return callback({});
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
      const source = sources.find(s => s.id === chosen.id);
      if (!source || selected !== chosen) return callback({});
      captureGranted = true;
      callback({ video: source });
    } catch { callback({}); }
  });
  handle('app:config', config);
  handle('capture:sources', async () => {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 320, height: 180 } });
    return sources.map(s => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL() }));
  });
  handle('capture:select', async id => {
    await stopCapture();
    if (typeof id !== 'string' || id.length > 256) throw new Error('Invalid display');
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
    const source = sources.find(s => s.id === id);
    if (!source) throw new Error('Display is no longer available. Refresh displays.');
    selected = { id, displayId: source.display_id };
  });
  handle('capture:started', () => {
    if (!selected || !captureGranted) throw new Error('No display capture was granted.');
    capturing = true;
  });
  handle('capture:stop', stopCapture);
  handle('control:disable', () => revokeControl());
  handle('control:enable', async () => {
    if (!capturing || !selected) throw new Error('Start sharing a display first.');
    const epoch = ++grantEpoch;
    const chosen = selected;
    const display = screen.getAllDisplays().find(d => String(d.id) === chosen.displayId);
    if (!display) throw new Error('The captured display cannot be mapped to desktop coordinates. Control is unavailable for this source.');
    if (process.platform === 'darwin' && !systemPreferences.isTrustedAccessibilityClient(true)) throw new Error('Grant WiiUltraConnect Accessibility permission in System Settings, then try again.');
    const result = await dialog.showMessageBox(win, {
      type: 'question', title: 'Allow remote control?',
      message: 'Allow the connected viewer to use your mouse and keyboard?',
      detail: 'Keyboard shortcuts can act across your desktop. Press Ctrl/Cmd + Shift + Escape or Stop control to revoke access.',
      buttons: ['Cancel', 'Allow control'], defaultId: 0, cancelId: 0, noLink: true
    });
    if (result.response !== 1 || epoch !== grantEpoch || !capturing || selected !== chosen) return false;
    await input.grant(display.bounds);
    if (epoch !== grantEpoch || !capturing) { await input.revoke(); return false; }
    const registered = globalShortcut.register('CommandOrControl+Shift+Escape', () => { void revokeControl('Emergency shortcut: remote control stopped'); });
    if (!registered) { await input.revoke(); throw new Error('The emergency shortcut is unavailable. Close the application using Ctrl/Cmd + Shift + Escape and retry.'); }
    return true;
  });
  ipcMain.on('control:input', (event, value) => { if (trusted(event) && capturing) input.enqueue(value); });
  screen.on('display-removed', () => { void stopCapture(); });
  screen.on('display-metrics-changed', () => { void revokeControl('Display configuration changed. Enable control again.'); });
  function createWindow() {
    win = new BrowserWindow({
      width: 1440, height: 940, minWidth: 1040, minHeight: 740,
      show: process.env.WII_SMOKE !== '1',
      title: 'WiiUltraConnect', backgroundColor: '#f5f7fb', autoHideMenuBar: true,
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false, webSecurity: true }
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.webContents.on('render-process-gone', () => { void stopCapture(); });
    win.on('closed', () => { void stopCapture(); win = null; });
    win.loadFile(path.join(__dirname, '../src/index.html'));
  }
  createWindow();
  app.on('activate', () => { if (!win) createWindow(); });
});
app.on('before-quit', event => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  void input.dispose().finally(() => app.quit());
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
