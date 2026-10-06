const fs = require('node:fs');
const path = require('node:path');

const MARKER = '/* latex-editor: build-and-view */';
const BUILD_COMMAND = "vscode.commands.registerCommand('latex-workshop.build', () => lw_1.lw.commands.build())";
const BUILD_AND_VIEW_COMMAND = `vscode.commands.registerCommand('latex-workshop.build', async () => {
        ${MARKER}
        let succeeded = false;
        const buildDone = lw_1.lw.event.on(lw_1.lw.event.BuildDone, () => { succeeded = true; });
        try {
            await lw_1.lw.commands.build();
            if (succeeded) {
                await lw_1.lw.commands.view('tab');
            }
        }
        finally {
            buildDone.dispose();
        }
    })`;

function extensionVersion(name) {
  return (name.match(/latex-workshop-(\d+(?:\.\d+)*)/i)?.[1] || '0')
    .split('.')
    .map((part) => Number(part));
}

function compareVersions(left, right) {
  const a = extensionVersion(left);
  const b = extensionVersion(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (b[index] || 0) - (a[index] || 0);
    if (difference) return difference;
  }
  return right.localeCompare(left);
}

function ensureBuildOpensPdf(extensionsDir, dependencies = {}) {
  const fileSystem = dependencies.fs || fs;
  if (!fileSystem.existsSync(extensionsDir)) return { available: false, patched: false };
  const candidates = fileSystem.readdirSync(extensionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^james-yu\.latex-workshop-/i.test(entry.name))
    .map((entry) => entry.name)
    .sort(compareVersions);

  for (const directory of candidates) {
    const extensionMain = path.join(extensionsDir, directory, 'out', 'src', 'main.js');
    if (!fileSystem.existsSync(extensionMain)) continue;
    const source = fileSystem.readFileSync(extensionMain, 'utf8');
    if (source.includes(MARKER) || source.includes('const originalBuild = lw_1.lw.commands.build;')) {
      return { available: true, patched: false, extensionMain };
    }
    if (!source.includes(BUILD_COMMAND)) continue;
    fileSystem.writeFileSync(extensionMain, source.replace(BUILD_COMMAND, BUILD_AND_VIEW_COMMAND), 'utf8');
    return { available: true, patched: true, extensionMain };
  }
  return { available: false, patched: false };
}

module.exports = { ensureBuildOpensPdf };
