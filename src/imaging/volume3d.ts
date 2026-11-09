import type { Annotation, Plane, Series, Vec3, ViewMode, ViewState, Volume } from '../model';
import { getPlaneFrame, isPaddingValue, screenMapping } from './geometry';
import { t } from '../i18n';

export interface CropBounds { min: Vec3; max: Vec3 }
export interface SurfaceHit { point: Vec3; index: Vec3; distance: number }
export const REMOVED_VALUE = -1e30;

type Matrix3 = [number, number, number, number, number, number, number, number, number];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const subtract = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const multiply = (m: Matrix3, p: Vec3): Vec3 => [m[0] * p[0] + m[1] * p[1] + m[2] * p[2], m[3] * p[0] + m[4] * p[1] + m[5] * p[2], m[6] * p[0] + m[7] * p[1] + m[8] * p[2]];

function geometry(series: Series): { forward: Matrix3; inverse: Matrix3 } {
  const d = series.direction;
  const s = series.spacing;
  if (d.length !== 9 || !d.every(Number.isFinite) || !series.origin.every(Number.isFinite)
    || !s.every(value => Number.isFinite(value) && value > 0)) {
    throw new Error(t('volume.invalidGeometry'));
  }
  const m: Matrix3 = [d[0] * s[0], d[1] * s[1], d[2] * s[2], d[3] * s[0], d[4] * s[1], d[5] * s[2], d[6] * s[0], d[7] * s[1], d[8] * s[2]];
  const determinant = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
  const norm = Math.hypot(m[0], m[3], m[6]) * Math.hypot(m[1], m[4], m[7]) * Math.hypot(m[2], m[5], m[8]);
  if (!Number.isFinite(determinant) || !Number.isFinite(norm) || norm === 0 || Math.abs(determinant) < norm * 1e-10) {
    throw new Error(t('volume.singular'));
  }
  const inverse: Matrix3 = [
    (m[4] * m[8] - m[5] * m[7]) / determinant,
    (m[2] * m[7] - m[1] * m[8]) / determinant,
    (m[1] * m[5] - m[2] * m[4]) / determinant,
    (m[5] * m[6] - m[3] * m[8]) / determinant,
    (m[0] * m[8] - m[2] * m[6]) / determinant,
    (m[2] * m[3] - m[0] * m[5]) / determinant,
    (m[3] * m[7] - m[4] * m[6]) / determinant,
    (m[1] * m[6] - m[0] * m[7]) / determinant,
    (m[0] * m[4] - m[1] * m[3]) / determinant,
  ];
  return { forward: m, inverse };
}

function validateVolume(volume: Volume, mask?: Uint8Array): void {
  if (volume.series.components === 3) throw new Error(t('volume.rgbUnsupported'));
  if (volume.sourceFrameIndex !== undefined) throw new Error(t('volume.completeVolume'));
  const dimensions = volume.series.dimensions;
  const count = dimensions[0] * dimensions[1] * dimensions[2];
  if (!dimensions.every(value => Number.isInteger(value) && value > 0)
    || !Number.isSafeInteger(count) || count > 0xffffffff || volume.data.length !== count) {
    throw new Error(t('volume.dimensionsMismatch'));
  }
  if (mask && mask.length !== count) throw new Error('The removal mask does not match the volume.');
}

function paddingFrames(volume: Volume): Array<Series | null> {
  const series = volume.series;
  const pixelType = volume.data instanceof Float32Array ? 'float32' : volume.data instanceof Float64Array ? 'float64' : series.pixelType;
  return Array.from({ length: series.dimensions[2] }, (_, frame) => {
    const range = series.frameMetadata?.[frame]?.paddingRange ?? series.paddingRange;
    if (!range) return null;
    if (!range.every(Number.isFinite)) throw new Error(t('volume.paddingRange'));
    return { ...series, pixelType, frameMetadata: undefined, paddingRange: range };
  });
}

function invalidValue(value: number, padding: Series | null): boolean {
  return !Number.isFinite(value) || (padding !== null && isPaddingValue(padding, value));
}

/** Permanent exclusions: 3 means source padding or an invalid scalar; original values stay intact. */
export function createPaddingMask(volume: Volume): Uint8Array {
  validateVolume(volume);
  const mask = new Uint8Array(volume.data.length), frames = paddingFrames(volume);
  const frameLength = volume.series.dimensions[0] * volume.series.dimensions[1];
  for (let frame = 0; frame < frames.length; frame++) {
    const padding = frames[frame], end = (frame + 1) * frameLength;
    for (let i = frame * frameLength; i < end; i++) if (invalidValue(volume.data[i], padding)) mask[i] = 3;
  }
  return mask;
}

function validateCrop(volume: Volume, crop: CropBounds): void {
  for (let axis = 0; axis < 3; axis++) {
    if (!Number.isInteger(crop.min[axis]) || !Number.isInteger(crop.max[axis])
      || crop.min[axis] < 0 || crop.max[axis] >= volume.series.dimensions[axis]
      || crop.min[axis] > crop.max[axis]) throw new Error(t('volume.cropOutside'));
  }
}

export function fullCrop(volume: Volume): CropBounds {
  validateVolume(volume);
  return { min: [0, 0, 0], max: volume.series.dimensions.map(value => value - 1) as Vec3 };
}

export function indexToPatient(series: Series, p: Vec3): Vec3 {
  if (!p.every(Number.isFinite)) throw new Error('Voxel coordinates must be finite.');
  return add(series.origin, multiply(geometry(series).forward, p));
}

export function patientToIndex(series: Series, p: Vec3): Vec3 {
  if (!p.every(Number.isFinite)) throw new Error('Patient coordinates must be finite.');
  return multiply(geometry(series).inverse, subtract(p, series.origin));
}

