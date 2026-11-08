// Sphere VOIs: a region in three dimensions, drawn in any pane by dragging its radius and measured through the
// volume's own voxels, whichever plane it was drawn on. For a PET in SUV it also gives SUVpeak: the highest mean in a
// 1 cm³ sphere, placed wherever that mean is highest. That is Practical PERCIST's definition (O, Lodge and Wahl,
// Radiology 2016): the small sphere need not sit on, or even contain, the hottest voxel.
//
// Values are in the quantity the caller passes, `quantitativeScale` (annotations.ts): the SUV the Units panel selects
// (SUVbw, SUL or SUVbsa, each named by its unit), or the series' own unit. A PET without SUV is never called SUV.
import type { Annotation, LabelVolume, Series, Vec3, Volume } from '../model';
import { indexToWorld, isPaddingValue, worldToIndexMatrix } from './geometry';
import { getLocale, t } from '../i18n';
import { bodyWeightFactor } from './quantity';
import { petTracer } from './petTracer';
import { sulGlu, type StudyGlucose } from './glucose';

export interface Sphere { center: Vec3; radius: number }
export interface Quantity { factor: number; unit: string }

/** SUVpeak averages a 1 cm³ (1000 mm³) sphere: radius 6.20 mm, about 1.24 cm across. */
export const PEAK_VOLUME_MM3 = 1000;
export const PEAK_RADIUS_MM = Math.cbrt(3 * PEAK_VOLUME_MM3 / (4 * Math.PI));
/** A sphere whose bounding box spans more voxels than this is not measured. */
export const SPHERE_VOXEL_LIMIT = 16_000_000;
/** A sphere is drawn with its centre and a point on its surface; a smaller radius than this is a click, not a sphere. */
export const MIN_SPHERE_RADIUS_MM = 0.5;
/** The liver reference is a 3 cm sphere (PERCIST 1.0: a 3 cm diameter region in normal right-lobe liver). */
export const LIVER_REFERENCE_RADIUS_MM = 15;

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const finite = (point: Vec3) => point.every(Number.isFinite);

/** The sphere a `sphere` annotation stands for: its first point is the centre, its second a point on the surface. */
export function sphereOf(annotation: Pick<Annotation, 'type' | 'points'>): Sphere | null {
  if (annotation.type !== 'sphere' || annotation.points.length < 2) return null;
  const [center, edge] = annotation.points;
  if (!finite(center) || !finite(edge)) return null;
  const radius = Math.hypot(...sub(edge, center));
  return Number.isFinite(radius) && radius >= MIN_SPHERE_RADIUS_MM ? { center: [...center], radius } : null;
}

/** The points of a sphere with `center` and `radius`, its surface point taken towards `toward` (or along x). */
export function spherePoints(center: Vec3, radius: number, toward?: Vec3): Vec3[] {
  let direction: Vec3 = toward ? sub(toward, center) : [1, 0, 0];
  const length = Math.hypot(...direction);
  direction = length > 1e-9 ? [direction[0] / length, direction[1] / length, direction[2] / length] : [1, 0, 0];
  return [[...center], [center[0] + direction[0] * radius, center[1] + direction[1] * radius, center[2] + direction[2] * radius]];
}

/** The circle a plane (a point on it and its normal) cuts from a sphere: its centre in the plane and its radius; null
 * when the plane misses the sphere. */
export function sphereSection(sphere: Sphere, plane: { center: Vec3; normal: Vec3 }): { center: Vec3; radius: number; depth: number } | null {
  const length = Math.hypot(...plane.normal);
  if (!(length > 1e-12)) return null;
  const normal: Vec3 = [plane.normal[0] / length, plane.normal[1] / length, plane.normal[2] / length];
  const depth = dot(sub(sphere.center, plane.center), normal);
  if (!(Math.abs(depth) < sphere.radius)) return null;
  return { center: sub(sphere.center, [normal[0] * depth, normal[1] * depth, normal[2] * depth]), radius: Math.sqrt(sphere.radius ** 2 - depth ** 2), depth };
}

