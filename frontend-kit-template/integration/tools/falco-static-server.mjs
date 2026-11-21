/**
 * Tiny, zero-dependency local HTTP server for an integrated STATIC website.
 * Copy to <website-root>/tools/falco-static-server.mjs along with ABRIR_DEMO.cmd.
 * Run from the website root; serve only on localhost, never on a public interface.
 * For React/Vite/Next or an existing dev server, adapt the CMD to launch that server instead.
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.avif', 'image/avif'],
  ['.gif', 'image/gif'],
  ['.ico', 'image/x-icon'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json'],
  ['.mp4', 'video/mp4'],
]);

const DENY_SEGMENTS = new Set(['node_modules', '.git', '.generated', '.wrangler', '.vscode', '.github']);
const DENY_FILENAMES = new Set(['package.json', 'package-lock.json', 'wrangler.json', 'wrangler.toml']);

function inside(root, file) {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

export async function createStaticServer({ root = process.cwd(), port = 3000, host = 'localhost' } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer between 0 and 65535');
  if (host !== 'localhost') throw new Error('This development server may only bind to localhost');
  const publicRoot = await fs.realpath(root);
  const server = http.createServer(async (req, res) => {
    const end = (status, value = '') => {
      res.writeHead(status, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(value);
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') return end(405);
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const raw = decodeURIComponent(url.pathname);
      const relative = raw === '/' ? 'index.html' : raw.replace(/^\/+/, '').replace(/\/$/, '/index.html');
      const segments = relative.split('/');
      if (segments.some(s => !s || s.startsWith('.') || DENY_SEGMENTS.has(s.toLowerCase()))) return end(403);
      if (DENY_FILENAMES.has(segments.at(-1).toLowerCase())) return end(403);
      const candidate = path.resolve(publicRoot, relative);
      if (!inside(publicRoot, candidate)) return end(403);
      const file = await fs.realpath(candidate);
      if (!inside(publicRoot, file)) return end(403);
      const stat = await fs.stat(file);
      const type = TYPES.get(path.extname(file).toLowerCase());
      if (!stat.isFile() || !type || stat.size > 20_000_000) return end(404);
      const content = await fs.readFile(file);
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': content.length,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (e) {
      return end(e?.code === 'ENOENT' || e?.code === 'ENOTDIR' ? 404 : 400);
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  try {
    const server = await createStaticServer({ port, root: process.cwd() });
    console.log(`\nWebsite with Falco: http://localhost:${server.address().port}/`);
    console.log('Leave this window open. Ctrl+C to stop. Do not open index.html using file://.\n');
  } catch (error) {
    console.error(`[ERROR] Could not start the local site: ${error.message}`);
    if (error?.code === 'EADDRINUSE') console.error('Another app is using port 3000. Close it first.');
    process.exitCode = 1;
  }
}
