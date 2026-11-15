import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { assertClose } from './support';
import type { Series, ViewState } from '../src/model';
import { screenMapping, sourceFrameSeries, worldToScreen } from '../src/imaging/geometry';
import { deformity, filmKey, withPlan, type FilmPlans } from '../src/ui/deformityStore';
import { acceptSuggestions, clearSuggestions, dragContinues, fromUnchecked, imageSideOnScreen, MEASURED_FROM, movedView, moveHandle, nextLandmark, pixelToWorld, place, planView, putBackSuggestion, settleMoved, withSuggestions, worldToPixel } from '../src/ui/deformityPlan';
import { MODEL, suggestionsFrom, suggestionTarget } from '../src/ui/landmarkSuggestions';
import { lateralOnImage, type Landmarks } from '../src/imaging/deformity/measure';
import { LANDMARKS } from '../src/imaging/deformity/landmarks';
import { UNCHECKED } from '../src/imaging/deformity/suggest';
import { parsePlanFile, planFile, PLAN_SCHEMA } from '../src/ui/deformityFile';
import { reportHeader } from '../src/ui/deformityReport';
import type { Point } from '../src/imaging/deformity/plane';

const deg = Math.PI / 180;
/** A DX film of 400 × 1000 pixels of 0.33 mm, at the detector, with Patient Orientation L\F. */
const series: Series = {
  id: 'dx', uid: '2.25.1', studyUid: '2.25.2', patientId: 'SYNTHETIC', patientName: 'Synthetic', studyDate: '', description: 'Long leg', modality: 'DX',
  seriesNumber: 1, dimensions: [400, 1000, 1], spacing: [0.33, 0.33, 1], origin: [0, 0, 0], direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  windowCenter: 2048, windowWidth: 4096, valueUnit: '', suvFactor: null, canReconstruct: false, spacingKnown: true, orientationKnown: false,
  warnings: [], photometricInterpretation: 'MONOCHROME2',
  frameMetadata: [{ origin: [0, 0, 0], direction: [1, 0, 0, 0, 1, 0, 0, 0, 1], spacing: [0.33, 0.33, 1], spacingKnown: true, sopInstanceUid: '2.25.1.1',
    projection: { basis: 'detector', spacing: [0.33, 0.33], imagerPixelSpacing: [0.33, 0.33], patientOrientation: ['L', 'F'], laterality: 'B' } }],
};
const frame = sourceFrameSeries(series, 0);
const view = (patch: Partial<ViewState> = {}): ViewState => ({ plane: 'axial', slice: 0, windowCenter: 0, windowWidth: 1, zoom: 1.7, pan: [12, -30], rotation: 0, flipX: false, flipY: false, inverted: false, mode: 'source', ...patch });

afterEach(() => { deformity.restore({}); deformity.connectUndo(null); deformity.setPlacing(null); });

describe('image pixels and the viewer\'s coordinates', () => {
  it('put the first pixel\'s centre at (0.5, 0.5)', () => {
    assert.deepEqual(pixelToWorld(frame, [0.5, 0.5]), [0, 0, 0]);
    const world = pixelToWorld(frame, [10.5, 20.5]);
    assertClose(world[0], 3.3, 12); assertClose(world[1], 6.6, 12);
    assert.deepEqual(worldToPixel(frame, world).map(v => Number(v.toFixed(12))), [10.5, 20.5]);
  });
});

describe('the fragment drawn as a view of the film', () => {
  for (const patch of [{}, { rotation: 30 }, { flipX: true }, { flipY: true, rotation: 90 }, { flipX: true, flipY: true, rotation: 200 }]) {
    it(`lands each point where the motion takes it (${JSON.stringify(patch)})`, () => {
      const base = view(patch), size: [number, number] = [640, 900];
      const hinge: Point = [180, 600], degrees = 8, shift: Point = [-14, 6];
      const moved = (p: Point): Point => {
        const c = Math.cos(degrees * deg), s = Math.sin(degrees * deg), x = p[0] - hinge[0], y = p[1] - hinge[1];
        return [hinge[0] + x * c - y * s + shift[0], hinge[1] + x * s + y * c + shift[1]];
      };
      const fragment = movedView(frame, base, size, hinge, moved(hinge), degrees);
      const before = screenMapping(frame, base, ...size), after = screenMapping(frame, fragment, ...size);
      for (const p of [[180, 600], [100, 950], [300, 700], [5, 999]] as Point[]) {
        const want = worldToScreen(before, pixelToWorld(frame, moved(p))), got = worldToScreen(after, pixelToWorld(frame, p));
        assertClose(got[0], want[0], 9); assertClose(got[1], want[1], 9);
      }
    });
  }
});

