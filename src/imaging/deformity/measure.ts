// Frontal-plane alignment of one leg from its landmarks (Paley, Principles of Deformity Correction, ch. 1): the
// mechanical and anatomic axes, the joint orientation angles, the joint line convergence angle, the hip–knee–ankle
// angle and the mechanical axis deviation, with the femoral, tibial and limb lengths. Pure float64, no DOM: the
// unit tests check it against hand-computed values and tools/check-deformity-plan.cjs against the synthetic film.
//
// Landmarks come in image pixels (x right, y down). Every length and angle is computed in the plane of the film in
// millimetres, each pixel `mmPerPixel` wide and high, so pixels need not be square. Without a calibration the plane
// is in pixels: angles then assume square pixels, which is said beside them, and lengths are in px.
import { CONTOUR_MINIMUM, type LandmarkName, PAIRS } from './landmarks';
import { NORMALS, type ValueKey, verdict, type Verdict } from './normals';
import { add, angleBetween, along, dot, fitCircle, intersect, length, midpoint, offsetFrom, type Point, scale, signedAngle, sub, unit } from './plane';

export type Side = 'R' | 'L';
export type Landmarks = Partial<Record<LandmarkName, readonly Point[]>>;

export interface LegInput {
  side: Side;
  points: Landmarks;
  /** Millimetres per pixel along x and y, or null in pixels only. */
  mmPerPixel: readonly [number, number] | null;
  /** The leg's lateral side as a direction on the image, in pixels, or null when the film does not say which side of
   * the image is the patient's right. */
  lateral: Point | null;
}

/** Why a value cannot be given: the landmarks it still needs, or what else is missing. */
/** Why a value is not given: landmarks not placed, a pair placed on one point (no line), or a reason. */
export type Missing = { landmarks: LandmarkName[] } | { together: LandmarkName[] } | { reason: 'side' | 'parallel' | 'calibration' };

export interface Value {
  key: ValueKey | 'WBL' | 'femurLength' | 'tibiaLength' | 'limbLength';
  value: number | null;
  unit: '°' | 'mm' | 'px' | '%';
  missing?: Missing;
  verdict?: Verdict;
}

/** What one leg's landmarks construct, in image pixels for drawing, and its values. */
export interface Leg {
  hip: { centre: Point; radius: number; residual: number } | null;
  knee: Point | null; ankle: Point | null; trochanter: Point | null;
  femoralLine: [Point, Point] | null; tibialLine: [Point, Point] | null; plafondLine: [Point, Point] | null;
  femoralShaft: [Point, Point] | null; tibialShaft: [Point, Point] | null;
  /** Where the hip–ankle line passes the knee: the foot of the perpendicular from the knee centre. */
  madFoot: Point | null;
  /** Where the hip–ankle line crosses the plateau line. */
  wblPoint: Point | null;
  values: Record<Value['key'], Value>;
  /** Medial and lateral points placed on the wrong sides of the leg, and a femoral head that is not round. */
  swapped: LandmarkName[];
  /** Pairs placed on one point (within half a pixel), which give no line. */
  together: LandmarkName[];
  headFitPoor: boolean;
  unit: 'mm' | 'px';
}

/** The leg's lateral direction on the image from Patient Orientation, or from the reader's answer to which side of the
 * image the patient's right is on; null when neither is known (the kit then asks). */
export function lateralOnImage(side: Side, orientation: readonly string[] | undefined, patientRight: 'left' | 'right' | undefined): Point | null {
  let right: Point | null = null;
  if (orientation?.length === 2) {
    // The patient's right in LPS is −x: how far each image axis runs towards it.
    const towardsRight = (value: string) => [...value].reduce((sum, letter) => sum + (letter === 'R' ? 1 : letter === 'L' ? -1 : 0), 0) / Math.max(1, value.length);
    right = unit([towardsRight(orientation[0]), towardsRight(orientation[1])]);
  } else if (patientRight) right = [patientRight === 'right' ? 1 : -1, 0];
  if (!right) return null;
  // + 0 turns a −0 into 0.
  return side === 'R' ? [right[0] + 0, right[1] + 0] : [-right[0] + 0, -right[1] + 0];
}

const one = (points: Landmarks, name: LandmarkName): Point | null => points[name]?.[0] ?? null;

