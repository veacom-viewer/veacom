import type { Plane, Series, Vec3, ViewState, Volume } from '../model';
import { usesSourceFrames } from './viewState';
import { t } from '../i18n';

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const length = (a: Vec3): number => Math.hypot(...a);
export function normalize(a: Vec3): Vec3 { const n = length(a); if (n < 1e-12) throw new Error('Degenerate coordinate direction'); return scale(a, 1 / n); }
export const clamp = (n: number, a: number, b: number): number => Math.min(b, Math.max(a, n));

function multiply(m: number[], p: Vec3): Vec3 {
  return [m[0] * p[0] + m[1] * p[1] + m[2] * p[2], m[3] * p[0] + m[4] * p[1] + m[5] * p[2], m[6] * p[0] + m[7] * p[1] + m[8] * p[2]];
}

export function inverse3(m: number[]): number[] {
  const [a, b, c, d, e, f, g, h, i] = m;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-10) throw new Error(t('geometry.nonInvertible'));
  return [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det,
    (f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det,
    (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det];
}

export function indexToWorld(series: Series, index: Vec3): Vec3 {
  return add(series.origin, multiply(series.direction, index.map((n, i) => n * series.spacing[i]) as Vec3));
}

const sourceFrameCache = new WeakMap<Series, Map<number, Series>>();
export function sourceFrameSeries(series: Series, frame: number): Series {
  const index = Math.round(clamp(frame, 0, series.dimensions[2] - 1));
  let cached = sourceFrameCache.get(series);
  if (!cached) { cached = new Map(); sourceFrameCache.set(series, cached); }
  const previous = cached.get(index); if (previous) return previous;
  const metadata = series.frameMetadata?.[index];
  const result: Series = { ...series, ...metadata, dimensions: [series.dimensions[0], series.dimensions[1], 1],
    origin: metadata?.origin ?? indexToWorld(series, [0, 0, index]),
    direction: metadata?.direction ?? series.direction, spacing: metadata?.spacing ?? series.spacing,
    windowCenter: metadata?.windowCenter ?? series.windowCenter, windowWidth: metadata?.windowWidth ?? series.windowWidth,
    paddingRange: metadata?.paddingRange ?? series.paddingRange, frameMetadata: undefined,
    canReconstruct: false, sourceFramesOnly: true };
  if (cached.size >= 64) cached.delete(cached.keys().next().value!);
  cached.set(index, result); return result;
}

export function isPaddingValue(series: Series, value: number, sourceFrame?: number): boolean {
  const metadata = sourceFrame === undefined ? undefined : series.frameMetadata?.[sourceFrame];
  if (Number.isNaN(value) && (metadata?.paddingIsNaN ?? series.paddingIsNaN)) return true;
  const range = metadata?.paddingRange ?? series.paddingRange;
  if (!range) return false;
  const first = series.pixelType === 'float32' ? Math.fround(range[0]) : range[0];
  const second = series.pixelType === 'float32' ? Math.fround(range[1]) : range[1];
  return value >= Math.min(first, second) && value <= Math.max(first, second);
}

const inverseCache = new WeakMap<Series, number[]>();
export function worldToIndexMatrix(series: Series): number[] {
  let inverse = inverseCache.get(series);
  if (!inverse) {
    if (series.spacing.some(s => !Number.isFinite(s) || s <= 0)) throw new Error(t('geometry.invalidSpacing'));
    inverse = inverse3(series.direction).map((n, i) => n / series.spacing[Math.floor(i / 3)]);
    inverseCache.set(series, inverse);
  }
  return inverse;
}

export function worldToIndex(series: Series, world: Vec3): Vec3 {
  return multiply(worldToIndexMatrix(series), sub(world, series.origin));
}

export function sampleVolume(volume: Volume, world: Vec3, interpolate = false): number | null {
  if (volume.series.components === 3) return null;
  const geometry = volume.sourceFrameIndex === undefined ? volume.series : sourceFrameSeries(volume.series, volume.sourceFrameIndex);
  const p = worldToIndex(geometry, world), d = geometry.dimensions;
  if (p.some((n, i) => n < -0.500001 || n > d[i] - 0.499999)) return null;
  const at = (x: number, y: number, z: number) => volume.data[(clamp(z, 0, d[2] - 1) * d[1] + clamp(y, 0, d[1] - 1)) * d[0] + clamp(x, 0, d[0] - 1)];
  const nearest = at(Math.round(p[0]), Math.round(p[1]), Math.round(p[2]));
  const padding = (value: number, z: number) => isPaddingValue(volume.series, value, volume.sourceFrameIndex ?? clamp(z, 0, d[2] - 1));
  if (padding(nearest, Math.round(p[2]))) return NaN;
  if (!interpolate) return nearest;
  if (!Number.isFinite(nearest)) return NaN;
  const a = p.map(Math.floor), t = p.map((n, i) => n - a[i]);
  let result = 0, totalWeight = 0;
  for (let z = 0; z < 2; z++) for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
    const weight = (x ? t[0] : 1 - t[0]) * (y ? t[1] : 1 - t[1]) * (z ? t[2] : 1 - t[2]);
    if (weight <= 0) continue;
    const value = at(a[0] + x, a[1] + y, a[2] + z);
    if (Number.isFinite(value) && !padding(value, a[2] + z)) { result += value * weight; totalWeight += weight; }
  }
  return totalWeight > 0 ? result / totalWeight : NaN;
}

