// Synthetic multi-frame secondary captures with an independently readable index in each frame.
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { drawBand } from '../browser-bench/lib/marker.mjs';
import { dataset, element } from './dicom-elements.mjs';

const [folder] = process.argv.slice(2);
if (!folder) throw new Error('Usage: node tools/fixtures/make-cine-study.mjs <new directory>');
await mkdir(folder);
const size = 128, frames = 60, sopClass = '1.2.840.10008.5.1.4.1.1.7.2', syntax = '1.2.840.10008.1.2.1';
const bytes = Buffer.alloc(size * size * frames, 64);
for (let i = 0; i < frames; i++) drawBand(bytes.subarray(i * size * size, (i + 1) * size * size), size, i, 0, 255);
const hashes = {};
for (const [index, clip] of ['20-fps', '40-fps', 'variable'].entries()) {
  const root = '2.25.29189915746479167584147502386506012063.' + (index + 1), sop = root + '.1';
  const vector = clip === 'variable', rate = index === 0 ? 20 : 40;
  const meta = dataset([[2, 1, 'OB', [0, 1]], [2, 2, 'UI', sopClass], [2, 3, 'UI', sop], [2, 0x10, 'UI', syntax], [2, 0x12, 'UI', root + '.2']]);
  const data = dataset([
    [0x0008, 0x0008, 'CS', ['DERIVED', 'SECONDARY']], [0x0008, 0x0016, 'UI', sopClass], [0x0008, 0x0018, 'UI', sop],
    [0x0008, 0x0060, 'CS', 'OT'], [0x0008, 0x0064, 'CS', 'SYN'], [0x0008, 0x103e, 'LO', clip],
    ...(vector ? [] : [[0x0008, 0x2144, 'IS', rate]]),
    [0x0010, 0x0010, 'PN', 'SYNTHETIC^CINE'], [0x0010, 0x0020, 'LO', 'CINE-TEST'],
    ...(vector ? [[0x0018, 0x1065, 'DS', Array.from({ length: frames }, (_, i) => i === 0 ? 0 : i % 2 ? 25 : 75)]] : [[0x0018, 0x1063, 'DS', 1000 / rate]]),
    [0x0018, 0x1244, 'US', 0], [0x0020, 0x000d, 'UI', root + '.3'], [0x0020, 0x000e, 'UI', root + '.4'],
    [0x0020, 0x0011, 'IS', 1], [0x0020, 0x0013, 'IS', 1], [0x0028, 0x0002, 'US', 1], [0x0028, 0x0004, 'CS', 'MONOCHROME2'],
    [0x0028, 0x0008, 'IS', frames], [0x0028, 0x0009, 'AT', [[0x0018, vector ? 0x1065 : 0x1063]]],
    [0x0028, 0x0010, 'US', size], [0x0028, 0x0011, 'US', size], [0x0028, 0x0100, 'US', 8],
    [0x0028, 0x0101, 'US', 8], [0x0028, 0x0102, 'US', 7], [0x0028, 0x0103, 'US', 0],
    [0x0028, 0x0301, 'CS', 'NO'], [0x0028, 0x1050, 'DS', 128], [0x0028, 0x1051, 'DS', 256],
    [0x0028, 0x2110, 'CS', '00'], [0x2050, 0x0020, 'CS', 'IDENTITY'], [0x7fe0, 0x0010, 'OB', bytes],
  ]);
  const file = clip + '.dcm', part10 = Buffer.concat([Buffer.alloc(128), Buffer.from('DICM'), element(2, 0, 'UL', meta.length), meta, data]);
  await writeFile(path.join(folder, file), part10);
  hashes[file] = createHash('sha256').update(part10).digest('hex');
}
await writeFile(path.join(folder, 'manifest.json'), JSON.stringify({ generator: 'veacom-cine-v1', synthetic: true, dimensions: [size, size, frames], syntax, sha256: hashes }, null, 2) + '\n');