export interface SphereStatistics {
  unit: string;
  /** Voxels whose centre lies inside the sphere and that have a value. */
  count: number;
  mean: number; max: number; min: number; standardDeviation: number;
  /** The centre of the hottest voxel. */
  maxAt: Vec3;
  /** The sphere's own volume (mL) and diameter (mm). */
  volumeMl: number; diameterMm: number;
  /** The highest mean in a 1 cm³ sphere and where that sphere is centred: for a PET in SUV only. */
  peak: { value: number; at: Vec3 } | null;
  /** Part of the sphere lies outside the image. */
  clipped: boolean;
  paddingCount: number; invalidCount: number;
}

/** Whether a volume can be measured in three dimensions: a whole, reconstructable, scalar volume. */
export function measurableVolume(volume: Volume): boolean {
  const series = volume.series, [nx, ny, nz] = series.dimensions;
  return volume.sourceFrameIndex === undefined && series.components !== 3 && series.canReconstruct && !series.sourceFramesOnly
    && series.spacingKnown !== false && volume.data.length >= nx * ny * nz;
}

/** Whether a quantity is an SUV (SUVbw, SUL, SUVbsa…), so that SUVpeak applies. */
export const isSuv = (unit: string) => /^SU[VL]/i.test(unit);

/** The voxel index box that holds every voxel centre the sphere may contain, and whether the sphere reaches past the
 * image. Null when the series' geometry cannot be inverted. */
function indexBox(series: Series, sphere: Sphere): { first: Vec3; last: Vec3; clipped: boolean } | null {
  let inverse: number[];
  try { inverse = worldToIndexMatrix(series); } catch { return null; }
  const center = sub(sphere.center, series.origin), dimensions = series.dimensions;
  const first: number[] = [], last: number[] = [];
  let clipped = false;
  for (let axis = 0; axis < 3; axis++) {
    const row: Vec3 = [inverse[axis * 3], inverse[axis * 3 + 1], inverse[axis * 3 + 2]];
    // A row of the inverse maps a world offset to this index: over the sphere it reaches |row| × radius either side.
    const middle = dot(row, center), reach = Math.hypot(...row) * sphere.radius;
    if (!Number.isFinite(middle) || !Number.isFinite(reach)) return null;
    const low = middle - reach, high = middle + reach;
    clipped ||= low < -0.5 - 1e-9 || high > dimensions[axis] - 0.5 + 1e-9;
    first.push(Math.max(0, Math.ceil(low - 1e-9)));
    last.push(Math.min(dimensions[axis] - 1, Math.floor(high + 1e-9)));
  }
  return { first: first as Vec3, last: last as Vec3, clipped };
}

/** One index step along i, j and k, in mm. */
function voxelAxes(series: Series): [Vec3, Vec3, Vec3] {
  const origin = indexToWorld(series, [0, 0, 0]);
  return [sub(indexToWorld(series, [1, 0, 0]), origin), sub(indexToWorld(series, [0, 1, 0]), origin), sub(indexToWorld(series, [0, 0, 1]), origin)];
}

/** Statistics of the voxels whose centres lie inside `sphere`, in `quantity`. Null for a volume that cannot be measured
 * in three dimensions, a sphere with no voxel in the image, or one larger than SPHERE_VOXEL_LIMIT. */
