import { assertFields } from './support';
import { assertClose } from './support';
import assert from 'node:assert/strict';
// Gamma camera (NM) studies as the arrangements see them (docs/arrangements.md): the SPECT/CT screen, a whole body's
// anterior and posterior views side by side, a SPECT fused as a PET is but never read in SUV, and frames named by
// their view in the corner.
import { afterEach, describe, it } from 'node:test';
import { activeStudyContext, deriveKept, match, paneView, readKept, withKept, type ShownPane } from '../src/arrangements';
import { BUILTIN_ARRANGEMENTS, FUSION, NUCLEAR_MEDICINE_SCREENS, SPECT_CT, WHOLE_BODY } from '../src/arrangements/builtin';
import { findRole } from '../src/arrangements/roles';
import { fusesAsOverlay, fusesOver, fusionScaleMaxKey, petAutoLevel, petHasSuv, petScale } from '../src/imaging/fusion';
import { quantityScale } from '../src/imaging/quantity';
import { fusedPetSummary, quantitativeScale } from '../src/imaging/annotations';
import { renderedView } from '../src/imaging/viewState';
import { isProjection } from '../src/imaging/geometry';
import { nmFrameText, topRightLines } from '../src/ui/overlayCorners';
import { setLocale } from '../src/i18n';
import type { Annotation, FrameMetadata, NmFrame, Series, ViewState, Volume } from '../src/model';

const series = (overrides: Partial<Series> = {}): Series => ({
  id: 's', uid: 'u', studyUid: 'study', patientId: 'P', patientName: 'Synthetic', studyDate: '20000102', description: '', modality: 'CT',
  seriesNumber: 1, dimensions: [128, 128, 95], spacing: [3, 3, 3], origin: [-190, -190, -282], direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  windowCenter: 40, windowWidth: 400, valueUnit: 'HU', suvFactor: null, canReconstruct: true, warnings: [], photometricInterpretation: 'MONOCHROME2',
  frameOfReferenceUid: 'frame', orientationKnown: true, positionKnown: true, ...overrides,
} as Series);
const ct = series({ id: 'ct', description: 'CT' });
/** A reconstructed SPECT in Bq/ml, as the engine gives it: a volume in the CT's frame of reference, without SUV. */
const spect = (id = 'spect', extra: Partial<Series> = {}) => series({ id, modality: 'NM', valueUnit: 'Bq/ml', imageType: 'ORIGINAL\\PRIMARY\\RECON TOMO\\EMISSION',
  description: 'SPECT', dimensions: [64, 64, 48], spacing: [6, 6, 6], windowCenter: 5000, windowWidth: 10000, windowFromPixels: true, ...extra });
const planar = { canReconstruct: false, orientationKnown: false, positionKnown: false } as const;
/** The projections the SPECT was made from: more frames than its slices, and no place in the patient. */
const projections = series({ id: 'projections', modality: 'NM', valueUnit: 'a.u.', imageType: 'ORIGINAL\\PRIMARY\\TOMO\\EMISSION', dimensions: [64, 48, 128], ...planar });
const frames = (labels: (NmFrame | undefined)[]): FrameMetadata[] => labels.map(nm => ({ origin: [0, 0, 0], direction: [1, 0, 0, 0, 1, 0, 0, 0, 1], spacing: [4, 4, 1],
  positionKnown: false, orientationKnown: false, ...(nm ? { nm } : {}) }));
const scan = (id: string, imageType: string, labels: (NmFrame | undefined)[]) => series({ id, modality: 'NM', valueUnit: 'a.u.', imageType, description: 'Whole body',
  dimensions: [128, 512, labels.length], spacing: [4, 4, 1], windowCenter: 600, windowWidth: 1200, frameMetadata: frames(labels), ...planar });
const wholeBody = (id = 'wb', labels: (NmFrame | undefined)[] = [{ view: 'ANT', detector: 1 }, { view: 'POST', detector: 2 }]) =>
  scan(id, 'ORIGINAL\\PRIMARY\\WHOLE BODY\\EMISSION', labels);
