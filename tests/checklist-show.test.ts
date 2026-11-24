import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { onPlane, planeView, showsPlane } from '../src/imaging/calipers';
import { getPlaneFrame, dot, sub } from '../src/imaging/geometry';
import { rememberView, rememberedView } from '../src/ui/checklistViews';
import { CHECKLISTS, nextPlane, noteAnswered, type ChecklistItem, type ChecklistState, type SliceNote } from '../src/ui/preopChecklist';
import type { Series, Vec3, ViewState } from '../src/model';

const pns = CHECKLISTS.pns.groups.flatMap(group => group.items);
const item = (id: string): ChecklistItem => { const found = pns.find(candidate => candidate.id === id); assert.ok(found, id); return found; };
const empty: ChecklistState = { kind: 'pns', answers: {}, notes: {} };
const here: SliceNote = { seriesId: 's', slice: 40, shown: '41/64', plane: 'coronal', mode: 'mpr' };

describe('the planes a checklist item is shown on', () => {
  it('gives every sinus item its planes, the usual one first', () => {
    assert.deepEqual(Object.fromEntries(pns.map(entry => [entry.id, entry.planes])), {
      keros: ['coronal'], lamina: ['coronal'], onodi: ['coronal', 'sagittal'], 'sphenoid-ica': ['axial', 'coronal'],
      'sphenoid-optic': ['coronal', 'axial'], 'sphenoid-septum': ['axial', 'coronal'], pneumatisation: ['sagittal'],
      'ethmoid-artery': ['coronal'], septum: ['coronal'], 'concha-bullosa': ['coronal'], haller: ['coronal'],
    });
  });

  it('turns to the usual plane first, then to the other one and back', () => {
    assert.equal(nextPlane(item('keros'), null), 'coronal');
    assert.equal(nextPlane(item('keros'), 'axial'), 'coronal');
    assert.equal(nextPlane(item('keros'), 'coronal'), 'coronal', 'One plane: Show stays on it.');
    assert.equal(nextPlane(item('onodi'), 'axial'), 'coronal');
    assert.equal(nextPlane(item('onodi'), 'coronal'), 'sagittal');
    assert.equal(nextPlane(item('onodi'), 'sagittal'), 'coronal');
    assert.equal(nextPlane(item('sphenoid-ica'), 'sagittal'), 'axial');
    assert.equal(nextPlane(item('sphenoid-ica'), 'axial'), 'coronal');
    assert.equal(nextPlane(item('pneumatisation'), 'axial'), 'sagittal');
    assert.equal(nextPlane(CHECKLISTS.temporal.groups[0].items[0], 'axial'), null, 'A temporal bone item has no plane of its own yet.');
  });
});

describe('a slice noted by itself when a side is marked present', () => {
  const answered = (state: ChecklistState, id: string, side: 'right' | 'left', value: string | undefined) =>
    ({ ...state, answers: { ...state.answers, [id]: { ...state.answers[id], [side]: value } } });

  it('notes the slice on screen for Var, on one of the item\'s planes, and only on the side answered', () => {
    const state = noteAnswered(answered(empty, 'lamina', 'left', 'yes'), item('lamina'), ['left'], here, 'coronal');
    assert.deepEqual(state.notes.lamina, { left: { ...here, auto: true } });
    assert.equal(noteAnswered(answered(empty, 'lamina', 'left', 'yes'), item('lamina'), ['left'], here, 'axial').notes.lamina, undefined, 'An axial pane is not a lamina papyracea plane.');
    assert.equal(noteAnswered(answered(empty, 'lamina', 'left', 'no'), item('lamina'), ['left'], here, 'coronal').notes.lamina, undefined, 'Yok notes nothing.');
    assert.equal(noteAnswered(answered(empty, 'lamina', 'left', 'unknown'), item('lamina'), ['left'], here, 'coronal').notes.lamina, undefined, '? notes nothing.');
    assert.equal(noteAnswered(answered(empty, 'lamina', 'left', 'yes'), item('lamina'), ['left'], null, 'coronal').notes.lamina, undefined, 'No slice on screen, no note.');
    const both = { ...empty, answers: { onodi: { right: 'yes', left: 'yes' } } };
    assert.deepEqual(Object.keys(noteAnswered(both, item('onodi'), ['right', 'left'], { ...here, plane: 'sagittal' }, 'sagittal').notes.onodi ?? {}), ['right', 'left'], 'Alt+Shift answers both sides: both are noted.');
  });

  it('leaves a note the reader took or a caliper made, and an item with answers of its own', () => {
    const taken: SliceNote = { ...here, slice: 12, shown: '13/64' };
    const state: ChecklistState = { ...answered(empty, 'lamina', 'right', 'yes'), notes: { lamina: { right: taken } } };
    assert.equal(noteAnswered(state, item('lamina'), ['right'], here, 'coronal'), state);
    const keros = answered(empty, 'keros', 'right', '2');
    assert.equal(noteAnswered(keros, item('keros'), ['right'], here, 'coronal'), keros, 'Keros is measured: its types note nothing by themselves.');
    // The reader's own note stays when the answer changes.
    assert.deepEqual(noteAnswered(answered(state, 'lamina', 'right', 'no'), item('lamina'), ['right'], here, 'coronal').notes.lamina, { right: taken });
  });

  it('takes the note away again when the answer is no longer Var', () => {
    const noted = noteAnswered(answered(empty, 'septum', 'right', 'yes'), item('septum'), ['right'], here, 'coronal');
    assert.equal(noted.notes.septum?.right?.auto, true);
    for (const value of ['no', 'unknown', undefined]) {
      assert.deepEqual(noteAnswered(answered(noted, 'septum', 'right', value), item('septum'), ['right'], here, 'coronal').notes.septum, {}, String(value));
    }
    // Another plane on screen when it changes: the note still goes, and none comes back for Yok.
    assert.deepEqual(noteAnswered(answered(noted, 'septum', 'right', 'no'), item('septum'), ['right'], null, null).notes.septum, {});
  });
});

