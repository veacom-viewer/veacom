import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertClose } from './support';
import type { FrameMetadata, Series, ViewState } from '../src/model';
import { getPlaneFrame, screenMapping, worldToScreen } from '../src/imaging/geometry';
import { framesOnPlane, labelVolume, maskFrames, maskTransform, overlayShapes, planeOutlines, segmentationApplies, segmentationTexture } from '../src/imaging/segmentation';

const frame = (z: number, segmentNumber?: number): FrameMetadata => ({
  origin: [10, 20, z], direction: [1, 0, 0, 0, 1, 0, 0, 0, 1], spacing: [0.5, 0.5, 2],
  positionKnown: true, orientationKnown: true, spacingKnown: true, ...(segmentNumber ? { segmentNumber } : {}),
});
const seg: Series = {
  id: 'seg', uid: '9.1', studyUid: '9', patientId: 'P', patientName: 'Synthetic', studyDate: '', description: 'Nodule',
  modality: 'SEG', seriesNumber: 2, dimensions: [3, 3, 3], spacing: [0.5, 0.5, 2], origin: [10, 20, 0],
  direction: [1, 0, 0, 0, 1, 0, 0, 0, 1], windowCenter: 0.5, windowWidth: 1, valueUnit: 'a.u.', suvFactor: null,
  canReconstruct: false, warnings: [], photometricInterpretation: 'MONOCHROME2', frameOfReferenceUid: '9.9', components: 1,
  segmentation: { kind: 'BINARY', referencedSeriesUid: '9.2', segments: [{ number: 1, label: 'Nodule', color: [255, 0, 0] }, { number: 2, label: 'Vessel' }] },
  frameMetadata: [frame(0, 1), frame(2, 1), frame(2, 2)],
};
// Frame 0: an L of three pixels; frame 1: nothing; frame 2: the centre pixel.
const data = new Uint8Array([
  1, 0, 0, 1, 1, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 1, 0, 0, 0, 0,
]);
const image: Series = { ...seg, id: 'ct', uid: '9.2', modality: 'CT', description: 'Chest', segmentation: undefined, frameMetadata: undefined,
  dimensions: [6, 6, 3], spacing: [0.25, 0.25, 2], origin: [10, 20, 0], windowCenter: 40, windowWidth: 400, canReconstruct: true, orientationKnown: true };
const view: ViewState = { mode: 'mpr', plane: 'axial', slice: 0, windowCenter: 40, windowWidth: 400, zoom: 1, pan: [0, 0], rotation: 0, flipX: false, flipY: false, inverted: false };
const matrix = (transform: string) => transform.slice(7, -1).split(' ').map(Number);

