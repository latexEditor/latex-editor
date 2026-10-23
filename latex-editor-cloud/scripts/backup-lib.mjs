import { randomUUID, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, writeFile, rm, stat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const ACCOUNT = 'a533b356d5a670c392fdc7dd9969c5c9';
export const SOURCE = 'latex-editor-projects';
export const DESTINATION = 'latex-editor-backups';
const SQL_LIMIT = 64 * 1024 * 1024;
const OBJECT_LIMIT = 50 * 1024 * 1024;

export function validObjectKey(key) {
  return typeof key === 'string' && /^(bundles|templates|publications)\/[A-Za-z0-9_./-]+$/.test(key)
    && !key.split('/').some((part) => !part || part === '.' || part === '..');
}

export async function fingerprint(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return { bytes: (await stat(file)).size, sha256: hash.digest('hex') };
}

export async function snapshotKeys(file) {
  if ((await stat(file)).size > SQL_LIMIT) throw new Error('D1 export exceeds the supported 64 MiB metadata limit.');
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys=OFF;');
    db.exec(await readFile(file, 'utf8'));
    const hasPublications = Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'project_publications'").get());
    const query = 'SELECT bundle_key AS object_key FROM projects UNION SELECT bundle_key AS object_key FROM user_templates'
      + (hasPublications ? ' UNION SELECT pdf_key AS object_key FROM project_publications' : '');
    const keys = db.prepare(query).all().map((row) => row.object_key);
    if (keys.length > 100000 || keys.some((key) => !validObjectKey(key))) throw new Error('Invalid object references in D1 export.');
    return keys;
  } finally { db.close(); }
}

async function privateTemporaryDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), 'latex-cloud-backup-'));
  if (process.platform !== 'win32') await chmod(directory, 0o700);
  return directory;
}

export async function createBackup(adapter, { now = Date.now(), id = randomUUID() } = {}) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid backup identifier.');
  const directory = await privateTemporaryDirectory();
  const prefix = `daily/${new Date(now).toISOString().replace(/[:.]/g, '-')}_${id}`;
  const lockKey = `backup-locks/${id}.json`;
  const deadline = now + 2 * 3600000;
  let locked = false;
  const timeRemaining = () => {
    if (Date.now() > deadline - 15 * 60000) throw new Error('Backup exceeded its safe time window.');
  };
  try {
    const lockFile = path.join(directory, 'lock.json');
    await writeFile(lockFile, JSON.stringify({ version: 1, expiresAt: deadline }), { mode: 0o600 });
    await adapter.put(SOURCE, lockKey, lockFile);
    locked = true;
    const databaseFile = path.join(directory, 'database.sql');
    await adapter.exportDatabase(databaseFile);
    const keys = await snapshotKeys(databaseFile);
    const manifest = {
      version: 1, account: ACCOUNT, source: SOURCE, destination: DESTINATION,
      createdAt: new Date(now).toISOString(),
      database: { key: `${prefix}/database.sql`, ...await fingerprint(databaseFile) },
      objects: []
    };
    const unavailable = [];
    for (const key of keys) {
      timeRemaining();
      const file = path.join(directory, 'object.bin');
      try { await adapter.get(SOURCE, key, file); }
      catch (error) {
        unavailable.push({ key, reason: String(error.message).slice(0, 500) });
        continue;
      }
      const checksum = await fingerprint(file);
      if (checksum.bytes > OBJECT_LIMIT) throw new Error('An object exceeds the supported 50 MiB limit.');
      const backupKey = `${prefix}/objects/${key}`;
      await adapter.put(DESTINATION, backupKey, file);
      manifest.objects.push({ key, backupKey, ...checksum });
      await rm(file);
      adapter.progress?.(manifest.objects.length, keys.length);
    }
    timeRemaining();
    await adapter.put(DESTINATION, manifest.database.key, databaseFile);
    const manifestFile = path.join(directory, 'manifest.json');
    if (unavailable.length) {
      // Preserve the consistent database and every readable object for recovery,
      // but fail the job and never label a partial copy as a complete backup.
      const incompleteKey = `${prefix}/incomplete.json`;
      await writeFile(manifestFile, JSON.stringify({ ...manifest, complete: false, unavailable }), { mode: 0o600 });
      await adapter.put(DESTINATION, incompleteKey, manifestFile);
      throw new Error(`${unavailable.length}/${keys.length} source objects unavailable. Partial snapshot saved at ${incompleteKey}. ${unavailable[0].reason}`);
    }
    await writeFile(manifestFile, JSON.stringify(manifest), { mode: 0o600 });
    const manifestKey = `${prefix}/manifest.json`;
    // A manifest is the commit marker. Failed/incomplete runs never publish it.
    await adapter.put(DESTINATION, manifestKey, manifestFile);
    return { manifestKey, objects: manifest.objects.length };
  } finally {
    if (locked) {
      try { await adapter.remove(SOURCE, lockKey); }
      catch { adapter.warn?.('Backup lock cleanup failed; it will expire automatically.'); }
    }
    await rm(directory, { recursive: true, force: true });
  }
}