describe('the patient\'s right, answered on screen', () => {
  // The reader answers from the R/L marker as the pane shows it; the plan keeps the side of the stored image.
  it('follows the pane\'s flips and turns', () => {
    assert.equal(imageSideOnScreen('right', view({ rotation: 0, flipX: false })), 'right');
    assert.equal(imageSideOnScreen('right', view({ rotation: 0, flipX: true })), 'left');
    assert.equal(imageSideOnScreen('right', view({ rotation: 180, flipX: false })), 'left');
    assert.equal(imageSideOnScreen('right', view({ rotation: 180, flipX: true })), 'right');
    assert.equal(imageSideOnScreen('left', view({ rotation: 0, flipY: true })), 'left', 'An upside-down flip keeps left and right.');
    // Turned a quarter, the pane's left and right are the image's top and bottom: no answer.
    assert.equal(imageSideOnScreen('right', view({ rotation: 90 })), null);
  });
  it('gives the right leg the lateral side the reader saw, on a flipped pane', () => {
    // Patient's right on the screen's right of a pane flipped left to right: in the image, its left (−x).
    const stored = imageSideOnScreen('right', view({ flipX: true }))!;
    assert.deepEqual(lateralOnImage('R', undefined, stored), [-1, 0]);
    assert.deepEqual(lateralOnImage('R', undefined, imageSideOnScreen('left', view({ rotation: 180 }))!), [1, 0]);
  });
});

/** A film's plans as the store makes them, for the right leg only. */
function film(): FilmPlans {
  return deformity.ensure(series, 0, ['R']);
}

describe('the plans of a film', () => {
  it('stay with their image when a re-import reorders the series\' frames', () => {
    // Two films of one series; a re-import puts a new one first, so the first film is now the second frame.
    const meta = (uid: string) => ({ ...series.frameMetadata![0], sopInstanceUid: uid });
    const two: Series = { ...series, dimensions: [400, 1000, 2], frameMetadata: [meta('2.25.1.1'), meta('2.25.1.2')] };
    const key = filmKey(two, 0);
    deformity.ensure(two, 0, ['R']);
    deformity.change(key, current => place(current, { film: key, kind: 'landmark', name: 'kneeCentre' }, [200, 500], frame).film);
    const reordered: Series = { ...two, dimensions: [400, 1000, 3], frameMetadata: [meta('2.25.1.9'), meta('2.25.1.2'), meta('2.25.1.1')] };
    assert.equal(filmKey(reordered, 2), key, 'The first film\'s plans follow it to its new index.');
    assert.equal(deformity.get().films[filmKey(reordered, 0)], undefined, 'The new film at index 0 has none of them.');
    assert.equal(deformity.ensure(reordered, 0, ['R']).plans[0].points.kneeCentre, undefined);
    assert.deepEqual(deformity.get().films[filmKey(reordered, 2)]?.plans[0].points.kneeCentre, [[200, 500]]);
    const unidentified = { id: 'dx', sourceRevision: 1 };
    assert.notEqual(filmKey(unidentified, 1), filmKey({ ...unidentified, sourceRevision: 2 }, 1));
  });
});

describe('placing and moving landmarks', () => {
  it('asks for the landmarks in order, the head\'s outline taking three points', () => {
    let current = film(), placing = { film: filmKey(series, 0), kind: 'landmark' as const, name: nextLandmark(current.plans[0])! };
    assert.equal(placing.name, 'femoralHeadContour');
    const points: Point[] = [[100, 100], [120, 80], [140, 100], [150, 110], [200, 400]];
    const asked: string[] = [];
    for (const point of points) {
      const result = place(current, placing, point, frame);
      current = result.film; placing = result.placing as typeof placing;
      asked.push(placing.name);
    }
    assert.deepEqual(asked, ['femoralHeadContour', 'femoralHeadContour', 'greaterTrochanterTip', 'femoralShaftProximal', 'femoralShaftDistal']);
    assert.equal(current.plans[0].points.femoralHeadContour?.length, 3);
    assert.deepEqual(current.plans[0].provenance.greaterTrochanterTip, ['placed']);
    const moved = moveHandle(current, { kind: 'landmark', name: 'greaterTrochanterTip', index: 0 }, [151, 112]);
    assert.deepEqual(moved.plans[0].points.greaterTrochanterTip, [[151, 112]]);
    assert.deepEqual(moved.plans[0].provenance.greaterTrochanterTip, ['moved']);
  });

  it('moves a dragged point only on the film and plan the drag began on, with its pointer', () => {
    const held = { key: 'dx:a:1', plan: 'plan-1', pointer: 7 };
    assert.equal(dragContinues(held, { ...held }), 'move');
    assert.equal(dragContinues(held, { ...held, pointer: 8 }), 'ignore', 'Another pointer does not move it.');
    assert.equal(dragContinues(held, { ...held, key: 'dx:b:1' }), 'stop', 'Paged to another film, the drag stops.');
    assert.equal(dragContinues(held, { ...held, plan: 'plan-2' }), 'stop', 'On another plan, the drag stops.');
  });

  it('makes each change one Undo step, and a drag one step for all its moves', () => {
    film();
    let remembered = 0;
    deformity.connectUndo(() => { remembered++; });
    const key = filmKey(series, 0), handle = { kind: 'landmark' as const, name: 'kneeCentre' as const, index: 0 };
    deformity.change(key, current => place(current, { film: key, kind: 'landmark', name: 'kneeCentre' }, [200, 500], frame).film);
    const before = deformity.snapshot();
    for (const [index, point] of ([[201, 500], [202, 501], [203, 502]] as Point[]).entries()) deformity.change(key, current => moveHandle(current, handle, point), index === 0);
    assert.equal(remembered, 2);
    assert.deepEqual(deformity.get().films[key]?.plans[0].points.kneeCentre, [[203, 502]]);
    deformity.restore(before);
    assert.deepEqual(deformity.get().films[key]?.plans[0].points.kneeCentre, [[200, 500]]);
  });
});

