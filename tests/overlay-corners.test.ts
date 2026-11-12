import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { assertFields } from './support';
import { setLocale } from '../src/i18n';
import { ageText, dicomDate, dicomTime, general, scannerLines, sliceDetail, topLeftLines, topRightLines } from '../src/ui/overlayCorners';
import { overlayKeepOut } from '../src/ui/labelPlacement';
import { fusionLine } from '../src/ui/seriesNames';
import type { Series } from '../src/model';

const series = (overrides: Partial<Series> = {}): Series => ({
  id: 's', uid: 'u', studyUid: 'study', patientId: 'P', patientName: 'Sentetik^Hasta', studyDate: '20240305', description: 'T1 aks', modality: 'MR',
  seriesNumber: 1, dimensions: [4, 4, 2], spacing: [1, 1, 1], origin: [0, 0, 0], direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  windowCenter: 40, windowWidth: 400, valueUnit: '', suvFactor: null, canReconstruct: true, warnings: [], photometricInterpretation: 'MONOCHROME2',
  patientAgeText: '045Y', patientSex: 'F', patientBirthDate: '19790102', studyTime: '101530.25', studyDescription: 'Beyin MR',
  institutionName: 'Deneme Hastanesi', magneticFieldStrength: 1.5, repetitionTime: 500, echoTime: 14.999999999, ...overrides,
});

afterEach(() => setLocale('tr'));

describe('image corner texts', () => {
  it('formats stored dates, times and ages', () => {
    setLocale('tr');
    assert.equal(dicomDate('20240305'), '05.03.2024');
    assert.equal(dicomDate('2024'), '2024');
    assert.equal(dicomTime('101530.25'), '10:15');
    assert.equal(dicomTime('10'), '');
    assert.equal(ageText('045Y'), '45y');
    assert.equal(ageText('006M'), '6 ay');
    assert.equal(ageText('3W'), '3 hf');
    assert.equal(ageText('45'), '');
    assert.equal(general(14.999999999), '15');
    assert.equal(general(1.5), '1.5');
  });
  it('puts who and when top left, and only age and sex with patient data hidden', () => {
    setLocale('tr');
    assert.deepEqual(topLeftLines(series(), false).map(line => line.text), ['Sentetik Hasta (45y K)', 'DOB: 02.01.1979', 'Çekim Tarihi: 05.03.2024 10:15']);
    assert.equal(topLeftLines(series(), false)[2].short, '05.03.2024 10:15');
    assert.deepEqual(topLeftLines(series(), true), [{ text: '45y K' }]);
    assert.deepEqual(topLeftLines(series({ patientAgeText: undefined, patientSex: '' }), true), []);
    assert.deepEqual(topLeftLines(series({ studyTime: undefined, patientBirthDate: undefined }), false).map(line => line.text), ['Sentetik Hasta (45y K)', 'Çekim Tarihi: 05.03.2024']);
    // The protocol number right under the name; it names the patient, so it goes with patient data hidden.
    const numbered = topLeftLines(series({ accessionNumber: 'LHK000000001' }), false);
    assert.deepEqual(numbered.map(line => line.text), ['Sentetik Hasta (45y K)', 'Protokol No: LHK000000001', 'DOB: 02.01.1979', 'Çekim Tarihi: 05.03.2024 10:15']);
    assertFields(numbered[1], { short: 'LHK000000001', identity: true });
    assert.deepEqual(topLeftLines(series({ accessionNumber: 'LHK000000001' }), true), [{ text: '45y K' }]);
  });
  it('puts the institution and descriptions top right, once each, above the modality', () => {
    assert.deepEqual(topRightLines(series(), false).map(line => line.text), ['Deneme Hastanesi', 'Beyin MR', 'T1 aks', 'MR']);
    assert.deepEqual(topRightLines(series({ studyDescription: 'T1 aks' }), false).map(line => line.text), ['Deneme Hastanesi', 'T1 aks', 'MR']);
    assert.deepEqual(topRightLines(series(), true).map(line => line.text), ['MR']);
  });
  it('names a fused series by its description, and with patient data hidden by its modality, as top right does', () => {
    const pet = series({ modality: 'PT', description: 'WB AC' }), spect = series({ modality: 'NM', description: 'SPECT Bq/ml' });
    assert.equal(fusionLine(pet, false), 'PET: WB AC');
    assert.equal(fusionLine(pet, true), 'PET');
    assert.equal(fusionLine(spect, false), 'Füzyon: SPECT Bq/ml');
    assert.equal(fusionLine(spect, true), 'Füzyon: NM');
    // The phase stays: it tells one of several series apart and names no one.
    const delayed = series({ modality: 'PT', description: 'WB AC 2 h', phase: { kind: 'time', value: '2', label: '2 h', order: 2 } });
    assert.equal(fusionLine(delayed, true), 'PET: 2 h');
    setLocale('en');
    assert.equal(fusionLine(spect, true), 'Fusion: NM');
  });
  it('gives MR field strength and timings, nothing for CT', () => {
    assert.deepEqual(scannerLines(series()), ['FS: 1.5', 'TR: 500 TE: 15']);
    assert.deepEqual(scannerLines(series({ magneticFieldStrength: undefined, echoTime: undefined })), ['TR: 500']);
    assert.deepEqual(scannerLines(series({ modality: 'CT' })), []);
  });
  it('writes the slice thickness and location in mm', () => {
    setLocale('tr');
    assert.equal(sliceDetail(5, -12.34), 'T: 5.0 mm  Loc: -12.3 mm');
    assert.equal(sliceDetail(undefined, 0), 'Loc: 0.0 mm');
    assert.equal(sliceDetail(undefined, null), '');
    setLocale('en');
    assert.equal(sliceDetail(2.5, null), 'T: 2.5 mm');
  });
  it('keeps labels away from every corner line', () => {
    const boxes = overlayKeepOut(400, 300, 182, { topLeft: 3, topRight: 4, bottomLeft: 3, bottomRight: 2 });
    assert.equal(boxes[4].height, 56);
    assert.equal(boxes[5].height, 72);
    assertFields(boxes[6], { y: 242, height: 58 });
    assertFields(boxes[8], { x: 204, y: 226, height: 32 });
    assert.equal(overlayKeepOut(400, 300, 182).length, 8);
  });
});
