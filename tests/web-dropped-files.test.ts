import assert from 'node:assert/strict';
import { it } from 'node:test';
import { droppedFileGroups, importFileSources, readImportFiles } from '../src/web/droppedFiles';
import { watchFileDrops } from '../src/web/fileDropCapture';

function fileEntry(file: File, read = () => file): FileSystemFileEntry {
  return { name: file.name, isFile: true, isDirectory: false, file: (send: FileCallback) => send(read()) } as FileSystemFileEntry;
}

function directory(name: string, pages: FileSystemEntry[][]): FileSystemDirectoryEntry {
  return { name, isFile: false, isDirectory: true, createReader: () => {
    let index = 0;
    return { readEntries: (send: FileSystemEntriesCallback) => send(pages[index++] ?? []) };
  } } as FileSystemDirectoryEntry;
}

it('hands each early drop to the mounted reader once and preserves the live drop after the handoff', () => {
  const target = new EventTarget(), drops = watchFileDrops(target as Document);
  const files = ['first', 'second'].map(data => new File([data], 'same.dcm'));
  const send = (type: string, types: string[], source: File[]) => {
    const transfer = { files: source, types, items: source.map(file => ({ webkitGetAsEntry: () => fileEntry(file) })), dropEffect: '' };
    const event = Object.assign(new Event(type, { cancelable: true }), { dataTransfer: transfer });
    target.dispatchEvent(event);
    return [event.defaultPrevented, transfer.dropEffect];
  };
  assert.deepEqual(send('dragenter', ['Files'], []), [true, 'copy']);
  assert.deepEqual(send('dragover', ['Files'], []), [true, 'copy']);
  assert.deepEqual(send('dragover', ['text/uri-list'], []), [true, 'none']);
  assert.deepEqual(send('drop', ['Files', 'application/x-veacom-series'], [files[0]]), [false, '']);
  for (const file of files) assert.deepEqual(send('drop', ['Files'], [file]), [true, '']);
  assert.deepEqual(drops.takePending().map(drop => drop.files[0]), files);
  assert.deepEqual(drops.takePending(), []);
  assert.equal(drops.takeLatest(), null);
  assert.deepEqual(send('dragenter', ['Files'], []), [false, '']);
  assert.deepEqual(send('dragover', ['Files'], []), [false, '']);
  assert.deepEqual(send('drop', ['Files'], [files[1]]), [false, '']);
  assert.equal(drops.takeLatest()?.files[0], files[1]);
  assert.equal(drops.takeLatest(), null);
});

it('uses the two original dropped files even when both names are the same', async () => {
  const files = [new File(['first source'], 'slice.dcm'), new File(['second source'], 'slice.dcm')];
  const entries = files.map(file => fileEntry(file, () => { throw new Error('File requested again'); }));
  const groups = await droppedFileGroups(files, { files: [...files], entries });
  assert.deepEqual(groups.map(group => group.map(item => item.path)), [['slice.dcm'], ['slice.dcm']]);
  assert('file' in groups[0][0] && groups[0][0].file === files[0]);
  assert('file' in groups[1][0] && groups[1][0].file === files[1]);
});

it('reads a dropped folder through every directory page and keeps its path beside a loose file', async () => {
  const one = new File(['1'], 'one'), two = new File(['2'], 'two'), loose = new File(['3'], 'three');
  const folder = directory('study', [[fileEntry(one)], [directory('series', [[fileEntry(two)]])]]);
  const files = [new File([], 'study'), loose];
  const groups = await droppedFileGroups(files, { files, entries: [folder, fileEntry(loose)] });
  assert.deepEqual(groups.map(group => group.map(item => item.path)), [['study/one', 'study/series/two'], ['three']]);
  const selected = await readImportFiles(importFileSources(groups.flat()));
  assert.deepEqual(await Promise.all(selected.files.map(item => item.file.text())), ['1', '2', '3']);
  assert.deepEqual(selected.heads.map(head => new TextDecoder().decode(head)), ['1', '2', '3']);
});

it('uses entries for a partial or differently named listing and ignores entries from a previous drop', async () => {
  const old = new File(['old'], 'image'), current = new File(['new'], 'image'), sibling = new File(['2'], 'sibling');
  const expected = [[{ path: 'image', file: old }]];
  const [[stale]] = await droppedFileGroups([current], { files: [old], entries: [fileEntry(old)] });
  assert('file' in stale && stale.file === current);
  assert.deepEqual(await droppedFileGroups([sibling], { files: [sibling], entries: [fileEntry(old)] }), expected);
  assert.deepEqual(await droppedFileGroups([old, sibling], { files: [old, sibling], entries: [fileEntry(old)] }), expected);
  assert.deepEqual(await droppedFileGroups([current], null), [[{ path: 'image', file: current }]]);
});

