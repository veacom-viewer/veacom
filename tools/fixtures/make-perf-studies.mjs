import { dataset, element } from './dicom-elements.mjs';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Synthetic DICOM fixtures covering workloads absent from CI's uncompressed single-file CT checks:
// - ct-12bit-500: 500-slice unsigned 12-bit CT with RescaleIntercept = -1024 (the dominant clinical CT encoding)
// - multiframe-200: single-file 200-frame uncompressed CT (100 MiB)
// - rle-100: 100-slice RLE Lossless compressed CT (1.2.840.10008.1.2.5)
// Every study records the exact SHA-256 of its decoded little-endian int16 physical pixels.

const [destination, kind = 'all'] = process.argv.slice(2);
if (!destination || !['all', 'ct-12bit-500', 'multiframe-200', 'rle-100'].includes(kind)) {
  throw new Error('Usage: node tools/fixtures/make-perf-studies.mjs <directory> [all|ct-12bit-500|multiframe-200|rle-100]');
}

const ROOT = '2.25.302617644913925066835652647005517224299';
const CT_SOP = '1.2.840.10008.5.1.4.1.1.2';
const EXPLICIT_LE = '1.2.840.10008.1.2.1';
const RLE_LOSSLESS = '1.2.840.10008.1.2.5';

function phantomHu(x, y, z, size, slices) {
  const r = Math.hypot((x - size / 2) / (size * 0.42), (y - size / 2) / (size * 0.36), (z - slices / 2) / Math.max(1, slices * 0.45));
  const texture = ((x * 7 + y * 3 + z * 11) % 21) - 10;
  return r > 1 ? -1000 : r > 0.88 ? 1200 : 40 + texture;
}

function dicomMeta(sopClass, uid, transferSyntax) {
  const meta = dataset([
    [0x0002, 0x0001, 'OB', [0, 1]],
    [0x0002, 0x0002, 'UI', sopClass],
    [0x0002, 0x0003, 'UI', uid],
    [0x0002, 0x0010, 'UI', transferSyntax],
    [0x0002, 0x0012, 'UI', `${ROOT}.4`],
  ]);
  return Buffer.concat([Buffer.alloc(128), Buffer.from('DICM'), element(0x0002, 0x0000, 'UL', meta.length), meta]);
}

function packBits(bytes, rowWidth) {
  // DICOM PS3.5 Section G.3: each row must be encoded separately without runs crossing row boundaries.
  const out = [];
  for (let rowStart = 0; rowStart < bytes.length; rowStart += rowWidth) {
    const rowEnd = Math.min(bytes.length, rowStart + rowWidth);
    let i = rowStart;
    while (i < rowEnd) {
      let run = 1;
      while (run < 128 && i + run < rowEnd && bytes[i + run] === bytes[i]) run++;
      if (run >= 3) {
        out.push((257 - run) & 0xff, bytes[i]);
        i += run;
        continue;
      }
      const start = i;
      let lit = 0;
      while (lit < 128 && i < rowEnd) {
        if (i + 2 < rowEnd && bytes[i] === bytes[i + 1] && bytes[i] === bytes[i + 2]) break;
        i++;
        lit++;
      }
      out.push(lit - 1);
      for (let k = start; k < start + lit; k++) out.push(bytes[k]);
    }
  }
  if (out.length % 2) out.push(0);
  return Buffer.from(out);
}

function rleEncode16(raw, width) {
  const pixels = raw.length / 2;
  const hi = new Uint8Array(pixels);
  const lo = new Uint8Array(pixels);
  for (let i = 0; i < pixels; i++) {
    lo[i] = raw[i * 2];
    hi[i] = raw[i * 2 + 1];
  }
  const seg0 = packBits(hi, width);
  const seg1 = packBits(lo, width);
  const header = Buffer.alloc(64);
  header.writeUInt32LE(2, 0);
  header.writeUInt32LE(64, 4);
  header.writeUInt32LE(64 + seg0.length, 8);
  const fragment = Buffer.concat([header, seg0, seg1]);
  const pixelTag = Buffer.alloc(12);
  pixelTag.writeUInt16LE(0x7fe0, 0);
  pixelTag.writeUInt16LE(0x0010, 2);
  pixelTag.write('OB', 4, 'latin1');
  pixelTag.writeUInt32LE(0xffffffff, 8);
  const bot = Buffer.alloc(8);
  bot.writeUInt16LE(0xfffe, 0);
  bot.writeUInt16LE(0xe000, 2);
  bot.writeUInt32LE(0, 4);
  const item = Buffer.alloc(8);
  item.writeUInt16LE(0xfffe, 0);
  item.writeUInt16LE(0xe000, 2);
  item.writeUInt32LE(fragment.length, 4);
  const delim = Buffer.alloc(8);
  delim.writeUInt16LE(0xfffe, 0);
  delim.writeUInt16LE(0xe0dd, 2);
  delim.writeUInt32LE(0, 4);
  return Buffer.concat([pixelTag, bot, item, fragment, delim]);
}

