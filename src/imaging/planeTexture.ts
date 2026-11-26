import type { PixelArray, Vec3 } from '../model';

export interface PlaneTexture { start: Vec3; size: Vec3 }

const PLANES_PER_BLOCK = 4;

/** A thin reconstruction parallel to a voxel axis reads only neighbouring planes along that axis. */
export function planeTexture(dimensions: Vec3, topLeft: Vec3, right: Vec3, down: Vec3, width: number, height: number): PlaneTexture | undefined {
  for (const axis of [0, 1, 2] as const) {
    const across = right[axis] * width, along = down[axis] * height;
    if (dimensions[axis] < 64 || !(Math.abs(across) + Math.abs(along) <= 0.001) || !Number.isFinite(topLeft[axis])) continue;
    const middle = topLeft[axis] + (across + along) / 2;
    const nearest = Math.max(0, Math.min(dimensions[axis] - 1, Math.round(middle)));
    const block = Math.floor(nearest / PLANES_PER_BLOCK) * PLANES_PER_BLOCK;
    // The block covers four slice centres and one extra voxel at each end for trilinear interpolation.
    const first = Math.max(0, block - 1);
    const end = Math.min(dimensions[axis], block + PLANES_PER_BLOCK + 1);
    const start: Vec3 = [0, 0, 0], size: Vec3 = [...dimensions];
    start[axis] = first;
    size[axis] = end - first;
    return { start, size };
  }
}

/** Pack the same source samples in x-fastest order. Axial planes already occupy consecutive memory. */
export function planePixels(data: PixelArray, dimensions: Vec3, region: PlaneTexture): PixelArray {
  const [nx, ny] = dimensions, [x0, y0, z0] = region.start, [w, h, d] = region.size;
  const first = (z0 * ny + y0) * nx + x0;
  if (w === nx && h === ny) return data.subarray(first, first + w * h * d);
  const ArrayType = data.constructor as { new(length: number): PixelArray };
  const packed = new ArrayType(w * h * d);
  let at = 0;
  for (let z = 0; z < d; z++) {
    const plane = first + z * nx * ny;
    if (w === nx) {
      packed.set(data.subarray(plane, plane + w * h), at);
      at += w * h;
    } else for (let y = 0; y < h; y++) {
      const row = plane + y * nx;
      for (let x = 0; x < w; x++) packed[at++] = data[row + x];
    }
  }
  return packed;
}
