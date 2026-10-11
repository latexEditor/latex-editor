const crypto = require('node:crypto');
const http = require('node:http');

const MAX_BODY_BYTES = 2 * 1024 * 1024;

class CollaborationBridge {
  constructor({ onMessage = () => {} } = {}) {
    this.onMessage = onMessage;
    this.token = crypto.randomBytes(32).toString('base64url');
    this.server = null;
    this.port = null;
    this.pending = [];
    this.waiters = new Set();
  }

  async start() {
    if (this.server) return this.connection();
    this.server = http.createServer((request, response) => this.#handle(request, response));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    this.port = this.server.address().port;
    return this.connection();
  }

  connection() { return { port: this.port, token: this.token }; }

  publish(message) {
    if (!message || typeof message !== 'object') return;
    if (this.waiters.size) {
      for (const waiter of this.waiters) waiter([message]);
      this.waiters.clear();
    } else {
      this.pending.push(message);
      if (this.pending.length > 200) this.pending.splice(0, this.pending.length - 200);
    }
  }

  async stop() {
    for (const waiter of this.waiters) waiter([]);
    this.waiters.clear();
    const server = this.server;
    this.server = null;
    this.port = null;
    if (!server) return;
    await new Promise((resolve) => server.close(resolve));
  }

  #authorized(request) {
    const provided = request.headers['x-latex-editor-bridge-token'];
    if (typeof provided !== 'string') return false;
    const left = crypto.createHash('sha256').update(provided).digest();
    const right = crypto.createHash('sha256').update(this.token).digest();
    return crypto.timingSafeEqual(left, right);
  }

  async #handle(request, response) {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    if (!this.#authorized(request)) {
      response.writeHead(401).end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    if (request.method === 'POST' && request.url === '/events') {
      try {
        const chunks = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Too large'), { status: 413 });
          chunks.push(chunk);
        }
        const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        await this.onMessage(message);
        response.end(JSON.stringify({ accepted: true }));
      } catch (error) {
        response.writeHead(error.status || 400).end(JSON.stringify({ error: error.message }));
      }
      return;
    }
    if (request.method === 'GET' && request.url === '/events') {
      if (this.pending.length) {
        response.end(JSON.stringify({ events: this.pending.splice(0) }));
        return;
      }
      let settled = false;
      const finish = (events) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.waiters.delete(finish);
        if (!response.destroyed) response.end(JSON.stringify({ events }));
      };
      const timer = setTimeout(() => finish([]), 15_000);
      this.waiters.add(finish);
      request.once('close', () => finish([]));
      return;
    }
    response.writeHead(404).end(JSON.stringify({ error: 'Not found' }));
  }
}

module.exports = { CollaborationBridge };
