import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertClose } from './support';
import type { Series, Vec3, Volume } from '../src/model';
import { quantitativeScale } from '../src/imaging/annotations';
import { formatSphereStatistics, PEAK_RADIUS_MM, peakKernel, sphereOf, spherePoints, sphereSection, sphereStatistics, THRESHOLDS, thresholdVolume, type Sphere } from '../src/imaging/voi';
import { setLocale } from '../src/i18n';

// A synthetic PET in Bq/ml: two stored units make one SUVbw (suvFactor 0.5), 1.6 make one SUL.
const pet: Series = {
  id: 'pet', uid: '1', studyUid: '2', patientId: 'TEST', patientName: 'Synthetic', studyDate: '20000101', description: 'Synthetic PET',
  modality: 'PT', petAcquisition: { tracer: 'FDG' }, seriesNumber: 1, dimensions: [40, 40, 40], spacing: [2, 2, 2], origin: [0, 0, 0], direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  windowCenter: 5, windowWidth: 10, valueUnit: 'Bq/ml', suvFactor: 0.5, sulFactor: 0.625, canReconstruct: true, spacingKnown: true,
  warnings: [], photometricInterpretation: 'MONOCHROME2',
};

function volume(suv: (p: Vec3) => number, metadata: Partial<Series> = {}): Volume {
  const series = { ...pet, ...metadata }, [nx, ny, nz] = series.dimensions, factor = series.suvFactor ?? 1;
  const data = new Float32Array(nx * ny * nz);
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const p: Vec3 = [series.origin[0] + x * series.spacing[0], series.origin[1] + y * series.spacing[1], series.origin[2] + z * series.spacing[2]];
    data[(z * ny + y) * nx + x] = suv(p) / factor;
  }
  return { series, data };
}
const distance = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const ball = (center: Vec3, radius: number, inside: number, outside: number) => (p: Vec3) => distance(p, center) <= radius ? inside : outside;

/** SUVpeak by brute force: the 1 cm³ kernel's mean at every voxel centre inside the sphere, the highest kept. */
function brutePeak(source: Volume, sphere: Sphere): number {
  const series = source.series, kernel = peakKernel(series)!, [nx, ny, nz] = series.dimensions, factor = quantitativeScale(series).factor;
  let best = -Infinity;
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const p: Vec3 = [x * series.spacing[0], y * series.spacing[1], z * series.spacing[2]];
    if (distance(p, sphere.center) + PEAK_RADIUS_MM > sphere.radius + 1e-9) continue;
    let sum = 0, valid = true;
    for (let n = 0; n < kernel.weights.length; n++) {
      const i = x + kernel.offsets[n * 3], j = y + kernel.offsets[n * 3 + 1], k = z + kernel.offsets[n * 3 + 2];
      const at: Vec3 = [i * series.spacing[0], j * series.spacing[1], k * series.spacing[2]];
      if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz || distance(at, sphere.center) > sphere.radius + 1e-9) { valid = false; break; }
      sum += kernel.weights[n] * source.data[(k * ny + j) * nx + i] * factor;
    }
    if (valid) best = Math.max(best, sum / kernel.total);
  }
  return best;
}

describe('sphere geometry', () => {
  it('reads a sphere from its centre and a point on its surface, and rejects a click', () => {
    assert.deepEqual(sphereOf({ type: 'sphere', points: [[1, 2, 3], [4, 6, 3]] }), { center: [1, 2, 3], radius: 5 });
    assert.equal(sphereOf({ type: 'sphere', points: [[1, 2, 3], [1.1, 2, 3]] }), null);
    assert.equal(sphereOf({ type: 'ellipse', points: [[1, 2, 3], [4, 6, 3]] }), null);
    assert.deepEqual(spherePoints([0, 0, 0], 15, [0, 3, 4]), [[0, 0, 0], [0, 9, 12]]);
  });
  it('cuts the circle a plane makes through it, and nothing when the plane misses', () => {
    const section = sphereSection({ center: [0, 0, 10], radius: 5 }, { center: [7, 7, 7], normal: [0, 0, 2] })!;
    assert.deepEqual(section.center, [0, 0, 7]);
    assertClose(section.radius, 4);
    assert.equal(sphereSection({ center: [0, 0, 10], radius: 5 }, { center: [0, 0, 15], normal: [0, 0, 1] }), null);
  });
});

