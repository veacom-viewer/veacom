import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertClose } from './support';
import type { Series, ViewState } from '../src/model';
import { screenMapping, screenToWorld, worldToScreen } from '../src/imaging/geometry';
import { twoPointWorld } from '../src/ui/measureGesture';

const series: Series = {
  id: 'gesture', uid: '1', studyUid: '2', patientId: 'TEST', patientName: 'Synthetic', studyDate: '', description: 'Known geometry',
  modality: 'CT', seriesNumber: 1, dimensions: [64, 64, 8], spacing: [0.8, 0.8, 2], origin: [-25, -25, 0],
  direction: [1, 0, 0, 0, 1, 0, 0, 0, 1], windowCenter: 40, windowWidth: 400, valueUnit: 'HU', suvFactor: null, canReconstruct: true,
  warnings: [], photometricInterpretation: 'MONOCHROME2',
};
const view: ViewState = { plane: 'axial', slice: 3, windowCenter: 40, windowWidth: 400, zoom: 1, pan: [0, 0], rotation: 0, flipX: false, flipY: false, inverted: false };

describe('click-click measurements', () => {
  it('keep a rectangle square to the screen when the view is zoomed and panned between the clicks', () => {
    const first = screenMapping(series, view, 400, 360);
    const startWorld = screenToWorld(first, 120, 100);
    // The second click happens after a zoom and pan: the start must be re-projected, not reused in old pixels.
    const second = screenMapping(series, { ...view, zoom: 1.25, pan: [40, -12] }, 400, 360);
    const corners = twoPointWorld(second, 'rectangle', startWorld, [300, 260]).map(point => worldToScreen(second, point));
    const [a, b, c, d] = corners;
    assertClose(b[1], a[1], 6); assertClose(c[0], b[0], 6);
    assertClose(d[0], a[0], 6); assertClose(d[1], c[1], 6);
    assertClose(c[0], 300, 6); assertClose(c[1], 260, 6);
  });
  it('start exactly at the first click and stay in the slice plane', () => {
    const mapping = screenMapping(series, { ...view, rotation: 90, flipX: true }, 400, 360);
    const startWorld = screenToWorld(mapping, 150, 140);
    const points = twoPointWorld(mapping, 'ellipse', startWorld, [260, 220]);
    assert.equal(points[0], startWorld);
    assert.equal(new Set(points.map(point => point[2].toFixed(9))).size, 1);
  });
  it('give two points for lines and arrows', () => {
    const mapping = screenMapping(series, view, 400, 360);
    assert.equal(twoPointWorld(mapping, 'length', screenToWorld(mapping, 10, 10), [50, 60]).length, 2);
    assert.equal(twoPointWorld(mapping, 'arrow', screenToWorld(mapping, 10, 10), [50, 60]).length, 2);
  });
});
