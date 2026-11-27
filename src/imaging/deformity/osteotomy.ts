// A simulated osteotomy of one leg (single or multi-level): one or more cuts, each with a hinge and a distal fragment
// polygon turned about it, opened or closed, then shifted and lengthened. Cuts compose proximally to distally so a
// double-level or bifocal correction moves every intermediate and distal segment rigidly without double-drawing or
// gaps. Nothing here touches pixels: the landmarks move with their segment and the leg is measured again (measure.ts);
// the renderer draws each moved segment as a layer (DeformityOverlay).
import { CONTOUR_MINIMUM, type LandmarkName } from './landmarks';
import type { Cora } from './analysis';
import { type LegInput, type Leg, type Landmarks, measureLeg, toImage, toPlane } from './measure';
import {
  acrossAxis, add, applyRigid, bisect, composeRigid, cross, distance, dot, IDENTITY, midpoint,
  polygonArea, type Point, type Rigid, rotate, scale, signedAngle, simplifyClosedPolygon, sub, unit,
} from './plane';

export const MAX_FRAGMENT_POINTS = 32;
export const MAX_OSTEOTOMIES = 6;

export interface Osteotomy {
  /** Stable identifier within a plan (optional for legacy objects and unit tests). */
  id?: string;
  bone: 'femur' | 'tibia';
  /** The cut, in image pixels: from the cortex that opens (or closes) to the hinge's cortex. */
  cut: [Point, Point];
  hinge: Point;
  wedge: 'opening' | 'closing';
  /** The correction's size in degrees (0 or more), and the way it turns the distal fragment. */
  degrees: number;
  direction: 'valgus' | 'varus';
  /** The distal fragment's shift, laterally and distally, and its lengthening along the bone, in mm (px without a
   * calibration). */
  shiftLateral: number; shiftDistal: number; lengthen: number;
  /** The fragment, in image pixels. */
  fragment: Point[];
}

/** The bone's distal direction on the plane: hip to knee for the femur, knee to ankle for the tibia. */
function boneAxis(bone: Osteotomy['bone'], leg: Leg, mm: LegInput['mmPerPixel']): Point | null {
  const top = bone === 'femur' ? leg.hip?.centre : leg.knee, bottom = bone === 'femur' ? leg.knee : leg.ankle;
  return top && bottom ? unit(sub(toPlane(bottom, mm), toPlane(top, mm))) : null;
}

/** A bone's local plane frame: distal axis, lateral unit vector perpendicular to it, and the rotation sign for valgus. */
function boneFrame(bone: Osteotomy['bone'], leg: Leg, input: Pick<LegInput, 'mmPerPixel' | 'lateral'>): { axis: Point; lateral: Point; valgusSign: number } | null {
  const axis = boneAxis(bone, leg, input.mmPerPixel);
  const lateralImage = input.lateral ? unit(toPlane(input.lateral, input.mmPerPixel)) : null;
  if (!axis || !lateralImage) return null;
  const lateral = acrossAxis(axis, lateralImage);
  if (!lateral) return null;
  // Valgus turns the distal end laterally.
  const valgusSign = Math.sign(cross(axis, lateral));
  if (!valgusSign) return null;
  return { axis, lateral, valgusSign };
}

/**
 * The fragment outline a new cut gets: the cut carried 40% further on each side (25 mm at least), then down the bone
 * to 60 mm past the ankle centre. The reader can move its corners, insert vertices or trace a custom cutout.
 */
export function fragmentFor(cut: [Point, Point], bone: Osteotomy['bone'], leg: Leg, mm: LegInput['mmPerPixel']): Point[] | null {
  const axis = boneAxis(bone, leg, mm);
  if (!axis || !leg.ankle) return null;
  const a = toPlane(cut[0], mm), b = toPlane(cut[1], mm), across = unit(sub(b, a));
  if (!across) return null;
  const reach = Math.max(25, distance(a, b) * 0.4), ankle = toPlane(leg.ankle, mm);
  const depth = Math.max(60, dot(sub(ankle, a), axis) + 60);
  const start = sub(a, scale(across, reach)), end = add(b, scale(across, reach));
  return [start, end, add(end, scale(axis, depth)), add(start, scale(axis, depth))].map(p => toImage(p, mm));
}

