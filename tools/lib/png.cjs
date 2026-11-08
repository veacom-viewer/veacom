// PNG reading and writing for the verification tools, on Node's own zlib. Every colour type and bit depth of a
// non-interlaced PNG reads as 8-bit RGBA, the way pngjs read it: 16-bit and low-bit samples are rescaled to 0–255,
// and a tRNS chunk sets alpha. Writing produces 8-bit RGBA. Interlaced files are refused.
const zlib = require('node:zlib');

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Channels per pixel, and the bit depths the PNG specification allows, for each colour type.
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const DEPTHS = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };

function decodePng(bytes) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  if (!bytes.subarray(0, 8).equals(SIGNATURE)) throw new Error('Not a PNG file');
  let header = null, palette = null, transparency = null;
  const compressed = [];
  for (let offset = 8; ;) {
    if (offset + 12 > bytes.length) throw new Error('PNG ends before its IEND chunk');
    const length = bytes.readUInt32BE(offset), type = bytes.toString('latin1', offset + 4, offset + 8), end = offset + 12 + length;
    if (end > bytes.length) throw new Error(`PNG ${type} chunk exceeds the file`);
    if (zlib.crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) throw new Error(`PNG ${type} chunk fails its CRC`);
    const body = bytes.subarray(offset + 8, end - 4);
    if (!header && type !== 'IHDR') throw new Error('PNG does not start with IHDR');
    if (type === 'IHDR') {
      header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], colorType: body[9] };
      if (!header.width || !header.height || !DEPTHS[header.colorType]?.includes(header.depth) || body[10] || body[11]) {
        throw new Error(`Unsupported PNG header: colour type ${header.colorType}, bit depth ${header.depth}`);
      }
      if (body[12]) throw new Error('Interlaced PNGs are not supported');
    } else if (type === 'PLTE') palette = body;
    else if (type === 'tRNS') transparency = body;
    else if (type === 'IDAT') compressed.push(body);
    else if (type === 'IEND') break;
    offset = end;
  }
  const { width, height, depth, colorType } = header;
  if (colorType === 3 && !palette) throw new Error('Palette PNG has no PLTE chunk');

  // Undo each row's filter (PNG specification, section 9).
  const channels = CHANNELS[colorType], stride = Math.ceil(width * channels * depth / 8), step = Math.max(1, channels * depth >> 3);
  const raw = zlib.inflateSync(Buffer.concat(compressed), { maxOutputLength: height * (stride + 1) });
  if (raw.length !== height * (stride + 1)) throw new Error('PNG image data is truncated');
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], input = y * (stride + 1) + 1, row = y * stride, above = row - stride;
    if (filter > 4) throw new Error(`PNG row ${y} has unknown filter ${filter}`);
    for (let i = 0; i < stride; i++) {
      const left = i >= step ? pixels[row + i - step] : 0, up = y ? pixels[above + i] : 0, corner = y && i >= step ? pixels[above + i - step] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = (left + up) >> 1;
      else if (filter === 4) {
        const estimate = left + up - corner, toLeft = Math.abs(estimate - left), toUp = Math.abs(estimate - up), toCorner = Math.abs(estimate - corner);
        predictor = toLeft <= toUp && toLeft <= toCorner ? left : toUp <= toCorner ? up : corner;
      }
      pixels[row + i] = (raw[input + i] + predictor) & 0xff;
    }
  }

  const max = 2 ** depth - 1;
  const sample = (y, index) => {
    if (depth === 8) return pixels[y * stride + index];
    if (depth === 16) return pixels.readUInt16BE(y * stride + index * 2);
    const bit = index * depth;
    return (pixels[y * stride + (bit >> 3)] >> (8 - depth - (bit & 7))) & max;
  };
  const scale = value => depth === 8 ? value : Math.floor(value * 255 / max + 0.5);
  const key = transparency && colorType !== 3 ? Array.from({ length: colorType === 2 ? 3 : 1 }, (_, i) => transparency.readUInt16BE(i * 2)) : null;
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0, out = 0; y < height; y++) {
    for (let x = 0; x < width; x++, out += 4) {
      const first = x * channels;
      if (colorType === 3) {
        const index = sample(y, first);
        if (index * 3 + 3 > palette.length) throw new Error(`PNG palette has no entry ${index}`);
        palette.copy(data, out, index * 3, index * 3 + 3);
        data[out + 3] = transparency && index < transparency.length ? transparency[index] : 255;
        continue;
      }
      const gray = colorType === 0 || colorType === 4;
      const red = sample(y, first), green = gray ? red : sample(y, first + 1), blue = gray ? red : sample(y, first + 2);
      data[out] = scale(red); data[out + 1] = scale(green); data[out + 2] = scale(blue);
      data[out + 3] = colorType === 4 ? scale(sample(y, first + 1)) : colorType === 6 ? scale(sample(y, first + 3))
        : key && red === key[0] && (gray || (green === key[1] && blue === key[2])) ? 0 : 255;
    }
  }
  return { width, height, data };
}

function chunk(type, body) {
  const out = Buffer.alloc(body.length + 12);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, 'latin1');
  body.copy(out, 8);
  out.writeUInt32BE(zlib.crc32(out.subarray(4, out.length - 4)), out.length - 4);
  return out;
}

// An 8-bit RGBA PNG, every row unfiltered. level is the zlib compression level, 0–9.
function encodePng({ width, height, data }, { level = zlib.constants.Z_DEFAULT_COMPRESSION } = {}) {
  if (!width || !height || data.length !== width * height * 4) throw new Error(`Expected ${width}x${height} RGBA pixels`);
  const pixels = Buffer.from(data.buffer, data.byteOffset, data.length), stride = width * 4, raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6;
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw, { level })), chunk('IEND', Buffer.alloc(0))]);
}

module.exports = { decodePng, encodePng };
