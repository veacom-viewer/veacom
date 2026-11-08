import { hasPixels, type ViewVolume } from '../model';
import type { Annotation, Series, Vec3, ViewState, Volume } from '../model';
import { getPlaneFrame, indexToWorld, isPaddingValue, isProjection, sampleVolume, sourceFrameSeries, worldToIndex, type PlaneFrame } from './geometry';
import { usesSourceFrames } from './viewState';
import { formatSphereStatistics, formatSphereValue, isSuv, peakName, measurableVolume, sphereOf, sphereSection, sphereSulGlu, sphereStatisticsFor, thresholdVolumeFor, type SphereStatistics } from './voi';
import { t } from '../i18n';
import { isEmission, overlayKind, petHasSuv } from './emission';
import { sulGluGlucose } from './glucose';

export interface RoiStatistics {
  mean: number;
  min: number;
  max: number;
  standardDeviation: number;
  count: number;
  outsideCount: number;
  invalidCount: number;
  paddingCount: number;
  clipped: boolean;
  sampling: 'source-voxels' | 'derived-interpolated';
  area: number;
  areaUnit: 'mm²' | 'px²';
  unit: string;
  samplingStep: [number, number];
  spatialUnit: 'mm' | 'px';
  downsampled: boolean;
}

type Point2 = [number, number];
interface RoiPlane {
  origin: Vec3;
  u: Vec3;
  v: Vec3;
  polygon: Point2[];
  ellipse: boolean;
  width: number;
  height: number;
}

const subtract = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const valid = (point: Vec3) => point.every(Number.isFinite);
const normalize = (a: Vec3): Vec3 | null => {
  const length = Math.hypot(...a);
  return length > 1e-10 && Number.isFinite(length) ? [a[0] / length, a[1] / length, a[2] / length] : null;
};

export function distanceMm(a: Vec3, b: Vec3): number | null {
  if (!valid(a) || !valid(b)) return null;
  const length = Math.hypot(...subtract(a, b));
  return Number.isFinite(length) ? length : null;
}

export function angleDegrees(a: Vec3, vertex: Vec3, b: Vec3): number | null {
  if (![a, vertex, b].every(valid)) return null;
  const first = normalize(subtract(a, vertex));
  const second = normalize(subtract(b, vertex));
  if (!first || !second) return null;
  return Math.acos(Math.min(1, Math.max(-1, dot(first, second)))) * 180 / Math.PI;
}

export function cobbAngleDegrees(points: Vec3[]): number | null {
  if (points.length < 4 || !points.slice(0, 4).every(valid)) return null;
  const first = normalize(subtract(points[1], points[0]));
  const second = normalize(subtract(points[3], points[2]));
  if (!first || !second) return null;
  return Math.acos(Math.min(1, Math.abs(dot(first, second)))) * 180 / Math.PI;
}

export function polylineLengthMm(points: Vec3[]): number | null {
  if (points.length < 2 || !points.every(valid)) return null;
  let length = 0;
  for (let index = 1; index < points.length; index++) length += Math.hypot(...subtract(points[index], points[index - 1]));
  return Number.isFinite(length) ? length : null;
}

const positive = (value: number | null | undefined): value is number => value != null && Number.isFinite(value) && value > 0;

/** Older catalogues can name a GML series as SUV even when ingest declined calibration. */
export const storedUnit = (series: Series) => series.modality === 'PT' && /^SU[VL]/i.test(series.valueUnit) && !petHasSuv(series) ? 'g/ml' : series.valueUnit;

/** How stored values become the quantity shown, and its unit. A PET is given in the SUV the reader chose (body
 * weight, lean body mass or body surface area) where the series has what that needs, else in SUVbw; values stored
 * as SUV stay as they are unless converted. The unit always names the SUV given. */
export function quantitativeScale(series: Series): { factor: number; unit: string } {
  const unit = storedUnit(series) || t('annotation.valueUnit');
  if (!petHasSuv(series)) return { factor: 1, unit };
  if (series.suvNormalization === 'lbm' && positive(series.sulFactor)) return { factor: series.sulFactor, unit: 'SUL' };
  if (series.suvNormalization === 'bsa' && positive(series.suvBsaFactor)) return { factor: series.suvBsaFactor, unit: 'SUVbsa' };
  if (!/^SUV/i.test(unit)) return { factor: series.suvFactor, unit: 'SUVbw' };
  return { factor: 1, unit };
}

/** Decimals for a value in `unit`: two for an SUV or SUL, one otherwise. */
const quantityDigits = (unit: string) => /^SU[VL]/i.test(unit) ? 2 : 1;
/** A value with its unit as the probe writes it: "3.42 SUVbw", "-12.0 HU". */
export const quantityText = (value: number, unit: string) => `${format(value, quantityDigits(unit))} ${unit}`;

