const test = require('node:test');
const assert = require('node:assert/strict');

const configPath = require.resolve('../src/main/config');

function loadConfig(apiUrl) {
  const previous = process.env.LATEX_EDITOR_API_URL;
  if (apiUrl === undefined) delete process.env.LATEX_EDITOR_API_URL;
  else process.env.LATEX_EDITOR_API_URL = apiUrl;
  delete require.cache[configPath];
  const config = require(configPath);
  if (previous === undefined) delete process.env.LATEX_EDITOR_API_URL;
  else process.env.LATEX_EDITOR_API_URL = previous;
  delete require.cache[configPath];
  return config;
}

test('uses the deployed cloud Worker by default so Google login is available', () => {
  assert.equal(loadConfig().apiUrl, 'https://latex-editor-cloud.emsidt.workers.dev');
});

test('allows development builds to override the cloud Worker URL', () => {
  assert.equal(loadConfig('http://127.0.0.1:8787').apiUrl, 'http://127.0.0.1:8787');
});