export function sphereStatistics(volume: Volume, sphere: Sphere, quantity: Quantity): SphereStatistics | null {
  if (!measurableVolume(volume) || !(sphere.radius > 0) || !finite(sphere.center) || !(quantity.factor > 0)) return null;
  const series = volume.series, box = indexBox(series, sphere);
  if (!box) return null;
  const { first, last } = box, [nx, ny] = series.dimensions;
  const span = [0, 1, 2].map(axis => last[axis] - first[axis] + 1);
  if (span.some(n => n < 1) || span[0] * span[1] * span[2] > SPHERE_VOXEL_LIMIT) return null;
  const [di, dj, dk] = voxelAxes(series), start = sub(indexToWorld(series, first), sphere.center);
  const reach = sphere.radius * sphere.radius * (1 + 1e-12) + 1e-9;
  const suv = series.modality === 'PT' && isSuv(quantity.unit);
  const candidates: number[] = [], inside: number[] = [];
  const centerReach = sphere.radius < PEAK_RADIUS_MM ? -1 : (sphere.radius - PEAK_RADIUS_MM) ** 2;
  let seed = -1, seedValue = -Infinity;
  let count = 0, mean = 0, squares = 0, sum = 0, correction = 0, min = Infinity, max = -Infinity, maxIndex = -1;
  let paddingCount = 0, invalidCount = 0;
  for (let k = first[2]; k <= last[2]; k++) {
    for (let j = first[1]; j <= last[1]; j++) {
      const a = k - first[2], b = j - first[1];
      let x = start[0] + a * dk[0] + b * dj[0], y = start[1] + a * dk[1] + b * dj[1], z = start[2] + a * dk[2] + b * dj[2];
      for (let i = first[0]; i <= last[0]; i++, x += di[0], y += di[1], z += di[2]) {
        const distance2 = x * x + y * y + z * z;
        if (distance2 > reach) continue;
        const index = (k * ny + j) * nx + i, stored = volume.data[index];
        if (isPaddingValue(series, stored, k)) { paddingCount++; continue; }
        const value = stored * quantity.factor;
        if (!Number.isFinite(value)) { invalidCount++; continue; }
        count++;
        const delta = value - mean;
        mean += delta / count;
        squares += delta * (value - mean);
        const next = sum + value;
        correction += Math.abs(sum) >= Math.abs(value) ? (sum - next) + value : (value - next) + sum;
        sum = next;
        if (value > max) { max = value; maxIndex = index; }
        if (value < min) min = value;
        if (suv && centerReach >= 0) {
          inside.push(index);
          if (distance2 <= centerReach + 1e-9) {
            candidates.push(index);
            if (value > seedValue) { seed = index; seedValue = value; }
          }
        }
      }
    }
  }
  if (!count) return null;
  const compensated = (sum + correction) / count;
  if (Number.isFinite(compensated)) mean = compensated;
  const at = (index: number): Vec3 => indexToWorld(series, [index % nx, Math.floor(index / nx) % ny, Math.floor(index / (nx * ny))]);
  return {
    unit: quantity.unit, count, mean, max, min, standardDeviation: Math.sqrt(Math.max(0, squares / count)), maxAt: at(maxIndex),
    volumeMl: 4 / 3 * Math.PI * sphere.radius ** 3 / 1000, diameterMm: sphere.radius * 2,
    peak: suv ? peakOf(volume, quantity.factor, candidates, inside, seed) : null,
    clipped: box.clipped, paddingCount, invalidCount,
  };
}

// Results kept per drawing (a drawing that changes is a new object), per volume's pixels and per quantity.
type Kept<T> = WeakMap<object, WeakMap<Volume['data'], Map<string, { series: Series; value: T }>>>;
function remembered<T>(store: Kept<T>, annotation: Annotation, volume: Volume, quantity: Quantity, compute: () => T): T {
  let byVolume = store.get(annotation);
  if (!byVolume) { byVolume = new WeakMap(); store.set(annotation, byVolume); }
  let byQuantity = byVolume.get(volume.data);
  if (!byQuantity) { byQuantity = new Map(); byVolume.set(volume.data, byQuantity); }
  const key = `${quantity.unit}:${quantity.factor}`, cached = byQuantity.get(key), series = volume.series;
  if (cached?.series === series) return cached.value;
  const value = compute();
  byQuantity.set(key, { series, value });
  return value;
}
const measured: Kept<SphereStatistics | null> = new WeakMap();

/** `sphereStatistics` for a `sphere` annotation, computed once for each drawing, volume and quantity. */
export function sphereStatisticsFor(annotation: Annotation, volume: Volume, quantity: Quantity): SphereStatistics | null {
  const sphere = sphereOf(annotation);
  if (!sphere) return null;
  if (volume.sourceFrameIndex !== undefined) return sphereStatistics(volume, sphere, quantity);
  return remembered(measured, annotation, volume, quantity, () => sphereStatistics(volume, sphere, quantity));
}

