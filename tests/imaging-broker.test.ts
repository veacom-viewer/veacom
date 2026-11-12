import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { waitFor } from './support';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
const require = createRequire(import.meta.url);
const { ImagingBroker, validateApplicationSender } = require('../electron/imaging-broker.cjs');

type Body = Record<string, unknown> | undefined;
type Options = { signal?: AbortSignal };
const image = { id: 'study', dimensions: [2, 2, 8] };
function fixture() {
  // The engine's connection (engine-pipe.cjs): request(op, body, { signal }) answers with a Response.
  const request = mock.fn(async (op: string, _body?: Body, _options?: Options) => op === 'series' || op === 'import'
    ? Response.json({ series: [image], warnings: [] }) : Response.json({ running: false }));
  const engine = Object.assign(new EventEmitter(), {
    generation: 1,
    state() { return { status: 'ready', generation: this.generation }; },
    connection(expected?: number) {
      if (expected !== undefined && expected !== this.generation) throw new Error('Engine changed');
      return { generation: this.generation, request };
    },
  });
  let now = 1;
  const broker = new ImagingBroker({ engine, realpath: async (value: string) => value, now: () => now });
  // The op and body of each request, in order.
  const calls = () => request.mock.calls.map(call => [call.arguments[0], call.arguments[1]] as [string, Body]);
  return { broker, engine, request, calls, expire: () => { now += 11 * 60_000; } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('main-only imaging broker', () => {
  it('registers series published early so their frames can be asked for before the import ends', async () => {
    const f = fixture(), finished = deferred<Response>();
    const capabilities = await f.broker.authorizeImportPaths(['/selected/early']);
    f.request.mock.mockImplementation(async op => op === 'import' ? finished.promise
      : Response.json({ import: 3, series: [{ id: 'early', dimensions: [2, 2, 4] }] }));
    const importing = f.broker.importSelected(capabilities);
    const result = await f.broker.importEarly(capabilities, 0);
    const request = f.calls()[0][1] as { requestId: string };
    assert.deepEqual(f.calls()[1], ['importEarly', { after: 0, requestId: request.requestId }]);
    assert.deepEqual(result, { import: 3, series: [{ id: 'early', dimensions: [2, 2, 4], engineGeneration: 1 }] });
    assert.match(f.broker.getPixels({ seriesId: 'early', generation: 1, index: 3 }).url, /^veacom:\/\/app\/_imaging\/frame\//);
    assert.throws(() => f.broker.getPixels({ seriesId: 'early', generation: 1, index: 4 }), { message: /out of range/ });
    for (const after of [-1, 1.5, '0', 100_001]) await assert.rejects(f.broker.importEarly(capabilities, after), { message: /Invalid request\./ });
    for (const invalid of [null, [], [1]]) await assert.rejects(f.broker.importEarly(invalid, 0), { message: /Invalid request\./ });
    finished.resolve(Response.json({ series: [], warnings: [] }));
    await importing;
    const calls = f.request.mock.calls.length;
    assert.deepEqual((await f.broker.importEarly(capabilities, 0)).series, []);
    assert.equal(f.request.mock.callCount(), calls);
    f.broker.dispose();
  });
  it('keeps startup and manual import previews scoped to their own requests', async () => {
    const f = fixture(), startup = deferred<Response>(), manual = deferred<Response>();
    const first = await f.broker.authorizeImportPaths(['/startup']), second = await f.broker.authorizeImportPaths(['/manual']);
    const ids = new Map<string, string>();
    let active = '/startup';
    f.request.mock.mockImplementation(async (op, body) => {
      const request = body as { paths: string[]; requestId: string };
      if (op === 'import') {
        ids.set(request.paths[0], request.requestId);
        return request.paths[0] === '/startup' ? startup.promise : manual.promise;
      }
      const matches = request.requestId === ids.get(active);
      return Response.json({ import: 1, series: matches ? [{ id: active, dimensions: [2, 2, 4] }] : [] });
    });
    f.broker.prefetchImport(first);
    const firstResult = f.broker.importSelected(first), secondResult = f.broker.importSelected(second);
    assert.notEqual(ids.get('/startup'), ids.get('/manual'));
    assert.deepEqual((await f.broker.importEarly(second, 0)).series, []);
    assert.equal((await f.broker.importEarly(first, 0)).series[0].id, '/startup');
    startup.resolve(Response.json({ series: [], warnings: [] }));
    await firstResult;
    active = '/manual';
    assert.equal((await f.broker.importEarly(second, 0)).series[0].id, '/manual');
    manual.resolve(Response.json({ series: [], warnings: [] }));
    await secondResult;
    f.broker.dispose();
  });
  for (const failed of [false, true]) it(`ignores a late early-series response after an import settles (failed: ${failed})`, async () => {
    const f = fixture(), finished = deferred<Response>(), early = deferred<Response>();
    const capabilities = await f.broker.authorizeImportPaths(['/selected/study']);
    f.request.mock.mockImplementation(async op => op === 'import' ? finished.promise : early.promise);
    const importing = f.broker.importSelected(capabilities).catch((error: Error) => error);
    const preview = f.broker.importEarly(capabilities, 0);
    finished.resolve(failed ? Response.json({ error: 'Import failed' }, { status: 422 })
      : Response.json({ series: [{ id: 'study', dimensions: [2, 2, 8] }], warnings: [] }));
    await importing;
    early.resolve(Response.json({ import: 1, series: [{ id: 'study', dimensions: [2, 2, 4] }] }));
    assert.deepEqual((await preview).series, []);
    if (failed) assert.throws(() => f.broker.requireSeries('study', 1));
    else assert.ok(f.broker.getPixels({ seriesId: 'study', generation: 1, index: 7 }).url.includes('/frame/'));
    f.broker.dispose();
  });
  it('shows an engine error as its translated message, not the response JSON', async () => {
    const i18n = require('../electron/i18n.cjs');
    const f = fixture();
    const reason = { code: 'file.notDicom', text: 'Missing DICOM file meta marker' };
    const unreadable = { code: 'import.fileUnreadable', params: { file: 'notes.txt', reason }, text: 'notes.txt: Missing DICOM file meta marker' };
    const body = { error: 'No supported images were found. notes.txt: Missing DICOM file meta marker',
      note: { code: 'import.noImages', params: { details: [unreadable] }, text: 'No supported images were found. notes.txt: Missing DICOM file meta marker' } };
    f.request.mock.mockImplementation(async () => Response.json(body, { status: 422 }));
    await assert.rejects(f.broker.importSelected(await f.broker.authorizeImportPaths(['/selected/notes'])), { message: /^No supported images were found\. notes\.txt: Missing DICOM file meta marker$/ });
    i18n.setLocale('tr');
    try {
      await assert.rejects(f.broker.importSelected(await f.broker.authorizeImportPaths(['/selected/notes'])), { message: /^Desteklenen görüntü bulunamadı\. notes\.txt okunamadı: DICOM dosyası değil \(DICOM başlığı yok\)$/ });
      f.request.mock.mockImplementation(async () => Response.json({ error: 'Plain engine error' }, { status: 422 }));
      await assert.rejects(f.broker.listSeries(), { message: /^Plain engine error$/ });
      f.request.mock.mockImplementation(async () => new Response('Not JSON', { status: 500 }));
      await assert.rejects(f.broker.listSeries(), { message: /^Not JSON$/ });
    } finally { i18n.setLocale('en'); f.broker.dispose(); }
  });
  it('removes from the engine only series it handed out, from the same engine generation', async () => {
    const f = fixture();
    assert.deepEqual(await f.broker.removeSeries(['study'], 1), { removed: 0 });
    assert.equal(f.request.mock.callCount(), 0);
    await f.broker.listSeries();
    f.request.mock.mockImplementation(async () => Response.json({ removed: 1, remaining: 0 }));
    assert.deepEqual(await f.broker.removeSeries(['study', 'study', 'unknown'], 1), { removed: 1, remaining: 0 });
    assert.deepEqual(f.calls().at(-1), ['removeSeries', { ids: ['study'] }]);
    // Forgotten: the same series can no longer be read or removed again.
    assert.throws(() => f.broker.requireSeries('study', 1));
    assert.deepEqual(await f.broker.removeSeries(['study'], 1), { removed: 0 });
    await assert.rejects(f.broker.removeSeries('study', 1), { message: /Invalid series request\./ });
    await assert.rejects(f.broker.removeSeries(['study'], 0), { message: /Invalid series request\./ });
    f.broker.dispose();
  });
  it('registers only two different series it handed out, at the revisions shown, and checks the answer', async () => {
    const f = fixture();
    f.request.mock.mockImplementation(async () => Response.json({ series: [{ id: 'fixed', sourceRevision: 3 }, { id: 'moving', sourceRevision: 5 }], warnings: [] }));
    await f.broker.listSeries();
    const answer = { matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, -24, 0, 0, 0, 1], similarity: 0.8, similarityBefore: 0.7, overlap: 0.9, angle: 0 };
    f.request.mock.mockImplementation(async () => Response.json(answer));
    const request = { fixedId: 'fixed', movingId: 'moving', generation: 1, fixedRevision: 3, movingRevision: 5 };
    assert.deepEqual(await f.broker.register(request), answer);
    assert.deepEqual(f.calls().at(-1), ['register', { fixedId: 'fixed', movingId: 'moving', fixedRevision: 3, movingRevision: 5 }]);
    const calls = f.request.mock.callCount();
    for (const invalid of [null, { ...request, path: '/etc' }, { ...request, movingId: 'fixed' }]) await assert.rejects(f.broker.register(invalid), { message: /Invalid registration request\./ });
    await assert.rejects(f.broker.register({ ...request, movingId: 'unknown' }), { message: /not open|açık değil/ });
    await assert.rejects(f.broker.register({ ...request, fixedRevision: 4 }), { message: /Source series changed\./ });
    await assert.rejects(f.broker.register({ ...request, generation: 2 }), { message: /Engine changed/ });
    assert.equal(f.request.mock.callCount(), calls, 'nothing invalid reaches the engine');
    f.request.mock.mockImplementation(async () => Response.json({ ...answer, matrix: [1, 2, 3] }));
    await assert.rejects(f.broker.register(request), { message: /Invalid registration result\./ });
    f.broker.dispose();
  });
  it('rejects raw paths and consumes only main-issued one-use file selections', async () => {
    const f = fixture();
    await assert.rejects(f.broker.importSelected(['/private/unselected.dcm']), { message: /invalid or expired/ });
    assert.equal(f.request.mock.callCount(), 0);
    const capabilities = await f.broker.authorizeImportPaths(['/selected/study']);
    assert.match(capabilities[0], /^import:/); assert.ok(!capabilities[0].includes('/selected'));
    const result = await f.broker.importSelected(capabilities);
    assert.equal(result.series[0].engineGeneration, 1);
    const [op, { requestId, ...sent }] = f.calls()[0] as [string, { requestId: string }];
    assert.deepEqual([op, sent], ['import', { paths: ['/selected/study'] }]); assert.equal(typeof requestId, 'string');
    await assert.rejects(f.broker.importSelected(capabilities), { message: /invalid or expired/ });
    f.broker.dispose();
  });
  it('rejects expired and mixed invalid selections without consuming valid ones', async () => {
    const f = fixture(), selected = await f.broker.authorizeImportPaths(['/selected/study']);
    await assert.rejects(f.broker.importSelected([...selected, '/unselected']), { message: /invalid or expired/ });
    await f.broker.importSelected(selected);
    const expired = await f.broker.authorizeImportPaths(['/selected/other']); f.expire();
    await assert.rejects(f.broker.importSelected(expired), { message: /invalid or expired/ }); f.broker.dispose();
  });
  it('hands a launch-time import to the same selection once and warms its first series', async () => {
    const f = fixture(), capabilities = await f.broker.authorizeImportPaths(['/launch/study']);
    f.broker.prefetchImport(capabilities);
    const result = await f.broker.importSelected([...capabilities]);
    assert.equal(result.series[0].id, 'study');
    await waitFor(() => assert.ok(f.calls().some(([op, body]) => op === 'warm' && body?.id === 'study')));
    assert.equal(f.calls().filter(([op]) => op === 'import').length, 1);
    await assert.rejects(f.broker.importSelected(capabilities), { message: /invalid or expired/ });
    const other = await f.broker.authorizeImportPaths(['/selected/other']);
    f.broker.prefetchImport(await f.broker.authorizeImportPaths(['/launch/again']));
    await f.broker.importSelected(other);
    assert.equal(f.calls().filter(([op]) => op === 'import').length, 3);
    f.broker.dispose();
  });
  it('keeps both launches until the window takes each prefetch once', async () => {
    const f = fixture();
    const a = await f.broker.authorizeImportPaths(['/launch/first']);
    const b = await f.broker.authorizeImportPaths(['/launch/second']);
    f.broker.prefetchImport(a); f.broker.prefetchImport(b);
    await f.broker.importSelected(a); await f.broker.importSelected(b);
    assert.equal(f.calls().filter(([op]) => op === 'import').length, 2);
    await assert.rejects(f.broker.importSelected(a), /invalid or expired/);
    await assert.rejects(f.broker.importSelected(b), /invalid or expired/);
    f.broker.dispose();
  });
  it('warms the first series the viewer opens, not a segmentation drawn over it', async () => {
    const f = fixture();
    const series = [{ id: 'mask', dimensions: [2, 2, 8], segmentation: { segments: [] } }, { id: 'ct', dimensions: [2, 2, 8] }];
    f.request.mock.mockImplementation(async (op: string) => op === 'import' ? Response.json({ series, warnings: [] }) : Response.json({}));
    const capabilities = await f.broker.authorizeImportPaths(['/launch/study']);
    f.broker.prefetchImport(capabilities);
    await f.broker.importSelected(capabilities);
    await waitFor(() => assert.ok(f.calls().some(([op, body]) => op === 'warm' && body?.id === 'ct')));
    assert.ok(!f.calls().some(([op, body]) => op === 'warm' && body?.id === 'mask'));
    f.broker.dispose();
  });
  it('names the engine job a cancel is for', async () => {
    const f = fixture();
    await f.broker.cancelOperation(7);
    assert.deepEqual(f.calls().at(-1), ['cancel', { id: 7 }]);
    await f.broker.cancelOperation();
    assert.deepEqual(f.calls().at(-1), ['cancel', undefined]);
    await assert.rejects(f.broker.cancelOperation(-1), { message: /Invalid operation/ });
    f.broker.dispose();
  });
  it('only issues fixed pixel routes for known series and valid frame indices', async () => {
    const f = fixture(); await f.broker.listSeries();
    assert.throws(() => f.broker.getPixels({ seriesId: '../../private', generation: 1 }), { message: /not open/ });
    assert.throws(() => f.broker.getPixels({ seriesId: 'study', generation: 1, index: 8 }), { message: /out of range/ });
    assert.throws(() => f.broker.getPixels({ seriesId: 'study', generation: 1, path: '/export' }), { message: /Invalid pixel/ });
    const capability = f.broker.getPixels({ seriesId: 'study', generation: 1, index: 7 });
    assert.match(capability.url, /^veacom:\/\/app\/_imaging\/frame\/[0-9a-f-]{36}$/);
    assert.deepEqual(Object.keys(capability).sort(), ['generation', 'url']); f.broker.dispose();
  });
  it('expires issued pixel URLs and rejects stale series objects on same-generation reimport', async () => {
    const f = fixture();
    let revision = 1;
    f.request.mock.mockImplementation(async op => op === 'import'
      ? Response.json({ series: [{ ...image, catalogRevision: revision }] })
      : new Response(new Uint8Array([revision])));
    const load = async () => f.broker.importSelected(await f.broker.authorizeImportPaths(['/synthetic']));
    await load();
    const request = { seriesId: image.id, generation: 1, revision, index: 0 };
    const old = f.broker.getPixels(request);
    revision++;
    await load();
    assert.equal((await f.broker.pixelResponse(new Request(old.url))).status, 404);
    assert.throws(() => f.broker.getPixels(request));
    await assert.rejects(f.broker.getTags(image.id, 1, 0, 1));
    const fresh = f.broker.getPixels({ ...request, revision });
    const pixels = await f.broker.pixelResponse(new Request(fresh.url));
    assert.deepEqual([...new Uint8Array(await pixels.arrayBuffer())], [2]);
    assert.deepEqual(f.calls().at(-1), ['frame', {id: image.id, index: 0, revision: 2}]);
    f.broker.dispose();
  });
  it('streams bytes and all source-identity headers, and no other header', async () => {
    const f = fixture(); await f.broker.listSeries();
    const capability = f.broker.getPixels({ seriesId: 'study', generation: 1, index: 7 });
    f.request.mock.mockImplementationOnce(async () => new Response(new Uint8Array([1,2,3,4]), { headers: {
      'Content-Type':'application/octet-stream', 'Content-Length':'4', 'X-Pixel-Type':'int16', 'X-Components':'1',
      'X-Source-Frame-Index':'7', 'X-SOP-Instance-UID':'1.2.3', 'X-Source-Frame-Number':'4',
      'Authorization':'private', 'X-Unknown':'not-forwarded',
    }}));
    const response = await f.broker.pixelResponse(new Request(capability.url));
    assert.deepEqual(f.calls().at(-1), ['frame', { id: 'study', index: 7 }]);
    assert.equal(response.headers.get('Content-Length'), '4');
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1,2,3,4]);
    assert.equal(response.headers.get('X-Source-Frame-Index'), '7');
    assert.equal(response.headers.get('X-SOP-Instance-UID'), '1.2.3');
    assert.equal(response.headers.get('X-Source-Frame-Number'), '4');
    assert.equal(response.headers.get('Authorization'), null); assert.equal(response.headers.get('X-Unknown'), null);
    assert.equal((await f.broker.pixelResponse(new Request(capability.url))).status, 404); f.broker.dispose();
  });
  it('denies foreign websites, mismatched routes and writes before consuming a pixel lease', async () => {
    const f = fixture(); await f.broker.listSeries();
    const capability = f.broker.getPixels({ seriesId: 'study', generation: 1 });
    for (const request of [new Request(capability.url,{headers:{Origin:'https://evil.example'}}),
      new Request(capability.url,{method:'POST'}),new Request(capability.url+'?path=/export'),
      new Request(capability.url.replace('/volume/','/frame/'))]) assert.ok((await f.broker.pixelResponse(request)).status >= 400);
    assert.equal(f.request.mock.callCount(), 1);
    assert.equal((await f.broker.pixelResponse(new Request(capability.url))).status, 200);
    assert.deepEqual(f.calls().at(-1), ['volume', { id: 'study' }]); f.broker.dispose();
  });
  it('passes request cancellation to the engine request and revokes leases on engine restart', async () => {
    const f = fixture(); await f.broker.listSeries();
    const capability = f.broker.getPixels({ seriesId:'study',generation:1 });
    let received: AbortSignal | undefined;
    f.request.mock.mockImplementationOnce(async (_op: string, _body?: Body, options?: Options) => {
      received = options!.signal as AbortSignal;
      return new Promise((_resolve,reject) => received!.addEventListener('abort',()=>reject(received!.reason),{once:true}));
    });
    const controller = new AbortController();
    const pending = f.broker.pixelResponse(new Request(capability.url,{signal:controller.signal}));
    controller.abort(); await assert.rejects(pending, reason => reason !== undefined); assert.equal(received?.aborted, true);
    const stale = f.broker.getPixels({seriesId:'study',generation:1});
    f.engine.generation=2; f.engine.emit('state',f.engine.state());
    assert.equal((await f.broker.pixelResponse(new Request(stale.url))).status, 404);
    assert.throws(()=>f.broker.getPixels({seriesId:'study',generation:2}), { message: /not open/ }); f.broker.dispose();
  });
  it('rejects child frames and foreign navigation even from the same webContents', () => {
    const frame = {url:'veacom://app/index.html'}, window={webContents:{mainFrame:frame}};
    assert.doesNotThrow(()=>validateApplicationSender({senderFrame:frame},window));
    assert.throws(()=>validateApplicationSender({senderFrame:{url:frame.url}},window), { message: /frame/ });
    frame.url='http://127.0.0.1:1234/'; assert.throws(()=>validateApplicationSender({senderFrame:frame},window), { message: /origin/ });
    assert.doesNotThrow(()=>validateApplicationSender({senderFrame:frame},window,'http://127.0.0.1:1234'));
    frame.url='http://127.0.0.1:5678/'; assert.throws(()=>validateApplicationSender({senderFrame:frame},window,'http://127.0.0.1:1234'), { message: /origin/ });
  });
});
