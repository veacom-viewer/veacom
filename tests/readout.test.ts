import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FusionSettings, Series, Vec3, ViewState, Volume } from '../src/model';
import { annotationSummary, annotationThrough, fusedPetSummary } from '../src/imaging/annotations';
import { compose, rotation, translation } from '../src/imaging/rigid';
import { indexToWorld } from '../src/imaging/geometry';
import { pointerReadout, voxelAt } from '../src/imaging/readout';
import { setLocale } from '../src/i18n';

// Synthetic grids: an 8 × 8 × 8 PET of 4 mm voxels with a hot voxel, and a CT of 2 mm voxels reaching beyond it.
const base = {
  uid: 'u', studyUid: 'study', patientId: 'P', patientName: 'Synthetic', studyDate: '', seriesNumber: 1,
  direction: [1, 0, 0, 0, 1, 0, 0, 0, 1], windowCenter: 0, windowWidth: 1, canReconstruct: true, warnings: [],
  photometricInterpretation: 'MONOCHROME2', frameOfReferenceUid: 'frame', orientationKnown: true, spacingKnown: true,
};
const petSeries = (overrides: Partial<Series> = {}): Series => ({ ...base, id: 'pet', description: 'PET', modality: 'PT',
  dimensions: [8, 8, 8], spacing: [4, 4, 4], origin: [0, 0, 0], valueUnit: 'Bq/ml', suvFactor: 0.001, ...overrides } as Series);
const ctSeries: Series = { ...base, id: 'ct', description: 'CT', modality: 'CT', dimensions: [20, 20, 20], spacing: [2, 2, 2], origin: [-1, -1, -1],
  valueUnit: 'HU', suvFactor: null } as Series;
const HOT: Vec3 = [5, 2, 3];
const petVolume = (overrides: Partial<Series> = {}): Volume => {
  const series = petSeries(overrides), data = new Float32Array(8 * 8 * 8).fill(1500);
  data[(HOT[2] * 8 + HOT[1]) * 8 + HOT[0]] = 9000;
  return { series, data };
};
const ctVolume = (): Volume => ({ series: ctSeries, data: new Float32Array(20 ** 3).map((_, index) => index % 20 < 8 ? 35 : -820) });
const view = (overrides: Partial<ViewState> = {}): ViewState => ({ plane: 'axial', slice: HOT[2], windowCenter: 0, windowWidth: 1, zoom: 1, pan: [0, 0],
  rotation: 0, flipX: false, flipY: false, inverted: false, mode: 'mpr', ...overrides });
const fusion = (volume: Volume): FusionSettings => ({ volume, opacity: 0.5, upperSuv: 10, palette: 'hot', blend: 'uptake' });
const hot = indexToWorld(petSeries(), HOT);

