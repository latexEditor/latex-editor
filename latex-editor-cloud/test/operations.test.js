// Node 22.12+ test runner: real SQLite checks SQL/transactions, not a SQL mock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { environment, signedIn } from './support.js';
import { handleRequest } from '../src/index.js';
import { reserveStorage, storageUsage, runMaintenance, requestAccountDeletion, cleanDeletedAccount } from '../src/operations.js';

class SqliteD1 {
  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    this.sqlite.exec('PRAGMA foreign_keys=ON;');
    this.sqlite.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
    this.sqlite.exec(readFileSync(new URL('../migrations/0001_operations.sql', import.meta.url), 'utf8'));
  }
  prepare(sql) {
    const statement = this.sqlite.prepare(sql);
    return {
      params: [],
      read: /^\s*SELECT/i.test(sql),
      bind(...params) { this.params = params; return this; },
      async first() { return statement.get(...this.params) || null; },
      async all() { return { results: statement.all(...this.params) }; },
      async run() { return { meta: { changes: Number(statement.run(...this.params).changes) } }; }
    };
  }
  async batch(statements) {
    this.sqlite.exec('BEGIN');
    try {
      const results = [];
      for (const statement of statements) results.push(statement.read ? await statement.all() : await statement.run());
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
}
const id = '11111111-1111-4111-8111-111111111111';
const secondId = '22222222-2222-4222-8222-222222222222';
const head = 'a'.repeat(40);
const upload = (etag) => ({ method: 'PUT', headers: { 'X-Git-Head': head, 'X-Project-Name': 'Test', ...(etag ? { 'If-Match': etag } : { 'If-None-Match': '*' }) }, body: `# v2 git bundle\n${head} refs/heads/main\n\nPACK-test` });
const api = (env, token, route, options = {}) => handleRequest(new Request(env.PUBLIC_BASE_URL + route, { ...options, headers: { Authorization: `Bearer ${token}`, ...options.headers } }), env);
function fixture(t) {
  const env = environment();
  env.DB = new SqliteD1();
  t.after(() => env.DB.sqlite.close());
  return env;
}

test('atomic reservations reject parallel quota overflow and account isolation uses real SQLite', async (t) => {
  const env = fixture(t);
  env.ACCOUNT_STORAGE_BYTES = '100';
  env.PROJECT_STORAGE_BYTES = '90';
  const results = await Promise.allSettled(['a', 'b'].map((key) => reserveStorage(env, { key, userId: 'one', projectId: id, bytes: 60 })));
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(results.find((item) => item.status === 'rejected').reason.status, 413);
  await reserveStorage(env, { key: 'c', userId: 'two', bytes: 100 });
  assert.equal((await storageUsage(env, 'one')).usedBytes, 60);
  assert.equal((await storageUsage(env, 'two')).usedBytes, 100);
});

test('upload quotas apply before R2 writes and editor uploads are charged to owner', async (t) => {
  const env = fixture(t);
  const owner = (await signedIn(handleRequest, env, 'owner')).session;
  const editor = (await signedIn(handleRequest, env, 'editor')).session;
  const saved = await (await api(env, owner.token, `/v1/projects/${id}`, upload())).json();
  assert.ok(saved.bundle_key);
  await env.DB.prepare('INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)').bind(id, editor.user.id, 'editor').run();
  const update = await api(env, editor.token, `/v1/projects/${id}`, upload(saved.updatedAt));
  assert.equal(update.status, 200, await update.clone().text());
  assert.ok((await storageUsage(env, owner.user.id)).usedBytes > 0);
  assert.equal((await storageUsage(env, editor.user.id)).usedBytes, 0);
  env.ACCOUNT_STORAGE_BYTES = '1';
  const count = env.PROJECTS.items.size;
  assert.equal((await api(env, owner.token, `/v1/projects/${secondId}`, upload())).status, 413);
  assert.equal(env.PROJECTS.items.size, count);
});

test('GC preserves referenced/current and in-flight data, removes old unreferenced bundles and auth', async (t) => {
  const env = fixture(t);
  const owner = (await signedIn(handleRequest, env)).session;
  const saved = await (await api(env, owner.token, `/v1/projects/${id}`, upload())).json();
  const old = new Date(Date.now() - 2 * 86400000);
  for (const object of env.PROJECTS.items.values()) object.uploaded = old;
  await env.PROJECTS.put('bundles/old/orphan.bundle', 'orphan');
  env.PROJECTS.items.get('bundles/old/orphan.bundle').uploaded = old;
  await reserveStorage(env, { key: 'bundles/old/orphan.bundle', userId: owner.user.id, bytes: 6 });
  await env.PROJECTS.put('bundles/new/pending.bundle', 'pending');
  for (let index = 0; index < 4; index++) await runMaintenance(env);
  assert.ok(await env.PROJECTS.head(saved.bundle_key));
  assert.ok(await env.PROJECTS.head('bundles/new/pending.bundle'));
  assert.equal(await env.PROJECTS.head('bundles/old/orphan.bundle'), null);
  assert.equal([...env.PROJECTS.items.keys()].some((key) => key.startsWith('auth/')), false);
  assert.equal((await env.DB.prepare('SELECT bytes FROM cloud_storage WHERE key = ?').bind(saved.bundle_key).first()).bytes, (await env.PROJECTS.head(saved.bundle_key)).size);
});

test('maintenance removes expired public PDFs but preserves links without expiration', async (t) => {
  const env = fixture(t);
  const owner = (await signedIn(handleRequest, env, 'publication-owner')).session;
  await api(env, owner.token, `/v1/projects/${id}`, upload());
  const publish = (days) => api(env, owner.token, `/v1/projects/${id}/publication`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/pdf', 'X-Source-Head': head, 'X-PDF-Filename': 'result.pdf', 'X-Expires-In-Days': String(days) },
    body: '%PDF-1.7\nresult\n%%EOF'
  });
  assert.equal((await publish(1)).status, 200);
  const expired = await env.DB.prepare('SELECT id, pdf_key FROM project_publications WHERE project_id = ?').bind(id).first();
  await env.DB.prepare('UPDATE project_publications SET expires_at = ? WHERE project_id = ?').bind(Date.now() - 1, id).run();
  const report = await runMaintenance(env);
  assert.equal(report.expiredPublications, 1);
  assert.equal(await env.PROJECTS.head(expired.pdf_key), null);
  assert.equal((await handleRequest(new Request(`${env.PUBLIC_BASE_URL}/p/${expired.id}`), env)).status, 404);

  assert.equal((await publish(0)).status, 200);
  const permanent = await env.DB.prepare('SELECT id, pdf_key FROM project_publications WHERE project_id = ?').bind(id).first();
  await runMaintenance(env);
  assert.ok(await env.PROJECTS.head(permanent.pdf_key));
  assert.equal((await handleRequest(new Request(`${env.PUBLIC_BASE_URL}/p/${permanent.id}`), env)).status, 200);
});

