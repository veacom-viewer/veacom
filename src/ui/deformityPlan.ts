// One film's plan, measured: what the panel lists and the pane draws, from the store (deformityStore.ts), the film's
// calibration (imaging/radiograph.ts) and the kernel (imaging/deformity). Also where the kit's image pixels lie in the
// viewer's patient coordinates, and how a moved fragment is shown as a view of the same film.
import type { Series, Vec3, ViewState } from '../model';
import { indexToWorld, screenMapping, sub, worldToIndex, worldToScreen, type ScreenMapping } from '../imaging/geometry';
import { millimetresPerPixel, projectionOf } from '../imaging/radiograph';
import { coras, malalignmentTest, type Cora, type Step } from '../imaging/deformity/analysis';
import { lateralOnImage, measureLeg, type Leg, type LegInput } from '../imaging/deformity/measure';
import { fragmentFor, moved, paleyRule, simulate, type Osteotomy, type Simulation } from '../imaging/deformity/osteotomy';
import { CONTOUR_MAXIMUM, CONTOUR_MINIMUM, isContour, LANDMARKS, type LandmarkName } from '../imaging/deformity/landmarks';
import type { Point } from '../imaging/deformity/plane';
import { activePlan, withPlan, type FilmPlans, type LegPlan, type Placing } from './deformityStore';

export interface PlanView {
  film: FilmPlans; plan: LegPlan;
  mm: [number, number] | null;
  /** The leg's lateral side on the image, or null until the reader says which side is the patient's right. */
  lateral: Point | null;
  /** The film records no Patient Orientation: the reader is asked. */
  askRight: boolean;
  input: LegInput; leg: Leg;
  cora: { femur: Cora | null; tibia: Cora | null };
  steps: Step[];
  simulation: Simulation | null;
  rule: ReturnType<typeof paleyRule> | null;
}

export function planView(film: FilmPlans, series: Series, plan: LegPlan = activePlan(film)): PlanView {
  const mm = millimetresPerPixel(series), orientation = projectionOf(series)?.patientOrientation;
  const askRight = !orientation;
  const lateral = lateralOnImage(plan.side, askRight ? undefined : orientation, film.patientRight);
  const input: LegInput = { side: plan.side, points: plan.points, mmPerPixel: mm, lateral };
  const leg = measureLeg(input);
  const cora = coras(leg, mm, lateral);
  const osteotomy = plan.osteotomy;
  const simulation = osteotomy ? simulate(input, leg, osteotomy) : null;
  const bone = osteotomy ? cora[osteotomy.bone] : null;
  return { film, plan, mm, lateral, askRight, input, leg, cora, steps: malalignmentTest(leg, plan.points, mm, lateral), simulation,
    rule: osteotomy && bone ? paleyRule(osteotomy, bone, mm) : null };
}

/**
 * The side of the stored image (its x axis) that a side of the pane shows, through the view's turn and left-right flip:
 * the reader answers where the patient's right is from the film's R/L marker as the pane shows it, and the plan keeps
 * the image's side. Null while the pane is turned near a quarter, when its left and right are the image's top and
 * bottom. A pane's right edge runs along the image's +x by cos(turn), negated by a left-right flip (screenMapping).
 */
export function imageSideOnScreen(screen: 'left' | 'right', view: Pick<ViewState, 'rotation' | 'flipX'>): 'left' | 'right' | null {
  const along = Math.cos(view.rotation * Math.PI / 180) * (view.flipX ? -1 : 1);
  if (Math.abs(along) < 0.7) return null;
  return (along > 0) === (screen === 'right') ? 'right' : 'left';
}

/** Image pixels as the kit keeps them (DICOM image-relative: the first pixel's centre at 0.5, 0.5) in the viewer's
 * patient coordinates of a frame, and back. */
export const pixelToWorld = (frame: Series, p: Point): Vec3 => indexToWorld(frame, [p[0] - 0.5, p[1] - 0.5, 0]);
export function worldToPixel(frame: Series, world: Vec3): Point {
  const index = worldToIndex(frame, world);
  return [index[0] + 0.5, index[1] + 0.5];
}

/**
 * The view that draws the film with the fragment's motion applied: turned by the motion's angle and panned, so that
 * each point of the film lands where the motion takes it in the pane (`worldToScreen(mapping(result), p)` equals
 * `worldToScreen(mapping(view), T(p))`). The renderer then samples the film's own pixels; nothing is resampled into a
 * new image. `degrees` turns from the image's +x towards +y, as the view's rotation does.
 */
export function movedView(frame: Series, view: ViewState, size: [number, number], hinge: Point, hingeMoved: Point, degrees: number): ViewState {
  const before = screenMapping(frame, view, size[0], size[1]);
  const turned: ViewState = { ...view, rotation: view.rotation + degrees };
  const after = screenMapping(frame, turned, size[0], size[1]);
  const pivot = pixelToWorld(frame, hinge);
  // The pivot must land where the moved hinge is shown now.
  const target = worldToScreen(before, pixelToWorld(frame, hingeMoved)), current = worldToScreen(after, pivot);
  return { ...turned, pan: [view.pan[0] + target[0] - current[0], view.pan[1] + target[1] - current[1]] };
}

/** The screen point of an image pixel point in a pane. */
export const pixelToScreen = (frame: Series, mapping: ScreenMapping, p: Point): [number, number] => worldToScreen(mapping, pixelToWorld(frame, p));

