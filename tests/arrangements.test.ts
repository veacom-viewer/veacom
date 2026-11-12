import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertClose, assertFields } from './support';
import { alignmentPair, deriveKept, match, matchOnOpen, paneView, sharesSuvScale, readKept, withKept, type Plan } from '../src/arrangements';
import { BUILTIN_ARRANGEMENTS, FUSION, NUCLEAR_MEDICINE_SCREENS, PET_CT, PET_CT_READING, PET_FOLLOW_UP, SIDE_BY_SIDE } from '../src/arrangements/builtin';
import { findRole, ROLE_RANKS } from '../src/arrangements/roles';
import { isProjection, PROJECTION_STEPS } from '../src/imaging/geometry';
import { windowGrey } from '../src/imaging/viewState';
import { sameRangeWindow, windowFor, windowIn } from '../src/imaging/quantity';
import { en } from '../src/i18n/en';
import type { Series, ViewState } from '../src/model';

const series = (overrides: Partial<Series> = {}): Series => ({
  id: 's', uid: 'u', studyUid: 'study', patientKey: 'synthetic-scoped-patient', patientId: 'P', patientName: 'Synthetic', studyDate: '20000101', description: '', modality: 'CT',
  seriesNumber: 1, dimensions: [64, 64, 90], spacing: [2.6, 2.6, 4], origin: [-82, -82, 0], direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  windowCenter: 40, windowWidth: 400, valueUnit: 'HU', suvFactor: null, canReconstruct: true, warnings: [], photometricInterpretation: 'MONOCHROME2',
  frameOfReferenceUid: 'frame', orientationKnown: true, positionKnown: true, ...overrides,
});
const ct = series({ id: 'ct', description: 'CT' });
const pet = (id: string, extra: Partial<Series> = {}) => series({ id, modality: 'PT', petAcquisition: { tracer: 'FDG' }, valueUnit: 'Bq/ml', suvFactor: 3.5e-4, dimensions: [32, 32, 90], spacing: [5.2, 5.2, 4], description: 'PET AC', ...extra });
const view = (extra: Partial<ViewState> = {}): ViewState => ({ mode: 'source', windowMode: 'dicom', plane: 'axial', slice: 0, windowCenter: 40, windowWidth: 400, zoom: 1, pan: [0, 0], rotation: 0, flipX: false, flipY: false, inverted: false, ...extra });
const mr = (id: string, role: 'dwi' | 'adc', extra: Partial<Series> = {}) => series({ id, modality: 'MR', valueUnit: '', description: role === 'dwi' ? 'ep2d_diff trace' : 'ep2d_diff ADC',
  imageType: role === 'adc' ? 'DERIVED\\PRIMARY\\ADC' : 'ORIGINAL\\PRIMARY\\DIFFUSION\\TRACEW', ...(role === 'dwi' ? { diffusionBValue: 1000 } : {}), ...extra });

describe('arrangements as data', () => {
  it('are plain data: every name, notice and ranking they use exists', () => {
    assert.deepEqual(JSON.parse(JSON.stringify(BUILTIN_ARRANGEMENTS)), BUILTIN_ARRANGEMENTS);
    for (const arrangement of BUILTIN_ARRANGEMENTS) {
      if (arrangement.name) assert.ok(arrangement.name in en, arrangement.name);
      if (arrangement.notice) assert.ok(arrangement.notice.key in en, arrangement.notice.key);
      for (const spec of Object.values(arrangement.roles)) for (const rank of spec.prefer ?? []) assert.ok(ROLE_RANKS.includes(rank));
      for (const pane of arrangement.panes) {
        assert.ok(pane.role in arrangement.roles, `${arrangement.id}: ${pane.role}`);
        if (pane.over) assert.ok(pane.over in arrangement.roles, `${arrangement.id}: ${pane.over}`);
      }
    }
    assert.equal(PET_CT.panes.length, 1);
    assert.equal(PET_CT_READING.panes.length, 4);
  });
});

