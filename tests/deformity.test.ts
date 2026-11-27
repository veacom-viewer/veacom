import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertClose } from './support';
import {
  applyRigid, composeRigid, fitCircle, intersect, invertRigid, isIdentityRigid, pointToSegment, polygonArea,
  signedAngle, simplifyClosedPolygon, type Point, type Rigid,
} from '../src/imaging/deformity/plane';
import { lateralOnImage, measureLeg, type LegInput } from '../src/imaging/deformity/measure';
import { coraNeeds, coras, malalignmentTest } from '../src/imaging/deformity/analysis';
import {
  coraCut, coraPlaceable, fragmentFor, insertFragmentVertex, MAX_FRAGMENT_POINTS, moved, movedLandmarks, paleyRule,
  removeFragmentVertex, rotationHandlePoint, simplifyFragment, simulate, simulateMany, solveAngle,
  solveAngleMany, sortOsteotomies, type Osteotomy,
} from '../src/imaging/deformity/osteotomy';

const deg = Math.PI / 180;
// Expected values below are worked out by hand from the points (the comment beside each), not by the kernel.

/** A right leg, lateral towards −x, in 1 mm pixels: straight, with a plateau tilted 2 mm over 40 mm. */
function straight(): LegInput {
  return {
    side: 'R', mmPerPixel: [1, 1], lateral: [-1, 0],
    points: {
      femoralHeadContour: [[-20, 0], [0, -20], [20, 0]], greaterTrochanterTip: [[-50, 0]],
      femoralShaftProximal: [[-25, 100]], femoralShaftDistal: [[0, 350]], kneeCentre: [[0, 400]],
      femoralCondyleMedial: [[20, 410]], femoralCondyleLateral: [[-20, 410]],
      tibialPlateauMedial: [[20, 414]], tibialPlateauLateral: [[-20, 416]],
      tibialShaftProximal: [[0, 500]], tibialShaftDistal: [[0, 700]],
      plafondMedial: [[15, 805]], plafondLateral: [[-15, 805]], ankleCentre: [[0, 800]],
    },
  };
}

describe('the circle through the femoral head outline', () => {
  it('is the circumcircle of three points, and fits more points by least squares', () => {
    const circle = fitCircle([[-20, 0], [0, -20], [20, 0]])!;
    assertClose(circle.centre[0], 0, 12); assertClose(circle.centre[1], 0, 12); assertClose(circle.radius, 20, 12);
    // Points of a circle of radius 24 at (1000, 2000), at large pixel coordinates.
    const points: Point[] = [10, 70, 130, 200, 260].map(a => [1000 + 24 * Math.cos(a * deg), 2000 + 24 * Math.sin(a * deg)]);
    const fitted = fitCircle(points)!;
    assertClose(fitted.centre[0], 1000, 9); assertClose(fitted.centre[1], 2000, 9); assertClose(fitted.radius, 24, 9);
    assert.ok(fitted.residual < 1e-9);
    // Two points, or points on a line, give no circle.
    assert.equal(fitCircle([[0, 0], [1, 1]]), null);
    assert.equal(fitCircle([[0, 0], [1, 1], [2, 2]]), null);
  });
  it('reports how far the points stray from the circle', () => {
    const circle = fitCircle([[-20, 0], [0, -20], [20, 0], [0, 22]])!;
    assert.ok(circle.residual > 0.4 && circle.residual < 1.5);
  });
});