describe('the plan file', () => {
  const planned = () => {
    const key = filmKey(series, 0);
    film();
    for (const [name, point] of [['kneeCentre', [200, 500]], ['ankleCentre', [205, 900]]] as const) deformity.change(key, current => place(current, { film: key, kind: 'landmark', name }, point, frame).film);
    return deformity.get().films[key]!;
  };

  it('writes labels in image pixels, with confidence, spacing, side and version, and no identifiers', async () => {
    const file = await planFile(planned(), frame, new Date('2026-01-01T00:00:00Z'));
    assert.equal(file.schema, PLAN_SCHEMA); assert.equal(file.version, 1); assert.equal(file.coordinates, 'dicom-image-relative');
    assert.equal(file.film.sopInstanceSha256.length, 64);
    assert.deepEqual(file.calibration.mmPerPixel, [0.33, 0.33]);
    assert.equal(file.calibration.state, 'detector');
    const knee = file.plans[0].landmarks.find(label => label.name === 'kneeCentre')!;
    assert.deepEqual(knee, { name: 'kneeCentre', points: [[200, 500]], confidence: 'manual', provenance: ['placed'], spacing: 'detector', side: 'R', software: 'unknown', suggestionShown: false });
    assert.doesNotMatch(JSON.stringify(file), /2\.25\.1|SYNTHETIC|Synthetic/);
    assertClose(file.plans[0].values.tibiaLength.value, Math.hypot(5, 400) * 0.33, 9);
  });

  it('restores the applied scale and its source independently of later marker edits and display units', async () => {
    const current = { ...planned(), marker: { method: 'ruler' as const, knownMm: 30, points: [[0, 0], [0, 100]] as Point[], depthConfirmed: false } };
    const applied = { method: 'ruler' as const, knownMm: 25, scale: 0.25 / 0.33, depthConfirmed: false };
    const calibrated = { ...frame, measurementUnits: 'px' as const, measurementScale: applied.scale, manualCalibration: applied };
    const file = await planFile(current, calibrated);
    assert.deepEqual(file.calibration.mmPerPixel, [0.25, 0.25]);
    const result = await parsePlanFile(JSON.stringify(file), current, frame);
    assert.ok(!('error' in result));
    assert.deepEqual(result.calibration, applied);
    assert.equal(result.marker?.knownMm, 30);
    assertClose(file.plans[0].values.tibiaLength.value, Math.hypot(5, 400) * 0.25, 9);
    delete file.calibration.appliedMarker;
    const legacy = await parsePlanFile(JSON.stringify(file), current, frame);
    assert.ok(!('error' in legacy));
    assert.deepEqual(legacy.calibration, { method: 'scale', scale: applied.scale });
    file.calibration.mmPerPixel = [0.25, 1];
    assert.deepEqual(await parsePlanFile(JSON.stringify(file), current, frame), { error: 'content' });
  });

  it('opens its own file, and refuses another film\'s, a broken or hostile one', async () => {
    const current = planned(), text = JSON.stringify(await planFile(current, frame));
    const opened = await parsePlanFile(text, current, frame);
    assert.ok(!('error' in opened));
    assert.deepEqual(opened.plans[0].points.kneeCentre, [[200, 500]]);
    const other = { ...current, sopInstanceUid: '2.25.9' };
    assert.deepEqual(await parsePlanFile(text, other, frame), { error: 'film' });
    assert.deepEqual(await parsePlanFile('{', current, frame), { error: 'json' });
    assert.deepEqual(await parsePlanFile('{"schema":"other"}', current, frame), { error: 'schema' });
    const value = JSON.parse(text);
    assert.deepEqual(await parsePlanFile(JSON.stringify({ ...value, version: 2 }), current, frame), { error: 'version' });
    const far = structuredClone(value); far.plans[0].landmarks[0].points = [[1e9, 0]];
    assert.deepEqual(await parsePlanFile(JSON.stringify(far), current, frame), { error: 'content' });
    const many = structuredClone(value); many.plans[0].landmarks[0].points = Array.from({ length: 13 }, () => [10, 10]);
    assert.deepEqual(await parsePlanFile(JSON.stringify(many), current, frame), { error: 'content' });
    const steep = structuredClone(value); steep.plans[0].osteotomy = { bone: 'tibia', cut: [[0, 0], [1, 1]], hinge: [1, 1], fragment: [[0, 0], [1, 0], [1, 1]], wedge: 'opening', direction: 'valgus', degrees: 90, shiftLateral: 0, shiftDistal: 0, lengthen: 0 };
    assert.deepEqual(await parsePlanFile(JSON.stringify(steep), current, frame), { error: 'content' });
    assert.deepEqual(await parsePlanFile(' '.repeat(2_000_001), current, frame), { error: 'size' });
    // Which plan was in front must be a whole index into the plans: half a plan is refused, not opened as nothing.
    for (const active of [0.5, -1, 1, '0', null]) assert.deepEqual(await parsePlanFile(JSON.stringify({ ...value, active }), current, frame), { error: 'content' }, `active ${String(active)}`);
    const { active: _active, ...unstated } = value;
    const first = await parsePlanFile(JSON.stringify(unstated), current, frame);
    assert.ok(!('error' in first)); assert.equal(first.active, 0);
    // Unknown landmarks and fields are left out; text is bounded.
    const extra = structuredClone(value); extra.plans[0].name = 'x'.repeat(500); extra.plans[0].landmarks.push({ name: '__proto__', points: [[1, 1]] });
    const read = await parsePlanFile(JSON.stringify(extra), current, frame);
    assert.ok(!('error' in read));
    assert.equal(read.plans[0].name.length, 64);
    assert.equal(Object.keys(read.plans[0].points).includes('__proto__'), false);
  });

  it('measures what the store holds', () => {
    const view = planView(planned(), frame);
    assert.equal(view.askRight, false);
    assert.deepEqual(view.lateral, [-1, 0]);
    assertClose(view.leg.values.tibiaLength.value, Math.hypot(5, 400) * 0.33, 9);
  });
});

