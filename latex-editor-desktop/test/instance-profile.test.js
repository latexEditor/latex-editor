const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { acquireInstanceLock } = require('../src/main/InstanceProfile');

test('custom data directory selects an isolated Electron profile before the singleton lock', () => {
  const calls = [];
  const app = {
    setPath: (...args) => calls.push(['setPath', ...args]),
    requestSingleInstanceLock: () => { calls.push(['lock']); return true; }
  };
  const filesystem = { mkdirSync: (...args) => calls.push(['mkdir', ...args]) };
  assert.equal(acquireInstanceLock(app, 'test-profile', filesystem), true);
  assert.deepEqual(calls, [
    ['mkdir', path.resolve('test-profile', 'electron'), { recursive: true }],
    ['setPath', 'userData', path.resolve('test-profile', 'electron')],
    ['lock']
  ]);
});

test('normal startup preserves the existing Electron profile and duplicate-instance behavior', () => {
  const app = {
    setPath: () => assert.fail('default profile must not be changed'),
    requestSingleInstanceLock: () => false
  };
  assert.equal(acquireInstanceLock(app, undefined), false);
});
