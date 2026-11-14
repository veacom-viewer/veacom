// Paley's malalignment test and the CORA of each bone, from the values and constructions of measure.ts.
//
// Malalignment test (Paley, Principles of Deformity Correction, ch. 2; Marques Luís 2021, Fisher 2025): the MAD says
// whether the limb is malaligned; mLDFA, MPTA and JLCA say whether the femur, the tibia or the joint is where it comes
// from; joint midpoints more than 3 mm apart say the knee is subluxed. Each step can be "not assessable".
//
// CORA (Paley ch. 4): the proximal axis is drawn from the proximal joint at its normal angle, the distal axis from the
// distal joint at its normal angle, both mechanical in the frontal plane. They cross at the CORA; the angle between
// them is the deformity's magnitude. The transverse bisector halves that angle across the bone at the CORA; osteotomies
// hinged on it
// correct without translation (Paley's rules 1 and 2).
import type { LandmarkName } from './landmarks';
import { type Leg, type Missing, toPlane, toImage } from './measure';
import { CORA_ANGLES } from './normals';
import { angleBetween, along, dot, intersect, type Point, rotate, scale, sub, unit } from './plane';

export type StepResult = 'normal' | 'varus' | 'valgus' | 'subluxed' | 'unassessable';
export interface Step { step: 'mad' | 'femur' | 'tibia' | 'joint' | 'subluxation'; result: StepResult; missing?: Missing }

/** The five steps of the malalignment test. Subluxation: the femoral and tibial joint midpoints, across the leg. */
export function malalignmentTest(leg: Leg): Step[] {
  const v = leg.values;
  const graded = (step: Step['step'], value: number | null, missing: Missing | undefined, low: number, high: number, below: StepResult, above: StepResult): Step =>
    value === null ? { step, result: 'unassessable', missing: missing ?? { reason: 'parallel' } }
      : { step, result: value < low ? below : value > high ? above : 'normal' };
  return [
    v.MAD.unit === 'mm' ? graded('mad', v.MAD.value, v.MAD.missing, 1, 15, 'valgus', 'varus') : { step: 'mad', result: 'unassessable', missing: v.MAD.missing ?? { reason: 'calibration' } },
    graded('femur', v.mLDFA.value, v.mLDFA.missing, 85, 90, 'valgus', 'varus'),
    graded('tibia', v.MPTA.value, v.MPTA.missing, 85, 90, 'varus', 'valgus'),
    graded('joint', v.JLCA.value, v.JLCA.missing, -2, 2, 'valgus', 'varus'),
    typeof leg.jointOffsetMm === 'number'
      ? { step: 'subluxation', result: leg.jointOffsetMm > 3 ? 'subluxed' : 'normal' }
      : { step: 'subluxation', result: 'unassessable', missing: leg.jointOffsetMm },
  ];
}

/** What a bone's CORA needs that the plan does not have: its landmarks (placed apart), then the patient's right. */
export function coraNeeds(leg: Leg, lateral: Point | null, bone: 'femur' | 'tibia'): Missing | undefined {
  const absent: LandmarkName[] = [], together: LandmarkName[] = [];
  if (!leg.hip) absent.push('femoralHeadContour');
  if (!leg.knee) absent.push('kneeCentre');
  if (!leg.ankle) absent.push('ankleCentre');
  if (bone === 'femur' && !leg.trochanter) absent.push('greaterTrochanterTip');
  const lines: Array<[unknown, LandmarkName, LandmarkName]> = bone === 'femur'
    ? [[leg.femoralLine, 'femoralCondyleMedial', 'femoralCondyleLateral']]
    : [[leg.tibialLine, 'tibialPlateauMedial', 'tibialPlateauLateral'], [leg.plafondLine, 'plafondMedial', 'plafondLateral']];
  for (const [line, medial, lateralName] of lines) if (!line) (leg.together.includes(medial) ? together : absent).push(medial, lateralName);
  if (absent.length) return { landmarks: absent };
  if (leg.hip && leg.ankle && leg.hip.centre[0] === leg.ankle[0] && leg.hip.centre[1] === leg.ankle[1]) together.push('femoralHeadContour', 'ankleCentre');
  if (bone === 'femur' && leg.hip && leg.trochanter && leg.hip.centre[0] === leg.trochanter[0] && leg.hip.centre[1] === leg.trochanter[1]) together.push('femoralHeadContour', 'greaterTrochanterTip');
  if (together.length) return { together };
  return lateral ? undefined : { reason: 'side' };
}