/** The fragment's local motion on the plane (mm, or px without a calibration): a turn about the hinge, then the shifts. */
export function fragmentMotion(osteotomy: Osteotomy, leg: Leg, input: Pick<LegInput, 'mmPerPixel' | 'lateral'>): Rigid | null {
  const frame = boneFrame(osteotomy.bone, leg, input);
  if (!frame) return null;
  const degrees = (osteotomy.direction === 'valgus' ? 1 : -1) * frame.valgusSign * osteotomy.degrees;
  const shift = add(add(scale(frame.lateral, osteotomy.shiftLateral), scale(frame.axis, osteotomy.shiftDistal)), scale(frame.axis, osteotomy.lengthen));
  return { pivot: toPlane(osteotomy.hinge, input.mmPerPixel), degrees, shift };
}

/** A point of the image after the motion, in image pixels. */
export const moved = (motion: Rigid, p: Point, mm: LegInput['mmPerPixel']) => toImage(applyRigid(motion, toPlane(p, mm)), mm);

/** Whether a landmark point lies distal to `cut` along `axis` in plane coordinates. */
function distalPredicate(cut: [Point, Point], mm: LegInput['mmPerPixel'], axis: Point): (p: Point) => boolean {
  const a = toPlane(cut[0], mm), b = toPlane(cut[1], mm), along = unit(sub(b, a));
  const normal: Point | null = along && [-along[1], along[0]];
  const distalSide = normal ? (dot(normal, axis) >= 0 ? normal : scale(normal, -1)) : axis;
  return (p: Point) => dot(sub(toPlane(p, mm), a), distalSide) > 0;
}

/**
 * The landmarks with those of the distal fragment moved: every landmark beyond the cut's line, distally along the bone.
 * The plan holds one leg, so its side of the cut is the whole question; the fragment's outline only says which pixels are
 * drawn moved. The femoral head's outline moves only whole.
 */
export function movedLandmarks(points: Landmarks, osteotomy: Osteotomy, motion: Rigid, mm: LegInput['mmPerPixel'], axis: Point): Landmarks {
  const beyond = distalPredicate(osteotomy.cut, mm, axis);
  const result: Landmarks = {};
  for (const [name, list] of Object.entries(points) as Array<[LandmarkName, readonly Point[]]>) {
    const moves = list.length >= CONTOUR_MINIMUM ? list.every(beyond) : list.some(beyond);
    result[name] = moves ? list.map(p => moved(motion, p, mm)) : list;
  }
  return result;
}

/** Sorts osteotomies proximally to distally: femur cuts before tibia cuts, then by distance along each bone's axis. */
export function sortOsteotomies(osteotomies: readonly Osteotomy[], leg: Leg, mm: LegInput['mmPerPixel']): Array<{ index: number; osteotomy: Osteotomy }> {
  const rank = (osteotomy: Osteotomy): [number, number] => {
    const boneRank = osteotomy.bone === 'femur' ? 0 : 1;
    const axis = boneAxis(osteotomy.bone, leg, mm);
    const top = osteotomy.bone === 'femur' ? leg.hip?.centre : leg.knee;
    const mid = toPlane(midpoint(osteotomy.cut[0], osteotomy.cut[1]), mm);
    const along = axis && top ? dot(sub(mid, toPlane(top, mm)), axis) : mid[1];
    return [boneRank, along];
  };
  return osteotomies
    .map((osteotomy, index) => ({ index, osteotomy, key: rank(osteotomy) }))
    .sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.index - b.index)
    .map(({ index, osteotomy }) => ({ index, osteotomy }));
}

export interface CutSimulation {
  /** Position of this cut in the plan's `osteotomies` array. */
  index: number;
  osteotomy: Osteotomy;
  /** This cut's local rigid motion in pre-op plane coordinates. */
  localMotion: Rigid;
  /** Cumulative rigid motion of all cuts proximal to this one (`IDENTITY` for the most proximal cut). */
  parentMotion: Rigid;
  /** Cumulative rigid motion applied to this cut's distal segment (`parentMotion ∘ localMotion`). */
  totalMotion: Rigid;
  /** Cut endpoints on the proximal side of this cut, after `parentMotion`, in image pixels. */
  cutMoved: [Point, Point];
  /** Hinge on the proximal side of this cut, after `parentMotion`, in image pixels. */
  hingeMoved: Point;
  /** Distal side of the hinge after `totalMotion`, in image pixels (differs from `hingeMoved` when shifted). */
  hingeAfter: Point;
  /** What the turn does at the cut's opening/closing cortex: opens it or closes it; null without a turn. */
  wedge: 'opening' | 'closing' | null;
  /** The cut's end across from the hinge in pre-op image pixels. */
  cortex: Point;
  /** The opening/closing cortex on the proximal side of this cut, after `parentMotion`, in image pixels. */
  cortexMoved: Point;
  /** Wedge height at that cortex: 2 w sin(θ/2), w its distance from the hinge (Rolim 2016). */
  wedgeHeight: number;
  /** Distance from hinge to opening/closing cortex in plane units (mm, or px uncalibrated). */
  boneWidth: number;
  /** Pre-op distal bone axis and lateral unit vectors in plane coordinates, and the valgus rotation sign. */
  axis: Point;
  lateral: Point;
  valgusSign: number;
}

