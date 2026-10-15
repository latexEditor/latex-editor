const DAY = 86400000;
export class OperationsError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const changed = (result) => result.meta?.changes ?? result.changes ?? 0;
const positive = (value, fallback) => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
export const limits = (env) => ({
  accountBytes: positive(env.ACCOUNT_STORAGE_BYTES, 1024 * 1024 * 1024),
  projectBytes: positive(env.PROJECT_STORAGE_BYTES, 500 * 1024 * 1024),
  objectBytes: 50 * 1024 * 1024
});

export async function storageUsage(env, userId) {
  const usage = await env.DB.prepare('SELECT COALESCE(SUM(bytes), 0) AS bytes FROM cloud_storage WHERE user_id = ?').bind(userId).first();
  return { usedBytes: usage.bytes, ...limits(env), accounting: 'physical-including-pending-cleanup' };
}

// A single SQLite statement reserves capacity, including concurrent uploads.
// Immutable object keys are never reused, so GC cannot remove a newer version.
export async function reserveStorage(env, { key, userId, projectId = null, bytes }) {
  const quota = limits(env);
  const result = await env.DB.prepare(`INSERT INTO cloud_storage (key, user_id, project_id, bytes, created_at)
    SELECT ?, ?, ?, ?, ? WHERE
    NOT EXISTS (SELECT 1 FROM account_deletions WHERE user_id = ?) AND
    (SELECT COALESCE(SUM(bytes), 0) FROM cloud_storage WHERE user_id = ?) + ? <= ? AND
    (? IS NULL OR (SELECT COALESCE(SUM(bytes), 0) FROM cloud_storage WHERE project_id = ?) + ? <= ?)`)
    .bind(key, userId, projectId, bytes, Date.now(), userId, userId, bytes, quota.accountBytes,
      projectId, projectId, bytes, quota.projectBytes).run();
  if (!changed(result)) throw new OperationsError(413, 'Đã vượt dung lượng cloud của tài khoản hoặc project. Hãy xóa dữ liệu không cần thiết hoặc chờ dọn phiên bản cũ.');
}

export async function discardStorage(env, key) {
  // Keep the reservation when R2 deletion fails, for retry by maintenance.
  await env.PROJECTS.delete(key);
  await env.DB.prepare('DELETE FROM cloud_storage WHERE key = ?').bind(key).run();
}

async function roomRequest(env, projectId, path, userId) {
  if (!env.COLLABORATION_ROOMS) return;
  const headers = userId ? { 'X-Collaboration-User-Id': userId } : {};
  const response = await env.COLLABORATION_ROOMS.getByName(projectId).fetch(new Request(`https://collaboration.internal/${path}`, { method: 'POST', headers }));
  if (!response.ok) throw new Error('Không dọn được phòng cộng tác.');
}

export async function requestAccountDeletion(env, user) {
  // Block new API sessions immediately. Retryable cleanup is performed by cron.
  await env.DB.batch([
    env.DB.prepare('INSERT INTO account_deletions (user_id, requested_at) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET requested_at = excluded.requested_at').bind(user.id, Date.now()),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id)
  ]);
  // Disconnect existing sockets before returning, including shared projects.
  const { results } = await env.DB.prepare('SELECT project_id FROM project_members WHERE user_id = ?').bind(user.id).all();
  for (const member of results) {
    try { await roomRequest(env, member.project_id, 'disconnect', user.id); }
    catch { console.error(JSON.stringify({ event: 'account-disconnect-pending', projectId: member.project_id })); }
  }
  return { accepted: true, pending: true };
}

export async function cleanDeletedAccount(env, userId) {
  const { results: memberships } = await env.DB.prepare('SELECT project_id, role FROM project_members WHERE user_id = ?').bind(userId).all();
  // Process a bounded number each run; markers survive failures/restarts.
  for (const member of memberships.slice(0, 2)) {
    if (member.role === 'owner') {
      const owners = await env.DB.prepare("SELECT COUNT(*) AS count FROM project_members WHERE project_id = ? AND role = 'owner'").bind(member.project_id).first();
      if (owners.count === 1) {
        await roomRequest(env, member.project_id, 'destroy');
        await env.DB.batch([
          env.DB.prepare('DELETE FROM projects WHERE id = ?').bind(member.project_id),
          env.DB.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').bind(member.project_id, userId)
        ]);
      } else {
        // Accounting belongs to a surviving owner after ownership changes.
        const next = await env.DB.prepare("SELECT user_id FROM project_members WHERE project_id = ? AND role = 'owner' AND user_id != ? LIMIT 1").bind(member.project_id, userId).first();
        await env.DB.prepare('UPDATE cloud_storage SET user_id = ? WHERE project_id = ?').bind(next.user_id, member.project_id).run();
      }
    }
    await roomRequest(env, member.project_id, 'disconnect', userId);
    await env.DB.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').bind(member.project_id, userId).run();
  }
  const remaining = await env.DB.prepare('SELECT COUNT(*) AS count FROM project_members WHERE user_id = ?').bind(userId).first();
  if (remaining.count) return false;
  await env.DB.prepare('DELETE FROM user_templates WHERE user_id = ?').bind(userId).run();
  const { results: objects } = await env.DB.prepare('SELECT key FROM cloud_storage WHERE user_id = ? LIMIT 5').bind(userId).all();
  for (const object of objects) await discardStorage(env, object.key);
  const pending = await env.DB.prepare('SELECT COUNT(*) AS count FROM cloud_storage WHERE user_id = ?').bind(userId).first();
  if (pending.count) return false;
  const user = await env.DB.prepare('SELECT email FROM users WHERE id = ?').bind(userId).first();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM invitations WHERE inviter_id = ? OR email = ?').bind(userId, user?.email || ''),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId),
    env.DB.prepare('DELETE FROM account_deletions WHERE user_id = ?').bind(userId)
  ]);
  return true;
}