/** A region on a reconstructed plane of a PET larger than this many voxels (a large oblique one) is described by
 * interpolated plane samples instead of its voxels. */
export const PET_VOXEL_LIMIT = 4_000_000;

export function measurementSpace(series: Series): { unit: 'mm' | 'px'; scale: number } {
  if (series.measurementUnits === 'px') return { unit: 'px', scale: 1 };
  const scale = series.measurementScale;
  if (scale != null && Number.isFinite(scale) && scale > 0) return { unit: 'mm', scale };
  return { unit: series.spacingKnown === true ? 'mm' : 'px', scale: 1 };
}

function planeAxes(annotation: Annotation, series: Series): [Vec3, Vec3] | null {
  if (annotation.mode !== 'source' && series.canReconstruct && !series.sourceFramesOnly && series.components !== 3) {
    if (annotation.plane === 'coronal') return [[1, 0, 0], [0, 0, -1]];
    if (annotation.plane === 'sagittal') return [[0, 1, 0], [0, 0, -1]];
    return [[1, 0, 0], [0, 1, 0]];
  }
  const d = series.direction;
  if (d.length !== 9 || !d.every(Number.isFinite)) return null;
  const u = normalize([d[0], d[3], d[6]]);
  const v = normalize([d[1], d[4], d[7]]);
  return u && v ? [u, v] : null;
}

export function roiPlane(annotation: Annotation, series: Series): RoiPlane | null {
  let points = annotation.points;
  if (points.length < 2 || !points.every(valid)) return null;
  if (annotation.type === 'polygon') {
    points = points.filter((point, index) => index === 0 || Math.hypot(...subtract(point, points[index - 1])) > 1e-8);
    if (points.length > 3 && Math.hypot(...subtract(points[0], points[points.length - 1])) < 1e-8) points = points.slice(0, -1);
  }
  const boxed = annotation.type === 'rectangle' || annotation.type === 'ellipse';
  const origin = points[0];
  let u: Vec3;
  let v: Vec3;
  let polygon: Point2[];
  let width = 0;
  let height = 0;
  if (boxed && points.length === 2) {
    const axes = planeAxes(annotation, series);
    if (!axes) return null;
    [u, v] = axes;
    width = dot(subtract(points[1], origin), u);
    height = dot(subtract(points[1], origin), v);
    polygon = [[0, 0], [width, 0], [width, height], [0, height]];
  } else {
    if (points.length < 3) return null;
    const along = normalize(subtract(points[1], origin));
    if (!along) return null;
    u = along;
    let normal: Vec3 | null = null;
    for (let index = 2; index < points.length && !normal; index++) normal = normalize(cross(u, subtract(points[index], origin)));
    if (!normal) return null;
    const vertical = normalize(cross(normal, u));
    if (!vertical) return null;
    v = vertical;
    // A plane ROI cannot silently become a projection of non-coplanar points.
    if (points.some(point => Math.abs(dot(subtract(point, origin), normal!)) > 1e-3)) return null;
    polygon = points.map(point => [dot(subtract(point, origin), u), dot(subtract(point, origin), v)]);
    if (boxed) {
      if (points.length !== 4) return null;
      width = polygon[1][0];
      height = polygon[3][1];
      const tolerance = Math.max(1, Math.abs(width), Math.abs(height)) * 1e-5;
      if (Math.abs(polygon[1][1]) > tolerance || Math.abs(polygon[3][0]) > tolerance || Math.abs(polygon[2][0] - width) > tolerance || Math.abs(polygon[2][1] - height) > tolerance) return null;
    }
  }
  return { origin, u, v, polygon, ellipse: annotation.type === 'ellipse', width, height };
}

function isSimplePolygon(points: Point2[]): boolean {
  const orientation = (a: Point2, b: Point2, c: Point2) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const onSegment = (a: Point2, b: Point2, p: Point2) => Math.abs(orientation(a, b, p)) < 1e-8 && p[0] >= Math.min(a[0], b[0]) - 1e-8 && p[0] <= Math.max(a[0], b[0]) + 1e-8 && p[1] >= Math.min(a[1], b[1]) - 1e-8 && p[1] <= Math.max(a[1], b[1]) + 1e-8;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    for (let j = i + 2; j < points.length; j++) {
      if (i === 0 && j === points.length - 1) continue;
      const c = points[j];
      const d = points[(j + 1) % points.length];
      const first = orientation(a, b, c) * orientation(a, b, d);
      const second = orientation(c, d, a) * orientation(c, d, b);
      if ((first < 0 && second < 0) || onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b)) return false;
    }
  }
  return true;
}