describe('the PET/CT screen', () => {
  const nac = pet('nac', { description: 'PET NAC' }), ac = pet('ac');
  it('opens the attenuation-corrected PET over its CT in one pane', () => {
    const plan = matchOnOpen({}, { series: [ct, nac, ac] })!;
    assert.equal(plan.arrangement.id, 'pet-ct');
    assert.equal(plan.roles.pet.id, 'ac');
    assert.equal(plan.roles.ct.id, 'ct');
    assert.deepEqual(plan.grid, [1, 1]);
    assert.deepEqual(plan.panes.map(pane => [pane.series.id, pane.spec.show, pane.spec.over]), [['ct', 'fused', 'pet']]);
    assert.equal(plan.arrangement.link, 'crosshair');
  });
  it('needs a PET and a CT in one frame of reference', () => {
    assert.equal(match(BUILTIN_ARRANGEMENTS, 'open', { series: [ct] }), null);
    assert.equal(match(BUILTIN_ARRANGEMENTS, 'open', { series: [ac] }), null);
    assert.equal(match(BUILTIN_ARRANGEMENTS, 'open', { series: [ct, pet('elsewhere', { frameOfReferenceUid: 'other' })] }), null);
    assert.equal(match(BUILTIN_ARRANGEMENTS, 'open', { series: [series({ id: 'flat', canReconstruct: false }), ac] }), null);
    assert.equal(match(BUILTIN_ARRANGEMENTS, 'open', { series: [ct, pet('other-study', { studyUid: 'other' })] }), null);
  });
  it('takes the CT acquired with the PET over a diagnostic CT of another range', () => {
    const diagnostic = series({ id: 'diagnostic', dimensions: [64, 64, 300], spacing: [0.8, 0.8, 1], origin: [-82, -82, 200] });
    assert.equal(match(BUILTIN_ARRANGEMENTS, 'open', { series: [diagnostic, ct, ac] })!.roles.ct.id, 'ct');
  });
  it('builds each pane: the MIP as a whole-volume projection, the PET inverted grey at SUV 0–5', () => {
    const plan = match([PET_CT_READING], 'screen', { series: [ct, ac] })!;
    const [ctPane, petPane, , mipPane] = plan.panes.map(pane => paneView(pane.series, pane.spec, view()));
    assertFields(ctPane, { mode: 'source', plane: 'axial', inverted: false, windowMode: 'dicom' });
    assertFields(petPane, { mode: 'source', inverted: true, windowMode: 'manual' });
    assertClose(windowGrey(0 / 3.5e-4, petPane.windowCenter, petPane.windowWidth), 0, 6);
    assertClose(windowGrey(5 / 3.5e-4, petPane.windowCenter, petPane.windowWidth), 1, 6);
    assertFields(mipPane, { mode: 'mpr', plane: 'coronal', projection: 'mip', slice: 0, inverted: true });
    assert.equal(isProjection(ac, mipPane), true);
  });
  it('keeps a PET without SUV in its own window, never in SUV', () => {
    const uncalibrated = pet('raw', { suvFactor: null });
    const plan = match([PET_CT_READING], 'screen', { series: [ct, uncalibrated] })!;
    const petPane = paneView(plan.panes[1].series, plan.panes[1].spec, view({ windowCenter: 1000, windowWidth: 2000 }));
    assertFields(petPane, { inverted: true, windowMode: 'dicom', windowCenter: 1000, windowWidth: 2000 });
  });
});

