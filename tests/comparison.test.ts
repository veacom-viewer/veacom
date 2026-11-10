import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { matchComparison } from '../src/arrangements';
import { COMPARISONS } from '../src/arrangements/builtin';
import { bestCounterpart, counterpart } from '../src/arrangements/counterpart';
import { levelSlice } from '../src/imaging/linking';
import { sequenceGuess } from '../src/ui/seriesNames';
import { en } from '../src/i18n/en';
import type { Series, ViewState } from '../src/model';

const series = (overrides: Partial<Series> = {}): Series => ({
  id: 's', uid: 'u', studyUid: 'now', patientKey: 'synthetic-patient', patientId: 'P', patientName: 'Synthetic', studyDate: '20000601', description: '', modality: 'CT',
  seriesNumber: 1, dimensions: [64, 64, 21], spacing: [1, 1, 5], origin: [0, 0, 0], direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  windowCenter: 40, windowWidth: 400, valueUnit: 'HU', suvFactor: null, canReconstruct: true, warnings: [], photometricInterpretation: 'MONOCHROME2',
  frameOfReferenceUid: 'frame-now', orientationKnown: true, positionKnown: true, ...overrides,
});
const view = (extra: Partial<ViewState> = {}): ViewState => ({ mode: 'source', windowMode: 'dicom', plane: 'axial', slice: 0, windowCenter: 40, windowWidth: 400, zoom: 1, pan: [0, 0], rotation: 0, flipX: false, flipY: false, inverted: false, ...extra });
const SAGITTAL = [0, 0, 1, 1, 0, 0, 0, 1, 0];
const mr = (id: string, kind: 't1' | 't1c' | 't2', extra: Partial<Series> = {}) => series({ id, modality: 'MR', valueUnit: '', description: kind,
  ...(kind === 't2' ? { repetitionTime: 4000, echoTime: 100 } : { repetitionTime: 500, echoTime: 10 }), ...(kind === 't1c' ? { contrastBolusAgent: 'Gadolinium' } : {}), ...extra });
/** A series of an earlier study of the same patient. */
const earlier = (item: Series, date = '19991201') => ({ ...item, id: `${item.id}@${date}`, studyUid: `study-${date}`, studyDate: date, frameOfReferenceUid: `frame-${date}` });

describe('the comparison arrangements', () => {
  it('are plain data whose names and notices exist', () => {
    assert.deepEqual(JSON.parse(JSON.stringify(COMPARISONS)), COMPARISONS);
    for (const arrangement of COMPARISONS) {
      assert.ok(arrangement.name && arrangement.name in en, arrangement.id);
      assert.ok(arrangement.notice && arrangement.notice.key in en, arrangement.id);
      // With a counterpart beside the series, the note says which study it is from.
      assert.equal(/\{date\}/.test(en[arrangement.notice.key]), arrangement.panes.length === 2, `${arrangement.id} says the other study's date`);
      for (const pane of arrangement.panes) assert.ok(pane.role in arrangement.roles, `${arrangement.id}: ${pane.role}`);
      assert.equal(arrangement.panes.filter(pane => pane.asShown).length, 1, `${arrangement.id} keeps the reader's pane as shown`);
    }
  });
});

