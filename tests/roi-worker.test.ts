import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { assertClose, assertFields, waitFor } from './support';
import type { Annotation, PixelArray, Series, Vec3, Volume } from '../src/model';
import { roiStatistics } from '../src/imaging/annotations';
import { RoiStatisticsService, type RoiWorkerLike } from '../src/imaging/roiStatisticsService';
import { createRoiWorkerHandler, ROI_COPY_CHUNK_BYTES, type RoiFrameDescriptor, type RoiWorkerRequest, type RoiWorkerResult } from '../src/imaging/roiStatistics.worker';

const base: Series = {
  id: 'roi-worker-source', uid: '1.2.3', studyUid: '1.2', patientId: 'TEST', patientName: 'Synthetic',
  studyDate: '', description: 'Known source pixels', modality: 'CT', seriesNumber: 1,
  dimensions: [2, 2, 1], spacing: [1, 1, 1], origin: [0, 0, 0],
  direction: [1, 0, 0, 0, 1, 0, 0, 0, 1], windowCenter: 40, windowWidth: 400,
  valueUnit: 'HU', suvFactor: null, canReconstruct: false, spacingKnown: true,
  warnings: [], photometricInterpretation: 'MONOCHROME2', engineGeneration: 1,
};
const source = (data: PixelArray = new Int16Array([0, 100, 100, 0]), metadata: Partial<Series> = {}): Volume => ({ series: { ...base, ...metadata }, data });
const outline = (id = 'roi'): Annotation => ({
  id, type: 'rectangle', mode: 'source', sourceFrame: 0, plane: 'axial', slice: 0,
  points: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]],
});

/** Real structured-clone transfers, without a browser, native process, or GPU. */
class LocalWorker implements RoiWorkerLike {
  onmessage: RoiWorkerLike['onmessage'] = null;
  onerror: RoiWorkerLike['onerror'] = null;
  onmessageerror: RoiWorkerLike['onmessageerror'] = null;
  readonly messages: RoiWorkerRequest[] = [];
  readonly replies: RoiWorkerResult[] = [];
  readonly transferred: Transferable[] = [];
  readonly held: RoiWorkerRequest[] = [];
  readonly hold = new Set<RoiWorkerRequest['type']>();
  terminated = false;
  throwOn: RoiWorkerRequest['type'] | null = null;
  onPost?: (message: RoiWorkerRequest) => void;
  transformReply?: (reply: RoiWorkerResult) => RoiWorkerResult;
  private receive = createRoiWorkerHandler(reply => {
    this.replies.push(reply);
    queueMicrotask(() => {
      if (!this.terminated) this.onmessage?.({ data: this.transformReply?.(reply) ?? reply } as MessageEvent<RoiWorkerResult>);
    });
  });

  postMessage(message: RoiWorkerRequest, transfer: Transferable[] = []): void {
    if (message.type === this.throwOn) throw new Error('Worker postMessage failed.');
    const clone = structuredClone(message, { transfer });
    this.messages.push(clone);
    this.transferred.push(...transfer);
    this.onPost?.(clone);
    queueMicrotask(() => {
      if (this.terminated) return;
      if (this.hold.has(clone.type)) this.held.push(clone);
      else this.receive(clone);
    });
  }
  release(type: RoiWorkerRequest['type']): void {
    this.hold.delete(type);
    const selected = this.held.filter(message => message.type === type);
    for (const message of selected) {
      this.held.splice(this.held.indexOf(message), 1);
      if (!this.terminated) this.receive(message);
    }
  }
  terminate(): void { this.terminated = true; }
}

