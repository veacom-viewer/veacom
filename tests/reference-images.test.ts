import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Series } from '../src/model';
import { referenceImages } from '../src/ui/referenceImages';

// Synthetic series: a reformatted stack and the one image its scanner put at its head.
const item = (id: string, images: number, values: Partial<Series> = {}): Series => ({
  id, uid: '1.2.3', studyUid: '1.2', patientId: 'TEST', patientName: 'Synthetic', studyDate: '20240305', description: 'Cor 0.6',
  modality: 'CT', seriesNumber: 601, dimensions: [8, 8, images], spacing: [1, 1, 1], origin: [0, 0, 0], direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  windowCenter: 40, windowWidth: 400, valueUnit: 'HU', suvFactor: null, canReconstruct: images > 1, warnings: [], photometricInterpretation: 'MONOCHROME2',
  ...values,
});

describe('a stack\'s reference image', () => {
  it('is the one-image series that shares the stack\'s series in its study', () => {
    const stack = item('stack', 321), reference = item('reference', 1), other = item('other', 40, { uid: '1.2.4' });
    assert.deepEqual([...referenceImages([reference, stack, other])], [['stack', reference]]);
  });
  it('is not taken from another series or another study', () => {
    assert.equal(referenceImages([item('stack', 321), item('single', 1, { uid: '1.2.9' })]).size, 0);
    assert.equal(referenceImages([item('stack', 321), item('single', 1, { studyUid: '1.9' })]).size, 0);
    assert.equal(referenceImages([item('stack', 321), item('single', 1, { uid: '' }), item('other', 1, { uid: '' })]).size, 0);
  });
  it('is left on a card of its own where the series has several stacks, several single images or no stack', () => {
    assert.equal(referenceImages([item('a', 321), item('b', 311), item('single', 1)]).size, 0);
    assert.equal(referenceImages([item('stack', 321), item('one', 1), item('two', 1)]).size, 0);
    assert.equal(referenceImages([item('few', 4), item('single', 1)]).size, 0);
    assert.equal(referenceImages([item('stack', 321, { canReconstruct: false }), item('single', 1)]).size, 0);
  });
});
