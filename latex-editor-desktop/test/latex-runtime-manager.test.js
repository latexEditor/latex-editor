const assert = require('node:assert/strict');
const test = require('node:test');
const { LatexRuntimeManager } = require('../src/main/LatexRuntimeManager');

test('recognizes MiKTeX and a usable build tool', () => {
  const manager = new LatexRuntimeManager({
    platform: 'win32',
    spawnSync: (command, [argument]) => {
      if (command === 'where.exe' && argument === 'latexmk.exe') {
        return { status: 0, stdout: 'C:\\Program Files\\MiKTeX\\miktex\\bin\\x64\\latexmk.exe\r\n' };
      }
      if (command.endsWith('latexmk.exe') && argument === '--version') return { status: 0, stdout: 'Latexmk' };
      return { status: 1, stdout: '' };
    },
    fs: { existsSync: () => false }, env: {}
  });
  const status = manager.getStatus();
  assert.equal(status.canBuild, true);
  assert.equal(status.distribution, 'MiKTeX');
});

test('marks latexmk unusable without Perl and falls back to pdflatex', () => {
  const manager = new LatexRuntimeManager({
    platform: 'win32',
    spawnSync: (command, [argument]) => {
      if (command === 'where.exe' && argument === 'latexmk.exe') {
        return { status: 0, stdout: 'C:\\MiKTeX\\latexmk.exe\r\n' };
      }
      if (command === 'where.exe' && argument === 'pdflatex.exe') {
        return { status: 0, stdout: 'C:\\MiKTeX\\pdflatex.exe\r\n' };
      }
      if (command.endsWith('latexmk.exe')) {
        return { status: 1, stdout: '', stderr: "could not find script engine 'perl'" };
      }
      return { status: 1, stdout: '' };
    },
    fs: { existsSync: () => false }, env: {}
  });
  const status = manager.getStatus();
  const latexmk = status.tools.find((tool) => tool.name === 'latexmk');
  assert.equal(status.canBuild, true);
  assert.equal(latexmk.available, true);
  assert.equal(latexmk.usable, false);
  assert.match(latexmk.reason, /Perl/);
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
