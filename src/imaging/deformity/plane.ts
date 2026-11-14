// Plane geometry for the deformity kit, in float64 with no DOM: points, lines, circles and rigid motions. A point is
// [x, y] with y pointing down the image, in pixels or in millimetres (measure.ts converts). `rotate` turns from +x
// towards +y, which is clockwise on an image shown without flips.
export type Point = readonly [number, number];

export const add = (a: Point, b: Point): Point => [a[0] + b[0], a[1] + b[1]];
export const sub = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1]];
export const scale = (a: Point, s: number): Point => [a[0] * s, a[1] * s];
export const dot = (a: Point, b: Point) => a[0] * b[0] + a[1] * b[1];
export const cross = (a: Point, b: Point) => a[0] * b[1] - a[1] * b[0];
export const length = (a: Point) => Math.hypot(a[0], a[1]);
export const distance = (a: Point, b: Point) => length(sub(a, b));
export const midpoint = (a: Point, b: Point): Point => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const DEGREE = Math.PI / 180;

export function unit(a: Point): Point | null {
  const size = length(a);
  return size > 1e-12 && Number.isFinite(size) ? [a[0] / size, a[1] / size] : null;
}
/** The unit direction across a unit axis towards the indicated side, or null if the directions are parallel. */
export function acrossAxis(axis: Point, side: Point): Point | null {
  return unit(sub(side, scale(axis, dot(side, axis))));
}
export function rotate(v: Point, degrees: number): Point {
  const c = Math.cos(degrees * DEGREE), s = Math.sin(degrees * DEGREE);
  return [v[0] * c - v[1] * s, v[0] * s + v[1] * c];
}
/** The angle between two directions, 0–180°, or null when either has no length. */
export function angleBetween(a: Point, b: Point): number | null {
  const u = unit(a), v = unit(b);
  return u && v ? Math.acos(Math.max(-1, Math.min(1, dot(u, v)))) / DEGREE : null;
}
/** The turn from `a` to `b`, −180 to 180°, positive from +x towards +y. */
export function signedAngle(a: Point, b: Point): number {
  return Math.atan2(cross(a, b), dot(a, b)) / DEGREE;
}

/** Where two lines (a point and a direction each) cross, or null when they are parallel within 0.01°. */
export function intersect(p: Point, d: Point, q: Point, e: Point): Point | null {
  const denominator = cross(d, e);
  if (Math.abs(denominator) <= Math.sin(0.01 * DEGREE) * length(d) * length(e)) return null;
  return add(p, scale(d, cross(sub(q, p), e) / denominator));
}
/** The signed distance of `p` from the line through `a` along `direction`, positive towards `side`. */
export function offsetFrom(p: Point, a: Point, direction: Point, side: Point): number | null {
  const d = unit(direction);
  if (!d) return null;
  const normal: Point = [-d[1], d[0]], sign = Math.sign(dot(normal, side)) || 1;
  return dot(sub(p, a), normal) * sign;
}
/** Where `p` falls along a to b: 0 at a, 1 at b. */
export function along(p: Point, a: Point, b: Point): number | null {
  const ab = sub(b, a), size = dot(ab, ab);
  return size > 1e-24 ? dot(sub(p, a), ab) / size : null;
}

/**
 * The circle through three or more points, by least squares on the algebraic distance (Kåsa 1976), then refined by
 * Gauss–Newton on the geometric distance. Three points give the circumcircle exactly. Null when the points lie on a
 * line. `residual`: the root mean square of the points' distances from the circle.
 */
