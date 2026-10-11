import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { handleRequest } from '../src/index.js';
import { ProjectCollaborationRoom } from '../src/collaboration-room.js';
import { environment, signedIn } from './support.js';

const id = '11111111-1111-4111-8111-111111111111';
const head = 'a'.repeat(40);
function request(env, token, route, options = {}) {
  return handleRequest(new Request(env.PUBLIC_BASE_URL + route, { ...options, headers: { Authorization: `Bearer ${token}`, ...options.headers } }), env);
}
function upload(updatedAt) {
  return { method: 'PUT', headers: { 'X-Git-Head': head, 'X-Project-Name': encodeURIComponent('Báo cáo'), ...(updatedAt ? { 'If-Match': updatedAt } : { 'If-None-Match': '*' }) }, body: `# v2 git bundle\n${head} refs/heads/main\n\nPACK-test-fixture` };
}

test('Google authorization uses PKCE; exchange is one-time and logout invalidates the session', async () => {
  const env = environment();
  const login = await signedIn(handleRequest, env);
  assert.equal(login.session.user.id, 'google-user-one');
  assert.equal((await login.exchange()).status, 400);
  assert.equal((await request(env, login.session.token, '/v1/me')).status, 200);
  assert.equal((await request(env, login.session.token, '/auth/logout', { method: 'POST' })).status, 200);
  assert.equal((await request(env, login.session.token, '/v1/me')).status, 401);
});

test('projects are isolated per account via D1 membership', async () => {
  const env = environment();
  const first = (await signedIn(handleRequest, env, 'one')).session;
  const second = (await signedIn(handleRequest, env, 'two')).session;
  const saved = await request(env, first.token, `/v1/projects/${id}`, upload());
  assert.equal(saved.status, 200);
  assert.equal((await request(env, second.token, `/v1/projects/${id}`)).status, 403);
  assert.deepEqual((await (await request(env, second.token, '/v1/projects')).json()).projects, []);
  const download = await request(env, first.token, `/v1/projects/${id}`);
  assert.match(await download.text(), /PACK-test-fixture/);
  assert.equal(download.headers.get('X-Git-Head'), head);
});

test('OAuth requests work with legacy workerd redirect modes and never follow provider redirects', async () => {
  for (const redirectAt of [null, '/token', '/userinfo']) {
    const calls = [];
    const handler = (request, env, fixtureFetch) => handleRequest(request, env, async (url, options) => {
      // Reproduce the Request validation in workerd shipped with Wrangler 4.120.
      if (!['follow', 'manual'].includes(options.redirect)) throw new TypeError('Invalid redirect value');
      assert.equal(options.redirect, 'manual', 'OAuth secrets must not follow a redirected request');
      calls.push(url);
      if (redirectAt && url.endsWith(redirectAt)) return new Response(null, { status: 302, headers: { Location: 'https://untrusted.example.test' } });
      return fixtureFetch(url, options);
    });
    const login = await signedIn(handler, environment());
    if (redirectAt) {
      assert.equal(login.session.token, undefined);
      assert.equal(calls.length, redirectAt === '/token' ? 1 : 2);
    } else {
      assert.equal(login.session.user.id, 'google-user-one');
      assert.equal(calls.length, 2);
    }
  }
});

test('stale writes and concurrent D1 updates return conflict', async () => {
  const env = environment();
  const { token } = (await signedIn(handleRequest, env)).session;
  const first = await (await request(env, token, `/v1/projects/${id}`, upload())).json();
  // Second create with If-None-Match: * should conflict
  assert.equal((await request(env, token, `/v1/projects/${id}`, upload())).status, 409);
  // Update with correct updatedAt
  const updated = await (await request(env, token, `/v1/projects/${id}`, upload(first.updatedAt))).json();
  assert.ok(updated.updatedAt);
  // Update with stale updatedAt
  assert.equal((await request(env, token, `/v1/projects/${id}`, upload(first.updatedAt))).status, 409);
});

