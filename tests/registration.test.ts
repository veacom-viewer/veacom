import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertClose } from './support';
import { facesSame, linkedSlice, type Pane } from '../src/imaging/linking';
import { alignedFusion, alignedTransform, alignmentCautions, alignmentFrom, alignmentOf, automatic, adjusted, frameOf, mapPoint, movement, NUDGE_DEGREES, nudged, nudgeStep, transformBetween, withAlignment, withoutAlignment, type Alignment } from '../src/imaging/registration';
import { angleOf, applyPoint, applyVector, compose, IDENTITY, invert, isIdentity, rotation, translation } from '../src/imaging/rigid';
import type { EngineRegistration, FusionSettings, Series, Vec3, ViewState } from '../src/model';

// Two visits of the synthetic follow-up (tools/fixtures/make-pet-followup.mjs): each a CT and a PET in a frame of
// reference of its own. The prior was scanned 24 mm further along the table, so its point p is this study's p − (0, 0, 24).
const series = (overrides: Partial<Series>): Series => ({
  id: 's', uid: 'u', studyUid: 'current', patientKey: 'synthetic-site-patient', patientId: 'P1', patientName: 'SYNTHETIC^FOLLOWUP', studyDate: '20000101', description: '', modality: 'CT',
  seriesNumber: 1, dimensions: [8, 8, 80], spacing: [4, 4, 4], origin: [-14, -14, -316], direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  windowCenter: 40, windowWidth: 400, valueUnit: 'HU', suvFactor: null, canReconstruct: true, spacingKnown: true, orientationKnown: true, positionKnown: true,
  warnings: [], photometricInterpretation: 'MONOCHROME2', frameOfReferenceUid: 'current-frame', ...overrides,
} as Series);
const currentCt = series({ id: 'current-ct' }), currentPet = series({ id: 'current-pet', modality: 'PT' });
const prior = { studyUid: 'prior', studyDate: '19991001', frameOfReferenceUid: 'prior-frame', dimensions: [8, 8, 84] as Vec3, origin: [-14, -14, -332] as Vec3 };
const priorCt = series({ id: 'prior-ct', ...prior }), priorPet = series({ id: 'prior-pet', modality: 'PT', ...prior });
/** What the engine answers for the prior CT laid over this study's (native/src/registration.rs): moving to fixed. */
const engine = (matrix: number[] = [...translation([0, 0, -24])]): EngineRegistration => ({ matrix, rotation: [0, 0, 0], shift: [0, 0, 24], centre: [0, 0, -158],
  angle: 0, similarity: 0.85, similarityBefore: 0.73, overlap: 0.92, evaluations: 500, levels: 2 });
const aligned = alignmentFrom(engine(), currentCt, priorCt)!;
const view = (slice: number, plane: ViewState['plane'] = 'axial'): ViewState => ({ mode: 'source', plane, slice, windowCenter: 40, windowWidth: 400, zoom: 1, pan: [0, 0], rotation: 0, flipX: false, flipY: false, inverted: false });
const pane = (item: Series, slice: number): Pane => ({ series: item, view: view(slice) });
const close = (actual: Vec3, expected: Vec3) => actual.forEach((value, axis) => assertClose(value, expected[axis], 1e-9));

