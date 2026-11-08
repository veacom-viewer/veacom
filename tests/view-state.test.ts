import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertClose, assertFields } from './support';
import type { Series, ViewState, Volume } from '../src/model';
import { patchView, renderedView, resolveView, voiGrey, windowGrey } from '../src/imaging/viewState';

const series: Series = {
  id: 'source', uid: 'source', studyUid: 'study', patientId: '', patientName: '', studyDate: '', description: '', modality: 'MR', seriesNumber: 1,
  dimensions: [2, 2, 3], origin: [0, 0, 0], direction: [1, 0, 0, 0, 1, 0, 0, 0, 1], spacing: [1, 1, 2],
  windowCenter: 100, windowWidth: 200, canReconstruct: true, valueUnit: '', suvFactor: null, warnings: [], photometricInterpretation: 'MONOCHROME2',
  frameMetadata: [0, 1, 2].map(index => ({ origin: [0, index, index * 2], direction: [1, 0, 0, 0, 1, 0, 0, 0, 1], spacing: [1, 1, 2],
    windowCenter: 100 + index * 100, windowWidth: 40 + index * 20 })),
};
const volume: Volume = { series, data: new Int16Array(12) };
const initial: ViewState = { mode: 'source', windowMode: 'dicom', plane: 'axial', slice: 0, windowCenter: 100, windowWidth: 40,
  zoom: 1, pan: [0, 0], rotation: 0, flipX: false, flipY: false, inverted: false };

describe('acquired-frame window state', () => {
  it('uses each acquired frame window while paging', () => {
    assertFields(patchView(volume, initial, { slice: 2 }), { mode: 'source', slice: 2, windowCenter: 300, windowWidth: 80, windowMode: 'dicom' });
  });
  it('keeps manual window adjustments across source frames', () => {
    const manual = patchView(volume, initial, { windowCenter: 75, windowWidth: 90 });
    assertFields(patchView(volume, manual, { slice: 2 }), { windowCenter: 75, windowWidth: 90, windowMode: 'manual' });
    assertFields(patchView(volume, { ...manual, slice: 2 }, { windowMode: 'dicom' }), { windowCenter: 300, windowWidth: 80, windowMode: 'dicom' });
  });
  it('keeps a requested MIP turn while displaying the acquired preview frame', () => {
    const preview = { ...volume, data: new Int16Array(4), sourceFrameIndex: 1 };
    const mip: ViewState = { ...initial, mode: 'mpr', plane: 'coronal', projection: 'mip', slice: 0 };
    const paged = patchView(preview, mip, { slice: 7 });
    assertFields(paged, { mode: 'mpr', plane: 'coronal', slice: 7, projection: 'mip' });
    assertFields(renderedView(preview, paged), { mode: 'source', plane: 'axial', slice: 1 });
    assertFields(renderedView(volume, paged), { mode: 'mpr', plane: 'coronal', slice: 7, projection: 'mip' });
  });
  it('normalizes source frame indices without converting irregular acquisitions into MPR', () => {
    const irregular = { ...volume, series: { ...series, canReconstruct: false } };
    assertFields(resolveView(irregular, { ...initial, mode: 'mpr', plane: 'coronal', slice: 200, oblique: [20, 30] }), { mode: 'source', plane: 'axial', slice: 2, oblique: undefined });
  });
  it('keeps requested and displayed partial frame windows separate', () => {
    const partial = { ...volume, sourceFrameIndex: 0, data: new Int16Array(4) };
    const requested = patchView(partial, initial, { slice: 2 });
    assertFields(requested, { slice: 2, windowCenter: 300, windowWidth: 80 });
    assertFields(renderedView(partial, requested), { slice: 0, windowCenter: 100, windowWidth: 40 });
    assert.equal(requested.slice, 2);
    assertFields(resolveView(partial, { ...requested, mode: 'mpr', plane: 'coronal', slice: 99 }), { mode: 'source', plane: 'axial', slice: 2 });
  });
  it('keeps the current contrast when entering MPR and resumes frame defaults on return', () => {
    const source = patchView(volume, initial, { slice: 2 });
    const mpr = patchView(volume, source, { mode: 'mpr', plane: 'coronal', slice: 1 });
    assertFields(mpr, { windowCenter: 300, windowWidth: 80, windowMode: 'dicom' });
    assertFields(patchView(volume, mpr, { mode: 'source', slice: 1 }), { windowCenter: 200, windowWidth: 60 });
  });
  it('retains legacy explicitly supplied MPR windows and avoids unchanged-state allocations', () => {
    const legacy = { ...initial, mode: undefined, windowMode: undefined, plane: 'coronal' as const, slice: 7 };
    assert.equal(resolveView(volume, legacy), legacy);
    assert.equal(resolveView(volume, initial), initial);
  });
  it('falls back to the series window when a frame has invalid defaults', () => {
    const invalid = { ...volume, series: { ...series, frameMetadata: [{ ...series.frameMetadata![0], windowCenter: NaN, windowWidth: 0 }] } };
    assertFields(resolveView(invalid, initial), { windowCenter: 100, windowWidth: 200 });
  });
});

