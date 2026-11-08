import { getEventListeners } from 'node:events';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, it, mock } from 'node:test';
import { restoreGlobals, stubGlobal, waitFor } from './support';
import type { CoreState, Series } from '../src/model';

// Pixel bodies are read into one buffer of the image's size, so a large volume is never held twice
// while it arrives. These bodies arrive the way a network delivers them: in uneven pieces, cut short,
// too long, failing midway, or stalled until the request is cancelled.
const series: Series = {
  id: 'stream', uid: '1', studyUid: '2', patientId: 'TEST', patientName: 'Synthetic',
  studyDate: '', description: '', modality: 'CT', seriesNumber: 1, engineGeneration: 1,
  dimensions: [3, 2, 2], spacing: [1, 1, 1], origin: [0, 0, 0],
  direction: [1, 0, 0, 0, 1, 0, 0, 0, 1], windowCenter: 40, windowWidth: 400,
  valueUnit: 'HU', suvFactor: null, canReconstruct: true, warnings: [], photometricInterpretation: 'MONOCHROME2',
};
const headers = { 'X-Pixel-Type': 'int16', 'X-Components': '1' };
const values = Int16Array.from({ length: 12 }, (_, i) => i * 100 - 600);
const bytes = new Uint8Array(values.buffer);
/** READ_STEP in src/api.ts. */
const SCRATCH = 4 << 20;
// Chromium's fetch bodies are byte streams; plain streams are covered as well.
const kinds = [['a byte stream', 'bytes'], ['a plain stream', undefined]] as const;

interface Body { stream: ReadableStream<Uint8Array>; stalled: boolean; views: number[]; cancelled: unknown[]; fail(reason: unknown): void }

/** Answers each read with the next of `sizes` bytes of `source`, then closes, fails or never answers again. */
function body(source: Uint8Array, sizes: number[], type?: 'bytes', end: 'close' | 'stall' | Error = 'close'): Body {
  let offset = 0, index = 0;
  const result: Body = { stream: undefined as never, stalled: false, views: [], cancelled: [], fail: () => {} };
  result.stream = new ReadableStream({
    type,
    start(controller: ReadableStreamDefaultController<Uint8Array> | ReadableByteStreamController) { result.fail = reason => controller.error(reason); },
    pull(controller: ReadableStreamDefaultController<Uint8Array> | ReadableByteStreamController) {
      const request = 'byobRequest' in controller ? controller.byobRequest : null;
      if (offset >= source.length) {
        if (end === 'stall') { result.stalled = true; return new Promise<void>(() => {}); }
        if (end instanceof Error) return controller.error(end);
        controller.close();
        // A byte stream closed during a pending read must answer that read.
        request?.respond(0);
        return;
      }
      const size = Math.min(sizes[index++ % sizes.length], source.length - offset);
      if (request?.view) {
        // Like Chromium, write straight into the buffer the reader offered.
        const view = new Uint8Array(request.view.buffer, request.view.byteOffset, request.view.byteLength);
        result.views.push(view.byteLength);
        const filled = Math.min(size, view.byteLength);
        view.set(source.subarray(offset, offset + filled));
        offset += filled;
        request.respond(filled);
      } else {
        controller.enqueue(source.slice(offset, offset + size));
        offset += size;
      }
    },
    cancel(reason) { result.cancelled.push(reason); },
  } as UnderlyingDefaultSource<Uint8Array>);
  return result;
}
const serve = (delivered: Body, extra: Record<string, string> = {}) =>
  mock.fn(async (_url: string, _options?: RequestInit) => new Response(delivered.stream, { headers: { ...headers, ...extra } }));

// A fresh copy of the API module for each test, with its own engine state.
let copies = 0;
const loadApi = () => import(`../src/api.ts?fresh=${++copies}`) as Promise<typeof import('../src/api')>;
let emit: (state: CoreState) => void = () => {};
beforeEach(() => {
  stubGlobal('window', { veacom: {
    getCoreState: async () => ({ status: 'ready', generation: 1, restartCount: 0 }),
    onCoreState: (listener: (state: CoreState) => void) => { emit = listener; return () => {}; },
    getPixels: async ({ index }: { index?: number }) => ({ url: `veacom://app/_imaging/${index === undefined ? 'volume' : 'frame'}/test`, generation: 1 }),
  } });
});
afterEach(restoreGlobals);

