const { app, BrowserWindow, desktopCapturer, ipcMain, session, screen, dialog, globalShortcut, systemPreferences, clipboard, powerSaveBlocker } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { InputController } = require('./input-controller.cjs');
const { checkForVerifiedUpdate, downloadVerifiedArtifact, readUpdateState, writeUpdateState } = require('./update-client.cjs');
const { compareVersions } = require('./update-verifier.cjs');

app.setName('WiiUltraConnect');
if (process.env.WII_SMOKE !== '1') app.setPath('userData', path.join(app.getPath('appData'), 'WiiUltraConnect'));
const page = pathToFileURL(path.join(__dirname, '../src/index.html')).href;
let win;
let selected = null;
let capturing = false;
let captureGranted = false;
let grantEpoch = 0;
let quitting = false;
let activeSession = false;
let blocker;
let verifiedUpdate;

function readUpdateConfiguration() {
  try {
    const configPath = path.join(app.getAppPath(), 'build', 'update-endpoint.json');
    const updateConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!updateConfig || updateConfig.metadataUrl === null) return { metadataUrl: null };
    if (typeof updateConfig.metadataUrl !== 'string') throw new Error('metadataUrl must be null or a credential-free HTTPS URL');
    const metadataUrl = new URL(updateConfig.metadataUrl);
    if (metadataUrl.protocol !== 'https:' || metadataUrl.username || metadataUrl.password || metadataUrl.hash) throw new Error('metadataUrl must be a credential-free HTTPS URL without a fragment');
    return { metadataUrl: metadataUrl.toString() };
  } catch (error) {
    console.error(`[Update] Invalid update configuration: ${error.message}`);
    return { metadataUrl: null };
  }
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
    screenAccess,
    systemAudio: process.platform === 'win32',
    edition: 'Direct · No intermediary services',
    updatesConfigured: Boolean(readUpdateConfiguration().metadataUrl)
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
  handle('app:networkInfo', getNetworkInfo);
  handle('update:check', async () => {
    const updateConfig = readUpdateConfiguration();
    if (!updateConfig.metadataUrl) throw new Error('Updates are not configured in this build. Install a signed release manually.');
    const keyring = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'build', 'update-keys.json'), 'utf8'));
    const statePath = path.join(app.getPath('userData'), 'update-state.json');
    const state = readUpdateState(statePath);
    const format = process.platform === 'win32' ? 'nsis' : process.platform === 'darwin' ? 'zip' : 'deb';
    const result = await checkForVerifiedUpdate({ metadataUrl: updateConfig.metadataUrl, keyring, state: { ...state, currentVersion: app.getVersion() }, platform: process.platform, arch: process.arch, format });
    writeUpdateState(statePath, result.nextState);
    verifiedUpdate = compareVersions(result.signed.version, app.getVersion()) > 0 ? result : undefined;
    return { available: Boolean(verifiedUpdate), version: result.signed.version, artifact: verifiedUpdate ? { name: result.artifact.name, size: result.artifact.size } : undefined };
  });
  handle('update:download', async () => {
    if (!verifiedUpdate) throw new Error('Check for an update first. No verified newer update is pending.');
    const destination = path.join(app.getPath('downloads'), verifiedUpdate.artifact.name);
    const result = await downloadVerifiedArtifact({ artifact: verifiedUpdate.artifact, destination });
    return { file: result.destination, sha256: result.digest };
  });
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
  handle('control:enable', async () => {
    if (!capturing || !captureGranted || !selected || !activeSession) throw new Error('Connect to a viewer while sharing a display first.');
    const epoch = ++grantEpoch;
    const chosen = selected;
    const display = screen.getAllDisplays().find(d => String(d.id) === chosen.displayId);
    if (!display) throw new Error('The captured display cannot be mapped to desktop coordinates. Control is unavailable for this source.');
    if (process.platform === 'darwin' && !systemPreferences.isTrustedAccessibilityClient(true)) throw new Error('Grant WiiUltraConnect Accessibility permission in System Settings, then try again.');
    const result = await dialog.showMessageBox(win, {
      type: 'question', title: 'Allow remote control?',
      message: 'Allow the connected viewer to use your mouse and keyboard?',
      detail: 'Keyboard shortcuts can act across your desktop. Press Ctrl/Cmd + Alt + Shift + F12 or Stop control to revoke access.',
      buttons: ['Cancel', 'Allow control'], defaultId: 0, cancelId: 0, noLink: true
    });
    if (result.response !== 1 || epoch !== grantEpoch || !capturing || !activeSession || selected !== chosen) return false;
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
