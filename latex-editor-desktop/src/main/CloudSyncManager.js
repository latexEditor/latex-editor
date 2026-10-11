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
      await fs.mkdir(folder, { recursive: true }); // Never overwrite an existing project.
      await this.history.importBundle(folder, Buffer.concat(chunks), response.headers.get('X-Git-Head'));
      check();
      await this.writeMetadata(folder, { id, owner: user.id, apiUrl: this.auth.apiUrl, etag: response.headers.get('ETag') });
      this.workspace.remember(folder);
      return this.workspace.describe(folder);
    });
  }

  async getProjectMeta(project) {
    return this.exclusive(async (user, check) => {
      const metadata = await this.readMetadata(project);
      if (!metadata) return null;
      if (metadata.apiUrl !== this.auth.apiUrl) {
        throw new Error('Project này thuộc tài khoản hoặc dịch vụ cloud khác.');
      }
      try {
        const response = await this.auth.request(`/v1/projects/${metadata.id}/meta`);
        return await response.json();
      } catch (error) {
        if (error.status === 404) return null;
        if (error.status === 403) {
          throw new Error('Project này thuộc tài khoản hoặc dịch vụ cloud khác.');
        }
        throw error;
      }
    });
  }

  async listMembers(project) {
    return this.exclusive(async (user, check) => {
      const metadata = await this.readMetadata(project);
      if (!metadata) throw new Error('Project này chưa được đồng bộ lên cloud.');
      if (metadata.apiUrl !== this.auth.apiUrl) {
        throw new Error('Project này thuộc tài khoản hoặc dịch vụ cloud khác.');
      }
      try {
        const response = await this.auth.request(`/v1/projects/${metadata.id}/members`);
        return (await response.json()).members;
      } catch (error) {
        if (error.status === 404) throw new Error('Project này chưa được đồng bộ lên cloud.');
        if (error.status === 403) throw new Error('Project này thuộc tài khoản hoặc dịch vụ cloud khác.');
        throw error;
      }
    });
  }

  async invite(project, { email, role }) {
    return this.exclusive(async (user, check) => {
      const metadata = await this.readMetadata(project);
      if (!metadata) throw new Error('Project này chưa được đồng bộ lên cloud.');
      if (metadata.apiUrl !== this.auth.apiUrl) {
        throw new Error('Project này thuộc tài khoản hoặc dịch vụ cloud khác.');
      }
      const body = { role: role || 'editor' };
      if (email && email.trim()) body.email = email.trim();
      const response = await this.auth.request(`/v1/projects/${metadata.id}/invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      return await response.json();
    });
  }

  async listInvitations(project) {
    return this.exclusive(async (user, check) => {
      const metadata = await this.readMetadata(project);
      if (!metadata) throw new Error('Project này chưa được đồng bộ lên cloud.');
      if (metadata.apiUrl !== this.auth.apiUrl) {
        throw new Error('Project này thuộc tài khoản hoặc dịch vụ cloud khác.');
      }
      const response = await this.auth.request(`/v1/projects/${metadata.id}/invitations`);
      return (await response.json()).invitations;
    });
  }

  async revokeInvitation(project, invitationId) {
    return this.exclusive(async (user, check) => {
      const metadata = await this.readMetadata(project);
      if (!metadata) throw new Error('Project này chưa được đồng bộ lên cloud.');
      if (metadata.apiUrl !== this.auth.apiUrl) {
        throw new Error('Project này thuộc tài khoản hoặc dịch vụ cloud khác.');
      }
      const response = await this.auth.request(`/v1/projects/${metadata.id}/invitations/${invitationId}/revoke`, {
        method: 'POST'
      });
      return await response.json();
    });
  }

  async removeMember(project, memberUserId) {
    return this.exclusive(async (user, check) => {
      const metadata = await this.readMetadata(project);
      if (!metadata) throw new Error('Project này chưa được đồng bộ lên cloud.');
      if (metadata.apiUrl !== this.auth.apiUrl) {
        throw new Error('Project này thuộc tài khoản hoặc dịch vụ cloud khác.');
      }
      const response = await this.auth.request(`/v1/projects/${metadata.id}/members/${encodeURIComponent(memberUserId)}`, {
        method: 'DELETE'
      });
      return await response.json();
    });
  }

  async acceptInvitation(invitationId, token) {
    return this.exclusive(async (user, check) => {
      if (!/^[a-f0-9-]{36}$/.test(invitationId || '')) throw new Error('Mã lời mời không hợp lệ.');
      const response = await this.auth.request(`/v1/invitations/${invitationId}/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
      });
      return await response.json();
    });
  }

  async myInvitations() {
    const user = this.auth.status().user;
    if (!user) throw new Error('Hãy đăng nhập trước.');
    const response = await this.auth.request('/v1/my-invitations');
    return (await response.json()).invitations;
  }

  async declineInvitation(invitationId) {
    if (!/^[a-f0-9-]{36}$/.test(invitationId || '')) throw new Error('Mã lời mời không hợp lệ.');
    const user = this.auth.status().user;
    if (!user) throw new Error('Hãy đăng nhập trước.');
    const response = await this.auth.request(`/v1/invitations/${invitationId}/decline`, {
      method: 'POST'
    });
    return await response.json();
  }

  async deleteProjectById(id) {
    if (!/^[a-f0-9-]{36}$/.test(id || '')) throw new Error('Mã project cloud không hợp lệ.');
    return this.exclusive(async (user, check) => {
      const response = await this.auth.request(`/v1/projects/${id}`, {
        method: 'DELETE'
      });
      const result = await response.json();
      check();
      try {
        const files = await fs.readdir(this.directory);
        for (const file of files) {
          if (file.endsWith('.json')) {
            const fullPath = path.join(this.directory, file);
            try {
              const meta = JSON.parse(await fs.readFile(fullPath, 'utf8'));
              if (meta && meta.id === id) {
                await fs.unlink(fullPath);
              }
            } catch {}
          }
        }
      } catch {}
      return result;
    });
  }

  async deleteProject(project) {
    const metadata = await this.readMetadata(project);
    if (!metadata) throw new Error('Project này chưa được đồng bộ lên cloud.');
    if (metadata.apiUrl !== this.auth.apiUrl) {
      throw new Error('Project này thuộc tài khoản hoặc dịch vụ cloud khác.');
    }
    const result = await this.deleteProjectById(metadata.id);
    try {
      await fs.unlink(this.metadataPath(project));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    return result;
  }

  async listCloudTemplates() {
    return this.exclusive(async (user, check) => {
      const response = await this.auth.request('/v1/templates');
      check();
      const data = await response.json();
      return data.templates || [];
    });
  }

  async uploadTemplate(templateId) {
    if (!/^personal-[0-9a-f-]{36}$/i.test(templateId || '')) throw new Error('Mã template không hợp lệ.');
    return this.exclusive(async (user, check) => {
      const template = this.workspace.personalTemplates.exportZipBuffer(templateId);
      check();
      const response = await this.auth.request(`/v1/templates/${templateId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/zip',
          'X-Template-Name': encodeURIComponent(template.name),
          'X-Template-Engine': template.engine,
          'X-Template-Description': encodeURIComponent(template.description || '')
        },
        body: template.buffer
      });
      check();
      return await response.json();
    });
  }

  async downloadTemplate(templateId) {
    if (!/^personal-[0-9a-f-]{36}$/i.test(templateId || '')) throw new Error('Mã template không hợp lệ.');
    return this.exclusive(async (user, check) => {
      const response = await this.auth.request(`/v1/templates/${templateId}`);
      check();
      const name = decodeURIComponent(response.headers.get('X-Template-Name') || '');
      const chunks = [];
      let total = 0;
      for await (const chunk of response.body) {
        total += chunk.length;
        if (total > MAX_BYTES) throw new Error('Template vượt giới hạn 50 MB.');
        chunks.push(Buffer.from(chunk));
      }
      check();
      const buffer = Buffer.concat(chunks);
      return await this.workspace.personalTemplates.importFromBuffer(buffer, name, templateId);
    });
  }

  async deleteCloudTemplate(templateId) {
    if (!/^personal-[0-9a-f-]{36}$/i.test(templateId || '')) throw new Error('Mã template không hợp lệ.');
    return this.exclusive(async (user, check) => {
      const response = await this.auth.request(`/v1/templates/${templateId}`, {
        method: 'DELETE'
      });
      check();
      return await response.json();
    });
  }

  async syncAllTemplates() {
    return this.exclusive(async (user, check) => {
      const cloudList = (await (await this.auth.request('/v1/templates')).json()).templates || [];
      check();
      const cloudMap = new Map(cloudList.map((t) => [t.id, t]));
      const localList = this.workspace.personalTemplates.list();
      const localMap = new Map(localList.map((t) => [t.id, t]));

      let uploaded = 0;
      let downloaded = 0;

      // Upload local templates missing from cloud
      for (const local of localList) {
        if (!cloudMap.has(local.id)) {
          const template = this.workspace.personalTemplates.exportZipBuffer(local.id);
          check();
          await this.auth.request(`/v1/templates/${local.id}`, {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/zip',
              'X-Template-Name': encodeURIComponent(template.name),
              'X-Template-Engine': template.engine,
              'X-Template-Description': encodeURIComponent(template.description || '')
            },
            body: template.buffer
          });
          uploaded += 1;
        }
      }

      // Download cloud templates missing from local
      for (const cloud of cloudList) {
        if (!localMap.has(cloud.id)) {
          const response = await this.auth.request(`/v1/templates/${cloud.id}`);
          check();
          const name = decodeURIComponent(response.headers.get('X-Template-Name') || cloud.name);
          const chunks = [];
          for await (const chunk of response.body) chunks.push(Buffer.from(chunk));
          const buffer = Buffer.concat(chunks);
          check();
          await this.workspace.personalTemplates.importFromBuffer(buffer, name, cloud.id);
          downloaded += 1;
        }
      }

      return {
        uploaded,
        downloaded,
        total: (this.workspace.personalTemplates.list()).length
      };
    });
  }
}

module.exports = { CloudSyncManager };


