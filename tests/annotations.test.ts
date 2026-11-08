import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertClose, assertFields } from './support';
import type { Annotation, Series, Vec3, Volume } from '../src/model';
import { angleDegrees, annotationSummary, cobbAngleDegrees, distanceMm, fusedPetSummary, polylineLengthMm, quantitativeScale, roiStatistics, storedUnit } from '../src/imaging/annotations';
import { setLocale } from '../src/i18n';

const series: Series = {
  id: 'fixture', uid: '1', studyUid: '2', patientId: 'TEST', patientName: 'Synthetic',
  studyDate: '', description: 'Known linear field', modality: 'CT', seriesNumber: 1,
  dimensions: [6, 6, 6], spacing: [1, 1, 1], origin: [0, 0, 0],
  direction: [1, 0, 0, 0, 1, 0, 0, 0, 1], windowCenter: 40, windowWidth: 400,
  valueUnit: 'HU', suvFactor: null, canReconstruct: true, spacingKnown: true,
  warnings: [], photometricInterpretation: 'MONOCHROME2',
};

function volume(field: (x: number, y: number, z: number) => number = () => 12, metadata: Partial<Series> = {}): Volume {
  const actual = { ...series, ...metadata };
  const [nx, ny, nz] = actual.dimensions;
  const data = new Float32Array(nx * ny * nz);
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) data[(z * ny + y) * nx + x] = field(x, y, z);
  return { series: actual, data };
}

function roi(type: Annotation['type'], points: Vec3[], plane: Annotation['plane'] = 'axial'): Annotation {
  return { id: 'roi', type, points, plane, slice: 1, mode: 'mpr' };
}

function sourceRoi(type: Annotation['type'], points: Vec3[], sourceFrame = 0): Annotation {
  return { ...roi(type, points), mode: 'source', sourceFrame, slice: sourceFrame };
}

const box: Vec3[] = [[1, 1, 1], [3, 1, 1], [3, 3, 1], [1, 3, 1]];

describe('patient-space measurements', () => {
  it('uses the 3D patient coordinate distance, independently of display settings', () => {
    assert.equal(distanceMm([10, 20, 30], [13, 24, 42]), 13);
    assert.equal(distanceMm([NaN, 0, 0], [0, 0, 0]), null);
  });
  it('reports vertex angles and rejects zero-length arms', () => {
    assertClose(angleDegrees([1, 0, 0], [0, 0, 0], [0, 2, 0]), 90);
    assertClose(angleDegrees([1, 0, 0], [0, 0, 0], [1, 1, 0]), 45);
    assert.equal(angleDegrees([0, 0, 0], [0, 0, 0], [1, 1, 0]), null);
  });
  it('makes Cobb angles independent of endpoint order', () => {
    assertClose(cobbAngleDegrees([[0, 0, 0], [2, 0, 0], [2, 2, 0], [1, 1, 0]]), 45);
    assertClose(cobbAngleDegrees([[2, 0, 0], [0, 0, 0], [1, 1, 0], [2, 2, 0]]), 45);
  });
  it('sums segments for a polyline', () => {
    assert.equal(polylineLengthMm([[0, 0, 0], [3, 4, 0], [3, 4, 12]]), 17);
  });
});