test('authentication rejects unsafe redirects, forged state, unauthenticated access and rate excess', async () => {
  const env = environment();
  assert.equal((await handleRequest(new Request(env.PUBLIC_BASE_URL + '/v1/projects'), env)).status, 401);
  const url = new URL(env.PUBLIC_BASE_URL + '/auth/google/start');
  url.search = new URLSearchParams({ redirect_uri: 'https://attacker.test/callback', state: 's'.repeat(43), code_challenge: 'c'.repeat(43) }).toString();
  assert.equal((await handleRequest(new Request(url), env)).status, 400);
  assert.equal((await handleRequest(new Request(env.PUBLIC_BASE_URL + '/auth/google/callback?state=' + 's'.repeat(43) + '&code=fake'), env)).status, 400);
  env.AUTH_RATE_LIMITER.limit = async () => ({ success: false });
  assert.equal((await handleRequest(new Request(url), env)).status, 429);
});

test('server validates bundle metadata and expires sessions', async () => {
  const env = environment();
  const { token } = (await signedIn(handleRequest, env)).session;
  assert.equal((await request(env, token, `/v1/projects/${id}`, { ...upload(), body: 'not a bundle' })).status, 400);
  // Expire all sessions in D1
  for (const session of env.DB.tables.sessions) {
    session.expires_at = 0;
  }
  assert.equal((await request(env, token, '/v1/projects')).status, 401);
});

test('provider failures return to the validated desktop callback without leaking provider details', async () => {
  for (const failure of [async () => new Response('private provider error', { status: 400 }), async () => { throw new Error('network failure'); }]) {
    const env = environment();
    const start = new URL(env.PUBLIC_BASE_URL + '/auth/google/start');
    start.search = new URLSearchParams({ redirect_uri: 'http://127.0.0.1:12345/callback', state: 's'.repeat(43), code_challenge: 'c'.repeat(43) }).toString();
    const google = new URL((await handleRequest(new Request(start), env)).headers.get('Location'));
    const callback = new URL(env.PUBLIC_BASE_URL + '/auth/google/callback');
    callback.search = new URLSearchParams({ state: google.searchParams.get('state'), code: 'test-code' }).toString();
    const result = await handleRequest(new Request(callback), env, failure);
    assert.equal(result.status, 302);
    const location = new URL(result.headers.get('Location'));
    assert.equal(location.origin, 'http://127.0.0.1:12345');
    assert.equal(location.searchParams.get('state'), 's'.repeat(43));
    assert.equal(location.searchParams.get('error'), 'authentication_failed');
    assert.equal(location.searchParams.has('code'), false);
  }
});

test('incorrect PKCE cannot consume a valid one-time code', async () => {
  const env = environment();
  const code = 'c'.repeat(43);
  const verifier = 'v'.repeat(43);
  const hash = (text) => createHash('sha256').update(text).digest('base64url');
  await env.PROJECTS.put('auth/code/' + hash(code), JSON.stringify({ user: { id: 'test' }, challenge: hash(verifier), expiresAt: Date.now() + 60000 }));
  const exchange = (value) => handleRequest(new Request(env.PUBLIC_BASE_URL + '/auth/exchange', { method: 'POST', body: JSON.stringify({ code, verifier: value }) }), env);
  assert.equal((await exchange('x'.repeat(43))).status, 400);
  assert.equal((await exchange(verifier)).status, 200);
  assert.equal((await exchange(verifier)).status, 400);
});

test('project listing paginates with offset', async () => {
  const env = environment();
  const { token } = (await signedIn(handleRequest, env)).session;
  for (let index = 0; index < 27; index += 1) {
    const projectId = `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`;
    assert.equal((await request(env, token, `/v1/projects/${projectId}`, upload())).status, 200);
  }
  const first = await (await request(env, token, '/v1/projects')).json();
  assert.equal(first.projects.length, 25);
  assert.ok(first.cursor);
  const second = await (await request(env, token, '/v1/projects?offset=' + first.cursor)).json();
  assert.equal(second.projects.length, 2);
  assert.equal(second.cursor, null);
  assert.equal(new Set([...first.projects, ...second.projects].map((project) => project.id)).size, 27);
});

// --- Team management tests ---