describe('landmark suggestions', () => {
  const key = filmKey(series, 0);
  const ring: Point[] = [0, 90, 180, 270].map(degrees => [100 + 30 * Math.cos(degrees * deg), 120 + 30 * Math.sin(degrees * deg)]);
  const points = { femoralHeadContour: ring, kneeCentre: [[200, 500]] as Point[], femoralCondyleMedial: [[230, 520]] as Point[], femoralCondyleLateral: [[170, 520]] as Point[],
    tibialPlateauMedial: [[228, 530]] as Point[], tibialPlateauLateral: [[172, 532]] as Point[], ankleCentre: [[205, 900]] as Point[] };
  const suggested = () => { film(); deformity.change(key, current => withSuggestions(current, points, MODEL)); return deformity.get().films[key]!; };

  it('are drawn apart and measured only once the reader accepts or moves them', () => {
    let current = suggested(), plan = current.plans[0];
    assert.deepEqual(Object.keys(plan.suggested!.points).sort(), Object.keys(points).sort());
    assert.deepEqual(plan.points, {}, 'A suggestion is not a landmark.');
    assert.equal(planView(current, frame).leg.values.HKA.value, null, 'Nothing is measured from a suggestion.');
    assert.equal(nextLandmark(plan), 'greaterTrochanterTip', 'Placing asks first for what has no suggestion.');
    current = acceptSuggestions(current, ['kneeCentre']); plan = current.plans[0];
    assert.deepEqual(plan.points.kneeCentre, [[200, 500]]);
    assert.deepEqual(plan.provenance.kneeCentre, ['accepted']);
    assert.deepEqual(plan.origin?.kneeCentre, { shown: true, model: MODEL });
    assert.equal(plan.suggested?.points.kneeCentre, undefined);
    // Dragging one point of the suggested outline moves the suggestion, still unmeasured; let go, the outline is the
    // reader's: that point moved, the others accepted.
    current = moveHandle(current, { kind: 'suggestion', name: 'femoralHeadContour', index: 1 }, [101, 152]);
    current = moveHandle(current, { kind: 'suggestion', name: 'femoralHeadContour', index: 1 }, [101, 151]);
    assert.equal(current.plans[0].points.femoralHeadContour, undefined);
    assert.deepEqual(current.plans[0].suggested?.points.femoralHeadContour?.[1], [101, 151]);
    // A drag that did not finish (cancelled, or the reader switched plans) puts the point back, on its own plan.
    const other = { ...current, plans: [...current.plans, { ...current.plans[0], id: 'plan-other' }], active: 'plan-other' };
    const putBack = putBackSuggestion(other, current.plans[0].id, 'femoralHeadContour', 1, ring[1]);
    assert.deepEqual(putBack.plans[0].suggested?.points.femoralHeadContour?.[1], ring[1]);
    assert.deepEqual(putBack.plans[1].suggested?.points.femoralHeadContour?.[1], [101, 151], 'The other plan is left alone.');
    current = settleMoved(current, 'femoralHeadContour', 1);
    plan = current.plans[0];
    assert.deepEqual(plan.provenance.femoralHeadContour, ['accepted', 'moved', 'accepted', 'accepted']);
    assert.deepEqual(plan.points.femoralHeadContour?.[1], [101, 151]);
    assert.equal(plan.origin?.femoralHeadContour?.model, MODEL);
    current = acceptSuggestions(current); plan = current.plans[0];
    assert.equal(plan.suggested, undefined);
    assert.notEqual(planView(current, frame).leg.values.HKA.value, null);
  });

  it('give way to a point placed by hand, which stays marked as placed with a suggestion shown', () => {
    let current = suggested();
    current = place(current, { film: key, kind: 'landmark', name: 'ankleCentre' }, [210, 905], frame).film;
    const plan = current.plans[0];
    assert.deepEqual(plan.points.ankleCentre, [[210, 905]]);
    assert.deepEqual(plan.provenance.ankleCentre, ['placed']);
    assert.deepEqual(plan.origin?.ankleCentre, { shown: true });
    assert.equal(plan.suggested?.points.ankleCentre, undefined);
    // Placed again after accepting, a landmark is the reader's alone; cleared, the waiting suggestions go and the accepted stay.
    current = place(acceptSuggestions(current, ['kneeCentre']), { film: key, kind: 'landmark', name: 'kneeCentre' }, [199, 501], frame).film;
    assert.deepEqual(current.plans[0].origin?.kneeCentre, { shown: true });
    current = clearSuggestions(current);
    assert.equal(current.plans[0].suggested, undefined);
    assert.deepEqual(current.plans[0].points.kneeCentre, [[199, 501]]);
    // Suggested again, only what is not placed is suggested.
    assert.deepEqual(Object.keys(withSuggestions(current, points, MODEL).plans[0].suggested!.points).sort(),
      ['femoralCondyleLateral', 'femoralCondyleMedial', 'femoralHeadContour', 'tibialPlateauLateral', 'tibialPlateauMedial']);
  });

  it('stay marked as shown through Undo: a point placed after undoing them is labelled with a suggestion shown', async () => {
    film();
    const before = deformity.snapshot();
    deformity.change(key, current => withSuggestions(current, points, MODEL));
    deformity.restore(before);
    const undone = deformity.get().films[key]!.plans[0];
    assert.equal(undone.suggested, undefined, 'Undo takes the suggestions off the film.');
    assert.equal(undone.origin?.kneeCentre?.shown, true);
    deformity.change(key, current => place(current, { film: key, kind: 'landmark', name: 'kneeCentre' }, [200, 500], frame).film);
    const labels = (await planFile(deformity.get().films[key]!, frame)).plans[0].landmarks;
    assert.equal(labels.find(label => label.name === 'kneeCentre')?.suggestionShown, true);
  });

  it('are saved with the model and its hashes, accepted against moved, and opened again as they were', async () => {
    let current = suggested();
    current = acceptSuggestions(settleMoved(moveHandle(current, { kind: 'suggestion', name: 'tibialPlateauMedial', index: 0 }, [231, 529]), 'tibialPlateauMedial', 0));
    current = place(current, { film: key, kind: 'landmark', name: 'plafondMedial' }, [225, 890], frame).film;
    const file = await planFile(current, frame), labels = Object.fromEntries(file.plans[0].landmarks.map(label => [label.name, label]));
    assert.deepEqual(labels.kneeCentre.confidence, { model: 'veacom-landmarks-r2', sha256: { stageA: MODEL.sha256.stageA, stageB: MODEL.sha256.stageB } });
    assert.match(MODEL.sha256.stageA, /^[0-9a-f]{64}$/);
    assert.deepEqual([labels.kneeCentre.provenance, labels.kneeCentre.suggestionShown], [['accepted'], true]);
    assert.deepEqual([labels.tibialPlateauMedial.provenance, labels.tibialPlateauMedial.confidence], [['moved'], MODEL]);
    assert.equal(labels.femoralHeadContour.construction, 'hipCentreRing');
    assert.deepEqual([labels.hipCentre.confidence, labels.hipCentre.suggestionShown, labels.hipCentre.derivedFrom], [MODEL, true, 'femoralHeadContour']);
    assert.deepEqual([labels.plafondMedial.confidence, labels.plafondMedial.provenance, labels.plafondMedial.suggestionShown], ['manual', ['placed'], false]);
    const text = JSON.stringify(file), opened = await parsePlanFile(text, current, frame);
    assert.ok(!('error' in opened));
    assert.deepEqual(opened.plans[0].origin, current.plans[0].origin);
    assert.deepEqual(opened.plans[0].provenance, current.plans[0].provenance);
    // Saved again, the labels are the same: a model's point is never laundered into the reader's.
    const reopened = await planFile({ ...current, plans: opened.plans, active: opened.plans[0].id }, frame);
    assert.deepEqual(reopened.plans[0].landmarks, file.plans[0].landmarks);
    // A model's outline saved without the ring's mark (a traced one) is not called a ring when saved again.
    const traced = structuredClone(JSON.parse(text));
    for (const label of traced.plans[0].landmarks) if (label.name === 'femoralHeadContour') delete label.construction;
    const tracedOpen = await parsePlanFile(JSON.stringify(traced), current, frame);
    assert.ok(!('error' in tracedOpen));
    const tracedSaved = await planFile({ ...current, plans: tracedOpen.plans, active: tracedOpen.plans[0].id }, frame);
    const head = tracedSaved.plans[0].landmarks.find(label => label.name === 'femoralHeadContour')!;
    assert.deepEqual([head.confidence, head.construction], [MODEL, undefined]);
    // A model's label that says no suggestion was shown keeps saying so.
    const unshown = structuredClone(JSON.parse(text));
    for (const label of unshown.plans[0].landmarks) if (label.name === 'kneeCentre') label.suggestionShown = false;
    const unshownOpen = await parsePlanFile(JSON.stringify(unshown), current, frame);
    assert.ok(!('error' in unshownOpen));
    const unshownLabel = (await planFile({ ...current, plans: unshownOpen.plans, active: unshownOpen.plans[0].id }, frame)).plans[0].landmarks.find(label => label.name === 'kneeCentre')!;
    assert.deepEqual([unshownLabel.confidence, unshownLabel.suggestionShown], [MODEL, false]);
    // A point claimed as accepted with no model, or a model with a malformed hash, is the reader's.
    const forged = structuredClone(JSON.parse(text));
    for (const label of forged.plans[0].landmarks) if (label.name === 'kneeCentre') label.confidence = 'manual';
    for (const label of forged.plans[0].landmarks) if (label.name === 'ankleCentre') label.confidence = { model: 'x', sha256: { stageA: 'zz', stageB: 'zz' } };
    const read = await parsePlanFile(JSON.stringify(forged), current, frame);
    assert.ok(!('error' in read));
    assert.deepEqual(read.plans[0].provenance.kneeCentre, ['placed']);
    assert.deepEqual(read.plans[0].origin?.kneeCentre, { shown: true });
    assert.deepEqual(read.plans[0].provenance.ankleCentre, ['placed']);
    assert.equal(read.plans[0].origin?.ankleCentre?.model, undefined);
  });

  it('mark the model\'s unchecked landmarks, and the values measured from them while they stay as suggested', async () => {
    film();
    const all = { ...points, greaterTrochanterTip: [[60, 140]] as Point[], femoralShaftProximal: [[150, 300]] as Point[], femoralShaftDistal: [[185, 420]] as Point[],
      plafondMedial: [[222, 895]] as Point[], plafondLateral: [[188, 897]] as Point[] };
    deformity.change(key, current => withSuggestions(current, all, MODEL, UNCHECKED));
    let current = deformity.get().films[key]!;
    assert.deepEqual(current.plans[0].suggested?.unchecked, ['greaterTrochanterTip', 'femoralShaftProximal', 'plafondMedial', 'plafondLateral']);
    assert.equal(fromUnchecked(current.plans[0]).size, 0, 'Nothing is measured from a suggestion, so nothing is marked yet.');
    current = acceptSuggestions(current);
    let plan = current.plans[0];
    assert.deepEqual(plan.origin?.plafondMedial, { shown: true, model: MODEL, unchecked: true });
    assert.deepEqual(plan.origin?.femoralShaftDistal, { shown: true, model: MODEL }, 'The lower femoral shaft is checked on real films.');
    assert.deepEqual([...fromUnchecked(plan)].sort(), ['AMA', 'LDTA', 'aLDFA', 'coraFemur', 'coraTibia', 'mLPFA']);
    // Moved, the plafond is the reader's point: LDTA and the tibia's CORA lose the mark, and the label keeps the model and
    // that its channel is unchecked.
    current = moveHandle(current, { kind: 'landmark', name: 'plafondMedial', index: 0 }, [223, 894]);
    current = moveHandle(current, { kind: 'landmark', name: 'plafondLateral', index: 0 }, [187, 898]);
    assert.deepEqual([...fromUnchecked(current.plans[0])].sort(), ['AMA', 'aLDFA', 'coraFemur', 'mLPFA']);
    // Placed again by hand, the trochanter is the reader's alone.
    current = place(current, { film: key, kind: 'landmark', name: 'greaterTrochanterTip' }, [61, 141], frame).film;
    plan = current.plans[0];
    assert.deepEqual(plan.origin?.greaterTrochanterTip, { shown: true });
    assert.deepEqual([...fromUnchecked(plan)].sort(), ['AMA', 'aLDFA']);
    // Saved, the model's confidence says its channel is unchecked; opened and saved again, the labels are the same.
    const file = await planFile(current, frame), labels = Object.fromEntries(file.plans[0].landmarks.map(label => [label.name, label]));
    assert.deepEqual([labels.femoralShaftProximal.confidence, labels.femoralShaftProximal.provenance], [{ ...MODEL, unchecked: true }, ['accepted']]);
    assert.deepEqual([labels.plafondMedial.confidence, labels.plafondMedial.provenance], [{ ...MODEL, unchecked: true }, ['moved']]);
    assert.deepEqual(labels.femoralShaftDistal.confidence, MODEL);
    assert.deepEqual([labels.greaterTrochanterTip.confidence, labels.greaterTrochanterTip.suggestionShown], ['manual', true]);
    assert.deepEqual(labels.hipCentre.confidence, MODEL, 'The hip centre is the model\'s checked channel.');
    const text = JSON.stringify(file), opened = await parsePlanFile(text, current, frame);
    assert.ok(!('error' in opened));
    assert.deepEqual(opened.plans[0].origin, plan.origin);
    assert.deepEqual((await planFile({ ...current, plans: opened.plans, active: opened.plans[0].id }, frame)).plans[0].landmarks, file.plans[0].landmarks);
    const edited = (edit: (label: Record<string, unknown>) => void) => {
      const copy = structuredClone(JSON.parse(text));
      for (const label of copy.plans[0].landmarks) edit(label);
      return parsePlanFile(JSON.stringify(copy), current, frame);
    };
    // A label of the model VEAcom ships keeps its channel's mark even when a file lost it (an older VEAcom drops fields it
    // does not know when it saves a file again).
    const dropped = await edited(label => { if (isModel(label.confidence)) delete label.confidence.unchecked; });
    assert.ok(!('error' in dropped));
    assert.equal(dropped.plans[0].origin?.femoralShaftProximal?.unchecked, true);
    assert.equal(dropped.plans[0].origin?.femoralShaftDistal?.unchecked, undefined);
    // Another model's label is unchecked only where its file says so; a point the file gives no model is the reader's.
    const other = { model: 'other', sha256: { stageA: 'a'.repeat(64), stageB: 'b'.repeat(64) } };
    const foreign = await edited(label => {
      if (label.name === 'femoralShaftProximal') label.confidence = other;
      if (label.name === 'kneeCentre') label.confidence = { ...other, unchecked: true };
      if (label.name === 'ankleCentre') label.confidence = { model: 'x', sha256: { stageA: 'zz', stageB: 'zz' }, unchecked: true };
    });
    assert.ok(!('error' in foreign));
    assert.deepEqual(foreign.plans[0].origin?.femoralShaftProximal, { shown: true, model: other });
    assert.deepEqual(foreign.plans[0].origin?.kneeCentre, { shown: true, model: other, unchecked: true });
    assert.deepEqual([foreign.plans[0].origin?.ankleCentre, foreign.plans[0].provenance.ankleCentre], [{ shown: true }, ['placed']]);
  });

  it('name exactly the landmarks each value and CORA is measured from', () => {
    const current = film(), plan = current.plans[0];
    const full: Landmarks = { femoralHeadContour: [[70, 120], [100, 90], [130, 120], [100, 150]], greaterTrochanterTip: [[40, 150]],
      femoralShaftProximal: [[125, 260]], femoralShaftDistal: [[180, 420]], kneeCentre: [[200, 500]], femoralCondyleMedial: [[232, 518]],
      femoralCondyleLateral: [[168, 522]], tibialPlateauMedial: [[228, 530]], tibialPlateauLateral: [[172, 532]], tibialShaftProximal: [[205, 600]],
      tibialShaftDistal: [[207, 800]], plafondMedial: [[224, 893]], plafondLateral: [[188, 899]], ankleCentre: [[205, 900]] };
    const measured = (points: Landmarks) => {
      const view = planView(withPlan(current, { ...plan, points }), frame);
      return (key: keyof typeof MEASURED_FROM) => key === 'coraFemur' ? view.cora.femur !== null : key === 'coraTibia' ? view.cora.tibia !== null
        : key === 'subluxation' ? typeof view.leg.jointOffsetMm === 'number' : view.leg.values[key].value !== null;
    };
    const keys = Object.keys(MEASURED_FROM) as Array<keyof typeof MEASURED_FROM>, complete = measured(full);
    for (const key of keys) assert.ok(complete(key), `${key} is measured on the full plan.`);
    for (const name of LANDMARKS) {
      const { [name]: _gone, ...rest } = full, without = measured(rest);
      for (const key of keys) assert.equal(without(key), !MEASURED_FROM[key].includes(name), `${key} without ${name}`);
    }
  });

  it('run only on a film the model can read, for the leg on its side of the image', () => {
    const current = film();
    assert.deepEqual(suggestionTarget(planView(current, frame), frame), { leg: 'left' }, 'L\\F: the right leg is on the image\'s left.');
    const mirrored = { ...frame, projection: { ...frame.projection!, patientOrientation: ['R', 'F'] as [string, string] } };
    assert.deepEqual(suggestionTarget(planView(current, mirrored), mirrored), { leg: 'right' });
    const upsideDown = { ...frame, projection: { ...frame.projection!, patientOrientation: ['L', 'H'] as [string, string] } };
    assert.deepEqual(suggestionTarget(planView(current, upsideDown), upsideDown), { block: 'upright' });
    const turned = { ...frame, projection: { ...frame.projection!, patientOrientation: ['F', 'R'] as [string, string] } };
    assert.deepEqual(suggestionTarget(planView(current, turned), turned), { block: 'upright' });
    const unoriented = { ...frame, projection: { ...frame.projection!, patientOrientation: undefined } };
    assert.deepEqual(suggestionTarget(planView(current, unoriented), unoriented), { block: 'side' });
    assert.deepEqual(suggestionTarget(planView({ ...current, patientRight: 'right' }, unoriented), unoriented), { leg: 'right' });
    const colour = { ...frame, components: 3 as const };
    assert.deepEqual(suggestionTarget(planView(current, colour), colour), { block: 'colour' });
    const tall = { ...frame, dimensions: [400, 5000, 1] as [number, number, number] };
    assert.deepEqual(suggestionTarget(planView(current, tall), tall), { block: 'size' });
    const most = acceptSuggestions(withSuggestions(current, points, MODEL));
    assert.deepEqual(suggestionTarget(planView(most, frame), frame), { leg: 'left' }, 'The trochanter, shafts and plafond are still to suggest.');
    const rest = Object.fromEntries(LANDMARKS.filter(name => !(name in points)).map((name, i) => [name, [[150 + i, 300 + 80 * i]] as Point[]]));
    const done = acceptSuggestions(withSuggestions(most, rest, MODEL, UNCHECKED));
    assert.deepEqual(suggestionTarget(planView(done, frame), frame), { block: 'placed' });
  });

  it('are kept only when the model found two legs, the leg\'s hip, knee and ankle down the film, and only on the film', () => {
    const channels = { kneeCentre: { point: [200, 500] as Point, confidence: 0.06 }, ankleCentre: { point: [205, 1001] as Point, confidence: 0.06 } };
    const right = { hip: [300, 120] as Point, knee: [290, 500] as Point, ankle: [295, 900] as Point }, size = [400, 1000] as const, mm = [0.33, 0.33] as const;
    const legs = (left: { hip: Point; knee: Point; ankle: Point }) => ({ left, right });
    assert.deepEqual(Object.keys(suggestionsFrom(legs({ hip: [100, 120], knee: [200, 500], ankle: [205, 900] }), 'left', channels, mm, size)!), ['kneeCentre'],
      'The ankle centre a pixel below the film is left out.');
    assert.equal(suggestionsFrom(legs({ hip: [100, 520], knee: [200, 500], ankle: [205, 900] }), 'left', channels, mm, size), null, 'The hip below the knee.');
    assert.equal(suggestionsFrom(legs({ hip: [310, 120], knee: [200, 500], ankle: [205, 900] }), 'left', channels, mm, size), null,
      'The image\'s left leg found right of its right leg: both on one leg.');
    assert.equal(suggestionsFrom(legs({ hip: [160, 120], knee: [200, 500], ankle: [205, 900] }), 'left', channels, mm, size), null,
      'Both hips found within 50 mm (140 px of 0.33 mm, 46 mm): both on one leg.');
    assert.deepEqual(suggestionsFrom(legs({ hip: [100, 120], knee: [200, 500], ankle: [205, 900] }), 'left', { femoralCondyleMedial: { point: [-1, 500] as Point, confidence: 0.06 } }, mm, size),
      {}, 'Every point off the film leaves nothing to suggest (the panel then says the model found nothing).');
  });
});