function sampleUnchecked(volume: Volume, p: Vec3, mask?: Uint8Array, maskValue?: number, paddingAsEmpty = false, frames = paddingFrames(volume)): number {
  const [nx, ny, nz] = volume.series.dimensions;
  const empty = paddingAsEmpty ? -Infinity : REMOVED_VALUE;
  if (!p.every(Number.isFinite) || p[0] < -0.5 || p[0] > nx - 0.5 || p[1] < -0.5 || p[1] > ny - 0.5 || p[2] < -0.5 || p[2] > nz - 0.5) return empty;
  const x = Math.max(0, Math.min(nx - 1, p[0]));
  const y = Math.max(0, Math.min(ny - 1, p[1]));
  const z = Math.max(0, Math.min(nz - 1, p[2]));
  const nearest = (Math.round(z) * ny + Math.round(y)) * nx + Math.round(x);
  const removal = mask?.[nearest];
  if (removal === 3 || invalidValue(volume.data[nearest], frames[Math.round(z)])) {
    if (paddingAsEmpty) return empty;
    throw new Error(t('volume.samplePadding'));
  }
  if (removal && (maskValue === undefined || removal === maskValue)) return empty;
  const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
  const x1 = Math.min(nx - 1, x0 + 1), y1 = Math.min(ny - 1, y0 + 1), z1 = Math.min(nz - 1, z0 + 1);
  const fx = x - x0, fy = y - y0, fz = z - z0;
  const data = volume.data;
  let weighted = 0, weightSum = 0;
  for (let iz = 0; iz < 2; iz++) for (let iy = 0; iy < 2; iy++) for (let ix = 0; ix < 2; ix++) {
    const weight = (ix ? fx : 1 - fx) * (iy ? fy : 1 - fy) * (iz ? fz : 1 - fz);
    if (weight === 0) continue;
    const frame = iz ? z1 : z0, flat = (frame * ny + (iy ? y1 : y0)) * nx + (ix ? x1 : x0);
    const value = data[flat];
    if (mask?.[flat] === 3 || invalidValue(value, frames[frame])) {
      if (paddingAsEmpty) continue;
      throw new Error(t('volume.samplePadding'));
    }
    weighted += value * weight; weightSum += weight;
  }
  if (!weightSum) return empty;
  const value = weighted / weightSum;
  if (!Number.isFinite(value)) throw new Error(t('volume.nonFinite'));
  return value;
}

/** Scalar sampling clamps to edge voxel centres within the half-voxel image boundary. */
export function sampleVolume(volume: Volume, pIndex: Vec3, mask?: Uint8Array): number {
  validateVolume(volume, mask);
  return sampleUnchecked(volume, pIndex, mask);
}

export function pickSurface(volume: Volume, rayOriginPatient: Vec3, rayDirectionPatient: Vec3,
  threshold: number, crop: CropBounds, mask?: Uint8Array, maskValue?: number): SurfaceHit | null {
  validateVolume(volume, mask);
  validateCrop(volume, crop);
  if (!Number.isFinite(threshold) || !rayOriginPatient.every(Number.isFinite) || !rayDirectionPatient.every(Number.isFinite)) throw new Error('The pick ray and threshold must be finite.');
  const length = Math.hypot(...rayDirectionPatient);
  if (length <= 1e-12) return null;
  const direction = scale(rayDirectionPatient, 1 / length);
  const frames = paddingFrames(volume);
  const { inverse } = geometry(volume.series);
  const origin = multiply(inverse, subtract(rayOriginPatient, volume.series.origin));
  const along = multiply(inverse, direction);
  let entry = 0, exit = Infinity;
  for (let axis = 0; axis < 3; axis++) {
    const low = crop.min[axis] - 0.5, high = crop.max[axis] + 0.5;
    if (Math.abs(along[axis]) < 1e-12) {
      if (origin[axis] < low || origin[axis] > high) return null;
    } else {
      const first = (low - origin[axis]) / along[axis], last = (high - origin[axis]) / along[axis];
      entry = Math.max(entry, Math.min(first, last));
      exit = Math.min(exit, Math.max(first, last));
    }
  }
  if (exit < entry || !Number.isFinite(exit)) return null;
  // Advancing at most half a voxel in every index axis also covers anisotropic/sheared grids.
  const step = 0.5 / Math.max(...along.map(Math.abs));
  const samples = Math.ceil((exit - entry) / step);
  if (samples > 65536) throw new Error('This pick ray exceeds the supported sampling range.');
  const at = (distance: number): Vec3 => add(origin, scale(along, distance));
  let previous = entry;
  for (let sample = 0; sample <= samples; sample++) {
    const distance = Math.min(exit, entry + sample * step);
    if (sampleUnchecked(volume, at(distance), mask, maskValue, true, frames) >= threshold) {
      let low = previous, high = distance;
      if (sample > 0) {
        for (let iteration = 0; iteration < 10; iteration++) {
          const middle = (low + high) * 0.5;
          if (sampleUnchecked(volume, at(middle), mask, maskValue, true, frames) >= threshold) high = middle;
          else low = middle;
        }
      }
      return { point: add(rayOriginPatient, scale(direction, high)), index: at(high), distance: high };
    }
    previous = distance;
  }
  return null;
}

