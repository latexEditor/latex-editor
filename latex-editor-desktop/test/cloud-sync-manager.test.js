const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { WorkspaceManager } = require('../src/main/WorkspaceManager');
const { HistoryManager } = require('../src/main/HistoryManager');
const { CloudSyncManager } = require('../src/main/CloudSyncManager');

async function fixture(t) {
  const { handleRequest } = await import('../../latex-editor-cloud/src/index.js');
  const { environment, signedIn } = await import('../../latex-editor-cloud/test/support.js');
  const env = environment();
  const { session } = await signedIn(handleRequest, env);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'latex-cloud-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = new WorkspaceManager({ projectsDir: path.join(root, 'projects'), settingsFile: path.join(root, 'settings.json'), templateDir: path.resolve(__dirname, '../resources/templates/basic-article') });
  const project = workspace.createProject('Cloud test', 'blank');
  const history = new HistoryManager({ historyDir: path.join(root, 'history') });
  const auth = {
    generation: 0, apiUrl: env.PUBLIC_BASE_URL, user: session.user,
    status() { return { signedIn: true, user: this.user }; },
    async request(route, options = {}) {
      const response = await handleRequest(new Request(env.PUBLIC_BASE_URL + route, { ...options, headers: { ...options.headers, Authorization: `Bearer ${session.token}` } }), env);
      if (!response.ok) { const error = new Error((await response.json()).error); error.status = response.status; throw error; }
      return response;
    }
  };
  const cloud = new CloudSyncManager({ cloudDir: path.join(root, 'cloud') }, { auth, history, workspace });
  return { project, cloud, history, auth };
}

test('desktop-to-worker roundtrip restores real project files and complete Git history', async (t) => {
  const { project, cloud, history } = await fixture(t);
  await history.save(project.path, 'Initial version');
  await fs.writeFile(path.join(project.path, 'main.tex'), 'Updated source');
  const uploaded = await cloud.upload(project.path);
  assert.equal(uploaded.status, 'synced');
  assert.equal((await cloud.list()).length, 1);
  const copy = await cloud.download(uploaded.project.id);
  assert.notEqual(copy.path, project.path);
  assert.equal(await fs.readFile(path.join(copy.path, 'main.tex'), 'utf8'), 'Updated source');
  assert.equal((await history.list(copy.path)).length, 2);
  assert.equal((await cloud.upload(copy.path)).status, 'synced');
});

test('two-device conflict preserves both local work and the remote version', async (t) => {
  const { project, cloud } = await fixture(t);
  const first = await cloud.upload(project.path);
  const secondDevice = await cloud.download(first.project.id);
  await fs.writeFile(path.join(project.path, 'main.tex'), 'Machine one change');
  const updated = await cloud.upload(project.path);
  await fs.writeFile(path.join(secondDevice.path, 'main.tex'), 'Machine two change');
  await assert.rejects(cloud.upload(secondDevice.path), /Xung đột/);
  assert.equal(await fs.readFile(path.join(secondDevice.path, 'main.tex'), 'utf8'), 'Machine two change');
  assert.equal((await cloud.list())[0].head, updated.project.head);
});

test('switching accounts does not reassign a local project to another cloud account', async (t) => {
  const { project, cloud, auth } = await fixture(t);
  await cloud.upload(project.path);
  auth.generation += 1;
  auth.user = { id: 'google-other', name: 'Other account' };
  await assert.rejects(cloud.upload(project.path), /tài khoản hoặc dịch vụ cloud khác/);
});

test('session changes during listing cannot expose results under another account', async (t) => {
  const { cloud, auth } = await fixture(t);
  const original = auth.request.bind(auth);
  auth.request = async (...args) => { const response = await original(...args); auth.generation += 1; return response; };
  await assert.rejects(cloud.list(), /Phiên đăng nhập đã thay đổi/);
});