// Metabolic volume inside a sphere: its voxels at or above a threshold, as data. 41% of the sphere's SUVmax (EANM) is
// relative, so the same in any SUV; SUV 2.5 is read in SUVbw whatever SUV is shown, as it is defined. The reader selects the lesion regions when uptake is disconnected.
export type ThresholdId = 'max41' | 'suv2.5';
export interface Threshold { id: ThresholdId; relative?: number; suvBw?: number }
export const THRESHOLDS: readonly Threshold[] = [{ id: 'max41', relative: 0.41 }, { id: 'suv2.5', suvBw: 2.5 }];
export const isThresholdId = (value: unknown): value is ThresholdId => THRESHOLDS.some(item => item.id === value);

export interface ThresholdVolume {
  threshold: ThresholdId;
  /** The level, in the quantity. */
  level: number;
  count: number;
  /** Metabolic tumour volume (mL) and total lesion glycolysis (MTV × mean, in the quantity times mL). */
  mtvMl: number; mean: number; tlg?: number; unit: string;
  regions: { seed: number; count: number; at: Vec3 }[];
  selectionRequired: boolean;
  /** The voxels counted, for drawing (src/imaging/segmentation.ts planeOutlines). */
  mask: LabelVolume | null;
}

const MASK_COLOR = '#ff8a3d', MASK_RGB: [number, number, number] = [255, 138, 61];

/** The voxels of `sphere` at or above `threshold`, in `quantity`: a PET in SUV only. */
export function thresholdVolume(volume: Volume, sphere: Sphere, quantity: Quantity, threshold: Threshold, stats = sphereStatistics(volume, sphere, quantity), selected: readonly number[] = []): ThresholdVolume | null {
  const series = volume.series;
  if (!stats || series.modality !== 'PT' || !isSuv(quantity.unit)) return null;
  let level: number;
  if (threshold.relative !== undefined) level = threshold.relative * stats.max;
  else {
    const bodyWeight = bodyWeightFactor(series);
    if (!bodyWeight || threshold.suvBw === undefined) return null;
    level = threshold.suvBw * quantity.factor / bodyWeight;
  }
  if (!Number.isFinite(level) || level <= 0) return null;
  const box = indexBox(series, sphere);
  if (!box) return null;
  const { first, last } = box, [nx, ny] = series.dimensions;
  const [di, dj, dk] = voxelAxes(series), start = sub(indexToWorld(series, first), sphere.center);
  const reach = sphere.radius * sphere.radius * (1 + 1e-12) + 1e-9;
  const included: number[] = [];
  for (let k = first[2]; k <= last[2]; k++) for (let j = first[1]; j <= last[1]; j++) {
    const a = k - first[2], b = j - first[1];
    let x = start[0] + a * dk[0] + b * dj[0], y = start[1] + a * dk[1] + b * dj[1], z = start[2] + a * dk[2] + b * dj[2];
    for (let i = first[0]; i <= last[0]; i++, x += di[0], y += di[1], z += di[2]) {
      if (x * x + y * y + z * z > reach) continue;
      const index = (k * ny + j) * nx + i, stored = volume.data[index];
      if (isPaddingValue(series, stored, k)) continue;
      const value = stored * quantity.factor;
      if (!Number.isFinite(value) || value < level) continue;
      included.push(index);
    }
  }
  const voxelMl = Math.abs(dot(di, [dj[1] * dk[2] - dj[2] * dk[1], dj[2] * dk[0] - dj[0] * dk[2], dj[0] * dk[1] - dj[1] * dk[0]])) / 1000;
  const groups = connectedRegions(series.dimensions, included);
  const regions = groups.map(group => {
    const peak = group.reduce((best, index) => volume.data[index] > volume.data[best] ? index : best, group[0]);
    const at = indexToWorld(series, [peak % nx, Math.floor(peak / nx) % ny, Math.floor(peak / (nx * ny))]);
    return { seed: group[0], count: group.length, at };
  });
  const seeds = new Set(selected);
  const chosen = groups.length <= 1 ? groups : groups.filter(group => seeds.has(group[0]));
  const selectionRequired = groups.length > 1 && chosen.length === 0;
  const count = chosen.reduce((total, group) => total + group.length, 0);
  let sum = 0;
  for (const group of chosen) for (const index of group) sum += volume.data[index] * quantity.factor;
  const mtvMl = count * voxelMl, mean = count ? sum / count : 0;
  const tlg = petTracer(series.petAcquisition) === 'fdg' && !selectionRequired ? mtvMl * mean : undefined;
  const visible = chosen.length === groups.length || selectionRequired ? included : chosen.flat();
  const mask = visible.length ? maskOf(series, visible, di, dj, dk) : null;
  return { threshold: threshold.id, level, count, mtvMl, mean, tlg, unit: quantity.unit, mask, regions, selectionRequired };
}