export function carveSphere(volume: Volume, mask: Uint8Array, centrePatient: Vec3, radiusMm: number, crop: CropBounds): Uint32Array {
  validateVolume(volume, mask);
  validateCrop(volume, crop);
  if (!centrePatient.every(Number.isFinite) || !Number.isFinite(radiusMm) || radiusMm <= 0) throw new Error('The burr position and radius must be valid millimetres.');
  const { forward, inverse } = geometry(volume.series);
  const centre = multiply(inverse, subtract(centrePatient, volume.series.origin));
  const reach: Vec3 = [Math.hypot(inverse[0], inverse[1], inverse[2]) * radiusMm, Math.hypot(inverse[3], inverse[4], inverse[5]) * radiusMm, Math.hypot(inverse[6], inverse[7], inverse[8]) * radiusMm];
  const low = centre.map((value, axis) => Math.max(crop.min[axis], Math.ceil(value - reach[axis]))) as Vec3;
  const high = centre.map((value, axis) => Math.min(crop.max[axis], Math.floor(value + reach[axis]))) as Vec3;
  const removed: number[] = [];
  const frames = paddingFrames(volume);
  const [nx, ny] = volume.series.dimensions;
  const radiusSquared = radiusMm * radiusMm;
  for (let z = low[2]; z <= high[2]; z++) for (let y = low[1]; y <= high[1]; y++) for (let x = low[0]; x <= high[0]; x++) {
    const index = (z * ny + y) * nx + x;
    if (mask[index] || invalidValue(volume.data[index], frames[z])) continue;
    const offset = multiply(forward, [x - centre[0], y - centre[1], z - centre[2]]);
    if (dot(offset, offset) <= radiusSquared + 1e-10) {
      mask[index] = 1;
      removed.push(index);
    }
  }
  return Uint32Array.from(removed);
}

export function restoreCarve(mask: Uint8Array, indices: Uint32Array): void {
  for (const index of indices) if (index >= mask.length) throw new Error('The undo stroke is outside its removal mask.');
  for (const index of indices) if (mask[index] === 1) mask[index] = 0;
}

const CUBE: readonly Vec3[] = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
// A shared 0–6 body diagonal gives matching triangulation on adjacent cube faces.
const TETRAHEDRA = [[0, 5, 1, 6], [0, 1, 2, 6], [0, 2, 3, 6], [0, 3, 7, 6], [0, 7, 4, 6], [0, 4, 5, 6]] as const;

interface SurfaceVertex { point: Vec3; scalar: number; kept: number }
function interpolateVertex(a: SurfaceVertex, b: SurfaceVertex, fraction: number): SurfaceVertex {
  return { point: add(a.point, scale(subtract(b.point, a.point), fraction)), scalar: a.scalar + (b.scalar - a.scalar) * fraction, kept: a.kept + (b.kept - a.kept) * fraction };
}

function clipPolygon(polygon: SurfaceVertex[], field: 'scalar' | 'kept', threshold: number): SurfaceVertex[] {
  const clipped: SurfaceVertex[] = [];
  for (let index = 0; index < polygon.length; index++) {
    const a = polygon[index], b = polygon[(index + 1) % polygon.length];
    const aInside = a[field] >= threshold, bInside = b[field] >= threshold;
    if (aInside) clipped.push(a);
    if (aInside !== bInside) clipped.push(interpolateVertex(a, b, (threshold - a[field]) / (b[field] - a[field])));
  }
  return clipped;
}

function tetraContour(vertices: SurfaceVertex[], field: 'scalar' | 'kept', threshold: number): { polygon: SurfaceVertex[]; outward: Vec3 } | null {
  const inside = vertices.filter(vertex => vertex[field] >= threshold);
  const outside = vertices.filter(vertex => vertex[field] < threshold);
  if (!inside.length || !outside.length) return null;
  const mean = (points: SurfaceVertex[]): Vec3 => scale(points.reduce<Vec3>((result, vertex) => add(result, vertex.point), [0, 0, 0]), 1 / points.length);
  const outward = subtract(mean(outside), mean(inside));
  const edge = (a: SurfaceVertex, b: SurfaceVertex): SurfaceVertex => interpolateVertex(a, b, (threshold - a[field]) / (b[field] - a[field]));
  let polygon: SurfaceVertex[];
  if (inside.length === 1) polygon = outside.map(vertex => edge(inside[0], vertex));
  else if (outside.length === 1) polygon = inside.map(vertex => edge(outside[0], vertex));
  else polygon = [edge(inside[0], outside[0]), edge(inside[0], outside[1]), edge(inside[1], outside[1]), edge(inside[1], outside[0])];
  return { polygon, outward };
}

class StlWriter {
  private readonly chunks: Uint8Array[] = [];
  private chunk = new Uint8Array(50 * 16384);
  private view = new DataView(this.chunk.buffer);
  private position = 0;
  count = 0;
  private readonly maxTriangles: number;
  constructor(maxTriangles: number) { this.maxTriangles = maxTriangles; }

  triangle(a: Vec3, b: Vec3, c: Vec3, outward: Vec3): void {
    let normal = cross(subtract(b, a), subtract(c, a));
    const areaTwice = Math.hypot(...normal);
    if (areaTwice < 1e-12) return;
    if (dot(normal, outward) < 0) {
      [b, c] = [c, b];
      normal = scale(normal, -1);
    }
    if (this.count >= this.maxTriangles) throw new Error(t('volume.triangleLimit', { count: this.maxTriangles.toLocaleString() }));
    if (this.position === this.chunk.length) {
      this.chunks.push(this.chunk);
      this.chunk = new Uint8Array(50 * 16384);
      this.view = new DataView(this.chunk.buffer);
      this.position = 0;
    }
    normal = scale(normal, 1 / areaTwice);
    for (const vector of [normal, a, b, c]) for (const value of vector) {
      if (!Number.isFinite(Math.fround(value))) throw new Error(t('volume.stlRange'));
      this.view.setFloat32(this.position, value, true);
      this.position += 4;
    }
    this.view.setUint16(this.position, 0, true);
    this.position += 2;
    this.count++;
  }

