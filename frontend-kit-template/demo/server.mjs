/** No dependencies. Demo only. Serve on http://localhost:3000 by default.
 *  The Cloudflare Worker ALLOWED_ORIGIN must equal the origin in the address bar.
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const kitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT || '3000');
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Set PORT to an unprivileged port (1024–65535).');
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const httpServer = http.createServer(async (request, response) => {
  try {
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405); response.end(); return; }
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const relative = pathname === '/' ? 'demo/index.html' : pathname.replace(/^\/+/, '');
    const resolved = path.resolve(kitRoot, relative);
    if (!resolved.startsWith(kitRoot + path.sep)) { response.writeHead(403); response.end(); return; }
    const stat = await fs.lstat(resolved);
    if (!stat.isFile() || !types[path.extname(resolved)]) { response.writeHead(404); response.end(); return; }
    const data = await fs.readFile(resolved);
    response.writeHead(200, { 'Content-Type': types[path.extname(resolved)], 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
    response.end(request.method === 'HEAD' ? undefined : data);
  } catch { response.writeHead(404); response.end('Not found'); }
});
httpServer.listen(port, 'localhost', () => console.log(`Falco demo: http://localhost:${port}`));
