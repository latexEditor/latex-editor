const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
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

function config(overrides = {}) {
  return {
    preferredPort: 18765, readyTimeoutMs: 50, host: '127.0.0.1',
    executable: process.execPath, auth: 'none', appDataDir: process.cwd(),
    extensionsDir: process.cwd(), ...overrides
  };
}

const quiet = { info() {}, warn() {}, error() {} };

test('uses root readiness endpoint when healthz is unavailable', async () => {
  const child = fakeChild();
  const requested = [];
  const manager = new CodeServerManager(config(), quiet, {
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

test('reports recent process output when startup fails', async () => {
  const child = fakeChild();
  const manager = new CodeServerManager(config(), quiet, {
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