  finish(): ArrayBuffer {
    const buffer = new ArrayBuffer(84 + this.count * 50);
    const bytes = new Uint8Array(buffer);
    bytes.set(new TextEncoder().encode('VEAcom isosurface; patient LPS mm; crop/padding boundaries may be open'));
    new DataView(buffer).setUint32(80, this.count, true);
    let offset = 84;
    for (const chunk of this.chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    bytes.set(this.chunk.subarray(0, this.position), offset);
    return buffer;
  }
}

function* buildSurface(volume: Volume, threshold: number, crop: CropBounds, mask: Uint8Array | undefined, maxTriangles: number): Generator<number, ArrayBuffer> {
  validateVolume(volume, mask);
  validateCrop(volume, crop);
  if (!Number.isFinite(threshold)) throw new Error('The surface threshold must be finite.');
  if (!Number.isInteger(maxTriangles) || maxTriangles < 1 || maxTriangles > 10_000_000) throw new Error('The STL triangle budget is invalid.');
  const { forward } = geometry(volume.series);
  const writer = new StlWriter(maxTriangles);
  const [nx, ny] = volume.series.dimensions;
  const frames = paddingFrames(volume);
  const width = crop.max[0] - crop.min[0], height = crop.max[1] - crop.min[1], depth = crop.max[2] - crop.min[2];
  const totalRows = height * depth;
  let rows = 0;
  if (!width || !height || !depth) return writer.finish();
  for (let z = crop.min[2]; z < crop.max[2]; z++) {
    for (let y = crop.min[1]; y < crop.max[1]; y++) {
      for (let x = crop.min[0]; x < crop.max[0]; x++) {
        const values: number[] = [], kept: number[] = [];
        let invalid = false;
        for (const p of CUBE) {
          const flat = ((z + p[2]) * ny + y + p[1]) * nx + x + p[0];
          const value = volume.data[flat];
          if (mask?.[flat] === 3 || invalidValue(value, frames[z + p[2]])) { invalid = true; break; }
          values.push(value); kept.push(mask?.[flat] ? 0 : 1);
        }
        if (invalid) continue;
        const anyInside = values.some(value => value >= threshold);
        const anyOutside = values.some(value => value < threshold);
        const anyKept = kept.some(Boolean), anyRemoved = kept.some(value => value === 0);
        if (!anyInside || !anyKept || (!anyOutside && !anyRemoved)) continue;
        const vertices = CUBE.map((p, index): SurfaceVertex => ({ point: add(volume.series.origin, multiply(forward, [x + p[0], y + p[1], z + p[2]])), scalar: values[index], kept: kept[index] }));
        for (const tetrahedron of TETRAHEDRA) {
          const points = tetrahedron.map(vertex => vertices[vertex]);
          const emit = (field: 'scalar' | 'kept', level: number, clip: 'scalar' | 'kept', clipLevel: number): void => {
            const contour = tetraContour(points, field, level);
            if (!contour) return;
            const polygon = clipPolygon(contour.polygon, clip, clipLevel);
            for (let i = 1; i + 1 < polygon.length; i++) writer.triangle(polygon[0].point, polygon[i].point, polygon[i + 1].point, contour.outward);
          };
          // Intersect the density field with a separately interpolated removal mask. The
          // mask cuts halfway between voxel centres without distorting density values.
          if (anyOutside) emit('scalar', threshold, 'kept', 0.5);
          if (anyRemoved) emit('kept', 0.5, 'scalar', threshold);
        }
      }
      rows++;
      if (rows % 8 === 0) yield rows / totalRows;
    }
  }
  return writer.finish();
}

/** Extracts the scalar isosurface in patient LPS millimetres. Crop and padding boundaries are not capped. */
export function extractStl(volume: Volume, threshold: number, crop: CropBounds, mask?: Uint8Array, maxTriangles = 2_000_000): ArrayBuffer {
  const surface = buildSurface(volume, threshold, crop, mask, maxTriangles);
  let step = surface.next();
  while (!step.done) step = surface.next();
  return step.value;
}

/** Same extraction with event-loop yields. The caller must disable edits during extraction. */
export async function extractStlAsync(volume: Volume, threshold: number, crop: CropBounds, mask?: Uint8Array,
  options: { maxTriangles?: number; signal?: AbortSignal; onProgress?: (fraction: number) => void } = {}): Promise<ArrayBuffer> {
  if (options.signal?.aborted) throw new Error(t('volume.stlCancelled'));
  options.onProgress?.(0);
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  if (options.signal?.aborted) throw new Error(t('volume.stlCancelled'));
  const surface = buildSurface(volume, threshold, crop, mask, options.maxTriangles ?? 2_000_000);
  let lastYield = performance.now();
  let step = surface.next();
  while (!step.done) {
    if (options.signal?.aborted) throw new Error(t('volume.stlCancelled'));
    if (performance.now() - lastYield >= 8) {
      options.onProgress?.(step.value);
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      lastYield = performance.now();
    }
    if (options.signal?.aborted) throw new Error(t('volume.stlCancelled'));
    step = surface.next();
  }
  options.onProgress?.(1);
  return step.value;
}

export interface VoiKey { slice: number; outline: Vec3[]; plane?: Plane; mode?: ViewMode; sourceFrame?: number }
export interface VoiSelection { plane: Plane; keys: VoiKey[]; mode?: ViewMode }
export interface VoiMask { mask: Uint8Array; crop: CropBounds; insideCount: number }
type Point2 = [number, number];
const VOI_POINTS = 128;

function voiFrame(volume: Volume, plane: Plane, mode: ViewMode = 'mpr') {
  if (volume.sourceFrameIndex !== undefined) throw new Error(t('volume.loadComplete'));
  validateVolume(volume);
  const { forward } = geometry(volume.series);
  if (!volume.series.canReconstruct) throw new Error(t('volume.noGeometry'));
  if (!['axial', 'coronal', 'sagittal'].includes(plane)) throw new Error(t('volume.choosePlane'));
  if (mode === 'mpr') return getPlaneFrame(volume.series, { plane, slice: 0, mode });
  if (plane !== 'axial') throw new Error(t('volume.sourceAxial'));
  const { series } = volume, count = series.dimensions[2];
  if (count < 2) throw new Error(t('volume.twoFrames'));
  if (series.frameMetadata && series.frameMetadata.length !== count) throw new Error(t('volume.frameGeometryIncomplete'));
  if ([series.orientationKnown, series.positionKnown, series.spacingKnown].includes(false)) throw new Error(t('volume.knownGeometry'));
  const metadata = series.frameMetadata;
  const firstOrigin = metadata?.[0].origin ?? series.origin;
  const expectedStep: Vec3 = [forward[2], forward[5], forward[8]];
  const delta = metadata ? subtract(metadata[1].origin, firstOrigin) : expectedStep;
  const frame = getPlaneFrame(series, { plane, slice: 0, mode });
  if (Math.abs(dot(frame.u, frame.v)) > 1e-5) throw new Error(t('volume.orthogonal'));
  const step = dot(delta, frame.normal);
  if (!Number.isFinite(step) || Math.abs(step) < 1e-8) throw new Error(t('volume.distinctPositions'));
  const positionTolerance = Math.max(1e-3, Math.abs(step) * 1e-3);
  if (Math.hypot(...subtract(firstOrigin, series.origin)) > positionTolerance || Math.hypot(...subtract(delta, expectedStep)) > positionTolerance) {
    throw new Error(t('volume.positionsDisagree'));
  }
  for (let index = 0; metadata && index < count; index++) {
    const source = metadata[index];
    if ([source.orientationKnown, source.positionKnown, source.spacingKnown].includes(false)) throw new Error(t('volume.frameKnownGeometry'));
    if (source.direction.length !== 9 || !source.direction.every(Number.isFinite) || !source.origin.every(Number.isFinite)
      || !source.spacing.every(value => Number.isFinite(value) && value > 0)) throw new Error(t('volume.frameGeometryInvalid'));
    if (Math.hypot(source.origin[0] - firstOrigin[0] - delta[0] * index, source.origin[1] - firstOrigin[1] - delta[1] * index,
      source.origin[2] - firstOrigin[2] - delta[2] * index) > positionTolerance) throw new Error(t('volume.equallySpaced'));
    for (const axis of [0, 1]) {
      if (Math.hypot(source.direction[axis] * source.spacing[axis] - forward[axis],
        source.direction[axis + 3] * source.spacing[axis] - forward[axis + 3],
        source.direction[axis + 6] * source.spacing[axis] - forward[axis + 6])
        > Math.max(1e-5, Math.hypot(forward[axis], forward[axis + 3], forward[axis + 6]) * 1e-5)) {
        throw new Error(t('volume.parallelAxes'));
      }
    }
  }
  return { ...frame, step, slices: count };
}

function resampleOutline(outline: Vec3[], frame: ReturnType<typeof voiFrame>, slice: number, preservePrepared = false): Vec3[] {
  if (!Number.isInteger(slice) || slice < 0 || slice >= frame.slices) throw new Error(t('volume.keySlice'));
  if (outline.length < 3 || outline.some(p => !p.every(Number.isFinite))) throw new Error(t('volume.threePoints'));
  const offset = slice * frame.step;
  if (outline.some(p => Math.abs(dot(subtract(p, frame.center), frame.normal) - offset) > Math.max(1e-4, Math.abs(frame.step) * 1e-4))) {
    throw new Error(t('volume.offPlane'));
  }
  const ring: Vec3[] = [];
  for (const p of outline) if (!ring.length || Math.hypot(...subtract(p, ring[ring.length - 1])) > 1e-9) ring.push([...p]);
  if (ring.length > 1 && Math.hypot(...subtract(ring[0], ring[ring.length - 1])) < 1e-9) ring.pop();
  if (ring.length < 3) throw new Error(t('volume.noArea'));
  let area = 0;
  const distances = [0];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const au = dot(subtract(a, frame.center), frame.u), av = dot(subtract(a, frame.center), frame.v);
    const bu = dot(subtract(b, frame.center), frame.u), bv = dot(subtract(b, frame.center), frame.v);
    area += au * bv - bu * av;
    distances.push(distances[i] + Math.hypot(...subtract(b, a)));
  }
  if (Math.abs(area) < 1e-8 || distances.at(-1)! <= 1e-8) throw new Error(t('volume.noArea'));
  if (preservePrepared && ring.length === VOI_POINTS) return ring;
  const perimeter = distances[distances.length - 1];
  let segment = 0;
  return Array.from({ length: VOI_POINTS }, (_, index) => {
    const distance = perimeter * index / VOI_POINTS;
    while (segment + 1 < ring.length && distances[segment + 1] <= distance) segment++;
    const fraction = (distance - distances[segment]) / (distances[segment + 1] - distances[segment]);
    return add(ring[segment], scale(subtract(ring[(segment + 1) % ring.length], ring[segment]), fraction));
  });
}

