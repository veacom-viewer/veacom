import { useSyncExternalStore } from 'react';
import { hasPixels, type Annotation, type ViewVolume, type Volume } from '../model';
import { annotationSourceIndex, annotationSummary, formatFusedRegion, formatRoiStatistics, fusedPetSummary, sphereSummary } from './annotations';
import { useMeasuredSpheres } from './useMeasuredSpheres';
import { measureRegion, nativeProbeLabel } from './nativeMeasurements';
import { sourceFrameSeries, worldToIndex } from './geometry';
import { requestSourceRoi } from './roiStatisticsService';
import { t, type Locale } from '../i18n';
import { useLocale } from '../i18n/react';

interface Entry {
  text: string;
  listeners: Set<() => void>;
  run?: () => Promise<string>;
  pending?: boolean;
  failures?: number;
  retryAt?: number;
  timer?: ReturnType<typeof setTimeout>;
}
interface Cached { locale: Locale; labels: Map<boolean, Entry> }
const cache = new WeakMap<ViewVolume, WeakMap<Annotation, Cached>>();
const empty: Entry = { text: '', listeners: new Set() };

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

function labelFor(item: Annotation, volume: ViewVolume, fused: boolean): string | (() => Promise<string>) {
  if (!volume.series.sourceRevision) {
    if (!fused && hasPixels(volume) && largeSourceRegion(item, volume) !== null) return async () => {
      const stats = await requestSourceRoi(item, volume).promise;
      return stats ? formatRoiStatistics(stats) : t('annotation.noRoiSamples');
    };
    return fused ? fusedPetSummary(item, volume) : annotationSummary(item, volume);
  }
  if (item.type === 'probe' || ['rectangle', 'ellipse', 'polygon'].includes(item.type)) {
    if (!item.points.length) return '';
    if (!fused && item.mode === 'source') {
      const index = annotationSourceIndex(item, volume.series);
      if (index === null || (volume.sourceFrameIndex !== undefined && index !== volume.sourceFrameIndex)) return t('annotation.sourceUnavailable');
    }
    if (item.type === 'probe') return () => nativeProbeLabel(item, volume, fused);
    if (volume.series.components === 3) return fused ? '' : t('annotation.noRoiSamples');
    return async () => {
      const result = await measureRegion(item, volume, fused);
      if (fused) return result ? formatFusedRegion(result, volume.series) : '';
      return result ? formatRoiStatistics(result) : t('annotation.noRoiSamples');
    };
  }
  return fused ? '' : annotationSummary(item, volume);
}

function entryFor(item: Annotation, volume: ViewVolume | undefined, locale: Locale, fused: boolean): Entry {
  if (!volume || item.type === 'sphere') return empty;
  let items = cache.get(volume);
  if (!items) { items = new WeakMap(); cache.set(volume, items); }
  let known = items.get(item);
  if (known?.locale !== locale) { known = { locale, labels: new Map() }; items.set(item, known); }
  let entry = known.labels.get(fused);
  if (!entry) {
    const label = labelFor(item, volume, fused);
    entry = typeof label === 'string' ? { text: label, listeners: new Set() }
      : { text: t('annotation.calculating'), run: label, listeners: new Set() };
    known.labels.set(fused, entry);
  }
  return entry;
}

function measureWhileVisible(entry: Entry) {
  if (!entry.run || !entry.listeners.size || entry.pending || entry.timer) return;
  const delay = (entry.retryAt ?? 0) - Date.now();
  if (delay > 0) {
    entry.timer = setTimeout(() => { entry.timer = undefined; measureWhileVisible(entry); }, delay);
    return;
  }
  entry.pending = true;
  void entry.run().then(text => {
    entry.text = text;
    entry.run = undefined;
  }, () => {
    entry.failures = (entry.failures ?? 0) + 1;
    if (entry.failures >= 3) entry.text = t('annotation.failed');
    const backoff = entry.failures === 1 ? 250 : entry.failures === 2 ? 1000 : 5000;
    entry.retryAt = Date.now() + backoff;
  }).finally(() => {
    entry.pending = false;
    for (const listener of entry.listeners) listener();
    measureWhileVisible(entry);
  });
}

export function useAnnotationSummary(annotation: Annotation, volume: ViewVolume | undefined): string {
  return useAnnotationSummaries([annotation], volume)[0];
}

export function useAnnotationSummaries(items: readonly Annotation[], volume?: ViewVolume, fused = false): readonly string[] {
  const locale = useLocale();
  const spheres = useMeasuredSpheres(items, volume);
  const entries = items.map(item => entryFor(item, volume, locale, fused));
  const subscribe = (listener: () => void) => {
    for (const entry of entries) {
      entry.listeners.add(listener);
      measureWhileVisible(entry);
    }
    return () => {
      for (const entry of entries) {
        entry.listeners.delete(listener);
        if (!entry.listeners.size && entry.timer) { clearTimeout(entry.timer); entry.timer = undefined; }
      }
    };
  };
  const snapshot = () => entries.map(entry => entry.text).join('\u0000');
  const labels = useSyncExternalStore(subscribe, snapshot, snapshot).split('\u0000');
  return items.map((item, i) => {
    if (item.type !== 'sphere' || !volume) return labels[i];
    const measured = spheres.get(item);
    if (measured?.state === 'idle' || measured?.state === 'pending') return fused ? '' : t('annotation.calculating');
    if (measured?.state === 'error') return t('annotation.failed');
    return fused ? fusedPetSummary(item, volume, measured?.result ?? null) : sphereSummary(item, volume, measured?.result ?? null);
  });
}