const services: RoiStatisticsService[] = [];
function service(configure: (worker: LocalWorker, index: number) => void = () => {}) {
  const workers: LocalWorker[] = [];
  const instance = new RoiStatisticsService(() => {
    const worker = new LocalWorker();
    configure(worker, workers.length); workers.push(worker);
    return worker;
  });
  services.push(instance);
  return { instance, workers };
}
afterEach(() => { for (const instance of services.splice(0)) instance.dispose(); });
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const chunks = (worker: LocalWorker) => worker.messages.filter((message): message is Extract<RoiWorkerRequest, { type: 'chunk' }> => message.type === 'chunk');
const begins = (worker: LocalWorker) => worker.messages.filter((message): message is Extract<RoiWorkerRequest, { type: 'begin' }> => message.type === 'begin');

describe('shared source ROI worker service', () => {
  it('returns exact source statistics and coalesces consumers without transferring the original pixels', async () => {
    const f = service(worker => worker.hold.add('measure'));
    const volume = source(), annotation = outline();
    const first = f.instance.request(annotation, volume);
    const second = f.instance.request(annotation, { ...volume });
    await waitFor(() => assert.equal(f.workers[0]?.held.some(message => message.type === 'measure'), true));
    const cancelled = assert.rejects(first.promise, { name: 'AbortError' });
    first.cancel(); await cancelled;
    assert.equal(f.workers[0].terminated, false);
    f.workers[0].release('measure');
    const stats = await second.promise;
    assertFields(stats, { count: 4, mean: 50, min: 0, max: 100, standardDeviation: 50, sampling: 'source-voxels', downsampled: false });
    assert.deepEqual(stats, roiStatistics(annotation, volume));
    assert.equal(begins(f.workers[0]).length, 1);
    assert.equal(f.workers[0].messages.filter(message => message.type === 'measure').length, 1);
    assert.ok(!f.workers[0].transferred.includes(volume.data.buffer));
    assert.equal(volume.data.byteLength, 8);
    assert.deepEqual([...volume.data], [0, 100, 100, 0]);
    assert.equal((f.workers[0].transferred[0] as ArrayBuffer).byteLength, 0);
  });

  it('copies only the identity-selected Float64 frame while preserving full metadata for SOP resolution', async () => {
    const f = service();
    const values = [16777217, 16777218, 16777219, 16777220];
    const data = new Float64Array([100, 101, 102, 103, 200, 201, 202, 203, 300, 301, 302, 303, ...values]);
    const volume = source(data, { dimensions: [2, 2, 4], pixelType: 'float64', origin: [0, 0, 31], frameMetadata: [31, 32, 33, 30].map((z, index) => ({
      origin: [0, 0, z], direction: base.direction, spacing: [1, 1, 1],
      sopInstanceUid: index === 3 ? 'original-sop' : `other-${index}`, sourceFrameNumber: 1,
    })) });
    const annotation: Annotation = { ...outline(), sourceSopInstanceUid: 'original-sop', sourceFrameNumber: 1,
      points: [[0, 0, 30], [1, 0, 30], [1, 1, 30], [0, 1, 30]] };
    const stats = await f.instance.request(annotation, volume).promise;
    assertFields(stats, { count: 4, mean: 16777218.5, min: 16777217, max: 16777220 });
    assertClose(stats!.standardDeviation, Math.sqrt(1.25));
    const descriptor = begins(f.workers[0])[0].descriptor;
    assert.equal(descriptor.sourceFrameIndex, 3);
    assert.deepEqual(descriptor.series.dimensions, [2, 2, 4]);
    assert.equal(descriptor.series.frameMetadata?.length, 4);
    assert.equal(descriptor.byteLength, 32);
    assert.deepEqual(chunks(f.workers[0]).map(message => message.bytes.byteLength), [32]);
    assert.deepEqual([...new Float64Array(chunks(f.workers[0])[0].bytes)], values);
    assert.equal(data.byteLength, 128);
    assert.deepEqual([...data.slice(12)], values);
  });

  it('bounds chunks at 4 MiB and yields to timers before copying the next chunk', async () => {
    let yielded = false, secondChunkSawYield = false;
    const f = service(worker => {
      worker.onPost = message => {
        if (message.type !== 'chunk') return;
        if (chunks(worker).length === 1) setTimeout(() => { yielded = true; }, 0);
        else secondChunkSawYield = yielded;
      };
    });
    const data = new Uint8Array(2048 * 2049).fill(7);
    const volume = source(data, { dimensions: [2048, 2049, 1], pixelType: 'uint8' });
    const stats = await f.instance.request(outline(), volume).promise;
    assertFields(stats, { count: 4, mean: 7, min: 7, max: 7, standardDeviation: 0 });
    assert.deepEqual(chunks(f.workers[0]).map(message => message.bytes.byteLength), [ROI_COPY_CHUNK_BYTES, 2048]);
    assert.equal(secondChunkSawYield, true);
    assert.equal(data.byteLength, 2048 * 2049);
    assert.equal(data[0], 7); assert.equal(data[data.length - 1], 7);
  });

  it('reuses cached frame bytes but applies fresh calibration and quantitative metadata', async () => {
    const f = service(), annotation = outline();
    const volume = source(new Int16Array([0, 100, 100, 0]), { modality: 'PT', valueUnit: 'BQML', suvFactor: 0.1 });
    assertFields(await f.instance.request(annotation, volume).promise, { mean: 5, max: 10, unit: 'SUVbw' });
    const updated: Volume = { ...volume, series: { ...volume.series, suvFactor: 0.2, measurementScale: 2 } };
    assertFields(await f.instance.request(annotation, updated).promise, { mean: 10, max: 20, area: 4, unit: 'SUVbw' });
    assert.equal(chunks(f.workers[0]).length, 1);
    assert.deepEqual(f.workers[0].replies.filter(reply => reply.type === 'ready').map(reply => reply.cached), [false, true]);
    assert.equal(begins(f.workers[0])[0].descriptor.key, begins(f.workers[0])[1].descriptor.key);
  });

  it('gives a PET in the SUV the reader chose, off the interface thread too', async () => {
    const f = service(), annotation = outline();
    const volume = source(new Int16Array([0, 100, 100, 0]), { modality: 'PT', valueUnit: 'BQML', suvFactor: 0.1, sulFactor: 0.08, suvNormalization: 'lbm' });
    assertFields(await f.instance.request(annotation, volume).promise, { mean: 4, max: 8, unit: 'SUL' });
  });

  for (const level of ['series', 'frame'] as const) it(`refreshes ${level} NaN-padding metadata without copying or modifying cached pixels`, async () => {
    const f = service(), annotation = outline();
    const pixels = new Float64Array([NaN, 10, 20, 30]);
    const originalBytes = new Uint8Array(pixels.buffer).slice();
    const volume = source(pixels, {
      pixelType: 'float64', paddingIsNaN: false,
      ...(level === 'frame' ? { frameMetadata: [{ origin: base.origin, direction: base.direction, spacing: base.spacing, paddingIsNaN: false }] } : {}),
    });
    assertFields(await f.instance.request(annotation, volume).promise, {
      count: 3, mean: 20, min: 10, max: 30, invalidCount: 1, paddingCount: 0,
    });
    const updated: Volume = { ...volume, series: level === 'series'
      ? { ...volume.series, paddingIsNaN: true }
      : { ...volume.series, frameMetadata: [{ ...volume.series.frameMetadata![0], paddingIsNaN: true }] } };
    const result = await f.instance.request(annotation, updated).promise;
    assertFields(result, { count: 3, mean: 20, min: 10, max: 30, invalidCount: 0, paddingCount: 1 });
    assertClose(result!.standardDeviation, Math.sqrt(200 / 3));
    assert.equal(chunks(f.workers[0]).length, 1);
    assert.deepEqual(f.workers[0].replies.filter(reply => reply.type === 'ready').map(reply => reply.cached), [false, true]);
    assert.equal(begins(f.workers[0])[0].descriptor.key, begins(f.workers[0])[1].descriptor.key);
    assert.deepEqual(new Uint8Array(pixels.buffer), originalBytes);
    assert.equal(Number.isNaN(pixels[0]), true);
  });

  it('does not reuse old frame bytes when reimport returns a new array under the same series ID', async () => {
    const f = service(), annotation = outline();
    const original = source();
    await f.instance.request(annotation, original).promise;
    const reimported: Volume = { series: original.series, data: new Int16Array([10, 20, 30, 40]) };
    const stats = await f.instance.request(annotation, reimported).promise;
    assertFields(stats, { count: 4, mean: 25, min: 10, max: 40 });
    assertClose(stats!.standardDeviation, Math.sqrt(125));
    assert.equal(chunks(f.workers[0]).length, 2);
    assert.notEqual(begins(f.workers[0])[0].descriptor.version, begins(f.workers[0])[1].descriptor.version);
    assert.notEqual(begins(f.workers[0])[0].descriptor.key, begins(f.workers[0])[1].descriptor.key);
  });

  it('includes engine generation in frame identity even if a retained source array is reused', async () => {
    const f = service(), annotation = outline(), volume = source();
    await f.instance.request(annotation, volume).promise;
    const replacement: Volume = { ...volume, series: { ...volume.series, engineGeneration: 2 } };
    await f.instance.request(annotation, replacement).promise;
    assert.equal(chunks(f.workers[0]).length, 2);
    assert.notEqual(begins(f.workers[0])[0].descriptor.key, begins(f.workers[0])[1].descriptor.key);
  });

  it('cancels a queued request before copying any of its pixels', async () => {
    const f = service(worker => worker.hold.add('measure'));
    const active = f.instance.request(outline('active'), source());
    await waitFor(() => assert.equal(f.workers[0]?.held.length, 1));
    const queued = f.instance.request(outline('queued'), source(new Int16Array([10, 20, 30, 40])));
    const cancelled = assert.rejects(queued.promise, { name: 'AbortError' });
    queued.cancel(); await cancelled;
    f.workers[0].release('measure'); await active.promise;
    assert.equal(begins(f.workers[0]).length, 1);
    assert.equal(f.workers[0].terminated, false);
  });

  it('terminates obsolete active work, continues queued work in a new worker and ignores stale replies', async () => {
    const f = service(worker => worker.hold.add('measure'));
    const active = f.instance.request(outline('obsolete'), source());
    await waitFor(() => assert.equal(f.workers[0]?.held.length, 1));
    const oldCallback = f.workers[0].onmessage!;
    const oldId = f.workers[0].held[0].id;
    const queued = f.instance.request(outline('current'), source(new Int16Array([10, 20, 30, 40])));
    let settled = false;
    void queued.promise.then(() => { settled = true; }, () => { settled = true; });
    const cancelled = assert.rejects(active.promise, { name: 'AbortError' });
    active.cancel(); await cancelled;
    assert.equal(f.workers[0].terminated, true);
    await waitFor(() => assert.equal(f.workers[1]?.held.length, 1));
    oldCallback({ data: { type: 'result', id: oldId, statistics: null } } as MessageEvent<RoiWorkerResult>);
    await Promise.resolve();
    assert.equal(settled, false);
    f.workers[1].release('measure');
    assertFields(await queued.promise, { count: 4, mean: 25, max: 40 });
  });

  it('stops a multi-chunk copy after cancellation at the first yield', async () => {
    let request!: ReturnType<RoiStatisticsService['request']>;
    const f = service(worker => {
      worker.onPost = message => {
        if (message.type === 'chunk' && chunks(worker).length === 1) setTimeout(() => request.cancel(), 0);
      };
    });
    const data = new Uint8Array(2048 * 2049).fill(7);
    request = f.instance.request(outline(), source(data, { dimensions: [2048, 2049, 1], pixelType: 'uint8' }));
    await assert.rejects(request.promise, { name: 'AbortError' });
    await tick();
    assert.equal(chunks(f.workers[0]).length, 1);
    assert.equal(f.workers[0].terminated, true);
    assert.equal(data.byteLength, 2048 * 2049);
    assert.equal(data[0], 7);
  });

  for (const failure of ['error', 'messageerror'] as const) it(`rejects all pending requests explicitly on worker ${failure}`, async () => {
    const f = service(worker => worker.hold.add('measure'));
    const first = f.instance.request(outline('first'), source());
    const second = f.instance.request(outline('second'), source());
    const firstFailed = assert.rejects(first.promise);
    const secondFailed = assert.rejects(second.promise);
    await waitFor(() => assert.equal(f.workers[0]?.held.length, 1));
    if (failure === 'error') f.workers[0].onerror!({ message: 'Worker crashed.', preventDefault() {} } as ErrorEvent);
    else f.workers[0].onmessageerror!({} as MessageEvent);
    await Promise.all([firstFailed, secondFailed]);
    assert.equal(f.workers[0].terminated, true);
  });

  it('rejects all pending requests when worker construction throws and leaves the pump usable', async () => {
    const factory = mock.fn((): RoiWorkerLike => {
      if (factory.mock.callCount() === 0) throw new Error('Worker construction failed.'); // a call counts once it returns
      return new LocalWorker();
    });
    const instance = new RoiStatisticsService(factory); services.push(instance);
    const first = instance.request(outline('first'), source());
    const second = instance.request(outline('second'), source());
    await Promise.all([
      assert.rejects(first.promise, { message: /Worker construction failed\./ }),
      assert.rejects(second.promise, { message: /Worker construction failed\./ }),
    ]);
    assert.equal(factory.mock.callCount(), 1);
    assertFields(await instance.request(outline('explicit-new-request'), source()).promise, { count: 4, mean: 50, max: 100 });
    assert.equal(factory.mock.callCount(), 2);
  });

  it('creates a fresh worker for a later explicit request without replaying requests rejected by a fatal error', async () => {
    const f = service((worker, index) => { if (index === 0) worker.hold.add('measure'); });
    const first = f.instance.request(outline('failed-active'), source());
    const second = f.instance.request(outline('failed-queued'), source());
    const firstFailed = assert.rejects(first.promise, { message: /Worker crashed\./ });
    const secondFailed = assert.rejects(second.promise, { message: /Worker crashed\./ });
    await waitFor(() => assert.equal(f.workers[0]?.held.length, 1));
    f.workers[0].onerror!({ message: 'Worker crashed.', preventDefault() {} } as ErrorEvent);
    await Promise.all([firstFailed, secondFailed]);
    assert.equal(f.workers.length, 1);
    const fresh = f.instance.request(outline('explicit-new-request'), source(new Int16Array([10, 20, 30, 40])));
    assertFields(await fresh.promise, { count: 4, mean: 25, max: 40 });
    assert.equal(f.workers.length, 2);
    assert.equal(begins(f.workers[1]).length, 1);
    assert.deepEqual(f.workers[1].messages.filter(message => message.type === 'measure').map(message => message.annotation.id), ['explicit-new-request']);
  });

  it('rejects a postMessage failure without detaching the source buffer', async () => {
    const f = service(worker => { worker.throwOn = 'chunk'; });
    const volume = source();
    await assert.rejects(f.instance.request(outline(), volume).promise);
    assert.equal(f.workers[0].terminated, true);
    assert.deepEqual([...volume.data], [0, 100, 100, 0]);
    assert.equal(volume.data.byteLength, 8);
  });

  it('rejects an out-of-order worker acknowledgement instead of leaving a request pending', async () => {
    const f = service(worker => {
      worker.transformReply = reply => reply.type === 'ready' ? { type: 'received', id: reply.id, offset: 999 } : reply;
    });
    await assert.rejects(f.instance.request(outline(), source()).promise);
    assert.equal(f.workers[0].terminated, true);
  });
});

