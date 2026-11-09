import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertClose } from './support';
import { createHash } from 'node:crypto';
import type { Annotation, Plane, Series, Vec3, ViewState, Volume } from '../src/model';
import { REMOVED_VALUE, annotationToVoiKey, buildVisibleRegionMaskAsync, buildVoiMask, buildVoiMaskAsync, carveSphere, createPaddingMask, extractStl, extractStlAsync, fullCrop, indexToPatient, interpolateVoiOutline, patientToIndex, pickSurface, restoreCarve, sampleVolume } from '../src/imaging/volume3d';
import type { VoiKey, VoiSelection } from '../src/imaging/volume3d';
import { getPlaneFrame, screenMapping, worldToScreen } from '../src/imaging/geometry';

function makeVolume(dimensions: Vec3 = [5, 5, 5], scalar = (x: number, _y: number, _z: number) => x * 100): Volume {
  const series: Series = {
    id: 'test', uid: '1', studyUid: '2', patientId: 'synthetic', patientName: 'Synthetic phantom',
    studyDate: '', description: 'Analytic field', modality: 'CT', seriesNumber: 1,
    dimensions, spacing: [1, 1, 1], origin: [0, 0, 0], direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    windowCenter: 0, windowWidth: 400, valueUnit: 'HU', suvFactor: null,
    canReconstruct: true, warnings: [], photometricInterpretation: 'MONOCHROME2',
  };
  const data = new Float32Array(dimensions[0] * dimensions[1] * dimensions[2]);
  for (let z = 0; z < dimensions[2]; z++) for (let y = 0; y < dimensions[1]; y++) for (let x = 0; x < dimensions[0]; x++) data[(z * dimensions[1] + y) * dimensions[0] + x] = scalar(x, y, z);
  return { series, data };
}

function sourceHash(volume: Volume): string {
  return createHash('sha256').update(new Uint8Array(volume.data.buffer, volume.data.byteOffset, volume.data.byteLength)).digest('hex');
}

