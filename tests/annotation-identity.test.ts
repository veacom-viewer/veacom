import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertClose } from './support';
import type { Annotation, FrameMetadata, Series, Volume } from '../src/model';
import { annotationSourceIndex, annotationSummary, roiStatistics } from '../src/imaging/annotations';

interface SourceFrame {
  sop: string;
  number?: number;
  z: number;
  pixels: [number, number, number, number];
}

const original: SourceFrame = { sop: '1.2.3.100', number: 1, z: 30, pixels: [2, 4, 6, 8] };
const neighbors: SourceFrame[] = [
  { sop: '1.2.3.101', number: 1, z: 31, pixels: [100, 200, 300, 400] },
  { sop: '1.2.3.102', number: 1, z: 32, pixels: [10, 20, 30, 40] },
  { sop: '1.2.3.103', number: 1, z: 33, pixels: [-10, -20, -30, -40] },
];

function volume(frames: SourceFrame[]): Volume {
  const frameMetadata: FrameMetadata[] = frames.map(frame => ({
    sopInstanceUid: frame.sop, sourceFrameNumber: frame.number,
    origin: [10, 20, frame.z], spacing: [2, 3, 1], direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    spacingKnown: true, orientationKnown: true, positionKnown: true,
  }));
  const series: Series = {
    id: 'identity-fixture', uid: '1.2.3', studyUid: '1.2', patientId: 'TEST', patientName: 'Synthetic',
    studyDate: '', description: 'Known source frame identities', modality: 'CT', seriesNumber: 1,
    dimensions: [2, 2, frames.length], spacing: [2, 3, 1], origin: [10, 20, frames[0].z],
    direction: [1, 0, 0, 0, 1, 0, 0, 0, 1], windowCenter: 40, windowWidth: 400,
    valueUnit: 'HU', suvFactor: null, canReconstruct: false, warnings: [],
    photometricInterpretation: 'MONOCHROME2', spacingKnown: true, frameMetadata,
  };
  return { series, data: new Int16Array(frames.flatMap(frame => frame.pixels)) };
}

function annotation(identity: Partial<Annotation> = {}): Annotation {
  return {
    id: 'measurement', type: 'rectangle', plane: 'axial', mode: 'source', slice: 0, sourceFrame: 0,
    sourceSopInstanceUid: original.sop, sourceFrameNumber: original.number,
    points: [[10, 20, 30], [12, 20, 30], [12, 23, 30], [10, 23, 30]], ...identity,
  };
}

function expectOriginalPixels(measurement: Annotation, source: Volume): void {
  const stats = roiStatistics(measurement, source)!;
  assert.notEqual(stats, null);
  assert.equal(stats.count, 4);
  assert.equal(stats.mean, 5);
  assert.equal(stats.min, 2);
  assert.equal(stats.max, 8);
  // Population variance of 2,4,6,8 is (9+1+1+9)/4 = 5.
  assertClose(stats.standardDeviation, Math.sqrt(5));
  assertClose(stats.area, 6);
  assert.equal(stats.sampling, 'source-voxels');
}

