import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { ACCOUNT, SOURCE, DESTINATION, createBackup, verifyBackup, validateManifest } from '../scripts/backup-lib.mjs';

const projectKey = 'bundles/11111111-1111-4111-8111-111111111111/revision.bundle';
const templateKey = 'templates/google-123/personal-11111111-1111-4111-8111-111111111111/template.zip';
const sql = `CREATE TABLE projects (bundle_key TEXT); CREATE TABLE user_templates (bundle_key TEXT);
CREATE TABLE sessions (token_hash TEXT); INSERT INTO sessions VALUES ('hashed-private-session');
INSERT INTO projects VALUES ('${projectKey}'); INSERT INTO user_templates VALUES ('${templateKey}');`;

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'latex-backup-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const buckets = new Map([[SOURCE, new Map([[projectKey, Buffer.from([0, 255, 13, 10, 42])], [templateKey, Buffer.from('PK-template')]])], [DESTINATION, new Map()]]);
  const writes = [];
  const local = new Map();
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  const adapter = {
    exportDatabase: (file) => writeFile(file, sql),
    get: async (bucket, key, file) => {
      const data = buckets.get(bucket).get(key);
      if (!data) throw new Error('Object missing');
      await writeFile(file, data);
    },
    put: async (bucket, key, file) => { buckets.get(bucket).set(key, await readFile(file)); },
    remove: async (bucket, key) => buckets.get(bucket).delete(key),
    initializeLocalRestore: async () => writes.push('initialize'),
    restoreObjectLocal: async (key, file) => { writes.push(key); local.set(key, await readFile(file)); },
    restoreDatabaseLocal: async (file) => {
      writes.push('database');
      database.exec(await readFile(file, 'utf8'));
      database.exec('DELETE FROM sessions;');
    }
  };
  return { root, buckets, writes, local, database, adapter };
}

test('backup and local restore preserve binary objects and validate the exported D1 references', async (t) => {
  const { adapter, buckets, root, local, database } = await fixture(t);
  const result = await createBackup(adapter);
  assert.equal(result.objects, 2);
  const manifest = JSON.parse(buckets.get(DESTINATION).get(result.manifestKey));
  assert.equal(manifest.account, ACCOUNT);
  assert.equal(manifest.database.sha256.length, 64);
  assert.equal([...buckets.get(SOURCE).keys()].some((key) => key.startsWith('backup-locks/')), false);
  assert.deepEqual(await verifyBackup(adapter, result.manifestKey, { restoreLocal: path.join(root, 'restore') }), { verified: true, restoredLocally: true, objects: 2 });
  assert.deepEqual(local.get(projectKey), buckets.get(SOURCE).get(projectKey));
  assert.deepEqual(local.get(templateKey), buckets.get(SOURCE).get(templateKey));
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM projects').get().count, 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0);
});

test('missing source object cannot publish a complete manifest and always releases its lock', async (t) => {
  const { adapter, buckets } = await fixture(t);
  buckets.get(SOURCE).delete(templateKey);
  await assert.rejects(createBackup(adapter), /Object missing/);
  assert.equal([...buckets.get(DESTINATION).keys()].some((key) => key.endsWith('/manifest.json')), false);
  const partialKey = [...buckets.get(DESTINATION).keys()].find((key) => key.endsWith('/incomplete.json'));
  assert.ok(partialKey);
  const partial = JSON.parse(buckets.get(DESTINATION).get(partialKey));
  assert.equal(partial.complete, false);
  assert.equal(partial.unavailable.length, 1);
  assert.equal(partial.objects.length, 1);
  assert.ok(buckets.get(DESTINATION).has(partial.database.key));
  assert.equal([...buckets.get(SOURCE).keys()].some((key) => key.startsWith('backup-locks/')), false);
});

test('corrupt backup object fails verification before touching the local destination', async (t) => {
  const { adapter, buckets, writes, root } = await fixture(t);
  const result = await createBackup(adapter);
  const manifest = JSON.parse(buckets.get(DESTINATION).get(result.manifestKey));
  buckets.get(DESTINATION).set(manifest.objects[0].backupKey, Buffer.from('CORRUPTED'));
  await assert.rejects(verifyBackup(adapter, result.manifestKey, { restoreLocal: path.join(root, 'restore') }), /checksum mismatch/);
  assert.deepEqual(writes, []);
});

test('manifest rejects another account, missing references and cross-prefix paths', async (t) => {
  const { adapter, buckets } = await fixture(t);
  const result = await createBackup(adapter);
  const manifest = JSON.parse(buckets.get(DESTINATION).get(result.manifestKey));
  assert.throws(() => validateManifest(result.manifestKey, { ...manifest, account: 'another-account' }), /Invalid backup manifest/);
  const altered = structuredClone(manifest);
  altered.objects[0].backupKey = 'another-prefix/private-data';
  assert.throws(() => validateManifest(result.manifestKey, altered), /Invalid object/);
  buckets.get(DESTINATION).set(result.manifestKey, Buffer.from(JSON.stringify({ ...manifest, objects: [] })));
  await assert.rejects(verifyBackup(adapter, result.manifestKey), /does not match D1 snapshot/);
});

test('verification alone never restores or changes source objects', async (t) => {
  const { adapter, buckets, writes } = await fixture(t);
  const result = await createBackup(adapter);
  const before = [...buckets.get(SOURCE).entries()];
  const verified = await verifyBackup(adapter, result.manifestKey);
  assert.equal(verified.restoredLocally, false);
  assert.deepEqual(writes, []);
  assert.deepEqual([...buckets.get(SOURCE).entries()], before);
});
