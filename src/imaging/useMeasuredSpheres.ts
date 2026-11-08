import { useSyncExternalStore } from 'react';
import { hasPixels, type Annotation, type SuvNormalization, type ViewVolume } from '../model';
import { quantitativeScale } from './annotations';
import { measurableVolume, sphereOf, sphereStatisticsFor, thresholdVolumeFor, type SphereStatistics } from './voi';
import { measureNativeSphere } from './nativeMeasurements';

interface Entry {
  listeners: Set<() => void>;
  state: 'idle' | 'pending' | 'ready' | 'error';
  result: SphereStatistics | null;
  retryAfter?: number;
  promise?: Promise<SphereStatistics | null>;
}
const cache = new WeakMap<ViewVolume, WeakMap<Annotation, Map<SuvNormalization, Entry>>>();

function entryFor(item: Annotation, volume: ViewVolume, normalization: SuvNormalization) {
  let items = cache.get(volume);
  if (!items) { items = new WeakMap(); cache.set(volume, items); }
  let quantities = items.get(item);
  if (!quantities) { quantities = new Map(); items.set(item, quantities); }
  let entry = quantities.get(normalization);
  if (!entry) { entry = { listeners: new Set(), state: 'idle', result: null }; quantities.set(normalization, entry); }
  return entry;
}

export function resolveSphere(item: Annotation, volume: ViewVolume, normalization = volume.series.suvNormalization ?? 'bw') {
  const entry = entryFor(item, volume, normalization);
  if (!entry.promise) {
    entry.state = 'pending';
    const measure = () => measureNativeSphere(item, volume, normalization);
    const withRetry = async () => {
      if (!volume.series.sourceRevision && hasPixels(volume)) {
        const quantity = quantitativeScale({ ...volume.series, suvNormalization: normalization });
        const stats = sphereStatisticsFor(item, volume, quantity);
        return stats && { ...stats, metabolic: item.threshold ? thresholdVolumeFor(item, volume, quantity) : null };
      }
      for (const delay of [250, 1000]) {
        try { return await measure(); }
        catch { await new Promise(resolve => setTimeout(resolve, delay)); }
      }
      return measure();
    };
    entry.promise = withRetry().then(result => {
      entry.result = result;
      entry.state = 'ready';
      return result;
    }, error => {
      entry.promise = undefined;
      entry.state = 'error';
      entry.retryAfter = Date.now() + 5000;
      throw error;
    }).finally(() => {
      for (const listener of entry.listeners) listener();
    });
  }
  return entry.promise;
}

export function useMeasuredSpheres(items: readonly Annotation[], volume?: ViewVolume, normalization = volume?.series.suvNormalization ?? 'bw') {
  const entries = new Map<Annotation, Entry>();
  if (volume && measurableVolume(volume)) {
    for (const item of items) {
      if (item.type === 'sphere' && sphereOf(item)) entries.set(item, entryFor(item, volume, normalization));
    }
  }
  const subscribe = (notify: () => void) => {
    for (const [item, entry] of entries) {
      entry.listeners.add(notify);
      if (entry.state === 'idle' || (entry.state === 'error' && Date.now() >= (entry.retryAfter ?? 0))) void resolveSphere(item, volume!, normalization).catch(() => {});
    }
    return () => { for (const entry of entries.values()) entry.listeners.delete(notify); };
  };
  const snapshot = () => Array.from(entries.values(), entry => entry.state).join(',');
  useSyncExternalStore(subscribe, snapshot, snapshot);
  return entries;
}
