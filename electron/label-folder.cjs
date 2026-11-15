// A folder of long-leg films to label one after another (docs/deformity-planning.md, "Labelling a folder"). The reader
// chooses the folder in the system's dialog; main lists the DICOM files directly inside it and keeps their paths, so the
// page names a film only by the folder's token and its place in the list. A plan is written only when the reader presses
// Save and next, beside its film as `<film's file name>.veacom-plan.json`, and only over the plan file the page was given
// for that film (or none), and only if that file is a deformity plan: a file changed or added since, or any other file,
// is left alone.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const PLAN_SUFFIX = '.veacom-plan.json';
/** A plan file's limit, as the page's own (src/ui/deformityFile.ts). */
const MAX_PLAN_BYTES = 2_000_000;
const MAX_FILMS = 5000;

const sha256 = text => createHash('sha256').update(text).digest('hex');

/** A DICOM file by its Part 10 preamble ("DICM" at byte 128, PS3.10 7.1), or by a .dcm name for files without one. */
async function isDicom(file) {
  if (/\.dcm$/i.test(file)) return true;
  // A file that cannot be opened (permissions, gone meanwhile) is not a film the queue could import.
  const handle = await fs.open(file, 'r').catch(() => null);
  if (!handle) return false;
  try {
    const { bytesRead, buffer } = await handle.read(Buffer.alloc(132), 0, 132, 0);
    return bytesRead === 132 && buffer.toString('latin1', 128, 132) === 'DICM';
  } finally { await handle.close(); }
}

/** The films of a folder, in the order a person would number them, with the plan file beside each: its text, or that it
 * is too large to be a plan. */
async function listFilms(root) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const names = entries.filter(entry => entry.isFile() && !entry.name.startsWith('.') && !entry.name.endsWith(PLAN_SUFFIX)).map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' }) || (a < b ? -1 : a > b ? 1 : 0));
  const films = [];
  for (const name of names) {
    if (films.length >= MAX_FILMS) break;
    const file = path.join(root, name);
    if (await isDicom(file)) films.push({ name, path: file, plan: await readPlan(`${file}${PLAN_SUFFIX}`) });
  }
  return films;
}

/** The plan file at `file`: null when there is none; `unreadable` when it is not a file, too large or cannot be read;
 * otherwise its text. */
async function readPlan(file) {
  let stat;
  try { stat = await fs.lstat(file); } catch (error) {
    if (error.code === 'ENOENT') return null;
    return { unreadable: true };
  }
  if (!stat.isFile() || stat.size > MAX_PLAN_BYTES) return { unreadable: true };
  // One plan that cannot be read (permissions) is that film's state, not a failure of the whole folder.
  const text = await fs.readFile(file, 'utf8').catch(() => null);
  return text === null ? { unreadable: true } : { text };
}

/** Whether text is a deformity plan file (src/ui/deformityFile.ts): its schema and a version. */
function isPlan(text) {
  let value;
  try { value = JSON.parse(text); } catch { return false; }
  return Boolean(value) && value.schema === 'veacom.deformity-plan' && Number.isInteger(value.version);
}

/** The state of a plan file as the page was told it: `none`, or the hash of the text it was given. */
const known = plan => plan === null ? 'none' : plan.text === undefined ? 'unreadable' : sha256(plan.text);

function createLabelFolder({ dialog, getWindow, authorize, t }) {
  const folders = new Map();

  function filmOf(token, index) {
    const folder = typeof token === 'string' ? folders.get(token) : undefined;
    if (!folder || !Number.isInteger(index) || index < 0 || index >= folder.films.length) throw new Error(t('label.expired'));
    return folder.films[index];
  }

  return {
    async open() {
      const selected = await dialog.showOpenDialog(getWindow(), { title: t('dialog.labelFolder'), properties: ['openDirectory'] });
      if (selected.canceled || !selected.filePaths.length) return null;
      const root = selected.filePaths[0], films = await listFilms(root), token = `label:${randomUUID()}`;
      folders.set(token, { root, films: films.map(film => ({ name: film.name, path: film.path, known: known(film.plan) })) });
      return { token, folder: path.basename(root), writes: 'beside',
        films: films.map(film => ({ name: film.name, plan: film.plan?.text ?? null, ...(film.plan?.unreadable ? { unreadable: true } : {}) })) };
    },
    /** An import capability for one film of the folder. */
    film(token, index) { return authorize([filmOf(token, index).path]); },
    /** Writes a film's plan beside it, and returns the file's name. */
    async write(token, index, text) {
      const film = filmOf(token, index);
      if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_PLAN_BYTES || !isPlan(text)) throw new Error(t('label.invalidPlan'));
      const target = `${film.path}${PLAN_SUFFIX}`, now = await readPlan(target);
      // The file there must still be the one the page was given (or none), and a plan: anything else is someone's and stays.
      if (now !== null && (now.text === undefined || !isPlan(now.text))) throw new Error(t('label.notAPlan'));
      if (known(now) !== film.known) throw new Error(t('label.planChanged'));
      // Written beside its place under a name of its own and renamed into it, so a half-written plan never replaces a
      // whole one.
      const partial = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.part`);
      let written = false;
      try {
        await fs.writeFile(partial, text, { encoding: 'utf8', flag: 'wx' });
        written = true;
        await fs.rename(partial, target);
      } catch (error) {
        if (written) await fs.rm(partial, { force: true });
        throw error;
      }
      film.known = sha256(text);
      return path.basename(target);
    },
  };
}

function registerLabelFolder({ handle, dialog, getWindow, authorize, t }) {
  const folder = createLabelFolder({ dialog, getWindow, authorize, t });
  handle('label:open', () => folder.open());
  handle('label:film', (token, index) => folder.film(token, index));
  handle('label:write', (token, index, text) => folder.write(token, index, text));
  return folder;
}

module.exports = { createLabelFolder, registerLabelFolder, listFilms, PLAN_SUFFIX };
