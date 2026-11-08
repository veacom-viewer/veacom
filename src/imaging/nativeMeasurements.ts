import { sampleSeries } from '../api';
import { t } from '../i18n';
import type { Annotation, Series, SuvNormalization, Vec3, ViewState, Volume } from '../model';
import { annotationSourceIndex, planePoints, roiPlane, voxelPlane, type RoiStatistics } from './annotations';
import { isProjection, sourceFrameSeries, windowPlane, type WindowPlane } from './geometry';
import { usesSourceFrames } from './viewState';

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const count = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object';
interface FrameRef { index: number; sopInstanceUid: string; sourceFrameNumber?: number }
export type SamplingOperation = { kind: 'sourceRegion'; frame?: FrameRef; voxelPlane?: {axis: number; index: number}; oblique?: {u: Vec3; v: Vec3}; shape: 'ellipse' | 'rectangle' | 'polygon';
  points: Vec3[]; normalization?: SuvNormalization; pixelUnits: boolean; measurementScale?: number }
  | { kind: 'window'; frame?: FrameRef; plane?: WindowPlane; automatic: boolean };

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

export async function measureSourceRegion(annotation: Annotation, volume: Volume): Promise<RoiStatistics | null> {
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