describe('permanent source padding exclusions', () => {
  it('never picks positive padding as bone, even when reading pre-burr depth', () => {
    const volume = makeVolume([7, 3, 3], x => x < 2 || x === 6 ? 32767 : x === 2 ? 0 : 1000);
    volume.series.paddingRange = [32767, 32767];
    const mask = createPaddingMask(volume), crop = fullCrop(volume), before = sourceHash(volume);
    assert.equal(mask.filter(value => value === 3).length, 27);
    for (const supplied of [undefined, mask]) {
      const hit = pickSurface(volume, [-2, 1, 1], [1, 0, 0], 500, crop, supplied);
      assertClose(hit!.point[0], 2.5, 4);
    }
    const bone = (1 * 3 + 1) * 7 + 3;
    mask[bone] = 1;
    assertClose(pickSurface(volume, [-2, 1, 1], [1, 0, 0], 500, crop, mask)!.point[0], 3.5, 3);
    assertClose(pickSurface(volume, [-2, 1, 1], [1, 0, 0], 500, crop, mask, 2)!.point[0], 2.5, 4);
    assert.throws(() => sampleVolume(volume, [0, 1, 1], mask), { message: /padding/ });
    assert.equal(sampleVolume(volume, [2, 1, 1]), 0);
    assert.equal(sourceHash(volume), before);
  });

  it('uses each acquired frame padding range instead of another frame or the shared default', () => {
    const volume = makeVolume([3, 2, 2], x => [1000, 2000, 500][x]);
    volume.series.paddingRange = [1000, 1000];
    volume.series.frameMetadata = [
      { origin: [0, 0, 0], direction: volume.series.direction, spacing: volume.series.spacing },
      { origin: [0, 0, 1], direction: volume.series.direction, spacing: volume.series.spacing, paddingRange: [2000, 2000] },
    ];
    assert.deepEqual([...createPaddingMask(volume)], [3, 0, 0, 3, 0, 0, 0, 3, 0, 0, 3, 0]);
    assert.throws(() => sampleVolume(volume, [0, 0, 0]), { message: /padding/ });
    assert.equal(sampleVolume(volume, [0, 0, 1]), 1000);
    assert.equal(pickSurface(volume, [-1, 0, 1], [1, 0, 0], 1500, fullCrop(volume)), null);
  });

  it('matches reversed Float32 padding endpoints after negative rescaling without rounding Float64 values', () => {
    const volume = makeVolume([4, 1, 1]);
    volume.data = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    volume.series.paddingRange = [0.30000000000000004, 0.1];
    const before = sourceHash(volume);
    assert.deepEqual([...createPaddingMask(volume)], [3, 3, 3, 0]);
    assert.throws(() => sampleVolume(volume, [2, 0, 0]), { message: /padding/ });
    assert.equal(sampleVolume(volume, [3, 0, 0]), Math.fround(0.4));
    assert.equal(sourceHash(volume), before);

    volume.data = new Float64Array([2 ** 24, 2 ** 24 + 1, Infinity, NaN]);
    volume.series.paddingRange = [2 ** 24, 2 ** 24];
    const doubleBefore = sourceHash(volume);
    assert.deepEqual([...createPaddingMask(volume)], [3, 0, 3, 3]);
    assert.equal(sampleVolume(volume, [1, 0, 0]), 2 ** 24 + 1);
    assert.equal(sourceHash(volume), doubleBefore);
  });

  it('never carves padding when supplied an empty mask and never undoes permanent exclusions', () => {
    const volume = makeVolume([3, 3, 3], (x, y, z) => x === 0 ? 65535 : x === 2 && y === 2 && z === 2 ? NaN : 1000);
    volume.series.paddingRange = [65535, 65535];
    const before = sourceHash(volume), empty = new Uint8Array(volume.data.length);
    const changed = carveSphere(volume, empty, [1, 1, 1], 10, fullCrop(volume));
    assert.equal(changed.length, 17);
    assert.equal([...changed].every(index => volume.data[index] === 1000), true);
    restoreCarve(empty, changed);
    assert.equal(empty.every(value => value === 0), true);
    const permanent = createPaddingMask(volume); permanent[1] = 2;
    restoreCarve(permanent, new Uint32Array([0, 1, 26]));
    assert.deepEqual([permanent[0], permanent[1], permanent[26]], [3, 2, 3]);
    assert.equal(sourceHash(volume), before);
    assert.throws(() => createPaddingMask({ ...volume, sourceFrameIndex: 0 }), { message: /complete volume/ });
  });

  it('excludes padding from VOI and visible-region counts and preserves source bytes through STL export', async () => {
    const volume = makeVolume([4, 3, 3], x => x * 100);
    volume.data[0] = 5000; volume.data[1] = NaN; volume.series.paddingRange = [5000, 5000];
    const original = volume.data, before = sourceHash(volume);
    const keys: VoiKey[] = [0, 2].map(slice => ({ slice, outline: [[-0.5, -0.5, slice], [3.5, -0.5, slice], [3.5, 2.5, slice], [-0.5, 2.5, slice]] }));
    const selection = buildVoiMask(volume, { plane: 'axial', keys });
    assert.equal(selection.insideCount, 34);
    assert.deepEqual([selection.mask[0], selection.mask[1]], [3, 3]);
    const view: ViewState = { plane: 'axial', mode: 'mpr', slice: 1, windowCenter: 100, windowWidth: 400, zoom: 1, pan: [0, 0], rotation: 0, flipX: false, flipY: false, inverted: false };
    const visible = await buildVisibleRegionMaskAsync(volume, view, [400, 300]);
    assert.equal(visible.insideCount, 34);
    assert.deepEqual([visible.mask[0], visible.mask[1]], [3, 3]);
    const triangles = readTriangles(extractStl(volume, 150, fullCrop(volume), createPaddingMask(volume)));
    assert.ok(triangles.length > 0);
    for (const triangle of triangles) for (const point of triangle.vertices) assertClose(point[0], 1.5, 6);
    assert.equal(volume.data, original);
    assert.equal(sourceHash(volume), before);
  });

  it('does not manufacture isosurfaces at padding while retaining real burr and VOI cuts', () => {
    const volume = makeVolume([3, 3, 3], () => 1000);
    volume.data[13] = 0; volume.series.paddingRange = [0, 0];
    assert.equal(readTriangles(extractStl(volume, 500, fullCrop(volume))).length, 0);
    volume.data[13] = 1000; volume.series.paddingRange = undefined;
    const mask = new Uint8Array(27); mask[13] = 3;
    assert.equal(readTriangles(extractStl(volume, 500, fullCrop(volume), mask)).length, 0);
    mask[13] = 1;
    const burr = extractStl(volume, 500, fullCrop(volume), mask);
    assert.ok(readTriangles(burr).length > 0);
    mask[13] = 2;
    assert.deepEqual(new Uint8Array(extractStl(volume, 500, fullCrop(volume), mask)), new Uint8Array(burr));
  });

  it('keeps padding empty even when the threshold is below the public missing-value sentinel', () => {
    const volume = makeVolume([3, 3, 3], () => 32767); volume.series.paddingRange = [32767, 32767];
    const mask = createPaddingMask(volume), crop = fullCrop(volume);
    assert.equal(pickSurface(volume, [-2, 1, 1], [1, 0, 0], REMOVED_VALUE * 2, crop, mask, 2), null);
    assert.equal(readTriangles(extractStl(volume, REMOVED_VALUE * 2, crop, mask)).length, 0);
  });
});