describe('aligned frames of reference', () => {
  it('keep the engine\'s transform for the two frames, not the two series', () => {
    assert.deepEqual([aligned.fixed, aligned.moving, aligned.fixedSeriesId, aligned.movingSeriesId], [frameOf(currentCt), frameOf(priorCt), 'current-ct', 'prior-ct']);
    assert.equal(alignmentFrom(engine(), currentCt, currentPet), null, 'one frame needs no alignment');
    assert.equal(alignmentFrom(engine(), currentCt, series({ id: 'flat', frameOfReferenceUid: 'x', canReconstruct: false })), null, 'nor can a series not placed in the patient be aligned');
    assert.equal(alignmentFrom(engine([1, 2]), currentCt, priorCt), null);
    assert.equal(frameOf(series({ orientationKnown: false })), null);
  });

  it('take a prior point to this study 24 mm lower, and back, for the CTs and the PETs alike', () => {
    const alignments = [aligned];
    // Registered by the CTs, the PETs scanned with them follow.
    for (const [from, to] of [[priorCt, currentCt], [priorPet, currentPet], [priorPet, currentCt]]) {
      close(applyPoint(transformBetween(alignments, from, to)!, [10, -5, -76]), [10, -5, -100]);
      close(applyPoint(transformBetween(alignments, to, from)!, [10, -5, -100]), [10, -5, -76]);
    }
    assert.equal(transformBetween(alignments, currentCt, currentPet), IDENTITY, 'one frame of reference: the identity');
    assert.equal(alignedTransform(alignments, currentCt, currentPet), null);
    assert.equal(transformBetween([], priorCt, currentCt), null, 'not aligned: nothing joins them');
    assert.equal(transformBetween(alignments, priorCt, currentCt), transformBetween(alignments, priorCt, currentCt), 'the same matrix object while the alignments stay');
    assert.notEqual(transformBetween([...alignments], priorCt, currentCt), transformBetween(alignments, priorCt, currentCt));
  });

  it('keeps alignments with their patient when frame UIDs are reused', () => {
    const anotherPrior = { ...priorCt, patientKey: 'different-site' }, anotherCurrent = { ...currentCt, patientKey: 'different-site' };
    assert.equal(alignmentFrom(engine([...IDENTITY]), currentCt, anotherPrior), null);
    assert.equal(transformBetween([aligned], priorCt, anotherPrior), null);
    assert.equal(transformBetween([aligned], anotherPrior, anotherCurrent), null);
    assert.equal(alignmentOf([aligned], anotherPrior), null);
  });

  it('chain through other alignments: an MR laid over this study places the prior on it too', () => {
    const mr = series({ id: 'mr', modality: 'MR', studyUid: 'mr', frameOfReferenceUid: 'mr-frame' });
    const onMr = alignmentFrom(engine([...rotation(2, 90, [0, 0, 0])]), mr, currentCt)!;
    const alignments = [aligned, onMr];
    // Prior → this study (24 mm down), then this study → MR (a quarter turn about z).
    close(applyPoint(transformBetween(alignments, priorCt, mr)!, [10, 0, -76]), [0, 10, -100]);
    close(applyPoint(transformBetween(alignments, mr, priorCt)!, [0, 10, -100]), [10, 0, -76]);
    assert.equal(alignmentOf(alignments, priorPet), aligned);
    assert.equal(alignmentOf(alignments, series({ frameOfReferenceUid: 'elsewhere' })), null);
  });

  it('adjusts the displayed PET when two registrations share the same CT', () => {
    const other = { ...priorPet, id: 'other-pet', frameOfReferenceUid: 'other-frame' };
    const second = alignmentFrom(engine(), currentCt, other)!;
    const both = [aligned, second];
    assert.equal(alignmentOf(both, currentCt, other), second);
    assert.equal(alignmentOf(both, currentCt, priorPet), aligned);
    assert.equal(alignmentOf(both, currentCt), null);
  });

  it('are replaced and removed by pair of frames, either way round', () => {
    const again = alignmentFrom(engine([...translation([0, 0, -23])]), priorCt, currentCt)!;
    assert.deepEqual(withAlignment([aligned], again), [again]);
    assert.deepEqual(withoutAlignment([aligned], { fixed: aligned.moving, moving: aligned.fixed }), []);
  });

  it('take the reader\'s nudges in the fixed frame after the engine\'s transform, and go back to it', () => {
    const lower = nudged(aligned, translation([0, 0, -1]));
    close(applyPoint(lower.matrix, [0, 0, 0]), [0, 0, -25]);
    assert.equal(adjusted(lower), true);
    // A turn about a point in the fixed frame leaves that point where it is.
    const turned = nudged(lower, rotation(2, 0.5, [0, 0, -100]));
    close(applyPoint(turned.matrix, [0, 0, -75]), [0, 0, -100]);
    assertClose(movement(turned).angle, 0.5, 1e-9);
    assert.deepEqual(automatic(turned).matrix, aligned.found);
    assert.equal(adjusted(automatic(turned)), false);
    assertClose(movement(aligned).shift, 24, 1e-9);
  });

  it('page an aligned prior to where this study is in the patient', () => {
    // This study's slice 54 lies at z = −100; the same anatomy is at z = −76 in the prior, its slice 64.
    const toPrior = transformBetween([aligned], currentPet, priorPet)!;
    assert.equal(linkedSlice(pane(currentPet, 54), pane(priorPet, 3), [0, 0, -100], 1, undefined, toPrior), 64);
    // Without the alignment the frames differ and the slice counts too: it would not follow.
    assert.equal(linkedSlice(pane(currentPet, 54), pane(priorPet, 3), [0, 0, -100], 1), null);
    // A coronal prior does not follow an axial pane.
    assert.equal(facesSame(pane(currentPet, 54), { series: priorPet, view: { ...view(3, 'coronal'), mode: 'mpr' } }, toPrior), false);
  });

  it('keep the same points and fusions while the transform stays, so panes are not redrawn for nothing', () => {
    const point: Vec3 = [1, 2, 3], matrix = translation([0, 0, 24]);
    assert.equal(mapPoint(IDENTITY, point), point);
    assert.equal(mapPoint(matrix, point), mapPoint(matrix, point));
    assert.deepEqual(mapPoint(matrix, point), [1, 2, 27]);
    const fusion = { opacity: 0.5 } as FusionSettings;
    assert.equal(alignedFusion(fusion, IDENTITY), fusion);
    assert.equal(alignedFusion(fusion, matrix), alignedFusion(fusion, matrix));
    assert.equal(alignedFusion(fusion, matrix).transform, matrix);
  });

  it('say when the measured match does not support the alignment', () => {
    assert.deepEqual(alignmentCautions(aligned), []);
    assert.deepEqual(alignmentCautions({ ...aligned, similarity: 0.7, similarityBefore: 0.7, overlap: 0.2 } as Alignment), ['noBetter', 'littleOverlap']);
  });
});