describe('derived MPR plane ROI statistics', () => {
  it('measures a known constant rectangle and geometric area', () => {
    const stats = roiStatistics(roi('rectangle', box), volume())!;
    assertClose(stats.area, 4);
    assertClose(stats.mean, 12);
    assertClose(stats.min, 12);
    assertClose(stats.max, 12);
    assert.equal(stats.standardDeviation, 0);
    assert.equal(stats.count, 4);
    assert.deepEqual(stats.samplingStep, [1, 1]);
    assert.equal(stats.downsampled, false);
  });
  it('samples a known linear field at the four cell centres', () => {
    // x + 2y + 3z at (1.5/2.5, 1.5/2.5, 1) is 7.5, 8.5, 9.5, 10.5.
    const stats = roiStatistics(roi('rectangle', box), volume((x, y, z) => x + 2 * y + 3 * z))!;
    assert.equal(stats.count, 4);
    assertClose(stats.mean, 9);
    assertClose(stats.min, 7.5);
    assertClose(stats.max, 10.5);
    assertClose(stats.standardDeviation, Math.sqrt(1.25));
  });
  it('accounts for anisotropic spacing and nonzero patient origin', () => {
    const known = volume((x, y) => x + 2 * y, { spacing: [2, 3, 4], origin: [10, 20, 30] });
    const stats = roiStatistics(roi('rectangle', [[12, 23, 34], [16, 23, 34], [16, 29, 34], [12, 29, 34]]), known)!;
    assertClose(stats.area, 24);
    assert.equal(stats.count, 4);
    assertClose(stats.samplingStep[0], 2);
    assertClose(stats.samplingStep[1], 3);
    assertClose(stats.mean, 6);
  });
  it('uses explicitly stored corners for an oblique ROI', () => {
    const c = Math.SQRT1_2;
    const corners: Vec3[] = [[1, 1, 1], [1 + 2 * c, 1, 1 + 2 * c], [1 + 2 * c, 3, 1 + 2 * c], [1, 3, 1]];
    const stats = roiStatistics(roi('rectangle', corners), volume((x, y, z) => x + y + z))!;
    assertClose(stats.area, 4);
    assertClose(stats.mean, 4 + 2 * c);
  });
  it('uses the proper patient axes for two-corner coronal rectangles', () => {
    const stats = roiStatistics(roi('rectangle', [[1, 2, 3], [3, 2, 1]], 'coronal'), volume((x, y, z) => x + 2 * y + 3 * z))!;
    assertClose(stats.area, 4);
    assertClose(stats.mean, 12);
  });
  it('uses source axes for two-corner ROIs on rotated long-stack frame fallback', () => {
    const source = volume(() => 12, { sourceFramesOnly: true, direction: [0, 0, 1, 1, 0, 0, 0, 1, 0] });
    const stats = roiStatistics(roi('rectangle', [[1, 1, 1], [1, 3, 3]]), source)!;
    assertClose(stats.area, 4);
    assert.equal(stats.mean, 12);
    assert.equal(stats.count, 4);
  });
  it('measures ellipse area from its physical axes', () => {
    const stats = roiStatistics(roi('ellipse', box), volume())!;
    assertClose(stats.area, Math.PI);
    assert.equal(stats.count, 4);
    assert.equal(stats.mean, 12);
  });
  it('measures a non-axis-aligned triangular polygon', () => {
    const stats = roiStatistics(roi('polygon', [[1, 1, 1], [4, 1, 1], [1, 5, 1]]), volume())!;
    assertClose(stats.area, 6);
    assertClose(stats.mean, 12);
    assert.ok(stats.count > 0);
  });
  it('reports clipping rather than treating missing values as zero', () => {
    const stats = roiStatistics(roi('rectangle', [[-2, 1, 1], [2, 1, 1], [2, 3, 1], [-2, 3, 1]]), volume())!;
    assert.ok(stats.outsideCount > 0);
    assertClose(stats.mean, 12);
    assert.ok(annotationSummary(roi('rectangle', [[-2, 1, 1], [2, 1, 1], [2, 3, 1], [-2, 3, 1]]), volume()).includes('clipped'));
  });
  it('caps very long thin ROIs as well as square ROIs', () => {
    const stats = roiStatistics(roi('rectangle', [[0, 0, 1], [100, 0, 1], [100, 0.1, 1], [0, 0.1, 1]]), volume(), 2);
    // The region extends far outside this image and may have no valid sample, but must terminate.
    assert.equal(stats == null || stats.count + stats.outsideCount <= 2, true);
    const reduced = roiStatistics(roi('rectangle', box), volume(), 1)!;
    assert.equal(reduced.count, 1);
    assert.equal(reduced.downsampled, true);
    assert.equal(reduced.mean, 12);
  });
  it('accepts an explicitly closed polygon ring', () => {
    const stats = roiStatistics(roi('polygon', [...box, box[0]]), volume())!;
    assertClose(stats.area, 4);
    assert.equal(stats.mean, 12);
  });
  it('rejects self-intersecting outlines with nonzero algebraic area', () => {
    assert.equal(roiStatistics(roi('polygon', [[0, 0, 1], [4, 4, 1], [0, 3, 1], [3, 0, 1]]), volume()), null);
  });
  it('rejects non-coplanar polygons and degenerate boxes', () => {
    assert.equal(roiStatistics(roi('polygon', [[1, 1, 1], [3, 1, 1], [3, 3, 1], [1, 3, 2]]), volume()), null);
    assert.equal(roiStatistics(roi('rectangle', [[1, 1, 1], [1, 1, 1]]), volume()), null);
  });
});

