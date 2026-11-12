import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertClose, assertFields } from './support';
import { getPlaneFrame, indexToWorld, isProjection, PROJECTION_STEPS, projectionAngle, sliceAtWorld, sliceCount } from '../src/imaging/geometry';
import { hottestAlongRay } from '../src/imaging/projection';
import { MAX_PROJECTION_HALF, projectionSampling, slabSampling } from '../src/imaging/slab';
import { petLook, quantityScale, suvPresetFor, suvWindowText, windowFor, windowIn } from '../src/imaging/quantity';
import { windowGrey } from '../src/imaging/viewState';
import type { Series, Vec3, ViewState, Volume } from '../src/model';

const series = (overrides: Partial<Series> = {}): Series => ({
  id: 'pet', uid: 'u', studyUid: 'study', patientId: 'P', patientName: 'Synthetic', studyDate: '', description: 'PET', modality: 'PT',
  seriesNumber: 1, dimensions: [20, 16, 30], spacing: [5, 5, 4], origin: [-47.5, -37.5, 0], direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  windowCenter: 0, windowWidth: 1, valueUnit: 'Bq/ml', suvFactor: 3.5e-4, canReconstruct: true, warnings: [], photometricInterpretation: 'MONOCHROME2',
  frameOfReferenceUid: 'frame', orientationKnown: true, ...overrides,
});
const mip = (slice = 0): ViewState => ({ mode: 'mpr', windowMode: 'manual', plane: 'coronal', slice, windowCenter: 0, windowWidth: 1, zoom: 1, pan: [0, 0], rotation: 0,
  flipX: false, flipY: false, inverted: true, projection: 'mip' });
const centre = (item: Series): Vec3 => indexToWorld(item, item.dimensions.map(n => (n - 1) / 2) as Vec3);

describe('a whole-volume MIP pane', () => {
  const pet = series();
  it('pages through 36 turns of 10° about the long axis, always through the volume centre', () => {
    assert.equal(sliceCount(pet, mip()), PROJECTION_STEPS);
    assert.equal(projectionAngle(0), 0);
    assert.equal(projectionAngle(9), 90);
    assert.equal(projectionAngle(-1), 350);
    for (const slice of [0, 4, 9, 18, 27]) {
      const frame = getPlaneFrame(pet, mip(slice));
      assert.equal(frame.center.map((value, axis) => value - centre(pet)[axis]).every(value => Math.abs(value) < 1e-6), true);
      assert.ok(Math.abs(frame.normal[2]) < 1e-9); // turned about the long axis only
    }
    assert.deepEqual(getPlaneFrame(pet, mip(0)).normal.map(Math.abs), [0, 1, 0]);
    assertClose(Math.abs(getPlaneFrame(pet, mip(9)).normal[0]), 1, 9);
    assert.equal(sliceAtWorld(pet, mip(), [10, 10, 10]), 0);
  });
  it('is a projection only while the whole volume can be reconstructed', () => {
    assert.equal(isProjection(pet, mip()), true);
    assert.equal(isProjection(pet, { ...mip(), mode: 'source' }), false);
    assert.equal(isProjection(series({ canReconstruct: false }), mip()), false);
    assert.equal(isProjection(pet, { ...mip(), projection: undefined }), false);
  });
  it('samples the whole depth at half a voxel, so a one-voxel lesion is not read low', () => {
    const sampling = projectionSampling(pet, mip());
    const depth = (pet.dimensions[1] - 1) * pet.spacing[1];
    assert.equal(sampling.mode, 1);
    // One step is half a voxel along the view (index units), and the samples reach past both faces.
    assertClose(Math.hypot(...sampling.step), 0.5, 9);
    assert.ok(sampling.half * Math.hypot(...sampling.step) * pet.spacing[1] >= depth / 2);
    assert.deepEqual(slabSampling(pet, mip()), sampling);
    const huge = series({ dimensions: [600, 600, 30], spacing: [1, 1, 4], origin: [-300, -300, 0] });
    assert.equal(projectionSampling(huge, mip()).half, MAX_PROJECTION_HALF);
  });
  it('a click goes to the hottest voxel near the ray, at its depth', () => {
    const data = new Float32Array(pet.dimensions[0] * pet.dimensions[1] * pet.dimensions[2]).fill(1000);
    const hot: Vec3 = [12, 3, 20];
    data[(hot[2] * pet.dimensions[1] + hot[1]) * pet.dimensions[0] + hot[0]] = 30000;
    const volume: Volume = { series: pet, data };
    const lesion = indexToWorld(pet, hot);
    // A click on the front view, 3 mm beside the lesion and at the plane's depth (the centre).
    const clicked: Vec3 = [lesion[0] + 3, centre(pet)[1], lesion[2]];
    assert.deepEqual(hottestAlongRay(volume, mip(), clicked), lesion);
    // Far from it, the click stays where it was put when everything along the ray is the same.
    const far: Vec3 = [-40, centre(pet)[1], 10];
    const picked = hottestAlongRay(volume, mip(), far);
    assert.ok(Math.abs(picked[2] - 10) <= pet.spacing[2]);
  });
});

