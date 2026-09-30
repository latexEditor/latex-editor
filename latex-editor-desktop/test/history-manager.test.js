const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { HistoryManager, safeFile } = require('../src/main/HistoryManager');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'latex-history-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'Dự án thử nghiệm');
  await fs.mkdir(project);
  await fs.writeFile(path.join(project, 'main.tex'), 'Version one');
  return { root, project, history: new HistoryManager({ historyDir: path.join(root, 'history') }) };
}

test('history persists, skips unchanged snapshots, and does not touch a user Git repository', async (t) => {
  const { project, history } = await fixture(t);
  await fs.mkdir(path.join(project, '.git'));
  await fs.writeFile(path.join(project, '.git', 'index'), 'user staging area');
  const first = await history.save(project, 'Bản đầu');
  assert.equal((await history.save(project, 'No changes')).unchanged, true);
  await fs.writeFile(path.join(project, 'main.tex'), 'Version two');
  const second = await history.save(project, 'Bản hai', { name: 'Author', email: 'a@example.com' });
  const restarted = new HistoryManager({ historyDir: history.root });
  const entries = await restarted.list(project);
  assert.deepEqual(entries.map((item) => item.hash), [second.hash, first.hash]);
  assert.equal(entries[0].author, 'Author');
  assert.match(await history.diff(project, second.hash), /\+Version two/);
  assert.equal(await fs.readFile(path.join(project, '.git', 'index'), 'utf8'), 'user staging area');
});

test('restoration preserves current work as a backup commit and leaves build output alone', async (t) => {
  const { project, history } = await fixture(t);
  const first = await history.save(project, 'First');
  await fs.writeFile(path.join(project, 'main.tex'), 'Uncommitted changes');
  await fs.writeFile(path.join(project, 'extra.tex'), 'New file');
  await fs.mkdir(path.join(project, 'build'));
  await fs.writeFile(path.join(project, 'build', 'main.pdf'), 'generated');
  const restored = await history.restore(project, first.hash);
  assert.equal(await fs.readFile(path.join(project, 'main.tex'), 'utf8'), 'Version one');
  await assert.rejects(fs.access(path.join(project, 'extra.tex')));
  assert.equal(await fs.readFile(path.join(project, 'build', 'main.pdf'), 'utf8'), 'generated');
  assert.equal((await history.list(project)).length, 3);
  await history.restore(project, restored.backup);
  assert.equal(await fs.readFile(path.join(project, 'extra.tex'), 'utf8'), 'New file');
  assert.equal(await fs.readFile(path.join(project, 'main.tex'), 'utf8'), 'Uncommitted changes');
});

test('bundle roundtrip preserves full history, Unicode names and binary assets', async (t) => {
  const { root, project, history } = await fixture(t);
  const binary = Buffer.from([0, 1, 2, 255, 128]);
  await fs.writeFile(path.join(project, 'ảnh.png'), binary);
  await fs.writeFile(path.join(project, '.env'), 'PRIVATE_SECRET=never-upload');
  await history.save(project, 'First');
  await fs.writeFile(path.join(project, 'main.tex'), 'Second version');
  await history.save(project, 'Second');
  const bundle = await history.exportBundle(project);
  const copy = path.join(root, 'Downloaded');
  await fs.mkdir(copy);
  await history.importBundle(copy, bundle.data, bundle.head);
  assert.equal((await history.list(copy)).length, 2);
  assert.deepEqual(await fs.readFile(path.join(copy, 'ảnh.png')), binary);
  await assert.rejects(fs.access(path.join(copy, '.env')));
  assert.equal((await history.save(copy, 'Unchanged')).unchanged, true);
});

test('invalid restore revisions and unsafe cloud paths are rejected before modifying files', async (t) => {
  const { project, history } = await fixture(t);
  await history.save(project, 'First');
  await assert.rejects(history.restore(project, '--help'));
  for (const name of ['../escape', '.GIT/config', 'a/../../escape', 'C:/windows', 'NUL', 'a\\b', 'build/main.pdf', '.env']) assert.throws(() => safeFile(name));
  assert.equal(await fs.readFile(path.join(project, 'main.tex'), 'utf8'), 'Version one');
});

test('file-directory transitions restore without recursively deleting user directories', async (t) => {
  const { project, history } = await fixture(t);
  await fs.writeFile(path.join(project, 'chapter'), 'file');
  const version = await history.save(project, 'File');
  await fs.unlink(path.join(project, 'chapter'));
  await fs.mkdir(path.join(project, 'chapter'));
  await fs.writeFile(path.join(project, 'chapter', 'part.tex'), 'directory');
  await history.save(project, 'Directory');
  await history.restore(project, version.hash);
  assert.equal(await fs.readFile(path.join(project, 'chapter'), 'utf8'), 'file');
});

test('concurrent saves are serialized into a consistent project history', async (t) => {
  const { project, history } = await fixture(t);
  const results = await Promise.all([history.save(project, 'One'), history.save(project, 'Two')]);
  assert.equal(results[1].unchanged, true);
  assert.equal((await history.list(project)).length, 1);
});

test('project Git attributes cannot rewrite the bytes saved in a safety snapshot', async (t) => {
  const { project, history } = await fixture(t);
  const original = Buffer.from('First line\r\nSecond line\r\n');
  await fs.writeFile(path.join(project, 'main.tex'), original);
  await fs.writeFile(path.join(project, '.gitattributes'), '*.tex text eol=lf\n');
  const saved = await history.save(project, 'Exact bytes');
  await fs.writeFile(path.join(project, 'main.tex'), 'Changed');
  await history.restore(project, saved.hash);
  assert.deepEqual(await fs.readFile(path.join(project, 'main.tex')), original);
});
