// Serves one viewer's files from localhost, so no viewer's timing includes the internet and every viewer gets the same
// server. VEAcom is served by its own web/serve.mjs, with the site's headers; the others by this plain static server,
// cross-origin isolated only when their lockfile entry says they need it.
import { spawn } from 'node:child_process';
import { createReadStream, promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css',
  '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8', '.gz': 'application/gzip',
};
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * Serves `root` on a free port; `spa` answers unknown paths with index.html (client-side routes such as /local), and
 * `overlay` ({ 'app-config.js': '/abs/file' }) serves the given files in place of the viewer's own.
 */
export async function serveStatic(root, { isolation = false, spa = false, overlay = {} } = {}) {
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...(isolation ? {
    'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'same-origin' } : {}) };
  const inside = root.endsWith(path.sep) ? root : root + path.sep;
  // One bad request answers an error; it never ends the run this server lives in.
  const server = createServer((request, response) => {
    answer(request, response).catch(() => { if (!response.headersSent) response.writeHead(500, headers); response.end(); });
  });
  async function answer(request, response) {
    const url = new URL(request.url, 'http://localhost');
    let relative;
    try { relative = decodeURIComponent(url.pathname).replace(/^\/+/, ''); } catch { response.writeHead(400, headers).end(); return; }
    let file = overlay[relative] ?? path.join(root, relative);
    if (!overlay[relative] && file !== root && !file.startsWith(inside)) { response.writeHead(403, headers).end(); return; }
    let stat = await fs.stat(file).catch(() => null);
    if (stat?.isDirectory()) { file = path.join(file, 'index.html'); stat = await fs.stat(file).catch(() => null); }
    if (!stat && spa && !path.extname(url.pathname)) { file = path.join(root, 'index.html'); stat = await fs.stat(file).catch(() => null); }
    if (!stat) { response.writeHead(404, headers).end(); return; }
    response.writeHead(200, { ...headers, 'Content-Type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'Content-Length': stat.size });
    if (request.method === 'HEAD') { response.end(); return; }
    createReadStream(file).on('error', () => response.destroy()).pipe(response);
  }
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise(resolve => server.close(resolve)) };
}

/** Serves a VEAcom browser build (a dist-web folder) with web/serve.mjs, as the site would. */
export async function serveVeacom(dist, { isolation = true } = {}) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  // Electron runs the script as plain Node, so the harness needs no other Node on the machine.
  const child = spawn(process.execPath, [path.join(repository, 'web', 'serve.mjs'), String(port), dist, ...(isolation ? [] : ['--no-isolation'])],
    { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`web/serve.mjs exited (${code})`)));
    child.stdout.once('data', resolve);
  });
  return { url: `http://127.0.0.1:${port}/`, close: async () => { child.kill(); } };
}