describe('patient-space volume geometry', () => {
  it('uses direction columns and anisotropic spacing in LPS', () => {
    const { series } = makeVolume();
    series.origin = [10, -20, 30];
    series.spacing = [1, 2, 3];
    series.direction = [0, -1, 0, 1, 0, 0, 0, 0, 1];
    assert.deepEqual(indexToPatient(series, [2, 1, 3]), [8, -18, 39]);
    assert.deepEqual(patientToIndex(series, [8, -18, 39]), [2, 1, 3]);
  });

  it('inverts sheared and reflected transforms rather than transposing them', () => {
    const { series } = makeVolume();
    series.origin = [10, -20, 30];
    series.spacing = [2, 3, 4];
    series.direction = [1, 0.5, 0, 0, 1, 0, 0, 0, -1];
    assert.deepEqual(indexToPatient(series, [2, 1, 1]), [15.5, -17, 26]);
    assert.deepEqual(patientToIndex(series, [15.5, -17, 26]), [2, 1, 1]);
  });

  it('rejects a singular transform and mismatched scalar buffer', () => {
    const volume = makeVolume();
    volume.series.direction = [1, 1, 0, 0, 0, 0, 0, 0, 1];
    assert.throws(() => patientToIndex(volume.series, [1, 2, 3]), { message: /singular/ });
    volume.series.direction.fill(0);
    assert.throws(() => patientToIndex(volume.series, [1, 2, 3]), { message: /singular/ });
    volume.data = new Float32Array(3);
    assert.throws(() => fullCrop(volume), { message: /dimensions/ });
  });

  it('rejects RGB volumes before any scalar operation', () => {
    const volume = makeVolume();
    volume.series.components = 3;
    assert.throws(() => fullCrop(volume), { message: /scalar volume/ });
  });
});

describe('volume sampling and surface picking', () => {
  it('interpolates a known affine scalar field exactly', () => {
    const volume = makeVolume([2, 2, 2], (x, y, z) => x + 2 * y + 4 * z);
    assertClose(sampleVolume(volume, [0.25, 0.5, 0.75]), 4.25, 12);
    assert.equal(sampleVolume(volume, [-0.5, 0, 0]), 0);
    assert.equal(sampleVolume(volume, [-0.51, 0, 0]), REMOVED_VALUE);
  });

  it('applies the removal mask without replacing original scalars', () => {
    const volume = makeVolume([2, 2, 2], (x, y, z) => x + 2 * y + 4 * z);
    const before = volume.data.slice();
    const mask = new Uint8Array(volume.data.length);
    mask[0] = 1;
    assert.equal(sampleVolume(volume, [0.4, 0.4, 0.4], mask), REMOVED_VALUE);
    assert.equal(sampleVolume(volume, [1, 1, 1], mask), 7);
    assert.deepEqual(volume.data, before);
  });

  it('finds an analytic threshold plane and returns millimetres along a normalized ray', () => {
    const volume = makeVolume();
    volume.series.spacing = [2, 1, 1];
    const hit = pickSurface(volume, [-10, 2, 2], [9, 0, 0], 150, fullCrop(volume));
    assert.notEqual(hit, null);
    assertClose(hit!.point[0], 3, 4);
    assertClose(hit!.index[0], 1.5, 4);
    assertClose(hit!.distance, 13, 4);
    assert.equal(pickSurface(volume, [-10, 20, 20], [1, 0, 0], 150, fullCrop(volume)), null);
  });

  it('keeps a pick inside the crop and skips carved voxels', () => {
    const volume = makeVolume();
    const mask = new Uint8Array(volume.data.length);
    for (let z = 0; z < 5; z++) for (let y = 0; y < 5; y++) mask[(z * 5 + y) * 5 + 2] = 1;
    const hit = pickSurface(volume, [-10, 2, 2], [1, 0, 0], 150, fullCrop(volume), mask);
    assertClose(hit!.point[0], 2.5, 3);
    const cropped = pickSurface(volume, [-10, 2, 2], [1, 0, 0], 150, { min: [3, 0, 0], max: [4, 4, 4] });
    assertClose(cropped!.point[0], 2.5, 6);
  });

  it('can ignore burr marks while respecting selected-volume exclusions for depth', () => {
    const volume = makeVolume();
    const mask = new Uint8Array(volume.data.length);
    for (let z = 0; z < 5; z++) for (let y = 0; y < 5; y++) {
      mask[(z * 5 + y) * 5 + 1] = 2;
      mask[(z * 5 + y) * 5 + 2] = 1;
    }
    const original = pickSurface(volume, [-10, 2, 2], [1, 0, 0], 100, fullCrop(volume), mask, 2);
    const carved = pickSurface(volume, [-10, 2, 2], [1, 0, 0], 100, fullCrop(volume), mask);
    assertClose(original!.point[0], 1.5, 3);
    assertClose(carved!.point[0], 2.5, 3);
  });

  it('picks finite anatomy through Float32/Float64 non-finite padding without changing strict sampling', () => {
    for (const BufferType of [Float32Array, Float64Array]) for (const padding of [NaN, Infinity, -Infinity]) {
      const volume = makeVolume([6, 3, 3]);
      volume.data = new BufferType(volume.data.length).fill(padding);
      volume.data[(1 * 3 + 1) * 6 + 2] = 100;
      volume.data[(1 * 3 + 1) * 6 + 3] = 300;
      const source = volume.data, before = source.slice();
      for (const offset of [0, 0.25]) {
        const hit = pickSurface(volume, [-3, 1 + offset, 1 + offset], [1, 0, 0], 200, fullCrop(volume));
        assert.deepEqual(hit?.point, [2.5, 1 + offset, 1 + offset]);
        assert.equal(hit?.distance, 5.5);
      }
      assert.equal(pickSurface(volume, [-3, 1.6, 1], [1, 0, 0], 200, fullCrop(volume)), null);
      assert.throws(() => sampleVolume(volume, [0, 1, 1]), { message: /non-finite/ });
      assert.equal(volume.data, source);
      assert.deepEqual(volume.data, before);
    }
  });
});

