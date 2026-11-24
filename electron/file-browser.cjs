'use strict';
// The import window's file browser (src/import-window, shown by import-view.cjs), as in VEAcom Next: the folders and
// archives in a folder, the drives with their kind (a CD/DVD drive shows even with no disc in it), and the usual
// places. Nothing is read inside the files here; the chosen paths go to the imaging broker like dropped ones.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

// RAR archives are not listed: the engine refuses them (see native/src/ingest.rs).
const ARCHIVES = /\.zip$/i;
const MAX_ENTRIES = 5000;
const collator = new Intl.Collator('tr', { numeric: true, sensitivity: 'base' });
const withTimeout = (promise, ms, fallback) => Promise.race([promise, new Promise(resolve => setTimeout(() => resolve(fallback), ms))]);

/** Home, Desktop, Downloads and Documents, which Windows can keep on a server (folder redirection). */
function usualPlaces(app) {
  return [['home', 'home'], ['desktop', 'desktop'], ['downloads', 'downloads'], ['documents', 'documents']].flatMap(([name, key]) => {
    try { return [{ key, path: app.getPath(name) }]; } catch { return []; }
  });
}

const inside = (child, parent, paths) => {
  const relative = paths.relative(parent, child);
  return !paths.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${paths.sep}`);
};
const placePaths = places => places.map(place => place.path ?? place);

/**
 * `value` resolved, if it is a local absolute path. A network share or device path (\\server\share, \\?\, \\.\, or
 * /net/host on macOS) would make this PC connect, and on Windows sign in, to the host it names: it is refused, unless
 * it lies inside one of the usual `places`. The import window only offers drives and folders, so this holds even if
 * its page were made to ask for something else. `paths` and `platform` are for tests.
 */
function localPath(value, { places = [], paths = path, platform = process.platform } = {}) {
  if (typeof value !== 'string' || !paths.isAbsolute(value) || /^[\\/]{2}[?.][\\/]/.test(value)) throw new Error('Invalid folder.');
  const resolved = paths.resolve(value);
  const local = platform === 'win32' ? /^[A-Za-z]:\\/.test(resolved) : !/^[\\/]{2}/.test(resolved) && !(platform === 'darwin' && /^\/net(\/|$)/i.test(resolved));
  if (local || places.some(place => inside(resolved, paths.resolve(place), paths))) return resolved;
  throw new Error('Invalid folder.');
}

/** The import window's Open: up to 4096 local paths (localPath), resolved and without repeats. */
function chosenPaths(paths, places = []) {
  if (!Array.isArray(paths) || !paths.length || paths.length > 4096) throw new Error('Invalid selected files.');
  return [...new Set(paths.map(value => localPath(value, { places: placePaths(places) })))];
}

/** The folders and archives in `folder`, folders first in natural order, and how many other files it holds. */
async function browse(folder, places = []) {
  const resolved = localPath(folder, { places: placePaths(places) });
  const entries = await fs.readdir(resolved, { withFileTypes: true });
  const items = [];
  let files = 0, dicomdir = false;
  for (const entry of entries) {
    const name = entry.name;
    if (name.startsWith('.') || name.startsWith('$') || name === 'System Volume Information') continue;
    if (entry.isDirectory()) { if (items.length < MAX_ENTRIES) items.push({ name, path: path.join(resolved, name), kind: 'folder' }); }
    else if (entry.isFile() && ARCHIVES.test(name)) { if (items.length < MAX_ENTRIES) items.push({ name, path: path.join(resolved, name), kind: 'archive' }); }
    else if (entry.isFile()) { files++; if (name.toUpperCase() === 'DICOMDIR') dicomdir = true; }
  }
  items.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'folder' ? -1 : 1) || collator.compare(a.name, b.name));
  // No way up out of a usual place kept on a server: its parent would be refused.
  let parent = path.dirname(resolved);
  if (parent === resolved) parent = null;
  else try { localPath(parent, { places: placePaths(places) }); } catch { parent = null; }
  return { path: resolved, parent, items, files, dicomdir, truncated: items.length >= MAX_ENTRIES };
}

const KINDS = new Set(['removable', 'fixed', 'network', 'disc']);
const LETTERS = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
// The longest volume name Windows gives (MAX_PATH + 1).
const MAX_LABEL = 261;

/**
 * Windows drive kinds and volume names by letter, from the engine (native/src/drives.rs), which reads a name only for
 * the `answering` letters. An engine that is starting, restarting or busy gives none: the drives then keep their
 * letters alone. What it answers is checked: a row that is no drive is left out, and a name is cut to MAX_LABEL.
 */
async function driveTypes(engine, answering) {
  try {
    const response = await engine.connection().request('drives', { answering }, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return {};
    const { drives } = await response.json();
    if (!Array.isArray(drives)) return {};
    return Object.fromEntries(drives.flatMap(drive => typeof drive?.letter === 'string' && /^[A-Z]$/.test(drive.letter) && KINDS.has(drive.kind)
      ? [[drive.letter, { kind: drive.kind, label: typeof drive.label === 'string' ? drive.label.slice(0, MAX_LABEL) : '' }]] : []));
  } catch { return {}; }
}

/** The drives to list: each that answers, and a disc drive even if it does not (it has no disc in it). */
function listedDrives(answering, types) {
  return LETTERS.flatMap(letter => {
    const type = types[letter], ready = answering.includes(letter);
    if (!ready && type?.kind !== 'disc') return [];
    return [{ path: `${letter}:\\`, label: type?.label ? `${type.label} (${letter}:)` : `${letter}:`, kind: type?.kind ?? 'fixed', ready }];
  });
}

/** Drives and usual places. A drive that does not answer within a moment is left out, unless it is a disc drive. */
async function places(app, engine) {
  const home = usualPlaces(app).filter(place => place.key !== 'home');
  if (process.platform !== 'win32') {
    const roots = process.platform === 'darwin' ? ['/Volumes'] : ['/media', '/mnt'];
    const mounted = (await Promise.all(roots.map(root => fs.readdir(root).then(names => names.map(name => path.join(root, name)), () => [])))).flat();
    return { drives: [{ path: '/', label: '/', kind: 'fixed', ready: true }, ...mounted.map(item => ({ path: item, label: path.basename(item), kind: 'removable', ready: true }))], home: [{ key: 'home', path: os.homedir() }, ...home] };
  }
  const reached = await Promise.all(LETTERS.map(letter => withTimeout(fs.access(`${letter}:\\`).then(() => true, () => false), 800, false)));
  const answering = LETTERS.filter((_, index) => reached[index]);
  return { drives: listedDrives(answering, await driveTypes(engine, answering)), home };
}

module.exports = { browse, places, usualPlaces, localPath, chosenPaths, driveTypes, listedDrives };
