import { createRequire } from 'node:module';
import { crc32, deflateSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertFields } from './support';

const require = createRequire(import.meta.url);
const { comparePng } = require('../tools/lib/png-diff.cjs');
const { decodePng, encodePng } = require('../tools/lib/png.cjs');
const png = (width = 2, height = 2) => ({ width, height, data: Buffer.alloc(width * height * 4) });
const chunk = (type: string, content: Buffer) => {
  const out = Buffer.alloc(content.length + 12);
  out.writeUInt32BE(content.length); out.write(type, 4); content.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, -4)), out.length - 4);
  return out;
};
// A PNG from filtered rows, each starting with its filter type.
const file = (width: number, height: number, depth: number, colorType: number, rows: number[][], ...extra: Buffer[]) => {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = depth; header[9] = colorType;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), ...extra,
    chunk('IDAT', deflateSync(Buffer.from(rows.flat()))), chunk('IEND', Buffer.alloc(0))]);
};

describe('PNG reading', () => {
  it('reads every row filter, palettes, low-bit grey and 16-bit colour as 8-bit RGBA', () => {
    const grey = (...levels: number[]) => levels.flatMap(level => [level, level, level, 255]);
    // Rows filtered None, Sub, Up, Average and Paeth, worked by hand.
    assert.deepEqual([...decodePng(file(2, 5, 8, 0, [[0, 10, 20], [1, 30, 20], [2, 5, 251], [3, 23, 18], [4, 10, 10]])).data], grey(10, 20, 30, 50, 35, 45, 40, 60, 50, 70));
    const palette = chunk('PLTE', Buffer.from([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120]));
    assert.deepEqual([...decodePng(file(3, 1, 2, 3, [[0, 0b00011100]], palette, chunk('tRNS', Buffer.from([0, 128])))).data], [10, 20, 30, 0, 40, 50, 60, 128, 100, 110, 120, 255]);
    assert.deepEqual([...decodePng(file(2, 1, 4, 0, [[0, 0x0f]], chunk('tRNS', Buffer.from([0, 0])))).data], [0, 0, 0, 0, 255, 255, 255, 255]);
    assert.deepEqual([...decodePng(file(1, 1, 16, 2, [[0, 0x00, 0x00, 0x80, 0x80, 0xff, 0xff]])).data], [0, 128, 255, 255]);
  });
  it('round-trips written RGBA and refuses interlaced or corrupted files', () => {
    const image = png(3, 2); image.data.forEach((_, index) => { image.data[index] = index * 11; });
    assert.deepEqual(decodePng(encodePng(image)), image);
    const interlaced = file(1, 1, 8, 0, [[0, 0]]); interlaced[28] = 1; interlaced.writeUInt32BE(crc32(interlaced.subarray(12, 29)), 29);
    assert.throws(() => decodePng(interlaced), { message: /Interlaced/ });
    const corrupted = encodePng(png()); corrupted[16] ^= 1;
    assert.throws(() => decodePng(corrupted), { message: /CRC/ });
  });
});

describe('export golden comparison', () => {
  it('compares decoded pixels, not PNG compression bytes', () => {
    const image = png(); image.data.fill(128);
    assert.equal(comparePng(encodePng(image, { level: 0 }), encodePng(image, { level: 9 })).result.passed, true);
  });
  it('fails on a one-level change in a single pixel, including alpha', () => {
    for (const channel of [0, 1, 2, 3]) {
      const reference = png(), changed = png(); changed.data[channel] = 1;
      const { result } = comparePng(encodePng(reference), encodePng(changed));
      assertFields(result, { passed: false, sizeMatch: true, differingPixels: 1, maxChannelDifference: 1 });
    }
  });
  it('fails when dimensions differ even if the total pixel count matches', () => {
    assertFields(comparePng(encodePng(png(2, 2)), encodePng(png(1, 4))).result, { passed: false, sizeMatch: false });
  });
  it('rejects malformed PNG data', () => {
    assert.throws(() => comparePng(encodePng(png()), Buffer.from('not an image')));
  });
  for (const type of ['tEXt', 'eXIf', 'gAMA']) it(`rejects a ${type} chunk even when all decoded pixels match`, () => {
    const original = encodePng(png());
    const withMetadata = Buffer.concat([original.subarray(0, -12),
      chunk(type, type === 'gAMA' ? Buffer.from([0, 0, 177, 143]) : Buffer.from('synthetic')), original.subarray(-12)]);
    assertFields(comparePng(original, withMetadata).result, { passed: false, differingPixels: 0, unexpectedExportChunks: [type] });
  });
});
