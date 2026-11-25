import { useEffect, useEffectEvent, useRef, useState } from 'react';
import type { Annotation, Series, Volume } from '../model';
import { calibrationEditId, measurementEdits, measurementScope, recoverCalibration, recoverMeasurement, saveCalibration, saveMeasurement, type CalibrationEdit, type RecoveryRecord } from '../domain/measurementRecovery';
import { readMeasurements, writeMeasurements } from '../domain/measurementDatabase';

type Edit = { id: string; drawing?: Annotation; calibration?: CalibrationEdit };
type Batch = { series: Series; edits: Edit[] };
type Read = { series: Series; edited?: Set<string> };

export function useMeasurementRecovery(volumes: Map<string, Volume>, active: Series | undefined, onRestore: (series: Series, drawings: Annotation[], calibration: CalibrationEdit[], edited: ReadonlySet<string>) => void) {
  const restore = useEffectEvent(onRestore);
  const reads = useRef(new Map<string, Read>());
  const readFailures = useRef(new Set<string>());
  const failed = useRef(new Map<string, Batch>());
  const writes = useRef(Promise.resolve());
  const pending = useRef(0);
  const loading = useRef(0);
  const [status, setStatus] = useState<'saved' | 'saving' | 'restoring' | 'failed'>('saved');
  const [attempt, setAttempt] = useState(0);

  function updateStatus() {
    setStatus(pending.current ? 'saving' : failed.current.size || readFailures.current.size ? 'failed' : loading.current ? 'restoring' : 'saved');
  }
  function enqueue(series: Series, edits: Edit[]) {
    if (!edits.length) return;
    const read = reads.current.get(series.id);
    for (const edit of edits) read?.edited?.add(edit.id);
    pending.current++;
    updateStatus();
    writes.current = writes.current.then(async () => {
      try {
        const scope = await measurementScope(series);
        if (!scope) throw new Error('Missing study identity');
        const changes = await Promise.all(edits.map(async (edit): Promise<{ id: string; put?: RecoveryRecord }> => {
          if (edit.calibration) return saveCalibration(series, scope, edit.calibration);
          return edit.drawing ? { id: edit.id, put: await saveMeasurement(series, scope, edit.drawing) } : { id: edit.id };
        }));
        await writeMeasurements(scope, changes.flatMap(e => e.put ? [e.put] : []), changes.filter(e => !e.put).map(e => e.id));
        const previous = failed.current.get(series.id);
        if (previous) {
          const completed = new Set(edits.map(e => e.id));
          previous.edits = previous.edits.filter(e => !completed.has(e.id));
          if (!previous.edits.length) failed.current.delete(series.id);
        }
      } catch {
        const outstanding = new Map(failed.current.get(series.id)?.edits.map(e => [e.id, e]));
        for (const edit of edits) outstanding.set(edit.id, edit);
        failed.current.set(series.id, { series, edits: [...outstanding.values()] });
      } finally { pending.current--; updateStatus(); }
    });
  }
  function save(series: Series, before: Annotation[], after: Annotation[]) {
    const { put, remove } = measurementEdits(series, before, after);
    enqueue(series, [...put.map(drawing => ({ id: drawing.id, drawing })), ...remove.map(id => ({ id }))]);
  }
  function calibrate(series: Series, changes: CalibrationEdit[]) {
    enqueue(series, changes.map(calibration => ({ id: calibrationEditId(series, calibration.frame), calibration })));
  }
  function retry() {
    for (const batch of failed.current.values()) enqueue(batch.series, batch.edits);
    for (const id of readFailures.current) reads.current.delete(id);
    setAttempt(n => n + 1);
  }

  useEffect(() => {
    // Begin with the selected catalog entry while its pixels are loading. The decoded series takes precedence.
    const candidates = new Map([...volumes].map(([id, volume]) => [id, volume.series]));
    if (active && !candidates.has(active.id)) candidates.set(active.id, active);
    for (const id of reads.current.keys()) if (!candidates.has(id)) {
      reads.current.delete(id);
      if (readFailures.current.delete(id)) updateStatus();
    }
    for (const [id, item] of candidates) {
      if (item.segmentation || reads.current.get(id)?.series === item) continue;
      const read: Read = { series: item };
      reads.current.set(id, read);
      const scope = measurementScope(item);
      if (!scope) continue;
      const edited = new Set<string>(); read.edited = edited;
      loading.current++; updateStatus();
      // A read started by a reopen follows earlier writes. Edits made during the read still win, including deletions.
      void Promise.all([scope, writes.current]).then(async ([key]) => {
        const rows = await readMeasurements(key);
        // Individual film calibrations take precedence over a scale recovered from a partially imported series.
        const calibrationRows = rows.filter(r => r && typeof r === 'object' && 'calibration' in r);
        const isSeriesScale = (r: unknown) => Boolean(r && typeof r === 'object' && 'frame' in r && r.frame === null);
        calibrationRows.sort((a, b) => Number(isSeriesScale(b)) - Number(isSeriesScale(a)));
        const [drawings, calibrations] = await Promise.all([
          Promise.all(rows.flatMap(r => r && typeof r === 'object' && 'drawing' in r ? [recoverMeasurement(item, key, r)] : [])),
          Promise.all(calibrationRows.map(r => recoverCalibration(item, key, r))),
        ]);
        if (reads.current.get(id) !== read) return;
        readFailures.current.delete(id);
        for (const edit of failed.current.get(id)?.edits ?? []) edited.add(edit.id);
        const back = drawings.filter((a): a is Annotation => a !== null && !edited.has(a.id));
        const scales = calibrations.flat().filter(c => !edited.has(calibrationEditId(item, c.frame)));
        restore(item, back, scales, edited);
      }).catch(() => {
        if (reads.current.get(id) !== read) return;
        readFailures.current.add(id);
      }).finally(() => { delete read.edited; loading.current--; updateStatus(); });
    }
  }, [volumes, active, attempt]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (pending.current || failed.current.size) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', warn);
    const entries = reads.current;
    return () => { entries.clear(); window.removeEventListener('beforeunload', warn); };
  }, []);
  return { save, calibrate, retry, status };
}
