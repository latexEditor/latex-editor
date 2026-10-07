const encoder = new TextEncoder();
const MAX_BUNDLE = 50 * 1024 * 1024;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLES = ['owner', 'editor', 'viewer'];
const WRITE_ROLES = ['owner', 'editor'];
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const random = () => base64(crypto.getRandomValues(new Uint8Array(32)));
function base64(bytes) { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
async function digest(value) { return base64(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))); }

// R2 helpers — still used for auth flow temp state and bundles
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
function redirect(url) { return new Response(null, { status: 302, headers: { Location: url.toString(), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } }); }
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}
function secureEqual(left, right) {
  const a = new TextEncoder().encode(String(left));
  const b = new TextEncoder().encode(String(right));
  let different = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) different |= (a[index % a.length] || 0) ^ (b[index % b.length] || 0);
  return different === 0;
}
async function sendInvitationEmail(env, invitation) {
  if (!env.EMAIL || !env.EMAIL_FROM) return { sent: false, reason: 'not_configured' };
  const role = invitation.role === 'editor' ? 'chỉnh sửa' : 'xem';
  const inviteUrl = `${env.PUBLIC_BASE_URL}/invite/${invitation.id}`;
  try {
    const result = await env.EMAIL.send({
      to: invitation.email,
      from: { email: env.EMAIL_FROM, name: env.EMAIL_FROM_NAME || 'LaTeX Editor' },
      subject: `${invitation.inviterName} mời bạn tham gia “${invitation.projectName}”`,
      text: `${invitation.inviterName} đã mời bạn tham gia project “${invitation.projectName}” với quyền ${role}.\n\nMở lời mời: ${inviteUrl}\nMã lời mời: ${invitation.id}\n\nLời mời hết hạn sau 7 ngày.`,
      html: `<h2>Lời mời tham gia LaTeX Editor</h2><p><strong>${escapeHtml(invitation.inviterName)}</strong> đã mời bạn tham gia project <strong>${escapeHtml(invitation.projectName)}</strong> với quyền ${role}.</p><p><a href="${escapeHtml(inviteUrl)}">Mở lời mời</a></p><p>Mã lời mời: <code>${invitation.id}</code></p><p>Lời mời hết hạn sau 7 ngày.</p>`
    });
    return { sent: true, messageId: result?.messageId || null };
  } catch (error) {
    console.error(JSON.stringify({ message: 'invitation email failed', invitationId: invitation.id, error: error instanceof Error ? error.message : String(error) }));
    return { sent: false, reason: 'delivery_failed' };
  }
}

// D1 session — replaces R2 session lookup
async function session(request, env) {
  const token = request.headers.get('Authorization')?.replace(/^Bearer /, '');
  if (!TOKEN.test(token || '')) throw new HttpError(401, 'Cần đăng nhập.');
  const tokenHash = await digest(token);
  const row = await env.DB.prepare(
    'SELECT s.user_id, s.expires_at, u.id, u.email, u.name, u.avatar_url FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?'
  ).bind(tokenHash).first();
  if (!row || row.expires_at <= Date.now()) throw new HttpError(401, 'Phiên đăng nhập đã hết hạn.');
  return { user: { id: row.user_id, email: row.email, name: row.name, avatar_url: row.avatar_url || null }, expiresAt: row.expires_at, tokenHash };
}

// D1 authorization — check project membership
async function authorize(db, projectId, userId, requiredRoles) {
  const row = await db.prepare(
    'SELECT role FROM project_members WHERE project_id = ? AND user_id = ?'
  ).bind(projectId, userId).first();
  if (!row || !requiredRoles.includes(row.role)) throw new HttpError(403, 'Không có quyền thực hiện thao tác này.');
  return row.role;
}