test('GC checkpoints pagination and retries safely after R2 failure', async (t) => {
  const env = fixture(t);
  for (let index = 0; index < 65; index++) {
    const key = `bundles/old/${index}.bundle`;
    await env.PROJECTS.put(key, 'x');
    env.PROJECTS.items.get(key).uploaded = new Date(Date.now() - 2 * 86400000);
  }
  const remove = env.PROJECTS.delete.bind(env.PROJECTS);
  env.PROJECTS.delete = async () => { throw new Error('R2 down'); };
  await assert.rejects(runMaintenance(env), /R2 down/);
  assert.equal(env.PROJECTS.items.size, 65);
  env.PROJECTS.delete = remove;
  for (let index = 0; index < 8; index++) await runMaintenance(env);
  assert.equal(env.PROJECTS.items.size, 0);
});

test('account deletion requires confirmation, revokes all sessions and resumes failed cleanup', async (t) => {
  const env = fixture(t);
  const owner = (await signedIn(handleRequest, env, 'owner')).session;
  const another = (await signedIn(handleRequest, env, 'owner')).session;
  const viewer = (await signedIn(handleRequest, env, 'viewer')).session;
  await api(env, owner.token, `/v1/projects/${id}`, upload());
  await env.DB.prepare('INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)').bind(id, viewer.user.id, 'viewer').run();
  assert.equal((await api(env, owner.token, '/v1/me', { method: 'DELETE', body: '{}' })).status, 400);
  assert.equal((await api(env, owner.token, '/v1/me', { method: 'DELETE', body: JSON.stringify({ confirm: 'DELETE', email: owner.user.email }) })).status, 202);
  assert.equal((await api(env, another.token, '/v1/me')).status, 401);
  assert.equal((await signedIn(handleRequest, env, 'owner')).session.token, undefined);
  const remove = env.PROJECTS.delete.bind(env.PROJECTS);
  env.PROJECTS.delete = async () => { throw new Error('R2 down'); };
  await assert.rejects(cleanDeletedAccount(env, owner.user.id), /R2 down/);
  assert.ok(await env.DB.prepare('SELECT user_id FROM account_deletions WHERE user_id = ?').bind(owner.user.id).first());
  env.PROJECTS.delete = remove;
  assert.equal(await cleanDeletedAccount(env, owner.user.id), true);
  assert.equal(await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(owner.user.id).first(), null);
  assert.ok(await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(viewer.user.id).first());
  assert.equal(await env.DB.prepare('SELECT id FROM projects WHERE id = ?').bind(id).first(), null);
});

