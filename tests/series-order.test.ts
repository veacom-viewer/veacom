import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Series } from '../src/model';
import { withFound, withImported } from '../src/ui/seriesOrder';

const series = (id: string, extra: Partial<Series> = {}): Series => ({
  id, uid: id, studyUid: 'study', patientId: 'P', patientName: 'Synthetic', studyDate: '20000101', description: id, modality: 'CT',
  seriesNumber: 1, dimensions: [8, 8, 4], spacing: [1, 1, 1], origin: [0, 0, 0], direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  windowCenter: 40, windowWidth: 400, valueUnit: 'HU', suvFactor: null, canReconstruct: true, warnings: [], photometricInterpretation: 'MONOCHROME2', ...extra,
});
const ids = (list: Series[]) => list.map(item => item.id);

describe('where an import\'s series go in the series list', () => {
  const old = [series('old-1'), series('old-2')], listedBefore = new Set(ids(old));
  it('puts the series found while it runs at the top, in the order found, above the ones listed before', () => {
    const first = withFound(old, [series('new-2')], listedBefore);
    assert.deepEqual(ids(first), ['new-2', 'old-1', 'old-2']);
    const second = withFound(first, [series('new-1'), series('new-3')], listedBefore);
    assert.deepEqual(ids(second), ['new-2', 'new-1', 'new-3', 'old-1', 'old-2']);
  });
  it('updates a series already in the list where it is', () => {
    const again = withFound([series('new-1'), ...old], [series('old-2', { description: 'read again' }), series('new-1', { description: 'found again' })], listedBefore);
    assert.deepEqual(again.map(item => [item.id, item.description]), [['new-1', 'found again'], ['old-1', 'old-1'], ['old-2', 'read again']]);
  });
  it('ends with the new series first in the import\'s own order, whatever order they were found in', () => {
    const found = withFound(old, [series('new-2'), series('new-1')], listedBefore);
    const result = [series('new-1'), series('new-2'), series('new-3')];
    assert.deepEqual(ids(withImported(found, result, listedBefore, ['new-2', 'new-1'])), ['new-1', 'new-2', 'new-3', 'old-1', 'old-2']);
  });
  it('leaves a study opened again where it was, as the import read it', () => {
    const result = [series('old-2', { description: 'read again' }), series('new-1')];
    const list = withImported(old, result, listedBefore, []);
    assert.deepEqual(list.map(item => [item.id, item.description]), [['new-1', 'new-1'], ['old-1', 'old-1'], ['old-2', 'read again']]);
  });
  it('drops a series found on the way that the import did not keep', () => {
    const found = withFound(old, [series('passing')], listedBefore);
    assert.deepEqual(ids(withImported(found, [series('new-1')], listedBefore, ['passing'])), ['new-1', 'old-1', 'old-2']);
  });
  it('opens the first study into an empty list as before', () => {
    assert.deepEqual(ids(withImported([], [series('a'), series('b')], new Set(), [])), ['a', 'b']);
  });
});