describe('source ROI worker protocol and bounded cache', () => {
  const descriptor = (key: string, version = 1): RoiFrameDescriptor => ({ key, version, series: { ...base, pixelType: 'float32' }, sourceFrameIndex: 0, pixelType: 'float32', byteLength: 16 });
  function direct(cacheBytes: number) {
    const replies: RoiWorkerResult[] = [];
    const receive = createRoiWorkerHandler(reply => replies.push(reply), cacheBytes);
    const begin = (id: number, key: string, version = 1) => {
      receive({ type: 'begin', id, descriptor: descriptor(key, version) });
      const reply = replies.at(-1);
      assert.equal(reply?.type, 'ready');
      return (reply).cached;
    };
    const commit = (id: number) => {
      receive({ type: 'chunk', id, offset: 0, bytes: new Float32Array([0, 100, 100, 0]).buffer });
      receive({ type: 'commit', id });
      assert.deepEqual(replies.at(-1), { type: 'committed', id });
    };
    return { receive, replies, begin, commit };
  }

  it('evicts the least recently used complete frame within its byte budget', () => {
    const f = direct(32);
    assert.equal(f.begin(1, 'a'), false); f.commit(1);
    assert.equal(f.begin(2, 'b'), false); f.commit(2);
    assert.equal(f.begin(3, 'a'), true);
    assert.equal(f.begin(4, 'c'), false); f.commit(4);
    assert.equal(f.begin(5, 'a'), true);
    assert.equal(f.begin(6, 'b'), false);
  });

  it('measures oversized frames exactly but does not retain them in the cache', async () => {
    const f = direct(8);
    assert.equal(f.begin(1, 'large'), false); f.commit(1);
    f.receive({ type: 'measure', id: 1, annotation: outline() });
    await waitFor(() => assert.equal(f.replies.at(-1)?.type, 'result'));
    const result = f.replies.at(-1) as Extract<RoiWorkerResult, { type: 'result' }>;
    assertFields(result.statistics, { count: 4, mean: 50, min: 0, max: 100, standardDeviation: 50 });
    assert.equal(f.begin(2, 'large'), false);
  });

  it('refuses a descriptor whose dimensions are not three sizes', () => {
    const f = direct(32);
    // As a faulty sender could post it: the fourth size leaves the byte count matching.
    f.receive({ type: 'begin', id: 1, descriptor: { ...descriptor('four'), series: { ...base, pixelType: 'float32', dimensions: [2, 2, 1, 1] as unknown as Vec3 } } });
    assertFields(f.replies.at(-1), { type: 'error', id: 1, message: 'ROI measurement requires valid scalar source frames.' });
  });

  it('discards partial uploads after protocol errors and rejects incomplete commits', () => {
    const f = direct(32);
    f.begin(1, 'partial');
    f.receive({ type: 'chunk', id: 1, offset: 4, bytes: new Float32Array([100]).buffer });
    assertFields(f.replies.at(-1), { type: 'error', id: 1 });
    assert.equal(f.begin(2, 'partial'), false);
    f.receive({ type: 'chunk', id: 2, offset: 0, bytes: new Float32Array([100]).buffer });
    f.receive({ type: 'commit', id: 2 });
    assertFields(f.replies.at(-1), { type: 'error', id: 2 });
    assert.equal(f.begin(3, 'partial'), false); f.commit(3);
  });

  it('cancels staged bytes and ignores stale generation messages', () => {
    const f = direct(32);
    f.begin(1, 'old');
    f.receive({ type: 'chunk', id: 1, offset: 0, bytes: new Float32Array([100]).buffer });
    f.receive({ type: 'cancel', id: 1 });
    assert.equal(f.begin(2, 'old'), false);
    const before = f.replies.length;
    f.receive({ type: 'chunk', id: 1, offset: 4, bytes: new Float32Array([100]).buffer });
    f.receive({ type: 'begin', id: 1, descriptor: descriptor('old') });
    assert.equal(f.replies.length, before);
    f.commit(2);
  });
});