/** Converts an existing closed measurement into a key on the same patient-space slice. */
export function annotationToVoiKey(volume: Volume, annotation: Annotation): VoiKey {
  const mode = annotation.mode ?? 'mpr';
  if (annotation.sourceFrame !== undefined && mode !== 'source') throw new Error(t('volume.sourceMode'));
  const slice = mode === 'source' ? annotation.sourceFrame ?? annotation.slice : annotation.slice;
  const frame = voiFrame(volume, annotation.plane, mode);
  if (!['rectangle', 'ellipse', 'polygon'].includes(annotation.type)) throw new Error(t('volume.closedShape'));
  let outline = annotation.points.map(point => [...point] as Vec3);
  if (annotation.type !== 'polygon') {
    if (outline.length === 2) {
      const [a, b] = outline, delta = subtract(b, a);
      const alongU = scale(frame.u, dot(delta, frame.u)), alongV = scale(frame.v, dot(delta, frame.v));
      outline = [a, add(a, alongU), b, add(a, alongV)];
    }
    if (outline.length !== 4) throw new Error(t('volume.fourCorners'));
    const [a, b, c, d] = outline, u = subtract(b, a), v = subtract(d, a);
    const area = Math.hypot(...cross(u, v));
    if (area < 1e-8 || Math.abs(dot(u, v)) > Math.hypot(...u) * Math.hypot(...v) * 1e-4
      || Math.hypot(...subtract(add(a, add(u, v)), c)) > 1e-4) throw new Error(t('volume.invalidRectangle'));
    if (annotation.type === 'ellipse') {
      const center = scale(add(a, c), 0.5);
      outline = Array.from({ length: 96 }, (_, index) => {
        const angle = index * Math.PI * 2 / 96;
        return add(center, add(scale(u, Math.cos(angle) * 0.5), scale(v, Math.sin(angle) * 0.5)));
      });
    }
  }
  return { slice, outline: resampleOutline(outline, frame, slice), plane: annotation.plane, mode, ...(mode === 'source' ? { sourceFrame: slice } : {}) };
}