export interface PlaneFrame {
  center: Vec3; u: Vec3; v: Vec3; normal: Vec3;
  widthMm: number; heightMm: number; step: number; slices: number;
  minNormal: number;
}

export type PlaneSelection = Plane | Pick<ViewState, 'plane' | 'mode' | 'oblique' | 'projection'>;
const selectionView = (selection: PlaneSelection): Pick<ViewState, 'plane' | 'mode' | 'oblique' | 'projection'> => typeof selection === 'string' ? { plane: selection } : selection;

/** A whole-volume projection turns about the patient's long axis in this many steps (10° each): its slice is the step. */
export const PROJECTION_STEPS = 36;
/** The turn of a projection at `slice`, in degrees (0 seen from the front). */
export const projectionAngle = (slice: number) => ((Math.round(slice) % PROJECTION_STEPS + PROJECTION_STEPS) % PROJECTION_STEPS) * (360 / PROJECTION_STEPS);
/** A view showing a whole-volume projection: only a reconstructed volume has one (a loading series shows its acquired
 * preview frame instead). */
export const isProjection = (series: Series, view: Pick<ViewState, 'mode' | 'projection'>) => view.projection !== undefined && !usesSourceFrames(series, view);
/** The plane a projection is drawn on: coronal through the volume's centre, turned about the long axis by its angle.
 * Its slab reaches the whole volume either side (slab.projectionSampling). */
export function projectionPlane(series: Series, view: Pick<ViewState, 'slice'>): Pick<ViewState, 'plane' | 'mode' | 'oblique' | 'slice'> {
  const turned = { plane: 'coronal' as const, mode: 'mpr' as const, oblique: [0, projectionAngle(view.slice)] as [number, number] };
  return { ...turned, slice: (extent(series, turned).slices - 1) / 2 };
}

export function planeAxes(series: Series, selection: PlaneSelection): { u: Vec3; v: Vec3; normal: Vec3 } {
  const view = selectionView(selection), plane = view.plane;
  if (usesSourceFrames(series, view)) {
    const m = series.direction;
    const u = normalize([m[0], m[3], m[6]]), v = normalize([m[1], m[4], m[7]]);
    return { u, v, normal: normalize(cross(u, v)) };
  }
  const u: Vec3 = plane === 'sagittal' ? [0, 1, 0] : [1, 0, 0];
  const v: Vec3 = plane === 'axial' ? [0, 1, 0] : [0, 0, -1];
  let along = u, down = v, normal = cross(u, v);
  if (view.oblique) {
    down = rotateAround(down, along, view.oblique[0]); normal = rotateAround(normal, along, view.oblique[0]);
    along = rotateAround(along, down, view.oblique[1]); normal = rotateAround(normal, down, view.oblique[1]);
  }
  return { u: along, v: down, normal };
}

function corners(series: Series, edges: boolean): Vec3[] {
  const low = edges ? -0.5 : 0, result: Vec3[] = [];
  for (let z = 0; z < 2; z++) for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
    result.push(indexToWorld(series, [x ? series.dimensions[0] - 1 - low : low,
      y ? series.dimensions[1] - 1 - low : low, z ? series.dimensions[2] - 1 - low : low]));
  }
  return result;
}