describe('a window in SUV', () => {
  const pet = series(), gml = series({ valueUnit: 'SUVbw', suvFactor: 1 }), raw = series({ suvFactor: null }), ct = series({ modality: 'CT', valueUnit: 'HU', suvFactor: null });
  it('draws exactly the SUV range asked for, through the renderer\'s linear window', () => {
    for (const item of [pet, gml]) {
      const window = windowFor(item, { unit: 'SUV', from: 0, to: 5 })!, scale = quantityScale(item, 'SUV')!;
      assertClose(windowGrey(0 / scale, window.windowCenter, window.windowWidth), 0, 9);
      assertClose(windowGrey(5 / scale, window.windowCenter, window.windowWidth), 1, 9);
      assertClose(windowGrey(2.5 / scale, window.windowCenter, window.windowWidth), 0.5, 9);
      const back = windowIn(item, window, 'SUV')!;
      assertClose(back.from, 0, 9);
      assertClose(back.to, 5, 9);
      assert.equal(suvWindowText(item, window), 'SUV 0–5');
      assert.equal(suvPresetFor(item, window)?.key, 'suv5');
    }
  });
  it('never calls a PET without SUV, or a CT, SUV', () => {
    assert.equal(windowFor(raw, { unit: 'SUV', from: 0, to: 5 }), null);
    assert.equal(suvWindowText(raw, { windowCenter: 100, windowWidth: 200 }), null);
    // A file storing SUV that the engine refused (no SUV factor) has no SUV window and no SUV preset: what would draw
    // SUV 0–5 for the same file calibrated (factor 1) is its own values 0–5.
    const refused = { ...gml, suvFactor: null }, five = windowFor(gml, { unit: 'SUV', from: 0, to: 5 })!;
    assert.equal(quantityScale(refused, 'SUV'), null);
    assert.equal(windowFor(refused, { unit: 'SUV', from: 0, to: 5 }), null);
    assert.equal(suvWindowText(refused, five), null);
    assert.equal(suvPresetFor(refused, five), undefined);
    assert.deepEqual(petLook(refused), { inverted: true, palette: undefined });
    assert.equal(suvWindowText(ct, { windowCenter: 40, windowWidth: 400 }), null);
    assert.deepEqual(windowIn(ct, { windowCenter: 40, windowWidth: 400 }, 'HU'), { unit: 'HU', from: -160, to: 239 });
  });
  it('a PET opens inverted grey: at SUV 0–5 with SUV, in its own window without', () => {
    assertFields(petLook(pet), { inverted: true, windowMode: 'manual' });
    assert.deepEqual(petLook(raw), { inverted: true, palette: undefined });
    assert.deepEqual(petLook(ct), {});
  });
});
