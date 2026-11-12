import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pickState, togglePicked } from '../src/ui/exportSelection';

// Two studies of made-up series ids, as the export window's "Selected series" list groups them.
const first = ['a1', 'a2', 'a3'], second = ['b1', 'b2'], every = [...first, ...second];

describe('the export window\'s boxes over several series', () => {
  it('counts the picked series, and tells all of them from some of them', () => {
    assert.deepEqual(pickState(every, new Set(every)), { count: 5, all: true, partial: false });
    assert.deepEqual(pickState(every, new Set(['a1', 'b2'])), { count: 2, all: false, partial: true });
    assert.deepEqual(pickState(every, new Set()), { count: 0, all: false, partial: false });
  });

  it('counts only the series under the box', () => {
    const picked = new Set([...first, 'b1']);
    assert.deepEqual(pickState(first, picked), { count: 3, all: true, partial: false });
    assert.deepEqual(pickState(second, picked), { count: 1, all: false, partial: true });
    // A series no longer in the list does not count.
    assert.deepEqual(pickState(second, new Set(['gone'])), { count: 0, all: false, partial: false });
  });

  it('is not ticked over an empty list', () => {
    assert.deepEqual(pickState([], new Set(every)), { count: 0, all: false, partial: false });
  });

  it('picks every series when none or only some were picked', () => {
    assert.deepEqual([...togglePicked(new Set(), every)].sort(), every);
    assert.deepEqual([...togglePicked(new Set(['a2']), every)].sort(), every);
  });

  it('picks none when all were picked', () => {
    assert.equal(togglePicked(new Set(every), every).size, 0);
  });

  it('changes only its own study\'s series', () => {
    // The second study's box with one of its two series picked: both are picked, the first study is as it was.
    assert.deepEqual([...togglePicked(new Set(['a1', 'b2']), second)].sort(), ['a1', 'b1', 'b2']);
    // Pressed again, the second study is left out and the first study is still as it was.
    assert.deepEqual([...togglePicked(new Set(['a1', 'b1', 'b2']), second)], ['a1']);
  });

  it('ticks and unticks one series', () => {
    assert.deepEqual([...togglePicked(new Set(['a1']), ['a2'])].sort(), ['a1', 'a2']);
    assert.deepEqual([...togglePicked(new Set(['a1', 'a2']), ['a2'])], ['a1']);
  });

  it('leaves the set it was given as it was', () => {
    const picked = new Set(['a1']);
    togglePicked(picked, every);
    assert.deepEqual([...picked], ['a1']);
  });
});
