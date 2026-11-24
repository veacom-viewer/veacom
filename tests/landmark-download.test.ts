import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import manifest from '../electron/landmark-model.json';
import { cancelLandmarkModel, landmarkModel } from '../src/web/landmarkModel';
import { framePixels, loadModel, runModel } from '../src/ui/landmarkSuggestions';
import type { Volume } from '../src/model';
import { restoreGlobals, stubGlobal } from './support';

const require = createRequire(import.meta.url);
const { createLandmarkModel } = require('../electron/landmark-model.cjs');
const directories: string[] = [];
afterEach(async () => { restoreGlobals(); await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

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
    await assert.rejects(readdir(path.join(userData, 'landmark-model')), 'Nothing is kept.');
    await assert.rejects(model.get('../../secrets'), /Unknown model file/);
    await assert.rejects(model.get('toString'), /Unknown model file/);
  });

  it('starts again after Cancel instead of joining the stopped download', async () => {
    const { bytes, entry } = graph();
    const userData = await mkdtemp(path.join(tmpdir(), 'veacom-model-test-'));
    directories.push(userData);
    let calls = 0;
    // The first download never ends unless it is stopped; the second answers.
    const fetchImpl = mock.fn((url: string, init: { signal: AbortSignal }) => {
      if (url.startsWith('https://github.com/')) return Promise.resolve(new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/synthetic' } }));
      if (calls++ === 0) return new Promise<Response>((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
      return Promise.resolve(new Response(new Uint8Array(bytes)));
    });
    const model = createLandmarkModel({ userData, fetchImpl, manifest: { ...manifest, files: { ...manifest.files, stageA: entry } } });
    const first = model.get('stageA');
    await new Promise(resolve => setTimeout(resolve, 10));
    model.cancel();
    await assert.rejects(first, /aborted/);
    assert.deepEqual(Buffer.from(await model.get('stageA')), bytes);
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

  it('fetches from the site, checks the hash before keeping it, and drops an earlier model\'s files', async () => {
    const { bytes, entry } = graph(), original = { ...manifest.files.stageB };
    Object.assign(manifest.files.stageB, entry);
    try {
      const { entries, store } = storage();
      entries.set('https://viewer.example/models/old-model.onnx', new Response('old'));
      const fetchImpl = mock.fn(async (_url: string, _init: RequestInit) => new Response(bytes));
      const base = 'https://viewer.example/', progress: number[] = [];
      const got = await landmarkModel('stageB', received => progress.push(received), { fetchImpl: fetchImpl as unknown as typeof fetch, store, base });
      assert.deepEqual(Buffer.from(got), bytes);
      assert.equal(fetchImpl.mock.calls[0].arguments[0], `${base}models/${entry.file}`);
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
      // Cancel while the cache is still being read stops that request; the next one downloads.
      const { store: slow } = storage();
      let open = () => {};
      const opened = new Promise<void>(resolve => { open = resolve; });
      const pending = landmarkModel('stageB', undefined, { fetchImpl: fetchImpl as unknown as typeof fetch, base,
        store: { open: async () => { await opened; return slow.open(''); } } as unknown as CacheStorage });
      cancelLandmarkModel(); open();
      await assert.rejects(pending, /abort/i);
      assert.equal(fetchImpl.mock.callCount(), 2, 'The cancelled request fetched nothing.');
      // A file of the right size but other bytes is refused and never kept.
      const { store: fresh, entries: none } = storage();
      const forged = mock.fn(async () => new Response(Buffer.alloc(entry.bytes, 7)));
      await assert.rejects(landmarkModel('stageB', undefined, { fetchImpl: forged as unknown as typeof fetch, store: fresh, base }), /checksum/);
      assert.equal(none.size, 0);
    } finally { Object.assign(manifest.files.stageB, original); }
  });
});

describe('the model in the page', () => {
  it('hands the Worker a copy of the frame shown, never the volume\'s own buffer', () => {
    const data = Uint16Array.from({ length: 2 * 3 * 2 }, (_, i) => i);
    const volume = { series: { dimensions: [2, 3, 2] }, data } as unknown as Volume;
    const second = framePixels(volume, 1);
    assert.deepEqual([...second], [6, 7, 8, 9, 10, 11]);
    assert.notEqual(second.buffer, data.buffer);
    const partial = { ...volume, data: data.slice(6), sourceFrameIndex: 1 } as unknown as Volume;
    assert.deepEqual([...framePixels(partial, 1)], [6, 7, 8, 9, 10, 11]);
    assert.throws(() => framePixels(partial, 0), /^Error: frame$/);
  });

  it('checks the graphs against their hashes, and keeps them for the session once checked', async () => {
    const a = graph(64), b = graph(96), original = structuredClone(manifest.files);
    Object.assign(manifest.files.stageA, a.entry); Object.assign(manifest.files.stageB, b.entry);
    try {
      let served = { stageA: Buffer.alloc(64), stageB: b.bytes };
      const fetchPart = mock.fn(async (part: 'stageA' | 'stageB', onProgress?: (received: number) => void) => {
        onProgress?.(served[part].length);
        return new Uint8Array(served[part]).buffer;
      });
      stubGlobal('window', { veacom: { landmarkModel: fetchPart } });
      const progress: number[] = [];
      await assert.rejects(loadModel(received => progress.push(received)), /checksum/);
      assert.equal(progress.at(-1), 64 + 96);
      served = { stageA: a.bytes, stageB: b.bytes };
      const loaded = await loadModel(() => {});
      assert.deepEqual(Buffer.from(loaded.stageA), a.bytes);
      await loadModel(() => {});
      assert.equal(fetchPart.mock.callCount(), 4, 'Checked once, the graphs are not asked for again.');
    } finally { Object.assign(manifest.files.stageA, original.stageA); Object.assign(manifest.files.stageB, original.stageB); }
  });

  it('runs in a Worker that gets the graphs once, and stops it when cancelled', async () => {
    const workers: FakeWorker[] = [];
    let failNext = false, holdNext = false;
    class FakeWorker {
      messages: Array<{ id: number; models?: unknown }> = []; terminated = false;
      onmessage: ((event: { data: unknown }) => void) | null = null; onerror: ((event: { message: string; preventDefault(): void }) => void) | null = null;
      constructor() { workers.push(this); }
      postMessage(message: { id: number; models?: unknown }) {
        this.messages.push(message);
        const reply = failNext ? { id: message.id, ok: false, error: 'the runtime did not load' } : { id: message.id, ok: true, anchors: {}, channels: {}, threads: 1, timings: {} };
        failNext = false;
        if (!holdNext) queueMicrotask(() => this.onmessage?.({ data: reply }));
        holdNext = false;
      }
      terminate() { this.terminated = true; }
    }
    stubGlobal('Worker', FakeWorker);
    const film = () => ({ pixels: new Uint16Array(4), columns: 2, rows: 2, mm: [0.3, 0.3] as [number, number], invert: false });
    const graphs = { stageA: new ArrayBuffer(8), stageB: new ArrayBuffer(8) };
    const first = await runModel(film(), 'left', graphs, new AbortController().signal);
    assert.equal(first.ok, true); assert.ok(first.total >= 0);
    // The second request goes unanswered until it is cancelled: the Worker is stopped and the next run starts another.
    holdNext = true;
    const controller = new AbortController(), waiting = runModel(film(), 'left', graphs, controller.signal);
    controller.abort(new Error('cancelled'));
    await assert.rejects(waiting, /cancelled/);
    assert.equal(workers[0].terminated, true);
    assert.ok(workers[0].messages[0].models && !workers[0].messages[1].models, 'The graphs go with the first request only.');
    await runModel(film(), 'left', graphs, new AbortController().signal);
    assert.equal(workers.length, 2);
    assert.ok(workers[1].messages[0].models);
    assert.equal(graphs.stageA.byteLength, 8, 'The checked graphs stay here for the next Worker.');
    // A failed run (the runtime not loading, say) stops its Worker too: the next run loads everything again.
    failNext = true;
    const logged = mock.method(console, 'error', () => {});
    await assert.rejects(runModel(film(), 'left', graphs, new AbortController().signal), /^Error: run$/);
    assert.match(String(logged.mock.calls[0].arguments[1]), /runtime did not load/, 'The detail goes to the console.');
    logged.mock.restore();
    assert.equal(workers[1].terminated, true);
    await runModel(film(), 'left', graphs, new AbortController().signal);
    assert.equal(workers.length, 3);
    assert.ok(workers[2].messages[0].models);
  });
});