async function makeCt12Bit(dir) {
  const size = 512, slices = 500;
  const seriesDir = path.join(dir, 'S01');
  await mkdir(seriesDir, { recursive: true });
  const hash = createHash('sha256');
  const physical = Buffer.alloc(size * size * 2);
  const stored = Buffer.alloc(size * size * 2);
  for (let z = 0; z < slices; z++) {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const hu = phantomHu(x, y, z, size, slices);
      const off = (y * size + x) * 2;
      physical.writeInt16LE(hu, off);
      stored.writeUInt16LE(hu + 1024, off);
    }
    hash.update(physical);
    const uid = `${ROOT}.12.3.${z + 1}`;
    const bytes = Buffer.concat([
      dicomMeta(CT_SOP, uid, EXPLICIT_LE),
      dataset([
        [0x0008, 0x0016, 'UI', CT_SOP], [0x0008, 0x0018, 'UI', uid],
        [0x0008, 0x0020, 'DA', '20000101'], [0x0008, 0x0030, 'TM', '120000'],
        [0x0008, 0x0060, 'CS', 'CT'], [0x0008, 0x103e, 'LO', 'Synthetic 12-bit CT'],
        [0x0010, 0x0010, 'PN', 'SYNTHETIC^PERF12'], [0x0010, 0x0020, 'LO', 'SYNTHETIC-PERF12'],
        [0x0018, 0x0050, 'DS', 1], [0x0020, 0x000d, 'UI', `${ROOT}.12.1`],
        [0x0020, 0x000e, 'UI', `${ROOT}.12.2`], [0x0020, 0x0011, 'IS', 1],
        [0x0020, 0x0013, 'IS', z + 1], [0x0020, 0x0032, 'DS', [0, 0, z]],
        [0x0020, 0x0037, 'DS', [1, 0, 0, 0, 1, 0]], [0x0020, 0x0052, 'UI', `${ROOT}.12.5`],
        [0x0028, 0x0002, 'US', 1], [0x0028, 0x0004, 'CS', 'MONOCHROME2'],
        [0x0028, 0x0010, 'US', size], [0x0028, 0x0011, 'US', size],
        [0x0028, 0x0030, 'DS', [1, 1]], [0x0028, 0x0100, 'US', 16],
        [0x0028, 0x0101, 'US', 12], [0x0028, 0x0102, 'US', 11],
        [0x0028, 0x0103, 'US', 0], [0x0028, 0x1050, 'DS', 40],
        [0x0028, 0x1051, 'DS', 400], [0x0028, 0x1052, 'DS', -1024],
        [0x0028, 0x1053, 'DS', 1], [0x7fe0, 0x0010, 'OW', stored],
      ]),
    ]);
    await writeFile(path.join(seriesDir, `IM${String(z).padStart(5, '0')}.dcm`), bytes);
  }
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify({
    generator: 'veacom-perf-studies-v1', kind: 'ct-12bit-500', synthetic: true,
    dimensions: [size, size, slices], pixelType: 'int16', pixelSha256: hash.digest('hex'),
  }, null, 2) + '\n');
}

async function makeMultiframe(dir) {
  const size = 512, slices = 200;
  const seriesDir = path.join(dir, 'S01');
  await mkdir(seriesDir, { recursive: true });
  const hash = createHash('sha256');
  const stored = Buffer.alloc(size * size * slices * 2);
  const physical = Buffer.alloc(size * size * 2);
  for (let z = 0; z < slices; z++) {
    const base = z * size * size * 2;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const hu = phantomHu(x, y, z, size, slices);
      const off = (y * size + x) * 2;
      physical.writeInt16LE(hu, off);
      stored.writeUInt16LE(hu + 1024, base + off);
    }
    hash.update(physical);
  }
  const uid = `${ROOT}.20.3.1`;
  const bytes = Buffer.concat([
    dicomMeta(CT_SOP, uid, EXPLICIT_LE),
    dataset([
      [0x0008, 0x0016, 'UI', CT_SOP], [0x0008, 0x0018, 'UI', uid],
      [0x0008, 0x0020, 'DA', '20000101'], [0x0008, 0x0030, 'TM', '120000'],
      [0x0008, 0x0060, 'CS', 'CT'], [0x0008, 0x103e, 'LO', 'Synthetic Multiframe CT'],
      [0x0010, 0x0010, 'PN', 'SYNTHETIC^PERFMF'], [0x0010, 0x0020, 'LO', 'SYNTHETIC-PERFMF'],
      [0x0018, 0x0050, 'DS', 1], [0x0018, 0x0088, 'DS', 1],
      [0x0020, 0x000d, 'UI', `${ROOT}.20.1`], [0x0020, 0x000e, 'UI', `${ROOT}.20.2`],
      [0x0020, 0x0011, 'IS', 1], [0x0020, 0x0013, 'IS', 1],
      [0x0020, 0x0032, 'DS', [0, 0, 0]], [0x0020, 0x0037, 'DS', [1, 0, 0, 0, 1, 0]],
      [0x0020, 0x0052, 'UI', `${ROOT}.20.5`],
      [0x0028, 0x0002, 'US', 1], [0x0028, 0x0004, 'CS', 'MONOCHROME2'],
      [0x0028, 0x0008, 'IS', slices],
      [0x0028, 0x0010, 'US', size], [0x0028, 0x0011, 'US', size],
      [0x0028, 0x0030, 'DS', [1, 1]], [0x0028, 0x0100, 'US', 16],
      [0x0028, 0x0101, 'US', 12], [0x0028, 0x0102, 'US', 11],
      [0x0028, 0x0103, 'US', 0], [0x0028, 0x1050, 'DS', 40],
      [0x0028, 0x1051, 'DS', 400], [0x0028, 0x1052, 'DS', -1024],
      [0x0028, 0x1053, 'DS', 1], [0x7fe0, 0x0010, 'OW', stored],
    ]),
  ]);
  await writeFile(path.join(seriesDir, 'MF00001.dcm'), bytes);
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify({
    generator: 'veacom-perf-studies-v1', kind: 'multiframe-200', synthetic: true,
    dimensions: [size, size, slices], pixelType: 'int16', pixelSha256: hash.digest('hex'),
  }, null, 2) + '\n');
}

