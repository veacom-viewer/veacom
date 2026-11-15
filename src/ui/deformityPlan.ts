// One film's plan, measured: what the panel lists and the pane draws, from the store (deformityStore.ts), the film's
// calibration (imaging/radiograph.ts) and the kernel (imaging/deformity). Also where the kit's image pixels lie in the
// viewer's patient coordinates, and how a moved fragment is shown as a view of the same film.
import type { Series, Vec3, ViewState } from '../model';
import { indexToWorld, screenMapping, sub, worldToIndex, worldToScreen, type ScreenMapping } from '../imaging/geometry';
import { millimetresPerPixel, projectionOf } from '../imaging/radiograph';
import { coras, malalignmentTest, type Cora, type Step } from '../imaging/deformity/analysis';
import { lateralOnImage, measureLeg, type Leg, type LegInput, type Value } from '../imaging/deformity/measure';
import { fragmentFor, moved, paleyRule, simulate, type Osteotomy, type Simulation } from '../imaging/deformity/osteotomy';
import { CONTOUR_MAXIMUM, CONTOUR_MINIMUM, isContour, LANDMARKS, type LandmarkName } from '../imaging/deformity/landmarks';
import type { Point } from '../imaging/deformity/plane';
import { activePlan, withPlan, type FilmPlans, type LegPlan, type ModelRef, type Placing } from './deformityStore';

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
  return { film, plan, mm, lateral, askRight, input, leg, cora, steps: malalignmentTest(leg), simulation,
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

/** Whether a landmark has the points it needs. */
export const isPlaced = (plan: LegPlan, name: LandmarkName) => (plan.points[name]?.length ?? 0) >= (isContour(name) ? CONTOUR_MINIMUM : 1);

/** The landmark the kit asks for after `name`: the next one in order that is not placed yet and has no suggestion
 * waiting for the reader. */
export function nextLandmark(plan: LegPlan, after?: LandmarkName): LandmarkName | null {
  const start = after ? LANDMARKS.indexOf(after) + 1 : 0;
  return [...LANDMARKS.slice(start), ...LANDMARKS.slice(0, start)].find(name => !isPlaced(plan, name) && !plan.suggested?.points[name]) ?? null;
}

/** The plan without the suggestion of `name`. */
function withoutSuggestion(plan: LegPlan, name: LandmarkName): LegPlan {
  if (!plan.suggested?.points[name]) return plan;
  const { [name]: _gone, ...points } = plan.suggested.points;
  const unchecked = plan.suggested.unchecked?.filter(item => item !== name);
  return { ...plan, suggested: Object.keys(points).length ? { model: plan.suggested.model, points, ...(unchecked?.length ? { unchecked } : {}) } : undefined };
}

/** The model's suggestions put on the active plan, for the landmarks it has not placed: they replace earlier ones,
 * and each suggested landmark is marked as shown (the plan file's suggestionShown). `unchecked` names the landmarks
 * whose model channels have no check on real films. */
export function withSuggestions(film: FilmPlans, points: LegPlan['points'], model: ModelRef, unchecked: readonly LandmarkName[]): FilmPlans {
  const plan = activePlan(film);
  const names = LANDMARKS.filter(name => points[name]?.length && !isPlaced(plan, name));
  if (!names.length) return film;
  const origin = { ...plan.origin };
  for (const name of names) origin[name] = { ...origin[name], shown: true };
  const marked = names.filter(name => unchecked.includes(name));
  return withPlan(film, { ...plan, suggested: { model, points: Object.fromEntries(names.map(name => [name, points[name]])), ...(marked.length ? { unchecked: marked } : {}) }, origin });
}

/** The reader accepts suggestions as they are (one landmark, or all): they become the plan's landmarks, from the model. */
export function acceptSuggestions(film: FilmPlans, names?: LandmarkName[]): FilmPlans {
  let plan = activePlan(film);
  const suggested = plan.suggested;
  if (!suggested) return film;
  for (const name of names ?? LANDMARKS) {
    const points = suggested.points[name];
    if (!points) continue;
    plan = withoutSuggestion({ ...plan, points: { ...plan.points, [name]: points }, provenance: { ...plan.provenance, [name]: points.map(() => 'accepted' as const) },
      // The model's head is always the ring around its hip centre (suggest.ts kitSuggestions).
      origin: { ...plan.origin, [name]: { shown: true, model: suggested.model, ...(suggested.unchecked?.includes(name) ? { unchecked: true as const } : {}),
        ...(name === 'femoralHeadContour' ? { construction: 'hipCentreRing' as const } : {}) } } }, name);
  }
  return withPlan(film, plan);
}

/** Whether a landmark's points are the model's unchecked suggestion, accepted as it was: no reader has checked the
 * model's channel for it on real films, and this reader did not move it. */
export const uncheckedAsSuggested = (plan: LegPlan, name: LandmarkName) => Boolean(plan.origin?.[name]?.unchecked && plan.provenance[name]?.includes('accepted'));

/** The landmarks each value, step and CORA is measured from (measure.ts, analysis.ts). JLCA's sign also follows the leg's
 * axis, from any two of the hip, knee and ankle, which no single one of them decides. */
const HEAD = 'femoralHeadContour', KNEE = 'kneeCentre', ANKLE = 'ankleCentre';
const CONDYLES = ['femoralCondyleMedial', 'femoralCondyleLateral'] as const, PLATEAU = ['tibialPlateauMedial', 'tibialPlateauLateral'] as const;
const FEMORAL_SHAFT = ['femoralShaftProximal', 'femoralShaftDistal'] as const, PLAFOND = ['plafondMedial', 'plafondLateral'] as const;
export const MEASURED_FROM: Record<Value['key'] | 'subluxation' | 'coraFemur' | 'coraTibia', readonly LandmarkName[]> = {
  mLPFA: [HEAD, KNEE, 'greaterTrochanterTip'], mLDFA: [HEAD, KNEE, ...CONDYLES], aLDFA: [...FEMORAL_SHAFT, ...CONDYLES],
  MPTA: [KNEE, ANKLE, ...PLATEAU], LDTA: [KNEE, ANKLE, ...PLAFOND], JLCA: [...CONDYLES, ...PLATEAU], AMA: [HEAD, KNEE, ...FEMORAL_SHAFT],
  HKA: [HEAD, KNEE, ANKLE], MAD: [HEAD, KNEE, ANKLE], WBL: [HEAD, ANKLE, ...PLATEAU],
  femurLength: [HEAD, KNEE], tibiaLength: [KNEE, ANKLE], limbLength: [HEAD, ANKLE], subluxation: [...CONDYLES, ...PLATEAU],
  coraFemur: [HEAD, KNEE, ANKLE, 'greaterTrochanterTip', ...CONDYLES], coraTibia: [HEAD, KNEE, ANKLE, ...PLATEAU, ...PLAFOND],
};

/** The values (and CORAs) measured from a landmark that is still the model's unchecked suggestion as it was: each is
 * marked beside it, in the panel and the report, until the reader moves or places that landmark. */
export function fromUnchecked(plan: LegPlan): Set<keyof typeof MEASURED_FROM> {
  const keys = Object.keys(MEASURED_FROM) as Array<keyof typeof MEASURED_FROM>;
  return new Set(keys.filter(key => MEASURED_FROM[key].some(name => uncheckedAsSuggested(plan, name))));
}

/** A dragged suggestion, let go: the reader's landmark, the dragged point moved and the landmark's other points (the
 * head's outline) accepted as they were. */
export function settleMoved(film: FilmPlans, name: LandmarkName, index: number): FilmPlans {
  const accepted = acceptSuggestions(film, [name]), plan = activePlan(accepted), provenance = [...(plan.provenance[name] ?? [])];
  if (index >= provenance.length || accepted === film) return film;
  provenance[index] = 'moved';
  return withPlan(accepted, { ...plan, provenance: { ...plan.provenance, [name]: provenance } });
}

/** A suggested point put back on plan `planId` (active or not), as a drag that did not finish leaves it. */
export function putBackSuggestion(film: FilmPlans, planId: string, name: LandmarkName, index: number, point: Point): FilmPlans {
  const plan = film.plans.find(item => item.id === planId), suggested = plan?.suggested, points = suggested?.points[name];
  if (!plan || !suggested || !points || index >= points.length) return film;
  return withPlan(film, { ...plan, suggested: { ...suggested, points: { ...suggested.points, [name]: points.map((p, i) => i === index ? point : p) } } });
}

/** The suggestions taken off the active plan; landmarks already accepted stay. */
export function clearSuggestions(film: FilmPlans): FilmPlans {
  const plan = activePlan(film);
  return plan.suggested ? withPlan(film, { ...plan, suggested: undefined }) : film;
}

/** A click on the film while the kit asks for a point: the film after it, and what the next click places. */
export function place(film: FilmPlans, placing: Placing, point: Point, series: Series): { film: FilmPlans; placing: Placing | null } {
  const plan = activePlan(film);
  if (placing.kind === 'landmark') {
    const name = placing.name, contour = isContour(name);
    const points = contour ? [...(plan.points[name] ?? []), point].slice(0, CONTOUR_MAXIMUM) : [point];
    const provenance = contour ? [...(plan.provenance[name] ?? []), 'placed' as const].slice(0, CONTOUR_MAXIMUM) : ['placed' as const];
    // A point placed by hand replaces the landmark's suggestion. The landmark keeps its model only while points the
    // model gave remain (an outline taking one more point), and stays marked as shown a suggestion.
    const shown = plan.origin?.[name]?.shown || plan.suggested?.points[name], kept = contour ? plan.origin?.[name] : undefined;
    const entry = { ...(shown ? { shown: true as const } : {}), ...(kept?.model ? { model: kept.model } : {}), ...(kept?.model && kept.unchecked ? { unchecked: true as const } : {}),
      ...(kept?.construction ? { construction: kept.construction } : {}) };
    const { [name]: _replaced, ...others } = plan.origin ?? {};
    const origin = Object.keys(entry).length ? { ...others, [name]: entry } : others;
    const next = withoutSuggestion({ ...plan, points: { ...plan.points, [name]: points }, provenance: { ...plan.provenance, [name]: provenance }, origin }, name);
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

/** Where a drag of a handle began: the film (filmKey), its active plan, and the pointer. */
export interface DragContext { key: string; plan: string; pointer: number }
/** What a pointer move does to a drag: moves the point while it is on the film and plan it began on, with the same
 * pointer; another pointer is ignored; a drag whose film or plan changed under it (paged, or another plan) stops,
 * rather than writing a point measured on one film into another. */
export function dragContinues(held: DragContext, now: DragContext): 'move' | 'ignore' | 'stop' {
  if (now.pointer !== held.pointer) return 'ignore';
  return now.key === held.key && now.plan === held.plan ? 'move' : 'stop';
}

/** What a handle on the film moves. A suggestion dragged moves as a suggestion, and becomes the reader's landmark when it
 * is let go (settleMoved). */
export type Handle = { kind: 'landmark'; name: LandmarkName; index: number } | { kind: 'suggestion'; name: LandmarkName; index: number } | { kind: 'marker'; index: number }
  | { kind: 'cut'; index: 0 | 1 } | { kind: 'hinge' } | { kind: 'fragment'; index: number };

export function moveHandle(film: FilmPlans, handle: Handle, point: Point): FilmPlans {
  const plan = activePlan(film);
  if (handle.kind === 'suggestion') {
    // The suggestion itself moves, so the handle under the pointer stays the same element for the whole drag.
    const suggested = plan.suggested, points = suggested?.points[handle.name];
    if (!suggested || !points || handle.index >= points.length) return film;
    return withPlan(film, { ...plan, suggested: { ...suggested, points: { ...suggested.points, [handle.name]: points.map((p, i) => i === handle.index ? point : p) } } });
  }
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
