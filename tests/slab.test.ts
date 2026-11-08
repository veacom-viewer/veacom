import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertClose } from './support';
import { acquiredPlane, halfWidth, MAX_SLAB_HALF, slabSampling } from '../src/imaging/slab';
import type { Series, ViewState } from '../src/model';

const series = (overrides: Partial<Series> = {}): Series => ({
  id: 's', uid: 'u', studyUid: 'study', patientId: 'P', patientName: 'Synthetic', studyDate: '', description: '', modality: 'CT',
  seriesNumber: 1, dimensions: [64, 64, 80], spacing: [0.5, 0.5, 2.5], origin: [0, 0, 0], direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  windowCenter: 40, windowWidth: 400, valueUnit: 'HU', suvFactor: null, canReconstruct: true, warnings: [], photometricInterpretation: 'MONOCHROME2', ...overrides,
} as Series);
const view = (plane: ViewState['plane'], slab?: ViewState['slab']): ViewState => ({ plane, slice: 10, windowCenter: 40, windowWidth: 400, zoom: 1, pan: [0, 0], rotation: 0, flipX: false, flipY: false, inverted: false, mode: 'mpr', slab });

describe('thick slab as in VEAcom Next', () => {
  it('takes the slices whose centres lie within half the thickness', () => {
    assert.equal(halfWidth(10, 2.5), 2);
    assert.equal(halfWidth(5, 2.5), 1);
    assert.equal(halfWidth(40, 0.5), 40);
    assert.equal(halfWidth(10, 0), 0);
  });
  it('knows the plane a series was acquired in', () => {
    assert.equal(acquiredPlane(series()), 'axial');
    assert.equal(acquiredPlane(series({ direction: [1, 0, 0, 0, 0, -1, 0, 1, 0] })), 'coronal');
    assert.equal(acquiredPlane(series({ direction: [0, 0, 1, 1, 0, 0, 0, 1, 0] })), 'sagittal');
  });
  it('steps along the plane normal in index space, and samples a thick slab more coarsely', () => {
    assert.deepEqual(slabSampling(series(), view('axial')), { mode: 0, half: 0, step: [0, 0, 0] });
    const axial = slabSampling(series(), view('axial', { mode: 'mip', thickness: 10 }));
    assert.equal(axial.mode, 1);
    assert.equal(axial.half, 2);
    assert.deepEqual(axial.step.map(v => Math.abs(v)), [0, 0, 1]); // one 2.5 mm slice
    assert.equal(slabSampling(series(), view('coronal', { mode: 'mean', thickness: 40 })).half, 40); // 0.5 mm rows
    const fine = series({ spacing: [0.25, 0.25, 2.5], dimensions: [128, 128, 80] });
    const coronal = slabSampling(fine, view('coronal', { mode: 'mean', thickness: 40 }));
    assert.equal(coronal.mode, 3);
    assert.equal(coronal.half, MAX_SLAB_HALF); // 40 mm of 0.25 mm rows would be 80 either side: capped
    assertClose(Math.abs(coronal.step[1]) * 0.25 * 2 * MAX_SLAB_HALF, 40);
  });
});
