const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('wii', Object.freeze({
  config: () => ipcRenderer.invoke('app:config'),
  networkInfo: () => ipcRenderer.invoke('app:networkInfo'),
  ensureSignalServer: () => ipcRenderer.invoke('app:ensureSignalServer'),
  sources: () => ipcRenderer.invoke('capture:sources'),
  selectSource: id => ipcRenderer.invoke('capture:select', id),
  captureStarted: () => ipcRenderer.invoke('capture:started'),
  stopCapture: () => ipcRenderer.invoke('capture:stop'),
  enableControl: () => ipcRenderer.invoke('control:enable'),
  disableControl: () => ipcRenderer.invoke('control:disable'),
  input: value => ipcRenderer.send('control:input', value),
  onControlRevoked: callback => {
    const listener = (_event, reason) => callback(reason);
    ipcRenderer.on('control:revoked', listener);
    return () => ipcRenderer.removeListener('control:revoked', listener);
  }
}));
