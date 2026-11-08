// Writes the header of an H.264 MP4 file with the index first, so a video can start playing before it
// has all loaded. The encoded samples follow it unchanged, in the order they were encoded. Video only,
// a constant frame rate, and no B-frames, which is what VideoEncoder produces here. The file records
// no dates or names: what the viewer exports is the pictures.
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_SAMPLE_BYTES = 64 * 1024 * 1024;
const FOUR_GIB = 2 ** 32;
const SAMPLE_TICKS = 1000;

const toBuffer = data => {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return null;
};

/** The avcC record from VideoEncoder, as bytes. Samples carry 4-byte lengths, so the record must say so. */
function checkDecoderConfig(data) {
  const bytes = toBuffer(data);
  if (!bytes || bytes.length < 7 || bytes.length > MAX_CONFIG_BYTES || bytes[0] !== 1 || (bytes[4] & 3) !== 3) {
    throw new Error('Invalid H.264 configuration.');
  }
  return bytes;
}

/** One encoded frame, as bytes: NAL units that each start with a 4-byte length and fill it exactly. */
function checkSample(data) {
  const bytes = toBuffer(data);
  if (!bytes || !bytes.length || bytes.length > MAX_SAMPLE_BYTES) throw new Error('Invalid H.264 sample.');
  for (let offset = 0; offset < bytes.length;) {
    if (offset + 4 > bytes.length) throw new Error('Invalid H.264 sample.');
    const size = bytes.readUInt32BE(offset);
    if (!size || offset + 4 + size > bytes.length) throw new Error('Invalid H.264 sample.');
    offset += 4 + size;
  }
  return bytes;
}

const u8 = value => Buffer.from([value]);
function u16(value) { const b = Buffer.alloc(2); b.writeUInt16BE(value); return b; }
function u32(value) { const b = Buffer.alloc(4); b.writeUInt32BE(value); return b; }
function u64(value) { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(value)); return b; }
const zeros = count => Buffer.alloc(count);
const ascii = text => Buffer.from(text, 'latin1');

function box(type, ...parts) {
  const body = Buffer.concat(parts);
  return Buffer.concat([u32(body.length + 8), ascii(type), body]);
}
const fullBox = (type, version, flags, ...parts) => box(type, u32((version << 24 | flags) >>> 0), ...parts);

function u32Table(values) {
  const table = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => table.writeUInt32BE(value, index * 4));
  return table;
}
function u64Table(values) {
  const table = Buffer.alloc(values.length * 8);
  values.forEach((value, index) => table.writeBigUInt64BE(BigInt(value), index * 8));
  return table;
}

const IDENTITY = Buffer.concat([0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000].map(u32));

function sampleEntry({ width, height, config }) {
  const compressorName = zeros(32);
  return box('avc1', zeros(6), u16(1), zeros(16), u16(width), u16(height), u32(0x00480000), u32(0x00480000),
    zeros(4), u16(1), compressorName, u16(0x0018), u16(0xffff),
    box('avcC', config),
    // BT.709 primaries and matrix, the sRGB curve of the canvas it came from, limited range.
    box('colr', ascii('nclx'), u16(1), u16(13), u16(1), u8(0)),
    box('pasp', u32(1), u32(1)));
}

function sampleTable({ width, height, config, sizes, keyFrames, offsets, wide }) {
  return box('stbl',
    fullBox('stsd', 0, 0, u32(1), sampleEntry({ width, height, config })),
    fullBox('stts', 0, 0, u32(1), u32(sizes.length), u32(SAMPLE_TICKS)),
    fullBox('stss', 0, 0, u32(keyFrames.length), u32Table(keyFrames.map(index => index + 1))),
    fullBox('stsc', 0, 0, u32(1), u32(1), u32(1), u32(1)),
    fullBox('stsz', 0, 0, u32(0), u32(sizes.length), u32Table(sizes)),
    wide ? fullBox('co64', 0, 0, u32(offsets.length), u64Table(offsets))
      : fullBox('stco', 0, 0, u32(offsets.length), u32Table(offsets)));
}

function movie(options, offsets, wide) {
  const { width, height, fps, sizes } = options;
  const timescale = fps * SAMPLE_TICKS, duration = sizes.length * SAMPLE_TICKS;
  return box('moov',
    fullBox('mvhd', 0, 0, zeros(8), u32(timescale), u32(duration), u32(0x00010000), u16(0x0100), zeros(10),
      IDENTITY, zeros(24), u32(2)),
    box('trak',
      fullBox('tkhd', 0, 3, zeros(8), u32(1), zeros(4), u32(duration), zeros(8), zeros(8), IDENTITY,
        u32(width * 0x10000), u32(height * 0x10000)),
      box('mdia',
        fullBox('mdhd', 0, 0, zeros(8), u32(timescale), u32(duration), u16(0x55c4), u16(0)),
        fullBox('hdlr', 0, 0, zeros(4), ascii('vide'), zeros(12), ascii('VideoHandler\0')),
        box('minf',
          fullBox('vmhd', 0, 1, zeros(8)),
          box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1))),
          sampleTable({ ...options, offsets, wide })))));
}

const FILE_TYPE = box('ftyp', ascii('isom'), u32(0x200), ascii('isomiso2avc1mp41'));

/**
 * Everything before the first sample byte. `sizes` lists each sample's length and `keyFrames` the
 * zero-based samples that are key frames. `wideAt` exists so a test can reach the 64-bit layout.
 */
function mp4Header({ width, height, fps, config, sizes, keyFrames, wideAt = FOUR_GIB }) {
  if (!sizes.length || keyFrames[0] !== 0) throw new Error('A video must start with a key frame.');
  const total = sizes.reduce((sum, size) => sum + size, 0);
  const options = { width, height, fps, config, sizes, keyFrames };
  // The table's own width moves the samples, so the size is taken from a layout of the same width.
  const wide = FILE_TYPE.length + movie(options, sizes.map(() => 0), false).length + 8 + total >= wideAt;
  const moovLength = movie(options, sizes.map(() => 0), wide).length;
  const mediaHeader = wide ? Buffer.concat([u32(1), ascii('mdat'), u64(total + 16)]) : Buffer.concat([u32(total + 8), ascii('mdat')]);
  let position = FILE_TYPE.length + moovLength + mediaHeader.length;
  const offsets = sizes.map(size => { const start = position; position += size; return start; });
  return Buffer.concat([FILE_TYPE, movie(options, offsets, wide), mediaHeader]);
}

module.exports = { checkDecoderConfig, checkSample, mp4Header, SAMPLE_TICKS };
