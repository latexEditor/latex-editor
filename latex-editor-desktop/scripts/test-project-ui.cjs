// Exercises the actual renderer, preload and IPC. Only the editor and OS dialogs
// are replaced; projects/settings live in an isolated temporary directory.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { WorkspaceManager } = require('../src/main/WorkspaceManager');
const { registerIpc } = require('../src/main/ipc');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'latex-editor-ui-'));
app.setPath('userData', path.join(root, 'electron'));
app.disableHardwareAcceleration();
const manager = new WorkspaceManager({
  projectsDir: path.join(root, 'projects'),
  settingsFile: path.join(root, 'settings.json'),
  templateDir: path.resolve(__dirname, '../resources/templates/basic-article')
});
manager.initialize();
let window;
let activeProject = null;
let overlayOpen = false;
let choosingCount = 0;
const revealed = [];
const errors = [];
const state = () => ({ phase: 'ready', project: activeProject, openProjects: manager.listOpenProjects(), projectsDir: manager.projectsDir });
const notify = () => window.webContents.send('latex:state-changed', state());
shell.openPath = async (location) => { revealed.push(location); return ''; };
dialog.showOpenDialog = async () => { choosingCount += 1; return { canceled: true, filePaths: [] }; };

registerIpc({
  ipcMain, dialog, workspaceManager: manager,
  runtimeManager: { getStatus: () => ({ canBuild: true, distribution: 'Test runtime', tools: [] }) },
  openProject: async (location) => { activeProject = manager.openProject(location); notify(); },
  closeProject: async (location) => { activeProject = manager.closeProject(location); notify(); },
  hideEditor: () => { overlayOpen = true; },
  showEditor: () => { overlayOpen = false; },
  getState: state
});

const evaluate = (fn, ...args) => window.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
const click = (selector) => evaluate((target) => document.querySelector(target).click(), selector);
async function waitFor(predicate, message) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`Timed out: ${message}`);
}
const waitForPage = (predicate, message) => waitFor(() => evaluate(predicate), message);
async function capture(name) {
  if (!process.env.LATEX_EDITOR_UI_SCREENSHOTS) return;
  const directory = path.resolve(process.env.LATEX_EDITOR_UI_SCREENSHOTS);
  fs.mkdirSync(directory, { recursive: true });
  const image = await window.webContents.capturePage();
  fs.writeFileSync(path.join(directory, `${name}.png`), image.toPNG());
}

