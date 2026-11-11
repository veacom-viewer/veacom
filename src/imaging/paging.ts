import type { Annotation, Joined, Series, ViewState } from '../model';
import { getPlaneFrame, sliceCount, sub } from './geometry';

// Paging the slices the way VEAcom 1.x does: an axial stack from the top down (the head first; the wheel, a
// downward drag and the down keys go towards the feet), a coronal one from the front, a sagittal one from the
// middle, paging from right to left. Slice indices stay in the series' own order; the direction a reader pages
// in, and where a series opens, follow these rules.

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

/** Where slice `slice` of `count` stands in paging order, from 0: an axial stack counts from the top. The slice at a
 * place is found the same way, since the order is either the slices' own or its reverse. */
export function pagingPlace(series: Series, view: Paged, slice: number, count: number): number {
  return pagesBackwards(series, view) ? count - 1 - slice : slice;
}

/** A pane's place in the sequence it pages, from 0, and that sequence's length. A series alone is its own sequence
 * in paging order. A stack paged with its reference image counts that image too, at the end it stands at. */
export function placeInSequence(series: Series, view: Paged, slice: number, count: number, joined?: Joined | null): { place: number; total: number } {
  if (!joined) return { place: pagingPlace(series, view, slice, count), total: count };
  if (joined.lead) return { place: joined.leadAt, total: joined.total };
  return { place: pagingPlace(series, view, slice, count) + Number(joined.leadAt === 0), total: joined.total };
}

/** The slice of a stack at a place of the sequence it shares with its reference image (not that image's own place). */
export function stackSliceAt(series: Series, view: Paged, place: number, count: number, joined: Joined): number {
  return pagingPlace(series, view, place - Number(joined.leadAt === 0), count);
}

/** The number a slice shows and the total beside it: its place, from 1, in the sequence its pane pages. What numbers
 * the slice a pane shows asks here, so that the number means one image in all of it: the pane's counter, the slice
 * bar, the image corner, the export window, the tag panel, a checklist note and the measurement list (measuredSlice). */
export function shownSlice(series: Series, view: Paged, slice: number, count: number, joined?: Joined | null): { number: number; total: number } {
  const { place, total } = placeInSequence(series, view, slice, count, joined);
  return { number: place + 1, total };
}

/** The number a pane's counter shows on the slice a measurement was drawn on, for a list that names the measurement by
 * its slice: the acquired image at index `frame`, counted with the stack's reference image where the two are paged as
 * one (`joined`), or, with no `frame`, the measurement's slice of the reconstructed plane it was drawn on. */
export function measuredSlice(series: Series, annotation: Pick<Annotation, 'plane' | 'slice' | 'oblique'>, frame?: number, joined?: Joined | null): number {
  if (frame !== undefined) return shownSlice(series, { mode: 'source', plane: 'axial' }, frame, series.dimensions[2], joined).number;
  const plane: Paged = { mode: 'mpr', plane: annotation.plane, oblique: annotation.oblique };
  return shownSlice(series, plane, annotation.slice, sliceCount(series, plane)).number;
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
