const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { registerFeatureIpc } = require('../src/main/featureIpc');

function setup(upload, options = {}) {
  const handlers = new Map();
  const frame = {};
  const shellUrl = pathToFileURL(path.resolve(__dirname, '../src/renderer/index.html')).toString();
  const event = { sender: { getURL: () => shellUrl, mainFrame: frame }, senderFrame: frame };
  registerFeatureIpc({
    ipcMain: { removeHandler: () => {}, handle: (channel, handler) => handlers.set(channel, handler) },
    dialog: options.dialog || {},
    workspace: { getProjectLocation: (value) => value },
    history: {
      save: async () => ({ hash: 'a'.repeat(40), unchanged: false }),
      restore: options.restore || (async () => ({ hash: 'b'.repeat(40), backup: 'c'.repeat(40) }))
    },
    auth: { status: () => ({ signedIn: true, user: { id: 'owner', email: 'owner@example.test' } }) },
    cloud: { upload },
    collaboration: options.collaboration,
    openProject: async () => {}
  });
  return {
    save: (...args) => handlers.get('latex:history-save')(event, ...args),
    restore: (...args) => handlers.get('latex:history-restore')(event, ...args)
  };
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

test('restoring history resets the live draft before uploading the restored snapshot', async () => {
  const order = [];
  let dialogOptions;
  const collaboration = {
    resetCapability: () => ({ required: true, ready: true, participants: 2 }),
    resetDrafts: async () => { order.push('draft'); return { reset: true, documents: 2 }; }
  };
  const { restore } = setup(async () => { order.push('upload'); return { status: 'synced', project: { id: 'project-id' } }; }, {
    dialog: { showMessageBox: async (_owner, options) => { dialogOptions = options; return { response: 1 }; } },
    restore: async () => { order.push('restore'); return { hash: 'b'.repeat(40), backup: 'c'.repeat(40) }; },
    collaboration
  });
  const result = await restore('D:\\projects\\paper', 'b'.repeat(40));
  assert.deepEqual(order, ['restore', 'draft', 'upload']);
  assert.equal(result.draftReset, true);
  assert.match(dialogOptions.detail, /2 người đang online/);
  assert.match(dialogOptions.buttons[1], /thay draft/);
});

test('restore is blocked before touching disk when the collaboration room is offline', async () => {
  let restored = false;
  const { restore } = setup(async () => ({}), {
    dialog: { showMessageBox: async () => ({ response: 1 }) },
    restore: async () => { restored = true; return {}; },
    collaboration: {
      resetCapability: () => ({ required: true, ready: false, error: 'Cần kết nối phòng cộng tác.' })
    }
  });
  await assert.rejects(restore('D:\\projects\\paper', 'b'.repeat(40)), /Cần kết nối/);
  assert.equal(restored, false);
});