describe('acquired-source ROI statistics', () => {
  it('preserves every checkerboard source value, including extrema and standard deviation', () => {
    const source: Volume = { series: { ...series, dimensions: [2, 2, 1] }, data: new Int16Array([0, 100, 100, 0]) };
    const outline: Annotation = { ...roi('rectangle', [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]]), mode: 'source', sourceFrame: 0 };
    const stats = roiStatistics(outline, source)!;
    assert.equal(stats.count, 4);
    assert.equal(stats.mean, 50);
    assert.equal(stats.min, 0);
    assert.equal(stats.max, 100);
    assert.equal(stats.standardDeviation, 50);
    assert.equal(stats.sampling, 'source-voxels');
    assert.equal(stats.downsampled, false);
    assert.ok(annotationSummary(outline, source).includes('4 source voxels'));
    assert.ok(!annotationSummary(outline, source).includes('Interpolated'));
  });
  it('keeps derived MPR statistics explicitly separate from source extrema', () => {
    const source: Volume = { series: { ...series, dimensions: [2, 2, 1] }, data: new Int16Array([0, 100, 100, 0]) };
    const outline = roi('rectangle', [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]]);
    const stats = roiStatistics(outline, source)!;
    assert.equal(stats.count, 1);
    assert.equal(stats.min, 50);
    assert.equal(stats.max, 50);
    assert.equal(stats.standardDeviation, 0);
    assert.equal(stats.sampling, 'derived-interpolated');
    assert.ok(annotationSummary(outline, source).includes('Interpolated MPR samples'));
    assert.ok(annotationSummary(outline, source).includes('sample max 50.0'));
  });
  it('uses voxel-centre inclusion for ellipses, polygons and rotated rectangles', () => {
    const source = volume((x, y) => x + 3 * y, { dimensions: [3, 3, 1] });
    const corners: Vec3[] = [[0, 0, 0], [2, 0, 0], [2, 2, 0], [0, 2, 0]];
    const ellipse = roiStatistics(sourceRoi('ellipse', corners), source)!;
    // Circle includes values 1,3,4,5,7; four outside corner centres are excluded.
    assert.equal(ellipse.count, 5);
    assert.equal(ellipse.mean, 4);
    assert.equal(ellipse.min, 1);
    assert.equal(ellipse.max, 7);
    assert.equal(ellipse.standardDeviation, 2);
    assertClose(ellipse.area, Math.PI);
    const triangle = roiStatistics(sourceRoi('polygon', [[0, 0, 0], [2, 0, 0], [0, 2, 0]]), source)!;
    // Triangle includes values 0,1,2,3,4,6, including centres on its boundary.
    assert.equal(triangle.count, 6);
    assertClose(triangle.mean, 16 / 6);
    assert.equal(triangle.max, 6);
    assertClose(triangle.standardDeviation, Math.sqrt(35) / 3);
    const diamond = roiStatistics(sourceRoi('rectangle', [[1, 0, 0], [2, 1, 0], [1, 2, 0], [0, 1, 0]]), source)!;
    assert.equal(diamond.count, 5);
    assertClose(diamond.area, 2);
    assert.equal(diamond.mean, 4);
  });
  it('does not invent a sample for a small ROI containing no source centre', () => {
    const outline = sourceRoi('rectangle', [[0.2, 0.2, 0], [0.8, 0.2, 0], [0.8, 0.8, 0], [0.2, 0.8, 0]]);
    assert.equal(roiStatistics(outline, volume(() => 12, { dimensions: [2, 2, 1] })), null);
  });
  it('uses per-frame origins, directions, spacing and buffer offsets for source ROI and probes', () => {
    const source: Volume = { series: { ...series, dimensions: [2, 2, 2], canReconstruct: false, frameMetadata: [
      { origin: [0, 0, 0], direction: series.direction, spacing: [1, 1, 1] },
      { origin: [100, 200, 300], direction: [0, -1, 0, 1, 0, 0, 0, 0, 1], spacing: [2, 3, 7], spacingKnown: true },
    ] }, data: new Int16Array([-10, -20, -30, -40, 10, 20, 30, 40]) };
    const corners: Vec3[] = [[100, 200, 300], [100, 202, 300], [97, 202, 300], [97, 200, 300]];
    const outline = sourceRoi('rectangle', corners, 1);
    const stats = roiStatistics(outline, source)!;
    assert.equal(stats.count, 4);
    assert.equal(stats.mean, 25);
    assert.equal(stats.min, 10);
    assert.equal(stats.max, 40);
    assertClose(stats.standardDeviation, Math.sqrt(125));
    assertClose(stats.area, 6);
    assert.deepEqual(stats.samplingStep, [2, 3]);
    assert.equal(annotationSummary(sourceRoi('probe', [[97, 202, 300]], 1), source), '40.0 HU');
    assert.equal(roiStatistics({ ...outline, sourceFrame: 0 }, source), null);
    const preview: Volume = { ...source, data: new Int16Array([10, 20, 30, 40]), sourceFrameIndex: 1 };
    assert.deepEqual(roiStatistics(outline, preview), stats);
    assert.equal(annotationSummary(sourceRoi('probe', [[97, 202, 300]], 1), preview), '40.0 HU');
    assert.equal(roiStatistics({ ...outline, sourceFrame: 0 }, preview), null);
    assert.equal(annotationSummary(sourceRoi('probe', [[0, 0, 0]], 0), preview), 'Source frame unavailable');
    assert.equal(annotationSummary(sourceRoi('length', [[0, 0, 0], [1, 0, 0]], 0), preview), '1.0 mm');
    const padded: Volume = { ...source, series: { ...source.series, frameMetadata: [source.series.frameMetadata![0], { ...source.series.frameMetadata![1], paddingRange: [10, 10] }] } };
    assert.equal(roiStatistics(outline, padded)!.count, 3);
    assert.equal(roiStatistics(outline, padded)!.min, 20);
    assert.equal(annotationSummary(sourceRoi('probe', [[100, 200, 300]], 1), padded), 'Pixel padding value');
  });
  it('excludes finite padding and non-finite values without changing the original pixels', () => {
    const values = [0, 10, 20, 30, NaN, Infinity, -Infinity, -1000, -1001];
    const source: Volume = { series: { ...series, dimensions: [3, 3, 1], paddingRange: [-1001, -1000] }, data: new Float64Array(values) };
    const outline = sourceRoi('rectangle', [[0, 0, 0], [2, 0, 0], [2, 2, 0], [0, 2, 0]]);
    const stats = roiStatistics(outline, source)!;
    assert.equal(stats.count, 4);
    assert.equal(stats.mean, 15);
    assert.equal(stats.min, 0);
    assert.equal(stats.max, 30);
    assert.equal(stats.invalidCount, 3);
    assert.equal(stats.paddingCount, 2);
    assert.ok(annotationSummary(outline, source).includes('2 padding voxels excluded'));
    assert.equal(source.data.every((value, i) => Object.is(value, values[i])), true);
  });
  it('preserves Float64 extrema and source PET SUV maxima', () => {
    const corners: Vec3[] = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]];
    const outline = sourceRoi('rectangle', corners);
    const precise: Volume = { series: { ...series, dimensions: [2, 2, 1] }, data: new Float64Array([16777217, 16777218, 16777219, 16777220]) };
    const stats = roiStatistics(outline, precise)!;
    assert.equal(stats.min, 16777217);
    assert.equal(stats.max, 16777220);
    assert.equal(stats.mean, 16777218.5);
    assertClose(stats.standardDeviation, Math.sqrt(1.25));
    const pet: Volume = { series: { ...precise.series, modality: 'PT', valueUnit: 'BQML', suvFactor: 0.25 }, data: new Int16Array([0, 100, 100, 0]) };
    const suv = roiStatistics(outline, pet)!;
    assert.equal(suv.unit, 'SUVbw');
    assert.equal(suv.max, 25);
    assert.equal(suv.mean, 12.5);
    assert.equal(suv.standardDeviation, 12.5);
  });
  it('does not downsample a source ROI above the old 200,000-sample limit', () => {
    const data = new Int16Array(512 * 512);
    data[129 * 512 + 257] = 1000;
    const source: Volume = { series: { ...series, dimensions: [512, 512, 1] }, data };
    const outline = sourceRoi('rectangle', [[0, 0, 0], [511, 0, 0], [511, 511, 0], [0, 511, 0]]);
    const stats = roiStatistics(outline, source, 1)!;
    assert.equal(stats.count, 262144);
    assert.equal(stats.max, 1000);
    assertClose(stats.mean, 1000 / 262144, 12);
    assertClose(stats.standardDeviation, Math.sqrt(1_000_000 / 262144 - (1000 / 262144) ** 2));
    assert.equal(stats.downsampled, false);
  });
  it('clips source enumeration to image bounds and reports the clipping', () => {
    const source = volume(() => 12, { dimensions: [3, 3, 1] });
    const outline = sourceRoi('rectangle', [[-1e6, -1e6, 0], [1e6, -1e6, 0], [1e6, 1e6, 0], [-1e6, 1e6, 0]]);
    const stats = roiStatistics(outline, source)!;
    assert.equal(stats.count, 9);
    assert.equal(stats.clipped, true);
    assert.equal(stats.mean, 12);
    assert.ok(annotationSummary(outline, source).includes('clipped'));
  });
});