export interface MultiSimulation {
  leg: Leg;
  /** The plan's landmarks where the combined corrections put them. */
  points: Landmarks;
  /** Per-cut simulation results in proximal-to-distal order. */
  cuts: CutSimulation[];
  /** How far the limb lengthens (positive) or shortens overall, hip to ankle. */
  lengthChange: number | null;
}

export interface Simulation {
  leg: Leg;
  motion: Rigid;
  /** The plan's landmarks where the correction puts them. */
  points: Landmarks;
  /** What the turn does at the cut's first cortex: opens it (an opening wedge) or closes it (a closing wedge, bone taken
   * out); null without a turn. The hinge's side and the direction decide it, whatever the plan says. */
  wedge: 'opening' | 'closing' | null;
  /** The cut's end across from the hinge: the cortex that opens or closes, in image pixels. */
  cortex: Point;
  /** Wedge height at that cortex: 2 w sin(θ/2), w its distance from the hinge (Rolim 2016). */
  wedgeHeight: number;
  /** How far the limb lengthens (positive) or shortens, hip to ankle. */
  lengthChange: number | null;
}

const FEMORAL_LANDMARKS: ReadonlySet<LandmarkName> = new Set([
  'femoralHeadContour', 'greaterTrochanterTip', 'femoralShaftProximal',
  'femoralShaftDistal', 'femoralCondyleMedial', 'femoralCondyleLateral', 'kneeCentre',
]);

/**
 * Simulates one or more osteotomies on the same leg, composed proximally to distally. Each cut's local rigid motion
 * `M_k` is defined in pre-op bone coordinates and conjugated cleanly by all proximal cuts `T_{k-1}`, giving cumulative
 * distal motion `T_k = M_0 ∘ M_1 ∘ … ∘ M_k` so intermediate segments remain connected at each moved hinge.
 */
export function simulateMany(input: LegInput, before: Leg, osteotomies: readonly Osteotomy[]): MultiSimulation | null {
  if (!osteotomies.length) return null;
  const ordered = sortOsteotomies(osteotomies, before, input.mmPerPixel);
  const mm = input.mmPerPixel;
  const cuts: CutSimulation[] = [];
  let parentMotion: Rigid = IDENTITY;
  for (const { index, osteotomy } of ordered) {
    const frame = boneFrame(osteotomy.bone, before, input);
    const localMotion = fragmentMotion(osteotomy, before, input);
    if (!frame || !localMotion) return null;
    const totalMotion = cuts.length ? composeRigid(parentMotion, localMotion) : localMotion;
    const ends = osteotomy.cut.map(p => toPlane(p, mm));
    // The cortex that opens or closes is the cut's end farther from the hinge, whichever end the reader clicked first.
    const across = distance(ends[0], localMotion.pivot) >= distance(ends[1], localMotion.pivot) ? 0 : 1;
    const boneWidth = distance(localMotion.pivot, ends[across]);
    const start = ends[across], turned = add(localMotion.pivot, rotate(sub(start, localMotion.pivot), localMotion.degrees));
    // The cortex moved distally, away from the proximal fragment, opens the cut; moved proximally, it closes it.
    const wedge = Math.abs(localMotion.degrees) < 1e-9 ? null : dot(sub(turned, start), frame.axis) > 0 ? 'opening' : 'closing';
    const cutMoved: [Point, Point] = [moved(parentMotion, osteotomy.cut[0], mm), moved(parentMotion, osteotomy.cut[1], mm)];
    const hingeMoved = moved(parentMotion, osteotomy.hinge, mm);
    const hingeAfter = moved(totalMotion, osteotomy.hinge, mm);
    const cortex = osteotomy.cut[across];
    const cortexMoved = moved(parentMotion, cortex, mm);
    cuts.push({
      index, osteotomy, localMotion, parentMotion, totalMotion, cutMoved, hingeMoved, hingeAfter,
      wedge, cortex, cortexMoved,
      wedgeHeight: 2 * boneWidth * Math.sin(osteotomy.degrees / 2 * Math.PI / 180),
      boneWidth, axis: frame.axis, lateral: frame.lateral, valgusSign: frame.valgusSign,
    });
    parentMotion = totalMotion;
  }
  const predicates = cuts.map(cut => distalPredicate(cut.osteotomy.cut, mm, cut.axis));
  const points: Landmarks = {};
  for (const [name, list] of Object.entries(input.points) as Array<[LandmarkName, readonly Point[]]>) {
    const isFemoral = FEMORAL_LANDMARKS.has(name);
    // Walk proximally to distally along the limb hierarchy: a tibial cut never moves femoral landmarks, every tibial
    // landmark rides along with any femoral cut, and within one bone a landmark must be distal to every preceding cut.
    let deepest = -1;
    for (let k = 0; k < cuts.length; k++) {
      const cutBone = cuts[k].osteotomy.bone;
      if (cutBone === 'tibia' && isFemoral) break;
      if (cutBone === 'femur' && !isFemoral) {
        deepest = k;
        continue;
      }
      const beyond = predicates[k];
      const moves = list.length >= CONTOUR_MINIMUM ? list.every(beyond) : list.some(beyond);
      if (moves) deepest = k;
      else break;
    }
    points[name] = deepest >= 0 ? list.map(p => moved(cuts[deepest].totalMotion, p, mm)) : list;
  }
  const leg = measureLeg({ ...input, points });
  const was = before.values.limbLength.value, now = leg.values.limbLength.value;
  return { leg, points, cuts, lengthChange: was !== null && now !== null ? now - was : null };
}

