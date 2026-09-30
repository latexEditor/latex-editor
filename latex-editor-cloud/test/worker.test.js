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
function upload(etag) {
  return { method: 'PUT', headers: { 'X-Git-Head': head, 'X-Project-Name': encodeURIComponent('Báo cáo'), ...(etag ? { 'If-Match': etag } : { 'If-None-Match': '*' }) }, body: `# v2 git bundle\n${head} refs/heads/main\n\nPACK-test-fixture` };
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

test('R2 projects and bundles are isolated per account', async () => {
  const env = environment();
  const first = (await signedIn(handleRequest, env, 'one')).session;
  const second = (await signedIn(handleRequest, env, 'two')).session;
  const saved = await request(env, first.token, `/v1/projects/${id}`, upload());
  assert.equal(saved.status, 200);
  assert.equal((await request(env, second.token, `/v1/projects/${id}`)).status, 404);
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

test('stale writes and concurrent R2 updates return conflict', async () => {
  const env = environment();
  const { token } = (await signedIn(handleRequest, env)).session;
  const first = await (await request(env, token, `/v1/projects/${id}`, upload())).json();
  assert.equal((await request(env, token, `/v1/projects/${id}`, upload())).status, 409);
  const results = await Promise.all([request(env, token, `/v1/projects/${id}`, upload(first.etag)), request(env, token, `/v1/projects/${id}`, upload(first.etag))]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
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
  for (const [key, item] of env.PROJECTS.items) {
    if (key.startsWith('auth/session/')) {
      const value = JSON.parse(new TextDecoder().decode(item.data));
      await env.PROJECTS.put(key, JSON.stringify({ ...value, expiresAt: 0 }));
    }
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

test('project listing paginates without losing entries', async () => {
  const env = environment();
  const { token } = (await signedIn(handleRequest, env)).session;
  for (let index = 0; index < 27; index += 1) {
    const projectId = `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`;
    assert.equal((await request(env, token, `/v1/projects/${projectId}`, upload())).status, 200);
  }
  const first = await (await request(env, token, '/v1/projects')).json();
  assert.equal(first.projects.length, 25);
  assert.ok(first.cursor);
  const second = await (await request(env, token, '/v1/projects?cursor=' + encodeURIComponent(first.cursor))).json();
  assert.equal(second.projects.length, 2);
  assert.equal(second.cursor, null);
  assert.equal(new Set([...first.projects, ...second.projects].map((project) => project.id)).size, 27);
});
