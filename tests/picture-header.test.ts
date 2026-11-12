import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { headerSize, pngHasOrientation } from '../src/web/pictureHeader';

const u16 = (value: number) => [value >> 8, value & 0xff];
const u32 = (value: number) => [...u16(value >>> 16), ...u16(value & 0xffff)];
const le16 = (value: number) => [value & 0xff, value >> 8];
const le32 = (value: number) => [...le16(value & 0xffff), ...le16((value >>> 16) & 0xffff)];

/** A JPEG's header up to its scan: a big-endian Exif segment with `orientation` when given, then a start of frame. */
function jpeg(width: number, height: number, orientation?: number): Uint8Array {
  const exif = orientation === undefined ? [] : (() => {
    const tiff = [0x4d, 0x4d, ...u16(42), ...u32(8), ...u16(1), ...u16(0x0112), ...u16(3), ...u32(1), ...u16(orientation), 0, 0, ...u32(0)];
    const body = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
    return [0xff, 0xe1, ...u16(body.length + 2), ...body];
  })();
  const frame = [0xff, 0xc0, ...u16(17), 8, ...u16(height), ...u16(width), 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1];
  return new Uint8Array([0xff, 0xd8, ...exif, ...frame, 0xff, 0xda, ...u16(2)]);
}

function png(width: number, height: number, end: boolean, orientation = false): Uint8Array {
  const chunk = (type: string, data: number[]) => [...u32(data.length), ...[...type].map(c => c.charCodeAt(0)), ...data, 0, 0, 0, 0];
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk('IHDR', [...u32(width), ...u32(height), 8, 2, 0, 0, 0]), ...(orientation ? chunk('eXIf', [0x4d, 0x4d, 0, 42]) : []),
    ...(end ? chunk('IEND', []) : [])]);
}

function bmp(width: number, height: number, declared = 26 + 40): Uint8Array {
  return new Uint8Array(['B'.charCodeAt(0), 'M'.charCodeAt(0), ...le32(declared), 0, 0, 0, 0, ...le32(54),
    ...le32(40), ...le32(width), ...le32(height >>> 0), ...le16(1), ...le16(24)]);
}

describe('picture headers in the browser', () => {
  it('reads a JPEG start of frame, turned by its EXIF orientation as Chromium shows it', () => {
    assert.deepEqual(headerSize(jpeg(32, 24), false), { width: 32, height: 24, kind: 'jpeg' });
    assert.deepEqual(headerSize(jpeg(32, 24, 1), false), { width: 32, height: 24, kind: 'jpeg' });
    assert.deepEqual(headerSize(jpeg(32, 24, 6), false), { width: 24, height: 32, kind: 'jpeg' });
    // Cut before the scan: the size is not known to be the one decoded.
    assert.throws(() => headerSize(jpeg(32, 24).subarray(0, 20), true), /could not be decoded/);
  });

  it('reads a PNG header, and refuses a prefix that may leave out an orientation chunk', () => {
    assert.deepEqual(headerSize(png(640, 480, false), false), { width: 640, height: 480, kind: 'png' });
    assert.throws(() => headerSize(png(640, 480, false), true), /could not be decoded/);
    assert.deepEqual(headerSize(png(640, 480, true), true), { width: 640, height: 480, kind: 'png' });
    // Only a PNG with an orientation chunk is decoded to learn the size it is shown at.
    assert.equal(pngHasOrientation(png(640, 480, true)), false);
    assert.equal(pngHasOrientation(png(640, 480, true, true)), true);
    assert.equal(pngHasOrientation(png(640, 480, false, true).subarray(0, 40)), false);
  });

  it('reads a BMP header, rows stored either way, and refuses a prefix shorter than the file', () => {
    assert.deepEqual(headerSize(bmp(32, 24), false), { width: 32, height: 24, kind: 'bmp' });
    assert.deepEqual(headerSize(bmp(32, -24), false), { width: 32, height: 24, kind: 'bmp' });
    assert.throws(() => headerSize(bmp(32, 24, 4096), true), /could not be decoded/);
    assert.throws(() => headerSize(new Uint8Array([0x42, 0x4d, 0, 0, 0, 0, 0, 0]), false), /could not be decoded/);
  });
});