function alignOutline(reference: Vec3[], other: Vec3[]): Vec3[] {
  let bestCost = Infinity, bestShift = 0, bestDirection = 1;
  for (const direction of [1, -1]) for (let shift = 0; shift < VOI_POINTS; shift++) {
    let cost = 0;
    for (let point = 0; point < VOI_POINTS; point++) {
      const difference = subtract(reference[point], other[(shift + direction * point + VOI_POINTS) % VOI_POINTS]);
      cost += dot(difference, difference);
      if (cost >= bestCost) break;
    }
    if (cost < bestCost) { bestCost = cost; bestShift = shift; bestDirection = direction; }
  }
  return reference.map((_, point) => other[(bestShift + bestDirection * point + VOI_POINTS) % VOI_POINTS]);
}

function prepareVoi(volume: Volume, selection: VoiSelection) {
  const mode = selection.mode ?? 'mpr';
  const frame = voiFrame(volume, selection.plane, mode);
  if (!selection.keys.length) throw new Error(t('volume.drawOutline'));
  const keys = [...selection.keys].sort((a, b) => a.slice - b.slice).map(key => {
    if (key.plane && key.plane !== selection.plane) throw new Error(t('volume.samePlane'));
    if ((key.mode ?? 'mpr') !== mode) throw new Error(t('volume.mixedModes'));
    if (key.sourceFrame !== undefined && (mode !== 'source' || key.sourceFrame !== key.slice)) throw new Error(t('volume.keyFrame'));
    return { slice: key.slice, outline: resampleOutline(key.outline, frame, key.slice, true) };
  });
  for (let i = 1; i < keys.length; i++) {
    if (keys[i].slice === keys[i - 1].slice) throw new Error(t('volume.oneKey'));
    const carried = keys[i - 1].outline.map(p => add(p, scale(frame.normal, frame.step * (keys[i].slice - keys[i - 1].slice))));
    keys[i].outline = alignOutline(carried, keys[i].outline);
  }
  return { frame, keys };
}

function outlineAt(prepared: ReturnType<typeof prepareVoi>, slice: number): { outline: Vec3[]; kind: 'key' | 'between' | 'beyond' } {
  const { frame, keys } = prepared;
  const exact = keys.find(key => key.slice === slice);
  if (exact) return { outline: exact.outline.map(p => [...p]), kind: 'key' };
  const upper = keys.findIndex(key => key.slice > slice);
  if (upper > 0) {
    const low = keys[upper - 1], high = keys[upper], fraction = (slice - low.slice) / (high.slice - low.slice);
    return { outline: low.outline.map((point, i) => add(point, scale(subtract(high.outline[i], point), fraction))), kind: 'between' };
  }
  const nearest = upper === 0 ? keys[0] : keys[keys.length - 1];
  return { outline: nearest.outline.map(point => add(point, scale(frame.normal, frame.step * (slice - nearest.slice)))), kind: 'beyond' };
}

/** Beyond either end, returns a carried preview that must be confirmed as a new key. */
export function interpolateVoiOutline(volume: Volume, selection: VoiSelection, slice: number): { outline: Vec3[]; kind: 'key' | 'between' | 'beyond' } {
  const prepared = prepareVoi(volume, selection);
  if (!Number.isInteger(slice) || slice < 0 || slice >= prepared.frame.slices) throw new Error(t('volume.previewOutside'));
  return outlineAt(prepared, slice);
}

function polygonContains(polygon: Point2[], u: number, v: number): boolean {
  let inside = false;
  for (let index = 0; index < polygon.length; index++) {
    const a = polygon[index], b = polygon[(index + 1) % polygon.length];
    const du = b[0] - a[0], dv = b[1] - a[1], pu = u - a[0], pv = v - a[1];
    const lengthSquared = du * du + dv * dv;
    if (lengthSquared > 1e-16 && Math.abs(du * pv - dv * pu) <= 1e-8 && pu * du + pv * dv >= -1e-8 && pu * du + pv * dv <= lengthSquared + 1e-8) return true;
    if ((a[1] > v) !== (b[1] > v) && u < a[0] + (v - a[1]) * du / dv) inside = !inside;
  }
  return inside;
}

