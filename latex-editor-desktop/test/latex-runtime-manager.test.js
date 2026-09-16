const assert = require('node:assert/strict');
const test = require('node:test');
const { LatexRuntimeManager } = require('../src/main/LatexRuntimeManager');

test('recognizes MiKTeX and a usable build tool', () => {
  const manager = new LatexRuntimeManager({
    platform: 'win32',
    spawnSync: (_command, [name]) => name === 'latexmk.exe'
      ? { status: 0, stdout: 'C:\\Program Files\\MiKTeX\\miktex\\bin\\x64\\latexmk.exe\r\n' }
      : { status: 1, stdout: '' },
    fs: { existsSync: () => false }, env: {}
  });
  const status = manager.getStatus();
  assert.equal(status.canBuild, true);
  assert.equal(status.distribution, 'MiKTeX');
});

test('returns installation guidance when compiler is absent', () => {
  const manager = new LatexRuntimeManager({
    platform: 'linux', spawnSync: () => ({ status: 1, stdout: '' }),
    fs: { existsSync: () => false }, env: {}
  });
  const status = manager.getStatus();
  assert.equal(status.available, false);
  assert.match(status.recommendation, /MiKTeX|TeX Live/);
});
