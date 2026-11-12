import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertClose } from './support';
import type { Series, Vec3, ViewState } from '../src/model';
import { acquiredPlane, autoWindow, fullRangeWindow, getPlaneFrame, sameFacing, indexToWorld, inverse3, isPaddingValue, orientationLabel, reconstructedWindow, sampleVolume, screenMapping, screenToWorld, sliceAtWorld, sliceCount, sourceFrameSeries, windowPlane, worldToIndex, worldToScreen } from '../src/imaging/geometry';

const base: Series = {
  id: 'geometry', uid: '1', studyUid: '2', patientId: 'TEST', patientName: 'Synthetic',
  studyDate: '', description: 'Known geometry', modality: 'CT', seriesNumber: 1,
  dimensions: [4, 5, 6], spacing: [2, 3, 4], origin: [10, 20, 30],
  direction: [1, 0, 0, 0, 1, 0, 0, 0, 1], windowCenter: 40, windowWidth: 400,
  valueUnit: 'HU', suvFactor: null, canReconstruct: true, warnings: [], photometricInterpretation: 'MONOCHROME2',
};
const view: ViewState = { plane: 'axial', slice: 2, windowCenter: 40, windowWidth: 400, zoom: 1, pan: [0, 0], rotation: 0, flipX: false, flipY: false, inverted: false };
const expectPoint = (actual: Vec3 | number[], expected: number[]) => actual.forEach((n, i) => assertClose(n, expected[i], 8));

describe('DICOM patient geometry', () => {
  it('maps anisotropic image coordinates to LPS with a nonzero origin', () => {
    assert.deepEqual(indexToWorld(base, [2, 3, 4]), [14, 29, 46]);
    expectPoint(worldToIndex(base, [14, 29, 46]), [2, 3, 4]);
  });
  it('honours direction columns rather than treating the matrix as rows', () => {
    const rotated = { ...base, direction: [0, -1, 0, 1, 0, 0, 0, 0, 1] };
    // i points posterior, j points right. 2i + 3j at spacing 2,3 gives (-9,+4,0).
    assert.deepEqual(indexToWorld(rotated, [2, 3, 4]), [1, 24, 46]);
    expectPoint(worldToIndex(rotated, [1, 24, 46]), [2, 3, 4]);
  });
  it('inverts sheared slice geometry for gantry tilt', () => {
    const sheared = { ...base, direction: [1, 0, 0.25, 0, 1, 0, 0, 0, 1] };
    // Four k steps contribute 16mm superior and 4mm left, in addition to 4mm from i.
    assert.deepEqual(indexToWorld(sheared, [2, 3, 4]), [18, 29, 46]);
    expectPoint(worldToIndex(sheared, [18, 29, 46]), [2, 3, 4]);
    expectPoint(worldToIndex(sheared, [14, 29, 46]), [0, 3, 4]);
  });
  it('rejects singular directions and invalid pixel spacing', () => {
    assert.throws(() => inverse3([1, 0, 0, 1, 0, 0, 0, 0, 1]), { message: /non-invertible/ });
    assert.throws(() => worldToIndex({ ...base, spacing: [0, 1, 1] }, [0, 0, 0]), { message: /spacing/ });
  });
});

