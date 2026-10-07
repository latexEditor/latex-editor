// Exercises the actual renderer, preload and IPC. Only the editor and OS dialogs
// are replaced; projects/settings live in an isolated temporary directory.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, dialog, ipcMain, shell, safeStorage } = require('electron');
const { WorkspaceManager } = require('../src/main/WorkspaceManager');
const { registerIpc } = require('../src/main/ipc');
const { HistoryManager } = require('../src/main/HistoryManager');
const { AuthManager } = require('../src/main/AuthManager');
const { CloudSyncManager } = require('../src/main/CloudSyncManager');
const { registerFeatureIpc } = require('../src/main/featureIpc');

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
const history = new HistoryManager({ historyDir: path.join(root, 'history') });
const auth = new AuthManager({ apiUrl: '', sessionFile: path.join(root, 'session.bin') }, { safeStorage, openExternal: async () => {}, onChange: () => { if (window) notify(); } });
const cloud = new CloudSyncManager({ cloudDir: path.join(root, 'cloud') }, { auth, history, workspace: manager });
const state = () => ({ phase: 'ready', project: activeProject, openProjects: manager.listOpenProjects(), projectsDir: manager.projectsDir, auth: auth.status() });
const notify = () => window.webContents.send('latex:state-changed', state());
shell.openPath = async (location) => { revealed.push(location); return ''; };
dialog.showOpenDialog = async () => { choosingCount += 1; return { canceled: true, filePaths: [] }; };
let restoreAnswer = 0;
dialog.showMessageBox = async () => ({ response: restoreAnswer });
registerFeatureIpc({ ipcMain, dialog, workspace: manager, history, auth, cloud,
  openProject: async (location) => { activeProject = manager.openProject(location); notify(); }
});

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
  const page = window && !window.isDestroyed() ? await evaluate(() => ({
    width: window.innerWidth,
    tabs: document.querySelectorAll('.project-tab').length,
    accountFeedback: document.querySelector('#account-feedback')?.textContent,
    shareFeedback: document.querySelector('#share-feedback')?.textContent
  })) : null;
  throw new Error(`Timed out: ${message}; page=${JSON.stringify(page)}`);
}
const waitForPage = (predicate, message) => waitFor(() => evaluate(predicate), message);
async function capture(name) {
  if (!process.env.LATEX_EDITOR_UI_SCREENSHOTS) return;
  const directory = path.resolve(process.env.LATEX_EDITOR_UI_SCREENSHOTS);
  fs.mkdirSync(directory, { recursive: true });
  await evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const image = await window.webContents.capturePage();
  fs.writeFileSync(path.join(directory, `${name}.png`), image.toPNG());
}

