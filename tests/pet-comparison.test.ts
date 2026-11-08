import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PetAcquisition } from '../src/model';
import { compared, comparisonFlags, comparisonText, keptCompared, comparisonRows, REPEAT_UPTAKE_SECONDS, uptakeDifference, type PetPrior } from '../src/imaging/petComparison';
import { readPetStudies, priorRecord, storedAcquisition, withPetSeries, withStudyGlucose, type PetSeriesRecord } from '../src/domain/petStudies';
import { setLocale } from '../src/i18n';

// What tools/fixtures/make-pet-followup.mjs records: the current study 60 min after FDG on one scanner, with 5.4 mmol/l in
// its file; the prior 72 min after, on another scanner with another reconstruction, with no glucose.
const now: PetAcquisition = { tracer: 'Fludeoxyglucose F^18^', uptakeSeconds: 3600, scannerModel: 'SYNTHETIC PET 2', reconstruction: 'OSEM TOF PSF 4i5s', glucose: 5.4 };
const before: PetAcquisition = { tracer: 'Fludeoxyglucose F^18^', uptakeSeconds: 4320, scannerModel: 'SYNTHETIC PET 1', reconstruction: 'OSEM 3i24s' };
const flags = (current: PetAcquisition, prior: PetAcquisition, typed?: number) => comparisonFlags(compared(current), compared(prior, typed));
const same = { scannerModel: now.scannerModel, reconstruction: now.reconstruction };

describe('the uptake time of a repeat FDG study', () => {
  it('is flagged more than 10 min from the prior\'s, either way (EANM 2025, Supplemental File 3)', () => {
    assert.equal(REPEAT_UPTAKE_SECONDS, 600);
    for (const seconds of [3600, 3000, 4200, 3599.5, 4199.9]) assert.deepEqual(flags(now, { ...before, ...same, uptakeSeconds: seconds }), [], `${seconds} s`);
    for (const seconds of [2999, 4200.5, 4201, 4320, 7200]) assert.deepEqual(flags(now, { ...before, ...same, uptakeSeconds: seconds }), ['priorUptake'], `${seconds} s`);
  });

  it('uses five minutes only when the current acquisition covers the lesion region', () => {
    const base = compared(now);
    for (const seconds of [3300, 3900]) assert.deepEqual(comparisonFlags(base, { ...base, uptakeSeconds: seconds }, true), []);
    for (const seconds of [3299.9, 3900.1]) {
      const earlier = { ...base, uptakeSeconds: seconds };
      assert.deepEqual(comparisonFlags(base, earlier, false), []);
      assert.deepEqual(comparisonFlags(base, earlier, true), ['priorUptake']);
      assert.match(comparisonText('priorUptake', base, { date: '19991001', kept: false, acquisition: earlier }, true), /limit 5 min/);
    }
  });

  it('says the difference rounded up, so a flagged one never reads as 10 min', () => {
    assert.equal(uptakeDifference(compared(now), compared({ ...before, uptakeSeconds: 4200.4 })), 10.1);
    assert.equal(uptakeDifference(compared(now), compared(before)), 12);
  });

  it('is not checked for another tracer, or when either study gives no uptake time', () => {
    const psma = { ...now, tracer: 'Ga-68 PSMA-11' };
    assert.deepEqual(flags(psma, { ...before, ...same, tracer: 'Ga-68 PSMA-11' }), []);
    assert.deepEqual(flags(now, { ...before, ...same, uptakeSeconds: undefined }), []);
    assert.deepEqual(flags({ ...now, uptakeSeconds: undefined }, { ...before, ...same }), []);
  });
});

describe('the scanner and reconstruction of a repeat study', () => {
  it('are flagged when both studies record them and they differ, case and spacing aside', () => {
    assert.deepEqual(flags(now, before), ['priorUptake', 'priorScanner', 'priorReconstruction']);
    assert.deepEqual(flags(now, { ...before, uptakeSeconds: 3600, scannerModel: ' synthetic  pet 2 ', reconstruction: 'osem tof psf 4i5s' }), []);
  });

  it('are not flagged when either study records none', () => {
    assert.deepEqual(flags(now, { ...before, uptakeSeconds: 3600, scannerModel: '', reconstruction: undefined }), []);
    assert.deepEqual(flags({ ...now, scannerModel: undefined, reconstruction: ' ' }, { ...before, uptakeSeconds: 3600 }), []);
  });
});

