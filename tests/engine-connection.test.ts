import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { restoreGlobals, stubGlobal, waitFor } from './support';
import type { CoreState, ImportResult, Series } from '../src/model';

const ready = (generation = 1): CoreState => ({ status: 'ready', generation, restartCount: generation - 1 });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const source = (generation = 1): Series => ({ id: 'same-uid', engineGeneration: generation, dimensions: [1, 1, 2],
  frameMetadata: [{ sopInstanceUid: '1.2.0', sourceFrameNumber: 0 }, { sopInstanceUid: '1.2.1', sourceFrameNumber: 1 }] } as Series);
const catalog = (generation = 1): ImportResult => ({ series: [source(generation)], warnings: [] });
const frameResponse = (headers: Record<string, string> = {}) => new Response(new Float32Array([42]).buffer, { headers: {
  'X-Pixel-Type': 'float32', 'X-Source-Frame-Index': '1', 'X-SOP-Instance-UID': '1.2.1', 'X-Source-Frame-Number': '1', ...headers,
} });
// A fresh copy of the API module for each test, with its own engine state.
let copies = 0;
const loadApi = () => import(`../src/api.ts?fresh=${++copies}`) as Promise<typeof import('../src/api')>;
async function fixture(initial?: Promise<CoreState>) {
  let notify!: (state: CoreState) => void;
  let generation = 1;
  const bridge = {
    getCoreState: mock.fn(() => initial || Promise.resolve(ready(generation))),
    onCoreState: mock.fn((listener: (state: CoreState) => void) => { notify = listener; return () => {}; }),
    listSeries: mock.fn(async () => catalog(generation)),
    importSelected: mock.fn(async (_capabilities: string[]) => catalog(generation)),
    getProgress: mock.fn(async () => ({ running: false, stage: 'idle', completed: 0, total: 0, cancelled: false })),
    cancelOperation: mock.fn(async () => ({ requested: true })),
    getTags: mock.fn(async (_id: string, _generation: number): Promise<Record<string, unknown>[]> => [{ PatientName: 'SYNTHETIC' }]),
    getPixels: mock.fn(async (request: { seriesId: string; generation: number; index?: number }) => ({
      url: `veacom://app/_imaging/${request.index === undefined ? 'volume' : 'frame'}/opaque-pixel-capability`, generation,
    })),
  };
  stubGlobal('window', { veacom: bridge });
  const api = await loadApi();
  const states: CoreState[] = [];
  api.subscribeEngineState(state => states.push(state));
  await Promise.resolve();
  return { api, bridge, states, event: (state: CoreState) => { generation = state.generation; notify(state); } };
}
afterEach(restoreGlobals);

