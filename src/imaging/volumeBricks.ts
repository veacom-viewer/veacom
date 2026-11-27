import type { PixelArray, Vec3, Volume } from '../model';
import type { PlaneTexture } from './planeTexture';

export interface VolumeBrick {
  /** Half-open logical voxel bounds [coreMin, coreMax) owned by this brick. */
  coreMin: Vec3;
  coreMax: Vec3;
  /** Half-open shader clip bounds in voxel-center coordinates (-1e9 / +1e9 on outer volume faces). */
  clipMin: Vec3;
  clipMax: Vec3;
  /** Padded 3D sub-box uploaded to the GPU (each region.size[axis] <= max3DTextureSize). */
  region: PlaneTexture;
}

interface DisplayVolumeLevel {
  stride: Vec3;
  dimensions: Vec3;
  downsampled: boolean;
  data: Float32Array | Int16Array | Uint16Array | Uint8Array;
  mask: Uint8Array;
}

/** True when any volume axis exceeds a single GPU 3D texture dimension and requires bricking or display scaling. */
export function needsBricking(dimensions: Vec3, max3DTextureSize: number): boolean {
  return dimensions.some(dimension => dimension > max3DTextureSize);
}

/**
 * Maps a full-resolution voxel-center coordinate along one axis uniformly onto the downsampled display grid so
 * the full volume domain `[-0.5, fullDim - 0.5]` maps exactly onto `[-0.5, displayDim - 0.5]`.
 */
export function fullToDisplayCoord(coord: number, fullDim: number, displayDim: number): number {
  return fullDim === displayDim ? coord : ((coord + 0.5) * displayDim) / fullDim - 0.5;
}

function splitAxis(start: number, end: number, maxCore: number): Array<[number, number]> {
  const span = end - start;
  if (span <= maxCore) return [[start, end]];
  const parts = Math.ceil(span / maxCore);
  const step = Math.ceil(span / parts);
  const ranges: Array<[number, number]> = [];
  for (let at = start; at < end; at += step) ranges.push([at, Math.min(end, at + step)]);
  return ranges;
}

/** Upper bound on bricks planned for a single 2D slice draw so pathological geometry cannot hang or OOM the UI. */
export const MAX_SLICE_BRICKS = 64;

/**
 * Partitions the visible voxel domain of a slice or thick slab into disjoint brick cores padded with interpolation
 * and slab halos so every brick fits inside `max3DTextureSize` along all three axes. Returns `[]` when the slice lies
 * outside the volume, or `null` when partitioning would exceed `maxBricks`.
 */
export function planSliceBricks(
  dimensions: Vec3,
  topLeft: Vec3,
  right: Vec3,
  down: Vec3,
  width: number,
  height: number,
  max3DTextureSize: number,
  slabStep?: Vec3,
  slabHalf = 0,
  maxBricks = MAX_SLICE_BRICKS,
): VolumeBrick[] | null {
  if (max3DTextureSize < 4 || width <= 0 || height <= 0 || maxBricks < 1) return [];
  const minCorner: Vec3 = [Infinity, Infinity, Infinity];
  const maxCorner: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const sx of [0, width]) for (const sy of [0, height]) {
    for (let axis = 0; axis < 3; axis++) {
      const value = topLeft[axis] + right[axis] * sx + down[axis] * sy;
      if (!Number.isFinite(value)) return [];
      if (value < minCorner[axis]) minCorner[axis] = value;
      if (value > maxCorner[axis]) maxCorner[axis] = value;
    }
  }
  const coreStart: Vec3 = [0, 0, 0];
  const coreEnd: Vec3 = [0, 0, 0];
  const halo: Vec3 = [1, 1, 1];
  // Reserve at least half of each 3D texture dimension for brick cores so thick slabs or extreme zoom-out cannot
  // shrink cores to a couple of voxels and multiply brick counts.
  const maxHalo = Math.max(1, Math.floor(max3DTextureSize / 4));
  const maxPlaneReach = Math.max(1, Math.floor(max3DTextureSize / 8));

  for (let axis = 0; axis < 3; axis++) {
    if (maxCorner[axis] < -0.5 || minCorner[axis] > dimensions[axis] - 0.5) return [];
    const slabReach = slabStep && slabHalf > 0 ? Math.ceil(Math.abs(slabStep[axis] * slabHalf)) : 0;
    const planeReach = Math.min(maxPlaneReach, Math.ceil(0.5 * (Math.abs(right[axis]) + Math.abs(down[axis]))));
    halo[axis] = Math.min(maxHalo, 1 + slabReach + planeReach);
    coreStart[axis] = Math.max(0, Math.floor(minCorner[axis]));
    coreEnd[axis] = Math.min(dimensions[axis], Math.ceil(maxCorner[axis]) + 1);
    if (coreStart[axis] >= coreEnd[axis]) return [];
  }

  const splits = [0, 1, 2].map(axis => {
    const maxCore = Math.max(1, max3DTextureSize - 2 * halo[axis]);
    return splitAxis(coreStart[axis], coreEnd[axis], maxCore);
  });
  const totalBricks = splits[0].length * splits[1].length * splits[2].length;
  if (totalBricks > maxBricks) return null;

  const bricks: VolumeBrick[] = [];
  for (const [x0, x1] of splits[0]) {
    for (const [y0, y1] of splits[1]) {
      for (const [z0, z1] of splits[2]) {
        const coreMin: Vec3 = [x0, y0, z0];
        const coreMax: Vec3 = [x1, y1, z1];
        const regionStart: Vec3 = [
          Math.max(0, x0 - halo[0]),
          Math.max(0, y0 - halo[1]),
          Math.max(0, z0 - halo[2]),
        ];
        const regionEnd: Vec3 = [
          Math.min(dimensions[0], x1 + halo[0]),
          Math.min(dimensions[1], y1 + halo[1]),
          Math.min(dimensions[2], z1 + halo[2]),
        ];
        const clipMin: Vec3 = [
          x0 === coreStart[0] ? -1e9 : x0 - 0.5,
          y0 === coreStart[1] ? -1e9 : y0 - 0.5,
          z0 === coreStart[2] ? -1e9 : z0 - 0.5,
        ];
        const clipMax: Vec3 = [
          x1 === coreEnd[0] ? 1e9 : x1 - 0.5,
          y1 === coreEnd[1] ? 1e9 : y1 - 0.5,
          z1 === coreEnd[2] ? 1e9 : z1 - 0.5,
        ];
        bricks.push({
          coreMin,
          coreMax,
          clipMin,
          clipMax,
          region: {
            start: regionStart,
            size: [
              regionEnd[0] - regionStart[0],
              regionEnd[1] - regionStart[1],
              regionEnd[2] - regionStart[2],
            ],
          },
        });
      }
    }
  }
  return bricks;
}

