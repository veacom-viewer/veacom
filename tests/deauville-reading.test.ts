import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { Annotation, Series, Vec3, Volume } from '../src/model';
import { canAssessLymphoma, clearEditedScores, currentDeauville, deauvilleReading } from '../src/imaging/deauvilleReading';
import { spherePoints } from '../src/imaging/voi';
import { fusedPetSummary } from '../src/imaging/annotations';
import { setLocale } from '../src/i18n';

const series: Series = {
  id: 'static-pet', uid: '1', studyUid: '2', patientId: '', patientName: '', description: '', studyDate: '',
  seriesNumber: 1, modality: 'PT', dimensions: [48, 48, 48], spacing: [2, 2, 2], origin: [0, 0, 0],
  direction: [1, 0, 0, 0, 1, 0, 0, 0, 1], windowCenter: 5, windowWidth: 10, valueUnit: 'SUVbw', suvFactor: 1,
  canReconstruct: true, warnings: [], photometricInterpretation: 'MONOCHROME2', petAcquisition: { tracer: 'FDG' },
};
const data = new Float32Array(48 ** 3).map((_, i) => i % 48 < 15 ? 1 : i % 48 > 35 ? 4 : 2);
const volume: Volume = { series, data };
const sphere = (id: string, center: Vec3, radius: number): Annotation => ({
  id, type: 'sphere', plane: 'axial', slice: 24, points: spherePoints(center, radius),
});
const lesion = { ...sphere('lesion', [80, 48, 48], 8), fdgLymphoma: true };
const liver: Annotation = { ...sphere('liver', [48, 48, 48], 15), role: 'liver' };
const pool: Annotation = { ...sphere('pool', [16, 48, 48], 6), role: 'bloodPool' };
const items = [lesion, liver, pool];

it('requires the lymphoma reading context, a suitable tracer and complete reference data', () => {
  assert.deepEqual(deauvilleReading({ ...lesion, fdgLymphoma: false }, items, volume), { problem: 'context' });
  const psma = { ...volume, series: { ...series, petAcquisition: { tracer: 'Ga-68 PSMA' } } };
  assert.deepEqual(deauvilleReading(lesion, items, psma), { problem: 'context' });
  const ambiguous = { ...volume, series: { ...series, petAcquisition: { multipleAdministrations: true } } };
  assert.deepEqual(deauvilleReading(lesion, items, ambiguous), { problem: 'context' });
  assert.deepEqual(deauvilleReading(lesion, [lesion, pool], volume), { problem: 'missing' });
  for (const points of [spherePoints([-14, 48, 48], 15), spherePoints([48, 48, 48], 23)]) {
    assert.deepEqual(deauvilleReading(lesion, [lesion, { ...liver, points }, pool], volume), { problem: 'coverage' });
  }
  const padded = { ...volume, series: { ...series, paddingRange: [2, 2] as [number, number] } };
  assert.deepEqual(deauvilleReading(lesion, items, padded), { problem: 'coverage' });
});

it('reads nothing on a file storing SUV that the engine refused, not corrected for attenuation', () => {
  // The same PET without the engine's SUV factor: its unit still says SUVbw, but its values are not an SUV.
  const refused = { ...volume, series: { ...series, suvFactor: null } };
  assert.equal(canAssessLymphoma(volume), true);
  assert.equal(canAssessLymphoma(refused), false);
  assert.deepEqual(deauvilleReading(lesion, items, refused), { problem: 'context' });
  setLocale('en');
  assert.doesNotMatch(fusedPetSummary(lesion, refused), /SU[VL]/);
  assert.match(fusedPetSummary(lesion, refused), /^PET g\/ml max /);
});

it('invalidates confirmed scores when the lesion, references or measured values change', () => {
  const reading = deauvilleReading(lesion, items, volume);
  if (!('basis' in reading)) throw new Error('Expected a quantitative basis');
  assert.equal(reading.suggestion.score, 5);
  const confirmed: Annotation = { ...lesion, deauville: 5, deauvilleBasis: reading.basis };
  const previous = [confirmed, liver, pool];
  assert.equal(currentDeauville(confirmed, previous, volume), 5);
  assert.equal(currentDeauville(confirmed, previous, { ...volume, data: new Float32Array(data.length).fill(1) }), undefined);
  for (const next of [
    [{ ...confirmed, points: spherePoints([16, 30, 48], 8) }, liver, pool],
    [confirmed, { ...liver, points: spherePoints([52, 48, 48], 15) }, pool],
    [confirmed, liver, { ...pool, id: 'replacement' }], [confirmed, liver],
  ]) {
    assert.equal(clearEditedScores(previous, next)[0].deauville, undefined);
    assert.equal(currentDeauville(next[0], next, volume), undefined);
  }
  assert.equal(clearEditedScores(previous, [{ ...confirmed, labelShift: [1, 0, 0] }, liver, pool])[0].deauville, 5);
});

it('labels a fused sphere with its actual modality and the Turkish peak term', () => {
  try {
    setLocale('en');
    assert.match(fusedPetSummary(lesion, { ...volume, series: { ...series, modality: 'MR', suvFactor: null, valueUnit: 'a.u.' } }), /^MR a\.u\. max/);
    setLocale('tr');
    assert.ok(fusedPetSummary(liver, volume).includes('SUVpeak 2,00'));
    assert.ok(fusedPetSummary(liver, { ...volume, series: { ...series, suvNormalization: 'lbm', sulFactor: 0.5 } }).includes('SULpeak 1,00'));
  } finally { setLocale('en'); }
});
