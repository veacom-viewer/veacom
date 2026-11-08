// What a reader measured on a PET, kept per study on this computer (src/domain/petStudies.ts): the reference spheres
// and the lesion table. Put back on a PET series when it is loaded again, and saved whenever they change. A series is
// saved only after whatever was kept for it has been put back, so the first render after an import cannot overwrite it.
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { Annotation, Series, Volume } from '../model';
import { patientDigest, PET_STUDIES_STORAGE, priorRecord, readPetStudies, REFERENCE_ROLES, sameSeriesRecord, storedAcquisition, uidDigest, withPetSeries, withStudyGlucose,
  type PetSeriesRecord, type PetStudyRecords, type StoredLesion } from '../domain/petStudies';
import { sliceAtWorld } from './geometry';
import { isLesion, lesionValues, nameLesions, seriesRatios } from './lesions';
import { comparisonTracer } from './petTracer';
import { plausibleGlucose } from './glucose';
import { currentDeauville } from './deauvilleReading';
import { LIVER_REFERENCE_RADIUS_MM, measurableVolume, sphereOf, spherePoints } from './voi';

type Annotations = Record<string, Annotation[]>;
interface Keys {
  study: string; series: string; patient?: string; date: string;
  previousStudy: string; previousSeries: string; previousPatient?: string; uidOnly: string;
}

function readRecords(): PetStudyRecords | null {
  try { return readPetStudies(localStorage.getItem(PET_STUDIES_STORAGE)); } catch { return null; } // Storage may be disabled by the host.
}
function writeRecords(records: PetStudyRecords): boolean {
  try { localStorage.setItem(PET_STUDIES_STORAGE, JSON.stringify(records)); return true; } catch { return false; }
}

export const reconstructedSeriesDigest = (series: Pick<Series, 'uid' | 'id'>) => uidDigest(JSON.stringify([series.uid, series.id]));

export async function petStorageKeys(item: Series): Promise<Keys> {
  const [study, series, previousStudy, previousSeries, uidOnly, previousPatient] = await Promise.all([
    uidDigest(JSON.stringify([item.patientKey, item.studyUid])), reconstructedSeriesDigest(item), uidDigest(item.studyUid),
    reconstructedSeriesDigest({ uid: item.uid, id: item.previousPetId ?? item.id }), uidDigest(item.uid),
    item.patientId.trim() ? uidDigest(`${item.patientId.trim()}\u0000${item.patientName.trim().toUpperCase()}`) : undefined,
  ]);
  return { study, series, previousStudy, previousSeries, uidOnly, previousPatient, patient: patientDigest(item), date: item.studyDate };
}

/** Older builds used both reconstruction-specific and series-UID-only records. The reader confirms the destination. */
export function previousMeasurements(records: PetStudyRecords, key: Keys) {
  const old = records[key.previousStudy];
  const locations = [{ study: key.study, series: key.uidOnly }];
  if (old && (!old.patient || old.patient === key.previousPatient) && (!old.date || !key.date || old.date === key.date)) {
    locations.push({ study: key.previousStudy, series: key.previousSeries }, { study: key.previousStudy, series: key.uidOnly });
  }
  return locations.find(({ study, series }) => {
    const record = records[study]?.series[series];
    return record && (Object.keys(record.references).length || record.lesions?.length);
  });
}

/** What a series' measurements keep: its reference spheres, and its lesions with their values (from `volume`, the
 * series' whole volume). Null while lesions cannot be measured yet: the volume is still loading. */
export function seriesRecord(annotations: readonly Annotation[], series: Series, volume: Volume | undefined): PetSeriesRecord | null {
  const record: PetSeriesRecord = { references: {} };
  const acquisition = storedAcquisition(series.petAcquisition);
  if (acquisition) record.acquisition = acquisition;
  record.tracer = comparisonTracer(series.petAcquisition);
  for (const role of REFERENCE_ROLES) {
    const drawn = annotations.find(item => item.type === 'sphere' && item.role === role), sphere = drawn && sphereOf(drawn);
    if (drawn && sphere) record.references[role] = { id: drawn.id, center: sphere.center, radius: sphere.radius };
  }
  const lesions = annotations.filter(item => isLesion(item) && item.label && sphereOf(item));
  if (lesions.length) {
    if (!volume || !measurableVolume(volume)) return null;
    record.lesions = lesions.map(item => {
      const sphere = sphereOf(item)!, values = lesionValues(item, volume), lesion: StoredLesion = { id: item.id, name: item.label!, center: sphere.center, radius: sphere.radius };
      if (item.threshold) lesion.threshold = item.threshold;
      if (item.regionSeeds?.length) lesion.regionSeeds = item.regionSeeds;
      if (item.priorLesionId) lesion.priorLesionId = item.priorLesionId;
      if (item.fdgLymphoma) lesion.fdgLymphoma = true;
      const score = currentDeauville(item, annotations, volume);
      if (score !== undefined) { lesion.deauville = score; lesion.deauvilleBasis = item.deauvilleBasis; }
      if (values) lesion.values = values;
      return lesion;
    });
    Object.assign(record, seriesRatios(series));
  }
  return record;
}

