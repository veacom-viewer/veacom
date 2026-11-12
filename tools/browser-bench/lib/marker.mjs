// The slice marker: a band of 24 black and white cells drawn into every slice of a bench study, so the harness can
// read which slice a viewer is showing from the screen alone, whatever the viewer.
//
//   [quiet 2] [start 1 1 0 1] [12 bits: slice index] [4 bits: CRC-4 of the index] [stop 1 0 0 1] [quiet 2]
//
// White is far above and black far below any window a viewer opens with, so they stay pure white and pure black.
// The start and stop guards differ, so a band shown mirrored (a viewer flipping left and right) is still read, and
// the CRC rejects a band cut by the edge of a pane or blurred by interpolation.

export const CELLS = 24, QUIET = 2, INDEX_BITS = 12, MAX_INDEX = (1 << INDEX_BITS) - 1;
const START = [1, 1, 0, 1], STOP = [1, 0, 0, 1];

/** CRC-4/ITU (x⁴ + x + 1) of the index's 12 bits, most significant first. */
export function crc4(index) {
  let crc = 0;
  for (let bit = INDEX_BITS - 1; bit >= 0; bit--) {
    const top = ((crc >> 3) & 1) ^ ((index >> bit) & 1);
    crc = (crc << 1) & 0xf;
    if (top) crc ^= 0x3;
  }
  return crc;
}

/** The band's 24 cells for a slice index (1 white, 0 black). */
export function cells(index) {
  if (!Number.isInteger(index) || index < 0 || index > MAX_INDEX) throw new RangeError(`Slice index ${index} is outside 0–${MAX_INDEX}.`);
  const bits = [];
  for (let bit = INDEX_BITS - 1; bit >= 0; bit--) bits.push((index >> bit) & 1);
  const check = crc4(index);
  for (let bit = 3; bit >= 0; bit--) bits.push((check >> bit) & 1);
  return [...START, ...bits, ...STOP];
}

/** Where the band sits in a square slice of `size` pixels: cell width, height and top-left corner of the quiet zone. */
export function bandGeometry(size) {
  const cell = Math.max(2, Math.floor(size / 32)), width = (CELLS + 2 * QUIET) * cell, height = Math.max(4, Math.floor(size / 8));
  return { cell, width, height, left: Math.floor((size - width) / 2), top: Math.floor((size - height) / 2) };
}

/** Draws the band into a slice's stored values (row-major, `size`×`size`): `high` for white cells, `low` for the rest. */
export function drawBand(values, size, index, low, high) {
  const { cell, width, height, left, top } = bandGeometry(size), pattern = cells(index);
  for (let y = top; y < top + height; y++) for (let x = left; x < left + width; x++) {
    const c = Math.floor((x - left) / cell) - QUIET;
    values[y * size + x] = c >= 0 && c < CELLS && pattern[c] ? high : low;
  }
}

// Edges are found at mid-grey. Cells are then read against the band's own black and white, which a small, blurred
// pane (a 500-pixel trace screenshot of a four-pane layout, JPEG-compressed) pulls towards each other.
const kind = (value) => (value >= 128 ? 1 : 0);
const MIN_CONTRAST = 80;

function sample(row, x) {
  return row[Math.min(row.length - 1, Math.max(0, Math.round(x)))];
}

/** Reads the band in one row of luminance values, between the rise of its first white cell and the fall of its last. */
function readBetween(row, from, to) {
  const unit = (to - from) / CELLS;
  if (unit < 2) return null;
  // Three points across each cell: a viewer's thin crosshair line through one of them is outvoted.
  const points = [];
  for (let c = -QUIET; c < CELLS + QUIET; c++) points.push([0.3, 0.5, 0.7].map(at => sample(row, from + (c + at) * unit)));
  const all = points.flat(), low = Math.min(...all), high = Math.max(...all);
  if (high - low < MIN_CONTRAST) return null;
  const middle = (low + high) / 2, read = points.map(votes => (votes.filter(v => v >= middle).length >= 2 ? 1 : 0));
  if (read[0] || read[1] || read[CELLS + QUIET] || read[CELLS + QUIET + 1]) return null;
  const band = read.slice(QUIET, QUIET + CELLS);
  for (const [pattern, mirrored] of [[band, false], [[...band].reverse(), true]]) {
    if (START.some((v, i) => pattern[i] !== v) || STOP.some((v, i) => pattern[CELLS - 4 + i] !== v)) continue;
    let index = 0, check = 0;
    for (let i = 0; i < INDEX_BITS; i++) index = (index << 1) | pattern[4 + i];
    for (let i = 0; i < 4; i++) check = (check << 1) | pattern[4 + INDEX_BITS + i];
    if (crc4(index) === check) return { index, unit, mirrored };
  }
  return null;
}

/**
 * Finds slice markers in a picture. `pixels` holds 4 bytes a pixel (RGBA or BGRA: only the green byte is read, and the
 * band is grey). Rows are scanned `step` apart. Returns one entry per band found, the largest (the main pane) first.
 *
 * A band is four cells tall, so a code must read the same over at least 1.5 cells of height. That rules out a
 * coronal or sagittal pane: it cuts through every slice's band, and each of its rows, one slice high, reads as a
 * valid code for a different slice.
 */
export function findMarkers(pixels, width, height, { step = 3, region } = {}) {
  const hits = rowHits(pixels, width, height, step, region), bands = [];
  for (const hit of hits) {
    const band = bands.find(b => b.index === hit.index && Math.abs(b.x - hit.x) < hit.unit && Math.abs(b.unit - hit.unit) < Math.max(1, hit.unit * 0.1));
    if (band) { band.bottom = Math.max(band.bottom, hit.y); band.rows++; } else bands.push({ ...hit, bottom: hit.y, rows: 1 });
  }
  return bands.filter(b => b.bottom - b.y + step >= 1.5 * b.unit)
    .map(({ bottom, rows, ...band }) => ({ ...band, height: bottom - band.y + step }))
    .sort((a, b) => b.unit - a.unit || a.y - b.y);
}

/** Every row's readable codes, top to bottom. */
function rowHits(pixels, width, height, step, region) {
  const [x0, y0, x1, y1] = region ?? [0, 0, width, height];
  const found = [], row = new Uint8Array(x1 - x0);
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x++) row[x - x0] = pixels[(y * width + x) * 4 + 1];
    // Edges where white begins and ends: a band starts at the rise of its first white cell and ends at the fall of its last.
    const rises = [], falls = [];
    for (let x = 1; x < row.length; x++) {
      const before = kind(row[x - 1]), here = kind(row[x]);
      if (here && !before) rises.push(x);
      if (!here && before) falls.push(x);
    }
    for (const rise of rises) for (const fall of falls) {
      if (fall <= rise + 2 * CELLS) continue;
      const hit = readBetween(row, rise, fall);
      if (hit) found.push({ ...hit, x: x0 + rise, y, width: fall - rise });
    }
  }
  return found;
}
