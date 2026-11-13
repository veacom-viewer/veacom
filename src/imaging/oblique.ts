// Oblique MPR with handles, as in VEAcom Next: in the three-plane MPR each pane draws where the other two planes cut it,
// with a handle at both ends of each line. Dragging a handle turns that other plane about the crosshair, around this
// pane's normal, so its line follows the pointer.
import type { Plane, Series, ViewState } from '../model';
import { add, cross, dot, getPlaneFrame, planeAxes, planeIntersection, rotateAround, worldToScreen, type PlaneFrame, type ScreenMapping } from './geometry';
import { frameThrough } from './registration';
import { applyVector, invert, type Matrix } from './rigid';

/** Which of a plane's two oblique angles turns it about the normal of the pane it is seen in: the first turns a plane
 * about its own across axis, the second about its own down axis (geometry.planeAxes). */
export function rotationComponent(moved: Plane, seen: Plane): 0 | 1 {
  if (moved === 'axial') return seen === 'sagittal' ? 0 : 1;
  if (moved === 'coronal') return seen === 'sagittal' ? 0 : 1;
  return seen === 'coronal' ? 0 : 1; // sagittal: about y in the coronal pane, about z in the axial one
}

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
function turnRegistered(mapping: ScreenMapping, series: Series, view: ViewState, transform: Matrix, degrees: number): [number, number] {
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

/** A drag that turns the plane seen as a line by `turn` screen radians from where its line was at the press (the
 * pointer's turn about the crosshair, counted on through whole turns, so the plane follows the pointer all the way
 * round with no stop or jump). With `step` (degrees), the plane's angle goes in steps of that size (Shift 5°, Ctrl
 * 10°), so it lands exactly back on 0. */
export function turnedOblique(frame: PlaneFrame, mapping: ScreenMapping, series: Series, view: ViewState, component: 0 | 1, turn: number, step = 0, transform?: Matrix): [number, number] {
  const start: [number, number] = [...(view.oblique ?? [0, 0])];
  if (transform) {
    const base = lineAngle(frame, mapping, series, view, start, transform);
    if (base === null) return start;
    let degrees = turn * 180 / Math.PI;
    if (step > 0) {
      const plain = lineAngle(frame, mapping, series, view, [0, 0], transform);
      const offset = plain === null ? 0 : foldLine(base - plain) * 180 / Math.PI;
      degrees = Math.round((offset + degrees) / step) * step - offset;
    }
    return turnRegistered(mapping, series, view, transform, degrees);
  }
  const at = (degrees: number): [number, number] => { const next: [number, number] = [...start]; next[component] = degrees; return next; };
  const base = lineAngle(frame, mapping, series, view, start);
  const probe = lineAngle(frame, mapping, series, view, at(start[component] + 1));
  if (base === null || probe === null) return start;
  // Which way the line turns as the angle grows, in this pane.
  const way = foldLine(probe - base) < 0 ? -1 : 1;
  const target = base + turn;
  let degrees = start[component] + way * turn * 180 / Math.PI;
  for (let i = 0; i < 3; i++) {
    const now = lineAngle(frame, mapping, series, view, at(degrees));
    if (now === null) break;
    const error = foldLine(now - target);
    if (Math.abs(error) < 1e-4) break;
    degrees -= way * error * 180 / Math.PI;
  }
  if (step > 0) degrees = Math.round(degrees / step) * step;
  // A whole turn brings the plane back: kept within (-180°, 180°].
  degrees = ((degrees + 180) % 360 + 360) % 360 - 180;
  if (degrees === -180) degrees = 180;
  return at(Math.round(degrees * 10) / 10 || 0);
}