describe('the alignment of a leg', () => {
  it('measures each angle as Paley defines it', () => {
    const leg = measureLeg(straight());
    const v = leg.values;
    assertClose(v.mLPFA.value, 90, 9); // H (0,0), K straight below, GT level and lateral
    assertClose(v.mLDFA.value, 90, 9); // condyles level, axis vertical
    assertClose(v.aLDFA.value, Math.acos(25 / Math.hypot(25, 250)) / deg, 9); // shaft (−25, −250) against (−1, 0): 84.29°
    assertClose(v.AMA.value, Math.atan(25 / 250) / deg, 9); // 5.71°
    assertClose(v.MPTA.value, 90 + Math.atan(2 / 40) / deg, 9); // medial plateau 2 mm higher: 92.86°
    assertClose(v.LDTA.value, 90, 9);
    assertClose(v.JLCA.value, Math.atan(2 / 40) / deg, 9); // lateral end lower: converging medially, positive
    assertClose(v.HKA.value, 0, 9); assertClose(v.MAD.value, 0, 9);
    assertClose(v.WBL.value, 50, 9); // x = 0 is halfway along the plateau
    assertClose(v.femurLength.value, 400, 9); assertClose(v.tibiaLength.value, 400, 9); assertClose(v.limbLength.value, 800, 9);
    assert.equal(v.MPTA.verdict, 'high');
    assert.equal(v.mLDFA.verdict, 'normal');
    assert.deepEqual(leg.swapped, []);
  });

  it('gives varus a positive HKA and a medial MAD', () => {
    const input = straight();
    input.points = { ...input.points, ankleCentre: [[40, 800]] };
    const v = measureLeg(input).values;
    assertClose(v.HKA.value, Math.atan(40 / 400) / deg, 9); // 5.71° varus
    assertClose(v.MAD.value, 40 * 400 / Math.hypot(40, 800), 9); // |H→A × H→K| / |H→A| = 19.98 mm medial
    assert.equal(v.MAD.verdict, 'high');
    // The tibial axis (40, 400) against the medial plateau (40, −2).
    assertClose(v.MPTA.value, Math.acos((40 * 40 - 400 * 2) / (Math.hypot(40, 400) * Math.hypot(40, 2))) / deg, 9);
  });

  it('keeps every angle and its sign on a mirrored film, and for the left leg', () => {
    const input = straight();
    const mirror = (p: readonly Point[]) => p.map(([x, y]) => [-x, y] as Point);
    const mirrored: LegInput = { ...input, lateral: [1, 0], points: Object.fromEntries(Object.entries(input.points).map(([name, points]) => [name, mirror(points)])) };
    const a = measureLeg(input).values, b = measureLeg(mirrored).values;
    for (const key of ['mLPFA', 'mLDFA', 'aLDFA', 'MPTA', 'LDTA', 'JLCA', 'HKA', 'MAD', 'WBL'] as const) assertClose(b[key].value, a[key].value!, 9, key);
    // The left leg on the same film as the mirrored right one.
    const left = measureLeg({ ...mirrored, side: 'L' }).values;
    assertClose(left.JLCA.value, a.JLCA.value!, 9);
  });

  it('measures in millimetres on pixels that are not square', () => {
    // 0.2 mm across, 0.4 mm down: the tibia leans 100 px across 1000 px down, 20 mm across 400 mm.
    const v = measureLeg({ side: 'R', mmPerPixel: [0.2, 0.4], lateral: [-1, 0], points: {
      femoralHeadContour: [[-100, -1000], [0, -1050], [100, -1000]], kneeCentre: [[0, 0]], ankleCentre: [[100, 1000]] } }).values;
    const hip = fitCircle([[-20, -400], [0, -420], [20, -400]])!.centre; // the same outline in mm
    assertClose(v.HKA.value, (Math.atan(20 / 400) + Math.atan(-hip[0] / -hip[1])) / deg, 9);
    assert.equal(v.femurLength.unit, 'mm');
    assertClose(v.tibiaLength.value, Math.hypot(20, 400), 9);
  });

  it('says what is missing, and needs the side for every sided value', () => {
    const v = measureLeg({ side: 'R', mmPerPixel: [1, 1], lateral: [-1, 0], points: { kneeCentre: [[0, 400]] } }).values;
    assert.deepEqual(v.mLDFA.missing, { landmarks: ['femoralHeadContour', 'femoralCondyleMedial', 'femoralCondyleLateral'] });
    assert.equal(v.mLDFA.value, null);
    const unsided = measureLeg({ ...straight(), lateral: null }).values;
    assert.deepEqual(unsided.MPTA.missing, { reason: 'side' });
    assert.equal(unsided.MAD.value, null);
    // mLPFA and the lengths need no side.
    assertClose(unsided.mLPFA.value, 90, 9);
    assertClose(unsided.limbLength.value, 800, 9);
  });

  it('measures aLDFA from the shaft and condyles before the hip, knee or ankle is placed', () => {
    const input: LegInput = { side: 'R', mmPerPixel: [1, 1], lateral: [-1, 0], points: {
      femoralShaftProximal: [[0, 100]], femoralShaftDistal: [[0, 350]],
      femoralCondyleMedial: [[20, 410]], femoralCondyleLateral: [[-20, 410]],
    } };
    assert.equal(measureLeg(input).values.aLDFA.value, 90);
    const tilted: LegInput['points'] = { ...input.points, femoralShaftProximal: [[-25, 100]] };
    assertClose(measureLeg({ ...input, points: tilted }).values.aLDFA.value, Math.atan2(250, 25) / deg, 9);
    assert.deepEqual(measureLeg({ ...input, lateral: null }).values.aLDFA.missing, { reason: 'side' });
    const parallel = measureLeg({ ...input, lateral: [0, 1] }).values.aLDFA;
    assert.equal(parallel.value, null);
    assert.deepEqual(parallel.missing, { reason: 'parallel' });
  });

  it('gives lengths in pixels without a calibration, and no verdict on the MAD', () => {
    const input = straight();
    input.points = { ...input.points, ankleCentre: [[40, 800]] };
    const v = measureLeg({ ...input, mmPerPixel: null }).values;
    assert.equal(v.MAD.unit, 'px'); assert.equal(v.MAD.verdict, undefined);
    assert.equal(v.femurLength.unit, 'px');
  });

  it('finds medial and lateral points placed on the wrong sides', () => {
    const input = straight();
    input.points = { ...input.points, femoralCondyleMedial: [[-20, 410]], femoralCondyleLateral: [[20, 410]] };
    const leg = measureLeg(input);
    assert.deepEqual(leg.swapped, ['femoralCondyleMedial', 'femoralCondyleLateral']);
    // The angle still uses the film's side, so it does not turn into its supplement.
    assertClose(leg.values.mLDFA.value, 90, 9);
  });

  it('takes the lateral side from Patient Orientation, or from the reader', () => {
    assert.deepEqual(lateralOnImage('R', ['L', 'F'], undefined), [-1, 0]);
    assert.deepEqual(lateralOnImage('L', ['L', 'F'], undefined), [1, 0]);
    assert.deepEqual(lateralOnImage('R', ['R', 'F'], undefined), [1, 0]);
    assert.deepEqual(lateralOnImage('R', ['F', 'R'], undefined), [0, 1]); // a film turned a quarter
    assert.deepEqual(lateralOnImage('R', undefined, 'left'), [-1, 0]);
    assert.equal(lateralOnImage('R', undefined, undefined), null);
    assert.equal(lateralOnImage('R', ['A', 'F'], undefined), null); // a lateral view has no right
  });
});

