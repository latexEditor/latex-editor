function registerIpc({ ipcMain, dialog, workspaceManager, runtimeManager, openProject, getState }) {
  const channels = [
    'latex:get-state', 'latex:list-projects', 'latex:create-project',
    'latex:choose-project', 'latex:open-project', 'latex:get-runtime-status'
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
  ipcMain.handle('latex:choose-project', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Mở project LaTeX',
      properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const project = workspaceManager.openProject(result.filePaths[0]);
    await openProject(project.path);
    return project;
  });
}

module.exports = { registerIpc };
