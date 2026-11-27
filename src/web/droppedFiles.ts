import { HEAD_GROUP_SIZE, readHeads } from '../../web/file-heads.js';
import type { CapturedDrop } from './fileDropCapture';

export interface SelectedFile { path: string; file: File }
export type FileSource = SelectedFile | { path: string; entry: FileSystemFileEntry };
export type ImportFiles = SelectedFile[] | { port: MessagePort; count: number };
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

const MAX_ACQUIRE_GROUPS = 4;

/** Each group can reach the engine while the browser is still acquiring Files in another group. */
export function importFileSources(sources: FileSource[]): ImportFiles {
  if (sources.every((source): source is SelectedFile => 'file' in source)) return sources;
  const { port1, port2 } = new MessageChannel();
  let nextOffset = 0;
  let stopped = false;
  let failed: string | undefined;
  const isDone = () => stopped || failed !== undefined;
  port1.onmessage = () => { stopped = true; };
  const worker = async (): Promise<void> => {
    while (!isDone() && nextOffset < sources.length) {
      const offset = nextOffset;
      nextOffset += HEAD_GROUP_SIZE;
      const batch = sources.slice(offset, offset + HEAD_GROUP_SIZE);
      try {
        const files = await Promise.all(batch.map(acquire));
        if (isDone()) return;
        port1.postMessage({ offset, files });
      } catch (error) {
        if (!isDone()) {
          failed = error instanceof Error ? error.message : String(error);
          port1.postMessage({ error: failed });
        }
        return;
      }
    }
  };
  const groupCount = Math.ceil(sources.length / HEAD_GROUP_SIZE);
  const runners = Array.from({ length: Math.min(MAX_ACQUIRE_GROUPS, groupCount) }, () => worker());
  void Promise.all(runners).finally(() => port1.close());
  return { port: port2, count: sources.length };
}

/** The engine registers the files in selection order, including those beyond the header read budget. */
export async function readImportFiles(source: ImportFiles, onFile?: (file: SelectedFile, head: Uint8Array | undefined) => void) {
  const files = Array.isArray(source) ? source : new Array<SelectedFile>(source.count);
  const register = onFile && ((index: number, head: Uint8Array | undefined) => onFile(files[index], head));
  if (Array.isArray(source)) return { files, heads: await readHeads(files, undefined, register) };
  const { port, count } = source;
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
    }, register);
    return { files, heads };
  } finally {
    try { port.postMessage({ stop: true }); } catch { /* Port may already be closed. */ }
    port.close();
  }
}
