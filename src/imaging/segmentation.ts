import { samePatient } from './linking';
import type { LabelVolume, MaskFrame, SegmentationOverlay, Series, Vec3, Volume } from '../model';
import { add, cross, dot, indexToWorld, inverse3, length, scale, sub, worldToIndex, worldToScreen, type PlaneFrame, type ScreenMapping } from './geometry';

const FALLBACK_COLORS = ['#f2a541', '#4fc3f7', '#ef6f6c', '#7bd389', '#c792ea', '#ffd866'];
const FALLBACK_RGB: Array<[number, number, number]> = [[242, 165, 65], [79, 195, 247], [239, 111, 108], [123, 211, 137], [199, 146, 234], [255, 216, 102]];

export function segmentRgb(series: Series, segment: number): [number, number, number] {
  return series.segmentation?.segments.find(item => item.number === segment)?.color ?? FALLBACK_RGB[(Math.max(1, segment) - 1) % FALLBACK_RGB.length];
}

export function segmentColor(series: Series, segment: number): string {
  const rgb = series.segmentation?.segments.find(item => item.number === segment)?.color;
  return rgb ? `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})` : FALLBACK_COLORS[(Math.max(1, segment) - 1) % FALLBACK_COLORS.length];
}

function segmentLabel(series: Series, segment: number): string {
  return series.segmentation?.segments.find(item => item.number === segment)?.label || `Segment ${segment}`;
}

const instanceIndexes = new WeakMap<Series, Map<string, Set<number>>>();
function instancesOf(series: Series): Map<string, Set<number>> {
  const cached = instanceIndexes.get(series);
  if (cached) return cached;
  const index = new Map<string, Set<number>>();
  for (const frame of series.frameMetadata ?? []) {
    if (!frame.sopInstanceUid) continue;
    const frames = index.get(frame.sopInstanceUid) ?? new Set<number>();
    frames.add(frame.sourceFrameNumber ?? 1);
    index.set(frame.sopInstanceUid, frames);
  }
  instanceIndexes.set(series, index);
  return index;
}

/** Draw a mask only on a compatible patient and the sources the SEG actually references. */
export function segmentationApplies(segmentation: Series, series: Series): boolean {
  if (!segmentation.segmentation || series.segmentation || series.components === 3 || !samePatient(segmentation, series)) return false;
  const sameFrame = Boolean(segmentation.frameOfReferenceUid && segmentation.frameOfReferenceUid === series.frameOfReferenceUid);
  if (!sameFrame && segmentation.frameOfReferenceUid && series.frameOfReferenceUid) return false;
  const { referencedSeries, referencedSeriesUid, referencedInstances } = segmentation.segmentation;
  const targets = referencedSeries ?? (referencedSeriesUid ? [[segmentation.studyUid, referencedSeriesUid]] : undefined);
  if (targets && !targets.some(([study, uid]) => study === series.studyUid && uid === series.uid)) return false;
  if (referencedInstances) {
    const instances = instancesOf(series);
    return referencedInstances.length > 0 && referencedInstances.every(([uid, frame]) =>
      instances.has(uid) && (frame === null || instances.get(uid)!.has(frame)));
  }
  return targets !== undefined || sameFrame;
}

/** SVG paths in grid units for the cells `set` marks: their row runs, and the edges between set and unset cells. */
function trace(columns: number, rows: number, set: (x: number, y: number) => boolean): { fill: string; outline: string } | null {
  let left = columns, right = -1, top = rows, bottom = -1;
  for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) {
    if (set(x, y)) { left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); }
  }
  if (right < 0) return null;
  const inside = (x: number, y: number) => x >= left && x <= right && y >= top && y <= bottom && set(x, y);
  let fill = '', outline = '';
  for (let y = top; y <= bottom; y++) for (let x = left; x <= right;) {
    if (!inside(x, y)) { x++; continue; }
    const start = x; while (x <= right && inside(x, y)) x++;
    fill += `M${start - 0.5} ${y - 0.5}h${x - start}v1h${start - x}z`;
  }
  for (let y = top; y <= bottom + 1; y++) for (let x = left; x <= right;) {
    if (inside(x, y - 1) === inside(x, y)) { x++; continue; }
    const start = x; while (x <= right && inside(x, y - 1) !== inside(x, y)) x++;
    outline += `M${start - 0.5} ${y - 0.5}h${x - start}`;
  }
  for (let x = left; x <= right + 1; x++) for (let y = top; y <= bottom;) {
    if (inside(x - 1, y) === inside(x, y)) { y++; continue; }
    const start = y; while (y <= bottom && inside(x - 1, y) !== inside(x, y)) y++;
    outline += `M${x - 0.5} ${start - 0.5}v${y - start}`;
  }
  return { fill, outline };
}