describe('the counterpart of a series in another study', () => {
  const t1 = mr('t1', 't1'), t1c = mr('t1c', 't1c'), t2 = mr('t2', 't2');
  it('reads the fixtures as the sequences they are meant to be', () => {
    assert.deepEqual([t1, t1c, t2].map(item => sequenceGuess(item)?.role), ['t1', 't1c', 't2']);
  });
  it('for MR is the same likely sequence in the same plane, whatever it is called', () => {
    assert.ok(counterpart(t2, earlier({ ...t2, description: 'AX T2 TSE' })));
    assert.equal(counterpart(t2, earlier(t1)), null);
    assert.equal(counterpart(t1, earlier(t1c)), null, 'T1 with contrast is not T1');
    assert.equal(counterpart(t2, earlier({ ...t2, direction: SAGITTAL })), null);
  });
  it('for an MR whose sequence cannot be told is only a series of the same description and plane', () => {
    const unknown = series({ id: 'x', modality: 'MR', valueUnit: '', description: 'Site code 7' });
    assert.equal(sequenceGuess(unknown), null);
    assert.ok(counterpart(unknown, earlier(unknown)));
    assert.equal(counterpart(unknown, earlier({ ...unknown, description: 'Site code 8' })), null);
    assert.equal(counterpart(unknown, earlier(t2)), null);
  });
  it('for CT prefers the same contrast state, then the same name, the same stored look and the nearer thickness', () => {
    const soft = series({ id: 'soft', description: 'Abdomen 5.0 B31f', sliceThickness: 5 });
    const lung = series({ id: 'lung', description: 'Lung 1.0 B70f', sliceThickness: 1, windowCenter: -600, windowWidth: 1500, dimensions: [64, 64, 101], spacing: [1, 1, 1] });
    const enhanced = { ...soft, id: 'venous', description: 'Venous 5.0', contrastBolusAgent: 'Iohexol' };
    const before = [soft, lung, enhanced].map(item => earlier(item));
    assert.equal(bestCounterpart(soft, before)?.id, 'soft@19991201');
    assert.equal(bestCounterpart(lung, before)?.id, 'lung@19991201');
    assert.equal(bestCounterpart(enhanced, before)?.id, 'venous@19991201');
    // Renamed between the two scans: the stored look and the thickness still tell lung from soft tissue.
    const renamed = before.map(item => ({ ...item, description: `${item.description} (old protocol)` }));
    assert.equal(bestCounterpart(lung, renamed)?.id, 'lung@19991201');
    assert.equal(bestCounterpart(soft, renamed)?.id, 'soft@19991201');
    assert.equal(counterpart(soft, earlier({ ...soft, direction: SAGITTAL })), null, 'another plane is not a counterpart');
    assert.equal(counterpart(soft, earlier({ ...soft, canReconstruct: false })), null, 'a scout is not a volume\'s counterpart');
  });
  it('is never a series of another part of the body, where both record theirs', () => {
    const brain = { ...t2, bodyPartExamined: 'BRAIN' };
    assert.ok(counterpart(brain, earlier({ ...brain, bodyPartExamined: 'HEAD' })), 'HEAD and BRAIN are one part');
    assert.ok(counterpart(brain, earlier(t2)), 'a part that is not recorded decides nothing');
    assert.equal(counterpart(brain, earlier({ ...brain, bodyPartExamined: 'KNEE' })), null);
    const chest = series({ bodyPartExamined: 'CHEST' });
    assert.ok(counterpart(chest, earlier({ ...chest, bodyPartExamined: 'CHESTABDPELVIS' })));
    assert.ok(counterpart(chest, earlier({ ...chest, bodyPartExamined: 'Thorax' })));
    assert.equal(counterpart(chest, earlier({ ...chest, bodyPartExamined: 'ABDOMEN' })), null);
    const spine = series({ bodyPartExamined: 'L-SPINE' });
    assert.ok(counterpart(spine, earlier({ ...spine, bodyPartExamined: 'SPINE' })));
    assert.equal(counterpart(spine, earlier({ ...spine, bodyPartExamined: 'TSPINE' })), null);
    assert.equal(counterpart(series({ bodyPartExamined: 'EAR' }), earlier(series({ bodyPartExamined: 'HEART' }))), null, 'a name inside another name is not that part');
  });
  it('for other modalities is only a series of the same description; never another modality or a segmentation', () => {
    const chest = series({ id: 'cr', modality: 'CR', description: 'Chest PA', canReconstruct: false });
    assert.ok(counterpart(chest, earlier({ ...chest, description: 'chest  pa' })));
    assert.equal(counterpart(chest, earlier({ ...chest, description: 'Chest LAT' })), null);
    assert.equal(counterpart(chest, earlier({ ...chest, modality: 'DX' })), null);
    assert.equal(bestCounterpart(chest, []), null);
  });
});