describe('quantitative units', () => {
  it('distinguishes LUT-masked NaN padding while preserving valid anatomy mapped to zero', () => {
    const padded: Volume = { series: { ...series, dimensions: [3, 1, 1], pixelType: 'float32', paddingIsNaN: true }, data: new Float32Array([NaN, 0, 30]) };
    const points: Vec3[] = [[-0.5, -0.5, 0], [2.5, -0.5, 0], [2.5, 0.5, 0], [-0.5, 0.5, 0]];
    for (const annotation of [sourceRoi('rectangle', points), roi('rectangle', points)]) {
      const stats = roiStatistics(annotation, padded)!;
      assert.equal(stats.count, 2);
      assert.equal(stats.mean, 15);
      assert.equal(stats.min, 0);
      assert.equal(stats.max, 30);
      assert.equal(stats.paddingCount, 1);
      assert.equal(stats.invalidCount, 0);
      assert.ok(annotationSummary(annotation, padded).includes('1 padding'));
    }
    assert.equal(annotationSummary(sourceRoi('probe', [[0, 0, 0]]), padded), 'Pixel padding value');
    assert.equal(annotationSummary(roi('probe', [[0, 0, 0]]), padded), 'Pixel padding value');
    const unmarked = { ...padded, series: { ...padded.series, paddingIsNaN: false } };
    assert.equal(roiStatistics(sourceRoi('rectangle', points), unmarked)!.invalidCount, 1);
    assert.equal(padded.data[0], NaN);
  });
  it('keeps an exact source mean at a clinical ratio boundary', () => {
    const values = [0, 0, 200, 200, 200, 0, 0, 0, 0, 0, 0, 200, 200, 0, 200, 200, 0, 200, 200, 200];
    const volume: Volume = { series: { ...series, dimensions: [20, 1, 1] }, data: new Float64Array(values) };
    const annotation = sourceRoi('rectangle', [[-0.5, -0.5, 0], [19.5, -0.5, 0], [19.5, 0.5, 0], [-0.5, 0.5, 0]]);
    const stats = roiStatistics(annotation, volume)!;
    assert.equal(stats.mean, 100);
    assert.equal(stats.mean / 80, 1.25);
    assertClose(stats.standardDeviation, 100, 12);
    assert.equal(stats.count, 20);
    assert.equal(stats.clipped, false);
  });
  it('does not interpolate finite padding into derived MPR statistics', () => {
    const geometry: Series = { ...series, dimensions: [2, 1, 2], frameMetadata: [
      { origin: [0, 0, 0], direction: series.direction, spacing: [1, 1, 1], paddingRange: [-1000, -1000] },
      { origin: [0, 0, 1], direction: series.direction, spacing: [1, 1, 1], paddingRange: [-2000, -2000] },
    ] };
    const volume: Volume = { series: geometry, data: new Int16Array([10, -1000, 30, -2000]) };
    const annotation = roi('rectangle', [[0, -0.5, 0.25], [0.5, -0.5, 0.25], [0.5, 0.5, 0.25], [0, 0.5, 0.25]]);
    const stats = roiStatistics(annotation, volume)!;
    assert.equal(stats.mean, 15);
    assert.equal(stats.min, 15);
    assert.equal(stats.max, 15);
    assert.equal(stats.sampling, 'derived-interpolated');
  });
  it('distinguishes finite DICOM padding from non-finite values in derived MPR samples and probes', () => {
    const data = new Float64Array(9).fill(10);
    data[5] = -1000; data[7] = NaN; data[8] = Infinity;
    const padded: Volume = { series: { ...series, dimensions: [3, 3, 1], paddingRange: [-1000, -1000] }, data };
    const outline = roi('rectangle', [[0, 0, 0], [2, 0, 0], [2, 2, 0], [0, 2, 0]]);
    const stats = roiStatistics(outline, padded)!;
    assert.equal(stats.count, 1);
    assert.equal(stats.mean, 10);
    assert.equal(stats.invalidCount, 2);
    assert.equal(stats.paddingCount, 1);
    assert.ok(annotationSummary(outline, padded).includes('1 padding sample excluded'));
    assert.ok(annotationSummary(outline, padded).includes('2 non-finite samples excluded'));
    assert.equal(annotationSummary(roi('probe', [[2, 1, 0]]), padded), 'Pixel padding value');
    assert.equal(annotationSummary(roi('probe', [[1, 2, 0]]), padded), 'Non-finite pixel value');
    assert.equal(annotationSummary(roi('probe', [[2, 2, 0]]), padded), 'Non-finite pixel value');
  });
  it('uses actual frame geometry and padding metadata for probes in a single-frame preview', () => {
    const preview: Volume = { series: { ...series, dimensions: [2, 2, 2], frameMetadata: [
      { origin: [0, 0, 0], direction: series.direction, spacing: [1, 1, 1] },
      { origin: [100, 200, 300], direction: [0, -1, 0, 1, 0, 0, 0, 0, 1], spacing: [2, 3, 7], paddingRange: [20, 20] },
    ] }, data: new Int16Array([10, 20, 30, 40]), sourceFrameIndex: 1 };
    assert.equal(annotationSummary(roi('probe', [[100, 202, 300]]), preview), 'Pixel padding value');
    assert.equal(annotationSummary(roi('probe', [[97, 202, 300]]), preview), '40.0 HU');
  });
  it('reports non-finite padding separately from clipped image regions', () => {
    const data = new Float64Array(9).fill(10);
    data[5] = NaN; data[7] = Infinity; data[8] = -Infinity;
    const padded: Volume = { series: { ...series, dimensions: [3, 3, 1] }, data };
    const outline = roi('rectangle', [[0, 0, 0], [2, 0, 0], [2, 2, 0], [0, 2, 0]]);
    const stats = roiStatistics(outline, padded)!;
    assert.equal(stats.mean, 10);
    assert.equal(stats.count, 1);
    assert.equal(stats.invalidCount, 3);
    assert.equal(stats.outsideCount, 0);
    assert.ok(annotationSummary(outline, padded).includes('3 non-finite samples excluded'));
    assert.equal(annotationSummary(roi('probe', [[2, 1, 0]]), padded), 'Non-finite pixel value');
    assert.equal(annotationSummary(roi('probe', [[5, 1, 0]]), padded), 'Outside image');
    assert.equal(data[5], NaN);
    assert.equal(data[7], Infinity);
  });
  it('uses pixel coordinates when physical spacing is unverified', () => {
    const uncalibrated = volume(() => 12, { spacingKnown: false, spacing: [2, 3, 4], origin: [10, 20, 30] });
    const points: Vec3[] = [[10, 20, 30], [16, 32, 30], [16, 32, 78]];
    assert.equal(annotationSummary(roi('length', points.slice(0, 2)), uncalibrated), '5.0 px');
    assert.equal(annotationSummary(roi('polyline', points), uncalibrated), '17.0 px');
    assert.equal(annotationSummary(roi('angle', [[12, 20, 30], [10, 20, 30], [12, 23, 30]]), uncalibrated), '45.0°');
  });
  it('reports ROI area and sampling steps in pixels without calibration', () => {
    const uncalibrated = volume(() => 12, { spacingKnown: false, spacing: [2, 3, 4], origin: [10, 20, 30] });
    const rectangle = roi('rectangle', [[12, 23, 34], [16, 23, 34], [16, 29, 34], [12, 29, 34]]);
    const stats = roiStatistics(rectangle, uncalibrated)!;
    assertClose(stats.area, 4);
    assert.equal(stats.areaUnit, 'px²');
    assert.equal(stats.spatialUnit, 'px');
    assertClose(stats.samplingStep[0], 1);
    assertClose(stats.samplingStep[1], 1);
    assert.ok(annotationSummary(rectangle, uncalibrated).includes('4.0 px²'));
  });
  it('requires explicit spacing verification before labeling lengths in millimetres', () => {
    const measurement = roi('length', [[0, 0, 0], [3, 4, 0]]);
    assert.equal(annotationSummary(measurement, volume()), '5.0 mm');
    assert.equal(annotationSummary(measurement, volume(() => 12, { spacingKnown: undefined })), '5.0 px');
    assert.equal(roiStatistics(roi('rectangle', box), volume())!.areaUnit, 'mm²');
  });
  it('does not invent HU for unspecified pixel units', () => {
    assert.equal(annotationSummary(roi('probe', [[1, 1, 1]]), volume(() => 12, { valueUnit: '' })), '12.0 value');
  });
  it('applies a PET SUV factor once to raw activity values', () => {
    const pet = volume(() => 20, { modality: 'PT', valueUnit: 'BQML', suvFactor: 0.25 });
    assert.equal(roiStatistics(roi('rectangle', box), pet)!.mean, 5);
    assert.equal(roiStatistics(roi('rectangle', box), pet)!.unit, 'SUVbw');
    assert.equal(annotationSummary(roi('probe', [[1, 1, 1]]), pet), '5.00 SUVbw');
  });
  it('does not rescale a volume already in SUV units', () => {
    assert.deepEqual(quantitativeScale({ ...series, modality: 'PT', valueUnit: 'SUVbw', suvFactor: 0.25 }), { factor: 1, unit: 'SUVbw' });
  });
  it('retains known activity units when SUV inputs are missing', () => {
    assert.deepEqual(quantitativeScale({ ...series, modality: 'PT', valueUnit: 'BQML', suvFactor: null }), { factor: 1, unit: 'BQML' });
  });
  it('calls values a file stores as SUV SUV only where the engine calibrated them, else gives them in g/ml', () => {
    // Units GML that the engine refused (not corrected for attenuation): its unit still says SUVbw, but no SUV factor.
    const refused: Partial<Series> = { modality: 'PT', valueUnit: 'SUVbw', suvFactor: null };
    for (const normalization of ['bw', 'lbm', 'bsa'] as const) {
      const shown = { ...series, ...refused, sulFactor: 0.8, suvBsaFactor: 0.03, suvNormalization: normalization };
      assert.equal(storedUnit(shown), 'g/ml');
      assert.deepEqual(quantitativeScale(shown), { factor: 1, unit: 'g/ml' });
    }
    assert.equal(storedUnit({ ...series, ...refused, valueUnit: 'SUVlbm' }), 'g/ml');
    const pet = volume(() => 3.5, refused);
    assert.equal(annotationSummary(roi('probe', [[1, 1, 1]]), pet), '3.5 g/ml');
    assert.equal(roiStatistics(roi('rectangle', box), pet)!.unit, 'g/ml');
    assert.doesNotMatch(fusedPetSummary(roi('probe', [[1, 1, 1]]), pet), /SU[VL]/);
    // The same file calibrated (the engine's factor 1) reads SUVbw as before; other units and modalities are untouched.
    assert.equal(storedUnit({ ...series, ...refused, suvFactor: 1 }), 'SUVbw');
    assert.deepEqual(quantitativeScale({ ...series, ...refused, suvFactor: 1 }), { factor: 1, unit: 'SUVbw' });
    assert.equal(annotationSummary(roi('probe', [[1, 1, 1]]), volume(() => 3.5, { ...refused, suvFactor: 1 })), '3.50 SUVbw');
    assert.equal(storedUnit({ ...series, modality: 'PT', valueUnit: 'Bq/ml', suvFactor: null }), 'Bq/ml');
    assert.equal(storedUnit(series), 'HU');
  });
  it('gives PET values in the SUV the reader chose, and names the SUV it gives', () => {
    const activity: Series = { ...series, modality: 'PT', valueUnit: 'Bq/ml', suvFactor: 0.25, sulFactor: 0.2, suvBsaFactor: 0.07 };
    assert.deepEqual(quantitativeScale(activity), { factor: 0.25, unit: 'SUVbw' });
    assert.deepEqual(quantitativeScale({ ...activity, suvNormalization: 'bw' }), { factor: 0.25, unit: 'SUVbw' });
    assert.deepEqual(quantitativeScale({ ...activity, suvNormalization: 'lbm' }), { factor: 0.2, unit: 'SUL' });
    assert.deepEqual(quantitativeScale({ ...activity, suvNormalization: 'bsa' }), { factor: 0.07, unit: 'SUVbsa' });
    // Without a height (or sex) the values stay SUVbw, labelled as such: never SUVbw called SUL.
    assert.deepEqual(quantitativeScale({ ...activity, sulFactor: null, suvNormalization: 'lbm' }), { factor: 0.25, unit: 'SUVbw' });
    assert.deepEqual(quantitativeScale({ ...activity, suvBsaFactor: undefined, suvNormalization: 'bsa' }), { factor: 0.25, unit: 'SUVbw' });
    // Values stored as SUV by body weight convert; one stored by lean body mass stays what it is.
    assert.deepEqual(quantitativeScale({ ...activity, valueUnit: 'SUVbw', suvFactor: 1, sulFactor: 0.8, suvNormalization: 'lbm' }), { factor: 0.8, unit: 'SUL' });
    assert.deepEqual(quantitativeScale({ ...activity, valueUnit: 'SUVlbm', suvFactor: 1, sulFactor: null, suvNormalization: 'lbm' }), { factor: 1, unit: 'SUVlbm' });
    assert.deepEqual(quantitativeScale({ ...series, sulFactor: 0.2, suvNormalization: 'lbm' }), { factor: 1, unit: 'HU' });
    const pet = volume(() => 20, { modality: 'PT', valueUnit: 'Bq/ml', suvFactor: 0.25, sulFactor: 0.2, suvNormalization: 'lbm' });
    assert.equal(annotationSummary(roi('probe', [[1, 1, 1]]), pet), '4.00 SUL');
    assertFields(roiStatistics(roi('rectangle', box), pet), { mean: 4, unit: 'SUL' });
  });
});

