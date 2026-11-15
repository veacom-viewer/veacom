// Labelling a folder of films in the browser (docs/deformity-planning.md, "Labelling a folder"), as the desktop's main
// process does it (electron/label-folder.cjs): the DICOM files directly inside the folder, in the order a person would
// number them, each with the plan file beside it. Where the browser lets a page write into a folder it chose (the File
// System Access API: Chrome, Edge), Save and next writes the plan there, only over the plan file the page read for that
// film (or none), and only if that is a deformity plan. Elsewhere the folder is read through a folder input, and each
// plan downloads for the reader to keep.
import type { LabelFilm, LabelFolder, LabelFolderBridge } from '../model';

export const PLAN_SUFFIX = '.veacom-plan.json';
/** A plan file's limit, as src/ui/deformityFile.ts reads them. */
const MAX_PLAN_BYTES = 2_000_000;
const MAX_FILMS = 5000;

interface Writable { write(data: string): Promise<void>; close(): Promise<void> }
export interface FileEntry { kind: 'file'; name: string; getFile(): Promise<File>; createWritable?(): Promise<Writable> }
export interface FolderEntry { kind: 'directory'; name: string; values(): AsyncIterable<FileEntry | FolderEntry>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileEntry>; removeEntry(name: string): Promise<void> }

/** A DICOM file by its Part 10 preamble ("DICM" at byte 128, PS3.10 7.1), or by a .dcm name for files without one. */
export async function isDicom(file: File): Promise<boolean> {
  if (/\.dcm$/i.test(file.name)) return true;
  if (file.size < 132) return false;
  const bytes = new Uint8Array(await file.slice(128, 132).arrayBuffer());
  return String.fromCharCode(...bytes) === 'DICM';
}

/** The order a person would number films in: 2 before 10, letters without case. */
export const filmOrder = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' }) || (a < b ? -1 : a > b ? 1 : 0);

/** The films among the files directly inside a folder, each with its plan file's text (or that it is too large). */
export async function listFilms(files: ReadonlyMap<string, File>): Promise<Array<LabelFilm & { file: File }>> {
  const names = [...files.keys()].filter(name => !name.startsWith('.') && !name.endsWith(PLAN_SUFFIX)).sort(filmOrder);
  const films: Array<LabelFilm & { file: File }> = [];
  for (const name of names) {
    if (films.length >= MAX_FILMS) break;
    const file = files.get(name)!;
    if (!(await isDicom(file))) continue;
    const plan = files.get(`${name}${PLAN_SUFFIX}`);
    films.push({ name, file, plan: plan && plan.size <= MAX_PLAN_BYTES ? await plan.text() : null, ...(plan && plan.size > MAX_PLAN_BYTES ? { unreadable: true as const } : {}) });
  }
  return films;
}

/** What the page was given for a film's plan file, to write over it only while it is still that. */
const given = (film: LabelFilm) => film.unreadable ? 'unreadable' : film.plan;

/** Whether text is a deformity plan file (src/ui/deformityFile.ts): its schema and a version. */
function isPlan(text: string): boolean {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return false; }
  return typeof value === 'object' && value !== null && (value as { schema?: unknown }).schema === 'veacom.deformity-plan'
    && Number.isInteger((value as { version?: unknown }).version);
}

interface Options {
  /** The browser's folder picker for reading and writing, where it has one. */
  pick?: () => Promise<FolderEntry>;
  /** The folder input: the files of a folder, with their paths from it (webkitRelativePath). */
  chooseFiles: () => Promise<File[]>;
  /** An import capability for a file, as the bridge's own importFiles makes. */
  importFile: (file: File) => Promise<string[]>;
  download: (name: string, text: string) => void;
  /** Messages the reader sees when a plan is not written. */
  refused: { invalid: () => string; changed: () => string; notAPlan: () => string; expired: () => string };
}

export function createLabelFolder({ pick, chooseFiles, importFile, download, refused }: Options): LabelFolderBridge {
  const folders = new Map<string, { folder?: FolderEntry; films: Array<LabelFilm & { file: File }> }>();
  const filmOf = (token: string, index: number) => {
    const entry = folders.get(token), film = entry?.films[index];
    if (!entry || !film || !Number.isInteger(index)) throw new Error(refused.expired());
    return { entry, film };
  };
  return {
    async open(): Promise<LabelFolder | null> {
      const files = new Map<string, File>();
      let folder: FolderEntry | undefined, name = '';
      if (pick) {
        try { folder = await pick(); } catch (error) {
          if ((error as Error).name === 'AbortError') return null;
          throw error;
        }
        name = folder.name;
        for await (const entry of folder.values()) if (entry.kind === 'file') files.set(entry.name, await entry.getFile());
      } else {
        const chosen = await chooseFiles();
        if (!chosen.length) return null;
        // Only the files directly inside the chosen folder: "folder/file", not those of the folders within it.
        for (const file of chosen) {
          const parts = file.webkitRelativePath.split('/');
          if (parts.length === 2) { name = parts[0]; files.set(parts[1], file); }
        }
      }
      const films = await listFilms(files), token = `label:${crypto.randomUUID()}`;
      folders.set(token, { folder, films });
      return { token, folder: name, writes: folder ? 'beside' : 'download', films: films.map(({ name: film, plan, unreadable }) => ({ name: film, plan, ...(unreadable ? { unreadable } : {}) })) };
    },
    film(token, index) { return importFile(filmOf(token, index).film.file); },
    async write(token, index, text) {
      const { entry, film } = filmOf(token, index), target = `${film.name}${PLAN_SUFFIX}`;
      if (typeof text !== 'string' || new Blob([text]).size > MAX_PLAN_BYTES || !isPlan(text)) throw new Error(refused.invalid());
      if (!entry.folder) { download(target, text); film.plan = text; return target; }
      // The file there must still be the one read when the folder was opened, or written since (or none), and a plan.
      const existing = await entry.folder.getFileHandle(target).then(handle => handle.getFile(), (error: Error) => {
        if (error.name === 'NotFoundError') return null;
        throw error;
      });
      const now = existing === null ? null : existing.size > MAX_PLAN_BYTES ? 'unreadable' : await existing.text();
      if (now !== null && (now === 'unreadable' || !isPlan(now))) throw new Error(refused.notAPlan());
      if (now !== given(film)) throw new Error(refused.changed());
      const handle = await entry.folder.getFileHandle(target, { create: true });
      // The browser writes to a file of its own and puts it in place on close: a failed write leaves the old plan, and a
      // file this write made is taken away again.
      try {
        const writable = await handle.createWritable!();
        await writable.write(text);
        await writable.close();
      } catch (error) {
        if (existing === null) await entry.folder.removeEntry(target);
        throw error;
      }
      film.plan = text;
      delete film.unreadable;
      return target;
    },
  };
}