describe('the malalignment test and the CORA', () => {
  it('names where a varus knee comes from', () => {
    const input = straight();
    input.points = { ...input.points, ankleCentre: [[40, 800]] };
    const steps = malalignmentTest(measureLeg(input));
    assert.deepEqual(steps.map(step => [step.step, step.result]), [['mad', 'varus'], ['femur', 'normal'], ['tibia', 'normal'], ['joint', 'varus'], ['subluxation', 'normal']]);
    const pixels = malalignmentTest(measureLeg({ ...input, mmPerPixel: null }));
    assert.equal(pixels[0].result, 'unassessable');
    assert.deepEqual(pixels[4].missing, { reason: 'calibration' });
  });

  it('constructs the tibial CORA from the normal MPTA and LDTA', () => {
    // A proximal axis at 87° to a level plateau runs 3° medial of straight down; past C = K + 100 (sin 3°, cos 3°) the
    // shaft runs 1° medial, so the plafond, level, is at 89°. The CORA is C, and the bend 2°.
    const K: Point = [0, 400], C: Point = [100 * Math.sin(3 * deg), 400 + 100 * Math.cos(3 * deg)];
    const A: Point = [C[0] + 300 * Math.sin(1 * deg), C[1] + 300 * Math.cos(1 * deg)];
    const input: LegInput = { side: 'R', mmPerPixel: [1, 1], lateral: [-1, 0], points: {
      femoralHeadContour: [[-20, 0], [0, -20], [20, 0]], kneeCentre: [K], ankleCentre: [A],
      tibialPlateauMedial: [[20, 410]], tibialPlateauLateral: [[-20, 410]],
      plafondMedial: [[A[0] + 15, A[1]]], plafondLateral: [[A[0] - 15, A[1]]] } };
    const { tibia, femur } = coras(measureLeg(input), input.mmPerPixel, input.lateral);
    assert.equal(femur, null);
    assertClose(tibia!.point[0], C[0], 9); assertClose(tibia!.point[1], C[1], 9);
    assertClose(tibia!.magnitude, 2, 9);
    assertClose(tibia!.level, 0.25, 2);
  });

  it('has no CORA in a straight bone', () => {
    const input = straight();
    input.points = { ...input.points, tibialPlateauMedial: [[20, 410]], tibialPlateauLateral: [[-20, 410]], plafondMedial: [[15, 805]], plafondLateral: [[-15, 805]] };
    // Level joints at 90° are 3° and 1° from the normal angles, so the axes cross, far above the knee.
    const { tibia } = coras(measureLeg(input), [1, 1], [-1, 0]);
    assert.ok(tibia && (tibia.level < 0 || tibia.level > 1), 'The CORA of joint-level deformities lies outside the bone.');
  });

  it('measures subluxation across the leg, not across the film', () => {
    // A leg running along (0.6, 0.8) on the film, lateral −x. The tibial joint midpoint lies 8 mm further down the leg
    // than the femoral one, (4.8, 6.4), and not across it: no subluxation. Across the film it would read 4.8 mm.
    const d: Point = [0.6, 0.8], at = (t: number, across = 0): Point => [t * d[0] - across * d[1], t * d[1] + across * d[0]];
    const input: LegInput = { side: 'R', mmPerPixel: [1, 1], lateral: [-1, 0], points: {
      femoralHeadContour: [at(-20), at(0, 20), at(20)], kneeCentre: [at(400)], ankleCentre: [at(800)],
      femoralCondyleMedial: [at(400, -20)], femoralCondyleLateral: [at(400, 20)],
      tibialPlateauMedial: [at(408, -20)], tibialPlateauLateral: [at(408, 20)] } };
    const subluxation = (points: LegInput['points']) => malalignmentTest(measureLeg({ ...input, points })).at(-1)!.result;
    assert.equal(subluxation(input.points), 'normal');
    // Shifted 4 mm across the leg, it is.
    assert.equal(subluxation({ ...input.points, tibialPlateauMedial: [at(408, -16)], tibialPlateauLateral: [at(408, 24)] }), 'subluxed');
  });

  it('withholds subluxation until the landmarks define a transverse direction', () => {
    const input = straight();
    const joints: LegInput['points'] = {
      femoralCondyleMedial: [[20, 410]], femoralCondyleLateral: [[-20, 410]],
      tibialPlateauMedial: [[30, 415]], tibialPlateauLateral: [[-10, 415]],
    };
    const step = (points: LegInput['points']) => malalignmentTest(measureLeg({ ...input, points })).at(-1);
    const noAxis = { step: 'subluxation', result: 'unassessable', missing: { reason: 'axis' } };
    assert.deepEqual(step(joints), noAxis);
    assert.deepEqual(step({ ...joints, kneeCentre: [[0, 400]], ankleCentre: [[0, 400]] }), noAxis);
    assert.deepEqual(step({ ...joints, kneeCentre: [[0, 400]], ankleCentre: [[100, 400]] }),
      { step: 'subluxation', result: 'unassessable', missing: { reason: 'parallel' } });
    assert.deepEqual(step({ ...joints, kneeCentre: [[0, 400]], ankleCentre: [[0, 800]] }),
      { step: 'subluxation', result: 'subluxed' });
  });

  it('gives no line, and says why, for a pair placed on one point', () => {
    const input = straight();
    // Both condyles on one point (as a click or a drag can put them, or a file can hold them).
    input.points = { ...input.points, femoralCondyleMedial: [[0, 410]], femoralCondyleLateral: [[0.2, 410]] };
    const leg = measureLeg(input);
    assert.deepEqual(leg.together, ['femoralCondyleMedial', 'femoralCondyleLateral']);
    assert.deepEqual(malalignmentTest(leg).at(-1)?.missing, { together: leg.together });
    for (const key of ['mLDFA', 'aLDFA', 'JLCA'] as const) {
      assert.equal(leg.values[key].value, null, key);
      assert.deepEqual(leg.values[key].missing, { together: ['femoralCondyleMedial', 'femoralCondyleLateral'] }, key);
    }
    // The CORA needs the line; it is not built, and nothing throws.
    const both = coras(leg, [1, 1], [-1, 0]);
    assert.equal(both.femur, null);
    assert.deepEqual(coraNeeds(leg, [-1, 0], 'femur'), { together: ['femoralCondyleMedial', 'femoralCondyleLateral'] });
    // The plateau and the plafond, too.
    input.points = { ...input.points, tibialPlateauMedial: [[3, 415]], tibialPlateauLateral: [[3, 415]] };
    assert.doesNotThrow(() => coras(measureLeg(input), [1, 1], [-1, 0]));
    assert.equal(measureLeg(input).values.MPTA.value, null);
  });

  it('says what a CORA lacks before calling the axes parallel', () => {
    const input = straight(), full = measureLeg(input);
    assert.equal(coraNeeds(full, [-1, 0], 'tibia'), undefined);
    assert.deepEqual(coraNeeds(full, null, 'tibia'), { reason: 'side' });
    const { ankleCentre: _ankle, greaterTrochanterTip: _trochanter, ...rest } = input.points;
    const partial = measureLeg({ ...input, points: rest });
    assert.deepEqual(coraNeeds(partial, [-1, 0], 'femur'), { landmarks: ['ankleCentre', 'greaterTrochanterTip'] });
    assert.deepEqual(coraNeeds(partial, [-1, 0], 'tibia'), { landmarks: ['ankleCentre'] });
  });
});

