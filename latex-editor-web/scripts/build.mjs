import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
for (const entry of ['index.html', 'manifest.webmanifest', 'src']) {
  await cp(path.join(root, entry), path.join(dist, entry), { recursive: true });
}
console.log(`Built static web client in ${dist}`);
