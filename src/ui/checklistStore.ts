// The pre-operative checklists' answers and notes, per study, while the viewer is open: closing the panel keeps them,
// and a caliper drawn on the image records into them. Nothing is written to disk: saving waits for the hospital's
// ethics, KVKK and data protection approval (docs/close-calipers.md).
import { checklistKind, recordCaliper, type CaliperNote, type ChecklistState, type Side, type SliceNote } from './preopChecklist';
import type { Series } from '../model';

const kept = new Map<string, ChecklistState>();
const listeners = new Set<() => void>();

/** The study's checklist as kept, if anything was marked or measured. */
export const keptChecklist = (study: string): ChecklistState | undefined => kept.get(study);

export function keepChecklist(study: string, state: ChecklistState): void {
  kept.set(study, state);
  for (const listener of [...listeners]) listener();
}

export function subscribeChecklists(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Records what a caliper drawn on `series` measured for `item` on `side` in that study's checklist. */
export function keepCaliper(study: string, series: Series, item: string, side: Side, note: SliceNote & { caliper: CaliperNote }): void {
  const state = kept.get(study) ?? { kind: checklistKind(series) ?? 'pns', answers: {}, notes: {} };
  keepChecklist(study, recordCaliper(state, item, side, note));
}

/** The note on `item` that a caliper drawing (by its annotation id) is recorded in, if any. */
export function caliperRecorded(study: string, item: string, annotationId: string): SliceNote | undefined {
  const notes = kept.get(study)?.notes[item];
  return notes && Object.values(notes).find(note => note.caliper?.annotationId === annotationId);
}
