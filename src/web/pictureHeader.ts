// A PNG's, JPEG's or BMP's pixel size from its header, for the browser's picture decoder (picture.worker.ts): the size
// an import asks for, and the check against the engine's frame limit before a picture is decoded. The rules are the
// desktop decoder's (electron/picture-preload.cjs). That preload runs in a sandboxed renderer and can load no module of
// its own, so it keeps its copy.

export interface PictureSize { width: number; height: number }

export const invalidHeader = () => new Error('The source image could not be decoded.');

// The TIFF orientation in a JPEG APP1 Exif segment. Chromium reads the main IFD and its Exif subdirectory.
function exifOrientation(view: DataView, start: number, end: number): number | undefined {
  if (end - start < 8) return undefined;
  const order = view.getUint16(start), little = order === 0x4949;
  if ((!little && order !== 0x4d4d) || view.getUint16(start + 2, little) !== 42) return undefined;
  function directory(offset: number, root: boolean): number | undefined {
    const ifd = start + offset;
    if (offset < 8 || ifd + 2 > end) return undefined;
    const count = view.getUint16(ifd, little);
    for (let i = 0, at = ifd + 2; i < count && at + 12 <= end; i++, at += 12) {
      if (view.getUint32(at + 4, little) !== 1) continue;
      const tag = view.getUint16(at, little), type = view.getUint16(at + 2, little);
      if (tag === 0x0112 && type === 3) {
        const orientation = view.getUint16(at + 8, little);
        if (orientation >= 1 && orientation <= 8) return orientation;
      } else if (root && tag === 0x8769 && type === 4) {
        const orientation = directory(view.getUint32(at + 8, little), false);
        if (orientation) return orientation;
      }
    }
    return undefined;
  }
  return directory(view.getUint32(start + 4, little), true);
}

/** A JPEG's size from its start of frame, turned as its EXIF orientation turns it. Chromium's own size would include
 * the EXIF print density. */
export function jpegSize(view: DataView): PictureSize {
  let width: number | undefined, height: number | undefined, orientation: number | undefined, headerComplete = false;
  for (let at = 2; at < view.byteLength;) {
    if (view.getUint8(at++) !== 0xff) throw invalidHeader();
    while (at < view.byteLength && view.getUint8(at) === 0xff) at++;
    if (at === view.byteLength) throw invalidHeader();
    const marker = view.getUint8(at++);
    if (marker === 0xda || marker === 0xd9) { headerComplete = true; break; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (at + 2 > view.byteLength) throw invalidHeader();
    const length = view.getUint16(at), end = at + length;
    if (length < 2 || end > view.byteLength) throw invalidHeader();
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (width !== undefined || length < 8) throw invalidHeader();
      height = view.getUint16(at + 3);
      width = view.getUint16(at + 5);
    } else if (orientation === undefined && marker === 0xe1 && length >= 8 &&
        view.getUint32(at + 2) === 0x45786966 && view.getUint16(at + 6) === 0) {
      orientation = exifOrientation(view, at + 8, end);
    }
    at = end;
  }
  if (!headerComplete || !width || !height) throw invalidHeader();
  return orientation !== undefined && orientation >= 5 && orientation <= 8 ? { width: height, height: width } : { width, height };
}

// A later PNG chunk can carry orientation. Only use a prefix on its own when it contains the whole PNG.
function hasPngEnd(view: DataView): boolean {
  for (let at = 8; at + 12 <= view.byteLength;) {
    const length = view.getUint32(at), end = at + 12 + length;
    if (end > view.byteLength) break;
    if (view.getUint32(at + 4) === 0x49454e44) return length === 0;
    at = end;
  }
  return false;
}

/** Whether a PNG has an orientation chunk (eXIf), which can turn the picture Chromium shows. */
export function pngHasOrientation(bytes: Uint8Array): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 8; at + 8 <= view.byteLength;) {
    const type = view.getUint32(at + 4);
    if (type === 0x65584966) return true;
    if (type === 0x49454e44) return false;
    at += 12 + view.getUint32(at);
  }
  return false;
}

/** The size the header gives: a JPEG's turned by its orientation, a PNG's (IHDR) or BMP's (DIB header) as stored, which
 * Chromium may still turn by a PNG's own orientation. A `probe`, the start of a larger file, must hold all the header
 * Chromium reads, or this throws. */
export function headerSize(bytes: Uint8Array, probe: boolean): PictureSize & { kind: 'jpeg' | 'png' | 'bmp' } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.byteLength < 8) throw invalidHeader();
  if (view.getUint16(0) === 0xffd8) return { ...jpegSize(view), kind: 'jpeg' };
  if (view.getUint32(0) === 0x89504e47) {
    if (probe && !hasPngEnd(view)) throw invalidHeader();
    return { width: view.getUint32(16), height: view.getUint32(20), kind: 'png' };
  }
  if (view.getUint16(0) !== 0x424d || view.byteLength < 26) throw invalidHeader();
  if (probe) {
    const length = view.getUint32(2, true);
    if (!length || length > bytes.length) throw invalidHeader();
  }
  return view.getUint32(14, true) === 12
    ? { width: view.getUint16(18, true), height: view.getUint16(20, true), kind: 'bmp' }
    : { width: view.getInt32(18, true), height: Math.abs(view.getInt32(22, true)), kind: 'bmp' };
}
