import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PetAcquisition, Series } from '../src/model';
import { FDG_GLUCOSE_MMOL, FDG_UPTAKE_MINUTES, flagText, isFdg, panelPet, petFlags, petRows, superscripts } from '../src/imaging/petAcquisition';
import { setLocale } from '../src/i18n';

// What tools/fixtures/make-petct-study.mjs records: FDG, 200 MBq at 11:00, the scan from 12:00, 70 kg, 1.75 m, 5.4 mmol/l.
const complete: PetAcquisition = {
  tracer: 'Fludeoxyglucose F^18^', tracerCode: 'C-B1031', tracerCodeMeaning: 'Fluorodeoxyglucose F^18^', radionuclide: '^18^Fluorine',
  injectedActivity: 200e6, halfLife: 6586.2, injectionDateTime: '20000101110000', injectionTime: '110000',
  scanStart: '20000101120000', uptakeSeconds: 3600, weight: 70, height: 1.75, glucose: 5.4, decayCorrection: 'ADMIN',
};
const uptake = (minutes: number, pet: PetAcquisition = complete) => petFlags({ ...pet, uptakeSeconds: minutes * 60 }, 'M');
const glucose = (mmol: number, pet: PetAcquisition = complete) => petFlags({ ...pet, glucose: mmol }, 'F');

describe('the FDG uptake time', () => {
  it('is flagged outside EANM 2025’s 55–75 min (as in 2015)', () => {
    assert.deepEqual(FDG_UPTAKE_MINUTES, { from: 55, to: 75 });
    for (const minutes of [55, 60, 75]) assert.deepEqual(uptake(minutes), [], `${minutes} min`);
    for (const minutes of [30, 50, 54.4, 54.6, 75.4, 75.6, 80, 120]) assert.deepEqual(uptake(minutes), ['uptakeRange'], `${minutes} min`);
  });

  it('is flagged for FDG only', () => {
    const other = { ...complete, tracer: 'Fluorothymidine F^18^', tracerCode: '', tracerCodeMeaning: '' };
    assert.equal(isFdg(other), false);
    assert.deepEqual(uptake(90, other), []);
    assert.deepEqual(uptake(90, { ...complete, tracer: '', tracerCode: '', tracerCodeMeaning: '' }), []);
    // FDG by its code alone, or by any of its names.
    for (const pet of [{ tracerCode: '35321007', tracerCodeScheme: 'SCT' }, { tracer: '18F-FDG' }, { tracer: '[18F]FDG' }, { tracerCodeMeaning: '2-fluoro-2-deoxy-D-glucose' }, { tracer: 'FLUDEOXYGLUCOSE' }])
      assert.equal(isFdg(pet), true, JSON.stringify(pet));
    for (const pet of [{ tracer: 'Fluciclovine' }, { tracer: 'FDGal' }, { tracer: 'Ga-68 PSMA-11' }, {}]) assert.equal(isFdg(pet), false, JSON.stringify(pet));
  });

  it('says how long it was and the guideline’s range, in either language', () => {
    assert.equal(flagText('uptakeRange', { ...complete, uptakeSeconds: 82 * 60 }), 'FDG uptake time 82 min: outside 55–75 min (EANM 2025)');
    setLocale('tr');
    try { assert.equal(flagText('uptakeRange', { ...complete, uptakeSeconds: 82 * 60 }), 'FDG bekleme süresi 82 dk: 55–75 dk aralığının dışında (EANM 2025)'); }
    finally { setLocale('en'); }
  });
});

describe('blood glucose before FDG', () => {
  it('is flagged at 11 mmol/l or above and below 4 mmol/l, as EANM 2025 has it, before display rounding', () => {
    assert.deepEqual(FDG_GLUCOSE_MMOL, { low: 4, high: 11 });
    for (const mmol of [4, 5.4, 10.9, 10.94, 10.96]) assert.deepEqual(glucose(mmol), [], `${mmol} mmol/l`);
    for (const mmol of [11, 16.2]) assert.deepEqual(glucose(mmol), ['glucoseHigh'], `${mmol} mmol/l`);
    for (const mmol of [2.8, 3.94, 3.96]) assert.deepEqual(glucose(mmol), ['glucoseLow'], `${mmol} mmol/l`);
    // Not for other tracers, and nothing when the file records no glucose (most do not).
    assert.deepEqual(glucose(16.2, { ...complete, tracer: 'Ga-68 PSMA-11', tracerCode: '', tracerCodeMeaning: '' }), []);
    assert.deepEqual(petFlags({ ...complete, glucose: undefined }, 'M'), []);
  });

  it('says the value and the limit, in either language', () => {
    assert.equal(flagText('glucoseHigh', { ...complete, glucose: 12.34 }), 'Blood glucose 12.34 mmol/l: at 11 mmol/l or above, EANM 2025 advises rescheduling FDG');
    assert.equal(flagText('glucoseLow', { ...complete, glucose: 3.1 }), 'Blood glucose 3.1 mmol/l: below 4 mmol/l (EANM 2025)');
    setLocale('tr');
    try { assert.equal(flagText('glucoseHigh', { ...complete, glucose: 12.34 }), 'Kan şekeri 12.34 mmol/l: 11 mmol/l ve üzerinde EANM 2025 FDG çekiminin ertelenmesini önerir'); }
    finally { setLocale('en'); }
  });
});