test('owner can invite by email, invitee can accept and access project', async () => {
  const env = environment();
  const owner = (await signedIn(handleRequest, env, 'owner')).session;
  const invitee = (await signedIn(handleRequest, env, 'invitee')).session;

  // Owner creates a project
  const saved = await (await request(env, owner.token, `/v1/projects/${id}`, upload())).json();
  assert.ok(saved.id);

  // Invitee cannot access yet
  assert.equal((await request(env, invitee.token, `/v1/projects/${id}`)).status, 403);

  // Owner invites by email
  const invite = await (await request(env, owner.token, `/v1/projects/${id}/invite`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'invitee@example.test', role: 'editor' })
  })).json();
  assert.ok(invite.invitation.id);
  assert.equal(invite.invitation.role, 'editor');
  assert.equal(invite.delivery.sent, true);
  assert.equal(env.EMAIL.messages.length, 1);
  assert.equal(env.EMAIL.messages[0].to, 'invitee@example.test');
  assert.match(env.EMAIL.messages[0].text, new RegExp(invite.invitation.id));
  assert.match(env.EMAIL.messages[0].html, /Lời mời tham gia LaTeX Editor/);

  const landing = await handleRequest(new Request(`${env.PUBLIC_BASE_URL}/invite/${invite.invitation.id}`), env);
  assert.equal(landing.status, 200);
  assert.match(await landing.text(), new RegExp(invite.invitation.id));

  // Invitee sees pending invitation in /v1/my-invitations
  const myInvites = await (await request(env, invitee.token, '/v1/my-invitations')).json();
  assert.equal(myInvites.invitations.length, 1);
  assert.equal(myInvites.invitations[0].id, invite.invitation.id);
  assert.equal(myInvites.invitations[0].projectId, id);
  assert.equal(myInvites.invitations[0].role, 'editor');

  // Invitee accepts
  const accept = await (await request(env, invitee.token, `/v1/invitations/${invite.invitation.id}/accept`, { method: 'POST' })).json();
  assert.equal(accept.accepted, true);
  assert.equal(accept.role, 'editor');

  // Accepted invite no longer in /v1/my-invitations
  const remaining = await (await request(env, invitee.token, '/v1/my-invitations')).json();
  assert.equal(remaining.invitations.length, 0);

  // Invitee can now access
  const download = await request(env, invitee.token, `/v1/projects/${id}`);
  assert.equal(download.status, 200);

  // Invitee sees project in their list
  const list = await (await request(env, invitee.token, '/v1/projects')).json();
  assert.equal(list.projects.length, 1);
  assert.equal(list.projects[0].id, id);
});

test('invitee can decline an invitation', async () => {
  const env = environment();
  const owner = (await signedIn(handleRequest, env, 'owner')).session;
  const invitee = (await signedIn(handleRequest, env, 'invitee')).session;

  await request(env, owner.token, `/v1/projects/${id}`, upload());
  const invite = await (await request(env, owner.token, `/v1/projects/${id}/invite`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'invitee@example.test', role: 'editor' })
  })).json();

  const myInvites = await (await request(env, invitee.token, '/v1/my-invitations')).json();
  assert.equal(myInvites.invitations.length, 1);

  // Decline
  const decline = await (await request(env, invitee.token, `/v1/invitations/${invite.invitation.id}/decline`, { method: 'POST' })).json();
  assert.equal(decline.declined, true);

  // No longer in pending invitations
  const after = await (await request(env, invitee.token, '/v1/my-invitations')).json();
  assert.equal(after.invitations.length, 0);
});

test('owner can list members and remove a member', async () => {
  const env = environment();
  const owner = (await signedIn(handleRequest, env, 'owner')).session;
  const member = (await signedIn(handleRequest, env, 'member')).session;

  await request(env, owner.token, `/v1/projects/${id}`, upload());
  const invite = await (await request(env, owner.token, `/v1/projects/${id}/invite`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'member@example.test', role: 'viewer' })
  })).json();
  await request(env, member.token, `/v1/invitations/${invite.invitation.id}/accept`, { method: 'POST' });

  // List members
  const members = await (await request(env, owner.token, `/v1/projects/${id}/members`)).json();
  assert.equal(members.members.length, 2);

  // Remove member
  const remove = await request(env, owner.token, `/v1/projects/${id}/members/${member.user.id}`, { method: 'DELETE' });
  assert.equal(remove.status, 200);

  // Member can no longer access
  assert.equal((await request(env, member.token, `/v1/projects/${id}`)).status, 403);
});