async function run() {
  window = new BrowserWindow({
    show: false, width: 1100, height: 820,
    webPreferences: {
      preload: path.resolve(__dirname, '../src/preload/preload.js'),
      nodeIntegration: false, contextIsolation: true, sandbox: true
    }
  });
  window.webContents.on('console-message', (_event, details) => {
    if (details.level === 'error') errors.push(details.message);
  });
  await window.loadFile(path.resolve(__dirname, '../src/renderer/index.html'));
  await waitForPage(() => !document.querySelector('#new-project').disabled, 'shell ready');
  assert.equal(await evaluate(() => document.querySelector('#empty-workspace').hidden), false);

  await click('#welcome-new');
  await waitForPage(() => document.querySelectorAll('input[name="project-template"]').length === 4, 'template choices');
  assert.equal(overlayOpen, true);
  await capture('new-project');
  await evaluate(() => {
    document.querySelector('#new-project-name').value = 'Báo cáo thử nghiệm';
    document.querySelector('input[value="report"]').checked = true;
    document.querySelector('#new-project-form').requestSubmit();
  });
  await waitForPage(() => !document.querySelector('#new-dialog').open && document.querySelectorAll('.project-tab').length === 1, 'create report');
  await waitFor(() => !overlayOpen, 'restore editor');
  const report = activeProject;
  assert.equal(fs.existsSync(path.join(report.path, 'chapters', 'introduction.tex')), true);
  await click('.project-tab-close');
  await waitForPage(() => !document.querySelector('#empty-workspace').hidden && document.querySelectorAll('#welcome-project-list .recent-project').length === 1, 'closed project on welcome page');
  await capture('welcome');

  await click('#recent-projects');
  await waitForPage(() => document.querySelector('#recent-dialog').open && document.querySelectorAll('#recent-project-list .recent-project').length === 1, 'recent dialog');
  await evaluate(() => {
    const input = document.querySelector('#project-search');
    input.value = 'không tồn tại';
    input.dispatchEvent(new Event('input'));
  });
  assert.equal(await evaluate(() => document.querySelectorAll('#recent-project-list .recent-project').length), 0);
  await evaluate(() => {
    const input = document.querySelector('#project-search');
    input.value = 'BÁO CÁO';
    input.dispatchEvent(new Event('input'));
  });
  assert.equal(await evaluate(() => document.querySelectorAll('#recent-project-list .recent-project').length), 1);
  await click('#recent-project-list .recent-project-actions button');
  await waitFor(() => revealed.length === 1, 'reveal project');
  assert.equal(revealed[0], report.path);
  await click('#reveal-projects-root');
  await waitFor(() => revealed.length === 2, 'reveal storage root');
  assert.equal(revealed[1], manager.projectsDir);
  await capture('recent-projects');
  await click('#recent-project-list .recent-project-open');
  await waitForPage(() => !document.querySelector('#recent-dialog').open && document.querySelectorAll('.project-tab').length === 1, 'reopen project');
  assert.equal(activeProject.path, report.path);

  await click('#recent-projects');
  await waitForPage(() => document.querySelector('#recent-dialog').open, 'repeated recent dialog');
  await click('#recent-project-list .recent-project-actions button:last-child');
  await waitFor(() => manager.listRecent().length === 0, 'forget project');
  assert.equal(fs.existsSync(path.join(report.path, 'main.tex')), true);
  assert.equal(manager.listOpenProjects().length, 1);
  await click('#recent-close');
  await waitFor(() => !overlayOpen, 'close recent dialog');

  const missing = manager.createProject('Moved elsewhere', 'blank');
  manager.closeProject(missing.path);
  fs.renameSync(missing.path, `${missing.path}-moved`);
  await click('#recent-projects');
  await waitForPage(() => Boolean(document.querySelector('#recent-project-list .missing')), 'missing project indication');
  assert.equal(await evaluate(() => document.querySelector('#recent-project-list .missing .recent-project-open').disabled), true);
  await click('#recent-project-list .recent-project-actions button:last-child');
  await waitFor(() => manager.listRecent().length === 0, 'forget missing project');
  await click('#recent-close');

  // Canceling the native folder picker must not disable subsequent attempts.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await click('#open-project');
    await waitFor(() => choosingCount === attempt, 'folder picker invoked');
    await waitForPage(() => !document.querySelector('#open-project').disabled, 'folder button restored');
  }
  await click('#new-project');
  await waitForPage(() => document.querySelector('#new-dialog').open && document.querySelectorAll('.template-option').length === 4, 'repeat new project');
  await evaluate(() => {
    document.querySelector('#new-project-name').value = 'Báo cáo thử nghiệm';
    document.querySelector('#new-project-form').requestSubmit();
  });
  await waitForPage(() => document.querySelector('#dialog-error').textContent.includes('đã tồn tại'), 'duplicate name error');
  assert.equal(await evaluate(() => document.querySelector('#create-confirm').disabled), false);
  await click('#create-cancel');
  await waitFor(() => !overlayOpen, 'editor restored after cancel');

  for (let index = 1; index <= 6; index += 1) {
    manager.createProject(`Project ${index} with a longer name`, 'blank');
  }
  notify();
  window.setSize(960, 640);
  await waitForPage(() => window.innerWidth <= 960 && document.querySelectorAll('.project-tab').length === 7, 'compact toolbar');
  assert.equal(await evaluate(() => {
    const end = document.querySelector('.status').getBoundingClientRect().right;
    return end <= window.innerWidth - 139;
  }), true, 'toolbar should leave room for window controls');
  for (const project of manager.listOpenProjects()) manager.closeProject(project.path);
  activeProject = null;
  notify();
  await waitForPage(() => !document.querySelector('#empty-workspace').hidden && document.querySelectorAll('#welcome-project-list .recent-project').length === 5, 'populated welcome screen');
  assert.equal(await evaluate(() => document.querySelector('.empty-workspace-card').getBoundingClientRect().top >= 48), true, 'welcome screen must scroll without clipping its top');
  await capture('welcome-small-window');
  assert.deepEqual(errors, []);
  console.log('PASS: templates, create/close/reopen, Unicode search, reveal paths, forget safely, missing folders, repeated dialogs, duplicate validation, compact window layout.');
}

const timeout = setTimeout(() => { console.error('UI test timeout'); app.exit(1); }, 45000);
app.whenReady().then(run).then(() => finish(0), (error) => { console.error(error); finish(1); });
function finish(code) {
  clearTimeout(timeout);
  if (window && !window.isDestroyed()) window.destroy();
  // Electron may still hold its cache files; remove only our project fixtures.
  fs.rmSync(manager.projectsDir, { recursive: true, force: true });
  fs.rmSync(manager.settingsFile, { force: true });
  app.exit(code);
}
