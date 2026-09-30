export class MemoryR2 {
  constructor() { this.items = new Map(); this.sequence = 0; }
  async put(key, body, options = {}) {
    const previous = this.items.get(key);
    if (options.onlyIf?.etagMatches && options.onlyIf.etagMatches !== previous?.etag) return null;
    if (options.onlyIf?.etagDoesNotMatch === '*' && previous) return null;
    const data = typeof body === 'string' ? new TextEncoder().encode(body) : new Uint8Array(body);
    const etag = String(++this.sequence);
    this.items.set(key, { data, etag });
    return { key, etag, httpEtag: `"${etag}"`, size: data.length };
  }
  async get(key) {
    const item = this.items.get(key);
    if (!item) return null;
    return { key, etag: item.etag, httpEtag: `"${item.etag}"`, size: item.data.length, body: new Blob([item.data]).stream(), json: async () => JSON.parse(new TextDecoder().decode(item.data)) };
  }
  async delete(key) { this.items.delete(key); }
  async list({ prefix, limit = 100, cursor }) {
    const all = [...this.items.keys()].filter((key) => key.startsWith(prefix)).sort();
    const offset = Number(cursor || 0);
    const objects = all.slice(offset, offset + limit).map((key) => ({ key }));
    return { objects, truncated: offset + limit < all.length, cursor: String(offset + limit) };
  }
}

export function environment() {
  return { PROJECTS: new MemoryR2(), AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) }, PROJECT_RATE_LIMITER: { limit: async () => ({ success: true }) }, GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-only', PUBLIC_BASE_URL: 'https://cloud.example.test' };
}

export async function signedIn(handle, env, subject = 'user-one') {
  const verifier = 'v'.repeat(43);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const challenge = btoa(String.fromCharCode(...hash)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const start = new URL(env.PUBLIC_BASE_URL + '/auth/google/start');
  start.search = new URLSearchParams({ redirect_uri: 'http://127.0.0.1:12345/callback', state: 's'.repeat(43), code_challenge: challenge }).toString();
  const auth = await handle(new Request(start), env);
  const google = new URL(auth.headers.get('Location'));
  const callback = new URL(env.PUBLIC_BASE_URL + '/auth/google/callback');
  callback.search = new URLSearchParams({ state: google.searchParams.get('state'), code: 'google-code' }).toString();
  const result = await handle(new Request(callback), env, async (url) => new Response(JSON.stringify(url.includes('/token') ? { access_token: 'google-access' } : { sub: subject, name: subject, email: subject + '@example.test', email_verified: true }), { headers: { 'Content-Type': 'application/json' } }));
  const code = new URL(result.headers.get('Location')).searchParams.get('code');
  const exchange = () => handle(new Request(env.PUBLIC_BASE_URL + '/auth/exchange', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, verifier }) }), env);
  return { session: await (await exchange()).json(), exchange, code, verifier };
}