/** Minimal integer stride per axis so a 3D display texture fits inside `max3DTextureSize`. */
export function displayStride(dimensions: Vec3, max3DTextureSize: number): Vec3 {
  const limit = Math.max(1, max3DTextureSize);
  return [
    Math.max(1, Math.ceil(dimensions[0] / limit)),
    Math.max(1, Math.ceil(dimensions[1] / limit)),
    Math.max(1, Math.ceil(dimensions[2] / limit)),
  ];
}

function allocateDisplayArray(source: PixelArray, length: number): Float32Array | Int16Array | Uint16Array | Uint8Array {
  if (source instanceof Int16Array) return new Int16Array(length);
  if (source instanceof Uint16Array) return new Uint16Array(length);
  if (source instanceof Uint8Array) return new Uint8Array(length);
  return new Float32Array(length);
}

/**
 * Precomputes the full-resolution voxel index span `[start, end)` and fractional overlap weight for each display
 * voxel along one axis so non-multiple dimensions preserve exact physical length and uniform voxel spacing.
 */
function axisFootprints(fullDim: number, displayDim: number): Array<{ start: number; end: number; weights: number[] }> {
  const step = fullDim / displayDim;
  const footprints: Array<{ start: number; end: number; weights: number[] }> = [];
  for (let d = 0; d < displayDim; d++) {
    const low = d * step;
    const high = d + 1 === displayDim ? fullDim : (d + 1) * step;
    const start = Math.max(0, Math.floor(low + 1e-9));
    const end = Math.min(fullDim, Math.max(start + 1, Math.ceil(high - 1e-9)));
    const weights: number[] = [];
    for (let i = start; i < end; i++) {
      weights.push(Math.max(0, Math.min(i + 1, high) - Math.max(i, low)));
    }
    footprints.push({ start, end, weights });
  }
  return footprints;
}

/**
 * Builds a bounded 3D GPU display level when a volume exceeds `max3DTextureSize` along any axis.
 * Source `volume.data` and full-resolution `fullMask` remain untouched for exact picking, burring, and STL export.
 */