function* buildVoi(volume: Volume, selection: VoiSelection): Generator<number, VoiMask> {
  const prepared = prepareVoi(volume, selection), { keys, frame } = prepared;
  if (keys.length < 2) throw new Error(t('volume.secondSlice'));
  const { forward, inverse } = geometry(volume.series), dimensions = volume.series.dimensions;
  const low: Vec3 = [Infinity, Infinity, Infinity], high: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const key of keys) for (const point of key.outline) {
    const index = multiply(inverse, subtract(point, volume.series.origin));
    for (let axis = 0; axis < 3; axis++) { low[axis] = Math.min(low[axis], index[axis]); high[axis] = Math.max(high[axis], index[axis]); }
  }
  for (let axis = 0; axis < 3; axis++) {
    low[axis] = Math.max(0, Math.ceil(low[axis] - 1e-6));
    high[axis] = Math.min(dimensions[axis] - 1, Math.floor(high[axis] + 1e-6));
  }
  if (low.some((value, axis) => value > high[axis])) throw new Error(t('volume.noVoxels'));
  const projected = keys.map(key => ({ slice: key.slice, outline: key.outline.map(point => [dot(point, frame.u), dot(point, frame.v)] as Point2) }));
  const first = keys[0].slice, last = keys[keys.length - 1].slice;
  const polygonAt = (slice: number): Point2[] | null => {
    if (slice < first - 1e-6 || slice > last + 1e-6) return null;
    slice = Math.max(first, Math.min(last, slice));
    let upper = projected.findIndex(key => key.slice >= slice);
    if (upper < 0) upper = projected.length - 1;
    if (upper === 0 || projected[upper].slice === slice) return projected[upper].outline;
    const a = projected[upper - 1], b = projected[upper], fraction = (slice - a.slice) / (b.slice - a.slice);
    return a.outline.map((point, i) => [point[0] + (b.outline[i][0] - point[0]) * fraction, point[1] + (b.outline[i][1] - point[1]) * fraction]);
  };
  const columns: Vec3[] = [[forward[0], forward[3], forward[6]], [forward[1], forward[4], forward[7]], [forward[2], forward[5], forward[8]]];
  const sliceSteps = columns.map(column => dot(column, frame.normal) / frame.step);
  const scanAxis = [0, 1, 2].filter(axis => Math.abs(sliceSteps[axis]) < 1e-10).sort((a, b) => (high[b] - low[b]) - (high[a] - low[a]))[0] ?? 0;
  const otherAxes = [0, 1, 2].filter(axis => axis !== scanAxis);
  const canScan = Math.abs(sliceSteps[scanAxis]) < 1e-10;
  const mask = createPaddingMask(volume);
  for (let i = 0; i < mask.length; i++) if (mask[i] === 0) mask[i] = 1;
  const crop: CropBounds = { min: [...dimensions], max: [-1, -1, -1] };
  let insideCount = 0, rows = 0;
  const mark = (index: Vec3): void => {
    const flat = (index[2] * dimensions[1] + index[1]) * dimensions[0] + index[0];
    if (mask[flat] !== 1) return;
    mask[flat] = 0; insideCount++;
    for (let axis = 0; axis < 3; axis++) { crop.min[axis] = Math.min(crop.min[axis], index[axis]); crop.max[axis] = Math.max(crop.max[axis], index[axis]); }
  };
  const totalRows = (high[otherAxes[0]] - low[otherAxes[0]] + 1) * (high[otherAxes[1]] - low[otherAxes[1]] + 1);
  for (let outer = low[otherAxes[1]]; outer <= high[otherAxes[1]]; outer++) for (let inner = low[otherAxes[0]]; inner <= high[otherAxes[0]]; inner++) {
    const index: Vec3 = [0, 0, 0]; index[otherAxes[0]] = inner; index[otherAxes[1]] = outer;
    const base = add(volume.series.origin, multiply(forward, index));
    const slice = dot(subtract(base, frame.center), frame.normal) / frame.step;
    const u = dot(base, frame.u), v = dot(base, frame.v);
    const du = dot(columns[scanAxis], frame.u), dv = dot(columns[scanAxis], frame.v);
    if (canScan) {
      const polygon = polygonAt(slice);
      if (polygon) {
        const lengthSquared = du * du + dv * dv;
        const position = (point: Point2): number => ((point[0] - u) * du + (point[1] - v) * dv) / lengthSquared;
        const crossings: number[] = [], intervals: Point2[] = [];
        for (let edge = 0; edge < polygon.length; edge++) {
          const a = polygon[edge], b = polygon[(edge + 1) % polygon.length];
          const sideA = du * (a[1] - v) - dv * (a[0] - u), sideB = du * (b[1] - v) - dv * (b[0] - u);
          if (Math.abs(sideA) < 1e-8) intervals.push([position(a), position(a)]);
          if (Math.abs(sideA) < 1e-8 && Math.abs(sideB) < 1e-8) intervals.push([Math.min(position(a), position(b)), Math.max(position(a), position(b))]);
          else if ((sideA > 0) !== (sideB > 0)) {
            const fraction = sideA / (sideA - sideB);
            crossings.push(position([a[0] + (b[0] - a[0]) * fraction, a[1] + (b[1] - a[1]) * fraction]));
          }
        }
        crossings.sort((a, b) => a - b);
        for (let i = 0; i + 1 < crossings.length; i += 2) intervals.push([crossings[i], crossings[i + 1]]);
        for (const [start, end] of intervals) for (let along = Math.max(low[scanAxis], Math.ceil(start - 1e-7)); along <= Math.min(high[scanAxis], Math.floor(end + 1e-7)); along++) {
          index[scanAxis] = along; mark(index);
        }
      }
    } else {
      for (let along = low[scanAxis]; along <= high[scanAxis]; along++) {
        const polygon = polygonAt(slice + sliceSteps[scanAxis] * along);
        if (polygon && polygonContains(polygon, u + du * along, v + dv * along)) { index[scanAxis] = along; mark(index); }
      }
    }
    rows++;
    if (rows % (canScan ? 16 : 2) === 0) yield rows / totalRows;
  }
  if (!insideCount) throw new Error(t('volume.noVoxels'));
  return { mask, crop, insideCount };
}