describe('the value under the pointer', () => {
  it('reads a PET with SUV in the SUV chosen under PET values', () => {
    assert.deepEqual(pointerReadout(petVolume(), view(), hot), ['PET 9.00 SUVbw']);
    assert.deepEqual(pointerReadout(petVolume({ suvNormalization: 'lbm', sulFactor: 0.0008 }), view(), hot), ['PET 7.20 SUL']);
    assert.deepEqual(pointerReadout(petVolume({ suvNormalization: 'bsa', suvBsaFactor: 0.0002 }), view(), hot), ['PET 1.80 SUVbsa']);
    // Without height or sex there is no SUL: the value stays in SUVbw and says so.
    assert.deepEqual(pointerReadout(petVolume({ suvNormalization: 'lbm' }), view(), hot), ['PET 9.00 SUVbw']);
    // Stored as SUV already (GML).
    assert.deepEqual(pointerReadout(petVolume({ valueUnit: 'SUVbw', suvFactor: 1 }), view(), hot), ['PET 9000.00 SUVbw']);
  });

  it('never calls an uncalibrated value SUV', () => {
    const lines = pointerReadout(petVolume({ suvFactor: null }), view(), hot);
    assert.deepEqual(lines, ['PET 9000.0 Bq/ml']);
    assert.doesNotMatch(lines.join(' '), /SU[VL]/);
    // Whatever else it carries: SUL and SUVbsa are SUV too.
    assert.deepEqual(pointerReadout(petVolume({ suvFactor: null, valueUnit: 'CNTS', suvNormalization: 'lbm', sulFactor: 0.0008 }), view(), hot), ['PET 9000.0 CNTS']);
    assert.deepEqual(pointerReadout(petVolume({ suvFactor: null, suvNormalization: 'bsa', suvBsaFactor: 0.0002 }), view(), hot), ['PET 9000.0 Bq/ml']);
  });

  it('reads a CT in HU, and other series in their stored unit', () => {
    assert.deepEqual(pointerReadout(ctVolume(), view({ slice: 4 }), [4, 8, 8]), ['CT 35.0 HU']);
    assert.deepEqual(pointerReadout(ctVolume(), view({ slice: 4 }), [20, 8, 8]), ['CT -820.0 HU']);
    const mr: Volume = { series: { ...ctSeries, modality: 'MR', valueUnit: 'a.u.' }, data: new Float32Array(20 ** 3).fill(412) };
    assert.deepEqual(pointerReadout(mr, view({ slice: 4 }), [4, 8, 8]), ['MR 412.0 a.u.']);
  });

  it('gives the fused PET’s value at the same point on a fused pane', () => {
    assert.deepEqual(pointerReadout(ctVolume(), view({ slice: 4 }), hot, fusion(petVolume())), ['CT -820.0 HU', 'PET 9.00 SUVbw']);
    assert.deepEqual(pointerReadout(ctVolume(), view({ slice: 4 }), hot, fusion(petVolume({ suvNormalization: 'lbm', sulFactor: 0.0008 }))), ['CT -820.0 HU', 'PET 7.20 SUL']);
    assert.deepEqual(pointerReadout(ctVolume(), view({ slice: 4 }), hot, fusion(petVolume({ suvFactor: null }))), ['CT -820.0 HU', 'PET 9000.0 Bq/ml']);
    // Outside the PET: only the CT's value.
    assert.deepEqual(pointerReadout(ctVolume(), view({ slice: 4 }), [34, 8, 8], fusion(petVolume())), ['CT -820.0 HU']);
  });

  it('reads a PET aligned from a frame of its own in its own voxels, where the alignment puts the point', () => {
    // The PET's coordinates lie 24 mm further along: the CT's point p is its p + (0, 0, 24) (imaging/registration.ts).
    const aligned = petVolume({ frameOfReferenceUid: 'prior', origin: [0, 0, 24] }), transform = translation([0, 0, 24]);
    assert.deepEqual(pointerReadout(ctVolume(), view({ slice: 4 }), hot, { ...fusion(aligned), transform }), ['CT -820.0 HU', 'PET 9.00 SUVbw']);
    assert.deepEqual(pointerReadout(ctVolume(), view({ slice: 4 }), hot, fusion(aligned)), ['CT -820.0 HU'], 'taken as one frame, the point misses the PET');
    const through = { base: ctSeries, transform };
    const probe = { id: 'p', type: 'probe' as const, points: [hot], plane: 'axial' as const, slice: 4, mode: 'mpr' as const };
    assert.equal(fusedPetSummary(probe, aligned, through), 'PET 9.00 SUVbw');
    // A rectangle drawn on the CT keeps its shape when the alignment turns it: read by its four corners.
    const box = { id: 'r', type: 'rectangle' as const, points: [[hot[0] - 5, hot[1] - 3, hot[2]], [hot[0] + 7, hot[1] + 9, hot[2]]] as Vec3[], plane: 'axial' as const, slice: 4, mode: 'mpr' as const };
    const turned = { base: ctSeries, transform: compose(translation([0, 0, 24]), rotation(2, 90, hot)) };
    assert.equal(annotationThrough(box, ctSeries, turned.transform).points.length, 4);
    assert.match(fusedPetSummary(box, aligned, turned), /^PET SUVbw max 9\.00, mean /);
    assert.match(fusedPetSummary(box, aligned, through), /^PET SUVbw max 9\.00, mean /);
  });

  it('reads the nearest voxel, as the probe does', () => {
    const volume = petVolume(), near: Vec3 = [hot[0] + 1.9, hot[1] - 1.9, hot[2] + 1.9];
    assert.equal(voxelAt(volume, view(), near), 9000);
    assert.equal(voxelAt(volume, view(), [hot[0] + 2.1, hot[1], hot[2]]), 1500);
    const probe = { id: 'p', type: 'probe' as const, points: [near], plane: 'axial' as const, slice: HOT[2], mode: 'mpr' as const };
    assert.deepEqual(pointerReadout(volume, view(), near), [`PET ${annotationSummary(probe, volume)}`]);
    assert.equal(pointerReadout(ctVolume(), view({ slice: 4 }), near, fusion(volume))[1], fusedPetSummary(probe, volume));
  });

  it('shows nothing off the image, on padding or for an RGB image', () => {
    assert.deepEqual(pointerReadout(petVolume(), view(), [-10, 0, 0]), []);
    assert.deepEqual(pointerReadout(petVolume({ paddingRange: [9000, 9000] }), view(), hot), []);
    assert.deepEqual(pointerReadout({ ...ctVolume(), series: { ...ctSeries, components: 3 } }, view(), [4, 8, 8]), []);
  });

  it('reads an acquired frame’s own pixel, and nothing while that frame is not loaded', () => {
    const source = petVolume({ canReconstruct: false, sourceFramesOnly: true });
    assert.deepEqual(pointerReadout(source, view({ mode: 'source' }), hot), ['PET 9.00 SUVbw']);
    const frame = HOT[2] * 64, preview: Volume = { series: source.series, data: source.data.slice(frame, frame + 64), sourceFrameIndex: HOT[2] };
    assert.deepEqual(pointerReadout(preview, view({ mode: 'source' }), hot), ['PET 9.00 SUVbw']);
    assert.deepEqual(pointerReadout(preview, view({ mode: 'source', slice: HOT[2] + 1 }), hot), []);
  });

  it('gives a MIP’s hottest voxel on the pointer’s ray', () => {
    const mip = view({ plane: 'coronal', slice: 0, projection: 'mip' });
    // The ray through the hot voxel, seen from the front: it runs front to back, so any depth will do.
    assert.deepEqual(pointerReadout(petVolume(), mip, [hot[0], 14, hot[2]]), ['PET ray voxel max 9.00 SUVbw']);
    assert.deepEqual(pointerReadout(petVolume(), mip, [hot[0] + 8, 14, hot[2]]), ['PET ray voxel max 1.50 SUVbw']);
    setLocale('tr');
    try { assert.deepEqual(pointerReadout(petVolume(), mip, [hot[0], 14, hot[2]]), ['PET ışın boyunca voksel maks 9.00 SUVbw']); }
    finally { setLocale('en'); }
  });
});