export function buildDisplayVolume(volume: Volume, fullMask: Uint8Array, max3DTextureSize: number): DisplayVolumeLevel {
  const fullDims = volume.series.dimensions;
  const stride = displayStride(fullDims, max3DTextureSize);
  const downsampled = stride[0] > 1 || stride[1] > 1 || stride[2] > 1;
  const isDouble = volume.data instanceof Float64Array;

  if (!downsampled) {
    if (!isDouble) {
      return {
        stride,
        dimensions: [...fullDims],
        downsampled: false,
        data: volume.data as Float32Array | Int16Array | Uint16Array | Uint8Array,
        mask: fullMask,
      };
    }
    const copy = new Float32Array(volume.data.length);
    for (let i = 0; i < copy.length; i++) {
      const value = volume.data[i];
      copy[i] = Number.isFinite(value) && fullMask[i] !== 3 ? value : NaN;
    }
    return { stride, dimensions: [...fullDims], downsampled: false, data: copy, mask: fullMask };
  }

  const [nx, ny, nz] = fullDims;
  const [sx, sy, sz] = stride;
  const dims: Vec3 = [Math.ceil(nx / sx), Math.ceil(ny / sy), Math.ceil(nz / sz)];
  const [dxLen, dyLen, dzLen] = dims;
  const total = dxLen * dyLen * dzLen;
  const outData = allocateDisplayArray(volume.data, total);
  const outMask = new Uint8Array(total);
  const isInteger = !(outData instanceof Float32Array);
  const plane = nx * ny;
  const xFoot = axisFootprints(nx, dxLen);
  const yFoot = axisFootprints(ny, dyLen);
  const zFoot = axisFootprints(nz, dzLen);

  for (let dz = 0; dz < dzLen; dz++) {
    const zf = zFoot[dz];
    for (let dy = 0; dy < dyLen; dy++) {
      const yf = yFoot[dy];
      for (let dx = 0; dx < dxLen; dx++) {
        const xf = xFoot[dx];
        let sum = 0, weightSum = 0, unmaskedWeight = 0, carvedWeight = 0, excludedWeight = 0;
        for (let z = zf.start; z < zf.end; z++) {
          const wz = zf.weights[z - zf.start];
          const zBase = z * plane;
          for (let y = yf.start; y < yf.end; y++) {
            const wzy = wz * yf.weights[y - yf.start];
            const row = zBase + y * nx;
            for (let x = xf.start; x < xf.end; x++) {
              const w = wzy * xf.weights[x - xf.start];
              if (w <= 0) continue;
              const index = row + x;
              const m = fullMask[index];
              const value = volume.data[index];
              if (m === 3 || !Number.isFinite(value)) continue;
              sum += value * w;
              weightSum += w;
              if (m === 0) unmaskedWeight += w;
              else if (m === 1) carvedWeight += w;
              else if (m === 2) excludedWeight += w;
            }
          }
        }
        const outIndex = (dz * dyLen + dy) * dxLen + dx;
        if (weightSum <= 0) {
          outMask[outIndex] = 3;
          outData[outIndex] = isInteger ? 0 : NaN;
        } else {
          const mean = sum / weightSum;
          outData[outIndex] = isInteger ? Math.round(mean) : mean;
          outMask[outIndex] = unmaskedWeight > 0 ? 0 : carvedWeight >= excludedWeight ? 1 : 2;
        }
      }
    }
  }
  return { stride, dimensions: dims, downsampled: true, data: outData, mask: outMask };
}

/** Recomputes the display-level mask voxels covering full-resolution box `[min, max]` (inclusive). */
export function syncDisplayMaskBox(
  fullMask: Uint8Array,
  fullDims: Vec3,
  displayMask: Uint8Array,
  displayDims: Vec3,
  min: Vec3,
  max: Vec3,
): { min: Vec3; max: Vec3 } {
  const [nx, ny, nz] = fullDims;
  const [dxLen, dyLen, dzLen] = displayDims;
  const dMin: Vec3 = [
    Math.max(0, Math.floor((min[0] * dxLen) / nx)),
    Math.max(0, Math.floor((min[1] * dyLen) / ny)),
    Math.max(0, Math.floor((min[2] * dzLen) / nz)),
  ];
  const dMax: Vec3 = [
    Math.min(dxLen - 1, Math.max(dMin[0], Math.ceil(((max[0] + 1) * dxLen) / nx - 1e-9) - 1)),
    Math.min(dyLen - 1, Math.max(dMin[1], Math.ceil(((max[1] + 1) * dyLen) / ny - 1e-9) - 1)),
    Math.min(dzLen - 1, Math.max(dMin[2], Math.ceil(((max[2] + 1) * dzLen) / nz - 1e-9) - 1)),
  ];
  const plane = nx * ny;
  const stepX = nx / dxLen, stepY = ny / dyLen, stepZ = nz / dzLen;
  for (let dz = dMin[2]; dz <= dMax[2]; dz++) {
    const z0 = Math.max(0, Math.floor(dz * stepZ + 1e-9));
    const z1 = Math.min(nz, Math.max(z0 + 1, Math.ceil((dz + 1) * stepZ - 1e-9)));
    for (let dy = dMin[1]; dy <= dMax[1]; dy++) {
      const y0 = Math.max(0, Math.floor(dy * stepY + 1e-9));
      const y1 = Math.min(ny, Math.max(y0 + 1, Math.ceil((dy + 1) * stepY - 1e-9)));
      for (let dx = dMin[0]; dx <= dMax[0]; dx++) {
        const x0 = Math.max(0, Math.floor(dx * stepX + 1e-9));
        const x1 = Math.min(nx, Math.max(x0 + 1, Math.ceil((dx + 1) * stepX - 1e-9)));
        let unmasked = 0, carved = 0, excluded = 0, valid = 0;
        for (let z = z0; z < z1; z++) {
          const zBase = z * plane;
          for (let y = y0; y < y1; y++) {
            const row = zBase + y * nx;
            for (let x = x0; x < x1; x++) {
              const m = fullMask[row + x];
              if (m === 3) continue;
              valid++;
              if (m === 0) unmasked++;
              else if (m === 1) carved++;
              else if (m === 2) excluded++;
            }
          }
        }
        const outIndex = (dz * dyLen + dy) * dxLen + dx;
        displayMask[outIndex] = valid === 0 ? 3 : unmasked > 0 ? 0 : carved >= excluded ? 1 : 2;
      }
    }
  }
  return { min: dMin, max: dMax };
}

