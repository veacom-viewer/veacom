import assert from 'node:assert/strict';
// A gated SPECT as the interface sees it (docs/arrangements.md): one placed volume per gate, named by its time slot,
// its R-R window where the file holds several, and the time it counted, in English and Turkish; the SPECT/CT screen and
// the fusion button keep the summed reconstruction while there is one.
import { afterEach, describe, it } from 'node:test';
import { match } from '../src/arrangements';
import { BUILTIN_ARRANGEMENTS, FUSION, SPECT_CT } from '../src/arrangements/builtin';
import { findRole, ROLE_RANKS } from '../src/arrangements/roles';
import { fusesAsOverlay, petScale } from '../src/imaging/fusion';
import { phaseLabel, topRightLines } from '../src/ui/overlayCorners';
import { exportedImages, foldSearch, searchText, seriesName, sortStudySeries } from '../src/ui/seriesNames';
import { setLocale } from '../src/i18n';
import type { Gate, Series } from '../src/model';

const series = (overrides: Partial<Series> = {}): Series => ({
  id: 's', uid: 'u', studyUid: 'study', patientId: 'P', patientName: 'Synthetic', studyDate: '20000102', description: '', modality: 'CT',
  seriesNumber: 1, dimensions: [128, 128, 95], spacing: [3, 3, 3], origin: [-190, -190, -282], direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  windowCenter: 40, windowWidth: 400, valueUnit: 'HU', suvFactor: null, canReconstruct: true, warnings: [], photometricInterpretation: 'MONOCHROME2',
  frameOfReferenceUid: 'frame', orientationKnown: true, positionKnown: true, ...overrides,
} as Series);
const ct = series({ id: 'ct', description: 'CT', seriesNumber: 1 });
/** The summed reconstruction, as the engine gives it: a volume in the CT's frame of reference. */
const summed = series({ id: 'summed', modality: 'NM', valueUnit: 'a.u.', imageType: 'ORIGINAL\\PRIMARY\\RECON TOMO\\EMISSION', description: 'SPECT',
  seriesNumber: 3, dimensions: [64, 64, 32], spacing: [6, 6, 6], windowCenter: 500, windowWidth: 1000 });
/** Gate `slot` of a gated SPECT: one series of the engine's, listed before the summed one by its lower series number. */
const gate = (slot: number, extra: Partial<Gate> = {}, slots = 8): Series => series({
  id: `gate-${extra.interval ?? 1}-${slot}`, uid: 'gated', modality: 'NM', valueUnit: 'a.u.', imageType: 'ORIGINAL\\PRIMARY\\RECON GATED TOMO\\EMISSION',
  description: 'Gated SPECT', seriesNumber: 2, dimensions: [64, 64, 32], spacing: [6, 6, 6], windowCenter: 500, windowWidth: 1000,
  phase: { kind: 'timeSlot', value: String(slot), label: `Gate ${slot}/${slots}`, order: ((extra.interval ?? 1) - 1) * slots + slot, gate: { slot, slots, ...extra } },
});
const gates = Array.from({ length: 8 }, (_, index) => gate(index + 1, { slotTime: 120_000 - index * 1_000 }));

afterEach(() => setLocale('en'));

describe('a gated SPECT beside its summed reconstruction', () => {
  it('opens the SPECT/CT screen on the summed SPECT, though its gates come first', () => {
    const plan = match(BUILTIN_ARRANGEMENTS, 'screen', { series: [ct, ...gates, summed] })!;
    assert.equal(plan.arrangement.id, 'spect-ct');
    assert.deepEqual(plan.panes.map(pane => pane.series.id), ['ct', 'summed', 'ct', 'summed']);
    assert.equal(plan.panes[2].spec.over, 'spect');
  });
  it('opens it on the first gate when the study holds no summed SPECT', () => {
    const plan = match([SPECT_CT], 'screen', { series: [ct, ...gates] })!;
    assert.equal(plan.roles.spect.id, 'gate-1-1');
  });
  it('ranks a gate below any summed reconstruction, and leaves PET as it was', () => {
    assert.equal(ROLE_RANKS[0], 'ungated');
    assert.deepEqual(SPECT_CT.roles.spect.prefer, ['ungated', 'corrected', 'slices']);
    // A summed reconstruction without attenuation correction still comes before a corrected gate.
    const nac = { ...summed, id: 'summed-nac', description: 'SPECT NAC' };
    const corrected = { ...gates[0], description: 'Gated SPECT AC' };
    assert.equal(findRole(SPECT_CT.roles.spect, [corrected, nac], null)?.id, 'summed-nac');
    assert.equal(findRole(SPECT_CT.roles.spect, [corrected, nac, summed], null)?.id, 'summed');
    const pets = [series({ id: 'nac', modality: 'PT', description: 'PET NAC' }), series({ id: 'ac', modality: 'PT', description: 'PET AC' })];
    assert.equal(findRole(FUSION.roles.overlay, pets, ct)?.id, 'ac');
  });
  it('the fusion button finds the summed SPECT for a CT, and fuses a gate shown in the pane over its CT', () => {
    assert.equal(findRole(FUSION.roles.overlay, [...gates, summed], ct)?.id, 'summed');
    assert.equal(fusesAsOverlay(gates[3]), true);
    assert.equal(findRole(FUSION.roles.ct, [ct, ...gates, summed], gates[3])?.id, 'ct');
  });
  it('lists the gates in gate order after the series numbered before them', () => {
    const shuffled = [summed, gates[5], ct, gates[0], gates[7], gates[2], gates[1], gates[4], gates[6], gates[3]];
    assert.deepEqual(sortStudySeries(shuffled).map(item => item.id), ['ct', ...gates.map(item => item.id), 'summed']);
  });
});

