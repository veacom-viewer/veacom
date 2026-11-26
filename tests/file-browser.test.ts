import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
const require = createRequire(import.meta.url);
const { browse, chosenPaths, driveTypes, listedDrives, localPath, readyDiscs } = require('../electron/file-browser.cjs');

const windows = (value: string, places: string[] = []) => localPath(value, { places, paths: path.win32, platform: 'win32' });
const mac = (value: string) => localPath(value, { platform: 'darwin', paths: path.posix });

describe('import window paths', () => {
  it('takes local absolute paths, resolved', () => {
    assert.equal(windows('C:\\Studies\\..\\CD'), 'C:\\CD');
    assert.equal(windows('d:/DICOM'), 'd:\\DICOM');
    assert.equal(mac('/Volumes/CD/../CD/DICOM'), '/Volumes/CD/DICOM');
    assert.equal(mac('/Users/ayse/network'), '/Users/ayse/network');
  });

  it('refuses relative paths and other values', () => {
    for (const value of ['DICOM', 'C:DICOM', '', 42, null]) assert.throws(() => windows(value as string), { message: /Invalid folder\./ });
    assert.throws(() => mac('DICOM'), { message: /Invalid folder\./ });
  });

  it('refuses network shares and device paths, which would connect to the host they name', () => {
    for (const value of ['\\\\attacker\\share', '//attacker/share', '\\\\attacker\\share\\..\\..\\x', '\\\\?\\C:\\Studies', '\\\\?\\UNC\\attacker\\share', '\\\\.\\PhysicalDrive0', '//./pipe/x']) {
      assert.throws(() => windows(value), { message: /Invalid folder\./ }, value);
    }
    for (const value of ['/net/attacker', '/net/attacker/export', '/net', '/NET/attacker', '/Net/attacker']) assert.throws(() => mac(value), { message: /Invalid folder\./ }, value);
  });

  it('takes a network folder inside a usual place, as Windows keeps them for redirected folders', () => {
    const documents = '\\\\files\\home$\\ayse\\Documents';
    assert.equal(windows('\\\\FILES\\home$\\ayse\\documents\\CD', [documents]), '\\\\FILES\\home$\\ayse\\documents\\CD');
    assert.equal(windows(documents, [documents]), documents);
    assert.equal(windows(`${documents}\\..x`, [documents]), `${documents}\\..x`);
    for (const value of ['\\\\files\\home$\\ayse', `${documents}\\..\\Private`, '\\\\attacker\\home$\\ayse\\Documents']) {
      assert.throws(() => windows(value, [documents]), { message: /Invalid folder\./ }, value);
    }
    assert.throws(() => windows('\\\\?\\UNC\\files\\home$\\ayse\\Documents', [documents]), { message: /Invalid folder\./ });
  });

  it('lists a folder\'s folders and its archives, RAR on Windows alone, and counts its other files', async () => {
    const folder = await realpath(await mkdtemp(path.join(tmpdir(), 'veacom-browse-test-')));
    try {
      await mkdir(path.join(folder, 'study'));
      for (const name of ['b.ZIP', 'a.rar', 'notes.txt', 'IM0001', '.hidden.zip']) await writeFile(path.join(folder, name), '');
      const listed = await browse(folder);
      // The engine opens a RAR archive on Windows; elsewhere it is one more file.
      const rar = process.platform === 'win32';
      assert.deepEqual(listed.items.map((item: { name: string; kind: string }) => [item.name, item.kind]), [['study', 'folder'], ...(rar ? [['a.rar', 'archive']] : []), ['b.ZIP', 'archive']]);
      assert.equal(listed.files, rar ? 2 : 3);
    } finally { await rm(folder, { recursive: true, force: true }); }
  });

  it('tells the page that RAR archives open on Windows alone', () => {
    const preload = readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');
    for (const platform of ['win32', 'darwin', 'linux']) {
      let bridge!: { features: { rarImport: boolean } };
      runInNewContext(preload, {
        process: { argv: [], platform },
        require: () => ({ contextBridge: { exposeInMainWorld: (_name: string, api: typeof bridge) => { bridge = api; } } }),
      });
      assert.equal(bridge.features.rarImport, platform === 'win32', platform);
    }
  });

  it('lists no network folder', async () => {
    const network = process.platform === 'win32' ? '\\\\127.0.0.1\\share' : process.platform === 'darwin' ? '/NET/127.0.0.1' : 'share';
    await assert.rejects(browse(network), { message: /Invalid folder\./ });
  });

  it('opens up to 4096 local paths, resolved and without repeats', () => {
    const study = path.resolve('/studies/ct'), other = path.resolve('/studies/mr');
    assert.deepEqual(chosenPaths([study, `${other}/../mr`, study]), [study, other]);
    const network = process.platform === 'win32' ? '\\\\attacker\\share' : process.platform === 'darwin' ? '/net/attacker' : 'relative';
    for (const paths of [[], 'C:\\', [study, network], [study, 'relative'], Array(4097).fill(study)]) assert.throws(() => chosenPaths(paths as string[]), { message: /^Invalid / });
  });
});

