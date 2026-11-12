// The series picked in the export window's "Selected series" list. A box over several series (the whole list, or one
// study) is ticked when all of them are picked and shows a dash when only some are; a click on it picks them all, or
// none of them when all were picked.

interface PickState {
  /** How many of the series are picked. */
  count: number;
  all: boolean;
  /** Some are picked, not all. */
  partial: boolean;
}

export function pickState(ids: readonly string[], picked: ReadonlySet<string>): PickState {
  const count = ids.filter(id => picked.has(id)).length;
  return { count, all: count > 0 && count === ids.length, partial: count > 0 && count < ids.length };
}

/** The picked series after a click on the box over `ids`: without them when all were picked, with all of them otherwise. */
export function togglePicked(picked: ReadonlySet<string>, ids: readonly string[]): Set<string> {
  const next = new Set(picked), remove = pickState(ids, picked).all;
  for (const id of ids) { if (remove) next.delete(id); else next.add(id); }
  return next;
}
