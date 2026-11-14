import { useSyncExternalStore } from 'react';
import type { Annotation, PixelArray, Series, Volume } from '../model';
import { annotationSourceIndex, annotationSummary, formatRoiStatistics, withCalibration } from './annotations';
import { sourceFrameSeries, worldToIndex } from './geometry';
import { measureSourceRegion } from './nativeMeasurements';
import { requestSourceRoi } from './roiStatisticsService';
import { t, type Locale } from '../i18n';
import { useLocale } from '../i18n/react';

interface SummaryEntry {
  text: string;
  state: 'idle' | 'pending' | 'ready' | 'error';
  listeners: Set<() => void>;
  annotation?: Annotation;
  volume?: Volume;
  /** The series the region is measured on: a projection film's names its calibration after the area. */
  frame?: Series;
  cancel?: () => void;
  cancelTimer?: ReturnType<typeof setTimeout>;
  generation: number;
  touched: number;
}
const cache = new WeakMap<PixelArray, Map<string, SummaryEntry>>();
const sync = (text: string): SummaryEntry => ({ text, state: 'ready', listeners: new Set(), generation: 0, touched: 0 });

function largeSourceRegion(annotation: Annotation, volume: Volume): number | null {
  if (annotation.mode !== 'source' || !['rectangle', 'ellipse', 'polygon'].includes(annotation.type) || volume.series.components === 3) return null;
  const index = annotationSourceIndex(annotation, volume.series);
  if (index === null || (volume.sourceFrameIndex !== undefined && volume.sourceFrameIndex !== index)) return null;
  const frame = sourceFrameSeries(volume.series, index), [width, height] = frame.dimensions;
  const points = annotation.points.map(point => worldToIndex(frame, point));
  const xs = points.map(point => point[0]), ys = points.map(point => point[1]);
  const columns = Math.max(0, Math.min(width - 1, Math.floor(Math.max(...xs))) - Math.max(0, Math.ceil(Math.min(...xs))) + 1);
  const rows = Math.max(0, Math.min(height - 1, Math.floor(Math.max(...ys))) - Math.max(0, Math.ceil(Math.min(...ys))) + 1);
  const complexity = annotation.type === 'polygon' ? Math.max(1, points.length / 8) : 1;
  return columns * rows * complexity > 262_144 ? index : null;
}

function createEntry(annotation: Annotation, volume: Volume, locale: Locale): SummaryEntry {
  const native = volume.series.sourceRevision && volume.series.components === 1 && ['rectangle', 'ellipse', 'polygon'].includes(annotation.type);
  const frameIndex = native ? annotationSourceIndex(annotation, volume.series) : largeSourceRegion(annotation, volume);
  if (!native && frameIndex === null) {

    try { return sync(annotationSummary(annotation, volume)); } catch { return sync(t('annotation.unavailable')); }
  }
  const frame = frameIndex === null ? volume.series : sourceFrameSeries(volume.series, frameIndex);
  const metadata = frameIndex === null ? undefined : volume.series.frameMetadata?.[frameIndex];
  const key = JSON.stringify([locale, annotation.id, annotation.type, annotation.mode, annotation.plane, annotation.oblique, annotation.points,
    annotation.sourceSopInstanceUid, annotation.sourceFrameNumber, frameIndex, volume.sourceFrameIndex, volume.series.id, volume.series.uid, volume.series.engineGeneration, volume.series.sourceRevision,
    metadata?.sopInstanceUid, metadata?.sourceFrameNumber, frame.origin, frame.direction, frame.spacing, frame.dimensions,
    frame.paddingRange, frame.paddingIsNaN, frame.pixelType, frame.spacingKnown, frame.measurementScale, frame.measurementUnits, frame.modality, frame.valueUnit, frame.suvFactor,
    frame.sulFactor, frame.suvBsaFactor, frame.suvNormalization, frame.projection?.basis, frame.projection?.magnification]);
  let entries = cache.get(volume.data);
  if (!entries) { entries = new Map(); cache.set(volume.data, entries); }
  let entry = entries.get(key);
  if (!entry) {
    if (entries.size >= 128) {
      const idle = [...entries].filter(([, value]) => value.listeners.size === 0).sort((a, b) => a[1].touched - b[1].touched).at(0);
      if (idle) { idle[1].cancel?.(); entries.delete(idle[0]); }
    }
    entry = { text: t('annotation.calculating'), state: 'idle', listeners: new Set(), annotation, volume, frame, generation: 0, touched: performance.now() };
    entries.set(key, entry);
  }
  entry.touched = performance.now();
  return entry;
}