describe('where an item was last looked at', () => {
  it('is kept per study, item and plane, the latest place only', () => {
    const first: SliceNote = { ...here, slice: 30, shown: '31/64' }, second: SliceNote = { ...here, slice: 33, shown: '34/64' };
    rememberView('study-a', 'keros', 'coronal', first);
    rememberView('study-a', 'keros', 'coronal', second);
    assert.equal(rememberedView('study-a', 'keros', 'coronal'), second);
    assert.equal(rememberedView('study-a', 'keros', 'sagittal'), undefined);
    assert.equal(rememberedView('study-a', 'lamina', 'coronal'), undefined);
    assert.equal(rememberedView('study-b', 'keros', 'coronal'), undefined);
  });

  it('forgets the oldest places past its limit', () => {
    rememberView('study-old', 'keros', 'coronal', here);
    for (let index = 0; index < 500; index++) rememberView(`study-${index}`, 'lamina', 'coronal', here);
    assert.equal(rememberedView('study-old', 'keros', 'coronal'), undefined);
    assert.equal(rememberedView('study-499', 'lamina', 'coronal'), here);
  });
});

describe('setting a pane up to show a plane', () => {
  // A 64 mm cube at 1 mm, origin at 0, as tests/calipers.test.ts sets a pane up for a caliper.
  const series = {
    id: 's', uid: 'u', studyUid: 'study', patientId: 'P', patientName: 'Synthetic', studyDate: '', description: '', modality: 'CT',
    seriesNumber: 1, dimensions: [64, 64, 64], spacing: [1, 1, 1], origin: [0, 0, 0], direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    windowCenter: 40, windowWidth: 400, valueUnit: 'HU', suvFactor: null, canReconstruct: true, orientationKnown: true, warnings: [], photometricInterpretation: 'MONOCHROME2',
  } as Series;
  const view = (plane: ViewState['plane'], window: [number, number], extra: Partial<ViewState> = {}): ViewState => ({ plane, slice: 32, windowWidth: window[0], windowCenter: window[1],
    zoom: 1, pan: [0, 0], rotation: 0, flipX: false, flipY: false, inverted: false, mode: 'mpr', ...extra });
  const soft: [number, number] = [400, 40], bone: [number, number] = [1500, 300];
  const at: Vec3 = [20, 12, 40];

  it('knows the plane a view shows, tilted up to 45°, and that a whole-volume MIP shows none', () => {
    assert.ok(showsPlane('axial', series, view('axial', bone)));
    assert.ok(showsPlane('coronal', series, view('coronal', bone, { oblique: [30, 0] })));
    assert.ok(!showsPlane('coronal', series, view('coronal', bone, { oblique: [60, 0] })));
    assert.ok(showsPlane('sagittal', series, view('sagittal', bone)));
    assert.ok(!showsPlane('axial', series, view('coronal', bone)));
    assert.ok(!showsPlane('coronal', series, view('coronal', bone, { projection: 'mip', slice: 0 })));
    // Acquired axial slices show the axial plane; an axial plane needs no head-up, a coronal one does.
    assert.ok(showsPlane('axial', series, view('axial', bone, { mode: 'source' })));
    assert.ok(onPlane('axial', [0, -1, 0], [0, 0, -1]));
    assert.ok(!onPlane('coronal', [0, 0, -1], [0, 1, 0]), 'An upside-down coronal plane is not set up as one.');
  });

  it('turns a coronal pane to the axial plane through the point, in the bone window', () => {
    const setUp = planeView('axial', series, view('coronal', soft), at, true);
    assert.ok(setUp && 'patch' in setUp && setUp.plane && setUp.window);
    assert.deepEqual([setUp.patch.plane, setUp.patch.mode, setUp.patch.oblique], ['axial', 'mpr', [0, 0]]);
    const frame = getPlaneFrame(series, { ...view('coronal', bone), ...setUp.patch });
    assert.ok(Math.abs(dot(sub(at, frame.center), frame.normal)) <= frame.step / 2);
    assert.equal(planeView('axial', series, view('axial', bone), at, true), null, 'Already on it in a bone window: nothing changes.');
    assert.deepEqual(planeView('axial', series, view('coronal', bone), at, false), { blocked: 'caliper.noAxial' });
  });
});