import { remapAnnotationCoordinates } from '../src/imaging/annotations';

describe('annotation calibration remapping', () => {
  it('keeps drawn source pixels fixed when pixel spacing is calibrated', () => {
    const previous: Series = { ...series, spacingKnown: false };
    const calibrated: Series = { ...series, spacingKnown: true, spacing: [0.5, 0.25, 1] };
    const original = { ...roi('length', [[2, 4, 1], [6, 8, 1]]), label: 'Landmark', color: '#ff0' };
    const mapped = remapAnnotationCoordinates(original, previous, calibrated);
    assert.deepEqual(mapped.points, [[1, 1, 1], [3, 2, 1]]);
    assert.equal(mapped.label, 'Landmark');
    assert.equal(mapped.color, '#ff0');
    assert.equal(mapped.slice, original.slice);
    assert.deepEqual(original.points, [[2, 4, 1], [6, 8, 1]]);
    assert.equal(annotationSummary(mapped, { series: calibrated, data: new Float32Array(216) }), '2.2 mm');
  });
  it('includes both origins, anisotropic spacing, and rotated image directions', () => {
    const previous: Series = { ...series, spacing: [2, 3, 4], origin: [10, 20, 30] };
    const next: Series = { ...series, spacing: [1, 2, 5], origin: [-10, 7, 9], direction: [0, -1, 0, 1, 0, 0, 0, 0, 1] };
    // Source index (2,3,4) becomes -6 left, +2 posterior, +20 superior from the new origin.
    const mapped = remapAnnotationCoordinates(roi('probe', [[14, 29, 46]]), previous, next);
    assert.deepEqual(mapped.points, [[-16, 9, 29]]);
  });
});

