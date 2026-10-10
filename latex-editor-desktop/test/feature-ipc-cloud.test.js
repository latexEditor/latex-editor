const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { registerFeatureIpc } = require('../src/main/featureIpc');

function setup(upload) {
  const handlers = new Map();
  const frame = {};
  const shellUrl = pathToFileURL(path.resolve(__dirname, '../src/renderer/index.html')).toString();
  const event = { sender: { getURL: () => shellUrl, mainFrame: frame }, senderFrame: frame };
  registerFeatureIpc({
    ipcMain: { removeHandler: () => {}, handle: (channel, handler) => handlers.set(channel, handler) },
    dialog: {},
    workspace: { getProjectLocation: (value) => value },
    history: { save: async () => ({ hash: 'a'.repeat(40), unchanged: false }) },
    auth: { status: () => ({ signedIn: true, user: { id: 'owner', email: 'owner@example.test' } }) },
    cloud: { upload },
    openProject: async () => {}
  });
  return { save: (...args) => handlers.get('latex:history-save')(event, ...args) };
}

test('saving a version automatically uploads the project bundle to cloud', async () => {
  const uploaded = [];
  const { save } = setup(async (location) => {
    uploaded.push(location);
    return { status: 'synced', project: { id: 'project-id' } };
  });
  const result = await save('D:\\projects\\paper', 'First version');
  assert.deepEqual(uploaded, ['D:\\projects\\paper']);
  assert.equal(result.cloudSynced, true);
  assert.equal(result.cloudProject.id, 'project-id');
});

test('saving locally remains successful when automatic cloud upload fails', async () => {
  const { save } = setup(async () => { throw new Error('R2 unavailable'); });
  const result = await save('D:\\projects\\paper', 'Offline version');
  assert.equal(result.hash, 'a'.repeat(40));
  assert.equal(result.cloudSynced, false);
  assert.match(result.cloudWarning, /R2 unavailable/);
});
