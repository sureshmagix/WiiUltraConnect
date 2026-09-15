const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('wii', Object.freeze({
  config: () => ipcRenderer.invoke('app:config'),
  unattendedConfig: () => ipcRenderer.invoke('unattended:config'),
  saveUnattended: value => ipcRenderer.invoke('unattended:save', value),
  networkInfo: () => ipcRenderer.invoke('app:networkInfo'),
  sessionActive: value => ipcRenderer.invoke('session:active', value),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  writeClipboard: value => ipcRenderer.invoke('clipboard:write', value),
  sources: () => ipcRenderer.invoke('capture:sources'),
  selectSource: (id, audio) => ipcRenderer.invoke('capture:select', id, audio),
  confirmDisplaySwitch: id => ipcRenderer.invoke('capture:confirmSwitch', id),
  captureStarted: () => ipcRenderer.invoke('capture:started'),
  stopCapture: () => ipcRenderer.invoke('capture:stop'),
  enableControl: options => ipcRenderer.invoke('control:enable', options),
  disableControl: () => ipcRenderer.invoke('control:disable'),
  input: value => ipcRenderer.send('control:input', value),
  onCaptureEnded: callback => {
    const listener = (_event, reason) => callback(reason);
    ipcRenderer.on('capture:ended', listener);
    return () => ipcRenderer.removeListener('capture:ended', listener);
  },
  onControlRevoked: callback => {
    const listener = (_event, reason) => callback(reason);
    ipcRenderer.on('control:revoked', listener);
    return () => ipcRenderer.removeListener('control:revoked', listener);
  }
}));
