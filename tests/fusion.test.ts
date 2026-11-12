import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertClose, assertFields } from './support';
import { afterContrast, bestPartner, contrastPair, DEVICE_LOOKS, deviceMaker, draggedFusion, fusesOver, fusionScaleMaxKey, mrPartner, petAutoLevel, petHasSuv, petScale } from '../src/imaging/fusion';
import { en } from '../src/i18n/en';
import { tr } from '../src/i18n/tr';
import type { Series } from '../src/model';

const series = (overrides: Partial<Series> = {}): Series => ({
  id: 's', uid: 'u', studyUid: 'study', patientId: 'P', patientName: 'Synthetic', studyDate: '', description: '', modality: 'CT',
  seriesNumber: 1, dimensions: [4, 4, 100], spacing: [1, 1, 2.5], origin: [0, 0, 0], direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  windowCenter: 40, windowWidth: 400, valueUnit: 'HU', suvFactor: null, canReconstruct: true, warnings: [], photometricInterpretation: 'MONOCHROME2', ...overrides,
});

describe('MR over MR', () => {
  const mr = (id: string, description: string, extra: Partial<Series> = {}) => series({ id, description, modality: 'MR', valueUnit: '', windowCenter: 1000, windowWidth: 2000, ...extra });
  it('rejects a different patient or issuer even on the same frame of reference', () => {
    const base = series({ id: 'ct', patientKey: 'first-site', orientationKnown: true, frameOfReferenceUid: 'synthetic-frame' });
    const overlay = { ...base, id: 'pet', modality: 'PT' };
    assert.equal(fusesOver(base, overlay), true);
    assert.equal(fusesOver(base, { ...overlay, patientKey: 'second-site' }), false);
    assert.equal(fusesOver(base, { ...overlay, patientId: 'OTHER' }), false);
  });
  it('tells the series after contrast by its name', () => {
    for (const name of ['3D_AX_T1_postcontrast', 'T1 +C', 'T1 C+', 'T1 GAD', 'T1 kontrastlı', 't1_mprage_KM', 'KM T1']) assert.equal(afterContrast(mr('a', name)), true, name);
    for (const name of ['3D_AX_T1_precontrast', 'T1 aks', 'T2 TSE', 'kmeans', '517146096']) assert.equal(afterContrast(mr('a', name)), false, name);
  });
  it('orders a pair as after and before contrast: by name, else by series number', () => {
    const pre = mr('pre', 'T1 aks', { seriesNumber: 6 }), post = mr('post', 'T1 aks C+', { seriesNumber: 5 });
    assert.deepEqual(contrastPair(pre, post).map(item => item.id), ['post', 'pre']);
    const six = mr('six', '517146096', { seriesNumber: 6 }), seven = mr('seven', '517146096', { seriesNumber: 7 });
    assert.deepEqual(contrastPair(six, seven).map(item => item.id), ['seven', 'six']);
    assert.deepEqual(contrastPair(seven, six).map(item => item.id), ['seven', 'six']);
  });
  it('fuses with an MR of the same study beside it, the other side of contrast first', () => {
    const pre = mr('pre', 'T1 aks'), post = mr('post', 'T1 aks C+'), t2 = mr('t2', 'T2 aks'), other = mr('other', 'T1 C+', { studyUid: 'other' }), ct = series({ id: 'ct' });
    assert.equal(mrPartner(pre, [t2, post, other, ct], () => true)?.id, 'post');
    assert.equal(mrPartner(pre, [t2], () => true)?.id, 't2');
    assert.equal(mrPartner(pre, [post], () => false), null);
    assert.equal(mrPartner(pre, [other, ct], () => true), null);
  });
  it('puts an MR overlay\'s own window top at the top of the default scale', () => {
    const before = mr('pre', 'T1 aks', { windowCenter: 2237, windowWidth: 4474 });
    assertClose(petScale({ series: before, data: new Float32Array([1, 2, 3]) }) * 4474, 5);
  });
});

