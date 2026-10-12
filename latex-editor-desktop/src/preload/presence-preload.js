const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('presenceWindow', {
  onData: (callback) => ipcRenderer.once('presence:data', (_event, data) => callback(data)),
  jumpToUser: (userId) => ipcRenderer.invoke('latex:presence-jump-to-user', userId),
  close: () => window.close()
});