test('non-owner cannot invite or remove members', async () => {
  const env = environment();
  const owner = (await signedIn(handleRequest, env, 'owner')).session;
  const editor = (await signedIn(handleRequest, env, 'editor')).session;

  await request(env, owner.token, `/v1/projects/${id}`, upload());
  const invite = await (await request(env, owner.token, `/v1/projects/${id}/invite`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'editor@example.test', role: 'editor' })
  })).json();
  await request(env, editor.token, `/v1/invitations/${invite.invitation.id}/accept`, { method: 'POST' });

  // Editor cannot invite
  assert.equal((await request(env, editor.token, `/v1/projects/${id}/invite`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'other@example.test', role: 'viewer' })
  })).status, 403);

  // Editor cannot remove owner
  assert.equal((await request(env, editor.token, `/v1/projects/${id}/members/${owner.user.id}`, { method: 'DELETE' })).status, 403);
});

test('owner can revoke a pending invitation', async () => {
  const env = environment();
  const owner = (await signedIn(handleRequest, env, 'owner')).session;
  const invitee = (await signedIn(handleRequest, env, 'invitee')).session;

  await request(env, owner.token, `/v1/projects/${id}`, upload());
  const invite = await (await request(env, owner.token, `/v1/projects/${id}/invite`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'invitee@example.test', role: 'editor' })
  })).json();

  // List invitations
  const list = await (await request(env, owner.token, `/v1/projects/${id}/invitations`)).json();
  assert.equal(list.invitations.length, 1);
  assert.equal(list.invitations[0].status, 'pending');

  // Revoke
  const revoke = await request(env, owner.token, `/v1/projects/${id}/invitations/${invite.invitation.id}/revoke`, { method: 'POST' });
  assert.equal(revoke.status, 200);

  // Cannot accept revoked invitation
  const accept = await request(env, invitee.token, `/v1/invitations/${invite.invitation.id}/accept`, { method: 'POST' });
  assert.equal(accept.status, 400);
});

test('owner cannot remove themselves if they are the only owner', async () => {
  const env = environment();
  const owner = (await signedIn(handleRequest, env, 'owner')).session;

  await request(env, owner.token, `/v1/projects/${id}`, upload());
  const remove = await request(env, owner.token, `/v1/projects/${id}/members/${owner.user.id}`, { method: 'DELETE' });
  assert.equal(remove.status, 400);
});

test('viewer cannot upload to a project', async () => {
  const env = environment();
  const owner = (await signedIn(handleRequest, env, 'owner')).session;
  const viewer = (await signedIn(handleRequest, env, 'viewer')).session;

  const saved = await (await request(env, owner.token, `/v1/projects/${id}`, upload())).json();
  const invite = await (await request(env, owner.token, `/v1/projects/${id}/invite`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'viewer@example.test', role: 'viewer' })
  })).json();
  await request(env, viewer.token, `/v1/invitations/${invite.invitation.id}/accept`, { method: 'POST' });

  // Viewer can download
  assert.equal((await request(env, viewer.token, `/v1/projects/${id}`)).status, 200);
  // Viewer cannot upload
  assert.equal((await request(env, viewer.token, `/v1/projects/${id}`, upload(saved.updatedAt))).status, 403);
});

test('duplicate email invitation is rejected', async () => {
  const env = environment();
  const owner = (await signedIn(handleRequest, env, 'owner')).session;

  await request(env, owner.token, `/v1/projects/${id}`, upload());
  assert.equal((await request(env, owner.token, `/v1/projects/${id}/invite`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'dup@example.test', role: 'editor' })
  })).status, 200);
  assert.equal((await request(env, owner.token, `/v1/projects/${id}/invite`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'dup@example.test', role: 'editor' })
  })).status, 409);
});