/** Face-connected regions, identified by their lowest voxel index on the source grid. */
function connectedRegions([nx, ny, nz]: Vec3, indices: readonly number[]): number[][] {
  const remaining = new Set(indices), plane = nx * ny, groups: number[][] = [];
  for (const seed of indices) {
    if (!remaining.delete(seed)) continue;
    const group = [seed];
    const visit = (index: number) => { if (remaining.delete(index)) group.push(index); };
    for (let i = 0; i < group.length; i++) {
      const index = group[i], x = index % nx, y = Math.floor(index / nx) % ny, z = Math.floor(index / plane);
      if (x > 0) visit(index - 1);
      if (x + 1 < nx) visit(index + 1);
      if (y > 0) visit(index - nx);
      if (y + 1 < ny) visit(index + nx);
      if (z > 0) visit(index - plane);
      if (z + 1 < nz) visit(index + plane);
    }
    groups.push(group);
  }
  return groups;
}

/** The voxels `included` (indices into the volume) as a one-segment label volume on the series' own grid. */
function maskOf(series: Series, included: readonly number[], i: Vec3, j: Vec3, k: Vec3): LabelVolume {
  const [nx, ny] = series.dimensions, low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
  const positions = included.map(index => [index % nx, Math.floor(index / nx) % ny, Math.floor(index / (nx * ny))] as Vec3);
  for (const p of positions) for (let axis = 0; axis < 3; axis++) { low[axis] = Math.min(low[axis], p[axis]); high[axis] = Math.max(high[axis], p[axis]); }
  const dimensions = [0, 1, 2].map(axis => high[axis] - low[axis] + 1) as Vec3, labels = new Uint8Array(dimensions[0] * dimensions[1] * dimensions[2]);
  for (const p of positions) labels[((p[2] - low[2]) * dimensions[1] + p[1] - low[1]) * dimensions[0] + p[0] - low[0]] = 1;
  const length = Math.hypot(...k) || 1;
  return { dimensions, origin: indexToWorld(series, low as Vec3), i, j, k, normal: [k[0] / length, k[1] / length, k[2] / length], labels,
    segments: [{ segment: 1, label: 'MTV', color: MASK_COLOR, rgb: MASK_RGB }], min: [0, 0, 0], max: [dimensions[0] - 1, dimensions[1] - 1, dimensions[2] - 1] };
}

const thresholded: Kept<ThresholdVolume | null> = new WeakMap();

/** `thresholdVolume` for a sphere annotation with a threshold, computed once for each drawing, volume and quantity. */
export function thresholdVolumeFor(annotation: Annotation, volume: Volume, quantity: Quantity): ThresholdVolume | null {
  const sphere = sphereOf(annotation), threshold = THRESHOLDS.find(item => item.id === annotation.threshold);
  if (!sphere || !threshold || volume.sourceFrameIndex !== undefined) return null;
  return remembered(thresholded, annotation, volume, quantity, () => thresholdVolume(volume, sphere, quantity, threshold, sphereStatisticsFor(annotation, volume, quantity), annotation.regionSeeds));
}

