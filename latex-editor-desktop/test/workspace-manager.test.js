const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { WorkspaceManager } = require('../src/main/WorkspaceManager');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'latex-editor-'));
  const templateDir = path.join(root, 'template');
  fs.mkdirSync(templateDir);
  fs.writeFileSync(path.join(templateDir, 'main.tex'), '\\documentclass{article}');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return new WorkspaceManager({
    projectsDir: path.join(root, 'projects'),
    settingsFile: path.join(root, 'data', 'settings.json'),
    templateDir
  });
}

test('creates a project from template and persists recent projects', (t) => {
  const manager = fixture(t);
  const project = manager.createProject('Báo cáo 2026');
  assert.equal(project.name, 'Báo cáo 2026');
  assert.equal(project.hasMainTex, true);
  assert.equal(fs.existsSync(path.join(project.path, '.vscode', 'settings.json')), true);
  assert.equal(manager.listRecent()[0].path, project.path);
});

test('writes a pdflatex fallback recipe when latexmk is unavailable', (t) => {
  const manager = fixture(t);
  manager.runtimeStatus = { tools: [{ name: 'latexmk', available: false }] };
  const project = manager.createProject('Fallback compiler');
  const settings = JSON.parse(fs.readFileSync(path.join(project.path, '.vscode', 'settings.json'), 'utf8'));
  assert.equal(settings['latex-workshop.latex.recipes'][0].name, 'pdflatex');
});

test('sanitizes path separators so project stays below managed root', (t) => {
  const manager = fixture(t);
  const project = manager.createProject('chapter/../paper');
  assert.equal(project.name, 'chapter-..-paper');
  assert.equal(path.dirname(project.path), manager.projectsDir);
});

test('creates an encoded code-server URL for Unicode Windows paths', (t) => {
  const manager = fixture(t);
  const url = manager.codeServerUrl('127.0.0.1', 8765, 'D:\\Dự án LaTeX');
  assert.equal(url.origin, 'http://127.0.0.1:8765');
  assert.match(url.search, /folder=/);
  assert.equal(url.searchParams.get('folder').includes('Dự án LaTeX'), true);
});