describe('patient plane frames', () => {
  it('creates correctly sized axial, coronal and sagittal frames', () => {
    const axial = getPlaneFrame(base, view);
    expectPoint(axial.center, [13, 26, 38]);
    assert.deepEqual([axial.widthMm, axial.heightMm, axial.step, axial.slices], [8, 15, 4, 6]);
    const coronal = getPlaneFrame(base, { plane: 'coronal', slice: 2 });
    expectPoint(coronal.center, [13, 26, 40]);
    assert.deepEqual(coronal.v, [0, 0, -1]);
    assert.deepEqual([coronal.widthMm, coronal.heightMm, coronal.step, coronal.slices], [8, 24, 3, 5]);
    const sagittal = getPlaneFrame(base, { plane: 'sagittal', slice: 1 });
    expectPoint(sagittal.center, [14, 26, 40]);
    assert.deepEqual([sagittal.widthMm, sagittal.heightMm, sagittal.step, sagittal.slices], [15, 24, 2, 4]);
  });
  it('computes canonical counts for rotated acquisitions and maps linked points', () => {
    const rotated = { ...base, direction: [0, -1, 0, 1, 0, 0, 0, 0, 1] };
    assert.equal(sliceCount(rotated, 'coronal'), 4);
    assert.equal(sliceCount(rotated, 'sagittal'), 5);
    assert.equal(sliceAtWorld(rotated, 'axial', [1, 24, 46]), 4);
    assert.equal(sliceAtWorld(rotated, 'coronal', [1, 24, 46]), 2);
    assert.equal(sliceAtWorld(rotated, 'sagittal', [1, 24, 46]), 3);
  });
  it('keeps source frame geometry for unreconstructable and RGB images', () => {
    const source = { ...base, canReconstruct: false, direction: [0, -1, 0, 1, 0, 0, 0, 0, 1] };
    const frame = getPlaneFrame(source, view);
    expectPoint(frame.center, [4, 23, 38]);
    assert.deepEqual(frame.u, [0, 1, 0]);
    assert.deepEqual(frame.v, [-1, 0, 0]);
    assert.deepEqual([frame.widthMm, frame.heightMm, frame.slices], [8, 15, 6]);
    assert.deepEqual(getPlaneFrame({ ...source, canReconstruct: true, components: 3 }, view), frame);
    assert.deepEqual(getPlaneFrame({ ...source, canReconstruct: true, sourceFramesOnly: true }, view), frame);
    assert.equal(sliceCount({ ...source, canReconstruct: true, sourceFramesOnly: true }, 'axial'), 6);
  });
  it('fits the rotated plane to its patient-space extent', () => {
    const frame = getPlaneFrame(base, { ...view, oblique: [90, 0] });
    expectPoint(frame.center, [13, 26, 40]);
    expectPoint(frame.u, [1, 0, 0]);
    expectPoint(frame.v, [0, 0, 1]);
    expectPoint(frame.normal, [0, -1, 0]);
  });
  it('pages a90-degree oblique plane along its tilted normal', () => {
    const first = getPlaneFrame(base, { ...view, slice: 1, oblique: [90, 0] });
    const next = getPlaneFrame(base, { ...view, slice: 2, oblique: [90, 0] });
    expectPoint(next.center.map((n, i) => n - first.center[i]), [0, -3, 0]);
    assert.equal(sliceCount(base, { ...view, oblique: [90, 0] }), 5);
    assert.equal(sliceAtWorld(base, { ...view, oblique: [90, 0] }, [13, 26, 38]), 2);
  });
  it('covers a45-degree plane range with consecutive parallel planes', () => {
    const cube = { ...base, dimensions: [3, 3, 3] as Vec3, spacing: [1, 1, 1] as Vec3, origin: [0, 0, 0] as Vec3 };
    const tilted: ViewState = { ...view, slice: 0, mode: 'mpr', oblique: [45, 0] };
    const first = getPlaneFrame(cube, tilted), next = getPlaneFrame(cube, { ...tilted, slice: 1 }), last = getPlaneFrame(cube, { ...tilted, slice: 3 });
    assert.equal(sliceCount(cube, tilted), 4);
    expectPoint(first.center, [1, 2, 0]);
    expectPoint(last.center, [1, 0, 2]);
    expectPoint(next.center.map((n, i) => n - first.center[i]), [0, -2 / 3, 2 / 3]);
    assertClose(first.step, 2 * Math.SQRT2 / 3);
    assert.equal(sliceAtWorld(cube, tilted, [1, 4 / 3, 2 / 3]), 1);
  });
  it('uses both tilt angles before calculating the paging direction', () => {
    const cube = { ...base, dimensions: [3, 3, 3] as Vec3, spacing: [1, 1, 1] as Vec3, origin: [0, 0, 0] as Vec3 };
    const first = getPlaneFrame(cube, { ...view, slice: 0, oblique: [45, 30] });
    const next = getPlaneFrame(cube, { ...view, slice: 1, oblique: [45, 30] });
    const step = (1 + Math.sqrt(6)) / 4;
    expectPoint(first.normal, [0.5, -Math.sqrt(6) / 4, Math.sqrt(6) / 4]);
    expectPoint(next.center.map((n, i) => n - first.center[i]), [0.5 * step, -Math.sqrt(6) / 4 * step, Math.sqrt(6) / 4 * step]);
  });
});