export function measureLeg(input: LegInput): Leg {
  const [sx, sy] = input.mmPerPixel ?? [1, 1];
  const unitName = input.mmPerPixel ? 'mm' : 'px';
  const toPlane = (p: Point): Point => [p[0] * sx, p[1] * sy];
  const toImage = (p: Point): Point => [p[0] / sx, p[1] / sy];
  const at = (name: LandmarkName) => { const p = one(input.points, name); return p ? toPlane(p) : null; };
  const contour = (input.points.femoralHeadContour ?? []).map(toPlane);
  const head = contour.length >= CONTOUR_MINIMUM ? fitCircle(contour) : null;
  const H = head?.centre ?? null, K = at('kneeCentre'), A = at('ankleCentre'), GT = at('greaterTrochanterTip');
  // A pair placed within half a pixel of each other gives no line: its values are not given, and say why.
  const together = new Set<LandmarkName>(), apart = 0.5 * Math.min(sx, sy);
  const pair = (medial: LandmarkName, lateral: LandmarkName) => {
    const m = at(medial), l = at(lateral);
    if (!m || !l) return null;
    if (length(sub(l, m)) < apart) { together.add(medial); together.add(lateral); return null; }
    return [m, l] as [Point, Point];
  };
  const condyles = pair('femoralCondyleMedial', 'femoralCondyleLateral'), plateau = pair('tibialPlateauMedial', 'tibialPlateauLateral');
  const plafond = pair('plafondMedial', 'plafondLateral');
  const femoralShaft = pair('femoralShaftProximal', 'femoralShaftDistal'), tibialShaft = pair('tibialShaftProximal', 'tibialShaftDistal');
  // The leg runs distally from the hip to the ankle; its lateral side is the film's, kept square to that.
  const distal = H && A ? unit(sub(A, H)) : K && A ? unit(sub(A, K)) : H && K ? unit(sub(K, H)) : null;
  const imageLateral = input.lateral ? unit(toPlane(input.lateral)) : null;
  const lateral = imageLateral && distal ? unit(sub(imageLateral, scale(distal, dot(imageLateral, distal)))) : null;
  /** A joint line as a direction pointing lateral. */
  const lateralWards = (line: [Point, Point] | null) => {
    if (!line || !lateral) return null;
    const d = sub(line[1], line[0]);
    return dot(d, lateral) >= 0 ? d : scale(d, -1);
  };
  const needs = (...names: Array<[LandmarkName, unknown]>): Missing | undefined => {
    const absent = names.filter(([, value]) => value === null || value === undefined).map(([name]) => name);
    const unplaced = absent.filter(name => !together.has(name));
    return unplaced.length ? { landmarks: unplaced } : absent.length ? { together: absent } : undefined;
  };
  const values = {} as Record<Value['key'], Value>;
  const angle = (key: ValueKey, missing: Missing | undefined, compute: () => number | null, sided = true) => {
    const value = missing || (sided && !lateral) ? null : compute();
    values[key] = { key, value, unit: '°', ...(missing ? { missing } : sided && !lateral ? { missing: { reason: 'side' } } : value === null ? { missing: { reason: 'parallel' } } : {}),
      ...(value !== null ? { verdict: verdict(key, value) } : {}) };
  };
  const femurAxis = H && K ? sub(H, K) : null; // pointing proximally
  const tibiaAxis = K && A ? sub(A, K) : null; // pointing distally
  angle('mLPFA', needs(['femoralHeadContour', H], ['kneeCentre', K], ['greaterTrochanterTip', GT]), () => angleBetween(sub(K!, H!), sub(GT!, H!)), false);
  angle('mLDFA', needs(['femoralHeadContour', H], ['kneeCentre', K], ['femoralCondyleMedial', condyles], ['femoralCondyleLateral', condyles]), () => angleBetween(femurAxis!, lateralWards(condyles)!));
  angle('aLDFA', needs(['femoralShaftProximal', femoralShaft], ['femoralShaftDistal', femoralShaft], ['femoralCondyleMedial', condyles], ['femoralCondyleLateral', condyles]),
    () => angleBetween(sub(femoralShaft![0], femoralShaft![1]), lateralWards(condyles)!));
  angle('MPTA', needs(['kneeCentre', K], ['ankleCentre', A], ['tibialPlateauMedial', plateau], ['tibialPlateauLateral', plateau]), () => angleBetween(tibiaAxis!, scale(lateralWards(plateau)!, -1)));
  angle('LDTA', needs(['kneeCentre', K], ['ankleCentre', A], ['plafondMedial', plafond], ['plafondLateral', plafond]), () => angleBetween(scale(tibiaAxis!, -1), lateralWards(plafond)!));
  // Positive when the joint lines converge medially: the tibial line turned from the femoral one so that its lateral
  // end lies further from it (Paley).
  angle('JLCA', needs(['femoralCondyleMedial', condyles], ['femoralCondyleLateral', condyles], ['tibialPlateauMedial', plateau], ['tibialPlateauLateral', plateau]),
    () => signedAngle(lateralWards(condyles)!, lateralWards(plateau)!) * Math.sign(-signedAngle(distal!, lateral!)));
  angle('AMA', needs(['femoralHeadContour', H], ['kneeCentre', K], ['femoralShaftProximal', femoralShaft], ['femoralShaftDistal', femoralShaft]),
    () => { const a = angleBetween(femurAxis!, sub(femoralShaft![0], femoralShaft![1])); return a === null ? null : Math.min(a, 180 - a); }, false);
  // The knee centre's distance from the hip–ankle line, positive when the line passes medial to it (varus).
  const madMissing = needs(['femoralHeadContour', H], ['kneeCentre', K], ['ankleCentre', A]);
  const mad = !madMissing && lateral ? offsetFrom(K!, H!, sub(A!, H!), lateral) : null;
  values.MAD = { key: 'MAD', value: mad, unit: unitName, ...(madMissing ? { missing: madMissing } : !lateral ? { missing: { reason: 'side' } } : {}),
    ...(mad !== null && unitName === 'mm' ? { verdict: verdict('MAD', mad) } : {}) };
  angle('HKA', madMissing, () => { const size = angleBetween(sub(K!, H!), tibiaAxis!); return size === null || mad === null ? null : size * (mad < 0 ? -1 : 1); });
  // The weight-bearing line's crossing of the plateau, as a share of its width from the medial edge (Fujisawa).
  const wbl = H && A && plateau && lateral ? intersect(H, sub(A, H), plateau[0], sub(plateau[1], plateau[0])) : null;
  const plateauMedial = plateau && lateral ? (dot(sub(plateau[1], plateau[0]), lateral) >= 0 ? plateau[0] : plateau[1]) : null;
  const share = wbl && plateau && plateauMedial ? along(wbl, plateauMedial, plateauMedial === plateau[0] ? plateau[1] : plateau[0]) : null;
  values.WBL = { key: 'WBL', value: share === null ? null : share * 100, unit: '%', ...(needs(['femoralHeadContour', H], ['ankleCentre', A], ['tibialPlateauMedial', plateau], ['tibialPlateauLateral', plateau]) ? { missing: needs(['femoralHeadContour', H], ['ankleCentre', A], ['tibialPlateauMedial', plateau], ['tibialPlateauLateral', plateau])! } : !lateral ? { missing: { reason: 'side' } } : {}) };
  const span = (key: 'femurLength' | 'tibiaLength' | 'limbLength', a: Point | null, b: Point | null, missing: Missing | undefined) => {
    values[key] = { key, value: a && b ? length(sub(b, a)) : null, unit: unitName, ...(missing ? { missing } : {}) };
  };
  span('femurLength', H, K, needs(['femoralHeadContour', H], ['kneeCentre', K]));
  span('tibiaLength', K, A, needs(['kneeCentre', K], ['ankleCentre', A]));
  span('limbLength', H, A, needs(['femoralHeadContour', H], ['ankleCentre', A]));
  const foot = H && K && A ? (() => { const d = unit(sub(A, H)); return d ? add(H, scale(d, dot(sub(K, H), d))) : null; })() : null;
  const swapped = lateral ? PAIRS.flatMap(([medial, lateralName]) => {
    const m = at(medial), l = at(lateralName);
    return m && l && dot(sub(l, m), lateral) < 0 ? [medial, lateralName] : [];
  }) : [];
  const image = (p: Point | null) => p ? toImage(p) : null;
  const line = (l: [Point, Point] | null): [Point, Point] | null => l ? [toImage(l[0]), toImage(l[1])] : null;
  return {
    hip: head ? { centre: toImage(head.centre), radius: head.radius, residual: head.residual } : null,
    knee: image(K), ankle: image(A), trochanter: image(GT), femoralLine: line(condyles), tibialLine: line(plateau), plafondLine: line(plafond),
    femoralShaft: line(femoralShaft), tibialShaft: line(tibialShaft), madFoot: image(foot), wblPoint: image(wbl), values, swapped, together: [...together],
    headFitPoor: Boolean(head && head.residual > 0.02 * head.radius), unit: unitName,
  };
}

/** The plane coordinates (mm, or px without calibration) of an image point. */
export function toPlane(p: Point, mmPerPixel: readonly [number, number] | null): Point {
  return mmPerPixel ? [p[0] * mmPerPixel[0], p[1] * mmPerPixel[1]] : p;
}
export function toImage(p: Point, mmPerPixel: readonly [number, number] | null): Point {
  return mmPerPixel ? [p[0] / mmPerPixel[0], p[1] / mmPerPixel[1]] : p;
}
export { midpoint };
export const NORMAL_KEYS = Object.keys(NORMALS) as ValueKey[];
