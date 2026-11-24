// Where each checklist item was last looked at, per plane: Show (src/components/PreopChecklist.tsx) goes back there when
// nothing is noted on that plane. Kept per study while the viewer is open, in memory only, as the checklists are.
import type { Plane } from '../model';
import type { SliceNote } from './preopChecklist';

/** At most this many places: a long day of studies cannot grow it without end. */
const LIMIT = 500;
const places = new Map<string, SliceNote>();
const placeKey = (study: string, item: string, plane: Plane) => JSON.stringify([study, item, plane]);

/** Remembers `note` as where `item` of `study` was last looked at on `plane`. */
export function rememberView(study: string, item: string, plane: Plane, note: SliceNote): void {
  const key = placeKey(study, item, plane);
  places.delete(key);
  places.set(key, note);
  if (places.size > LIMIT) places.delete(places.keys().next().value!);
}

/** Where `item` of `study` was last looked at on `plane`, if anywhere. */
export const rememberedView = (study: string, item: string, plane: Plane): SliceNote | undefined => places.get(placeKey(study, item, plane));
