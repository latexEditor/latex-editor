const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

function normalizeApiUrl(value) {
  if (!value) return '';
  const url = new URL(value);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)))
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Backend phải là một HTTPS origin (hoặc localhost khi phát triển).');
  }
  return url.origin;
}

let defaultFetcher = global.fetch;
try {
  const { Agent } = require('undici');
  const agent = new Agent({ connect: { timeout: 30000 } });
  defaultFetcher = (url, options = {}) => global.fetch(url, { dispatcher: agent, ...options });
} catch {
  // Use global.fetch as fallback
}

class AuthManager {
  constructor(config, { safeStorage, openExternal, fetch: fetcher = defaultFetcher, onChange = () => {} }) {
    this.apiUrl = normalizeApiUrl(config.apiUrl);
    this.sessionFile = config.sessionFile;
    this.storage = safeStorage;
    this.openExternal = openExternal;
    this.fetch = fetcher;
    this.onChange = onChange;
    this.session = null;
    this.pending = null;
    this.generation = 0;
    this.controller = new AbortController();
    this.storageQueue = Promise.resolve();
  }

  storageTask(task) {
    const result = this.storageQueue.catch(() => {}).then(task);
    this.storageQueue = result;
    return result;
  }

  async canPersist() {
    if (process.platform === 'linux' && this.storage?.getSelectedStorageBackend?.() === 'basic_text') return false;
    if (this.storage?.isAsyncEncryptionAvailable) return this.storage.isAsyncEncryptionAvailable();
    return this.storage?.isEncryptionAvailable?.() || false;
  }

  status() {
    const valid = this.session && this.session.expiresAt > Date.now();
    return { configured: Boolean(this.apiUrl), signedIn: Boolean(valid), user: valid ? this.session.user : null, signingIn: Boolean(this.pending) };
  }

  async initialize() {
    if (!this.apiUrl) return;
    try {
      if (!await this.canPersist()) return;
      const bytes = await fs.readFile(this.sessionFile);
      const decrypted = this.storage.decryptStringAsync
        ? (await this.storage.decryptStringAsync(bytes)).result
        : this.storage.decryptString(bytes);
      const saved = JSON.parse(decrypted);
      if (saved.apiUrl === this.apiUrl && saved.expiresAt > Date.now() && /^[A-Za-z0-9_-]{43}$/.test(saved.token || '') && saved.user?.id) this.session = saved;
    } catch (error) {
      if (error.code !== 'ENOENT') await fs.rm(this.sessionFile, { force: true }).catch(() => {});
    }
  }

  async persist(session, generation) {
    return this.storageTask(async () => {
      if (!await this.canPersist()) return; // Session stays in memory.
      const value = JSON.stringify({ ...session, apiUrl: this.apiUrl });
      const encrypted = this.storage.encryptStringAsync
        ? await this.storage.encryptStringAsync(value) : this.storage.encryptString(value);
      if (generation !== this.generation) return;
      await fs.mkdir(path.dirname(this.sessionFile), { recursive: true });
      const temporary = this.sessionFile + '.' + crypto.randomUUID() + '.tmp';
      try {
        await fs.writeFile(temporary, encrypted, { flag: 'wx', mode: 0o600 });
        if (generation === this.generation) await fs.rename(temporary, this.sessionFile);
      } finally { await fs.rm(temporary, { force: true }); }
    });
  }

