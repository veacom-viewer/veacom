'use strict';
// The picture decoder's only script (picture-decoder.cjs). It runs in the preload's isolated world of a sandboxed
// renderer whose blank page has JavaScript off, and answers each picture it is sent with Chromium's own decoders:
//
// Import reads headers only. The frame limit uses encoded pixels, including when EXIF supplies a different
// display size. The bitmap and canvas run only for frames that fit.
const { ipcRenderer } = require('electron');

// The engine's frame limit, in RGB samples (native/src/pictures.rs MAX_SAMPLES).
const MAX_SAMPLES = 64 * 1024 * 1024;

const invalidHeader = () => new Error('The source image could not be decoded.');

// The TIFF orientation in a JPEG APP1 Exif segment. Chromium reads the main IFD and its Exif subdirectory.
function exifOrientation(view, start, end) {
  if (end - start < 8) return;
  const order = view.getUint16(start), little = order === 0x4949;
  if ((!little && order !== 0x4d4d) || view.getUint16(start + 2, little) !== 42) return;
  function directory(offset, root) {
    const ifd = start + offset;
    if (offset < 8 || ifd + 2 > end) return;
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
  }
  return directory(view.getUint32(start + 4, little), true);
}

// Only the start-of-frame gives the JPEG's pixel dimensions. Chromium's naturalWidth includes EXIF print density.
function jpegSize(view) {
  let width, height, orientation, headerComplete = false;
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
  return orientation >= 5 && orientation <= 8 ? { width: height, height: width } : { width, height };
}

// A later PNG chunk can carry orientation. Only use a prefix on its own when it contains the whole PNG.
function hasPngEnd(view) {
  for (let at = 8; at + 12 <= view.byteLength;) {
    const length = view.getUint32(at), end = at + 12 + length;
    if (end > view.byteLength) break;
    if (view.getUint32(at + 4) === 0x49454e44) return length === 0;
    at = end;
  }
  return false;
}

async function headerSize(bytes, blob, probe) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.byteLength < 8) throw invalidHeader();
  const png = view.getUint32(0) === 0x89504e47;
  if (probe && png && !hasPngEnd(view)) throw invalidHeader();
  if (probe && view.getUint16(0) === 0x424d) {
    const length = view.getUint32(2, true);
    if (!length || length > bytes.length) throw invalidHeader();
  }
  const url = URL.createObjectURL(blob);
  const image = new Image();
  try {
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(invalidHeader());
      image.src = url;
    });
    if (view.getUint16(0) === 0xffd8) return jpegSize(view);
    // PNG IHDR and BMP DIB dimensions. Chromium supplies the orientation for these formats.
    let width, height;
    if (png) {
      width = view.getUint32(16);
      height = view.getUint32(20);
    } else if (view.getUint32(14, true) === 12) {
      width = view.getUint16(18, true);
      height = view.getUint16(20, true);
    } else {
      width = view.getInt32(18, true);
      height = Math.abs(view.getInt32(22, true));
    }
    const { naturalWidth, naturalHeight } = image;
    if (!((width === naturalWidth && height === naturalHeight) || (width === naturalHeight && height === naturalWidth))) {
      throw invalidHeader();
    }
    return { width: naturalWidth, height: naturalHeight };
  } finally { URL.revokeObjectURL(url); }
}

ipcRenderer.on('picture:decode', async (_event, id, bytes, want) => {
  let bitmap;
  try {
    const blob = new Blob([bytes]);
    const size = await headerSize(bytes, blob, want === 'probe');
    if (want !== 'pixels') {
      ipcRenderer.send('picture:decoded', id, size);
      return;
    }
    if (size.width * size.height * 3 > MAX_SAMPLES) throw new Error('Frame exceeds the supported 64 million sample limit');
    bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    // The decoded size, which the engine compares with the size it was given at import.
    const { width, height } = bitmap;
    if (width * height * 3 > MAX_SAMPLES) throw new Error('Frame exceeds the supported 64 million sample limit');
    // The engine drops the alpha samples: done here, in JavaScript, that took longer than the decoding.
    const context = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, width, height);
    ipcRenderer.send('picture:decoded', id, { width, height, rgba: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) });
  } catch (error) {
    ipcRenderer.send('picture:decoded', id, { error: want === 'probe' ? 'Incomplete picture header' : String(error?.message ?? error) });
  } finally {
    bitmap?.close();
  }
});
