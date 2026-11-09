// Writes a bench study: a synthetic CT whose every slice carries its index in a marker band (lib/marker.mjs), so the
// harness can tell from the screen which slice any viewer shows. The same name always gives the same bytes; the
// manifest records each file's SHA-256 so a run can check its study before timing it.
//
//   node tools/browser-tools/browser-bench/make-study.mjs <name> [<folder>]
// Names: ct-300 (300 × 512², ~158 MB) and ct-1000 (1,000 × 512², ~525 MB), uncompressed Explicit VR Little Endian.
// The folder defaults to ~/.cache/veacom-bench/studies/<name>; an existing study is checked, not rewritten.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { dataset, element } from '../fixtures/dicom-elements.mjs';
import { drawBand } from './lib/marker.mjs';

export const STUDIES = {
  'ct-300': { slices: 300, size: 512, about: 'a 300-slice CT of 512×512, uncompressed' },
  'ct-1000': { slices: 1000, size: 512, about: 'a thin-slice 1,000-slice CT of 512×512, uncompressed, as in the Weasis comparison' },
};
const GENERATOR = 'veacom-bench-study-v1';
export const studyFolder = (name) => path.join(os.homedir(), '.cache', 'veacom-bench', 'studies', name);

/** The slice's stored values (HU): a body with a bone rim and two lungs that change along the stack, and the band. */
function slice(size, z, slices) {
  const values = new Int16Array(size * size), t = z / Math.max(1, slices - 1);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const body = Math.hypot((x - size / 2) / (size * 0.42), (y - size / 2) / (size * 0.34));
    const lung = Math.min(
      Math.hypot((x - size * 0.33) / (size * (0.06 + 0.07 * Math.sin(Math.PI * t))), (y - size * 0.47) / (size * 0.16)),
      Math.hypot((x - size * 0.67) / (size * (0.06 + 0.07 * Math.sin(Math.PI * t))), (y - size * 0.47) / (size * 0.16)));
    const texture = ((x * 7 + y * 3 + z * 11) % 21) - 10;
    values[y * size + x] = body > 1 ? -1000 : body > 0.9 ? 1200 : lung < 1 ? -800 + texture : 100 + texture;
  }
  drawBand(values, size, z, -3000, 3000);
  return values;
}

function file(name, size, z, slices) {
  const id = BigInt(`0x${createHash('sha256').update(name).digest('hex').slice(0, 24)}`).toString();
  const root = `2.25.${id}`, uid = `${root}.3.${z + 1}`;
  const sopClass = '1.2.840.10008.5.1.4.1.1.2', transferSyntax = '1.2.840.10008.1.2.1';
  const meta = dataset([
    [0x0002, 0x0001, 'OB', [0, 1]], [0x0002, 0x0002, 'UI', sopClass], [0x0002, 0x0003, 'UI', uid],
    [0x0002, 0x0010, 'UI', transferSyntax], [0x0002, 0x0012, 'UI', `${root}.4`],
  ]);
  const pixels = Buffer.from(slice(size, z, slices).buffer);
  // Head first, superior at slice 0: z falls along the stack, 1 mm apart.
  return Buffer.concat([Buffer.alloc(128), Buffer.from('DICM'), element(0x0002, 0x0000, 'UL', meta.length), meta, dataset([
    [0x0008, 0x0008, 'CS', ['ORIGINAL', 'PRIMARY', 'AXIAL']], [0x0008, 0x0016, 'UI', sopClass], [0x0008, 0x0018, 'UI', uid],
    [0x0008, 0x0020, 'DA', '20000101'], [0x0008, 0x0030, 'TM', '120000'], [0x0008, 0x0050, 'SH', 'BENCH'], [0x0008, 0x0060, 'CS', 'CT'],
    [0x0008, 0x0070, 'LO', 'VEAcom bench'], [0x0008, 0x103e, 'LO', `Bench ${name}`], [0x0010, 0x0010, 'PN', 'BENCH^SYNTHETIC'],
    [0x0010, 0x0020, 'LO', `BENCH-${name}`], [0x0010, 0x0030, 'DA', '19700101'], [0x0010, 0x0040, 'CS', 'O'],
    [0x0018, 0x0050, 'DS', 1], [0x0018, 0x5100, 'CS', 'HFS'], [0x0020, 0x000d, 'UI', `${root}.1`], [0x0020, 0x000e, 'UI', `${root}.2`],
    [0x0020, 0x0010, 'SH', '1'], [0x0020, 0x0011, 'IS', 1], [0x0020, 0x0013, 'IS', z + 1], [0x0020, 0x0032, 'DS', [-size / 2, -size / 2, -z]],
    [0x0020, 0x0037, 'DS', [1, 0, 0, 0, 1, 0]], [0x0020, 0x0052, 'UI', `${root}.5`], [0x0020, 0x1041, 'DS', -z],
    [0x0028, 0x0002, 'US', 1], [0x0028, 0x0004, 'CS', 'MONOCHROME2'], [0x0028, 0x0010, 'US', size], [0x0028, 0x0011, 'US', size],
    [0x0028, 0x0030, 'DS', [1, 1]], [0x0028, 0x0100, 'US', 16], [0x0028, 0x0101, 'US', 16], [0x0028, 0x0102, 'US', 15], [0x0028, 0x0103, 'US', 1],
    [0x0028, 0x1050, 'DS', 40], [0x0028, 0x1051, 'DS', 400], [0x0028, 0x1052, 'DS', 0], [0x0028, 0x1053, 'DS', 1], [0x0028, 0x1054, 'LO', 'HU'],
    [0x7fe0, 0x0010, 'OW', pixels],
  ])]);
}

