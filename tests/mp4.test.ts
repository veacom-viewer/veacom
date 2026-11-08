import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const { checkDecoderConfig, checkSample, mp4Header } = require('../electron/mp4.cjs');
const config = Buffer.from([1, 0x64, 0, 0x1f, 0xff, 0xe1, 0, 0]);

/** The boxes inside a byte range, by four-character type. */
function boxes(bytes: Buffer, start = 0, end = bytes.length): Map<string, Buffer> {
  const found = new Map<string, Buffer>();
  for (let offset = start; offset < end;) {
    let size = bytes.readUInt32BE(offset), header = 8;
    if (size === 1) { size = Number(bytes.readBigUInt64BE(offset + 8)); header = 16; }
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    found.set(type, bytes.subarray(offset + header, Math.min(offset + size, end)));
    offset += type === 'mdat' ? end : size;
  }
  return found;
}
const open = (parent: Buffer, ...path: string[]) => path.reduce((box, type) => boxes(box).get(type)!, parent);
const words = (table: Buffer, skip: number) => Array.from({ length: (table.length - skip) / 4 }, (_, index) => table.readUInt32BE(skip + index * 4));
const movie = (header: Buffer) => boxes(header).get('moov')!;
const sampleTable = (header: Buffer) => open(movie(header), 'trak', 'mdia', 'minf', 'stbl');

describe('MP4 header', () => {
  const options = { width: 18, height: 14, fps: 10, config, sizes: [5, 9, 7], keyFrames: [0, 2] };

  it('points each sample at its own bytes straight after the header', () => {
    const header: Buffer = mp4Header(options);
    assert.deepEqual([...boxes(header).keys()], ['ftyp', 'moov', 'mdat']);
    const media = header.subarray(header.length - 8);
    assert.equal(media.readUInt32BE(0), 8 + 5 + 9 + 7);
    assert.equal(media.toString('latin1', 4), 'mdat');
    const table = sampleTable(header);
    assert.deepEqual(words(open(table, 'stco'), 8), [header.length, header.length + 5, header.length + 14]);
    assert.deepEqual(words(open(table, 'stsz'), 12), [5, 9, 7]);
    assert.deepEqual(words(open(table, 'stss'), 8), [1, 3]);
    assert.deepEqual(words(open(table, 'stsc'), 8), [1, 1, 1]);
  });

  it('records the frame rate, the size and the colour of the picture', () => {
    const header: Buffer = mp4Header(options);
    const table = sampleTable(header);
    assert.deepEqual(words(open(table, 'stts'), 8), [3, 1000]);
    assert.equal(open(movie(header), 'mvhd').readUInt32BE(12), 10000);
    assert.equal(open(movie(header), 'mvhd').readUInt32BE(16), 3000);
    const tkhd = open(movie(header), 'trak', 'tkhd');
    assert.equal(tkhd.readUInt32BE(tkhd.length - 8) / 0x10000, 18);
    assert.equal(tkhd.readUInt32BE(tkhd.length - 4) / 0x10000, 14);
    const entry = open(table, 'stsd').subarray(16);
    assert.equal(entry.readUInt16BE(24), 18);
    assert.equal(entry.readUInt16BE(26), 14);
    const children = boxes(entry, 78);
    assert.deepEqual(children.get('avcC'), config);
    assert.deepEqual([...children.get('colr')!], [0x6e, 0x63, 0x6c, 0x78, 0, 1, 0, 13, 0, 1, 0]);
  });

  it('records no date in the file', () => {
    const header: Buffer = mp4Header(options);
    assert.equal(open(movie(header), 'mvhd').readBigUInt64BE(4), 0n);
    assert.equal(open(movie(header), 'trak', 'mdia', 'mdhd').readBigUInt64BE(4), 0n);
  });

  it('uses 64-bit offsets and a large media box past 4 GiB', () => {
    const header: Buffer = mp4Header({ ...options, wideAt: 0 });
    const table = sampleTable(header);
    assert.equal(boxes(table).has('stco'), false);
    const offsets = open(table, 'co64');
    assert.equal(offsets.readUInt32BE(4), 3);
    assert.equal(Number(offsets.readBigUInt64BE(8)), header.length);
    assert.equal(Number(offsets.readBigUInt64BE(16)), header.length + 5);
    const media = header.subarray(header.length - 16);
    assert.equal(media.readUInt32BE(0), 1);
    assert.equal(media.toString('latin1', 4, 8), 'mdat');
    assert.equal(Number(media.readBigUInt64BE(8)), 16 + 21);
  });

  it('refuses a video that does not start with a key frame', () => {
    assert.throws(() => mp4Header({ ...options, keyFrames: [1] }), { message: /key frame/ });
    assert.throws(() => mp4Header({ ...options, sizes: [], keyFrames: [] }), { message: /key frame/ });
  });
});

describe('encoder output checks', () => {
  it('accepts length-prefixed NAL units and rejects anything else', () => {
    const sample = Buffer.from([0, 0, 0, 2, 0x65, 1, 0, 0, 0, 1, 0x41]);
    assert.deepEqual(checkSample(sample), sample);
    assert.deepEqual(checkSample(new Uint8Array(sample).buffer), sample);
    for (const bad of [Buffer.alloc(0), Buffer.from([0, 0, 0, 9, 1]), Buffer.from([0, 0, 0, 0, 1]), Buffer.from([0, 0, 1]), 'text', null]) {
      assert.throws(() => checkSample(bad), { message: /Invalid H\.264 sample/ });
    }
    assert.throws(() => checkSample(Buffer.alloc(64 * 1024 * 1024 + 1)), { message: /Invalid H\.264 sample/ });
  });

  it('accepts only a 4-byte-length avcC record', () => {
    assert.deepEqual(checkDecoderConfig(config), config);
    for (const bad of [Buffer.from([1, 0, 0]), Buffer.from([2, 0, 0, 0, 0xff, 0, 0]), Buffer.from([1, 0, 0, 0, 0xfc, 0, 0]), Buffer.alloc(70000, 0xff), null]) {
      assert.throws(() => checkDecoderConfig(bad), { message: /Invalid H\.264 configuration/ });
    }
  });
});
