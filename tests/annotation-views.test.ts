import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertFields } from './support';
import { shownOnView, viewOfAnnotation } from '../src/imaging/annotations';
import { add, getPlaneFrame, scale } from '../src/imaging/geometry';
import { checklistSummary } from '../src/ui/preopChecklist';
import type { Annotation, Series, Vec3, ViewState } from '../src/model';

const series = {
  id: 's', uid: 'u', studyUid: 'study', patientId: 'P', patientName: 'Synthetic', studyDate: '', description: '', modality: 'CT',
  seriesNumber: 1, dimensions: [64, 64, 64], spacing: [1, 1, 1], origin: [0, 0, 0], direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  windowCenter: 40, windowWidth: 400, valueUnit: 'HU', suvFactor: null, canReconstruct: true, orientationKnown: true, warnings: [], photometricInterpretation: 'MONOCHROME2',
} as Series;
const view = (slice: number, oblique?: [number, number]): ViewState => ({ plane: 'axial', slice, windowCenter: 40, windowWidth: 400, zoom: 1, pan: [0, 0], rotation: 0,
  flipX: false, flipY: false, inverted: false, mode: 'mpr', oblique });
/** A length across the plane `shown` displays, recorded as the viewport records it. */
function lengthOn(shown: ViewState): Annotation {
  const frame = getPlaneFrame(series, shown);
  const points: Vec3[] = [add(frame.center, scale(frame.v, -20)), add(frame.center, scale(frame.v, 20))];
  return { id: crypto.randomUUID(), type: 'length', points, mode: 'mpr', plane: shown.plane, slice: shown.slice,
    ...(shown.oblique?.some(Boolean) ? { oblique: shown.oblique } : {}) };
}

describe('measurements on tilted planes', () => {
  const tilted = view(32, [25, 0]), plain = view(32);
  const onTilted = lengthOn(tilted), onPlain = lengthOn(plain);

  it('are shown, and deleted with "Delete on slice", only on the plane they were drawn on', () => {
    assert.equal(shownOnView(onTilted, series, tilted), true);
    // Same plane name and slice number, no tilt: the measurement is not there, so it must not be deleted there.
    assert.equal(shownOnView(onTilted, series, plain), false);
    assert.equal(shownOnView(onPlain, series, plain), true);
    assert.equal(shownOnView(onPlain, series, tilted), false);
  });

  it('go back to their own tilt, and a plain one undoes a tilt the pane has now', () => {
    assert.deepEqual(onTilted.oblique, [25, 0]);
    assert.deepEqual(viewOfAnnotation(onTilted, null), { mode: 'mpr', plane: 'axial', slice: 32, oblique: [25, 0], projection: undefined });
    assert.deepEqual(viewOfAnnotation(onPlain, null), { mode: 'mpr', plane: 'axial', slice: 32, oblique: [0, 0], projection: undefined });
    const source: Annotation = { ...onPlain, mode: 'source', sourceFrame: 7, slice: 7 };
    assert.deepEqual(viewOfAnnotation(source, 9), { mode: 'source', plane: 'axial', slice: 9, oblique: undefined, projection: undefined });
  });

  it('are not shown in a whole-volume MIP, and "Go to" leaves the MIP for their own plane', () => {
    // Nothing drawn lies in a MIP, not even a measurement on the plane through the volume that it is seen across.
    const mip: ViewState = { ...plain, projection: 'mip' };
    assert.equal(shownOnView(onPlain, series, mip), false);
    assert.equal(shownOnView(lengthOn(mip), series, mip), false);
    for (const annotation of [onPlain, onTilted]) {
      const after: ViewState = { ...mip, ...viewOfAnnotation(annotation, null) };
      assert.equal(after.projection, undefined);
      assert.equal(shownOnView(annotation, series, after), true);
    }
    const source: Annotation = { ...onPlain, mode: 'source', sourceFrame: 7, slice: 7 };
    assertFields({ ...mip, ...viewOfAnnotation(source, 7) }, { mode: 'source', slice: 7, projection: undefined });
  });

  it('name the tilt in the pre-operative summary', () => {
    const note = { seriesId: 's', slice: 200, shown: '201/596', plane: 'coronal', mode: 'mpr', oblique: [35, 0] as [number, number], tilt: 35 };
    const answers = { sscd: { right: 'present', left: 'absent' } };
    const english = checklistSummary('temporal', answers, { sscd: note }, 'en');
    assert.ok(english.includes('(slice 201/596, coronal oblique 35°)'));
    assert.ok(checklistSummary('temporal', answers, { sscd: note }, 'tr').includes('(kesit 201/596, koronal oblik 35°)'));
    assert.ok(checklistSummary('temporal', answers, { sscd: { ...note, oblique: undefined, tilt: undefined } }, 'en').includes('(slice 201/596)'));
  });
});
