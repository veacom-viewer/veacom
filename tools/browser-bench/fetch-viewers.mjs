// Downloads the pinned viewers of tools/browser-bench/viewers.json into ~/.cache/veacom-bench/viewers/<name>@<version> and checks
// each against its tree hash, so every machine benchmarks exactly the same files. A copy already there is checked,
// not downloaded again. For the live-only PlexusMD it only reports whether the live build still matches the pin.
//   node tools/browser-tools/browser-bench/fetch-viewers.mjs [name …]
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const LOCK = JSON.parse(readFileSync(path.join(here, 'viewers.json'), 'utf8'));
const cache = path.join(os.homedir(), '.cache', 'veacom-bench');
export const viewerFolder = entry => path.join(cache, 'viewers', `${entry.name}@${entry.version}`);
export const lockEntry = name => LOCK.viewers.find(entry => entry.name === name);

/** SHA-256 of the sorted lines '<file sha256>  <relative path>' (the same as `find . -type f | sort | xargs shasum -a 256`). */
export async function treeHash(folder) {
  const entries = [];
  let bytes = 0;
  const walk = async relative => {
    for (const item of await readdir(path.join(folder, relative), { withFileTypes: true })) {
      const child = relative ? `${relative}/${item.name}` : item.name;
      if (item.isDirectory()) await walk(child);
      else if (item.isFile()) {
        const content = await readFile(path.join(folder, child));
        bytes += content.length;
        entries.push([child, createHash('sha256').update(content).digest('hex')]);
      }
    }
  };
  await walk('');
  entries.sort((a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])));
  return { files: entries.length, bytes, sha256: createHash('sha256').update(entries.map(([p, h]) => `${h}  ${p}\n`).join('')).digest('hex') };
}

async function download(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'veacom-bench' } });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function fetchTarball(entry, into) {
  const archive = await download(entry.source.url);
  const sha = createHash('sha256').update(archive).digest('hex');
  if (entry.source.sha256 && sha !== entry.source.sha256) throw new Error(`${entry.name}: the download's SHA-256 is ${sha}, not ${entry.source.sha256}`);
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'veacom-bench-'));
  try {
    await writeFile(path.join(scratch, 'archive.tgz'), archive);
    // The operating system's tar (bsdtar on macOS and Windows, GNU tar on Linux): no unpacking package needed.
    execFileSync('tar', ['-xzf', path.join(scratch, 'archive.tgz'), '-C', scratch]);
    await rename(path.join(scratch, entry.source.folder), into);
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

async function fetchGitTree(entry, into) {
  const { repo, commit, path: base, gitTree } = entry.source;
  const listing = JSON.parse((await download(`https://api.github.com/repos/${repo}/git/trees/${gitTree}?recursive=1`)).toString('utf8'));
  if (listing.truncated) throw new Error(`${entry.name}: GitHub truncated the tree listing.`);
  for (const blob of listing.tree.filter(item => item.type === 'blob')) {
    const content = await download(`https://raw.githubusercontent.com/${repo}/${commit}/${base ? `${base}/` : ''}${blob.path}`);
    // Git's own object hash: every file is checked against the pinned tree as it arrives.
    const sha1 = createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
    if (sha1 !== blob.sha) throw new Error(`${entry.name}: ${blob.path} does not match the pinned tree.`);
    await mkdir(path.dirname(path.join(into, blob.path)), { recursive: true });
    await writeFile(path.join(into, blob.path), content);
  }
}

/** Fetches (if missing) and checks one viewer; returns its folder. */
export async function ensureViewer(entry, { log = console.log } = {}) {
  const folder = viewerFolder(entry);
  if (entry.source.type === 'live') return null;
  if (!existsSync(folder)) {
    log(`Fetching ${entry.name} ${entry.version} …`);
    const partial = `${folder}.partial-${process.pid}`;
    await rm(partial, { recursive: true, force: true });
    await mkdir(path.dirname(folder), { recursive: true });
    if (entry.source.type === 'tarball') await fetchTarball(entry, partial);
    else if (entry.source.type === 'git-tree') { await mkdir(partial); await fetchGitTree(entry, partial); }
    else throw new Error(`${entry.name}: unknown source type ${entry.source.type}`);
    const tree = await treeHash(partial);
    if (tree.sha256 !== entry.tree.sha256) { await rm(partial, { recursive: true, force: true }); throw new Error(`${entry.name}: the files' tree hash is ${tree.sha256}, not ${entry.tree.sha256}`); }
    await rename(partial, folder);
    return folder;
  }
  const tree = await treeHash(folder);
  if (tree.sha256 !== entry.tree.sha256) throw new Error(`${folder} has changed (tree ${tree.sha256}); delete it and fetch again.`);
  return folder;
}

/** The live site's asset names now, and whether they are still the pinned build. */
export async function liveBuild(entry) {
  const page = (await download(entry.source.url)).toString('utf8');
  const assets = [...new Set(page.match(/assets\/[A-Za-z0-9_.-]+\.(?:js|css)/g) ?? [])].sort();
  return { assets, pinned: JSON.stringify(assets) === JSON.stringify([...entry.source.assets].sort()) };
}

/** Fetches and checks the named viewers (all when none are named), and reports on the live one. */
export async function fetchAll(names = []) {
  for (const entry of LOCK.viewers.filter(e => !names.length || names.includes(e.name))) {
    if (entry.source.type === 'live') {
      const live = await liveBuild(entry);
      console.log(`${entry.name}: live build ${live.pinned ? 'matches the pin' : `has changed: ${live.assets.join(' ')}`}`);
      continue;
    }
    console.log(`${entry.name} ${entry.version}: ${await ensureViewer(entry)} (checked)`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await fetchAll(process.argv.slice(2));
