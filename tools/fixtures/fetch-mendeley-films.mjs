// Two real standing long-leg films for the landmark model's checks, fetched from Mendeley Data and wrapped as DX DICOM.
// They are not in this repository and not published anywhere by it: each film is fetched from the dataset's public
// download path, checked against its pinned SHA-256, kept in a local cache (CI's actions/cache), and written out here.
//
// Source: Przystalski K, Paleczek A, Szustakowski K, Wawryka P, Jungiewicz M, Miśkowiec K, Zalewski M, Kwiatkowski J,
// Gądek A. High Tibial Osteotomy. Mendeley Data, V3, 2022. https://doi.org/10.17632/bpvj6xczm2.3. Licence CC BY-NC 3.0.
// Standing AP films taken at ORTOTOP Medical Center (Poland), 8-bit greyscale PNG.
//
// - 49_0: both legs, hips to ankles. The model is sure of both legs and suggests their landmarks.
// - 10_0: the film stops mid-tibia, below the knees and above the ankles. The model is not sure of either leg's
//   ankle and suggests nothing.
//
// Neither PNG states a spacing or an orientation. Each film's spacing is read off the ruler on its right edge: its
// 10 mm marks, found in a column profile, and 10 mm over their mean gap. That is the ruler's plane, so it is stated as a
// FIDUCIAL calibration. Imager Pixel Spacing is left out: the detector's is not known, and none is made up. They are
// AP films, shown as such films are (the patient's right on the image's left; 10_0's
// L marker is on the image's right), so Patient Orientation is L\F.
//
//   node tools/fixtures/fetch-mendeley-films.mjs <new-directory> [--cache=<directory>]
//
// The cache defaults to ~/.cache/veacom-fixtures/mendeley; a cached film whose hash does not match is fetched again.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { dataset, element } from './dicom-elements.mjs';

const { decodePng } = createRequire(import.meta.url)('../lib/png.cjs');

const GENERATOR = 'veacom-mendeley-longleg-v1';
const DATASET = 'bpvj6xczm2', VERSION = 3;
const CREDIT = 'Przystalski K, Paleczek A, Szustakowski K, Wawryka P, Jungiewicz M, Miśkowiec K, Zalewski M, Kwiatkowski J, Gądek A. '
  + 'High Tibial Osteotomy. Mendeley Data, V3, 2022. https://doi.org/10.17632/bpvj6xczm2.3 (CC BY-NC 3.0)';
const FILMS = {
  '49_0': { id: 'c2eb2001-9ca0-46e2-9232-de9f473533e4', bytes: 10_215_831, sha256: '464577ceabe8e29a8daf395be111b696fa6cbe4ddb1e245de5b14aaa04cb0a16',
    columns: 2860, rows: 9289, mm: 0.1411, ruler: '70.88 px per 10 mm, 36 marks', shows: 'both legs, hips to ankles', expect: 'suggestions' },
  '10_0': { id: 'ee9b912a-cbc2-4c2e-aafe-64fa3c09a4f1', bytes: 6_997_255, sha256: '00b7b24708527ebbf3aac00ba8969cd769b3f969bd16a4ca68af3ec7972380c1',
    columns: 2860, rows: 6561, mm: 0.1449, ruler: '69.02 px per 10 mm, 22 marks', shows: 'hips to mid-tibia, no ankles', expect: 'unsure' },
};

const [destination, ...options] = process.argv.slice(2);
const cacheOption = options.find(option => option.startsWith('--cache='));
if (!destination || options.some(option => option !== cacheOption)) {
  throw new Error('Usage: node tools/fixtures/fetch-mendeley-films.mjs <new-directory> [--cache=<directory>]');
}
const cache = path.resolve(cacheOption?.slice('--cache='.length) ?? path.join(os.homedir(), '.cache', 'veacom-fixtures', 'mendeley'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** The film's PNG from the cache, or from Mendeley Data (three tries), checked against its pinned size and hash. */
async function film(name, { id, bytes, sha256: pinned }) {
  const cached = path.join(cache, `${name}.png`);
  const kept = await readFile(cached).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (kept && sha256(kept) === pinned) return { png: kept, from: 'cache' };
  const url = `https://data.mendeley.com/public-files/datasets/${DATASET}/files/${id}/file_downloaded`;
  let failure;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(90_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const png = Buffer.from(await response.arrayBuffer());
      if (png.length !== bytes || sha256(png) !== pinned) throw new Error(`${png.length} bytes, SHA-256 ${sha256(png)}, not the pinned film`);
      await mkdir(cache, { recursive: true });
      await writeFile(`${cached}.part`, png);
      await rename(`${cached}.part`, cached);
      return { png, from: url };
    } catch (error) {
      failure = error;
      console.warn(`${name}: try ${attempt} of 3 failed: ${error.message}`);
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, attempt * 10_000));
    }
  }
  throw new Error(`Could not fetch Mendeley film ${name} from ${url}: ${failure.message}`);
}