/** The kept reference spheres and lesions as measurements on `series`. */
export function keptAnnotations(record: PetSeriesRecord, series: Series): Annotation[] {
  const slice = (center: [number, number, number]) => { try { return sliceAtWorld(series, 'axial', center); } catch { return 0; } };
  const sphere = (center: [number, number, number], radius: number, id?: string): Annotation => ({ id: id ?? crypto.randomUUID(), type: 'sphere', points: spherePoints(center, radius), plane: 'axial', slice: slice(center), mode: 'mpr' });
  return [
    ...REFERENCE_ROLES.flatMap(role => { const kept = record.references[role]; return kept ? [{ ...sphere(kept.center, role === 'liver' ? LIVER_REFERENCE_RADIUS_MM : kept.radius, kept.id), role }] : []; }),
    ...(record.lesions ?? []).map(lesion => ({ ...sphere(lesion.center, lesion.radius, lesion.id), label: lesion.name,
      ...(lesion.threshold ? { threshold: lesion.threshold } : {}), ...(lesion.regionSeeds ? { regionSeeds: lesion.regionSeeds } : {}),
      ...(lesion.priorLesionId ? { priorLesionId: lesion.priorLesionId } : {}), ...(lesion.fdgLymphoma ? { fdgLymphoma: true } : {}),
      ...(lesion.deauvilleBasis ? { deauville: lesion.deauville, deauvilleBasis: lesion.deauvilleBasis } : {}) })),
  ];
}

/** Keep edits made during restoration. A display name is never a lesion identifier. */
export function mergeRestored(existing: readonly Annotation[], restored: readonly Annotation[]): Annotation[] {
  const missing = restored.filter(item => !existing.some(other => other.id === item.id || (item.role && other.role === item.role)));
  const labels = new Set(missing.filter(isLesion).map(item => item.label));
  const edits = existing.map(item => isLesion(item) && labels.has(item.label) ? { ...item, label: undefined } : item);
  return nameLesions([...missing, ...edits]);
}

export function usePetRecords(series: readonly Series[], setAnnotations: Dispatch<SetStateAction<Annotations>>) {
  // Each PET series' digests, once its kept measurements are back (or it had none).
  const [keys, setKeys] = useState(() => new Map<string, Keys>());
  // What was last saved, or put back, for each series.
  const saved = useRef(new Map<string, PetSeriesRecord>());
  const [records, setRecords] = useState(readRecords);
  const [saveFailed, setSaveFailed] = useState(false);

  useEffect(() => {
    // A series that left the session is put back afresh if it comes again.
    const removed = [...keys.keys()].filter(id => !series.some(item => item.id === id));
    if (removed.length) {
      const next = new Map(keys);
      for (const id of removed) { next.delete(id); saved.current.delete(id); }
      setKeys(next);
      return;
    }
    const pending = series.filter(item => item.modality === 'PT' && !item.segmentation && item.patientKey && item.studyUid && item.uid && !keys.has(item.id));
    if (!pending.length) return;
    let cancelled = false;
    void Promise.all(pending.map(async item => ({ item, keys: await petStorageKeys(item) }))).then(found => {
      if (cancelled) return;
      const records = readRecords(), back: Annotations = {};
      if (!records) { setSaveFailed(true); return; }
      const nextKeys = new Map(keys);
      for (const { item, keys: own } of found) {
        const record = records[own.study]?.series[own.series];
        nextKeys.set(item.id, own);
        back[item.id] = record ? keptAnnotations(record, item) : [];
      }
      // What the reader marked meanwhile stays; only what is still missing comes back.
      if (Object.keys(back).length) setAnnotations(current => {
        let next = current;
        for (const [id, list] of Object.entries(back)) {
          next = { ...next, [id]: mergeRestored(current[id] ?? [], list) };
        }
        return next;
      });
      setKeys(nextKeys); setRecords(records);
    }).catch(() => { if (!cancelled) setSaveFailed(true); });
    return () => { cancelled = true; };
  }, [series, setAnnotations, keys]);

  const save = (next: PetStudyRecords | null) => {
    const ok = !!next && writeRecords(next);
    setSaveFailed(!ok);
    if (ok) setRecords(next);
    return ok;
  };
  const studyFor = (item: Series) => {
    const key = keys.get(item.id);
    return key && records?.[key.study];
  };
  const typedGlucose = (item: Series) => studyFor(item)?.glucose;
  const limitedView = (item: Series) => {
    const key = keys.get(item.id);
    return !!(key && records?.[key.study]?.series[key.series]?.limitedView);
  };
  const setGlucose = (item: Series, mmol: number | null) => {
    const key = keys.get(item.id);
    if (!key || (mmol !== null && !plausibleGlucose(mmol)) || plausibleGlucose(item.petAcquisition?.glucose)) return false;
    const records = readRecords();
    return save(records && withStudyGlucose(records, key.study, mmol, Date.now(), key));
  };
  const setLimitedView = (item: Series, limited: boolean) => {
    const key = keys.get(item.id), records = readRecords();
    if (!key || !records) return save(null);
    const record = { ...(records[key.study]?.series[key.series] ?? { references: {} }) };
    if (limited) record.limitedView = true;
    else delete record.limitedView;
    return save(withPetSeries(records, key.study, key.series, record, Date.now(), key));
  };
  return { keys, setKeys, saved, records, save, saveFailed, typedGlucose, limitedView, setGlucose, setLimitedView };
}

