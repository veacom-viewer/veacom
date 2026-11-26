import type { Volume } from '../model';

/** A retired browser render can keep its series index. The live cache or an active reader owns the actual volume. */
export class VolumeIndex {
  private readonly entries = new Map<string, WeakRef<Volume>>();

  constructor(volumes: ReadonlyMap<string, Volume>) {
    for (const [id, volume] of volumes) this.entries.set(id, new WeakRef(volume));
  }

  get(id: string): Volume | undefined { return this.entries.get(id)?.deref(); }

  *[Symbol.iterator](): IterableIterator<[string, Volume]> {
    for (const [id, entry] of this.entries) {
      const volume = entry.deref();
      if (volume) yield [id, volume];
    }
  }
}

export const INACTIVE_VOLUME_BUDGET = 512 * 1024 * 1024;

/** Visible and assessment volumes stay resident outside the inactive cache budget. */
export function trimInactiveVolumes(
  volumes: Map<string, Volume>,
  pinned: ReadonlySet<string>,
  lastAccess: ReadonlyMap<string, number>,
  budget = INACTIVE_VOLUME_BUDGET,
): { volumes: Map<string, Volume>; evicted: string[] } {
  let inactiveBytes = 0;
  const inactive: string[] = [];
  for (const [id, volume] of volumes) {
    if (pinned.has(id)) continue;
    inactiveBytes += volume.data.byteLength;
    inactive.push(id);
  }
  if (inactiveBytes <= budget) return { volumes, evicted: [] };

  inactive.sort((a, b) => (lastAccess.get(a) ?? 0) - (lastAccess.get(b) ?? 0));
  const next = new Map(volumes);
  const evicted: string[] = [];
  for (const id of inactive) {
    if (inactiveBytes <= budget) break;
    inactiveBytes -= next.get(id)!.data.byteLength;
    next.delete(id);
    evicted.push(id);
  }
  return { volumes: next, evicted };
}
