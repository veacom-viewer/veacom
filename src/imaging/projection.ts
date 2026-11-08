// A click on a whole-volume projection (MIP) goes to what made that pixel bright: the hottest voxel along the ray
// through it, searched a few millimetres round the ray so a slightly-off click still lands on a small lesion.
import type { Vec3, ViewState, Volume } from '../model';
import { add, getPlaneFrame, indexToWorld, projectionPlane, sampleVolume, scale, worldToIndex } from './geometry';

/** How far round the clicked ray the hottest voxel is looked for, in millimetres. */
export const PICK_RADIUS_MM = 4;

/** The centre of the hottest voxel within `radius` mm of the ray through `world` along the projection's view
 * direction; `world` itself when the ray meets no value. */
export function hottestAlongRay(volume: Volume, view: Pick<ViewState, 'slice'>, world: Vec3, radius = PICK_RADIUS_MM): Vec3 {
  const series = volume.series, { frame, step, reach } = rayWalk(volume, view);
  // The ray itself, then two rings round it.
  const offsets: Array<[number, number]> = [[0, 0]];
  for (const ring of [radius / 2, radius]) for (let k = 0; k < 8; k++) offsets.push([ring * Math.cos(k * Math.PI / 4), ring * Math.sin(k * Math.PI / 4)]);
  let best = -Infinity, hottest: Vec3 | null = null;
  for (const [du, dv] of offsets) {
    const start = add(world, add(scale(frame.u, du), scale(frame.v, dv)));
    for (let t = -reach; t <= reach; t += step) {
      const point = add(start, scale(frame.normal, t)), value = sampleVolume(volume, point);
      if (value === null || !Number.isFinite(value) || value <= best) continue;
      best = value; hottest = point;
    }
  }
  if (!hottest) return world;
  const index = worldToIndex(series, hottest).map(Math.round) as Vec3;
  return indexToWorld(series, index);
}

/** How a ray through a projection is walked: along its plane's normal, half a voxel at a time, through the whole depth. */
function rayWalk(volume: Volume, view: Pick<ViewState, 'slice'>) {
  const series = volume.series, frame = getPlaneFrame(series, projectionPlane(series, view));
  const voxel = Math.min(...series.spacing.filter(value => value > 0)), step = Math.max(0.25, voxel / 2);
  return { frame, step, reach: (frame.slices - 1) / 2 * frame.step + frame.step };
}

/** The stored value of the hottest voxel on the ray through `world` itself (what the MIP draws there, read from the
 * voxels), or null when the ray meets none. */
export function rayMaximum(volume: Volume, view: Pick<ViewState, 'slice'>, world: Vec3): number | null {
  const { frame, step, reach } = rayWalk(volume, view);
  let best = -Infinity;
  for (let t = -reach; t <= reach; t += step) {
    const value = sampleVolume(volume, add(world, scale(frame.normal, t)));
    if (value !== null && Number.isFinite(value) && value > best) best = value;
  }
  return best > -Infinity ? best : null;
}