export function usePetStudies(series: readonly Series[], annotations: Annotations, setAnnotations: Dispatch<SetStateAction<Annotations>>,
  volumes: ReadonlyMap<string, Volume>, store: ReturnType<typeof usePetRecords>) {
  const { keys, saved, records, save, saveFailed } = store;

  useEffect(() => {
    let records: PetStudyRecords | null = null, changed = false;
    const pending = new Map<string, PetSeriesRecord>();
    for (const item of series) {
      const key = keys.get(item.id);
      // Only a series whose measurements exist in this session: one restored to a moment before it was loaded (Undo)
      // has none, and must not wipe what was kept.
      if (!key || !Object.hasOwn(annotations, item.id)) continue;
      const record = seriesRecord(annotations[item.id], item, volumes.get(item.id));
      if (!record || sameSeriesRecord(record, saved.current.get(item.id))) continue;
      if (!records) records = readRecords();
      if (!records) { save(null); return; }
      pending.set(item.id, record);
      const previous = records[key.study]?.series[key.series];
      const updated = previous?.limitedView ? { ...record, limitedView: true as const } : record;
      if (sameSeriesRecord(updated, previous)) continue;
      records = withPetSeries(records, key.study, key.series, updated, Date.now(), key);
      changed = true;
    }
    if (changed && !save(records)) return;
    for (const [id, record] of pending) saved.current.set(id, record);
  }, [annotations, series, volumes, keys, save, saved]);

  const keptPrior = (item: Series, live: Series | null) => {
    const key = keys.get(item.id), tracer = comparisonTracer(item.petAcquisition);
    if (!records || !key?.patient || !tracer) return null;
    if (live) {
      const prior = keys.get(live.id), study = prior && records[prior.study], record = prior && study?.series[prior.series];
      return prior?.patient === key.patient && record?.tracer === tracer ? { date: live.studyDate, series: record, glucose: study?.glucose } : null;
    }
    return priorRecord(records, key.patient, key.date, tracer, annotations[item.id]?.some(isLesion));
  };
  const legacyFor = (item: Series, records: PetStudyRecords | null) => {
    const key = keys.get(item.id);
    if (!key || !records || series.some(other => other.studyUid === item.studyUid && other.patientKey !== item.patientKey)) return;
    return previousMeasurements(records, key);
  };
  const hasLegacy = (item: Series) => Boolean(legacyFor(item, records));
  const restoreLegacy = (item: Series) => {
    const key = keys.get(item.id), current = readRecords();
    if (!current) { save(null); return; }
    const legacy = legacyFor(item, current);
    if (!key || !legacy) return;
    const previousStudy = current[legacy.study], old = previousStudy.series[legacy.series];
    const restored = keptAnnotations(old, item);
    const merged = mergeRestored(annotations[item.id] ?? [], restored);
    const record = seriesRecord(merged, item, volumes.get(item.id));
    if (!record) return;
    if (old.limitedView || current[key.study]?.series[key.series]?.limitedView) record.limitedView = true;
    let next = withPetSeries(current, legacy.study, legacy.series, null, Date.now());
    next = withPetSeries(next, key.study, key.series, record, Date.now(), key);
    if (next[key.study]?.glucose === undefined && previousStudy.glucose !== undefined) {
      next = withStudyGlucose(next, key.study, previousStudy.glucose, Date.now(), key);
    }
    if (!save(next)) return;
    setAnnotations(current => ({ ...current, [item.id]: mergeRestored(current[item.id] ?? [], restored) }));
  };
  return { keptPrior, hasLegacy, restoreLegacy, saveFailed };
}