/** DX For Presentation, Explicit VR Little Endian, the PNG's 8-bit grey values as stored. */
function dicom(name, film, grey, number) {
  const root = '2.25.297618404457296114650541803760744227', uid = `${root}.3.${number}`;
  const sopClass = '1.2.840.10008.5.1.4.1.1.1.1', transferSyntax = '1.2.840.10008.1.2.1';
  const description = `Mendeley HTO ${name}, ${film.shows}`;
  const meta = dataset([[0x0002, 0x0001, 'OB', [0, 1]], [0x0002, 0x0002, 'UI', sopClass], [0x0002, 0x0003, 'UI', uid],
    [0x0002, 0x0010, 'UI', transferSyntax], [0x0002, 0x0012, 'UI', `${root}.4`]]);
  const elements = [
    [0x0008, 0x0008, 'CS', ['DERIVED', 'PRIMARY']], [0x0008, 0x0016, 'UI', sopClass], [0x0008, 0x0018, 'UI', uid],
    [0x0008, 0x0020, 'DA', '20220930'], [0x0008, 0x0030, 'TM', '120000'], [0x0008, 0x0060, 'CS', 'DX'], [0x0008, 0x0068, 'CS', 'FOR PRESENTATION'],
    [0x0008, 0x0080, 'LO', 'ORTOTOP Medical Center (Poland)'], [0x0008, 0x103e, 'LO', description],
    [0x0010, 0x0010, 'PN', `MENDELEY^HTO ${name}`], [0x0010, 0x0020, 'LO', `MENDELEY-HTO-${name}`], [0x0018, 0x0015, 'CS', 'LEG'],
    [0x0018, 0x5101, 'CS', 'AP'],
    [0x0020, 0x000d, 'UI', `${root}.1.${number}`], [0x0020, 0x000e, 'UI', `${root}.2.${number}`], [0x0020, 0x0011, 'IS', 1], [0x0020, 0x0013, 'IS', 1],
    [0x0020, 0x0020, 'CS', ['L', 'F']], [0x0020, 0x0062, 'CS', 'B'],
    [0x0028, 0x0002, 'US', 1], [0x0028, 0x0004, 'CS', 'MONOCHROME2'], [0x0028, 0x0010, 'US', film.rows], [0x0028, 0x0011, 'US', film.columns],
    [0x0028, 0x0030, 'DS', [film.mm, film.mm]],
    [0x0028, 0x0100, 'US', 8], [0x0028, 0x0101, 'US', 8], [0x0028, 0x0102, 'US', 7], [0x0028, 0x0103, 'US', 0],
    [0x0028, 0x0a02, 'CS', 'FIDUCIAL'], [0x0028, 0x0a04, 'LO', `Ruler on the film: ${film.ruler}`],
    [0x0028, 0x1040, 'CS', 'LIN'], [0x0028, 0x1041, 'SS', 1], [0x0028, 0x1050, 'DS', 128], [0x0028, 0x1051, 'DS', 256],
    [0x2050, 0x0020, 'CS', 'IDENTITY'],
    [0x7fe0, 0x0010, 'OB', grey],
  ];
  return { description, bytes: Buffer.concat([Buffer.alloc(128), Buffer.from('DICM'), element(0x0002, 0x0000, 'UL', meta.length), meta, dataset(elements)]) };
}

// Every film first, so a failed fetch leaves no half-written study behind.
const fetched = [];
for (const [name, pinned] of Object.entries(FILMS)) fetched.push({ name, pinned, ...await film(name, pinned) });
await mkdir(destination); // Refuse to replace an existing study.
const series = {};
let number = 0;
for (const { name, pinned, png, from } of fetched) {
  number++;
  const image = decodePng(png);
  if (image.width !== pinned.columns || image.height !== pinned.rows) throw new Error(`${name} is ${image.width} × ${image.height}, not the pinned size.`);
  const grey = Buffer.alloc(image.width * image.height);
  for (let i = 0; i < grey.length; i++) {
    const [r, g, b] = [image.data[i * 4], image.data[i * 4 + 1], image.data[i * 4 + 2]];
    if (r !== g || g !== b) throw new Error(`${name} is not greyscale.`);
    grey[i] = r;
  }
  const { description, bytes } = dicom(name, pinned, grey, number);
  const file = `mendeley-hto-${name}.dcm`;
  await writeFile(path.join(destination, file), bytes);
  series[name] = { file, description, source: `${name}.png`, sha256: pinned.sha256, columns: pinned.columns, rows: pinned.rows,
    mmPerPixel: pinned.mm, ruler: pinned.ruler, shows: pinned.shows, expect: pinned.expect, patientOrientation: ['L', 'F'] };
  console.log(`${name}: ${from === 'cache' ? 'from the cache' : 'fetched from Mendeley Data'}, ${pinned.columns} × ${pinned.rows}, ${pinned.mm} mm per pixel`);
}
await writeFile(path.join(destination, 'manifest.json'), JSON.stringify({
  generator: GENERATOR, credit: CREDIT, dataset: { publisher: 'Mendeley Data', id: DATASET, version: VERSION, doi: '10.17632/bpvj6xczm2.3', licence: 'CC BY-NC 3.0' },
  note: 'Fetched for checks only; not kept in or published by VEAcom. Pixel Spacing is read off each film\'s ruler.',
  series,
}, null, 2) + '\n');
console.log(`Wrote ${number} Mendeley films to ${destination}. ${CREDIT}`);