test('link invitations require their secret token', async () => {
  const env = environment();
  const owner = (await signedIn(handleRequest, env, 'owner')).session;
  const invitee = (await signedIn(handleRequest, env, 'link-invitee')).session;
  await request(env, owner.token, `/v1/projects/${id}`, upload());
  const created = await (await request(env, owner.token, `/v1/projects/${id}/invite`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'viewer' })
  })).json();
  const route = `/v1/invitations/${created.invitation.id}/accept`;
  assert.equal((await request(env, invitee.token, route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await request(env, invitee.token, route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'x'.repeat(43) }) })).status, 403);
  assert.equal((await request(env, invitee.token, route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: created.invitation.token }) })).status, 200);
});

test('email invitation remains available when email delivery is not configured', async () => {
  const env = environment();
  delete env.EMAIL;
  delete env.EMAIL_FROM;
  const owner = (await signedIn(handleRequest, env, 'owner')).session;
  await request(env, owner.token, `/v1/projects/${id}`, upload());
  const result = await (await request(env, owner.token, `/v1/projects/${id}/invite`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'offline@example.test', role: 'viewer' })
  })).json();
  assert.deepEqual(result.delivery, { sent: false, reason: 'not_configured' });
  assert.ok(result.invitation.id);
});

test('project members can enter their authenticated collaboration room', async () => {
  const env = environment();
  const owner = (await signedIn(handleRequest, env, 'room-owner')).session;
  await request(env, owner.token, `/v1/projects/${id}`, upload());

  const missingUpgrade = await request(env, owner.token, `/v1/projects/${id}/collaboration`);
  assert.equal(missingUpgrade.status, 426);
  assert.equal(env.COLLABORATION_ROOMS.calls.length, 0);

  const connected = await request(env, owner.token, `/v1/projects/${id}/collaboration`, { headers: { Upgrade: 'websocket' } });
  assert.equal(connected.status, 204);
  assert.equal(env.COLLABORATION_ROOMS.calls.length, 1);
  assert.deepEqual(env.COLLABORATION_ROOMS.calls[0], {
    projectId: id,
    path: '/connect',
    method: 'GET',
    headers: {
      'sec-websocket-protocol': 'latex-editor-v1',
      upgrade: 'websocket',
      'x-collaboration-role': 'owner',
      'x-collaboration-user-id': 'google-room-owner',
      'x-collaboration-user-name': 'room-owner'
    }
  });

  const presence = await request(env, owner.token, `/v1/projects/${id}/collaboration/presence`);
  assert.equal(presence.status, 200);
  assert.deepEqual(await presence.json(), { participants: [] });
});

test('collaboration room rejects non-members and accepts auth via WebSocket subprotocol', async () => {
  const env = environment();
  const owner = (await signedIn(handleRequest, env, 'socket-owner')).session;
  const outsider = (await signedIn(handleRequest, env, 'socket-outsider')).session;
  await request(env, owner.token, `/v1/projects/${id}`, upload());

  const outsiderRequest = new Request(`${env.PUBLIC_BASE_URL}/v1/projects/${id}/collaboration`, {
    headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `latex-editor-v1, latex-editor-auth.${outsider.token}` }
  });
  assert.equal((await handleRequest(outsiderRequest, env)).status, 403);
  assert.equal(env.COLLABORATION_ROOMS.calls.length, 0);

  const ownerRequest = new Request(`${env.PUBLIC_BASE_URL}/v1/projects/${id}/collaboration`, {
    headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `latex-editor-v1, latex-editor-auth.${owner.token}` }
  });
  assert.equal((await handleRequest(ownerRequest, env)).status, 204);
  assert.equal(env.COLLABORATION_ROOMS.calls.length, 1);
});

test('removing a member disconnects their active collaboration sessions', async () => {
  const env = environment();
  const owner = (await signedIn(handleRequest, env, 'disconnect-owner')).session;
  const member = (await signedIn(handleRequest, env, 'disconnect-member')).session;
  await request(env, owner.token, `/v1/projects/${id}`, upload());
  const invite = await (await request(env, owner.token, `/v1/projects/${id}/invite`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: member.user.email, role: 'editor' })
  })).json();
  await request(env, member.token, `/v1/invitations/${invite.invitation.id}/accept`, { method: 'POST' });

  assert.equal((await request(env, owner.token, `/v1/projects/${id}/members/${member.user.id}`, { method: 'DELETE' })).status, 200);
  const disconnect = env.COLLABORATION_ROOMS.calls.at(-1);
  assert.equal(disconnect.path, '/disconnect');
  assert.equal(disconnect.method, 'POST');
  assert.equal(disconnect.headers['x-collaboration-user-id'], member.user.id);
});