for (const [kind, type] of kinds) it(`assembles a volume from ${kind} delivered in uneven pieces, including ones that split a sample`, async () => {
  stubGlobal('fetch', serve(body(bytes, [5, 1, 7, 3], type)));
  const { loadVolume } = await loadApi();
  const volume = await loadVolume(series);
  assert.ok(volume.data instanceof Int16Array);
  assert.deepEqual([...volume.data], [...values]);
});

it('preserves every bit of a float64 source frame, including NaN padding and negative zero', async () => {
  const bits = new BigUint64Array([0x7ff8_0000_0000_0042n, 0x8000_0000_0000_0000n]);
  const delivered = body(new Uint8Array(bits.buffer), [3, 5, 1], 'bytes');
  stubGlobal('fetch', serve(delivered, { 'X-Pixel-Type': 'float64', 'X-Source-Frame-Index': '1' }));
  const { loadSourceFrame } = await loadApi();
  const frame = await loadSourceFrame({ ...series, dimensions: [2, 1, 3] }, 1);
  assert.ok(frame.data instanceof Float64Array);
  assert.deepEqual(new BigUint64Array(frame.data.buffer), bits);
});

it('keeps RGB channels in order across stream chunks', async () => {
  const rgb = Uint8Array.of(255, 1, 2, 3, 128, 4);
  const delivered = body(rgb, [2, 1], 'bytes');
  stubGlobal('fetch', serve(delivered, { 'X-Pixel-Type': 'uint8', 'X-Components': '3' }));
  const { loadVolume } = await loadApi();
  const volume = await loadVolume({ ...series, dimensions: [2, 1, 1], components: 3 });
  assert.deepEqual(volume.data, rgb);
  assert.equal(volume.series.components, 3);
});

for (const [kind, type] of kinds) it(`reads a 10 MiB volume from ${kind} into one buffer of exactly its size`, async () => {
  const large: Series = { ...series, dimensions: [1024, 1024, 5] };
  const source = new Uint8Array(1024 * 1024 * 5 * 2);
  for (let i = 0; i < source.length; i++) source[i] = (i * 31 + 7) & 255;
  const delivered = body(source, [65536, 1, 1048579, 3000], type);
  stubGlobal('fetch', serve(delivered));
  const { loadVolume } = await loadApi();
  const volume = await loadVolume(large);
  assert.equal(volume.data.buffer.byteLength, source.length);
  const received = new Uint8Array(volume.data.buffer);
  assert.equal(received.findIndex((value, i) => value !== source[i]), -1);
  if (type === 'bytes') {
    // Every read offers the same small scratch buffer. Offering the rest of the image instead moves
    // the whole image buffer on each read, which made V8 collect garbage thousands of times.
    assert.ok(delivered.views.length > 1);
    assert.deepEqual(new Set(delivered.views), new Set([SCRATCH]));
  }
});

for (const [kind, type] of kinds) it(`rejects ${kind} that is shorter or longer than the image, and stops a longer one`, async () => {
  const short = body(bytes.slice(0, 22), [8], type), long = body(new Uint8Array(64), [8], type);
  const replies = [new Response(short.stream, { headers }), new Response(long.stream, { headers })];
  stubGlobal('fetch', mock.fn(async () => replies.shift()));
  const { loadVolume } = await loadApi();
  await assert.rejects(loadVolume(series), { message: /Incomplete image: received 22 of 24 bytes\./ });
  await assert.rejects(loadVolume(series), { message: /Incomplete image: received (2[5-9]|3[0-2]) of 24 bytes\./ });
  assert.equal(long.cancelled.length, 1);
});

it('rejects a mismatched Content-Length before reading pixels from a replaced series', async () => {
  const delivered = body(bytes, [3], 'bytes');
  stubGlobal('fetch', serve(delivered, { 'Content-Length': '2' }));
  const { loadVolume } = await loadApi();
  await assert.rejects(loadVolume(series), { message: /image size/i });
  assert.equal(delivered.views.length, 0);
  assert.equal(delivered.cancelled.length, 1);
});

