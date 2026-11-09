import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
// @ts-expect-error The bench's plain JavaScript modules have no type declarations.
import { bandGeometry, cells, crc4, drawBand, findMarkers, MAX_INDEX } from '../tools/browser-bench/lib/marker.mjs';

/** A slice as a viewer would show it: windowed to grey, scaled (bilinear) into a larger RGBA picture at an offset. */
function screen(index: number, { size = 512, scale = 1.6, mirrored = false, offset = [37, 21], window = [40, 400] } = {}) {
  const values = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const r = Math.hypot((x - size / 2) / (size * 0.41), (y - size / 2) / (size * 0.36));
    values[y * size + x] = r > 1 ? -1000 : r > 0.88 ? 1200 : 100 + ((x * 7 + y * 3) % 21) - 10;
  }
  drawBand(values, size, index, -3000, 3000);
  const [center, width] = window, grey = (v: number) => Math.max(0, Math.min(255, ((v - (center - width / 2)) / width) * 255));
  const shown = Math.round(size * scale), W = shown + offset[0] + 40, H = shown + offset[1] + 30, pixels = new Uint8Array(W * H * 4);
  for (let y = 0; y < shown; y++) for (let x = 0; x < shown; x++) {
    const sx = Math.min(size - 1.001, ((mirrored ? shown - 1 - x : x) + 0.5) / scale - 0.5), sy = Math.min(size - 1.001, (y + 0.5) / scale - 0.5);
    const ix = Math.max(0, Math.floor(sx)), iy = Math.max(0, Math.floor(sy)), fx = sx - ix, fy = sy - iy;
    const at = (xx: number, yy: number) => grey(values[yy * size + xx]);
    const v = (at(ix, iy) * (1 - fx) + at(ix + 1, iy) * fx) * (1 - fy) + (at(ix, iy + 1) * (1 - fx) + at(ix + 1, iy + 1) * fx) * fy;
    const o = ((y + offset[1]) * W + x + offset[0]) * 4;
    pixels[o] = pixels[o + 1] = pixels[o + 2] = Math.round(v); pixels[o + 3] = 255;
  }
  return { pixels, width: W, height: H };
}

describe('bench slice marker', () => {
  it('encodes 24 cells with guards and a CRC that catches every single-bit error', () => {
    assert.equal(cells(0).length, 24);
    assert.deepEqual(cells(0).slice(0, 4), [1, 1, 0, 1]);
    assert.deepEqual(cells(MAX_INDEX).slice(-4), [1, 0, 0, 1]);
    for (let index = 0; index <= MAX_INDEX; index += 97) for (let bit = 0; bit < 12; bit++) assert.notEqual(crc4(index), crc4(index ^ (1 << bit)));
    assert.throws(() => cells(MAX_INDEX + 1), RangeError);
  });

  it('reads the slice index back from a scaled, offset picture', () => {
    for (const index of [0, 1, 499, 999, MAX_INDEX]) {
      const { pixels, width, height } = screen(index);
      const [first] = findMarkers(pixels, width, height);
      assert.equal(first?.index, index);
      assert.equal(first.mirrored, false);
    }
  });

  it('reads a mirrored band, a small pane and a wide window', () => {
    assert.deepEqual(pick(screen(733, { mirrored: true })), { index: 733, mirrored: true });
    assert.equal(pick(screen(42, { scale: 0.6 }))?.index, 42);
    assert.equal(pick(screen(42, { window: [0, 2000] }))?.index, 42);
  });

  it('ignores a reformatted pane whose every row is a different slice’s band', () => {
    // A coronal cut through the bands: row z of the pane is one row of slice z's band.
    const size = 512, width = 600, height = 300, pixels = new Uint8Array(width * height * 4);
    for (let z = 0; z < height; z++) {
      const values = new Float32Array(size * size);
      drawBand(values, size, z, 0, 255);
      const { top } = bandGeometry(size);
      for (let x = 0; x < size; x++) pixels[(z * width + x + 40) * 4 + 1] = values[(top + 1) * size + x];
    }
    assert.deepEqual(findMarkers(pixels, width, height, { step: 1 }), []);
  });

  it('finds nothing in a picture without a band', () => {
    const { pixels, width, height } = screen(5);
    const { top, height: bandHeight } = bandGeometry(512);
    // Paint over the band's rows (1.6× scale, 21 px offset).
    for (let y = Math.floor(top * 1.6) + 10; y < Math.ceil((top + bandHeight) * 1.6) + 32; y++) pixels.fill(128, y * width * 4, (y + 1) * width * 4);
    assert.deepEqual(findMarkers(pixels, width, height), []);
  });
});

function pick({ pixels, width, height }: { pixels: Uint8Array; width: number; height: number }) {
  const [first] = findMarkers(pixels, width, height);
  return first && { index: first.index, mirrored: first.mirrored };
}