interface PlaneExtent { widthMm: number; heightMm: number; step: number; slices: number; minNormal: number; center: Vec3; }
const extentCache = new WeakMap<Series, Map<string, PlaneExtent>>();
function extent(series: Series, selection: PlaneSelection): PlaneExtent {
  const view = selectionView(selection);
  const key = `${view.plane}:${view.oblique?.[0] ?? 0}:${view.oblique?.[1] ?? 0}`;
  let perPlane = extentCache.get(series);
  if (!perPlane) { perPlane = new Map(); extentCache.set(series, perPlane); }
  const cached = perPlane.get(key); if (cached) return cached;
  const { u, v, normal } = planeAxes(series, view);
  const edges = corners(series, true), centers = corners(series, false);
  const range = (axis: Vec3, points: Vec3[]) => { const values = points.map(p => dot(p, axis)); return [Math.min(...values), Math.max(...values)]; };
  const ru = range(u, edges), rv = range(v, edges), rn = range(normal, centers);
  const nominalStep = 1 / length(multiply(worldToIndexMatrix(series), normal));
  const slices = Math.max(1, Math.ceil((rn[1] - rn[0]) / nominalStep - 1e-7) + 1);
  const step = slices > 1 ? (rn[1] - rn[0]) / (slices - 1) : nominalStep;
  const e = { widthMm: ru[1] - ru[0], heightMm: rv[1] - rv[0], step, slices, minNormal: rn[0],
    center: add(add(scale(u, (ru[0] + ru[1]) / 2), scale(v, (rv[0] + rv[1]) / 2)), scale(normal, rn[0])) };
  if (perPlane.size >= 128) perPlane.delete(perPlane.keys().next().value!);
  perPlane.set(key, e); return e;
}

export function sliceCount(series: Series, selection: PlaneSelection): number {
  const view = selectionView(selection);
  if (isProjection(series, view)) return PROJECTION_STEPS;
  return usesSourceFrames(series, view) ? series.dimensions[2] : extent(series, selection).slices;
}
/** The slice `delta` steps on: held at the ends of a plane, round and round through a projection's turns. */
export function stepSlice(series: Series, view: Pick<ViewState, 'plane' | 'mode' | 'oblique' | 'projection' | 'slice'>, delta: number): number {
  const count = sliceCount(series, view);
  if (isProjection(series, view)) return ((Math.round(view.slice) + Math.round(delta)) % count + count) % count;
  return clamp(view.slice + delta, 0, count - 1);
}
/** The slice of a plane through `point`. A projection holds every point at every turn: it keeps the front view. */
export function sliceAtWorld(series: Series, selection: PlaneSelection, point: Vec3): number {
  if (isProjection(series, selectionView(selection))) return 0;
  if (usesSourceFrames(series, selectionView(selection))) {
    if (!series.frameMetadata?.length) return Math.round(clamp(worldToIndex(series, point)[2], 0, series.dimensions[2] - 1));
    let nearest = 0, distance = Infinity;
    for (let i = 0; i < series.dimensions[2]; i++) {
      const metadata = series.frameMetadata[i], origin = metadata?.origin ?? indexToWorld(series, [0, 0, i]);
      const m = metadata?.direction ?? series.direction;
      const nx = m[3] * m[7] - m[6] * m[4], ny = m[6] * m[1] - m[0] * m[7], nz = m[0] * m[4] - m[3] * m[1];
      const magnitude = Math.hypot(nx, ny, nz); if (magnitude < 1e-10) continue;
      const candidate = Math.abs((point[0] - origin[0]) * nx + (point[1] - origin[1]) * ny + (point[2] - origin[2]) * nz) / magnitude;
      if (candidate < distance) { nearest = i; distance = candidate; }
    }
    return nearest;
  }
  const e = extent(series, selection), { normal } = planeAxes(series, selection);
  return Math.round(clamp((dot(point, normal) - e.minNormal) / e.step, 0, e.slices - 1));
}

function rotateAround(vector: Vec3, axis: Vec3, degrees: number): Vec3 {
  const radians = degrees * Math.PI / 180, c = Math.cos(radians), s = Math.sin(radians);
  return add(add(scale(vector, c), scale(cross(axis, vector), s)), scale(axis, dot(axis, vector) * (1 - c)));
}

