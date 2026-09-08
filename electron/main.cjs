const { app, BrowserWindow, desktopCapturer, ipcMain, session, screen, dialog, globalShortcut, systemPreferences } = require('electron');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { InputController } = require('./input-controller.cjs');

app.setName('WiiUltraConnect');
if (process.env.WII_SMOKE !== '1') app.setPath('userData', path.join(app.getPath('appData'), 'WiiUltraConnect'));
const page = pathToFileURL(path.join(__dirname, '../src/index.html')).href;
let win;
let selected = null;
let capturing = false;
let captureGranted = false;
let grantEpoch = 0;
let quitting = false;
let embeddedSignalServer = null;

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

function getNetworkInfo() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const [name, list] of Object.entries(interfaces)) {
    for (const info of list || []) {
      if (!info.internal && info.family === 'IPv4') {
        addresses.push({ name, address: info.address });
      }
    }
  }
  return addresses;
}

async function startEmbeddedSignalServer(port = 8787) {
  if (embeddedSignalServer) return embeddedSignalServer;
  try {
    const { createSignalingServer } = await import(pathToFileURL(path.join(__dirname, '../server/signaling.mjs')).href);
    const srv = createSignalingServer();
    const addr = await srv.listen(port, '0.0.0.0');
    const actualPort = typeof addr === 'object' ? addr.port : port;
    embeddedSignalServer = { server: srv, port: actualPort };
    console.log(`[Main] Embedded signaling server started on port ${actualPort}`);
    return embeddedSignalServer;
  } catch (err) {
    console.log(`[Main] Signaling server port in use or already running (${err.message})`);
    return { port, external: true };
  }
}

function config() {
  let signalUrl = 'ws://127.0.0.1:8787/signal';
  if (process.env.WII_SIGNAL_URL && (process.env.WII_SIGNAL_URL.startsWith('ws://') || process.env.WII_SIGNAL_URL.startsWith('wss://') || process.env.WII_SIGNAL_URL.startsWith('http://') || process.env.WII_SIGNAL_URL.startsWith('https://'))) {
    signalUrl = process.env.WII_SIGNAL_URL;
  }
  let iceServers = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }
  ];
  if (process.env.WII_ICE_SERVERS) {
    try {
      const parsed = JSON.parse(process.env.WII_ICE_SERVERS);
      if (Array.isArray(parsed)) iceServers = parsed;
    } catch {}
  }
  let screenAccess = 'granted';
  try {
    if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus) {
      screenAccess = systemPreferences.getMediaAccessStatus('screen');
    }
  } catch {}
  return {
    platform: process.platform,
    version: app.getVersion(),
    signalUrl,
    iceServers,
    screenAccess,
    edition: 'Direct & LAN P2P · Verbal 6-Digit Codes'
  };
}

app.whenReady().then(async () => {
  // Start local signaling helper
  try {
    await startEmbeddedSignalServer();
  } catch (err) {
    console.log('[Main] Signaling server auto-start notification:', err.message);
  }

  session.defaultSession.setPermissionCheckHandler((contents, permission) => {
    return (win && !win.isDestroyed() && contents === win.webContents) && ['media', 'display-capture'].includes(permission);
  });

  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
    const isApp = win && !win.isDestroyed() && contents === win.webContents;
    callback(isApp && ['media', 'display-capture'].includes(permission));
  });

  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    if (!request.videoRequested) return callback({});
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
      if (!sources || sources.length === 0) {
        console.error('[Main] No screen sources found for display capture');
        return callback({});
      }
      let source = selected ? sources.find(s => s.id === selected.id) : null;
      if (!source) {
        source = sources[0];
        selected = { id: source.id, displayId: source.display_id };
      }
      captureGranted = true;
      callback({ video: source });
    } catch (err) {
      console.error('[Main] Error in getDisplayMedia handler:', err);
      callback({});
    }
  });

  handle('app:config', config);
  handle('app:networkInfo', getNetworkInfo);
  handle('app:ensureSignalServer', async () => {
    const res = await startEmbeddedSignalServer();
    return { ok: true, port: res.port };
  });

  handle('capture:sources', async () => {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 320, height: 180 } });
    if (sources.length > 0 && !selected) {
      selected = { id: sources[0].id, displayId: sources[0].display_id };
    }
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
    if (!selected) throw new Error('No display was selected.');
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
      icon: path.join(__dirname, 'icon.png'),
      title: 'WiiUltraConnect', backgroundColor: '#f5f7fb', autoHideMenuBar: true,
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false, webSecurity: true }
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.webContents.on('render-process-gone', () => { void stopCapture(); });
    win.webContents.on('console-message', (_event, _level, message, line, sourceId) => {
      console.log(`[Renderer] ${message} (${sourceId}:${line})`);
    });
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
  if (embeddedSignalServer?.server) {
    void embeddedSignalServer.server.close();
  }
  void input.dispose().finally(() => app.quit());
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