function polygonArea(points: Point2[]): number {
  let twiceArea = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) twiceArea += points[j][0] * points[i][1] - points[i][0] * points[j][1];
  return Math.abs(twiceArea) / 2;
}

function contains(points: Point2[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    const dx = xj - xi;
    const dy = yj - yi;
    const boundary = Math.abs((x - xi) * dy - (y - yi) * dx) <= 1e-7 * Math.max(1, Math.hypot(dx, dy));
    if (boundary && x >= Math.min(xi, xj) - 1e-7 && x <= Math.max(xi, xj) + 1e-7 && y >= Math.min(yi, yj) - 1e-7 && y <= Math.max(yi, yj) + 1e-7) return true;
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function spacingAlong(series: Series, origin: Vec3, axis: Vec3): number | null {
  const index0 = worldToIndex(series, origin);
  const index1 = worldToIndex(series, [origin[0] + axis[0], origin[1] + axis[1], origin[2] + axis[2]]);
  const reciprocal = Math.hypot(...subtract(index1, index0));
  return Number.isFinite(reciprocal) && reciprocal > 1e-10 ? 1 / reciprocal : null;
}

export function annotationSourceIndex(annotation: Annotation, series: Series): number | null {
  if (annotation.mode !== 'source') return null;
  let index: number | undefined;
  if (annotation.sourceSopInstanceUid) {
    const matches = (series.frameMetadata ?? []).flatMap((frame, i) => frame.sopInstanceUid === annotation.sourceSopInstanceUid
      && frame.sourceFrameNumber === annotation.sourceFrameNumber ? [i] : []);
    if (matches.length !== 1) return null;
    index = matches[0];
  } else index = annotation.sourceFrame ?? annotation.slice;
  if (!Number.isInteger(index) || index < 0 || index >= series.dimensions[2] || !annotation.points.length) return null;
  try {
    const frame = sourceFrameSeries(series, index);
    if (annotation.points.some(point => { const p = worldToIndex(frame, point); return !valid(p) || Math.abs(p[2]) > 1e-4; })) return null;
  } catch { return null; }
  return index;
}

export function planePoints(frame: RoiPlane): Vec3[] {
  return frame.polygon.map(([u, v]) => frame.origin.map((x, axis) => x + u * frame.u[axis] + v * frame.v[axis]) as Vec3);
}

/** The constant integer voxel coordinate of a native grid plane. Between-plane and oblique regions have none. */
export function voxelPlane(points: Vec3[], series: Series): { axis: number; index: number } | undefined {
  if (!series.canReconstruct || series.sourceFramesOnly || points.length < 3) return;
  const indices = points.map(point => worldToIndex(series, point));
  for (let axis = 0; axis < 3; axis++) {
    const index = Math.round(indices[0][axis]);
    if (index >= 0 && index < series.dimensions[axis] && indices.every(p => Math.abs(p[axis] - index) < 1e-5)) return { axis, index };
  }
}

function annotationSourceFrame(annotation: Annotation, volume: ViewVolume, requirePixels = true): { series: Series; offset: number } | null {
  const index = annotationSourceIndex(annotation, volume.series);
  if (index === null) return null;
  if (requirePixels && volume.sourceFrameIndex !== undefined && volume.sourceFrameIndex !== index) return null;
  const frameLength = volume.series.dimensions[0] * volume.series.dimensions[1];
  const offset = volume.sourceFrameIndex === undefined ? index * frameLength : 0;
  if (requirePixels && (!volume.data || offset + frameLength > volume.data.length)) return null;
  return { series: sourceFrameSeries(volume.series, index), offset };
}

function nearestSourceSample(volume: Volume, world: Vec3): { value: number; frame: number } | null {
  if (volume.series.components === 3 || !valid(world)) return null;
  const series = volume.sourceFrameIndex === undefined ? volume.series : sourceFrameSeries(volume.series, volume.sourceFrameIndex);
  const point = worldToIndex(series, world), dimensions = series.dimensions;
  if (!valid(point) || point.some((n, axis) => n < -0.500001 || n > dimensions[axis] - 0.499999)) return null;
  const [x, y, z] = point.map((n, axis) => Math.max(0, Math.min(dimensions[axis] - 1, Math.round(n))));
  return { value: volume.data[(z * dimensions[1] + y) * dimensions[0] + x], frame: volume.sourceFrameIndex ?? z };
}

/** Source ROIs use every contained voxel centre. On a reconstructed plane, a PET's ROI uses its own voxels: those whose
 * box the plane passes through and whose centre lies inside the outline, so the maximum is the hottest voxel's value,
 * as SUVmax is read. Other MPR statistics describe interpolated plane samples. */
export function roiStatistics(annotation: Annotation, volume: Volume, maxSamples = 200_000): RoiStatistics | null {
  if (!['rectangle', 'ellipse', 'polygon'].includes(annotation.type) || volume.series.components === 3) return null;
  const source = annotation.mode === 'source' ? annotationSourceFrame(annotation, volume) : null;
  if (annotation.mode === 'source' && !source) return null;
  if (!source && (!Number.isFinite(maxSamples) || maxSamples < 1)) return null;
  const samplingSeries = source?.series ?? volume.series;
  const frame = roiPlane(annotation, samplingSeries);
  if (!frame || !isSimplePolygon(frame.polygon)) return null;
  const planeArea = frame.ellipse ? Math.PI * Math.abs(frame.width * frame.height) / 4 : polygonArea(frame.polygon);
  if (!Number.isFinite(planeArea) || planeArea <= 1e-10) return null;
  const pointAt = (u: number, v: number): Vec3 => [
    frame.origin[0] + u * frame.u[0] + v * frame.v[0],
    frame.origin[1] + u * frame.u[1] + v * frame.v[1],
    frame.origin[2] + u * frame.u[2] + v * frame.v[2],
  ];
  const inside = (u: number, v: number) => {
    if (frame.ellipse) return ((u - frame.width / 2) / (Math.abs(frame.width) / 2)) ** 2 + ((v - frame.height / 2) / (Math.abs(frame.height) / 2)) ** 2 <= 1 + 1e-12;
    if (annotation.type === 'rectangle') return u >= Math.min(0, frame.width) - 1e-7 && u <= Math.max(0, frame.width) + 1e-7
      && v >= Math.min(0, frame.height) - 1e-7 && v <= Math.max(0, frame.height) + 1e-7;
    return contains(frame.polygon, u, v);
  };
  const quantity = quantitativeScale(samplingSeries);
  const voxels = !source && isEmission(samplingSeries) && volume.sourceFrameIndex === undefined ? petVoxelPlan(samplingSeries, frame, pointAt) : null;
  let count = 0, outsideCount = 0, invalidCount = 0, paddingCount = 0;
  let mean = 0, sumSquaredDifferences = 0, sum = 0, correction = 0, min = Infinity, max = -Infinity;
  let stepU = 0, stepV = 0, downsampled = false, clipped = false;
  const record = (sampled: number) => {
    if (source && isPaddingValue(samplingSeries, sampled)) { paddingCount++; return; }
    if (!Number.isFinite(sampled)) { invalidCount++; return; }
    const value = sampled * quantity.factor;
    if (!Number.isFinite(value)) { invalidCount++; return; }
    count++;
    const delta = value - mean;
    mean += delta / count;
    sumSquaredDifferences += delta * (value - mean);
    const nextSum = sum + value;
    correction += Math.abs(sum) >= Math.abs(value) ? (sum - nextSum) + value : (value - nextSum) + sum;
    sum = nextSum;
    min = Math.min(min, value); max = Math.max(max, value);
  };
  if (source) {
    const vertices = frame.polygon.map(([u, v]) => worldToIndex(samplingSeries, pointAt(u, v)));
    if (vertices.some(point => !valid(point) || Math.abs(point[2]) > 1e-4)) return null;
    const [nx, ny] = samplingSeries.dimensions;
    let minX = Math.min(...vertices.map(point => point[0])), maxX = Math.max(...vertices.map(point => point[0]));
    let minY = Math.min(...vertices.map(point => point[1])), maxY = Math.max(...vertices.map(point => point[1]));
    if (frame.ellipse) {
      const center = worldToIndex(samplingSeries, pointAt(frame.width / 2, frame.height / 2));
      const origin = worldToIndex(samplingSeries, frame.origin);
      const u = subtract(worldToIndex(samplingSeries, pointAt(frame.width / 2, 0)), origin);
      const v = subtract(worldToIndex(samplingSeries, pointAt(0, frame.height / 2)), origin);
      const radiusX = Math.hypot(u[0], v[0]), radiusY = Math.hypot(u[1], v[1]);
      minX = center[0] - radiusX; maxX = center[0] + radiusX;
      minY = center[1] - radiusY; maxY = center[1] + radiusY;
    }
    clipped = minX < -0.5 - 1e-7 || maxX > nx - 0.5 + 1e-7 || minY < -0.5 - 1e-7 || maxY > ny - 0.5 + 1e-7;
    const firstX = Math.max(0, Math.ceil(minX - 1e-7)), lastX = Math.min(nx - 1, Math.floor(maxX + 1e-7));
    const firstY = Math.max(0, Math.ceil(minY - 1e-7)), lastY = Math.min(ny - 1, Math.floor(maxY + 1e-7));
    const origin = indexToWorld(samplingSeries, [0, 0, 0]);
    const i = subtract(indexToWorld(samplingSeries, [1, 0, 0]), origin);
    const j = subtract(indexToWorld(samplingSeries, [0, 1, 0]), origin);
    const offset = subtract(origin, frame.origin);
    const startU = dot(offset, frame.u), startV = dot(offset, frame.v);
    const iu = dot(i, frame.u), iv = dot(i, frame.v), ju = dot(j, frame.u), jv = dot(j, frame.v);
    stepU = Math.hypot(...i); stepV = Math.hypot(...j);
    for (let y = firstY; y <= lastY; y++) {
      for (let x = firstX; x <= lastX; x++) {
        if (inside(startU + x * iu + y * ju, startV + x * iv + y * jv)) record(volume.data[source.offset + y * nx + x]);
      }
    }
  } else if (voxels) {
    const { first, last, step, start, reach } = voxels, [nx, ny] = samplingSeries.dimensions;
    for (let z = first[2]; z <= last[2]; z++) {
      for (let y = first[1]; y <= last[1]; y++) {
        const dy = y - first[1], dz = z - first[2];
        let u = start[0] + dy * step[1][0] + dz * step[2][0], v = start[1] + dy * step[1][1] + dz * step[2][1];
        let n = start[2] + dy * step[1][2] + dz * step[2][2];
        for (let x = first[0]; x <= last[0]; x++, u += step[0][0], v += step[0][1], n += step[0][2]) {
          if (Math.abs(n) > reach || !inside(u, v)) continue;
          const value = volume.data[(z * ny + y) * nx + x];
          if (isPaddingValue(samplingSeries, value, z)) { paddingCount++; continue; }
          record(value);
        }
      }
    }
    clipped = voxels.clipped;
    [stepU, stepV] = voxels.spacing;
  } else {
    const spacingU = spacingAlong(samplingSeries, frame.origin, frame.u), spacingV = spacingAlong(samplingSeries, frame.origin, frame.v);
    if (!spacingU || !spacingV) return null;
    const minU = Math.min(...frame.polygon.map(point => point[0])), maxU = Math.max(...frame.polygon.map(point => point[0]));
    const minV = Math.min(...frame.polygon.map(point => point[1])), maxV = Math.max(...frame.polygon.map(point => point[1]));
    let columns = Math.max(1, Math.ceil((maxU - minU) / spacingU)), rows = Math.max(1, Math.ceil((maxV - minV) / spacingV));
    downsampled = columns * rows > maxSamples;
    if (downsampled) {
      const scale = Math.sqrt(columns * rows / Math.floor(maxSamples));
      columns = Math.max(1, Math.min(Math.floor(maxSamples), Math.floor(columns / scale)));
      rows = Math.max(1, Math.min(Math.floor(maxSamples / columns), Math.floor(rows / scale)));
    }
    stepU = (maxU - minU) / columns; stepV = (maxV - minV) / rows;
    for (let row = 0; row < rows; row++) {
      const v = minV + (row + 0.5) * stepV;
      for (let column = 0; column < columns; column++) {
        const u = minU + (column + 0.5) * stepU;
        if (!inside(u, v)) continue;
        const point = pointAt(u, v), nearest = nearestSourceSample(volume, point);
        if (nearest && isPaddingValue(volume.series, nearest.value, nearest.frame)) { paddingCount++; continue; }
        const sampled = sampleVolume(volume, point, true);
        if (sampled == null) { outsideCount++; continue; }
        record(sampled);
      }
    }
    clipped = outsideCount > 0;
  }
  if (!count) return null;
  const compensatedMean = (sum + correction) / count;
  if (Number.isFinite(compensatedMean)) mean = compensatedMean;
  const measurement = measurementSpace(samplingSeries);
  let area = planeArea * measurement.scale ** 2;
  let samplingStep: [number, number] = [stepU * measurement.scale, stepV * measurement.scale];
  if (measurement.unit === 'px') {
    const indexOrigin = worldToIndex(samplingSeries, frame.origin);
    const axisInPixels = (axis: Vec3): Vec3 => subtract(worldToIndex(samplingSeries,
      [frame.origin[0] + axis[0], frame.origin[1] + axis[1], frame.origin[2] + axis[2]]), indexOrigin);
    const u = axisInPixels(frame.u), v = axisInPixels(frame.v);
    area *= Math.hypot(...cross(u, v));
    samplingStep = source || voxels ? [1, 1] : [stepU * Math.hypot(...u), stepV * Math.hypot(...v)];
  }
  return { mean, min, max, standardDeviation: Math.sqrt(Math.max(0, sumSquaredDifferences / count)), count, outsideCount, invalidCount, paddingCount,
    clipped, sampling: source || voxels ? 'source-voxels' : 'derived-interpolated',
    area, areaUnit: measurement.unit === 'mm' ? 'mm²' : 'px²', unit: quantity.unit, samplingStep,
    spatialUnit: measurement.unit, downsampled };
}

interface VoxelPlan {
  /** The voxel index range scanned, inclusive. */
  first: Vec3; last: Vec3;
  /** One index step along i, j and k, in the plane's (u, v, normal) coordinates (mm). */
  step: [Vec3, Vec3, Vec3];
  /** The first voxel's centre in those coordinates. */
  start: Vec3;
  /** Half a voxel's depth along the plane's normal: a voxel whose centre is this close has a box the plane crosses. */
  reach: number;
  spacing: [number, number];
  clipped: boolean;
}

/** Which of a PET's voxels a region on a plane could take, scanning the box around its outline one voxel wider.
 * Null without a usable plane, or for more voxels than PET_VOXEL_LIMIT. */
function petVoxelPlan(series: Series, frame: RoiPlane, pointAt: (u: number, v: number) => Vec3): VoxelPlan | null {
  const normal = normalize(cross(frame.u, frame.v));
  if (!normal) return null;
  const origin = indexToWorld(series, [0, 0, 0]);
  const axes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map(index => subtract(indexToWorld(series, index as Vec3), origin));
  const reach = axes.reduce((total, axis) => total + Math.abs(dot(axis, normal)), 0) / 2;
  const corners = frame.polygon.map(([u, v]) => worldToIndex(series, pointAt(u, v)));
  if (!Number.isFinite(reach) || reach <= 0 || !corners.every(valid)) return null;
  const dimensions = series.dimensions;
  const low = [0, 1, 2].map(axis => Math.min(...corners.map(corner => corner[axis])));
  const high = [0, 1, 2].map(axis => Math.max(...corners.map(corner => corner[axis])));
  const first = low.map(value => Math.max(0, Math.floor(value) - 1)) as Vec3;
  const last = high.map((value, axis) => Math.min(dimensions[axis] - 1, Math.ceil(value) + 1)) as Vec3;
  const count = [0, 1, 2].reduce((total, axis) => total * Math.max(0, last[axis] - first[axis] + 1), 1);
  if (!(count <= PET_VOXEL_LIMIT)) return null;
  const offset = subtract(indexToWorld(series, first), frame.origin);
  const local = (vector: Vec3): Vec3 => [dot(vector, frame.u), dot(vector, frame.v), dot(vector, normal)];
  return {
    first, last, step: axes.map(local) as [Vec3, Vec3, Vec3], start: local(offset),
    reach: reach * (1 + 1e-9) + 1e-9, spacing: [Math.hypot(...axes[0]), Math.hypot(...axes[1])],
    clipped: [0, 1, 2].some(axis => low[axis] < -0.5 - 1e-7 || high[axis] > dimensions[axis] - 0.5 + 1e-7),
  };
}

const format = (value: number, digits = 1) => Number.isFinite(value) ? value.toFixed(digits) : '—';

export function formatRoiStatistics(stats: RoiStatistics): string {
  const digits = quantityDigits(stats.unit);
  const derived = stats.sampling === 'derived-interpolated';
  const one = (count: number) => count === 1;
  const invalid = !stats.invalidCount ? '' : derived
    ? t(one(stats.invalidCount) ? 'roi.nonFiniteSample' : 'roi.nonFiniteSamples', { count: stats.invalidCount })
    : t(one(stats.invalidCount) ? 'roi.nonFiniteVoxel' : 'roi.nonFiniteVoxels', { count: stats.invalidCount });
  const padding = !stats.paddingCount ? '' : derived
    ? t(one(stats.paddingCount) ? 'roi.paddingSample' : 'roi.paddingSamples', { count: stats.paddingCount })
    : t(one(stats.paddingCount) ? 'roi.paddingVoxel' : 'roi.paddingVoxels', { count: stats.paddingCount });
  return `${derived ? t('roi.interpolated') : ''}${format(stats.area)} ${stats.areaUnit} · ${t('roi.mean')} ${format(stats.mean, digits)} ${stats.unit} · ${t(derived ? 'roi.sampleMin' : 'roi.min')} ${format(stats.min, digits)} · ${t(derived ? 'roi.sampleMax' : 'roi.max')} ${format(stats.max, digits)} · σ ${format(stats.standardDeviation, digits)} · ${stats.count} ${t(derived ? 'roi.samples' : 'roi.sourceVoxels')}${stats.downsampled ? t('roi.reduced') : ''}${stats.clipped ? t('roi.clipped') : ''}${invalid}${padding}`;
}

/** What a sphere VOI measures in `volume`, or why it measures nothing yet. */
export function sphereSummary(annotation: Annotation, volume: ViewVolume, measured?: SphereStatistics | null): string {
  const sphere = sphereOf(annotation);
  if (!sphere) return t('annotation.invalidMeasurement');
  if (!measurableVolume(volume)) return t(volume.sourceFrameIndex !== undefined && volume.series.canReconstruct ? 'sphere.wholeVolume' : 'sphere.notMeasurable');
  const quantity = quantitativeScale(volume.series);
  const stats = measured === undefined && hasPixels(volume) ? sphereStatisticsFor(annotation, volume, quantity) : measured;
  const metabolic = measured === undefined && hasPixels(volume) && annotation.threshold ? thresholdVolumeFor(annotation, volume, quantity) : measured?.metabolic;
  return stats ? formatSphereStatistics(stats, metabolic, sulGluGlucose(volume.series, quantity.unit)) : t('sphere.noVoxels');
}

export function annotationSummary(annotation: Annotation, volume: ViewVolume): string {
  if (annotation.type === 'sphere') return sphereSummary(annotation, volume);
  const points = annotation.points;
  const needsPixels = ['probe', 'rectangle', 'ellipse', 'polygon'].includes(annotation.type);
  const source = annotation.mode === 'source' ? annotationSourceFrame(annotation, volume, needsPixels) : null;
  if (annotation.mode === 'source' && !source) return t('annotation.sourceUnavailable');
  const series = source?.series ?? volume.series;
  const measurement = measurementSpace(series);
  const measurePoints = measurement.unit === 'mm' ? points : points.map(point => worldToIndex(series, point));
  if (annotation.type === 'length' && points.length >= 2) {
    const length = distanceMm(measurePoints[0], measurePoints[1]);
    return length == null ? t('annotation.invalidMeasurement') : `${format(length * measurement.scale)} ${measurement.unit}`;
  }
  if (annotation.type === 'angle' && points.length >= 3) {
    const angularPoints = series.spacingKnown === true ? points : points.map(point => worldToIndex(series, point));
    const angle = angleDegrees(angularPoints[0], angularPoints[1], angularPoints[2]);
    return angle == null ? t('annotation.undefinedAngle') : `${format(angle)}°`;
  }
  if (annotation.type === 'cobb' && points.length >= 4) {
    const angularPoints = series.spacingKnown === true ? points : points.map(point => worldToIndex(series, point));
    const angle = cobbAngleDegrees(angularPoints);
    return angle == null ? t('annotation.undefinedCobb') : `${format(angle)}${t('annotation.cobbSuffix')}`;
  }
  if (annotation.type === 'polyline') {
    const length = polylineLengthMm(measurePoints);
    return length == null ? '' : `${format(length * measurement.scale)} ${measurement.unit}`;
  }
  if (needsPixels && !hasPixels(volume)) return t('annotation.sourceUnavailable');
  if (annotation.type === 'probe' && points.length && hasPixels(volume)) {
    if (series.components === 3) return t('annotation.noScalar');
    let value: number | null;
    if (source) {
      const point = worldToIndex(series, points[0]), [nx, ny] = series.dimensions;
      if (!valid(point) || Math.abs(point[2]) > 1e-4 || point[0] < -0.5 || point[0] > nx - 0.5 || point[1] < -0.5 || point[1] > ny - 0.5) return t('annotation.outsideSource');
      const x = Math.max(0, Math.min(nx - 1, Math.round(point[0]))), y = Math.max(0, Math.min(ny - 1, Math.round(point[1])));
      value = volume.data[source.offset + y * nx + x];
      if (isPaddingValue(series, value)) return t('annotation.padding');
    } else {
      const nearest = nearestSourceSample(volume, points[0]);
      value = nearest?.value ?? null;
      if (nearest && isPaddingValue(volume.series, nearest.value, nearest.frame)) return t('annotation.padding');
    }
    const quantity = quantitativeScale(series);
    if (value == null) return t('annotation.outsideImage');
    if (!Number.isFinite(value)) return t('annotation.nonFinite');
    const converted = value * quantity.factor;
    return Number.isFinite(converted) ? quantityText(converted, quantity.unit) : t('annotation.quantityUnavailable');
  }
  if (hasPixels(volume) && ['rectangle', 'ellipse', 'polygon'].includes(annotation.type)) {
    const stats = roiStatistics(annotation, volume);
    if (!stats) return points.length >= 3 ? t('annotation.noRoiSamples') : '';
    return formatRoiStatistics(stats);
  }
  return annotation.label || '';
}

/** What a PET (or SPECT) fused over the image gives at a probe or inside a region drawn on it, where the drawing lies in
 * the patient: the value of the PET voxel at the probe, or the maximum and mean of the PET voxels the region covers on
 * the drawing's plane (its hottest voxel, as SUVmax is read). Empty for other drawings. */
export function fusedPetSummary(annotation: Annotation, pet: ViewVolume, measured?: SphereStatistics | null): string {
  if (pet.series.components === 3 || !annotation.points.length) return '';
  const quantity = quantitativeScale(pet.series), digits = quantityDigits(quantity.unit);
  const modality = overlayKind(pet.series);
  if (annotation.type === 'probe' && hasPixels(pet)) {
    const sampled = sampleVolume(pet, annotation.points[0]);
    const value = sampled == null ? NaN : sampled * quantity.factor;
    return Number.isFinite(value) ? t('roi.petValue', { modality, value: format(value, digits), unit: quantity.unit }) : '';
  }
  if (annotation.type === 'sphere') {
    // A sphere drawn on the CT measures the PET's own voxels inside it, as one drawn on the PET does.
    const sphere = sphereOf(annotation), stats = measured !== undefined ? measured : sphere && hasPixels(pet) && measurableVolume(pet) ? sphereStatisticsFor(annotation, pet, quantity) : null;
    if (!stats) return '';
    const values = { modality, unit: stats.unit, max: formatSphereValue(stats.max, digits), mean: formatSphereValue(stats.mean, digits) };
    const line = stats.peak
      ? t('sphere.petLine', { ...values, name: peakName(stats.unit), peak: formatSphereValue(stats.peak.value, digits) })
      : [t('roi.petRegion', values), isSuv(stats.unit) && t('sphere.noPeak', { name: peakName(stats.unit) })].filter(Boolean).join(' · ');
    const corrected = sphereSulGlu(stats, sulGluGlucose(pet.series, quantity.unit));
    return corrected ? `${line} · ${corrected}` : line;
  }
  if (!hasPixels(pet) || !['rectangle', 'ellipse', 'polygon'].includes(annotation.type)) return '';
  // The PET is read on the drawing's own plane, whichever slices of the image it was drawn on.
  const stats = roiStatistics({ ...annotation, mode: 'mpr' }, pet, 50_000);
  if (!stats) return '';
  return formatFusedRegion(stats, pet.series);
}

export function formatFusedRegion(stats: RoiStatistics, series: Series): string {
  const modality = overlayKind(series), digits = quantityDigits(stats.unit);
  return t(stats.sampling === 'derived-interpolated' ? 'roi.petRegionSampled' : 'roi.petRegion',
    { modality, unit: stats.unit, max: format(stats.max, digits), mean: format(stats.mean, digits) });
}

/** Preserve source-pixel locations when calibration changes patient-space coordinates. */
export function remapAnnotationCoordinates(annotation: Annotation, previousSeries: Series, nextSeries: Series): Annotation {
  return { ...annotation, points: annotation.points.map(point => indexToWorld(nextSeries, worldToIndex(previousSeries, point))) };
}

/** True when `view` (as drawn: renderedView) shows the measurement: its own acquired frame, or a reconstructed plane
 * holding all its points (within half a slice); a whole-volume MIP shows none. The viewport draws exactly these and
 * "Delete on slice" removes exactly these, whatever plane, tilt or slice number the measurement was recorded with. */
export function shownOnView(annotation: Annotation, series: Series, view: ViewState, frame: PlaneFrame = getPlaneFrame(series, view)): boolean {
  if (!annotation.points.length || isProjection(series, view)) return false;
  if (annotation.type === 'sphere') {
    const sphere = sphereOf(annotation);
    return !!sphere && !!sphereSection(sphere, frame);
  }
  if (annotation.mode === 'source') return usesSourceFrames(series, view) && annotationSourceIndex(annotation, series) === view.slice
    && annotation.points.every(point => Math.abs(dot(subtract(point, frame.center), frame.normal)) < 1e-3);
  if (annotation.plane !== view.plane) return false;
  return annotation.points.every(point => Math.abs(dot(subtract(point, frame.center), frame.normal)) < Math.max(0.01, frame.step * 0.51));
}

/** The view that shows a measurement again ("Go to"): its acquired frame, or its plane with the tilt it was drawn on.
 * Either ends a whole-volume MIP, which shows no measurements. */
export function viewOfAnnotation(annotation: Annotation, sourceIndex: number | null): Pick<ViewState, 'mode' | 'plane' | 'slice' | 'oblique' | 'projection'> {
  if (annotation.mode === 'source') return { mode: 'source', plane: annotation.plane, slice: sourceIndex ?? annotation.slice, oblique: undefined, projection: undefined };
  return { mode: 'mpr', plane: annotation.plane, slice: annotation.slice, oblique: annotation.oblique ? [annotation.oblique[0], annotation.oblique[1]] : [0, 0], projection: undefined };
}