describe('the 1 cm³ SUVpeak sphere', () => {
  it('weighs voxels by their share inside it, adding up to 1 cm³ on any grid', () => {
    assertClose(PEAK_RADIUS_MM, 6.2035, 3);
    const turned = Math.PI / 6;
    for (const [spacing, direction] of [[[2, 2, 2]], [[4, 4, 3]], [[4.07, 4.07, 3.27]], [[2, 2, 2], [Math.cos(turned), -Math.sin(turned), 0, Math.sin(turned), Math.cos(turned), 0, 0, 0, 1]]] as Array<[Vec3, number[]?]>) {
      const kernel = peakKernel({ origin: [0, 0, 0], spacing, direction: direction ?? [1, 0, 0, 0, 1, 0, 0, 0, 1] })!;
      assert.ok(Math.abs(kernel.total * kernel.voxelMm3 - 1000) < 2, spacing.join('×'));
    }
  });
});

describe('sphere VOI statistics', () => {
  const lesion: Vec3 = [40, 40, 40];
  const source = volume(ball(lesion, 10, 8, 1));

  it('gives SUVmax, SUVmean, SUVpeak and the volume in the chosen SUV', () => {
    const sphere = { center: lesion, radius: 12 };
    const stats = sphereStatistics(source, sphere, quantitativeScale(source.series))!;
    assert.equal(stats.unit, 'SUVbw');
    assertClose(stats.max, 8, 5);
    assertClose(stats.peak!.value, 8, 5);
    assertClose(stats.volumeMl, 4 / 3 * Math.PI * 12 ** 3 / 1000, 6);
    assert.equal(stats.diameterMm, 24);
    // The mean of exactly the voxels whose centres lie in the sphere.
    let count = 0, sum = 0;
    for (let z = 0; z < 40; z++) for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) {
      const p: Vec3 = [x * 2, y * 2, z * 2];
      if (distance(p, lesion) <= 12) { count++; sum += ball(lesion, 10, 8, 1)(p); }
    }
    assert.equal(stats.count, count);
    assertClose(stats.mean, sum / count, 5);
    assert.equal(stats.clipped, false);
    // In SUL the values scale and are named SUL.
    const sul = sphereStatistics({ ...source, series: { ...source.series, suvNormalization: 'lbm' } }, sphere, quantitativeScale({ ...source.series, suvNormalization: 'lbm' }))!;
    assert.equal(sul.unit, 'SUL');
    assertClose(sul.max, 8 * 0.625 / 0.5, 4);
    assertClose(sul.peak!.value, 8 * 0.625 / 0.5, 4);
  });

  it('finds SUVpeak where the 1 cm³ mean is highest, away from a single hotter voxel', () => {
    const plateau: Vec3 = [30, 40, 40], hot: Vec3 = [56, 40, 40];
    const field = (p: Vec3) => distance(p, hot) < 0.5 ? 20 : distance(p, plateau) <= 8 ? 10 : 1;
    const mixed = volume(field), sphere = { center: [42, 40, 40] as Vec3, radius: 20 };
    const stats = sphereStatistics(mixed, sphere, quantitativeScale(mixed.series))!;
    assertClose(stats.max, 20, 5);
    assert.deepEqual(stats.maxAt, hot);
    assertClose(stats.peak!.value, 10, 5);
    assert.ok(distance(stats.peak!.at, plateau) <= 2);
    assertClose(stats.peak!.value, brutePeak(mixed, sphere), 9);
  });

  it('agrees with a brute-force search on an irregular field', () => {
    let seed = 12345;
    const random = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
    const blobs = Array.from({ length: 12 }, () => ({ at: [20 + random() * 40, 20 + random() * 40, 20 + random() * 40] as Vec3, size: 3 + random() * 8, height: 2 + random() * 10 }));
    const noise = new Map<string, number>();
    const field = (p: Vec3) => {
      const key = p.join(',');
      if (!noise.has(key)) noise.set(key, random() * 0.6);
      return 1 + noise.get(key)! + blobs.reduce((sum, blob) => sum + blob.height * Math.exp(-((distance(p, blob.at) / blob.size) ** 2)), 0);
    };
    const irregular = volume(field, { spacing: [2, 2, 2.5] });
    for (const sphere of [{ center: [40, 40, 50] as Vec3, radius: 18 }, { center: [30, 50, 45] as Vec3, radius: 9 }, { center: [4, 4, 4] as Vec3, radius: 10 }]) {
      const stats = sphereStatistics(irregular, sphere, quantitativeScale(irregular.series))!;
      const expected = brutePeak(irregular, sphere);
      if (Number.isFinite(expected)) assertClose(stats.peak!.value, expected, 9);
      else assert.equal(stats.peak, null);
    }
  });

  it('withholds peak when the 1 cm³ sphere cannot fit in valid VOI voxels', () => {
    // At the corner of the image every candidate's small sphere lies mostly outside it.
    const corner = sphereStatistics(source, { center: [0, 0, 0], radius: 2 }, quantitativeScale(source.series))!;
    assert.equal(corner.clipped, true);
    assert.equal(corner.peak, null);
  });

  it('excludes neighboring uptake and incomplete 1 cm³ samples', () => {
    const near = volume(p => distance(p, lesion) <= 6.1 ? 2 : 35);
    const result = sphereStatistics(near, { center: lesion, radius: 6.1 }, quantitativeScale(near.series))!;
    assert.equal(result.max, 2);
    assert.equal(result.peak, null);
    const withHole = volume(() => 3);
    withHole.data[(20 * 40 + 20) * 40 + 20] = NaN;
    assert.equal(sphereStatistics(withHole, { center: lesion, radius: 8 }, quantitativeScale(withHole.series))!.peak, null);
  });

  it('never calls a PET without SUV, or a CT, by an SUV, and gives them no SUVpeak', () => {
    const activity = { ...source, series: { ...source.series, suvFactor: null, sulFactor: null, valueUnit: 'BQML' } };
    const own = sphereStatistics(activity, { center: lesion, radius: 12 }, quantitativeScale(activity.series))!;
    assert.equal(own.unit, 'BQML');
    assert.equal(own.peak, null);
    assertClose(own.max, 16, 4);
    const ct = { ...source, series: { ...source.series, modality: 'CT', valueUnit: 'HU', suvFactor: null } };
    const hu = sphereStatistics(ct, { center: lesion, radius: 12 }, quantitativeScale(ct.series))!;
    assert.equal(hu.unit, 'HU');
    assert.equal(hu.peak, null);
    setLocale('en');
    assert.match(formatSphereStatistics(hu), /^HU max 16\.0 · mean [\d.]+ · min 2\.0 · 7\.24 mL · ⌀ 24\.0 mm · σ/);
    // Stored as SUV (Units GML) but refused by the engine, with no SUV factor: its own values in g/ml, never an SUV.
    const refused = { ...source, series: { ...source.series, suvFactor: null, sulFactor: 0.8, valueUnit: 'SUVbw', suvNormalization: 'lbm' as const } };
    const stored = sphereStatistics(refused, { center: lesion, radius: 12 }, quantitativeScale(refused.series))!;
    assert.equal(stored.unit, 'g/ml');
    assert.equal(stored.peak, null);
    assertClose(stored.max, 16, 4);
    assert.match(formatSphereStatistics(stored), /^g\/ml max 16\.0 · mean /);
    assert.doesNotMatch(formatSphereStatistics(stored), /SU[VL]/);
  });

  it('measures only a whole, reconstructable, scalar volume', () => {
    const sphere = { center: lesion, radius: 12 }, quantity = quantitativeScale(source.series);
    assert.equal(sphereStatistics({ ...source, sourceFrameIndex: 3 }, sphere, quantity), null);
    assert.equal(sphereStatistics({ ...source, series: { ...source.series, canReconstruct: false } }, sphere, quantity), null);
    assert.equal(sphereStatistics({ ...source, series: { ...source.series, components: 3 } }, sphere, quantity), null);
    assert.equal(sphereStatistics(source, { center: [500, 500, 500], radius: 5 }, quantity), null);
  });

  it('leaves padding and non-finite voxels out and says so', () => {
    const padded = volume(ball(lesion, 10, 8, 1));
    padded.data[(20 * 40 + 20) * 40 + 21] = NaN;
    const withPadding = { ...padded, series: { ...padded.series, paddingRange: [2, 2] as [number, number] } };
    const stats = sphereStatistics(withPadding, { center: lesion, radius: 12 }, quantitativeScale(withPadding.series))!;
    assert.equal(stats.invalidCount, 1);
    assert.ok(stats.paddingCount > 0);
    setLocale('en');
    const text = formatSphereStatistics(stats);
    assert.ok(text.includes('SUVpeak unavailable'));
    assert.ok(text.includes('1 non-finite voxel excluded'));
    assert.ok(text.includes('padding voxels excluded'));
  });
});

