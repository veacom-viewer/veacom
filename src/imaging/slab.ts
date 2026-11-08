// Thick slab, as in VEAcom Next (Python: app/ui/slab.py): each slice of a reconstructed plane shown as the brightest
// (MIP), darkest (MinIP) or mean value of the slices around it, through a chosen thickness. Only the slice on screen
// is worked out, on the GPU; the volume is not copied. Measurements keep reading the voxels' own values.
//
// A slab of T mm takes the slices whose centres lie within T/2 of the slice shown, cut short at the ends of the volume.
import type { Plane, Series, Vec3, ViewState } from '../model';
import { getPlaneFrame, isProjection, projectionPlane, worldToIndexMatrix } from './geometry';

export type SlabMode = 'mip' | 'minip' | 'mean';
export const SLAB_MODES: readonly SlabMode[] = ['mip', 'minip', 'mean'];
export const SLAB_THICKNESSES = [5, 10, 20, 40] as const; // mm, as the menu offers them
export const DEFAULT_SLAB_THICKNESS = 10;
/** At most this many samples either side of the slice: a thicker slab is sampled more coarsely. */
export const MAX_SLAB_HALF = 64;

/** How many slices either side of the one shown the slab reaches. */
export function halfWidth(thickness: number, spacing: number): number {
  if (!(spacing > 0)) return 0;
  return Math.max(0, Math.floor(thickness / 2 / spacing + 1e-6));
}

/** The plane a series was acquired in: the one its slices face. */
export function acquiredPlane(series: Series): Plane {
  const d = series.direction, k: Vec3 = [d[2], d[5], d[8]];
  const axis = [0, 1, 2].reduce((best, i) => Math.abs(k[i]) > Math.abs(k[best]) ? i : best, 0);
  return axis === 0 ? 'sagittal' : axis === 1 ? 'coronal' : 'axial';
}

/** A whole-volume projection's samples either side of its plane, at most: its own shader program has this bound, so
 * the slab programs above keep theirs. */
export const MAX_PROJECTION_HALF = 256;

/** One sample's step along a frame's normal, in the volume's index space. */
function indexStep(series: Series, normal: Vec3, spacing: number): Vec3 {
  const m = worldToIndexMatrix(series);
  return [0, 1, 2].map(row => (m[row * 3] * normal[0] + m[row * 3 + 1] * normal[1] + m[row * 3 + 2] * normal[2]) * spacing) as Vec3;
}

/** The samples of a whole-volume MIP: through the whole depth either side of the plane through the centre, half a voxel
 * apart (coarser only past MAX_PROJECTION_HALF), so a lesion of one voxel is not read low. */
export function projectionSampling(series: Series, view: Pick<ViewState, 'slice'>): { mode: number; half: number; step: Vec3 } {
  const frame = getPlaneFrame(series, projectionPlane(series, view));
  const reach = (frame.slices - 1) / 2 * frame.step + frame.step;
  let spacing = frame.step / 2, half = Math.ceil(reach / spacing - 1e-6);
  if (half > MAX_PROJECTION_HALF) { spacing = reach / MAX_PROJECTION_HALF; half = MAX_PROJECTION_HALF; }
  return { mode: 1, half, step: indexStep(series, frame.normal, spacing) };
}

/** What the renderer needs for the slab of a reconstructed view: its mode (1 MIP, 2 MinIP, 3 mean), how many samples
 * either side, and one sample's step in the volume's index space. Mode 0 when the view has no slab. */
export function slabSampling(series: Series, view: ViewState): { mode: number; half: number; step: Vec3 } {
  if (isProjection(series, view)) return projectionSampling(series, view);
  if (!view.slab) return { mode: 0, half: 0, step: [0, 0, 0] };
  const frame = getPlaneFrame(series, view);
  let spacing = frame.step, half = halfWidth(view.slab.thickness, spacing);
  if (half > MAX_SLAB_HALF) { spacing = view.slab.thickness / 2 / MAX_SLAB_HALF; half = MAX_SLAB_HALF; }
  return { mode: SLAB_MODES.indexOf(view.slab.mode) + 1, half, step: indexStep(series, frame.normal, spacing) };
}
