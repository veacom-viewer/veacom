// Oblique MPR with handles: in the three-plane MPR each pane draws where the other two planes cut it, with a handle at
// both ends of each line. Dragging a handle turns that other plane about the crosshair, around this pane's normal, so
// its line follows the pointer.
import type { Series, ViewState } from '../model';
import { add, cross, dot, getPlaneFrame, planeAxes, planeIntersection, rotateAround, worldToScreen, type PlaneFrame, type ScreenMapping } from './geometry';
import { frameThrough } from './registration';
import { applyVector, IDENTITY, invert, type Matrix } from './rigid';

/** How far a plane is tilted from its plain orientation, in whole degrees. */
export function obliqueAngle(series: Series, view: Pick<ViewState, 'plane' | 'mode' | 'oblique'>): number {
  if (!view.oblique?.some(Boolean)) return 0;
  const tilted = planeAxes(series, view).normal, plain = planeAxes(series, { ...view, oblique: undefined }).normal;
  return Math.round(Math.acos(Math.min(1, Math.abs(dot(tilted, plain)))) * 180 / Math.PI);
}

/** An angle folded to (-90°, 90°], in radians: a line's direction does not care which way it points. */
export const foldLine = (radians: number) => {
  const turned = ((radians + Math.PI / 2) % Math.PI + Math.PI) % Math.PI - Math.PI / 2;
  return turned === -Math.PI / 2 ? Math.PI / 2 : turned;
};

/** The screen angle of the line where the plane (`series`, `view` with `oblique`) cuts the pane `frame`. */
export function lineAngle(frame: PlaneFrame, mapping: ScreenMapping, series: Series, view: ViewState, oblique: [number, number], transform?: Matrix): number | null {
  const reference = getPlaneFrame(series, { ...view, mode: 'mpr', oblique });
  const cut = planeIntersection(frame, transform ? frameThrough(reference, transform) : reference);
  if (!cut) return null;
  const a = worldToScreen(mapping, cut.point), b = worldToScreen(mapping, add(cut.point, cut.direction));
  return Math.hypot(b[0] - a[0], b[1] - a[1]) > 1e-9 ? Math.atan2(b[1] - a[1], b[0] - a[0]) : null;
}

/** Turn the reference about the viewing pane's screen normal, expressed in the reference's own coordinates. */
export function turnPlane(mapping: ScreenMapping, series: Series, view: ViewState, degrees: number, transform: Matrix = IDENTITY): [number, number] {
  const axis = applyVector(invert(transform), cross(mapping.right, mapping.down));
  const plain = planeAxes(series, { ...view, mode: 'mpr', oblique: undefined });
  const tilted = planeAxes(series, { ...view, mode: 'mpr' });
  const normal = rotateAround(tilted.normal, axis, degrees), down = rotateAround(tilted.v, axis, degrees);
  // Recover the two angles used by planeAxes. Choose the solution that keeps the reference's down direction.
  const v = -dot(normal, plain.v), n = dot(normal, plain.normal), length = Math.hypot(v, n);
  const sign = v * dot(down, plain.normal) + n * dot(down, plain.v) < 0 ? -1 : 1;
  const across = length < 1e-9 ? Math.atan2(dot(down, plain.normal), dot(down, plain.v)) : Math.atan2(sign * v, sign * n);
  const alongDown = Math.atan2(dot(normal, plain.u), sign * length);
  const rounded = (radians: number) => Math.round(radians * 1800 / Math.PI) / 10 || 0;
  return [rounded(across), rounded(alongDown)];
}

/** Rotation in degrees for `turn` screen radians, optionally snapped in `step`-degree increments from where this
 * plane's untilted line would lie. Computing the snapped delta once for the held handle keeps every linked MPR plane
 * turning by the same angle so planes remain square even when the viewing pane is doubly tilted. */
export function snappedTurn(frame: PlaneFrame, mapping: ScreenMapping, series: Series, view: ViewState, turn: number, step = 0, transform: Matrix = IDENTITY): number | null {
  const start: [number, number] = [...(view.oblique ?? [0, 0])];
  const base = lineAngle(frame, mapping, series, view, start, transform);
  if (base === null) return null;
  let degrees = turn * 180 / Math.PI;
  if (step > 0) {
    const plain = lineAngle(frame, mapping, series, view, [0, 0], transform);
    const offset = plain === null ? 0 : foldLine(base - plain) * 180 / Math.PI;
    degrees = Math.round((offset + degrees) / step) * step - offset;
  }
  return degrees;
}

/** A drag that turns the plane seen as a line by `turn` screen radians from where its line was at the press (the
 * pointer's turn about the crosshair, counted on through whole turns, so the plane follows the pointer all the way
 * round with no stop or jump). The plane turns about the normal of the pane it is seen in, whatever that pane's own
 * tilt, so planes square to one another stay square, as the three-plane MPR's are. With `step` (degrees), its line
 * goes in steps of that size from where the untilted plane's line would be (Shift 5°, Ctrl 10°), so it lands exactly
 * back on 0. */
export function turnedOblique(frame: PlaneFrame, mapping: ScreenMapping, series: Series, view: ViewState, turn: number, step = 0, transform: Matrix = IDENTITY): [number, number] {
  const degrees = snappedTurn(frame, mapping, series, view, turn, step, transform);
  return degrees === null ? [...(view.oblique ?? [0, 0])] : turnPlane(mapping, series, view, degrees, transform);
}
