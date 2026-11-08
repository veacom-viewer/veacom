// Exercise the desktop kit on variants of the synthetic follow-up's current PET.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { dataset, element } from './fixtures/dicom-elements.mjs';

const [fixture, output, ...extra] = process.argv.slice(2);
if (!fixture || !output || extra.length) throw new Error('Usage: node tools/check-pet-validation-cases.mjs FOLLOWUP_DIR OUTPUT_DIR');
const manifest = JSON.parse(await readFile(path.join(fixture, 'manifest.json'), 'utf8'));
assert(manifest.synthetic && manifest.generator === 'veacom-pet-followup-v2');
const current = manifest.studies.find(study => study.name === 'current');
const pet = path.join(fixture, current.folder, current.series.find(series => series.modality === 'PT').folder);
const lesion = current.lesions.find(item => item.id === 'L1');
const sphere = { name: 'L1', center: lesion.center, radius: lesion.radius + 5 };

// Rebuild the fixture's single radiopharmaceutical item so its explicit sequence and item lengths stay correct.
function administration(time, datetime) {
  const item = dataset([[0x0018, 0x0031, 'LO', 'Fludeoxyglucose F^18^'], [0x0018, 0x1072, 'TM', time],
    [0x0018, 0x1074, 'DS', manifest.suv.doseBq], [0x0018, 0x1075, 'DS', 6586.2], ...(datetime ? [[0x0018, 0x1078, 'DT', datetime]] : [])]);
  const header = Buffer.from([0xfe, 0xff, 0x00, 0xe0, 0, 0, 0, 0]);
  header.writeUInt32LE(item.length, 4);
  return element(0x0054, 0x0016, 'SQ', Buffer.concat([header, item]));
}

const units = value => element(0x0054, 0x1001, 'CS', value);
const slope = value => element(0x0028, 0x1053, 'DS', value);
const correction = value => element(0x0028, 0x0051, 'CS', value);
const decay = value => element(0x0054, 0x1102, 'CS', value);
const originalDrug = administration(current.pet.injection);
const cases = [
  { study: 'raw', edits: [[correction(['ATTN', 'DECY']), correction(['SCAT', 'DECY'])]],
    vendor: { spheres: { L1: { maxBqml: 1000 } } } },
  { study: 'stored', edits: [[units('BQML'), Buffer.concat([units('GML'), element(0x0054, 0x1006, 'CS', 'LBM')])],
    [slope(1), slope(0.00035)], [originalDrug, administration('11')]],
    vendor: { suv: { injectionTime: '11:00:00' }, spheres: { L1: { SUL: { max: 7, peak: 7 } } } } },
  { study: 'dated', edits: [[originalDrug, administration('103000', current.date + '104800')], [decay('ADMIN'), decay('START')]],
    vendor: { suv: { injectionTime: '10:48:00' }, spheres: { L1: { SUVbw: { max: 0 }, maxBqml: 0 } } } },
];

const temp = await mkdtemp(path.join(tmpdir(), 'veacom-pet-validation-cases-'));
try {
  for (const { study, edits } of cases) {
    const folder = path.join(temp, study);
    await mkdir(folder);
    for (const file of await readdir(pet)) {
      const original = await readFile(path.join(pet, file));
      const pixelStart = original.indexOf(Buffer.from([0xe0, 0x7f, 0x10, 0x00, 0x4f, 0x57, 0, 0]), 132);
      assert(pixelStart > 132, `Missing pixel data in ${file}`);
      let header = original.subarray(0, pixelStart);
      for (const [before, after] of edits) {
        const at = header.indexOf(before);
        assert(at >= 0 && at === header.lastIndexOf(before), `Expected one matching DICOM element in ${file}`);
        header = Buffer.concat([header.subarray(0, at), after, header.subarray(at + before.length)]);
      }
      await writeFile(path.join(folder, file), Buffer.concat([header, original.subarray(pixelStart)]));
    }
  }
  const spheres = path.join(temp, 'spheres.json'), vendor = path.join(temp, 'vendor.json');
  await writeFile(path.join(temp, 'manifest.json'), JSON.stringify({ synthetic: true }));
  await writeFile(spheres, JSON.stringify({ studies: cases.map(({ study }) => ({ study, spheres: [sphere] })) }));
  await writeFile(vendor, JSON.stringify({ studies: cases.map(({ study, vendor }) => ({ study, ...vendor })) }));
  const run = spawnSync(process.execPath, [path.join(import.meta.dirname, 'pet-validation.cjs'), temp, spheres, output, '--vendor', vendor], { stdio: 'inherit' });
  if (run.error) throw run.error;
  assert.equal(run.status, 1, 'The deliberately wrong vendor readings should fail.');
  const report = JSON.parse(await readFile(path.join(output, 'run.json'), 'utf8'));
  assert.deepEqual(report.comparison, { within: 3, beyond: 3, reported: 1, missing: 0 });
  const csv = await readFile(path.join(output, 'comparison.csv'), 'utf8');
  assert.match(csv, /^raw,L1,Bq\/ml,max,20000,1000,1900,0.5,beyond,/m);
  assert.match(csv, /^stored,L1,SUL,max,7,7,0,1,within,"Stored SUVlbm, DICOM SUV Type LBM\."/m);
  assert.match(csv, /^stored,,,injection time,11,11:00:00,,,reported,/m);
  assert.match(csv, /^dated,,,injection time,10:48:00,10:48:00,,,within,/m);
  assert.match(csv, /^dated,L1,SUVbw,max,[\d.]+,0,,1,beyond,/m);
} finally {
  await rm(temp, { recursive: true, force: true });
}
