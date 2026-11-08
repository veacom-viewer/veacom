import { annotationOutline, combineSourceRegions, type Sample, type SampleTask, type StudyVolume } from '../domain/clinical';
import { sampleSeries } from '../api';
import type { Annotation, Series, SuvNormalization, Vec3, ViewState, ViewVolume as Volume } from '../model';
import { annotationSourceIndex, planePoints, voxelPlane, roiPlane, quantitativeScale, quantityText, type RoiStatistics } from './annotations';
import { isThresholdId, metabolicMask, SPHERE_VOXEL_LIMIT, sphereOf, type SphereStatistics, type ThresholdVolume } from './voi';
import { petTracer } from './petTracer';
import { t } from '../i18n';

import { getPlaneFrame, projectionPlane, isProjection, sourceFrameSeries, windowPlane, type WindowPlane } from './geometry';
import { usesSourceFrames } from './viewState';
import { overlayKind } from './emission';
type RegionShape = 'ellipse' | 'rectangle' | 'polygon';
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const count = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
const vector = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every(finite);
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object';
interface FrameRef { index: number; sopInstanceUid: string; sourceFrameNumber?: number }
export type SamplingOperation = { kind: 'sourceRegion'; frame?: FrameRef; voxelPlane?: {axis: number; index: number}; oblique?: {u: Vec3; v: Vec3}; shape: 'ellipse' | 'rectangle' | 'polygon';
  points: Vec3[]; normalization?: SuvNormalization; pixelUnits: boolean; measurementScale?: number }
  | { kind: 'planeRegion'; origin: Vec3; u: Vec3; v: Vec3; polygon: [number, number][]; shape: RegionShape;
      normalization?: SuvNormalization; pixelUnits: boolean; measurementScale?: number; maxSamples: number }
  | { kind: 'probe'; point: Vec3; frame?: FrameRef }
  | { kind: 'ray'; point: Vec3; normal: Vec3; right: Vec3; down: Vec3; reach: number; pick: boolean }
  | { kind: 'selection'; target: string; layerRevision: number; crop: import('./volume3d').CropBounds }
  | ({ kind: 'surface' } & import('./nativeVolume').SurfaceRequest)
  | { kind: 'window'; frame?: FrameRef; fullRange: boolean }
  | { kind: 'window'; frame?: FrameRef; plane?: WindowPlane; automatic: boolean }
  | { kind: 'sphere'; center: Vec3; radius: number; normalization?: SuvNormalization; threshold?: Annotation['threshold']; regionSeeds?: number[] }
  | { kind: 'assessment'; sets: { outline: Vec3[]; frame?: FrameRef }[] };

export function sourceFrameRef(series: Series, index: number): FrameRef {
  const meta = series.frameMetadata?.[index];
  return { index, sopInstanceUid: meta?.sopInstanceUid ?? '', sourceFrameNumber: meta?.sourceFrameNumber };
}

export async function measureWindow(series: Series, view: ViewState, automatic: boolean): Promise<Pick<ViewState, 'windowCenter' | 'windowWidth'> | null> {
  const frame = usesSourceFrames(series, view) ? sourceFrameRef(series, view.slice) : undefined;
  const plane = !frame && !isProjection(series, view) && !view.slab ? windowPlane(series, view) : undefined;
  const result = await sampleSeries(series, { kind: 'window', frame, plane, automatic });
  if (result === null) return null;
  const window = result as Pick<ViewState, 'windowCenter' | 'windowWidth'>;
  if (!Number.isFinite(window.windowCenter) || !Number.isFinite(window.windowWidth) || window.windowWidth < 1) throw new Error('Invalid window range.');
  return window;
}

export async function measureSourceRegion(annotation: Annotation, volume: StudyVolume): Promise<RoiStatistics | null> {
  const { series } = volume;
  const index = annotationSourceIndex(annotation, series);
  if ((volume.sourceFrameIndex !== undefined && volume.sourceFrameIndex !== index)
    || !['rectangle', 'ellipse', 'polygon'].includes(annotation.type) || series.components === 3) return null;
  if (annotation.mode === 'source' && index === null) return null;
  const plane = roiPlane(annotation, index === null ? series : sourceFrameSeries(series, index));
  if (!plane) return null;
  const points = planePoints(plane);
  const aligned = annotation.mode !== 'source' ? voxelPlane(points, series) : undefined;
  if (index === null && !series.canReconstruct) return null;
  const address = index !== null ? { frame: sourceFrameRef(series, index) } : aligned ? { voxelPlane: aligned } : { oblique: { u: plane.u, v: plane.v } };
  const result = await sampleSeries(series, { kind: 'sourceRegion', ...address,
    shape: annotation.type as 'rectangle' | 'ellipse' | 'polygon', points,
    normalization: series.suvNormalization, pixelUnits: series.measurementUnits === 'px', measurementScale: series.measurementScale });
  return validatedRegion(result, !('oblique' in address));
}

