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

/**
 * Minimal in-memory D1 simulator for testing.
 * Supports the exact SQL patterns used by the worker — not a general SQL engine.
 */
export class MemoryD1 {
  constructor() {
    this.tables = {
      users: [],
      sessions: [],
      projects: [],
      project_members: [],
      invitations: []
    };
  }

  prepare(sql) { return new MemoryD1Statement(this, sql); }

  async batch(statements) {
    const results = [];
    for (const stmt of statements) results.push(await stmt.run());
    return results;
  }
}

class MemoryD1Statement {
  constructor(db, sql) { this.db = db; this.sql = sql; this.params = []; }

  bind(...params) { this.params = params; return this; }

  async first() {
    const { results } = await this.all();
    return results[0] || null;
  }

  async run() { return this.all(); }

  async all() {
    const sql = this.sql.trim();
    const p = this.params;

    // --- INSERT ---
    if (/^INSERT\s+INTO/i.test(sql)) return this._insert(sql, p);
    // --- SELECT ---
    if (/^SELECT/i.test(sql)) return this._select(sql, p);
    // --- UPDATE ---
    if (/^UPDATE/i.test(sql)) return this._update(sql, p);
    // --- DELETE ---
    if (/^DELETE/i.test(sql)) return this._delete(sql, p);

    throw new Error(`MemoryD1: unsupported: ${sql}`);
  }