function rectangleKey(volume: Volume, slice: number, min: [number, number], max: [number, number], plane: Plane = 'axial'): VoiKey {
  const frame = getPlaneFrame(volume.series, { plane, slice });
  const normalPosition = frame.center.reduce((sum, value, axis) => sum + value * frame.normal[axis], 0);
  const point = (u: number, v: number): Vec3 => frame.normal.map((value, axis) => value * normalPosition + frame.u[axis] * u + frame.v[axis] * v) as Vec3;
  return { slice, plane, outline: [point(min[0], min[1]), point(max[0], min[1]), point(max[0], max[1]), point(min[0], max[1])] };
}

describe('selected-volume outlines', () => {
  it('creates rectangle and ellipse keys from annotations with 128 physical arc-length points', () => {
    const volume = makeVolume([7, 7, 7]);
    const key = rectangleKey(volume, 2, [1, 1], [5, 5]);
    const annotation: Annotation = { id: 'outline', type: 'rectangle', points: key.outline, plane: 'axial', slice: 2 };
    const rectangle = annotationToVoiKey(volume, annotation);
    assert.equal(rectangle.outline.length, 128);
    assert.equal(rectangle.plane, 'axial');
    const ellipse = annotationToVoiKey(volume, { ...annotation, type: 'ellipse' });
    assert.equal(ellipse.outline.length, 128);
    for (const [x, y, z] of ellipse.outline) {
      assert.equal(z, 2);
      assertClose(((x - 3) / 2) ** 2 + ((y - 3) / 2) ** 2, 1, 2);
    }
    assert.throws(() => annotationToVoiKey(volume, { ...annotation, type: 'polyline' }), { message: /closed polygon/ });
  });

  it('aligns reversed winding and cyclic starts before interpolating tapered rectangles', () => {
    const volume = makeVolume([9, 9, 7]);
    const a = rectangleKey(volume, 1, [1, 1], [7, 7]);
    const b = rectangleKey(volume, 5, [3, 3], [5, 5]);
    b.outline = [b.outline[2], b.outline[1], b.outline[0], b.outline[3]];
    const selection: VoiSelection = { plane: 'axial', keys: [b, a] };
    const middle = interpolateVoiOutline(volume, selection, 3);
    assert.equal(middle.kind, 'between');
    assert.equal(middle.outline.length, 128);
    assertClose(Math.min(...middle.outline.map(p => p[0])), 2);
    assertClose(Math.max(...middle.outline.map(p => p[0])), 6);
    assertClose(Math.min(...middle.outline.map(p => p[1])), 2);
    assertClose(Math.max(...middle.outline.map(p => p[1])), 6);
    const beyond = interpolateVoiOutline(volume, selection, 6);
    assert.equal(beyond.kind, 'beyond');
    assert.equal(beyond.outline.every(p => p[2] === 6), true);
    const mask = buildVoiMask(volume, selection);
    assert.equal(mask.insideCount, 49 + 25 + 25 + 9 + 9);
    assert.deepEqual(mask.crop, { min: [1, 1, 1], max: [7, 7, 5] });
    for (let z = 0; z < 7; z++) for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) {
      if (z < 1 || z > 5) assert.equal(mask.mask[(z * 9 + y) * 9 + x], 1);
    }
  });

  it('requires a second confirmed key and rejects mixed-plane, duplicate and nonplanar keys', () => {
    const volume = makeVolume([7, 7, 7]);
    const first = rectangleKey(volume, 1, [1, 1], [5, 5]);
    assert.equal(interpolateVoiOutline(volume, { plane: 'axial', keys: [first] }, 3).kind, 'beyond');
    assert.throws(() => buildVoiMask(volume, { plane: 'axial', keys: [first] }), { message: /second slice/ });
    assert.throws(() => buildVoiMask(volume, { plane: 'axial', keys: [first, first] }), { message: /one.*key/ });
    const second = rectangleKey(volume, 3, [1, 1], [5, 5]);
    assert.throws(() => buildVoiMask(volume, { plane: 'axial', keys: [first, { ...second, plane: 'coronal' }] }), { message: /same plane/ });
    second.outline[0][2] += 0.5;
    assert.throws(() => buildVoiMask(volume, { plane: 'axial', keys: [first, second] }), { message: /not on its selected plane/ });
  });

  it('uses patient-space boundaries in a sheared grid and preserves every source value', () => {
    const volume = makeVolume([7, 7, 7]);
    volume.series.direction = [1, 0, 0.5, 0, 1, 0, 0, 0, 1];
    const pristine = volume.data.slice();
    const selection: VoiSelection = { plane: 'axial', keys: [rectangleKey(volume, 1, [1, 1], [4, 4]), rectangleKey(volume, 4, [1, 1], [4, 4])] };
    const result = buildVoiMask(volume, selection);
    assert.equal(result.insideCount, 40);
    assert.deepEqual(result.crop, { min: [0, 1, 1], max: [3, 4, 3] });
    assert.deepEqual(volume.data, pristine);
  });

  it('matches an analytic physical prism when all three voxel axes cross the plane', () => {
    const volume = makeVolume([7, 7, 7]);
    volume.series.direction = [1, 0, 0, 0, 1, 0, 0.25, 0.4, 1];
    const selection: VoiSelection = { plane: 'axial', keys: [rectangleKey(volume, 1, [1, 1], [4, 4]), rectangleKey(volume, 4, [1, 1], [4, 4])] };
    const firstZ = selection.keys[0].outline[0][2], lastZ = selection.keys[1].outline[0][2];
    const result = buildVoiMask(volume, selection);
    let expectedCount = 0;
    for (let z = 0; z < 7; z++) for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) {
      const patientZ = 0.25 * x + 0.4 * y + z;
      const inside = x >= 1 && x <= 4 && y >= 1 && y <= 4 && patientZ >= firstZ - 1e-6 && patientZ <= lastZ + 1e-6;
      assert.equal(result.mask[(z * 7 + y) * 7 + x], inside ? 0 : 1);
      if (inside) expectedCount++;
    }
    assert.equal(result.insideCount, expectedCount);
  });

  it('matches async masks, reports progress and cancels before allocation', async () => {
    const volume = makeVolume([7, 7, 7]);
    const selection: VoiSelection = { plane: 'axial', keys: [rectangleKey(volume, 1, [1, 1], [5, 5]), rectangleKey(volume, 5, [1, 1], [5, 5])] };
    const progress: number[] = [];
    const sync = buildVoiMask(volume, selection);
    const asyncResult = await buildVoiMaskAsync(volume, selection, { onProgress: value => progress.push(value) });
    assert.deepEqual(asyncResult, sync);
    assert.equal(progress[0], 0); assert.equal(progress.at(-1), 1);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(buildVoiMaskAsync(volume, selection, { signal: controller.signal }), { message: /cancelled/ });
  });
});

