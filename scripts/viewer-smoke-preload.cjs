// Test-only viewer bridge. Packaged applications exclude scripts/ entirely.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('wii', {
  config: async () => ({ platform: process.platform, version: 'smoke', systemAudio: false }),
  sources: async () => [], networkInfo: async () => [], sessionActive: async () => {}, stopCapture: async () => {},
  disableControl: async () => {}, onControlRevoked: () => {}, onCaptureEnded: () => {},
  readClipboard: async () => 'clipboard from viewer',
  writeClipboard: text => ipcRenderer.invoke('smoke:clipboard', text)
});
