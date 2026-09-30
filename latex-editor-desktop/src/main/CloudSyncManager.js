const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { MAX_BYTES } = require('./HistoryManager');

class CloudSyncManager {
  constructor({ cloudDir }, { auth, history, workspace }) {
    this.directory = cloudDir;
    this.auth = auth;
    this.history = history;
    this.workspace = workspace;
    this.busy = false;
  }

  async exclusive(task) {
    if (this.busy) throw new Error('Một lượt đồng bộ đang chạy. Hãy chờ hoàn tất.');
    this.busy = true;
    const user = this.auth.status().user;
    const generation = this.auth.generation;
    if (!user) { this.busy = false; throw new Error('Hãy đăng nhập trước.'); }
    const check = () => {
      if (generation !== this.auth.generation || this.auth.status().user?.id !== user.id) throw new Error('Phiên đăng nhập đã thay đổi; đã dừng đồng bộ.');
    };
    try { return await task(user, check); } finally { this.busy = false; }
  }

  metadataPath(project) { return path.join(this.directory, path.basename(this.history.location(project)) + '.json'); }
  async readMetadata(project) {
    try { return JSON.parse(await fs.readFile(this.metadataPath(project), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async writeMetadata(project, data) {
    await fs.mkdir(this.directory, { recursive: true });
    const file = this.metadataPath(project);
    await fs.writeFile(file + '.tmp', JSON.stringify(data), { mode: 0o600 });
    await fs.rename(file + '.tmp', file);
  }

  async list() {
    return this.exclusive(async (_user, check) => {
      const projects = [];
      let cursor = '';
      const seen = new Set();
      do {
        if (seen.has(cursor)) throw new Error('Danh sách cloud trả về phân trang không hợp lệ.');
        seen.add(cursor);
        const data = await (await this.auth.request('/v1/projects' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''))).json();
        check();
        projects.push(...data.projects);
        cursor = data.cursor || '';
        if (projects.length >= 1000) break;
      } while (cursor);
      return projects;
    });
  }

  upload(project) {
    return this.exclusive(async (user, check) => {
      let metadata = await this.readMetadata(project);
      if (metadata && (metadata.owner !== user.id || metadata.apiUrl !== this.auth.apiUrl)) {
        throw new Error('Project này thuộc tài khoản hoặc dịch vụ cloud khác. Không thể tự chuyển quyền sở hữu.');
      }
      if (!metadata) {
        metadata = { id: crypto.randomUUID(), owner: user.id, apiUrl: this.auth.apiUrl, etag: null };
        await this.writeMetadata(project, metadata);
      }
      await this.history.save(project, 'Lưu trước khi đồng bộ', user);
      const bundle = await this.history.exportBundle(project);
      check();
      let remote = null;
      try { remote = await (await this.auth.request(`/v1/projects/${metadata.id}/meta`)).json(); }
      catch (error) { if (error.status !== 404) throw error; }
      check();
      if (remote?.head === bundle.head) {
        await this.writeMetadata(project, { ...metadata, etag: remote.etag });
        return { status: 'synced', message: 'Project đã đồng bộ.', project: remote };
      }
      if (remote && remote.etag !== metadata.etag) throw new Error('Xung đột: cloud có phiên bản mới từ máy khác. Tải bản cloud thành project riêng để đối chiếu trước khi đồng bộ tiếp.');
      const response = await this.auth.request(`/v1/projects/${metadata.id}`, {
        method: 'PUT', headers: {
          'Content-Type': 'application/x-git-bundle', 'X-Git-Head': bundle.head,
          'X-Project-Name': encodeURIComponent(path.basename(project)),
          ...(remote ? { 'If-Match': remote.etag } : { 'If-None-Match': '*' })
        }, body: bundle.data
      });
      const saved = await response.json();
      check();
      await this.writeMetadata(project, { ...metadata, etag: saved.etag });
      return { status: 'synced', message: 'Đã đồng bộ project và lịch sử lên R2.', project: saved };
    });
  }

  download(id) {
    if (!/^[a-f0-9-]{36}$/.test(id || '')) throw new Error('Mã project cloud không hợp lệ.');
    return this.exclusive(async (user, check) => {
      const response = await this.auth.request(`/v1/projects/${id}`);
      if (Number(response.headers.get('Content-Length')) > MAX_BYTES) throw new Error('Bundle vượt giới hạn 50 MB.');
      const chunks = [];
      let total = 0;
      for await (const chunk of response.body) {
        total += chunk.length;
        if (total > MAX_BYTES) throw new Error('Bundle vượt giới hạn 50 MB.');
        chunks.push(Buffer.from(chunk));
      }
      check();
      const name = this.workspace.sanitizeProjectName(decodeURIComponent(response.headers.get('X-Project-Name') || 'Cloud project'));
      const folder = path.join(this.workspace.projectsDir, `${name.slice(0, 65)}-cloud-${crypto.randomUUID().slice(0, 8)}`);
      await fs.mkdir(folder); // Never overwrite an existing project.
      await this.history.importBundle(folder, Buffer.concat(chunks), response.headers.get('X-Git-Head'));
      check();
      await this.writeMetadata(folder, { id, owner: user.id, apiUrl: this.auth.apiUrl, etag: response.headers.get('ETag') });
      this.workspace.remember(folder);
      return this.workspace.describe(folder);
    });
  }
}

module.exports = { CloudSyncManager };