describe('acquired frame metadata', () => {
  it('uses the selected frame origin, axes, spacing and window without changing source metadata', () => {
    const series: Series = { ...base, dimensions: [4, 5, 2], frameMetadata: [
      { origin: [0, 0, 0], direction: base.direction, spacing: [1, 1, 1] },
      { origin: [110, 200, 300], direction: [0, 1, 0, 0, 0, 1, 1, 0, 0], spacing: [3, 4, 5], windowCenter: 12, windowWidth: 34, paddingRange: [-1000, -900] },
    ] };
    const local = sourceFrameSeries(series, 1), frame = getPlaneFrame(series, { ...view, mode: 'source', slice: 1 });
    assert.deepEqual(local.dimensions, [4, 5, 1]);
    assert.deepEqual(indexToWorld(local, [2, 3, 0]), [122, 200, 306]);
    expectPoint(frame.center, [118, 200, 304.5]);
    expectPoint(frame.normal, [0, 1, 0]);
    assert.deepEqual([frame.widthMm, frame.heightMm], [12, 20]);
    assert.deepEqual([local.windowCenter, local.windowWidth], [12, 34]);
    assert.equal(isPaddingValue(local, -950), true);
    assert.deepEqual(series.origin, [10, 20, 30]);
    assert.deepEqual(series.dimensions, [4, 5, 2]);
  });
  it('finds the nearest acquired plane for an irregularly spaced stack', () => {
    const series: Series = { ...base, dimensions: [4, 5, 3], frameMetadata: [0, 10, 11].map(z => ({ origin: [0, 0, z] as Vec3, direction: base.direction, spacing: [1, 1, 1] as Vec3 })) };
    assert.equal(sliceAtWorld(series, { ...view, mode: 'source' }, [2, 2, 9.2]), 1);
    assert.equal(sliceAtWorld(series, { ...view, mode: 'source' }, [2, 2, 10.8]), 2);
    assert.equal(sliceCount(series, { ...view, mode: 'source', oblique: [45, 0] }), 3);
  });
  it('preserves gantry-tilt shifts when source metadata uses the shared affine geometry', () => {
    const tilted = { ...base, direction: [1, 0, 0.25, 0, 1, 0, 0, 0, 1] };
    assert.deepEqual(sourceFrameSeries(tilted, 2).origin, [12, 20, 38]);
    expectPoint(getPlaneFrame(tilted, { ...view, mode: 'source' }).center, [15, 26, 38]);
    expectPoint(worldToIndex(sourceFrameSeries(tilted, 2), [16, 29, 38]), [2, 3, 0]);
  });
  it('excludes per-frame padding from auto window, including a single-frame preview', () => {
    const series: Series = { ...base, dimensions: [2, 1, 2], spacing: [1, 1, 1], origin: [0, 0, 0], frameMetadata: [
      { origin: [0, 0, 0], direction: base.direction, spacing: [1, 1, 1], paddingRange: [-1000, -1000] },
      { origin: [0, 0, 10], direction: base.direction, spacing: [1, 1, 1], paddingRange: [-2000, -2000] },
    ] };
    const volume = { series, data: new Float64Array([-1000, 100, -2000, 500]) };
    assert.deepEqual(autoWindow(volume, 0), { windowCenter: 100, windowWidth: 1 });
    assert.deepEqual(autoWindow(volume, 1), { windowCenter: 500, windowWidth: 1 });
    assert.deepEqual(autoWindow(volume), { windowCenter: 300, windowWidth: 392 });
    const preview = { series, data: new Float64Array([-2000, 500]), sourceFrameIndex: 1 };
    assert.deepEqual(autoWindow(preview), { windowCenter: 500, windowWidth: 1 });
    assert.equal(autoWindow(preview, 0), null);
    assert.equal(sampleVolume(preview, [1, 0, 10]), 500);
    assert.equal(sampleVolume(preview, [0, 0, 10]), NaN);
    assert.equal(volume.data[0], -1000);
  });
  it('compares padding endpoints in the actual decoded numeric representation', () => {
    const float32: Series = { ...base, pixelType: 'float32', paddingRange: [-3276.8, -3276.8] };
    assert.equal(isPaddingValue(float32, Math.fround(-3276.8)), true);
    assert.equal(isPaddingValue(float32, Math.fround(-3276.7)), false);
    const float64: Series = { ...float32, pixelType: 'float64' };
    assert.equal(isPaddingValue(float64, -3276.8), true);
    assert.equal(isPaddingValue(float64, Math.fround(-3276.8)), false);
  });
  it('honors a frame-specific NaN padding flag without masking finite values', () => {
    const series: Series = { ...base, paddingIsNaN: true, frameMetadata: [{ origin: base.origin, direction: base.direction, spacing: base.spacing, paddingIsNaN: false }] };
    assert.equal(isPaddingValue(series, NaN), true);
    assert.equal(isPaddingValue(series, NaN, 0), false);
    assert.equal(isPaddingValue(series, 0), false);
    assert.equal(isPaddingValue(series, Infinity), false);
  });
  it('excludes each frame’s finite padding before trilinear interpolation', () => {
    const series: Series = { ...base, dimensions: [2, 1, 2], spacing: [1, 1, 1], origin: [0, 0, 0], frameMetadata: [
      { origin: [0, 0, 0], direction: base.direction, spacing: [1, 1, 1], paddingRange: [-1000, -1000] },
      { origin: [0, 0, 1], direction: base.direction, spacing: [1, 1, 1], paddingRange: [-2000, -2000] },
    ] };
    const volume = { series, data: new Int16Array([10, -1000, 30, -2000]) };
    assert.equal(sampleVolume(volume, [0.25, 0, 0.25], true), 15);
    assert.equal(sampleVolume(volume, [0.25, 0, 0.75], true), 25);
    assert.equal(sampleVolume(volume, [0.75, 0, 0.25], true), NaN);
    assert.equal(sampleVolume(volume, [1, 0, 1], false), NaN);
    assert.deepEqual([...volume.data], [10, -1000, 30, -2000]);
  });
});