it('rejects a volume over the engine limit before allocating its advertised size', async () => {
  const oversized: Series = { ...series, dimensions: [1024, 1024, 1025] };
  const advertised = 1024 * 1024 * 1025 * Int16Array.BYTES_PER_ELEMENT;
  const delivered = body(bytes, [3], 'bytes');
  stubGlobal('fetch', serve(delivered));
  const { loadVolume } = await loadApi();
  // Trap the allocation so a regression cannot reserve more than 2 GiB in the test runner.
  stubGlobal('Uint8Array', new Proxy(Uint8Array, {
    construct(target, args, newTarget) {
      if (args[0] === advertised) throw new Error('Attempted oversized allocation');
      return Reflect.construct(target, args, newTarget);
    },
  }));
  await assert.rejects(loadVolume(oversized), { message: /image size/i });
  assert.equal(delivered.cancelled.length, 1);
});

it('rejects a missing or empty body as an incomplete image', async () => {
  const replies = [new Response(null, { headers }), new Response(body(new Uint8Array(0), [8], 'bytes').stream, { headers })];
  stubGlobal('fetch', mock.fn(async () => replies.shift()));
  const { loadVolume } = await loadApi();
  await assert.rejects(loadVolume(series), { message: /Incomplete image: received 0 of 24 bytes\./ });
  await assert.rejects(loadVolume(series), { message: /Incomplete image: received 0 of 24 bytes\./ });
});

for (const [kind, type] of kinds) it(`passes on the error of ${kind} that fails midway`, async () => {
  const failure = new TypeError('network error');
  stubGlobal('fetch', serve(body(bytes.slice(0, 10), [4], type, failure)));
  const { loadVolume } = await loadApi();
  await assert.rejects(loadVolume(series), error => error === failure);
});

for (const [kind, type] of kinds) it(`stops reading ${kind} when the engine restarts midway, even if the body never answers again`, async () => {
  const stalled = body(bytes.slice(0, 10), [4], type, 'stall');
  stubGlobal('fetch', serve(stalled));
  const { loadVolume } = await loadApi();
  const rejected = assert.rejects(loadVolume(series), { message: /The imaging engine restarted\./ });
  await waitFor(() => assert.equal(stalled.stalled, true));
  emit({ status: 'restarting', generation: 1, restartCount: 1 });
  await rejected;
  assert.equal(stalled.cancelled.length, 1);
});

it('reports the engine restart rather than the network error the cancelled body ends with', async () => {
  const stalled = body(bytes.slice(0, 10), [4], 'bytes', 'stall');
  stubGlobal('fetch', mock.fn(async (_url: string, options: RequestInit) => {
    const response = new Response(stalled.stream, { headers });
    // A cancelled request can fail its body before the reader hears of the cancellation.
    options.signal!.addEventListener('abort', () => stalled.fail(new TypeError('network error')));
    return response;
  }));
  const { loadVolume } = await loadApi();
  const rejected = assert.rejects(loadVolume(series), { message: /The imaging engine restarted\./ });
  await waitFor(() => assert.equal(stalled.stalled, true));
  emit({ status: 'restarting', generation: 1, restartCount: 1 });
  await rejected;
});

for (const [kind, type] of kinds) it(`stops reading ${kind} when the caller cancels a source frame midway`, async () => {
  const stalled = body(bytes.slice(0, 2), [1], type, 'stall');
  stubGlobal('fetch', serve(stalled, { 'X-Source-Frame-Index': '1' }));
  const { loadSourceFrame } = await loadApi();
  const controller = new AbortController();
  const rejected = assert.rejects(loadSourceFrame(series, 1, controller.signal), { name: 'AbortError' });
  await waitFor(() => assert.equal(stalled.stalled, true));
  controller.abort();
  await rejected;
  assert.equal(stalled.cancelled.length, 1);
});

it('leaves no listener on the engine generation\'s signal once a volume has been read', async () => {
  const fetch = serve(body(bytes, [8], 'bytes'));
  stubGlobal('fetch', fetch);
  const { loadVolume } = await loadApi();
  await loadVolume(series);
  // A volume request uses that signal directly, and it lasts as long as the engine does.
  assert.deepEqual(getEventListeners(fetch.mock.calls[0].arguments[1]!.signal!, 'abort'), []);
});
