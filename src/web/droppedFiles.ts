export interface SelectedFile { path: string; file: File }
type Directory = FolderHandle | null;
export interface CapturedDrop { files: File[]; entries: FileSystemEntry[]; folders?: Map<FileSystemEntry, Promise<Directory>> }

export function captureDrop(transfer: DataTransfer): CapturedDrop {
  const entries: FileSystemEntry[] = [], folders = new Map<FileSystemEntry, Promise<Directory>>();
  for (const item of transfer.items) {
    const entry = item.webkitGetAsEntry();
    if (!entry) continue;
    entries.push(entry);
    const source = item as DataTransferItem & { getAsFileSystemHandle?: () => Promise<FileHandle | FolderHandle | null> };
    if (entry.isDirectory && source.getAsFileSystemHandle) {
      // A drop can grant a handle only during the same event. The legacy entry is still available for unsupported handles.
      const promise = source.getAsFileSystemHandle().then(handle => handle?.kind === 'directory' && handle.name === entry.name ? handle : null, () => null);
      folders.set(entry, promise);
    }
  }
  return { files: Array.from(transfer.files), entries, folders };
}

type FileHandle = { kind: 'file'; name: string; getFile(): Promise<File> };
export type FolderHandle = { kind: 'directory'; name: string; values(): AsyncIterable<FileHandle | FolderHandle> };

/** Every file in a folder chosen with the File System Access API, by its path from the folder. */
export async function readFolder(folder: FolderHandle): Promise<SelectedFile[]> {
  const found: { path: string; handle: FileHandle }[] = [];
  const visit = async (handle: FolderHandle, path: string): Promise<void> => {
    const folders: Promise<void>[] = [];
    for await (const entry of handle.values()) {
      if (entry.kind === 'file') found.push({ path: `${path}/${entry.name}`, handle: entry });
      else folders.push(visit(entry, `${path}/${entry.name}`));
    }
    await Promise.all(folders);
  };
  await visit(folder, folder.name);
  return Promise.all(found.map(async ({ path, handle }) => ({ path, file: await handle.getFile() })));
}



async function walk(root: FileSystemEntry): Promise<SelectedFile[]> {
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
  return Promise.all(found.map(({ path, entry }) => new Promise<{ path: string; file: File }>((resolve, reject) => entry.file(file => resolve({ path, file }), reject))));
}

export async function droppedFileGroups(files: File[], drop: CapturedDrop | null): Promise<SelectedFile[][]> {
  const same = drop && drop.files.length === files.length && drop.files.every((file, i) => file === files[i]);
  if (same && drop.entries.length) {
    // DataTransfer.files already holds the selected files in drag item order (HTML, dom-datatransfer-files).
    const looseFiles = drop.entries.length === files.length && drop.entries.every((entry, i) => entry.isFile && entry.name === files[i].name);
    if (!looseFiles) return Promise.all(drop.entries.map(async entry => {
      const handle = await drop.folders?.get(entry);
      if (!handle) return walk(entry);
      performance.mark('veacom:directory-handle');
      return readFolder(handle);
    }));
  }
  return files.map(file => [{ path: file.name, file }]);
}