export function simulate(input: LegInput, before: Leg, osteotomy: Osteotomy): Simulation | null {
  const result = simulateMany(input, before, [osteotomy]);
  if (!result) return null;
  const first = result.cuts[0];
  return {
    leg: result.leg, motion: first.totalMotion, points: result.points, wedge: first.wedge,
    cortex: first.cortex, wedgeHeight: first.wedgeHeight, lengthChange: result.lengthChange,
  };
}

export type Target =
  | { kind: 'mad'; mm: number }
  | { kind: 'wbl'; percent: number }
  | { kind: 'mLDFA'; degrees: number }
  | { kind: 'MPTA'; degrees: number }
  | { kind: 'LDTA'; degrees: number };

function targetResidual(values: Leg['values'] | undefined, target: Target): number {
  if (!values) return NaN;
  if (target.kind === 'mad') {
    const v = values.MAD.value;
    return v === null ? NaN : v - target.mm;
  }
  if (target.kind === 'wbl') {
    const v = values.WBL.value;
    return v === null ? NaN : target.percent - v;
  }
  const v = values[target.kind].value;
  return v === null ? NaN : v - target.degrees;
}

/**
 * Solves the angle for one cut (`cutIndex`) within a single- or multi-level plan so that the combined simulated leg
 * reaches `target` (MAD, WBL, mLDFA, MPTA or LDTA). Solved by bisection between 45° of varus and 45° of valgus; null
 * when no angle in that range reaches the target.
 */
export function solveAngleMany(
  input: LegInput,
  before: Leg,
  osteotomies: readonly Osteotomy[],
  cutIndex: number,
  target: Target,
): Pick<Osteotomy, 'degrees' | 'direction'> | null {
  if (cutIndex < 0 || cutIndex >= osteotomies.length) return null;
  const at = (signed: number) => {
    const trial = osteotomies.map((item, i) => i === cutIndex
      ? { ...item, degrees: Math.abs(signed), direction: signed >= 0 ? 'valgus' as const : 'varus' as const }
      : item);
    return targetResidual(simulateMany(input, before, trial)?.leg.values, target);
  };
  const signed = bisect(at, -45, 45);
  return signed === null ? null : { degrees: Math.abs(signed), direction: signed >= 0 ? 'valgus' : 'varus' };
}

/**
 * The correction that brings the weight-bearing line or joint orientation angle through the target, measured again
 * after the fragment moves.
 */
export function solveAngle(input: LegInput, before: Leg, osteotomy: Osteotomy, target: Target): Pick<Osteotomy, 'degrees' | 'direction'> | null {
  return solveAngleMany(input, before, [osteotomy], 0, target);
}