describe('the prior\'s blood glucose', () => {
  it('is flagged at 11 mmol/l or above and below 4 mmol/l, typed or from its file (EANM 2025, section 9.4)', () => {
    const prior = { ...before, ...same, uptakeSeconds: 3600 };
    assert.deepEqual(flags(now, { ...prior, glucose: 11 }), ['priorGlucoseHigh', 'glucoseChange']);
    assert.deepEqual(flags(now, { ...prior, glucose: 3.9 }), ['priorGlucoseLow']);
    for (const glucose of [4, 7.2, 10.5]) assert.deepEqual(flags(now, { ...prior, glucose }), [], `${glucose} mmol/l`);
    assert.deepEqual(flags(now, { ...prior, glucose: 12 }, 6), ['priorGlucoseHigh', 'glucoseChange']);
    assert.deepEqual(flags(now, prior, 11.5), ['priorGlucoseHigh', 'glucoseChange']);
  });
});

it('flags a fasting glucose change strictly over 50% of the earlier value in either direction (UPICT §4.2.2)', () => {
  const previous = { ...now, glucose: 6 };
  for (const value of [3, 6, 9]) assert.deepEqual(flags({ ...now, glucose: value }, previous), []);
  for (const value of [2.99, 9.01]) assert.deepEqual(flags({ ...now, glucose: value }, previous), ['glucoseChange']);
  assert.deepEqual(flags({ ...now, glucose: 7.2 }, { ...now, glucose: 4.8 }), []);
  assert.deepEqual(flags({ ...now, glucose: undefined }, previous), []);
  assert.deepEqual(flags(now, { ...previous, glucose: undefined }), []);
  assert.deepEqual(flags({ ...now, tracer: 'PSMA', glucose: 10 }, { ...previous, tracer: 'PSMA' }), []);
  assert.deepEqual(flags({ ...now, glucose: 10 }, { ...previous, glucose: undefined }, 6), ['glucoseChange']);
});

describe('a prior kept on this computer', () => {
  it('is compared as a loaded one, from what was kept with its lesions and the glucose typed for its study', () => {
    const patient = 'd'.repeat(64), study = 'a'.repeat(64), series = 'b'.repeat(64);
    const record: PetSeriesRecord = { references: {}, tracer: 'fdg', sulPerBw: 0.8, acquisition: storedAcquisition(before),
      lesions: [{ id: 'l1', name: 'L1', center: [-80, -20, -76], radius: 20, values: { max: 10, mean: 4, peak: 10 } }] };
    let records = withPetSeries({}, study, series, record, 1, { patient, date: '19991001' });
    records = withStudyGlucose(records, study, 6, 2, { patient, date: '19991001' });
    const kept = priorRecord(readPetStudies(JSON.stringify(records)), patient, '20000101', 'fdg')!;
    const prior: PetPrior = { date: kept.date, kept: true, acquisition: keptCompared(kept.series, kept.glucose) };
    assert.deepEqual(prior.acquisition, compared(before, 6));
    assert.deepEqual(comparisonFlags(compared(now), prior.acquisition), ['priorUptake', 'priorScanner', 'priorReconstruction']);
    assert.deepEqual(comparisonRows(prior.acquisition), [
      { key: 'uptake', value: '72 min' }, { key: 'scanner', value: 'SYNTHETIC PET 1' }, { key: 'reconstruction', value: 'OSEM 3i24s' },
      { key: 'glucose', value: '6 mmol/l (108 mg/dl)', source: 'typed' }]);
  });

  it('says each flag with the prior\'s date, in either language', () => {
    const prior: PetPrior = { date: '19991001', kept: true, acquisition: compared({ ...before, glucose: 12 }) };
    try {
      setLocale('en');
      assert.equal(comparisonText('priorUptake', compared(now), prior), 'Uptake differs by 12 min from 01.10.1999. EANM limit 10 min.');
      assert.equal(comparisonText('priorScanner', compared(now), prior), 'Scanner model differs from 01.10.1999.');
      assert.equal(comparisonText('priorGlucoseHigh', compared(now), prior), 'Blood glucose on 01.10.1999 was 12 mmol/l: at 11 mmol/l or above (EANM 2025).');
      setLocale('tr');
      assert.equal(comparisonText('priorUptake', compared(now), prior), '01.10.1999 tarihli çekimle bekleme süresi farkı 12 dk. EANM sınırı 10 dk.');
      assert.equal(comparisonText('priorReconstruction', compared(now), prior), 'Rekonstrüksiyon 01.10.1999 tarihli çekimden farklı.');
    } finally { setLocale('en'); }
  });
});