const view = (extra: Partial<ViewState> = {}): ViewState => ({ mode: 'source', windowMode: 'dicom', plane: 'axial', slice: 0, windowCenter: 600, windowWidth: 1200,
  zoom: 1, pan: [0, 0], rotation: 0, flipX: false, flipY: false, inverted: false, ...extra });

afterEach(() => setLocale('en'));

describe('the SPECT/CT screen', () => {
  it('opens CT · SPECT · fused · MIP with the reconstructed SPECT, not its projections, linked by the crosshair', () => {
    const plan = match(BUILTIN_ARRANGEMENTS, 'screen', { series: [ct, projections, spect()] })!;
    assert.equal(plan.arrangement.id, 'spect-ct');
    assert.deepEqual([plan.roles.spect.id, plan.roles.ct.id], ['spect', 'ct']);
    assert.deepEqual(plan.grid, [2, 2]);
    assert.deepEqual(plan.panes.map(pane => [pane.series.id, pane.spec.show]), [['ct', 'plain'], ['spect', 'plain'], ['ct', 'fused'], ['spect', 'mip']]);
    assert.equal(plan.panes[2].spec.over, 'spect');
    assert.equal(plan.arrangement.link, 'crosshair');
  });
  it('needs a reconstructed SPECT and the CT in its frame of reference', () => {
    assert.equal(match(BUILTIN_ARRANGEMENTS, 'screen', { series: [ct, projections] }), null);
    assert.equal(match(BUILTIN_ARRANGEMENTS, 'screen', { series: [spect()] }), null);
    assert.equal(match(BUILTIN_ARRANGEMENTS, 'screen', { series: [ct, spect('elsewhere', { frameOfReferenceUid: 'other' })] }), null);
    assert.equal(match(BUILTIN_ARRANGEMENTS, 'screen', { series: [ct, spect('other-study', { studyUid: 'other' })] }), null);
    assert.equal(match(BUILTIN_ARRANGEMENTS, 'screen', { series: [ct, spect('flat', planar)] }), null);
  });
  it('shows the SPECT inverted grey in its own window, never in SUV, and its MIP as a whole-volume projection', () => {
    const plan = match([SPECT_CT], 'screen', { series: [ct, spect()] })!;
    const [ctPane, spectPane, fusedPane, mipPane] = plan.panes.map(pane => paneView(pane.series, pane.spec, view({ windowCenter: pane.series.windowCenter, windowWidth: pane.series.windowWidth })));
    assertFields(ctPane, { inverted: false, windowCenter: 40 });
    assertFields(spectPane, { mode: 'source', inverted: true, windowMode: 'dicom', windowCenter: 5000, windowWidth: 10000 });
    assertFields(fusedPane, { inverted: false, windowCenter: 40 });
    assertFields(mipPane, { mode: 'mpr', plane: 'coronal', projection: 'mip', slice: 0, inverted: true, windowCenter: 5000 });
    assert.equal(isProjection(plan.panes[3].series, mipPane), true);
  });
});