describe('the comparison screen', () => {
  const t1 = mr('t1', 't1'), t2 = mr('t2', 't2', { seriesNumber: 2 }), now = [t1, t2];
  const plan = (picked: Series, session: Series[]) => matchComparison(picked, session);
  it('puts the earlier study\'s counterpart on the left and keeps the reader\'s series on the right', () => {
    const found = plan(t2, [...now, earlier(t1), earlier(t2)])!;
    assert.equal(found.arrangement.id, 'compare-prior');
    assert.deepEqual(found.grid, [1, 2]);
    assert.deepEqual(found.panes.map(pane => pane.series.id), ['t2@19991201', 't2']);
    assert.deepEqual(found.panes.map(pane => Boolean(pane.spec.asShown)), [false, true]);
    assert.equal(found.arrangement.link, 'level');
    assert.equal(found.arrangement.view, 'shared');
  });
  it('takes the most recent earlier study that has a counterpart', () => {
    const found = plan(t2, [...now, earlier(t1, '19991201'), earlier(t2, '19980301'), earlier(t2, '19970101')])!;
    assert.equal(found.arrangement.id, 'compare-prior');
    assert.equal(found.roles.prior.id, 't2@19980301');
  });
  it('passes over a nearer study of another part of the body', () => {
    const brain = { ...t2, bodyPartExamined: 'BRAIN' };
    const knee = earlier({ ...brain, bodyPartExamined: 'KNEE' }, '20000101');
    const found = plan(brain, [brain, knee, earlier(brain, '19990101')])!;
    assert.equal(found.roles.prior.id, 't2@19990101');
  });
  it('is not offered between two PET studies, which the PET follow-up screen compares', () => {
    const ct = series({ id: 'ct' }), pet = series({ id: 'pet', modality: 'PT', description: 'PET AC', valueUnit: 'BQML' });
    const both = [ct, pet, earlier(ct), earlier(pet)];
    assert.equal(plan(ct, both), null);
    assert.equal(plan(pet, both), null);
    assert.equal(plan(earlier(ct), both), null, 'nor from the earlier of the two');
    // A PET/CT is compared with an earlier CT alone, also when a PET/CT lies between the two.
    assert.equal(plan(ct, [ct, pet, earlier(ct)])?.roles.prior.id, 'ct@19991201');
    assert.equal(plan(ct, [...both, earlier(ct, '19980101')])?.roles.prior.id, 'ct@19980101');
  });
  it('leaves the left side empty when the earlier study has no counterpart: nothing of another kind is put there', () => {
    const found = plan(t2, [...now, earlier(t1)])!;
    assert.equal(found.arrangement.id, 'compare-prior-empty');
    assert.equal(found.arrangement.lead, 1);
    assert.deepEqual(found.panes.map(pane => pane.series.id), ['t2']);
    assert.equal(found.roles.other.studyDate, '19991201');
  });
  it('from the earlier study, puts the later study\'s counterpart on the right', () => {
    const old = earlier(t2), found = plan(old, [...now, earlier(t1), old])!;
    assert.equal(found.arrangement.id, 'compare-later');
    assert.deepEqual(found.panes.map(pane => pane.series.id), ['t2@19991201', 't2']);
    assert.deepEqual(found.panes.map(pane => Boolean(pane.spec.asShown)), [true, false]);
  });
  it('is not offered without another study of the same patient', () => {
    assert.equal(plan(t2, now), null);
    const stranger = { ...earlier(t2), patientId: 'Q', patientName: 'Other', patientKey: 'other-patient' };
    assert.equal(plan(t2, [...now, stranger]), null);
    assert.equal(plan(t2, [...now, { ...earlier(t2), studyDate: '' }]), null, 'a study without a date is neither earlier nor later');
  });
});

describe('the level a series opens at beside another study', () => {
  const stack = (slices: number, extra: Partial<Series> = {}) => series({ dimensions: [64, 64, slices], ...extra });
  it('is as far through its own stack as the other is through its own', () => {
    assert.equal(levelSlice({ series: stack(21), view: view({ slice: 10 }) }, { series: stack(41), view: view() }), 20);
    assert.equal(levelSlice({ series: stack(21), view: view({ slice: 0 }) }, { series: stack(41), view: view({ slice: 7 }) }), 0);
    assert.equal(levelSlice({ series: stack(21), view: view({ slice: 20 }) }, { series: stack(41), view: view() }), 40);
  });
  it('goes the same way in the patient when one stack is stored the other way round', () => {
    const reversed = stack(41, { direction: [1, 0, 0, 0, 1, 0, 0, 0, -1], origin: [0, 0, 200] });
    assert.equal(levelSlice({ series: stack(21), view: view({ slice: 5 }) }, { series: reversed, view: view() }), 30);
  });
  it('keeps the slice of a stack too short to place', () => {
    assert.equal(levelSlice({ series: stack(1), view: view() }, { series: stack(41), view: view({ slice: 12 }) }), 12);
    assert.equal(levelSlice({ series: stack(21), view: view({ slice: 10 }) }, { series: stack(1), view: view() }), 0);
  });
});
