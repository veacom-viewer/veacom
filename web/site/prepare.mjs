// Makes the site's files (web/site/public) from the browser build (dist-web): web.html becomes the home page, and only
// the files it uses go along, with the licenses of the fonts and icons. Stops if a file is of a kind a site has no
// reason to publish, or too large for Cloudflare.
//   web\build.ps1; pnpm run build:browser; node web/site/prepare.mjs
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, '../../dist-web');
const out = path.join(here, 'public');
const MAX_FILE = 25 * 1024 * 1024; // Cloudflare's limit for one static file
const PUBLISHABLE = /\.(html|js|css|wasm|woff2|svg|txt)$/;

function walk(folder, prefix = '') {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? walk(path.join(folder, entry.name), relative) : [relative];
  });
}

const files = walk(dist);
const byName = new Map();
for (const file of files) {
  const name = path.posix.basename(file);
  if (byName.has(name)) throw new Error(`Two files are called ${name}: ${byName.get(name)} and ${file}`);
  byName.set(name, file);
}

// From the home page, every file a page, script or style sheet names, and so on.
const keep = new Set(['web.html']);
const queue = ['web.html'];
while (queue.length) {
  const file = queue.pop();
  if (!/\.(html|js|css)$/.test(file)) continue;
  const text = readFileSync(path.join(dist, file), 'utf8');
  for (const [name, target] of byName) {
    if (!keep.has(target) && text.includes(name)) {
      keep.add(target);
      queue.push(target);
    }
  }
}
for (const file of files) if (/LICENSE/.test(file)) keep.add(file);

let bytes = 0;
for (const file of keep) {
  const size = statSync(path.join(dist, file)).size;
  if (!PUBLISHABLE.test(file)) throw new Error(`Not a kind of file the site publishes: ${file}`);
  if (size > MAX_FILE) throw new Error(`Larger than Cloudflare's 25 MiB per file: ${file}`);
  bytes += size;
}

// Files of an earlier build that are not written again are removed one by one: the folder itself stays, since a
// running `wrangler dev` holds it open on Windows.
const published = new Set([...keep].map((file) => (file === 'web.html' ? 'index.html' : file)));
mkdirSync(out, { recursive: true });
for (const file of walk(out)) if (!published.has(file)) rmSync(path.join(out, file), { force: true });
for (const file of keep) {
  const target = path.join(out, file === 'web.html' ? 'index.html' : file);
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(path.join(dist, file), target);
}
const left = files.filter((file) => !keep.has(file));
console.log(`web/site/public: ${keep.size} files, ${(bytes / 1048576).toFixed(1)} MB. Left behind: ${left.join(', ') || 'nothing'}`);