describe('display-only measurement calibration', () => {
  it('keeps physical angles and Cobb angles unchanged when length units switch to pixels', () => {
    const native = volume(() => 12, { spacing: [2, 1, 1], spacingKnown: true });
    const pixelDisplay = { ...native, series: { ...native.series, measurementUnits: 'px' as const } };
    const angle = roi('angle', [[2, 1, 0], [0, 0, 0], [2, 0, 0]]);
    const cobb = roi('cobb', [[0, 0, 0], [2, 1, 0], [0, 2, 0], [2, 2, 0]]);
    // atan(1/2) in physical space is 26.565 degrees, even though the index-space angle is 45.
    assert.equal(annotationSummary(angle, native), '26.6°');
    assert.equal(annotationSummary(angle, pixelDisplay), '26.6°');
    assert.equal(annotationSummary(cobb, native), '26.6° Cobb');
    assert.equal(annotationSummary(cobb, pixelDisplay), '26.6° Cobb');
  });
  it('keeps unverified-spacing angles in pixel geometry under a uniform manual scale', () => {
    const unknown = volume(() => 12, { spacing: [2, 1, 1], spacingKnown: false, measurementScale: 2 });
    const angle = roi('angle', [[2, 1, 0], [0, 0, 0], [2, 0, 0]]);
    const cobb = roi('cobb', [[0, 0, 0], [2, 1, 0], [0, 2, 0], [2, 2, 0]]);
    assert.equal(annotationSummary(angle, unknown), '45.0°');
    assert.equal(annotationSummary(cobb, unknown), '45.0° Cobb');
  });
  it('scales physical lengths, areas and sampling steps without changing intensities or geometry', () => {
    const calibrated = volume(() => 12, { measurementScale: 2 });
    const annotation = roi('rectangle', box);
    const stats = roiStatistics(annotation, calibrated)!;
    assert.equal(annotationSummary(roi('length', [[0, 0, 0], [3, 4, 0]]), calibrated), '10.0 mm');
    assert.equal(annotationSummary(roi('polyline', [[0, 0, 0], [3, 4, 0], [3, 4, 12]]), calibrated), '34.0 mm');
    assertClose(stats.area, 16);
    assert.equal(stats.areaUnit, 'mm²');
    assert.deepEqual(stats.samplingStep, [2, 2]);
    assert.equal(stats.mean, 12);
    assert.equal(stats.count, 4);
    assert.deepEqual(calibrated.series.spacing, [1, 1, 1]);
    assert.deepEqual(annotation.points, box);
  });
  it('allows manual calibration to supply physical units when native spacing is missing', () => {
    const calibrated = volume(() => 12, { spacingKnown: false, measurementScale: 0.5 });
    assert.equal(annotationSummary(roi('length', [[0, 0, 0], [3, 4, 0]]), calibrated), '2.5 mm');
    const stats = roiStatistics(roi('rectangle', box), calibrated)!;
    assertClose(stats.area, 1);
    assert.equal(stats.areaUnit, 'mm²');
    assert.deepEqual(stats.samplingStep, [0.5, 0.5]);
  });
  it('lets explicit pixel units override both native spacing and a manual scale', () => {
    const pixelDisplay = volume(() => 12, { spacing: [2, 3, 4], origin: [10, 20, 30], measurementScale: 9, measurementUnits: 'px' });
    assert.equal(annotationSummary(roi('length', [[10, 20, 30], [16, 32, 30]]), pixelDisplay), '5.0 px');
    const stats = roiStatistics(roi('rectangle', [[12, 23, 34], [16, 23, 34], [16, 29, 34], [12, 29, 34]]), pixelDisplay)!;
    assertClose(stats.area, 4);
    assert.equal(stats.areaUnit, 'px²');
    assertClose(stats.samplingStep[0], 1);
    assertClose(stats.samplingStep[1], 1);
  });
  it('ignores invalid calibration factors', () => {
    for (const measurementScale of [0, -1, NaN, Infinity]) {
      const unknown = volume(() => 12, { spacingKnown: false, measurementScale });
      assert.equal(annotationSummary(roi('length', [[0, 0, 0], [3, 4, 0]]), unknown), '5.0 px');
    }
  });
});