describe('Keep this', () => {
  const ac = pet('ac'), plan = match([PET_CT_READING], 'screen', { series: [ct, ac] })!;
  const shown = (plan: Plan) => plan.panes.map(pane => ({ seriesId: pane.series.id, view: paneView(pane.series, pane.spec, view()), fusedWith: pane.spec.show === 'fused' ? ac.id : null }));
  it('keeps the panes as moved, with each one\'s role, plane, kind and look, and opens the next study so', () => {
    const panes = shown(plan);
    [panes[0], panes[1]] = [panes[1], panes[0]];
    const variant = deriveKept(plan, panes, [2, 2])!;
    assertFields(variant, { grid: [2, 2], panes: [{ role: 'pet', plane: 'axial', show: 'plain', display: { invert: true, window: { unit: 'SUV', from: 0, to: 5 } } },
      { role: 'ct', plane: 'axial', show: 'plain', display: { invert: false } }, { role: 'ct', show: 'fused', over: 'pet' }, { role: 'pet', show: 'mip' }] });
    const kept = readKept(JSON.stringify({ 'pet-ct': variant }));
    const next = match(withKept(kept), 'open', { series: [series({ id: 'ct2' }), pet('ac2')] })!;
    assert.equal(next.arrangement.kept, true);
    assert.deepEqual(next.panes.map(pane => [pane.series.id, pane.spec.show]), [['ac2', 'plain'], ['ct2', 'plain'], ['ct2', 'fused'], ['ac2', 'mip']]);
  });
  it('keeps the screen without the arrangement too: a kept "off" opens PET/CT studies unarranged', () => {
    const kept = readKept('{"pet-ct":{"off":true}}');
    const context = { series: [ct, ac] };
    assert.equal(matchOnOpen(kept, context), null);
    assert.deepEqual(match(withKept(kept, NUCLEAR_MEDICINE_SCREENS), 'screen', context)?.grid, [2, 2]);
  });
  it('drops what it cannot trust when reading', () => {
    assert.deepEqual(readKept('not json'), {});
    assert.deepEqual(readKept(JSON.stringify({ unknown: { off: true }, 'side-by-side': { off: true } })), {});
    assert.deepEqual(readKept(JSON.stringify({ 'pet-ct': { grid: [2, 2], panes: [{ role: 'mri' }] } })), {});
    assert.deepEqual(readKept(JSON.stringify({ 'pet-ct': { grid: [9, 2], panes: [{ role: 'ct' }] } })), {});
    assert.deepEqual(readKept(JSON.stringify({ 'pet-ct': { grid: [1, 1], panes: [{ role: 'ct' }, { role: 'pet' }] } })), {});
    assert.deepEqual(readKept(JSON.stringify({ 'pet-ct': { grid: [1, 2], panes: [{ role: 'ct', display: { window: { unit: 'SUV', from: 5, to: 1 } } }, { role: 'pet' }] } })), {});
    assert.deepEqual(readKept(JSON.stringify({ 'pet-ct': { grid: [1, 2], panes: [{ role: 'ct', show: 'fused', over: 'ct' }, { role: 'pet' }] } })), {});
  });
  it('cannot keep a pane that shows a series of no role', () => {
    const panes = shown(plan);
    panes[0] = { ...panes[0], seriesId: 'something-else' };
    assert.equal(deriveKept(plan, panes, [2, 2]), null);
  });
});

