const { app, BrowserWindow, WebContentsView, dialog, ipcMain, shell, session, safeStorage } = require('electron');
const path = require('node:path');
const config = require('./config');
const { CodeServerManager } = require('./CodeServerManager');
const { WorkspaceManager } = require('./WorkspaceManager');
const { LatexRuntimeManager } = require('./LatexRuntimeManager');
const { registerIpc } = require('./ipc');
const { HistoryManager } = require('./HistoryManager');
const { AuthManager } = require('./AuthManager');
const { CloudSyncManager } = require('./CloudSyncManager');
const { CollaborationManager } = require('./CollaborationManager');
const { CollaborationBridge } = require('./CollaborationBridge');
const { PresenceWindowManager } = require('./PresenceWindowManager');
const { registerFeatureIpc } = require('./featureIpc');

const TOPBAR_HEIGHT = 32;
let mainWindow;
let editorView;
let serverManager;
let workspaceManager;
let runtimeManager;
let authManager;
let collaborationManager;
let collaborationBridge;
let presenceWindowManager;
let activeProject;
let serverUrl;
let quitting = false;
let shellOverlayOpen = false;
const hasSingleInstanceLock = app.requestSingleInstanceLock();

function state() {
  return {
    phase: serverUrl ? 'ready' : 'starting',
    project: activeProject || null,
    openProjects: workspaceManager?.listOpenProjects() || [],
    projectsDir: workspaceManager?.projectsDir || '',
    auth: authManager?.status() || { configured: false, signedIn: false },
    collaboration: collaborationManager?.status() || { enabled: false, connection: 'offline', participants: [], error: null },
    serverUrl: serverUrl?.toString() || null
  };
}

function notifyState() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('latex:state-changed', state());
}

function layoutEditor() {
  if (!mainWindow || !editorView) return;
  if (!activeProject || shellOverlayOpen) {
    hideEditor();
    return;
  }
  try {
    if (!mainWindow.contentView?.children?.includes(editorView)) {
      mainWindow.contentView.addChildView(editorView);
    }
    editorView.setVisible(true);
  } catch {}
  const [width, height] = mainWindow.getContentSize();
  editorView.setBounds({ x: 0, y: TOPBAR_HEIGHT, width, height: Math.max(0, height - TOPBAR_HEIGHT) });
}