export function getPlaneFrame(series: Series, view: Pick<ViewState, 'plane' | 'slice' | 'oblique' | 'mode' | 'projection'>): PlaneFrame {
  if (isProjection(series, view)) return getPlaneFrame(series, projectionPlane(series, view));
  if (usesSourceFrames(series, view)) {
    const slice = Math.round(clamp(view.slice, 0, series.dimensions[2] - 1)), frame = sourceFrameSeries(series, slice);
    const { u, v, normal } = planeAxes(frame, 'axial');
    const center = indexToWorld(frame, [(frame.dimensions[0] - 1) / 2, (frame.dimensions[1] - 1) / 2, 0]);
    return { center, u, v, normal, widthMm: frame.dimensions[0] * frame.spacing[0], heightMm: frame.dimensions[1] * frame.spacing[1],
      step: frame.spacing[2], slices: series.dimensions[2], minNormal: dot(frame.origin, normal) };
  }
  const e = extent(series, view), { u, v, normal } = planeAxes(series, view);
  return { ...e, center: add(e.center, scale(normal, clamp(view.slice, 0, e.slices - 1) * e.step)), u, v, normal };
}

export interface ScreenMapping { center: Vec3; right: Vec3; down: Vec3; pixelsPerMm: number; width: number; height: number; pan: [number, number]; }
export function screenMapping(series: Series, view: ViewState, width: number, height: number): ScreenMapping {
  const frame = getPlaneFrame(series, view), angle = view.rotation * Math.PI / 180;
  const c = Math.cos(angle), s = Math.sin(angle);
  const pixelsPerMm = Math.max(1e-8, Math.min(width / frame.widthMm, height / frame.heightMm) * Math.max(0.01, view.zoom));
  // Inverse of the displayed in-plane rotation. Positive view rotation turns the image clockwise.
  const right = scale(add(scale(frame.u, c), scale(frame.v, -s)), view.flipX ? -1 : 1);
  const down = scale(add(scale(frame.u, s), scale(frame.v, c)), view.flipY ? -1 : 1);
  return { center: frame.center, right, down, pixelsPerMm, width, height, pan: view.pan };
}

export function screenToWorld(mapping: ScreenMapping, x: number, y: number): Vec3 {
  return add(mapping.center, add(scale(mapping.right, (x - mapping.width / 2 - mapping.pan[0]) / mapping.pixelsPerMm),
    scale(mapping.down, (y - mapping.height / 2 - mapping.pan[1]) / mapping.pixelsPerMm)));
}

export function worldToScreen(mapping: ScreenMapping, world: Vec3): [number, number] {
  const p = sub(world, mapping.center);
  return [mapping.width / 2 + mapping.pan[0] + dot(p, mapping.right) * mapping.pixelsPerMm,
    mapping.height / 2 + mapping.pan[1] + dot(p, mapping.down) * mapping.pixelsPerMm];
}

/** The patient directions a screen direction points to, the main one first. Another letter follows only when the
 * direction leans more than 30° towards it (a truly oblique plane): a CT taken with gantry tilt reads A and P, not AI
 * and PS. */
export function orientationLabel(direction: Vec3): string {
  return direction.map((value, axis) => ({ value, axis })).sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
    .filter((x, index) => Math.abs(x.value) > (index === 0 ? 0.2 : 0.5)).map(({ value, axis }) => [['R', 'L'], ['A', 'P'], ['I', 'S']][axis][value >= 0 ? 1 : 0]).join('');
}

/** The point closest to the patient-space origin and a unit direction along both planes. */
/** Whether two planes face the same way: their normals lie closest to the same patient axis (both axial,
 * both coronal, both sagittal), however many degrees apart. */
export function sameFacing(first: Vec3, second: Vec3): boolean {
  const axis = (normal: Vec3) => { const size = normal.map(Math.abs); return size.indexOf(Math.max(...size)); };
  return first.every(Number.isFinite) && second.every(Number.isFinite) && axis(first) === axis(second);
}

/** The plane a series was acquired in, from its slice normal: the patient axis it lies closest to. */
export function acquiredPlane(series: Series): Plane | null {
  const normal = [series.direction[2], series.direction[5], series.direction[8]].map(Math.abs);
  if (!normal.every(Number.isFinite) || Math.max(...normal) === 0) return null;
  return (['sagittal', 'coronal', 'axial'] as const)[normal.indexOf(Math.max(...normal))];
}

