const { app, BrowserWindow, WebContentsView, dialog, ipcMain, shell, session } = require('electron');
const path = require('node:path');
const config = require('./config');
const { CodeServerManager } = require('./CodeServerManager');
const { WorkspaceManager } = require('./WorkspaceManager');
const { LatexRuntimeManager } = require('./LatexRuntimeManager');
const { registerIpc } = require('./ipc');

const TOPBAR_HEIGHT = 40;
let mainWindow;
let editorView;
let serverManager;
let workspaceManager;
let runtimeManager;
let activeProject;
let serverUrl;
let quitting = false;

function state() {
  return {
    phase: serverUrl ? 'ready' : 'starting',
    project: activeProject || null,
    serverUrl: serverUrl?.toString() || null
  };
}

function notifyState() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('latex:state-changed', state());
}

function layoutEditor() {
  if (!mainWindow || !editorView) return;
  const [width, height] = mainWindow.getContentSize();
  editorView.setBounds({ x: 0, y: TOPBAR_HEIGHT, width, height: Math.max(0, height - TOPBAR_HEIGHT) });
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
  activeProject = workspaceManager.openProject(projectPath);
  const target = workspaceManager.codeServerUrl(config.host, serverManager.port, activeProject.path);
  await editorView.webContents.loadURL(target.toString());
  notifyState();
  return activeProject;
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#0b1020',
    title: 'LaTeX Editor',
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
  activeProject = workspaceManager.ensureWelcomeProject();
  registerIpc({
    ipcMain,
    dialog,
    workspaceManager,
    runtimeManager,
    openProject: loadProject,
    getState: state
  });
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  await createWindow();
  await serverManager.start();
  await serverManager.waitUntilReady();
  serverUrl = new URL(`http://${config.host}:${serverManager.port}`);
  await loadProject(activeProject.path);
}

async function shutdown() {
  if (quitting) return;
  quitting = true;
  await Promise.allSettled([serverManager?.stop()]);
}

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
