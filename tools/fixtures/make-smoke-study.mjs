import { dataset, element } from './dicom-elements.mjs';
// A small deterministic CT for the manual CI smoke job. Performance and golden tests use ct-small instead.
// `--modality MR` writes the same phantom as an MR study with its own UIDs, for the checks of what only MR has
// (the assessment button, whose pre-diagnosis is switched off for now); the CT is the default and does not change.
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [destination, ...options] = process.argv.slice(2);
const large = options.includes('--pipe-volume');
const flag = options.indexOf('--modality'), modality = flag >= 0 ? options[flag + 1] : 'CT';
if (!destination || !['CT', 'MR'].includes(modality) || options.length !== (flag >= 0 ? 2 : 0) + Number(large)) {
  throw new Error('Usage: node tools/fixtures/make-smoke-study.mjs <new-directory> [--modality CT|MR] [--pipe-volume]');
}
const mr = modality === 'MR';
await mkdir(destination); // Refuse to replace an existing study.
const series = path.join(destination, 'S01');
await mkdir(series);
// The MR's UIDs sit under their own branch, so both studies can be open together.
const root = `2.25.302617644913925066835652647005517224101${mr ? '.10' : ''}`;
const sopClass = mr ? '1.2.840.10008.5.1.4.1.1.4' : '1.2.840.10008.5.1.4.1.1.2', transferSyntax = '1.2.840.10008.1.2.1';
const size = large ? 512 : 128, slices = large ? 1000 : 100, hashes = {};
const volumeHash = createHash('sha256');
for (let z = 0; z < slices; z++) {
  const uid = `${root}.3.${z + 1}`;
  const pixels = Buffer.alloc(size * size * 2);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const r = Math.hypot((x - size / 2) / 53, (y - size / 2) / 46, (z - slices / 2) / 70);
    const texture = ((x * 7 + y * 3 + z * 11) % 21) - 10;
    // CT in HU (air, bone rim, soft tissue); MR in arbitrary signal (none outside, a bright rim, tissue).
    const value = mr ? (r > 1 ? 0 : r > 0.88 ? 900 : 400 + texture) : (r > 1 ? -1000 : r > 0.88 ? 1200 : 40 + texture);
    pixels.writeInt16LE(value, (y * size + x) * 2);
  }
  if (large) volumeHash.update(pixels);
  const meta = dataset([
    [0x0002, 0x0001, 'OB', [0, 1]], [0x0002, 0x0002, 'UI', sopClass], [0x0002, 0x0003, 'UI', uid],
    [0x0002, 0x0010, 'UI', transferSyntax], [0x0002, 0x0012, 'UI', `${root}.4`],
  ]);
  const bytes = Buffer.concat([Buffer.alloc(128), Buffer.from('DICM'), element(0x0002, 0x0000, 'UL', meta.length), meta, dataset([
    [0x0008, 0x0016, 'UI', sopClass], [0x0008, 0x0018, 'UI', uid], [0x0008, 0x0020, 'DA', '20000101'], [0x0008, 0x0030, 'TM', '120000'],
    [0x0008, 0x0060, 'CS', modality], [0x0008, 0x103e, 'LO', `Synthetic CI smoke ${modality}`], [0x0010, 0x0010, 'PN', 'SYNTHETIC^SMOKE'],
    [0x0010, 0x0020, 'LO', 'SYNTHETIC-SMOKE'], [0x0018, 0x0050, 'DS', 1], [0x0020, 0x000d, 'UI', `${root}.1`], [0x0020, 0x000e, 'UI', `${root}.2`],
    [0x0020, 0x0011, 'IS', 1], [0x0020, 0x0013, 'IS', z + 1], [0x0020, 0x0032, 'DS', [0, 0, z]], [0x0020, 0x0037, 'DS', [1, 0, 0, 0, 1, 0]],
    [0x0020, 0x0052, 'UI', `${root}.5`], [0x0028, 0x0002, 'US', 1], [0x0028, 0x0004, 'CS', 'MONOCHROME2'], [0x0028, 0x0010, 'US', size],
    [0x0028, 0x0011, 'US', size], [0x0028, 0x0030, 'DS', [1, 1]], [0x0028, 0x0100, 'US', 16], [0x0028, 0x0101, 'US', 16], [0x0028, 0x0102, 'US', 15],
    // An MR image has no rescale to a physical unit.
    ...(mr ? [[0x0028, 0x0103, 'US', 1], [0x0028, 0x1050, 'DS', 450], [0x0028, 0x1051, 'DS', 1000]]
      : [[0x0028, 0x0103, 'US', 1], [0x0028, 0x1050, 'DS', 40], [0x0028, 0x1051, 'DS', 400], [0x0028, 0x1052, 'DS', 0], [0x0028, 0x1053, 'DS', 1]]),
    [0x7fe0, 0x0010, 'OW', pixels],
  ])]);
  const name = `IM${String(z).padStart(5, '0')}.dcm`;
  await writeFile(path.join(series, name), bytes);
  hashes[`S01/${name}`] = createHash('sha256').update(bytes).digest('hex');
}
await writeFile(path.join(destination, 'manifest.json'), JSON.stringify({ generator: 'veacom-ci-smoke-v1', synthetic: true, ...(mr ? { modality } : {}),
  dimensions: [size, size, slices], ...(large ? { pixelSha256: volumeHash.digest('hex') } : {}), transferSyntax, sha256: hashes }, null, 2) + '\n');
console.log(`Generated ${slices} synthetic ${modality} slices in ${destination}`);
