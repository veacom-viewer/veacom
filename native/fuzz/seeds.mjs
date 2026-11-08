// Synthetic Part 10 inputs for the structure and compressed-frame guards.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const directory = process.argv[2];
mkdirSync(directory, { recursive: true });

function u16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }
function even(bytes) { return bytes.length % 2 ? Buffer.concat([bytes, Buffer.alloc(1)]) : bytes; }
function tag(group, number, vr, bytes) {
  const data = even(Buffer.from(bytes));
  const length = ['OB', 'OW'].includes(vr) ? Buffer.concat([u16(0), u32(data.length)]) : u16(data.length);
  return Buffer.concat([u16(group), u16(number), Buffer.from(vr), length, data]);
}
function item(number, data) { return Buffer.concat([u16(0xfffe), u16(number), u32(data.length), data]); }
function seed(syntax, fragment, rows = 2) {
  const meta = Buffer.concat([
    tag(2, 2, 'UI', '1.2.840.10008.5.1.4.1.1.2'), tag(2, 3, 'UI', '2.25.1'),
    tag(2, 0x10, 'UI', syntax), tag(2, 0x12, 'UI', '2.25.2'),
  ]);
  const pixel = fragment ? Buffer.concat([u16(0x7fe0), u16(16), Buffer.from('OB'), u16(0), u32(0xffffffff),
    item(0xe000, Buffer.alloc(0)), item(0xe000, even(fragment)), item(0xe0dd, Buffer.alloc(0))]) : tag(0x7fe0, 16, 'OW', Buffer.alloc(4));
  return Buffer.concat([Buffer.alloc(128), Buffer.from('DICM'), tag(2, 0, 'UL', u32(meta.length)), meta,
    ...[[2, 1], [16, rows], [17, 2], [256, 8], [257, 8], [258, 7], [259, 0]].map(([n, v]) => tag(0x28, n, 'US', u16(v))),
    tag(0x28, 4, 'CS', 'MONOCHROME2 '), pixel]);
}
const native = seed('1.2.840.10008.1.2.1');
const rle = Buffer.concat([u32(1), u32(64), Buffer.alloc(56), Buffer.from([3, 1, 2, 3, 4])]);
const jpeg = 'ffd8ffc0000b080002000201011100ffda0008010100003f00ffd9';
const inputs = { native, truncated: native.subarray(0, -4), size: seed('1.2.840.10008.1.2.1', undefined, 65535),
  rle: seed('1.2.840.10008.1.2.5', rle), jpeg: seed('1.2.840.10008.1.2.4.50', Buffer.from(jpeg, 'hex')),
  'jpeg-ls': seed('1.2.840.10008.1.2.4.80', Buffer.from(jpeg.replace('ffc0', 'fff7'), 'hex')),
  jpeg2000: seed('1.2.840.10008.1.2.4.90', Buffer.concat([Buffer.from('ff4fff510029', 'hex'), Buffer.alloc(39)])) };
for (const [name, bytes] of Object.entries(inputs)) writeFileSync(join(directory, name), bytes);