function hideEditor() {
  if (!mainWindow || !editorView) return;
  try { editorView.setVisible(false); } catch {}
  try {
    if (mainWindow.contentView?.children?.includes(editorView)) {
      mainWindow.contentView.removeChildView(editorView);
    }
  } catch {}
  editorView.setBounds({ x: -10000, y: -10000, width: 0, height: 0 });
  if (mainWindow?.webContents && !mainWindow.isDestroyed()) {
    mainWindow.webContents.focus();
  }
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

const HIDE_ACCOUNTS_CSS = `
  .activitybar .action-item:has(.codicon-account),
  .activitybar .action-item:has([class*="codicon-account"]),
  .activitybar .action-item:has([aria-label*="Account" i]),
  .activitybar .action-item:has([aria-label*="Accounts" i]),
  .activitybar .action-item:has([aria-label*="Tài khoản" i]),
  .activitybar .action-item:has([aria-label*="Profile" i]),
  .activitybar li.action-item[aria-label*="Account" i],
  .activitybar li.action-item[aria-label*="Accounts" i],
  .activitybar li.action-item[aria-label*="Tài khoản" i],
  .activitybar li.action-item[aria-label*="Profile" i],
  .action-item:has(.codicon-account),
  .action-item:has([class*="codicon-account"]),
  .action-item:has([aria-label*="Account" i]),
  .action-item:has([aria-label*="Accounts" i]),
  .action-item:has([aria-label*="Tài khoản" i]),
  li.action-item[aria-label*="Account" i],
  li.action-item[aria-label*="Accounts" i],
  li.action-item[aria-label*="Tài khoản" i],
  [aria-label*="Accounts" i].action-item,
  [aria-label*="Tài khoản" i].action-item,
  .codicon-account,
  [class*="codicon-account"] {
    display: none !important;
  }
`;

const HIDE_ACCOUNTS_SCRIPT = `
  (() => {
    const hide = () => {
      document.querySelectorAll('.codicon-account, [class*="codicon-account"]').forEach((el) => {
        const item = el.closest('.action-item') || el;
        item.style.setProperty('display', 'none', 'important');
      });
    };
    hide();
    if (!window.__latexHideAccountsObserver) {
      window.__latexHideAccountsObserver = new MutationObserver(hide);
      window.__latexHideAccountsObserver.observe(document.documentElement, { childList: true, subtree: true });
    }
  })();
`;

async function applyEditorCustomizations() {
  if (!editorView?.webContents || editorView.webContents.isDestroyed()) return;
  try {
    await editorView.webContents.insertCSS(HIDE_ACCOUNTS_CSS);
  } catch {
    // Ignore transient navigation errors
  }
  try {
    await editorView.webContents.executeJavaScript(HIDE_ACCOUNTS_SCRIPT);
  } catch {
    // Ignore transient script errors
  }
}

async function loadProject(projectPath) {
  if (!projectPath) {
    collaborationManager?.close();
    activeProject = null;
    hideEditor();
    notifyState();
    return null;
  }
  activeProject = workspaceManager.openProject(projectPath);
  const target = workspaceManager.codeServerUrl(config.host, serverManager.port, activeProject.path);
  showEditor();
  notifyState();
  const currentUrl = editorView?.webContents?.getURL();
  if (!currentUrl || currentUrl === 'about:blank' || currentUrl !== target.toString()) {
    await editorView.webContents.loadURL(target.toString());
    await applyEditorCustomizations();
  }
  showEditor();
  if (editorView?.webContents) {
    editorView.webContents.focus();
    editorView.webContents.executeJavaScript('window.dispatchEvent(new Event("resize"));').catch(() => {});
  }
  collaborationManager?.open(activeProject.path).catch(() => {});
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
    icon: config.iconPath,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#f8fafc',
      symbolColor: '#334155',
      height: 32
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
  editorView.webContents.on('dom-ready', applyEditorCustomizations);
  editorView.webContents.on('did-finish-load', applyEditorCustomizations);
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
  const startupStartedAt = Date.now();
  runtimeManager = new LatexRuntimeManager({ cacheFile: config.runtimeStatusFile });
  const runtimeStatus = runtimeManager.getStatus();
  config.additionalPath = runtimeStatus.pathEntries.join(path.delimiter);
  workspaceManager = new WorkspaceManager(config, { runtimeStatus });
  serverManager = new CodeServerManager(config);
  workspaceManager.initialize();
  collaborationBridge = new CollaborationBridge({
    onMessage: (message) => collaborationManager?.handleEditorMessage(message)
  });
  const bridge = await collaborationBridge.start();
  config.collaborationBridgePort = bridge.port;
  config.collaborationBridgeToken = bridge.token;
  let serverStartupError = null;
  const serverReady = (async () => {
    await serverManager.start();
    await serverManager.waitUntilReady();
    serverUrl = new URL(`http://${config.host}:${serverManager.port}`);
    notifyState();
  })().catch((error) => { serverStartupError = error; });
  const history = new HistoryManager(config);
  authManager = new AuthManager(config, {
    safeStorage,
    openExternal: (url) => shell.openExternal(url),
    onChange: () => {
      collaborationManager?.open(activeProject?.path || null).catch(() => {});
      notifyState();
    }
  });
  await authManager.initialize();
  const cloud = new CloudSyncManager(config, { auth: authManager, history, workspace: workspaceManager });
  collaborationManager = new CollaborationManager({
    auth: authManager,
    cloud,
    onChange: notifyState,
    onEditorMessage: (message) => collaborationBridge?.publish(message)
  });
  registerFeatureIpc({
    ipcMain, dialog, workspace: workspaceManager, history, auth: authManager, cloud,
    collaboration: collaborationManager, openProject: loadProject
  });
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
    auth: authManager,
    cloud,
    openProject: loadProject,
    closeProject: closeProjectTab,
    hideEditor: () => { shellOverlayOpen = true; hideEditor(); },
    showEditor: () => {
      shellOverlayOpen = false;
      showEditor();
      if (activeProject && editorView?.webContents) {
        editorView.webContents.focus();
        editorView.webContents.executeJavaScript('window.dispatchEvent(new Event("resize"));').catch(() => {});
      }
    },
    togglePresencePopover: (anchor) => presenceWindowManager?.toggle(anchor) || false,
    jumpToUser: (userId) => {
      presenceWindowManager?.close();
      return collaborationManager?.jumpToParticipant(userId);
    },
    getState: state
  });
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  await createWindow();
  presenceWindowManager = new PresenceWindowManager(mainWindow, () => ({
    participants: collaborationManager?.status().participants || [],
    currentUserId: authManager?.status().user?.id || null
  }));
  await serverReady;
  if (serverStartupError) throw serverStartupError;
  await loadProject(activeProject?.path || null);
  console.info(`LaTeX Editor ready in ${Date.now() - startupStartedAt}ms`);
}

async function shutdown() {
  if (quitting) return;
  quitting = true;
  authManager?.dispose();
  collaborationManager?.dispose();
  presenceWindowManager?.dispose();
  await Promise.allSettled([serverManager?.stop(), collaborationBridge?.stop()]);
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