describe('a whole body side by side', () => {
  it('limits a requested screen to the active patient when another patient has the same study UID', () => {
    const foreign = { ...wholeBody('a'), patientKey: 'patient-one' };
    const own = { ...wholeBody('z'), patientKey: 'patient-two' };
    const active = { ...ct, patientKey: own.patientKey };
    assert.equal(foreign.studyUid, active.studyUid);
    assert.equal(match(NUCLEAR_MEDICINE_SCREENS, 'screen', activeStudyContext(active, [foreign, active])), null);
    const plan = match(NUCLEAR_MEDICINE_SCREENS, 'screen', activeStudyContext(active, [foreign, active, own]));
    assert.deepEqual(plan?.panes.map(pane => pane.series.id), [own.id, own.id]);
  });
  it('opens the anterior and posterior views side by side, inverted grey, each paging on its own', () => {
    const plan = match(BUILTIN_ARRANGEMENTS, 'screen', { series: [wholeBody()] })!;
    assert.equal(plan.arrangement.id, 'whole-body');
    assert.deepEqual(plan.grid, [1, 2]);
    assert.equal(plan.arrangement.link, 'none');
    const panes = plan.panes.map(pane => paneView(pane.series, pane.spec, view()));
    assert.deepEqual(panes.map(pane => [pane.slice, pane.inverted]), [[0, true], [1, true]]);
  });
  it('finds each view in whichever frame holds it', () => {
    const plan = match(BUILTIN_ARRANGEMENTS, 'screen', { series: [wholeBody('wb', [{ view: 'POST' }, { view: 'ANT' }])] })!;
    assert.deepEqual(plan.panes.map(pane => paneView(pane.series, pane.spec, view()).slice), [1, 0]);
  });
  it('needs a whole-body scan whose frames name both views', () => {
    for (const labels of [[{ detector: 1 }, { detector: 2 }], [{ view: 'ANT' }], [{ view: 'ANT' }, { view: 'LAO' }], [undefined, undefined]]) {
      assert.equal(match(BUILTIN_ARRANGEMENTS, 'screen', { series: [wholeBody('wb', labels)] }), null, JSON.stringify(labels));
    }
    assert.equal(match(BUILTIN_ARRANGEMENTS, 'screen', { series: [scan('spots', 'ORIGINAL\\PRIMARY\\STATIC\\EMISSION', [{ view: 'ANT' }, { view: 'POST' }])] }), null);
  });
  it('opens a bone scan holding a whole body and a SPECT/CT on the whole body, read first', () => {
    assert.equal(match(BUILTIN_ARRANGEMENTS, 'screen', { series: [ct, spect(), projections, wholeBody()] })!.arrangement.id, 'whole-body');
    assert.ok(BUILTIN_ARRANGEMENTS.indexOf(WHOLE_BODY) < BUILTIN_ARRANGEMENTS.indexOf(SPECT_CT));
  });
  it('keeps the views where the reader moved them, and opens the next whole body so', () => {
    const plan = match(BUILTIN_ARRANGEMENTS, 'screen', { series: [wholeBody()] })!;
    const shown: ShownPane[] = plan.panes.map(pane => ({ seriesId: pane.series.id, view: paneView(pane.series, pane.spec, view()), fusedWith: null }));
    [shown[0], shown[1]] = [shown[1], shown[0]];
    const variant = deriveKept(plan, shown, [1, 2])!;
    assertFields(variant, { grid: [1, 2], panes: [{ role: 'body', view: 'POST', display: { invert: true } }, { role: 'body', view: 'ANT', display: { invert: true } }] });
    const kept = readKept(JSON.stringify({ 'whole-body': variant }));
    assert.deepEqual(kept['whole-body'], variant);
    const next = match(withKept(kept), 'screen', { series: [wholeBody('wb2')] })!;
    assert.equal(next.arrangement.kept, true);
    assert.deepEqual(next.panes.map(pane => paneView(pane.series, pane.spec, view()).slice), [1, 0]);
  });
  it('drops a kept view it does not know', () => {
    assert.deepEqual(readKept(JSON.stringify({ 'whole-body': { grid: [1, 2], panes: [{ role: 'body', view: 'LEFT' }, { role: 'body', view: 'POST' }] } })), {});
    assert.deepEqual(readKept(JSON.stringify({ 'whole-body': { grid: [1, 2], panes: [{ role: 'body', view: 3 }, { role: 'body' }] } })), {});
  });
});

