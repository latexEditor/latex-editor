const { BrowserWindow } = require('electron');

function registerIpc({ ipcMain, dialog, workspaceManager, runtimeManager, openProject, closeProject, hideEditor, showEditor, getState }) {
  let choosingProject = false;
  const channels = [
    'latex:get-state', 'latex:list-projects', 'latex:create-project',
    'latex:choose-project', 'latex:open-project', 'latex:get-runtime-status',
    'latex:close-project', 'latex:hide-editor', 'latex:show-editor'
  ];
  for (const channel of channels) ipcMain.removeHandler(channel);

  ipcMain.handle('latex:get-state', () => getState());
  ipcMain.handle('latex:list-projects', () => workspaceManager.listRecent());
  ipcMain.handle('latex:get-runtime-status', () => runtimeManager.getStatus());
  ipcMain.handle('latex:create-project', async (_event, name) => {
    const project = workspaceManager.createProject(name);
    await openProject(project.path);
    return project;
  });
  ipcMain.handle('latex:open-project', async (_event, projectPath) => {
    const project = workspaceManager.openProject(projectPath);
    await openProject(project.path);
    return project;
  });
  ipcMain.handle('latex:choose-project', async (event) => {
    if (choosingProject) return null;
    choosingProject = true;
    try {
      const owner = BrowserWindow.fromWebContents(event.sender);
      const options = {
        title: 'Mở project LaTeX',
        properties: ['openDirectory', 'createDirectory']
      };
      const result = owner && !owner.isDestroyed()
        ? await dialog.showOpenDialog(owner, options)
        : await dialog.showOpenDialog(options);
      if (result.canceled || !result.filePaths[0]) return null;
      const project = workspaceManager.openProject(result.filePaths[0]);
      await openProject(project.path);
      return project;
    } finally {
      choosingProject = false;
    }
  });
  ipcMain.handle('latex:close-project', (_event, projectPath) => closeProject(projectPath));
  ipcMain.handle('latex:hide-editor', () => {
    hideEditor();
  });
  ipcMain.handle('latex:show-editor', () => {
    showEditor();
  });
}

module.exports = { registerIpc };
