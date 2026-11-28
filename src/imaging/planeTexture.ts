import type { PixelArray, Vec3 } from '../model';

export interface PlaneTexture { start: Vec3; size: Vec3 }

/** A thin reconstruction parallel to a voxel axis reads only neighbouring planes along that axis. */
export function planeTexture(dimensions: Vec3, topLeft: Vec3, right: Vec3, down: Vec3, width: number, height: number): PlaneTexture | undefined {
  for (const axis of [0, 1, 2] as const) {
    const across = right[axis] * width, along = down[axis] * height;
    if (dimensions[axis] < 64 || !(Math.abs(across) + Math.abs(along) <= 0.001) || !Number.isFinite(topLeft[axis])) continue;
    const middle = topLeft[axis] + (across + along) / 2;
    const nearest = Math.max(0, Math.min(dimensions[axis] - 1, Math.round(middle)));
    // The original padded eight-plane uploads changed on integer slices 6, 10, 14, etc.
    // Keep the same wheel steps cached, including the wider groups at the volume borders.
    const block = Math.floor((nearest + 2) / 4) * 4 - 2;
    const lastBlock = Math.floor((dimensions[axis] - 1) / 8) * 8 + 2;
    const firstCenter = nearest < 6 ? 0 : Math.min(block, lastBlock);
    const pastCenters = nearest >= lastBlock ? dimensions[axis] : Math.max(6, block + 4);
    // One neighbour on either side covers trilinear interpolation up to half a voxel from each centre.
    const first = Math.max(0, firstCenter - 1);
    const end = Math.min(dimensions[axis], pastCenters + 1);
    const start: Vec3 = [0, 0, 0], size: Vec3 = [...dimensions];
    start[axis] = first;
    size[axis] = end - first;
    return { start, size };
  }
}

/** Pack the same source samples in x-fastest order. Axial planes already occupy consecutive memory. */
export function planePixels(data: PixelArray, dimensions: Vec3, region: PlaneTexture): PixelArray {
  const [nx, ny] = dimensions, [x0, y0, z0] = region.start, [w, h, d] = region.size;
  const planeStride = nx * ny;
  const first = (z0 * ny + y0) * nx + x0;
  if (w === nx && h === ny) return data.subarray(first, first + w * h * d);
  const ArrayType = data.constructor as { new(length: number): PixelArray };
  const packed = new ArrayType(w * h * d);
  let at = 0;
  if (w === nx) {
    const chunk = w * h;
    for (let z = 0; z < d; z++) {
      const plane = first + z * planeStride;
      packed.set(data.subarray(plane, plane + chunk), at);
      at += chunk;
    }
    return packed;
  }
  if (w === 6) {
    for (let z = 0; z < d; z++) {
      let row = first + z * planeStride;
      for (let y = 0; y < h; y++, row += nx) {
        packed[at] = data[row];
        packed[at + 1] = data[row + 1];
        packed[at + 2] = data[row + 2];
        packed[at + 3] = data[row + 3];
        packed[at + 4] = data[row + 4];
        packed[at + 5] = data[row + 5];
        at += 6;
      }
    }
    return packed;
  }
  for (let z = 0; z < d; z++) {
    let row = first + z * planeStride;
    for (let y = 0; y < h; y++, row += nx) {
      for (let x = 0; x < w; x++) packed[at++] = data[row + x];
    }
  }
  return packed;
}
