// Series in frames of reference of their own, aligned: two visits of one patient, or a PET and a CT or MR acquired
// apart. The engine finds the rigid transform between them from their pixels (native/src/registration.rs), and the
// reader can nudge it. An alignment belongs to a pair of frames of reference, not to the two series registered, so the
// CTs of two PET/CT visits aligned once place their PETs too. Pixels are never resampled: drawing, linking, the
// crosshair and the fused readings map points through the transform, and each series is read in its own voxels.
import type { EngineRegistration, FusionSettings, Plane, Series, Vec3 } from '../model';
import { indexToWorld, type PlaneFrame } from './geometry';
import { samePatient, shareFrame } from './linking';
import { angleOf, applyPoint, applyVector, compose, displacement, IDENTITY, invert, isIdentity, isMatrix, rotation, translation, type Matrix } from './rigid';

export interface Alignment {
  /** Frames of reference: a point of `moving`'s patient coordinates lies at `matrix` × p in `fixed`'s. */
  fixed: string; moving: string;
  /** The series registered (the CTs of two visits, or a PET and the CT it was laid over), named in notices. */
  fixedSeriesId: string; movingSeriesId: string;
  /** The engine's transform, the reader's nudges after it (in the fixed frame), and the two together. */
  found: Matrix; nudge: Matrix; matrix: Matrix;
  /** Normalised mutual information (0 unrelated, 1 identical) aligned and with the two coordinates taken as one, and
   * the share of the fixed series inside the moving one (native/README.md). */
  similarity: number; similarityBefore: number; overlap: number;
  /** The middle of the moving series in its patient coordinates, where how far it moved is measured. */
  centre: Vec3;
}

/** Key an alignment by patient and frame, since different patients can reuse a frame UID. */
export const frameOf = (series: Series): string | null =>
  series.canReconstruct && series.orientationKnown === true && series.patientKey && series.frameOfReferenceUid
    ? JSON.stringify([series.patientKey, series.frameOfReferenceUid]) : null;

/** The engine's answer for `moving` laid over `fixed`, as an alignment of their frames; null when they share one. */
export function alignmentFrom(result: EngineRegistration, fixed: Series, moving: Series): Alignment | null {
  const fixedFrame = frameOf(fixed), movingFrame = frameOf(moving);
  if (!fixedFrame || !movingFrame || fixedFrame === movingFrame || !samePatient(fixed, moving) || !isMatrix(result.matrix)) return null;
  const centre = indexToWorld(moving, moving.dimensions.map(n => (n - 1) / 2) as Vec3);
  return { fixed: fixedFrame, moving: movingFrame, fixedSeriesId: fixed.id, movingSeriesId: moving.id,
    found: [...result.matrix], nudge: IDENTITY, matrix: [...result.matrix],
    similarity: result.similarity, similarityBefore: result.similarityBefore, overlap: result.overlap, centre };
}

const samePair = (a: Pick<Alignment, 'fixed' | 'moving'>, b: Pick<Alignment, 'fixed' | 'moving'>) =>
  (a.fixed === b.fixed && a.moving === b.moving) || (a.fixed === b.moving && a.moving === b.fixed);

/** The alignments with `next` in place of any between the same two frames. */
export const withAlignment = (alignments: readonly Alignment[], next: Alignment): Alignment[] => [...alignments.filter(item => !samePair(item, next)), next];
/** The alignments without the one between these two frames. */
export const withoutAlignment = (alignments: readonly Alignment[], pair: Pick<Alignment, 'fixed' | 'moving'>): Alignment[] => alignments.filter(item => !samePair(item, pair));

// Found transforms, per list of alignments (a new list whenever one changes) and pair of frames: the same matrix object
// each time, so what is drawn with it keeps its identity.
const paths = new WeakMap<readonly Alignment[], Map<string, Matrix | null>>();

/** The transform taking `from`'s patient coordinates to `to`'s: the identity in one frame of reference, through the
 * alignments (either way, and one after another) between two, null where none joins them. */
export function transformBetween(alignments: readonly Alignment[], from: Series, to: Series): Matrix | null {
  if (shareFrame(from, to)) return IDENTITY;
  if (!samePatient(from, to)) return null;
  const start = frameOf(from), end = frameOf(to);
  if (!start || !end) return null;
  let known = paths.get(alignments);
  if (!known) { known = new Map(); paths.set(alignments, known); }
  const key = `${start}\n${end}`;
  if (!known.has(key)) known.set(key, search(alignments, start, end));
  return known.get(key) ?? null;
}

/** Breadth first through the alignments, each one usable either way. */
function search(alignments: readonly Alignment[], start: string, end: string): Matrix | null {
  const reached = new Map<string, Matrix>([[start, IDENTITY]]);
  const queue = [start];
  while (queue.length) {
    const frame = queue.shift()!, so = reached.get(frame)!;
    for (const item of alignments) {
      const step = item.moving === frame ? { to: item.fixed, matrix: item.matrix } : item.fixed === frame ? { to: item.moving, matrix: invert(item.matrix) } : null;
      if (!step || reached.has(step.to)) continue;
      const matrix = compose(step.matrix, so);
      if (step.to === end) return matrix;
      reached.set(step.to, matrix);
      queue.push(step.to);
    }
  }
  return null;
}