// The 1 cm³ sphere as weights on the voxel grid: each voxel's share of its box inside a sphere centred on a voxel
// centre. The weights times the voxel volume add up to 1000 mm³.
export interface PeakKernel {
  /** Index offsets (i, j, k) of the voxels with a weight, three numbers each. */
  offsets: Int32Array;
  weights: Float64Array;
  /** The largest offset along each axis. */
  half: [number, number, number];
  /** The weights' sum: 1 cm³ in voxels. */
  total: number;
  voxelMm3: number;
}
const KERNEL_SAMPLES = 16;
const kernels = new Map<string, PeakKernel | null>();

export function peakKernel(series: Pick<Series, 'origin' | 'direction' | 'spacing'>): PeakKernel | null {
  const key = [...series.spacing, ...series.direction].join(',');
  if (kernels.has(key)) return kernels.get(key)!;
  const kernel = buildKernel(series as Series);
  if (kernels.size >= 16) kernels.delete(kernels.keys().next().value!);
  kernels.set(key, kernel);
  return kernel;
}

function buildKernel(series: Series): PeakKernel | null {
  let inverse: number[];
  try { inverse = worldToIndexMatrix(series); } catch { return null; }
  const axes = voxelAxes(series);
  const voxelMm3 = Math.abs(dot(axes[0], [axes[1][1] * axes[2][2] - axes[1][2] * axes[2][1], axes[1][2] * axes[2][0] - axes[1][0] * axes[2][2], axes[1][0] * axes[2][1] - axes[1][1] * axes[2][0]]));
  if (!(voxelMm3 > 0) || !Number.isFinite(voxelMm3)) return null;
  // The farthest corner of a voxel's box from its centre.
  let corner = 0;
  for (const sx of [-0.5, 0.5]) for (const sy of [-0.5, 0.5]) for (const sz of [-0.5, 0.5]) {
    corner = Math.max(corner, Math.hypot(sx * axes[0][0] + sy * axes[1][0] + sz * axes[2][0], sx * axes[0][1] + sy * axes[1][1] + sz * axes[2][1], sx * axes[0][2] + sy * axes[1][2] + sz * axes[2][2]));
  }
  const radius = PEAK_RADIUS_MM, reach = radius + corner;
  const half = [0, 1, 2].map(axis => Math.ceil(reach * Math.hypot(inverse[axis * 3], inverse[axis * 3 + 1], inverse[axis * 3 + 2]))) as [number, number, number];
  if (half.some(n => !Number.isFinite(n) || n > 64)) return null;
  // A voxel on the sphere's edge: its box sampled on a grid across i and j, and each line through it along k cut by the
  // sphere exactly (where |q + w·k|² = r²).
  const offsets: number[] = [], weights: number[] = [], samples = KERNEL_SAMPLES, step = 1 / samples, k = axes[2];
  const kk = dot(k, k);
  for (let c = -half[2]; c <= half[2]; c++) for (let b = -half[1]; b <= half[1]; b++) for (let a = -half[0]; a <= half[0]; a++) {
    const center: Vec3 = [a * axes[0][0] + b * axes[1][0] + c * axes[2][0], a * axes[0][1] + b * axes[1][1] + c * axes[2][1], a * axes[0][2] + b * axes[1][2] + c * axes[2][2]];
    const distance = Math.hypot(...center);
    let weight: number;
    if (distance + corner <= radius) weight = 1;
    else if (distance - corner >= radius) continue;
    else {
      let inside = 0;
      for (let y = 0; y < samples; y++) for (let x = 0; x < samples; x++) {
        const u = (x + 0.5) * step - 0.5, v = (y + 0.5) * step - 0.5;
        const q: Vec3 = [center[0] + u * axes[0][0] + v * axes[1][0], center[1] + u * axes[0][1] + v * axes[1][1], center[2] + u * axes[0][2] + v * axes[1][2]];
        const along = dot(q, k), rest = dot(q, q) - radius * radius, discriminant = along * along - kk * rest;
        if (discriminant <= 0) continue;
        const root = Math.sqrt(discriminant), low = (-along - root) / kk, high = (-along + root) / kk;
        inside += Math.max(0, Math.min(0.5, high) - Math.max(-0.5, low));
      }
      if (!(inside > 0)) continue;
      weight = inside / samples ** 2;
    }
    offsets.push(a, b, c); weights.push(weight);
  }
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return { offsets: Int32Array.from(offsets), weights: Float64Array.from(weights), half, total, voxelMm3 };
}