function sourceVolume(order = 1): Volume {
  const volume = makeVolume([7, 7, 5]);
  const cosine = Math.cos(Math.PI / 6), sine = Math.sin(Math.PI / 6);
  const u: Vec3 = [cosine, 0, sine], normal: Vec3 = [-sine, 0, cosine];
  const step = normal.map((value, axis) => order * value * 2 + u[axis] * 0.4) as Vec3;
  const spacing = Math.hypot(...step);
  volume.series.origin = [10, -20, 5];
  volume.series.spacing = [1, 1, spacing];
  volume.series.direction = [u[0], 0, step[0] / spacing, u[1], 1, step[1] / spacing, u[2], 0, step[2] / spacing];
  volume.series.orientationKnown = true; volume.series.positionKnown = true; volume.series.spacingKnown = true;
  volume.series.frameMetadata = Array.from({ length: 5 }, (_, index) => ({
    origin: indexToPatient(volume.series, [0, 0, index]),
    direction: [u[0], 0, normal[0], u[1], 1, normal[1], u[2], 0, normal[2]], spacing: [1, 1, 2],
    orientationKnown: true, positionKnown: true, spacingKnown: true,
  }));
  return volume;
}

function sourceRectangle(volume: Volume, sourceFrame: number, low: number, high: number): Annotation {
  return { id: `source-${sourceFrame}`, type: 'rectangle', plane: 'axial', mode: 'source', sourceFrame, slice: sourceFrame,
    points: [[low, low, sourceFrame], [high, low, sourceFrame], [high, high, sourceFrame], [low, high, sourceFrame]].map(point => indexToPatient(volume.series, point as Vec3)) };
}