describe('metabolic volume inside a sphere', () => {
  const lesion: Vec3 = [40, 40, 40], sphere = { center: lesion, radius: 12 };
  const [max41, suv25] = THRESHOLDS;
  /** Voxel centres of the 2 mm grid within `radius` of the lesion. */
  const inside = (radius: number) => {
    let count = 0;
    for (let z = 0; z < 40; z++) for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) if (distance([x * 2, y * 2, z * 2], lesion) <= radius) count++;
    return count;
  };

  it('counts the voxels at 41% of the SUVmax or above: MTV, and TLG as MTV times their mean', () => {
    const source = volume(ball(lesion, 10, 8, 1)), metabolic = thresholdVolume(source, sphere, quantitativeScale(source.series), max41)!;
    assertClose(metabolic.level, 0.41 * 8, 6);
    assert.equal(metabolic.count, inside(10));
    assertClose(metabolic.mtvMl, inside(10) * 8 / 1000, 9);
    assertClose(metabolic.mean, 8, 5);
    assertClose(metabolic.tlg, metabolic.mtvMl * 8, 5);
    assert.equal(metabolic.unit, 'SUVbw');
    const labels = metabolic.mask!.labels.reduce((sum, label) => sum + label, 0);
    assert.equal(labels, metabolic.count);
    assert.deepEqual(metabolic.mask!.dimensions, [11, 11, 11]);
  });

  it('reads 41% the same in any SUV, and SUV 2.5 always in SUVbw', () => {
    // A background of SUVbw 2.2 reads SUL 2.75: above 2.5 in SUL, below it in SUVbw, so it is not counted.
    const source = volume(ball(lesion, 10, 8, 2.2)), sul = { ...source, series: { ...source.series, suvNormalization: 'lbm' as const } };
    const bw = thresholdVolume(source, sphere, quantitativeScale(source.series), max41)!, lean = thresholdVolume(sul, sphere, quantitativeScale(sul.series), max41)!;
    assert.equal(lean.count, bw.count);
    assertClose(lean.tlg, bw.tlg! * 1.25, 4);
    const fixed = thresholdVolume(sul, sphere, quantitativeScale(sul.series), suv25)!;
    assert.equal(fixed.count, inside(10));
    assertClose(fixed.level, 2.5 * 1.25, 6);
    assert.equal(fixed.unit, 'SUL');
  });

  it('has no metabolic volume on a CT or a PET without SUV', () => {
    const source = volume(ball(lesion, 10, 8, 1));
    const ct = { ...source, series: { ...source.series, modality: 'CT', valueUnit: 'HU', suvFactor: null } };
    assert.equal(thresholdVolume(ct, sphere, quantitativeScale(ct.series), max41), null);
    const activity = { ...source, series: { ...source.series, suvFactor: null, sulFactor: null, valueUnit: 'BQML' } };
    assert.equal(thresholdVolume(activity, sphere, quantitativeScale(activity.series), suv25), null);
    const refused = { ...source, series: { ...source.series, suvFactor: null, sulFactor: null, valueUnit: 'SUVbw' } };
    for (const threshold of [max41, suv25]) assert.equal(thresholdVolume(refused, sphere, quantitativeScale(refused.series), threshold), null);
  });

  it('gives MTV and TLG after the sphere\'s own volume in its line', () => {
    setLocale('en');
    const source = volume(ball(lesion, 10, 8, 1)), quantity = quantitativeScale(source.series);
    const text = formatSphereStatistics(sphereStatistics(source, sphere, quantity)!, thresholdVolume(source, sphere, quantity, max41));
    assert.match(text, / · ⌀ 24\.0 mm · MTV 41% [\d.]+ mL · TLG [\d.]+ SUVbw·mL · σ /);
  });
});

