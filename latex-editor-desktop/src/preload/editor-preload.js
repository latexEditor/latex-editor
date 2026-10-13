const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('latexDesktopBridge', {
  togglePresence: (bounds) => ipcRenderer.send('latex:editor-toggle-presence', bounds),
  getPresence: () => ipcRenderer.invoke('latex:get-presence'),
  jumpToUser: (userId) => ipcRenderer.invoke('latex:presence-jump-to-user', userId)
});
