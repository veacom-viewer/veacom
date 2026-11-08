import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertClose } from './support';
import { foldLine, lineAngle, obliqueAngle, rotationComponent, turnedOblique } from '../src/imaging/oblique';
import { getPlaneFrame, screenMapping } from '../src/imaging/geometry';
import type { Series, ViewState } from '../src/model';

const series = {
  id: 's', uid: 'u', studyUid: 'study', patientId: 'P', patientName: 'Synthetic', studyDate: '', description: '', modality: 'CT',
  seriesNumber: 1, dimensions: [64, 64, 64], spacing: [1, 1, 1], origin: [0, 0, 0], direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  windowCenter: 40, windowWidth: 400, valueUnit: 'HU', suvFactor: null, canReconstruct: true, orientationKnown: true, warnings: [], photometricInterpretation: 'MONOCHROME2',
} as Series;
const view = (plane: ViewState['plane'], oblique?: [number, number]): ViewState => ({ plane, slice: 32, windowCenter: 40, windowWidth: 400, zoom: 1, pan: [0, 0], rotation: 0, flipX: false, flipY: false, inverted: false, mode: 'mpr', oblique });
const deg = (radians: number) => radians * 180 / Math.PI;

describe('oblique MPR handles', () => {
  it('turns each plane with the angle that turns it about the pane it is seen in', () => {
    assert.equal(rotationComponent('coronal', 'axial'), 1);
    assert.equal(rotationComponent('coronal', 'sagittal'), 0);
    assert.equal(rotationComponent('sagittal', 'axial'), 1);
    assert.equal(rotationComponent('sagittal', 'coronal'), 0);
    assert.equal(rotationComponent('axial', 'sagittal'), 0);
    assert.equal(rotationComponent('axial', 'coronal'), 1);
  });
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
      const oblique = turnedOblique(frame, mapping, series, view(moved), rotationComponent(moved, seen), 25 * Math.PI / 180);
      assert.ok(Math.abs(deg(foldLine(lineAngle(frame, mapping, series, view(moved), oblique)! - target))) < 0.2);
      assert.equal(obliqueAngle(series, view(moved, oblique)), 25);
    });
  }
  it('follows the pointer past 90° without a stop or a jump, and steps with Shift/Ctrl back to exactly 0', () => {
    const pane = view('axial'), frame = getPlaneFrame(series, pane), mapping = screenMapping(series, pane, 400, 400);
    const component = rotationComponent('coronal', 'axial'), start = lineAngle(frame, mapping, series, view('coronal'), [0, 0])!;
    let previous = 0;
    for (let turned = 10; turned <= 350; turned += 10) {
      const oblique = turnedOblique(frame, mapping, series, view('coronal'), component, turned * Math.PI / 180);
      assert.ok(Math.abs(deg(foldLine(lineAngle(frame, mapping, series, view('coronal'), oblique)! - start - turned * Math.PI / 180))) < 0.2);
      // Each 10° of pointer turns the plane 10° on (modulo a whole turn): no stop at 90°.
      const step = ((Math.abs(oblique[component] - previous) % 360) + 360) % 360;
      assertClose(Math.min(step, 360 - step), 10, 0);
      previous = oblique[component];
    }
    assert.equal(Math.abs(turnedOblique(frame, mapping, series, view('coronal'), component, 23 * Math.PI / 180, 5)[component]), 25);
    const turned = turnedOblique(frame, mapping, series, view('coronal'), component, 23 * Math.PI / 180);
    assert.deepEqual(turnedOblique(frame, mapping, series, view('coronal', turned), component, -21 * Math.PI / 180, 10), [0, 0]);
    assert.equal(obliqueAngle(series, view('coronal', [0, 0])), 0);
  });
});