/** Binary masks hold 0 or 1; fractional ones up to their maximum, the core's window width. Label maps hold segment numbers. */
function maskThreshold(series: Series): number {
  return series.segmentation?.kind === 'FRACTIONAL' ? Math.max(1, series.windowWidth) / 2 : 0.5;
}

/** The frames of a decoded segmentation that hold any part of a mask, one entry per frame and segment, ready to draw. */
export function maskFrames(volume: Volume): MaskFrame[] {
  const { series, data } = volume, [columns, rows, count] = series.dimensions;
  if (!series.segmentation || volume.sourceFrameIndex !== undefined) return [];
  const labelmap = series.segmentation.kind === 'LABELMAP', threshold = maskThreshold(series), area = columns * rows;
  const frames: MaskFrame[] = [];
  for (let frame = 0; frame < count; frame++) {
    const metadata = series.frameMetadata?.[frame];
    if (!metadata || metadata.positionKnown === false || metadata.orientationKnown === false) continue;
    const offset = frame * area;
    const segments = new Set<number>();
    if (labelmap) { for (let p = 0; p < area; p++) if (data[offset + p] > 0) segments.add(data[offset + p]); }
    else segments.add(metadata.segmentNumber ?? 1);
    const m = metadata.direction, spacing = metadata.spacing;
    const i = scale([m[0], m[3], m[6]], spacing[0]), j = scale([m[1], m[4], m[7]], spacing[1]);
    const normal = cross([m[0], m[3], m[6]], [m[1], m[4], m[7]]);
    for (const segment of [...segments].sort((a, b) => a - b)) {
      const paths = trace(columns, rows, labelmap ? (x, y) => data[offset + y * columns + x] === segment : (x, y) => data[offset + y * columns + x] > threshold);
      if (!paths) continue;
      frames.push({ segment, label: segmentLabel(series, segment), color: segmentColor(series, segment), origin: metadata.origin, i, j, normal,
        reach: Math.max(0.01, spacing[2] / 2), ...paths });
    }
  }
  return frames;
}

/**
 * The segmentation as one regular grid of segment indices, for planes across its frames and for 3D: frames
 * placed by position (planes without a mask stay empty), larger segments painted first so that a small one
 * overlapping them stays visible. Null when the frames do not share one orientation and pixel grid.
 */
