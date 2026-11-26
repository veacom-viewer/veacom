// One film's plan, measured: what the panel lists and the pane draws, from the store (deformityStore.ts), the film's
// calibration (imaging/radiograph.ts) and the kernel (imaging/deformity). Also where the kit's image pixels lie in the
// viewer's patient coordinates, and how moved fragments are shown as views of the same film.
import type { Series, Vec3, ViewState } from '../model';
import { indexToWorld, screenMapping, sub, worldToIndex, worldToScreen, type ScreenMapping } from '../imaging/geometry';
import { millimetresPerPixel, projectionOf } from '../imaging/radiograph';
import { coras, malalignmentTest, type Cora, type Step } from '../imaging/deformity/analysis';
import { lateralOnImage, measureLeg, toImage, type Leg, type LegInput, type Value } from '../imaging/deformity/measure';
import {
  coraCut, fragmentFor, insertFragmentVertex, MAX_OSTEOTOMIES, moved, paleyRule, removeFragmentVertex,
  simulateMany, type CutSimulation, type MultiSimulation, type Osteotomy,
} from '../imaging/deformity/osteotomy';
import { CONTOUR_MAXIMUM, CONTOUR_MINIMUM, isContour, LANDMARKS, type LandmarkName } from '../imaging/deformity/landmarks';
import { dot, isIdentityRigid, type Point } from '../imaging/deformity/plane';
import { activeCutIndex, activePlan, newCutId, withPlan, type FilmPlans, type LegPlan, type ModelRef, type Placing } from './deformityStore';

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
  simulation: MultiSimulation | null;
  /** Paley rule per cut (in `plan.osteotomies` order; null without a CORA or calibration). */
  rules: Array<ReturnType<typeof paleyRule> | null>;
  /** Paley rule of the currently selected cut, or null. */
  rule: ReturnType<typeof paleyRule> | null;
}