function start(entry: SummaryEntry): void {
  if (entry.state !== 'idle' || !entry.annotation || !entry.volume) return;
  entry.state = 'pending';
  const generation = ++entry.generation;
  try {
    const request = entry.volume.series.sourceRevision
      ? { promise: measureSourceRegion(entry.annotation, entry.volume), cancel: undefined }
      : requestSourceRoi(entry.annotation, entry.volume);
    entry.cancel = request.cancel;
    request.promise.then(stats => {
      if (generation !== entry.generation) return;
      entry.cancel = undefined;
      try { entry.text = stats ? (entry.frame ? withCalibration(formatRoiStatistics(stats), entry.frame, stats.spatialUnit) : formatRoiStatistics(stats)) : t('annotation.noRoiSamples'); entry.state = 'ready'; }
      catch { entry.state = 'error'; entry.text = t('annotation.failed'); }
      for (const listener of entry.listeners) listener();
    }, () => {
      if (generation !== entry.generation) return;
      entry.cancel = undefined; entry.state = 'error'; entry.text = t('annotation.failed');
      for (const listener of entry.listeners) listener();
    });
  } catch {
    entry.state = 'error'; entry.text = t('annotation.failed');
    for (const listener of entry.listeners) listener();
  }
}

function subscribeEntry(entry: SummaryEntry, listener: () => void): () => void {
  if (entry.cancelTimer) { clearTimeout(entry.cancelTimer); entry.cancelTimer = undefined; }
  entry.listeners.add(listener); start(entry);
  return () => {
    entry.listeners.delete(listener);
    if (!entry.listeners.size && entry.state === 'pending' && entry.cancel) entry.cancelTimer = setTimeout(() => {
      entry.cancelTimer = undefined;
      if (entry.listeners.size || entry.state !== 'pending') return;
      entry.generation++; entry.cancel?.(); entry.cancel = undefined; entry.state = 'idle'; entry.text = t('annotation.calculating');
    }, 0);
  };
}

// Small ROIs are measured synchronously. Reuse the result while its immutable inputs are alive.
const summaries = new WeakMap<Volume, WeakMap<Annotation, { locale: Locale; entry: SummaryEntry }>>();
const empty = sync('');

function entryFor(annotation: Annotation, volume: Volume | undefined, locale: Locale): SummaryEntry {
  if (!volume) return empty;
  let byAnnotation = summaries.get(volume);
  if (!byAnnotation) { byAnnotation = new WeakMap(); summaries.set(volume, byAnnotation); }
  const cached = byAnnotation.get(annotation);
  if (cached?.locale === locale) return cached.entry;
  const entry = createEntry(annotation, volume, locale);
  byAnnotation.set(annotation, { locale, entry });
  return entry;
}

/** The canvas and the measurement list subscribe to the same ROI computation. */
export function useAnnotationSummary(annotation: Annotation, volume: Volume | undefined): string {
  const entry = entryFor(annotation, volume, useLocale());
  const subscribe = (listener: () => void) => subscribeEntry(entry, listener);
  const snapshot = () => entry.text;
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function useAnnotationSummaries(annotations: readonly Annotation[], volume: Volume | undefined): readonly string[] {
  const locale = useLocale();
  const entries = annotations.map(annotation => entryFor(annotation, volume, locale));
  const subscribe = (listener: () => void) => {
    const stops = entries.map(entry => subscribeEntry(entry, listener));
    return () => stops.forEach(stop => stop());
  };
  const snapshot = () => entries.map(entry => entry.text).join('\u0000');
  const joined = useSyncExternalStore(subscribe, snapshot, snapshot);
  return entries.length ? joined.split('\u0000') : [];
}
