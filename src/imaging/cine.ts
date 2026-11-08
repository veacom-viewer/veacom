export function advanceCine(last: number, now: number, fps: number): { last: number; steps: number } {
  const elapsed = now - last;
  if (elapsed >= 1000) return { last: now, steps: 1 };
  const interval = 1000 / fps;
  // Cover floating-point round-off at an interval boundary, retaining any time borrowed by the tolerance.
  const steps = Math.max(0, Math.floor((elapsed + 1e-7) / interval));
  return { last: last + steps * interval, steps };
}