describe('the rules arrangements replace keep their behaviour', () => {
  it('DWI and ADC pair up in two panes, the DWI with the highest b-value', () => {
    const dwi = mr('dwi', 'dwi'), dwiHigh = mr('dwi-high', 'dwi', { diffusionBValue: 1400 }), adc = mr('adc', 'adc'), otherStudy = mr('adc-2', 'adc', { studyUid: 'other' });
    const all = [dwi, otherStudy, adc, dwiHigh];
    assert.equal(match(BUILTIN_ARRANGEMENTS, 'pick', { series: all, picked: [dwi], panes: 2 })!.roles.adc.id, 'adc');
    assert.equal(match(BUILTIN_ARRANGEMENTS, 'pick', { series: all, picked: [adc], panes: 2 })!.roles.dwi.id, 'dwi-high');
    assert.deepEqual(match(BUILTIN_ARRANGEMENTS, 'pick', { series: all, picked: [adc], panes: 2 })!.arrangement.notice, { key: 'pair.placed', params: { kind: 'DWI' } });
    assert.equal(match(BUILTIN_ARRANGEMENTS, 'pick', { series: all, picked: [dwi], panes: 3 }), null);
    assert.equal(match(BUILTIN_ARRANGEMENTS, 'pick', { series: [dwi, otherStudy], picked: [dwi], panes: 2 }), null);
    assert.equal(match(BUILTIN_ARRANGEMENTS, 'pick', { series: all, picked: [ct], panes: 2 }), null);
  });
  it('several series picked together: 2 → 1×2, 3 → 1×3, 4 → 2×2, 5–6 → 2×3, at most six, the first picked first', () => {
    const items = Array.from({ length: 7 }, (_, index) => series({ id: `s${index}` }));
    const grid = (count: number) => match([SIDE_BY_SIDE], 'pick-several', { series: items, picked: items.slice(0, count) })!.grid;
    assert.deepEqual([2, 3, 4, 5, 6].map(grid), [[1, 2], [1, 3], [2, 2], [2, 3], [2, 3]]);
    const seven = match([SIDE_BY_SIDE], 'pick-several', { series: items, picked: items })!;
    assert.deepEqual(seven.grid, [2, 3]);
    assert.deepEqual(seven.panes.map(pane => pane.series.id), ['s0', 's1', 's2', 's3', 's4', 's5']);
    assert.deepEqual(match([SIDE_BY_SIDE], 'pick-several', { series: items, picked: [items[0], series({ id: 'seg', segmentation: { kind: 'SEG', segments: [] } })] })!.grid, [1, 1]);
  });
  it('fuses anonymous images only within their verified study and frame', () => {
    const patient = { patientId: '', patientName: '', patientKey: 'study-scoped-key' };
    const base = { ...ct, ...patient }, overlay = pet('anonymous-pet', patient);
    assert.equal(match([PET_CT], 'open', { series: [base, overlay] })?.roles.pet.id, overlay.id);
    for (const changed of [{ studyUid: 'other' }, { patientKey: 'other' }, { patientKey: undefined }, { frameOfReferenceUid: 'other' }]) {
      assert.equal(findRole(FUSION.roles.overlay, [{ ...overlay, ...changed }], base), null);
    }
    assert.equal(match([PET_FOLLOW_UP], 'open', { series: [overlay], session: [{ ...overlay, id: 'prior', studyUid: 'other', studyDate: '19990101' }] }), null);
  });

  it('the fusion button finds its partners from the fusion arrangement\'s roles', () => {
    const ac = pet('ac'), nac = pet('nac', { description: 'PET NAC' }), far = pet('far', { frameOfReferenceUid: 'other' });
    assert.equal(findRole(FUSION.roles.overlay, [nac, far, ac], ct)?.id, 'ac');
    assert.equal(findRole(FUSION.roles.ct, [ct, series({ id: 'other-frame', frameOfReferenceUid: 'x' })], ac)?.id, 'ct');
    assert.equal(findRole(FUSION.roles.overlay, [far], ct), null);
  });
  it('a prior study is the same patient\'s most recent earlier one', () => {
    const now = series({ id: 'now', studyUid: 'now', studyDate: '20260101' });
    const older = series({ id: 'older', studyUid: 'a', studyDate: '20240101' }), recent = series({ id: 'recent', studyUid: 'b', studyDate: '20250601' });
    const stranger = series({ id: 'stranger', studyUid: 'c', studyDate: '20251201', patientId: 'Q' });
    assert.equal(findRole({ modality: 'CT', study: 'prior' }, [older, stranger, recent, now], now)?.id, 'recent');
  });
});