describe('source annotation identity across catalog changes', () => {
  it('follows the original SOP/frame from array index zero to three without changing ROI statistics', () => {
    const before = volume([original, ...neighbors]);
    const after = volume([...neighbors, original]);
    const measurement = annotation();
    assert.equal(annotationSourceIndex(measurement, before.series), 0);
    assert.equal(annotationSourceIndex(measurement, after.series), 3);
    expectOriginalPixels(measurement, before);
    expectOriginalPixels(measurement, after);
    assert.equal(measurement.sourceFrame, 0);
    assert.deepEqual(measurement.points[0], [10, 20, 30]);
  });

  it('rejects a removed identity even when a replacement occupies the same index and physical plane', () => {
    const replacement: SourceFrame = { sop: '1.2.3.999', number: 1, z: 30, pixels: [900, 901, 902, 903] };
    const changed = volume([replacement, ...neighbors]);
    const measurement = annotation();
    assert.equal(annotationSourceIndex(measurement, changed.series), null);
    assert.equal(roiStatistics(measurement, changed), null);
    assert.equal(annotationSummary(measurement, changed), 'Source frame unavailable');
    assert.equal(annotationSummary({ ...measurement, type: 'probe', points: [[10, 20, 30]] }, changed), 'Source frame unavailable');
  });

  it('does not fall back to a saved index when identity metadata is missing', () => {
    const changed = volume([original, ...neighbors]);
    changed.series = { ...changed.series, frameMetadata: undefined };
    assert.equal(annotationSourceIndex(annotation(), changed.series), null);
    assert.equal(roiStatistics(annotation(), changed), null);
  });

  it('distinguishes enhanced or classic multi-frame images sharing a SOP UID by exact source frame number', () => {
    const multiFrame = { ...original, sop: '1.2.840.500', number: 2 };
    const sameSop = neighbors.map((frame, i) => ({ ...frame, sop: multiFrame.sop, number: [1, 3, 4][i] }));
    const changed = volume([...sameSop, multiFrame]);
    const measurement = annotation({ sourceSopInstanceUid: multiFrame.sop, sourceFrameNumber: 2 });
    assert.equal(annotationSourceIndex(measurement, changed.series), 3);
    expectOriginalPixels(measurement, changed);
    assert.equal(annotationSourceIndex({ ...measurement, sourceFrameNumber: 99 }, changed.series), null);
    assert.equal(annotationSourceIndex({ ...measurement, sourceFrameNumber: undefined }, changed.series), null);
  });

  it('supports a unique classic single-frame SOP without an explicit frame number', () => {
    const single = { ...original, number: undefined };
    const changed = volume([...neighbors, single]);
    const measurement = annotation({ sourceFrameNumber: undefined });
    assert.equal(annotationSourceIndex(measurement, changed.series), 3);
    expectOriginalPixels(measurement, changed);
  });

  it('rejects duplicate SOP/frame identities instead of resolving ambiguity using index or plane', () => {
    const duplicate: SourceFrame = { ...original, z: 99, pixels: [500, 600, 700, 800] };
    const changed = volume([original, duplicate]);
    const measurement = annotation();
    assert.equal(annotationSourceIndex(measurement, changed.series), null);
    assert.equal(roiStatistics(measurement, changed), null);
    assert.equal(annotationSummary(measurement, changed), 'Source frame unavailable');
  });

  it('keeps the physical-plane guard even when the SOP/frame identity matches', () => {
    const changed = volume([{ ...original, z: 40 }, ...neighbors]);
    assert.equal(annotationSourceIndex(annotation(), changed.series), null);
    assert.equal(roiStatistics(annotation(), changed), null);
  });

  it('accepts legacy index-only annotations only while their physical plane still matches', () => {
    const legacy = annotation({ sourceSopInstanceUid: undefined, sourceFrameNumber: undefined });
    const before = volume([original, ...neighbors]);
    assert.equal(annotationSourceIndex(legacy, before.series), 0);
    expectOriginalPixels(legacy, before);
    assert.equal(annotationSourceIndex({ ...legacy, sourceFrame: undefined }, before.series), 0);
    const reordered = volume([...neighbors, original]);
    assert.equal(annotationSourceIndex(legacy, reordered.series), null);
    assert.equal(roiStatistics(legacy, reordered), null);
    assert.equal(annotationSummary(legacy, reordered), 'Source frame unavailable');
  });

  it('requires the preview buffer to contain the identity-resolved frame rather than the stale saved index', () => {
    const reordered = volume([...neighbors, original]);
    const correctPreview: Volume = { ...reordered, sourceFrameIndex: 3, data: new Int16Array(original.pixels) };
    const wrongPreview: Volume = { ...reordered, sourceFrameIndex: 0, data: new Int16Array(neighbors[0].pixels) };
    const measurement = annotation();
    expectOriginalPixels(measurement, correctPreview);
    assert.equal(roiStatistics(measurement, wrongPreview), null);
    assert.equal(annotationSummary(measurement, wrongPreview), 'Source frame unavailable');
  });
});
