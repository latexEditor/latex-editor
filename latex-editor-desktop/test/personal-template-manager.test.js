const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { PersonalTemplateManager } = require('../src/main/PersonalTemplateManager');

const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  return crc >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function makeZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const fileName = Buffer.from(name, 'utf8');
    const contents = Buffer.from(value, 'utf8');
    const checksum = crc32(contents);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(contents.length, 18);
    local.writeUInt32LE(contents.length, 22);
    local.writeUInt16LE(fileName.length, 26);
    localParts.push(local, fileName, contents);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(contents.length, 20);
    central.writeUInt32LE(contents.length, 24);
    central.writeUInt16LE(fileName.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, fileName);
    offset += local.length + fileName.length + contents.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'latex-template-'));
  const directory = path.join(root, 'templates');
  const manager = new PersonalTemplateManager(directory);
  manager.initialize();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, directory, manager };
}

test('saves a project as a filtered personal template', (t) => {
  const { root, manager } = fixture(t);
  const project = path.join(root, 'project');
  fs.mkdirSync(path.join(project, 'chapters'), { recursive: true });
  fs.mkdirSync(path.join(project, 'build'));
  fs.mkdirSync(path.join(project, '.git'));
  fs.writeFileSync(path.join(project, 'main.tex'), '% !TeX program = xelatex\n\\usepackage{fontspec}');
  fs.writeFileSync(path.join(project, 'chapters', 'one.tex'), 'Chapter');
  fs.writeFileSync(path.join(project, 'build', 'main.pdf'), 'generated');
  fs.writeFileSync(path.join(project, '.git', 'config'), 'secret');
  fs.writeFileSync(path.join(project, '.env'), 'TOKEN=secret');

  const template = manager.saveProject(project, 'Luận văn riêng');
  const stored = manager.resolve(template.id);
  assert.equal(template.personal, true);
  assert.equal(template.engine, 'xelatex');
  assert.equal(fs.existsSync(path.join(stored, 'chapters', 'one.tex')), true);
  assert.equal(fs.existsSync(path.join(stored, 'build')), false);
  assert.equal(fs.existsSync(path.join(stored, '.git')), false);
  assert.equal(fs.existsSync(path.join(stored, '.env')), false);
});

test('imports a wrapped ZIP and ignores generated or secret files', async (t) => {
  const { root, manager } = fixture(t);
  const archive = path.join(root, 'report.zip');
  fs.writeFileSync(archive, makeZip({
    'report/main.tex': '\\documentclass{article}\\begin{document}Hello\\end{document}',
    'report/chapters/intro.tex': 'Intro',
    'report/build/main.pdf': 'generated',
    'report/.env.local': 'TOKEN=secret'
  }));

  const template = await manager.importZip(archive, 'Báo cáo ZIP');
  const stored = manager.resolve(template.id);
  assert.equal(template.name, 'Báo cáo ZIP');
  assert.equal(fs.existsSync(path.join(stored, 'chapters', 'intro.tex')), true);
  assert.equal(fs.existsSync(path.join(stored, 'build')), false);
  assert.equal(fs.existsSync(path.join(stored, '.env.local')), false);
});

test('rejects path traversal ZIP entries and removes partial imports', async (t) => {
  const { root, directory, manager } = fixture(t);
  const archive = path.join(root, 'unsafe.zip');
  fs.writeFileSync(archive, makeZip({ '../escape.tex': 'nope', 'main.tex': 'safe' }));

  await assert.rejects(manager.importZip(archive), /invalid|đường dẫn|relative path/i);
  assert.equal(fs.existsSync(path.join(root, 'escape.tex')), false);
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('rejects Windows alternate streams and reserved path names', async (t) => {
  const { root, directory, manager } = fixture(t);
  for (const fileName of ['main.tex:payload', 'CON/readme.tex']) {
    const archive = path.join(root, `${fileName.replace(/[^a-z0-9]/gi, '-')}.zip`);
    fs.writeFileSync(archive, makeZip({ [fileName]: 'unsafe' }));
    await assert.rejects(manager.importZip(archive), /đường dẫn/i);
    assert.deepEqual(fs.readdirSync(directory), []);
  }
});

test('rejects templates without root main.tex and rolls back the destination', async (t) => {
  const { root, directory, manager } = fixture(t);
  const archive = path.join(root, 'missing-main.zip');
  fs.writeFileSync(archive, makeZip({ 'notes.tex': 'No main file' }));

  await assert.rejects(manager.importZip(archive), /main\.tex/i);
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('edits template metadata and preview without changing its id or document files', (t) => {
  const { root, manager } = fixture(t);
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'main.tex'), 'Original document');
  const template = manager.saveProject(project, 'Original');
  const png = fs.readFileSync(path.resolve(__dirname, '../resources/templates/basic-article/preview.png'));
  const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
  const edited = manager.updateMetadata(template.id, { name: 'Báo cáo riêng', description: 'Mô tả mới', language: 'Tiếng Việt', engine: 'xelatex', previewDataUrl: dataUrl });
  assert.equal(edited.id, template.id);
  assert.equal(edited.name, 'Báo cáo riêng');
  assert.equal(edited.engine, 'xelatex');
  assert.equal(edited.description, 'Mô tả mới');
  assert.equal(edited.previewDataUrl, dataUrl);
  assert.equal(fs.readFileSync(path.join(manager.resolve(template.id), 'main.tex'), 'utf8'), 'Original document');
  assert.equal(manager.updateMetadata(template.id, { previewDataUrl: null }).previewDataUrl, null);
});

test('invalid edits and failed publication preserve the previous template', (t) => {
  const { root, directory, manager } = fixture(t);
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'main.tex'), 'Original');
  const template = manager.saveProject(project, 'Keep me');
  for (const changes of [{ engine: 'shell' }, { previewDataUrl: 'data:image/svg+xml;base64,AAAA' }, { description: 'x'.repeat(501) }, { id: 'another-id' }]) {
    assert.throws(() => manager.updateMetadata(template.id, changes));
    assert.equal(manager.list()[0].name, 'Keep me');
  }
  manager.fs = { ...fs, renameSync: (from, to) => {
    if (path.basename(from).startsWith('.import-edit-')) throw new Error('Publish failed');
    return fs.renameSync(from, to);
  } };
  assert.throws(() => manager.updateMetadata(template.id, { name: 'Do not publish' }), /Publish failed/);
  assert.equal(manager.list()[0].name, 'Keep me');
  assert.deepEqual(fs.readdirSync(directory), [template.id]);
});

test('invalid cloud metadata never deletes an existing local template', async (t) => {
  const { root, manager } = fixture(t);
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'main.tex'), 'Original');
  const template = manager.saveProject(project, 'Keep me');
  const buffer = makeZip({ 'main.tex': 'Wrong replacement', 'template.json': '{invalid json' });
  await assert.rejects(manager.importFromBuffer(buffer, 'Cloud', template.id));
  assert.equal(fs.readFileSync(path.join(manager.resolve(template.id), 'main.tex'), 'utf8'), 'Original');
  assert.equal(manager.list()[0].name, 'Keep me');
});