async function makeRle(dir) {
  const size = 512, slices = 100;
  const seriesDir = path.join(dir, 'S01');
  await mkdir(seriesDir, { recursive: true });
  const hash = createHash('sha256');
  const raw = Buffer.alloc(size * size * 2);
  for (let z = 0; z < slices; z++) {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const hu = phantomHu(x, y, z, size, slices);
      raw.writeInt16LE(hu, (y * size + x) * 2);
    }
    hash.update(raw);
    const uid = `${ROOT}.30.3.${z + 1}`;
    const bytes = Buffer.concat([
      dicomMeta(CT_SOP, uid, RLE_LOSSLESS),
      dataset([
        [0x0008, 0x0016, 'UI', CT_SOP], [0x0008, 0x0018, 'UI', uid],
        [0x0008, 0x0020, 'DA', '20000101'], [0x0008, 0x0030, 'TM', '120000'],
        [0x0008, 0x0060, 'CS', 'CT'], [0x0008, 0x103e, 'LO', 'Synthetic RLE CT'],
        [0x0010, 0x0010, 'PN', 'SYNTHETIC^PERFRLE'], [0x0010, 0x0020, 'LO', 'SYNTHETIC-PERFRLE'],
        [0x0018, 0x0050, 'DS', 1], [0x0020, 0x000d, 'UI', `${ROOT}.30.1`],
        [0x0020, 0x000e, 'UI', `${ROOT}.30.2`], [0x0020, 0x0011, 'IS', 1],
        [0x0020, 0x0013, 'IS', z + 1], [0x0020, 0x0032, 'DS', [0, 0, z]],
        [0x0020, 0x0037, 'DS', [1, 0, 0, 0, 1, 0]], [0x0020, 0x0052, 'UI', `${ROOT}.30.5`],
        [0x0028, 0x0002, 'US', 1], [0x0028, 0x0004, 'CS', 'MONOCHROME2'],
        [0x0028, 0x0010, 'US', size], [0x0028, 0x0011, 'US', size],
        [0x0028, 0x0030, 'DS', [1, 1]], [0x0028, 0x0100, 'US', 16],
        [0x0028, 0x0101, 'US', 16], [0x0028, 0x0102, 'US', 15],
        [0x0028, 0x0103, 'US', 1], [0x0028, 0x1050, 'DS', 40],
        [0x0028, 0x1051, 'DS', 400], [0x0028, 0x1052, 'DS', 0],
        [0x0028, 0x1053, 'DS', 1],
      ]),
      rleEncode16(raw, size),
    ]);
    await writeFile(path.join(seriesDir, `IM${String(z).padStart(5, '0')}.dcm`), bytes);
  }
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify({
    generator: 'veacom-perf-studies-v1', kind: 'rle-100', synthetic: true,
    dimensions: [size, size, slices], pixelType: 'int16', pixelSha256: hash.digest('hex'),
  }, null, 2) + '\n');
}

const tasks = {
  'ct-12bit-500': () => makeCt12Bit(kind === 'all' ? path.join(destination, 'ct-12bit-500') : destination),
  'multiframe-200': () => makeMultiframe(kind === 'all' ? path.join(destination, 'multiframe-200') : destination),
  'rle-100': () => makeRle(kind === 'all' ? path.join(destination, 'rle-100') : destination),
};
if (kind === 'all') {
  await mkdir(destination, { recursive: true });
  for (const [name, build] of Object.entries(tasks)) {
    await build();
    console.log(`Generated ${name} in ${path.join(destination, name)}`);
  }
} else {
  await tasks[kind]();
  console.log(`Generated ${kind} in ${destination}`);
}