describe('screen transforms and sampling', () => {
  it('fits millimetres rather than stretching anisotropic pixels', () => {
    const mapping = screenMapping(base, view, 160, 150);
    assert.equal(mapping.pixelsPerMm, 10);
    expectPoint(screenToWorld(mapping, 100, 105), [15, 29, 38]);
    expectPoint(worldToScreen(mapping, [15, 29, 38]), [100, 105]);
  });
  it('applies rotation, zoom, pan and reflection consistently to measurements', () => {
    const mapping = screenMapping(base, { ...view, rotation: 90, zoom: 2, pan: [5, -3], flipX: true }, 160, 150);
    // Centre is (85,72). Screen-right is patient +y, screen-down is patient +x, 20px/mm.
    expectPoint(screenToWorld(mapping, 125, 92), [14, 28, 38]);
    expectPoint(worldToScreen(mapping, [14, 28, 38]), [125, 92]);
  });
  it('samples a known linear field and clamps only within voxel-edge extent', () => {
    const series = { ...base, dimensions: [2, 2, 2] as Vec3, spacing: [1, 1, 1] as Vec3, origin: [0, 0, 0] as Vec3 };
    const volume = { series, data: new Int16Array([0, 10, 20, 30, 40, 50, 60, 70]) };
    assert.equal(sampleVolume(volume, [0.25, 0.5, 0.75], true), 42.5);
    assert.equal(sampleVolume(volume, [-0.4, 0, 0], true), 0);
    assert.equal(sampleVolume(volume, [-0.6, 0, 0], true), null);
    assert.equal(sampleVolume(volume, [1, 1, 1]), 70);
    assert.equal(sampleVolume({ ...volume, series: { ...series, components: 3 } }, [0, 0, 0]), null);
  });
  it('labels patient LPS directions including oblique directions', () => {
    assert.equal(orientationLabel([1, 0, 0]), 'L');
    assert.equal(orientationLabel([0, -1, 0]), 'A');
    assert.equal(orientationLabel([0, 0, -1]), 'I');
    assert.equal(orientationLabel([0.6, 0.8, 0]), 'PL');
  });
  it('keeps Float64 source values exact for quantitative sampling', () => {
    const series = { ...base, dimensions: [2, 1, 1] as Vec3, spacing: [1, 1, 1] as Vec3, origin: [0, 0, 0] as Vec3 };
    const volume = { series, data: new Float64Array([16_777_217, 16_777_219]) };
    assert.equal(sampleVolume(volume, [0, 0, 0]), 16_777_217);
    assert.equal(sampleVolume(volume, [1, 0, 0]), 16_777_219);
    assert.equal(sampleVolume(volume, [0.5, 0, 0], true), 16_777_218);
    const wide = { series, data: new Float64Array([-2_147_483_648, 4_294_967_295]) };
    assert.equal(sampleVolume(wide, [0, 0, 0]), -2_147_483_648);
    assert.equal(sampleVolume(wide, [1, 0, 0]), 4_294_967_295);
  });
  it('keeps finite values visible beside non-finite padding without assigning values to missing pixels', () => {
    const series = { ...base, dimensions: [2, 2, 1] as Vec3, spacing: [1, 1, 1] as Vec3, origin: [0, 0, 0] as Vec3 };
    const volume = { series, data: new Float64Array([10, NaN, Infinity, -Infinity]) };
    assert.equal(sampleVolume(volume, [0, 0, 0], true), 10);
    assert.equal(sampleVolume(volume, [0.25, 0.25, 0], true), 10);
    assert.equal(sampleVolume(volume, [1, 0, 0], true), NaN);
    assert.equal(sampleVolume(volume, [0.75, 0.25, 0], true), NaN);
    assert.equal(volume.data[2], Infinity);
  });
});

