// Taking hold of a measurement drawn on the image, as in VEAcom Next: a handle moves its point, the label moves
// the label (a thin leader line then joins it to the measurement), the line moves the whole measurement.
import type { Annotation, Vec3 } from '../model';
import { add, dot, length, normalize, scale, sub } from '../imaging/geometry';
import type { Box } from './labelPlacement';

type Point2 = [number, number];
export type AnnotationPart = number | 'label' | 'body';

/** How near a handle, a line and a label a press must land (screen px), and when a leader line is drawn. */
export const HANDLE_GRAB_PX = 7;
export const LINE_GRAB_PX = 5;
export const LABEL_GRAB_PX = 3;
export const LEADER_MIN_PX = 40;
const ELLIPSE_SEGMENTS = 48;
const BOXES = new Set(['rectangle', 'ellipse']);

/** The lines of a measurement on screen, each with whether it closes on itself. */
export function screenPaths(annotation: Annotation, points: readonly Point2[]): Array<[Point2[], boolean]> {
  if (!points.length) return [];
  if (annotation.type === 'ellipse' && points.length >= 4) {
    const center: Point2 = [(points[0][0] + points[2][0]) / 2, (points[0][1] + points[2][1]) / 2];
    const rx = Math.hypot(points[1][0] - points[0][0], points[1][1] - points[0][1]) / 2;
    const ry = Math.hypot(points[3][0] - points[0][0], points[3][1] - points[0][1]) / 2;
    const angle = Math.atan2(points[1][1] - points[0][1], points[1][0] - points[0][0]), c = Math.cos(angle), s = Math.sin(angle);
    return [[Array.from({ length: ELLIPSE_SEGMENTS }, (_, i) => {
      const t = (i / ELLIPSE_SEGMENTS) * 2 * Math.PI, x = rx * Math.cos(t), y = ry * Math.sin(t);
      return [center[0] + x * c - y * s, center[1] + x * s + y * c] as Point2;
    }), true]];
  }
  // A sphere VOI is drawn as the circle the plane cuts from it: its centre, then a point on that circle.
  if (annotation.type === 'sphere' && points.length >= 2) {
    const radius = Math.hypot(points[1][0] - points[0][0], points[1][1] - points[0][1]);
    return [[Array.from({ length: ELLIPSE_SEGMENTS }, (_, i) => {
      const t = (i / ELLIPSE_SEGMENTS) * 2 * Math.PI;
      return [points[0][0] + radius * Math.cos(t), points[0][1] + radius * Math.sin(t)] as Point2;
    }), true]];
  }
  if (annotation.type === 'rectangle' || annotation.type === 'polygon') return [[[...points], points.length >= 3]];
  if (annotation.type === 'cobb') return [[points.slice(0, 2), false], ...(points.length > 2 ? [[points.slice(2), false] as [Point2[], boolean]] : [])];
  if (annotation.type === 'probe' || annotation.type === 'text') return [[[points[0]], false]];
  return [[[...points], false]];
}

function segmentPoint(at: Point2, a: Point2, b: Point2): Point2 {
  const dx = b[0] - a[0], dy = b[1] - a[1], length2 = dx * dx + dy * dy;
  const t = length2 < 1e-12 ? 0 : Math.min(1, Math.max(0, ((at[0] - a[0]) * dx + (at[1] - a[1]) * dy) / length2));
  return [a[0] + t * dx, a[1] + t * dy];
}

/** The point of the measurement's lines nearest `at`, and how far it is. */
export function nearestOnPaths(paths: Array<[Point2[], boolean]>, at: Point2): { point: Point2; distance: number } | null {
  let best: { point: Point2; distance: number } | null = null;
  for (const [path, closed] of paths) {
    const corners = closed && path.length > 2 ? [...path, path[0]] : path;
    const pieces = corners.length === 1 ? [[corners[0], corners[0]]] : corners.slice(0, -1).map((a, i) => [a, corners[i + 1]]);
    for (const [a, b] of pieces) {
      const point = segmentPoint(at, a, b), distance = Math.hypot(point[0] - at[0], point[1] - at[1]);
      if (!best || distance < best.distance) best = { point, distance };
    }
  }
  return best;
}

export interface HitTarget { annotation: Annotation; points: Point2[]; label: Box | null }

/** What of which measurement a press at `at` takes hold of: handles first, then labels, then lines; the selected
 * measurement before the others, and a later one before an earlier one. */
