// Rigid transforms of patient coordinates (LPS mm): a rotation and a translation, as row-major 4 × 4 matrices. The
// engine's registration returns one (native/src/registration.rs); src/imaging/registration.ts keeps them per pair of
// frames of reference.
import type { Vec3 } from '../model';

/** Row-major 4 × 4: p ↦ R p + t, R in the upper left 3 × 3, t in the last column. */
export type Matrix = readonly number[];

export const IDENTITY: Matrix = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

export const isMatrix = (value: unknown): value is Matrix => Array.isArray(value) && value.length === 16 && value.every(Number.isFinite);

export const isIdentity = (m: Matrix) => m === IDENTITY || m.every((value, index) => Math.abs(value - IDENTITY[index]) < 1e-12);

export function applyPoint(m: Matrix, p: Vec3): Vec3 {
  return [0, 1, 2].map(row => m[row * 4] * p[0] + m[row * 4 + 1] * p[1] + m[row * 4 + 2] * p[2] + m[row * 4 + 3]) as Vec3;
}

/** A direction or step: rotated, not moved. */
export function applyVector(m: Matrix, v: Vec3): Vec3 {
  return [0, 1, 2].map(row => m[row * 4] * v[0] + m[row * 4 + 1] * v[1] + m[row * 4 + 2] * v[2]) as Vec3;
}

/** `a` after `b`: p ↦ a (b p). */
export function compose(a: Matrix, b: Matrix): Matrix {
  return Array.from({ length: 16 }, (_, at) => {
    const row = Math.floor(at / 4), column = at % 4;
    return a[row * 4] * b[column] + a[row * 4 + 1] * b[4 + column] + a[row * 4 + 2] * b[8 + column] + a[row * 4 + 3] * b[12 + column];
  });
}

/** The inverse of a rigid transform: Rᵀ, −Rᵀ t. */
export function invert(m: Matrix): Matrix {
  const r = [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]];
  const t = [m[3], m[7], m[11]];
  const back = [0, 1, 2].map(row => -(r[row * 3] * t[0] + r[row * 3 + 1] * t[1] + r[row * 3 + 2] * t[2]));
  return [r[0], r[1], r[2], back[0], r[3], r[4], r[5], back[1], r[6], r[7], r[8], back[2], 0, 0, 0, 1];
}

export const translation = (shift: Vec3): Matrix => [1, 0, 0, shift[0], 0, 1, 0, shift[1], 0, 0, 1, shift[2], 0, 0, 0, 1];

/** A turn of `degrees` about the patient axis `axis` (0: x, right to left; 1: y, front to back; 2: z, feet to head),
 * right-handed, through `pivot`. */
export function rotation(axis: 0 | 1 | 2, degrees: number, pivot: Vec3): Matrix {
  const radians = degrees * Math.PI / 180, c = Math.cos(radians), s = Math.sin(radians);
  const r = axis === 0 ? [1, 0, 0, 0, c, -s, 0, s, c] : axis === 1 ? [c, 0, s, 0, 1, 0, -s, 0, c] : [c, -s, 0, s, c, 0, 0, 0, 1];
  const turned: Matrix = [r[0], r[1], r[2], 0, r[3], r[4], r[5], 0, r[6], r[7], r[8], 0, 0, 0, 0, 1];
  return compose(translation(pivot), compose(turned, translation([-pivot[0], -pivot[1], -pivot[2]])));
}

/** The whole turn the transform makes, in degrees. */
export function angleOf(m: Matrix): number {
  return Math.acos(Math.min(1, Math.max(-1, (m[0] + m[5] + m[10] - 1) / 2))) * 180 / Math.PI;
}

/** How far the transform moves `point`, in mm. */
export function displacement(m: Matrix, point: Vec3): number {
  const moved = applyPoint(m, point);
  return Math.hypot(moved[0] - point[0], moved[1] - point[1], moved[2] - point[2]);
}
