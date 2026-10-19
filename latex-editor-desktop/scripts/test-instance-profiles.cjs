// Real Electron singleton regression test. No projects/cloud sessions are opened.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

if (process.argv.includes('--profile-child')) {
  const { app, BrowserWindow } = require('electron');
  const { acquireInstanceLock } = require('../src/main/InstanceProfile');
  const acquired = acquireInstanceLock(app, process.env.LATEX_EDITOR_DATA_DIR);
  const report = () => process.stdout.write(`PROFILE_RESULT:${JSON.stringify({ acquired, profile: app.getPath('userData') })}\n`);
  if (!acquired) { report(); app.quit(); }
  else {
    app.on('second-instance', () => {});
    app.whenReady().then(() => {
      global.profileWindow = new BrowserWindow({ show: false });
      setInterval(() => {
        if (fs.existsSync(path.join(process.env.LATEX_EDITOR_DATA_DIR, 'stop-test'))) app.quit();
      }, 100).unref();
      report();
    });
    setTimeout(() => app.quit(), 20000).unref();
  }
} else {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'latex-instance-test-'));
  const children = [];
  const launch = async (name) => {
    const env = { ...process.env, LATEX_EDITOR_DATA_DIR: path.join(root, name) };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require('electron'), [__filename, '--profile-child'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stopFile = path.join(env.LATEX_EDITOR_DATA_DIR, 'stop-test');
    children.push(child);
    child.stderr.resume();
    child.closed = new Promise((resolve) => child.once('close', resolve));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Electron profile startup timed out')), 10000);
      let output = '';
      child.stdout.on('data', (chunk) => {
        output += chunk;
        const line = output.match(/PROFILE_RESULT:(.+)\r?\n/);
        if (line) { clearTimeout(timer); resolve({ child, ...JSON.parse(line[1]) }); }
      });
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); if (!output.includes('PROFILE_RESULT:')) reject(new Error('Electron exited before reporting its lock')); });
    });
  };
  (async () => {
    try {
      const first = await launch('account-one');
      const second = await launch('account-two');
      assert.equal(first.child.exitCode, null, 'first profile is still running');
      assert.equal(second.child.exitCode, null, 'second profile is still running');
      const duplicate = await launch('account-one');
      assert.equal(first.acquired, true);
      assert.equal(second.acquired, true, 'a different profile must open concurrently');
      assert.equal(duplicate.acquired, false, 'the same profile must still be protected');
      assert.notEqual(first.profile, second.profile);
      console.log('PASS: two real Electron profiles run concurrently; duplicate profile is rejected.');
    } finally {
      for (const child of children) fs.writeFileSync(child.stopFile, 'stop');
      await Promise.all(children.map((child) => child.closed));
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  })().catch((error) => { console.error(error); process.exitCode = 1; });
}
