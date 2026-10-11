const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const POSITIVE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const NEGATIVE_CACHE_TTL_MS = 5 * 60 * 1000;

class LatexRuntimeManager {
  constructor(dependencies = {}) {
    this.spawnSync = dependencies.spawnSync || spawnSync;
    this.fs = dependencies.fs || fs;
    this.platform = dependencies.platform || process.platform;
    this.env = dependencies.env || process.env;
    this.cacheFile = dependencies.cacheFile || null;
    this.now = dependencies.now || Date.now;
    this.status = null;
  }

  getStatus(options = {}) {
    if (!options.refresh && this.status) return this.status;
    if (!options.refresh) {
      const cached = this.#readCache();
      if (cached) {
        this.status = cached;
        return cached;
      }
    }
    this.supportPaths = this.#findSupportPaths();
    const tools = ['latexmk', 'pdflatex', 'xelatex'].map((name) => this.#find(name));
    const available = tools.filter((tool) => tool.available);
    const distribution = this.#distribution(available);
    const canBuild = tools.some((tool) => ['latexmk', 'pdflatex', 'xelatex'].includes(tool.name) && tool.usable);
    this.status = {
      available: available.length > 0,
      canBuild,
      distribution,
      tools,
      pathEntries: [...new Set([
        ...available.map((tool) => path.dirname(tool.path)),
        ...this.supportPaths
      ])],
      recommendation: canBuild
        ? null
        : available.length > 0
          ? 'Đã tìm thấy LaTeX nhưng chưa có trình biên dịch chạy được. Hãy xem chi tiết từng công cụ.'
          : 'Hãy cài MiKTeX hoặc TeX Live, bật tùy chọn thêm công cụ LaTeX vào PATH, rồi khởi động lại ứng dụng.'
    };
    this.#writeCache(this.status);
    return this.status;
  }

  #environmentKey() {
    const value = [
      this.platform,
      this.env.PATH || '',
      this.env.LOCALAPPDATA || '',
      this.env.ProgramFiles || ''
    ].join('\0');
    return crypto.createHash('sha256').update(value).digest('hex');
  }

  #readCache() {
    if (!this.cacheFile || typeof this.fs.readFileSync !== 'function') return null;
    try {
      const cache = JSON.parse(this.fs.readFileSync(this.cacheFile, 'utf8'));
      const maxAge = cache.status?.canBuild ? POSITIVE_CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS;
      if (cache.version !== 1 || cache.environmentKey !== this.#environmentKey()
        || !Number.isFinite(cache.savedAt) || this.now() - cache.savedAt > maxAge) return null;
      if (!Array.isArray(cache.status?.tools) || !Array.isArray(cache.status?.pathEntries)) return null;
      const pathsStillExist = cache.status.tools
        .filter((tool) => tool.available)
        .every((tool) => tool.path && this.fs.existsSync(tool.path));
      return pathsStillExist ? cache.status : null;
    } catch {
      return null;
    }
  }

  #writeCache(status) {
    if (!this.cacheFile || typeof this.fs.writeFileSync !== 'function' || typeof this.fs.mkdirSync !== 'function') return;
    try {
      this.fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
      this.fs.writeFileSync(this.cacheFile, `${JSON.stringify({
        version: 1,
        savedAt: this.now(),
        environmentKey: this.#environmentKey(),
        status
      }, null, 2)}\n`, 'utf8');
    } catch {
      // Runtime detection still works if the cache cannot be persisted.
    }
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
        PATH: [path.dirname(executablePath), ...(this.supportPaths || []), this.env.PATH].filter(Boolean).join(path.delimiter)
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

  #findSupportPaths() {
    if (this.platform !== 'win32') return [];
    const result = this.spawnSync('where.exe', ['perl.exe'], { encoding: 'utf8', windowsHide: true });
    const fromPath = result.status === 0
      ? String(result.stdout).split(/\r?\n/).filter(Boolean).map((file) => path.dirname(file.trim()))
      : [];
    const candidates = [
      ...fromPath,
      path.join(this.env.ProgramFiles || 'C:\\Program Files', 'Git', 'usr', 'bin'),
      path.join(this.env.LOCALAPPDATA || '', 'Programs', 'Git', 'usr', 'bin')
    ];
    return [...new Set(candidates.filter((directory) => this.fs.existsSync(path.join(directory, 'perl.exe'))))];
  }
}

module.exports = { LatexRuntimeManager };
