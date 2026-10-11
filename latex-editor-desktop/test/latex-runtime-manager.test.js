const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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

test('uses the Perl bundled with Git to make MiKTeX latexmk usable', () => {
  const gitPerl = 'C:\\Program Files\\Git\\usr\\bin\\perl.exe';
  const manager = new LatexRuntimeManager({
    platform: 'win32',
    spawnSync: (command, [argument], options = {}) => {
      if (command === 'where.exe' && argument === 'latexmk.exe') {
        return { status: 0, stdout: 'C:\\MiKTeX\\latexmk.exe\r\n' };
      }
      if (command.endsWith('latexmk.exe') && argument === '--version') {
        return options.env.PATH.includes('Git\\usr\\bin')
          ? { status: 0, stdout: 'Latexmk' }
          : { status: 1, stdout: '', stderr: 'perl missing' };
      }
      return { status: 1, stdout: '' };
    },
    fs: { existsSync: (file) => file === gitPerl },
    env: { ProgramFiles: 'C:\\Program Files', PATH: '' }
  });
  const status = manager.getStatus();
  assert.equal(status.tools.find((tool) => tool.name === 'latexmk').usable, true);
  assert.equal(status.pathEntries.includes('C:\\Program Files\\Git\\usr\\bin'), true);
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

test('reuses an in-memory result instead of probing the runtime twice', () => {
  let probes = 0;
  const manager = new LatexRuntimeManager({
    platform: 'linux',
    spawnSync: () => { probes += 1; return { status: 1, stdout: '' }; },
    fs: { existsSync: () => false }, env: {}
  });
  manager.getStatus();
  manager.getStatus();
  assert.equal(probes, 3);
});

test('loads a valid runtime result from the persistent cache on restart', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'latex-runtime-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cacheFile = path.join(root, 'runtime-status.json');
  const executable = path.join(root, 'pdflatex');
  fs.writeFileSync(executable, 'fixture');
  const env = { PATH: root };
  let probes = 0;
  const first = new LatexRuntimeManager({
    cacheFile, platform: 'linux', env,
    spawnSync: (_command, [argument]) => {
      probes += 1;
      return argument === 'pdflatex'
        ? { status: 0, stdout: `${executable}\n` }
        : { status: 1, stdout: '' };
    }
  });
  assert.equal(first.getStatus().canBuild, true);
  const probesAfterFirstScan = probes;
  const restarted = new LatexRuntimeManager({
    cacheFile, platform: 'linux', env,
    spawnSync: () => { probes += 1; return { status: 1, stdout: '' }; }
  });
  assert.equal(restarted.getStatus().canBuild, true);
  assert.equal(probes, probesAfterFirstScan);
});