describe('a simulated osteotomy', () => {
  const plan = (input: LegInput, osteotomy: Partial<Osteotomy> = {}): Osteotomy => {
    const leg = measureLeg(input), cut: [Point, Point] = [[20, 500], [-20, 500]];
    return { bone: 'tibia', cut, hinge: [-20, 500], wedge: 'opening', degrees: 10, direction: 'valgus', shiftLateral: 0, shiftDistal: 0, lengthen: 0, fragment: fragmentFor(cut, 'tibia', leg, input.mmPerPixel)!, ...osteotomy };
  };
  it('turns the distal fragment about the hinge and measures again', () => {
    const input = straight(), before = measureLeg(input), osteotomy = plan(input);
    // The fragment: the cut carried 25 mm on each side, then down to 60 mm past the ankle.
    assert.deepEqual(osteotomy.fragment, [[45, 500], [-45, 500], [-45, 860], [45, 860]]);
    const result = simulate(input, before, osteotomy)!;
    // Valgus turns the ankle laterally (−x): about (−20, 500) by 10°, (20, 300) goes to (20 cos 10° − 300 sin 10°, ...).
    const ankle = result.leg.ankle!;
    assertClose(ankle[0], -20 + 20 * Math.cos(10 * deg) - 300 * Math.sin(10 * deg), 9);
    assertClose(ankle[1], 500 + 20 * Math.sin(10 * deg) + 300 * Math.cos(10 * deg), 9);
    // The knee and the plateau stay; the tibial axis turns, so MPTA grows and the knee goes into valgus.
    assert.deepEqual(result.leg.knee, before.knee);
    assert.ok(result.leg.values.MPTA.value! > before.values.MPTA.value!);
    assert.ok(result.leg.values.HKA.value! < 0);
    assertClose(result.wedgeHeight, 2 * 40 * Math.sin(5 * deg), 9);
    // Source landmarks are left as they were.
    assert.deepEqual(input.points.ankleCentre, [[0, 800]]);
  });

  it('shifts and lengthens along the bone, laterally and distally', () => {
    const input = straight(), before = measureLeg(input);
    const result = simulate(input, before, plan(input, { degrees: 0, shiftLateral: 5, shiftDistal: 2, lengthen: 10 }))!;
    assert.deepEqual(result.leg.ankle, [-5, 812]);
    assertClose(result.lengthChange, Math.hypot(5, 812) - 800, 9);
  });

  it('withholds a simulated correction when the bone runs along the film lateral', () => {
    const input = straight();
    input.points = { ...input.points, ankleCentre: [[100, 400]] };
    assert.equal(simulate(input, measureLeg(input), plan(input, { shiftLateral: 5 })), null);
  });

  it('moves only the landmarks inside the fragment', () => {
    const input = straight(), osteotomy = plan(input);
    const moved = movedLandmarks(input.points, osteotomy, { pivot: [0, 0], degrees: 0, shift: [7, 0] }, [1, 1], [0, 1]);
    assert.deepEqual(moved.kneeCentre, [[0, 400]]);
    assert.deepEqual(moved.ankleCentre, [[7, 800]]);
    assert.deepEqual(moved.femoralHeadContour, input.points.femoralHeadContour);
  });

  it('solves the angle that brings the weight-bearing line through the target', () => {
    const input = straight();
    input.points = { ...input.points, ankleCentre: [[40, 800]], plafondMedial: [[55, 805]], plafondLateral: [[25, 805]] };
    const before = measureLeg(input), osteotomy = plan(input);
    for (const target of [{ kind: 'mad' as const, mm: 0 }, { kind: 'wbl' as const, percent: 62.5 }]) {
      const solved = solveAngle(input, before, osteotomy, target)!;
      assert.equal(solved.direction, 'valgus');
      const after = simulate(input, before, { ...osteotomy, ...solved })!.leg.values;
      if (target.kind === 'mad') assertClose(after.MAD.value, 0, 6);
      else assertClose(after.WBL.value, 62.5, 6);
    }
  });

  it('solves a femoral cut on the leg measured again, where the knee moves too', () => {
    const input = straight();
    input.points = { ...input.points, ankleCentre: [[40, 800]], plafondMedial: [[55, 805]], plafondLateral: [[25, 805]] };
    const before = measureLeg(input), cut: [Point, Point] = [[20, 300], [-20, 300]];
    const osteotomy = plan(input, { bone: 'femur', cut, hinge: [-20, 300], fragment: fragmentFor(cut, 'femur', before, input.mmPerPixel)! });
    for (const target of [{ kind: 'mad' as const, mm: 0 }, { kind: 'wbl' as const, percent: 50 }]) {
      const solved = solveAngle(input, before, osteotomy, target)!;
      const after = simulate(input, before, { ...osteotomy, ...solved })!;
      assert.notDeepEqual(after.leg.knee, before.knee, 'The knee moves with a femoral fragment.');
      if (target.kind === 'mad') assertClose(after.leg.values.MAD.value, 0, 6);
      else assertClose(after.leg.values.WBL.value, 50, 6);
    }
  });

  it('moves every landmark beyond the cut, whatever the fragment\'s outline', () => {
    const input = straight(), before = measureLeg(input);
    // The outline dragged off the ankle: the ankle is still on the distal fragment.
    const narrow = plan(input, { fragment: [[45, 500], [-45, 500], [-45, 600], [45, 600]] });
    assert.notDeepEqual(simulate(input, before, narrow)!.leg.ankle, before.ankle);
  });

  it('tells an opening wedge from a closing one by where the first cortex goes', () => {
    const input = straight(), before = measureLeg(input);
    // Lateral hinge (−x) and valgus: the medial cortex moves distally and the cut opens; varus closes it.
    assert.equal(simulate(input, before, plan(input))!.wedge, 'opening');
    assert.equal(simulate(input, before, plan(input, { direction: 'varus' }))!.wedge, 'closing');
    // A medial hinge with valgus closes the cut at the lateral cortex: a closing wedge HTO.
    assert.equal(simulate(input, before, plan(input, { cut: [[-20, 500], [20, 500]], hinge: [20, 500] }))!.wedge, 'closing');
    assert.equal(simulate(input, before, plan(input, { degrees: 0 }))!.wedge, null);
  });

  it('measures the wedge from the hinge to the cortex across the cut, wherever the hinge is', () => {
    const input = straight(), before = measureLeg(input);
    assertClose(simulate(input, before, plan(input, { hinge: [0, 500] }))!.wedgeHeight, 2 * 20 * Math.sin(5 * deg), 9);
    // The cut drawn medial (+x) to lateral, varus 10°: hinged laterally it closes the medial cortex; hinged medially,
    // on the cut's first point, it opens the lateral cortex, by the same 2 × 40 × sin 5° = 6.97 mm.
    const lateral = simulate(input, before, plan(input, { direction: 'varus' }))!;
    assert.equal(lateral.wedge, 'closing'); assertClose(lateral.wedgeHeight, 2 * 40 * Math.sin(5 * deg), 9);
    const medial = simulate(input, before, plan(input, { direction: 'varus', hinge: [20, 500] }))!;
    assert.equal(medial.wedge, 'opening'); assertClose(medial.wedgeHeight, 2 * 40 * Math.sin(5 * deg), 9);
    assert.deepEqual(medial.cortex, [-20, 500]);
  });

  // A tibia bent `bend` degrees at C, 100 mm below a level plateau: proximal axis 3° medial of straight down (MPTA
  // 87°), the distal one the rest of the bend the other way, and a level plafond at the normal LDTA. Built as in the
  // CORA test above.
  const bentTibia = (bend: number, spacing: readonly [number, number] = [1, 1]) => {
    const K: Point = [0, 400], C: Point = [100 * Math.sin(3 * deg), 400 + 100 * Math.cos(3 * deg)];
    const q: Point = [Math.sin((3 - bend) * deg), Math.cos((3 - bend) * deg)], A: Point = [C[0] + 300 * q[0], C[1] + 300 * q[1]];
    // The plafond at the normal LDTA (89°) to the distal axis, pointing laterally (−x).
    const turnBy = (v: Point, a: number): Point => [v[0] * Math.cos(a) - v[1] * Math.sin(a), v[0] * Math.sin(a) + v[1] * Math.cos(a)];
    const up: Point = [-q[0], -q[1]], L = [turnBy(up, 89 * deg), turnBy(up, -89 * deg)].find(v => v[0] < 0)!;
    // Built in mm, placed on a film of `spacing` mm per pixel.
    const px = (p: Point): Point => [p[0] / spacing[0], p[1] / spacing[1]];
    const input: LegInput = { side: 'R', mmPerPixel: [spacing[0], spacing[1]], lateral: [-1, 0], points: {
      femoralHeadContour: ([[-20, 0], [0, -20], [20, 0]] as Point[]).map(px), kneeCentre: [px(K)], ankleCentre: [px(A)],
      tibialPlateauMedial: [px([20, 410])], tibialPlateauLateral: [px([-20, 410])],
      plafondMedial: [px([A[0] - 15 * L[0], A[1] - 15 * L[1]])], plafondLateral: [px([A[0] + 15 * L[0], A[1] + 15 * L[1]])] } };
    const cora = coras(measureLeg(input), input.mmPerPixel, [-1, 0]).tibia!;
    // The translation left after turning the distal axis back onto the proximal one about a hinge, worked out here by
    // turning the axis itself, independently of paleyRule.
    const residual = (hinge: Point, degrees: number) => {
      const p: Point = [Math.sin(3 * deg), Math.cos(3 * deg)];
      const turned = (sign: number) => turnBy(q, sign * degrees * deg);
      const sign = Math.abs(Math.atan2(turned(1)[0], turned(1)[1]) - 3 * deg) < 1e-9 ? 1 : -1;
      const arm = turnBy([A[0] - hinge[0], A[1] - hinge[1]], sign * degrees * deg), moved: Point = [hinge[0] + arm[0], hinge[1] + arm[1]];
      return Math.abs((moved[0] - K[0]) * p[1] - (moved[1] - K[1]) * p[0]);
    };
    const cutAt = (y: number): Pick<Osteotomy, 'cut'> => ({ cut: [[C[0] + 25, y], [C[0] - 25, y]] });
    // Across the bone towards the lateral cortex, and down it, from the CORA, in mm (the bisector is given on the image).
    const inMm: Point = [cora.bisector[0] * spacing[0], cora.bisector[1] * spacing[1]], size = Math.hypot(inMm[0], inMm[1]);
    const bisector: Point = [inMm[0] / size, inMm[1] / size];
    const across = bisector[0] < 0 ? bisector : [-bisector[0], -bisector[1]] as Point;
    const along: Point = [across[1], -across[0]]; // −across[0] > 0: distally
    const at = (a: number, d: number): Point => [C[0] + a * across[0] + d * along[0], C[1] + a * across[1] + d * along[1]];
    return { input, cora, residual, cutAt, at, C, px };
  };

  it('names the Paley rule against a real CORA, and the translation an off-bisector hinge leaves', () => {
    const { input, cora, residual, cutAt, at, C } = bentTibia(10);
    assertClose(cora.magnitude, 10, 6);
    // Hinge on the lateral cortex at the CORA's level, the cut through the CORA: rule 1, nothing left over.
    const atCora = at(15, 0);
    const one = paleyRule(plan(input, { ...cutAt(C[1]), hinge: atCora, degrees: 10 }), cora, [1, 1])!;
    assert.equal(one.rule, 1);
    assertClose(residual(atCora, 10), 0, 6);
    assertClose(one.translation, residual(atCora, 10), 1);
    // Hinge and cut 80 mm further down the bone: rule 3, and the translation the turn really leaves, 2·80·sin 5°.
    const low = at(0, 80);
    const three = paleyRule(plan(input, { ...cutAt(low[1]), hinge: low, degrees: 10 }), cora, [1, 1])!;
    assert.equal(three.rule, 3);
    assertClose(three.translation, residual(low, 10), 1);
    assertClose(three.translation, 2 * 80 * Math.sin(5 * deg), 1);
    // Hinge on the bisector at the CORA's level, cut lower: rule 2.
    assert.equal(paleyRule(plan(input, { ...cutAt(C[1] + 40), hinge: atCora, degrees: 10 }), cora, [1, 1])!.rule, 2);
    // Measured in pixels, the rules' 5 mm tolerance cannot be told: no rule.
    assert.equal(paleyRule(plan(input, { ...cutAt(C[1]), hinge: atCora, degrees: 10 }), cora, null), null);
  });

  it('gives the review\'s 10.5° case: no translation 30 mm across the bone, 2·80·sin 5.25° 80 mm down it', () => {
    const { input, cora, residual, cutAt, at, C } = bentTibia(10.5);
    assertClose(cora.magnitude, 10.5, 6);
    const lateral = at(30, 0);
    const across = paleyRule(plan(input, { ...cutAt(C[1]), hinge: lateral, degrees: 10.5 }), cora, [1, 1])!;
    assert.equal(across.rule, 1);
    assertClose(residual(lateral, 10.5), 0, 6);
    assertClose(across.translation, 0, 6);
    const low = at(0, 80);
    const down = paleyRule(plan(input, { ...cutAt(low[1]), hinge: low, degrees: 10.5 }), cora, [1, 1])!;
    assert.equal(down.rule, 3);
    assertClose(down.translation, residual(low, 10.5), 6);
    assertClose(down.translation, 2 * 80 * Math.sin(5.25 * deg), 6); // 14.64 mm
  });

  it('measures the hinge off the bisector in mm on non-square pixels, the bisector given on the image', () => {
    const spacing = [0.2, 0.4] as const;
    const { input, cora, cutAt, at, C, px } = bentTibia(10.5, spacing);
    assertClose(cora.magnitude, 10.5, 6);
    // On the image, the bisector is the mm one with each axis divided by its spacing.
    const square = bentTibia(10.5).cora.bisector, expected: Point = [square[0] / spacing[0], square[1] / spacing[1]];
    const size = Math.hypot(expected[0], expected[1]);
    assertClose(Math.abs(cora.bisector[0] * expected[1] - cora.bisector[1] * expected[0]) / size, 0, 9);
    const osteotomy = (hinge: Point, y: number): Osteotomy => ({ ...plan(input), cut: cutAt(y).cut.map(px) as [Point, Point], hinge: px(hinge), degrees: 10.5 });
    // 30 mm across the bone at the CORA's level: on the bisector, rule 1, no translation.
    const across = paleyRule(osteotomy(at(30, 0), C[1]), cora, input.mmPerPixel)!;
    assert.equal(across.rule, 1);
    assertClose(across.offset, 0, 6);
    // 80 mm down the bone: rule 3 and 2·80·sin 5.25°, in mm.
    const low = at(0, 80), down = paleyRule(osteotomy(low, low[1]), cora, input.mmPerPixel)!;
    assert.equal(down.rule, 3);
    assertClose(down.translation, 2 * 80 * Math.sin(5.25 * deg), 6);
  });
});

