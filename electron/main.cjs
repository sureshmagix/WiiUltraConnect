const { app, BrowserWindow, desktopCapturer, ipcMain, session, screen, dialog, globalShortcut, systemPreferences, clipboard, powerSaveBlocker, safeStorage } = require('electron');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { randomBytes } = require('node:crypto');
const { readFileSync, writeFileSync, mkdirSync, renameSync } = require('node:fs');
const { InputController } = require('./input-controller.cjs');

app.setName('WiiUltraConnect');
if (process.env.WII_SMOKE !== '1') app.setPath('userData', path.join(app.getPath('appData'), 'WiiUltraConnect'));
const page = pathToFileURL(path.join(__dirname, '../src/index.html')).href;
const unattendedPath = path.join(app.getPath('userData'), 'unattended.json');
let win;
let selected = null;
let capturing = false;
let captureGranted = false;
let grantEpoch = 0;
let quitting = false;
let activeSession = false;
let blocker;
let unattended = null;

function randomValue(bytes = 32) { return randomBytes(bytes).toString('base64url'); }
function validateBrokerUrl(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { throw new Error('Enter a valid signaling server URL.'); }
  if (!['ws:', 'wss:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) throw new Error('Use a ws:// or wss:// signaling URL without credentials, query parameters or fragments.');
  if (url.protocol === 'ws:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Use wss:// for an internet signaling server. ws:// is only allowed for local development.');
  url.pathname = url.pathname === '/' ? '/ws' : url.pathname.replace(/\/$/, '');
  if (url.pathname !== '/ws') throw new Error('The signaling server URL must end in /ws.');
  return url.href;
}
function validNetwork(value) {
  if (!value || value.mode !== 'internet' || typeof value.turnUrls !== 'string' || !value.turnUrls.trim() || typeof value.username !== 'string' || !value.username.trim() || typeof value.credential !== 'string' || !value.credential) throw new Error('Unattended access requires Internet mode and TURN URL, username and password.');
  return { mode: 'internet', stunUrls: String(value.stunUrls || ''), turnUrls: value.turnUrls, username: value.username, credential: value.credential, relayOnly: value.relayOnly === true };
}
function validUsername(value) { return /^[a-z][a-z0-9-]{2,63}$/.test(String(value || '').trim().toLowerCase()); }
function protect(value) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure desktop storage is unavailable. Enable your operating system keyring before configuring unattended access.');
  return safeStorage.encryptString(value).toString('base64');
}
function reveal(value) {
  if (!safeStorage.isEncryptionAvailable() || typeof value !== 'string') throw new Error('Saved unattended access settings cannot be decrypted on this computer. Configure them again.');
  return safeStorage.decryptString(Buffer.from(value, 'base64'));
}
function saveUnattended(value) {
  mkdirSync(path.dirname(unattendedPath), { recursive: true });
  const temporary = `${unattendedPath}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  renameSync(temporary, unattendedPath);
}
function loadUnattended() {
  try {
    const value = JSON.parse(readFileSync(unattendedPath, 'utf8'));
    if (!value || typeof value !== 'object' || value.enabled !== true) return null;
    return { ...value, deviceKey: reveal(value.deviceKey), accessVerifier: reveal(value.accessVerifier), network: JSON.parse(reveal(value.network)) };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    console.error('[Main] Could not load unattended settings:', error.message);
    return null;
  }
}
function publicUnattended() {
  if (!unattended) return { enabled: false };
  return { enabled: unattended.enabled === true, username: unattended.username, serverUrl: unattended.serverUrl, deviceId: unattended.deviceId, deviceKey: unattended.deviceKey, accessVerifier: unattended.accessVerifier, displayId: unattended.displayId || '', network: unattended.network, launchAtLogin: unattended.launchAtLogin === true };
}

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
    globalShortcut.unregister('CommandOrControl+Alt+Shift+F12');
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
  globalShortcut.unregister('CommandOrControl+Alt+Shift+F12');
  const pending = input.revoke();
  if (win && !win.isDestroyed()) win.webContents.send('control:revoked', reason);
  await pending;
}

async function stopCapture() {
  selected = null;
  capturing = false;
  captureGranted = false;
  activeSession = false;
  if (blocker !== undefined && powerSaveBlocker.isStarted(blocker)) powerSaveBlocker.stop(blocker);
  blocker = undefined;
  await revokeControl();
}

function getNetworkInfo() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const [name, list] of Object.entries(interfaces)) {
    for (const info of list || []) {
      if (!info.internal) {
        addresses.push({ name, address: info.address, family: info.family });
      }
    }
  }
  return addresses;
}

function config() {
  let screenAccess = 'granted';
  try {
    if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus) {
      screenAccess = systemPreferences.getMediaAccessStatus('screen');
    }
  } catch {}
  return {
    platform: process.platform,
    version: app.getVersion(),
    computerName: os.hostname(),
    screenAccess,
    systemAudio: process.platform === 'win32',
    edition: 'Direct with optional Internet mode'
  };
}

app.whenReady().then(async () => {
  session.defaultSession.setPermissionCheckHandler((contents, permission) => {
    return (win && !win.isDestroyed() && contents === win.webContents) && ['media', 'display-capture', 'fullscreen'].includes(permission);
  });

  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
    const isApp = win && !win.isDestroyed() && contents === win.webContents;
    callback(isApp && ['media', 'display-capture', 'fullscreen'].includes(permission));
  });

  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    const chosen = selected;
    if (!win || request.frame !== win.webContents.mainFrame || request.frame.url !== page || !request.videoRequested || !chosen || captureGranted) return callback({});
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
      const source = sources.find(s => s.id === chosen.id);
      if (!source || selected !== chosen || captureGranted) return callback({});
      captureGranted = true;
      callback({ video: source, ...(request.audioRequested && chosen.audio && process.platform === 'win32' ? { audio: 'loopback' } : {}) });
    } catch (err) {
      console.error('[Main] Error in getDisplayMedia handler:', err);
      callback({});
    }
  });

  handle('app:config', config);
  unattended = loadUnattended();
  handle('unattended:config', publicUnattended);
  handle('unattended:save', value => {
    if (!value || typeof value !== 'object') throw new Error('Invalid unattended access settings.');
    const enabled = value.enabled === true;
    if (!enabled) {
      saveUnattended({ enabled: false });
      unattended = null;
      try { app.setLoginItemSettings({ openAtLogin: false }); } catch {}
      return { enabled: false };
    }
    const deviceId = typeof value.deviceId === 'string' && /^wuc-[a-z0-9]{20,64}$/.test(value.deviceId) ? value.deviceId : `wuc-${randomBytes(16).toString('hex')}`;
    const deviceKey = typeof value.deviceKey === 'string' && /^[A-Za-z0-9_-]{32,256}$/.test(value.deviceKey) ? value.deviceKey : randomValue();
    const username = String(value.username || '').trim().toLowerCase();
    if (!validUsername(username)) throw new Error('Use a username with 3-64 lowercase letters, numbers or hyphens.');
    if (typeof value.accessVerifier !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(value.accessVerifier)) throw new Error('Set an unattended-access password before saving.');
    const stored = { enabled: true, username, serverUrl: validateBrokerUrl(value.serverUrl), deviceId, displayId: typeof value.displayId === 'string' ? value.displayId.slice(0, 256) : '', launchAtLogin: value.launchAtLogin === true, deviceKey: protect(deviceKey), accessVerifier: protect(value.accessVerifier), network: protect(JSON.stringify(validNetwork(value.network))) };
    saveUnattended(stored);
    unattended = { ...stored, deviceKey, accessVerifier: value.accessVerifier, network: validNetwork(value.network) };
    try { app.setLoginItemSettings({ openAtLogin: stored.launchAtLogin }); } catch (error) { console.error('[Main] Could not set launch at login:', error.message); }
    return publicUnattended();
  });
  handle('app:networkInfo', getNetworkInfo);
  handle('session:active', async value => {
    activeSession = value === true;
    if (!activeSession) await revokeControl();
  });
  handle('clipboard:read', () => clipboard.readText().slice(0, 16000));
  handle('clipboard:write', value => {
    if (typeof value !== 'string' || value.length > 16000) throw new Error('Clipboard text is limited to 16,000 characters.');
    clipboard.writeText(value);
  });

  handle('capture:sources', async () => {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 320, height: 180 } });
    return sources.map(s => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL() }));
  });

  handle('capture:select', async (id, audio = false) => {
    if (typeof id !== 'string' || id.length > 256) throw new Error('Invalid display');
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
    const source = sources.find(s => s.id === id);
    if (!source) throw new Error('Display is no longer available. Refresh displays.');
    await revokeControl();
    capturing = false; captureGranted = false;
    selected = { id, displayId: source.display_id, audio: audio === true };
  });

  handle('capture:confirmSwitch', async id => {
    if (!capturing || !activeSession || typeof id !== 'string') return false;
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
    const source = sources.find(s => s.id === id);
    if (!source) return false;
    const epoch = grantEpoch;
    const result = await dialog.showMessageBox(win, { type: 'question', title: 'Switch shared display?', message: `Your partner requests ${source.name}. Share this display?`, detail: 'Remote control will stop. Enable it again after checking the new display.', buttons: ['Cancel', 'Share display'], defaultId: 0, cancelId: 0, noLink: true });
    return result.response === 1 && activeSession && epoch === grantEpoch;
  });

  handle('capture:started', () => {
    if (!selected || !captureGranted) throw new Error('The selected display was not granted for capture.');
    capturing = true;
    if (blocker === undefined) blocker = powerSaveBlocker.start('prevent-app-suspension');
  });

  handle('capture:stop', stopCapture);
  handle('control:disable', () => revokeControl());
  handle('control:enable', async options => {
    if (!capturing || !captureGranted || !selected || !activeSession) throw new Error('Connect to a viewer while sharing a display first.');
    const epoch = ++grantEpoch;
    const chosen = selected;
    const display = screen.getAllDisplays().find(d => String(d.id) === chosen.displayId);
    if (!display) throw new Error('The captured display cannot be mapped to desktop coordinates. Control is unavailable for this source.');
    if (process.platform === 'darwin' && !systemPreferences.isTrustedAccessibilityClient(true)) throw new Error('Grant WiiUltraConnect Accessibility permission in System Settings, then try again.');
    const unattendedControl = options?.unattended === true;
    if (unattendedControl && unattended?.enabled !== true) throw new Error('Unattended control is not configured on this computer.');
    if (!unattendedControl) {
      const result = await dialog.showMessageBox(win, {
        type: 'question', title: 'Allow remote control?',
        message: 'Allow the connected viewer to use your mouse and keyboard?',
        detail: 'Keyboard shortcuts can act across your desktop. Press Ctrl/Cmd + Alt + Shift + F12 or Stop control to revoke access.',
        buttons: ['Cancel', 'Allow control'], defaultId: 0, cancelId: 0, noLink: true
      });
      if (result.response !== 1) return false;
    }
    if (epoch !== grantEpoch || !capturing || !activeSession || selected !== chosen) return false;
    await input.grant(display.bounds);
    if (epoch !== grantEpoch || !capturing || !activeSession) { await input.revoke(); return false; }
    const registered = globalShortcut.register('CommandOrControl+Alt+Shift+F12', () => { void revokeControl('Emergency shortcut: remote control stopped'); });
    if (!registered) { await input.revoke(); throw new Error('Ctrl/Cmd + Alt + Shift + F12 is in use by another app or control session. Release it and try again.'); }
    return true;
  });

  ipcMain.on('control:input', (event, value) => { if (trusted(event) && capturing && activeSession) input.enqueue(value); });
  screen.on('display-removed', (_event, display) => {
    if (selected?.displayId === String(display.id)) {
      void stopCapture();
      win?.webContents.send('capture:ended', 'The shared display was removed. Start a new session.');
    }
  });
  screen.on('display-metrics-changed', () => { void revokeControl('Display configuration changed. Enable control again.'); });

  function createWindow() {
    win = new BrowserWindow({
      width: 1440, height: 960, minWidth: 900, minHeight: 680,
      show: process.env.WII_SMOKE !== '1',
      icon: path.join(__dirname, 'icon.png'),
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
