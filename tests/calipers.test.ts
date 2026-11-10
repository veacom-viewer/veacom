import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { aeaType, caliperLabel, caliperRefusal, caliperReport, caliperResult, caliperShort, caliperView, geraClass, isLocalizer, kerosType, nearKerosLimit, septumGrade, snapToBone, type CaliperResult } from '../src/imaging/calipers';
import { getPlaneFrame, sub, dot } from '../src/imaging/geometry';
import { caliperNote, checklistRows, checklistSummary, recordCaliper, remeasureRecords, type CaliperNote, type ChecklistState, type SliceNote } from '../src/ui/preopChecklist';
import type { CaliperTag, Series, Vec3, ViewState, Volume } from '../src/model';

const coronal = (side: CaliperTag['side'], kind: CaliperTag['kind'] = 'keros'): CaliperTag => ({ kind, item: 'keros', side, up: [0, 0, 1], normal: [0, 1, 0] });
const sagittal: CaliperTag = { kind: 'sella', item: 'pneumatisation', side: 'both', up: [0, 0, 1], normal: [-1, 0, 0] };
const reading = (result: CaliperResult) => { assert.ok('reading' in result, JSON.stringify(result)); return result.reading; };
const close = (actual: number, expected: number, tolerance = 0.05) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not ${expected}`);
/** The top of a lamella `height` mm high from (−5, 0, 10), leaning `degrees` from the horizontal towards the right. */
const top = (degrees: number, height: number): Vec3 => [-5 - height / Math.tan(degrees * Math.PI / 180), 0, 10 + height];

describe('Keros depth and the Gera angle', () => {
  it('types a depth as Keros read it, in whole millimetres, and marks the gaps between types', () => {
    assert.deepEqual([1, 3.4, 3.5, 6, 7.4, 7.5, 12].map(kerosType), [1, 1, 2, 2, 2, 3, 3]);
    assert.deepEqual([2.4, 2.5, 3.5, 4.5, 4.6, 6, 6.5, 8.5, 8.6].map(nearKerosLimit), [false, true, true, true, false, false, true, true, false]);
    assert.deepEqual([90, 80.1, 80, 45, 44.9].map(geraClass), ['I', 'I', 'II', 'II', 'III']);
  });

  it("measures the lamella's height straight up and its angle to the plate carried on past its foot", () => {
    const plate: Vec3 = [-2, 0, 10], foot: Vec3 = [-5, 0, 10];
    const leaning = caliperResult(coronal('right'), [plate, foot, top(70, 3.5)], 1), measured = reading(leaning);
    assert.ok(measured.kind === 'keros');
    close(measured.gera, 70);
    assert.deepEqual({ ...measured, gera: 70 }, { kind: 'keros', depth: 3.5, type: 2, nearLimit: true, gera: 70, geraClass: 'II' });
    assert.equal('answer' in leaning && leaning.answer, '2');
    const upright = reading(caliperResult(coronal('right'), [plate, foot, [-5, 0, 16]], 1));
    assert.ok(upright.kind === 'keros' && upright.depth === 6 && Math.abs(upright.gera - 90) < 1e-9 && upright.geraClass === 'I' && !upright.nearLimit);
    const flat = reading(caliperResult(coronal('right'), [plate, foot, top(30, 2)], 1));
    assert.ok(flat.kind === 'keros' && Math.abs(flat.gera - 30) < 1e-9 && flat.geraClass === 'III' && flat.type === 1);
    // A lamella leaning towards the midline opens the angle past 90°.
    const medial = reading(caliperResult(coronal('right'), [plate, foot, [-4, 0, 15]], 1));
    assert.ok(medial.kind === 'keros' && medial.gera > 90 && medial.geraClass === 'I');
  });

  it('scales with a calibration, and fails visibly without spacing, off its plane or with points in the wrong order', () => {
    const points: Vec3[] = [[-2, 0, 10], [-5, 0, 10], [-5, 0, 16]];
    const doubled = reading(caliperResult(coronal('left'), points, 2));
    assert.ok(doubled.kind === 'keros' && doubled.depth === 12 && doubled.type === 3);
    assert.deepEqual(caliperResult(coronal('left'), points, null), { unavailable: 'caliper.noSpacing', side: 'left' });
    assert.deepEqual(caliperResult({ ...coronal('left'), up: [0, 1, 0], normal: [0, 0, 1] }, points, 1), { unavailable: 'caliper.notCoronal', side: 'left' });
    // Upside down on its own plane (a flipped reconstruction) is refused too; tilted 30° still counts as coronal.
    assert.deepEqual(caliperResult({ ...coronal('left'), up: [0, 0, -1] }, points, 1), { unavailable: 'caliper.notCoronal', side: 'left' });
    const tilt = 30 * Math.PI / 180;
    assert.equal('reading' in caliperResult({ ...coronal('left'), up: [0, -Math.sin(tilt), Math.cos(tilt)], normal: [0, Math.cos(tilt), Math.sin(tilt)] }, points, 1), true);
    assert.deepEqual(caliperResult(coronal('left'), [points[0], points[2], points[1]], 1), { unavailable: 'caliper.kerosOrder', side: 'left' });
    assert.deepEqual(caliperResult(coronal('left'), [[-5.2, 0, 10], points[1], points[2]], 1), { unavailable: 'caliper.kerosPlate', side: 'left' });
  });
});

describe('anterior ethmoidal artery', () => {
  const tag = coronal('left', 'aea');
  it('answers yes from 2 mm below the roof (El-Anwar types 2 to 4) and leaves type 1 to the reader', () => {
    assert.deepEqual([0, 1.9, 2, 3.9, 4, 6.1].map(aeaType), [1, 1, 2, 2, 3, 4]);
    const hanging = caliperResult(tag, [[12, 0, 13], [12, 0, 16]], 1);
    assert.deepEqual(hanging, { reading: { kind: 'aea', distance: 3, type: 2, nearLimit: false }, side: 'left', answer: 'yes' });
    const adherent = caliperResult(tag, [[12, 0, 12], [12.4, 0, 13.25]], 1);
    assert.deepEqual(adherent, { reading: { kind: 'aea', distance: 1.25, type: 1, nearLimit: false }, side: 'left' });
    const near = reading(caliperResult(tag, [[12, 0, 12], [12, 0, 14.3]], 1));
    assert.ok(near.kind === 'aea' && near.nearLimit);
    assert.deepEqual(caliperResult(tag, [[12, 0, 16], [12, 0, 13]], 1), { unavailable: 'caliper.aeaOrder', side: 'left' });
  });
});

describe('sella lines', () => {
  const tuberculum: Vec3 = [0, 10, 12], dorsum: Vec3 = [0, 22, 13];
  it('places the sinus wall against lines through the tuberculum and the dorsum, whichever is clicked first', () => {
    const sellar = caliperResult(sagittal, [tuberculum, dorsum, [0, 16, 0]], 1);
    assert.ok('answer' in sellar && sellar.answer === 'sellar' && sellar.side === 'both');
    assert.deepEqual(caliperResult(sagittal, [dorsum, tuberculum, [0, 16, 0]], 1), sellar);
    const behind = reading(caliperResult(sagittal, [tuberculum, dorsum, [0, 26, 0]], 1));
    assert.ok(behind.kind === 'sella' && behind.position === 'postsellar' && Math.abs(behind.behind - behind.span - 2.91) < 0.01);
    // In front of the tuberculum line it is presellar or conchal: the size decides, so the reader answers.
    const front = caliperResult(sagittal, [tuberculum, dorsum, [0, 8, 0]], 1);
    assert.ok('reading' in front && front.reading.kind === 'sella' && front.reading.position === 'anterior' && !('answer' in front));
    assert.equal('unavailable' in caliperResult({ ...sagittal, normal: [0, 1, 0] }, [tuberculum, dorsum, [0, 16, 0]], 1), true);
  });
});

describe('septal angle', () => {
  const crest: Vec3 = [0, 0, -18], crista: Vec3 = [0, 0, 18], x = 22 * Math.tan(12 * Math.PI / 180);
  it('measures at the crista galli and answers yes on the side the septum bows to', () => {
    const left = caliperResult(coronal('right', 'septum'), [crest, crista, [x, 0, -4]], 1);
    assert.ok('answer' in left && left.answer === 'yes' && left.side === 'left');
    const angle = reading(left);
    assert.ok(angle.kind === 'septum' && Math.abs(angle.angle - 12) < 1e-9 && angle.grade === 'moderate' && angle.side === 'left');
    const right = caliperResult(coronal('left', 'septum'), [crest, crista, [-x, 0, -4]], 1);
    assert.equal(right.side, 'right');
    const straight = caliperResult(coronal('left', 'septum'), [crest, crista, [0, 0, -4]], 1);
    assert.ok('reading' in straight && !('answer' in straight) && straight.side === 'left');
    assert.deepEqual([8.9, 9, 15, 15.1].map(septumGrade), ['mild', 'moderate', 'moderate', 'severe']);
  });
  it('refuses the crest and the crista galli clicked the other way round, which would put the angle at the crest', () => {
    // Swapped, the same three points would read about 18.5°, "severe", instead of 12° "moderate".
    assert.deepEqual(caliperResult(coronal('right', 'septum'), [crista, crest, [x, 0, -4]], 1), { unavailable: 'caliper.septumOrder', side: 'right' });
    assert.deepEqual(caliperResult(coronal('right', 'septum'), [crista, crista, [x, 0, -4]], 1), { unavailable: 'caliper.septumOrder', side: 'right' });
  });
});

describe('scouts', () => {
  it('are recognised by CT Image Type value 3, LOCALIZER, and nothing else', () => {
    assert.deepEqual(['ORIGINAL\\PRIMARY\\LOCALIZER', 'ORIGINAL\\PRIMARY\\AXIAL', 'DERIVED\\SECONDARY\\REFORMATTED', undefined]
      .map(imageType => isLocalizer({ imageType })), [true, false, false, false]);
  });

  it('are refused with every series that is not CT, at the start and at the drawing alike', () => {
    assert.equal(caliperRefusal({ modality: 'CT', imageType: 'ORIGINAL\\PRIMARY\\AXIAL' }), null);
    assert.equal(caliperRefusal({ modality: 'CT', imageType: 'ORIGINAL\\PRIMARY\\LOCALIZER' }), 'caliper.localizer');
    assert.equal(caliperRefusal({ modality: 'MR', imageType: 'ORIGINAL\\PRIMARY\\M' }), 'caliper.needsImage');
  });
});

describe('caliper words', () => {
  it('say the measurement with its unit in both languages', () => {
    const result = caliperResult(coronal('right'), [[-2, 0, 10], [-5, 0, 10], top(70, 3.5)], 1);
    assert.equal(caliperLabel(coronal('right'), result, 'en'), 'Keros right 3.5 mm · type 2, near limit · Gera 70.0°, class II');
    assert.equal(caliperLabel(coronal('right'), result, 'tr'), 'Keros sağ 3.5 mm · tip 2, sınırda · Gera 70.0°, sınıf II');
    assert.equal(caliperShort(result, 'en'), '3.5 mm · 70.0°');
    assert.equal(caliperLabel(coronal('right'), { unavailable: 'caliper.noSpacing', side: 'right' }, 'en'), 'Keros and Gera · Unavailable: pixel spacing unknown');
    // The report follows the item's answer and does not repeat it.
    const sellar = caliperResult(sagittal, [[0, 10, 12], [0, 22, 12], [0, 14, 0]], 1);
    assert.equal(caliperLabel(sagittal, sellar, 'en'), 'Sella lines · Sellar · 4.0 mm behind tuberculum line');
    assert.equal(caliperReport(sellar, 'tr'), 'tüberkulum hattının 4.0 mm arkasında');
    assert.equal(caliperReport(caliperResult(sagittal, [[0, 10, 12], [0, 22, 12], [0, 8.5, 0]], 1), 'en'), 'In front of the tuberculum line: presellar or conchal, 1.5 mm in front of tuberculum line');
    const septum = caliperResult(coronal('right', 'septum'), [[0, 0, -18], [0, 0, 18], [-4, 0, -4]], 1);
    assert.equal(caliperLabel(coronal('right', 'septum'), septum, 'tr'), 'Septum sağa 10.3° · orta');
    assert.equal(caliperReport(septum, 'en'), '10.3°, moderate');
  });
});

describe('snapping onto bone', () => {
  // A 10 mm cube of air at 0.5 mm with a bone plate one voxel thick at z = 2 mm.
  const series = {
    id: 's', uid: 'u', studyUid: 'study', patientId: 'P', patientName: 'Synthetic', studyDate: '', description: '', modality: 'CT',
    seriesNumber: 1, dimensions: [21, 21, 21], spacing: [0.5, 0.5, 0.5], origin: [-5, -5, -5], direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    windowCenter: 40, windowWidth: 400, valueUnit: 'HU', suvFactor: null, canReconstruct: true, orientationKnown: true, warnings: [], photometricInterpretation: 'MONOCHROME2',
  } as Series;
  const data = new Int16Array(21 * 21 * 21).fill(-1000);
  data.fill(1000, 14 * 441, 15 * 441);
  const volume: Volume = { series, data };
  const up: Vec3 = [0, 0, 1], across: Vec3 = [-1, 0, 0];

  it('moves a point within its plane to the nearest place at 200 HU or more, and leaves it where no bone is near', () => {
    // Air at z = 1.5 mm, bone at 2 mm: interpolated, 200 HU lies at 1.8 mm, so from 1.05 mm the nearest step on bone is 1.85.
    const snapped = snapToBone(volume, [0.3, 0, 1.05], up, across);
    assert.deepEqual(snapped.map(value => Math.round(value * 1000) / 1000), [0.3, 0, 1.85]);
    assert.deepEqual(snapToBone(volume, [0, 0, 2], up, across), [0, 0, 2]);
    assert.deepEqual(snapToBone(volume, [0, 0, -1.5], up, across), [0, 0, -1.5]);
    assert.deepEqual(snapToBone({ ...volume, series: { ...series, valueUnit: '' } }, [0, 0, 1], up, across), [0, 0, 1]);
  });
});

describe('the checklist record of a caliper', () => {
  const empty: ChecklistState = { kind: 'pns', answers: {}, notes: {} };
  const slice = { seriesId: 's', slice: 41, shown: '42/120', plane: 'coronal', mode: 'mpr' };
  const note = (annotationId: string, result: CaliperResult, kind: CaliperNote['kind'] = 'keros', points: Vec3[] = []): SliceNote & { caliper: CaliperNote } =>
    ({ ...slice, caliper: caliperNote(annotationId, coronal(result.side, kind), points, result) });
  const kerosPoints = (depth: number): Vec3[] => [[-2, 0, 10], [-5, 0, 10], [-5, 0, 10 + depth]];
  const keros = (depth: number) => caliperResult(coronal('right'), kerosPoints(depth), 1);

  it('sets the answer, follows edits of the same drawing, and keeps an answer the reader picked since', () => {
    let state = recordCaliper(empty, 'keros', 'right', note('a', keros(6)));
    assert.equal(state.answers.keros?.right, '2');
    assert.equal(state.notes.keros?.right?.caliper?.annotationId, 'a');
    state = recordCaliper(state, 'keros', 'right', note('a', keros(2)));
    assert.equal(state.answers.keros?.right, '1');
    state = { ...state, answers: { keros: { right: '3' } } };
    state = recordCaliper(state, 'keros', 'right', note('a', keros(6)));
    assert.equal(state.answers.keros?.right, '3');
    assert.equal(state.notes.keros?.right?.caliper?.given, '2');
  });

  it('moves a septum record to the side an edit bows it to, and drops an earlier drawing\'s answer', () => {
    const septum = (x: number) => caliperResult(coronal('left', 'septum'), [[0, 0, -18], [0, 0, 18], [x, 0, -4]], 1);
    let state = recordCaliper(empty, 'septum', 'left', note('s', septum(4), 'septum'));
    state = recordCaliper(state, 'septum', 'right', note('s', septum(-4), 'septum'));
    assert.deepEqual(state.answers.septum, { right: 'yes' });
    assert.deepEqual(Object.keys(state.notes.septum ?? {}), ['right']);
    // An artery measured again at the skull base: the earlier drawing's yes goes; the reader's own answer would stay.
    const artery = (distance: number) => caliperResult(coronal('left', 'aea'), [[12, 0, 13], [12, 0, 13 + distance]], 1);
    state = recordCaliper(state, 'ethmoid-artery', 'left', note('x', artery(3), 'aea'));
    assert.equal(state.answers['ethmoid-artery']?.left, 'yes');
    state = recordCaliper(state, 'ethmoid-artery', 'left', note('y', artery(1), 'aea'));
    assert.equal(state.answers['ethmoid-artery']?.left, undefined);
    state = { ...state, answers: { ...state.answers, 'ethmoid-artery': { left: 'no' } } };
    state = recordCaliper(state, 'ethmoid-artery', 'left', note('z', artery(1), 'aea'));
    assert.equal(state.answers['ethmoid-artery']?.left, 'no');
  });

  it('measures a record whose drawing was deleted again at a new scale, and leaves the records of drawings to them', () => {
    const leftPoints: Vec3[] = [[2, 0, 10], [5, 0, 10], [5, 0, 16]];
    let state = recordCaliper(empty, 'keros', 'right', note('deleted', keros(3.2), 'keros', kerosPoints(3.2)));
    state = recordCaliper(state, 'keros', 'left', note('drawn', caliperResult(coronal('left'), leftPoints, 1), 'keros', leftPoints));
    const doubled = remeasureRecords(state, 's', new Set(['drawn']), 2), right = doubled.notes.keros?.right?.caliper?.result;
    assert.ok(right && 'reading' in right && right.reading.kind === 'keros');
    close(right.reading.depth, 6.4);
    assert.equal(doubled.answers.keros?.right, '2', 'The answer follows the new depth.');
    assert.equal(doubled.notes.keros?.left, state.notes.keros?.left);
    assert.equal(remeasureRecords(state, 'another series', new Set(), 2), state);
    // An answer the reader picked stays; without a scale the record says why instead of keeping the old value.
    const picked = remeasureRecords({ ...state, answers: { keros: { ...state.answers.keros, right: '3' } } }, 's', new Set(['drawn']), 2);
    assert.equal(picked.answers.keros?.right, '3');
    const unscaled = remeasureRecords(state, 's', new Set(['drawn']), null);
    assert.deepEqual(unscaled.notes.keros?.right?.caliper?.result, { unavailable: 'caliper.noSpacing', side: 'right' });
    assert.equal(unscaled.answers.keros?.right, undefined);
  });

  it('gives each side its measurement and slice in the report, and both fossae their difference', () => {
    let state = recordCaliper(empty, 'keros', 'right', note('r', caliperResult(coronal('right'), [[-2, 0, 10], [-5, 0, 10], top(70, 3.5)], 1)));
    state = recordCaliper(state, 'keros', 'left', note('l', caliperResult(coronal('left'), [[2, 0, 10], [5, 0, 10], [5, 0, 16]], 1)));
    state = recordCaliper(state, 'ethmoid-artery', 'right', note('a', caliperResult(coronal('right', 'aea'), [[-12, 0, 12], [-12, 0, 13.25]], 1), 'aea'));
    const english = checklistSummary('pns', state.answers, state.notes, 'en');
    assert.ok(english.includes('Cribriform plate (Keros): Right 2 (3.5 mm, type 2, near limit; Gera 70.0°, class II; slice 42/120), Left 2 (6.0 mm, type 2; Gera 90.0°, class I; slice 42/120); right–left difference 2.5 mm'), english);
    // Measured without an answer: the side still shows what was measured.
    assert.ok(english.includes('Anterior ethmoid artery: Right – (1.3 mm below roof, type 1; slice 42/120), Left –'), english);
    const turkish = checklistSummary('pns', state.answers, state.notes, 'tr');
    assert.ok(turkish.includes('Sağ 2 (3.5 mm, tip 2, sınırda; Gera 70.0°, sınıf II; kesit 42/120)'), turkish);
    assert.ok(turkish.includes('sağ–sol fark 2.5 mm'), turkish);
  });
});

describe('setting a pane up for a caliper', () => {
  // A 64 mm cube at 1 mm, origin at 0: voxel centres from 0 to 63 on each axis.
  const series = {
    id: 's', uid: 'u', studyUid: 'study', patientId: 'P', patientName: 'Synthetic', studyDate: '', description: '', modality: 'CT',
    seriesNumber: 1, dimensions: [64, 64, 64], spacing: [1, 1, 1], origin: [0, 0, 0], direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    windowCenter: 40, windowWidth: 400, valueUnit: 'HU', suvFactor: null, canReconstruct: true, orientationKnown: true, warnings: [], photometricInterpretation: 'MONOCHROME2',
  } as Series;
  const view = (plane: ViewState['plane'], window: [number, number], extra: Partial<ViewState> = {}): ViewState => ({ plane, slice: 32, windowWidth: window[0], windowCenter: window[1],
    zoom: 1, pan: [0, 0], rotation: 0, flipX: false, flipY: false, inverted: false, mode: 'mpr', ...extra });
  const soft: [number, number] = [400, 40], bone: [number, number] = [1500, 300];
  const at: Vec3 = [20, 12, 40];

  it('turns the pane to the plain plane through the point, in the bone window', () => {
    const setUp = caliperView('keros', series, view('axial', soft), at, true);
    assert.ok(setUp && 'patch' in setUp && setUp.plane && setUp.window);
    assert.equal(setUp.patch.plane, 'coronal');
    assert.deepEqual([setUp.patch.mode, setUp.patch.oblique, setUp.patch.windowWidth, setUp.patch.windowCenter, setUp.patch.windowMode], ['mpr', [0, 0], 1500, 300, 'manual']);
    // The plane shown afterwards passes through the point.
    const frame = getPlaneFrame(series, { ...view('axial', bone), ...setUp.patch });
    assert.ok(Math.abs(dot(sub(at, frame.center), frame.normal)) <= frame.step / 2);
    const sella = caliperView('sella', series, view('coronal', bone), at, true);
    assert.ok(sella && 'patch' in sella && sella.patch.plane === 'sagittal' && !sella.window);
    const sagittalFrame = getPlaneFrame(series, { ...view('coronal', bone), ...sella.patch });
    assert.ok(Math.abs(dot(sub(at, sagittalFrame.center), sagittalFrame.normal)) <= sagittalFrame.step / 2);
  });

  it('keeps a pane already on the plane, with its slice and tilt, and a window that already shows bone', () => {
    assert.equal(caliperView('keros', series, view('coronal', [2000, 400], { oblique: [10, 0] }), at, true), null);
    const window = caliperView('aea', series, view('coronal', soft, { oblique: [10, 0] }), at, true);
    assert.deepEqual(window, { plane: false, window: true, patch: { windowWidth: 1500, windowCenter: 300, windowMode: 'manual' } });
    // A lung window is as wide but centred on air; a series not in HU keeps its own window.
    assert.equal(caliperView('keros', series, view('coronal', [1500, -400]), at, true) !== null, true);
    assert.equal(caliperView('keros', { ...series, valueUnit: '' }, view('coronal', soft), at, true), null);
  });

  it('leaves a whole-volume MIP for the plane, and says when the series cannot be shown on it', () => {
    const mip = caliperView('septum', series, view('coronal', bone, { projection: 'mip', slice: 0 }), at, true);
    assert.ok(mip && 'patch' in mip && mip.plane && mip.patch.projection === undefined && mip.patch.mode === 'mpr');
    assert.deepEqual(caliperView('keros', series, view('axial', bone), at, false), { blocked: 'caliper.noCoronal' });
    assert.deepEqual(caliperView('sella', series, view('axial', bone), at, false), { blocked: 'caliper.noSagittal' });
  });
});

describe('the theatre card', () => {
  it('lists every item with both sides, what was marked, measured and where, and the fossae difference', () => {
    let state: ChecklistState = { kind: 'pns', answers: { lamina: { left: 'yes' } }, notes: {} };
    const slice = { seriesId: 's', slice: 40, shown: '41/141', plane: 'coronal', mode: 'mpr' };
    const keros = (side: 'right' | 'left', depth: number): SliceNote & { caliper: CaliperNote } => {
      const result = caliperResult(coronal(side), [[side === 'right' ? -2 : 2, 0, 10], [side === 'right' ? -5 : 5, 0, 10], [side === 'right' ? -5 : 5, 0, 10 + depth]], 1);
      return { ...slice, caliper: caliperNote(side, coronal(side), [], result) };
    };
    state = recordCaliper(recordCaliper(state, 'keros', 'right', keros('right', 3.5)), 'keros', 'left', keros('left', 6));
    const groups = checklistRows('pns', state.answers, state.notes, 'en');
    assert.deepEqual(groups.map(group => group.title), ['CLOSE', 'Other']);
    assert.equal(groups.flatMap(group => group.items).length, 11, 'Every item, marked or not.');
    const [fossae] = groups[0].items;
    assert.deepEqual(fossae.sides[0], { side: 'right', word: '2', marked: true, nearLimit: true, measured: '3.5 mm, type 2, near limit; Gera 90.0°, class I', slice: 'slice 41/141', plane: 'coronal' });
    assert.equal(fossae.difference, 'right–left difference 2.5 mm');
    const lamina = groups[0].items.find(item => item.id === 'lamina');
    assert.deepEqual(lamina?.sides.map(side => [side.word, side.marked]), [['–', false], ['Yes', true]]);
    const pneumatisation = groups[0].items.find(item => item.id === 'pneumatisation');
    assert.deepEqual(pneumatisation?.sides.map(side => side.side), ['both']);
    assert.equal(checklistRows('pns', state.answers, state.notes, 'tr')[0].items[1].sides[1].word, 'Var');
  });
});