describe('a SPECT fused as a PET is', () => {
  it('lays a PET or a reconstructed SPECT over a CT of its frame of reference, never over itself or another emission image', () => {
    const pet = series({ id: 'pet', modality: 'PT', valueUnit: 'Bq/ml', suvFactor: 3e-4 });
    assert.deepEqual([pet, spect(), projections, ct, series({ id: 'seg', modality: 'NM', segmentation: { kind: 'BINARY', segments: [] } })].map(fusesAsOverlay), [true, true, false, false, false]);
    assert.equal(fusesOver(ct, spect()), true);
    assert.equal(fusesOver(spect(), spect()), false);
    assert.equal(fusesOver(pet, spect()), false);
    assert.equal(fusesOver(ct, spect('elsewhere', { frameOfReferenceUid: 'other' })), false);
  });
  it('the fusion button finds the reconstructed SPECT for a CT, and the CT for a SPECT', () => {
    assert.equal(findRole(FUSION.roles.overlay, [projections, spect()], ct)?.id, 'spect');
    assert.equal(findRole(FUSION.roles.ct, [ct, projections], spect())?.id, 'ct');
  });
  it('colours a SPECT on its own scale and never calls it SUV, even given an SUV factor', () => {
    const data = new Float32Array(Array.from({ length: 1000 }, (_, index) => index + 1));
    for (const item of [spect(), spect('factor', { suvFactor: 0.001 }), spect('named', { valueUnit: 'SUVbw' })]) {
      assert.equal(petHasSuv(item), false);
      assert.equal(quantityScale(item, 'SUV'), null);
      assert.equal(fusionScaleMaxKey(item), 'fusion.scaleMax');
      assertClose(petScale({ series: item, data }), 5 / petAutoLevel(data), 9);
    }
    assert.deepEqual(quantitativeScale(spect()), { factor: 1, unit: 'Bq/ml' });
  });
  it('reads a fused SPECT under a probe or a region in Bq/ml, named SPECT', () => {
    setLocale('en');
    const uniform: Volume = { series: spect('small', { dimensions: [6, 6, 6], spacing: [2, 2, 2], origin: [0, 0, 0] }), data: new Float32Array(216).fill(1500) };
    const roi = (type: Annotation['type'], points: Annotation['points']): Annotation => ({ id: 'roi', type, points, plane: 'axial', slice: 1, mode: 'mpr' });
    assert.equal(fusedPetSummary({ ...roi('probe', [[4, 4, 4]]), mode: 'source' }, uniform), 'SPECT 1500.0 Bq/ml');
    assert.equal(fusedPetSummary(roi('rectangle', [[2, 2, 4], [8, 2, 4], [8, 8, 4], [2, 8, 4]]), uniform), 'SPECT Bq/ml max 1500.0, mean 1500.0');
  });
});

describe('gamma camera frames in the corner', () => {
  it('name the view, and the detector, energy window and phase where the file holds several', () => {
    setLocale('en');
    assert.equal(nmFrameText({ view: 'ANT', detector: 1 }), 'ANT · Detector 1');
    assert.equal(nmFrameText({ view: 'POST' }), 'POST');
    assert.equal(nmFrameText({ detector: 2, energyWindow: '126–154 keV', phase: 3 }), 'Detector 2 · 126–154 keV · Phase 3');
    assert.equal(nmFrameText(undefined), '');
    assert.equal(topRightLines(wholeBody(), true, { view: 'POST', detector: 2 }).at(-1)?.text, 'NM · POST · Detector 2');
    assert.equal(topRightLines(wholeBody(), true).at(-1)?.text, 'NM');
    setLocale('tr');
    assert.equal(nmFrameText({ view: 'ANT', detector: 1, phase: 2 }), 'ANT · Dedektör 1 · Faz 2');
  });
});

it('opens anterior and posterior views at the same scale despite different frame windows and curves', () => {
  const body = wholeBody();
  Object.assign(body.frameMetadata![0], { windowCenter: 50, windowWidth: 100 });
  Object.assign(body.frameMetadata![1], { windowCenter: 100, windowWidth: 200, voiFunction: 'SIGMOID' });
  const volume = { series: body, data: new Uint16Array(0) };
  const panes = WHOLE_BODY.panes.map(pane => renderedView(volume, paneView(body, pane, view())));
  assert.deepEqual(panes.map(pane => [pane.windowCenter, pane.windowWidth, pane.voiFunction]), [[600, 1200, undefined], [600, 1200, undefined]]);
});
