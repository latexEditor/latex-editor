const test = require('node:test');
const assert = require('node:assert/strict');
const { CollaborationManager } = require('../src/main/CollaborationManager');

class FakeWebSocket {
  static instances = [];
  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.listeners = new Map();
    this.closed = null;
    this.readyState = 0;
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  emit(type, event = {}) { if (type === 'open') this.readyState = 1; this.listeners.get(type)?.(event); }
  send(message) { this.sent.push(JSON.parse(message)); }
  close(code, reason) { this.closed = { code, reason }; }
}

function fixture(metadata = { id: '11111111-1111-4111-8111-111111111111', apiUrl: 'https://cloud.example.test' }, overrides = {}) {
  const changes = [];
  const auth = {
    apiUrl: 'https://cloud.example.test',
    status: () => ({ signedIn: true }),
    webSocketProtocols: () => ['latex-editor-v1', `latex-editor-auth.${'t'.repeat(43)}`]
  };
  const cloud = { readMetadata: async () => metadata };
  const manager = new CollaborationManager({
    auth, cloud, onChange: (state) => changes.push(state), WebSocketImpl: FakeWebSocket, ...overrides
  });
  return { manager, changes };
}

test('desktop collaboration connects with a token subprotocol and renders presence', async () => {
  FakeWebSocket.instances = [];
  const { manager } = fixture();
  await manager.open('D:\\project');
  const socket = FakeWebSocket.instances[0];
  assert.equal(socket.url, 'wss://cloud.example.test/v1/projects/11111111-1111-4111-8111-111111111111/collaboration');
  assert.equal(socket.protocols[0], 'latex-editor-v1');
  assert.match(socket.protocols[1], /^latex-editor-auth\./);
  assert.equal(manager.status().connection, 'connecting');
  assert.equal(manager.status().enabled, true);

  socket.emit('open');
  socket.emit('message', { data: JSON.stringify({ type: 'welcome', participants: [{ id: 'u1', name: 'One', role: 'owner' }] }) });
  assert.equal(manager.status().connection, 'online');
  assert.equal(manager.status().participants[0].name, 'One');

  socket.emit('close', { code: 4003 });
  assert.equal(manager.status().connection, 'revoked');
  assert.equal(manager.status().enabled, false);
  assert.match(manager.status().error, /thu hồi/);
});

test('desktop collaboration stays offline for local projects and ignores stale sockets', async () => {
  FakeWebSocket.instances = [];
  const local = fixture(null).manager;
  await local.open('D:\\local');
  assert.equal(FakeWebSocket.instances.length, 0);
  assert.equal(local.status().connection, 'offline');
  assert.equal(local.status().enabled, false);

  const { manager } = fixture();
  await manager.open('D:\\cloud');
  const stale = FakeWebSocket.instances[0];
  manager.close();
  stale.emit('open');
  assert.equal(manager.status().connection, 'offline');
  assert.deepEqual(stale.closed, { code: 1000, reason: 'Project closed' });
});

test('desktop collaboration converts editor text into Yjs updates and applies remote merges', async () => {
  FakeWebSocket.instances = [];
  const editorEvents = [];
  const base = fixture();
  base.manager.onEditorMessage = (message) => editorEvents.push(message);
  await base.manager.open('D:\\cloud');
  const socket = FakeWebSocket.instances[0];
  socket.emit('open');
  socket.emit('message', { data: JSON.stringify({ type: 'welcome', self: { id: 'u1', role: 'owner' }, participants: [] }) });

  assert.equal(base.manager.handleEditorMessage({ type: 'document:open', path: 'main.tex', text: 'Hello' }), true);
  assert.equal(socket.sent.at(-1).type, 'document:subscribe');
  socket.emit('message', { data: JSON.stringify({ type: 'document:state', path: 'main.tex', update: null }) });
  assert.equal(socket.sent.at(-1).type, 'document:seed');

  base.manager.handleEditorMessage({ type: 'document:change', path: 'main.tex', text: 'Hello world' });
  assert.equal(socket.sent.at(-1).type, 'document:update');
  assert.equal(editorEvents.at(-1).text, 'Hello');
});