export async function runMaintenance(env, now = Date.now()) {
  const report = { deletedAccounts: 0, removedObjects: 0, reconciled: 0, errors: 0 };
  if (await backupInProgress(env, now)) {
    report.skippedForBackup = true;
    await saveReport(env, report, now);
    return report;
  }
  // Alternate cleanup/GC windows to keep each cron bounded and avoid a failing
  // account starving ordinary GC. Each batch is safe to retry after a crash.
  if (Math.floor(now / 900000) % 2 === 0) {
    const { results: deletions } = await env.DB.prepare('SELECT user_id FROM account_deletions ORDER BY requested_at LIMIT 1').all();
    if (deletions.length) {
      try { if (await cleanDeletedAccount(env, deletions[0].user_id)) report.deletedAccounts++; }
      catch { report.errors++; console.error(JSON.stringify({ event: 'account-cleanup-retry' })); }
      if (!report.deletedAccounts) {
        await env.DB.prepare('UPDATE account_deletions SET requested_at = ? WHERE user_id = ?').bind(now, deletions[0].user_id).run();
      }
      await saveReport(env, report, now);
      return report;
    }
  }
  // A full traversal is checkpointed across cron runs to stay within subrequest
  // limits. Grace exceeds the upload timeout; recheck references before removal.
  const state = await env.DB.prepare('SELECT value FROM cloud_maintenance WHERE id = ?').bind('r2-gc').first();
  const listed = await env.PROJECTS.list({ limit: 24, cursor: state?.value || undefined });
  const candidates = listed.objects.filter((object) => /^(bundles|templates|auth)\//.test(object.key));
  if (candidates.length) {
    const keys = candidates.map((object) => object.key);
    const placeholders = keys.map(() => '?').join(',');
    const references = await env.DB.batch([
      env.DB.prepare(`SELECT bundle_key FROM projects WHERE bundle_key IN (${placeholders})`).bind(...keys),
      env.DB.prepare(`SELECT bundle_key FROM user_templates WHERE bundle_key IN (${placeholders})`).bind(...keys)
    ]);
    const referenced = new Set(references.flatMap((result) => result.results.map((row) => row.bundle_key)));
    const updates = [];
    const garbage = [];
    for (const object of candidates) {
      if (referenced.has(object.key)) {
        updates.push(env.DB.prepare('UPDATE cloud_storage SET bytes = ?, created_at = ? WHERE key = ?').bind(object.size, now, object.key));
      } else if (object.uploaded && new Date(object.uploaded).getTime() <= now - DAY) {
        garbage.push(object.key);
      }
    }
    if (updates.length) await env.DB.batch(updates);
    report.reconciled = updates.length;
    if (garbage.length) {
      await env.PROJECTS.delete(garbage);
      await env.DB.prepare(`DELETE FROM cloud_storage WHERE key IN (${garbage.map(() => '?').join(',')})`).bind(...garbage).run();
      report.removedObjects = garbage.length;
    }
  }
  // Reclaim reservations for uploads that failed before creating an R2 object.
  const { results: stale } = await env.DB.prepare('SELECT key FROM cloud_storage WHERE created_at < ? ORDER BY created_at LIMIT 2').bind(now - DAY).all();
  for (const object of stale) {
    if (!await env.PROJECTS.head(object.key)) await env.DB.prepare('DELETE FROM cloud_storage WHERE key = ?').bind(object.key).run();
  }
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now).run();
  await env.DB.prepare('DELETE FROM invitations WHERE expires_at <= ?').bind(now - 30 * DAY).run();
  await env.DB.prepare('INSERT INTO cloud_maintenance (id, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .bind('r2-gc', listed.truncated ? listed.cursor : '', now).run();
  await saveReport(env, report, now);
  return report;
}

export async function backupInProgress(env, now = Date.now()) {
  const listed = await env.PROJECTS.list({ prefix: 'backup-locks/', limit: 4 });
  let active = Boolean(listed.truncated);
  for (const object of listed.objects) {
    const lock = await env.PROJECTS.get(object.key);
    if (!lock) continue;
    if (lock.size > 1024) return true;
    let value;
    try { value = await lock.json(); } catch { return true; }
    if (!Number.isSafeInteger(value.expiresAt)) return true;
    if (value.expiresAt > now) active = true;
    else await env.PROJECTS.delete(object.key);
  }
  return active;
}

async function saveReport(env, report, now) {
  await env.DB.prepare('INSERT INTO cloud_maintenance (id, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .bind('last-run', JSON.stringify(report), now).run();
  console.log(JSON.stringify({ event: 'cloud-maintenance', ...report }));
}