export function buildVoiMask(volume: Volume, selection: VoiSelection): VoiMask {
  const operation = buildVoi(volume, selection);
  let step = operation.next();
  while (!step.done) step = operation.next();
  return step.value;
}

export async function buildVoiMaskAsync(volume: Volume, selection: VoiSelection,
  options: { signal?: AbortSignal; onProgress?: (fraction: number) => void } = {}): Promise<VoiMask> {
  if (options.signal?.aborted) throw new Error(t('volume.selectionCancelled'));
  options.onProgress?.(0);
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  const operation = buildVoi(volume, selection);
  let lastYield = performance.now();
  let step: IteratorResult<number, VoiMask>;
  do {
    if (options.signal?.aborted) throw new Error(t('volume.selectionCancelled'));
    step = operation.next();
    if (!step.done && performance.now() - lastYield >= 8) {
      options.onProgress?.(step.value);
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      lastYield = performance.now();
    }
  } while (!step.done);
  options.onProgress?.(1);
  return step.value;
}

function* buildVisibleRegion(volume: Volume, view: ViewState, size: [number, number]): Generator<number, VoiMask> {
  voiFrame(volume, view.plane, view.mode);
  if (!size.every(value => Number.isFinite(value) && value > 0)) throw new Error(t('volume.viewportSize'));
  const mapping = screenMapping(volume.series, view, size[0], size[1]);
  if (![...mapping.center, ...mapping.right, ...mapping.down, ...mapping.pan, mapping.pixelsPerMm].every(Number.isFinite)) throw new Error(t('volume.viewportTransform'));
  const { forward } = geometry(volume.series), [nx, ny, nz] = volume.series.dimensions;
  const columns: Vec3[] = [[forward[0], forward[3], forward[6]], [forward[1], forward[4], forward[7]], [forward[2], forward[5], forward[8]]];
  const originOffset = subtract(volume.series.origin, mapping.center);
  const pixelOrigin = [mapping.width / 2 + mapping.pan[0] + dot(originOffset, mapping.right) * mapping.pixelsPerMm,
    mapping.height / 2 + mapping.pan[1] + dot(originOffset, mapping.down) * mapping.pixelsPerMm];
  const pixelSteps = columns.map(column => [dot(column, mapping.right) * mapping.pixelsPerMm, dot(column, mapping.down) * mapping.pixelsPerMm]);
  const mask = createPaddingMask(volume), hasPadding = mask.includes(3);
  if (hasPadding) { for (let i = 0; i < mask.length; i++) if (mask[i] === 0) mask[i] = 1; }
  else mask.fill(1);
  const crop: CropBounds = { min: [nx, ny, nz], max: [-1, -1, -1] };
  let insideCount = 0, rows = 0;
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) {
    let first = 0, last = nx - 1;
    for (let axis = 0; axis < 2; axis++) {
      const base = pixelOrigin[axis] + y * pixelSteps[1][axis] + z * pixelSteps[2][axis];
      const slope = pixelSteps[0][axis];
      if (Math.abs(slope) < 1e-12) {
        if (base < -1e-7 || base > size[axis] + 1e-7) { first = 1; last = 0; break; }
      } else {
        const a = -base / slope, b = (size[axis] - base) / slope;
        first = Math.max(first, Math.min(a, b));
        last = Math.min(last, Math.max(a, b));
      }
    }
    const low = Math.max(0, Math.ceil(first - 1e-7)), high = Math.min(nx - 1, Math.floor(last + 1e-7));
    if (low <= high) {
      const row = (z * ny + y) * nx;
      let firstKept = low, lastKept = high;
      if (hasPadding) {
        firstKept = nx; lastKept = -1;
        for (let x = low; x <= high; x++) {
          if (mask[row + x] === 3) continue;
          mask[row + x] = 0; insideCount++;
          firstKept = Math.min(firstKept, x); lastKept = x;
        }
      } else {
        mask.fill(0, row + low, row + high + 1);
        insideCount += high - low + 1;
      }
      if (lastKept >= firstKept) {
        crop.min = [Math.min(crop.min[0], firstKept), Math.min(crop.min[1], y), Math.min(crop.min[2], z)];
        crop.max = [Math.max(crop.max[0], lastKept), Math.max(crop.max[1], y), Math.max(crop.max[2], z)];
      }
    }
    rows++;
    if (rows % 16 === 0) yield rows / (ny * nz);
  }
  if (!insideCount) throw new Error(t('volume.visibleEmpty'));
  return { mask, crop, insideCount };
}

/** Selects all depth beneath the current screen rectangle, including oblique views. */
export async function buildVisibleRegionMaskAsync(volume: Volume, view: ViewState, size: [number, number],
  options: { signal?: AbortSignal; onProgress?: (fraction: number) => void } = {}): Promise<VoiMask> {
  if (options.signal?.aborted) throw new Error(t('volume.visibleCancelled'));
  options.onProgress?.(0);
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  const operation = buildVisibleRegion(volume, view, size);
  let lastYield = performance.now();
  let step: IteratorResult<number, VoiMask>;
  do {
    if (options.signal?.aborted) throw new Error(t('volume.visibleCancelled'));
    step = operation.next();
    if (!step.done && performance.now() - lastYield >= 8) {
      options.onProgress?.(step.value);
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      lastYield = performance.now();
    }
  } while (!step.done);
  options.onProgress?.(1);
  return step.value;
}