describe('DICOM segmentation frames', () => {
  const frames = maskFrames({ series: seg, data });

  it('keeps only frames with set pixels and traces their runs and boundary', () => {
    assert.deepEqual(frames.map(item => [item.segment, item.label, item.color]), [[1, 'Nodule', 'rgb(255, 0, 0)'], [2, 'Vessel', '#4fc3f7']]);
    assert.equal(frames[0].fill, 'M-0.5 -0.5h1v1h-1zM-0.5 0.5h2v1h-2z');
    // The L's outline: top, step, bottom, then the left side, inner corner and right side.
    assert.equal(frames[0].outline, 'M-0.5 -0.5h1M0.5 0.5h1M-0.5 1.5h2M-0.5 -0.5v2M0.5 -0.5v1M1.5 0.5v1');
    assert.equal(frames[1].fill, 'M0.5 0.5h1v1h-1z');
    assert.deepEqual(frames[0].i, [0.5, 0, 0]);
    assert.equal(frames[0].reach, 1);
  });

  it('draws a fractional mask where it holds at least half its maximum, and each label of a label map', () => {
    const fractional = { ...seg, windowWidth: 255, segmentation: { ...seg.segmentation!, kind: 'FRACTIONAL' } };
    assert.deepEqual(maskFrames({ series: fractional, data: new Uint8Array(27).fill(100) }), []);
    assert.equal(maskFrames({ series: fractional, data: new Uint8Array(27).fill(200) }).length, 3);
    const labelmap = { ...seg, frameMetadata: [frame(0), frame(2), frame(4)], segmentation: { ...seg.segmentation!, kind: 'LABELMAP' } };
    const labels = maskFrames({ series: labelmap, data: new Uint8Array([2, 2, 0, 1, 0, 0, 0, 0, 0, ...new Array(18).fill(0)]) });
    assert.deepEqual(labels.map(item => [item.segment, item.label, item.fill]), [[1, 'Nodule', 'M-0.5 0.5h1v1h-1z'], [2, 'Vessel', 'M-0.5 -0.5h2v1h-2z']]);
  });

  it('applies to the referenced series or its frame of reference, never to colour or other segmentations', () => {
    assert.equal(segmentationApplies(seg, image), true);
    assert.equal(segmentationApplies(seg, { ...image, uid: 'other' }), false);
    assert.equal(segmentationApplies({ ...seg, segmentation: { ...seg.segmentation!, referencedSeriesUid: undefined } }, { ...image, uid: 'other' }), true);
    assert.equal(segmentationApplies(seg, { ...image, patientId: 'DIFFERENT' }), false);
    assert.equal(segmentationApplies({ ...seg, patientKey: 'site-A' }, { ...image, patientKey: 'site-B' }), false);
    assert.equal(segmentationApplies(seg, { ...image, uid: 'other', frameOfReferenceUid: '8.8' }), false);
    assert.equal(segmentationApplies(seg, { ...image, components: 3 }), false);
    assert.equal(segmentationApplies(seg, seg), false);
  });

  it('honors the referenced study, SOP instances and multiframe frame numbers over matching geometry', () => {
    const target = { ...image, frameMetadata: [{ sopInstanceUid: '2.25.11', sourceFrameNumber: 2 }] } as Series;
    const mask = { ...seg, segmentation: { ...seg.segmentation!, referencedSeries: [[image.studyUid, image.uid]],
      referencedInstances: [['2.25.11', 2]] } } as Series;
    assert.equal(segmentationApplies(mask, target), true);
    assert.equal(segmentationApplies(mask, { ...target, studyUid: 'another-study' }), false);
    assert.equal(segmentationApplies(mask, { ...target, frameMetadata: [] }), false);
    assert.equal(segmentationApplies(mask, { ...target, frameMetadata: [{ ...target.frameMetadata![0], sourceFrameNumber: 1 }] }), false);
    assert.equal(segmentationApplies({ ...seg, segmentation: { ...seg.segmentation!, referencedInstances: [] } }, target), false);
  });

  it('shows a frame only on the slice whose plane it lies in', () => {
    assert.deepEqual(framesOnPlane(frames, getPlaneFrame(image, view)).map(item => item.segment), [1]);
    assert.deepEqual(framesOnPlane(frames, getPlaneFrame(image, { ...view, slice: 1 })).map(item => item.segment), [2]);
    assert.deepEqual(framesOnPlane(frames, getPlaneFrame(image, { ...view, plane: 'coronal', slice: 2 })), []);
  });

  it('maps mask pixel indices onto the viewport through its patient geometry', () => {
    const mapping = screenMapping(image, { ...view, rotation: 90, zoom: 2, pan: [7, -3] }, 300, 200);
    const [a, b, c, d, e, f] = matrix(maskTransform(mapping, frames[1]));
    // The centre pixel (1, 1) of the second mask frame lies at patient (10.5, 20.5, 2).
    const expected = worldToScreen(mapping, [10.5, 20.5, 2]);
    assertClose(a * 1 + c * 1 + e, expected[0], 8);
    assertClose(b * 1 + d * 1 + f, expected[1], 8);
  });
});

