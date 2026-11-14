import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertClose } from './support';
import { fitCircle, intersect, signedAngle, type Point } from '../src/imaging/deformity/plane';
import { lateralOnImage, measureLeg, type LegInput } from '../src/imaging/deformity/measure';
import { coras, malalignmentTest } from '../src/imaging/deformity/analysis';
import { fragmentFor, movedLandmarks, paleyRule, simulate, solveAngle, type Osteotomy } from '../src/imaging/deformity/osteotomy';

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
    const steps = malalignmentTest(measureLeg(input), input.points, input.mmPerPixel, input.lateral);
    assert.deepEqual(steps.map(step => [step.step, step.result]), [['mad', 'varus'], ['femur', 'normal'], ['tibia', 'normal'], ['joint', 'varus'], ['subluxation', 'normal']]);
    const pixels = malalignmentTest(measureLeg({ ...input, mmPerPixel: null }), input.points, null, input.lateral);
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

  it('measures the wedge from the hinge to the opening cortex', () => {
    const input = straight(), before = measureLeg(input);
    assertClose(simulate(input, before, plan(input, { hinge: [0, 500] }))!.wedgeHeight, 2 * 20 * Math.sin(5 * deg), 9);
  });

  it('names the Paley rule the hinge follows', () => {
    const input = straight(), osteotomy = plan(input);
    // A CORA on the cut with a vertical bisector: the hinge 20 mm off it.
    const offBisector = paleyRule(osteotomy, { point: [0, 500], bisector: [0, 1] }, [1, 1]);
    assert.equal(offBisector.rule, 3);
    assertClose(offBisector.translation, 2 * 20 * Math.tan(5 * deg), 9);
    assert.equal(paleyRule({ ...osteotomy, hinge: [0, 500] }, { point: [0, 500], bisector: [0, 1] }, [1, 1]).rule, 1);
    assert.equal(paleyRule({ ...osteotomy, hinge: [0, 560] }, { point: [0, 600], bisector: [0, 1] }, [1, 1]).rule, 2);
  });
});

describe('plane helpers', () => {
  it('cross lines and turn directions', () => {
    assert.deepEqual(intersect([0, 0], [1, 0], [5, -5], [0, 1]), [5, 0]);
    assert.equal(intersect([0, 0], [1, 0], [0, 1], [2, 0]), null);
    assertClose(signedAngle([1, 0], [0, 1]), 90, 12);
  });
});
