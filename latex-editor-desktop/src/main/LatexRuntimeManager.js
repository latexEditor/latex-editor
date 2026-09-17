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
    const canBuild = tools.some((tool) => ['latexmk', 'pdflatex'].includes(tool.name) && tool.usable);
    return {
      available: available.length > 0,
      canBuild,
      distribution,
      tools,
      recommendation: canBuild
        ? null
        : available.length > 0
          ? 'Đã tìm thấy LaTeX nhưng chưa có trình biên dịch chạy được. Hãy xem chi tiết từng công cụ.'
          : 'Hãy cài MiKTeX hoặc TeX Live, bật tùy chọn thêm công cụ LaTeX vào PATH, rồi khởi động lại ứng dụng.'
    };
  }

  #find(name) {
    const executable = this.platform === 'win32' ? `${name}.exe` : name;
    const lookup = this.platform === 'win32' ? 'where.exe' : 'which';
    const result = this.spawnSync(lookup, [executable], { encoding: 'utf8', windowsHide: true });
    const foundPath = result.status === 0 ? String(result.stdout).split(/\r?\n/).find(Boolean)?.trim() : null;
    if (foundPath) return this.#inspect(name, foundPath);

    if (this.platform === 'win32') {
      const roots = [
        path.join(this.env.LOCALAPPDATA || '', 'Programs', 'MiKTeX', 'miktex', 'bin', 'x64'),
        path.join(this.env.ProgramFiles || 'C:\\Program Files', 'MiKTeX', 'miktex', 'bin', 'x64'),
        path.join(this.env.ProgramFiles || 'C:\\Program Files', 'texlive', '2026', 'bin', 'windows'),
        path.join(this.env.ProgramFiles || 'C:\\Program Files', 'texlive', '2025', 'bin', 'windows')
      ];
      const candidate = roots.map((root) => path.join(root, executable)).find((file) => this.fs.existsSync(file));
      if (candidate) return this.#inspect(name, candidate);
    }
    return { name, available: false, usable: false, path: null, reason: 'Không tìm thấy' };
  }

  #inspect(name, executablePath) {
    if (name !== 'latexmk') {
      return { name, available: true, usable: true, path: executablePath, reason: null };
    }

    const probe = this.spawnSync(executablePath, ['--version'], {
      encoding: 'utf8',
      windowsHide: true,
      env: {
        ...this.env,
        PATH: [path.dirname(executablePath), this.env.PATH].filter(Boolean).join(path.delimiter)
      }
    });
    if (probe.status === 0) {
      return { name, available: true, usable: true, path: executablePath, reason: null };
    }
    const output = `${probe.stderr || ''}\n${probe.stdout || ''}`;
    const reason = /perl/i.test(output)
      ? 'Thiếu Perl; app sẽ dùng pdflatex'
      : 'Không thể chạy; app sẽ dùng pdflatex';
    return { name, available: true, usable: false, path: executablePath, reason };
  }

  #distribution(tools) {
    const paths = tools.map((tool) => tool.path.toLowerCase());
    if (paths.some((value) => value.includes('miktex'))) return 'MiKTeX';
    if (paths.some((value) => value.includes('texlive'))) return 'TeX Live';
    return tools.length ? 'LaTeX (PATH)' : null;
  }
}

module.exports = { LatexRuntimeManager };
