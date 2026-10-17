const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { WorkspaceManager } = require('../src/main/WorkspaceManager');
const { HistoryManager } = require('../src/main/HistoryManager');
const { CloudSyncManager } = require('../src/main/CloudSyncManager');

async function fixture(t) {
  const { handleRequest } = await import('../../latex-editor-cloud/src/index.js');
  const { environment, signedIn } = await import('../../latex-editor-cloud/test/support.js');
  const env = environment();
  const { session } = await signedIn(handleRequest, env);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'latex-template-cloud-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const templateDir = path.resolve(__dirname, '../resources/templates/basic-article');
  const workspace = new WorkspaceManager({
    projectsDir: path.join(root, 'projects'),
    settingsFile: path.join(root, 'settings.json'),
    templateDir,
    personalTemplatesDir: path.join(root, 'templates')
  });
  workspace.initialize();

  const history = new HistoryManager({ historyDir: path.join(root, 'history') });
  const auth = {
    generation: 0, apiUrl: env.PUBLIC_BASE_URL, user: session.user,
    status() { return { signedIn: true, user: this.user }; },
    async request(route, options = {}) {
      const response = await handleRequest(new Request(env.PUBLIC_BASE_URL + route, {
        ...options,
        headers: { ...options.headers, Authorization: `Bearer ${session.token}` }
      }), env);
      if (!response.ok) {
        const error = new Error((await response.json().catch(() => ({}))).error || 'Request failed');
        error.status = response.status;
        throw error;
      }
      return response;
    }
  };

  const cloud = new CloudSyncManager({ cloudDir: path.join(root, 'cloud') }, { auth, history, workspace });
  return { workspace, cloud, auth, root };
}

test('PersonalTemplateManager: exportZipBuffer, deleteTemplate, and importFromBuffer roundtrip', async (t) => {
  const { workspace } = await fixture(t);
  const project = workspace.createProject('My Template Project', 'blank');
  await fs.writeFile(path.join(project.path, 'main.tex'), '\\documentclass{article}\n\\begin{document}\nCustom Template Content\n\\end{document}');

  // Save project as personal template
  const saved = workspace.saveProjectAsTemplate(project.path, 'Báo Cáo Nghiên Cứu');
  assert.ok(saved.id.startsWith('personal-'));
  assert.equal(saved.name, 'Báo Cáo Nghiên Cứu');

  // Export to ZIP buffer
  const exported = workspace.personalTemplates.exportZipBuffer(saved.id);
  assert.equal(exported.id, saved.id);
  assert.equal(exported.name, 'Báo Cáo Nghiên Cứu');
  assert.ok(exported.buffer.length > 50);

  // Delete local template
  const delResult = workspace.deletePersonalTemplate(saved.id);
  assert.equal(delResult.deleted, true);
  assert.equal(workspace.personalTemplates.resolve(saved.id), null);

  // Re-import from buffer with original ID preserved
  const imported = await workspace.personalTemplates.importFromBuffer(exported.buffer, 'Báo Cáo Nghiên Cứu', saved.id);
  assert.equal(imported.id, saved.id);
  const reResolved = workspace.personalTemplates.resolve(saved.id);
  assert.ok(reResolved);
  const content = await fs.readFile(path.join(reResolved, 'main.tex'), 'utf8');
  assert.match(content, /Custom Template Content/);
});