describe('PET/CT fusion as in VEAcom Next', () => {
  const ct = series({ id: 'ct' });
  const pet = (id: string, extra: Partial<Series> = {}) => series({ id, modality: 'PT', valueUnit: 'BQML', suvFactor: 0.001, dimensions: [4, 4, 50], spacing: [2, 2, 5], ...extra });
  it('finds the attenuation-corrected PET of the same study covering the CT', () => {
    const corrected = pet('ac', { description: 'PET AC' }), uncorrected = pet('nac', { description: 'PET NAC' });
    const short = pet('short', { description: 'PET AC kısa', dimensions: [4, 4, 10] }), other = pet('other', { studyUid: 'other' });
    assert.equal(bestPartner(ct, [uncorrected, short, corrected, other], 'PT', () => true)?.id, 'ac');
    assert.equal(bestPartner(ct, [uncorrected], 'PT', () => true)?.id, 'nac');
    assert.equal(bestPartner(ct, [corrected], 'PT', () => false), null);
    assert.equal(bestPartner(ct, [other], 'PT', () => true), null);
  });
  it('finds the CT acquired with a PET: as many slices as far apart', () => {
    const p = pet('p');
    const matching = series({ id: 'same-grid', dimensions: [4, 4, 50], spacing: [1, 1, 5] }), thin = series({ id: 'thin' });
    assert.equal(bestPartner(p, [thin, matching], 'CT', () => true)?.id, 'same-grid');
  });
  it('takes the look of the PET scanner: Siemens or GE', () => {
    assert.equal(deviceMaker(pet('a', { manufacturer: 'SIEMENS Healthineers' })), 'Siemens');
    assert.equal(deviceMaker(pet('b', { manufacturer: 'GE MEDICAL SYSTEMS' })), 'GE');
    assert.equal(deviceMaker(pet('c')), 'GE');
    assertFields(DEVICE_LOOKS.Siemens, { palette: 'hot_metal', opacity: 0.65, upperSuv: 5, ctWindow: [250, 10] });
    assertFields(DEVICE_LOOKS.GE, { palette: 'ge', opacity: 0.5, upperSuv: 10, ctWindow: [400, 40] });
  });
  it('sets the scale with Ctrl + drag: doubles every 120 px across, opacity over 250 px up', () => {
    assert.deepEqual(draggedFusion({ upperSuv: 5, opacity: 0.5 }, 120, -125), { upperSuv: 10, opacity: 1 });
    assert.deepEqual(draggedFusion({ upperSuv: 5, opacity: 0.5 }, -240, 50), { upperSuv: 1.25, opacity: 0.3 });
    assert.deepEqual(draggedFusion({ upperSuv: 5, opacity: 0.5 }, 2000, 1000), { upperSuv: 60, opacity: 0.1 });
  });
  it('scales a PET without SUV by its own high activity, as SUV 5', () => {
    const values = new Float32Array(1000).map((_, i) => i);
    assertClose(petAutoLevel(values), 994.0, 0);
    const raw = series({ modality: 'PT', valueUnit: 'BQML', suvFactor: null });
    assert.equal(petHasSuv(raw), false);
    assertClose(petScale({ series: raw, data: values }) * petAutoLevel(values), 5);
    assert.equal(petScale({ series: pet('x'), data: values }), 0.001);
    assert.equal(petScale({ series: series({ modality: 'PT', valueUnit: 'SUVbw', suvFactor: 1 }), data: values }), 1);
  });
  it('reads a PET in SUV only with the engine\'s SUV factor, whatever its file\'s unit says', () => {
    // Units GML: values stored as SUV, which the engine gives an SUV factor of 1 (native/src/ingest.rs, suv_factor).
    // Not corrected for attenuation, the same file gets no factor: its unit still says SUVbw, but it has no SUV.
    const values = new Float32Array(1000).map((_, i) => i / 100);
    const gml = series({ modality: 'PT', valueUnit: 'SUVbw', suvFactor: 1 }), refused = { ...gml, suvFactor: null };
    assert.equal(petHasSuv(gml), true);
    assert.equal(petScale({ series: gml, data: values }), 1);
    for (const unit of ['SUVbw', 'SUVlbm', 'SUVbsa', 'SUV']) assert.equal(petHasSuv({ ...refused, valueUnit: unit }), false, unit);
    assertClose(petScale({ series: refused, data: values }) * petAutoLevel(values), 5);
    assert.equal(fusionScaleMaxKey(refused), 'fusion.scaleMax');
  });
  it('calls the top of the scale SUV only for a PET that has SUV', () => {
    assert.equal(fusionScaleMaxKey(series({ modality: 'PT', valueUnit: 'BQML', suvFactor: null })), 'fusion.scaleMax');
    assert.equal(fusionScaleMaxKey(pet('factor')), 'fusion.suvMax');
    assert.equal(fusionScaleMaxKey(series({ modality: 'PT', valueUnit: 'SUVbw', suvFactor: 1 })), 'fusion.suvMax');
    assert.equal(fusionScaleMaxKey(series({ modality: 'PT', valueUnit: 'SUVbw', suvFactor: null })), 'fusion.scaleMax');
    assert.equal(fusionScaleMaxKey(undefined), 'fusion.suvMax');
    for (const words of [en, tr]) assert.doesNotMatch(words['fusion.scaleMax'], /SUV/i);
  });
});
