import type { Series, ViewState } from '../model';
import { getPlaneFrame, sliceCount, sub } from './geometry';
import { usesSourceFrames } from './viewState';

// Paging the slices the way VEAcom 1.x does: an axial stack from the top down (the head first; the wheel, a
// downward drag and the down keys go towards the feet), a coronal one from the front, a sagittal one from the
// middle, paging from right to left. Slice indices stay in the series' own order; the direction a reader pages
// in, and where a series opens, follow these rules. The number a slice shows is another matter: numbersBackwards.

type Paged = Pick<ViewState, 'plane' | 'mode' | 'oblique'>;

/** How the slice centres move from the first slice to the last one, in patient coordinates (LPS). */
function travel(series: Series, view: Paged): [number, number, number] | null {
  const count = sliceCount(series, view);
  if (count < 2) return null;
  const first = getPlaneFrame(series, { ...view, slice: 0 }).center, last = getPlaneFrame(series, { ...view, slice: count - 1 }).center;
  return sub(last, first);
}

/** The patient axis the slices step along: 0 left-right (sagittal), 1 front-back (coronal), 2 head-feet (axial). */
function axisOf(step: [number, number, number]): 0 | 1 | 2 | null {
  const size = step.map(Math.abs);
  const axis = size.indexOf(Math.max(...size)) as 0 | 1 | 2;
  return size[axis] > 0 ? axis : null;
}

/** True when going down the page (wheel, drag, ↓, PgDn, the slice bar) is going to a lower slice index:
 * down towards the feet on axial, towards the back on coronal and towards the left on sagittal. */
export function pagesBackwards(series: Series, view: Paged): boolean {
  const step = travel(series, view);
  if (!step) return false;
  const axis = axisOf(step);
  return axis !== null && (axis === 2 ? step[2] > 0 : step[axis] < 0);
}

/** How the scanner numbered a stack's acquired images, where it numbered them 1 to N in the series' order (`up`) or
 * N to 1 (`down`). */
const scannerNumbering = new WeakMap<object, 'up' | 'down' | null>();
function ownNumbering(series: Series): 'up' | 'down' | null {
  const frames = series.frameMetadata, count = series.dimensions[2];
  if (!frames || count < 2 || frames.length !== count) return null;
  let known = scannerNumbering.get(frames);
  if (known === undefined) {
    known = frames.every((frame, index) => frame.instanceNumber === index + 1) ? 'up'
      : frames.every((frame, index) => frame.instanceNumber === count - index) ? 'down' : null;
    scannerNumbering.set(frames, known);
  }
  return known;
}

/** True when the slice number shown falls as the slice index rises. Acquired images that the scanner numbered 1 to N in
 * their order show those numbers: the number on screen is then the image's number in a report or in another viewer, and
 * it may fall as the reader pages down. Everything else counts in paging order, 1 at the top of an axial stack. */
export function numbersBackwards(series: Series, view: Paged): boolean {
  const own = usesSourceFrames(series, view) ? ownNumbering(series) : null;
  return own ? own === 'down' : pagesBackwards(series, view);
}

/** The number shown for slice index `slice` of `count`, from 1 (see numbersBackwards). */
export function shownSlice(series: Series, view: Paged, slice: number, count: number): number {
  return numbersBackwards(series, view) ? count - slice : slice + 1;
}

/** A paging step (+1 is down the page) as a change of slice index. */
export function pageStep(series: Series, view: Paged, steps: number): number {
  return pagesBackwards(series, view) ? -steps : steps;
}

/** Where a series opens in the plane it was acquired in: axial at the top, coronal at the front, sagittal in
 * the middle, anything else at its first image. */
export function openingSlice(series: Series): number {
  const view: Paged = { plane: 'axial', mode: 'source' };
  const count = sliceCount(series, view), step = travel(series, view);
  if (!step) return 0;
  const axis = axisOf(step);
  if (axis === 2) return step[2] > 0 ? count - 1 : 0;
  if (axis === 1) return step[1] > 0 ? 0 : count - 1; // +y is towards the back
  if (axis === 0) return Math.floor((count - 1) / 2);
  return 0;
}
