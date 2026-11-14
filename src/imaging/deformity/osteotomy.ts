// A simulated osteotomy of one leg: a cut, a hinge and the distal fragment turned about it, opened or closed, then
// shifted and lengthened. The fragment is a polygon around the leg below the cut, never a half-plane, so a film of both
// legs moves only this one (feasibility study S7). Nothing here touches pixels: the landmarks inside the fragment move
// with it and the leg is measured again (measure.ts); the renderer draws the fragment as a layer (DeformityOverlay).
import { CONTOUR_MINIMUM, type LandmarkName } from './landmarks';
import { type LegInput, type Leg, type Landmarks, measureLeg, toImage, toPlane } from './measure';
import { add, applyRigid, bisect, cross, distance, dot, length, type Point, type Rigid, scale, sub, unit, rotate } from './plane';

export interface Osteotomy {
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

/**
 * The fragment outline a new cut gets: the cut carried 40% further on each side (25 mm at least), then down the bone
 * to 60 mm past the ankle centre. The reader can move its corners.
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

/** The fragment's motion on the plane (mm, or px without a calibration): a turn about the hinge, then the shifts. */
export function fragmentMotion(osteotomy: Osteotomy, leg: Leg, input: Pick<LegInput, 'mmPerPixel' | 'lateral'>): Rigid | null {
  const axis = boneAxis(osteotomy.bone, leg, input.mmPerPixel);
  const lateralImage = input.lateral ? unit(toPlane(input.lateral, input.mmPerPixel)) : null;
  if (!axis || !lateralImage) return null;
  const lateral = unit(sub(lateralImage, scale(axis, dot(lateralImage, axis)))) ?? lateralImage;
  // Valgus turns the distal end laterally.
  const valgus = Math.sign(cross(axis, lateral)) || 1;
  const degrees = (osteotomy.direction === 'valgus' ? 1 : -1) * valgus * osteotomy.degrees;
  const shift = add(add(scale(lateral, osteotomy.shiftLateral), scale(axis, osteotomy.shiftDistal)), scale(axis, osteotomy.lengthen));
  return { pivot: toPlane(osteotomy.hinge, input.mmPerPixel), degrees, shift };
}

/** A point of the image after the motion, in image pixels. */
export const moved = (motion: Rigid, p: Point, mm: LegInput['mmPerPixel']) => toImage(applyRigid(motion, toPlane(p, mm)), mm);

/**
 * The landmarks with those of the distal fragment moved: every landmark beyond the cut's line, distally along the bone.
 * The plan holds one leg, so its side of the cut is the whole question; the fragment's outline only says which pixels are
 * drawn moved. The femoral head's outline moves only whole.
 */
export function movedLandmarks(points: Landmarks, osteotomy: Osteotomy, motion: Rigid, mm: LegInput['mmPerPixel'], axis: Point): Landmarks {
  const a = toPlane(osteotomy.cut[0], mm), b = toPlane(osteotomy.cut[1], mm), along = unit(sub(b, a));
  const normal: Point | null = along && [-along[1], along[0]];
  const distalSide = normal ? (dot(normal, axis) >= 0 ? normal : scale(normal, -1)) : axis;
  const beyond = (p: Point) => dot(sub(toPlane(p, mm), a), distalSide) > 0;
  const result: Landmarks = {};
  for (const [name, list] of Object.entries(points) as Array<[LandmarkName, readonly Point[]]>) {
    const moves = list.length >= CONTOUR_MINIMUM ? list.every(beyond) : list.some(beyond);
    result[name] = moves ? list.map(p => moved(motion, p, mm)) : list;
  }
  return result;
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

export function simulate(input: LegInput, before: Leg, osteotomy: Osteotomy): Simulation | null {
  const motion = fragmentMotion(osteotomy, before, input), axis = boneAxis(osteotomy.bone, before, input.mmPerPixel);
  if (!motion || !axis) return null;
  const points = movedLandmarks(input.points, osteotomy, motion, input.mmPerPixel, axis);
  const leg = measureLeg({ ...input, points });
  // The cortex that opens or closes is the cut's end farther from the hinge, whichever end the reader clicked first.
  const ends = osteotomy.cut.map(p => toPlane(p, input.mmPerPixel)), across = distance(ends[0], motion.pivot) >= distance(ends[1], motion.pivot) ? 0 : 1;
  const width = distance(motion.pivot, ends[across]);
  const was = before.values.limbLength.value, now = leg.values.limbLength.value;
  // The first cortex moved distally, away from the proximal fragment, opens the cut; moved proximally, it closes it.
  const start = ends[across], turned = add(motion.pivot, rotate(sub(start, motion.pivot), motion.degrees));
  const wedge = Math.abs(motion.degrees) < 1e-9 ? null : dot(sub(turned, start), axis) > 0 ? 'opening' : 'closing';
  return { leg, motion, points, wedge, cortex: osteotomy.cut[across], wedgeHeight: 2 * width * Math.sin(osteotomy.degrees / 2 * Math.PI / 180), lengthChange: was !== null && now !== null ? now - was : null };
}

export type Target = { kind: 'mad'; mm: number } | { kind: 'wbl'; percent: number };

/**
 * The correction that brings the weight-bearing line through the target, measured again after the fragment moves: a MAD
 * (0 for the knee centre), or a share of the plateau's width from its medial edge (62.5% for an HTO, Fujisawa). The
 * knee and the plateau move too when the cut is in the femur, so the target is read on the simulated leg, never on the
 * film as it was. Solved by bisection between 45° of varus and 45° of valgus; null when no angle in that range reaches
 * the target.
 */
export function solveAngle(input: LegInput, before: Leg, osteotomy: Osteotomy, target: Target): Pick<Osteotomy, 'degrees' | 'direction'> | null {
  const at = (signed: number) => {
    const trial = { ...osteotomy, degrees: Math.abs(signed), direction: signed >= 0 ? 'valgus' as const : 'varus' as const };
    const values = simulate(input, before, trial)?.leg.values;
    const value = target.kind === 'mad' ? values?.MAD.value : values?.WBL.value;
    return value === null || value === undefined ? NaN : target.kind === 'mad' ? value - target.mm : target.percent - value;
  };
  const signed = bisect(at, -45, 45);
  return signed === null ? null : { degrees: Math.abs(signed), direction: signed >= 0 ? 'valgus' : 'varus' };
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

export { length };
