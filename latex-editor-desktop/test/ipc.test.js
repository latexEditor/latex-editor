const test = require('node:test');
const assert = require('node:assert/strict');
const { registerIpc } = require('../src/main/ipc');

function setup({ signedIn = true, uploadError = null } = {}) {
  const handlers = new Map();
  const calls = [];
  const project = { name: 'Cloud first', path: 'D:\\projects\\Cloud first', exists: true };
  registerIpc({
    ipcMain: {
      removeHandler: () => {},
      handle: (channel, handler) => handlers.set(channel, handler)
    },
    dialog: {},
    workspaceManager: {
      createProject: () => { calls.push('create'); return project; },
      listRecent: () => [], listTemplates: () => [], forgetProject: () => [],
      getProjectLocation: (value) => value, openProject: () => project
    },
    runtimeManager: { getStatus: () => ({}) },
    auth: { status: () => ({ signedIn }) },
    cloud: {
      upload: async () => {
        calls.push('upload');
        if (uploadError) throw uploadError;
        return { status: 'synced', project: { id: 'cloud-id' } };
      }
    },
    openProject: async () => { calls.push('open'); },
    closeProject: () => {}, hideEditor: () => {}, showEditor: () => {}, getState: () => ({})
  });
  return { create: handlers.get('latex:create-project'), calls };
}

test('new projects require sign-in before creating local files', async () => {
  const { create, calls } = setup({ signedIn: false });
  await assert.rejects(create({}, 'Cloud first', 'basic-article'), /đăng nhập/i);
  assert.deepEqual(calls, []);
});

test('new projects upload to cloud before opening in the editor', async () => {
  const { create, calls } = setup();
  const result = await create({}, 'Cloud first', 'basic-article');
  assert.deepEqual(calls, ['create', 'upload', 'open']);
  assert.equal(result.cloudProject.id, 'cloud-id');
  assert.equal(result.cloudWarning, null);
});

test('cloud failure keeps and opens the recoverable local project', async () => {
  const { create, calls } = setup({ uploadError: new Error('R2 unavailable') });
  const result = await create({}, 'Cloud first', 'basic-article');
  assert.deepEqual(calls, ['create', 'upload', 'open']);
  assert.match(result.cloudWarning, /R2 unavailable/);
  assert.equal(result.exists, true);
});
