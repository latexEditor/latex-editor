import { createReadStream, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT || 4173);
const types = { '.css': 'text/css', '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

createServer((request, response) => {
  const rawPath = decodeURIComponent(new URL(request.url, `http://${request.headers.host}`).pathname);
  const candidate = path.resolve(root, `.${rawPath === '/' ? '/index.html' : rawPath}`);
  if (!candidate.startsWith(root) || !existsSync(candidate)) {
    response.writeHead(404).end('Not found');
    return;
  }
  response.setHeader('Content-Type', types[path.extname(candidate)] || 'application/octet-stream');
  response.setHeader('Cache-Control', 'no-store');
  createReadStream(candidate).pipe(response);
}).listen(port, '127.0.0.1', () => console.log(`LaTeX Editor Web: http://127.0.0.1:${port}`));