  // ---------- INSERT ----------
  _insert(sql, p) {
    // INSERT INTO table (cols) VALUES (placeholders) [ON CONFLICT(cols) DO UPDATE SET ...]
    const m = sql.match(/^INSERT\s+INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i);
    if (!m) throw new Error('MemoryD1 INSERT parse fail: ' + sql);
    const table = m[1];
    const cols = m[2].split(',').map((c) => c.trim());
    const placeholders = m[3].split(',').map((v) => v.trim());
    const rows = this.db.tables[table];
    if (!rows) throw new Error(`No table: ${table}`);

    // Build row from params
    const row = {};
    let pi = 0;
    for (let i = 0; i < cols.length; i++) {
      if (placeholders[i] === '?') {
        row[cols[i]] = p[pi++];
      } else {
        // literal e.g. datetime('now')
        row[cols[i]] = new Date().toISOString();
      }
    }
    // Defaults
    if (!row.created_at) row.created_at = new Date().toISOString();
    if ((table === 'users' || table === 'projects') && !row.updated_at) row.updated_at = new Date().toISOString();
    if (table === 'project_members' && !row.joined_at) row.joined_at = new Date().toISOString();
    if (table === 'invitations' && !row.status) row.status = 'pending';

    // ON CONFLICT?
    const conflict = sql.match(/ON\s+CONFLICT\s*\(([^)]+)\)\s*DO\s+UPDATE\s+SET\s+(.+)$/i);
    if (conflict) {
      const conflictCols = conflict[1].split(',').map((c) => c.trim());
      const idx = rows.findIndex((r) => conflictCols.every((c) => r[c] === row[c]));
      if (idx >= 0) {
        const updates = conflict[2].split(',').map((u) => u.trim());
        for (const u of updates) {
          const [col, expr] = u.split('=').map((s) => s.trim());
          if (expr.startsWith('excluded.')) rows[idx][col] = row[expr.replace('excluded.', '')];
          else if (expr.includes("datetime('now')")) rows[idx][col] = new Date().toISOString();
        }
        return { results: [], changes: 1 };
      }
    }
    // Check PK uniqueness
    const pkMap = { users: ['id'], sessions: ['token_hash'], projects: ['id'], invitations: ['id'], project_members: ['project_id', 'user_id'] };
    const pk = pkMap[table] || [];
    if (pk.length && rows.some((r) => pk.every((c) => r[c] === row[c]))) {
      throw new Error(`UNIQUE constraint failed: ${table}`);
    }
    rows.push(row);
    return { results: [], changes: 1 };
  }

  // ---------- SELECT ----------
  _select(sql, p) {
    // Handle COUNT
    const countMatch = sql.match(/^SELECT\s+COUNT\(\*\)\s+AS\s+(\w+)\s+FROM\s+(\w+)\s+WHERE\s+(.+)$/i);
    if (countMatch) {
      const table = countMatch[2];
      const rows = this._where(this.db.tables[table] || [], countMatch[3], p, 0).rows;
      return { results: [{ [countMatch[1]]: rows.length }] };
    }

    // JOIN query
    const joinMatch = sql.match(/^SELECT\s+(.+?)\s+FROM\s+(\w+)\s+(\w+)\s+JOIN\s+(\w+)\s+(\w+)\s+ON\s+(\w+)\.(\w+)\s*=\s*(\w+)\.(\w+)\s*(?:WHERE\s+(.+?))?(?:\s+ORDER\s+BY\s+(.+?))?(?:\s+LIMIT\s+(\?|\d+)(?:\s+OFFSET\s+(\?|\d+))?)?$/i);
    if (joinMatch) {
      const [, selectCols, t1, a1, t2, a2, jAlias1, jCol1, jAlias2, jCol2, where, order, limitRaw, offsetRaw] = joinMatch;
      const rows1 = this.db.tables[t1] || [];
      const rows2 = this.db.tables[t2] || [];

      // Join
      let joined = [];
      for (const r1 of rows1) {
        for (const r2 of rows2) {
          const v1 = (jAlias1 === a1 ? r1 : r2)[jCol1];
          const v2 = (jAlias2 === a2 ? r2 : r1)[jCol2];
          if (v1 === v2) joined.push({ [a1]: r1, [a2]: r2 });
        }
      }

      // Where (on joined rows)
      if (where) {
        let pi = 0;
        const conds = where.split(/\s+AND\s+/i);
        joined = joined.filter((jr) => {
          for (const cond of conds) {
            const { match, paramUsed } = this._evalJoinedCond(jr, cond.trim(), p, pi);
            pi += paramUsed;
            if (!match) { pi -= paramUsed; return false; }
          }
          return true;
        });
        // Reset pi for next row — this approach only works with single param eval
        // Actually filter needs fresh pi per row. Let's redo:
        joined = [];
        for (const r1 of rows1) {
          for (const r2 of rows2) {
            const v1 = (jAlias1 === a1 ? r1 : r2)[jCol1];
            const v2 = (jAlias2 === a2 ? r2 : r1)[jCol2];
            if (v1 !== v2) continue;
            const jr = { [a1]: r1, [a2]: r2 };
            let pi2 = 0;
            let pass = true;
            for (const cond of conds) {
              const { match, paramUsed } = this._evalJoinedCond(jr, cond.trim(), p, pi2);
              pi2 += paramUsed;
              if (!match) { pass = false; break; }
            }
            if (pass) joined.push(jr);
          }
        }
      }

      // Order
      if (order) {
        const parts = order.split(',').map((o) => {
          const tokens = o.trim().split(/\s+/);
          const [alias, col] = tokens[0].includes('.') ? tokens[0].split('.') : [null, tokens[0]];
          const dir = (tokens[1] || 'ASC').toUpperCase();
          return { alias, col, dir };
        });
        joined.sort((a, b) => {
          for (const { alias, col, dir } of parts) {
            const va = alias ? a[alias]?.[col] : null;
            const vb = alias ? b[alias]?.[col] : null;
            if (va < vb) return dir === 'ASC' ? -1 : 1;
            if (va > vb) return dir === 'ASC' ? 1 : -1;
          }
          return 0;
        });
      }

      // Limit/offset — params consumed after WHERE params
      let whereParamCount = where ? (where.match(/\?/g) || []).length : 0;
      let limit = limitRaw === '?' ? Number(p[whereParamCount]) : (limitRaw ? Number(limitRaw) : null);
      let offset = offsetRaw === '?' ? Number(p[whereParamCount + (limitRaw === '?' ? 1 : 0)]) : (offsetRaw ? Number(offsetRaw) : 0);
      if (limit !== null) joined = joined.slice(offset, offset + limit);

      // Project columns
      const results = joined.map((jr) => this._projectJoined(jr, selectCols));
      return { results };
    }

    // Simple SELECT
    const simpleMatch = sql.match(/^SELECT\s+(.+?)\s+FROM\s+(\w+)\s*(?:WHERE\s+(.+?))?(?:\s+ORDER\s+BY\s+(.+?))?(?:\s+LIMIT\s+(\?|\d+)(?:\s+OFFSET\s+(\?|\d+))?)?$/i);
    if (simpleMatch) {
      const [, selectCols, table, where, order, limitRaw, offsetRaw] = simpleMatch;
      let rows = [...(this.db.tables[table] || [])];
      let whereParamCount = 0;
      if (where) {
        const result = this._where(rows, where, p, 0);
        rows = result.rows;
        whereParamCount = result.paramCount;
      }
      if (order) rows = this._order(rows, order);
      let limit = limitRaw === '?' ? Number(p[whereParamCount]) : (limitRaw ? Number(limitRaw) : null);
      let offset = offsetRaw === '?' ? Number(p[whereParamCount + (limitRaw === '?' ? 1 : 0)]) : (offsetRaw ? Number(offsetRaw) : 0);
      if (limit !== null) rows = rows.slice(offset, offset + limit);
      if (selectCols.trim() === '*') return { results: rows.map((r) => ({ ...r })) };
      const results = rows.map((r) => this._projectSimple(r, selectCols));
      return { results };
    }

    throw new Error('MemoryD1 SELECT parse fail: ' + sql);
  }

  // ---------- UPDATE ----------
  _update(sql, p) {
    const m = sql.match(/^UPDATE\s+(\w+)\s+SET\s+(.+?)\s+WHERE\s+(.+)$/i);
    if (!m) throw new Error('MemoryD1 UPDATE parse fail: ' + sql);
    const table = m[1];
    const setClause = m[2];
    const whereClause = m[3];
    const rows = this.db.tables[table] || [];

    // Parse SET to figure out param count
    const setParts = setClause.split(',').map((s) => {
      const eq = s.indexOf('=');
      return { col: s.slice(0, eq).trim(), expr: s.slice(eq + 1).trim() };
    });
    let setParamCount = 0;
    for (const sp of setParts) { if (sp.expr === '?') setParamCount++; }

    // Where uses params after SET params
    const { rows: matching } = this._where(rows, whereClause, p, setParamCount);
    let changes = 0;
    for (const row of matching) {
      let pi = 0;
      for (const sp of setParts) {
        if (sp.expr === '?') row[sp.col] = p[pi++];
        else if (sp.expr.includes("'accepted'")) row[sp.col] = 'accepted';
        else if (sp.expr.includes("'revoked'")) row[sp.col] = 'revoked';
        else if (sp.expr.includes("datetime('now')")) row[sp.col] = new Date().toISOString();
      }
      changes++;
    }
    return { results: [], changes };
  }

  // ---------- DELETE ----------
  _delete(sql, p) {
    const m = sql.match(/^DELETE\s+FROM\s+(\w+)\s+WHERE\s+(.+)$/i);
    if (!m) throw new Error('MemoryD1 DELETE parse fail: ' + sql);
    const table = m[1];
    const rows = this.db.tables[table] || [];
    const { rows: matching } = this._where(rows, m[2], p, 0);
    const matchSet = new Set(matching);
    const before = rows.length;
    this.db.tables[table] = rows.filter((r) => !matchSet.has(r));
    return { results: [], changes: before - this.db.tables[table].length };
  }

  // ---------- Helpers ----------

  _where(rows, clause, p, paramOffset) {
    const conds = clause.split(/\s+AND\s+/i).map((c) => c.trim());
    // Count total params in WHERE
    let totalParams = 0;
    for (const c of conds) totalParams += (c.match(/\?/g) || []).length;

    const filtered = rows.filter((row) => {
      let pi = paramOffset;
      for (const cond of conds) {
        // col = ?
        let m = cond.match(/^(\w+(?:\.\w+)?)\s*=\s*\?$/);
        if (m) {
          const col = m[1].includes('.') ? m[1].split('.')[1] : m[1];
          if (row[col] !== p[pi++]) return false;
          continue;
        }
        // col = 'literal'
        m = cond.match(/^(\w+(?:\.\w+)?)\s*=\s*'([^']*)'$/);
        if (m) {
          const col = m[1].includes('.') ? m[1].split('.')[1] : m[1];
          if (row[col] !== m[2]) return false;
          continue;
        }
        // col > ?
        m = cond.match(/^(\w+(?:\.\w+)?)\s*>\s*\?$/);
        if (m) {
          const col = m[1].includes('.') ? m[1].split('.')[1] : m[1];
          if (!(row[col] > p[pi++])) return false;
          continue;
        }
        // col <= ?
        m = cond.match(/^(\w+(?:\.\w+)?)\s*<=\s*\?$/);
        if (m) {
          const col = m[1].includes('.') ? m[1].split('.')[1] : m[1];
          if (!(row[col] <= p[pi++])) return false;
          continue;
        }
      }
      return true;
    });
    return { rows: filtered, paramCount: totalParams };
  }

  _evalJoinedCond(jr, cond, p, pi) {
    // alias.col = ?
    let m = cond.match(/^(\w+)\.(\w+)\s*=\s*\?$/);
    if (m) return { match: jr[m[1]]?.[m[2]] === p[pi], paramUsed: 1 };
    // alias.col = 'literal'
    m = cond.match(/^(\w+)\.(\w+)\s*=\s*'([^']*)'$/);
    if (m) return { match: jr[m[1]]?.[m[2]] === m[3], paramUsed: 0 };
    // alias.col > ?
    m = cond.match(/^(\w+)\.(\w+)\s*>\s*\?$/);
    if (m) return { match: jr[m[1]]?.[m[2]] > p[pi], paramUsed: 1 };
    return { match: true, paramUsed: 0 };
  }

  _order(rows, clause) {
    const parts = clause.split(',').map((o) => {
      const tokens = o.trim().split(/\s+/);
      const col = tokens[0].includes('.') ? tokens[0].split('.')[1] : tokens[0];
      const dir = (tokens[1] || 'ASC').toUpperCase();
      return { col, dir };
    });
    return [...rows].sort((a, b) => {
      for (const { col, dir } of parts) {
        if (a[col] < b[col]) return dir === 'ASC' ? -1 : 1;
        if (a[col] > b[col]) return dir === 'ASC' ? 1 : -1;
      }
      return 0;
    });
  }

  _projectSimple(row, cols) {
    const result = {};
    for (const expr of cols.split(',').map((c) => c.trim())) {
      const asMatch = expr.match(/^(.+?)\s+AS\s+(\w+)$/i);
      if (asMatch) {
        const src = asMatch[1].trim();
        const dot = src.match(/^(\w+)\.(\w+)$/);
        result[asMatch[2]] = dot ? row[dot[2]] : row[src];
      } else {
        const dot = expr.match(/^(\w+)\.(\w+)$/);
        result[dot ? dot[2] : expr] = row[dot ? dot[2] : expr];
      }
    }
    return result;
  }

  _projectJoined(jr, cols) {
    const result = {};
    for (const expr of cols.split(',').map((c) => c.trim())) {
      const asMatch = expr.match(/^(.+?)\s+AS\s+(\w+)$/i);
      if (asMatch) {
        const src = asMatch[1].trim();
        const dot = src.match(/^(\w+)\.(\w+)$/);
        result[asMatch[2]] = dot ? jr[dot[1]]?.[dot[2]] : undefined;
      } else {
        const dot = expr.match(/^(\w+)\.(\w+)$/);
        if (dot) result[dot[2]] = jr[dot[1]]?.[dot[2]];
      }
    }
    return result;
  }
}

export function environment() {
  const EMAIL = {
    messages: [],
    async send(message) {
      this.messages.push(message);
      return { messageId: `test-email-${this.messages.length}` };
    }
  };
  return { PROJECTS: new MemoryR2(), DB: new MemoryD1(), EMAIL, EMAIL_FROM: 'invites@example.test', EMAIL_FROM_NAME: 'LaTeX Editor', AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) }, PROJECT_RATE_LIMITER: { limit: async () => ({ success: true }) }, GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-only', PUBLIC_BASE_URL: 'https://cloud.example.test' };
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