/**
 * Where the cut and hinge lie against the CORA (Paley's rules): rule 1, the cut through the CORA with the hinge on the
 * transverse bisector, corrects without translation; rule 2, the hinge on the bisector with the cut away from the CORA,
 * angulates and translates at the cut and keeps the axes in line; rule 3, the hinge off the bisector, leaves the axes
 * apart by 2 d sin(θ/2), d the hinge's distance from the bisector: turning about it instead of about a point of the
 * bisector moves the fragment by (I - R)·d. Within 5 mm counts as on.
 */
export function paleyRule(osteotomy: Osteotomy, cora: { point: Point; bisector: Point }, mm: LegInput['mmPerPixel']): { rule: 1 | 2 | 3; offset: number; translation: number } | null {
  // The rules' 5 mm tolerance needs millimetres: on a film measured in pixels the rule is not given.
  if (!mm) return null;
  const hinge = toPlane(osteotomy.hinge, mm), corePoint = toPlane(cora.point, mm);
  const bisector = unit(toPlane(cora.bisector, mm)) ?? cora.bisector;
  const offset = Math.abs(cross(sub(hinge, corePoint), bisector));
  const a = toPlane(osteotomy.cut[0], mm), b = toPlane(osteotomy.cut[1], mm), cut = unit(sub(b, a));
  const fromCut = cut ? Math.abs(cross(sub(corePoint, a), cut)) : Infinity;
  const translation = 2 * offset * Math.sin(osteotomy.degrees / 2 * Math.PI / 180);
  return { rule: offset > 5 ? 3 : fromCut > 5 ? 2 : 1, offset, translation };
}

/** Whether a CORA lies within the bone and within the editable angle range (and film bounds when given). */
export function coraPlaceable(cora: Cora | null, bounds?: readonly [number, number]): boolean {
  if (!cora || !(cora.magnitude > 0.05) || cora.magnitude > 45) return false;
  if (!(cora.level >= 0 && cora.level <= 1)) return false;
  if (!bounds) return true;
  const [cols, rows] = bounds;
  return cora.point[0] >= 0 && cora.point[0] <= cols && cora.point[1] >= 0 && cora.point[1] <= rows;
}

/**
 * Pre-places a Paley Rule 1 osteotomy right through a bone's CORA along its transverse bisector (perpendicular to the
 * longitudinal deformity bisector), with the hinge on the convex cortex for an opening wedge (or concave cortex for a
 * closing wedge) and the angle pre-dialled to the CORA magnitude.
 */
export function coraCut(
  cora: Cora,
  leg: Leg,
  input: Pick<LegInput, 'mmPerPixel' | 'lateral'>,
  wedge: Osteotomy['wedge'] = 'opening',
  bounds?: readonly [number, number],
): Osteotomy | null {
  const mm = input.mmPerPixel;
  const frame = boneFrame(cora.bone, leg, input);
  if (!frame || !coraPlaceable(cora, bounds)) return null;
  const u = unit(toPlane(cora.proximal.direction, mm));
  const d = unit(toPlane(cora.distal.direction, mm));
  const bisector = unit(toPlane(cora.bisector, mm));
  if (!u || !d || !bisector) return null;
  // Rotating the distal axis back onto the proximal axis removes the CORA angle.
  const delta = signedAngle(u, d);
  const direction: Osteotomy['direction'] = Math.sign(-delta) * frame.valgusSign >= 0 ? 'valgus' : 'varus';
  // Use the exact CORA magnitude for wedge-side geometry before formatting to 0.1° display precision.
  const exactDegrees = cora.magnitude;
  const jointLine = cora.bone === 'femur' ? leg.femoralLine : leg.tibialLine;
  if (!jointLine) return null;
  const rawHalf = distance(toPlane(jointLine[0], mm), toPlane(jointLine[1], mm)) * 0.28;
  const halfWidth = mm
    ? Math.max(cora.bone === 'femur' ? 18 : 15, Math.min(cora.bone === 'femur' ? 28 : 24, rawHalf))
    : Math.max(12, rawHalf);
  const core = toPlane(cora.point, mm);
  const endA = toImage(add(core, scale(bisector, halfWidth)), mm);
  const endB = toImage(sub(core, scale(bisector, halfWidth)), mm);
  if (bounds) {
    const [cols, rows] = bounds;
    const within = (p: Point) => p[0] >= -cols / 2 && p[0] <= cols * 1.5 && p[1] >= -rows / 2 && p[1] <= rows * 1.5;
    if (!within(endA) || !within(endB)) return null;
  }
  // Pick the hinge cortex so the correcting rotation produces the requested wedge type (convex = opening, concave = closing).
  const motionDeg = (direction === 'valgus' ? 1 : -1) * frame.valgusSign * exactDegrees;
  const aPlane = toPlane(endA, mm), bPlane = toPlane(endB, mm);
  const turnedA = add(bPlane, rotate(sub(aPlane, bPlane), motionDeg));
  const opensWithBHinge = dot(sub(turnedA, aPlane), frame.axis) > 0;
  const useBHinge = wedge === 'opening' ? opensWithBHinge : !opensWithBHinge;
  const cut: [Point, Point] = useBHinge ? [endA, endB] : [endB, endA];
  const hinge = cut[1];
  const fragment = fragmentFor(cut, cora.bone, leg, mm);
  if (!fragment) return null;
  const degrees = Number(exactDegrees.toFixed(1));
  return { bone: cora.bone, cut, hinge, wedge, degrees, direction, shiftLateral: 0, shiftDistal: 0, lengthen: 0, fragment };
}

