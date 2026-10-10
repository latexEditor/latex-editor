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
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  emit(type, event = {}) { this.listeners.get(type)?.(event); }
  close(code, reason) { this.closed = { code, reason }; }
}

function fixture(metadata = { id: '11111111-1111-4111-8111-111111111111', apiUrl: 'https://cloud.example.test' }) {
  const changes = [];
  const auth = {
    apiUrl: 'https://cloud.example.test',
    status: () => ({ signedIn: true }),
    webSocketProtocols: () => ['latex-editor-v1', `latex-editor-auth.${'t'.repeat(43)}`]
  };
  const cloud = { readMetadata: async () => metadata };
  const manager = new CollaborationManager({ auth, cloud, onChange: (state) => changes.push(state), WebSocketImpl: FakeWebSocket });
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
  assert.equal(manager.status().enabled, true);
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