describe('DICOM segmentation label volumes', () => {
  // Planes at z = 0, 2 and 6: the empty plane at z = 4 is not stored, as DCMQI omits empty frames.
  const gapped: Series = { ...seg, frameMetadata: [frame(0, 1), frame(2, 1), frame(6, 2), frame(2, 2)], dimensions: [3, 3, 4] };
  const masks = new Uint8Array([
    1, 1, 1, 1, 1, 1, 1, 1, 1, // segment 1, the whole of plane 0
    1, 1, 1, 1, 1, 1, 0, 0, 0, // segment 1, plane 1
    0, 0, 0, 0, 1, 0, 0, 0, 0, // segment 2, plane 3
    0, 0, 0, 0, 1, 1, 0, 0, 0, // segment 2, plane 1, inside segment 1
  ]);
  const volume = labelVolume({ series: gapped, data: masks })!;

  it('places frames by position, leaves missing planes empty and keeps small segments on top', () => {
    assert.deepEqual(volume.dimensions, [3, 3, 4]);
    assert.deepEqual(volume.k, [0, 0, 2]);
    assert.deepEqual(volume.segments.map(item => item.segment), [1, 2]);
    assert.deepEqual([...volume.labels], [
      1, 1, 1, 1, 1, 1, 1, 1, 1,
      1, 1, 1, 1, 2, 2, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 2, 0, 0, 0, 0,
    ]);
    assert.deepEqual([volume.min, volume.max], [[0, 0, 0], [2, 2, 3]]);
  });

  it('declines frames that do not share one orientation and pixel grid', () => {
    const tilted = { ...gapped, frameMetadata: gapped.frameMetadata!.map((item, index) => index ? item : { ...item, direction: [1, 0, 0, 0, 0, 1, 0, -1, 0] }) };
    assert.equal(labelVolume({ series: tilted, data: masks }), null);
    const shifted = { ...gapped, frameMetadata: gapped.frameMetadata!.map((item, index) => index === 1 ? { ...item, origin: [11, 20, 2] as [number, number, number] } : item) };
    assert.equal(labelVolume({ series: shifted, data: masks }), null);
    assert.equal(labelVolume({ series: gapped, data: new Uint8Array(36) }), null);
  });

  it('outlines where a coronal plane cuts the frames, sampled at the finest spacing', () => {
    // Patient y = 20.5 is the middle row of every frame.
    const shapes = planeOutlines(volume, { center: [10.5, 20.5, 3], u: [1, 0, 0], v: [0, 0, -1], normal: [0, -1, 0] });
    assert.deepEqual(shapes.map(item => item.segment), [1, 2]);
    for (const shape of shapes) assert.deepEqual(shape.i, [0.5, 0, 0]);
    // Grid cells are 0.5 mm, centred on the pixel centres. Segment 2 lies in the middle row at x 10.5 in the
    // plane at z 6 and at x 10.5–11 in the plane at z 2; each plane is 2 mm thick, four cells.
    const nodule = shapes[1];
    assert.deepEqual(nodule.j, [0, 0, -0.5]);
    const runs = [...nodule.fill.matchAll(/M(-?[\d.]+) (-?[\d.]+)h(\d+)/g)]
      .map(([, x, y, run]) => [nodule.origin[0] + (Number(x) + 0.5) * 0.5, nodule.origin[2] - (Number(y) + 0.5) * 0.5, Number(run)]);
    assert.deepEqual(runs.filter(([, z]) => z > 5 && z < 7), [[10.5, 6.75, 1], [10.5, 6.25, 1], [10.5, 5.75, 1], [10.5, 5.25, 1]]);
    assert.deepEqual(runs.filter(([, z]) => z > 1 && z < 3), [[10.5, 2.75, 2], [10.5, 2.25, 2], [10.5, 1.75, 2], [10.5, 1.25, 2]]);
    assert.deepEqual(planeOutlines(volume, { center: [10.5, 30, 3], u: [1, 0, 0], v: [0, 0, -1], normal: [0, -1, 0] }), []);
  });

  it('uses the exact frames on parallel planes and sampled outlines across them', () => {
    const overlay = { id: 'seg', series: gapped, frames: maskFrames({ series: gapped, data: masks }), labels: volume };
    const ct = { ...image, dimensions: [6, 6, 4] as [number, number, number] };
    assert.deepEqual(overlayShapes(overlay, getPlaneFrame(ct, { ...view, slice: 3 })).map(item => [item.segment, item.fill]), [[2, 'M0.5 0.5h1v1h-1z']]);
    assert.deepEqual(overlayShapes(overlay, getPlaneFrame(ct, { ...view, slice: 2 })), []);
    assert.deepEqual(overlayShapes(overlay, getPlaneFrame(ct, { ...view, plane: 'coronal', slice: 2 })).map(item => item.segment), [1, 2]);
  });

  it('resamples shown segmentations onto the series voxel grid for 3D, within the box they occupy', () => {
    const overlay = { id: 'seg', series: gapped, frames: [], labels: volume };
    const texture = segmentationTexture({ ...image, dimensions: [8, 8, 5] }, [overlay])!;
    // 0.25 mm CT voxels: each 0.5 mm segmentation pixel covers two in x and y.
    assert.deepEqual(texture.min, [0, 0, 0]);
    assert.deepEqual(texture.size, [6, 6, 5]);
    assert.deepEqual(texture.colors, [[255, 0, 0], [79, 195, 247]]);
    const at = (x: number, y: number, z: number) => texture.labels[(z * texture.size[1] + y) * texture.size[0] + x];
    assert.deepEqual([at(0, 0, 0), at(4, 4, 0), at(2, 2, 1), at(4, 2, 1), at(0, 5, 1), at(2, 2, 3), at(0, 0, 3), at(2, 2, 2)], [1, 1, 2, 2, 0, 2, 0, 0]);
    assert.equal(segmentationTexture({ ...image, frameOfReferenceUid: '8.8', uid: 'other' }, [overlay]), null);
  });
});
