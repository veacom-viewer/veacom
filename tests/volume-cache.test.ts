import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { INACTIVE_VOLUME_BUDGET, trimInactiveVolumes } from '../src/domain/volumeCache';
import type { Volume } from '../src/model';

function volume(id: string, bytes: number): Volume {
  return {
    series: {
      id, uid: id, studyUid: 'study', patientId: 'TEST', patientName: 'Synthetic',
      studyDate: '', description: id, modality: 'CT', seriesNumber: 1,
      dimensions: [bytes / 4, 1, 1], spacing: [1, 1, 1], origin: [0, 0, 0],
      direction: [1, 0, 0, 0, 1, 0, 0, 0, 1], windowCenter: 40, windowWidth: 400,
      valueUnit: 'HU', suvFactor: null, canReconstruct: true, spacingKnown: true,
      warnings: [], photometricInterpretation: 'MONOCHROME2',
    },
    data: new Float32Array(bytes / 4),
  };
}

const cache = (...items: Volume[]) => new Map(items.map(item => [item.series.id, item]));

describe('resident volume cache', () => {
  it('keeps the most recently used inactive volumes within the byte budget', () => {
    const resident = cache(volume('recent', 24), volume('oldest', 16), volume('middle', 20));
    const result = trimInactiveVolumes(resident, new Set(), new Map([['recent', 3], ['oldest', 1], ['middle', 2]]), 44);
    assert.deepEqual([...result.volumes.keys()], ['recent', 'middle']);
    assert.deepEqual(result.evicted, ['oldest']);
    assert.equal(resident.size, 3);
  });

  it('keeps visible and assessment data even when their size exceeds the inactive budget', () => {
    const resident = cache(volume('visible', 64), volume('assessment', 80), volume('old', 28), volume('recent', 20));
    const result = trimInactiveVolumes(resident, new Set(['visible', 'assessment']), new Map([['old', 1], ['recent', 2]]), 32);
    assert.deepEqual([...result.volumes.keys()], ['visible', 'assessment', 'recent']);
    assert.deepEqual(result.evicted, ['old']);
  });

  it('evicts a volume larger than the budget once its pin is released', () => {
    const resident = cache(volume('large', 80));
    const pinned = trimInactiveVolumes(resident, new Set(['large']), new Map(), 32);
    assert.equal(pinned.volumes, resident);
    const released = trimInactiveVolumes(pinned.volumes, new Set(), new Map(), 32);
    assert.equal(released.volumes.size, 0);
    assert.deepEqual(released.evicted, ['large']);
  });

  it('does not replace the map when inactive memory is exactly at the limit', () => {
    const resident = cache(volume('a', 12), volume('b', 20));
    assert.deepEqual(trimInactiveVolumes(resident, new Set(), new Map(), 32), { volumes: resident, evicted: [] });
    assert.equal(trimInactiveVolumes(resident, new Set(), new Map(), 32).volumes, resident);
    assert.equal(INACTIVE_VOLUME_BUDGET, 512 * 1024 * 1024);
  });
});
