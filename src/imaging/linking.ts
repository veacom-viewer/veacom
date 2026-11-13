// How panes of one plane page together while linked, as in VEAcom Next (Python: app/ui/cursor_sync.py):
// by position when they share a frame of reference; slice for slice for the same patient's series of as many
// slices; and, once the reader links them by hand at the slices they show, by the millimetres the driving pane
// has gone since. Every step keeps its direction in the patient, whichever way each series is stored.
import type { Series, Vec3, ViewState } from '../model';
import { dot, getPlaneFrame, sameFacing, sliceCount, sourceFrameSeries, sub, worldToIndex } from './geometry';
import { usesSourceFrames } from './viewState';

export interface Pane { series: Series; view: ViewState }

const referenceFrame = (series: Series) => 'frameOfReferenceUid' in series ? String(series.frameOfReferenceUid || '') : '';

/** An anonymous acquisition has a native patient key scoped to this study. It cannot identify a prior. */
function spatialIdentity(a: Series, b: Series): boolean {
  return samePatient(a, b) || Boolean(!a.patientId && !b.patientId && !a.patientName && !b.patientName
    && a.studyUid && a.studyUid === b.studyUid && a.patientKey && a.patientKey === b.patientKey);
}

/** Two series drawn together (crosshair, linked positions, fusion): one reconstructed space, one frame of reference. */
export function shareFrame(a: Series, b: Series): boolean {
  return spatialIdentity(a, b) && (a.id === b.id || (a.canReconstruct && b.canReconstruct && a.orientationKnown === true && b.orientationKnown === true && !!referenceFrame(a) && referenceFrame(a) === referenceFrame(b)));
}
/** Where two panes were linked by hand: each one's series and slice then. */
export type Anchor = Record<string, { seriesId: string; slice: number }>;

function placed(pane: Pane): boolean {
  const frame = usesSourceFrames(pane.series, pane.view) ? sourceFrameSeries(pane.series, pane.view.slice) : pane.series;
  return frame.orientationKnown === true && frame.positionKnown !== false && frame.spacingKnown !== false;
}

/** The two displayed planes have measured patient coordinates in the same frame of reference. */
export function sharePlaneSpace(a: Pane, b: Pane): boolean {
  return placed(a) && placed(b) && spatialIdentity(a.series, b.series) && (a.series.id === b.series.id ||
    Boolean(referenceFrame(a.series) && referenceFrame(a.series) === referenceFrame(b.series)));
}

export function facesSame(a: Pane, b: Pane): boolean {
  try { return sameFacing(getPlaneFrame(a.series, a.view).normal, getPlaneFrame(b.series, b.view).normal); }
  catch { return false; }
}

/** A corresponding slice only if the target stack covers the point. Never snap an outside point to an end slice. */
export function coveredSlice(pane: Pane, point: Vec3): number | null {
  const { series, view } = pane;
  const frame = getPlaneFrame(series, view);
  if (!usesSourceFrames(series, view)) {
    const index = Math.round((dot(point, frame.normal) - frame.minNormal) / frame.step);
    return index >= 0 && index < frame.slices ? index : null;
  }
  if (series.canReconstruct || !series.frameMetadata?.length) {
    const index = Math.round(worldToIndex(series, point)[2]);
    return index >= 0 && index < frame.slices ? index : null;
  }
  let best: number | null = null, distance = Infinity;
  for (const [index, meta] of series.frameMetadata.entries()) {
    if (!meta.positionKnown || !meta.orientationKnown || !meta.spacingKnown) continue;
    const m = meta.direction, delta = sub(point, meta.origin);
    const normal: Vec3 = [m[2], m[5], m[8]];
    if (!sameFacing(frame.normal, normal)) continue;
    const gap = Math.abs(dot(delta, normal));
    if (gap <= meta.spacing[2] / 2 + 1e-5 && gap < distance) { best = index; distance = gap; }
  }
  return best;
}