async function run() {
  window = new BrowserWindow({
    show: false, width: 1100, height: 820,
    webPreferences: {
      preload: path.resolve(__dirname, '../src/preload/preload.js'),
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      offscreen: true, backgroundThrottling: false
    }
  });
  window.webContents.on('console-message', (details) => {
    if (details.level === 'error') errors.push(details.message);
  });
  await window.loadFile(path.resolve(__dirname, '../src/renderer/index.html'));
  await waitForPage(() => !document.querySelector('#new-project').disabled, 'shell ready');
  assert.equal(await evaluate(() => document.querySelector('#empty-workspace').hidden), false);

  await click('#welcome-new');
  await waitForPage(() => document.querySelectorAll('input[name="project-template"]').length === 7, 'template choices');
  await waitForPage(() => {
    const previews = [...document.querySelectorAll('.template-preview img')];
    return previews.length === 7 && previews.every((image) => image.complete && image.naturalWidth > 0 && image.naturalHeight > 0);
  }, 'template preview images');
  assert.equal(await evaluate(() => document.querySelector('.template-preview').getBoundingClientRect().height >= 180), true, 'regular template cards should show a large preview');
  assert.equal(await evaluate(() => [...document.querySelectorAll('.template-preview img')].every((image) => image.alt.startsWith('Xem trước mẫu '))), true);
  assert.equal(overlayOpen, true);
  await capture('new-project');
  await evaluate(() => {
    const search = document.querySelector('#template-search');
    search.value = 'luan van';
    search.dispatchEvent(new Event('input'));
  });
  assert.equal(await evaluate(() => document.querySelectorAll('.template-option:not([hidden])').length), 1);
  assert.equal(await evaluate(() => document.querySelector('input[name="project-template"]:checked').value), 'thesis-vi');
  assert.match(await evaluate(() => document.querySelector('#template-note').textContent), /XeLaTeX/);
  await evaluate(() => {
    const search = document.querySelector('#template-search');
    search.value = 'no-such-template';
    search.dispatchEvent(new Event('input'));
  });
  assert.equal(await evaluate(() => document.querySelector('#template-empty').hidden), false);
  assert.equal(await evaluate(() => document.querySelector('#create-confirm').disabled), true);
  await evaluate(() => {
    const search = document.querySelector('#template-search');
    search.value = '';
    search.dispatchEvent(new Event('input'));
    const category = document.querySelector('#template-category');
    category.value = 'Hồ sơ';
    category.dispatchEvent(new Event('change'));
  });
  assert.equal(await evaluate(() => document.querySelector('input[name="project-template"]:checked').value), 'cv-vi');
  await evaluate(() => {
    const category = document.querySelector('#template-category');
    category.value = '';
    category.dispatchEvent(new Event('change'));
  });
  await evaluate(() => {
    document.querySelector('#new-project-name').value = 'Báo cáo thử nghiệm';
    document.querySelector('input[value="report"]').checked = true;
    document.querySelector('#new-project-form').requestSubmit();
  });
  await waitForPage(() => !document.querySelector('#new-dialog').open && document.querySelectorAll('.project-tab').length === 1, 'create report');
  await waitFor(() => !overlayOpen, 'restore editor');
  const report = activeProject;
  assert.equal(fs.existsSync(path.join(report.path, 'chapters', 'introduction.tex')), true);

  const originalTex = fs.readFileSync(path.join(report.path, 'main.tex'), 'utf8');
  await click('#history-button');
  await waitForPage(() => document.querySelector('#history-dialog').open && !document.querySelector('#history-save').disabled, 'history dialog ready');
  await evaluate(() => {
    document.querySelector('#history-message').value = 'Bản đầu';
    document.querySelector('#history-save-form').requestSubmit();
  });
  await waitForPage(() => document.querySelectorAll('.history-entry').length === 1 && !document.querySelector('#history-save').disabled, 'first snapshot');
  fs.writeFileSync(path.join(report.path, 'main.tex'), originalTex + '\n% Second version\n');
  await evaluate(() => {
    document.querySelector('#history-message').value = 'Bổ sung chương';
    document.querySelector('#history-save-form').requestSubmit();
  });
  await waitForPage(() => document.querySelectorAll('.history-entry').length === 2 && !document.querySelector('#history-save').disabled, 'second snapshot');
  await click('.history-entry:first-child');
  await waitForPage(() => document.querySelector('#history-diff').textContent.includes('+% Second version'), 'rendered Git diff');
  await capture('history');
  await click('.history-entry:last-child');
  await waitForPage(() => !document.querySelector('#history-restore').disabled, 'selected old version');
  await click('#history-restore');
  await waitForPage(() => document.querySelector('#history-feedback').textContent.includes('Đã hủy'), 'cancel restoration');
  assert.equal(fs.readFileSync(path.join(report.path, 'main.tex'), 'utf8'), originalTex + '\n% Second version\n');
  restoreAnswer = 1;
  await click('#history-restore');
  await waitForPage(() => document.querySelector('#history-feedback').textContent.includes('Đã khôi phục'), 'restore with backup');
  assert.equal(fs.readFileSync(path.join(report.path, 'main.tex'), 'utf8'), originalTex);
  assert.equal((await history.list(report.path)).length, 4);
  await click('#history-close');
  await waitFor(() => !overlayOpen, 'restore editor after history');
  await click('#account-button');
  await waitForPage(() => document.querySelector('#account-description').textContent.includes('chưa được thiết lập'), 'unconfigured cloud state');
  assert.equal(await evaluate(() => document.querySelector('#google-login').disabled), true);
  await capture('account-local');
  await click('#account-close');
  await waitFor(() => !overlayOpen, 'restore editor after account');

  // Use the real Worker routes and an in-memory R2 binding. Only Google's
  // external identity endpoints are fixtures; no production cloud is contacted.
  const { handleRequest } = await import('../../latex-editor-cloud/src/index.js');
  const { environment, signedIn } = await import('../../latex-editor-cloud/test/support.js');
  const cloudEnvironment = environment();
  const google = async (url) => Response.json(url.includes('/token')
    ? { access_token: 'test-google-access' }
    : { sub: 'ui-user', name: 'UI Test User', email: 'ui@example.test', email_verified: true });
  auth.apiUrl = cloudEnvironment.PUBLIC_BASE_URL;
  auth.fetch = (url, options) => handleRequest(new Request(url, options), cloudEnvironment, google);
  auth.openExternal = async (target) => {
    const start = await handleRequest(new Request(target), cloudEnvironment, google);
    const googleUrl = new URL(start.headers.get('Location'));
    const callback = new URL(auth.apiUrl + '/auth/google/callback');
    callback.search = new URLSearchParams({ state: googleUrl.searchParams.get('state'), code: 'test-google-code' }).toString();
    const redirect = await handleRequest(new Request(callback), cloudEnvironment, google);
    await fetch(redirect.headers.get('Location')); // The app's loopback callback.
  };
  notify();
  await click('#account-button');
  await waitForPage(() => !document.querySelector('#google-login').disabled, 'Google login enabled');
  await click('#google-login');
  await waitForPage(() => document.querySelector('#account-feedback').textContent.includes('Đăng nhập thành công'), 'Google login through Worker');
  assert.equal(auth.status().user.email, 'ui@example.test');
  await click('#cloud-upload');
  await waitForPage(() => document.querySelectorAll('.cloud-project').length === 1 && document.querySelector('#account-feedback').textContent.includes('đồng bộ'), 'upload history to cloud');
  await capture('account-cloud');

  // Exercise the actual sharing dialog with a second account against the
  // in-memory Worker/D1/R2 environment.
  await click('#account-close');
  await waitFor(() => !overlayOpen, 'restore editor before sharing');
  await click('#share-button');
  await waitForPage(() => document.querySelector('#share-dialog').open
    && document.querySelector('#share-my-role').textContent.includes('Chủ sở hữu')
    && document.querySelectorAll('#share-members-list .member-item').length === 1, 'owner sharing dialog');
  await evaluate(() => {
    document.querySelector('#share-invite-email').value = 'invitee@example.test';
    document.querySelector('#share-email-form').requestSubmit();
  });
  await waitForPage(() => document.querySelectorAll('#share-pending-list .pending-item').length === 1, 'email invitation in sharing UI');
  const invitationId = cloudEnvironment.DB.tables.invitations.find((item) => item.email === 'invitee@example.test').id;
  const invitee = (await signedIn(handleRequest, cloudEnvironment, 'invitee')).session;
  const accepted = await handleRequest(new Request(`${cloudEnvironment.PUBLIC_BASE_URL}/v1/invitations/${invitationId}/accept`, {
    method: 'POST', headers: { Authorization: `Bearer ${invitee.token}` }
  }), cloudEnvironment);
  assert.equal(accepted.status, 200);
  await click('#share-refresh');
  await waitForPage(() => document.querySelectorAll('#share-members-list .member-item').length === 2
    && document.querySelectorAll('#share-pending-list .pending-item').length === 0, 'accepted member in sharing UI');
  await click('#share-members-list .member-item:last-child .btn-danger');
  await waitForPage(() => document.querySelectorAll('#share-members-list .member-item').length === 1, 'remove member in sharing UI');
  await click('#share-create-link');
  await waitForPage(() => document.querySelector('#share-link-input').value.includes(':'), 'secure link invitation code');
  assert.match(await evaluate(() => document.querySelector('#share-link-input').value), /^[a-f0-9-]{36}:[A-Za-z0-9_-]{43}$/);
  await click('#share-pending-list .pending-item .btn-danger');
  await waitForPage(() => document.querySelectorAll('#share-pending-list .pending-item').length === 0, 'revoke link invitation in sharing UI');
  await capture('sharing-team');
  await click('#share-close');
  await waitFor(() => !overlayOpen, 'restore editor after sharing');
  await evaluate(() => document.querySelectorAll('.cloud-project').forEach((row) => { row.dataset.stale = 'true'; }));
  await click('#account-button');
  await waitForPage(() => document.querySelector('#account-dialog').open
    && document.querySelectorAll('.cloud-project:not([data-stale])').length === 1
    && !document.querySelector('#cloud-refresh').disabled, 'reopen account after sharing');

  await click('.cloud-project button');
  await waitForPage(() => document.querySelector('#account-feedback').textContent.includes('Đã tải'), 'download cloud project');
  const cloudCopy = activeProject;
  assert.notEqual(cloudCopy.path, report.path);
  assert.equal((await history.list(cloudCopy.path)).length, 4);
  assert.equal(fs.readFileSync(path.join(cloudCopy.path, 'main.tex'), 'utf8'), originalTex);
  await click('#account-logout');
  await waitForPage(() => document.querySelector('#account-feedback').textContent.includes('Đã đăng xuất'), 'logout');
  assert.equal(auth.status().signedIn, false);
  assert.equal(fs.existsSync(auth.sessionFile), false);
  assert.equal(fs.existsSync(path.join(cloudCopy.path, 'main.tex')), true);
  await click('#account-close');
  manager.closeProject(cloudCopy.path);
  manager.forgetProject(cloudCopy.path);
  activeProject = manager.openProject(report.path);
  notify();
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
  await waitForPage(() => document.querySelector('#new-dialog').open && document.querySelectorAll('.template-option').length === 7, 'repeat new project');
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
  // Windows display scaling can round the offscreen viewport by one CSS pixel.
  await waitForPage(() => Math.abs(window.innerWidth - 960) <= 2 && document.querySelectorAll('.project-tab').length === 7, 'compact toolbar');
  await click('#new-project');
  await waitForPage(() => document.querySelector('#new-dialog').open && document.querySelectorAll('.template-option').length === 7, 'compact template library');
  assert.equal(await evaluate(() => {
    const dialog = document.querySelector('#new-dialog');
    const rect = dialog.getBoundingClientRect();
    const button = document.querySelector('#create-confirm').getBoundingClientRect();
    const cards = document.querySelector('#template-options').getBoundingClientRect();
    const note = document.querySelector('#template-note').getBoundingClientRect();
    const preview = document.querySelector('.template-preview').getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= window.innerHeight && dialog.scrollWidth <= dialog.clientWidth && button.bottom <= rect.bottom && cards.bottom <= note.top && preview.width >= 100 && preview.height >= 90;
  }), true, 'template library must fit a small window');
  await capture('templates-small-window');
  await click('#create-cancel');
  await waitFor(() => !overlayOpen, 'close compact templates');
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
  console.log('PASS: projects, templates, history, diff, Google login, cloud history, team sharing UI, logout, compact layout.');
}

const timeout = setTimeout(() => { console.error('UI test timeout'); app.exit(1); }, 60000);
app.whenReady().then(run).then(() => finish(0), (error) => { console.error(error); finish(1); });
async function finish(code) {
  clearTimeout(timeout);
  if (window && !window.isDestroyed()) window.destroy();
  window = null;
  auth.dispose();
  // Electron may still hold its cache files; remove only our project fixtures.
  for (const fixture of [manager.projectsDir, manager.settingsFile, history.root]) {
    try { await fs.promises.rm(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
    catch (error) { console.warn(`Temporary fixture cleanup deferred: ${error.message}`); }
  }
  app.exit(code);
}