function validatedRegion(result: unknown, sourceOnly: boolean): RoiStatistics | null {
  if (result === null) return null;
  if (!object(result) || ![result.count, result.invalidCount, result.paddingCount, result.outsideCount].every(count)
    || !Number(result.count) || ![result.mean, result.min, result.max, result.area, result.standardDeviation].every(finite)
    || Number(result.min) > Number(result.max) || Number(result.area) < 0 || Number(result.standardDeviation) < 0
    || !Array.isArray(result.samplingStep) || result.samplingStep.length !== 2 || !result.samplingStep.every(n => finite(n) && n > 0)
    || typeof result.clipped !== 'boolean' || typeof result.downsampled !== 'boolean' || typeof result.unit !== 'string'
    || (result.sampling !== 'source-voxels' && (sourceOnly || result.sampling !== 'derived-interpolated'))
    || !((result.spatialUnit === 'px' && result.areaUnit === 'px²') || (result.spatialUnit === 'mm' && result.areaUnit === 'mm²'))) {
    throw new Error('Invalid region measurement.');
  }
  return { ...(result as unknown as RoiStatistics), unit: result.unit || t('annotation.valueUnit') };
}

export async function measureRegion(annotation: Annotation, volume: Volume, fused: boolean) {
  if (!fused && (annotation.mode === 'source' || !['PT', 'NM'].includes(volume.series.modality))) return measureSourceRegion(annotation, volume);
  const plane = roiPlane(fused ? { ...annotation, mode: 'mpr' } : annotation, volume.series);
  if (!plane || volume.series.components === 3 || !volume.series.canReconstruct) return null;
  return validatedRegion(await sampleSeries(volume.series, { kind: 'planeRegion', origin: plane.origin, u: plane.u, v: plane.v,
    polygon: plane.polygon, shape: annotation.type as RegionShape, normalization: volume.series.suvNormalization,
    pixelUnits: volume.series.measurementUnits === 'px', measurementScale: volume.series.measurementScale, maxSamples: fused ? 50_000 : 200_000 }), false);
}

export async function nativeProbe(series: Series, point: Vec3, frame?: number) {
  const result = await sampleSeries(series, { kind: 'probe', point, frame: frame === undefined ? undefined : sourceFrameRef(series, frame) });
  if (!object(result)) throw new Error('Invalid probe response.');
  if (result.status === 'value' && finite(result.value)) return { status: 'value' as const, value: result.value };
  if (result.status === 'outside' || result.status === 'padding' || result.status === 'nonFinite') return { status: result.status, value: null };
  throw new Error('Invalid probe response.');
}

export async function nativeRay(series: Series, view: { slice: number }, point: Vec3, pick: boolean) {
  const plane = getPlaneFrame(series, projectionPlane(series, view));
  const result = await sampleSeries(series, { kind: 'ray', point, normal: plane.normal, right: plane.u, down: plane.v,
    reach: (plane.slices + 1) * plane.step / 2, pick });
  if (result === null) return null;
  if (!object(result) || !vector(result.point) || !finite(result.value)) throw new Error('Invalid projection sample.');
  return { value: result.value, point: result.point };
}

export async function nativeWindow(series: Series, fullRange: boolean, index?: number) {
  const result = await sampleSeries(series, { kind: 'window', fullRange, frame: index === undefined ? undefined : sourceFrameRef(series, index) });
  if (result === null) return null;
  if (!object(result) || !finite(result.windowCenter) || !finite(result.windowWidth) || result.windowWidth < 1) throw new Error('Invalid display window.');
  return { windowCenter: result.windowCenter, windowWidth: result.windowWidth };
}

export async function nativeProbeLabel(annotation: Annotation, volume: Volume, fused: boolean) {
  if (volume.series.components === 3) return fused ? '' : t('annotation.noScalar');
  const source = !fused && annotation.mode === 'source';
  const frame = source ? annotationSourceIndex(annotation, volume.series) : undefined;
  if (frame === null) return t('annotation.sourceUnavailable');
  const result = await nativeProbe(volume.series, annotation.points[0], frame);
  if (result.value === null) {
    if (fused) return '';
    if (result.status === 'padding') return t('annotation.padding');
    if (result.status === 'nonFinite') return t('annotation.nonFinite');
    return t(source ? 'annotation.outsideSource' : 'annotation.outsideImage');
  }
  const { factor, unit } = quantitativeScale(volume.series);
  const value = result.value * factor;
  if (!Number.isFinite(value)) return fused ? '' : t('annotation.quantityUnavailable');
  return fused ? t('roi.petValue', { modality: overlayKind(volume.series), value: value.toFixed(/^SU[VL]/i.test(unit) ? 2 : 1), unit }) : quantityText(value, unit);
}