describe('the PET follow-up screen', () => {
  const ac = pet('ac'), current = [ct, ac];
  const prior = (id: string, extra: Partial<Series> = {}) => pet(id, { studyUid: 'prior', studyDate: '19991001', frameOfReferenceUid: 'prior-frame', ...extra });
  it('opens one fused pane with a loaded prior and offers current and prior PETs side by side on request', () => {
    const before = prior('before'), context = { series: current, session: [...current, before, prior('before-nac', { description: 'PET NAC' })] };
    assert.deepEqual(matchOnOpen({}, context)?.grid, [1, 1]);
    const plan = match(NUCLEAR_MEDICINE_SCREENS, 'screen', context)!;
    assert.equal(plan.arrangement.id, 'pet-follow-up');
    assert.equal(plan.roles.pet.id, 'ac');
    assert.equal(plan.roles.prior.id, 'before');
    assert.deepEqual(plan.panes.map(pane => [pane.series.id, pane.spec.show]), [['ac', 'plain'], ['before', 'plain'], ['ac', 'mip'], ['before', 'mip']]);
    assert.equal(PET_FOLLOW_UP.panes.every(pane => pane.display?.invert && pane.display.window?.unit === 'SUV' && pane.display.window.from === 0 && pane.display.window.to === 10), true);
  });
  it('keeps one SUV scale on its PETs, converted through each PET\'s own values per SUV', () => {
    assert.equal(PET_FOLLOW_UP.scale, 'shared');
    const plan = match([PET_FOLLOW_UP], 'open', { series: current, session: [prior('before')] })!;
    assert.equal(sharesSuvScale(plan), true);
    for (const raw of [prior('raw', { suvFactor: null }), prior('lbm', { valueUnit: 'SUVlbm' }), prior('refused', { valueUnit: 'SUVbw', suvFactor: null })]) {
      assert.equal(sharesSuvScale({ ...plan, roles: { ...plan.roles, prior: raw } }), false);
    }
    assert.equal(PET_CT.scale, undefined);
    // The two studies' stored values differ per SUV (another dose and weight): the same SUV range is another window.
    const now = pet('now'), before = prior('before', { suvFactor: 2.1e-4 });
    const view = windowFor(now, { unit: 'SUV', from: 0, to: 10 })!, shared = sameRangeWindow(now, view, before, 'SUV')!;
    const range = windowIn(before, shared, 'SUV')!;
    assertClose(range.from, 0, 6);
    assertClose(range.to, 10, 6);
    assert.notEqual(shared.windowWidth, view.windowWidth, 'A raw centre and width would show the prior on another scale.');
    assert.equal(sameRangeWindow(now, view, pet('raw', { suvFactor: null }), 'SUV'), null);
    assert.equal(sameRangeWindow(now, view, ct, 'SUV'), null);
  });
  it('chooses the latest comparable PET before ranking reconstructions and excludes unidentified patients or tracers', () => {
    const january = prior('january', { studyDate: '19990101', dimensions: [32, 32, 200] });
    const october = prior('october', { dimensions: [32, 32, 80] });
    const psma = prior('psma', { studyDate: '19991201', petAcquisition: { tracer: 'Ga-68 PSMA' } });
    const unknown = prior('unknown', { studyDate: '19991205', petAcquisition: undefined });
    assert.equal(match([PET_FOLLOW_UP], 'open', { series: current, session: [january, october, psma, unknown] })?.roles.prior.id, 'october');
    const anonymous = { ...ac, patientId: '', patientName: '' };
    assert.equal(match([PET_FOLLOW_UP], 'open', { series: [anonymous], session: [{ ...october, patientId: '', patientName: '' }] }), null);
  });
  it('aligns the prior to this study by their CTs, or by the PETs where one study has no CT', () => {
    assert.deepEqual(PET_FOLLOW_UP.align, { role: 'prior', to: 'pet', by: 'CT' });
    const before = prior('before'), priorCt = series({ id: 'prior-ct', studyUid: 'prior', studyDate: '19991001', frameOfReferenceUid: 'prior-frame' });
    const session = [...current, before, priorCt], plan = match(BUILTIN_ARRANGEMENTS, 'open', { series: current, session })!;
    const pair = alignmentPair(plan, session)!;
    assert.deepEqual([pair.fixed.id, pair.moving.id], ['ct', 'prior-ct'], 'this study\'s CT under, the prior\'s over it');
    const noCt = alignmentPair(plan, [...current, before])!;
    assert.deepEqual([noCt.fixed.id, noCt.moving.id], ['ac', 'before']);
    // A prior in this study's own frame needs no alignment; nor does an arrangement that asks for none.
    assert.equal(alignmentPair({ ...plan, roles: { ...plan.roles, prior: prior('same-frame', { frameOfReferenceUid: 'frame' }) } }, session), null);
    assert.equal(alignmentPair(match(BUILTIN_ARRANGEMENTS, 'open', { series: current })!, current), null);
    // A kept variant keeps the alignment.
    const kept = withKept({ 'pet-follow-up': { grid: [1, 2], panes: [{ role: 'pet' }, { role: 'prior' }] } }).find(item => item.id === 'pet-follow-up')!;
    assert.deepEqual(kept.align, PET_FOLLOW_UP.align);
  });
  it('gives way to the PET/CT screen without a prior PET of the same patient, earlier and loaded', () => {
    const arranged = (session?: Series[]) => matchOnOpen({}, { series: current, session })!.arrangement.id;
    assert.equal(arranged(), 'pet-ct');
    assert.equal(arranged([...current, prior('earlier')]), 'pet-ct');
    assert.equal(arranged([...current, prior('stranger', { patientId: 'Q' })]), 'pet-ct');
    assert.equal(arranged([...current, prior('later', { studyDate: '20010101' })]), 'pet-ct');
    assert.equal(arranged([...current, prior('ct-only', { modality: 'CT', valueUnit: 'HU' })]), 'pet-ct');
  });
});

describe('the projection pane', () => {
  it('pages in turns of 10° and holds every point at every turn', () => {
    const projection = paneView(pet('ac'), { role: 'pet', show: 'mip' }, view());
    assert.equal(PROJECTION_STEPS, 36);
    assert.equal(isProjection(pet('ac'), { ...projection, mode: 'source' }), false);
  });
});
