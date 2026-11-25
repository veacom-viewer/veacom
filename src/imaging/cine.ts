import type { CineTiming } from '../model';

export function advanceCine(last: number, now: number, fps: number): { last: number; steps: number } {
  const elapsed = now - last;
  if (elapsed >= 1000) return { last: now, steps: 1 };
  const interval = 1000 / fps;
  // Cover floating-point round-off at an interval boundary, retaining any time borrowed by the tolerance.
  const steps = Math.max(0, Math.floor((elapsed + 1e-7) / interval));
  return { last: last + steps * interval, steps };
}

/** Mean of the recorded forward frame intervals, for the speed control. The clock uses the individual intervals. */
export function recordedFps(timing: CineTiming): number {
  const total = timing.intervalsMs.reduce((sum, interval) => sum + interval, 0);
  return total > 0 ? 1000 * timing.intervalsMs.length / total : 0;
}

/** Start from the visible slice and keep phase against a monotonic clock, including refreshes that miss a frame. */
export function cineCycle(timing: CineTiming, overrideFps?: number) {
  const { slices, intervalsMs, sweeping } = timing;
  if (slices.length < 2) return;
  const fixed = overrideFps === undefined ? intervalsMs.length === 1 ? intervalsMs[0] : undefined : 1000 / overrideFps;
  const positions = slices.map((_, i) => i);
  if (sweeping) for (let i = slices.length - 2; i > 0; i--) positions.push(i);
  const ends: number[] = [];
  let duration = 0;
  for (let i = 0; i < positions.length; i++) {
    const from = positions[i], to = positions[(i + 1) % positions.length];
    // DICOM gives no interval from the last frame back to the first. Hold the last frame for its final forward interval.
    const gap = !sweeping && i === positions.length - 1 ? slices.length - 2 : Math.min(from, to);
    duration += fixed ?? intervalsMs[gap];
    ends.push(duration);
  }
  if (!(duration > 0) || !Number.isFinite(duration)) return;
  return {
    startAt(slice: number): number {
      const i = slices.indexOf(slice);
      return i > 0 ? ends[i - 1] : 0;
    },
    sliceAt(ms: number): number {
      const phase = ms % duration;
      let lo = 0, hi = ends.length - 1;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (phase < ends[mid]) hi = mid;
        else lo = mid + 1;
      }
      return slices[positions[lo]];
    },
  };
}
