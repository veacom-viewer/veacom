export interface SelectedFile { path: string; file: File }
export interface CapturedDrop { files: File[]; entries: FileSystemEntry[] }

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
  performance.mark('veacom:directory-start');
  await visit(root, root.name);
  performance.mark('veacom:directory-entries');
  return Promise.all(found.map(({ path, entry }) => new Promise<{ path: string; file: File }>((resolve, reject) => entry.file(file => resolve({ path, file }), reject))));
}

export async function droppedFileGroups(files: File[], drop: CapturedDrop | null): Promise<SelectedFile[][]> {
  const same = drop && drop.files.length === files.length && drop.files.every((file, i) => file === files[i]);
  if (same && drop.entries.length) {
    // DataTransfer.files already holds the selected files in drag item order (HTML, dom-datatransfer-files).
    const looseFiles = drop.entries.length === files.length && drop.entries.every((entry, i) => entry.isFile && entry.name === files[i].name);
    if (!looseFiles) return Promise.all(drop.entries.map(walk));
  }
  return files.map(file => [{ path: file.name, file }]);
}
