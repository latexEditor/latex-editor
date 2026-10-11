const path = require('node:path');

let isPackaged = false;
let resourcesDir = path.resolve(__dirname, '../..');
try {
  const electron = require('electron');
  if (electron?.app?.isPackaged) {
    isPackaged = true;
    resourcesDir = process.resourcesPath;
  }
} catch {
  // Ignore in non-Electron environments (e.g. tests)
}

const rootDir = path.resolve(__dirname, '../..');
const baseDir = isPackaged ? resourcesDir : rootDir;
const defaultApiUrl = 'https://latex-editor-cloud.emsidt.workers.dev';
const appDataRoot = process.env.LATEX_EDITOR_DATA_DIR
  || path.join(process.env.APPDATA || rootDir, 'LatexEditor');

module.exports = {
  rootDir,
  resourcesDir: baseDir,
  isPackaged,
  host: process.env.CODE_SERVER_HOST || '127.0.0.1',
  preferredPort: Number(process.env.CODE_SERVER_PORT || 8765),
  readyTimeoutMs: Number(process.env.CODE_SERVER_READY_TIMEOUT_MS || 60_000),
  executable: process.env.CODE_SERVER_BIN || path.join(baseDir, 'runtime', 'code-server-node20.cmd'),
  auth: 'none',
  appDataDir: path.join(appDataRoot, 'code-server-data'),
  extensionsDir: path.join(appDataRoot, 'extensions'),
  bundledExtensionsDir: path.join(baseDir, 'resources', 'extensions'),
  bundledCollaborationExtension: path.join(baseDir, 'resources', 'extensions', 'latex-editor-collaboration'),
  iconPath: path.join(baseDir, 'resources', 'icons', 'icon.png'),
  iconIcoPath: path.join(baseDir, 'resources', 'icons', 'icon.ico'),
  projectsDir: process.env.LATEX_EDITOR_PROJECTS_DIR || path.join(appDataRoot, 'projects'),
  settingsFile: path.join(appDataRoot, 'settings.json'),
  historyDir: path.join(appDataRoot, 'history'),
  cloudDir: path.join(appDataRoot, 'cloud'),
  sessionFile: path.join(appDataRoot, 'auth-session.bin'),
  runtimeStatusFile: path.join(appDataRoot, 'runtime-status.json'),
  apiUrl: process.env.LATEX_EDITOR_API_URL || defaultApiUrl,
  personalTemplatesDir: path.join(appDataRoot, 'templates'),
  templateDir: path.join(baseDir, 'resources', 'templates', 'basic-article'),
  templatesDir: path.join(baseDir, 'resources', 'templates')
};

