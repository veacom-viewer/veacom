import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertClose } from './support';
import { foldLine, lineAngle, obliqueAngle, turnedOblique } from '../src/imaging/oblique';
import { dot, getPlaneFrame, length, screenMapping } from '../src/imaging/geometry';
import { compose, rotation, translation } from '../src/imaging/rigid';
import type { Series, ViewState } from '../src/model';

const series = {
  id: 's', uid: 'u', studyUid: 'study', patientId: 'P', patientName: 'Synthetic', studyDate: '', description: '', modality: 'CT',
  seriesNumber: 1, dimensions: [64, 64, 64], spacing: [1, 1, 1], origin: [0, 0, 0], direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  windowCenter: 40, windowWidth: 400, valueUnit: 'HU', suvFactor: null, canReconstruct: true, orientationKnown: true, warnings: [], photometricInterpretation: 'MONOCHROME2',
} as Series;
const view = (plane: ViewState['plane'], oblique?: [number, number]): ViewState => ({ plane, slice: 32, windowCenter: 40, windowWidth: 400, zoom: 1, pan: [0, 0], rotation: 0, flipX: false, flipY: false, inverted: false, mode: 'mpr', oblique });
const deg = (radians: number) => radians * 180 / Math.PI;

describe('oblique MPR handles', () => {
  it('folds line angles and names the tilt', () => {
    assertClose(deg(foldLine(Math.PI)), 0);
    assertClose(deg(foldLine(Math.PI * 0.75)), -45);
    assert.equal(obliqueAngle(series, view('coronal')), 0);
    assert.equal(obliqueAngle(series, view('coronal', [0, 20])), 20);
  });
  for (const [moved, seen] of [['coronal', 'axial'], ['sagittal', 'axial'], ['coronal', 'sagittal'], ['axial', 'coronal'], ['sagittal', 'coronal'], ['axial', 'sagittal']] as const) {
    it(`puts the ${moved} line where the pointer is in the ${seen} pane`, () => {
      const pane = view(seen), frame = getPlaneFrame(series, pane), mapping = screenMapping(series, pane, 400, 400);
      const start = lineAngle(frame, mapping, series, view(moved), [0, 0])!;
      const target = start + 25 * Math.PI / 180;
      const oblique = turnedOblique(frame, mapping, series, view(moved), 25 * Math.PI / 180);
      assert.ok(Math.abs(deg(foldLine(lineAngle(frame, mapping, series, view(moved), oblique)! - target))) < 0.2);
      assert.equal(obliqueAngle(series, view(moved, oblique)), 25);
    });
  }
  it('turns a registered reference where it is drawn, even when its own plane is parallel to the pane', () => {
    const pane = view('axial'), reference = view('axial'), frame = getPlaneFrame(series, pane);
    const transform = compose(translation([3, -4, 8]), rotation(0, 90, frame.center));
    assert.equal(lineAngle(frame, screenMapping(series, pane, 400, 400), series, reference, [0, 0]), null);
    for (const flipX of [false, true]) {
      const mapping = screenMapping(series, { ...pane, flipX }, 400, 400);
      const start = lineAngle(frame, mapping, series, reference, [0, 0], transform);
      assert.ok(start !== null);
      assertClose(deg(foldLine(start)), 0, 8);
      for (const [turn, step, expected] of [[25, 0, 25], [113, 5, 115], [-70, 0, -70]]) {
        const oblique = turnedOblique(frame, mapping, series, reference, turn * Math.PI / 180, step, transform);
        const line = lineAngle(frame, mapping, series, reference, oblique, transform);
        assert.ok(line !== null);
        assert.ok(Math.abs(deg(foldLine(line - start - expected * Math.PI / 180))) < 0.2);
      }
    }
  });

  it('follows the pointer past 90° without a stop or a jump, and steps with Shift/Ctrl back to exactly 0', () => {
    const pane = view('axial'), frame = getPlaneFrame(series, pane), mapping = screenMapping(series, pane, 400, 400);
    // The coronal plane seen in the axial pane turns about the axial normal, its second angle.
    const component = 1, start = lineAngle(frame, mapping, series, view('coronal'), [0, 0])!;
    let previous = 0;
    for (let turned = 10; turned <= 350; turned += 10) {
      const oblique = turnedOblique(frame, mapping, series, view('coronal'), turned * Math.PI / 180);
      assert.ok(Math.abs(deg(foldLine(lineAngle(frame, mapping, series, view('coronal'), oblique)! - start - turned * Math.PI / 180))) < 0.2);
      // Each 10° of pointer turns the plane 10° on (modulo a whole turn): no stop at 90°.
      const step = ((Math.abs(oblique[component] - previous) % 360) + 360) % 360;
      assertClose(Math.min(step, 360 - step), 10, 0);
      previous = oblique[component];
    }
    assert.equal(Math.abs(turnedOblique(frame, mapping, series, view('coronal'), 23 * Math.PI / 180, 5)[component]), 25);
    const turned = turnedOblique(frame, mapping, series, view('coronal'), 23 * Math.PI / 180);
    assert.deepEqual(turnedOblique(frame, mapping, series, view('coronal', turned), -21 * Math.PI / 180, 10), [0, 0]);
    assert.equal(obliqueAngle(series, view('coronal', [0, 0])), 0);
  });

  it('keeps the three planes square to one another when a plane is turned from a pane that is itself tilted', () => {
    const planes = { axial: view('axial'), coronal: view('coronal'), sagittal: view('sagittal') };
    // Both other planes turn about the pane's own normal, as a handle turns them, each from where it was at the press.
    const turnFrom = (seen: keyof typeof planes, degrees: number) => {
      const pane = planes[seen], frame = getPlaneFrame(series, pane), mapping = screenMapping(series, pane, 400, 400);
      for (const moved of Object.keys(planes) as Array<keyof typeof planes>) {
        if (moved === seen) continue;
        const before = lineAngle(frame, mapping, series, planes[moved], planes[moved].oblique ?? [0, 0])!;
        const oblique = turnedOblique(frame, mapping, series, planes[moved], degrees * Math.PI / 180);
        planes[moved] = view(moved, oblique);
        // The line follows the pointer in the pane it is turned in.
        assert.ok(Math.abs(deg(foldLine(lineAngle(frame, mapping, series, planes[moved], oblique)! - before)) - degrees) < 0.3, `${moved} in ${seen}`);
      }
    };
    const square = () => {
      const normals = Object.values(planes).map(item => getPlaneFrame(series, item).normal);
      for (const [a, b] of [[0, 1], [0, 2], [1, 2]]) {
        assert.ok(Math.abs(dot(normals[a], normals[b])) / (length(normals[a]) * length(normals[b])) < 0.004, `planes ${a} and ${b}`);
      }
    };
    turnFrom('axial', 30); square();
    // The coronal pane is tilted now: its normal is no longer the patient's front-back axis.
    turnFrom('coronal', 25); square();
    turnFrom('sagittal', -40); square();
    turnFrom('axial', 15); square();
  });
});
