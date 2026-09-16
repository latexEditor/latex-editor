const path = require('node:path');

const rootDir = path.resolve(__dirname, '../..');
const appDataRoot = process.env.LATEX_EDITOR_DATA_DIR
  || path.join(process.env.APPDATA || rootDir, 'LatexEditor');

module.exports = {
  rootDir,
  host: process.env.CODE_SERVER_HOST || '127.0.0.1',
  preferredPort: Number(process.env.CODE_SERVER_PORT || 8765),
  readyTimeoutMs: Number(process.env.CODE_SERVER_READY_TIMEOUT_MS || 60_000),
  executable: process.env.CODE_SERVER_BIN || path.join(rootDir, 'runtime', 'code-server-node20.cmd'),
  auth: 'none',
  appDataDir: path.join(appDataRoot, 'code-server-data'),
  extensionsDir: path.join(appDataRoot, 'extensions'),
  projectsDir: process.env.LATEX_EDITOR_PROJECTS_DIR || path.join(appDataRoot, 'projects'),
  settingsFile: path.join(appDataRoot, 'settings.json'),
  templateDir: path.join(rootDir, 'resources', 'templates', 'basic-article')
};