/** The moved hinge and the motion's turn, ready for `movedView`; null without a simulation. */
export function fragmentView(view: PlanView): { hinge: Point; hingeMoved: Point; degrees: number } | null {
  const simulation = view.simulation, osteotomy = view.plan.osteotomy;
  if (!simulation || !osteotomy) return null;
  return { hinge: osteotomy.hinge, hingeMoved: moved(simulation.motion, osteotomy.hinge, view.mm), degrees: simulation.motion.degrees };
}

export { sub };

// Edits. Each returns the film as the reader's click or drag leaves it; the store makes it an Undo step.

/** The landmark the kit asks for after `name`: the next one in order that is not placed yet. */
export function nextLandmark(plan: LegPlan, after?: LandmarkName): LandmarkName | null {
  const start = after ? LANDMARKS.indexOf(after) + 1 : 0;
  const placed = (name: LandmarkName) => (plan.points[name]?.length ?? 0) >= (isContour(name) ? CONTOUR_MINIMUM : 1);
  return [...LANDMARKS.slice(start), ...LANDMARKS.slice(0, start)].find(name => !placed(name)) ?? null;
}

/** A click on the film while the kit asks for a point: the film after it, and what the next click places. */
export function place(film: FilmPlans, placing: Placing, point: Point, series: Series): { film: FilmPlans; placing: Placing | null } {
  const plan = activePlan(film);
  if (placing.kind === 'landmark') {
    const name = placing.name, contour = isContour(name);
    const points = contour ? [...(plan.points[name] ?? []), point].slice(0, CONTOUR_MAXIMUM) : [point];
    const provenance = contour ? [...(plan.provenance[name] ?? []), 'placed' as const].slice(0, CONTOUR_MAXIMUM) : ['placed' as const];
    const next = { ...plan, points: { ...plan.points, [name]: points }, provenance: { ...plan.provenance, [name]: provenance } };
    // The head's outline takes points until it has three; clicked again later, it takes more.
    const stay = contour && points.length < CONTOUR_MINIMUM;
    const following = stay ? name : nextLandmark(next, name);
    return { film: withPlan(film, next), placing: following ? { film: placing.film, kind: 'landmark', name: following } : null };
  }
  if (placing.kind === 'ball' || placing.kind === 'ruler') {
    const marker = film.marker?.method === placing.kind ? film.marker : { method: placing.kind, points: [], knownMm: placing.kind === 'ball' ? 25 : 100, depthConfirmed: false };
    const points = [...marker.points, point].slice(placing.kind === 'ruler' ? -2 : -8);
    const done = placing.kind === 'ruler' ? points.length === 2 : points.length === 8;
    return { film: { ...film, marker: { ...marker, points } }, placing: done ? null : placing };
  }
  if (!placing.first) return { film, placing: { ...placing, first: point } };
  const cut: [Point, Point] = [placing.first, point];
  const view = planView(film, series);
  const fragment = fragmentFor(cut, placing.bone, view.leg, view.mm);
  if (!fragment) return { film, placing: null };
  const osteotomy: Osteotomy = { bone: placing.bone, cut, hinge: point, wedge: plan.osteotomy?.wedge ?? 'opening', degrees: plan.osteotomy?.degrees ?? 0,
    direction: plan.osteotomy?.direction ?? 'valgus', shiftLateral: 0, shiftDistal: 0, lengthen: 0, fragment };
  return { film: withPlan(film, { ...plan, osteotomy }), placing: null };
}

/** What a handle on the film moves. */
export type Handle = { kind: 'landmark'; name: LandmarkName; index: number } | { kind: 'marker'; index: number }
  | { kind: 'cut'; index: 0 | 1 } | { kind: 'hinge' } | { kind: 'fragment'; index: number };

export function moveHandle(film: FilmPlans, handle: Handle, point: Point): FilmPlans {
  const plan = activePlan(film);
  if (handle.kind === 'landmark') {
    const points = [...(plan.points[handle.name] ?? [])], provenance = [...(plan.provenance[handle.name] ?? [])];
    if (handle.index >= points.length) return film;
    points[handle.index] = point; provenance[handle.index] = 'moved';
    return withPlan(film, { ...plan, points: { ...plan.points, [handle.name]: points }, provenance: { ...plan.provenance, [handle.name]: provenance } });
  }
  if (handle.kind === 'marker') {
    if (!film.marker || handle.index >= film.marker.points.length) return film;
    return { ...film, marker: { ...film.marker, points: film.marker.points.map((p, i) => i === handle.index ? point : p) } };
  }
  const osteotomy = plan.osteotomy;
  if (!osteotomy) return film;
  if (handle.kind === 'hinge') return withPlan(film, { ...plan, osteotomy: { ...osteotomy, hinge: point } });
  if (handle.kind === 'cut') {
    const cut: [Point, Point] = handle.index === 0 ? [point, osteotomy.cut[1]] : [osteotomy.cut[0], point];
    // The hinge follows the cut's hinge end while it sits on it.
    const onEnd = handle.index === 1 && osteotomy.hinge[0] === osteotomy.cut[1][0] && osteotomy.hinge[1] === osteotomy.cut[1][1];
    return withPlan(film, { ...plan, osteotomy: { ...osteotomy, cut, hinge: onEnd ? point : osteotomy.hinge } });
  }
  return withPlan(film, { ...plan, osteotomy: { ...osteotomy, fragment: osteotomy.fragment.map((p, i) => i === handle.index ? point : p) } });
}