/** The mean of the 1 cm³ sphere centred on voxel (x, y, z) of `values` (a box of the volume, NaN where there is no
 * value), or NaN if any contributing voxel is unavailable. */
function kernelMean(values: Float64Array, size: Vec3, kernel: PeakKernel, x: number, y: number, z: number): number {
  const [sx, sy, sz] = size, { offsets, weights, half } = kernel;
  const inside = x - half[0] >= 0 && x + half[0] < sx && y - half[1] >= 0 && y + half[1] < sy && z - half[2] >= 0 && z + half[2] < sz;
  let sum = 0;
  for (let n = 0, o = 0; n < weights.length; n++, o += 3) {
    const i = x + offsets[o], j = y + offsets[o + 1], k = z + offsets[o + 2];
    if (!inside && (i < 0 || j < 0 || k < 0 || i >= sx || j >= sy || k >= sz)) return NaN;
    const value = values[(k * sy + j) * sx + i];
    if (!Number.isFinite(value)) return NaN;
    sum += weights[n] * value;
  }
  return sum / kernel.total;
}

/** The running maximum of `values` over a box `half` voxels either side, axis by axis (NaN counts as nothing). */
function boxMaximum(values: Float64Array, size: Vec3, half: [number, number, number]): Float64Array {
  let current = values.map(value => value !== value ? -Infinity : value);
  const strides = [1, size[0], size[0] * size[1]];
  for (let axis = 0; axis < 3; axis++) {
    if (!half[axis]) continue;
    const next = new Float64Array(current.length), stride = strides[axis], length = size[axis];
    for (let index = 0; index < current.length; index++) {
      const position = Math.floor(index / stride) % length;
      const from = Math.max(0, position - half[axis]), to = Math.min(length - 1, position + half[axis]);
      let best = -Infinity;
      for (let p = from, at = index + (from - position) * stride; p <= to; p++, at += stride) if (current[at] > best) best = current[at];
      next[index] = best;
    }
    current = next;
  }
  return current;
}

/** Search complete 1 cm³ spheres within the VOI. Only valid VOI voxels can contribute to the mean. */
function peakOf(volume: Volume, factor: number, candidates: readonly number[], inside: readonly number[], seed: number): { value: number; at: Vec3 } | null {
  if (!candidates.length) return null;
  const series = volume.series, kernel = peakKernel(series);
  if (!kernel) return null;
  const [nx, ny, nz] = series.dimensions;
  const position = (index: number): Vec3 => [index % nx, Math.floor(index / nx) % ny, Math.floor(index / (nx * ny))];
  // The box of the volume the small spheres can reach, its values in the quantity and NaN where there is none.
  const low: number[] = [Infinity, Infinity, Infinity], high: number[] = [-Infinity, -Infinity, -Infinity];
  for (const index of candidates) {
    const p = position(index);
    for (let axis = 0; axis < 3; axis++) { low[axis] = Math.min(low[axis], p[axis]); high[axis] = Math.max(high[axis], p[axis]); }
  }
  const dimensions = [nx, ny, nz], from = low.map((value, axis) => Math.max(0, value - kernel.half[axis])) as Vec3;
  const to = high.map((value, axis) => Math.min(dimensions[axis] - 1, value + kernel.half[axis]));
  const size = [0, 1, 2].map(axis => to[axis] - from[axis] + 1) as Vec3;
  const values = new Float64Array(size[0] * size[1] * size[2]).fill(NaN);
  for (const index of inside) {
    const [x, y, z] = position(index);
    if (x < from[0] || y < from[1] || z < from[2] || x > to[0] || y > to[1] || z > to[2]) continue;
    values[((z - from[2]) * size[1] + y - from[1]) * size[0] + x - from[0]] = volume.data[index] * factor;
  }
  const bound = boxMaximum(values, size, kernel.half);
  const local = (index: number): Vec3 => { const p = position(index); return [p[0] - from[0], p[1] - from[1], p[2] - from[2]]; };
  let best = -Infinity, bestIndex = -1;
  const consider = (index: number) => {
    const [x, y, z] = local(index);
    if (!(bound[(z * size[1] + y) * size[0] + x] > best)) return;
    const mean = kernelMean(values, size, kernel, x, y, z);
    if (mean > best) { best = mean; bestIndex = index; }
  };
  // The hottest voxel first: its sphere's mean is near the answer, so most other candidates are skipped at once.
  if (seed >= 0) consider(seed);
  for (const index of candidates) consider(index);
  return bestIndex < 0 ? null : { value: best, at: indexToWorld(series, position(bestIndex)) };
}

