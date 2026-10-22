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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'latex-cloud-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = new WorkspaceManager({ projectsDir: path.join(root, 'projects'), settingsFile: path.join(root, 'settings.json'), templateDir: path.resolve(__dirname, '../resources/templates/basic-article') });
  const project = workspace.createProject('Cloud test', 'blank');
  const history = new HistoryManager({ historyDir: path.join(root, 'history') });
  const auth = {
    generation: 0, apiUrl: env.PUBLIC_BASE_URL, user: session.user,
    status() { return { signedIn: true, user: this.user }; },
    async request(route, options = {}) {
      const response = await handleRequest(new Request(env.PUBLIC_BASE_URL + route, { ...options, headers: { ...options.headers, Authorization: `Bearer ${session.token}` } }), env);
      if (!response.ok) { const error = new Error((await response.json()).error); error.status = response.status; throw error; }
      return response;
    }
  };
  const cloud = new CloudSyncManager({ cloudDir: path.join(root, 'cloud') }, { auth, history, workspace });
  return { project, cloud, history, auth, env, handleRequest, root, workspace };
}

test('desktop-to-worker roundtrip restores real project files and complete Git history', async (t) => {
  const { project, cloud, history } = await fixture(t);
  await history.save(project.path, 'Initial version');
  await fs.writeFile(path.join(project.path, 'main.tex'), 'Updated source');
  const uploaded = await cloud.upload(project.path);
  assert.equal(uploaded.status, 'synced');
  assert.equal((await cloud.list()).length, 1);
  const copy = await cloud.download(uploaded.project.id);
  assert.notEqual(copy.path, project.path);
  assert.equal(await fs.readFile(path.join(copy.path, 'main.tex'), 'utf8'), 'Updated source');
  assert.equal((await history.list(copy.path)).length, 2);
  assert.equal((await cloud.upload(copy.path)).status, 'synced');
});

