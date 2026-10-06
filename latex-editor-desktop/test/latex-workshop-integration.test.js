const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ensureBuildOpensPdf } = require('../src/main/LatexWorkshopIntegration');

function extensionFixture(t, version = '10.7.4') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'latex-workshop-integration-'));
  const extensionMain = path.join(root, `james-yu.latex-workshop-${version}-universal`, 'out', 'src', 'main.js');
  fs.mkdirSync(path.dirname(extensionMain), { recursive: true });
  fs.writeFileSync(extensionMain, [
    'function registerLatexWorkshopCommands(extensionContext) {',
    "  extensionContext.subscriptions.push(vscode.commands.registerCommand('latex-workshop.build', () => lw_1.lw.commands.build()));",
    '}'
  ].join('\n'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, extensionMain };
}

test('patches the newest LaTeX Workshop so manual Build opens the PDF after success', (t) => {
  const older = extensionFixture(t, '10.4.0');
  const newerDirectory = path.join(older.root, 'james-yu.latex-workshop-10.7.4-universal', 'out', 'src');
  const newerMain = path.join(newerDirectory, 'main.js');
  fs.mkdirSync(newerDirectory, { recursive: true });
  fs.copyFileSync(older.extensionMain, newerMain);

  const result = ensureBuildOpensPdf(older.root);
  const patched = fs.readFileSync(newerMain, 'utf8');
  assert.equal(result.patched, true);
  assert.equal(result.extensionMain, newerMain);
  assert.match(patched, /latex-editor: build-and-view/);
  assert.match(patched, /await lw_1\.lw\.commands\.build\(\)/);
  assert.match(patched, /await lw_1\.lw\.commands\.view\('tab'\)/);
  assert.doesNotMatch(fs.readFileSync(older.extensionMain, 'utf8'), /latex-editor: build-and-view/);
});

test('does not patch LaTeX Workshop more than once', (t) => {
  const fixture = extensionFixture(t);
  assert.equal(ensureBuildOpensPdf(fixture.root).patched, true);
  const once = fs.readFileSync(fixture.extensionMain, 'utf8');
  assert.equal(ensureBuildOpensPdf(fixture.root).patched, false);
  assert.equal(fs.readFileSync(fixture.extensionMain, 'utf8'), once);
});
