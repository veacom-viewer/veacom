import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertClose } from './support';
import { advanceCine } from '../src/imaging/cine';

describe('cine timing', () => {
  for (const fps of [1, 15, 25, 30, 100, 400, 512, 1000, 5000]) it(`keeps ${fps} slices per second across display refresh rates`, () => {
    for (const refresh of [60, 120, 144]) {
      let last = 0, slices = 0;
      for (let frame = 1; frame <= refresh * 10; frame++) {
        const advance = advanceCine(last, frame * 1000 / refresh, fps);
        last = advance.last;
        slices += advance.steps;
      }
      assert.equal(slices, fps * 10, `${refresh} Hz`);
    }
  });

  it('keeps the time remainder when display frames arrive unevenly', () => {
    let last = 0, slices = 0;
    for (const now of [12.4, 30.1, 49.8, 63.3, 81.7, 100]) {
      const advance = advanceCine(last, now, 512);
      last = advance.last;
      slices += advance.steps;
    }
    assert.equal(slices, 51);
    assertClose(last, 51 * 1000 / 512, 8);
  });

  it('does not count time before it has elapsed', () => {
    assert.deepEqual(advanceCine(0, 1.5, 512), { last: 0, steps: 0 });
    const boundary = advanceCine(0, 1000 / 30 - 1e-8, 30);
    assert.equal(boundary.steps, 1);
    assert.equal(advanceCine(boundary.last, 50, 30).steps, 0);
  });

  it('restarts after a hidden window without racing through missed slices', () => {
    assert.deepEqual(advanceCine(100, 1600, 512), { last: 1600, steps: 1 });
    assert.deepEqual(advanceCine(1600, 1601, 512), { last: 1600, steps: 0 });
  });
});
