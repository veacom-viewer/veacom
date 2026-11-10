import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Series } from '../src/model';
import { joinedWith, referenceImages } from '../src/ui/referenceImages';

// A series' direction: a row-major matrix whose columns are the row, column and slice directions.
const AXIAL = [1, 0, 0, 0, 1, 0, 0, 0, 1], SAGITTAL = [0, 0, -1, 1, 0, 0, 0, -1, 0];
/** An axial plane tipped by `degrees` about the left-right axis. */
const tipped = (degrees: number) => {
  const angle = degrees * Math.PI / 180, sin = Math.sin(angle), cos = Math.cos(angle);
  return [1, 0, 0, 0, cos, -sin, 0, sin, cos];
};

// Synthetic series: a reformatted stack and the one image its scanner put at its head, across the stack.
const item = (id: string, images: number, values: Partial<Series> = {}): Series => ({
  id, uid: '1.2.3', studyUid: '1.2', patientId: 'TEST', patientName: 'Synthetic', studyDate: '20240305', description: 'Cor 0.6',
  modality: 'CT', seriesNumber: 601, dimensions: [8, 8, images], spacing: [1, 1, 1], origin: [0, 0, 0], direction: AXIAL, orientationKnown: true,
  windowCenter: 40, windowWidth: 400, valueUnit: 'HU', suvFactor: null, canReconstruct: images > 1, warnings: [], photometricInterpretation: 'MONOCHROME2',
  ...values,
});
const across = (id: string, values: Partial<Series> = {}) => item(id, 1, { direction: SAGITTAL, ...values });

describe('a stack\'s reference image', () => {
  it('is the one-image series that shares the stack\'s series in its study and faces another way', () => {
    const stack = item('stack', 321), reference = across('reference'), other = item('other', 40, { uid: '1.2.4' });
    assert.deepEqual([...referenceImages([reference, stack, other])], [['stack', reference]]);
  });
  it('is not taken from another series or another study', () => {
    assert.equal(referenceImages([item('stack', 321), across('single', { uid: '1.2.9' })]).size, 0);
    assert.equal(referenceImages([item('stack', 321), across('single', { studyUid: '1.9' })]).size, 0);
    assert.equal(referenceImages([item('stack', 321), across('single', { uid: '' }), across('other', { uid: '' })]).size, 0);
  });
  it('is left on a card of its own where the series has several stacks, several single images or no stack', () => {
    assert.equal(referenceImages([item('a', 321), item('b', 311), across('single')]).size, 0);
    assert.equal(referenceImages([item('stack', 321), across('one'), across('two')]).size, 0);
    assert.equal(referenceImages([item('few', 4), across('single')]).size, 0);
    assert.equal(referenceImages([item('stack', 321, { canReconstruct: false }), across('single')]).size, 0);
  });
  it('is not a single image in the stack\'s own plane: another acquisition or time of the series keeps its card', () => {
    const stack = item('stack', 321);
    assert.equal(referenceImages([stack, item('same', 1)]).size, 0);
    // The same plane seen from its other side, and a plane a few degrees off, are the stack's plane too.
    assert.equal(referenceImages([stack, item('mirrored', 1, { direction: [-1, 0, 0, 0, 1, 0, 0, 0, -1] })]).size, 0);
    assert.equal(referenceImages([stack, item('tilted', 1, { direction: tipped(5) })]).size, 0);
    assert.equal(referenceImages([stack, item('across', 1, { direction: tipped(30) })]).size, 1);
  });
  it('is not taken on trust where an orientation is not known', () => {
    assert.equal(referenceImages([item('stack', 321), across('single', { orientationKnown: false })]).size, 0);
    assert.equal(referenceImages([item('stack', 321, { orientationKnown: undefined }), across('single')]).size, 0);
  });
});

describe('a stack paged with its reference image', () => {
  // The stack is stored from the feet up, so it is paged from its last index down. `numbers` are the slices' Instance
  // Numbers in stored order.
  const stack = (numbers: number[]) => item('stack', numbers.length, {
    frameMetadata: numbers.map((instanceNumber, index) => ({ origin: [0, 0, index], direction: AXIAL, spacing: [1, 1, 1], instanceNumber })) });
  const reference = (instanceNumber?: number) => across('reference', {
    frameMetadata: instanceNumber === undefined ? undefined : [{ origin: [0, 0, 0], direction: SAGITTAL, spacing: [1, 1, 1], instanceNumber }] });

  it('counts the reference image among the stack\'s images', () => {
    assert.equal(joinedWith(stack([2, 3, 4, 5, 6]), reference(1)).total, 6);
  });
  it('puts the image at the end of the stack the scanner numbered it next to, so that the numbers run on', () => {
    // Paged from the top down the slices are 6, 5, 4, 3, 2: the image numbered 1 comes after them.
    assert.equal(joinedWith(stack([2, 3, 4, 5, 6]), reference(1)).leadAt, 5);
    // Paged from the top down they are 2, 3, 4, 5, 6: the image numbered 1 comes before them.
    assert.equal(joinedWith(stack([6, 5, 4, 3, 2]), reference(1)).leadAt, 0);
    // An image numbered after the slices stands beside the highest number.
    assert.equal(joinedWith(stack([1, 2, 3, 4, 5]), reference(6)).leadAt, 0);
    assert.equal(joinedWith(stack([5, 4, 3, 2, 1]), reference(6)).leadAt, 5);
  });
  it('puts the image first where the numbers do not say', () => {
    assert.equal(joinedWith(stack([2, 3, 4, 5, 6]), reference()).leadAt, 0);
    assert.equal(joinedWith(item('stack', 5), reference(1)).leadAt, 0);
  });
});