export function planView(film: FilmPlans, series: Series, plan: LegPlan = activePlan(film)): PlanView {
  const mm = millimetresPerPixel(series), orientation = projectionOf(series)?.patientOrientation;
  const askRight = !orientation;
  const lateral = lateralOnImage(plan.side, askRight ? undefined : orientation, film.patientRight);
  const input: LegInput = { side: plan.side, points: plan.points, mmPerPixel: mm, lateral };
  const leg = measureLeg(input);
  const cora = coras(leg, mm, lateral);
  const simulation = plan.osteotomies.length ? simulateMany(input, leg, plan.osteotomies) : null;
  const rules = plan.osteotomies.map(cut => {
    const boneCora = cora[cut.bone];
    return boneCora ? paleyRule(cut, boneCora, mm) : null;
  });
  const selected = activeCutIndex(plan);
  return { film, plan, mm, lateral, askRight, input, leg, cora, steps: malalignmentTest(leg), simulation, rules, rule: selected >= 0 ? rules[selected] ?? null : null };
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
 * The view that draws the film with a fragment's motion applied: turned by the motion's angle and panned, so that
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

export interface FragmentLayer {
  cut: CutSimulation;
  hinge: Point;
  hingeMoved: Point;
  degrees: number;
  /** Whether this cut has non-zero local rotation or shift. */
  localMoving: boolean;
  /** Whether this fragment has non-zero cumulative rotation or shift. */
  moving: boolean;
}

/** Per-cut fragment layer parameters in proximal-to-distal order, ready for `movedView`. */
export function fragmentViews(view: PlanView): FragmentLayer[] {
  const simulation = view.simulation;
  if (!simulation) return [];
  return simulation.cuts.map(cut => {
    const hinge = toImage(cut.totalMotion.pivot, view.mm);
    const hingeMoved = moved(cut.totalMotion, hinge, view.mm);
    return {
      cut, hinge, hingeMoved, degrees: cut.totalMotion.degrees,
      localMoving: !isIdentityRigid(cut.localMotion),
      moving: !isIdentityRigid(cut.totalMotion),
    };
  });
}

/** The first cut's moved hinge and turn, ready for `movedView`; null without a simulation. */
export function fragmentView(view: PlanView): { hinge: Point; hingeMoved: Point; degrees: number } | null {
  const first = fragmentViews(view).at(0);
  return first ? { hinge: first.hinge, hingeMoved: first.hingeMoved, degrees: first.degrees } : null;
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

/** The landmarks each value, step and CORA is measured from (measure.ts, analysis.ts). The subluxation step measures
 * across the leg's axis, which any two of the hip, knee and ankle give: it counts all three (LEG_AXIS), though no single
 * one of them is needed. Where the axis only says which way is medial (JLCA's sign, a joint line's direction), it does
 * not count. */
const HEAD = 'femoralHeadContour', KNEE = 'kneeCentre', ANKLE = 'ankleCentre';
export const LEG_AXIS = [HEAD, KNEE, ANKLE] as const;
const CONDYLES = ['femoralCondyleMedial', 'femoralCondyleLateral'] as const, PLATEAU = ['tibialPlateauMedial', 'tibialPlateauLateral'] as const;
const FEMORAL_SHAFT = ['femoralShaftProximal', 'femoralShaftDistal'] as const, PLAFOND = ['plafondMedial', 'plafondLateral'] as const;
export const MEASURED_FROM: Record<Value['key'] | 'subluxation' | 'coraFemur' | 'coraTibia', readonly LandmarkName[]> = {
  mLPFA: [HEAD, KNEE, 'greaterTrochanterTip'], mLDFA: [HEAD, KNEE, ...CONDYLES], aLDFA: [...FEMORAL_SHAFT, ...CONDYLES],
  MPTA: [KNEE, ANKLE, ...PLATEAU], LDTA: [KNEE, ANKLE, ...PLAFOND], JLCA: [...CONDYLES, ...PLATEAU], AMA: [HEAD, KNEE, ...FEMORAL_SHAFT],
  HKA: [HEAD, KNEE, ANKLE], MAD: [HEAD, KNEE, ANKLE], WBL: [HEAD, ANKLE, ...PLATEAU],
  femurLength: [HEAD, KNEE], tibiaLength: [KNEE, ANKLE], limbLength: [HEAD, ANKLE], subluxation: [...CONDYLES, ...PLATEAU, ...LEG_AXIS],
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

/** Adds a cut to the active plan (up to MAX_OSTEOTOMIES) and selects it. */
function appendOsteotomy(film: FilmPlans, osteotomy: Osteotomy): FilmPlans {
  const plan = activePlan(film);
  if (plan.osteotomies.length >= MAX_OSTEOTOMIES) return film;
  const entry: Osteotomy = { ...osteotomy, id: osteotomy.id ?? newCutId() };
  const osteotomies = [...plan.osteotomies, entry];
  return withPlan(film, { ...plan, osteotomies, activeCut: osteotomies.length - 1 });
}

/** Pre-places a Paley Rule 1 osteotomy right at the bone's computed CORA. */
export function addCoraCut(film: FilmPlans, bone: 'femur' | 'tibia', series: Series, wedge: Osteotomy['wedge'] = 'opening'): FilmPlans {
  const plan = activePlan(film);
  if (plan.osteotomies.length >= MAX_OSTEOTOMIES) return film;
  const view = planView(film, series, plan);
  const cora = view.cora[bone];
  if (!cora) return film;
  const cut = coraCut(cora, view.leg, view.input, wedge);
  return cut ? appendOsteotomy(film, cut) : film;
}

/** Patches one osteotomy of the active plan. */
export function updateOsteotomy(film: FilmPlans, cutIndex: number, patch: Partial<Osteotomy>): FilmPlans {
  const plan = activePlan(film);
  if (cutIndex < 0 || cutIndex >= plan.osteotomies.length) return film;
  const osteotomies = plan.osteotomies.map((item, i) => i === cutIndex ? { ...item, ...patch } : item);
  return withPlan(film, { ...plan, osteotomies });
}

/** Removes one osteotomy from the active plan and adjusts the selected cut index. */
export function removeOsteotomy(film: FilmPlans, cutIndex: number): FilmPlans {
  const plan = activePlan(film);
  if (cutIndex < 0 || cutIndex >= plan.osteotomies.length) return film;
  const osteotomies = plan.osteotomies.filter((_, i) => i !== cutIndex);
  const current = activeCutIndex(plan);
  const activeCut = !osteotomies.length ? undefined : Math.min(osteotomies.length - 1, current > cutIndex ? current - 1 : current);
  return withPlan(film, { ...plan, osteotomies, activeCut });
}

/** Selects which osteotomy is active in the panel and on canvas. */
export function selectOsteotomy(film: FilmPlans, cutIndex: number): FilmPlans {
  const plan = activePlan(film);
  if (cutIndex < 0 || cutIndex >= plan.osteotomies.length || activeCutIndex(plan) === cutIndex) return film;
  return withPlan(film, { ...plan, activeCut: cutIndex });
}

/** Resets lateral/distal shifts and lengthening of one cut back to zero. */
export function resetCutShifts(film: FilmPlans, cutIndex: number): FilmPlans {
  const plan = activePlan(film), cut = cutIndex >= 0 ? plan.osteotomies.at(cutIndex) : undefined;
  if (!cut || (cut.shiftLateral === 0 && cut.shiftDistal === 0 && cut.lengthen === 0)) return film;
  return updateOsteotomy(film, cutIndex, { shiftLateral: 0, shiftDistal: 0, lengthen: 0 });
}

/** Resets one cut's fragment polygon back to the default 4-corner auto-polygon. */
export function resetCutFragment(film: FilmPlans, cutIndex: number, series: Series): FilmPlans {
  const plan = activePlan(film), cut = cutIndex >= 0 ? plan.osteotomies.at(cutIndex) : undefined;
  if (!cut) return film;
  const view = planView(film, series, plan);
  const fragment = fragmentFor(cut.cut, cut.bone, view.leg, view.mm);
  return fragment ? updateOsteotomy(film, cutIndex, { fragment }) : film;
}

/** Inserts a vertex along an edge of one cut's fragment polygon. */
export function addFragmentVertex(film: FilmPlans, cutIndex: number, edgeIndex: number, point: Point): FilmPlans {
  const plan = activePlan(film), cut = cutIndex >= 0 ? plan.osteotomies.at(cutIndex) : undefined;
  if (!cut) return film;
  const fragment = insertFragmentVertex(cut.fragment, edgeIndex, point);
  return fragment.length === cut.fragment.length ? film : updateOsteotomy(film, cutIndex, { fragment });
}

/** Deletes a vertex from one cut's fragment polygon (keeping at least 3 vertices). */
export function deleteFragmentVertex(film: FilmPlans, cutIndex: number, vertexIndex: number): FilmPlans {
  const plan = activePlan(film), cut = cutIndex >= 0 ? plan.osteotomies.at(cutIndex) : undefined;
  if (!cut) return film;
  const fragment = removeFragmentVertex(cut.fragment, vertexIndex);
  return fragment.length === cut.fragment.length ? film : updateOsteotomy(film, cutIndex, { fragment });
}

/** Computes new `{ degrees, direction }` during a direct on-canvas rotation drag. */
export function rotatedOsteotomy(
  initialSignedDeg: number,
  deltaDeg: number,
  valgusSign: number,
  snapDegrees: number,
  fallbackDirection: Osteotomy['direction'],
): Pick<Osteotomy, 'degrees' | 'direction'> {
  let signed = initialSignedDeg + deltaDeg * valgusSign;
  if (snapDegrees > 0) signed = Math.round(signed / snapDegrees) * snapDegrees;
  signed = Math.max(-45, Math.min(45, signed));
  const rounded = Math.round(Math.abs(signed) * 100) / 100;
  const direction: Osteotomy['direction'] = rounded < 1e-6 ? fallbackDirection : signed >= 0 ? 'valgus' : 'varus';
  return { degrees: rounded, direction };
}

/** Computes new `{ shiftLateral, shiftDistal }` during a direct on-canvas fragment translation drag. */
export function translatedOsteotomy(
  initialLateral: number,
  initialDistal: number,
  deltaPlane: Point,
  axisDisplay: Point,
  lateralDisplay: Point,
  snapUnit: number,
): Pick<Osteotomy, 'shiftLateral' | 'shiftDistal'> {
  let shiftLateral = initialLateral + dot(deltaPlane, lateralDisplay);
  let shiftDistal = initialDistal + dot(deltaPlane, axisDisplay);
  if (snapUnit > 0) {
    shiftLateral = Math.round(shiftLateral / snapUnit) * snapUnit;
    shiftDistal = Math.round(shiftDistal / snapUnit) * snapUnit;
  }
  const clampShift = (v: number) => Math.round(Math.max(-200, Math.min(200, v)) * 100) / 100;
  return { shiftLateral: clampShift(shiftLateral), shiftDistal: clampShift(shiftDistal) };
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
  if (placing.kind === 'lasso') return { film, placing };
  if (!placing.first) return { film, placing: { ...placing, first: point } };
  const cut: [Point, Point] = [placing.first, point];
  const view = planView(film, series);
  const fragment = fragmentFor(cut, placing.bone, view.leg, view.mm);
  if (!fragment || plan.osteotomies.length >= MAX_OSTEOTOMIES) return { film, placing: null };
  const osteotomy: Osteotomy = {
    id: newCutId(), bone: placing.bone, cut, hinge: point, wedge: 'opening', degrees: 0,
    direction: 'valgus', shiftLateral: 0, shiftDistal: 0, lengthen: 0, fragment,
  };
  return { film: appendOsteotomy(film, osteotomy), placing: null };
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
export type Handle =
  | { kind: 'landmark'; name: LandmarkName; index: number }
  | { kind: 'suggestion'; name: LandmarkName; index: number }
  | { kind: 'marker'; index: number }
  | { kind: 'cut'; cutIndex?: number; index: 0 | 1 }
  | { kind: 'hinge'; cutIndex?: number }
  | { kind: 'fragment'; cutIndex?: number; index: number };

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
  const cutIndex = handle.cutIndex ?? activeCutIndex(plan);
  const osteotomy = cutIndex >= 0 ? plan.osteotomies[cutIndex] : undefined;
  if (!osteotomy) return film;
  if (handle.kind === 'hinge') return updateOsteotomy(film, cutIndex, { hinge: point });
  if (handle.kind === 'cut') {
    const cut: [Point, Point] = handle.index === 0 ? [point, osteotomy.cut[1]] : [osteotomy.cut[0], point];
    // The hinge follows the cut's hinge end while it sits on it.
    const onEnd = handle.index === 1 && osteotomy.hinge[0] === osteotomy.cut[1][0] && osteotomy.hinge[1] === osteotomy.cut[1][1];
    return updateOsteotomy(film, cutIndex, { cut, hinge: onEnd ? point : osteotomy.hinge });
  }
  return updateOsteotomy(film, cutIndex, { fragment: osteotomy.fragment.map((p, i) => i === handle.index ? point : p) });
}