export function validateManifest(manifestKey, manifest, { allowIncomplete = false } = {}) {
  if (!/^daily\/[A-Za-z0-9_-]+\/(manifest|incomplete)\.json$/.test(manifestKey)) throw new Error('Invalid backup manifest key.');
  const partial = manifestKey.endsWith('/incomplete.json');
  if (partial && (!allowIncomplete || manifest?.complete !== false || !Array.isArray(manifest.unavailable))) throw new Error('Incomplete backups cannot be restored as complete backups.');
  const prefix = manifestKey.slice(0, manifestKey.lastIndexOf('/'));
  if (manifest?.version !== 1 || manifest.account !== ACCOUNT || manifest.source !== SOURCE || manifest.destination !== DESTINATION
    || !Array.isArray(manifest.objects) || manifest.objects.length > 100000
    || manifest.database?.key !== `${prefix}/database.sql`) throw new Error('Invalid backup manifest.');
  const checksum = (item, max) => Number.isSafeInteger(item?.bytes) && item.bytes >= 0 && item.bytes <= max && /^[a-f0-9]{64}$/.test(item.sha256 || '');
  if (!checksum(manifest.database, SQL_LIMIT)) throw new Error('Invalid database checksum metadata.');
  const keys = new Set();
  for (const object of manifest.objects) {
    if (!validObjectKey(object.key) || object.backupKey !== `${prefix}/objects/${object.key}` || !checksum(object, OBJECT_LIMIT) || keys.has(object.key)) throw new Error('Invalid object in backup manifest.');
    keys.add(object.key);
  }
  if (partial) {
    if (!manifest.unavailable.length || manifest.unavailable.length + keys.size > 100000) throw new Error('Invalid incomplete backup metadata.');
    for (const object of manifest.unavailable) {
      if (!validObjectKey(object.key) || keys.has(object.key) || typeof object.reason !== 'string' || object.reason.length > 500) throw new Error('Invalid unavailable object.');
      keys.add(object.key);
    }
  }
  return manifest;
}

async function verifyFile(file, expected) {
  const actual = await fingerprint(file);
  if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) throw new Error('Backup checksum mismatch.');
}

// Downloads and validates every byte before restoring. The adapter deliberately
// only exposes local restore operations; this tool cannot overwrite production.
export async function verifyBackup(adapter, manifestKey, { restoreLocal = null, allowIncomplete = false } = {}) {
  const partial = manifestKey?.endsWith('/incomplete.json');
  if (!/^daily\/[A-Za-z0-9_-]+\/(manifest|incomplete)\.json$/.test(manifestKey)) throw new Error('Invalid backup manifest key.');
  if (partial && (!allowIncomplete || restoreLocal)) throw new Error('Incomplete backups support verification only, never restore.');
  const directory = await privateTemporaryDirectory();
  try {
    const manifestFile = path.join(directory, 'manifest.json');
    await adapter.get(DESTINATION, manifestKey, manifestFile);
    if ((await stat(manifestFile)).size > 32 * 1024 * 1024) throw new Error('Manifest too large.');
    const manifest = validateManifest(manifestKey, JSON.parse(await readFile(manifestFile, 'utf8')), { allowIncomplete });
    const databaseFile = path.join(directory, 'database.sql');
    await adapter.get(DESTINATION, manifest.database.key, databaseFile);
    await verifyFile(databaseFile, manifest.database);
    const keys = await snapshotKeys(databaseFile);
    const files = [];
    const declared = new Set(manifest.objects.map((object) => object.key));
    if (partial) for (const object of manifest.unavailable) declared.add(object.key);
    if (keys.length !== declared.size || keys.some((key) => !declared.has(key))) throw new Error('Manifest does not match D1 snapshot.');
    for (const [index, object] of manifest.objects.entries()) {
      const file = path.join(directory, `object-${index}.bin`);
      await adapter.get(DESTINATION, object.backupKey, file);
      await verifyFile(file, object);
      files.push({ key: object.key, file });
      if (!restoreLocal) await rm(file);
    }
    if (restoreLocal) {
      await adapter.initializeLocalRestore(restoreLocal);
      for (const object of files) await adapter.restoreObjectLocal(object.key, object.file, restoreLocal);
      await adapter.restoreDatabaseLocal(databaseFile, restoreLocal);
    }
    const result = { verified: true, restoredLocally: Boolean(restoreLocal), objects: files.length };
    return partial ? { ...result, complete: false, unavailableObjects: manifest.unavailable.length } : result;
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function auditSource(adapter) {
  const directory = await privateTemporaryDirectory();
  try {
    const database = path.join(directory, 'database.sql');
    await adapter.exportDatabase(database);
    const keys = await snapshotKeys(database);
    const unavailable = [];
    let availableObjects = 0;
    for (const key of keys) {
      const file = path.join(directory, 'object.bin');
      try {
        await adapter.get(SOURCE, key, file);
        availableObjects++;
      } catch (error) { unavailable.push({ key, reason: String(error.message).slice(0, 500) }); }
      finally { await rm(file, { force: true }); }
    }
    return { complete: unavailable.length === 0, totalObjects: keys.length, availableObjects, unavailable };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
