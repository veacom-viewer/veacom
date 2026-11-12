// What one screen pixel of an acquired frame shows. The shader (sliceRenderer.ts) takes the frame's values under the
// screen pixel, each weighted by the share of its area the screen pixel covers, and applies the window or VOI LUT only
// to their mean. That area is never narrower than one pixel of the frame: where the frame is magnified this is bilinear
// interpolation between its four nearest pixels, as reconstructed planes interpolate between eight; where it is
// minified, every pixel keeps its share, so thin lines and fine patterns neither drop out nor alias.
//
// Only the picture is resampled. The value under the pointer, measurements, ROI statistics and DICOM export read the
// stored pixels. Picture and video exports copy the screen, so they show the same resampled picture.
import type { Vec3 } from '../model';

/** At most this many pixels of the frame are read across, and as many down, for one screen pixel. A wider footprint
 * (a frame shown more than this many times smaller than its matrix) is read at even steps. */
export const FOOTPRINT_TAPS = 16;

/** Half the width and height, in pixels of the frame, of the area one screen pixel covers: at least half a pixel each.
 * `right` and `down` are one screen pixel's steps in the frame's index space; a rotated view takes their bounding box. */
export function pixelFootprint(right: Vec3, down: Vec3): [number, number] {
  const half = (axis: number) => Math.max(0.5, (Math.abs(right[axis]) + Math.abs(down[axis])) / 2);
  return [half(0), half(1)];
}
