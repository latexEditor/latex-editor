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
  assert.equal(settings['latex-workshop.view.pdf.internal.synctex.keybinding'], 'double-click');
});

test('adds inverse SyncTeX defaults without replacing custom compiler settings', (t) => {
  const manager = fixture(t);
  const project = manager.createProject('Custom compiler');
  const settingsFile = path.join(project.path, '.vscode', 'settings.json');
  const custom = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  custom['latex-workshop.latex.recipes'] = [{ name: 'My compiler', tools: ['custom'] }];
  custom['latex-workshop.latex.tools'] = [{ name: 'custom', command: 'custom-latex', args: [] }];
  delete custom['latex-workshop.view.pdf.internal.synctex.keybinding'];
  fs.writeFileSync(settingsFile, JSON.stringify(custom));

  manager.openProject(project.path);

  const migrated = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.deepEqual(migrated['latex-workshop.latex.recipes'], custom['latex-workshop.latex.recipes']);
  assert.deepEqual(migrated['latex-workshop.latex.tools'], custom['latex-workshop.latex.tools']);
  assert.equal(migrated['latex-workshop.view.pdf.internal.synctex.keybinding'], 'double-click');
});

test('preserves an explicitly configured inverse SyncTeX gesture', (t) => {
  const manager = fixture(t);
  const project = manager.createProject('Custom SyncTeX');
  const settingsFile = path.join(project.path, '.vscode', 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  settings['latex-workshop.view.pdf.internal.synctex.keybinding'] = 'ctrl-click';
  fs.writeFileSync(settingsFile, JSON.stringify(settings));

  manager.openProject(project.path);

  const preserved = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.equal(preserved['latex-workshop.view.pdf.internal.synctex.keybinding'], 'ctrl-click');
});

test('migrates an app-managed latexmk recipe when latexmk is unusable', (t) => {
  const manager = fixture(t);
  manager.runtimeStatus = { tools: [{ name: 'latexmk', available: true, usable: true }] };
  const project = manager.createProject('Missing Perl');
  manager.runtimeStatus = { tools: [{ name: 'latexmk', available: true, usable: false }] };
  manager.openProject(project.path);
  const settings = JSON.parse(fs.readFileSync(path.join(project.path, '.vscode', 'settings.json'), 'utf8'));
  assert.equal(settings['latex-workshop.latex.recipes'][0].name, 'pdflatex');
  assert.equal(settings['latex-workshop.latex.tools'][0].command, 'pdflatex');
});

test('detects XeLaTeX projects and replaces an app-managed pdfLaTeX recipe', (t) => {
  const manager = fixture(t);
  manager.runtimeStatus = { tools: [{ name: 'latexmk', available: true, usable: true }] };
  const project = manager.createProject('Imported XeLaTeX project');
  const settingsFile = path.join(project.path, '.vscode', 'settings.json');
  const original = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.equal(original['latex-workshop.latex.recipes'][0].name, 'latexmk');
  assert.equal(original['latex-workshop.latex.tools'][0].args.includes('-pdf'), true);

  fs.writeFileSync(path.join(project.path, 'main.tex'), [
    '% !TeX program = xelatex',
    '\\documentclass{article}',
    '\\usepackage{fontspec}',
    '\\begin{document}Xin chÃ o\\end{document}'
  ].join('\n'));
  fs.writeFileSync(path.join(project.path, 'latexmkrc'), '$pdf_mode = 5;\n');
  manager.openProject(project.path);

  const migrated = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.equal(migrated['latex-workshop.latex.recipes'][0].name, 'latexmk-xelatex');
  assert.deepEqual(migrated['latex-workshop.latex.recipes'][0].tools, ['latexmk-xelatex']);
  assert.equal(migrated['latex-workshop.latex.tools'][0].command, 'latexmk');
  assert.equal(migrated['latex-workshop.latex.tools'][0].args.includes('-xelatex'), true);
  assert.equal(migrated['latex-workshop.latex.tools'][0].args.includes('-pdf'), false);
});

test('keeps multiple projects open in creation order without duplicating switched tabs', (t) => {
  const manager = fixture(t);
  const duong = manager.createProject('duong');
  const trinh = manager.createProject('trinh');
  assert.deepEqual(manager.listOpenProjects().map((project) => project.name), ['duong', 'trinh']);

  manager.openProject(duong.path);
  assert.deepEqual(manager.listOpenProjects().map((project) => project.name), ['duong', 'trinh']);
});

test('closes a project tab without deleting its project directory', (t) => {
  const manager = fixture(t);
  const duong = manager.createProject('duong');
  manager.createProject('trinh');
  const nextProject = manager.closeProject(duong.path);

  assert.equal(nextProject.name, 'trinh');
  assert.deepEqual(manager.listOpenProjects().map((project) => project.name), ['trinh']);
  assert.equal(fs.existsSync(duong.path), true);
});

test('remembers an intentionally empty tab list after closing the last project', (t) => {
  const manager = fixture(t);
  const project = manager.createProject('binh');
  manager.closeProject(project.path);

  assert.equal(manager.hasOpenProjectsState(), true);
  assert.deepEqual(manager.listOpenProjects(), []);
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

test('creates each bundled template and copies nested chapter files', (t) => {
  const manager = fixture(t);
  manager.templateDir = path.resolve(__dirname, '../resources/templates/basic-article');
  assert.equal(manager.listTemplates().length, 7);
  for (const template of manager.listTemplates()) {
    const project = manager.createProject(`Tài liệu ${template.id}`, template.id);
    assert.equal(project.hasMainTex, true);
    assert.match(fs.readFileSync(path.join(project.path, 'main.tex'), 'utf8'), /\\end\{document\}/);
    if (template.id === 'report') {
      assert.equal(fs.existsSync(path.join(project.path, 'chapters', 'introduction.tex')), true);
    }
  }
});

test('Vietnamese templates use XeLaTeX and upgrade to latexmk when it becomes available', (t) => {
  const manager = fixture(t);
  manager.templateDir = path.resolve(__dirname, '../resources/templates/basic-article');
  for (const id of ['report-vi', 'thesis-vi', 'cv-vi']) {
    manager.runtimeStatus = null;
    const project = manager.createProject(id, id);
    const settingsFile = path.join(project.path, '.vscode', 'settings.json');
    const initial = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    assert.equal(initial['latex-workshop.latex.tools'][0].command, 'xelatex');
    assert.deepEqual(initial['latex-workshop.latex.recipes'][0].tools, ['xelatex', 'xelatex']);
    manager.runtimeStatus = { tools: [{ name: 'latexmk', available: true, usable: true }] };
    manager.openProject(project.path);
    const upgraded = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    assert.equal(upgraded['latex-workshop.latex.recipes'][0].name, 'latexmk-xelatex');
    assert.equal(upgraded['latex-workshop.latex.tools'][0].command, 'latexmk');
    assert.equal(upgraded['latex-workshop.latex.tools'][0].args.includes('-xelatex'), true);
    const edited = { ...upgraded, 'latex-workshop.latex.recipes': [{ name: 'My compiler', tools: ['custom'] }] };
    fs.writeFileSync(settingsFile, JSON.stringify(edited));
    manager.openProject(project.path);
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')), edited);
  }
});

test('rejects unknown templates and does not overwrite an existing project', (t) => {
  const manager = fixture(t);
  assert.throws(() => manager.createProject('Bad template', '../outside'), /Mẫu project/);
  assert.equal(fs.existsSync(path.join(manager.projectsDir, 'Bad template')), false);
  const project = manager.createProject('Existing');
  fs.writeFileSync(path.join(project.path, 'main.tex'), 'User work');
  assert.throws(() => manager.createProject('Existing'), /đã tồn tại/);
  assert.equal(fs.readFileSync(path.join(project.path, 'main.tex'), 'utf8'), 'User work');
});

test('rejects Windows reserved names before creating a project', (t) => {
  const manager = fixture(t);
  for (const name of ['CON', 'nul.tex', 'COM1', 'LPT9', '...', ' ']) {
    assert.throws(() => manager.createProject(name), /không hợp lệ/);
  }
});

test('recent projects survive restart and can reopen a closed tab', (t) => {
  const manager = fixture(t);
  const project = manager.createProject('Báo cáo gần đây');
  manager.closeProject(project.path);
  const restored = new WorkspaceManager(manager);
  assert.deepEqual(restored.listOpenProjects(), []);
  assert.equal(restored.listRecent()[0].path, project.path);
  restored.openProject(project.path);
  assert.equal(restored.listOpenProjects()[0].path, project.path);
});

test('forgetting history preserves files, open tabs and unrelated settings', (t) => {
  const manager = fixture(t);
  const project = manager.createProject('Keep my files');
  const settings = JSON.parse(fs.readFileSync(manager.settingsFile, 'utf8'));
  fs.writeFileSync(manager.settingsFile, JSON.stringify({ ...settings, customOption: 'keep' }));
  manager.forgetProject(project.path);
  assert.deepEqual(manager.listRecent(), []);
  assert.equal(manager.listOpenProjects()[0].path, project.path);
  assert.equal(fs.existsSync(path.join(project.path, 'main.tex')), true);
  assert.equal(JSON.parse(fs.readFileSync(manager.settingsFile, 'utf8')).customOption, 'keep');
  assert.equal(manager.getProjectLocation(project.path), project.path);
});

test('missing project folders remain removable from history', (t) => {
  const manager = fixture(t);
  const project = manager.createProject('Moved project');
  fs.renameSync(project.path, `${project.path}-moved`);
  assert.equal(manager.listRecent()[0].exists, false);
  assert.deepEqual(manager.listOpenProjects(), []);
  assert.throws(() => manager.getProjectLocation(project.path), /không còn tồn tại/);
  manager.forgetProject(project.path);
  assert.deepEqual(manager.listRecent(), []);
  assert.equal(fs.existsSync(`${project.path}-moved`), true);
});

test('reveal location accepts known projects or storage root only', (t) => {
  const manager = fixture(t);
  manager.initialize();
  assert.equal(manager.getProjectLocation(), manager.projectsDir);
  assert.throws(() => manager.getProjectLocation(manager.templateDir), /chưa được mở/);
  const project = manager.createProject('Changed to file');
  fs.renameSync(project.path, `${project.path}-backup`);
  fs.writeFileSync(project.path, 'not a directory');
  assert.equal(manager.listRecent()[0].exists, false);
  assert.throws(() => manager.getProjectLocation(project.path), /không còn tồn tại/);
});
