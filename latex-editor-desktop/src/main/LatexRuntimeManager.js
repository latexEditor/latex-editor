const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

class LatexRuntimeManager {
  constructor(dependencies = {}) {
    this.spawnSync = dependencies.spawnSync || spawnSync;
    this.fs = dependencies.fs || fs;
    this.platform = dependencies.platform || process.platform;
    this.env = dependencies.env || process.env;
  }

  getStatus() {
    const tools = ['latexmk', 'pdflatex', 'xelatex'].map((name) => this.#find(name));
    const available = tools.filter((tool) => tool.available);
    const distribution = this.#distribution(available);
    return {
      available: available.length > 0,
      canBuild: tools.some((tool) => tool.name === 'latexmk' && tool.available)
        || tools.some((tool) => tool.name === 'pdflatex' && tool.available),
      distribution,
      tools,
      recommendation: available.length > 0
        ? null
        : 'Hãy cài MiKTeX hoặc TeX Live, bật tùy chọn thêm công cụ LaTeX vào PATH, rồi khởi động lại ứng dụng.'
    };
  }

  #find(name) {
    const executable = this.platform === 'win32' ? `${name}.exe` : name;
    const lookup = this.platform === 'win32' ? 'where.exe' : 'which';
    const result = this.spawnSync(lookup, [executable], { encoding: 'utf8', windowsHide: true });
    const foundPath = result.status === 0 ? String(result.stdout).split(/\r?\n/).find(Boolean)?.trim() : null;
    if (foundPath) return { name, available: true, path: foundPath };

    if (this.platform === 'win32') {
      const roots = [
        path.join(this.env.LOCALAPPDATA || '', 'Programs', 'MiKTeX', 'miktex', 'bin', 'x64'),
        path.join(this.env.ProgramFiles || 'C:\\Program Files', 'MiKTeX', 'miktex', 'bin', 'x64'),
        path.join(this.env.ProgramFiles || 'C:\\Program Files', 'texlive', '2026', 'bin', 'windows'),
        path.join(this.env.ProgramFiles || 'C:\\Program Files', 'texlive', '2025', 'bin', 'windows')
      ];
      const candidate = roots.map((root) => path.join(root, executable)).find((file) => this.fs.existsSync(file));
      if (candidate) return { name, available: true, path: candidate };
    }
    return { name, available: false, path: null };
  }

  #distribution(tools) {
    const paths = tools.map((tool) => tool.path.toLowerCase());
    if (paths.some((value) => value.includes('miktex'))) return 'MiKTeX';
    if (paths.some((value) => value.includes('texlive'))) return 'TeX Live';
    return tools.length ? 'LaTeX (PATH)' : null;
  }
}

module.exports = { LatexRuntimeManager };
