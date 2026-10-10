const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('presenceWindow', {
  onData: (callback) => ipcRenderer.once('presence:data', (_event, data) => callback(data)),
  close: () => window.close()
});
