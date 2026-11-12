import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { registerImageExport } = require('../electron/image-export.cjs');
// The module's own fs/promises object, so a test can make one write fail.
const files = require('node:fs/promises') as typeof import('node:fs/promises');
const folders: string[] = [];
const picture = new Uint8Array([137, 80, 78, 71]).buffer;

async function fixture() {
  const parent = await mkdtemp(path.join(tmpdir(), 'veacom-pictures-test-'));
  folders.push(parent);
  const handlers = new Map<string, (...args: any[]) => Promise<any>>();
  const recorded: string[] = [];
  const exports = registerImageExport({
    handle: (channel: string, handler: (...args: any[]) => Promise<any>) => handlers.set(channel, handler),
    dialog: {}, getWindow: () => null, t: (key: string) => key,
    exportFolder: { folder: async () => parent }, recordExport: (target: string) => recorded.push(target),
  });
  return { parent, handlers, recorded, exports, call: (channel: string, ...args: unknown[]) => handlers.get(channel)!(...args) };
}

afterEach(async () => { await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true }))); });

describe('picture export', () => {
  it('takes away a cancelled export\'s pictures and folder, so no folder named after the series looks complete', async () => {
    const { parent, call, recorded } = await fixture();
    const job = await call('images:begin', 'SYNTHETIC - CT Head', true);
    await call('images:append', job.id, '001.png', picture);
    await call('images:append', job.id, '002.png', picture);
    await call('images:cancel', job.id);
    assert.deepEqual(await readdir(parent), []);
    assert.deepEqual(recorded, []);
    // The next export of the same series gets the plain name again.
    const next = await call('images:begin', 'SYNTHETIC - CT Head', true);
    assert.equal(next.directory, path.join(parent, 'SYNTHETIC - CT Head'));
  });

  it('keeps a finished export and records it, and never removes files it did not write', async () => {
    const { call, recorded, exports } = await fixture();
    const done = await call('images:begin', 'SYNTHETIC - CT', true);
    await call('images:append', done.id, '001.png', picture);
    assert.equal(await call('images:finish', done.id), done.directory);
    assert.deepEqual(recorded, [done.directory]);

    const open = await call('images:begin', 'SYNTHETIC - MR', true);
    await call('images:append', open.id, '001.png', picture);
    await writeFile(path.join(open.directory, 'notes.txt'), 'the user\'s own file');
    await exports.reset(); // the page crashed
    assert.deepEqual(await readdir(open.directory), ['notes.txt']);
    assert.deepEqual(await readdir(done.directory), ['001.png']);
    await assert.rejects(call('images:append', open.id, '002.png', picture), { message: /Unknown picture export/ });
  });

  it('writes only the bytes of a typed array, not the rest of the buffer it views', async () => {
    const { call } = await fixture();
    const job = await call('images:begin', 'SYNTHETIC - CT', true);
    const backing = new Uint8Array([9, 9, 137, 80, 78, 71, 9]);
    await call('images:append', job.id, '001.png', backing.subarray(2, 6));
    assert.deepEqual([...await readFile(path.join(job.directory, '001.png'))], [137, 80, 78, 71]);
  });

  it('reports a cancelled export, not the file error, when the cancel removes the folder under a write', async () => {
    const { parent, call } = await fixture();
    const job = await call('images:begin', 'SYNTHETIC - CT', true);
    const original = files.writeFile;
    files.writeFile = async () => {
      await call('images:cancel', job.id);
      throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
    };
    try {
      await assert.rejects(call('images:append', job.id, '001.png', picture), { message: /Unknown picture export/ });
    } finally { files.writeFile = original; }
    assert.deepEqual(await readdir(parent), []);
    // While the export is still open, a failed write is the error the caller sees.
    const open = await call('images:begin', 'SYNTHETIC - MR', true);
    files.writeFile = async () => { throw new Error('Disk full'); };
    try {
      await assert.rejects(call('images:append', open.id, '001.png', picture), { message: 'Disk full' });
    } finally { files.writeFile = original; }
  });

  it('removes a picture whose export was cancelled while it was being written', async () => {
    const { parent, call } = await fixture();
    const job = await call('images:begin', 'SYNTHETIC - CT', true);
    // The assertion is attached before anything else is awaited: the append can be refused while the cancel still
    // removes files, and a rejection nobody handles yet fails the run.
    const refused = assert.rejects(call('images:append', job.id, '001.png', picture), { message: /Unknown picture export/ });
    await call('images:cancel', job.id);
    await refused;
    assert.deepEqual(await readdir(parent), []);
    await mkdir(path.join(parent, 'unrelated'));
    assert.deepEqual(await readdir(parent), ['unrelated']);
  });
});