test('publishing uses the newest built PDF, keeps source private, and supports revocation', async (t) => {
  const { project, cloud, env, handleRequest } = await fixture(t);
  await fs.mkdir(path.join(project.path, 'build'));
  await fs.writeFile(path.join(project.path, 'build', 'main.pdf'), '%PDF-1.7\ndesktop result\n%%EOF');

  const published = await cloud.publishPdf(project.path, 30);
  assert.match(published.url, /^https:\/\/cloud\.example\.test\/p\//);
  assert.equal(published.filename, 'main.pdf');
  assert.match(published.sourceHead, /^[a-f0-9]{40}$/);
  const publicResponse = await handleRequest(new Request(published.url), env);
  assert.equal(publicResponse.status, 200);
  assert.match(await publicResponse.text(), /desktop result/);

  const metadata = await cloud.getPublication(project.path);
  assert.equal(metadata.url, published.url);
  await cloud.revokePublication(project.path);
  assert.equal(await cloud.getPublication(project.path), null);
  assert.equal((await handleRequest(new Request(published.url), env)).status, 404);
});

test('publishing fails locally when no successful PDF build exists', async (t) => {
  const { project, cloud } = await fixture(t);
  await assert.rejects(cloud.publishPdf(project.path, 30), /Chưa tìm thấy PDF đã build/);
});

test('two-device conflict preserves both local work and the remote version', async (t) => {
  const { project, cloud } = await fixture(t);
  const first = await cloud.upload(project.path);
  const secondDevice = await cloud.download(first.project.id);
  await fs.writeFile(path.join(project.path, 'main.tex'), 'Machine one change');
  const updated = await cloud.upload(project.path);
  await fs.writeFile(path.join(secondDevice.path, 'main.tex'), 'Machine two change');
  await assert.rejects(cloud.upload(secondDevice.path), /Xung đột/);
  assert.equal(await fs.readFile(path.join(secondDevice.path, 'main.tex'), 'utf8'), 'Machine two change');
  assert.equal((await cloud.list())[0].head, updated.project.head);
});

test('switching accounts does not reassign a local project to another cloud account', async (t) => {
  const { project, cloud, auth } = await fixture(t);
  await cloud.upload(project.path);
  auth.generation += 1;
  auth.user = { id: 'google-other', name: 'Other account' };
  await assert.rejects(cloud.upload(project.path), /tài khoản hoặc dịch vụ cloud khác/);
});

test('session changes during listing cannot expose results under another account', async (t) => {
  const { cloud, auth } = await fixture(t);
  const original = auth.request.bind(auth);
  auth.request = async (...args) => { const response = await original(...args); auth.generation += 1; return response; };
  await assert.rejects(cloud.list(), /Phiên đăng nhập đã thay đổi/);
});

test('owner can manage team: list members, invite by email and link, accept, collaborate, and remove member', async (t) => {
  const { project, cloud, env, handleRequest, history } = await fixture(t);
  const { signedIn } = await import('../../latex-editor-cloud/test/support.js');

  // Unsynced project fails gracefully
  await assert.rejects(cloud.listMembers(project.path), /chưa được đồng bộ lên cloud/);

  // Sync project
  await history.save(project.path, 'Initial');
  const uploaded = await cloud.upload(project.path);

  // Meta & members
  const meta = await cloud.getProjectMeta(project.path);
  assert.equal(meta.role, 'owner');
  const members = await cloud.listMembers(project.path);
  assert.equal(members.length, 1);
  assert.equal(members[0].role, 'owner');

  // Invite by email
  const emailInvite = await cloud.invite(project.path, { email: 'collaborator@example.test', role: 'editor' });
  assert.ok(emailInvite.invitation.id);

  // Pending invitations
  let invs = await cloud.listInvitations(project.path);
  assert.equal(invs.length, 1);
  assert.equal(invs[0].email, 'collaborator@example.test');

  // Revoke invitation
  await cloud.revokeInvitation(project.path, emailInvite.invitation.id);
  invs = await cloud.listInvitations(project.path);
  assert.equal(invs[0].status, 'revoked');

  // Invite by link
  const linkInvite = await cloud.invite(project.path, { role: 'editor' });
  assert.ok(linkInvite.invitation.id);
  assert.ok(linkInvite.invitation.token);

  // Second user signs in and collaborates
  const userTwo = (await signedIn(handleRequest, env, 'user-two')).session;
  const userTwoAuth = {
    generation: 0, apiUrl: env.PUBLIC_BASE_URL, user: userTwo.user,
    status() { return { signedIn: true, user: this.user }; },
    async request(route, options = {}) {
      const response = await handleRequest(new Request(env.PUBLIC_BASE_URL + route, { ...options, headers: { ...options.headers, Authorization: `Bearer ${userTwo.token}` } }), env);
      if (!response.ok) { const error = new Error((await response.json()).error); error.status = response.status; throw error; }
      return response;
    }
  };
  const userTwoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'latex-user2-'));
  t.after(() => fs.rm(userTwoRoot, { recursive: true, force: true }));
  const userTwoWorkspace = new WorkspaceManager({ projectsDir: path.join(userTwoRoot, 'projects'), settingsFile: path.join(userTwoRoot, 'settings.json'), templateDir: path.resolve(__dirname, '../resources/templates/basic-article') });
  const userTwoHistory = new HistoryManager({ historyDir: path.join(userTwoRoot, 'history') });
  const userTwoCloud = new CloudSyncManager({ cloudDir: path.join(userTwoRoot, 'cloud') }, { auth: userTwoAuth, history: userTwoHistory, workspace: userTwoWorkspace });

  await assert.rejects(userTwoCloud.acceptInvitation(linkInvite.invitation.id, 'x'.repeat(43)), /Token lời mời không hợp lệ/);
  const linkAccept = await userTwoCloud.acceptInvitation(linkInvite.invitation.id, linkInvite.invitation.token);
  assert.equal(linkAccept.accepted, true);
  await cloud.removeMember(project.path, userTwo.user.id);

  // Owner invites user 2 by email
  const inviteForUserTwo = await cloud.invite(project.path, { email: userTwo.user.email, role: 'editor' });
  assert.ok(inviteForUserTwo.invitation.id);

  // User 2 checks their received invitations
  const received = await userTwoCloud.myInvitations();
  assert.equal(received.length, 1);
  assert.equal(received[0].id, inviteForUserTwo.invitation.id);
  assert.equal(received[0].projectId, uploaded.project.id);

  // User 2 accepts invitation
  const accept = await userTwoCloud.acceptInvitation(inviteForUserTwo.invitation.id);
  assert.equal(accept.accepted, true);

  // Received invitations is now empty
  const afterAccept = await userTwoCloud.myInvitations();
  assert.equal(afterAccept.length, 0);

  // User 2 downloads shared project
  const downloaded = await userTwoCloud.download(uploaded.project.id);
  assert.ok(downloaded.path);

  // User 2 edits and uploads
  await fs.writeFile(path.join(downloaded.path, 'main.tex'), 'Collaborator edits');
  const u2Upload = await userTwoCloud.upload(downloaded.path);
  assert.equal(u2Upload.status, 'synced');

  // Owner refreshes the same local project and sees B's cloud commit without
  // replacing files currently open in the editor.
  const ownerWorkingFile = await fs.readFile(path.join(project.path, 'main.tex'), 'utf8');
  const refreshed = await cloud.refreshHistory(project.path);
  assert.equal(refreshed.updated, true);
  assert.equal((await history.list(project.path))[0].hash, u2Upload.project.head);
  assert.equal(await fs.readFile(path.join(project.path, 'main.tex'), 'utf8'), ownerWorkingFile);

  // Owner sees 2 members now
  const updatedMembers = await cloud.listMembers(project.path);
  assert.equal(updatedMembers.length, 2);

  // Owner removes user 2
  await cloud.removeMember(project.path, userTwo.user.id);
  const afterRemove = await cloud.listMembers(project.path);
  assert.equal(afterRemove.length, 1);
});

test('owner can delete cloud project by project path or by id; local files remain untouched', async (t) => {
  const { project, cloud, history } = await fixture(t);

  // Unsynced delete fails
  await assert.rejects(cloud.deleteProject(project.path), /chưa được đồng bộ lên cloud/);

  // Upload project
  const initialTex = await fs.readFile(path.join(project.path, 'main.tex'), 'utf8');
  await history.save(project.path, 'Initial commit');
  const uploaded = await cloud.upload(project.path);
  assert.equal((await cloud.list()).length, 1);
  assert.ok(await cloud.readMetadata(project.path));

  // Delete project
  const result = await cloud.deleteProject(project.path);
  assert.equal(result.deleted, true);
  assert.equal(result.projectId, uploaded.project.id);

  // Cloud list is now empty
  assert.equal((await cloud.list()).length, 0);

  // Local metadata file was removed
  assert.equal(await cloud.readMetadata(project.path), null);

  // Local files and history remain intact!
  assert.equal(await fs.readFile(path.join(project.path, 'main.tex'), 'utf8'), initialTex);
  assert.equal((await history.list(project.path)).length, 1);
});

