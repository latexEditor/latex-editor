const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('latexEditor', {
  getState: () => ipcRenderer.invoke('latex:get-state'),
  listProjects: () => ipcRenderer.invoke('latex:list-projects'),
  createProject: (name) => ipcRenderer.invoke('latex:create-project', name),
  chooseProject: () => ipcRenderer.invoke('latex:choose-project'),
  openProject: (projectPath) => ipcRenderer.invoke('latex:open-project', projectPath),
  closeProject: (projectPath) => ipcRenderer.invoke('latex:close-project', projectPath),
  hideEditor: () => ipcRenderer.invoke('latex:hide-editor'),
  showEditor: () => ipcRenderer.invoke('latex:show-editor'),
  getRuntimeStatus: () => ipcRenderer.invoke('latex:get-runtime-status'),
  onStateChanged: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('latex:state-changed', listener);
    return () => ipcRenderer.removeListener('latex:state-changed', listener);
  }
});