import { planeIntersection, type PlaneFrame } from '../src/imaging/geometry';

const plane = (center: Vec3, normal: Vec3): PlaneFrame => ({
  center, normal, u: [1, 0, 0], v: [0, 1, 0], widthMm: 100, heightMm: 100,
  step: 1, slices: 100, minNormal: 0,
});

describe('patient plane intersections', () => {
  it('finds the line x=5, z=12 for two shifted perpendicular planes', () => {
    const result = planeIntersection(plane([6, 7, 12], [0, 0, 1]), plane([5, -8, 30], [1, 0, 0]))!;
    expectPoint(result.point, [5, 0, 12]);
    expectPoint(result.direction, [0, 1, 0]);
  });
  it('solves the oblique equations x+y=3 and y+z=4', () => {
    const result = planeIntersection(plane([3, 0, 0], [1, 1, 0]), plane([0, 4, 0], [0, 1, 1]))!;
    // Closest point minimizes (3-y)^2 + y^2 + (4-y)^2, so y=7/3.
    expectPoint(result.point, [2 / 3, 7 / 3, 5 / 3]);
    expectPoint(result.direction, [1 / Math.sqrt(3), -1 / Math.sqrt(3), 1 / Math.sqrt(3)]);
  });
  it('handles non-unit normals and reverses only direction when planes are swapped', () => {
    const first = plane([0, 0, 12], [0, 0, 7]), second = plane([5, 0, 0], [3, 0, 0]);
    const result = planeIntersection(second, first)!;
    expectPoint(result.point, [5, 0, 12]);
    expectPoint(result.direction, [0, -1, 0]);
  });
  it('returns no unique line for parallel or coincident planes', () => {
    assert.equal(planeIntersection(plane([0, 0, 2], [0, 0, 1]), plane([0, 0, 5], [0, 0, 1])), null);
    assert.equal(planeIntersection(plane([0, 0, 2], [0, 0, 1]), plane([5, 3, 2], [0, 0, -1])), null);
  });
  it('rejects non-finite centres and degenerate normals', () => {
    const valid = plane([0, 0, 0], [0, 0, 1]);
    assert.equal(planeIntersection(valid, plane([0, 0, 0], [0, 0, 0])), null);
    assert.equal(planeIntersection(valid, plane([NaN, 0, 0], [1, 0, 0])), null);
    assert.equal(planeIntersection(valid, plane([0, 0, 0], [Infinity, 0, 0])), null);
  });
});


