import assert from 'node:assert/strict';
import { afterEach, beforeEach, it, mock } from 'node:test';
import { restoreGlobals, stubGlobal } from './support';
import type { Series } from '../src/model';

const series: Series = {
  id: 'source', uid: '1', studyUid: '2', patientId: 'TEST', patientName: 'Synthetic',
  studyDate: '', description: '', modality: 'MR', seriesNumber: 1, engineGeneration: 1,
  dimensions: [2, 2, 8], spacing: [1, 1, 1], origin: [0, 0, 0],
  direction: [1, 0, 0, 0, 1, 0, 0, 0, 1], windowCenter: 50, windowWidth: 100,
  valueUnit: '', suvFactor: null, canReconstruct: true, warnings: [], photometricInterpretation: 'MONOCHROME2',
  frameMetadata: Array.from({ length: 8 }, (_, i) => ({ origin: [0, 0, i], direction: [1, 0, 0, 0, 1, 0, 0, 0, 1], spacing: [1, 1, 1], sopInstanceUid: '1.2.3', sourceFrameNumber: i + 1 })),
};
const headers = { 'X-Pixel-Type': 'int16', 'X-Components': '1', 'X-Source-Frame-Index': '4', 'X-SOP-Instance-UID': '1.2.3', 'X-Source-Frame-Number': '5' };
// A fresh copy of the API module for each test, with its own engine state.
let copies = 0;
const loadApi = () => import(`../src/api.ts?fresh=${++copies}`) as Promise<typeof import('../src/api')>;
beforeEach(() => {
  stubGlobal('window', { veacom: {
    getCoreState: async () => ({ status: 'ready', generation: 1, restartCount: 0 }),
    onCoreState: () => () => {},
    getPixels: async () => ({ url: 'veacom://app/_imaging/frame/test', generation: 1 }),
  } });
});
afterEach(restoreGlobals);

it('checks independent engine frame identity and retains full-series metadata with one frame of pixels', async () => {
  stubGlobal('fetch', mock.fn(async () => new Response(new Int16Array([4, 5, 6, 7]), { headers })));
  const { loadSourceFrame } = await loadApi();
  const volume = await loadSourceFrame(series, 4);
  assert.deepEqual(volume.series.dimensions, [2, 2, 8]);
  assert.equal(volume.series.frameMetadata, series.frameMetadata);
  assert.equal(volume.sourceFrameIndex, 4); assert.deepEqual([...volume.data], [4, 5, 6, 7]);
});

for (const [field, value] of [
  ['X-Source-Frame-Index', '3'], ['X-SOP-Instance-UID', '1.2.999'], ['X-Source-Frame-Number', '6'],
]) it(`rejects an unexpected ${field} instead of labelling the pixels with the requested frame`, async () => {
  stubGlobal('fetch', mock.fn(async () => new Response(new Int16Array(4), { headers: { ...headers, [field]: value } })));
  const { loadSourceFrame } = await loadApi();
  await assert.rejects(loadSourceFrame(series, 4), { message: /different source frame|source image changed/ });
});

it('rejects missing frame identity and truncated frame data', async () => {
  const fetch = mock.fn(async () => new Response(new Int16Array(3), { headers }));
  fetch.mock.mockImplementationOnce(async () => new Response(new Int16Array(4), { headers: { 'X-Pixel-Type': 'int16' } }));
  stubGlobal('fetch', fetch);
  const { loadSourceFrame } = await loadApi();
  await assert.rejects(loadSourceFrame(series, 4), { message: /different source frame/ });
  await assert.rejects(loadSourceFrame(series, 4), { message: /Incomplete image/ });
});