  async request(route, options = {}) {
    if (!this.status().signedIn) throw new Error('Hãy đăng nhập để đồng bộ project.');
    const generation = this.generation;
    const response = await this.fetch(this.apiUrl + route, {
      ...options, redirect: 'error',
      headers: { ...options.headers, Authorization: `Bearer ${this.session.token}` },
      signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(60000)])
    });
    if (generation !== this.generation) throw new Error('Phiên đăng nhập đã thay đổi.');
    if (response.status === 401) {
      await this.logout(false);
      throw new Error('Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại.');
    }
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const error = new Error(body.error || `Dịch vụ trả về lỗi ${response.status}.`);
      error.status = response.status;
      throw error;
    }
    return response;
  }

  async login() {
    if (!this.apiUrl) throw new Error('Cloud chưa được cấu hình cho bản ứng dụng này.');
    if (this.pending) throw new Error('Một lượt đăng nhập đang chờ hoàn tất trong trình duyệt.');
    if (this.status().signedIn) return this.status();
    const state = crypto.randomBytes(32).toString('base64url');
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const generation = this.generation;
    return new Promise((resolve, reject) => {
      let finished = false;
      let exchanging = false;
      const server = http.createServer(async (request, response) => {
        const url = new URL(request.url, 'http://127.0.0.1');
        if (request.method !== 'GET' || url.pathname !== '/callback' || url.searchParams.get('state') !== state || exchanging) {
          response.writeHead(400).end('Invalid login callback.'); return;
        }
        exchanging = true;
        response.setHeader('Content-Type', 'text/plain; charset=utf-8');
        response.setHeader('Cache-Control', 'no-store');
        try {
          const code = url.searchParams.get('code');
          if (!code || !/^[A-Za-z0-9_-]{43}$/.test(code)) throw new Error('Đăng nhập Google đã bị hủy hoặc không thành công.');
          const result = await this.fetch(this.apiUrl + '/auth/exchange', {
            method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code, verifier }),
            signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(30000)])
          });
          if (!result.ok) throw new Error('Không thể hoàn tất đăng nhập Google. Hãy thử lại.');
          const session = await result.json();
          if (!session.user?.id || !/^[A-Za-z0-9_-]{43}$/.test(session.token || '') || !(session.expiresAt > Date.now())) throw new Error('Dữ liệu phiên đăng nhập không hợp lệ.');
          if (finished || generation !== this.generation) throw new Error('Đăng nhập đã bị hủy.');
          await this.persist(session, generation);
          if (finished || generation !== this.generation) {
            throw new Error('Đăng nhập đã bị hủy.');
          }
          this.session = session;
          response.end('Đăng nhập thành công. Bạn có thể đóng tab này và quay lại LaTeX Editor.');
          finish();
        } catch (error) { response.statusCode = 400; response.end('Đăng nhập không thành công. Quay lại ứng dụng để thử lại.'); finish(error); }
      });
      const timer = setTimeout(() => finish(new Error('Hết thời gian chờ đăng nhập.')), 180000);
      const finish = (error) => {
        if (finished) return;
        finished = true;
        if (error && generation === this.generation) {
          this.generation += 1;
          this.controller.abort();
          this.controller = new AbortController();
          void this.storageTask(() => fs.rm(this.sessionFile, { force: true })).catch(() => {});
        }
        clearTimeout(timer);
        server.close();
        server.closeIdleConnections();
        this.pending = null;
        this.onChange();
        if (error) reject(error); else resolve(this.status());
      };
      this.pending = { cancel: () => finish(new Error('Đã hủy đăng nhập.')) };
      this.onChange();
      server.on('error', finish);
      server.listen(0, '127.0.0.1', async () => {
        if (finished) { server.close(); return; }
        const url = new URL(this.apiUrl + '/auth/google/start');
        url.searchParams.set('redirect_uri', `http://127.0.0.1:${server.address().port}/callback`);
        url.searchParams.set('state', state);
        url.searchParams.set('code_challenge', challenge);
        try { await this.openExternal(url.toString()); } catch (error) { finish(error); }
      });
    });
  }

  async logout(revoke = true) {
    const previous = this.session;
    this.generation += 1;
    this.controller.abort();
    this.controller = new AbortController();
    this.session = null;
    this.pending?.cancel();
    this.onChange();
    await this.storageTask(() => fs.rm(this.sessionFile, { force: true }));
    if (revoke && previous?.token) {
      try {
        const result = await this.fetch(this.apiUrl + '/auth/logout', { method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${previous.token}` }, signal: AbortSignal.timeout(10000) });
        if (!result.ok) throw new Error('Không thu hồi được phiên.');
      } catch { return { ...this.status(), warning: 'Đã đăng xuất trên máy này; chưa thu hồi được phiên trên server do lỗi kết nối.' }; }
    }
    return this.status();
  }

  dispose() { this.generation += 1; this.controller.abort(); this.pending?.cancel(); }
}

module.exports = { AuthManager, normalizeApiUrl };