it('requires a body-weight conversion for SUVbw 2.5 and an FDG tracer for TLG', () => {
  const source = volume(() => 2.6);
  const lbm = { ...source, series: { ...source.series, valueUnit: 'SUVlbm', suvFactor: 1, sulFactor: undefined } };
  const sphere: Sphere = { center: [40, 40, 40], radius: 5 };
  assert.equal(thresholdVolume(lbm, sphere, quantitativeScale(lbm.series), THRESHOLDS[1]), null);
  const psma = { ...source, series: { ...source.series, petAcquisition: { tracer: 'Ga-68 PSMA' } } };
  const measured = thresholdVolume(psma, sphere, quantitativeScale(psma.series), THRESHOLDS[0])!;
  assert.ok(measured.mtvMl > 0);
  assert.equal(measured.tlg, undefined);
});

it('shows disconnected uptake for review and measures only the selected regions', () => {
  const source = volume(([x,y,z]) => y === 40 && z === 40 && (x === 36 || x === 44) ? 10 : 0);
  const sphere: Sphere = { center: [40,40,40], radius: 6 }, quantity = quantitativeScale(source.series);
  const pending = thresholdVolume(source, sphere, quantity, THRESHOLDS[0])!;
  assert.equal(pending.regions.length, 2);
  assert.equal(pending.selectionRequired, true);
  assert.equal(pending.count, 0);
  const selected = thresholdVolume(source, sphere, quantity, THRESHOLDS[0], undefined, [pending.regions[0].seed])!;
  assert.equal(selected.selectionRequired, false);
  assert.equal(selected.count, 1);
  assertClose(selected.mtvMl, 0.008);
});
