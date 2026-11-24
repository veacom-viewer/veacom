import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { anchorFor, coveredSlice, facesSame, linkedSlice, sharePlaneSpace, followTarget, inStep, pairKey, samePatient, stepTarget, unplaced, type Anchor, type Pane } from '../src/imaging/linking';
import type { Series, ViewState } from '../src/model';

const series = (overrides: Partial<Series> = {}): Series => ({
  id: 's', uid: 'u', studyUid: 'study', patientKey: 'synthetic-scoped-patient', patientId: 'P1', patientName: 'SENTETIK^HASTA', studyDate: '', description: '', modality: 'CT',
  seriesNumber: 1, dimensions: [8, 8, 10], spacing: [1, 1, 2], origin: [0, 0, 0], direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  windowCenter: 40, windowWidth: 400, valueUnit: 'HU', suvFactor: null, canReconstruct: true, spacingKnown: true, orientationKnown: true,
  warnings: [], photometricInterpretation: 'MONOCHROME2', ...overrides,
});
const view = (slice: number, plane: ViewState['plane'] = 'axial'): ViewState => ({ plane, slice, windowCenter: 40, windowWidth: 400, zoom: 1, pan: [0, 0], rotation: 0, flipX: false, flipY: false, inverted: false });
const pane = (s: Series, slice: number, plane: ViewState['plane'] = 'axial'): Pane => ({ series: s, view: view(slice, plane) });

describe('panes paging together', () => {
  // B: another study of the same patient shown as its own 5 mm slices, stored from the head down (k points the other way).
  const a = series({ id: 'a' });
  const b = series({ id: 'b', studyUid: 'other', spacing: [1, 1, 5], origin: [0, 0, 45], direction: [1, 0, 0, 0, 1, 0, 0, 0, -1], canReconstruct: false });
  it('knows the same kind of plane and the same patient', () => {
    assert.equal(facesSame(pane(a, 0), pane(b, 0)), true);
    assert.equal(facesSame(pane(a, 0), pane(a, 0, 'coronal')), false);
    assert.equal(samePatient(a, b), true);
    assert.equal(samePatient(a, series({ patientId: 'P2' })), false);
    assert.equal(samePatient(series({ patientId: '', patientName: '' }), series({ patientId: '', patientName: '' })), false);
    // The key holds the name (for an ID without an issuer, without case or separators), so the key decides.
    assert.equal(samePatient(a, { ...b, patientName: 'sentetik hasta' }), true);
    assert.equal(samePatient(a, { ...b, patientKey: 'another-patient' }), false);
    assert.equal(samePatient(a, { ...b, patientKey: undefined }), false);
  });
  it('steps two series of pictures image for image, whatever their number', () => {
    const photos = series({ id: 'p', modality: 'OT', orientationKnown: false, canReconstruct: false, dimensions: [8, 8, 12] });
    const others = series({ id: 'q', modality: 'OT', orientationKnown: false, canReconstruct: false, dimensions: [8, 8, 4], patientId: 'P9' });
    assert.equal(unplaced(photos), true);
    assert.equal(inStep(pane(photos, 3), pane(others, 1)), true);
    assert.equal(stepTarget(pane(photos, 4), pane(others, 1), 2), 3);
    assert.equal(stepTarget(pane(photos, 9), pane(others, 3), 5), 3);
    // A picture and a placed DICOM series do not step together.
    assert.equal(inStep(pane(photos, 3), pane(a, 3)), false);
  });
  it('steps slice for slice in the same direction in the patient', () => {
    assert.equal(inStep(pane(a, 0), pane(b, 0)), true);
    assert.equal(inStep(pane(a, 0), pane(series({ dimensions: [8, 8, 12] }), 0)), false);
    assert.equal(stepTarget(pane(a, 3), pane(b, 5), 1), 4);
    assert.equal(stepTarget(pane(a, 3), pane(a, 5), 2), 7);
    assert.equal(stepTarget(pane(a, 3), pane(b, 1), 4), 0);
  });
  it('follows by millimetres from where two panes were linked by hand', () => {
    // A went 5 slices (10 mm) up from slice 3: B goes 2 slices of 5 mm up, which is down its index.
    assert.equal(followTarget(pane(a, 8), pane(b, 4), { source: 3, target: 4 }, 8), 2);
    // 1 slice (2 mm) is 0.4 of B's slice: B stays.
    assert.equal(followTarget(pane(a, 4), pane(b, 4), { source: 3, target: 4 }, 4), 4);
    // 8 x 0.5 mm make one 4 mm slice.
    const fine = series({ id: 'f', spacing: [1, 1, 0.5], dimensions: [8, 8, 40] }), coarse = series({ id: 'c', spacing: [1, 1, 4] });
    assert.equal(followTarget(pane(fine, 8), pane(coarse, 2), { source: 0, target: 2 }, 8), 3);
  });
  it('keeps a hand link only while both panes show the series they were linked with', () => {
    const anchors = new Map<string, Anchor>([[pairKey('p1', 'p2'), { p1: { seriesId: 'a', slice: 3 }, p2: { seriesId: 'b', slice: 4 } }]]);
    assert.notEqual(anchorFor(anchors, { id: 'p2', seriesId: 'b' }, { id: 'p1', seriesId: 'a' }), null);
    assert.equal(anchorFor(anchors, { id: 'p1', seriesId: 'a' }, { id: 'p2', seriesId: 'x' }), null);
  });
});

it('uses the displayed patient plane for paging and scout lines', () => {
  const axial = pane(series({ id: 'ax', frameOfReferenceUid: '1.2' }), 4);
  const coronal = pane(series({ id: 'cor', frameOfReferenceUid: '1.2', direction: [1,0,0,0,0,1,0,-1,0] }), 5);
  axial.view.mode = coronal.view.mode = 'source';
  assert.equal(linkedSlice(axial, coronal, [3,3,8], 1), null);
  const scout = { ...coronal, series: { ...coronal.series, canReconstruct: false, dimensions: [8,8,1] as [number,number,number] } };
  assert.ok(sharePlaneSpace(axial, scout));
  assert.equal(sharePlaneSpace(axial, { ...scout, series: { ...scout.series, frameOfReferenceUid: '2.3' } }), false);
  assert.equal(coveredSlice(axial, [3,3,100]), null);
  assert.equal(linkedSlice(axial, axial, [3,3,8], 1), 4);
});
