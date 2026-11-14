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
import { type Leg, type Landmarks, type Missing, toPlane, toImage } from './measure';
import { CORA_ANGLES } from './normals';
import { angleBetween, along, dot, intersect, midpoint, type Point, rotate, scale, sub, unit } from './plane';

export type StepResult = 'normal' | 'varus' | 'valgus' | 'subluxed' | 'unassessable';
export interface Step { step: 'mad' | 'femur' | 'tibia' | 'joint' | 'subluxation'; result: StepResult; missing?: Missing }

/** The five steps of the malalignment test. Subluxation: the femoral and tibial joint midpoints, across the leg. */
export function malalignmentTest(leg: Leg, points: Landmarks, mmPerPixel: readonly [number, number] | null, lateral: Point | null): Step[] {
  const v = leg.values;
  const graded = (step: Step['step'], value: number | null, missing: Missing | undefined, low: number, high: number, below: StepResult, above: StepResult): Step =>
    value === null ? { step, result: 'unassessable', missing: missing ?? { reason: 'parallel' } }
      : { step, result: value < low ? below : value > high ? above : 'normal' };
  const steps: Step[] = [
    v.MAD.unit === 'mm' ? graded('mad', v.MAD.value, v.MAD.missing, 1, 15, 'valgus', 'varus') : { step: 'mad', result: 'unassessable', missing: v.MAD.missing ?? { reason: 'calibration' } },
    graded('femur', v.mLDFA.value, v.mLDFA.missing, 85, 90, 'valgus', 'varus'),
    graded('tibia', v.MPTA.value, v.MPTA.missing, 85, 90, 'varus', 'valgus'),
    graded('joint', v.JLCA.value, v.JLCA.missing, -2, 2, 'valgus', 'varus'),
  ];
  const names: LandmarkName[] = ['femoralCondyleMedial', 'femoralCondyleLateral', 'tibialPlateauMedial', 'tibialPlateauLateral'];
  const absent = names.filter(name => !points[name]?.length);
  if (absent.length) steps.push({ step: 'subluxation', result: 'unassessable', missing: { landmarks: absent } });
  else if (!mmPerPixel) steps.push({ step: 'subluxation', result: 'unassessable', missing: { reason: 'calibration' } });
  else if (!lateral) steps.push({ step: 'subluxation', result: 'unassessable', missing: { reason: 'side' } });
  else {
    const plane = (name: LandmarkName) => toPlane(points[name]![0], mmPerPixel);
    const femoral = midpoint(plane('femoralCondyleMedial'), plane('femoralCondyleLateral')), tibial = midpoint(plane('tibialPlateauMedial'), plane('tibialPlateauLateral'));
    const across = unit(toPlane(lateral, mmPerPixel))!;
    steps.push({ step: 'subluxation', result: Math.abs(dot(sub(tibial, femoral), across)) > 3 ? 'subluxed' : 'normal' });
  }
  return steps;
}

export interface Cora {
  bone: 'femur' | 'tibia';
  /** In image pixels. */
  point: Point;
  /** The deformity's angle, degrees, the axes' directions (distally), and the transverse bisector's direction, across
   * the bone through the CORA, all on the image. */
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
  const H = plane(leg.hip.centre), K = plane(leg.knee), A = plane(leg.ankle), distal = unit(sub(A, H))!;
  const L = unit(toPlane(lateral, mmPerPixel))!;
  const lateralLine = (line: [Point, Point]) => { const d = unit(sub(plane(line[1]), plane(line[0])))!; return dot(d, L) >= 0 ? d : scale(d, -1); };
  const build = (bone: Cora['bone'], top: Point, topDirection: Point, bottom: Point, bottomDirection: Point): Cora | null => {
    const point = intersect(top, topDirection, bottom, bottomDirection);
    const magnitude = angleBetween(topDirection, scale(bottomDirection, -1));
    if (!point || magnitude === null || magnitude < 0.05) return null;
    const down = unit(scale(bottomDirection, -1))!, up = unit(topDirection)!;
    // Both axes point distally, so their sum runs along the bone; their difference is the transverse bisector, across the
    // bone through the CORA, where a hinge corrects without translation (Paley's ACA).
    const bisector = unit(sub(up, down)) ?? ([-up[1], up[0]] as Point);
    return { bone, point: image(point), magnitude, proximal: { from: image(top), direction: up }, distal: { from: image(bottom), direction: down },
      bisector, level: along(point, top, bottom) ?? NaN };
  };
  const femoralLine = leg.femoralLine, tibialLine = leg.tibialLine, plafondLine = leg.plafondLine;
  // Femur: from the hip centre at the normal mLPFA to the trochanter line, from the knee at the normal mLDFA.
  const trochanter = leg.trochanter ? unit(sub(plane(leg.trochanter), H)) : null;
  const femur = trochanter && femoralLine
    ? build('femur', H, turnedTowards(trochanter, CORA_ANGLES.mLPFA, distal), K, turnedTowards(lateralLine(femoralLine), CORA_ANGLES.mLDFA, scale(distal, -1)))
    : null;
  // Tibia: from the knee centre at the normal MPTA to the plateau, from the ankle at the normal LDTA to the plafond.
  const tibia = tibialLine && plafondLine
    ? build('tibia', K, turnedTowards(scale(lateralLine(tibialLine), -1), CORA_ANGLES.MPTA, distal), A, turnedTowards(lateralLine(plafondLine), CORA_ANGLES.LDTA, scale(distal, -1)))
    : null;
  return { femur, tibia };
}
