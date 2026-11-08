import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { SourceFrameCache } from '../src/sourceFrames';
import type { Series, Volume } from '../src/model';

const series: Series = {
  id: 'source', uid: '1', studyUid: '2', patientId: 'TEST', patientName: 'Synthetic',
  studyDate: '', description: 'Source paging', modality: 'MR', seriesNumber: 1,
  dimensions: [2, 2, 1000], spacing: [1, 1, 1], origin: [0, 0, 0],
  direction: [1, 0, 0, 0, 1, 0, 0, 0, 1], windowCenter: 50, windowWidth: 100,
  valueUnit: '', suvFactor: null, canReconstruct: true, warnings: [], photometricInterpretation: 'MONOCHROME2',
};
const frame = (index: number): Volume => ({ series, sourceFrameIndex: index, data: new Int16Array(4).fill(index) });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

describe('source frame paging', () => {
  it('keeps pixels from two catalog revisions separate when the series ID and slice match', async () => {
    const cache = new SourceFrameCache(async (series, index) => ({ ...frame(index), series, data: new Int16Array([series.catalogRevision!]) }));
    assert.equal((await cache.get({ ...series, catalogRevision: 1 }, 0)).data[0], 1);
    assert.equal((await cache.get({ ...series, catalogRevision: 2 }, 0)).data[0], 2);
    cache.dispose();
  });
  it('loads a requested frame without allocating a complete stack and coalesces linked panes', async () => {
    const pending = deferred<Volume>();
    const loader = mock.fn(() => pending.promise);
    const cache = new SourceFrameCache(loader);
    const first = cache.get(series, 999), second = cache.get(series, 999);
    await flush(); assert.equal(loader.mock.callCount(), 1);
    pending.resolve(frame(999));
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a, b); assert.equal(a.data.length, 4);
    assert.equal(a.series.dimensions[2], 1000);
    assert.equal(await cache.get(series, 999), a);
    cache.dispose();
  });

  it('cancels one pane without cancelling another pane requesting the same frame', async () => {
    const pending = deferred<Volume>(); let loaderSignal!: AbortSignal;
    const cache = new SourceFrameCache((_series, _index, signal) => { loaderSignal = signal; return pending.promise; });
    const controller = new AbortController();
    const cancelled = cache.get(series, 7, controller.signal).catch(error => error);
    const wanted = cache.get(series, 7);
    await flush(); controller.abort();
    assert.equal((await cancelled).name, 'AbortError'); assert.equal(loaderSignal.aborted, false);
    pending.resolve(frame(7)); assert.equal((await wanted).sourceFrameIndex, 7);
    cache.dispose();
  });

  it('bounds concurrent decoding and drops obsolete queued scroll requests', async () => {
    const pending = deferred<Volume>();
    const loader = mock.fn((_series: Series, index: number) => index === 1 ? pending.promise : Promise.resolve(frame(index)));
    const cache = new SourceFrameCache(loader, 64, 8, 1);
    const first = cache.get(series, 1);
    const controller = new AbortController();
    const stale = cache.get(series, 2, controller.signal).catch(error => error);
    const latest = cache.get(series, 3);
    await flush(); assert.equal(loader.mock.callCount(), 1);
    controller.abort(); assert.equal((await stale).name, 'AbortError');
    pending.resolve(frame(1)); await first;
    assert.equal((await latest).sourceFrameIndex, 3);
    assert.deepEqual(loader.mock.calls.map(call => call.arguments[1]), [1, 3]);
    cache.dispose();
  });

  it('cannot repopulate the cache with stale pixels after reimport', async () => {
    const old = deferred<Volume>();
    const loader = mock.fn((_series: Series, index: number) => Promise.resolve(frame(index)));
    loader.mock.mockImplementationOnce(() => old.promise);
    const cache = new SourceFrameCache(loader);
    const stale = cache.get(series, 4).catch(error => error);
    await flush(); cache.invalidate([series.id]);
    assert.equal((await stale).name, 'AbortError');
    const fresh = await cache.get(series, 4);
    old.resolve({ ...frame(4), data: new Int16Array(4).fill(30000) });
    await flush(); assert.equal(await cache.get(series, 4), fresh);
    assert.equal(fresh.data[0], 4); cache.dispose();
  });

  it('evicts by byte and frame limits while retaining recently viewed frames', async () => {
    const loader = mock.fn((_series: Series, index: number) => Promise.resolve(frame(index)));
    const cache = new SourceFrameCache(loader, 16, 2);
    await cache.get(series, 1); await cache.get(series, 2); await cache.get(series, 1); await cache.get(series, 3);
    await cache.get(series, 1); assert.equal(loader.mock.callCount(), 3);
    await cache.get(series, 2); assert.equal(loader.mock.callCount(), 4);
    cache.dispose();
  });

  it('does not cache decoder failures or accept a mismatched frame', async () => {
    const loader = mock.fn<(series: Series, index: number) => Promise<Volume>>();
    loader.mock.mockImplementationOnce(async () => { throw new Error('Truncated source'); }, 0);
    loader.mock.mockImplementationOnce(async () => frame(2), 1);
    loader.mock.mockImplementationOnce(async () => frame(1), 2);
    const cache = new SourceFrameCache(loader);
    await assert.rejects(cache.get(series, 1), { message: /Truncated source/ });
    await assert.rejects(cache.get(series, 1), { message: /different source frame/ });
    assert.equal((await cache.get(series, 1)).data[0], 1);
    assert.equal(loader.mock.callCount(), 3); cache.dispose();
  });

  it('aborts pending work on disposal and refuses new requests', async () => {
    const pending = deferred<Volume>(); let loaderSignal!: AbortSignal;
    const cache = new SourceFrameCache((_series, _index, signal) => { loaderSignal = signal; return pending.promise; });
    const result = cache.get(series, 0).catch(error => error);
    await flush(); cache.dispose();
    assert.equal(loaderSignal.aborted, true); assert.equal((await result).name, 'AbortError');
    await assert.rejects(cache.get(series, 0), { name: 'AbortError' });
    pending.resolve(frame(0)); await flush();
  });
});