describe('full range window (key 1)', () => {
  it('takes both reconstructed windows from the displayed plane, including per-frame padding and oblique interpolation', async () => {
    const data = Float32Array.from({ length: 120 }, (_, i) => i === 119 ? 32_000 : i);
    const volume = { series: { ...base, paddingRange: [0, 8] as [number, number] }, data };
    for (const plane of ['axial', 'coronal', 'sagittal'] as const) for (const tilt of [0, 11]) {
      const shown = { ...view, mode: 'mpr' as const, plane, oblique: [tilt, 0] as [number, number] };
      const grid = windowPlane(base, shown), values: number[] = [];
      for (let y = 0; y < grid.rows; y++) for (let x = 0; x < grid.columns; x++) {
        const point = grid.origin.map((v, i) => v + grid.right[i] * x + grid.down[i] * y) as Vec3;
        const value = sampleVolume(volume, point, true);
        if (value !== null && Number.isFinite(value)) values.push(value);
      }
      values.sort((a, b) => a - b);
      for (const automatic of [true, false]) {
        const at = (q: number) => { const n = q * (values.length - 1), f = n % 1; return values[Math.floor(n)] * (1 - f) + values[Math.ceil(n)] * f; };
        const low = at(automatic ? 0.01 : 0), high = at(automatic ? 0.99 : 1);
        const result = await reconstructedWindow(volume, shown, automatic, () => true);
        assertClose(result!.windowCenter, (low + high) / 2, 6);
        assertClose(result!.windowWidth, Math.max(1, high - low), 6);
      }
    }
  });
  it('spans the lowest and highest values of the slice shown, padding left out', () => {
    const series: Series = { ...base, dimensions: [2, 1, 2], paddingRange: [-2000, -2000] };
    const volume = { series, data: new Float32Array([-1000, 1000, -2000, 50]) };
    assert.deepEqual(fullRangeWindow(volume, 0), { windowCenter: 0, windowWidth: 2000 });
    assert.deepEqual(fullRangeWindow(volume, 1), { windowCenter: 50, windowWidth: 1 });
    assert.deepEqual(fullRangeWindow(volume), { windowCenter: 0, windowWidth: 2000 });
    assert.equal(fullRangeWindow({ ...volume, series: { ...series, components: 3 } }), null);
  });
});

describe('panes facing the same way', () => {
  it('takes planes a few degrees apart along the same axis as facing the same way, and others not', () => {
    const tilt = (degrees: number): Vec3 => [0, Math.cos(degrees * Math.PI / 180), Math.sin(degrees * Math.PI / 180)];
    assert.equal(sameFacing([0, 1, 0], tilt(6)), true); // two coronals 6° apart
    assert.equal(sameFacing([0, 1, 0], [0, -1, 0]), true); // stacked the other way round
    assert.equal(sameFacing([0, 1, 0], [0, 0, 1]), false); // coronal and axial
    assert.equal(sameFacing([1, 0, 0], [0, 0, 1]), false); // sagittal and axial
  });
});

describe('acquired plane', () => {
  it('names the plane from the slice normal (rows of the direction matrix, k in the third column)', () => {
    assert.equal(acquiredPlane(base), 'axial');
    assert.equal(acquiredPlane({ ...base, direction: [1, 0, 0, 0, 0, 1, 0, -1, 0] }), 'coronal');
    assert.equal(acquiredPlane({ ...base, direction: [0, 0, 1, 1, 0, 0, 0, -1, 0] }), 'sagittal');
  });
});

