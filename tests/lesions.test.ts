import { assertClose } from './support';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Annotation, Series, Vec3, Volume } from '../src/model';
import { lesionValues, nameLesions, percentChange, seriesRatios, valuesIn } from '../src/imaging/lesions';

const sphere = (id: string, extra: Partial<Annotation> = {}): Annotation => ({ id, type: 'sphere', points: [[40, 40, 40], [52, 40, 40]], plane: 'axial', slice: 0, mode: 'mpr', ...extra });
const pet: Series = {
  id: 'pet', uid: '1', studyUid: '2', patientId: 'TEST', patientName: 'Synthetic', studyDate: '20000101', description: 'Synthetic PET',
  modality: 'PT', petAcquisition: { tracer: 'FDG' }, seriesNumber: 1, dimensions: [40, 40, 40], spacing: [2, 2, 2], origin: [0, 0, 0], direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  windowCenter: 5, windowWidth: 10, valueUnit: 'Bq/ml', suvFactor: 0.5, sulFactor: 0.625, canReconstruct: true, spacingKnown: true,
  warnings: [], photometricInterpretation: 'MONOCHROME2',
};

describe('lesion names', () => {
  it('name each new lesion after the highest name in use, so names stay when one is deleted', () => {
    const named = nameLesions([sphere('a'), sphere('liver', { role: 'liver' }), { ...sphere('line'), type: 'length' }, sphere('b')]);
    assert.deepEqual(named.map(item => item.label), ['L1', undefined, undefined, 'L2']);
    const after = nameLesions([named[3], sphere('c')]);
    assert.deepEqual(after.map(item => item.label), ['L2', 'L3']);
    assert.deepEqual(nameLesions([sphere('kept', { label: 'Axilla' }), sphere('d')]).map(item => item.label), ['Axilla', 'L1']);
    const unchanged = [sphere('x', { label: 'L1' })];
    assert.equal(nameLesions(unchanged), unchanged);
  });
});

describe('lesion values', () => {
  const data = new Float32Array(40 * 40 * 40);
  for (let z = 0; z < 40; z++) for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) {
    const p: Vec3 = [x * 2, y * 2, z * 2];
    data[(z * 40 + y) * 40 + x] = (Math.hypot(p[0] - 40, p[1] - 40, p[2] - 40) <= 10 ? 8 : 1) / 0.5;
  }
  const volume: Volume = { series: { ...pet, suvNormalization: 'lbm' }, data };

  it('are kept in SUVbw whatever SUV is shown, with MTV and TLG at the lesion\'s threshold', () => {
    const values = lesionValues(sphere('a', { threshold: 'max41' }), volume)!;
    assertClose(values.max, 8, 5);
    assertClose(values.peak, 8, 5);
    assertClose(values.tlg! / values.mtv!, 8, 5);
    assert.equal(lesionValues(sphere('b'), volume)!.mtv, undefined);
  });

  it('read back in SUL or SUVbsa through the ratios kept beside them; MTV is a volume', () => {
    assert.deepEqual(seriesRatios(pet), { sulPerBw: 1.25 });
    const kept = { max: 8, mean: 4, peak: 7, mtv: 3.2, tlg: 25.6 };
    assert.deepEqual(valuesIn(kept, 'SUVbw', {}), kept);
    assert.deepEqual(valuesIn(kept, 'SUL', { sulPerBw: 1.25 }), { max: 10, mean: 5, peak: 8.75, mtv: 3.2, tlg: 32 });
    assert.equal(valuesIn(kept, 'SUVbsa', { sulPerBw: 1.25 }), null);
    assert.equal(valuesIn(kept, 'HU', { sulPerBw: 1.25 }), null);
  });

  it('change in per cent, and only against a positive value', () => {
    assertClose(percentChange(7, 10), -30);
    assertClose(percentChange(3, 2), 50);
    assert.equal(percentChange(3, 0), null);
    assert.equal(percentChange(undefined, 2), null);
    assert.equal(percentChange(3, Number.NaN), null);
  });
});