export function hitAnnotation(targets: readonly HitTarget[], selected: string | null, at: Point2): { annotation: Annotation; part: AnnotationPart } | null {
  const order = targets.map((target, index) => ({ target, index }))
    .sort((a, b) => Number(b.target.annotation.id === selected) - Number(a.target.annotation.id === selected) || b.index - a.index)
    .map(item => item.target);
  for (const { annotation, points } of order) {
    for (let i = 0; i < points.length; i++) if (Math.hypot(points[i][0] - at[0], points[i][1] - at[1]) <= HANDLE_GRAB_PX) return { annotation, part: i };
  }
  for (const { annotation, label } of order) {
    if (label && at[0] >= label.x - LABEL_GRAB_PX && at[0] <= label.x + label.width + LABEL_GRAB_PX
      && at[1] >= label.y - LABEL_GRAB_PX && at[1] <= label.y + label.height + LABEL_GRAB_PX) return { annotation, part: 'label' };
  }
  for (const { annotation, points } of order) {
    const near = nearestOnPaths(screenPaths(annotation, points), at);
    if (near && near.distance <= (annotation.type === 'probe' || annotation.type === 'text' ? HANDLE_GRAB_PX + 3 : LINE_GRAB_PX)) return { annotation, part: 'body' };
  }
  return null;
}

/** The points after one handle is moved to `world`. A rectangle or an ellipse keeps its shape: the opposite
 * corner stays and the two sides keep their directions. */
export function movedHandle(annotation: Annotation, index: number, world: Vec3): Vec3[] {
  const points = annotation.points.map(point => [...point] as Vec3);
  if (BOXES.has(annotation.type) && points.length === 4) {
    const opposite = points[(index + 2) % 4];
    const a = sub(points[(index + 1) % 4], opposite), b = sub(points[(index + 3) % 4], opposite);
    if (length(a) > 1e-6 && length(b) > 1e-6) {
      const u = normalize(a), v = normalize(b), d = sub(world, opposite);
      const along = scale(u, dot(d, u)), across = scale(v, dot(d, v));
      points[(index + 1) % 4] = add(opposite, along);
      points[(index + 3) % 4] = add(opposite, across);
      points[index] = add(opposite, add(along, across));
      return points;
    }
  }
  points[index] = [...world] as Vec3;
  return points;
}

/** The line joining a label moved away to its measurement: on the straight line between the label's middle and the
 * measurement's middle, from the edge of the label to the edge of the measurement (a closed shape's outline; a line
 * itself), so it reads as pointing at it; none while the label sits close to it. */
export function leaderLine(paths: Array<[Point2[], boolean]>, box: Box): [Point2, Point2] | null {
  const center: Point2 = [box.x + box.width / 2, box.y + box.height / 2];
  const closed = paths.find(([path, isClosed]) => isClosed && path.length >= 3)?.[0];
  const all = paths.flatMap(([path]) => path);
  if (!all.length) return null;
  const middle = (points: readonly Point2[]): Point2 => [points.reduce((sum, p) => sum + p[0], 0) / points.length, points.reduce((sum, p) => sum + p[1], 0) / points.length];
  // The measurement's middle: a closed shape's centre, or the point of an open one nearest its middle.
  const target = closed ? middle(closed) : nearestOnPaths(paths, middle(all))?.point;
  if (!target) return null;
  const dx = target[0] - center[0], dy = target[1] - center[1];
  // Where the line leaves the label's box.
  const exit = Math.min(Math.abs(dx) > 1e-9 ? (box.width / 2) / Math.abs(dx) : Infinity, Math.abs(dy) > 1e-9 ? (box.height / 2) / Math.abs(dy) : Infinity);
  if (exit >= 1) return null;
  const start: Point2 = [center[0] + dx * exit, center[1] + dy * exit];
  // Where it meets a closed shape's outline: the crossing nearest the label.
  let end = target;
  if (closed) {
    let best = Infinity;
    for (let i = 0; i < closed.length; i++) {
      const a = closed[i], b = closed[(i + 1) % closed.length];
      const ex = b[0] - a[0], ey = b[1] - a[1], denominator = dx * ey - dy * ex;
      if (Math.abs(denominator) < 1e-12) continue;
      const t = ((a[0] - center[0]) * ey - (a[1] - center[1]) * ex) / denominator, u = ((a[0] - center[0]) * dy - (a[1] - center[1]) * dx) / denominator;
      if (t >= 0 && t <= 1 && u >= 0 && u <= 1 && t < best) { best = t; end = [center[0] + dx * t, center[1] + dy * t]; }
    }
  }
  return Math.hypot(end[0] - start[0], end[1] - start[1]) > LEADER_MIN_PX ? [end, start] : null;
}
