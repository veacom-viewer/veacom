import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { Annotation, Series, ViewState, ViewVolume } from '../src/model';
import { resolveSphere } from '../src/imaging/useMeasuredSpheres';
import { nativeView } from '../src/imaging/nativeRender';
import { DISPLAY_CURVES, LOG_CURVE_K } from '../src/imaging/displayCurve';

const series = { id: 'pet', sourceRevision: 1, engineGeneration: 1, modality: 'PT', components: 1, canReconstruct: true,
  dimensions: [9, 9, 9], origin: [0, 0, 0], spacing: [2, 2, 2], direction: [1,0,0,0,1,0,0,0,1] } as Series;
const volume: ViewVolume = { series, data: null };
const sphere: Annotation = { id: 'lesion', type: 'sphere', plane: 'axial', slice: 4, points: [[8,8,8],[10,8,8]] };

it('retries a busy engine, shares the pending request, and can remeasure the same sphere after failure', async t => {
  let calls = 0, busy = true;
  const bridge = {
    onCoreState() {}, getCoreState: async () => ({ status: 'ready', generation: 1 }),
    async measure() {
      calls++;
      if (busy || calls === 4) throw new Error('Imaging engine is busy');
      return { unit: 'SUVbw', count: 1, mean: 2, min: 2, max: 2, standardDeviation: 0, maxAt: [8,8,8],
        volumeMl: 1, diameterMm: 4, clipped: false, invalidCount: 0, paddingCount: 0 };
    },
  };
  const previous = globalThis.window;
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { veacom: bridge } });
  t.after(() => previous === undefined ? Reflect.deleteProperty(globalThis, 'window') : Object.assign(globalThis, { window: previous }));
  const first = resolveSphere(sphere, volume);
  assert.equal(resolveSphere(sphere, volume), first);
  await assert.rejects(first, /busy/);
  assert.equal(calls, 3);
  busy = false;
  assert.equal((await resolveSphere(sphere, volume))?.max, 2);
  assert.equal((await resolveSphere(sphere, volume))?.max, 2);
  assert.equal(calls, 5);
});

it('sends the selected PET curve on both axial and projection views', () => {
  const view = { mode: 'mpr', plane: 'axial', slice: 1, zoom: 1, pan: [0,0], rotation: 0,
    flipX: false, flipY: false, inverted: false, windowCenter: 10.5, windowWidth: 21 } as ViewState;
  for (const projection of [undefined, 'mip'] as const) for (const curve of ['linear','sqrt','log'] as const) {
    const request = nativeView(volume, { ...view, projection, curve }, 32, 32, 32);
    assert.equal(request.curve, DISPLAY_CURVES[curve]);
    assert.equal(request.logCurveK, LOG_CURVE_K);
  }
});
