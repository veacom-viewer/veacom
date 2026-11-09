// Turns what the screen showed into numbers. Input: the run's marks (name → trace time in ms) and its frames, each a
// screenshot from Chromium's trace with the slice it showed (`index`, null when no marker was read), the marker's cell
// size (`unit`) and the mean grey of a patch of tissue beside the marker (`grey`), all in trace time. Pure: no I/O.

/**
 * Frames that show the main pane: a marker whose cells are at least `minShare` of the picture's width (a series
 * thumbnail's are far smaller). Relative, because trace screenshots are 500 pixels wide and window captures are not.
 */
export const mainFrames = (frames, minShare) => frames.filter(f => f.index != null && f.unit >= minShare * f.width);

/** Opening: the first frame after the drop that shows a slice, and which slice it was. */
export function openMetrics(marks, frames, minShare) {
  const drop = marks['bench:drop'];
  if (drop === undefined) throw new Error('The run has no drop mark.');
  const first = mainFrames(frames, minShare).find(f => f.ts >= drop);
  return { firstImageMs: first ? round(first.ts - drop) : null, firstSlice: first?.index ?? null };
}

/**
 * Paging: `notches` wheel notches sent between the marks `bench:<name>:start` and `bench:<name>:end`. `perNotch` is
 * how many slices one notch moves this viewer when sent slowly (its own rule, measured first), so `kept` compares
 * like with like. `lagMs` is how long the picture kept moving after the last notch: the "one more step a second
 * later" a user notices.
 */
export function pagingMetrics(marks, frames, minShare, name, notches, perNotch) {
  const start = marks[`bench:${name}:start`], end = marks[`bench:${name}:end`], until = marks[`bench:${name}:settled`];
  if (start === undefined || end === undefined || until === undefined) throw new Error(`The run has no ${name} marks.`);
  const shown = mainFrames(frames, minShare);
  const before = shown.filter(f => f.ts <= start).at(-1) ?? shown.find(f => f.ts > start);
  const during = shown.filter(f => f.ts > start && f.ts <= until);
  if (!before || !during.length) return { error: 'no slice was read on screen while paging' };
  const changes = [];
  let previous = before.index;
  for (const frame of during) if (frame.index !== previous) { changes.push(frame); previous = frame.index; }
  const last = during.at(-1), inputMs = end - start;
  const gaps = [], times = [start, ...changes.filter(c => c.ts <= end).map(c => c.ts)];
  for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
  const advanced = Math.abs(last.index - before.index), expected = notches * perNotch;
  return {
    notches, inputMs: round(inputMs), from: before.index, to: last.index, advanced,
    kept: expected ? round(advanced / expected, 3) : null,
    // Distinct slices drawn while the notches arrived, per second.
    slicesPerS: round(changes.filter(c => c.ts <= end).length / (inputMs / 1000), 1),
    longestStallMs: gaps.length ? round(Math.max(...gaps)) : null,
    lagMs: changes.length ? round(Math.max(0, changes.at(-1).ts - end)) : 0,
  };
}

/** Slices one notch moves, from notches sent one at a time (marks `bench:calibrate:<i>` before each notch). */
export function perNotch(marks, frames, minShare, count) {
  const shown = mainFrames(frames, minShare), steps = [];
  for (let i = 0; i < count; i++) {
    const at = marks[`bench:calibrate:${i}`], next = marks[`bench:calibrate:${i + 1}`] ?? marks['bench:calibrate:end'];
    const before = shown.filter(f => f.ts <= at).at(-1), after = shown.filter(f => f.ts <= next).at(-1);
    if (before && after) steps.push(Math.abs(after.index - before.index));
  }
  if (!steps.length) return null;
  steps.sort((a, b) => a - b);
  return steps[Math.floor(steps.length / 2)];
}

/**
 * Window/level: a drag between `bench:wl:start` and `bench:wl:end`. Counts the frames whose tissue grey changed (the
 * picture really redrawn with a new window) per second of dragging, and how long the picture kept changing after the
 * mouse stopped. Any change counts: a small step of the window moves the patch's mean by a few hundredths of a grey
 * level, and an unchanged picture decodes to exactly the same pixels (JPEG blocks are coded independently), so text
 * changing elsewhere on screen cannot move it.
 */
export function windowLevelMetrics(marks, frames, minShare) {
  const start = marks['bench:wl:start'], end = marks['bench:wl:end'], until = marks['bench:wl:settled'];
  if (start === undefined || end === undefined || until === undefined) throw new Error('The run has no wl marks.');
  const shown = mainFrames(frames, minShare).filter(f => f.grey != null);
  let previous = shown.filter(f => f.ts <= start).at(-1)?.grey;
  const updates = [];
  for (const frame of shown.filter(f => f.ts > start && f.ts <= until)) {
    if (previous !== undefined && frame.grey !== previous) updates.push(frame);
    previous = frame.grey;
  }
  const dragMs = end - start;
  return {
    dragMs: round(dragMs), updatesPerS: round(updates.filter(u => u.ts <= end).length / (dragMs / 1000), 1),
    settleMs: updates.length ? round(Math.max(0, updates.at(-1).ts - end)) : null, changed: updates.length > 0,
  };
}

function round(value, digits = 0) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