export function labelVolume(volume: Volume): LabelVolume | null {
  const { series, data } = volume, segmentation = series.segmentation, metadata = series.frameMetadata;
  const [columns, rows, count] = series.dimensions, area = columns * rows;
  if (!segmentation || volume.sourceFrameIndex !== undefined || !metadata || metadata.length !== count || !count) return null;
  const first = metadata[0], m = first.direction;
  const iUnit: Vec3 = [m[0], m[3], m[6]], jUnit: Vec3 = [m[1], m[4], m[7]], normal = cross(iUnit, jUnit);
  if (metadata.some(frame => frame.positionKnown === false || frame.orientationKnown === false
    || frame.direction.some((value, index) => index % 3 !== 2 && Math.abs(value - m[index]) > 1e-4)
    || Math.abs(frame.spacing[0] - first.spacing[0]) > 1e-4 || Math.abs(frame.spacing[1] - first.spacing[1]) > 1e-4)) return null;
  const positions = metadata.map(frame => dot(frame.origin, normal));
  const sorted = [...positions].sort((a, b) => a - b);
  let spacing = Infinity;
  for (let n = 1; n < sorted.length; n++) if (sorted[n] - sorted[n - 1] > 0.01) spacing = Math.min(spacing, sorted[n] - sorted[n - 1]);
  if (!Number.isFinite(spacing)) spacing = Math.max(0.01, first.spacing[2]);
  const lowest = positions.indexOf(sorted[0]), highest = positions.indexOf(sorted[sorted.length - 1]);
  const planes = Math.round((sorted[sorted.length - 1] - sorted[0]) / spacing) + 1;
  if (planes > 4096 || area * planes > 512 * 1024 * 1024) return null;
  const origin = metadata[lowest].origin;
  // From the first plane to the last: a gantry tilt shears it.
  const k = planes > 1 ? scale(sub(metadata[highest].origin, origin), 1 / (planes - 1)) : scale(normal, spacing);
  const tolerance = 0.5 * Math.min(first.spacing[0], first.spacing[1]) + 1e-6;
  const planeOf = metadata.map(frame => {
    const plane = Math.round(dot(sub(frame.origin, origin), normal) / dot(k, normal));
    return length(sub(frame.origin, add(origin, scale(k, plane)))) <= tolerance && plane >= 0 && plane < planes ? plane : -1;
  });
  if (planeOf.includes(-1)) return null;
  const labelmap = segmentation.kind === 'LABELMAP', threshold = maskThreshold(series);
  const counts = new Map<number, number>();
  for (let frame = 0; frame < count; frame++) {
    const offset = frame * area, fixed = metadata[frame].segmentNumber ?? 1;
    for (let p = 0; p < area; p++) {
      const value = data[offset + p];
      if (labelmap ? value > 0 : value > threshold) { const segment = labelmap ? value : fixed; counts.set(segment, (counts.get(segment) ?? 0) + 1); }
    }
  }
  if (!counts.size || counts.size > 255) return null;
  const order = [...counts.keys()].sort((a, b) => counts.get(b)! - counts.get(a)! || a - b);
  const indexOf = new Map(order.map((segment, index) => [segment, index + 1]));
  const labels = new Uint8Array(area * planes);
  const min: Vec3 = [columns, rows, planes], max: Vec3 = [-1, -1, -1];
  const frames = [...metadata.keys()].sort((a, b) => labelmap ? 0 : indexOf.get(metadata[a].segmentNumber ?? 1)! - indexOf.get(metadata[b].segmentNumber ?? 1)!);
  for (const frame of frames) {
    const offset = frame * area, z = planeOf[frame], base = z * area, fixed = indexOf.get(metadata[frame].segmentNumber ?? 1) ?? 0;
    for (let p = 0; p < area; p++) {
      const value = data[offset + p];
      if (labelmap ? value <= 0 : !(value > threshold)) continue;
      labels[base + p] = labelmap ? indexOf.get(value)! : fixed;
      const x = p % columns, y = (p - x) / columns;
      min[0] = Math.min(min[0], x); min[1] = Math.min(min[1], y); min[2] = Math.min(min[2], z);
      max[0] = Math.max(max[0], x); max[1] = Math.max(max[1], y); max[2] = Math.max(max[2], z);
    }
  }
  return { dimensions: [columns, rows, planes], origin, i: scale(iUnit, first.spacing[0]), j: scale(jUnit, first.spacing[1]), k, normal, labels, min, max,
    segments: order.map(segment => ({ segment, label: segmentLabel(series, segment), color: segmentColor(series, segment), rgb: segmentRgb(series, segment) })) };
}

function toIndex(volume: LabelVolume): (world: Vec3) => Vec3 {
  const { i, j, k, origin } = volume, inverse = inverse3([i[0], j[0], k[0], i[1], j[1], k[1], i[2], j[2], k[2]]);
  return world => {
    const v = sub(world, origin);
    return [inverse[0] * v[0] + inverse[1] * v[1] + inverse[2] * v[2], inverse[3] * v[0] + inverse[4] * v[1] + inverse[5] * v[2], inverse[6] * v[0] + inverse[7] * v[1] + inverse[8] * v[2]];
  };
}