describe('source-frame selected volumes', () => {
  it('interpolates oblique acquired outlines using signed plane spacing through gantry shear', () => {
    for (const [order, useMetadata] of [[1, true], [-1, true], [1, false]] as const) {
      const volume = sourceVolume(order);
      if (!useMetadata) volume.series.frameMetadata = undefined;
      const firstAnnotation = sourceRectangle(volume, 1, 1, 5);
      const first = annotationToVoiKey(volume, { ...firstAnnotation, slice: 999 });
      const last = annotationToVoiKey(volume, sourceRectangle(volume, 3, 2, 4));
      assert.equal(first.slice, 1); assert.equal(first.sourceFrame, 1); assert.equal(first.mode, 'source');
      const selection: VoiSelection = { plane: 'axial', mode: 'source', keys: [first, last] };
      const between = interpolateVoiOutline(volume, selection, 2);
      assert.equal(between.kind, 'between');
      const indices = between.outline.map(point => patientToIndex(volume.series, point));
      for (const index of indices) assertClose(index[2], 2, 10);
      assertClose(Math.min(...indices.map(point => point[0])), 1.5, 10);
      assertClose(Math.max(...indices.map(point => point[0])), 4.5, 10);
      const carried = interpolateVoiOutline(volume, selection, 4);
      assert.equal(carried.kind, 'beyond');
      const carriedIndex = patientToIndex(volume.series, carried.outline[0]);
      const originalIndex = patientToIndex(volume.series, last.outline[0]);
      assertClose(carriedIndex[0], originalIndex[0] - 0.4, 10);
      assertClose(carriedIndex[2], 4, 10);
      const source = volume.data, before = source.slice();
      const result = buildVoiMask(volume, selection);
      assert.equal(result.insideCount, 43);
      assert.deepEqual(result.crop, { min: [1, 1, 1], max: [5, 5, 3] });
      for (let z = 0; z < 5; z++) for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) {
        const inside = z === 1 ? x >= 1 && x <= 5 && y >= 1 && y <= 5 : z === 2 || z === 3 ? x >= 2 && x <= 4 && y >= 2 && y <= 4 : false;
        assert.equal(result.mask[(z * 7 + y) * 7 + x], inside ? 0 : 1);
      }
      assert.equal(volume.data, source); assert.deepEqual(volume.data, before);
    }
  });

  it('rejects source/MPR mixing and heterogeneous source geometry', () => {
    const volume = sourceVolume();
    const first = annotationToVoiKey(volume, sourceRectangle(volume, 1, 1, 5));
    const last = annotationToVoiKey(volume, sourceRectangle(volume, 3, 2, 4));
    assert.throws(() => buildVoiMask(volume, { plane: 'axial', mode: 'source', keys: [first, { ...last, mode: 'mpr', sourceFrame: undefined }] }), { message: /Source and MPR/ });
    assert.throws(() => buildVoiMask(volume, { plane: 'axial', keys: [first, last] }), { message: /Source and MPR/ });
    const irregular = sourceVolume();
    irregular.series.frameMetadata![3].origin[0] += 0.1;
    assert.throws(() => annotationToVoiKey(irregular, sourceRectangle(irregular, 1, 1, 5)), { message: /equally spaced/ });
    const rotated = sourceVolume();
    rotated.series.frameMetadata![3].direction[0] += 0.05;
    assert.throws(() => annotationToVoiKey(rotated, sourceRectangle(rotated, 1, 1, 5)), { message: /parallel matching/ });
    const incomplete = sourceVolume(); incomplete.series.frameMetadata!.pop();
    assert.throws(() => annotationToVoiKey(incomplete, sourceRectangle(incomplete, 1, 1, 5)), { message: /incomplete/ });
  });

  it('uses the source screen projection and rejects a one-frame buffer for visible-region 3D', async () => {
    const volume = sourceVolume();
    const view: ViewState = { plane: 'axial', mode: 'source', slice: 2, zoom: 2, pan: [20, -30], rotation: 17,
      flipX: true, flipY: false, windowCenter: 40, windowWidth: 400, inverted: false };
    const size: [number, number] = [500, 400], mapping = screenMapping(volume.series, view, ...size);
    const result = await buildVisibleRegionMaskAsync(volume, view, size);
    let count = 0;
    for (let z = 0; z < 5; z++) for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) {
      const [px, py] = worldToScreen(mapping, indexToPatient(volume.series, [x, y, z]));
      const inside = px >= 0 && px <= size[0] && py >= 0 && py <= size[1];
      assert.equal(result.mask[(z * 7 + y) * 7 + x], inside ? 0 : 1);
      if (inside) count++;
    }
    assert.equal(result.insideCount, count);
    const partial: Volume = { ...volume, sourceFrameIndex: 2, data: volume.data.subarray(98, 147) };
    await assert.rejects(buildVisibleRegionMaskAsync(partial, view, size), { message: /complete series/ });
  });
});

describe('visible-region volume selection', () => {
  const view: ViewState = { plane: 'axial', slice: 2, windowCenter: 40, windowWidth: 400,
    zoom: 2, pan: [100, -100], rotation: 0, flipX: false, flipY: false, inverted: false };

  it('selects the analytic zoomed and panned screen prism through every depth', async () => {
    const volume = makeVolume();
    const source = volume.data, before = source.slice();
    const result = await buildVisibleRegionMaskAsync(volume, view, [500, 500]);
    assert.equal(result.insideCount, 20);
    assert.deepEqual(result.crop, { min: [1, 2, 0], max: [2, 3, 4] });
    for (let z = 0; z < 5; z++) for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) {
      assert.equal(result.mask[(z * 5 + y) * 5 + x], x >= 1 && x <= 2 && y >= 2 && y <= 3 ? 0 : 1);
    }
    assert.equal(volume.data, source);
    assert.deepEqual(volume.data, before);
  });

  it('matches projected voxel centres under oblique, rotation, flip and shear transforms', async () => {
    const volume = makeVolume([6, 5, 4]);
    volume.series.origin = [10, -7, 3];
    volume.series.spacing = [0.7, 1.2, 2.5];
    volume.series.direction = [0.8, -0.4, 0.2, 0.4, 0.8, -0.1, 0.15, 0.25, 1];
    const size: [number, number] = [480, 320];
    for (const plane of ['axial', 'coronal', 'sagittal'] as const) {
      const transformed: ViewState = { ...view, plane, zoom: 1.4, pan: [37, -23], rotation: 31, flipX: true, flipY: true, oblique: [17, -23] };
      const mapping = screenMapping(volume.series, transformed, ...size);
      const result = await buildVisibleRegionMaskAsync(volume, transformed, size);
      const expectedMin: Vec3 = [6, 5, 4], expectedMax: Vec3 = [-1, -1, -1];
      let count = 0;
      for (let z = 0; z < 4; z++) for (let y = 0; y < 5; y++) for (let x = 0; x < 6; x++) {
        const point: Vec3 = [x, y, z];
        const [px, py] = worldToScreen(mapping, indexToPatient(volume.series, point));
        const inside = px >= 0 && px <= size[0] && py >= 0 && py <= size[1];
        assert.equal(result.mask[(z * 5 + y) * 6 + x], inside ? 0 : 1);
        if (inside) {
          count++;
          for (let axis = 0; axis < 3; axis++) { expectedMin[axis] = Math.min(expectedMin[axis], point[axis]); expectedMax[axis] = Math.max(expectedMax[axis], point[axis]); }
        }
      }
      assert.equal(result.insideCount, count);
      assert.deepEqual(result.crop, { min: expectedMin, max: expectedMax });
    }
  });

  it('rejects empty views and supports cancellation without a mask result', async () => {
    const volume = makeVolume();
    await assert.rejects(buildVisibleRegionMaskAsync(volume, { ...view, pan: [10000, 10000] }, [500, 500]), { message: /no voxel centres/ });
    await assert.rejects(buildVisibleRegionMaskAsync(volume, view, [0, 500]), { message: /visible width and height/ });
    const controller = new AbortController(); controller.abort();
    await assert.rejects(buildVisibleRegionMaskAsync(volume, view, [500, 500], { signal: controller.signal }), { message: /cancelled/ });
  });
});