describe('bounded percentile auto window', () => {
  it('windows the exact first and ninety-ninth percentiles of a known ramp', () => {
    assert.deepEqual(autoWindow({ series: base, data: Float32Array.from({ length: 101 }, (_, i) => i) }), { windowCenter: 50, windowWidth: 98 });
  });
  it('excludes extreme endpoints rather than using absolute min and max', () => {
    const data = Float32Array.from({ length: 101 }, (_, i) => i);
    data[0] = -10000;
    data[100] = 10000;
    assert.deepEqual(autoWindow({ series: base, data }), { windowCenter: 50, windowWidth: 98 });
  });
  it('handles signed compact pixels and keeps constant volumes usable', () => {
    assert.deepEqual(autoWindow({ series: base, data: Int16Array.from({ length: 10001 }, (_, i) => i - 5000) }), { windowCenter: 0, windowWidth: 9800 });
    assert.deepEqual(autoWindow({ series: base, data: new Uint16Array(20).fill(40000) }), { windowCenter: 40000, windowWidth: 1 });
    assert.deepEqual(autoWindow({ series: base, data: new Uint8Array([42]) }), { windowCenter: 42, windowWidth: 1 });
  });
  it('filters non-finite samples and refuses color or empty data', () => {
    const finite = autoWindow({ series: base, data: new Float32Array([NaN, 10, Infinity, 20, -Infinity]) })!;
    assert.equal(finite.windowCenter, 15);
    assertClose(finite.windowWidth, 9.8);
    assert.equal(autoWindow({ series: base, data: new Float32Array([NaN, Infinity]) }), null);
    assert.equal(autoWindow({ series: base, data: new Float32Array() }), null);
    assert.equal(autoWindow({ series: { ...base, components: 3 }, data: new Uint8Array([10, 20, 30]) }), null);
  });
  it('samples a large ramp across its complete extent', () => {
    const data = Float32Array.from({ length: 1_000_000 }, (_, i) => i);
    const result = autoWindow({ series: base, data })!;
    assert.ok(Math.abs(result.windowCenter - 499999.5) < 1);
    assert.ok(Math.abs(result.windowWidth - 979999.02) < 2);
  });
});

import { simplifyPolyline } from '../src/imaging/geometry';

describe('freehand polyline simplification', () => {
  it('removes collinear samples in three dimensions while preserving both endpoints', () => {
    const points: Vec3[] = [[0, 0, 0], [1, 1, 1], [2, 2, 2], [3, 3, 3]];
    assert.deepEqual(simplifyPolyline(points, 0.01), [[0, 0, 0], [3, 3, 3]]);
    assert.deepEqual(points, [[0, 0, 0], [1, 1, 1], [2, 2, 2], [3, 3, 3]]);
  });
  it('keeps a significant right-angle corner while removing samples along its arms', () => {
    assert.deepEqual(simplifyPolyline([[0, 0, 0], [1, 0, 0], [2, 0, 0], [2, 1, 0], [2, 2, 0]], 0.1), [[0, 0, 0], [2, 0, 0], [2, 2, 0]]);
  });
  it('measures three-dimensional deviation and uses the finite segment, not an infinite line', () => {
    assert.deepEqual(simplifyPolyline([[0, 0, 0], [1, 0, 2], [2, 0, 0]], 1), [[0, 0, 0], [1, 0, 2], [2, 0, 0]]);
    assert.deepEqual(simplifyPolyline([[0, 0, 0], [1, 0, 0.5], [2, 0, 0]], 1), [[0, 0, 0], [2, 0, 0]]);
    assert.deepEqual(simplifyPolyline([[0, 0, 0], [2, 0, 0], [1, 0, 0]], 0.5), [[0, 0, 0], [2, 0, 0], [1, 0, 0]]);
  });
  it('preserves a square ring and its explicit closing point', () => {
    const square: Vec3[] = [[0, 0, 0], [1, 0, 0], [2, 0, 0], [2, 1, 0], [2, 2, 0], [1, 2, 0], [0, 2, 0], [0, 1, 0], [0, 0, 0]];
    assert.deepEqual(simplifyPolyline(square, 0.1), [[0, 0, 0], [2, 0, 0], [2, 2, 0], [0, 2, 0], [0, 0, 0]]);
  });
  it('does not collapse a nondegenerate closed ring into a line at large tolerance', () => {
    const triangle: Vec3[] = [[0, 0, 0], [2, 0, 0], [0, 2, 0], [0, 0, 0]];
    assert.deepEqual(simplifyPolyline(triangle, 100), triangle);
    assert.deepEqual(simplifyPolyline([], 1), []);
    assert.deepEqual(simplifyPolyline([[1, 2, 3]], 1), [[1, 2, 3]]);
  });
});
