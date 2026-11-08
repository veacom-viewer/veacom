// The browser build's MP4 writer: the same file as the desktop's electron/mp4.cjs writes (an H.264 video with its index
// first, so it starts playing before it has all loaded), built from Uint8Arrays instead of Node's Buffer. The encoded
// samples follow the header unchanged, in the order they were encoded. Video only, a constant frame rate, no B-frames,
// which is what VideoEncoder produces here; no dates or names are recorded.
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_SAMPLE_BYTES = 64 * 1024 * 1024;
const FOUR_GIB = 2 ** 32;
export const SAMPLE_TICKS = 1000;

type Bytes = Uint8Array<ArrayBuffer>;

const toBytes = (data: ArrayBuffer | ArrayBufferView): Bytes =>
  data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);

/** The avcC record from VideoEncoder. Samples carry 4-byte lengths, so the record must say so. */
export function checkDecoderConfig(data: ArrayBuffer | ArrayBufferView): Bytes {
  const bytes = toBytes(data);
  if (bytes.length < 7 || bytes.length > MAX_CONFIG_BYTES || bytes[0] !== 1 || (bytes[4] & 3) !== 3) throw new Error('Invalid H.264 configuration.');
  return bytes;
}

/** One encoded frame: NAL units that each start with a 4-byte length and fill it exactly. */
export function checkSample(data: ArrayBuffer | ArrayBufferView): Bytes {
  const bytes = toBytes(data);
  if (!bytes.length || bytes.length > MAX_SAMPLE_BYTES) throw new Error('Invalid H.264 sample.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset < bytes.length;) {
    if (offset + 4 > bytes.length) throw new Error('Invalid H.264 sample.');
    const size = view.getUint32(offset);
    if (!size || offset + 4 + size > bytes.length) throw new Error('Invalid H.264 sample.');
    offset += 4 + size;
  }
  return bytes;
}

function concat(parts: Bytes[]): Bytes {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}
const u8 = (value: number): Bytes => new Uint8Array([value]);
function number(size: 2 | 4 | 8, value: number): Bytes {
  const view = new DataView(new ArrayBuffer(size));
  if (size === 2) view.setUint16(0, value); else if (size === 4) view.setUint32(0, value); else view.setBigUint64(0, BigInt(value));
  return new Uint8Array(view.buffer);
}
const u16 = (value: number) => number(2, value), u32 = (value: number) => number(4, value), u64 = (value: number) => number(8, value);
const zeros = (count: number): Bytes => new Uint8Array(count);
const ascii = (text: string): Bytes => new Uint8Array([...text].map(c => c.charCodeAt(0)));

function box(type: string, ...parts: Bytes[]): Bytes {
  const body = concat(parts);
  return concat([u32(body.length + 8), ascii(type), body]);
}
const fullBox = (type: string, version: number, flags: number, ...parts: Bytes[]) => box(type, u32((version << 24 | flags) >>> 0), ...parts);
const u32Table = (values: number[]) => concat(values.map(u32));
const u64Table = (values: number[]) => concat(values.map(u64));

const IDENTITY = concat([0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000].map(u32));

interface VideoOptions { width: number; height: number; fps: number; config: Bytes; sizes: number[]; keyFrames: number[] }

function sampleEntry({ width, height, config }: VideoOptions): Bytes {
  return box('avc1', zeros(6), u16(1), zeros(16), u16(width), u16(height), u32(0x00480000), u32(0x00480000),
    zeros(4), u16(1), zeros(32), u16(0x0018), u16(0xffff),
    box('avcC', config),
    // BT.709 primaries and matrix, the sRGB curve of the canvas it came from, limited range.
    box('colr', ascii('nclx'), u16(1), u16(13), u16(1), u8(0)),
    box('pasp', u32(1), u32(1)));
}

function sampleTable(options: VideoOptions, offsets: number[], wide: boolean): Bytes {
  const { sizes, keyFrames } = options;
  return box('stbl',
    fullBox('stsd', 0, 0, u32(1), sampleEntry(options)),
    fullBox('stts', 0, 0, u32(1), u32(sizes.length), u32(SAMPLE_TICKS)),
    fullBox('stss', 0, 0, u32(keyFrames.length), u32Table(keyFrames.map(index => index + 1))),
    fullBox('stsc', 0, 0, u32(1), u32(1), u32(1), u32(1)),
    fullBox('stsz', 0, 0, u32(0), u32(sizes.length), u32Table(sizes)),
    wide ? fullBox('co64', 0, 0, u32(offsets.length), u64Table(offsets)) : fullBox('stco', 0, 0, u32(offsets.length), u32Table(offsets)));
}

function movie(options: VideoOptions, offsets: number[], wide: boolean): Bytes {
  const { width, height, fps, sizes } = options;
  const timescale = fps * SAMPLE_TICKS, duration = sizes.length * SAMPLE_TICKS;
  return box('moov',
    fullBox('mvhd', 0, 0, zeros(8), u32(timescale), u32(duration), u32(0x00010000), u16(0x0100), zeros(10), IDENTITY, zeros(24), u32(2)),
    box('trak',
      fullBox('tkhd', 0, 3, zeros(8), u32(1), zeros(4), u32(duration), zeros(8), zeros(8), IDENTITY, u32(width * 0x10000), u32(height * 0x10000)),
      box('mdia',
        fullBox('mdhd', 0, 0, zeros(8), u32(timescale), u32(duration), u16(0x55c4), u16(0)),
        fullBox('hdlr', 0, 0, zeros(4), ascii('vide'), zeros(12), ascii('VideoHandler\0')),
        box('minf',
          fullBox('vmhd', 0, 1, zeros(8)),
          box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1))),
          sampleTable(options, offsets, wide)))));
}

const FILE_TYPE = box('ftyp', ascii('isom'), u32(0x200), ascii('isomiso2avc1mp41'));

/** Everything before the first sample byte. `sizes` lists each sample's length and `keyFrames` the zero-based samples
 * that are key frames. */
export function mp4Header({ width, height, fps, config, sizes, keyFrames }: VideoOptions, wideAt = FOUR_GIB): Bytes {
  if (!sizes.length || keyFrames[0] !== 0) throw new Error('A video must start with a key frame.');
  const total = sizes.reduce((sum, size) => sum + size, 0);
  const options = { width, height, fps, config, sizes, keyFrames };
  // The table's own width moves the samples, so the size is taken from a layout of the same width.
  const wide = FILE_TYPE.length + movie(options, sizes.map(() => 0), false).length + 8 + total >= wideAt;
  const moovLength = movie(options, sizes.map(() => 0), wide).length;
  const mediaHeader = wide ? concat([u32(1), ascii('mdat'), u64(total + 16)]) : concat([u32(total + 8), ascii('mdat')]);
  let position = FILE_TYPE.length + moovLength + mediaHeader.length;
  const offsets = sizes.map(size => { const start = position; position += size; return start; });
  return concat([FILE_TYPE, movie(options, offsets, wide), mediaHeader]);
}