test('CloudSyncManager: upload, list, download, and delete personal template on Cloudflare R2', async (t) => {
  const { workspace, cloud } = await fixture(t);
  const project = workspace.createProject('Cloud Template Test', 'blank');
  await fs.writeFile(path.join(project.path, 'main.tex'), '\\documentclass{article}\n\\begin{document}\nCloud Synced Template\n\\end{document}');

  // Save local template
  const localTemplate = workspace.saveProjectAsTemplate(project.path, 'Luận Văn Mẫu');
  assert.ok(localTemplate.id);

  // Initially cloud template list is empty
  let cloudList = await cloud.listCloudTemplates();
  assert.equal(cloudList.length, 0);

  // Upload template to Cloud
  const uploadRes = await cloud.uploadTemplate(localTemplate.id);
  assert.equal(uploadRes.id, localTemplate.id);
  assert.equal(uploadRes.name, 'Luận Văn Mẫu');

  // Cloud list now contains template
  cloudList = await cloud.listCloudTemplates();
  assert.equal(cloudList.length, 1);
  assert.equal(cloudList[0].id, localTemplate.id);
  assert.equal(cloudList[0].name, 'Luận Văn Mẫu');

  // Delete local template to simulate another clean machine
  workspace.deletePersonalTemplate(localTemplate.id);
  assert.equal(workspace.personalTemplates.resolve(localTemplate.id), null);

  // Download template from cloud
  const downloaded = await cloud.downloadTemplate(localTemplate.id);
  assert.equal(downloaded.id, localTemplate.id);
  assert.equal(downloaded.name, 'Luận Văn Mẫu');
  const restoredPath = workspace.personalTemplates.resolve(localTemplate.id);
  assert.ok(restoredPath);
  assert.match(await fs.readFile(path.join(restoredPath, 'main.tex'), 'utf8'), /Cloud Synced Template/);

  // Delete template from cloud
  const delCloudRes = await cloud.deleteCloudTemplate(localTemplate.id);
  assert.equal(delCloudRes.deleted, true);
  assert.equal((await cloud.listCloudTemplates()).length, 0);

  // Local template remains on disk after cloud deletion
  assert.ok(workspace.personalTemplates.resolve(localTemplate.id));
});

test('CloudSyncManager: syncAllTemplates two-way synchronizes templates', async (t) => {
  const { workspace, cloud } = await fixture(t);
  const project = workspace.createProject('Sync Test Project', 'blank');
  const tpl = workspace.saveProjectAsTemplate(project.path, 'Mẫu Báo Cáo Tháng');

  // Initially not on cloud
  assert.equal((await cloud.listCloudTemplates()).length, 0);

  // syncAllTemplates uploads local template to cloud
  const syncResult1 = await cloud.syncAllTemplates();
  assert.equal(syncResult1.uploaded, 1);
  assert.equal(syncResult1.downloaded, 0);
  assert.equal((await cloud.listCloudTemplates()).length, 1);

  // Calling syncAllTemplates again does nothing (already in sync)
  const syncResult2 = await cloud.syncAllTemplates();
  assert.equal(syncResult2.uploaded, 0);
  assert.equal(syncResult2.downloaded, 0);
});

test('editing and cloud download preserve description, language, compiler and preview', async (t) => {
  const { workspace, cloud } = await fixture(t);
  const project = workspace.createProject('Metadata roundtrip', 'blank');
  const template = workspace.saveProjectAsTemplate(project.path, 'Before');
  const png = await fs.readFile(path.resolve(__dirname, '../resources/templates/basic-article/preview.png'));
  const previewDataUrl = `data:image/png;base64,${png.toString('base64')}`;
  workspace.personalTemplates.updateMetadata(template.id, {
    name: 'Mẫu đã chỉnh sửa', description: 'Mô tả giữ qua cloud', language: 'Tiếng Việt', engine: 'xelatex', previewDataUrl
  });
  await cloud.uploadTemplate(template.id);
  workspace.deletePersonalTemplate(template.id);
  const downloaded = await cloud.downloadTemplate(template.id);
  assert.equal(downloaded.name, 'Mẫu đã chỉnh sửa');
  assert.equal(downloaded.description, 'Mô tả giữ qua cloud');
  assert.equal(downloaded.language, 'Tiếng Việt');
  assert.equal(downloaded.engine, 'xelatex');
  assert.equal(downloaded.previewDataUrl, previewDataUrl);
});
