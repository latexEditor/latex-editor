const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('latexDesktopBridge', {
  togglePresence: (bounds) => ipcRenderer.send('latex:editor-toggle-presence', bounds)
});