export function fitCircle(points: readonly Point[]): { centre: Point; radius: number; residual: number } | null {
  if (points.length < 3 || points.some(p => !p.every(Number.isFinite))) return null;
  // Centred on the mean, so large pixel coordinates do not cost precision.
  const mean: Point = [points.reduce((s, p) => s + p[0], 0) / points.length, points.reduce((s, p) => s + p[1], 0) / points.length];
  const local = points.map(p => sub(p, mean));
  let suu = 0, suv = 0, svv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
  for (const [u, v] of local) { suu += u * u; suv += u * v; svv += v * v; suuu += u * u * u; svvv += v * v * v; suvv += u * v * v; svuu += v * u * u; }
  const determinant = suu * svv - suv * suv, scaleSize = (suu + svv) ** 2;
  if (!(Math.abs(determinant) > 1e-12 * scaleSize)) return null;
  const bu = (suuu + suvv) / 2, bv = (svvv + svuu) / 2;
  let centre: Point = [(bu * svv - bv * suv) / determinant, (bv * suu - bu * suv) / determinant];
  let radius = Math.sqrt(dot(centre, centre) + (suu + svv) / points.length);
  for (let iteration = 0; iteration < 20; iteration++) {
    // Normal equations of the geometric fit for (cx, cy, r).
    const a = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0];
    for (const p of local) {
      const d = distance(p, centre);
      if (d < 1e-12) continue;
      const row = [(centre[0] - p[0]) / d, (centre[1] - p[1]) / d, -1], residual = d - radius;
      for (let i = 0; i < 3; i++) { b[i] -= row[i] * residual; for (let j = 0; j < 3; j++) a[i][j] += row[i] * row[j]; }
    }
    const step = solve3(a, b);
    if (!step) break;
    centre = [centre[0] + step[0], centre[1] + step[1]]; radius += step[2];
    if (Math.hypot(...step) < 1e-12 * Math.max(1, radius)) break;
  }
  if (!(radius > 0) || !centre.every(Number.isFinite)) return null;
  const residual = Math.sqrt(local.reduce((sum, p) => sum + (distance(p, centre) - radius) ** 2, 0) / points.length);
  return { centre: add(centre, mean), radius, residual };
}

function solve3(a: number[][], b: number[]): number[] | null {
  const m = a.map((row, i) => [...row, b[i]]);
  for (let column = 0; column < 3; column++) {
    let pivot = column;
    for (let row = column + 1; row < 3; row++) if (Math.abs(m[row][column]) > Math.abs(m[pivot][column])) pivot = row;
    if (Math.abs(m[pivot][column]) < 1e-14) return null;
    [m[column], m[pivot]] = [m[pivot], m[column]];
    for (let row = 0; row < 3; row++) {
      if (row === column) continue;
      const factor = m[row][column] / m[column][column];
      for (let k = column; k < 4; k++) m[row][k] -= factor * m[column][k];
    }
  }
  return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
}

/** A rigid motion: a turn of `degrees` about `pivot`, then a shift by `shift`. */
export interface Rigid { pivot: Point; degrees: number; shift: Point }
export const IDENTITY: Rigid = { pivot: [0, 0], degrees: 0, shift: [0, 0] };
export function applyRigid(motion: Rigid, p: Point): Point {
  return add(add(motion.pivot, rotate(sub(p, motion.pivot), motion.degrees)), motion.shift);
}

/** Whether `p` lies inside the polygon (even–odd rule). */
export function inside(p: Point, polygon: readonly Point[]): boolean {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) hit = !hit;
  }
  return hit;
}

/** The value of x in [low, high] where `f` changes sign, by bisection to 1e-9, or null when it does not. */
export function bisect(f: (x: number) => number, low: number, high: number): number | null {
  let fl = f(low), fh = f(high);
  if (!Number.isFinite(fl) || !Number.isFinite(fh) || Math.sign(fl) === Math.sign(fh)) return fl === 0 ? low : fh === 0 ? high : null;
  for (let i = 0; i < 200 && high - low > 1e-9; i++) {
    const middle = (low + high) / 2, fm = f(middle);
    if (!Number.isFinite(fm)) return null;
    if (Math.sign(fm) === Math.sign(fl)) { low = middle; fl = fm; } else { high = middle; fh = fm; }
  }
  return (low + high) / 2;
}
