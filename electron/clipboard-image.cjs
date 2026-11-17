'use strict';
// A picture of what is on screen for the system clipboard (Ctrl+C in the viewer). The page hands main the pixels it
// drew, opaque RGBA rows from the top, never an encoded picture: main decodes nothing a page gives it. The size limits
// are the capture's own (src/export-video.ts).
const MAX_SIDE = 8192;
const MAX_PIXELS = 36_000_000;

/** The page's picture as a bitmap in Chromium's own byte order on desktop (blue, green, red, alpha), fully opaque. */
function clipboardBitmap(picture) {
  const { width, height, pixels } = picture && typeof picture === 'object' ? picture : {};
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
    || width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) throw new Error('Invalid picture size.');
  const rgba = pixels instanceof ArrayBuffer ? new Uint8Array(pixels)
    : ArrayBuffer.isView(pixels) ? new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength) : null;
  if (!rgba || rgba.length !== width * height * 4) throw new Error('Invalid picture.');
  const buffer = Buffer.allocUnsafe(rgba.length);
  for (let at = 0; at < rgba.length; at += 4) {
    buffer[at] = rgba[at + 2]; buffer[at + 1] = rgba[at + 1]; buffer[at + 2] = rgba[at]; buffer[at + 3] = 255;
  }
  return { buffer, width, height };
}

/** Puts the page's picture on `clipboard` as an image. */
function writeClipboardImage(picture, { clipboard, nativeImage }) {
  const { buffer, width, height } = clipboardBitmap(picture);
  const image = nativeImage.createFromBitmap(buffer, { width, height });
  if (image.isEmpty()) throw new Error('Invalid picture.');
  clipboard.writeImage(image);
}

module.exports = { MAX_PIXELS, MAX_SIDE, clipboardBitmap, writeClipboardImage };
