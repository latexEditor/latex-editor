const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { AuthManager, normalizeApiUrl } = require('../src/main/AuthManager');

async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'latex-auth-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = { apiUrl: 'https://cloud.example.test', sessionFile: path.join(root, 'session.bin') };
  const storage = { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(Buffer.from(value).toString('base64')), decryptString: (value) => Buffer.from(value.toString(), 'base64').toString() };
  const auth = new AuthManager(config, { safeStorage: storage, openExternal: async () => {}, fetch: async () => Response.json({}), ...overrides });
  t.after(() => auth.dispose());
  return { config, auth, storage };
}

test('Google loopback login verifies state/PKCE and exposes no token to the renderer', async (t) => {
  let challenge;
  const session = { user: { id: 'google-one', name: 'User', email: 'one@example.test' }, token: 't'.repeat(43), expiresAt: Date.now() + 60000 };
  const { auth, config, storage } = await fixture(t, {
    openExternal: async (target) => {
      const url = new URL(target);
      challenge = url.searchParams.get('code_challenge');
      const callback = new URL(url.searchParams.get('redirect_uri'));
      callback.search = new URLSearchParams({ state: 'invalid', code: 'c'.repeat(43) }).toString();
      assert.equal((await fetch(callback)).status, 400);
      callback.searchParams.set('state', url.searchParams.get('state'));
      assert.equal((await fetch(callback)).status, 200);
    },
    fetch: async (url, options) => {
      if (url.endsWith('/auth/exchange')) {
        const body = JSON.parse(options.body);
        assert.equal(crypto.createHash('sha256').update(body.verifier).digest('base64url'), challenge);
        return Response.json(session);
      }
      return Response.json({});
    }
  });
  const result = await auth.login();
  assert.equal(result.signedIn, true);
  assert.equal(JSON.stringify(result).includes(session.token), false);
  const restarted = new AuthManager(config, { safeStorage: storage, openExternal: async () => {}, fetch: async () => Response.json({}) });
  await restarted.initialize();
  assert.equal(restarted.status().user.id, session.user.id);
  await restarted.logout();
  await assert.rejects(fs.access(config.sessionFile));
  assert.equal(restarted.status().signedIn, false);
});

test('canceling login cannot resurrect a signed-out session', async (t) => {
  const { auth } = await fixture(t);
  const login = auth.login();
  const rejected = assert.rejects(login, /hủy/);
  await auth.logout();
  await rejected;
  assert.equal(auth.status().signedIn, false);
  assert.equal(auth.status().signingIn, false);
});

test('expired API sessions are cleared and logout warns if remote revocation fails', async (t) => {
  const { auth } = await fixture(t, { fetch: async () => new Response('{}', { status: 401 }) });
  auth.session = { user: { id: 'one' }, token: 't'.repeat(43), expiresAt: Date.now() + 10000 };
  await assert.rejects(auth.request('/v1/projects'), /hết hạn/);
  assert.equal(auth.status().signedIn, false);
  auth.session = { user: { id: 'one' }, token: 't'.repeat(43), expiresAt: Date.now() + 10000 };
  const result = await auth.logout();
  assert.match(result.warning, /chưa thu hồi/);
  assert.equal(result.signedIn, false);
});

test('cloud URL accepts HTTPS or local development origins only', () => {
  assert.equal(normalizeApiUrl('https://cloud.example.test/'), 'https://cloud.example.test');
  assert.equal(normalizeApiUrl('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
  for (const value of ['http://public.example.test', 'https://user:pass@example.test', 'https://example.test/path', 'file:///tmp']) assert.throws(() => normalizeApiUrl(value));
});

test('parallel API requests share one renewal and persist the extended encrypted session', async (t) => {
  let renewals = 0;
  const expiresAt = Date.now() + 7 * 86400000;
  const { auth, config, storage } = await fixture(t, { fetch: async (url) => {
    if (url.endsWith('/auth/refresh')) {
      renewals++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return Response.json({ expiresAt });
    }
    return Response.json({ ok: true });
  } });
  auth.session = { user: { id: 'one' }, token: 't'.repeat(43), expiresAt: Date.now() + 60000 };
  await Promise.all([auth.request('/v1/projects'), auth.request('/v1/templates')]);
  assert.equal(renewals, 1);
  assert.equal(auth.session.expiresAt, expiresAt);
  const saved = JSON.parse(storage.decryptString(await fs.readFile(config.sessionFile)));
  assert.equal(saved.expiresAt, expiresAt);
  assert.equal(JSON.stringify(auth.status()).includes(saved.token), false);
});

test('logout during renewal cannot restore a session or leave its file on disk', async (t) => {
  let started, release;
  const renewing = new Promise((resolve) => { started = resolve; });
  const { auth, config } = await fixture(t, { fetch: async () => {
    started();
    await new Promise((resolve) => { release = resolve; });
    return Response.json({ expiresAt: Date.now() + 7 * 86400000 });
  } });
  auth.session = { user: { id: 'one' }, token: 't'.repeat(43), expiresAt: Date.now() + 60000 };
  const operation = auth.request('/v1/projects');
  const rejected = assert.rejects(operation, /thay đổi/);
  await renewing;
  await auth.logout(false);
  release();
  await rejected;
  assert.equal(auth.status().signedIn, false);
  await assert.rejects(fs.access(config.sessionFile));
});

test('failed optional renewal is throttled and a valid session still works against an older Worker', async (t) => {
  let renewals = 0;
  const { auth } = await fixture(t, { fetch: async (url) => {
    if (url.endsWith('/auth/refresh')) { renewals++; return new Response('{}', { status: 404 }); }
    return Response.json({ ok: true });
  } });
  auth.session = { user: { id: 'one' }, token: 't'.repeat(43), expiresAt: Date.now() + 60000 };
  await auth.request('/v1/projects');
  await auth.request('/v1/templates');
  assert.equal(renewals, 1);
  assert.equal(auth.status().signedIn, true);
});

test('logout waits for pending encrypted writes and prevents stale session persistence', async (t) => {
  let release;
  let started;
  const encrypting = new Promise((resolve) => { started = resolve; });
  const storage = {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async () => { started(); await new Promise((resolve) => { release = resolve; }); return Buffer.from('encrypted'); }
  };
  const { auth, config } = await fixture(t, { safeStorage: storage });
  const session = { user: { id: 'old-account' }, token: 't'.repeat(43), expiresAt: Date.now() + 60000 };
  const saving = auth.persist(session, auth.generation);
  await encrypting;
  const loggingOut = auth.logout();
  release();
  await Promise.all([saving, loggingOut]);
  assert.equal(auth.status().signedIn, false);
  await assert.rejects(fs.access(config.sessionFile));
});
