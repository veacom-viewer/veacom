import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Series } from '../src/model';
import { measuredSlice, numbersBackwards, openingSlice, pageStep, pagesBackwards, shownSlice } from '../src/imaging/paging';

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

describe('the slice number shown', () => {
  // A stack stored from the feet up is paged from its last index down: 4, 3, 2 …
  const feetUp = stack([1, 0, 0, 0, 1, 0, 0, 0, 1], 5);
  const numbered = (numbers: number[]): Series => ({ ...feetUp,
    frameMetadata: numbers.map((instanceNumber, index) => ({ origin: [0, 0, index * 2], direction: feetUp.direction, spacing: feetUp.spacing, instanceNumber })) });
  const shown = (series: Series) => [4, 3, 2, 1, 0].map(slice => shownSlice(series, source, slice, 5));

  it('counts in paging order where the images carry no numbers of their own', () => {
    assert.equal(numbersBackwards(feetUp, source), true);
    assert.deepEqual(shown(feetUp), [1, 2, 3, 4, 5]);
  });
  it('is the image\'s own number where the scanner numbered the stack 1 to N, though it falls as the reader pages down', () => {
    const fromTheFeet = numbered([1, 2, 3, 4, 5]);
    assert.equal(numbersBackwards(fromTheFeet, source), false);
    assert.deepEqual(shown(fromTheFeet), [5, 4, 3, 2, 1]);
    const fromTheHead = numbered([5, 4, 3, 2, 1]);
    assert.equal(numbersBackwards(fromTheHead, source), true);
    assert.equal(measuredSlice(fromTheHead, { plane: 'axial', slice: 0 }, 0), 5);
    assert.equal(measuredSlice(fromTheFeet, { plane: 'axial', slice: 0 }, 0), 1);
    assert.deepEqual(shown(fromTheHead), [1, 2, 3, 4, 5]);
  });
  it('counts in paging order where the numbers are not 1 to N in order', () => {
    for (const numbers of [[2, 3, 4, 5, 6], [1, 3, 2, 4, 5], [7, 7, 7, 7, 7], [1, 2, 3, 4]]) assert.deepEqual(shown(numbered(numbers)), [1, 2, 3, 4, 5], String(numbers));
  });
  it('counts a reconstructed plane in paging order, whatever the acquired images are numbered', () => {
    const fromTheFeet = numbered([1, 2, 3, 4, 5]);
    assert.equal(numbersBackwards(fromTheFeet, { plane: 'axial', mode: 'mpr' }), true);
    assert.equal(shownSlice(fromTheFeet, { plane: 'axial', mode: 'mpr' }, 4, 5), 1);
  });
});