describe('a PET fused over the image', () => {
  const pet = (field: (x: number, y: number, z: number) => number): Volume => volume(field, { modality: 'PT', valueUnit: 'BQML', suvFactor: 0.001, spacing: [2, 2, 2], dimensions: [6, 6, 6] });
  it('gives the SUV at a probe and the maximum and mean inside a region, in the CT drawing\'s own plane', () => {
    setLocale('en');
    const uniform = pet(() => 5000);
    assert.equal(fusedPetSummary({ ...roi('probe', [[4, 4, 4]]), mode: 'source' }, uniform), 'PET 5.00 SUVbw');
    assert.equal(fusedPetSummary(roi('rectangle', [[2, 2, 4], [8, 2, 4], [8, 8, 4], [2, 8, 4]]), uniform), 'PET SUVbw max 5.00, mean 5.00');
    // The maximum is the hottest voxel's own value (SUV 5 at x = 10), not an interpolated sample between voxels.
    const ramp = pet(x => x * 1000);
    assert.equal(fusedPetSummary(roi('rectangle', [[0, 2, 4], [10, 2, 4], [10, 6, 4], [0, 6, 4]]), ramp), 'PET SUVbw max 5.00, mean 2.50');
  });
  it('reads the hottest PET voxel a CT drawing crosses between PET slices', () => {
    setLocale('en');
    // One hot voxel (SUV 9) at (4, 4, 4); the CT slice lies at z = 4.6, inside that voxel's 2 mm layer.
    const hot = pet((x, y, z) => x === 2 && y === 2 && z === 2 ? 9000 : 0);
    const outline = roi('rectangle', [[1, 1, 4.6], [7, 1, 4.6], [7, 7, 4.6], [1, 7, 4.6]]);
    assert.equal(fusedPetSummary(outline, hot), 'PET SUVbw max 9.00, mean 1.00');
    assert.equal(fusedPetSummary({ ...roi('probe', [[4.6, 4.6, 4.6]]), mode: 'source' }, hot), 'PET 9.00 SUVbw');
    // The same region on the PET's own reconstructed plane: its voxels, not interpolated samples.
    const summary = annotationSummary(outline, hot);
    assert.ok(summary.includes('max 9.00'));
    assert.ok(summary.includes('9 source voxels'));
    assert.ok(!summary.includes('Interpolated'));
  });
  it('says when a region too large to read voxel by voxel is described by interpolated samples', () => {
    setLocale('en');
    const large = volume(() => 5000, { modality: 'PT', valueUnit: 'Bq/ml', suvFactor: 0.001, spacing: [2, 2, 2], dimensions: [200, 200, 200] });
    // A plane tilted 45° through the whole volume crosses more voxels than are scanned at once.
    const tilted = roi('polygon', [[0, 0, 0], [398, 0, 0], [398, 398, 398], [0, 398, 398]]);
    assert.equal(fusedPetSummary(tilted, large), 'PET SUVbw sample max 5.00, mean 5.00 (interpolated)');
  });
  it('gives nothing for a line, or where the PET does not reach', () => {
    setLocale('en');
    const uniform = pet(() => 5000);
    assert.equal(fusedPetSummary(roi('length', [[0, 0, 0], [3, 4, 0]]), uniform), '');
    assert.equal(fusedPetSummary(roi('probe', [[40, 40, 40]]), uniform), '');
  });
});
