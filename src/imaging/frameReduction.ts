import type { PixelArray } from '../model';

type Pair = [number, number];
export interface ReducedTile { origin: Pair; size: Pair; }

/** Bounds on the global reduced grid, including both neighbours of a bilinear sample at each tile edge. */
export function reducedTile(core: [number, number, number, number], full: Pair, grid: Pair): ReducedTile {
  const origin: Pair = [0, 0], size: Pair = [0, 0];
  for (const axis of [0, 1] as const) {
    const scale = grid[axis] / full[axis];
    origin[axis] = Math.max(0, Math.floor(core[axis] * scale) - 1);
    const end = Math.min(grid[axis], Math.ceil(core[axis + 2] * scale) + 1);
    size[axis] = end - origin[axis];
  }
  return { origin, size };
}

function spans(origin: number, length: number, full: number, reduced: number) {
  return Array.from({ length }, (_, i) => {
    const start = (origin + i) * full / reduced, end = (origin + i + 1) * full / reduced;
    const first = Math.floor(start), last = Math.ceil(end) - 1;
    return { first, last, firstWeight: Math.min(end, first + 1) - start, lastWeight: end - last };
  });
}

/** Average the source pixels covered by each reduced pixel before applying the DICOM window.
 * Scalar textures carry value and valid area so interpolation can exclude padding. */
export function reduceFrame(data: PixelArray, offset: number, full: Pair, grid: Pair, tile: ReducedTile,
  color: boolean, padding?: [number, number]): Float32Array | Uint8Array {
  const coverage = !color && (!!padding || data instanceof Float32Array || data instanceof Float64Array);
  const [width, height] = tile.size, channels = color ? 3 : coverage ? 2 : 1;
  const output = color ? new Uint8Array(width * height * channels) : new Float32Array(width * height * channels);
  // Common on large integer films. Read each pair of rows once and upload only their reduced values.
  if (channels === 1 && full[0] === 2 * grid[0] && full[1] === 2 * grid[1]) {
    for (let y = 0; y < height; y++) {
      let i = offset + 2 * ((tile.origin[1] + y) * full[0] + tile.origin[0]);
      for (let x = 0; x < width; x++, i += 2) {
        output[y * width + x] = (data[i] + data[i + 1] + data[i + full[0]] + data[i + full[0] + 1]) * 0.25;
      }
    }
    return output;
  }
  const columns = spans(tile.origin[0], width, full[0], grid[0]), rows = spans(tile.origin[1], height, full[1], grid[1]);
  const area = (full[0] / grid[0]) * (full[1] / grid[1]);
  const low = padding ? Math.min(...padding) : NaN, high = padding ? Math.max(...padding) : NaN;
  let out = 0;
  for (const row of rows) for (const column of columns) {
    let sum = 0, valid = 0, green = 0, blue = 0;
    for (let y = row.first; y <= row.last; y++) {
      const wy = y === row.first ? row.firstWeight : y === row.last ? row.lastWeight : 1;
      let i = offset + (y * full[0] + column.first) * (color ? 3 : 1);
      for (let x = column.first; x <= column.last; x++) {
        const weight = wy * (x === column.first ? column.firstWeight : x === column.last ? column.lastWeight : 1);
        const v = data[i++];
        if (color) {
          sum += weight * v; green += weight * data[i++]; blue += weight * data[i++];
        } else if (Number.isFinite(v) && !(v >= low && v <= high)) {
          sum += weight * v; valid += weight;
        }
      }
    }
    if (color) {
      output[out++] = Math.round(sum / area); output[out++] = Math.round(green / area); output[out++] = Math.round(blue / area);
    } else {
      output[out++] = sum / area;
      if (coverage) output[out++] = valid / area;
    }
  }
  return output;
}