describe('the reader\'s nudges', () => {
  it('turn clockwise as each plane is shown, about the pivot, and shift along patient axes', () => {
    const pivot: Vec3 = [10, 20, 30];
    // Axial: right (+x) towards down (+y). Coronal: right (+x) towards down (−z). Sagittal: right (+y) towards down (−z).
    const towards = (step: ReturnType<typeof nudgeStep>, from: Vec3) => applyPoint(step, [pivot[0] + from[0], pivot[1] + from[1], pivot[2] + from[2]]).map((value, axis) => value - pivot[axis]);
    const right = (plane: 'axial' | 'coronal' | 'sagittal') => ({ axial: [1, 0, 0], coronal: [1, 0, 0], sagittal: [0, 1, 0] } as const)[plane];
    const down = { axial: 1, coronal: 2, sagittal: 2 } as const, sign = { axial: 1, coronal: -1, sagittal: -1 } as const;
    for (const plane of ['axial', 'coronal', 'sagittal'] as const) {
      const moved = towards(nudgeStep({ turn: plane, clockwise: true }, pivot), [...right(plane)] as Vec3);
      assert.ok(moved[down[plane]] * sign[plane] > 0, `${plane} clockwise turns right towards down`);
      const back = towards(nudgeStep({ turn: plane, clockwise: false }, pivot), [...right(plane)] as Vec3);
      assert.ok(back[down[plane]] * sign[plane] < 0, `${plane} anticlockwise the other way`);
      close(applyPoint(nudgeStep({ turn: plane, clockwise: true }, pivot), pivot), pivot);
      assertClose(angleOf(nudgeStep({ turn: plane, clockwise: true }, pivot)), NUDGE_DEGREES, 1e-9);
    }
    close(applyPoint(nudgeStep({ shift: [0, 0, 1] }, pivot), [0, 0, 0]), [0, 0, 1]);
  });
});

describe('rigid transforms', () => {
  it('invert, compose and turn as rotations and translations do', () => {
    const m = compose(translation([3, -4, 5]), rotation(0, 30, [1, 2, 3]));
    assert.equal(isIdentity(compose(invert(m), m)), true);
    assert.equal(isIdentity(compose(m, invert(m))), true);
    assertClose(angleOf(m), 30, 1e-9);
    close(applyVector(rotation(2, 90, [5, 5, 5]), [1, 0, 0]), [0, 1, 0]);
    close(applyPoint(rotation(1, 90, [0, 0, 0]), [0, 0, 1]), [1, 0, 0]);
  });
});