function labelCorners(volume: LabelVolume): Vec3[] {
  const { min, max, origin, i, j, k } = volume;
  return Array.from({ length: 8 }, (_, n) => {
    const x = n & 1 ? max[0] + 0.5 : min[0] - 0.5, y = n & 2 ? max[1] + 0.5 : min[1] - 0.5, z = n & 4 ? max[2] + 0.5 : min[2] - 0.5;
    return add(origin, add(scale(i, x), add(scale(j, y), scale(k, z))));
  });
}

/**
 * Outlines of the segments where a plane crossing the segmentation's frames cuts them (coronal, sagittal or
 * oblique views of an axial segmentation): the label grid sampled at its finest spacing over the part of the
 * plane that its masks can reach.
 */
export function planeOutlines(volume: LabelVolume, plane: Pick<PlaneFrame, 'center' | 'u' | 'v' | 'normal'>): MaskFrame[] {
  const corners = labelCorners(volume), distances = corners.map(corner => dot(sub(corner, plane.center), plane.normal));
  if (Math.min(...distances) > 0 || Math.max(...distances) < 0) return [];
  const s = corners.map(corner => dot(sub(corner, plane.center), plane.u)), t = corners.map(corner => dot(sub(corner, plane.center), plane.v));
  const sMin = Math.min(...s), sMax = Math.max(...s), tMin = Math.min(...t), tMax = Math.max(...t);
  const step = Math.max(Math.min(length(volume.i), length(volume.j), length(volume.k)), (sMax - sMin) / 1024, (tMax - tMin) / 1024);
  // Cell centres sit half a step inside the box, on the pixel centres where the plane runs along the pixel grid.
  const width = Math.max(1, Math.ceil((sMax - sMin) / step - 1e-9)), height = Math.max(1, Math.ceil((tMax - tMin) / step - 1e-9));
  const start = add(plane.center, add(scale(plane.u, sMin + step / 2), scale(plane.v, tMin + step / 2)));
  const index = toIndex(volume), first = index(start), across = sub(index(add(start, scale(plane.u, step))), first), down = sub(index(add(start, scale(plane.v, step))), first);
  const [columns, rows, planes] = volume.dimensions, grid = new Uint8Array(width * height), present = new Set<number>();
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const a = Math.round(first[0] + x * across[0] + y * down[0]), b = Math.round(first[1] + x * across[1] + y * down[1]), c = Math.round(first[2] + x * across[2] + y * down[2]);
    if (a < 0 || b < 0 || c < 0 || a >= columns || b >= rows || c >= planes) continue;
    const label = volume.labels[(c * rows + b) * columns + a];
    if (label) { grid[y * width + x] = label; present.add(label); }
  }
  const i = scale(plane.u, step), j = scale(plane.v, step);
  return [...present].sort((a, b) => a - b).flatMap(label => {
    const paths = trace(width, height, (x, y) => grid[y * width + x] === label), segment = volume.segments[label - 1];
    return paths ? [{ segment: segment.segment, label: segment.label, color: segment.color, origin: start, i, j, normal: plane.normal, reach: 0, ...paths }] : [];
  });
}

/** The middle of a segmentation's masks in patient space: the centre of the box they occupy. */
export function segmentationCenter(overlay: Pick<SegmentationOverlay, 'frames' | 'labels'>): Vec3 | null {
  const volume = overlay.labels;
  if (volume) {
    const middle = (axis: number) => (volume.min[axis] + volume.max[axis]) / 2;
    return add(volume.origin, add(scale(volume.i, middle(0)), add(scale(volume.j, middle(1)), scale(volume.k, middle(2)))));
  }
  return overlay.frames.length ? overlay.frames[Math.floor(overlay.frames.length / 2)].origin : null;
}

/** The mask frames lying in a viewed plane: parallel to it and within half a slice of it. */
export function framesOnPlane(frames: readonly MaskFrame[], plane: Pick<PlaneFrame, 'center' | 'normal' | 'step'>): MaskFrame[] {
  const reach = Math.max(0.01, plane.step / 2);
  return frames.filter(frame => Math.abs(dot(frame.normal, plane.normal)) > 0.9999
    && Math.abs(dot(sub(frame.origin, plane.center), plane.normal)) <= Math.min(reach, frame.reach) + 1e-6);
}