export const formatSphereValue = (value: number, digits: number) => Number.isFinite(value) ? value.toLocaleString(getLocale(), { useGrouping: false, minimumFractionDigits: digits, maximumFractionDigits: digits }) : '—';
export const peakName = (unit: string) => /^(SUL|SUVlbm)$/i.test(unit) ? 'SULpeak' : 'SUVpeak';
const volumeText = (millilitres: number) => formatSphereValue(millilitres, millilitres < 10 ? 2 : 1);

export function sphereSulGlu(stats: SphereStatistics, glucose?: StudyGlucose | null): string | null {
  if (!glucose || stats.unit !== 'SUL') return null;
  const max = formatSphereValue(sulGlu(stats.max, glucose), 2);
  return stats.peak ? t('sphere.sulGlu', { max, peak: formatSphereValue(sulGlu(stats.peak.value, glucose), 2) }) : t('sphere.sulGluMax', { max });
}

/** The line a sphere VOI's statistics read as, its main value first: max (with the unit), peak for a PET in SUV, mean,
 * volume and diameter, then σ and the voxel count. In SUL with a `glucose`, SULglu's max and peak follow SUL's
 * (imaging/glucose.ts): beside SUL, never instead of it. */
export function formatSphereStatistics(stats: SphereStatistics, metabolic?: ThresholdVolume | null, glucose?: StudyGlucose | null): string {
  const digits = isSuv(stats.unit) ? 2 : 1;
  const parts = [t('sphere.max', { unit: stats.unit, value: formatSphereValue(stats.max, digits) })];
  if (stats.peak) parts.push(t('sphere.peak', { name: peakName(stats.unit), value: formatSphereValue(stats.peak.value, digits) }));
  else if (isSuv(stats.unit)) parts.push(t('sphere.noPeak', { name: peakName(stats.unit) }));
  parts.push(t('sphere.mean', { value: formatSphereValue(stats.mean, digits) }));
  if (!stats.peak) parts.push(`${t('roi.min')} ${formatSphereValue(stats.min, digits)}`);
  const corrected = sphereSulGlu(stats, glucose);
  if (corrected) parts.push(corrected);
  parts.push(t('sphere.volume', { value: volumeText(stats.volumeMl) }), t('sphere.diameter', { value: formatSphereValue(stats.diameterMm, 1) }));
  if (metabolic && !metabolic.selectionRequired) {
    parts.push(t(metabolic.threshold === 'max41' ? 'sphere.mtv41' : 'sphere.mtvSuv', { value: volumeText(metabolic.mtvMl) }));
    if (metabolic.tlg !== undefined) parts.push(t('sphere.tlg', { value: formatSphereValue(metabolic.tlg, 1), unit: metabolic.unit }));
  }
  parts.push(`σ ${formatSphereValue(stats.standardDeviation, digits)}`, t('sphere.voxels', { count: stats.count }));
  const one = (count: number) => count === 1;
  const notes = `${stats.clipped ? t('roi.clipped') : ''}${stats.invalidCount ? t(one(stats.invalidCount) ? 'roi.nonFiniteVoxel' : 'roi.nonFiniteVoxels', { count: stats.invalidCount }) : ''}${stats.paddingCount ? t(one(stats.paddingCount) ? 'roi.paddingVoxel' : 'roi.paddingVoxels', { count: stats.paddingCount }) : ''}`;
  return `${parts.join(' · ')}${notes}`;
}