test('viewer edits are reverted to the shared Yjs content', async () => {
  FakeWebSocket.instances = [];
  const editorEvents = [];
  const base = fixture();
  base.manager.onEditorMessage = (message) => editorEvents.push(message);
  await base.manager.open('D:\\cloud');
  const socket = FakeWebSocket.instances[0];
  socket.emit('open');
  socket.emit('message', { data: JSON.stringify({ type: 'welcome', self: { id: 'viewer', role: 'viewer' }, participants: [] }) });
  base.manager.handleEditorMessage({ type: 'document:open', path: 'main.tex', text: 'Local' });
  socket.emit('message', { data: JSON.stringify({ type: 'document:state', path: 'main.tex', update: null }) });
  assert.equal(base.manager.handleEditorMessage({ type: 'document:change', path: 'main.tex', text: 'Forbidden' }), false);
  assert.deepEqual(editorEvents.at(-1), { type: 'document:remote', path: 'main.tex', text: '' });
});

test('cursor selections are validated, sent and forwarded to the editor bridge', async () => {
  FakeWebSocket.instances = [];
  const editorEvents = [];
  const { manager } = fixture(undefined, { onEditorMessage: (message) => editorEvents.push(message) });
  await manager.open('D:\\cloud');
  const socket = FakeWebSocket.instances[0];
  socket.emit('open');
  socket.emit('message', { data: JSON.stringify({ type: 'welcome', self: { id: 'self', role: 'editor' }, participants: [] }) });
  assert.equal(manager.handleEditorMessage({ type: 'cursor:update', path: 'main.tex', selections: [{ anchor: 2, active: 8 }] }), true);
  assert.deepEqual(socket.sent.at(-1), { type: 'cursor:update', path: 'main.tex', selections: [{ anchor: 2, active: 8 }] });
  assert.equal(manager.handleEditorMessage({ type: 'cursor:update', path: '../bad.tex', selections: [] }), false);

  socket.emit('message', { data: JSON.stringify({
    type: 'cursor:update', path: 'main.tex', selections: [{ anchor: 1, active: 3 }],
    user: { id: 'other', name: 'Other', role: 'owner' }
  }) });
  assert.equal(editorEvents.at(-1).type, 'cursor:remote');
  assert.equal(editorEvents.at(-1).user.id, 'other');
});

test('unexpected disconnect reconnects with exponential backoff and rescans documents', async () => {
  FakeWebSocket.instances = [];
  const editorEvents = [];
  const { manager } = fixture(undefined, {
    onEditorMessage: (message) => editorEvents.push(message), reconnectBaseMs: 1
  });
  await manager.open('D:\\cloud');
  const first = FakeWebSocket.instances[0];
  first.emit('open');
  first.emit('close', { code: 1006 });
  assert.equal(manager.status().connection, 'reconnecting');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(FakeWebSocket.instances.length, 2);
  const second = FakeWebSocket.instances[1];
  second.emit('open');
  second.emit('message', { data: JSON.stringify({ type: 'welcome', self: { id: 'self', role: 'editor' }, participants: [] }) });
  assert.equal(manager.status().connection, 'online');
  assert.equal(editorEvents.some((event) => event.type === 'documents:rescan'), true);
  manager.close();
});

test('filesystem manifest and file operations are relayed with viewer protection', async () => {
  FakeWebSocket.instances = [];
  const editorEvents = [];
  const { manager } = fixture(undefined, { onEditorMessage: (message) => editorEvents.push(message) });
  await manager.open('D:\\cloud');
  const socket = FakeWebSocket.instances[0];
  socket.emit('open');
  socket.emit('message', { data: JSON.stringify({
    type: 'welcome', self: { id: 'self', role: 'editor' }, participants: []
  }) });

  assert.equal(manager.handleEditorMessage({ type: 'filesystem:snapshot', paths: ['main.tex', 'chapters/one.tex'] }), true);
  assert.deepEqual(socket.sent.at(-1), { type: 'manifest:subscribe', paths: ['main.tex', 'chapters/one.tex'] });
  assert.equal(manager.handleEditorMessage({ type: 'file:create', path: 'notes.tex', operationId: 'operation-create-1' }), true);
  assert.equal(manager.handleEditorMessage({
    type: 'file:rename', oldPath: 'notes.tex', newPath: 'notes-new.tex', operationId: 'operation-rename-1'
  }), true);
  assert.equal(manager.handleEditorMessage({ type: 'file:delete', path: 'notes-new.tex', operationId: 'operation-delete-1' }), true);
  assert.equal(manager.handleEditorMessage({ type: 'file:delete', path: '../outside.tex', operationId: 'operation-delete-2' }), false);
  assert.equal(manager.handleEditorMessage({ type: 'file:create', path: 'missing-id.tex' }), false);

  socket.emit('message', { data: JSON.stringify({
    type: 'filesystem:state', revision: 3,
    entries: [{ path: 'main.tex', deleted: false }, { path: 'old.tex', deleted: true }]
  }) });
  socket.emit('message', { data: JSON.stringify({ type: 'file:create', path: 'remote.tex', revision: 4 }) });
  socket.emit('message', { data: JSON.stringify({ type: 'file:rename', oldPath: 'remote.tex', newPath: 'renamed.tex', revision: 5 }) });
  socket.emit('message', { data: JSON.stringify({ type: 'file:delete', path: 'renamed.tex', revision: 6 }) });
  assert.deepEqual(editorEvents.slice(-4).map((event) => event.type), [
    'filesystem:state', 'file:create', 'file:rename', 'file:delete'
  ]);
  socket.emit('message', { data: JSON.stringify({
    type: 'file:ack', operationId: 'operation-delete-1', accepted: true, revision: 6
  }) });
  assert.deepEqual(editorEvents.at(-1), {
    type: 'file:ack', operationId: 'operation-delete-1', accepted: true, code: null, revision: 6
  });

  socket.emit('message', { data: JSON.stringify({
    type: 'welcome', self: { id: 'viewer', role: 'viewer' }, participants: []
  }) });
  assert.equal(manager.handleEditorMessage({ type: 'file:create', path: 'blocked.tex', operationId: 'operation-blocked-1' }), false);
  manager.close();
});

