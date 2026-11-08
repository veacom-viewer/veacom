import type { ViewVolume as Volume } from '../model';

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
    inactiveBytes += (volume.data?.byteLength ?? 0);
    inactive.push(id);
  }
  if (inactiveBytes <= budget) return { volumes, evicted: [] };

  inactive.sort((a, b) => (lastAccess.get(a) ?? 0) - (lastAccess.get(b) ?? 0));
  const next = new Map(volumes);
  const evicted: string[] = [];
  for (const id of inactive) {
    if (inactiveBytes <= budget) break;
    inactiveBytes -= (next.get(id)?.data?.byteLength ?? 0);
    next.delete(id);
    evicted.push(id);
  }
  return { volumes: next, evicted };
}
