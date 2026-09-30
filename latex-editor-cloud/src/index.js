const encoder = new TextEncoder();
const MAX_BUNDLE = 50 * 1024 * 1024;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const random = () => base64(crypto.getRandomValues(new Uint8Array(32)));
function base64(bytes) { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
async function digest(value) { return base64(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))); }
async function getJson(bucket, key) {
  const object = await bucket.get(key);
  return object ? { object, value: await object.json() } : null;
}
async function boundedBody(request, limit) {
  if (Number(request.headers.get('Content-Length')) > limit) throw new HttpError(413, 'Dữ liệu vượt giới hạn cho phép.');
  const chunks = [];
  let length = 0;
  if (request.body) for await (const chunk of request.body) {
    length += chunk.byteLength;
    if (length > limit) throw new HttpError(413, 'Dữ liệu vượt giới hạn cho phép.');
    chunks.push(chunk);
  }
  const data = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
  return data;
}
async function jsonBody(request) {
  try { return JSON.parse(new TextDecoder().decode(await boundedBody(request, 8192))); }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'JSON không hợp lệ.'); }
}
async function rateLimit(binding, key) {
  if (!binding) throw new HttpError(503, 'Dịch vụ chưa được cấu hình đầy đủ.');
  if (!(await binding.limit({ key })).success) throw new HttpError(429, 'Quá nhiều yêu cầu. Hãy thử lại sau một phút.');
}
function loopback(value) {
  let url;
  try { url = new URL(value); } catch { throw new HttpError(400, 'Callback không hợp lệ.'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/callback' || url.username || url.password || url.search || url.hash) throw new HttpError(400, 'Callback không hợp lệ.');
  return url;
}
async function consume(bucket, key, predicate) {
  const item = await getJson(bucket, key);
  if (!item || item.value.used || item.value.expiresAt <= Date.now() || !await predicate(item.value)) throw new HttpError(400, 'Phiên đăng nhập đã hết hạn hoặc không hợp lệ.');
  const claimed = await bucket.put(key, JSON.stringify({ ...item.value, used: true }), { onlyIf: { etagMatches: item.object.etag } });
  if (!claimed) throw new HttpError(409, 'Phiên đăng nhập đã được sử dụng.');
  return item.value;
}
async function session(request, env) {
  const token = request.headers.get('Authorization')?.replace(/^Bearer /, '');
  if (!TOKEN.test(token || '')) throw new HttpError(401, 'Cần đăng nhập.');
  const key = 'auth/session/' + await digest(token);
  const item = await getJson(env.PROJECTS, key);
  if (!item || item.value.expiresAt <= Date.now()) throw new HttpError(401, 'Phiên đăng nhập đã hết hạn.');
  return { ...item.value, key };
}
function redirect(url) { return new Response(null, { status: 302, headers: { Location: url.toString(), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } }); }

export async function handleRequest(request, env, fetcher = fetch) {
  try {
    const url = new URL(request.url);
    if (url.pathname === '/health') return json({ service: 'latex-editor-cloud', protocol: 'git-bundle-v1', configured: Boolean(env.PROJECTS && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) });
    if (!env.PROJECTS) throw new HttpError(503, 'Chưa cấu hình R2.');
    if (url.pathname.startsWith('/auth/') && url.pathname !== '/auth/logout') {
      await rateLimit(env.AUTH_RATE_LIMITER, request.headers.get('CF-Connecting-IP') || 'local');
    }
    if (url.pathname === '/auth/google/start' && request.method === 'GET') {
      if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.PUBLIC_BASE_URL) throw new HttpError(503, 'Chưa cấu hình đăng nhập Google.');
      const callback = loopback(url.searchParams.get('redirect_uri'));
      const state = url.searchParams.get('state');
      const challenge = url.searchParams.get('code_challenge');
      if (!TOKEN.test(state || '') || !TOKEN.test(challenge || '')) throw new HttpError(400, 'Tham số đăng nhập không hợp lệ.');
      const googleState = random();
      const googleVerifier = random();
      await env.PROJECTS.put('auth/login/' + await digest(googleState), JSON.stringify({ callback: callback.toString(), state, challenge, googleVerifier, expiresAt: Date.now() + 180000 }));
      const google = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      for (const [key, value] of Object.entries({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: env.PUBLIC_BASE_URL + '/auth/google/callback', response_type: 'code', scope: 'openid email profile', state: googleState, code_challenge: await digest(googleVerifier), code_challenge_method: 'S256', prompt: 'select_account' })) google.searchParams.set(key, value);
      return redirect(google);
    }
    if (url.pathname === '/auth/google/callback' && request.method === 'GET') {
      const state = url.searchParams.get('state');
      if (!TOKEN.test(state || '')) throw new HttpError(400, 'OAuth state không hợp lệ.');
      const login = await consume(env.PROJECTS, 'auth/login/' + await digest(state), () => true);
      const callback = loopback(login.callback);
      callback.searchParams.set('state', login.state);
      if (url.searchParams.has('error') || !url.searchParams.get('code')) {
        callback.searchParams.set('error', 'access_denied'); return redirect(callback);
      }
      try {
        const tokenResponse = await fetcher('https://oauth2.googleapis.com/token', {
          // Older workerd versions reject redirect: 'error'. Manual returns
          // 3xx responses, which the response.ok check below rejects.
          method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15000),
          body: new URLSearchParams({ code: url.searchParams.get('code'), client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: env.PUBLIC_BASE_URL + '/auth/google/callback', grant_type: 'authorization_code', code_verifier: login.googleVerifier })
        });
        if (!tokenResponse.ok) throw new HttpError(401, 'Google từ chối đăng nhập.');
        const tokens = await tokenResponse.json();
        const profileResponse = await fetcher('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${tokens.access_token}` }, redirect: 'manual', signal: AbortSignal.timeout(15000) });
        if (!profileResponse.ok) throw new HttpError(401, 'Không xác minh được tài khoản Google.');
        const profile = await profileResponse.json();
        if (!/^[A-Za-z0-9_-]{1,255}$/.test(profile.sub || '') || profile.email_verified !== true || typeof profile.email !== 'string') throw new HttpError(401, 'Tài khoản Google chưa được xác minh.');
        const user = { id: 'google-' + profile.sub, name: String(profile.name || profile.email).slice(0, 150), email: profile.email.slice(0, 254) };
        const code = random();
        await env.PROJECTS.put('auth/code/' + await digest(code), JSON.stringify({ user, challenge: login.challenge, expiresAt: Date.now() + 60000 }));
        callback.searchParams.set('code', code);
        return redirect(callback);
      } catch {
        callback.searchParams.delete('code');
        callback.searchParams.set('error', 'authentication_failed');
        return redirect(callback);
      }
    }
    if (url.pathname === '/auth/exchange' && request.method === 'POST') {
      const { code, verifier } = await jsonBody(request);
      if (!TOKEN.test(code || '') || !TOKEN.test(verifier || '')) throw new HttpError(400, 'Mã đăng nhập không hợp lệ.');
      const login = await consume(env.PROJECTS, 'auth/code/' + await digest(code), async (value) => value.challenge === await digest(verifier));
      const token = random();
      const data = { user: login.user, expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000 };
      await env.PROJECTS.put('auth/session/' + await digest(token), JSON.stringify(data));
      return json({ ...data, token });
    }
    const current = await session(request, env);
    if (url.pathname === '/auth/logout' && request.method === 'POST') { await env.PROJECTS.delete(current.key); return json({ signedOut: true }); }
    if (url.pathname === '/v1/me' && request.method === 'GET') return json({ user: current.user, expiresAt: current.expiresAt });
    await rateLimit(env.PROJECT_RATE_LIMITER, current.user.id);
    const prefix = 'users/' + await digest(current.user.id) + '/';
    if (url.pathname === '/v1/projects' && request.method === 'GET') {
      const objects = await env.PROJECTS.list({ prefix: prefix + 'projects/', limit: 25, cursor: url.searchParams.get('cursor') || undefined });
      const projects = [];
      for (const object of objects.objects) {
        const item = await getJson(env.PROJECTS, object.key);
        if (item) projects.push({ ...item.value, etag: item.object.httpEtag });
      }
      return json({ projects, cursor: objects.truncated ? objects.cursor : null });
    }
    const match = url.pathname.match(/^\/v1\/projects\/([^/]+)(\/meta)?$/);
    if (!match || !ID.test(match[1])) throw new HttpError(404, 'Không tìm thấy project.');
    const id = match[1];
    const key = prefix + 'projects/' + id + '.json';
    const existing = await getJson(env.PROJECTS, key);
    if (request.method === 'GET') {
      if (!existing) throw new HttpError(404, 'Không tìm thấy project.');
      if (match[2]) return json({ ...existing.value, etag: existing.object.httpEtag });
      const bundle = await env.PROJECTS.get(prefix + 'bundles/' + existing.value.bundle);
      if (!bundle) throw new HttpError(503, 'Dữ liệu phiên bản chưa sẵn sàng.');
      return new Response(bundle.body, { headers: {
        'Content-Type': 'application/x-git-bundle', 'Content-Length': String(bundle.size), 'Cache-Control': 'no-store',
        ETag: existing.object.httpEtag, 'X-Git-Head': existing.value.head, 'X-Project-Name': encodeURIComponent(existing.value.name)
      } });
    }
    if (request.method === 'PUT' && !match[2]) {
      const condition = existing
        ? request.headers.get('If-Match') === existing.object.httpEtag
        : request.headers.get('If-None-Match') === '*';
      if (!condition) throw new HttpError(409, 'Xung đột: project cloud đã thay đổi. Hãy tải bản cloud để đối chiếu.');
      const head = request.headers.get('X-Git-Head');
      let name;
      try { name = decodeURIComponent(request.headers.get('X-Project-Name') || ''); } catch { throw new HttpError(400, 'Tên project không hợp lệ.'); }
      if (!/^[a-f0-9]{40}$/.test(head || '') || !name.trim() || name.length > 100 || /[\x00-\x1f]/.test(name)) throw new HttpError(400, 'Metadata project không hợp lệ.');
      const data = await boundedBody(request, MAX_BUNDLE);
      const header = new TextDecoder().decode(data.slice(0, 4096)).split('\n\n')[0];
      if (!header.startsWith('# v2 git bundle\n') || !header.split('\n').includes(head + ' refs/heads/main') || header.split('\n').some((line) => line.startsWith('-'))) throw new HttpError(400, 'Cần một Git bundle đầy đủ, phiên bản v2.');
      const bundle = crypto.randomUUID() + '.bundle';
      await env.PROJECTS.put(prefix + 'bundles/' + bundle, data, { httpMetadata: { contentType: 'application/x-git-bundle' } });
      const project = { id, name, head, bundle, protocol: 'git-bundle-v1', updatedAt: new Date().toISOString() };
      const written = await env.PROJECTS.put(key, JSON.stringify(project), { onlyIf: existing ? { etagMatches: existing.object.etag } : { etagDoesNotMatch: '*' } });
      if (!written) {
        await env.PROJECTS.delete(prefix + 'bundles/' + bundle);
        throw new HttpError(409, 'Xung đột: project vừa được cập nhật từ máy khác.');
      }
      return json({ ...project, etag: written.httpEtag });
    }
    throw new HttpError(405, 'Phương thức không được hỗ trợ.');
  } catch (error) {
    return json({ error: error instanceof HttpError ? error.message : 'Dịch vụ chưa xử lý được yêu cầu. Hãy thử lại sau.' }, error instanceof HttpError ? error.status : 500);
  }
}

export default { fetch: (request, env) => handleRequest(request, env) };