function readMetabolic(raw: unknown, series: Series, unit: string): ThresholdVolume | null {
  if (raw == null) return null;
  if (!object(raw) || !isThresholdId(raw.threshold) || !finite(raw.level) || raw.level <= 0 || !finite(raw.mean)
    || !finite(raw.mtvMl) || raw.mtvMl < 0 || !count(raw.count) || typeof raw.selectionRequired !== 'boolean'
    || !vector(raw.first) || !raw.first.every(count) || !vector(raw.size)
    || !raw.size.every((n, axis) => Number.isSafeInteger(n) && n > 0 && n + (raw.first as Vec3)[axis] <= series.dimensions[axis])
    || !Array.isArray(raw.regions) || !Array.isArray(raw.maskWords)) throw new Error('Invalid metabolic volume.');
  const regions = raw.regions.map(region => {
    if (!object(region) || !count(region.seed) || !count(region.count) || !vector(region.at)) throw new Error('Invalid metabolic region.');
    return { seed: Number(region.seed), count: Number(region.count), at: region.at };
  });
  const length = raw.size[0] * raw.size[1] * raw.size[2];
  if (length > SPHERE_VOXEL_LIMIT || raw.maskWords.length !== (regions.length ? Math.ceil(length / 32) : 0)) throw new Error('Invalid metabolic mask.');
  let mask = null;
  if (regions.length) {
    const labels = new Uint8Array(length);
    for (const [i, word] of raw.maskWords.entries()) {
      if (!Number.isInteger(word) || word < 0 || word > 0xffffffff) throw new Error('Invalid metabolic mask.');
      for (let bits = word >>> 0; bits; bits = (bits & (bits - 1)) >>> 0) {
        const index = i * 32 + 31 - Math.clz32(bits & -bits);
        if (index >= length) throw new Error('Invalid metabolic mask.');
        labels[index] = 1;
      }
    }
    mask = metabolicMask(series, raw.first, raw.size, labels);
  }
  const tlg = petTracer(series.petAcquisition) === 'fdg' && !raw.selectionRequired ? raw.mtvMl * raw.mean : undefined;
  return { threshold: raw.threshold, level: raw.level, count: Number(raw.count), mtvMl: raw.mtvMl, mean: raw.mean,
    tlg, unit, regions, selectionRequired: raw.selectionRequired, mask };
}

export async function measureNativeSphere(annotation: Annotation, volume: Volume, normalization = volume.series.suvNormalization): Promise<SphereStatistics | null> {
  const sphere = sphereOf(annotation);
  if (!sphere) return null;
  const result = await sampleSeries(volume.series, { kind: 'sphere', ...sphere, normalization, threshold: annotation.threshold, regionSeeds: annotation.regionSeeds });
  if (result === null) return null;
  const stats = result as SphereStatistics;
  if (!object(result) || ![stats.count, stats.paddingCount, stats.invalidCount].every(count) || stats.count <= 0 || typeof stats.unit !== 'string' || typeof stats.clipped !== 'boolean'
    || !Array.isArray(stats.maxAt) || stats.maxAt.length !== 3
    || ![stats.mean, stats.max, stats.min, stats.standardDeviation, stats.volumeMl, stats.diameterMm, ...stats.maxAt].every(Number.isFinite)
    || (stats.peak && (!Number.isFinite(stats.peak.value) || !vector(stats.peak.at)))) throw new Error('Invalid sphere measurement.');
  return { ...stats, unit: stats.unit || t('annotation.valueUnit'), metabolic: readMetabolic(result.metabolic, volume.series, stats.unit) };
}

export async function measureAssessmentTask(volume: StudyVolume, task: SampleTask): Promise<Sample | null> {
  if (task.mode === 'source') {
    const stats: (RoiStatistics | null)[] = [];
    for (const item of task.annotations) stats.push(await measureSourceRegion(item, volume));
    return combineSourceRegions(stats);
  }
  const sets = task.annotations.map(item => {
    const index = item.sourceFrame ?? volume.sourceFrameIndex;
    return { outline: annotationOutline(item), frame: index === undefined ? undefined : sourceFrameRef(volume.series, index) };
  });
  const result = await sampleSeries(volume.series, { kind: 'assessment', sets });
  if (result === null) return null;
  const sample = result as Sample;
  if (!object(result) || sample.sampling !== 'derived-nearest' || ![sample.mean, sample.min, sample.max, sample.std, sample.coverage].every(Number.isFinite)
    || ![sample.samples, sample.voxels, sample.outsideSamples, sample.invalidSamples, sample.paddingSamples].every(count) || sample.coverage < 0 || sample.coverage > 1 || sample.samples < 1) throw new Error('Invalid assessment sample.');
  return sample;
}