export async function handleRequest(request, env, fetcher = fetch) {
  try {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === '/health') return json({ service: 'latex-editor-cloud', protocol: 'git-bundle-v1', configured: Boolean(env.DB && env.PROJECTS && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET), emailConfigured: Boolean(env.EMAIL && env.EMAIL_FROM) });
    if (!env.PROJECTS) throw new HttpError(503, 'Chưa cấu hình R2.');
    if (!env.DB) throw new HttpError(503, 'Chưa cấu hình D1.');

    const invitationPage = url.pathname.match(/^\/invite\/([a-f0-9-]{36})$/);
    if (invitationPage && request.method === 'GET') {
      const invitationId = invitationPage[1];
      return new Response(`<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Lời mời LaTeX Editor</title><style>body{font:16px/1.6 system-ui;margin:0;background:#f8fafc;color:#0f172a}.card{max-width:620px;margin:10vh auto;padding:32px;background:#fff;border:1px solid #e2e8f0;border-radius:14px;box-shadow:0 12px 35px #0f172a14}code{display:block;padding:12px;margin:16px 0;background:#f1f5f9;border-radius:8px;overflow-wrap:anywhere}h1{font-size:24px}</style></head><body><main class="card"><h1>Lời mời tham gia LaTeX Editor</h1><p>Mở ứng dụng, đăng nhập đúng tài khoản Google, chọn <strong>Tài khoản &amp; Cloud</strong> rồi dán mã sau:</p><code>${invitationId}</code><p>Lời mời có hiệu lực trong 7 ngày.</p></main></body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'", 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' } });
    }

    // Rate limit auth routes
    if (url.pathname.startsWith('/auth/') && url.pathname !== '/auth/logout') {
      await rateLimit(env.AUTH_RATE_LIMITER, request.headers.get('CF-Connecting-IP') || 'local');
    }

    // --- OAuth flow (auth temp state stays on R2) ---

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
          method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15000),
          body: new URLSearchParams({ code: url.searchParams.get('code'), client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: env.PUBLIC_BASE_URL + '/auth/google/callback', grant_type: 'authorization_code', code_verifier: login.googleVerifier })
        });
        if (!tokenResponse.ok) throw new HttpError(401, 'Google từ chối đăng nhập.');
        const tokens = await tokenResponse.json();
        const profileResponse = await fetcher('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${tokens.access_token}` }, redirect: 'manual', signal: AbortSignal.timeout(15000) });
        if (!profileResponse.ok) throw new HttpError(401, 'Không xác minh được tài khoản Google.');
        const profile = await profileResponse.json();
        if (!/^[A-Za-z0-9_-]{1,255}$/.test(profile.sub || '') || profile.email_verified !== true || typeof profile.email !== 'string') throw new HttpError(401, 'Tài khoản Google chưa được xác minh.');
        const user = {
          id: 'google-' + profile.sub,
          name: String(profile.name || profile.email).slice(0, 150),
          email: profile.email.slice(0, 254),
          avatar_url: profile.picture ? String(profile.picture).slice(0, 500) : null
        };
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
      // Upsert user in D1
      await env.DB.prepare(
        'INSERT INTO users (id, email, name, avatar_url) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET email = excluded.email, name = excluded.name, avatar_url = excluded.avatar_url, updated_at = datetime(\'now\')'
      ).bind(login.user.id, login.user.email, login.user.name, login.user.avatar_url || null).run();
      // Create session in D1
      const token = random();
      const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
      await env.DB.prepare(
        'INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)'
      ).bind(await digest(token), login.user.id, expiresAt).run();
      return json({ user: login.user, expiresAt, token });
    }

    // --- Authenticated routes ---
    const current = await session(request, env);

    if (url.pathname === '/auth/logout' && request.method === 'POST') {
      await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(current.tokenHash).run();
      return json({ signedOut: true });
    }

    if (url.pathname === '/v1/me' && request.method === 'GET') return json({ user: current.user, expiresAt: current.expiresAt });

    await rateLimit(env.PROJECT_RATE_LIMITER, current.user.id);

    // --- Project list (own + shared) ---
    if (url.pathname === '/v1/projects' && request.method === 'GET') {
      const limit = 25;
      const offset = Number(url.searchParams.get('cursor') || url.searchParams.get('offset') || 0);
      const { results } = await env.DB.prepare(
        'SELECT p.id, p.name, p.head, p.bundle_key, p.protocol, p.updated_at, p.updated_at AS updatedAt, m.role FROM projects p JOIN project_members m ON m.project_id = p.id WHERE m.user_id = ? ORDER BY p.updated_at DESC LIMIT ? OFFSET ?'
      ).bind(current.user.id, limit + 1, offset).all();
      const hasMore = results.length > limit;
      const projects = results.slice(0, limit).map((p) => ({
        ...p,
        etag: `"${p.updated_at}"`
      }));
      return json({ projects, cursor: hasMore ? String(offset + limit) : null });
    }

    // --- Team invitations ---

    // List received invitations for current user
    if (url.pathname === '/v1/my-invitations' && request.method === 'GET') {
      const now = Date.now();
      const userEmail = (current.user.email || '').toLowerCase().trim();
      const { results } = await env.DB.prepare(
        'SELECT i.id, i.project_id, i.inviter_id, i.role, i.created_at, i.expires_at, p.name AS project_name FROM invitations i JOIN projects p ON p.id = i.project_id WHERE i.email = ? AND i.status = \'pending\' AND i.expires_at > ? ORDER BY i.created_at DESC'
      ).bind(userEmail, now).all();
      const userRows = await env.DB.prepare('SELECT id, name, email FROM users').all();
      const userMap = new Map((userRows.results || []).map((u) => [u.id, u]));
      const invitations = (results || []).map((inv) => {
        const inviter = userMap.get(inv.inviter_id);
        return {
          id: inv.id,
          projectId: inv.project_id,
          projectName: inv.project_name,
          role: inv.role,
          inviterName: inviter?.name || inviter?.email || 'Thành viên',
          inviterEmail: inviter?.email || '',
          createdAt: inv.created_at,
          expiresAt: inv.expires_at
        };
      });
      return json({ invitations });
    }

    // Accept invitation by ID
    const inviteAccept = url.pathname.match(/^\/v1\/invitations\/([^/]+)\/accept$/);
    if (inviteAccept && request.method === 'POST') {
      const invitationId = inviteAccept[1];
      if (!ID.test(invitationId)) throw new HttpError(400, 'Mã lời mời không hợp lệ.');
      const invitation = await env.DB.prepare(
        'SELECT * FROM invitations WHERE id = ? AND status = \'pending\''
      ).bind(invitationId).first();
      if (!invitation || invitation.expires_at <= Date.now()) throw new HttpError(400, 'Lời mời đã hết hạn hoặc không tồn tại.');
      // If email-based, check that current user matches (case-insensitive)
      if (invitation.email && invitation.email.toLowerCase() !== current.user.email.toLowerCase()) {
        throw new HttpError(403, 'Lời mời này dành cho địa chỉ email khác.');
      }
      if (invitation.token_hash) {
        const body = await jsonBody(request);
        if (!TOKEN.test(body.token || '') || !secureEqual(await digest(body.token), invitation.token_hash)) {
          throw new HttpError(403, 'Token lời mời không hợp lệ.');
        }
      }
      // Accept: insert member + update invitation status
      await env.DB.batch([
        env.DB.prepare('INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?) ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role').bind(invitation.project_id, current.user.id, invitation.role),
        env.DB.prepare('UPDATE invitations SET status = \'accepted\' WHERE id = ?').bind(invitationId)
      ]);
      return json({ accepted: true, projectId: invitation.project_id, role: invitation.role });
    }

    // Decline invitation
    const inviteDecline = url.pathname.match(/^\/v1\/invitations\/([^/]+)\/decline$/);
    if (inviteDecline && request.method === 'POST') {
      const invitationId = inviteDecline[1];
      if (!ID.test(invitationId)) throw new HttpError(400, 'Mã lời mời không hợp lệ.');
      const userEmail = (current.user.email || '').toLowerCase().trim();
      const result = await env.DB.prepare(
        'UPDATE invitations SET status = \'revoked\' WHERE id = ? AND email = ? AND status = \'pending\''
      ).bind(invitationId, userEmail).run();
      if (!result.changes) throw new HttpError(404, 'Lời mời không tồn tại hoặc đã xử lý.');
      return json({ declined: true });
    }

    // --- Project-scoped routes ---
    const projectRoute = url.pathname.match(/^\/v1\/projects\/([^/]+)(\/.*)?$/);
    if (!projectRoute || !ID.test(projectRoute[1])) throw new HttpError(404, 'Không tìm thấy project.');
    const projectId = projectRoute[1];
    const subpath = projectRoute[2] || '';

    // Create new project (PUT with If-None-Match: *)
    if (subpath === '' && request.method === 'PUT' && request.headers.get('If-None-Match') === '*') {
      // New project — no membership check, creator becomes owner
      const head = request.headers.get('X-Git-Head');
      let name;
      try { name = decodeURIComponent(request.headers.get('X-Project-Name') || ''); } catch { throw new HttpError(400, 'Tên project không hợp lệ.'); }
      if (!/^[a-f0-9]{40}$/.test(head || '') || !name.trim() || name.length > 100 || /[\x00-\x1f]/.test(name)) throw new HttpError(400, 'Metadata project không hợp lệ.');
      const data = await boundedBody(request, MAX_BUNDLE);
      const header = new TextDecoder().decode(data.slice(0, 4096)).split('\n\n')[0];
      if (!header.startsWith('# v2 git bundle\n') || !header.split('\n').includes(head + ' refs/heads/main') || header.split('\n').some((line) => line.startsWith('-'))) throw new HttpError(400, 'Cần một Git bundle đầy đủ, phiên bản v2.');
      // Check project doesn't already exist
      const existing = await env.DB.prepare('SELECT id FROM projects WHERE id = ?').bind(projectId).first();
      if (existing) throw new HttpError(409, 'Xung đột: project cloud đã thay đổi. Hãy tải bản cloud để đối chiếu.');
      const bundleKey = 'bundles/' + projectId + '/' + crypto.randomUUID() + '.bundle';
      await env.PROJECTS.put(bundleKey, data, { httpMetadata: { contentType: 'application/x-git-bundle' } });
      const now = new Date().toISOString();
      await env.DB.batch([
        env.DB.prepare('INSERT INTO projects (id, name, head, bundle_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').bind(projectId, name, head, bundleKey, now, now),
        env.DB.prepare('INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)').bind(projectId, current.user.id, 'owner')
      ]);
      return json({ id: projectId, name, head, bundle_key: bundleKey, protocol: 'git-bundle-v1', updatedAt: now, etag: `"${now}"` });
    }

    // All remaining project routes require project to exist, then membership
    const project = await env.DB.prepare('SELECT * FROM projects WHERE id = ?').bind(projectId).first();
    if (!project) throw new HttpError(404, 'Không tìm thấy project.');
    const role = await authorize(env.DB, projectId, current.user.id, ROLES);

    // GET project meta
    if (subpath === '/meta' && request.method === 'GET') {
      return json({ id: project.id, name: project.name, head: project.head, protocol: project.protocol, updatedAt: project.updated_at, role, etag: `"${project.updated_at}"` });
    }

    // GET project bundle (download)
    if (subpath === '' && request.method === 'GET') {
      const bundle = await env.PROJECTS.get(project.bundle_key);
      if (!bundle) throw new HttpError(503, 'Dữ liệu phiên bản chưa sẵn sàng.');
      return new Response(bundle.body, { headers: {
        'Content-Type': 'application/x-git-bundle', 'Content-Length': String(bundle.size), 'Cache-Control': 'no-store',
        'ETag': `"${project.updated_at}"`,
        'X-Git-Head': project.head, 'X-Project-Name': encodeURIComponent(project.name), 'X-Updated-At': project.updated_at
      } });
    }

    // PUT project (update) — owner or editor
    if (subpath === '' && request.method === 'PUT') {
      await authorize(env.DB, projectId, current.user.id, WRITE_ROLES);
      const ifMatch = request.headers.get('If-Match');
      const normalizedIfMatch = ifMatch?.replace(/^"(.*)"$/, '$1');
      if (!ifMatch || (ifMatch !== project.updated_at && normalizedIfMatch !== project.updated_at)) throw new HttpError(409, 'Xung đột: project cloud đã thay đổi. Hãy tải bản cloud để đối chiếu.');
      const head = request.headers.get('X-Git-Head');
      let name;
      try { name = decodeURIComponent(request.headers.get('X-Project-Name') || ''); } catch { throw new HttpError(400, 'Tên project không hợp lệ.'); }
      if (!/^[a-f0-9]{40}$/.test(head || '') || !name.trim() || name.length > 100 || /[\x00-\x1f]/.test(name)) throw new HttpError(400, 'Metadata project không hợp lệ.');
      const data = await boundedBody(request, MAX_BUNDLE);
      const header = new TextDecoder().decode(data.slice(0, 4096)).split('\n\n')[0];
      if (!header.startsWith('# v2 git bundle\n') || !header.split('\n').includes(head + ' refs/heads/main') || header.split('\n').some((line) => line.startsWith('-'))) throw new HttpError(400, 'Cần một Git bundle đầy đủ, phiên bản v2.');
      const bundleKey = 'bundles/' + projectId + '/' + crypto.randomUUID() + '.bundle';
      await env.PROJECTS.put(bundleKey, data, { httpMetadata: { contentType: 'application/x-git-bundle' } });
      const now = new Date().toISOString();
      const result = await env.DB.prepare(
        'UPDATE projects SET name = ?, head = ?, bundle_key = ?, updated_at = ? WHERE id = ? AND updated_at = ?'
      ).bind(name, head, bundleKey, now, projectId, project.updated_at).run();
      if (!result.changes) {
        await env.PROJECTS.delete(bundleKey);
        throw new HttpError(409, 'Xung đột: project vừa được cập nhật từ máy khác.');
      }
      return json({ id: projectId, name, head, bundle_key: bundleKey, protocol: 'git-bundle-v1', updatedAt: now, etag: `"${now}"` });
    }

    // --- Team management routes (under /v1/projects/:id/...) ---

    // GET members
    if (subpath === '/members' && request.method === 'GET') {
      const { results } = await env.DB.prepare(
        'SELECT u.id, u.email, u.name, u.avatar_url, m.role, m.joined_at FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = ? ORDER BY m.joined_at'
      ).bind(projectId).all();
      return json({ members: results });
    }

    // POST invite — owner only
    if (subpath === '/invite' && request.method === 'POST') {
      await authorize(env.DB, projectId, current.user.id, ['owner']);
      const body = await jsonBody(request);
      const inviteRole = body.role;
      if (!inviteRole || !['editor', 'viewer'].includes(inviteRole)) throw new HttpError(400, 'Quyền mời không hợp lệ.');
      const invitationId = crypto.randomUUID();
      const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
      if (body.email) {
        // Email-based invitation
        if (!EMAIL.test(body.email)) throw new HttpError(400, 'Email không hợp lệ.');
        const email = body.email.toLowerCase().trim();
        // Check if already a member
        const existingUser = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
        if (existingUser) {
          const existingMember = await env.DB.prepare('SELECT role FROM project_members WHERE project_id = ? AND user_id = ?').bind(projectId, existingUser.id).first();
          if (existingMember) throw new HttpError(409, 'Người dùng này đã là thành viên.');
        }
        // Check duplicate pending invitation
        const pendingInvite = await env.DB.prepare('SELECT id FROM invitations WHERE project_id = ? AND email = ? AND status = \'pending\' AND expires_at > ?').bind(projectId, email, Date.now()).first();
        if (pendingInvite) throw new HttpError(409, 'Đã có lời mời đang chờ cho email này.');
        await env.DB.prepare(
          'INSERT INTO invitations (id, project_id, inviter_id, email, role, expires_at) VALUES (?, ?, ?, ?, ?, ?)'
        ).bind(invitationId, projectId, current.user.id, email, inviteRole, expiresAt).run();
        const delivery = await sendInvitationEmail(env, { id: invitationId, email, role: inviteRole, expiresAt, projectName: project.name, inviterName: current.user.name || current.user.email });
        return json({ invitation: { id: invitationId, email, role: inviteRole, expiresAt }, delivery });
      } else {
        // Link-based invitation
        const inviteToken = random();
        const inviteTokenHash = await digest(inviteToken);
        await env.DB.prepare(
          'INSERT INTO invitations (id, project_id, inviter_id, token_hash, role, expires_at) VALUES (?, ?, ?, ?, ?, ?)'
        ).bind(invitationId, projectId, current.user.id, inviteTokenHash, inviteRole, expiresAt).run();
        return json({ invitation: { id: invitationId, token: inviteToken, role: inviteRole, expiresAt } });
      }
    }

    // GET invitations list — owner only
    if (subpath === '/invitations' && request.method === 'GET') {
      await authorize(env.DB, projectId, current.user.id, ['owner']);
      const { results } = await env.DB.prepare(
        'SELECT i.id, i.email, i.role, i.status, i.created_at, i.expires_at, u.name AS inviter_name FROM invitations i JOIN users u ON u.id = i.inviter_id WHERE i.project_id = ? ORDER BY i.created_at DESC'
      ).bind(projectId).all();
      return json({ invitations: results });
    }

    // DELETE member — owner only (cannot remove self if last owner)
    if (subpath.match(/^\/members\//) && request.method === 'DELETE') {
      await authorize(env.DB, projectId, current.user.id, ['owner']);
      const targetUserId = decodeURIComponent(subpath.replace('/members/', ''));
      if (targetUserId === current.user.id) {
        const ownerCount = await env.DB.prepare('SELECT COUNT(*) AS count FROM project_members WHERE project_id = ? AND role = \'owner\'').bind(projectId).first();
        if (ownerCount.count <= 1) throw new HttpError(400, 'Không thể rời project khi bạn là chủ sở hữu duy nhất.');
      }
      await env.DB.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').bind(projectId, targetUserId).run();
      return json({ removed: true });
    }

    // PATCH revoke invitation — owner only
    const revokeMatch = subpath.match(/^\/invitations\/([^/]+)\/revoke$/);
    if (revokeMatch && request.method === 'POST') {
      await authorize(env.DB, projectId, current.user.id, ['owner']);
      const invId = revokeMatch[1];
      if (!ID.test(invId)) throw new HttpError(400, 'Mã lời mời không hợp lệ.');
      const result = await env.DB.prepare('UPDATE invitations SET status = \'revoked\' WHERE id = ? AND project_id = ? AND status = \'pending\'').bind(invId, projectId).run();
      if (!result.changes) throw new HttpError(404, 'Lời mời không tồn tại hoặc đã xử lý.');
      return json({ revoked: true });
    }

    throw new HttpError(405, 'Phương thức không được hỗ trợ.');
  } catch (error) {
    return json({ error: error instanceof HttpError ? error.message : 'Dịch vụ chưa xử lý được yêu cầu. Hãy thử lại sau.' }, error instanceof HttpError ? error.status : 500);
  }
}

export default { fetch: (request, env) => handleRequest(request, env) };
