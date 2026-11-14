import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { assertClose } from './support';
import type { Series, ViewState } from '../src/model';
import { screenMapping, sourceFrameSeries, worldToScreen } from '../src/imaging/geometry';
import { deformity, filmKey, type FilmPlans } from '../src/ui/deformityStore';
import { imageSideOnScreen, movedView, moveHandle, nextLandmark, pixelToWorld, place, planView, worldToPixel } from '../src/ui/deformityPlan';
import { lateralOnImage } from '../src/imaging/deformity/measure';
import { parsePlanFile, planFile, PLAN_SCHEMA } from '../src/ui/deformityFile';
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
  return deformity.ensure('dx', 0, ['R'], { sopInstanceUid: '2.25.1.1', frameNumber: 1 });
}

describe('placing and moving landmarks', () => {
  it('asks for the landmarks in order, the head\'s outline taking three points', () => {
    let current = film(), placing = { film: filmKey('dx', 0), kind: 'landmark' as const, name: nextLandmark(current.plans[0])! };
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

  it('makes each change one Undo step, and a drag one step for all its moves', () => {
    film();
    let remembered = 0;
    deformity.connectUndo(() => { remembered++; });
    const key = filmKey('dx', 0), handle = { kind: 'landmark' as const, name: 'kneeCentre' as const, index: 0 };
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
    const key = filmKey('dx', 0);
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
