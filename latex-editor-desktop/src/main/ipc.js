const { BrowserWindow, shell } = require('electron');

function registerIpc({ ipcMain, dialog, workspaceManager, runtimeManager, auth, cloud, openProject, closeProject, hideEditor, showEditor, togglePresencePopover = () => false, jumpToUser = () => false, getState }) {
  let choosingProject = false;
  let choosingTemplate = false;
  const channels = [
    'latex:get-state', 'latex:list-projects', 'latex:create-project',
    'latex:choose-project', 'latex:open-project', 'latex:get-runtime-status',
    'latex:close-project', 'latex:hide-editor', 'latex:show-editor', 'latex:toggle-presence-popover',
    'latex:presence-jump-to-user',
    'latex:list-templates', 'latex:import-template', 'latex:save-project-template',
    'latex:forget-project', 'latex:reveal-project'
  ];
  for (const channel of channels) ipcMain.removeHandler(channel);

  ipcMain.handle('latex:get-state', () => getState());
  ipcMain.handle('latex:list-projects', () => workspaceManager.listRecent());
  ipcMain.handle('latex:list-templates', () => workspaceManager.listTemplates());
  ipcMain.handle('latex:import-template', async (event, name) => {
    if (choosingTemplate) return null;
    choosingTemplate = true;
    try {
      const owner = BrowserWindow.fromWebContents(event.sender);
      const options = {
        title: 'Nhập template LaTeX',
        properties: ['openFile'],
        filters: [{ name: 'Template ZIP', extensions: ['zip'] }]
      };
      const result = owner && !owner.isDestroyed()
        ? await dialog.showOpenDialog(owner, options)
        : await dialog.showOpenDialog(options);
      if (result.canceled || !result.filePaths[0]) return null;
      return workspaceManager.importTemplateZip(result.filePaths[0], name);
    } finally {
      choosingTemplate = false;
    }
  });
  ipcMain.handle('latex:save-project-template', (_event, projectPath, name) => (
    workspaceManager.saveProjectAsTemplate(projectPath, name)
  ));
  ipcMain.handle('latex:forget-project', (_event, projectPath) => workspaceManager.forgetProject(projectPath));
  ipcMain.handle('latex:reveal-project', async (_event, projectPath) => {
    const error = await shell.openPath(workspaceManager.getProjectLocation(projectPath));
    if (error) throw new Error(`Không mở được thư mục: ${error}`);
  });
  ipcMain.handle('latex:get-runtime-status', () => runtimeManager.getStatus());
  ipcMain.handle('latex:create-project', async (_event, name, templateId) => {
    if (!auth?.status().signedIn) throw new Error('Hãy đăng nhập trước khi tạo project mới để dữ liệu được lưu lên cloud.');
    const project = workspaceManager.createProject(name, templateId);
    let cloudWarning = null;
    let cloudProject = null;
    try {
      const synced = await cloud.upload(project.path);
      cloudProject = synced.project || null;
    } catch (error) {
      // The local working copy must remain recoverable when the network or cloud
      // is unavailable. The UI exposes the warning and the manual retry action.
      cloudWarning = `Project đã được tạo trên máy nhưng chưa lưu được lên cloud: ${error.message}`;
    }
    await openProject(project.path);
    return { ...project, cloudProject, cloudWarning };
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
  ipcMain.handle('latex:toggle-presence-popover', (_event, anchor) => togglePresencePopover(anchor));
  ipcMain.handle('latex:presence-jump-to-user', (_event, userId) => jumpToUser(userId));
}

module.exports = { registerIpc };
