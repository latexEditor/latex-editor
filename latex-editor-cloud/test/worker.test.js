import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { handleRequest } from '../src/index.js';
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