test('restoring a snapshot replaces the manifest and waits for every draft ACK', async () => {
  FakeWebSocket.instances = [];
  const editorEvents = [];
  const { manager } = fixture(undefined, { onEditorMessage: (message) => editorEvents.push(message) });
  await manager.open('D:\\cloud');
  const socket = FakeWebSocket.instances[0];
  socket.emit('open');
  socket.emit('message', { data: JSON.stringify({
    type: 'welcome', self: { id: 'self', role: 'editor' }, participants: [{ id: 'self', role: 'editor' }]
  }) });

  const resetPromise = manager.resetDrafts('D:\\cloud');
  const requestId = editorEvents.at(-1).requestId;
  assert.equal(editorEvents.at(-1).type, 'draft:reset-request');
  manager.handleEditorMessage({ type: 'draft:reset:begin', requestId, paths: ['main.tex', 'chapter.tex'] });
  manager.handleEditorMessage({ type: 'draft:reset:document', requestId, path: 'main.tex', text: 'Restored main' });
  manager.handleEditorMessage({ type: 'draft:reset:document', requestId, path: 'chapter.tex', text: 'Restored chapter' });
  manager.handleEditorMessage({ type: 'draft:reset:end', requestId, count: 2 });
  assert.deepEqual(socket.sent.slice(-3).map((message) => message.type), [
    'filesystem:reset', 'document:reset', 'document:reset'
  ]);

  socket.emit('message', { data: JSON.stringify({ type: 'filesystem:reset:ack', requestId, revision: 8 }) });
  socket.emit('message', { data: JSON.stringify({ type: 'document:reset:ack', requestId, path: 'main.tex' }) });
  let settled = false;
  resetPromise.then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  socket.emit('message', { data: JSON.stringify({ type: 'document:reset:ack', requestId, path: 'chapter.tex' }) });
  assert.deepEqual(await resetPromise, { reset: true, documents: 2 });
  manager.close();
});

test('jumpToParticipant publishes cursor:jump event with tracked cursor info', async () => {
  FakeWebSocket.instances = [];
  const editorEvents = [];
  const { manager } = fixture(undefined, { onEditorMessage: (message) => editorEvents.push(message) });
  await manager.open('D:\\cloud');
  const socket = FakeWebSocket.instances[0];
  socket.emit('open');

  socket.emit('message', { data: JSON.stringify({
    type: 'cursor:update',
    path: 'chapters/intro.tex',
    selections: [{ anchor: 10, active: 15 }],
    user: { id: 'user-b', name: 'User B' }
  }) });

  assert.equal(editorEvents.at(-1).type, 'cursor:remote');

  manager.jumpToParticipant('user-b');
  assert.equal(editorEvents.at(-1).type, 'cursor:jump');
  assert.equal(editorEvents.at(-1).userId, 'user-b');
  assert.equal(editorEvents.at(-1).cursor.path, 'chapters/intro.tex');
  assert.deepEqual(editorEvents.at(-1).cursor.selections, [{ anchor: 10, active: 15 }]);
  manager.close();
});
