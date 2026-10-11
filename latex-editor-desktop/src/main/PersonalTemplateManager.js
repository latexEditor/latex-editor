const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const yauzl = require('yauzl');

const MAX_FILES = 500;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const EXCLUDED_DIRS = new Set(['.git', '.latex-editor', '.vscode', 'build', 'node_modules']);
const SECRET_FILE = /^(?:\.env(?:\..*)?|.*\.(?:pem|key|p12))$/i;

class PersonalTemplateManager {
  constructor(directory, dependencies = {}) {
    this.directory = path.resolve(directory);
    this.fs = dependencies.fs || fs;
  }

  initialize() { this.fs.mkdirSync(this.directory, { recursive: true }); }

  list() {
    this.initialize();
    const templates = [];
    for (const entry of this.fs.readdirSync(this.directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('personal-')) continue;
      const directory = path.join(this.directory, entry.name);
      try {
        const metadata = JSON.parse(this.fs.readFileSync(path.join(directory, 'template.json'), 'utf8'));
        if (metadata.id !== entry.name || !metadata.name || !this.fs.existsSync(path.join(directory, 'main.tex'))) continue;
        let previewDataUrl = null;
        const preview = path.join(directory, 'preview.png');
        if (this.fs.existsSync(preview) && this.fs.statSync(preview).size <= 2 * 1024 * 1024) {
          previewDataUrl = `data:image/png;base64,${this.fs.readFileSync(preview).toString('base64')}`;
        }
        templates.push({
          id: metadata.id, name: String(metadata.name).slice(0, 100), category: 'Cá nhân',
          language: metadata.language || 'Tùy chỉnh', engine: metadata.engine === 'xelatex' ? 'xelatex' : 'pdflatex',
          description: metadata.description || 'Mẫu cá nhân được lưu trên máy.', personal: true, previewDataUrl
        });
      } catch {}
    }
    return templates.sort((left, right) => left.name.localeCompare(right.name, 'vi'));
  }

  resolve(templateId) {
    if (!/^personal-[0-9a-f-]{36}$/i.test(templateId || '')) return null;
    const candidate = path.resolve(this.directory, templateId);
    if (path.dirname(candidate) !== this.directory || !this.fs.existsSync(path.join(candidate, 'main.tex'))) return null;
    return candidate;
  }

  saveProject(projectPath, name, engine = null) {
    const source = path.resolve(projectPath);
    if (!this.fs.statSync(source).isDirectory()) throw new Error('Project không còn tồn tại.');
    const cleanName = this.#cleanName(name || path.basename(source));
    const destination = path.join(this.directory, `personal-${randomUUID()}`);
    this.initialize();
    try {
      this.#copySafe(source, destination);
      if (!this.fs.existsSync(path.join(destination, 'main.tex'))) {
        throw new Error('Template cần có file main.tex ở thư mục gốc.');
      }
      this.#writeMetadata(destination, cleanName, engine || this.#detectEngine(destination), 'Mẫu được lưu từ project trên máy.');
      return this.list().find((template) => template.id === path.basename(destination));
    } catch (error) {
      this.#removeOwned(destination);
      throw error;
    }
  }

