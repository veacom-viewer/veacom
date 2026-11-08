// Serves a folder on 127.0.0.1 with the headers viewer.veacom.app would send (COOP/COEP, so SharedArrayBuffer and
// WebAssembly threads are allowed, and the content policy below). Without a folder it serves this one (the measurement
// page); `dist` is the interface's build, opened at web.html. For development it also serves the synthetic test
// studies under /__testdata/<name>/, set by VEACOM_TESTDATA (default D:\veacom-dev\testdata).
//   node web/serve.mjs [port] [folder]
import { createServer } from 'node:http';
import { createReadStream, existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(process.argv[3] ?? path.dirname(fileURLToPath(import.meta.url)));
const start = existsSync(path.join(root, 'web.html')) ? 'web.html' : 'index.html';
const port = Number(process.argv[2] ?? 5199);
const testdata = process.env.VEACOM_TESTDATA ?? 'D:\\veacom-dev\\testdata';
// Only these synthetic or openly licensed studies are ever served.
const studies = {
  petct: 'tcia/FDG-PET-CT-Lesions/PETCT_8fea5f0537',
  bigct: 'bigct',
  calisma: 'demo/Calisma.zip',
  // The first bigct series re-encoded losslessly, to check the JPEG 2000 and JPEG Lossless decoders.
  jtwok: 'bigct_j2k',
  jpegll: 'bigct_jpegll',
};
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm', '.json': 'application/json', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const headers = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  // Opened files are untrusted. The page and its Workers may run only the site's own scripts (and its WebAssembly),
  // may connect only to the site itself, so nothing can be sent elsewhere, and may not turn text into HTML or script
  // (Trusted Types). The policies: `default` (src/web/trusted-types.ts: icon shapes, the site's own Workers) and
  // `veacom-worker` (the measurement page's engine Worker).
  'Content-Security-Policy': [
    "default-src 'none'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "worker-src 'self'",
    "connect-src 'self'",
    "style-src 'self'",
    "font-src 'self'",
    "img-src 'self' blob: data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "require-trusted-types-for 'script'",
    'trusted-types default veacom-worker',
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), usb=(), serial=(), bluetooth=()',
  'Cache-Control': 'no-store',
};

async function walk(folder, prefix, out) {
  for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
    const relative = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) await walk(path.join(folder, entry.name), relative, out);
    else if (entry.isFile()) out.push(relative);
  }
  return out;
}

async function send(response, file) {
  const stat = await fs.stat(file).catch(() => null);
  if (!stat?.isFile()) {
    response.writeHead(404, headers).end();
    return;
  }
  response.writeHead(200, { ...headers, 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream', 'Content-Length': stat.size });
  createReadStream(file).pipe(response);
}

createServer(async (request, response) => {
  const url = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const test = url.match(/^\/__testdata\/([a-z]+)\/(.+)$/);
  if (test) {
    const study = studies[test[1]];
    if (!study) return response.writeHead(404, headers).end();
    const base = path.join(testdata, study);
    const name = path.basename(base);
    if (test[2] === '__list') {
      const files = study.endsWith('.zip') ? [name] : await walk(base, name, []);
      response.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
      return response.end(JSON.stringify({ roots: [name], files }));
    }
    // <name>/<path inside the study>; nothing outside the study folder.
    const inside = test[2].split('/').slice(1).join('/');
    const file = study.endsWith('.zip') ? base : path.join(base, inside);
    if (file !== base && !file.startsWith(base + path.sep)) return response.writeHead(403, headers).end();
    return send(response, file);
  }
  let file = path.join(root, url === '/' ? start : url);
  if (!file.startsWith(root + path.sep)) return response.writeHead(403, headers).end();
  return send(response, file);
}).listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port}/`));