/** Which slice paging the source should show in another pane, if any. */
export function linkedSlice(source: Pane, target: Pane, point: Vec3, steps: number, anchor?: { source: number; target: number }): number | null {
  if (sharePlaneSpace(source, target)) return facesSame(source, target) ? coveredSlice(target, point) : null;
  if (!placed(source) && !placed(target) && unplaced(source.series) && unplaced(target.series)) {
    return inStep(source, target) ? stepTarget(source, target, steps) : null;
  }
  if (!facesSame(source, target)) return null;
  if (anchor) return followTarget(source, target, anchor, source.view.slice);
  return steps && inStep(source, target) ? stepTarget(source, target, steps) : null;
}

/** The same patient, known by ID or name: the same ID and the engine's patient key, which holds the name and birth
 * date too (native/src/patient.rs); without keys, the same ID and name in one study. */
export function samePatient(a: Series, b: Series): boolean {
  const id = [a.patientId.trim(), b.patientId.trim()], name = [a.patientName.trim().toUpperCase(), b.patientName.trim().toUpperCase()];
  if (id[0] !== id[1]) return false;
  if (a.patientKey || b.patientKey) return a.patientKey === b.patientKey && Boolean(id[0] || name[0]);
  if (name[0] !== name[1] || !(id[0] || name[0])) return false;
  return Boolean(a.studyUid && a.studyUid === b.studyUid);
}

/** Images with no place in the patient (PNG/JPEG pictures, or an unknown orientation): they page by image number. */
export const unplaced = (series: Series) => series.orientationKnown !== true;

/** Paged slice for slice: the same patient's series, as many slices in this plane, each with a known orientation;
 * or two series of pictures, image for image whatever their number (nothing else can line them up). */
export function inStep(a: Pane, b: Pane): boolean {
  if (unplaced(a.series) && unplaced(b.series)) {
    return (a.series.modality === 'OT' && b.series.modality === 'OT') || samePatient(a.series, b.series);
  }
  return a.series.orientationKnown === true && b.series.orientationKnown === true && samePatient(a.series, b.series)
    && sliceCount(a.series, a.view) === sliceCount(b.series, b.view);
}

/** One slice step of a pane in the patient: its direction and length (mm). */
function step(pane: Pane): { along: Vec3; gap: number } | null {
  if (sliceCount(pane.series, pane.view) < 2) return null;
  try {
    const d = sub(getPlaneFrame(pane.series, { ...pane.view, slice: 1 }).center, getPlaneFrame(pane.series, { ...pane.view, slice: 0 }).center);
    const gap = Math.hypot(...d);
    return gap > 1e-6 ? { along: [d[0] / gap, d[1] / gap, d[2] / gap], gap } : null;
  } catch { return null; }
}

/** +1 when a step forward goes the same way in both panes, -1 when the other way. */
function sameWay(source: Pane, target: Pane): number {
  const a = step(source), b = step(target);
  return a && b && dot(a.along, b.along) < 0 ? -1 : 1;
}

const clampSlice = (pane: Pane, slice: number) => Math.max(0, Math.min(sliceCount(pane.series, pane.view) - 1, slice));

/** The target's slice when the source, in step with it, moved `steps` slices. */
export function stepTarget(source: Pane, target: Pane, steps: number): number {
  return clampSlice(target, Math.round(target.view.slice) + steps * sameWay(source, target));
}

/** The target's slice when the source, linked by hand, is at `sourceSlice`: as many millimetres from where they were
 * linked, to the target's nearest slice (rounded half away from zero, so 8 x 0.5 mm make one 4 mm slice). */
export function followTarget(source: Pane, target: Pane, anchor: { source: number; target: number }, sourceSlice: number): number {
  const a = step(source), b = step(target);
  if (!a || !b) return Math.round(target.view.slice);
  const ratio = (sourceSlice - anchor.source) * a.gap / b.gap;
  const steps = Math.sign(ratio) * Math.floor(Math.abs(ratio) + 0.5 + 1e-6);
  return clampSlice(target, anchor.target + steps * sameWay(source, target));
}

export const pairKey = (a: string, b: string) => [a, b].sort().join('|');

/** The anchor of two panes, while each still shows the series it was linked with. */
export function anchorFor(anchors: ReadonlyMap<string, Anchor>, a: { id: string; seriesId: string }, b: { id: string; seriesId: string }): Anchor | null {
  const found = anchors.get(pairKey(a.id, b.id));
  return found && found[a.id]?.seriesId === a.seriesId && found[b.id]?.seriesId === b.seriesId ? found : null;
}
