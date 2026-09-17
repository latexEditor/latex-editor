const { app, BrowserWindow, WebContentsView, dialog, ipcMain, shell, session } = require('electron');
const path = require('node:path');
const config = require('./config');
const { CodeServerManager } = require('./CodeServerManager');
const { WorkspaceManager } = require('./WorkspaceManager');
const { LatexRuntimeManager } = require('./LatexRuntimeManager');
const { registerIpc } = require('./ipc');

const TOPBAR_HEIGHT = 48;
let mainWindow;
let editorView;
let serverManager;
let workspaceManager;
let runtimeManager;
let activeProject;
let serverUrl;
let quitting = false;
const hasSingleInstanceLock = app.requestSingleInstanceLock();

function state() {
  return {
    phase: serverUrl ? 'ready' : 'starting',
    project: activeProject || null,
    openProjects: workspaceManager?.listOpenProjects() || [],
    serverUrl: serverUrl?.toString() || null
  };
}

function notifyState() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('latex:state-changed', state());
}

function layoutEditor() {
  if (!mainWindow || !editorView) return;
  if (!activeProject) {
    hideEditor();
    return;
  }
  const [width, height] = mainWindow.getContentSize();
  editorView.setBounds({ x: 0, y: TOPBAR_HEIGHT, width, height: Math.max(0, height - TOPBAR_HEIGHT) });
}

function hideEditor() {
  if (!mainWindow || !editorView) return;
  editorView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
}

function showEditor() {
  if (activeProject) layoutEditor();
  else hideEditor();
}

function allowedEditorUrl(target) {
  try {
    const url = new URL(target);
    return Boolean(serverUrl && url.origin === serverUrl.origin);
  } catch {
    return false;
  }
}

async function loadProject(projectPath) {
  if (!projectPath) {
    activeProject = null;
    hideEditor();
    notifyState();
    return null;
  }
  activeProject = workspaceManager.openProject(projectPath);
  const target = workspaceManager.codeServerUrl(config.host, serverManager.port, activeProject.path);
  await editorView.webContents.loadURL(target.toString());
  showEditor();
  notifyState();
  return activeProject;
}

async function closeProjectTab(projectPath) {
  const closingActiveProject = activeProject?.path
    && path.resolve(activeProject.path).toLowerCase() === path.resolve(projectPath).toLowerCase();
  const nextProject = workspaceManager.closeProject(projectPath);
  if (closingActiveProject) await loadProject(nextProject?.path || null);
  else notifyState();
  return nextProject;
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#ffffff',
    title: 'LaTeX Editor',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#f8fafc',
      symbolColor: '#334155',
      height: 48
    },
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });
  mainWindow.removeMenu();
  await mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  mainWindow.on('resize', layoutEditor);
  mainWindow.on('closed', () => { mainWindow = null; });

  editorView = new WebContentsView({
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true }
  });
  mainWindow.contentView.addChildView(editorView);
  layoutEditor();
  editorView.webContents.on('will-navigate', (event, target) => {
    if (!allowedEditorUrl(target)) event.preventDefault();
  });
  editorView.webContents.setWindowOpenHandler(({ url }) => {
    if (allowedEditorUrl(url)) return { action: 'allow' };
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.show();
}

async function startup() {
  runtimeManager = new LatexRuntimeManager();
  const runtimeStatus = runtimeManager.getStatus();
  config.additionalPath = [...new Set(runtimeStatus.tools
    .filter((tool) => tool.available)
    .map((tool) => path.dirname(tool.path)))].join(path.delimiter);
  workspaceManager = new WorkspaceManager(config, { runtimeStatus });
  serverManager = new CodeServerManager(config);
  workspaceManager.initialize();
  const restoredProjects = workspaceManager.listOpenProjects();
  const mostRecentOpenProject = workspaceManager.listRecent().find((recentProject) => (
    restoredProjects.some((openProject) => openProject.path.toLowerCase() === recentProject.path.toLowerCase())
  ));
  activeProject = mostRecentOpenProject || restoredProjects[0]
    || (workspaceManager.hasOpenProjectsState() ? null : workspaceManager.ensureWelcomeProject());
  registerIpc({
    ipcMain,
    dialog,
    workspaceManager,
    runtimeManager,
    openProject: loadProject,
    closeProject: closeProjectTab,
    hideEditor,
    showEditor,
    getState: state
  });
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  await createWindow();
  await serverManager.start();
  await serverManager.waitUntilReady();
  serverUrl = new URL(`http://${config.host}:${serverManager.port}`);
  await loadProject(activeProject?.path || null);
}

async function shutdown() {
  if (quitting) return;
  quitting = true;
  await Promise.allSettled([serverManager?.stop()]);
}

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(startup).catch(async (error) => {
  console.error('Startup failed:', error);
  await shutdown();
  await dialog.showMessageBox({
    type: 'error',
    title: 'Không thể khởi động LaTeX Editor',
    message: error.message,
    detail: 'Kiểm tra README và chạy npm run setup trước khi thử lại.'
  });
  app.quit();
  });

  const quitFromSignal = () => shutdown().finally(() => app.quit());
  process.once('SIGINT', quitFromSignal);
  process.once('SIGTERM', quitFromSignal);
}

app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  shutdown().finally(() => app.quit());
});
app.on('window-all-closed', () => app.quit());
app.on('render-process-gone', (_event, webContents) => {
  if (webContents === mainWindow?.webContents || webContents === editorView?.webContents) shutdown();
});
app.on('child-process-gone', () => shutdown());