/** Downsamples a segmentation label sub-box to match a downsampled 3D display volume. */
export function downsampleLabelSubbox(
  labels: Uint8Array,
  min: Vec3,
  size: Vec3,
  fullDims: Vec3,
  displayDims: Vec3,
): { labels: Uint8Array; min: Vec3; size: Vec3 } {
  if (fullDims[0] === displayDims[0] && fullDims[1] === displayDims[1] && fullDims[2] === displayDims[2]) {
    return { labels, min, size };
  }
  const dMin: Vec3 = [
    Math.max(0, Math.floor((min[0] * displayDims[0]) / fullDims[0])),
    Math.max(0, Math.floor((min[1] * displayDims[1]) / fullDims[1])),
    Math.max(0, Math.floor((min[2] * displayDims[2]) / fullDims[2])),
  ];
  const dEnd: Vec3 = [
    Math.min(displayDims[0], Math.max(dMin[0] + 1, Math.ceil(((min[0] + size[0]) * displayDims[0]) / fullDims[0] - 1e-9))),
    Math.min(displayDims[1], Math.max(dMin[1] + 1, Math.ceil(((min[1] + size[1]) * displayDims[1]) / fullDims[1] - 1e-9))),
    Math.min(displayDims[2], Math.max(dMin[2] + 1, Math.ceil(((min[2] + size[2]) * displayDims[2]) / fullDims[2] - 1e-9))),
  ];
  const dSize: Vec3 = [Math.max(1, dEnd[0] - dMin[0]), Math.max(1, dEnd[1] - dMin[1]), Math.max(1, dEnd[2] - dMin[2])];
  const out = new Uint8Array(dSize[0] * dSize[1] * dSize[2]);
  const srcPlane = size[0] * size[1];
  const stepX = fullDims[0] / displayDims[0], stepY = fullDims[1] / displayDims[1], stepZ = fullDims[2] / displayDims[2];
  for (let dz = 0; dz < dSize[2]; dz++) {
    const z0 = Math.max(min[2], Math.floor((dMin[2] + dz) * stepZ + 1e-9));
    const z1 = Math.min(min[2] + size[2], Math.max(z0 + 1, Math.ceil((dMin[2] + dz + 1) * stepZ - 1e-9)));
    for (let dy = 0; dy < dSize[1]; dy++) {
      const y0 = Math.max(min[1], Math.floor((dMin[1] + dy) * stepY + 1e-9));
      const y1 = Math.min(min[1] + size[1], Math.max(y0 + 1, Math.ceil((dMin[1] + dy + 1) * stepY - 1e-9)));
      for (let dx = 0; dx < dSize[0]; dx++) {
        const x0 = Math.max(min[0], Math.floor((dMin[0] + dx) * stepX + 1e-9));
        const x1 = Math.min(min[0] + size[0], Math.max(x0 + 1, Math.ceil((dMin[0] + dx + 1) * stepX - 1e-9)));
        let chosen = 0;
        for (let z = z0; z < z1 && !chosen; z++) {
          const zBase = (z - min[2]) * srcPlane;
          for (let y = y0; y < y1 && !chosen; y++) {
            const row = zBase + (y - min[1]) * size[0];
            for (let x = x0; x < x1; x++) {
              const label = labels[row + (x - min[0])];
              if (label > 0) { chosen = label; break; }
            }
          }
        }
        out[(dz * dSize[1] + dy) * dSize[0] + dx] = chosen;
      }
    }
  }
  return { labels: out, min: dMin, size: dSize };
}
