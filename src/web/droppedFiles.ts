export interface SelectedFile { path: string; file: File }
export interface CapturedDrop { files: File[]; entries: FileSystemEntry[] }

async function walk(root: FileSystemEntry): Promise<SelectedFile[]> {
  const found: SelectedFile[] = [];
  let nextFile = 0, stopped = false;
  const visit = async (entry: FileSystemEntry, path: string): Promise<void> => {
    if (entry.isFile) {
      const index = nextFile++;
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
      found[index] = { path, file };
      return;
    }
    if (!entry.isDirectory) return;
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    const nextPage = async (): Promise<void> => {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
      if (!batch.length || stopped) return;
      const children = batch.map(child => visit(child, `${path}/${child.name}`));
      await Promise.all([nextPage(), ...children]);
    };
    await nextPage();
  };
  try { await visit(root, root.name); return found; }
  finally { stopped = true; }
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
