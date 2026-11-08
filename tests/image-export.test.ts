import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { registerImageExport } = require('../electron/image-export.cjs');
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
    const { parent, call, recorded, exports } = await fixture();
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
