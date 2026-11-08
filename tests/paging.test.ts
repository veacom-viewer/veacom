import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Series } from '../src/model';
import { openingSlice, pageStep, pagesBackwards } from '../src/imaging/paging';

// Synthetic stacks with no frame metadata: the volume geometry alone places the slices.
const stack = (direction: number[], slices = 20): Series => ({
  id: 'paging', uid: '1', studyUid: '2', patientId: 'TEST', patientName: 'Synthetic', studyDate: '', description: 'Paging',
  modality: 'CT', seriesNumber: 1, dimensions: [8, 8, slices], spacing: [1, 1, 2], origin: [0, 0, 0], direction,
  windowCenter: 40, windowWidth: 400, valueUnit: 'HU', suvFactor: null, canReconstruct: true, warnings: [], photometricInterpretation: 'MONOCHROME2',
});
const source = { plane: 'axial' as const, mode: 'source' as const };

describe('VEAcom 1.x paging order', () => {
  it('pages an axial stack stored from the feet up from the top down, and opens it at the top', () => {
    const feetUp = stack([1, 0, 0, 0, 1, 0, 0, 0, 1]); // k steps towards +z, the head
    assert.equal(pagesBackwards(feetUp, source), true);
    assert.equal(pageStep(feetUp, source, 3), -3);
    assert.equal(openingSlice(feetUp), 19);
  });
  it('pages an axial stack stored from the head down as stored, and opens it at its first slice', () => {
    const headDown = stack([1, 0, 0, 0, 1, 0, 0, 0, -1]);
    assert.equal(pagesBackwards(headDown, source), false);
    assert.equal(pageStep(headDown, source, 3), 3);
    assert.equal(openingSlice(headDown), 0);
  });
  it('opens a coronal stack at the front and a sagittal one in the middle, paging both in anatomical order', () => {
    // Rows of the direction matrix, whose columns are the i, j, k axes.
    const coronal = stack([1, 0, 0, 0, 0, 1, 0, -1, 0]); // k towards +y, the back: slice 0 is the front
    assert.equal(openingSlice(coronal), 0);
    assert.equal(openingSlice(stack([1, 0, 0, 0, 0, -1, 0, -1, 0])), 19); // k towards the front
    assert.equal(pagesBackwards(coronal, source), false);
    const sagittal = stack([0, 0, 1, 1, 0, 0, 0, -1, 0]);
    assert.equal(openingSlice(sagittal), 9);
    assert.equal(pagesBackwards(sagittal, source), false);
    assert.equal(pageStep(stack([0, 0, -1, 1, 0, 0, 0, -1, 0]), source, 1), -1);
    assert.equal(pageStep(stack([1, 0, 0, 0, 1, 0, 0, 0, 1]), { plane: 'sagittal', mode: 'mpr' }, 1), -1);
  });
  it('leaves single images and stacks without positions alone', () => {
    assert.equal(openingSlice(stack([1, 0, 0, 0, 1, 0, 0, 0, 1], 1)), 0);
    assert.equal(pagesBackwards(stack([1, 0, 0, 0, 1, 0, 0, 0, 1], 1), source), false);
  });
  it('pages an axial reconstruction of a feet-up volume from the top down too', () => {
    assert.equal(pagesBackwards(stack([1, 0, 0, 0, 1, 0, 0, 0, 1]), { plane: 'axial', mode: 'mpr' }), true);
    assert.equal(pagesBackwards(stack([1, 0, 0, 0, 1, 0, 0, 0, 1]), { plane: 'coronal', mode: 'mpr' }), false);
  });
});