describe('renderer imaging broker', () => {
  it('sends selected capabilities through typed IPC without an HTTP request or credential', async () => {
    const f = await fixture();
    const fetchMock = mock.fn(); stubGlobal('fetch', fetchMock);
    assert.deepEqual(await f.api.importPaths(['import-capability']), catalog());
    assert.deepEqual(f.bridge.importSelected.mock.calls.map(call => call.arguments), [[['import-capability']]]);
    assert.deepEqual(await f.api.listSeries(), catalog());
    await f.api.getProgress(); await f.api.cancelOperation();
    assert.deepEqual(await f.api.getTags('same-uid', 1), [{ PatientName: 'SYNTHETIC' }]);
    assert.deepEqual(f.bridge.getTags.mock.calls.map(call => call.arguments), [['same-uid', 1]]);
    assert.equal(fetchMock.mock.callCount(), 0);
    assert.equal('getConnection' in f.api, false); assert.equal('coreRequest' in f.api, false);
  });
  it('aborts a crashing import without replaying it, then permits a new selected import', async () => {
    const f = await fixture(), old = deferred<ImportResult>();
    f.bridge.importSelected.mock.mockImplementationOnce(() => old.promise);
    const imported = f.api.importPaths(['old-capability']);
    const rejected = assert.rejects(imported, { message: /Engine crashed/ });
    await waitFor(() => assert.equal(f.bridge.importSelected.mock.callCount(), 1));
    f.event({ status: 'restarting', generation: 1, restartCount: 1, message: 'Engine crashed; operation not retried.' });
    f.event(ready(2));
    await rejected;
    old.resolve(catalog(1));
    await Promise.resolve();
    assert.equal(f.bridge.importSelected.mock.callCount(), 1);
    assert.equal((await f.api.importPaths(['new-capability'])).series[0].engineGeneration, 2);
    assert.equal(f.bridge.importSelected.mock.callCount(), 2);
  });
  it('rejects old-series source operations before contacting a replacement engine', async () => {
    const f = await fixture();
    f.event({ status: 'restarting', generation: 1, restartCount: 1 }); f.event(ready(2));
    const fetchMock = mock.fn(); stubGlobal('fetch', fetchMock);
    await assert.rejects(f.api.loadVolume(source(1)), { message: /Reopen this study/ });
    await assert.rejects(f.api.loadSourceFrame(source(1), 1), { message: /Reopen this study/ });
    await assert.rejects(f.api.getTags('same-uid', 1), { message: /Reopen this study/ });
    await assert.rejects(f.api.assertSeriesEngine(source(1)), { message: /Reopen this study/ });
    assert.equal(f.bridge.getPixels.mock.callCount(), 0); assert.equal(f.bridge.getTags.mock.callCount(), 0); assert.equal(fetchMock.mock.callCount(), 0);
    assert.deepEqual(await f.api.assertSeriesEngine(source(2)), { generation: 2 });
  });
  it('does not let an initial state query overwrite a newer event', async () => {
    const query = deferred<CoreState>(), f = await fixture(query.promise);
    f.event(ready(2)); query.resolve(ready(1)); await Promise.resolve();
    assert.deepEqual(f.states, [ready(2)]);
    assert.deepEqual(await f.api.assertSeriesEngine(source(2)), { generation: 2 });
  });
  it('retries a failed initial state query without exposing a connection object', async () => {
    const f = await fixture(Promise.reject(new Error('temporarily unavailable')));
    await Promise.resolve(); await Promise.resolve();
    f.bridge.getCoreState.mock.mockImplementationOnce(async () => ready());
    assert.deepEqual(await f.api.assertSeriesEngine(source()), { generation: 1 });
    assert.equal(f.bridge.getCoreState.mock.callCount(), 2);
  });
  it('rejects catalog replies labelled with a different engine generation', async () => {
    const f = await fixture();
    f.bridge.listSeries.mock.mockImplementationOnce(async () => catalog(2));
    await assert.rejects(f.api.listSeries(), { message: /Reopen this study/ });
  });
  it('fetches only an opaque same-origin image URL and verifies all source identity headers', async () => {
    const f = await fixture();
    const fetchMock = mock.fn(async (_url: string, _options: RequestInit) => frameResponse()); stubGlobal('fetch', fetchMock);
    const volume = await f.api.loadSourceFrame(source(), 1);
    assert.deepEqual(f.bridge.getPixels.mock.calls.map(call => call.arguments), [[{ seriesId: 'same-uid', generation: 1, index: 1 }]]);
    const [, options] = fetchMock.mock.calls[0].arguments;
    assert.ok(options.signal instanceof AbortSignal);
    assert.deepEqual(fetchMock.mock.calls[0].arguments, ['veacom://app/_imaging/frame/opaque-pixel-capability', { signal: options.signal }]);
    assert.equal(volume.sourceFrameIndex, 1); assert.equal(volume.data[0], 42); assert.deepEqual(volume.series.dimensions, [1, 1, 2]);
    const mismatches: Record<string, string>[] = [{ 'X-Source-Frame-Index': '0' }, { 'X-SOP-Instance-UID': 'different' }, { 'X-Source-Frame-Number': '9' }];
    for (const changed of mismatches) {
      fetchMock.mock.mockImplementationOnce(async () => frameResponse(changed));
      await assert.rejects(f.api.loadSourceFrame(source(), 1), { message: /different source frame|source image changed/ });
    }
  });
  for (const url of ['http://127.0.0.1:1234/volume/series', 'https://example.org/image', 'veacom://app/index.html',
    'veacom://other/_imaging/frame/token', 'veacom://app/_imaging/frame/token?extra=1', 'veacom://app/_imaging/volume/token'])
  it(`rejects a nonmatching pixel capability URL: ${url}`, async () => {
    const f = await fixture(), fetchMock = mock.fn(); stubGlobal('fetch', fetchMock);
    f.bridge.getPixels.mock.mockImplementationOnce(async () => ({ url, generation: 1 }));
    await assert.rejects(f.api.loadSourceFrame(source(), 1), { message: /Invalid imaging response capability/ });
    assert.equal(fetchMock.mock.callCount(), 0);
  });
  it('rejects an expired pixel capability generation before fetching its URL', async () => {
    const f = await fixture(), fetchMock = mock.fn(); stubGlobal('fetch', fetchMock);
    f.bridge.getPixels.mock.mockImplementationOnce(async () => ({ url: 'veacom://app/_imaging/frame/old', generation: 2 }));
    await assert.rejects(f.api.loadSourceFrame(source(), 1), { message: /Reopen this study/ });
    assert.equal(fetchMock.mock.callCount(), 0);
  });
  it('cancels pending capability IPC without fetching a late reply', async () => {
    const f = await fixture(), capability = deferred<{ url: string; generation: number }>();
    f.bridge.getPixels.mock.mockImplementationOnce(() => capability.promise);
    const fetchMock = mock.fn(); stubGlobal('fetch', fetchMock);
    const controller = new AbortController(), pending = f.api.loadSourceFrame(source(), 1, controller.signal);
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    await waitFor(() => assert.equal(f.bridge.getPixels.mock.callCount(), 1));
    controller.abort(); await rejected;
    capability.resolve({ url: 'veacom://app/_imaging/frame/late', generation: 1 }); await Promise.resolve();
    assert.equal(fetchMock.mock.callCount(), 0);
  });
  it('passes cancellation into the streaming pixel fetch', async () => {
    const f = await fixture();
    const fetchMock = mock.fn((_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
      options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true });
    })); stubGlobal('fetch', fetchMock);
    const controller = new AbortController(), pending = f.api.loadSourceFrame(source(), 1, controller.signal);
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    await waitFor(() => assert.equal(fetchMock.mock.callCount(), 1)); controller.abort(); await rejected;
    assert.equal(fetchMock.mock.calls[0].arguments[1].signal!.aborted, true);
  });
  it('rejects late pixel bodies and tag replies after an engine reset', async () => {
    const f = await fixture(), pixels = deferred<ArrayBuffer>(), tags = deferred<Record<string, unknown>[]>();
    const arrayBuffer = mock.fn(() => pixels.promise);
    stubGlobal('fetch', mock.fn(async () => ({ ok: true, headers: new Headers({ 'X-Pixel-Type': 'float32' }), arrayBuffer })));
    f.bridge.getTags.mock.mockImplementationOnce(() => tags.promise);
    const loading = f.api.loadVolume({ ...source(), dimensions: [1, 1, 1] }), reading = f.api.getTags('same-uid', 1);
    const rejectedVolume = assert.rejects(loading), rejectedTags = assert.rejects(reading);
    await waitFor(() => { assert.equal(arrayBuffer.mock.callCount(), 1); assert.equal(f.bridge.getTags.mock.callCount(), 1); });
    f.event({ status: 'restarting', generation: 1, restartCount: 1 }); f.event(ready(2));
    pixels.resolve(new Float32Array([42]).buffer); tags.resolve([{ PatientName: 'OLD' }]);
    await Promise.all([rejectedVolume, rejectedTags]);
  });
  it('reports unavailable engine state without sending operations', async () => {
    const f = await fixture();
    f.event({ status: 'failed', generation: 3, restartCount: 2, message: 'Restart limit reached.' });
    await assert.rejects(f.api.importPaths(['capability']), { message: /Restart limit/ });
    assert.equal(f.bridge.importSelected.mock.callCount(), 0);
  });
  it('requires the desktop bridge and never fetches a credential file in a browser', async () => {
    stubGlobal('window', {}); const fetchMock = mock.fn(); stubGlobal('fetch', fetchMock);
    const api = await loadApi();
    await assert.rejects(api.listSeries(), { message: /Open VEAcom Desktop/ });
    assert.equal(fetchMock.mock.callCount(), 0);
  });
});
