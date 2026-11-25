import type { PixelArray, Vec3 } from '../model';

export interface PlaneTexture { start: Vec3; size: Vec3 }

/** A thin reconstruction parallel to a voxel axis reads only neighbouring planes along that axis. */
export function planeTexture(dimensions: Vec3, topLeft: Vec3, right: Vec3, down: Vec3, width: number, height: number): PlaneTexture | undefined {
  for (const axis of [0, 1, 2] as const) {
    const across = right[axis] * width, along = down[axis] * height;
    if (dimensions[axis] < 64 || !(Math.abs(across) + Math.abs(along) <= 0.001) || !Number.isFinite(topLeft[axis])) continue;
    const low = topLeft[axis] + Math.min(0, across) + Math.min(0, along);
    const high = topLeft[axis] + Math.max(0, across) + Math.max(0, along);
    const last = dimensions[axis] - 1;
    // Include both trilinear neighbours, edge clamping and round-off. Nearby slices share one upload.
    const first = Math.floor(Math.max(0, Math.min(last, low - 2)) / 8) * 8;
    const end = Math.min(dimensions[axis], (Math.floor(Math.max(0, Math.min(last, high + 2)) / 8) + 1) * 8);
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
