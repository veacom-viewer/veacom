import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Series } from '../src/model';
import { openingSlice, pageStep, pagesBackwards, placeInSequence, shownSlice, stackSliceAt } from '../src/imaging/paging';

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

describe('a stack paged with its reference image as one sequence', () => {
  // Five slices stored from the feet up: paged from index 4 down to index 0.
  const feetUp = stack([1, 0, 0, 0, 1, 0, 0, 0, 1], 5);
  const first = { total: 6, leadAt: 0, lead: false }, last = { total: 6, leadAt: 5, lead: false };

  it('gives a series alone its places in paging order', () => {
    assert.deepEqual([4, 2, 0].map(slice => placeInSequence(feetUp, source, slice, 5)), [{ place: 0, total: 5 }, { place: 2, total: 5 }, { place: 4, total: 5 }]);
    assert.deepEqual(shownSlice(feetUp, source, 4, 5), { number: 1, total: 5 });
  });
  it('counts the reference image at the end it stands at', () => {
    assert.deepEqual([4, 0].map(slice => placeInSequence(feetUp, source, slice, 5, first)), [{ place: 1, total: 6 }, { place: 5, total: 6 }]);
    assert.deepEqual([4, 0].map(slice => placeInSequence(feetUp, source, slice, 5, last)), [{ place: 0, total: 6 }, { place: 4, total: 6 }]);
    // The pane that shows the image itself stands at the image's place.
    assert.deepEqual(placeInSequence(feetUp, source, 0, 1, { ...first, lead: true }), { place: 0, total: 6 });
    assert.deepEqual(placeInSequence(feetUp, source, 0, 1, { ...last, lead: true }), { place: 5, total: 6 });
  });
  it('numbers a slice from 1 over the whole sequence', () => {
    assert.deepEqual(shownSlice(feetUp, source, 4, 5, first), { number: 2, total: 6 });
    assert.deepEqual(shownSlice(feetUp, source, 0, 5, first), { number: 6, total: 6 });
    assert.deepEqual(shownSlice(feetUp, source, 4, 5, last), { number: 1, total: 6 });
    assert.deepEqual(shownSlice(feetUp, source, 0, 1, { ...last, lead: true }), { number: 6, total: 6 });
  });
  it('finds the slice at a place of the sequence, the inverse of the place of a slice', () => {
    assert.deepEqual([1, 3, 5].map(place => stackSliceAt(feetUp, source, place, 5, first)), [4, 2, 0]);
    assert.deepEqual([0, 2, 4].map(place => stackSliceAt(feetUp, source, place, 5, last)), [4, 2, 0]);
    for (const joined of [first, last]) for (const slice of [0, 1, 2, 3, 4]) assert.equal(stackSliceAt(feetUp, source, placeInSequence(feetUp, source, slice, 5, joined).place, 5, joined), slice);
  });
});