describe('VOI LUT display', () => {
  const lut = { first: 10, bits: 8, data: [0, 51, 255] };
  const frames = [0, 1, 2].map(index => ({ origin: [0, 0, index * 2], direction: [1, 0, 0, 0, 1, 0, 0, 0, 1], spacing: [1, 1, 2] }));
  const lutSeries: Series = { ...series, windowCenter: 11.5, windowWidth: 3, voiLuts: [lut],
    frameMetadata: [{ ...frames[0], voiLut: 0 }, { ...frames[1], windowCenter: 40, windowWidth: 80 }, { ...frames[2], voiLut: 0 }] as Series['frameMetadata'] };
  const lutVolume: Volume = { series: lutSeries, data: new Int16Array(12) };

  it('maps values to the nearest entry over the output range, clamped at both ends', () => {
    assert.deepEqual([5, 10, 10.6, 12, 99].map(value => voiGrey(lut, value)), [0, 0, 0.2, 1, 1]);
  });
  it('shows a frame without a window with its VOI LUT in DICOM mode, starting manual changes from its range', () => {
    assertFields(resolveView(lutVolume, initial), { voiLut: 0, windowCenter: 11.5, windowWidth: 3 });
    assertFields(patchView(lutVolume, initial, { slice: 1 }), { windowCenter: 40, windowWidth: 80 });
    assert.equal(patchView(lutVolume, initial, { slice: 1 }).voiLut, undefined);
    assertFields(patchView(lutVolume, initial, { slice: 2 }), { voiLut: 0 });
    const manual = patchView(lutVolume, resolveView(lutVolume, initial), { windowWidth: 9 });
    assertFields(manual, { windowMode: 'manual', windowCenter: 11.5, windowWidth: 9 });
    assert.equal(manual.voiLut, undefined);
    assertFields(patchView(lutVolume, manual, { windowMode: 'dicom' }), { voiLut: 0 });
  });
  it('never applies a VOI LUT to reconstructed planes', () => {
    assert.equal(resolveView(lutVolume, { ...initial, mode: 'mpr', plane: 'coronal' }).voiLut, undefined);
  });
});

describe('window curves (VOI LUT Function)', () => {
  it('follow PS3.3 C.11.2.1.2–3: LINEAR, LINEAR_EXACT and SIGMOID', () => {
    // LINEAR keeps the renderer's established half-unit offsets.
    const linear = [-0.5, 100, 199.5].map(value => windowGrey(value, 100, 201));
    [0, 0.5025, 1].forEach((expected, index) => assertClose(linear[index], expected, 10));
    assert.deepEqual([0, 49.5, 100, 150.5, 200].map(value => windowGrey(value, 100, 101, 'LINEAR_EXACT')), [0, 0, 0.5, 1, 1]);
    assert.equal(windowGrey(100, 100, 400, 'SIGMOID'), 0.5);
    assertClose(windowGrey(200, 100, 400, 'SIGMOID'), 1 / (1 + Math.exp(-1)), 12);
    assertClose(windowGrey(-1e6, 100, 400, 'SIGMOID'), 0, 12);
  });

  const curved: Series = { ...series, frameMetadata: series.frameMetadata!.map((frame, index) => index === 2 ? frame : { ...frame, voiFunction: 'SIGMOID' as const }) };
  const curvedVolume: Volume = { series: curved, data: new Int16Array(12) };
  it('shape the displayed frame\'s window, manual changes included, and never reconstructed planes', () => {
    assertFields(resolveView(curvedVolume, initial), { voiFunction: 'SIGMOID', windowCenter: 100, windowWidth: 40 });
    const manual = patchView(curvedVolume, resolveView(curvedVolume, initial), { windowWidth: 90 });
    assertFields(manual, { windowMode: 'manual', windowWidth: 90, voiFunction: 'SIGMOID' });
    assert.equal(patchView(curvedVolume, manual, { slice: 2 }).voiFunction, undefined);
    assert.equal(resolveView(curvedVolume, { ...initial, mode: 'mpr', plane: 'coronal' }).voiFunction, undefined);
  });
});