  importZip(zipPath, name) {
    const archive = path.resolve(zipPath);
    if (!/\.zip$/i.test(archive) || !this.fs.statSync(archive).isFile()) throw new Error('Hãy chọn một file ZIP hợp lệ.');
    if (this.fs.statSync(archive).size > MAX_TOTAL_BYTES) throw new Error('ZIP vượt quá giới hạn 50 MiB.');
    this.initialize();
    const temporary = path.join(this.directory, `.import-${randomUUID()}`);
    let destination = null;
    this.fs.mkdirSync(temporary, { recursive: false });
    return this.#extract(archive, temporary).then(() => {
      const source = this.#sourceRoot(temporary);
      const templateName = this.#cleanName(name || path.basename(archive, path.extname(archive)));
      destination = path.join(this.directory, `personal-${randomUUID()}`);
      this.#copySafe(source, destination);
      const engine = this.#detectEngine(destination);
      this.#writeMetadata(destination, templateName, engine, 'Mẫu cá nhân được nhập từ ZIP.');
      this.#removeOwned(temporary);
      return this.list().find((template) => template.id === path.basename(destination));
    }).catch((error) => {
      this.#removeOwned(temporary);
      if (destination) this.#removeOwned(destination);
      throw error;
    });
  }

  #cleanName(value) {
    const name = String(value || '').trim().replace(/[\x00-\x1f]/g, '').slice(0, 100);
    if (!name) throw new Error('Tên template không hợp lệ.');
    return name;
  }

  #writeMetadata(directory, name, engine, description) {
    const metadata = { id: path.basename(directory), name, engine, language: 'Tùy chỉnh', description };
    this.fs.writeFileSync(path.join(directory, 'template.json'), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  }

  #allowed(relative) {
    const parts = relative.split(path.sep).filter(Boolean);
    return !parts.some((part) => EXCLUDED_DIRS.has(part.toLowerCase())) && !parts.some((part) => SECRET_FILE.test(part));
  }

  #copySafe(source, destination) {
    let files = 0;
    let bytes = 0;
    const visit = (directory) => {
      for (const entry of this.fs.readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        const relative = path.relative(source, absolute);
        if (!this.#allowed(relative)) continue;
        const stat = this.fs.lstatSync(absolute);
        if (stat.isSymbolicLink()) throw new Error('Template không hỗ trợ symbolic link.');
        if (stat.isDirectory()) visit(absolute);
        else if (stat.isFile()) {
          files += 1;
          bytes += stat.size;
          if (files > MAX_FILES || bytes > MAX_TOTAL_BYTES || stat.size > MAX_FILE_BYTES) {
            throw new Error('Template vượt giới hạn 500 file, 50 MiB tổng hoặc 10 MiB mỗi file.');
          }
        }
      }
    };
    visit(source);
    this.fs.cpSync(source, destination, {
      recursive: true, errorOnExist: true, force: false,
      filter: (candidate) => candidate === source || this.#allowed(path.relative(source, candidate))
    });
  }

  #sourceRoot(temporary) {
    if (this.fs.existsSync(path.join(temporary, 'main.tex'))) return temporary;
    const entries = this.fs.readdirSync(temporary, { withFileTypes: true }).filter((entry) => entry.name !== '__MACOSX');
    if (entries.length === 1 && entries[0].isDirectory()) {
      const nested = path.join(temporary, entries[0].name);
      if (this.fs.existsSync(path.join(nested, 'main.tex'))) return nested;
    }
    throw new Error('ZIP cần có main.tex ở thư mục gốc hoặc trong một thư mục bọc duy nhất.');
  }

  #extract(zipPath, destination) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let files = 0;
      let bytes = 0;
      const fail = (error, zip) => {
        if (settled) return;
        settled = true;
        try { zip?.close(); } catch {}
        reject(error);
      };
      yauzl.open(zipPath, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
        if (error) return fail(error);
        zip.on('error', (zipError) => fail(zipError, zip));
        zip.on('end', () => { if (!settled) { settled = true; resolve(); } });
        zip.on('entry', async (entry) => {
          try {
            const archivePath = entry.fileName;
            if (!archivePath || archivePath.includes('\\') || archivePath.includes('\0') || /^[A-Za-z]:/.test(archivePath) || archivePath.startsWith('/')) {
              throw new Error('ZIP chứa đường dẫn không an toàn.');
            }
            const parts = archivePath.split('/').filter(Boolean);
            const unsafeWindowsName = (part) => /[<>:"|?*\x00-\x1f]/.test(part)
              || /[. ]$/.test(part)
              || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part);
            if (!parts.length || parts.some((part) => part === '.' || part === '..' || unsafeWindowsName(part))) {
              throw new Error('ZIP chứa đường dẫn không an toàn.');
            }
            const relative = parts.join(path.sep);
            const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
            if (mode === 0xa000 || (entry.generalPurposeBitFlag & 1)) throw new Error('ZIP có symlink hoặc entry được mã hóa, không được hỗ trợ.');
            const target = path.resolve(destination, relative);
            if (target !== destination && !target.startsWith(destination + path.sep)) throw new Error('ZIP chứa đường dẫn vượt ra ngoài template.');
            const isDirectory = /\/$/.test(archivePath);
            if (!isDirectory) {
              files += 1;
              bytes += entry.uncompressedSize;
              if (files > MAX_FILES || bytes > MAX_TOTAL_BYTES || entry.uncompressedSize > MAX_FILE_BYTES) {
                throw new Error('ZIP vượt giới hạn 500 file, 50 MiB tổng hoặc 10 MiB mỗi file.');
              }
            }
            if (!this.#allowed(relative)) { zip.readEntry(); return; }
            if (isDirectory) {
              this.fs.mkdirSync(target, { recursive: true });
              zip.readEntry();
              return;
            }
            this.fs.mkdirSync(path.dirname(target), { recursive: true });
            zip.openReadStream(entry, async (streamError, stream) => {
              if (streamError) return fail(streamError, zip);
              try {
                await pipeline(stream, this.fs.createWriteStream(target, { flags: 'wx' }));
                zip.readEntry();
              } catch (writeError) { fail(writeError, zip); }
            });
          } catch (entryError) { fail(entryError, zip); }
        });
        zip.readEntry();
      });
    });
  }

  #detectEngine(directory) {
    try {
      const source = this.fs.readFileSync(path.join(directory, 'main.tex'), 'utf8');
      if (/^\s*%\s*!\s*TeX\s+(?:TS-)?program\s*=\s*xelatex\b/im.test(source)
        || /\\usepackage(?:\[[^\]]*\])?\{fontspec\}/i.test(source)) return 'xelatex';
    } catch {}
    return 'pdflatex';
  }

  #removeOwned(target) {
    const resolved = path.resolve(target);
    if (path.dirname(resolved) !== this.directory || !/^(?:\.import-|personal-)/.test(path.basename(resolved))) return;
    this.fs.rmSync(resolved, { recursive: true, force: true });
  }
}

module.exports = { PersonalTemplateManager };
