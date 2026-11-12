// Where an import's series go in the series list: at the top. The study a reader has just opened is the first thing
// in the list, above the ones opened before it, which keep their order.
import type { Series } from '../model';

/** While an import runs: the series it has found so far lead the list, in the order found; the series listed before
 * the import (`listedBefore`) follow where they were. A series already in the list is updated in place. */
export function withFound(current: readonly Series[], found: readonly Series[], listedBefore: ReadonlySet<string>): Series[] {
  const latest = new Map(found.map(item => [item.id, item]));
  const listed = new Set(current.map(item => item.id));
  const updated = current.map(item => latest.get(item.id) ?? item);
  return [...updated.filter(item => !listedBefore.has(item.id)), ...found.filter(item => !listed.has(item.id)), ...updated.filter(item => listedBefore.has(item.id))];
}

/** When the import ends: its new series lead the list in its own catalogue order (`result`), whatever order they were
 * found in; the series listed before it follow where they were, as the import read them. A series found on the way
 * (`early`) that the import did not keep is gone. */
export function withImported(current: readonly Series[], result: readonly Series[], listedBefore: ReadonlySet<string>, early: Iterable<string>): Series[] {
  const latest = new Map(result.map(item => [item.id, item]));
  const placed = new Set([...result.map(item => item.id), ...early].filter(id => !listedBefore.has(id)));
  const kept = current.filter(item => !placed.has(item.id)).map(item => latest.get(item.id) ?? item);
  return [...result.filter(item => !listedBefore.has(item.id)), ...kept];
}
