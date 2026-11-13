import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Series } from '../src/model';
import { sliceCount } from '../src/imaging/geometry';
import { assessmentRoiLocation } from '../src/ui/assessmentRoi';
import { translate, type Translator } from '../src/i18n';
import { measuredSlice, numbersBackwards, openingSlice, pageStep, pagesBackwards, placeInSequence, shownSlice, stackSliceAt } from '../src/imaging/paging';

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
  it('names a measurement on an acquired image by the number the pane shows on it', () => {
    const drawn = { plane: 'axial' as const, slice: 0 };
    // A stack alone, paged from its last stored slice down: the top slice is 1, though it is stored last.
    assert.deepEqual([4, 0].map(frame => measuredSlice(feetUp, drawn, frame)), [1, 5]);
    // With the reference image first every slice is one higher; with it last the slices keep their numbers.
    assert.deepEqual([4, 0].map(frame => measuredSlice(feetUp, drawn, frame, first)), [2, 6]);
    assert.deepEqual([4, 0].map(frame => measuredSlice(feetUp, drawn, frame, last)), [1, 5]);
    // A measurement on the reference image is named by the image's own place.
    assert.equal(measuredSlice(feetUp, drawn, 0, { ...first, lead: true }), 1);
    assert.equal(measuredSlice(feetUp, drawn, 0, { ...last, lead: true }), 6);
    // Whatever the order, the list says what the counter says.
    for (const joined of [undefined, first, last]) for (const frame of [0, 1, 2, 3, 4]) assert.equal(measuredSlice(feetUp, drawn, frame, joined), shownSlice(feetUp, source, frame, 5, joined).number);
  });
  it('names a measurement on a reconstructed plane by the number that plane\'s pane shows on it', () => {
    // An axial plane of a volume stored from the feet up is paged from the top, as its pane pages it.
    const axial = { mode: 'mpr' as const, plane: 'axial' as const }, count = sliceCount(feetUp, axial);
    assert.ok(count > 1);
    assert.deepEqual([0, count - 1].map(slice => measuredSlice(feetUp, { plane: 'axial', slice })), [count, 1]);
    // A coronal plane is paged as stored, from the front.
    const coronal = { mode: 'mpr' as const, plane: 'coronal' as const };
    assert.deepEqual([0, 3].map(slice => measuredSlice(feetUp, { plane: 'coronal', slice })), [0, 3].map(slice => shownSlice(feetUp, coronal, slice, sliceCount(feetUp, coronal)).number));
    assert.equal(measuredSlice(feetUp, { plane: 'coronal', slice: 0 }), 1);
    // A reference image is no slice of a reconstructed plane: the sequence is not asked.
    assert.equal(measuredSlice(feetUp, { plane: 'axial', slice: 0 }, undefined, first), count);
  });
});

describe('the slice number shown', () => {
  // A stack stored from the feet up is paged from its last index down: 4, 3, 2 …
  const feetUp = stack([1, 0, 0, 0, 1, 0, 0, 0, 1], 5);
  const numbered = (numbers: number[]): Series => ({ ...feetUp,
    frameMetadata: numbers.map((instanceNumber, index) => ({ origin: [0, 0, index * 2], direction: feetUp.direction, spacing: feetUp.spacing, instanceNumber })) });
  const shown = (series: Series) => [4, 3, 2, 1, 0].map(slice => shownSlice(series, source, slice, 5).number);

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
  it('labels a source ROI with the displayed slice, the distinct DICOM instance and its frame', () => {
    const t: Translator = (key, params) => translate('en', key, params);
    const drawn = { mode: 'source', plane: 'axial', slice: 0 } as const;
    const irregular = numbered([10, 20, 30, 40, 50]);
    irregular.frameMetadata![0].sourceFrameNumber = 2;
    assert.equal(assessmentRoiLocation(irregular, drawn, 0, t), 'Image 5 · Instance Number 10 · frame 2');
    assert.equal(assessmentRoiLocation(irregular, drawn, 0, t, { lead: false, leadAt: 0, total: 6, reverseNumbers: false }), 'Image 6 · Instance Number 10 · frame 2');
    assert.equal(assessmentRoiLocation(numbered([1, 2, 3, 4, 5]), drawn, 0, t), 'Image 1');
    assert.equal(assessmentRoiLocation(feetUp, drawn, 0, t), 'Image 5');
    assert.equal(assessmentRoiLocation(feetUp, drawn, null, t), t('assessment.sourceUnavailable'));
  });
  it('counts a reconstructed plane in paging order, whatever the acquired images are numbered', () => {
    const fromTheFeet = numbered([1, 2, 3, 4, 5]);
    assert.equal(numbersBackwards(fromTheFeet, { plane: 'axial', mode: 'mpr' }), true);
    assert.equal(shownSlice(fromTheFeet, { plane: 'axial', mode: 'mpr' }, 4, 5).number, 1);
    assert.deepEqual([0, 4].map(slice => measuredSlice(fromTheFeet, { plane: 'axial', slice })), [5, 1]);
  });
});