/** Of two series in frames of their own, the transform between them once aligned; null in one frame, or unaligned. */
export const alignedTransform = (alignments: readonly Alignment[], from: Series, to: Series): Matrix | null =>
  shareFrame(from, to) ? null : transformBetween(alignments, from, to);

/** The alignment that places `series` against another frame, the one it moves first. */
export const alignmentOf = (alignments: readonly Alignment[], series: Series): Alignment | null => {
  const frame = frameOf(series);
  return frame ? alignments.find(item => item.moving === frame) ?? alignments.find(item => item.fixed === frame) ?? null : null;
};

const mapped = new WeakMap<Matrix, WeakMap<Vec3, Vec3>>();
/** `point` in the other frame; the same array for the same point and matrix, so a pane is not redrawn for nothing. */
export function mapPoint(matrix: Matrix, point: Vec3): Vec3 {
  if (isIdentity(matrix)) return point;
  let byPoint = mapped.get(matrix);
  if (!byPoint) { byPoint = new WeakMap(); mapped.set(matrix, byPoint); }
  let found = byPoint.get(point);
  if (!found) { found = applyPoint(matrix, point); byPoint.set(point, found); }
  return found;
}

/** A displayed plane taken into another frame of reference: where it lies and which way it faces there. */
export const frameThrough = (frame: PlaneFrame, matrix: Matrix): PlaneFrame => ({ ...frame, center: applyPoint(matrix, frame.center),
  u: applyVector(matrix, frame.u), v: applyVector(matrix, frame.v), normal: applyVector(matrix, frame.normal) });

const fused = new WeakMap<FusionSettings, WeakMap<Matrix, FusionSettings>>();
/** The fusion as a pane draws it: the overlay read through `transform` from the pane's coordinates. The same object for
 * the same fusion and transform, so the pane redraws only when one of them changes. */
export function alignedFusion(fusion: FusionSettings, transform: Matrix): FusionSettings {
  if (isIdentity(transform)) return fusion;
  let byMatrix = fused.get(fusion);
  if (!byMatrix) { byMatrix = new WeakMap(); fused.set(fusion, byMatrix); }
  let found = byMatrix.get(transform);
  if (!found) { found = { ...fusion, transform }; byMatrix.set(transform, found); }
  return found;
}

/** One of the reader's nudges: a shift in mm along patient LPS, or a turn in a plane, clockwise as the plane is shown
 * (axial seen from the feet, coronal from the front, sagittal from the patient's left, as getPlaneFrame draws them). */
export type Nudge = { shift: Vec3 } | { turn: Plane; clockwise: boolean };
export const NUDGE_MM = 1, NUDGE_DEGREES = 0.5;

/** A nudge as a transform of the fixed frame, turning about `pivot`. On screen right is +x and down +y in an axial pane,
 * +x and −z in a coronal one, +y and −z in a sagittal one: clockwise turns right towards down. */
export function nudgeStep(nudge: Nudge, pivot: Vec3): Matrix {
  if ('shift' in nudge) return translation(nudge.shift);
  const degrees = nudge.clockwise ? NUDGE_DEGREES : -NUDGE_DEGREES;
  return nudge.turn === 'axial' ? rotation(2, degrees, pivot) : nudge.turn === 'coronal' ? rotation(1, degrees, pivot) : rotation(0, -degrees, pivot);
}

/** The alignment with the reader's `step` (a shift or a turn, in the fixed frame) after it. */
export function nudged(alignment: Alignment, step: Matrix): Alignment {
  const nudge = compose(step, alignment.nudge);
  return { ...alignment, nudge, matrix: compose(nudge, alignment.found) };
}
/** Back to what the engine found. */
export const automatic = (alignment: Alignment): Alignment => ({ ...alignment, nudge: IDENTITY, matrix: alignment.found });
export const adjusted = (alignment: Alignment) => !isIdentity(alignment.nudge);

/** How far the alignment moves the moving series (at its middle, in mm) and how far it turns it (degrees). */
export function movement(alignment: Alignment): { shift: number; angle: number } {
  return { shift: displacement(alignment.matrix, alignment.centre), angle: angleOf(alignment.matrix) };
}

/** What limits how far an alignment can be trusted, from what the engine measured: aligned, the two images match no
 * better than in their own coordinates; or little of the fixed series lies inside the moving one. */
export type AlignmentCaution = 'noBetter' | 'littleOverlap';
export function alignmentCautions(alignment: Alignment): AlignmentCaution[] {
  return [
    ...(alignment.similarity <= alignment.similarityBefore ? ['noBetter' as const] : []),
    ...(alignment.overlap < 0.3 ? ['littleOverlap' as const] : []),
  ];
}