export interface Cora {
  bone: 'femur' | 'tibia';
  /** In image pixels. */
  point: Point;
  /** The deformity's angle, degrees, the axes' directions (distally), and the transverse bisector's direction, across
   * the bone through the CORA, all on the image (unit vectors in image pixels; toPlane gives their directions in mm). */
  magnitude: number;
  proximal: { from: Point; direction: Point }; distal: { from: Point; direction: Point };
  bisector: Point;
  /** Where the CORA lies along the bone, 0 at its proximal joint and 1 at its distal one: outside 0–1 the axes do
   * not meet in the bone, a sign of a multiapical deformity or one at the joint. */
  level: number;
}

/** A direction at `degrees` from `line`, the one that runs towards `towards`. */
function turnedTowards(line: Point, degrees: number, towards: Point): Point {
  const a = rotate(line, degrees), b = rotate(line, -degrees);
  return dot(a, towards) >= dot(b, towards) ? a : b;
}

/** The CORA of the femur and of the tibia, where their landmarks allow; null where they do not, or where the axes are
 * parallel (no angular deformity). Constructed in millimetres, so the angles hold on non-square pixels. */
export function coras(leg: Leg, mmPerPixel: readonly [number, number] | null, lateral: Point | null): { femur: Cora | null; tibia: Cora | null } {
  if (!lateral || !leg.hip || !leg.knee || !leg.ankle) return { femur: null, tibia: null };
  const plane = (p: Point) => toPlane(p, mmPerPixel), image = (p: Point) => toImage(p, mmPerPixel);
  // A direction found in mm, given back on the image.
  const onImage = (d: Point): Point => unit(image(d)) ?? d;
  const H = plane(leg.hip.centre), K = plane(leg.knee), A = plane(leg.ankle), distal = unit(sub(A, H)), L = unit(toPlane(lateral, mmPerPixel));
  // A hip centre on the ankle, or a joint line of no length, has no direction: no CORA.
  if (!distal || !L) return { femur: null, tibia: null };
  const lateralLine = (line: [Point, Point]) => { const d = unit(sub(plane(line[1]), plane(line[0]))); return d && (dot(d, L) >= 0 ? d : scale(d, -1)); };
  const build = (bone: Cora['bone'], top: Point, topDirection: Point, bottom: Point, bottomDirection: Point): Cora | null => {
    const point = intersect(top, topDirection, bottom, bottomDirection);
    const magnitude = angleBetween(topDirection, scale(bottomDirection, -1));
    if (!point || magnitude === null || magnitude < 0.05) return null;
    const down = unit(scale(bottomDirection, -1))!, up = unit(topDirection)!;
    // Both axes point distally, so their sum runs along the bone; their difference is the transverse bisector, across the
    // bone through the CORA, where a hinge corrects without translation (Paley's ACA).
    const bisector = unit(sub(up, down)) ?? ([-up[1], up[0]] as Point);
    return { bone, point: image(point), magnitude, proximal: { from: image(top), direction: onImage(up) }, distal: { from: image(bottom), direction: onImage(down) },
      bisector: onImage(bisector), level: along(point, top, bottom) ?? NaN };
  };
  const femoralLine = leg.femoralLine, tibialLine = leg.tibialLine, plafondLine = leg.plafondLine;
  // Femur: from the hip centre at the normal mLPFA to the trochanter line, from the knee at the normal mLDFA.
  const trochanter = leg.trochanter ? unit(sub(plane(leg.trochanter), H)) : null;
  const condyles = femoralLine && lateralLine(femoralLine), plateau = tibialLine && lateralLine(tibialLine), plafond = plafondLine && lateralLine(plafondLine);
  const femur = trochanter && condyles
    ? build('femur', H, turnedTowards(trochanter, CORA_ANGLES.mLPFA, distal), K, turnedTowards(condyles, CORA_ANGLES.mLDFA, scale(distal, -1)))
    : null;
  // Tibia: from the knee centre at the normal MPTA to the plateau, from the ankle at the normal LDTA to the plafond.
  const tibia = plateau && plafond
    ? build('tibia', K, turnedTowards(scale(plateau, -1), CORA_ANGLES.MPTA, distal), A, turnedTowards(plafond, CORA_ANGLES.LDTA, scale(distal, -1)))
    : null;
  return { femur, tibia };
}
