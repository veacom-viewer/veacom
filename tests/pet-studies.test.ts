import { petStorageKeys, previousMeasurements, reconstructedSeriesDigest, keptAnnotations, mergeRestored, seriesRecord } from '../src/imaging/usePetStudies';
import { sphereOf } from '../src/imaging/voi';
import type { Annotation, Series, Volume } from '../src/model';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { patientDigest, priorRecord, readPetStudies, sameSeriesRecord, storedAcquisition, uidDigest, withPetSeries, withStudyGlucose, type PetSeriesRecord } from '../src/domain/petStudies';

const study = 'a'.repeat(64), series = 'b'.repeat(64), other = 'c'.repeat(64);
const liver: PetSeriesRecord = { references: { liver: { center: [-80, -10, -218], radius: 15 } } };

describe('PET study records kept on this computer', () => {
  it('know studies and series only by a SHA-256 digest of their UIDs', async () => {
    assert.equal(await uidDigest('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.deepEqual(readPetStudies(JSON.stringify({ '1.2.840.113619.2.55': { savedAt: 1, series: { [series]: liver } } })), {});
    assert.deepEqual(readPetStudies(JSON.stringify({ [study]: { savedAt: 1, series: { '1.2.3': liver } } })), {});
  });

  it('finds only the matching pre-upgrade reconstruction or UID-only record for manual recovery', async () => {
    const pet = { id: 'new-reconstruction', previousPetId: 'old-reconstruction', uid: '1.2.3.4', studyUid: '1.2.3',
      patientId: 'patient', patientName: 'Synthetic', patientKey: 'a'.repeat(64), studyDate: '20000101' } as Series;
    const key = await petStorageKeys(pet);
    const oldPatient = await uidDigest('patient\u0000SYNTHETIC'), oldStudy = await uidDigest(pet.studyUid);
    const oldSeries = await reconstructedSeriesDigest({ uid: pet.uid, id: pet.previousPetId! });
    const legacy = withPetSeries({}, oldStudy, oldSeries, liver, 1, { patient: oldPatient, date: pet.studyDate });
    assert.ok(!legacy[key.study], 'no automatic restore under the issuer-aware key');
    assert.deepEqual(previousMeasurements(legacy, key), { study: oldStudy, series: oldSeries });
    assert.equal(previousMeasurements(legacy, await petStorageKeys({ ...pet, previousPetId: 'other-phase' })), undefined);
    assert.equal(previousMeasurements(legacy, await petStorageKeys({ ...pet, patientName: 'Other' })), undefined);
    assert.equal(previousMeasurements(legacy, await petStorageKeys({ ...pet, studyDate: '20010101' })), undefined);
    const uid = await uidDigest(pet.uid);
    assert.deepEqual(previousMeasurements(withPetSeries({}, oldStudy, uid, liver, 0), key), { study: oldStudy, series: uid });
  });

  it('stores each reconstructed phase separately and restores a 30 mm liver reference', async () => {
    const first = await reconstructedSeriesDigest({ uid: '1.2.3', id: 'phase-a' });
    const second = await reconstructedSeriesDigest({ uid: '1.2.3', id: 'phase-b' });
    assert.notEqual(first, second);
    assert.notEqual(first, await uidDigest('1.2.3'));
    let records = withPetSeries({}, study, first, liver, 1);
    const next: PetSeriesRecord = { references: { liver: { center: [20, 30, 40], radius: 23 } } };
    records = withPetSeries(records, study, second, next, 2);
    assert.deepEqual(records[study].series[first], liver);
    const [restored] = keptAnnotations(records[study].series[second], {} as Series);
    assert.deepEqual(sphereOf(restored), { center: [20, 30, 40], radius: 15 });
  });

  it('read back what was written and drop anything malformed', () => {
    const records = withPetSeries({}, study, series, { references: { ...liver.references, bloodPool: { center: [0, -20, -150], radius: 5 } } }, 10);
    assert.deepEqual(readPetStudies(JSON.stringify(records)), records);
    assert.deepEqual(readPetStudies('not json'), {});
    assert.deepEqual(readPetStudies('[1, 2]'), {});
    const broken = { [study]: { savedAt: 1, series: { [series]: { references: { liver: { center: [0, 0], radius: 15 }, bloodPool: { center: [0, 0, 0], radius: -1 }, spleen: { center: [0, 0, 0], radius: 5 } } } } } };
    assert.deepEqual(readPetStudies(JSON.stringify(broken)), {});
    const half = { [study]: { savedAt: 1, series: { [series]: { references: { liver: { center: [0, 0, 0], radius: 15 }, bloodPool: { center: [0, 0, 'x'], radius: 5 } } } } } };
    assert.deepEqual(readPetStudies(JSON.stringify(half)), { [study]: { savedAt: 1, series: { [series]: { references: { liver: { center: [0, 0, 0], radius: 15 } } } } } });
  });

  it('remove a series that holds nothing, and a study with no series left', () => {
    let records = withPetSeries({}, study, series, liver, 1);
    records = withPetSeries(records, study, other, liver, 2);
    assert.deepEqual(Object.keys(records[study].series), [series, other]);
    records = withPetSeries(records, study, series, { references: {} }, 3);
    assert.deepEqual(Object.keys(records[study].series), [other]);
    assert.deepEqual(withPetSeries(records, study, other, null, 4), {});
  });

  it('keep the studies saved most recently when there are too many', () => {
    let records = {};
    for (let n = 0; n < 5; n++) records = withPetSeries(records, n.toString(16).repeat(64), series, liver, n, {}, 3);
    assert.deepEqual(Object.keys(records).sort(), ['2', '3', '4'].map(n => n.repeat(64)));
  });

  it('compare records by their spheres', () => {
    assert.equal(sameSeriesRecord(liver, { references: { liver: { center: [-80, -10, -218], radius: 15 } } }), true);
    assert.equal(sameSeriesRecord(liver, { references: { liver: { center: [-80, -10, -218], radius: 14 } } }), false);
    assert.equal(sameSeriesRecord(liver, null), false);
    assert.equal(sameSeriesRecord({ references: {} }, undefined), true);
  });
});

describe('the lesion table kept with a study', () => {
  const lesions: PetSeriesRecord = { references: {}, tracer: 'fdg', sulPerBw: 1.25,
    lesions: [{ name: 'L1', center: [-80, -20, -100], radius: 20, threshold: 'max41', fdgLymphoma: true, deauvilleBasis: 'test-basis', deauville: 5, values: { max: 7, mean: 3.2, peak: 7, mtv: 14.1, tlg: 98.7 } }] };

  it('reads back lesions with their names, thresholds, scores and values, and drops what is malformed', () => {
    const records = withPetSeries({}, study, series, lesions, 1, { patient: other, date: '20000101' });
    assert.deepEqual(readPetStudies(JSON.stringify(records)), records);
    const broken = { [study]: { savedAt: 1, patient: 'Jane Doe', date: '1.1.2000', series: { [series]: { references: {}, sulPerBw: -1,
      lesions: [{ name: '', center: [0, 0, 0], radius: 5 }, { name: 'L2', center: [0, 0, 0], radius: 5, threshold: 'max50', deauville: 7, values: { max: 'high' } }] } } } };
    assert.deepEqual(readPetStudies(JSON.stringify(broken)), { [study]: { savedAt: 1, series: { [series]: { references: {}, lesions: [{ name: 'L2', center: [0, 0, 0], radius: 5 }] } } } });
  });

  it('reads a record kept before lesions were, as it was', () => {
    const kept = { [study]: { savedAt: 1, series: { [series]: liver } } };
    assert.deepEqual(readPetStudies(JSON.stringify(kept)), kept);
  });

  it('finds the patient\'s most recent earlier study with lesions', () => {
    const patient = 'd'.repeat(64);
    let records = withPetSeries({}, '1'.repeat(64), series, lesions, 1, { patient, date: '19990101' });
    records = withPetSeries(records, '2'.repeat(64), series, { ...lesions, sulPerBw: 1.3 }, 2, { patient, date: '19991001' });
    records = withPetSeries(records, '3'.repeat(64), series, liver, 3, { patient, date: '19991101' });
    records = withPetSeries(records, '4'.repeat(64), series, lesions, 4, { patient: 'e'.repeat(64), date: '19991201' });
    records = withPetSeries(records, '5'.repeat(64), series, lesions, 5, { patient, date: '20000101' });
    assert.deepEqual(priorRecord(records, patient, '20000101', 'fdg'), { date: '19991001', series: { ...lesions, sulPerBw: 1.3 } });
    assert.equal(priorRecord(records, patient, '19990101', 'fdg'), null);
  });

  it('uses an unmarked prior for acquisition QC without displacing a measured lesion comparison', () => {
    const acquisition = { references: {}, tracer: 'fdg', acquisition: { uptakeSeconds: 3600 } };
    let records = withPetSeries({}, study, series, lesions, 1, { patient: other, date: '19990101' });
    records = withPetSeries(records, '1'.repeat(64), series, acquisition, 2, { patient: other, date: '19991001' });
    assert.equal(priorRecord(records, other, '20000101', 'fdg')?.date, '19991001');
    assert.equal(priorRecord(records, other, '20000101', 'fdg', true)?.date, '19990101');
    records = withPetSeries(records, study, '2'.repeat(64), lesions, 3);
    assert.equal(priorRecord(records, other, '20000101', 'fdg', true), null, 'Ambiguous measured reconstructions need an open prior.');
  });

  it('keeps what a later study is compared on beside the lesions, from the files, and drops what is malformed', () => {
    const pet = { id: 'pet', uid: '1', modality: 'PT', dimensions: [9, 9, 9], spacing: [2, 2, 2], direction: [1, 0, 0, 0, 1, 0, 0, 0, 1], origin: [0, 0, 0],
      canReconstruct: true, spacingKnown: true, valueUnit: 'SUVbw', suvFactor: 1,
      petAcquisition: { tracer: 'FDG', uptakeSeconds: 4320, scannerModel: ' Synthetic PET 1 ', reconstruction: 'OSEM 3i24s', glucose: 5.4, weight: 70 } } as Series;
    const volume: Volume = { series: pet, data: new Float32Array(9 ** 3).fill(2) };
    const drawn: Annotation[] = [{ type: 'sphere', id: 'l1', label: 'L1', slice: 4, plane: 'axial', mode: 'mpr', points: [[8, 8, 8], [12, 8, 8]] }];
    const record = seriesRecord(drawn, pet, volume)!;
    // Only what is compared: no weight, height or times of day.
    assert.deepEqual(record.acquisition, { uptakeSeconds: 4320, scannerModel: 'Synthetic PET 1', reconstruction: 'OSEM 3i24s', glucose: 5.4 });
    const records = withPetSeries({}, study, series, record, 1, { patient: other, date: '19991001' });
    assert.deepEqual(readPetStudies(JSON.stringify(records))[study].series[series].acquisition, record.acquisition);
    // The uptake record survives without a drawn lesion, including a zero-second interval.
    const unmarked = seriesRecord([], pet, undefined)!;
    assert.deepEqual(unmarked.acquisition, record.acquisition);
    const earlier = withPetSeries({}, study, series, { ...unmarked, limitedView: true }, 1, { patient: other, date: '19991001' });
    assert.deepEqual(priorRecord(readPetStudies(JSON.stringify(earlier)), other, '20000101', 'fdg')?.series, { ...unmarked, limitedView: true });
    assert.deepEqual(storedAcquisition({ uptakeSeconds: 0 }), { uptakeSeconds: 0 });
    // Malformed parts are dropped, the rest kept.
    const broken = { ...record, acquisition: { uptakeSeconds: -60, scannerModel: 42, reconstruction: 'OSEM\u0000', glucose: 6.1 } };
    assert.deepEqual(readPetStudies(JSON.stringify(withPetSeries({}, study, series, broken as unknown as PetSeriesRecord, 1)))[study].series[series].acquisition, { glucose: 6.1 });
    assert.equal(storedAcquisition({ tracer: 'FDG' }), undefined);
    // A changed acquisition is a changed record, so it is saved.
    assert.equal(sameSeriesRecord(record, { ...record, acquisition: { ...record.acquisition, uptakeSeconds: 3600 } }), false);
  });

  it('keeps the glucose typed for a study, with or without its series, and gives it back with the prior', () => {
    const patient = 'd'.repeat(64);
    let records = withStudyGlucose({}, study, 6, 1, { patient, date: '19991001' });
    assert.deepEqual(records, { [study]: { savedAt: 1, series: {}, patient, date: '19991001', glucose: 6 } });
    assert.deepEqual(readPetStudies(JSON.stringify(records)), records);
    // Saving the study's lesions keeps it, and the prior comes back with it.
    records = withPetSeries(records, study, series, lesions, 2, { patient, date: '19991001' });
    assert.equal(records[study].glucose, 6);
    assert.deepEqual(priorRecord(records, patient, '20000101', 'fdg'), { date: '19991001', series: lesions, glucose: 6 });
    // Removing the lesions keeps the glucose; clearing the glucose too removes the study.
    records = withPetSeries(records, study, series, null, 3);
    assert.deepEqual(records[study].series, {});
    assert.deepEqual(withStudyGlucose(records, study, null, 4), {});
    // Only positive, finite glucose values are kept.
    assert.deepEqual(withStudyGlucose({}, study, -1, 1), {});
    assert.deepEqual(readPetStudies(JSON.stringify({ [study]: { savedAt: 1, series: {}, glucose: 0 } })), {});
  });

  it('keeps patients with the same local ID at different issuers out of each other’s priors', () => {
    const patient = 'd'.repeat(64);
    const records = withPetSeries({}, '1'.repeat(64), series, lesions, 1, { patient, date: '19990101' });
    assert.equal(patientDigest({ patientId: 'LOCAL-1', patientKey: patient }), patient);
    assert.equal(priorRecord(records, patientDigest({ patientId: 'LOCAL-1', patientKey: 'c'.repeat(64) }), '20010101', 'fdg'), null);
    assert.equal(patientDigest({ patientId: 'LOCAL-1' }), undefined);
  });
});

it('does not use anonymous or tracer-incompatible stored priors', async () => {
  const unknown = patientDigest({ patientId: '' });
  assert.equal(unknown, undefined);
  const record = { references: {}, tracer: 'fdg', lesions: [{ name: 'L1', center: [0,0,0], radius: 3 }] } as PetSeriesRecord;
  const oldEmptyDigest = await uidDigest('\u0000');
  const records = withPetSeries({}, study, series, record, 0, { patient: oldEmptyDigest, date: '20000101' });
  assert.equal(priorRecord(records, unknown, '20010101', 'fdg'), null);
  assert.equal(priorRecord(records, oldEmptyDigest, '20010101', 'PSMA'), null);
});
it('restores every lesion with its own identity and refuses an unverified score', () => {
  const pet = { id: 'pet', uid: '1', modality: 'PT', dimensions: [9,9,9], spacing: [2,2,2], direction: [1,0,0,0,1,0,0,0,1], origin: [0,0,0],
    canReconstruct: true, spacingKnown: true, valueUnit: 'SUVbw', suvFactor: 1, petAcquisition: { tracer: 'FDG' } } as Series;
  const volume: Volume = { series: pet, data: new Float32Array(9**3).fill(2) };
  const drawings: Annotation[] = Array.from({length:51}, (_,n) => ({ type:'sphere', id: 'draw-'+n, label: 'L'+(n+1), slice:4, plane:'axial', points:[[8,8,8],[10,8,8]], deauville:5 }));
  const record = seriesRecord(drawings, pet, volume)!;
  const stored = readPetStudies(JSON.stringify(withPetSeries({}, study, series, record, 1)));
  const restored = keptAnnotations(stored[study].series[series],pet);
  assert.deepEqual(restored.map(item=>item.id),drawings.map(item=>item.id));
  assert.ok(restored.every(item=>item.deauville === undefined));
  const edits = mergeRestored([{...drawings[0], id:'new'}], restored);
  assert.equal(edits.length,52);
  assert.equal(edits.find(item=>item.id==='new')?.label,'L52');
  assert.equal(edits.find(item=>item.id==='draw-0')?.label,'L1');
});