export function planeIntersection(first: PlaneFrame, second: PlaneFrame): { point: Vec3; direction: Vec3 } | null {
  if (![first.center, second.center, first.normal, second.normal].every(v => v.every(Number.isFinite))) return null;
  const firstLength = length(first.normal), secondLength = length(second.normal);
  if (firstLength < 1e-12 || secondLength < 1e-12) return null;
  const n1 = scale(first.normal, 1 / firstLength), n2 = scale(second.normal, 1 / secondLength);
  const along = cross(n1, n2), magnitude = length(along);
  if (magnitude < 1e-8) return null;
  const d1 = dot(n1, first.center), d2 = dot(n2, second.center);
  const point = scale(add(scale(cross(n2, along), d1), scale(cross(along, n1), d2)), 1 / (magnitude * magnitude));
  return point.every(Number.isFinite) ? { point, direction: scale(along, 1 / magnitude) } : null;
}

/** The common part of the two image rectangles along their line of intersection. */
export function referenceSegment(first: PlaneFrame, second: PlaneFrame): [Vec3, Vec3] | null {
  const line = planeIntersection(first, second);
  if (!line || sameFacing(first.normal, second.normal)) return null;
  let low = -Infinity, high = Infinity;
  for (const frame of [first, second]) {
    const offset = sub(line.point, frame.center);
    for (const [axis, half] of [[frame.u, frame.widthMm / 2], [frame.v, frame.heightMm / 2]] as const) {
      const origin = dot(offset, axis), step = dot(line.direction, axis);
      if (Math.abs(step) < 1e-10) {
        if (Math.abs(origin) > half) return null;
      } else {
        const a = (-half - origin) / step, b = (half - origin) / step;
        low = Math.max(low, Math.min(a, b)); high = Math.min(high, Math.max(a, b));
      }
    }
  }
  return low < high ? [add(line.point, scale(line.direction, low)), add(line.point, scale(line.direction, high))] : null;
}

export interface WindowPlane { origin: Vec3; right: Vec3; down: Vec3; columns: number; rows: number }

/** Pixel centres covering the displayed MPR plane, independent of viewport zoom, pan and screen resolution. */
export function windowPlane(series: Series, view: ViewState): WindowPlane {
  const { center, u, v, widthMm, heightMm } = getPlaneFrame(series, view);
  const inverse = worldToIndexMatrix(series);
  const columns = Math.max(1, Math.ceil(widthMm * length(multiply(inverse, u)) - 1e-7));
  const rows = Math.max(1, Math.ceil(heightMm * length(multiply(inverse, v)) - 1e-7));
  const right = scale(u, widthMm / columns), down = scale(v, heightMm / rows);
  const origin = sub(sub(center, scale(right, (columns - 1) / 2)), scale(down, (rows - 1) / 2));
  return { origin, right, down, columns, rows };
}

/** A bounded, deterministic 1st–99th percentile window, excluding DICOM padding. */
export function autoWindow(volume: Volume, sourceFrame?: number): { windowCenter: number; windowWidth: number } | null {
  if (volume.series.components === 3 || volume.data.length === 0) return null;
  const frameLength = volume.series.dimensions[0] * volume.series.dimensions[1];
  const selectedFrame = sourceFrame ?? volume.sourceFrameIndex;
  if (selectedFrame !== undefined && (!Number.isInteger(selectedFrame) || selectedFrame < 0 || selectedFrame >= volume.series.dimensions[2]
    || (volume.sourceFrameIndex !== undefined && selectedFrame !== volume.sourceFrameIndex))) return null;
  const offset = selectedFrame === undefined || volume.sourceFrameIndex !== undefined ? 0 : selectedFrame * frameLength;
  const available = selectedFrame === undefined ? volume.data.length : frameLength;
  if (offset + available > volume.data.length) return null;
  const sampleCount = Math.min(65_536, available);
  const samples = new Float64Array(sampleCount);
  let finiteCount = 0;
  for (let i = 0; i < sampleCount; i++) {
    const index = offset + (sampleCount === 1 ? 0 : Math.floor(i * (available - 1) / (sampleCount - 1)));
    const value = volume.data[index];
    const frame = volume.sourceFrameIndex ?? Math.floor(index / frameLength);
    if (Number.isFinite(value) && !isPaddingValue(volume.series, value, frame)) samples[finiteCount++] = value;
  }
  if (!finiteCount) return null;
  const sorted = samples.subarray(0, finiteCount).sort();
  const percentile = (fraction: number) => {
    const index = (finiteCount - 1) * fraction, lower = Math.floor(index), upper = Math.ceil(index);
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
  };
  const low = percentile(0.01), high = percentile(0.99);
  return { windowCenter: (low + high) / 2, windowWidth: Math.max(1, high - low) };
}

