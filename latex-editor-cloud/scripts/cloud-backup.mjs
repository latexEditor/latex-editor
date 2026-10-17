import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACCOUNT, SOURCE, createBackup, verifyBackup, auditSource } from './backup-lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function wranglerEntry() {
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    const entry = path.resolve(directory, '../wrangler/bin/wrangler.js');
    const pkg = path.resolve(directory, '../wrangler/package.json');
    if (existsSync(entry) && existsSync(pkg) && JSON.parse(readFileSync(pkg, 'utf8')).version === '4.120.0') return entry;
  }
  throw new Error('Run via npm run backup (uses isolated Node 22 and Wrangler 4.120.0).');
}

function adapter() {
  if (process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_ACCOUNT_ID !== ACCOUNT) throw new Error('Cloudflare account does not match the approved backup account.');
  const entry = wranglerEntry();
  const run = (...args) => {
    const retryable = args[0] === 'r2' || (args[0] === 'd1' && args[1] === 'export');
    for (let attempt = 1; attempt <= (retryable ? 3 : 1); attempt++) {
      try {
        execFileSync(process.execPath, [entry, ...args, '--config', path.join(root, 'wrangler.toml')], {
          cwd: root, env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT, WRANGLER_SEND_METRICS: 'false' },
          stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 120000, maxBuffer: 8 * 1024 * 1024
        });
        return;
      } catch (error) {
        const output = String(error.stderr || '') + String(error.stdout || '');
        const code = output.match(/\[code:\s*(\d+)\]/i)?.[1];
        const reason = /NoSuchKey|specified key does not exist|object (?:does not exist|not found)|\b404\b/i.test(output) ? 'object not found'
          : /fetch failed|ECONN|ENOTFOUND|network|connect timeout/i.test(output) ? 'network error'
            : /authentication|authorization|\b403\b|\b401\b/i.test(output) ? 'authentication error'
              : error.code === 'ETIMEDOUT' ? 'timeout' : 'command error';
        if (retryable && attempt < 3 && reason !== 'object not found' && reason !== 'authentication error') continue;
        throw new Error(`Wrangler ${args.slice(0, args[0] === 'r2' ? 3 : 2).join(' ')} failed: ${reason}${code ? ` (API ${code})` : ''}. No private output was logged.`);
      }
    }
  };
  return {
    exportDatabase: (file) => run('d1', 'export', 'latex-editor-db', '--remote', '--output', file),
    get: (bucket, key, file) => run('r2', 'object', 'get', `${bucket}/${key}`, '--remote', '--file', file),
    put: (bucket, key, file) => run('r2', 'object', 'put', `${bucket}/${key}`, '--remote', '--file', file, '--force'),
    remove: (bucket, key) => run('r2', 'object', 'delete', `${bucket}/${key}`, '--remote'),
    progress: (done, total) => console.log(`Copied ${done}/${total} backup objects.`),
    warn: (message) => console.warn(message),
    initializeLocalRestore: async (directory) => {
      // mkdir without recursive mode refuses an existing destination.
      await mkdir(directory);
    },
    restoreObjectLocal: (key, file, directory) => run('r2', 'object', 'put', `${SOURCE}/${key}`, '--local', '--persist-to', directory, '--file', file, '--force'),
    restoreDatabaseLocal: (file, directory) => {
      run('d1', 'execute', 'latex-editor-db', '--local', '--persist-to', directory, '--file', file);
      // Recovered sessions must never silently become valid again.
      run('d1', 'execute', 'latex-editor-db', '--local', '--persist-to', directory, '--command', 'DELETE FROM sessions;');
    }
  };
}

try {
  const [mode = 'create', manifestKey, restoreDirectory, ...extra] = process.argv.slice(2);
  if (extra.length || !['create', 'audit', 'verify', 'verify-incomplete', 'restore-local'].includes(mode)
    || (['create', 'audit'].includes(mode) && manifestKey) || (!['create', 'audit'].includes(mode) && !manifestKey)
    || (mode !== 'restore-local' && restoreDirectory) || (mode === 'restore-local' && !restoreDirectory)) {
    throw new Error('Usage: npm run backup -- [create | audit | verify MANIFEST_KEY | verify-incomplete INCOMPLETE_KEY | restore-local MANIFEST_KEY NEW_DIRECTORY]');
  }
  console.log(mode === 'create' ? 'Exporting D1 and backing up to private latex-editor-backups...' : mode === 'audit' ? 'Auditing D1 references against R2 (read-only)...' : 'Verifying private backup checksums...');
  const io = adapter();
  const result = mode === 'create' ? await createBackup(io) : mode === 'audit' ? await auditSource(io)
    : await verifyBackup(io, manifestKey, { restoreLocal: mode === 'restore-local' ? path.resolve(restoreDirectory) : null, allowIncomplete: mode === 'verify-incomplete' });
  console.log(JSON.stringify(result));
  if (mode === 'audit' && !result.complete) process.exitCode = 1;
} catch (error) {
  // Never serialize child-process error objects: they may contain private output.
  console.error(error.message);
  process.exitCode = 1;
}