it('joins out-of-order directory batches to their original paths and bytes', async () => {
  const calls: FileCallback[] = [];
  const original = Array.from({ length: 35 }, (_, i) => new File([Uint8Array.of(i)], 'same.dcm'));
  const sources = original.map((_, i) => ({ path: `study/${i}/same.dcm`, entry: {
    file: (send: FileCallback) => { calls[i] = send; },
  } as FileSystemFileEntry }));
  const selected = readImportFiles(importFileSources(sources));
  for (const i of original.keys()) { const reversed = 34 - i; calls[reversed](original[reversed]); }
  const { files, heads } = await selected;
  assert.deepEqual(files.map(item => item.path), sources.map(item => item.path));
  assert.deepEqual(heads.map(head => head?.[0]), Array.from(original.keys()));
});

it('reads the first directory batch while the final file is still being acquired', { timeout: 5000 }, async t => {
  const file = new File(['a'], 'slice');
  const sources = Array.from({ length: 17 }, (_, i) => ({ path: String(i), entry: fileEntry(file) }));
  let release!: FileCallback;
  sources[16].entry = { file: (send: FileCallback) => { release = send; } } as FileSystemFileEntry;
  let didRead!: () => void;
  const firstRead = new Promise<void>(resolve => { didRead = resolve; });
  t.mock.method(Blob.prototype, 'arrayBuffer', function (this: Blob) {
    if (this.size === 16) didRead();
    return new Response(this.stream()).arrayBuffer();
  });
  const imported = readImportFiles(importFileSources(sources));
  await firstRead;
  release(new File(['z'], 'last'));
  const { heads } = await imported;
  assert.equal(new TextDecoder().decode(heads[16]), 'z');
});

it('rejects the entire import when a file in a later directory batch becomes unreadable', async () => {
  const file = new File(['synthetic'], 'slice');
  const sources = Array.from({ length: 17 }, (_, i) => ({ path: String(i), entry: fileEntry(file) }));
  sources[16].entry = { file: (_send: FileCallback, fail: ErrorCallback) => fail(new DOMException('Selection lost', 'NotReadableError')) } as FileSystemFileEntry;
  await assert.rejects(readImportFiles(importFileSources(sources)), /Selection lost/);
});

for (const count of [512, 767, 768]) {
  it(`registers ${count} sources in selection order with a delayed header group`, { timeout: 5000 }, async t => {
    const sources = Array.from({ length: count }, (_, i) => ({ path: String(i), file: new File([Uint8Array.of(i % 256)], 'slice') }));
    let release!: () => void, checked!: () => void, reads = 0;
    const delayed = new Promise<void>(resolve => { release = resolve; });
    const firstRead = new Promise<void>(resolve => { checked = resolve; });
    t.mock.method(Blob.prototype, 'arrayBuffer', async function (this: Blob) {
      const group = ++reads;
      if (group === 2) await delayed;
      const bytes = await new Response(this.stream()).arrayBuffer();
      if (group === 1) checked();
      return bytes;
    });
    const registered: [string, number | undefined][] = [];
    const imported = readImportFiles(sources, (source, head) => { registered.push([source.path, head?.[0]]); });
    try {
      await firstRead;
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(registered.length, count >= 768 ? 16 : 0);
    } finally { release(); }
    await imported;
    assert.deepEqual(registered, sources.map((source, i) => [source.path, i % 256]));
  });
}

it('propagates a directory reading error without returning a partial selection', async () => {
  const files = [new File([], 'study')];
  const denied = { name: 'study', isDirectory: true, createReader: () => ({
    readEntries: (_send: FileSystemEntriesCallback, fail: ErrorCallback) => fail(new DOMException('Permission lost', 'NotReadableError')),
  }) } as FileSystemDirectoryEntry;
  await assert.rejects(droppedFileGroups(files, { files, entries: [denied] }), { name: 'NotReadableError' });
});

it('bounds concurrent file acquisitions on large directory drops', async () => {
  let active = 0, peak = 0;
  const sources = Array.from({ length: 160 }, (_, i) => ({
    path: `study/${i}.dcm`,
    entry: {
      file: (send: FileCallback) => {
        active++;
        if (active > peak) peak = active;
        setImmediate(() => { active--; send(new File([Uint8Array.of(i % 251)], `${i}.dcm`)); });
      },
    } as FileSystemFileEntry,
  }));
  const { files, heads } = await readImportFiles(importFileSources(sources));
  assert.equal(files.length, 160);
  assert.equal(heads[159]?.[0], 159);
  assert(peak <= 64, `expected peak concurrent entry.file() calls <= 64, got ${peak}`);
});