describe('virtual burr', () => {
  it('carves a physical sphere in an anisotropic volume and restores its stroke', () => {
    const volume = makeVolume([5, 5, 5], () => 1200);
    volume.series.spacing = [1, 2, 3];
    const pristine = volume.data.slice();
    const mask = new Uint8Array(volume.data.length);
    const removed = carveSphere(volume, mask, [2, 4, 6], 2.1, fullCrop(volume));
    const flat = (x: number, y: number, z: number) => (z * 5 + y) * 5 + x;
    const expected = [flat(0, 2, 2), flat(1, 2, 2), flat(2, 2, 2), flat(3, 2, 2), flat(4, 2, 2), flat(2, 1, 2), flat(2, 3, 2)];
    assert.deepEqual([...removed].sort((a, b) => a - b), expected.sort((a, b) => a - b));
    assert.equal(carveSphere(volume, mask, [2, 4, 6], 1, fullCrop(volume)).length, 0);
    assert.deepEqual(volume.data, pristine);
    restoreCarve(mask, removed);
    assert.equal(mask.every(value => value === 0), true);
  });

  it('respects crop bounds and leaves masks untouched on invalid inputs', () => {
    const volume = makeVolume();
    const mask = new Uint8Array(volume.data.length);
    const removed = carveSphere(volume, mask, [2, 2, 2], 1.1, { min: [2, 2, 2], max: [2, 2, 2] });
    assert.deepEqual([...removed], [62]);
    const before = mask.slice();
    assert.throws(() => carveSphere(volume, mask, [2, 2, 2], 2, { min: [-1, 0, 0], max: [4, 4, 4] }), { message: /crop/ });
    assert.deepEqual(mask, before);
  });
});

function readTriangles(buffer: ArrayBuffer): { normal: Vec3; vertices: Vec3[] }[] {
  const view = new DataView(buffer);
  const count = view.getUint32(80, true);
  assert.equal(buffer.byteLength, 84 + count * 50);
  return Array.from({ length: count }, (_, triangle) => {
    const vectors = Array.from({ length: 4 }, (_, vector) => [0, 1, 2].map(axis => view.getFloat32(84 + triangle * 50 + (vector * 3 + axis) * 4, true)) as Vec3);
    return { normal: vectors[0], vertices: vectors.slice(1) };
  });
}

