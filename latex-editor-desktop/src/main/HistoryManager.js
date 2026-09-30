const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const MAX_BYTES = 50 * 1024 * 1024;
const OMIT = new Set(['.git', 'build', 'node_modules', '.latex-editor', '.ds_store']);

function excluded(name) {
  return OMIT.has(name.toLowerCase()) || /^\.env(?:\.|$)/i.test(name) || /\.(?:aux|log|fls|fdb_latexmk|synctex(?:\.gz)?|pem|key|p12)$/i.test(name);
}
function safeFile(value) {
  const parts = value.split('/');
  if (!value || parts.some((part) => !part || part === '.' || part === '..' || excluded(part)
    || /[<>:"\\|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error('Phiên bản chứa đường dẫn không an toàn.');
  }
  return value;
}

class HistoryManager {
  constructor({ historyDir }) { this.root = path.resolve(historyDir); this.queues = new Map(); }

  location(project) {
    const normalized = process.platform === 'win32' ? path.resolve(project).toLowerCase() : path.resolve(project);
    return path.join(this.root, crypto.createHash('sha256').update(normalized).digest('hex'));
  }

  async locked(project, task) {
    const key = this.location(project);
    const previous = this.queues.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(() => task(key));
    this.queues.set(key, next);
    try { return await next; } finally { if (this.queues.get(key) === next) this.queues.delete(key); }
  }

  async git(repo, args, binary = false) {
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0' };
    for (const key of Object.keys(env)) {
      if (/^GIT_/i.test(key) && !['GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_TERMINAL_PROMPT'].includes(key)) delete env[key];
    }
    try {
      const result = await exec('git', ['-c', 'core.hooksPath=' + path.join(this.root, 'no-hooks'), '-c', 'core.autocrlf=false', '-c', 'core.quotepath=false', '-c', 'commit.gpgSign=false', '-C', repo, ...args], {
        env, windowsHide: true, timeout: 30000, maxBuffer: MAX_BYTES + 1024, encoding: binary ? 'buffer' : 'utf8'
      });
      return result.stdout;
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error('Chưa tìm thấy Git. Hãy cài Git for Windows rồi mở lại app.');
      throw new Error(`Không thực hiện được lịch sử Git: ${String(error.stderr || error.message).slice(0, 1000)}`);
    }
  }

  async initialize(repo) {
    await fs.mkdir(repo, { recursive: true });
    try { await fs.access(path.join(repo, '.git')); }
    catch { await this.git(repo, ['init', '--initial-branch=main']); }
    await fs.mkdir(path.join(repo, '.git', 'info'), { recursive: true });
    // Attributes in a document must not transform the bytes of its backup.
    await fs.writeFile(path.join(repo, '.git', 'info', 'attributes'), '* -text -filter -ident -working-tree-encoding\n');
  }

  async scan(directory, prefix = '', result = new Map(), budget = { bytes: 0 }) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (excluded(entry.name)) continue;
      const relative = safeFile(prefix + entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Không lưu liên kết tượng trưng: ${relative}`);
      if (entry.isDirectory()) await this.scan(path.join(directory, entry.name), relative + '/', result, budget);
      else if (entry.isFile()) {
        const file = path.join(directory, entry.name);
        budget.bytes += (await fs.stat(file)).size;
        if (budget.bytes > MAX_BYTES || result.size >= 5000) throw new Error('Project vượt giới hạn 50 MB hoặc 5.000 file cho một phiên bản.');
        result.set(relative, await fs.readFile(file));
      }
    }
    return result;
  }

  async head(repo) {
    const refs = await this.git(repo, ['for-each-ref', '--format=%(objectname)', 'refs/heads/main']);
    return refs.trim() || null;
  }

  async tree(repo, hash) {
    if (!/^[a-f0-9]{40}$/.test(hash || '')) throw new Error('Mã phiên bản không hợp lệ.');
    const reachable = await this.git(repo, ['rev-list', 'main']);
    if (!reachable.split(/\r?\n/).includes(hash)) throw new Error('Phiên bản không thuộc lịch sử project.');
    const entries = (await this.git(repo, ['ls-tree', '-rz', hash])).split('\0').filter(Boolean);
    if (entries.length > 5000) throw new Error('Phiên bản vượt giới hạn số file.');
    const result = new Map();
    const names = new Set();
    let bytes = 0;
    for (const entry of entries) {
      const match = entry.match(/^(100644|100755) blob ([a-f0-9]{40})\t([\s\S]+)$/);
      if (!match) throw new Error('Phiên bản chứa symlink hoặc submodule không được hỗ trợ.');
      const name = safeFile(match[3]);
      const folded = name.toLowerCase();
      if (names.has(folded)) throw new Error('Phiên bản chứa tên file trùng nhau trên Windows.');
      names.add(folded);
      const size = Number((await this.git(repo, ['cat-file', '-s', match[2]])).trim());
      bytes += size;
      if (bytes > MAX_BYTES) throw new Error('Phiên bản vượt giới hạn 50 MB.');
      result.set(name, await this.git(repo, ['cat-file', 'blob', match[2]], true));
    }
    return result;
  }

  async replaceFiles(directory, previous, next) {
    // Only remove named files in the captured snapshot. Never recursively delete
    // a project directory; ignored build output and the user's .git stay intact.
    for (const name of previous.keys()) {
      if (!next.has(name)) {
        const file = path.join(directory, safeFile(name));
        await fs.unlink(file);
        let parent = path.dirname(file);
        while (parent !== directory && parent.startsWith(directory + path.sep)) {
          try { await fs.rmdir(parent); } catch { break; }
          parent = path.dirname(parent);
        }
      }
    }
    for (const [name, content] of next) {
      const target = path.join(directory, safeFile(name));
      try {
        const stat = await fs.lstat(target);
        if (stat.isSymbolicLink()) throw new Error('Không ghi đè liên kết tượng trưng.');
        if (stat.isDirectory()) await fs.rmdir(target); // Empty directories only.
      } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
      await fs.mkdir(path.dirname(target), { recursive: true });
      const temporary = target + '.latex-tmp-' + crypto.randomUUID();
      await fs.writeFile(temporary, content, { flag: 'wx' });
      await fs.rename(temporary, target);
    }
  }

  async capture(repo, project, message, author = {}, force = false, capturedFiles = null) {
    if (typeof message !== 'string' || !message.trim() || message.length > 300 || /[\x00-\x1f]/.test(message)) throw new Error('Nhập ghi chú phiên bản từ 1 đến 300 ký tự.');
    const source = capturedFiles || await this.scan(project);
    await this.initialize(repo);
    const old = await this.scan(repo);
    await this.replaceFiles(repo, old, source);
    await this.git(repo, ['add', '--all', '--force', '--', '.']);
    const status = await this.git(repo, ['status', '--porcelain']);
    if (!status.trim() && await this.head(repo) && !force) return { hash: await this.head(repo), unchanged: true };
    const clean = (text, fallback) => String(text || fallback).replace(/[<>\r\n\x00]/g, '').slice(0, 150) || fallback;
    await this.git(repo, ['-c', `user.name=${clean(author.name, 'Local user')}`, '-c', `user.email=${clean(author.email, 'local@latex-editor.invalid')}`, 'commit', '--allow-empty', '-m', message.trim()]);
    return { hash: await this.head(repo), unchanged: false };
  }

  save(project, message, author) { return this.locked(project, (repo) => this.capture(repo, project, message, author)); }

  list(project) {
    return this.locked(project, async (repo) => {
      await this.initialize(repo);
      const head = await this.head(repo);
      if (!head) return [];
      const text = await this.git(repo, ['log', '--max-count=100', '--format=%H%x00%aI%x00%an%x00%s%x00', 'main']);
      const fields = text.split('\0');
      const items = [];
      for (let index = 0; index + 3 < fields.length; index += 4) {
        items.push({ hash: fields[index].trim(), date: fields[index + 1], author: fields[index + 2], message: fields[index + 3] });
      }
      return items;
    });
  }

  diff(project, hash) {
    return this.locked(project, async (repo) => {
      if (!/^[a-f0-9]{40}$/.test(hash || '')) throw new Error('Mã phiên bản không hợp lệ.');
      if (!(await this.git(repo, ['rev-list', 'main'])).split(/\r?\n/).includes(hash)) throw new Error('Không tìm thấy phiên bản.');
      const text = await this.git(repo, ['show', '--format=fuller', '--no-ext-diff', '--no-textconv', '--stat', '--patch', hash, '--']);
      return text.length > 200000 ? text.slice(0, 200000) + '\n… Nội dung xem trước đã rút gọn.' : text;
    });
  }

  restore(project, hash, author) {
    return this.locked(project, async (repo) => {
      const target = await this.tree(repo, hash);
      const before = await this.scan(project);
      // A separate commit always preserves all on-disk work before restoration.
      const backup = await this.capture(repo, project, `Bản bảo vệ trước khi khôi phục ${hash.slice(0, 8)}`, author, true, before);
      const latest = await this.scan(project);
      if (before.size !== latest.size || [...before].some(([name, data]) => !data.equals(latest.get(name) || Buffer.alloc(0)))) {
        throw new Error('File đang thay đổi. Đã lưu bản bảo vệ; hãy dừng chỉnh sửa và thử lại.');
      }
      try {
        await this.replaceFiles(project, before, target);
        const result = await this.capture(repo, project, `Khôi phục phiên bản ${hash.slice(0, 8)}`, author, true);
        return { ...result, backup: backup.hash };
      } catch (error) {
        throw new Error(`${error.message} Bản bảo vệ còn trong Lịch sử: ${backup.hash.slice(0, 8)}.`);
      }
    });
  }

  exportBundle(project) {
    return this.locked(project, async (repo) => {
      const head = await this.head(repo);
      if (!head) throw new Error('Hãy lưu ít nhất một phiên bản trước khi đồng bộ.');
      const file = path.join(repo, '.git', `transfer-${crypto.randomUUID()}.bundle`);
      try {
        await this.git(repo, ['bundle', 'create', file, 'refs/heads/main']);
        if ((await fs.stat(file)).size > MAX_BYTES) throw new Error('Lịch sử vượt giới hạn đồng bộ 50 MB.');
        return { head, data: await fs.readFile(file) };
      } finally { await fs.rm(file, { force: true }); }
    });
  }

  importBundle(project, data, expectedHead) {
    return this.locked(project, async (repo) => {
      if (data.length > MAX_BYTES || !/^[a-f0-9]{40}$/.test(expectedHead || '')) throw new Error('Dữ liệu cloud không hợp lệ.');
      await this.initialize(repo);
      if (await this.head(repo)) throw new Error('Chỉ tải cloud vào project mới để bảo vệ dữ liệu local.');
      const file = path.join(repo, '.git', 'download.bundle');
      try {
        await fs.writeFile(file, data);
        await this.git(repo, ['bundle', 'verify', file]);
        const refs = await this.git(repo, ['bundle', 'list-heads', file, 'refs/heads/main']);
        if (refs.trim() !== `${expectedHead} refs/heads/main`) throw new Error('Mã phiên bản cloud không khớp bundle.');
        await this.git(repo, ['-c', 'protocol.file.allow=always', '-c', 'fetch.fsckObjects=true', 'fetch', '--no-tags', file, 'refs/heads/main:refs/remotes/cloud/main']);
        await this.git(repo, ['update-ref', 'refs/heads/main', expectedHead]);
        const files = await this.tree(repo, expectedHead);
        if ((await fs.readdir(project)).length) throw new Error('Thư mục nhận cloud phải trống.');
        await this.replaceFiles(project, new Map(), files);
        return expectedHead;
      } finally { await fs.rm(file, { force: true }); }
    });
  }
}

module.exports = { HistoryManager, safeFile, MAX_BYTES };