/** A label's confidence when it names a model. */
const isModel = (value: unknown): value is { unchecked?: boolean } => typeof value === 'object' && value !== null;

describe('the report header', () => {
  const named: Series = { ...series, patientName: 'DOE^JANE', patientId: 'ID-77', studyDate: '20000101', studyTime: '120000', description: 'Long leg standing',
    studyDescription: 'Lower limbs', institutionName: 'Synthetic Hospital', accessionNumber: 'ACC-1', patientAgeText: '045Y', patientSex: 'F' };
  it('names the patient, the study and the film as the pane does', () => {
    const lines = reportHeader(named, sourceFrameSeries(named, 0), false).join('\n');
    assert.match(lines, /DOE JANE/); assert.match(lines, /01\.01\.2000/); assert.match(lines, /Long leg standing/);
    assert.match(lines, /Both sides · Detector plane, not corrected/);
  });
  it('leaves out what the pane hides with patient data hidden', () => {
    const lines = reportHeader(named, sourceFrameSeries(named, 0), true).join('\n');
    for (const hidden of ['DOE', 'JANE', 'ID-77', '2000', 'Long leg standing', 'Lower limbs', 'Synthetic Hospital', 'ACC-1']) assert.doesNotMatch(lines, new RegExp(hidden), hidden);
    assert.match(lines, /DX/); assert.match(lines, /Both sides · Detector plane, not corrected/);
  });
});