test('collaboration room restores presence from WebSocket attachments and handles control messages', async () => {
  class FakeSocket {
    constructor(attachment) { this.attachment = attachment; this.messages = []; this.closed = null; }
    deserializeAttachment() { return this.attachment; }
    send(message) { this.messages.push(JSON.parse(message)); }
    close(code, reason) { this.closed = { code, reason }; }
  }
  const first = new FakeSocket({ userId: 'u1', name: 'One', avatarUrl: null, role: 'owner', joinedAt: 1 });
  const second = new FakeSocket({ userId: 'u1', name: 'One', avatarUrl: null, role: 'owner', joinedAt: 2 });
  const viewer = new FakeSocket({ userId: 'u2', name: 'Two', avatarUrl: null, role: 'viewer', joinedAt: 3 });
  const room = new ProjectCollaborationRoom({ getWebSockets: () => [first, second, viewer] });

  assert.deepEqual(room.participants(), [
    { id: 'u1', name: 'One', avatarUrl: null, role: 'owner', joinedAt: 1, connections: 2 },
    { id: 'u2', name: 'Two', avatarUrl: null, role: 'viewer', joinedAt: 3, connections: 1 }
  ]);
  await room.webSocketMessage(viewer, JSON.stringify({ type: 'presence:request' }));
  assert.equal(viewer.messages.at(-1).type, 'presence');
  assert.equal(viewer.messages.at(-1).participants.length, 2);
  await room.webSocketMessage(first, JSON.stringify({ type: 'ping' }));
  assert.equal(first.messages.at(-1).type, 'pong');
  await room.webSocketClose(viewer);
  assert.equal(first.messages.at(-1).action, 'leave');
  assert.equal(first.messages.at(-1).participants.length, 1);
});

test('collaboration room persists Yjs documents and rejects viewer updates', async () => {
  const Y = await import('yjs');
  class FakeSocket {
    constructor(role) { this.attachment = { userId: role, name: role, role, joinedAt: 1 }; this.messages = []; }
    deserializeAttachment() { return this.attachment; }
    send(message) { this.messages.push(JSON.parse(message)); }
  }
  const values = new Map();
  const storage = {
    get: async (key) => values.get(key),
    put: async (key, value) => values.set(key, new Uint8Array(value))
  };
  const owner = new FakeSocket('owner');
  const viewer = new FakeSocket('viewer');
  const state = { storage, getWebSockets: () => [owner, viewer] };
  const room = new ProjectCollaborationRoom(state);
  const document = new Y.Doc();
  document.getText('content').insert(0, 'Shared');
  const update = Buffer.from(Y.encodeStateAsUpdate(document)).toString('base64');

  await room.webSocketMessage(owner, JSON.stringify({ type: 'document:seed', path: 'main.tex', update }));
  assert.equal(values.has('document:main.tex'), true);
  assert.equal(viewer.messages.at(-1).type, 'document:update');

  const restarted = new ProjectCollaborationRoom(state);
  await restarted.webSocketMessage(viewer, JSON.stringify({ type: 'document:subscribe', path: 'main.tex' }));
  assert.equal(viewer.messages.at(-1).type, 'document:state');
  assert.ok(viewer.messages.at(-1).update);
  await restarted.webSocketMessage(viewer, JSON.stringify({ type: 'document:update', path: 'main.tex', update }));
  assert.equal(viewer.messages.at(-1).code, 'read_only');
});