/** Inserts a vertex into a fragment polygon after `edgeIndex`, up to `MAX_FRAGMENT_POINTS`. */
export function insertFragmentVertex(fragment: readonly Point[], edgeIndex: number, point: Point, maxPoints = MAX_FRAGMENT_POINTS): Point[] {
  if (fragment.length >= maxPoints || edgeIndex < 0 || edgeIndex >= fragment.length) return [...fragment];
  return [...fragment.slice(0, edgeIndex + 1), point, ...fragment.slice(edgeIndex + 1)];
}

/** Removes a vertex from a fragment polygon, keeping at least 3 vertices. */
export function removeFragmentVertex(fragment: readonly Point[], index: number): Point[] {
  if (fragment.length <= 3 || index < 0 || index >= fragment.length) return [...fragment];
  return fragment.filter((_, i) => i !== index);
}

/** Simplifies a freehand/lasso cutout stroke into a valid bone-hugging polygon (3 to `maxPoints` vertices). */
export function simplifyFragment(points: readonly Point[], tolerancePx: number, maxPoints = MAX_FRAGMENT_POINTS): Point[] | null {
  const simplified = simplifyClosedPolygon(points, tolerancePx, maxPoints);
  if (simplified.length < 3 || polygonArea(simplified) < 4) return null;
  return simplified;
}

/**
 * Position of the direct on-canvas rotation swing handle for a simulated cut, in image pixels: placed distally along
 * the moved bone segment with comfortable lever-arm leverage and nudged laterally clear of the knee joint line.
 */
export function rotationHandlePoint(cut: CutSimulation, leg: Leg, mm: LegInput['mmPerPixel'], nextCut?: CutSimulation): Point {
  const cutMid = toPlane(midpoint(cut.osteotomy.cut[0], cut.osteotomy.cut[1]), mm);
  const boneLen = leg.knee && leg.ankle ? distance(toPlane(leg.knee, mm), toPlane(leg.ankle, mm))
    : leg.hip && leg.knee ? distance(toPlane(leg.hip.centre, mm), toPlane(leg.knee, mm)) : 380;
  // Scale physical mm bounds when working in uncalibrated pixels on high-resolution films.
  const k = mm ? 1 : Math.max(1, boneLen / 380);
  let lever = 90 * k;
  if (nextCut) {
    const nextMid = toPlane(midpoint(nextCut.osteotomy.cut[0], nextCut.osteotomy.cut[1]), mm);
    const span = dot(sub(nextMid, cutMid), cut.axis);
    lever = Math.max(45 * k, Math.min(120 * k, span * 0.5));
  } else if (leg.ankle) {
    const span = dot(sub(toPlane(leg.ankle, mm), cutMid), cut.axis);
    lever = Math.max(65 * k, Math.min(160 * k, span * 0.52));
  }
  let preOp = add(cutMid, scale(cut.axis, lever));
  // Keep the handle clear of the knee landmarks and joint lines when a femoral cut lands near the knee.
  if (leg.knee && distance(preOp, toPlane(leg.knee, mm)) < 40 * k) {
    preOp = add(preOp, scale(cut.lateral, 42 * k));
  }
  return toImage(applyRigid(cut.totalMotion, preOp), mm);
}
