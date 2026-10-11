const assert = require('node:assert/strict');
const test = require('node:test');
const { CollaborationBridge } = require('../src/main/CollaborationBridge');

test('localhost collaboration bridge requires its random token and relays both directions', async (t) => {
  const received = [];
  const bridge = new CollaborationBridge({ onMessage: async (message) => received.push(message) });
  t.after(() => bridge.stop());
  const { port, token } = await bridge.start();
  const url = `http://127.0.0.1:${port}/events`;

  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-LaTeX-Editor-Bridge-Token': token },
    body: JSON.stringify({ type: 'document:open', path: 'main.tex', text: 'Hello' })
  })).status, 200);
  assert.equal(received[0].path, 'main.tex');

  bridge.publish({ type: 'document:remote', path: 'main.tex', text: 'Remote' });
  const response = await fetch(url, { headers: { 'X-LaTeX-Editor-Bridge-Token': token } });
  assert.deepEqual(await response.json(), { events: [{ type: 'document:remote', path: 'main.tex', text: 'Remote' }] });
});