test('deleting a co-owner preserves the project and transfers storage attribution', async (t) => {
  const env = fixture(t);
  const first = (await signedIn(handleRequest, env, 'first')).session;
  const second = (await signedIn(handleRequest, env, 'second')).session;
  await api(env, first.token, `/v1/projects/${id}`, upload());
  await env.DB.prepare('INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)').bind(id, second.user.id, 'owner').run();
  await requestAccountDeletion(env, first.user);
  await cleanDeletedAccount(env, first.user.id);
  assert.equal((await api(env, second.token, `/v1/projects/${id}`)).status, 200);
  assert.ok((await storageUsage(env, second.user.id)).usedBytes > 0);
  assert.equal((await storageUsage(env, first.user.id)).usedBytes, 0);
});

test('session renewal has an absolute 30-day ceiling and cannot revive revoked sessions', async (t) => {
  const env = fixture(t);
  const owner = (await signedIn(handleRequest, env)).session;
  const created = new Date(Date.now() - 29 * 86400000).toISOString();
  await env.DB.prepare('UPDATE sessions SET created_at = ? WHERE user_id = ?').bind(created, owner.user.id).run();
  const refreshed = await api(env, owner.token, '/auth/refresh', { method: 'POST' });
  assert.equal(refreshed.status, 200);
  assert.equal((await refreshed.json()).expiresAt, Date.parse(created) + 30 * 86400000);
  await api(env, owner.token, '/auth/logout', { method: 'POST' });
  assert.equal((await api(env, owner.token, '/auth/refresh', { method: 'POST' })).status, 401);
});

test('migration seeds legacy bundle accounting conservatively and is repeatable', async (t) => {
  const env = fixture(t);
  const owner = (await signedIn(handleRequest, env)).session;
  const saved = await (await api(env, owner.token, `/v1/projects/${id}`, upload())).json();
  await env.DB.prepare('DELETE FROM cloud_storage WHERE key = ?').bind(saved.bundle_key).run();
  const sql = readFileSync(new URL('../migrations/0001_operations.sql', import.meta.url), 'utf8');
  env.DB.sqlite.exec(sql);
  env.DB.sqlite.exec(sql);
  assert.equal((await storageUsage(env, owner.user.id)).usedBytes, 52428800);
  await runMaintenance(env);
  assert.equal((await storageUsage(env, owner.user.id)).usedBytes, (await env.PROJECTS.head(saved.bundle_key)).size);
});

test('template revisions use immutable R2 keys and old revisions are collected', async (t) => {
  const env = fixture(t);
  const owner = (await signedIn(handleRequest, env)).session;
  const template = '/v1/templates/personal-' + id;
  const put = { method: 'PUT', headers: { 'X-Template-Name': 'Test', 'X-Template-Engine': 'pdflatex' }, body: 'PK' + 'x'.repeat(30) };
  assert.equal((await api(env, owner.token, template, put)).status, 200);
  const first = (await env.DB.prepare('SELECT bundle_key FROM user_templates WHERE user_id = ?').bind(owner.user.id).first()).bundle_key;
  assert.equal((await api(env, owner.token, template, put)).status, 200);
  const next = (await env.DB.prepare('SELECT bundle_key FROM user_templates WHERE user_id = ?').bind(owner.user.id).first()).bundle_key;
  assert.notEqual(first, next);
  env.PROJECTS.items.get(first).uploaded = new Date(Date.now() - 2 * 86400000);
  await runMaintenance(env);
  assert.equal(await env.PROJECTS.head(first), null);
  assert.ok(await env.PROJECTS.head(next));
});

test('deletion marker rejects late session and membership writes at the database boundary', async (t) => {
  const env = fixture(t);
  const owner = (await signedIn(handleRequest, env)).session;
  await api(env, owner.token, `/v1/projects/${id}`, upload());
  await requestAccountDeletion(env, owner.user);
  await assert.rejects(env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').bind('late-token', owner.user.id, Date.now() + 60000).run(), /account deletion pending/);
  await assert.rejects(env.DB.prepare('INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)').bind(secondId, owner.user.id, 'viewer').run(), /account deletion pending/);
});

test('an active backup pins GC and expired backup locks are reclaimed', async (t) => {
  const env = fixture(t);
  await env.PROJECTS.put('backup-locks/one.json', JSON.stringify({ version: 1, expiresAt: Date.now() + 3600000 }));
  await env.PROJECTS.put('bundles/old/orphan.bundle', 'old');
  env.PROJECTS.items.get('bundles/old/orphan.bundle').uploaded = new Date(Date.now() - 2 * 86400000);
  assert.equal((await runMaintenance(env)).skippedForBackup, true);
  assert.ok(await env.PROJECTS.head('bundles/old/orphan.bundle'));
  await env.PROJECTS.put('backup-locks/one.json', JSON.stringify({ version: 1, expiresAt: Date.now() - 1000 }));
  assert.equal((await runMaintenance(env)).removedObjects, 1);
  assert.equal(await env.PROJECTS.head('backup-locks/one.json'), null);
});
