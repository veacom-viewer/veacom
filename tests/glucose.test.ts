import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertClose } from './support';
import type { Annotation, Series, Volume } from '../src/model';
import { glucoseInUnit, glucoseText, studyGlucose, sulGlu, sulGluGlucose, SULGLU_REFERENCE_MMOL, typedGlucoseMmol } from '../src/imaging/glucose';
import { fusedPetSummary, sphereSummary } from '../src/imaging/annotations';
import { formatSphereStatistics, type SphereStatistics } from '../src/imaging/voi';
import { petFlags, withTypedGlucose } from '../src/imaging/petAcquisition';
import { setLocale } from '../src/i18n';

// A uniform FDG PET in Bq/ml: 2 Bq/ml is SUVbw 2 and SUL 1.6 (SUL per SUVbw 0.8), shown in SUL.
const pet = (extra: Partial<Series> = {}): Series => ({ id: 'pet', uid: '1', studyUid: 's', patientId: 'P', patientName: 'SYNTHETIC', studyDate: '20000101',
  description: 'PET AC', modality: 'PT', seriesNumber: 2, dimensions: [9, 9, 9], spacing: [2, 2, 2], origin: [0, 0, 0], direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  windowCenter: 1, windowWidth: 2, valueUnit: 'Bq/ml', suvFactor: 1, sulFactor: 0.8, suvBsaFactor: 0.02, canReconstruct: true, warnings: [],
  photometricInterpretation: 'MONOCHROME2', spacingKnown: true, suvNormalization: 'lbm', petAcquisition: { tracer: 'Fludeoxyglucose F^18^', glucose: 5.4 }, ...extra });
const sphere: Annotation = { id: 'l1', type: 'sphere', label: 'L1', plane: 'axial', slice: 4, mode: 'mpr', points: [[8, 8, 8], [16, 8, 8]] };
const summary = (series: Series) => sphereSummary(sphere, { series, data: new Float32Array(9 ** 3).fill(2) } as Volume);

describe('SULglu', () => {
  it('is SUL × glucose / 5.0 mmol/l (EANM 2025, section 13): the same at 5.0, higher with a higher glucose', () => {
    assert.equal(SULGLU_REFERENCE_MMOL, 5);
    assertClose(sulGlu(5.59, { mmol: 5.4 }), 6.0372, 6);
    assert.equal(sulGlu(5.59, { mmol: 5 }), 5.59);
    assert.ok(sulGlu(5.59, { mmol: 8 }) > sulGlu(5.59, { mmol: 6 }));
  });

  it('is shown beside SUL, after SULpeak, labelled SULglu, and never SUV', () => {
    try {
      setLocale('en');
      const text = summary(pet());
      assert.match(text, /^SUL max 1\.60 · SULpeak 1\.60 · mean 1\.60 · SULglu max 1\.73, peak 1\.73/);
      assert.doesNotMatch(text, /SUVglu|SUV ?glu/);
      setLocale('tr');
      assert.match(summary(pet()), /^SUL maks 1,60 · SULpeak 1,60 · .*SULglu maks 1,73, tepe 1,73 · /);
    } finally { setLocale('en'); }
  });

  it('is not shown without a glucose, outside SUL, or for another tracer', () => {
    assert.doesNotMatch(summary(pet({ petAcquisition: { tracer: 'FDG' } })), /SULglu/);
    assert.doesNotMatch(summary(pet({ suvNormalization: 'bw' })), /SULglu/);
    assert.doesNotMatch(summary(pet({ suvNormalization: 'bsa' })), /SULglu/);
    assert.doesNotMatch(summary(pet({ petAcquisition: { tracer: 'Ga-68 PSMA-11', glucose: 5.4 } })), /SULglu/);
    // Without SUV calibration there is no SUL, so no SULglu either.
    assert.doesNotMatch(summary(pet({ suvFactor: null, sulFactor: null })), /SUL/);
    assert.equal(sulGluGlucose(pet(), 'SUVbw'), null);
    assert.equal(sulGluGlucose(pet({ petAcquisition: { tracer: 'FDG', glucose: 0 } }), 'SUL'), null);
    const stats = { unit: 'SUVbw', count: 1, mean: 2, max: 2, min: 2, standardDeviation: 0, maxAt: [0, 0, 0], volumeMl: 1, diameterMm: 12,
      peak: null, clipped: false, invalidCount: 0, paddingCount: 0 } as unknown as SphereStatistics;
    assert.doesNotMatch(formatSphereStatistics(stats, null, { mmol: 5.4, source: 'file' }), /SULglu/);
  });

  it('uses DICOM glucose first and a typed value only when it is missing', () => {
    assert.deepEqual(studyGlucose({ glucose: 5.4 }, undefined), { mmol: 5.4, source: 'file' });
    assert.deepEqual(studyGlucose({ glucose: 5.4 }, 6.2), { mmol: 5.4, source: 'file' });
    assert.deepEqual(studyGlucose({}, 6.2), { mmol: 6.2, source: 'typed' });
    assert.equal(studyGlucose({}, undefined), null);
    assert.match(summary(pet({ typedGlucose: 6, petAcquisition: { tracer: 'FDG' } })), /SULglu max 1\.92, peak 1\.92/);
    assert.match(fusedPetSummary(sphere, { series: pet(), data: new Float32Array(9 ** 3).fill(2) } as Volume),
      /PET SUL max 1.60.*SULglu max 1.73, peak 1.73/);
    assert.deepEqual(withTypedGlucose({ tracer: 'FDG', glucose: 5.4 }, 12), { tracer: 'FDG', glucose: 5.4 });
    // The typed value also reads in the acquisition panel's flags.
    assert.deepEqual(petFlags(withTypedGlucose({ tracer: 'FDG' }, 12), 'M').filter(flag => flag.startsWith('glucose')), ['glucoseHigh']);
  });
});

describe('a typed blood glucose', () => {
  it('reads in mmol/l or mg/dl, with a decimal point or comma, and only in the range a glucose can be', () => {
    assert.equal(typedGlucoseMmol('5,4', 'mmol'), 5.4);
    assertClose(typedGlucoseMmol('97', 'mgdl'), 97 / 18.0182, 9);
    for (const text of ['', ' ', 'abc', '0', '-1', 'Infinity', '0x20', '1e3']) assert.equal(typedGlucoseMmol(text, 'mmol'), null, text);
    for (const text of ['0', '-15']) assert.equal(typedGlucoseMmol(text, 'mgdl'), null, text);
  });

  it('shows in the unit it is typed in, and in both units in the panel', () => {
    assert.equal(glucoseInUnit(97 / 18.0182, 'mgdl'), '97');
    assert.equal(glucoseInUnit(5.994, 'mmol'), '5.99');
    assert.equal(glucoseText(5.4), '5.4 mmol/l (97 mg/dl)');
  });
});