describe('the PET acquisition panel', () => {
  it('shows the tracer, injection, uptake time and patient', () => {
    assert.deepEqual(Object.fromEntries(petRows(complete).map(row => [row.key, row.value])), {
      tracer: 'Fludeoxyglucose F¹⁸', activity: '200 MBq (5.41 mCi)', injection: '11:00', scanStart: '12:00', uptake: '60 min',
      weight: '70 kg', height: '1.75 m', glucose: '5.4 mmol/l (97 mg/dl)', scanner: null, reconstruction: null,
    });
    const recorded = Object.fromEntries(petRows({ ...complete, scannerModel: ' Biograph Vision 600 ', reconstruction: 'OSEM3D 4i5s' }).map(row => [row.key, row.value]));
    assert.deepEqual([recorded.scanner, recorded.reconstruction], ['Biograph Vision 600', 'OSEM3D 4i5s']);
    assert.deepEqual(petFlags(complete, 'M'), []);
    assert.equal(superscripts('^18^F and ^68^Ga'), '¹⁸F and ⁶⁸Ga');
  });

  it('gives the dates when the injection and the scan fall on different days', () => {
    const rows = petRows({ ...complete, injectionDateTime: '20000101235000', injectionTime: '235000', scanStart: '20000102005000' });
    assert.equal(rows.find(row => row.key === 'injection')?.value, '01.01.2000 23:50');
    assert.equal(rows.find(row => row.key === 'scanStart')?.value, '02.01.2000 00:50');
    assert.equal(petRows({ ...complete, injectionDateTime: '' }).find(row => row.key === 'injection')?.value, '11:00');
  });

  it('labels offsets on both clocks and explains ambiguous administrations', () => {
    const rows = Object.fromEntries(petRows({ injectionDateTime: '20240101100000+0000', scanStart: '20240101120000+0100' }).map(row => [row.key, row.value]));
    assert.equal(rows.injection, '10:00 UTC+00:00');
    assert.equal(rows.scanStart, '12:00 UTC+01:00');
    assert.deepEqual(petFlags({ ...complete, multipleAdministrations: true, injectedActivity: undefined, injectionDateTime: undefined, injectionTime: undefined }, 'M'), ['multipleAdministrations']);
    assert.equal(isFdg({ tracerCode: '35321007', tracerCodeScheme: '99LOCAL' }), false);
  });

  it('flags a missing weight, activity, injection time or scan start', () => {
    assert.deepEqual(petFlags({ ...complete, weight: undefined }, 'M'), ['weight']);
    assert.deepEqual(petFlags({ ...complete, injectedActivity: undefined }, 'M'), ['activity']);
    assert.deepEqual(petFlags({ ...complete, injectionDateTime: undefined, injectionTime: undefined, uptakeSeconds: undefined }, 'M'), ['injectionTime']);
    assert.deepEqual(petFlags({ ...complete, scanStart: undefined, uptakeSeconds: undefined }, 'M'), ['scanStart']);
    // Both times there, yet no uptake time: the injection is not before the scan, or a time cannot be read.
    assert.deepEqual(petFlags({ ...complete, uptakeSeconds: undefined }, 'M'), ['uptakeUnknown']);
    assert.deepEqual(petFlags({}), ['weight', 'height', 'sex', 'activity', 'injectionTime', 'scanStart']);
    const rows = petRows({});
    assert.deepEqual(rows.map(row => row.key), ['tracer', 'activity', 'injection', 'scanStart', 'uptake', 'weight', 'height', 'glucose', 'scanner', 'reconstruction']);
    assert.equal(rows.every(row => row.value === null), true);
    assert.equal(flagText('weight', {}), 'Patient weight not recorded');
  });

  it('flags what SUL needs: a height in metres and a male or female sex', () => {
    assert.deepEqual(petFlags({ ...complete, height: undefined }, 'F'), ['height']);
    // Centimetres (or any value outside 0.3–2.5 m) are not taken for metres, by the engine or here.
    assert.deepEqual(petFlags({ ...complete, height: 175 }, 'F'), ['heightUnit']);
    assert.equal(flagText('heightUnit', { ...complete, height: 175 }), 'Height 175 m is not a height in metres: no SUL or SUVbsa');
    for (const sex of [undefined, '', 'O', ' f ']) assert.deepEqual(petFlags(complete, sex), sex === ' f ' ? [] : ['sex'], JSON.stringify(sex));
  });

  it('shows the active PET, or the PET fused in the active series’ study', () => {
    const pet = { id: 'pet', modality: 'PT', studyUid: 'a' } as Series, ct = { id: 'ct', modality: 'CT', studyUid: 'a' } as Series;
    assert.equal(panelPet(pet, null), pet);
    assert.equal(panelPet(ct, pet), pet);
    assert.equal(panelPet({ ...ct, studyUid: 'b' }, pet), null);
    assert.equal(panelPet(ct, null), null);
    assert.equal(panelPet(null, pet), null);
  });
});
