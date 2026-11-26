import { HEAD_GROUP_SIZE, readHeads } from '../../web/file-heads.js';
import { allowExternalDrop, externalDropEffect } from '../ui/fileDrop';

export interface SelectedFile { path: string; file: File }
export type FileSource = SelectedFile | { path: string; entry: FileSystemFileEntry };
export type ImportFiles = SelectedFile[] | { port: MessagePort; count: number };
export interface CapturedDrop { files: File[]; entries: FileSystemEntry[] }

/** Directory entries must be taken during the drop. Keep each early selection until the reader installs its handler. */
export function watchFileDrops(target: Document) {
  let pending: CapturedDrop[] | undefined = [];
  let latest: CapturedDrop | null = null;
  target.addEventListener('dragover', allowExternalDrop, true);
  target.addEventListener('drop', event => {
    const transfer = event.dataTransfer, effect = externalDropEffect(transfer);
    if (!transfer || !effect) return;
    if (pending) event.preventDefault();
    if (effect !== 'copy' || !transfer.files.length) return;
    const drop = {
      files: Array.from(transfer.files),
      entries: Array.from(transfer.items, item => item.webkitGetAsEntry()).filter((entry): entry is FileSystemEntry => Boolean(entry)),
    };
    if (pending) pending.push(drop);
    else latest = drop;
  }, true);
  return {
    takePending() {
      const early = pending ?? [];
      pending = undefined;
      target.removeEventListener('dragover', allowExternalDrop, true);
      return early;
    },
    takeLatest() { const drop = latest; latest = null; return drop; },
  };
}

function acquire(source: FileSource): Promise<SelectedFile> {
  if ('file' in source) return Promise.resolve(source);
  return new Promise((resolve, reject) => source.entry.file(file => resolve({ path: source.path, file }), reject));
}

async function walk(root: FileSystemEntry): Promise<FileSource[]> {
  if (root.isFile) return [await acquire({ path: root.name, entry: root as FileSystemFileEntry })];
  const found: { path: string; entry: FileSystemFileEntry }[] = [];
  const visit = async (entry: FileSystemEntry, path: string): Promise<void> => {
    if (entry.isFile) { found.push({ path, entry: entry as FileSystemFileEntry }); return; }
    if (!entry.isDirectory) return;
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
      if (!batch.length) break;
      await Promise.all(batch.map(child => visit(child, `${path}/${child.name}`)));
    }
  };
  await visit(root, root.name);
  return found;
}

export async function droppedFileGroups(files: File[], drop: CapturedDrop | null): Promise<FileSource[][]> {
  const same = drop && drop.files.length === files.length && drop.files.every((file, i) => file === files[i]);
  if (same && drop.entries.length) {
    // DataTransfer.files already holds the selected files in drag item order (HTML, dom-datatransfer-files).
    const looseFiles = drop.entries.length === files.length && drop.entries.every((entry, i) => entry.isFile && entry.name === files[i].name);
    if (!looseFiles) return Promise.all(drop.entries.map(walk));
  }
  return files.map(file => [{ path: file.name, file }]);
}

/** Each group can reach the engine while the browser is still acquiring Files in another group. */
export function importFileSources(sources: FileSource[]): ImportFiles {
  if (sources.every((source): source is SelectedFile => 'file' in source)) return sources;
  const { port1, port2 } = new MessageChannel();
  const groups: Promise<void>[] = [];
  for (let offset = 0; offset < sources.length; offset += HEAD_GROUP_SIZE) {
    groups.push(Promise.all(sources.slice(offset, offset + HEAD_GROUP_SIZE).map(acquire)).then(files => {
      port1.postMessage({ offset, files });
    }));
  }
  void Promise.all(groups).catch(error => {
    port1.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }).finally(() => port1.close());
  return { port: port2, count: sources.length };
}

/** The engine registers the files in selection order, including those beyond the header read budget. */
export async function readImportFiles(source: ImportFiles) {
  if (Array.isArray(source)) return { files: source, heads: await readHeads(source) };
  const { port, count } = source;
  const files = new Array<SelectedFile>(count);
  const arrived: (() => void)[] = [];
  const groups = Array.from({ length: Math.ceil(count / HEAD_GROUP_SIZE) }, (_, index) =>
    new Promise<void>(resolve => { arrived[index] = resolve; }));
  let error: Error | undefined;
  function fail(message: string) {
    error = new Error(message);
    for (const wake of arrived) wake();
  }
  port.onmessageerror = () => fail('The browser could not transfer the selected files.');
  port.onmessage = ({ data }: MessageEvent<{ offset: number; files: SelectedFile[] } | { error: string }>) => {
    if ('error' in data) { fail(data.error); return; }
    for (const [index, file] of data.files.entries()) files[data.offset + index] = file;
    arrived[data.offset / HEAD_GROUP_SIZE]();
  };
  try {
    const heads = await readHeads(files, async offset => {
      await groups[offset / HEAD_GROUP_SIZE];
      if (error) throw error;
    });
    return { files, heads };
  } finally { port.close(); }
}