describe('multi-level osteotomies, joint solvers, polygon editing and CORA presets', () => {
  const mkCut = (input: LegInput, bone: 'femur' | 'tibia', cut: [Point, Point], patch: Partial<Osteotomy> = {}): Osteotomy => {
    const leg = measureLeg(input);
    return {
      bone, cut, hinge: cut[1], wedge: 'opening', degrees: 0, direction: 'valgus',
      shiftLateral: 0, shiftDistal: 0, lengthen: 0, fragment: fragmentFor(cut, bone, leg, input.mmPerPixel)!, ...patch,
    };
  };

  it('composes a double-level DFO + HTO proximally to distally regardless of array order', () => {
    const input = straight(), before = measureLeg(input);
    const femurCut = mkCut(input, 'femur', [[20, 300], [-20, 300]], { degrees: 6, direction: 'varus', shiftLateral: 3, shiftDistal: 2 });
    const tibiaCut = mkCut(input, 'tibia', [[20, 500], [-20, 500]], { degrees: 9, direction: 'valgus', shiftLateral: -2, lengthen: 4 });
    // Pass tibia first, femur second: simulation must still compose femur (proximal) then tibia (distal).
    const sim = simulateMany(input, before, [tibiaCut, femurCut])!;
    assert.deepEqual(sim.cuts.map(c => c.osteotomy.bone), ['femur', 'tibia']);
    assert.deepEqual(sim.cuts.map(c => c.index), [1, 0]);
    const [femSim, tibSim] = sim.cuts;
    // Femoral head stays fixed; knee and plateau move by M_femur only; ankle moves by M_femur ∘ M_tibia.
    assert.deepEqual(sim.leg.hip?.centre, before.hip?.centre);
    const expectedKnee = moved(femSim.localMotion, before.knee!, input.mmPerPixel);
    assertClose(sim.leg.knee![0], expectedKnee[0], 9);
    assertClose(sim.leg.knee![1], expectedKnee[1], 9);
    const expectedAnkle = moved(femSim.localMotion, moved(tibSim.localMotion, before.ankle!, input.mmPerPixel), input.mmPerPixel);
    assertClose(sim.leg.ankle![0], expectedAnkle[0], 9);
    assertClose(sim.leg.ankle![1], expectedAnkle[1], 9);
    // Rigid knee joint moves as one: JLCA stays identical.
    assertClose(sim.leg.values.JLCA.value, before.values.JLCA.value!, 9);
    // With zero tibial shifts, proximal and distal sides of the tibial hinge meet identically at M_femur(hinge_tibia).
    const noShiftTib = { ...tibiaCut, shiftLateral: 0, shiftDistal: 0, lengthen: 0 };
    const connected = simulateMany(input, before, [femurCut, noShiftTib])!;
    assertClose(connected.cuts[1].hingeMoved[0], connected.cuts[1].hingeAfter[0], 9);
    assertClose(connected.cuts[1].hingeMoved[1], connected.cuts[1].hingeAfter[1], 9);
    // Total rotation on distal tibia is the algebraic sum of both local rotations.
    assertClose(connected.cuts[1].totalMotion.degrees, connected.cuts[0].localMotion.degrees + connected.cuts[1].localMotion.degrees, 9);
  });

  it('composes a bifocal tibial osteotomy (proximal + distal) accurately', () => {
    const input = straight(), before = measureLeg(input);
    const prox = mkCut(input, 'tibia', [[20, 480], [-20, 480]], { degrees: 5, direction: 'valgus' });
    const dist = mkCut(input, 'tibia', [[18, 720], [-18, 720]], { degrees: 4, direction: 'varus' });
    const sorted = sortOsteotomies([dist, prox], before, input.mmPerPixel);
    assert.deepEqual(sorted.map(item => item.index), [1, 0]);
    const sim = simulateMany(input, before, [dist, prox])!;
    // Proximal tibial shaft (y=500) moves with proximal cut only; distal shaft (y=700) also with prox only; ankle (y=800) with both.
    const movedProxShaft = sim.points.tibialShaftProximal![0];
    const expectedProxShaft = moved(sim.cuts[0].totalMotion, input.points.tibialShaftProximal![0], input.mmPerPixel);
    assertClose(movedProxShaft[0], expectedProxShaft[0], 9);
    assertClose(movedProxShaft[1], expectedProxShaft[1], 9);
    const movedAnkle = sim.points.ankleCentre![0];
    const expectedAnkle = moved(sim.cuts[1].totalMotion, input.points.ankleCentre![0], input.mmPerPixel);
    assertClose(movedAnkle[0], expectedAnkle[0], 9);
    assertClose(movedAnkle[1], expectedAnkle[1], 9);
  });

  it('solves joint-specific targets (mLDFA, MPTA, LDTA) and chained double-level DFO + HTO corrections', () => {
    // Combined varus femur (tilted condyles -> mLDFA ~93°) and varus tibia (ankle medial -> MPTA ~82°, high medial MAD).
    const input = straight();
    input.points = {
      ...input.points,
      femoralCondyleMedial: [[20, 408]], femoralCondyleLateral: [[-20, 412]], // mLDFA ≈ 95.7°
      tibialPlateauMedial: [[20, 416]], tibialPlateauLateral: [[-20, 416]],
      ankleCentre: [[60, 800]], plafondMedial: [[75, 805]], plafondLateral: [[45, 805]],
    };
    const before = measureLeg(input);
    assert.ok(before.values.mLDFA.value! > 92);
    assert.ok(before.values.MPTA.value! < 85);
    const dfo = mkCut(input, 'femur', [[20, 320], [-20, 320]]);
    const hto = mkCut(input, 'tibia', [[20, 500], [-20, 500]]);

    // Step 1: Solve femoral cut alone to restore normal mLDFA = 87°.
    const solvedFemur = solveAngleMany(input, before, [dfo, hto], 0, { kind: 'mLDFA', degrees: 87 })!;
    const dfoSolved = { ...dfo, ...solvedFemur };
    const afterDfo = simulateMany(input, before, [dfoSolved, hto])!;
    assertClose(afterDfo.leg.values.mLDFA.value, 87, 5);

    // Step 2: Keeping the femoral correction in place, solve tibial cut to Fujisawa WBL = 62.5%.
    const solvedTibia = solveAngleMany(input, before, [dfoSolved, hto], 1, { kind: 'wbl', percent: 62.5 })!;
    const htoSolved = { ...hto, ...solvedTibia };
    const afterBoth = simulateMany(input, before, [dfoSolved, htoSolved])!;
    assertClose(afterBoth.leg.values.mLDFA.value, 87, 5);
    assertClose(afterBoth.leg.values.WBL.value, 62.5, 5);

    // Also verify MPTA = 87° and LDTA = 89° direct solvers.
    const solvedMpta = solveAngle(input, before, hto, { kind: 'MPTA', degrees: 87 })!;
    assertClose(simulate(input, before, { ...hto, ...solvedMpta })!.leg.values.MPTA.value, 87, 5);
    const distalCut = mkCut(input, 'tibia', [[18, 740], [-18, 740]]);
    const solvedLdta = solveAngle(input, before, distalCut, { kind: 'LDTA', degrees: 89 })!;
    assertClose(simulate(input, before, { ...distalCut, ...solvedLdta })!.leg.values.LDTA.value, 89, 5);
  });

  it('pre-places a Paley Rule 1 CORA-guided cut for opening and closing wedges across orientations', () => {
    const K: Point = [0, 400], C: Point = [100 * Math.sin(3 * deg), 400 + 100 * Math.cos(3 * deg)];
    const q: Point = [Math.sin(-7 * deg), Math.cos(-7 * deg)], A: Point = [C[0] + 300 * q[0], C[1] + 300 * q[1]];
    const turnBy = (v: Point, a: number): Point => [v[0] * Math.cos(a) - v[1] * Math.sin(a), v[0] * Math.sin(a) + v[1] * Math.cos(a)];
    const up: Point = [-q[0], -q[1]], L = [turnBy(up, 89 * deg), turnBy(up, -89 * deg)].find(v => v[0] < 0)!;
    const input: LegInput = {
      side: 'R', mmPerPixel: [0.3, 0.3], lateral: [-1, 0], points: {
        femoralHeadContour: ([[-20, 0], [0, -20], [20, 0]] as Point[]).map(([x, y]) => [x / 0.3, y / 0.3]),
        kneeCentre: [[K[0] / 0.3, K[1] / 0.3]], ankleCentre: [[A[0] / 0.3, A[1] / 0.3]],
        tibialPlateauMedial: [[20 / 0.3, 410 / 0.3]], tibialPlateauLateral: [[-20 / 0.3, 410 / 0.3]],
        plafondMedial: [[(A[0] - 15 * L[0]) / 0.3, (A[1] - 15 * L[1]) / 0.3]],
        plafondLateral: [[(A[0] + 15 * L[0]) / 0.3, (A[1] + 15 * L[1]) / 0.3]],
      },
    };
    const before = measureLeg(input), cora = coras(before, input.mmPerPixel, input.lateral).tibia!;
    assertClose(cora.magnitude, 10, 5);
    for (const wedge of ['opening', 'closing'] as const) {
      const cut = coraCut(cora, before, input, wedge)!;
      assert.equal(cut.bone, 'tibia');
      assert.equal(cut.wedge, wedge);
      assertClose(cut.degrees, 10, 1);
      const rule = paleyRule(cut, cora, input.mmPerPixel)!;
      assert.equal(rule.rule, 1);
      assertClose(rule.offset, 0, 5);
      assertClose(rule.translation, 0, 5);
      const sim = simulate(input, before, cut)!;
      assert.equal(sim.wedge, wedge);
    }
  });

  it('inserts, removes, and simplifies bone-hugging fragment polygons safely', () => {
    const poly: Point[] = [[40, 500], [-40, 500], [-40, 860], [40, 860]];
    const inserted = insertFragmentVertex(poly, 0, [0, 495]);
    assert.equal(inserted.length, 5);
    assert.deepEqual(inserted[1], [0, 495]);
    const removed = removeFragmentVertex(inserted, 1);
    assert.deepEqual(removed, poly);
    // Never drops below 3 vertices.
    const tri: Point[] = [[0, 0], [10, 0], [5, 10]];
    assert.equal(removeFragmentVertex(tri, 0).length, 3);
    // Respects MAX_FRAGMENT_POINTS cap.
    let capped = poly;
    for (let i = 0; i < 40; i++) capped = insertFragmentVertex(capped, 0, [i, 500]);
    assert.equal(capped.length, MAX_FRAGMENT_POINTS);
    // Freehand bone lasso loop of 120 points simplifies cleanly within MAX_FRAGMENT_POINTS while keeping area.
    const loop: Point[] = Array.from({ length: 120 }, (_, i) => {
      const a = i / 120 * Math.PI * 2;
      return [50 * Math.cos(a), 650 + 180 * Math.sin(a)];
    });
    const simplified = simplifyFragment(loop, 2)!;
    assert.ok(simplified.length >= 4 && simplified.length <= MAX_FRAGMENT_POINTS);
    assert.ok(polygonArea(simplified) > polygonArea(loop) * 0.9);
    // Degenerate collinear stroke returns null.
    assert.equal(simplifyFragment([[0, 0], [10, 0], [20, 0]], 1), null);
  });

  it('places the rotation handle on the moved segment and clears the knee joint line', () => {
    const input = straight(), before = measureLeg(input);
    const femurCut = mkCut(input, 'femur', [[20, 330], [-20, 330]], { degrees: 8, direction: 'valgus' });
    const sim = simulateMany(input, before, [femurCut])!;
    const handle = rotationHandlePoint(sim.cuts[0], before, input.mmPerPixel);
    // Handle must stay well clear of the moved knee centre.
    const distToKnee = Math.hypot(handle[0] - sim.leg.knee![0], handle[1] - sim.leg.knee![1]);
    assert.ok(distToKnee >= 35, `Expected handle at least 35 mm from knee, got ${distToKnee.toFixed(1)}`);
  });

  it('never moves femoral landmarks with an oblique tibial cut and respects parent-cut containment', () => {
    const input = straight(), before = measureLeg(input);
    // Steeply oblique medial-to-lateral HTO whose infinite line rises above the lateral femoral condyle at x = -20.
    const obliqueHto = mkCut(input, 'tibia', [[20, 480], [-20, 420]], { degrees: 12, direction: 'valgus' });
    const sim = simulateMany(input, before, [obliqueHto])!;
    // Every femoral landmark stays untouched by a tibial osteotomy.
    assert.deepEqual(sim.points.femoralCondyleLateral, input.points.femoralCondyleLateral);
    assert.deepEqual(sim.points.femoralCondyleMedial, input.points.femoralCondyleMedial);
    assert.deepEqual(sim.points.greaterTrochanterTip, input.points.greaterTrochanterTip);
    assert.deepEqual(sim.points.femoralShaftDistal, input.points.femoralShaftDistal);
    // The ankle still moves distally with the HTO.
    assert.notDeepEqual(sim.leg.ankle, before.ankle);
  });

  it('rejects off-bone, out-of-frame, or >45° CORAs in coraPlaceable and coraCut', () => {
    const input = straight(), before = measureLeg(input);
    const valid = {
      bone: 'tibia' as const, point: [0, 520] as Point, level: 0.3, magnitude: 8.75,
      bisector: [1, 0] as Point, proximal: { from: [0, 400] as Point, direction: [0, 1] as Point },
      distal: { from: [0, 800] as Point, direction: [0, -1] as Point },
    };
    assert.equal(coraPlaceable(valid), true);
    assert.equal(coraPlaceable(valid, [500, 1000]), true);
    assert.equal(coraPlaceable({ ...valid, level: -0.2 }), false);
    assert.equal(coraPlaceable({ ...valid, level: 1.3 }), false);
    assert.equal(coraPlaceable({ ...valid, magnitude: 52 }), false);
    assert.equal(coraPlaceable({ ...valid, point: [-50, 520] }, [500, 1000]), false);
    assert.equal(coraCut({ ...valid, level: 1.5 }, before, input, 'opening'), null);
    assert.equal(coraCut({ ...valid, magnitude: 50 }, before, input, 'opening'), null);
    assert.equal(coraCut({ ...valid, point: [999, 520] }, before, input, 'opening', [500, 1000]), null);
  });

  it('recovers native fragment coordinates when inverting totalMotion after tracing in simulated view', () => {
    const input = straight(), before = measureLeg(input);
    const dfo = mkCut(input, 'femur', [[20, 320], [-20, 320]], { degrees: 7, direction: 'varus', shiftLateral: 4 });
    const hto = mkCut(input, 'tibia', [[20, 500], [-20, 500]], { degrees: 10, direction: 'valgus', lengthen: 5 });
    const sim = simulateMany(input, before, [dfo, hto])!;
    const tibSim = sim.cuts[1];
    const nativeOutline: Point[] = [[30, 500], [-30, 500], [-25, 820], [25, 820]];
    const tracedOnMoved = nativeOutline.map(p => moved(tibSim.totalMotion, p, input.mmPerPixel));
    const recovered = tracedOnMoved.map(p => moved(invertRigid(tibSim.totalMotion), p, input.mmPerPixel));
    nativeOutline.forEach((want, i) => {
      assertClose(recovered[i][0], want[0], 9);
      assertClose(recovered[i][1], want[1], 9);
    });
  });
});

