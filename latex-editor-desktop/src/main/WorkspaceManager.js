const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const { PROJECT_TEMPLATES } = require('./ProjectTemplates');

class WorkspaceManager {
  constructor({ projectsDir, settingsFile, templateDir }, dependencies = {}) {
    this.projectsDir = path.resolve(projectsDir);
    this.settingsFile = path.resolve(settingsFile);
    this.templateDir = path.resolve(templateDir);
    this.fs = dependencies.fs || fs;
    this.runtimeStatus = dependencies.runtimeStatus || null;
  }

  initialize() {
    this.fs.mkdirSync(this.projectsDir, { recursive: true });
    this.fs.mkdirSync(path.dirname(this.settingsFile), { recursive: true });
  }

  sanitizeProjectName(name) {
    const clean = String(name || '').trim().replace(/[<>:"/\\|?*\x00-\x1F]/g, '-').replace(/[. ]+$/g, '');
    const result = clean.slice(0, 100).replace(/[. ]+$/g, '');
    if (!result || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(result)) {
      throw new Error('Tên project không hợp lệ hoặc là tên dành riêng của Windows.');
    }
    return result;
  }

  listTemplates() {
    return PROJECT_TEMPLATES.map((template) => ({ ...template }));
  }

  createProject(name, templateId = 'basic-article') {
    if (!PROJECT_TEMPLATES.some((template) => template.id === templateId)) {
      throw new Error('Mẫu project không hợp lệ.');
    }
    this.initialize();
    const cleanName = this.sanitizeProjectName(name);
    const projectPath = path.join(this.projectsDir, cleanName);
    if (this.fs.existsSync(projectPath)) throw new Error(`Project “${cleanName}” đã tồn tại.`);
    const source = templateId === 'basic-article'
      ? this.templateDir
      : path.join(path.dirname(this.templateDir), templateId);
    this.fs.cpSync(source, projectPath, { recursive: true, errorOnExist: true, force: false });
    this.#writeLatexSettings(projectPath);
    this.remember(projectPath);
    return this.describe(projectPath);
  }

  ensureWelcomeProject() {
    this.initialize();
    const recent = this.listRecent().find((item) => item.exists);
    if (recent) return recent;
    const welcomePath = path.join(this.projectsDir, 'Welcome');
    if (!this.fs.existsSync(welcomePath)) {
      this.fs.cpSync(this.templateDir, welcomePath, { recursive: true });
      this.#writeLatexSettings(welcomePath);
    }
    this.remember(welcomePath);
    return this.describe(welcomePath);
  }

  openProject(projectPath) {
    const resolved = path.resolve(projectPath);
    if (!this.fs.existsSync(resolved) || !this.fs.statSync(resolved).isDirectory()) {
      throw new Error(`Không tìm thấy thư mục project: ${resolved}`);
    }
    this.#writeLatexSettings(resolved);
    this.remember(resolved);
    return this.describe(resolved);
  }

  describe(projectPath) {
    const resolved = path.resolve(projectPath);
    let exists = false;
    try { exists = this.fs.statSync(resolved).isDirectory(); }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
    return {
      name: path.basename(resolved),
      path: resolved,
      exists,
      hasMainTex: this.fs.existsSync(path.join(resolved, 'main.tex'))
    };
  }

  listRecent() {
    const settings = this.#readSettings();
    return (settings.recentProjects || []).map((item) => this.describe(item));
  }

  forgetProject(projectPath) {
    const resolved = path.resolve(projectPath);
    const settings = this.#readSettings();
    settings.recentProjects = (settings.recentProjects || []).filter((candidate) => (
      process.platform === 'win32' ? candidate.toLowerCase() !== resolved.toLowerCase() : candidate !== resolved
    ));
    this.fs.writeFileSync(this.settingsFile, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    return this.listRecent();
  }

  getProjectLocation(projectPath) {
    if (!projectPath) return this.projectsDir;
    const resolved = path.resolve(projectPath);
    const known = [...this.listRecent(), ...this.listOpenProjects()].find((project) => (
      process.platform === 'win32' ? project.path.toLowerCase() === resolved.toLowerCase() : project.path === resolved
    ));
    if (!known?.exists || !this.fs.statSync(resolved).isDirectory()) {
      throw new Error('Thư mục project không còn tồn tại hoặc chưa được mở trong ứng dụng.');
    }
    return resolved;
  }

  listOpenProjects() {
    const settings = this.#readSettings();
    return (settings.openProjects || [])
      .map((item) => this.describe(item))
      .filter((item) => item.exists);
  }

  hasOpenProjectsState() {
    return Array.isArray(this.#readSettings().openProjects);
  }

  closeProject(projectPath) {
    const resolved = path.resolve(projectPath);
    const settings = this.#readSettings();
    const samePath = (candidate) => process.platform === 'win32'
      ? candidate.toLowerCase() === resolved.toLowerCase()
      : candidate === resolved;
    settings.openProjects = (settings.openProjects || []).filter((item) => !samePath(item));
    if (settings.lastProject && samePath(settings.lastProject)) {
      settings.lastProject = settings.openProjects[0] || null;
    }
    this.fs.writeFileSync(this.settingsFile, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    return settings.openProjects.length ? this.describe(settings.openProjects[0]) : null;
  }

  remember(projectPath) {
    const resolved = path.resolve(projectPath);
    const settings = this.#readSettings();
    const samePath = (candidate) => process.platform === 'win32'
      ? candidate.toLowerCase() === resolved.toLowerCase()
      : candidate === resolved;
    settings.recentProjects = [resolved, ...(settings.recentProjects || []).filter((item) => !samePath(item))].slice(0, 12);
    const openProjects = (settings.openProjects || []).filter((item) => this.fs.existsSync(item));
    if (!openProjects.some((item) => samePath(item))) openProjects.push(resolved);
    settings.openProjects = openProjects;
    settings.lastProject = resolved;
    this.fs.writeFileSync(this.settingsFile, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  }

  codeServerUrl(host, port, projectPath) {
    const url = new URL(`http://${host}:${port}`);
    url.searchParams.set('folder', this.remotePath(projectPath));
    return url;
  }

  remotePath(projectPath) {
    return `/${path.resolve(projectPath).replace(/\\/g, '/')}`;
  }

  #readSettings() {
    try {
      return JSON.parse(this.fs.readFileSync(this.settingsFile, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return {};
      throw error;
    }
  }

  #writeLatexSettings(projectPath) {
    const vscodeDir = path.join(projectPath, '.vscode');
    const settingsPath = path.join(vscodeDir, 'settings.json');
    this.fs.mkdirSync(vscodeDir, { recursive: true });
    const preferredTool = this.runtimeStatus?.tools?.find((tool) => (
      tool.name === 'latexmk' && tool.available && tool.usable !== false
    ))
      ? 'latexmk'
      : 'pdflatex';
    const tools = preferredTool === 'latexmk'
      ? [{
        name: 'latexmk', command: 'latexmk',
        args: ['-synctex=1', '-interaction=nonstopmode', '-file-line-error', '-pdf', '-outdir=%OUTDIR%', '%DOC%']
      }]
      : [{
        name: 'pdflatex', command: 'pdflatex',
        args: ['-synctex=1', '-interaction=nonstopmode', '-file-line-error', '-output-directory=%OUTDIR%', '%DOC%']
      }];
    const settings = {
      'window.commandCenter': false,
      'window.customTitleBarVisibility': 'never',
      'latex-workshop.latex.autoBuild.run': 'onSave',
      'latex-workshop.latex.outDir': '%DIR%/build',
      'latex-workshop.latex.recipes': [{ name: preferredTool, tools: [preferredTool] }],
      'latex-workshop.latex.tools': tools,
      'latex-workshop.view.pdf.viewer': 'tab',
      'latex-workshop.view.pdf.tab.editorGroup': 'right',
      'latex-workshop.synctex.afterBuild.enabled': true,
      'files.exclude': { '**/*.aux': true, '**/*.fls': true, '**/*.fdb_latexmk': true }
    };

    if (this.fs.existsSync(settingsPath)) {
      try {
        const current = JSON.parse(this.fs.readFileSync(settingsPath, 'utf8'));
        const recipe = current['latex-workshop.latex.recipes'];
        const currentTools = current['latex-workshop.latex.tools'];
        const managedRecipe = Array.isArray(recipe) && recipe.length === 1
          && ['latexmk', 'pdflatex'].includes(recipe[0]?.name)
          && recipe[0]?.tools?.length === 1
          && recipe[0].tools[0] === recipe[0].name;
        const managedTools = Array.isArray(currentTools) && currentTools.length === 1
          && currentTools[0]?.name === recipe?.[0]?.name
          && currentTools[0]?.command === recipe?.[0]?.name;
        if (!managedRecipe || !managedTools || recipe[0].name === preferredTool) return;
        const migrated = {
          ...current,
          'latex-workshop.latex.recipes': settings['latex-workshop.latex.recipes'],
          'latex-workshop.latex.tools': settings['latex-workshop.latex.tools']
        };
        this.fs.writeFileSync(settingsPath, `${JSON.stringify(migrated, null, 2)}\n`, 'utf8');
        return;
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        return;
      }
    }
    this.fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  }
}

module.exports = { WorkspaceManager };
