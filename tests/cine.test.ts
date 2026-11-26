import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertClose } from './support';
import { advanceCine, cineCycle, recordedFps } from '../src/imaging/cine';

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

describe('DICOM playback in source-frame order', () => {
  const clip = { slices: [2, 0, 3, 1], intervalsMs: [25, 75, 25], sweeping: false };
  it('follows each encoded interval on a catalog that sorted the source frames differently', () => {
    const cycle = cineCycle(clip)!;
    assert.deepEqual([0, 24, 25, 99, 100, 124, 125, 149, 150].map(t => cycle.sliceAt(t)), [2, 2, 0, 0, 3, 3, 1, 1, 2]);
    assert.equal(cycle.startAt(0), 25);
    assert.equal(cycle.startAt(1), 125);
    assert.equal(cycle.startAt(7), 0);
    assert.equal(recordedFps(clip), 24);
  });
  it('visits every frame once per turn on a sweep, without repeating the endpoints', () => {
    const cycle = cineCycle({ ...clip, sweeping: true })!;
    assert.deepEqual([0, 25, 100, 125, 150, 225, 250].map(t => cycle.sliceAt(t)), [2, 0, 3, 1, 3, 0, 2]);
  });
  it('uses a requested constant speed and resumes original timing when the override is cleared', () => {
    const manual = cineCycle(clip, 40)!, original = cineCycle(clip)!;
    assert.equal(manual.sliceAt(50), 3);
    assert.equal(original.sliceAt(50), 0);
    assert.equal(manual.sliceAt(100), 2);
    assert.equal(original.sliceAt(100), 3);
  });
  it('handles fractional rates, sub-Hz clips, coincident frames and clips trimmed down to one frame', () => {
    const fractional = { ...clip, slices: [3, 4], intervalsMs: [1000 / 29.97] };
    assertClose(recordedFps(fractional), 29.97);
    const slow = cineCycle({ ...fractional, intervalsMs: [2000] })!;
    assert.deepEqual([0, 1999, 2000, 3999, 4000].map(t => slow.sliceAt(t)), [3, 3, 4, 4, 3]);
    assert.equal(cineCycle({ ...clip, intervalsMs: [25, 0, 75] })!.sliceAt(25), 3);
    assert.equal(cineCycle({ ...clip, slices: [2], intervalsMs: [] }), undefined);
  });
});
