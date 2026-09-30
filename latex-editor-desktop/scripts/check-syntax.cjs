const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function check(directory) {
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name);
    if (item.isDirectory()) check(file);
    else if (/\.(?:js|cjs)$/.test(item.name)) {
      const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit', windowsHide: true });
      if (result.error || result.status !== 0) process.exit(result.status || 1);
    }
  }
}
check(path.resolve(__dirname, '../src'));
check(__dirname);
console.log('JavaScript syntax checks passed.');