describe('import window drives', () => {
  /** An engine whose connection answers every request with `answer`, noting what it was asked in `seen`. */
  const engine = (answer: unknown, seen: unknown[] = []) => ({
    connection: () => ({ request: async (op: string, body: unknown) => { seen.push([op, body]); return answer instanceof Response ? answer : Response.json(answer); } }),
  });

  it('asks the engine for the kinds, and for the names of the drives that answer', async () => {
    const seen: unknown[] = [];
    const types = await driveTypes(engine({ drives: [{ letter: 'C', kind: 'fixed', label: 'Windows' }, { letter: 'E', kind: 'disc', label: '' }] }, seen), ['C']);
    assert.deepEqual(seen, [['drives', { answering: ['C'] }]]);
    assert.deepEqual(types, { C: { kind: 'fixed', label: 'Windows' }, E: { kind: 'disc', label: '' } });
  });

  it('takes from the engine only what a drive can be', async () => {
    const types = await driveTypes(engine({ drives: [
      { letter: 'CD', kind: 'fixed', label: 'x' }, { letter: 'c', kind: 'fixed', label: 'x' }, { letter: 7, kind: 'fixed' }, null,
      { letter: 'D', kind: 'tape', label: 'x' }, { letter: 'F', kind: 'network', label: 42 }, { letter: 'G', kind: 'removable', label: 'N'.repeat(300) },
    ] }), []);
    assert.deepEqual(types, { F: { kind: 'network', label: '' }, G: { kind: 'removable', label: 'N'.repeat(261) } });
  });

  it('lists the drives by their letters alone when the engine does not answer', async () => {
    const stopped = { connection: () => { throw new Error('The imaging engine is not ready.'); } };
    for (const silent of [engine(new Response('busy', { status: 503 })), engine({ drives: 'none' }), engine({}), stopped]) {
      assert.deepEqual(await driveTypes(silent, ['C']), {});
    }
    assert.deepEqual(listedDrives(['C'], {}), [{ path: 'C:\\', label: 'C:', kind: 'fixed', ready: true }]);
  });

  it('lists each drive that answers, and a disc drive with no disc in it', () => {
    const types = { C: { kind: 'fixed', label: 'Windows' }, E: { kind: 'disc', label: '' }, F: { kind: 'disc', label: 'CT 2026' }, Z: { kind: 'network', label: 'Arşiv' } };
    assert.deepEqual(listedDrives(['C', 'F', 'H'], types), [
      { path: 'C:\\', label: 'Windows (C:)', kind: 'fixed', ready: true },
      { path: 'E:\\', label: 'E:', kind: 'disc', ready: false },
      { path: 'F:\\', label: 'CT 2026 (F:)', kind: 'disc', ready: true },
      { path: 'H:\\', label: 'H:', kind: 'fixed', ready: true },
    ]);
  });

  it('finds the disc drives that hold a disc, waiting on each and on no other drive', async () => {
    const drives = [{ letter: 'C', kind: 'fixed', label: '' }, ...['D', 'E', 'F'].map(letter => ({ letter, kind: 'disc', label: '' }))];
    const asked: string[] = [];
    // D holds a disc, E is empty and says so, F never answers.
    const reach = (root: string) => {
      asked.push(root);
      return root === 'D:\\' ? Promise.resolve() : root === 'E:\\' ? Promise.reject(new Error('not ready')) : new Promise<void>(() => {});
    };
    const started = performance.now();
    assert.deepEqual(await readyDiscs(engine({ drives }), { platform: 'win32', reach, wait: 60 }), ['D:\\']);
    assert.deepEqual(asked, ['D:\\', 'E:\\', 'F:\\']);
    assert.ok(performance.now() - started < 2000, 'the drive that never answers is waited for only as long as asked');
    assert.deepEqual(await readyDiscs(engine({ drives: [drives[0]] }), { platform: 'win32', reach }), []);
  });

  it('does not say which drives hold a disc where that is not known', async () => {
    const stopped = { connection: () => { throw new Error('The imaging engine is not ready.'); } };
    assert.equal(await readyDiscs(stopped, { platform: 'win32' }), null);
    const disc = engine({ drives: [{ letter: 'D', kind: 'disc', label: '' }] });
    for (const platform of ['darwin', 'linux']) assert.equal(await readyDiscs(disc, { platform, reach: () => Promise.resolve() }), null);
  });
});
