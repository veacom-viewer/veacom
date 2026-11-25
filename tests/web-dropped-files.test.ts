import assert from 'node:assert/strict';
import { it } from 'node:test';
import { droppedFileGroups } from '../src/web/droppedFiles';

function fileEntry(file: File, read = () => file): FileSystemFileEntry {
  return { name: file.name, isFile: true, isDirectory: false, file: (send: FileCallback) => send(read()) } as FileSystemFileEntry;
}

function directory(name: string, pages: FileSystemEntry[][]): FileSystemDirectoryEntry {
  return { name, isFile: false, isDirectory: true, createReader: () => {
    let index = 0;
    return { readEntries: (send: FileSystemEntriesCallback) => send(pages[index++] ?? []) };
  } } as FileSystemDirectoryEntry;
}

it('uses the two original dropped files even when both names are the same', async () => {
  const files = [new File(['first source'], 'slice.dcm'), new File(['second source'], 'slice.dcm')];
  const entries = files.map(file => fileEntry(file, () => { throw new Error('File requested again'); }));
  const groups = await droppedFileGroups(files, { files: [...files], entries });
  assert.deepEqual(groups.map(group => group.map(item => item.path)), [['slice.dcm'], ['slice.dcm']]);
  assert.equal(groups[0][0].file, files[0]);
  assert.equal(groups[1][0].file, files[1]);
});

it('reads a dropped folder through every directory page and keeps its path beside a loose file', async () => {
  const one = new File(['1'], 'one'), two = new File(['2'], 'two'), loose = new File(['3'], 'three');
  const folder = directory('study', [[fileEntry(one)], [directory('series', [[fileEntry(two)]])]]);
  const files = [new File([], 'study'), loose];
  const groups = await droppedFileGroups(files, { files, entries: [folder, fileEntry(loose)] });
  assert.deepEqual(groups, [[{ path: 'study/one', file: one }, { path: 'study/series/two', file: two }], [{ path: 'three', file: loose }]]);
});

it('uses entries for a partial or differently named listing and ignores entries from a previous drop', async () => {
  const old = new File(['old'], 'image'), current = new File(['new'], 'image'), sibling = new File(['2'], 'sibling');
  const expected = [[{ path: 'image', file: old }]];
  assert.equal((await droppedFileGroups([current], { files: [old], entries: [fileEntry(old)] }))[0][0].file, current);
  assert.deepEqual(await droppedFileGroups([sibling], { files: [sibling], entries: [fileEntry(old)] }), expected);
  assert.deepEqual(await droppedFileGroups([old, sibling], { files: [old, sibling], entries: [fileEntry(old)] }), expected);
  assert.deepEqual(await droppedFileGroups([current], null), [[{ path: 'image', file: current }]]);
});

it('propagates a directory reading error without returning a partial selection', async () => {
  const files = [new File([], 'study')];
  const denied = { name: 'study', isDirectory: true, createReader: () => ({
    readEntries: (_send: FileSystemEntriesCallback, fail: ErrorCallback) => fail(new DOMException('Permission lost', 'NotReadableError')),
  }) } as FileSystemDirectoryEntry;
  await assert.rejects(droppedFileGroups(files, { files, entries: [denied] }), { name: 'NotReadableError' });
});