/** Writes the study (or checks an existing one) and returns its manifest. */
export async function makeStudy(name, folder = studyFolder(name), { log = console.log } = {}) {
  const spec = STUDIES[name];
  if (!spec) throw new Error(`Unknown bench study ${name}; known: ${Object.keys(STUDIES).join(', ')}`);
  const manifestPath = path.join(folder, 'manifest.json');
  // Made one at a time (a 1,000-slice study is half a gigabyte).
  const expected = function* () {
    for (let z = 0; z < spec.slices; z++) yield [`S01/IM${String(z).padStart(5, '0')}.dcm`, file(name, spec.size, z, spec.slices)];
  };
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    for (const [relative, bytes] of expected()) {
      const want = createHash('sha256').update(bytes).digest('hex');
      if (manifest.sha256?.[relative] !== want) throw new Error(`${folder} is not ${name} as this generator writes it (${relative}); delete it to regenerate.`);
      const have = createHash('sha256').update(await readFile(path.join(folder, relative))).digest('hex');
      if (have !== want) throw new Error(`${path.join(folder, relative)} has changed on disk; delete ${folder} to regenerate.`);
    }
    return manifest;
  }
  // Written beside the final folder and renamed, so a half-written study is never taken for a whole one.
  const partial = `${folder}.partial-${process.pid}`;
  await rm(partial, { recursive: true, force: true });
  await mkdir(path.join(partial, 'S01'), { recursive: true });
  const sha256 = {};
  let bytes = 0;
  for (const [relative, content] of expected()) {
    await writeFile(path.join(partial, relative), content);
    sha256[relative] = createHash('sha256').update(content).digest('hex');
    bytes += content.length;
  }
  const manifest = { generator: GENERATOR, synthetic: true, name, about: spec.about, dimensions: [spec.size, spec.size, spec.slices],
    files: spec.slices, bytes, transferSyntax: '1.2.840.10008.1.2.1', marker: 'tools/browser-bench/lib/marker.mjs', sha256 };
  await writeFile(path.join(partial, 'manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`);
  await mkdir(path.dirname(folder), { recursive: true });
  await rename(partial, folder);
  log(`Wrote ${name}: ${spec.slices} files, ${(bytes / 1e6).toFixed(0)} MB, in ${folder}`);
  return manifest;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [name, folder] = process.argv.slice(2);
  if (!name) throw new Error('Usage: node tools/browser-tools/browser-bench/make-study.mjs <name> [<folder>]');
  await makeStudy(name, folder ? path.resolve(folder) : undefined);
}
