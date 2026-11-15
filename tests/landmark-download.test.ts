import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import manifest from '../electron/landmark-model.json';
import { landmarkModel } from '../src/web/landmarkModel';

const require = createRequire(import.meta.url);
const { createLandmarkModel } = require('../electron/landmark-model.cjs');
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

/** Synthetic bytes standing for a graph, with a manifest entry made for them. */
function graph(size = 4096) {
  const bytes = Buffer.from(Array.from({ length: size }, (_, i) => (i * 31 + 7) % 256));
  return { bytes, entry: { file: 'synthetic.onnx', bytes: size, sha256: createHash('sha256').update(bytes).digest('hex') } };
}

describe('the model\'s graphs on the desktop', () => {
  async function setup(served: Buffer, entry = graph().entry) {
    const userData = await mkdtemp(path.join(tmpdir(), 'veacom-model-test-'));
    directories.push(userData);
    const files = { ...manifest, files: { ...manifest.files, stageA: entry } };
    const cdn = 'https://release-assets.githubusercontent.com/synthetic';
    const fetchImpl = mock.fn(async (url: string) => url.startsWith('https://github.com/')
      ? new Response(null, { status: 302, headers: { location: cdn } }) : new Response(new Uint8Array(served)));
    const progress: number[] = [];
    const model = createLandmarkModel({ userData, fetchImpl, manifest: files, notify: (_part: string, received: number) => progress.push(received) });
    return { model, fetchImpl, userData, progress };
  }

  it('downloads from the release, checks the hash, keeps the file and uses it the next time', async () => {
    const { bytes, entry } = graph();
    const { model, fetchImpl, userData, progress } = await setup(bytes, entry);
    assert.deepEqual(Buffer.from(await model.get('stageA')), bytes);
    assert.equal(fetchImpl.mock.calls[0].arguments[0], manifest.release + entry.file);
    assert.equal(progress.at(-1), bytes.length);
    assert.deepEqual(await readdir(path.join(userData, 'landmark-model')), [`${entry.sha256}.onnx`]);
    assert.deepEqual(Buffer.from(await model.get('stageA')), bytes);
    assert.equal(fetchImpl.mock.callCount(), 2, 'The kept file needs no download.');
  });

  it('refuses a file that does not match, keeps nothing, and asks only for its own two files', async () => {
    const { entry } = graph(), wrong = Buffer.from(graph().bytes).fill(1);
    const { model, userData } = await setup(wrong, entry);
    await assert.rejects(model.get('stageA'), /checksum/);
    await assert.rejects(readdir(path.join(userData, 'landmark-model')));
    await assert.rejects(model.get('../../secrets'), /Unknown model file/);
    await assert.rejects(model.get('toString'), /Unknown model file/);
  });

  it('downloads again when the kept file was changed', async () => {
    const { bytes, entry } = graph();
    const { model, fetchImpl, userData } = await setup(bytes, entry);
    await model.get('stageA');
    const kept = path.join(userData, 'landmark-model', `${entry.sha256}.onnx`);
    await writeFile(kept, Buffer.alloc(entry.bytes));
    assert.deepEqual(Buffer.from(await model.get('stageA')), bytes);
    assert.deepEqual(await readFile(kept), bytes);
    assert.equal(fetchImpl.mock.callCount(), 4);
  });
});

describe('the model\'s graphs in the browser', () => {
  /** A Cache Storage holding requests by URL. */
  function storage() {
    const entries = new Map<string, Response>();
    const cache = {
      keys: async () => [...entries.keys()].map(url => new Request(url)),
      match: async (url: string) => entries.get(url)?.clone(),
      put: async (url: string, response: Response) => { entries.set(url, response); },
      delete: async (request: string | Request) => entries.delete(typeof request === 'string' ? request : request.url),
    };
    return { entries, store: { open: async () => cache } as unknown as CacheStorage };
  }

  it('fetches from the site with the hash as its integrity, keeps it, and drops an earlier model\'s files', async () => {
    const { bytes, entry } = graph(), original = { ...manifest.files.stageB };
    Object.assign(manifest.files.stageB, entry);
    try {
      const { entries, store } = storage();
      entries.set('https://viewer.example/models/old-model.onnx', new Response('old'));
      const fetchImpl = mock.fn(async (_url: string, _init: RequestInit) => new Response(bytes));
      const base = 'https://viewer.example/', progress: number[] = [];
      const got = await landmarkModel('stageB', received => progress.push(received), { fetchImpl: fetchImpl as unknown as typeof fetch, store, base });
      assert.deepEqual(Buffer.from(got), bytes);
      const [url, init] = fetchImpl.mock.calls[0].arguments;
      assert.equal(url, `${base}models/${entry.file}`);
      assert.equal(init.integrity, `sha256-${Buffer.from(entry.sha256, 'hex').toString('base64')}`);
      assert.equal(progress.at(-1), bytes.length);
      assert.deepEqual([...entries.keys()], [`${base}models/${entry.file}`]);
      assert.deepEqual(Buffer.from(await landmarkModel('stageB', undefined, { fetchImpl: fetchImpl as unknown as typeof fetch, store, base })), bytes);
      assert.equal(fetchImpl.mock.callCount(), 1, 'The kept copy needs no download.');
      // A kept copy that no longer matches is fetched again.
      entries.set(`${base}models/${entry.file}`, new Response(Buffer.alloc(entry.bytes)));
      assert.deepEqual(Buffer.from(await landmarkModel('stageB', undefined, { fetchImpl: fetchImpl as unknown as typeof fetch, store, base })), bytes);
      assert.equal(fetchImpl.mock.callCount(), 2);
      // Too much or too little is refused.
      const long = mock.fn(async () => new Response(Buffer.concat([bytes, Buffer.from([1])])));
      await assert.rejects(landmarkModel('stageB', undefined, { fetchImpl: long as unknown as typeof fetch, store: undefined, base }), /larger/);
      const short = mock.fn(async () => new Response(bytes.subarray(1)));
      await assert.rejects(landmarkModel('stageB', undefined, { fetchImpl: short as unknown as typeof fetch, store: undefined, base }), /incomplete/);
    } finally { Object.assign(manifest.files.stageB, original); }
  });
});