describe('plane helpers', () => {
  it('cross lines and turn directions', () => {
    assert.deepEqual(intersect([0, 0], [1, 0], [5, -5], [0, 1]), [5, 0]);
    assert.equal(intersect([0, 0], [1, 0], [0, 1], [2, 0]), null);
    assertClose(signedAngle([1, 0], [0, 1]), 90, 12);
  });

  it('composes and inverts rigid motions exactly', () => {
    const a: Rigid = { pivot: [120, 340], degrees: 14.5, shift: [-8, 12] };
    const b: Rigid = { pivot: [140, 620], degrees: -9.25, shift: [5, -4] };
    const ab = composeRigid(a, b);
    for (const p of [[0, 0], [120, 340], [140, 620], [200, 900], [-30, 500]] as Point[]) {
      const want = applyRigid(a, applyRigid(b, p)), got = applyRigid(ab, p);
      assertClose(got[0], want[0], 11); assertClose(got[1], want[1], 11);
      const back = applyRigid(invertRigid(ab), got);
      assertClose(back[0], p[0], 11); assertClose(back[1], p[1], 11);
    }
    assert.equal(isIdentityRigid(composeRigid(invertRigid(ab), ab)), true);
    assert.equal(isIdentityRigid(ab), false);
    const seg = pointToSegment([5, 4], [0, 0], [10, 0]);
    assertClose(seg.t, 0.5, 12); assertClose(seg.distance, 4, 12); assert.deepEqual(seg.point, [5, 0]);
    assert.equal(simplifyClosedPolygon([[0, 0], [10, 0], [10, 10], [0, 10]], 0.5, 8).length, 4);
  });
});