describe('binary STL isosurface export', () => {
  it('extracts an analytic plane with the correct physical area and outward winding', () => {
    const volume = makeVolume([2, 2, 2], x => x);
    volume.series.spacing = [2, 3, 4];
    volume.series.origin = [10, 20, 30];
    const triangles = readTriangles(extractStl(volume, 0.5, fullCrop(volume)));
    assert.ok(triangles.length > 0);
    let area = 0;
    for (const { vertices: [a, b, c], normal } of triangles) {
      for (const point of [a, b, c]) {
        assert.equal(point[0], 11);
        assert.ok(point[1] >= 20); assert.ok(point[1] <= 23);
        assert.ok(point[2] >= 30); assert.ok(point[2] <= 34);
      }
      const signedTwiceArea = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
      assert.ok(signedTwiceArea < 0);
      for (let axis = 0; axis < 3; axis++) assertClose(normal[axis], axis === 0 ? -1 : 0);
      area += Math.abs(signedTwiceArea) / 2;
    }
    assertClose(area, 12, 8);
  });

  it('reverses physical winding correctly for a reflected direction matrix', () => {
    const volume = makeVolume([2, 2, 2], x => x);
    volume.series.spacing = [2, 3, 4];
    volume.series.origin = [10, 20, 30];
    volume.series.direction = [-1, 0, 0, 0, 1, 0, 0, 0, 1];
    const triangles = readTriangles(extractStl(volume, 0.5, fullCrop(volume)));
    for (const triangle of triangles) {
      for (const point of triangle.vertices) assert.equal(point[0], 9);
      for (let axis = 0; axis < 3; axis++) assertClose(triangle.normal[axis], axis === 0 ? 1 : 0);
    }
  });

  it('exports the carved field without changing the original and enforces a triangle budget', () => {
    const volume = makeVolume([3, 3, 3], () => 1000);
    const mask = new Uint8Array(27); mask[13] = 1;
    const before = volume.data.slice();
    const triangles = readTriangles(extractStl(volume, 500, fullCrop(volume), mask));
    assert.ok(triangles.length > 0);
    for (const triangle of triangles) for (const point of triangle.vertices) for (const coordinate of point) {
      assert.ok(coordinate >= 0.5);
      assert.ok(coordinate <= 1.5);
    }
    assert.deepEqual(volume.data, before);
    assert.throws(() => extractStl(volume, 500, fullCrop(volume), mask, 1), { message: /exceeds/ });
  });

  it('intersects scalar and mask surfaces without shifting the scalar threshold', () => {
    const volume = makeVolume([2, 2, 2], x => x);
    const mask = new Uint8Array(8);
    for (let i = 1; i < mask.length; i += 2) mask[i] = 1;
    const triangles = readTriangles(extractStl(volume, 0.25, fullCrop(volume), mask));
    const positions = new Set(triangles.flatMap(triangle => triangle.vertices.map(point => point[0])));
    assert.deepEqual([...positions].sort((a, b) => a - b), [0.25, 0.5]);
    for (const triangle of triangles) {
      const x = triangle.vertices[0][0];
      assert.equal(triangle.vertices.every(point => point[0] === x), true);
      assertClose(triangle.normal[0], x === 0.25 ? -1 : 1);
    }
  });

  it('preserves compact integer source buffers through sampling, carving and precise export', () => {
    const volume = makeVolume([2, 2, 2], x => x * 1001);
    volume.data = new Int16Array(volume.data);
    const original = volume.data;
    const before = original.slice();
    const mask = new Uint8Array(8);
    const removed = carveSphere(volume, mask, [0, 0, 0], 0.1, fullCrop(volume));
    restoreCarve(mask, removed);
    assert.equal(sampleVolume(volume, [0.5, 0.5, 0.5], mask), 500.5);
    for (const triangle of readTriangles(extractStl(volume, 500.5, fullCrop(volume), mask))) {
      for (const point of triangle.vertices) assert.equal(point[0], 0.5);
    }
    assert.equal(volume.data, original);
    assert.deepEqual(volume.data, before);
  });

  it('preserves Float64 differences above Float32 precision in sampling, picking and STL', () => {
    const volume = makeVolume([2, 2, 2], x => x);
    const offset = 2 ** 40;
    volume.data = Float64Array.from(volume.data, value => offset + value);
    volume.series.pixelType = 'float64';
    const source = volume.data, before = source.slice(), mask = new Uint8Array(8);
    assert.equal(sampleVolume(volume, [0.5, 0.5, 0.5]), offset + 0.5);
    const hit = pickSurface(volume, [-1, 0.5, 0.5], [1, 0, 0], offset + 0.5, fullCrop(volume), mask);
    assert.deepEqual(hit?.point, [0.5, 0.5, 0.5]);
    assert.equal(hit?.distance, 1.5);
    const triangles = readTriangles(extractStl(volume, offset + 0.5, fullCrop(volume), mask));
    assert.ok(triangles.length > 0);
    for (const triangle of triangles) for (const point of triangle.vertices) assert.equal(point[0], 0.5);
    const removed = carveSphere(volume, mask, [0, 0, 0], 0.1, fullCrop(volume));
    restoreCarve(mask, removed);
    assert.equal(volume.data, source);
    assert.deepEqual(volume.data, before);
    assert.equal(sampleVolume(volume, [0.5, 0.5, 0.5], mask), offset + 0.5);
  });

  it('excludes cells touching invalid scalars and matches async extraction to the same geometry', async () => {
    const volume = makeVolume([3, 3, 3], (x, y, z) => x + y + z);
    const sync = extractStl(volume, 2.5, fullCrop(volume));
    const asyncResult = await extractStlAsync(volume, 2.5, fullCrop(volume));
    assert.deepEqual(new Uint8Array(asyncResult), new Uint8Array(sync));
    volume.data[0] = NaN;
    const validCells = readTriangles(extractStl(volume, 2.5, fullCrop(volume)));
    assert.ok(validCells.length > 0);
    assert.ok(validCells.length < readTriangles(sync).length);
    for (const triangle of validCells) for (const point of triangle.vertices) assertClose(point.reduce((sum, value) => sum + value, 0), 2.5, 5);
  });

  it('reports progress before extraction and honors cancellation before doing work', async () => {
    const volume = makeVolume();
    const progress: number[] = [];
    await extractStlAsync(volume, 150, fullCrop(volume), undefined, { onProgress: fraction => progress.push(fraction) });
    assert.equal(progress[0], 0);
    assert.equal(progress.at(-1), 1);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(extractStlAsync(volume, 150, fullCrop(volume), undefined, { signal: controller.signal }), { message: /cancelled/ });
  });
});