test('collaboration room broadcasts validated cursor selections without persisting them', async () => {
  class FakeSocket {
    constructor(id, role) { this.attachment = { userId: id, name: id, role, joinedAt: 1 }; this.messages = []; }
    deserializeAttachment() { return this.attachment; }
    send(message) { this.messages.push(JSON.parse(message)); }
  }
  const owner = new FakeSocket('owner-user', 'owner');
  const viewer = new FakeSocket('viewer-user', 'viewer');
  let writes = 0;
  const room = new ProjectCollaborationRoom({
    storage: { get: async () => null, put: async () => { writes += 1; } },
    getWebSockets: () => [owner, viewer]
  });
  await room.webSocketMessage(owner, JSON.stringify({
    type: 'cursor:update', path: 'main.tex', selections: [{ anchor: 4, active: 9 }]
  }));
  assert.deepEqual(viewer.messages.at(-1), {
    type: 'cursor:update', path: 'main.tex', selections: [{ anchor: 4, active: 9 }],
    user: { id: 'owner-user', name: 'owner-user', avatarUrl: null, role: 'owner', joinedAt: 1 }
  });
  assert.equal(writes, 0);
  await room.webSocketMessage(owner, JSON.stringify({ type: 'cursor:update', path: '../bad', selections: [] }));
  assert.equal(owner.messages.at(-1).code, 'unsupported_event');
});

test('collaboration room persists a tombstoned file manifest and moves document state on rename', async () => {
  class FakeSocket {
    constructor(id, role) { this.attachment = { userId: id, name: id, role, joinedAt: 1 }; this.messages = []; }
    deserializeAttachment() { return this.attachment; }
    send(message) { this.messages.push(JSON.parse(message)); }
  }
  const owner = new FakeSocket('owner-user', 'owner');
  const viewer = new FakeSocket('viewer-user', 'viewer');
  const values = new Map([['document:old.tex', new Uint8Array([1, 2, 3])]]);
  const storage = {
    get: async (key) => values.get(key),
    put: async (key, value) => values.set(key, value),
    delete: async (key) => values.delete(key)
  };
  const room = new ProjectCollaborationRoom({ storage, getWebSockets: () => [owner, viewer] });

  await room.webSocketMessage(owner, JSON.stringify({ type: 'manifest:subscribe', paths: ['main.tex', 'old.tex'] }));
  assert.equal(owner.messages.at(-1).type, 'filesystem:state');
  assert.equal(owner.messages.at(-1).revision, 1);
  await room.webSocketMessage(owner, JSON.stringify({
    type: 'file:rename', oldPath: 'old.tex', newPath: 'new.tex', operationId: 'rename-operation-1'
  }));
  assert.equal(viewer.messages.at(-1).type, 'file:rename');
  assert.deepEqual(values.get('document:new.tex'), new Uint8Array([1, 2, 3]));
  assert.equal(values.has('document:old.tex'), false);
  const revisionAfterRename = owner.messages.at(-1).revision;
  await room.webSocketMessage(owner, JSON.stringify({
    type: 'file:rename', oldPath: 'old.tex', newPath: 'new.tex', operationId: 'rename-operation-1'
  }));
  assert.equal(owner.messages.at(-1).type, 'file:ack');
  assert.equal(owner.messages.at(-1).revision, revisionAfterRename);
  await room.webSocketMessage(owner, JSON.stringify({
    type: 'file:create', path: 'occupied.tex', operationId: 'create-operation-1'
  }));
  await room.webSocketMessage(owner, JSON.stringify({
    type: 'file:rename', oldPath: 'main.tex', newPath: 'occupied.tex', operationId: 'rename-operation-2'
  }));
  assert.equal(owner.messages.at(-1).code, 'file_exists');
  await room.webSocketMessage(owner, JSON.stringify({
    type: 'file:delete', path: 'new.tex', operationId: 'delete-operation-1'
  }));
  assert.equal(values.has('document:new.tex'), false);

  const restarted = new ProjectCollaborationRoom({ storage, getWebSockets: () => [owner, viewer] });
  await restarted.webSocketMessage(owner, JSON.stringify({ type: 'manifest:subscribe', paths: ['new.tex'] }));
  const manifest = owner.messages.at(-1);
  assert.equal(manifest.type, 'filesystem:state');
  assert.equal(manifest.entries.find((entry) => entry.path === 'old.tex').deleted, true);
  assert.equal(manifest.entries.find((entry) => entry.path === 'new.tex').deleted, true);
  await restarted.webSocketMessage(viewer, JSON.stringify({
    type: 'file:create', path: 'blocked.tex', operationId: 'viewer-operation-1'
  }));
  assert.equal(viewer.messages.at(-1).code, 'read_only');
});
