const { app, safeStorage } = require('electron');
const config = require('../src/main/config');
const { AuthManager } = require('../src/main/AuthManager');

async function inspectRoute(auth, route) {
  if (!auth.session?.token) return { status: null, ok: false, error: 'not-signed-in' };
  try {
    const response = await fetch(auth.apiUrl + route, {
      redirect: 'error',
      headers: { Authorization: `Bearer ${auth.session.token}` },
      signal: AbortSignal.timeout(20_000)
    });
    const body = await response.json().catch(() => ({}));
    return {
      status: response.status,
      ok: response.ok,
      error: response.ok ? null : (body.error || `HTTP ${response.status}`),
      projectCount: Array.isArray(body.projects) ? body.projects.length : undefined,
      templateCount: Array.isArray(body.templates) ? body.templates.length : undefined
    };
  } catch (error) {
    return { status: null, ok: false, error: error.message };
  }
}

async function main() {
  await app.whenReady();
  const auth = new AuthManager(config, {
    safeStorage,
    openExternal: async () => { throw new Error('Cloud diagnostic never opens a browser.'); }
  });
  await auth.initialize();

  let health;
  try {
    const response = await fetch(config.apiUrl + '/health', { signal: AbortSignal.timeout(20_000) });
    health = { status: response.status, ok: response.ok, ...(await response.json().catch(() => ({}))) };
  } catch (error) {
    health = { status: null, ok: false, error: error.message };
  }

  const signedIn = auth.status().signedIn;
  const result = {
    apiUrl: config.apiUrl,
    health,
    session: { signedIn, expiresAt: signedIn ? new Date(auth.session.expiresAt).toISOString() : null },
    me: signedIn ? await inspectRoute(auth, '/v1/me') : null,
    projects: signedIn ? await inspectRoute(auth, '/v1/projects') : null,
    templates: signedIn ? await inspectRoute(auth, '/v1/templates') : null
  };
  console.log(JSON.stringify(result, null, 2));
  auth.dispose();
  app.quit();
}

main().catch((error) => {
  console.error(error);
  app.exit(1);
});