/** What a segmentation shows in a viewed plane: its own frames where the plane is parallel to them, otherwise where the plane cuts them. */
export function overlayShapes(overlay: SegmentationOverlay, plane: PlaneFrame): MaskFrame[] {
  const normal = overlay.labels?.normal ?? overlay.frames[0]?.normal;
  if (!normal) return [];
  if (Math.abs(dot(normal, plane.normal)) > 0.9999) return framesOnPlane(overlay.frames, plane);
  return overlay.labels ? planeOutlines(overlay.labels, plane) : [];
}

/** The SVG transform from a mask frame's pixel indices to viewport pixels. */
export function maskTransform(mapping: ScreenMapping, frame: Pick<MaskFrame, 'origin' | 'i' | 'j'>): string {
  const origin = worldToScreen(mapping, frame.origin), right = worldToScreen(mapping, add(frame.origin, frame.i)), down = worldToScreen(mapping, add(frame.origin, frame.j));
  return `matrix(${right[0] - origin[0]} ${right[1] - origin[1]} ${down[0] - origin[0]} ${down[1] - origin[1]} ${origin[0]} ${origin[1]})`;
}

export interface SegmentationTexture {
  /** Palette index per voxel of the box, x fastest; 0 where no segment is shown. */
  labels: Uint8Array;
  /** The box within the target series' voxel grid that holds every shown segment. */
  min: Vec3; size: Vec3;
  /** sRGB per palette index, starting at index 1. */
  colors: Array<[number, number, number]>;
}

/** The shown segmentations resampled onto a series' voxel grid (nearest), limited to the box their masks occupy, for the 3D view. */
export function segmentationTexture(target: Series, overlays: readonly SegmentationOverlay[]): SegmentationTexture | null {
  const [nx, ny, nz] = target.dimensions;
  const shown = overlays.filter(overlay => overlay.labels && segmentationApplies(overlay.series, target));
  if (!shown.length) return null;
  const low: Vec3 = [nx, ny, nz], high: Vec3 = [-1, -1, -1];
  for (const overlay of shown) for (const corner of labelCorners(overlay.labels!)) {
    const p = worldToIndex(target, corner);
    for (let axis = 0; axis < 3; axis++) {
      low[axis] = Math.min(low[axis], Math.max(0, Math.floor(p[axis])));
      high[axis] = Math.max(high[axis], Math.min(target.dimensions[axis] - 1, Math.ceil(p[axis])));
    }
  }
  if (high.some((value, axis) => value < low[axis])) return null;
  const size: Vec3 = [high[0] - low[0] + 1, high[1] - low[1] + 1, high[2] - low[2] + 1];
  if (size[0] * size[1] * size[2] > 256 * 1024 * 1024) return null;
  const labels = new Uint8Array(size[0] * size[1] * size[2]), colors: Array<[number, number, number]> = [];
  for (const overlay of shown) {
    const volume = overlay.labels!, index = toIndex(volume), palette = volume.segments.map(segment => {
      if (colors.length >= 255) return 255;
      colors.push(segment.rgb);
      return colors.length;
    });
    const origin = index(indexToWorld(target, low));
    const stepX = sub(index(indexToWorld(target, add(low, [1, 0, 0]))), origin), stepY = sub(index(indexToWorld(target, add(low, [0, 1, 0]))), origin);
    const stepZ = sub(index(indexToWorld(target, add(low, [0, 0, 1]))), origin);
    const [columns, rows, planes] = volume.dimensions;
    for (let z = 0; z < size[2]; z++) for (let y = 0; y < size[1]; y++) for (let x = 0; x < size[0]; x++) {
      const a = Math.round(origin[0] + x * stepX[0] + y * stepY[0] + z * stepZ[0]), b = Math.round(origin[1] + x * stepX[1] + y * stepY[1] + z * stepZ[1]);
      const c = Math.round(origin[2] + x * stepX[2] + y * stepY[2] + z * stepZ[2]);
      if (a < 0 || b < 0 || c < 0 || a >= columns || b >= rows || c >= planes) continue;
      const label = volume.labels[(c * rows + b) * columns + a];
      if (label) labels[(z * size[1] + y) * size[0] + x] = palette[label - 1];
    }
  }
  return { labels, min: low, size, colors };
}
