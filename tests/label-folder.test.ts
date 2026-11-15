import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { createLabelFolder as createWebLabelFolder, isDicom, listFilms as listWebFilms, PLAN_SUFFIX, type FileEntry, type FolderEntry } from '../src/web/labelFolder';
import { filmSides, labelQueue, planState, sidesFor } from '../src/ui/labelQueue';
import type { LabelFolder } from '../src/model';

const require = createRequire(import.meta.url);
const { createLabelFolder, listFilms } = require('../electron/label-folder.cjs');
const directories: string[] = [];
afterEach(async () => { labelQueue.stop(); await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

/** A file that starts as a DICOM Part 10 file does: 128 bytes of preamble, then "DICM". */
const dicom = (marker = 'DICM') => new Uint8Array(Buffer.concat([Buffer.alloc(128), Buffer.from(marker), Buffer.from('rest')]));
const plan = (shown: boolean) => JSON.stringify({ schema: 'veacom.deformity-plan', version: 1, plans: [{ side: 'R', landmarks: [{ name: 'kneeCentre', suggestionShown: shown }] }] });
const t = (key: string, params?: Record<string, string>) => params ? `${key} ${JSON.stringify(params)}` : key;

describe('a folder to label, on the desktop', () => {
  async function folder() {
    const root = await mkdtemp(path.join(tmpdir(), 'veacom-label-test-'));
    directories.push(root);
    await writeFile(path.join(root, 'film 10.dcm'), 'no preamble, but named .dcm');
    await writeFile(path.join(root, 'film 2'), dicom());
    await writeFile(path.join(root, 'film 2' + PLAN_SUFFIX), plan(true));
    await writeFile(path.join(root, 'notes.txt'), dicom('NOPE'));
    await writeFile(path.join(root, '.hidden.dcm'), dicom());
    await writeFile(path.join(root, 'short'), 'DICM');
    await writeFile(path.join(root, 'big.dcm'), dicom());
    await writeFile(path.join(root, 'big.dcm' + PLAN_SUFFIX), Buffer.alloc(2_000_001, 32));
    await mkdir(path.join(root, 'inside'));
    await writeFile(path.join(root, 'inside', 'film 3.dcm'), dicom());
    const authorized: string[][] = [];
    const dialog = { showOpenDialog: async () => ({ canceled: false, filePaths: [root] }) };
    const labels = createLabelFolder({ dialog, getWindow: () => null, authorize: async (paths: string[]) => { authorized.push(paths); return ['import:1']; }, t });
    return { root, labels, authorized };
  }

  it('lists the DICOM files directly inside the folder, numbered as a person would, with each one\'s plan file', async () => {
    const { root } = await folder();
    const films = await listFilms(root);
    assert.deepEqual(films.map((film: { name: string }) => film.name), ['big.dcm', 'film 2', 'film 10.dcm']);
    assert.deepEqual(films.map((film: { plan: unknown }) => film.plan), [{ unreadable: true }, { text: plan(true) }, null]);
  });

  it('gives the page a token, the folder\'s name and the films, and imports a film only by its place in the list', async () => {
    const { root, labels, authorized } = await folder();
    const opened = await labels.open();
    assert.equal(opened.folder, path.basename(root));
    assert.equal(opened.writes, 'beside');
    assert.match(opened.token, /^label:[0-9a-f-]{36}$/);
    assert.deepEqual(opened.films, [{ name: 'big.dcm', plan: null, unreadable: true }, { name: 'film 2', plan: plan(true) }, { name: 'film 10.dcm', plan: null }]);
    assert.deepEqual(await labels.film(opened.token, 2), ['import:1']);
    assert.deepEqual(authorized, [[path.join(root, 'film 10.dcm')]]);
    for (const [token, index] of [['label:other', 0], [opened.token, 3], [opened.token, -1], [opened.token, 1.5], [opened.token, '0']]) {
      assert.throws(() => labels.film(token, index), /label\.expired/);
    }
    const cancelled = createLabelFolder({ dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }, getWindow: () => null, authorize: async () => [], t });
    assert.equal(await cancelled.open(), null);
  });

  it('writes a plan beside its film, only a plan, and only over the plan file the page was given', async () => {
    const { root, labels } = await folder();
    const { token } = await labels.open();
    for (const text of ['{', JSON.stringify({ schema: 'other', version: 1 }), JSON.stringify({ schema: 'veacom.deformity-plan' }), 42, `"${'x'.repeat(2_000_001)}"`]) {
      await assert.rejects(labels.write(token, 2, text), /label\.invalidPlan/);
    }
    assert.equal(await labels.write(token, 2, plan(false)), 'film 10.dcm' + PLAN_SUFFIX);
    assert.equal(await readFile(path.join(root, 'film 10.dcm' + PLAN_SUFFIX), 'utf8'), plan(false));
    // Written again over its own plan; over a plan changed outside VEAcom, or over a file that is not a plan, refused.
    assert.equal(await labels.write(token, 2, plan(true)), 'film 10.dcm' + PLAN_SUFFIX);
    const other = JSON.stringify({ schema: 'veacom.deformity-plan', version: 1, plans: [] });
    await writeFile(path.join(root, 'film 10.dcm' + PLAN_SUFFIX), other);
    await assert.rejects(labels.write(token, 2, plan(false)), /label\.planChanged/);
    await writeFile(path.join(root, 'film 10.dcm' + PLAN_SUFFIX), 'someone else\'s');
    await assert.rejects(labels.write(token, 2, plan(false)), /label\.notAPlan/);
    assert.equal(await readFile(path.join(root, 'film 10.dcm' + PLAN_SUFFIX), 'utf8'), 'someone else\'s');
    // A plan file too large to read is never replaced; the one given is replaced.
    await assert.rejects(labels.write(token, 0, plan(false)), /label\.notAPlan/);
    assert.equal(await labels.write(token, 1, plan(false)), 'film 2' + PLAN_SUFFIX);
    assert.ok(!(await readdir(root)).some(name => name.endsWith('.part')), 'No partial file is left.');
  });
});

/** A folder handle of the File System Access API, in memory. */
function memoryFolder(name: string, files: Record<string, BlobPart>): FolderEntry & { files: Map<string, BlobPart> } {
  const store = new Map(Object.entries(files));
  const entry = (file: string): FileEntry => ({ kind: 'file', name: file, getFile: async () => new File([store.get(file)!], file),
    createWritable: async () => { let text = ''; return { write: async (data: string) => { text += data; }, close: async () => { store.set(file, text); } }; } });
  const inside: FolderEntry = { kind: 'directory', name: 'inside', values: async function* () { /* empty */ }, getFileHandle: () => Promise.reject(new Error('empty')), removeEntry: async () => {} };
  return { kind: 'directory', name, files: store,
    async *values() { for (const file of store.keys()) yield entry(file); yield inside; },
    removeEntry: async (file: string) => { store.delete(file); },
    getFileHandle: async (file: string, options?: { create?: boolean }) => {
      if (!store.has(file) && !options?.create) throw Object.assign(new Error('not found'), { name: 'NotFoundError' });
      if (!store.has(file)) store.set(file, '');
      return entry(file);
    } };
}
const refused = { invalid: () => 'invalid', changed: () => 'changed', notAPlan: () => 'not a plan', expired: () => 'expired' };

describe('a folder to label, in the browser', () => {
  it('reads DICOM by its preamble or a .dcm name, in a person\'s order, with the plan files beside them', async () => {
    assert.equal(await isDicom(new File([dicom()], 'IM0001')), true);
    assert.equal(await isDicom(new File(['x'], 'film.DCM')), true);
    assert.equal(await isDicom(new File([dicom('NOPE')], 'notes.txt')), false);
    assert.equal(await isDicom(new File(['DICM'], 'short')), false);
    const files = new Map([['film 10.dcm', new File(['a'], 'film 10.dcm')], ['film 2.dcm', new File(['b'], 'film 2.dcm')], ['.dot.dcm', new File(['c'], '.dot.dcm')],
      ['film 2.dcm' + PLAN_SUFFIX, new File([plan(false)], 'p')], ['film 10.dcm' + PLAN_SUFFIX, new File([new Uint8Array(2_000_001)], 'q')]]);
    const films = await listWebFilms(files);
    assert.deepEqual(films.map(film => [film.name, film.plan, film.unreadable]), [['film 2.dcm', plan(false), undefined], ['film 10.dcm', null, true]]);
  });

  it('writes beside the film where the browser lets it, never over a plan file changed since it was read', async () => {
    const folder = memoryFolder('legs', { 'b.dcm': dicom(), 'a.dcm': 'named', ['a.dcm' + PLAN_SUFFIX]: plan(true) });
    const imported: File[] = [], downloads: string[] = [];
    const labels = createWebLabelFolder({ pick: async () => folder, chooseFiles: async () => [], importFile: async file => { imported.push(file); return ['import:x']; },
      download: name => downloads.push(name), refused });
    const opened = (await labels.open())!;
    assert.deepEqual([opened.folder, opened.writes, opened.films], ['legs', 'beside', [{ name: 'a.dcm', plan: plan(true) }, { name: 'b.dcm', plan: null }]]);
    assert.deepEqual(await labels.film(opened.token, 1), ['import:x']);
    assert.equal(imported[0].name, 'b.dcm');
    assert.equal(await labels.write(opened.token, 1, plan(false)), 'b.dcm' + PLAN_SUFFIX);
    assert.equal(folder.files.get('b.dcm' + PLAN_SUFFIX), plan(false));
    assert.equal(await labels.write(opened.token, 0, plan(false)), 'a.dcm' + PLAN_SUFFIX);
    folder.files.set('a.dcm' + PLAN_SUFFIX, JSON.stringify({ schema: 'veacom.deformity-plan', version: 1, plans: [] }));
    await assert.rejects(labels.write(opened.token, 0, plan(true)), /^Error: changed$/);
    folder.files.set('a.dcm' + PLAN_SUFFIX, 'edited elsewhere');
    await assert.rejects(labels.write(opened.token, 0, plan(true)), /not a plan/);
    await assert.rejects(labels.write(opened.token, 1, '{"schema":"veacom.deformity-plan"}'), /invalid/);
    // A write that fails takes away the file it made, so the film is not left with an empty plan file.
    const base = memoryFolder('legs', { 'c.dcm': dicom() });
    const failing = { ...base, getFileHandle: async (file: string, options?: { create?: boolean }) => ({ ...(await base.getFileHandle(file, options)), createWritable: () => Promise.reject(new Error('disk full')) }) };
    const broken = createWebLabelFolder({ pick: async () => failing, chooseFiles: async () => [], importFile: async () => [], download: () => {}, refused });
    const brokenFolder = (await broken.open())!;
    await assert.rejects(broken.write(brokenFolder.token, 0, plan(false)), /disk full/);
    assert.deepEqual([...failing.files.keys()], ['c.dcm']);
    await assert.rejects(labels.write('label:none', 0, plan(true)), /expired/);
    assert.deepEqual(downloads, []);
    const cancelled = createWebLabelFolder({ pick: () => Promise.reject(Object.assign(new Error('no'), { name: 'AbortError' })), chooseFiles: async () => [], importFile: async () => [], download: () => {}, refused });
    assert.equal(await cancelled.open(), null);
  });

  it('reads the folder\'s own files through a folder input where it cannot write, and downloads each plan', async () => {
    const at = (relative: string, content: BlobPart) => Object.defineProperty(new File([content], relative.split('/').pop()!), 'webkitRelativePath', { value: relative });
    const downloads: Array<[string, string]> = [];
    const labels = createWebLabelFolder({ chooseFiles: async () => [at('legs/a.dcm', 'x'), at('legs/inside/c.dcm', 'y'), at('legs/a.dcm' + PLAN_SUFFIX, plan(false))],
      importFile: async () => ['import:y'], download: (name, text) => downloads.push([name, text]), refused });
    const opened = (await labels.open())!;
    assert.deepEqual([opened.folder, opened.writes, opened.films], ['legs', 'download', [{ name: 'a.dcm', plan: plan(false) }]]);
    assert.equal(await labels.write(opened.token, 0, plan(true)), 'a.dcm' + PLAN_SUFFIX);
    assert.deepEqual(downloads, [['a.dcm' + PLAN_SUFFIX, plan(true)]]);
    assert.equal(await createWebLabelFolder({ chooseFiles: async () => [], importFile: async () => [], download: () => {}, refused }).open(), null);
  });
});

describe('the labelling queue', () => {
  const folder: LabelFolder = { token: 'label:1', folder: 'legs', writes: 'beside', films: [{ name: 'a.dcm', plan: null }, { name: 'b.dcm', plan: plan(true) }] };

  it('names each film\'s plan file by what it holds', () => {
    assert.equal(planState({ name: 'a', plan: null }), 'none');
    assert.equal(planState({ name: 'a', plan: plan(false) }), 'saved');
    assert.equal(planState({ name: 'a', plan: plan(true) }), 'shown');
    assert.equal(planState({ name: 'a', plan: JSON.stringify({ schema: 'veacom.deformity-plan', version: 1, plans: [{ side: 'R', landmarks: [] }] }) }), 'empty');
    for (const text of ['{', '[]', JSON.stringify({ schema: 'other', plans: [] }), JSON.stringify({ schema: 'veacom.deformity-plan', version: 1, plans: {} }),
      JSON.stringify({ schema: 'veacom.deformity-plan', version: 2, plans: [] })]) assert.equal(planState({ name: 'a', plan: text }), 'unreadable', text);
    assert.equal(planState({ name: 'a', plan: null, unreadable: true }), 'unreadable');
  });

  it('plans the run\'s legs among those a film shows', () => {
    assert.deepEqual(filmSides('R'), ['R']); assert.deepEqual(filmSides('B'), ['R', 'L']); assert.deepEqual(filmSides(undefined), ['R', 'L']);
    assert.deepEqual(sidesFor(['R'], 'B'), ['R']);
    assert.deepEqual(sidesFor(['R', 'L'], 'L'), ['L']);
    assert.deepEqual(sidesFor(['R'], 'L'), ['R'], 'A film showing none of the run\'s legs gets the run\'s.');
  });

  it('waits for one film or write at a time, and keeps the settings from run to run', () => {
    assert.equal(labelQueue.begin(), false, 'No folder, nothing to wait for.');
    labelQueue.start(folder);
    assert.equal(labelQueue.begin(), true);
    assert.equal(labelQueue.begin(), false, 'A second press while the first runs is refused.');
    labelQueue.end('done');
    assert.deepEqual([labelQueue.get().busy, labelQueue.get().status], [false, 'done']);
    labelQueue.shown(1, ['series-b']);
    labelQueue.loaded(0, 'stale');
    assert.equal(labelQueue.get().loaded, null, 'A film no longer shown is not marked loaded.');
    labelQueue.loaded(1, 'it belongs to another film');
    assert.deepEqual(labelQueue.get().loaded, { index: 1, refused: 'it belongs to another film' });
    // A series opened for one film shares it when a later film opens into it again; the same film coming back does not.
    assert.equal(labelQueue.shares(0, ['series-b']), true);
    assert.equal(labelQueue.shares(1, ['series-b']), false);
    labelQueue.hold(1, 'planned while read');
    labelQueue.shown(0, ['series-a']); labelQueue.shown(1, ['series-b']);
    assert.deepEqual([labelQueue.get().loaded, labelQueue.get().held[1]], [null, 'planned while read'], 'Held for the run, to refuse again on the next visit.');
    labelQueue.saved(0, plan(false));
    assert.equal(planState(labelQueue.get().folder!.films[0]), 'saved');
    labelQueue.setSuggestions(false); labelQueue.setSides(['L']); labelQueue.setSides([]);
    labelQueue.stop();
    assert.deepEqual([labelQueue.get().folder, labelQueue.get().suggestions, labelQueue.get().sides], [null, false, ['L']]);
    labelQueue.setSuggestions(true); labelQueue.setSides(['R', 'L']);
  });
});
