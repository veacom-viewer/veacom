import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertClose } from './support';
import { pixelFootprint } from '../src/imaging/footprint';
import { screenMapping, screenToWorld, sub, worldToIndex } from '../src/imaging/geometry';
import type { Series, Vec3, ViewState } from '../src/model';

const series = (overrides: Partial<Series> = {}): Series => ({
  id: 's', uid: 'u', studyUid: 'study', patientId: 'P', patientName: 'Synthetic', studyDate: '', description: '', modality: 'MR',
  seriesNumber: 1, dimensions: [512, 512, 1], spacing: [0.5, 0.5, 3], origin: [0, 0, 0], direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  windowCenter: 400, windowWidth: 800, valueUnit: '', suvFactor: null, canReconstruct: true, warnings: [], photometricInterpretation: 'MONOCHROME2', ...overrides,
});
const view = (overrides: Partial<ViewState> = {}): ViewState => ({ mode: 'source', plane: 'axial', slice: 0, windowCenter: 400, windowWidth: 800,
  zoom: 1, pan: [0, 0], rotation: 0, flipX: false, flipY: false, inverted: false, ...overrides });
/** One screen pixel's steps right and down in the frame's index space, as the renderer works them out. */
function steps(image: Series, shown: ViewState, size: number): [Vec3, Vec3] {
  const mapping = screenMapping(image, shown, size, size), origin = worldToIndex(image, screenToWorld(mapping, 0, 0));
  return [sub(worldToIndex(image, screenToWorld(mapping, 1, 0)), origin), sub(worldToIndex(image, screenToWorld(mapping, 0, 1)), origin)];
}

describe('the area of an acquired frame one screen pixel shows', () => {
  it('is never narrower than one pixel of the frame, so a magnified frame is interpolated between four pixels', () => {
    assert.deepEqual(pixelFootprint([0.25, 0, 0], [0, 0.25, 0]), [0.5, 0.5]);
    assert.deepEqual(pixelFootprint([1, 0, 0], [0, 1, 0]), [0.5, 0.5]);
  });
  it('covers every pixel a minified screen pixel spans, across and down', () => {
    assert.deepEqual(pixelFootprint([3, 0, 0], [0, 3, 0]), [1.5, 1.5]);
    assert.deepEqual(pixelFootprint([2.5, 0, 0], [0, 4, 0]), [1.25, 2]);
    assert.deepEqual(pixelFootprint([0.25, 0, 0], [0, 4, 0]), [0.5, 2]);
  });
  it('takes the bounding box of a rotated or flipped screen pixel, and ignores the step across frames', () => {
    assert.deepEqual(pixelFootprint([0, 2, 0], [-2, 0, 0]), [1, 1]);
    assert.deepEqual(pixelFootprint([-3, 0, 0], [0, -3, 0]), [1.5, 1.5]);
    const [x, y] = pixelFootprint([Math.SQRT2, Math.SQRT2, 0], [-Math.SQRT2, Math.SQRT2, 0]);
    assertClose(x, Math.SQRT2); assertClose(y, Math.SQRT2);
    assert.deepEqual(pixelFootprint([3, 0, 7], [0, 3, -7]), [1.5, 1.5]);
  });
  it('follows the pane size and zoom of a real frame', () => {
    const frame = series();
    // A 512 matrix in a 256-pixel pane: two pixels of the frame each way under every screen pixel.
    pixelFootprint(...steps(frame, view(), 256)).forEach(half => assertClose(half, 1));
    // The same pane zoomed four times: magnified, interpolated between four pixels.
    assert.deepEqual(pixelFootprint(...steps(frame, view({ zoom: 4 }), 256)), [0.5, 0.5]);
    // Rectangular pixels (0.5 × 1 mm) keep their shape on screen: twice as many pixels across as down.
    const tall = series({ dimensions: [512, 256, 1], spacing: [0.5, 1, 3] });
    const [across, down] = pixelFootprint(...steps(tall, view(), 128));
    assertClose(across, 2); assertClose(down, 1);
  });
});
