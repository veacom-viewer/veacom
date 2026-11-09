import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
// @ts-expect-error The bench's plain JavaScript modules have no type declarations.
import { openMetrics, pagingMetrics, perNotch, windowLevelMetrics } from '../tools/browser-bench/lib/metrics.mjs';
// @ts-expect-error The bench's plain JavaScript modules have no type declarations.
import { compare, median, summarize } from '../tools/browser-bench/lib/stats.mjs';

type Frame = { ts: number; index: number | null; unit: number; width: number; grey?: number | null };
const frame = (ts: number, index: number | null, unit = 9, grey: number | null = 150): Frame => ({ ts, index, unit, width: 500, grey });
const MAIN = 0.0035;

describe('bench metrics', () => {
  it('times the first image of the main pane, not a thumbnail', () => {
    const frames = [frame(1000, null), frame(1100, 150, 1), frame(1250, 0), frame(1300, 0)];
    assert.deepEqual(openMetrics({ 'bench:drop': 1000 }, frames, MAIN), { firstImageMs: 250, firstSlice: 0 });
    assert.deepEqual(openMetrics({ 'bench:drop': 1000 }, [frame(900, 0)], MAIN), { firstImageMs: null, firstSlice: null });
  });

  it('measures paging: slices drawn per second, notches kept, the longest stall and the lag after the last notch', () => {
    const marks = { 'bench:p:start': 0, 'bench:p:end': 1000, 'bench:p:settled': 2500 };
    // 10 notches, but the screen shows only 8 slices by the end of input and the last one 600 ms later.
    const frames = [frame(-10, 100), ...[1, 2, 3, 4, 5, 6, 7, 8].map(i => frame(i * 100, 100 + i)), frame(1600, 110)];
    const result = pagingMetrics(marks, frames, MAIN, 'p', 10, 1);
    assert.equal(result.advanced, 10);
    assert.equal(result.kept, 1);
    assert.equal(result.slicesPerS, 8);
    assert.equal(result.longestStallMs, 100);
    assert.equal(result.lagMs, 600);
  });

  it('counts kept notches against the viewer’s own slices per notch', () => {
    const marks = { 'bench:p:start': 0, 'bench:p:end': 500, 'bench:p:settled': 1000 };
    const result = pagingMetrics(marks, [frame(-1, 50), frame(100, 52), frame(400, 56)], MAIN, 'p', 4, 2);
    assert.equal(result.kept, 0.75);
  });

  it('calibrates slices per notch from single notches', () => {
    const marks = { 'bench:calibrate:0': 0, 'bench:calibrate:1': 400, 'bench:calibrate:2': 800, 'bench:calibrate:end': 1200 };
    const frames = [frame(-5, 10), frame(50, 12), frame(450, 14), frame(850, 16)];
    assert.equal(perNotch(marks, frames, MAIN, 3), 2);
  });

  it('counts window/level redraws by the grey of the tissue', () => {
    const marks = { 'bench:wl:start': 0, 'bench:wl:end': 1000, 'bench:wl:settled': 2000 };
    const frames = [frame(-10, 5, 9, 150), frame(16, 5, 9, 150.3), frame(19, 5, 9, 150.3), frame(500, 5, 9, 151), frame(1200, 5, 9, 152)];
    assert.deepEqual(windowLevelMetrics(marks, frames, MAIN), { dragMs: 1000, updatesPerS: 2, settleMs: 200, changed: true });
  });
});

describe('bench statistics', () => {
  it('gives the median with an interval that holds it', () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 2, 3]), 2.5);
    const summary = summarize([100, 102, 98, 101, 99, 100, 103]);
    assert.equal(summary.median, 100);
    assert.ok(summary.low <= 100 && summary.high >= 100);
  });

  it('calls a difference only outside the interval and the measured noise', () => {
    const a = [100, 101, 99, 100, 102], b = [150, 149, 151, 150, 152];
    assert.equal(compare(a, b).differs, true);
    assert.equal(compare(a, a.map(v => v * 1.01), { noise: 0.03 }).differs, false);
  });
});
