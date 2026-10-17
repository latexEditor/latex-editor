const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { crc32, deflateRawSync } = require('node:zlib');
const yauzl = require('yauzl');

const MAX_FILES = 500;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const EXCLUDED_DIRS = new Set(['.git', '.latex-editor', '.vscode', 'build', 'node_modules']);
const SECRET_FILE = /^(?:\.env(?:\..*)?|.*\.(?:pem|key|p12))$/i;
const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;

function validatePreviewPng(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 57 || bytes.length > MAX_PREVIEW_BYTES
    || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || bytes.toString('ascii', 12, 16) !== 'IHDR' || bytes.readUInt32BE(8) !== 13
    || bytes.toString('ascii', bytes.length - 8, bytes.length - 4) !== 'IEND') {
    throw new Error('Ảnh xem trước phải là PNG hợp lệ, tối đa 2 MiB.');
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!width || !height || width > 4096 || height > 4096) throw new Error('Ảnh xem trước tối đa 4096 × 4096 pixel.');
  return bytes;
}

function buildZip(files) {
  const localHeaders = [];
  const centralHeaders = [];
  let offset = 0;
  for (const file of files) {
    const nameBuf = Buffer.from(file.path.replace(/\\/g, '/'), 'utf8');
    const uncompressedSize = file.data.length;
    const crc = crc32(file.data);
    const compressed = deflateRawSync(file.data);
    const compressedSize = compressed.length;

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressedSize, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);
    localHeaders.push(local, compressed);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressedSize, 20);
    central.writeUInt32LE(uncompressedSize, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    centralHeaders.push(central);
    offset += local.length + compressedSize;
  }
  const centralDirSize = centralHeaders.reduce((sum, h) => sum + h.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralDirSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...localHeaders, ...centralHeaders, eocd]);
}

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

  deleteTemplate(templateId) {
    const target = this.resolve(templateId);
    if (!target) throw new Error('Không tìm thấy template.');
    this.#removeOwned(target);
    return { deleted: true, templateId };
  }

  updateMetadata(templateId, changes) {
    const target = this.resolve(templateId);
    if (!target) throw new Error('Không tìm thấy template cá nhân.');
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)
      || Object.keys(changes).some((key) => !['name', 'description', 'language', 'engine', 'previewDataUrl'].includes(key))) {
      throw new Error('Thông tin template không hợp lệ.');
    }
    const old = JSON.parse(this.fs.readFileSync(path.join(target, 'template.json'), 'utf8'));
    const name = this.#cleanName(changes.name ?? old.name);
    const description = this.#cleanText(changes.description ?? old.description ?? '', 500);
    const language = this.#cleanText(changes.language ?? old.language ?? 'Tùy chỉnh', 80) || 'Tùy chỉnh';
    const engine = changes.engine ?? old.engine ?? 'pdflatex';
    if (!['pdflatex', 'xelatex'].includes(engine)) throw new Error('Compiler của template không hợp lệ.');
    let preview;
    if (changes.previewDataUrl !== undefined && changes.previewDataUrl !== null) {
      const value = changes.previewDataUrl;
      if (typeof value !== 'string' || value.length > MAX_PREVIEW_BYTES * 1.4 || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) {
        throw new Error('Ảnh xem trước không hợp lệ.');
      }
      preview = validatePreviewPng(Buffer.from(value.slice('data:image/png;base64,'.length), 'base64'));
    }
    const staged = path.join(this.directory, `.import-edit-${randomUUID()}`);
    try {
      this.#copySafe(target, staged);
      if (preview) this.fs.writeFileSync(path.join(staged, 'preview.png'), preview);
      else if (changes.previewDataUrl === null) this.fs.rmSync(path.join(staged, 'preview.png'), { force: true });
      this.#writeMetadata(staged, name, engine, description, { id: templateId, language });
      this.#replace(staged, target);
      return this.list().find((template) => template.id === templateId);
    } finally { this.#removeOwned(staged); }
  }

  exportZipBuffer(templateId) {
    const target = this.resolve(templateId);
    if (!target) throw new Error('Không tìm thấy template.');
    const metadata = JSON.parse(this.fs.readFileSync(path.join(target, 'template.json'), 'utf8'));

    const files = [];
    const collect = (dir) => {
      for (const entry of this.fs.readdirSync(dir, { withFileTypes: true })) {
        const absolute = path.join(dir, entry.name);
        const relative = path.relative(target, absolute);
        if (!this.#allowed(relative)) continue;
        const stat = this.fs.statSync(absolute);
        if (stat.isDirectory()) {
          collect(absolute);
        } else if (stat.isFile()) {
          files.push({
            path: relative,
            data: this.fs.readFileSync(absolute)
          });
        }
      }
    };
    collect(target);
    const buffer = buildZip(files);
    return {
      id: templateId,
      name: metadata.name,
      engine: metadata.engine || 'pdflatex',
      description: metadata.description || '',
      buffer
    };
  }

  async importFromBuffer(buffer, name = '', targetId = null) {
    if (!Buffer.isBuffer(buffer) || buffer.length > MAX_TOTAL_BYTES) {
      throw new Error('Dữ liệu template không hợp lệ hoặc vượt quá 50 MiB.');
    }
    this.initialize();
    const tempFile = path.join(this.directory, `.import-temp-${randomUUID()}.zip`);
    this.fs.writeFileSync(tempFile, buffer);
    try {
      return await this.importZip(tempFile, name, targetId);
    } finally {
      this.#removeOwned(tempFile);
    }
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

  importZip(zipPath, name, targetId = null) {
    if (targetId !== null && !/^personal-[0-9a-f-]{36}$/i.test(targetId)) throw new Error('Mã template không hợp lệ.');
    const archive = path.resolve(zipPath);
    if (!/\.zip$/i.test(archive) || !this.fs.statSync(archive).isFile()) throw new Error('Hãy chọn một file ZIP hợp lệ.');
    if (this.fs.statSync(archive).size > MAX_TOTAL_BYTES) throw new Error('ZIP vượt quá giới hạn 50 MiB.');
    this.initialize();
    const temporary = path.join(this.directory, `.import-${randomUUID()}`);
    let destination = null;
    let ready = null;
    this.fs.mkdirSync(temporary, { recursive: false });
    return this.#extract(archive, temporary).then(() => {
      const source = this.#sourceRoot(temporary);
      let embedded = {};
      const metadataFile = path.join(source, 'template.json');
      if (this.fs.existsSync(metadataFile)) {
        if (this.fs.statSync(metadataFile).size > 16384) throw new Error('Metadata template vượt giới hạn.');
        embedded = JSON.parse(this.fs.readFileSync(metadataFile, 'utf8'));
      }
      const templateName = this.#cleanName(name || embedded.name || path.basename(archive, path.extname(archive)));
      destination = path.join(this.directory, targetId || `personal-${randomUUID()}`);
      ready = path.join(this.directory, `.import-ready-${randomUUID()}`);
      this.#copySafe(source, ready);
      const engine = ['pdflatex', 'xelatex'].includes(embedded.engine) ? embedded.engine : this.#detectEngine(ready);
      this.#writeMetadata(ready, templateName, engine,
        this.#cleanText(embedded.description ?? 'Mẫu cá nhân được nhập từ ZIP.', 500),
        { id: path.basename(destination), language: this.#cleanText(embedded.language ?? 'Tùy chỉnh', 80) || 'Tùy chỉnh' });
      this.#replace(ready, destination);
      this.#removeOwned(temporary);
      return this.list().find((template) => template.id === path.basename(destination));
    }).catch((error) => {
      this.#removeOwned(temporary);
      if (ready) this.#removeOwned(ready);
      throw error;
    });
  }

  #cleanName(value) {
    const name = String(value || '').trim().replace(/[\x00-\x1f]/g, '').slice(0, 100);
    if (!name) throw new Error('Tên template không hợp lệ.');
    return name;
  }

  #cleanText(value, limit) {
    if (typeof value !== 'string' || value.length > limit) throw new Error(`Thông tin template phải là văn bản tối đa ${limit} ký tự.`);
    return value.trim().replace(/[\x00-\x08\x0b-\x1f]/g, '');
  }

  #replace(staged, destination) {
    const backup = path.join(this.directory, `.import-backup-${randomUUID()}`);
    const existed = this.fs.existsSync(destination);
    if (existed) this.fs.renameSync(destination, backup);
    try { this.fs.renameSync(staged, destination); }
    catch (error) {
      if (existed) this.fs.renameSync(backup, destination);
      throw error;
    }
    if (existed) {
      // Publishing succeeded. A transient antivirus lock on the old directory
      // must not turn a successful update into a misleading failure.
      try { this.#removeOwned(backup); } catch {}
    }
  }

  #writeMetadata(directory, name, engine, description, extra = {}) {
    const metadata = { id: extra.id || path.basename(directory), name, engine, language: extra.language || 'Tùy chỉnh', description };
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
    this.fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 });
  }
}

module.exports = { PersonalTemplateManager, validatePreviewPng };
