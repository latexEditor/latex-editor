import assert from 'node:assert/strict';
import test from 'node:test';
import { createProject, extractDocumentMeta, TEMPLATES, validateProject } from '../src/core.js';

test('createProject clones template files and selects first file', () => {
  const first = createProject(TEMPLATES[0], '  Research  ');
  const second = createProject(TEMPLATES[0], 'Second');
  assert.equal(first.name, 'Research');
  assert.equal(first.activeFile, 'main.tex');
  assert.notEqual(first.id, second.id);
  first.files['main.tex'] = 'changed';
  assert.notEqual(first.files['main.tex'], TEMPLATES[0].files['main.tex']);
});

test('extractDocumentMeta reads title, author, abstract and outline', () => {
  const source = String.raw`\title{A clear title}
\author{Ada}
\begin{abstract}Short summary.\end{abstract}
\section{Opening}
Text.
\section{Result}`;
  assert.deepEqual(extractDocumentMeta(source).sections, ['Opening', 'Result']);
  assert.equal(extractDocumentMeta(source).title, 'A clear title');
  assert.equal(extractDocumentMeta(source).author, 'Ada');
  assert.equal(extractDocumentMeta(source).abstract, 'Short summary.');
});

test('validateProject rejects incomplete persisted values', () => {
  assert.equal(validateProject({ id: '1', name: 'Good', files: { 'main.tex': '' } }), true);
  assert.equal(validateProject({ id: '1', name: 'No files', files: {} }), false);
  assert.equal(validateProject(null), false);
});
