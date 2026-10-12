const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const { CodeServerManager } = require('../src/main/CodeServerManager');

function fakeChild() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.killed = false;
  child.pid = 999999;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => { child.killed = true; };
  return child;
}

function config(t, overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'latex-editor-code-server-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return {
    preferredPort: 18765, readyTimeoutMs: 50, host: '127.0.0.1',
    executable: process.execPath, auth: 'none', appDataDir: dataDir,
    extensionsDir: path.join(dataDir, 'extensions'), ...overrides
  };
}

const quiet = { info() {}, warn() {}, error() {} };

test('uses root readiness endpoint when healthz is unavailable', async (t) => {
  const child = fakeChild();
  const requested = [];
  const manager = new CodeServerManager(config(t), quiet, {
    spawn: () => child,
    fetch: async (url) => {
      requested.push(url);
      return new Response('', { status: url.endsWith('/healthz') ? 404 : 200 });
    }
  });
  await manager.start();
  await manager.waitUntilReady();
  assert.equal(requested.some((url) => url.endsWith('/healthz')), true);
  assert.equal(requested.some((url) => url.endsWith('/')), true);
  child.exitCode = 0;
  child.emit('exit', 0, null);
});

test('reports recent process output when startup fails', async (t) => {
  const child = fakeChild();
  const manager = new CodeServerManager(config(t), quiet, {
    spawn: () => child,
    fetch: async () => { throw new Error('not ready'); }
  });
  await manager.start();
  child.stderr.write('extension directory is not writable\n');
  await new Promise((resolve) => setImmediate(resolve));
  child.exitCode = 1;
  child.emit('exit', 1, null);
  await assert.rejects(() => manager.waitUntilReady(), /extension directory is not writable/);
});

test('registers the bundled collaboration extension and passes only the local bridge credentials', async (t) => {
  const child = fakeChild();
  const extension = fs.mkdtempSync(path.join(os.tmpdir(), 'latex-editor-extension-'));
  t.after(() => fs.rmSync(extension, { recursive: true, force: true }));
  fs.writeFileSync(path.join(extension, 'package.json'), JSON.stringify({ name: 'latex-editor-collaboration' }));
  let spawnOptions;
  const values = config(t, {
    bundledCollaborationExtension: extension,
    collaborationBridgePort: 45678,
    collaborationBridgeToken: 'secret-token'
  });
  const manager = new CodeServerManager(values, quiet, {
    spawn: (_command, _args, options) => { spawnOptions = options; return child; },
    fetch: async () => new Response('', { status: 200 })
  });
  await manager.start();

  const installed = path.join(values.extensionsDir, 'latex-editor.latex-editor-collaboration-0.1.0');
  assert.equal(fs.existsSync(path.join(installed, 'package.json')), true);
  const registry = JSON.parse(fs.readFileSync(path.join(values.extensionsDir, 'extensions.json'), 'utf8'));
  assert.equal(registry.some((entry) => entry.identifier.id === 'latex-editor.latex-editor-collaboration'), true);
  assert.equal(spawnOptions.env.LATEX_EDITOR_BRIDGE_PORT, '45678');
  assert.equal(spawnOptions.env.LATEX_EDITOR_BRIDGE_TOKEN, 'secret-token');
  child.exitCode = 0;
  child.emit('exit', 0, null);
});

test('launches the bundled code-server entry through the tracked Node process', async (t) => {
  const child = fakeChild();
  let spawned;
  const values = config(t, { executableArgs: ['C:\\runtime\\code-server\\entry.js'] });
  const manager = new CodeServerManager(values, quiet, {
    spawn: (command, args) => { spawned = { command, args }; return child; },
    fetch: async () => new Response('', { status: 200 })
  });

  await manager.start();

  assert.equal(spawned.command, process.execPath);
  assert.equal(spawned.args[0], 'C:\\runtime\\code-server\\entry.js');
  assert.equal(spawned.args.includes('--bind-addr'), true);
  child.exitCode = 0;
  child.emit('exit', 0, null);
});