/** The slice's whole value range, its padding left out (key 1, VEAcom 1.x's full range); a reconstruction
 * takes the volume's. */
export function fullRangeWindow(volume: Volume, sourceFrame?: number): { windowCenter: number; windowWidth: number } | null {
  if (volume.series.components === 3 || volume.data.length === 0) return null;
  const frameLength = volume.series.dimensions[0] * volume.series.dimensions[1];
  const selectedFrame = sourceFrame ?? volume.sourceFrameIndex;
  if (selectedFrame !== undefined && (!Number.isInteger(selectedFrame) || selectedFrame < 0 || selectedFrame >= volume.series.dimensions[2]
    || (volume.sourceFrameIndex !== undefined && selectedFrame !== volume.sourceFrameIndex))) return null;
  const offset = selectedFrame === undefined || volume.sourceFrameIndex !== undefined ? 0 : selectedFrame * frameLength;
  const available = selectedFrame === undefined ? volume.data.length : frameLength;
  if (offset + available > volume.data.length) return null;
  let low = Infinity, high = -Infinity;
  for (let index = offset; index < offset + available; index++) {
    const value = volume.data[index];
    if (!Number.isFinite(value) || isPaddingValue(volume.series, value, volume.sourceFrameIndex ?? Math.floor(index / frameLength))) continue;
    if (value < low) low = value;
    if (value > high) high = value;
  }
  return low > high ? null : { windowCenter: (low + high) / 2, windowWidth: Math.max(1, high - low) };
}

function segmentDistanceSquared(point: Vec3, start: Vec3, end: Vec3): number {
  const dx = end[0] - start[0], dy = end[1] - start[1], dz = end[2] - start[2];
  const px = point[0] - start[0], py = point[1] - start[1], pz = point[2] - start[2];
  const denominator = dx * dx + dy * dy + dz * dz;
  const t = denominator > 0 ? clamp((px * dx + py * dy + pz * dz) / denominator, 0, 1) : 0;
  return (px - t * dx) ** 2 + (py - t * dy) ** 2 + (pz - t * dz) ** 2;
}

/** Ramer–Douglas–Peucker simplification in the input coordinate units, without mutating the path. */
export function simplifyPolyline(points: Vec3[], tolerance: number): Vec3[] {
  if (points.length <= 2 || !Number.isFinite(tolerance) || tolerance < 0 || points.some(point => point.some(n => !Number.isFinite(n)))) return points.slice();
  const last = points.length - 1, keep = new Uint8Array(points.length);
  const anchors = [0, last];
  const closed = points[0].every((coordinate, axis) => coordinate === points[last][axis]);
  if (closed) {
    let farthest = 0, distance = 0;
    for (let i = 1; i < last; i++) {
      const candidate = segmentDistanceSquared(points[i], points[0], points[0]);
      if (candidate > distance) { distance = candidate; farthest = i; }
    }
    if (farthest) {
      anchors.push(farthest);
      // A nondegenerate closed ring retains at least three distinct vertices even at a large tolerance.
      let corner = 0, deviation = 0;
      for (let i = 1; i < last; i++) {
        const candidate = segmentDistanceSquared(points[i], points[0], points[farthest]);
        if (candidate > deviation) { deviation = candidate; corner = i; }
      }
      if (corner) anchors.push(corner);
    }
  }
  anchors.sort((a, b) => a - b);
  const stack: [number, number][] = [];
  for (let i = 0; i < anchors.length; i++) {
    keep[anchors[i]] = 1;
    if (i > 0) stack.push([anchors[i - 1], anchors[i]]);
  }
  const threshold = tolerance * tolerance;
  while (stack.length) {
    const [start, end] = stack.pop()!;
    let farthest = -1, deviation = threshold;
    for (let i = start + 1; i < end; i++) {
      const candidate = segmentDistanceSquared(points[i], points[start], points[end]);
      if (candidate > deviation) { deviation = candidate; farthest = i; }
    }
    if (farthest < 0) continue;
    keep[farthest] = 1;
    stack.push([start, farthest], [farthest, end]);
  }
  return points.filter((_, index) => keep[index] !== 0);
}