describe('a gate named', () => {
  it('by its time slot and the time it counted, never as a delay after the R wave', () => {
    setLocale('en');
    assert.equal(phaseLabel(gates[2].phase!), 'Gate 3/8 · 118 s acquired');
    assert.equal(phaseLabel(gate(5, { slotTime: 41_234 }).phase!), 'Gate 5/8 · 41.2 s acquired');
    assert.equal(phaseLabel(gate(16, { slotTime: 950 }, 16).phase!), 'Gate 16/16 · 0.95 s acquired');
    assert.equal(phaseLabel(gate(1).phase!), 'Gate 1/8', 'without a Time Slot Time, by number only');
    setLocale('tr');
    assert.equal(phaseLabel(gates[2].phase!), 'Kapı 3/8 · 118 sn çekim');
    assert.equal(phaseLabel(gate(1).phase!), 'Kapı 1/8');
  });
  it('after its R-R window where the file holds several, with the beats that window took', () => {
    setLocale('en');
    const ectopic = gate(3, { interval: 2, intervals: 2, beats: [300, 640], slotTime: 2_500 }, 4);
    assert.equal(phaseLabel(ectopic.phase!), 'R-R 2 (300–640 ms) · Gate 3/4 · 2.5 s acquired');
    assert.equal(phaseLabel(gate(1, { interval: 1, intervals: 2 }, 4).phase!), 'R-R 1 · Gate 1/4');
    setLocale('tr');
    assert.equal(phaseLabel(ectopic.phase!), 'R-R 2 (300–640 ms) · Kapı 3/4 · 2.5 sn çekim');
  });
  it('as the engine labels other phases, where it is not a gate', () => {
    setLocale('tr');
    assert.equal(phaseLabel({ kind: 'triggerTime', value: '400', label: 'Phase 2 · 400 ms', order: 2 }), 'Phase 2 · 400 ms');
  });
  it('in the series list, the fusion menu and the image corner', () => {
    setLocale('en');
    assert.equal(seriesName(gates[2]), 'Gated SPECT · Gate 3/8 · 118 s acquired');
    assert.equal(seriesName(summed), 'SPECT');
    assert.equal(topRightLines(gates[2], true).at(-1)?.text, 'NM · Gate 3/8 · 118 s acquired');
    setLocale('tr');
    assert.equal(topRightLines(gates[2], true).at(-1)?.text, 'NM · Kapı 3/8 · 118 sn çekim');
  });
  it('found by a search in either language', () => {
    setLocale('tr');
    const text = searchText(gates[2], null);
    for (const query of ['kapi 3', 'gate 3', 'çekim']) assert.ok(text.includes(foldSearch(query)), query);
  });
});

describe('the gates of one gated file', () => {
  it('fuse over the CT on the scale they share, so a gate that counted less looks dimmer', () => {
    const counts = new Float32Array([0, 100, 200, 400, 800, 1600]);
    const half = counts.map(value => value / 2);
    // The engine gives every gate of a file one window (share_gate_windows): its top is where the colour scale tops out.
    assert.equal(petScale({ series: gates[0], data: counts }), 5 / 1000);
    assert.equal(petScale({ series: gates[1], data: half }), petScale({ series: gates[0], data: counts }));
    // A summed SPECT keeps its own high activity at the top.
    assert.equal(petScale({ series: summed, data: half }), 2 * petScale({ series: summed, data: counts }));
  });
  it('are exported whole, and the series list says so', () => {
    setLocale('en');
    assert.equal(exportedImages(gates[4]), 'NM · 256 images: all 8 gates of its file');
    assert.equal(exportedImages(gate(3, { interval: 2, intervals: 2 }, 4)), 'NM · 256 images: all 8 gates of its file');
    assert.equal(exportedImages(summed), 'NM · 32 images');
    setLocale('tr');
    assert.equal(exportedImages(gates[4]), 'NM · 256 görüntü: dosyasındaki 8 kapının tümü');
  });
});

describe('the SPECT/CT screen', () => {
  it('takes a SPECT that has a CT in its frame of reference before a better-ranked one that has none', () => {
    const elsewhere = { ...summed, id: 'elsewhere', frameOfReferenceUid: 'another frame' };
    const plan = match(BUILTIN_ARRANGEMENTS, 'screen', { series: [ct, ...gates, elsewhere] })!;
    assert.equal(plan.arrangement.id, 'spect-ct');
    assert.deepEqual(plan.panes.map(pane => pane.series.id), ['ct', 'gate-1-1', 'ct', 'gate-1-1']);
    // A summed SPECT in the CT's frame still comes first.
    assert.equal(match([SPECT_CT], 'screen', { series: [ct, ...gates, elsewhere, summed] })!.roles.spect.id, 'summed');
    // As does a PET with its CT, before a corrected PET with none.
    const pets = [series({ id: 'pet-elsewhere', modality: 'PT', description: 'PET AC', frameOfReferenceUid: 'another frame' }),
      series({ id: 'pet', modality: 'PT', description: 'PET NAC' })];
    assert.equal(match(BUILTIN_ARRANGEMENTS, 'screen', { series: [ct, ...pets] })?.roles.pet?.id, 'pet');
  });
});
