// A small deterministic PET/CT follow-up for the PET quantification checks: one synthetic patient, a prior study and a
// current one, each a CT and an attenuation-corrected PET in Bq/ml with what SUV needs (weight, height, sex, dose,
// decay correction to administration). The PET has no noise and no blur, so every value a check reads is known: uniform
// liver (SUV 2), descending aorta (the mediastinal blood pool, SUV 1.5) and two lesions whose SUV falls from the prior
// to the current study. The prior was scanned at another table position, over more slices, in its own frame of reference.
// It was also scanned 72 min after its injection rather than 60, on another scanner model with another reconstruction,
// and records no blood glucose; the current PET records 5.4 mmol/l (Acquisition Context, CP-1229). The values are
// decay corrected to the injection, so the uptake time changes none of them.
//
//   node tools/fixtures/make-pet-followup.mjs <new-directory>
//
// The directory gets prior/ and current/ (a study each) and manifest.json with the lesions and regions in each study's
// patient coordinates.
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [destination, ...rest] = process.argv.slice(2);
if (!destination || rest.length) throw new Error('Usage: node tools/fixtures/make-pet-followup.mjs <new-directory>');
await mkdir(destination); // Refuse to replace an existing study.

// DICOM Part 10, Explicit VR Little Endian: just the value types these studies use, sequences with explicit lengths
// (as tools/fixtures/make-petct-study.mjs writes them).
const LONG_LENGTH = new Set(['OB', 'OW', 'SQ']);
function element(group, item, vr, value) {
  let body;
  if (vr === 'SQ') body = Buffer.concat(value.map(entries => { const data = dataset(entries), header = Buffer.alloc(8); header.writeUInt16LE(0xfffe); header.writeUInt16LE(0xe000, 2); header.writeUInt32LE(data.length, 4); return Buffer.concat([header, data]); }));
  else if (vr === 'OB' || vr === 'OW') body = Buffer.from(value);
  else if (vr === 'US') { body = Buffer.alloc(2); body.writeUInt16LE(value); }
  else if (vr === 'UL') { body = Buffer.alloc(4); body.writeUInt32LE(value); }
  else body = Buffer.from(Array.isArray(value) ? value.join('\\') : String(value), 'latin1');
  if (body.length % 2) body = Buffer.concat([body, Buffer.from(vr === 'UI' || vr === 'OB' ? [0] : [0x20])]);
  const header = Buffer.alloc(LONG_LENGTH.has(vr) ? 12 : 8);
  header.writeUInt16LE(group); header.writeUInt16LE(item, 2); header.write(vr, 4, 'latin1');
  if (LONG_LENGTH.has(vr)) header.writeUInt32LE(body.length, 8); else header.writeUInt16LE(body.length, 6);
  return Buffer.concat([header, body]);
}
function dataset(elements) { return Buffer.concat(elements.map(([group, item, vr, value]) => element(group, item, vr, value))); }

const root = '2.25.302617644913925066835652647005517224101.30', transferSyntax = '1.2.840.10008.1.2.1';
const code = (value, scheme, meaning) => [[0x0008, 0x0100, 'SH', value], [0x0008, 0x0102, 'SH', scheme], [0x0008, 0x0104, 'LO', meaning]];
const sliceGap = 4; // mm, head to feet
const weightKg = 70, heightM = 1.75, doseBq = 200e6, bqPerSuv = doseBq / (weightKg * 1000);

// Patient coordinates (LPS, mm) of the current study: x to the left, y to the back, z to the head; slice k at z = -4k.
const inside = (p, c, r) => Math.hypot((p[0] - c[0]) / r[0], (p[1] - c[1]) / r[1], (p[2] - c[2]) / r[2]);
const lungs = [[-85, -5, -90], [85, -5, -90]], lungSize = [50, 70, 75];
const liver = { center: [-75, 0, -215], size: [70, 65, 50], suv: 2, hu: 60 };
// The descending aorta: a cylinder along z, left of the spine and behind the heart.
const aorta = { center: [20, 30], radius: 12, from: -260, to: -40, suv: 1.5, hu: 45 };
const kidneys = [[-70, 50, -260], [70, 50, -260]], kidneySize = [22, 20, 40];
// The lesions: a right lung nodule and a node below the aorta. Uniform spheres, their SUV in each study.
const lesions = [
  { id: 'L1', center: [-80, -20, -100], radius: 15, suv: { prior: 10, current: 7 }, hu: 30 },
  { id: 'L2', center: [25, 10, -280], radius: 10, suv: { prior: 4.5, current: 3 }, hu: 40 },
];

/** CT value (HU) and PET uptake (SUV) at a point of the current study's patient coordinates. */
function tissue(p, study) {
  if (Math.hypot(p[0] / 165, p[1] / 115) > 1) return { hu: -1000, suv: 0 };
  let hu = 40, suv = 1;
  if (Math.hypot(p[0], p[1] - 75) < 16) { hu = 700; suv = 1.1; }
  for (const c of lungs) if (inside(p, c, lungSize) < 1) { hu = -820; suv = 0.4; }
  if (inside(p, [15, -25, -140], [45, 40, 40]) < 1) { hu = 40; suv = 1.8; }
  if (Math.hypot(p[0] - aorta.center[0], p[1] - aorta.center[1]) <= aorta.radius && p[2] >= aorta.from && p[2] <= aorta.to) { hu = aorta.hu; suv = aorta.suv; }
  if (inside(p, liver.center, liver.size) < 1) { hu = liver.hu; suv = liver.suv; }
  for (const c of kidneys) if (inside(p, c, kidneySize) < 1) { hu = 35; suv = 3; }
  for (const lesion of lesions) if (Math.hypot(p[0] - lesion.center[0], p[1] - lesion.center[1], p[2] - lesion.center[2]) <= lesion.radius) { hu = lesion.hu; suv = lesion.suv[study]; }
  return { hu, suv };
}
/** Repeatable texture in [-1, 1] for voxel (x, y, z) of one series. */
const noise = (x, y, z, salt) => { let h = (x * 374761393 + y * 668265263 + z * 1274126177 + salt * 2246822519) >>> 0; h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0; return ((h ^ (h >>> 16)) >>> 0) / 2 ** 31 - 1; };

// The prior was scanned 24 mm further along the table, so the same anatomy sits 24 mm higher in its coordinates, and
// over 84 slices instead of 80: its slices do not pair one for one with the current study's, so the two are linked by
// hand at a level the reader chooses.
// Each is scanned from 12:00; the prior's injection at 10:48 gives it 72 min of uptake, 12 min more than the current's.
const STUDIES = [
  { name: 'prior', number: 1, date: '19991001', shift: [0, 0, 24], slices: 84, injection: '104800', uptakeMinutes: 72,
    model: 'SYNTHETIC PET 1', reconstruction: 'OSEM 3i24s', glucoseMmol: null },
  { name: 'current', number: 2, date: '20000101', shift: [0, 0, 0], slices: 80, injection: '110000', uptakeMinutes: 60,
    model: 'SYNTHETIC PET 2', reconstruction: 'OSEM TOF PSF 4i5s', glucoseMmol: 5.4 },
];
const hashes = {};

async function writeSeries(study, { folder, prefix, number, description, size, spacing, ct }) {
  const directory = path.join(destination, study.name, folder);
  await mkdir(directory, { recursive: true });
  const sopClass = ct ? '1.2.840.10008.5.1.4.1.1.2' : '1.2.840.10008.5.1.4.1.1.128', origin = -(size - 1) / 2 * spacing;
  const seriesUid = `${root}.${study.number}.2.${number}`;
  for (let k = 0; k < study.slices; k++) {
    const z = -k * sliceGap, uid = `${root}.${study.number}.3.${number}.${k + 1}`, pixels = Buffer.alloc(size * size * 2);
    for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
      // This study's coordinates, back to the anatomy's.
      const p = [origin + i * spacing - study.shift[0], origin + j * spacing - study.shift[1], z - study.shift[2]];
      const { hu, suv } = tissue(p, study.name);
      if (ct) pixels.writeInt16LE(Math.round(hu + (hu > -1000 ? 10 * noise(i, j, k, number + study.number * 7) : 0)), (j * size + i) * 2);
      else pixels.writeUInt16LE(Math.max(0, Math.min(65535, Math.round(suv * bqPerSuv))), (j * size + i) * 2);
    }
    const meta = dataset([
      [0x0002, 0x0001, 'OB', [0, 1]], [0x0002, 0x0002, 'UI', sopClass], [0x0002, 0x0003, 'UI', uid],
      [0x0002, 0x0010, 'UI', transferSyntax], [0x0002, 0x0012, 'UI', `${root}.4`],
    ]);
    const bytes = Buffer.concat([Buffer.alloc(128), Buffer.from('DICM'), element(0x0002, 0x0000, 'UL', meta.length), meta, dataset([
      [0x0008, 0x0016, 'UI', sopClass], [0x0008, 0x0018, 'UI', uid], [0x0008, 0x0020, 'DA', study.date], [0x0008, 0x0021, 'DA', study.date],
      [0x0008, 0x0022, 'DA', study.date], [0x0008, 0x0030, 'TM', '120000'], [0x0008, 0x0031, 'TM', '120000'], [0x0008, 0x0032, 'TM', '120000'],
      [0x0008, 0x0060, 'CS', ct ? 'CT' : 'PT'], [0x0008, 0x0070, 'LO', 'SYNTHETIC'], [0x0008, 0x103e, 'LO', description], [0x0008, 0x1090, 'LO', study.model],
      [0x0010, 0x0010, 'PN', 'SYNTHETIC^FOLLOWUP'], [0x0010, 0x0020, 'LO', 'SYNTHETIC-FOLLOWUP'], [0x0010, 0x0021, 'LO', 'SYNTHETIC-SITE'], [0x0010, 0x0040, 'CS', 'M'],
      [0x0010, 0x1020, 'DS', heightM], [0x0010, 0x1030, 'DS', weightKg], [0x0018, 0x0050, 'DS', sliceGap],
      [0x0020, 0x000d, 'UI', `${root}.${study.number}.1`], [0x0020, 0x000e, 'UI', seriesUid], [0x0020, 0x0011, 'IS', number], [0x0020, 0x0013, 'IS', k + 1],
      [0x0020, 0x0032, 'DS', [origin, origin, z]], [0x0020, 0x0037, 'DS', [1, 0, 0, 0, 1, 0]], [0x0020, 0x0052, 'UI', `${root}.${study.number}.5`],
      [0x0028, 0x0002, 'US', 1], [0x0028, 0x0004, 'CS', 'MONOCHROME2'], [0x0028, 0x0010, 'US', size], [0x0028, 0x0011, 'US', size],
      [0x0028, 0x0030, 'DS', [spacing, spacing]], [0x0028, 0x0100, 'US', 16], [0x0028, 0x0101, 'US', 16], [0x0028, 0x0102, 'US', 15],
      ...(ct ? [[0x0028, 0x0103, 'US', 1], [0x0028, 0x1050, 'DS', 40], [0x0028, 0x1051, 'DS', 400], [0x0028, 0x1052, 'DS', 0], [0x0028, 0x1053, 'DS', 1]]
        : [[0x0028, 0x0051, 'CS', ['ATTN', 'DECY']], [0x0028, 0x0103, 'US', 0], [0x0028, 0x1052, 'DS', 0], [0x0028, 0x1053, 'DS', 1],
          ...(study.glucoseMmol ? [[0x0040, 0x0555, 'SQ', [[[0x0040, 0x08ea, 'SQ', [code('mmol/l', 'UCUM', 'mmol/l')]], [0x0040, 0xa040, 'CS', 'NUMERIC'],
            [0x0040, 0xa043, 'SQ', [code('14749-6', 'LN', 'Glucose')]], [0x0040, 0xa30a, 'DS', study.glucoseMmol]]]]] : []),
          [0x0054, 0x0016, 'SQ', [[[0x0018, 0x0031, 'LO', 'Fludeoxyglucose F^18^'], [0x0018, 0x1072, 'TM', study.injection], [0x0018, 0x1074, 'DS', doseBq], [0x0018, 0x1075, 'DS', 6586.2]]]],
          [0x0054, 0x1000, 'CS', ['WHOLE BODY', 'IMAGE']], [0x0054, 0x1001, 'CS', 'BQML'], [0x0054, 0x1102, 'CS', 'ADMIN'], [0x0054, 0x1103, 'LO', study.reconstruction]]),
      [0x7fe0, 0x0010, 'OW', pixels],
    ])]);
    const name = `${prefix}${String(k).padStart(5, '0')}.dcm`;
    await writeFile(path.join(directory, name), bytes);
    hashes[`${study.name}/${folder}/${name}`] = createHash('sha256').update(bytes).digest('hex');
  }
  return { folder, description, modality: ct ? 'CT' : 'PT', dimensions: [size, size, study.slices], spacing: [spacing, spacing, sliceGap], origin: [origin, origin, 0] };
}

const moved = (point, shift) => point.map((value, axis) => value + (shift[axis] ?? 0));
const studies = [];
for (const study of STUDIES) {
  const series = [
    await writeSeries(study, { folder: 'S01', prefix: 'IM', number: 1, description: 'Synthetic follow-up · CT', size: 128, spacing: 3.125, ct: true }),
    await writeSeries(study, { folder: 'S02', prefix: 'PT', number: 2, description: 'Synthetic follow-up · PET AC', size: 100, spacing: 4 }),
  ];
  studies.push({ name: study.name, date: study.date, folder: study.name, shift: study.shift, series,
    pet: { injection: study.injection, scanStart: '120000', uptakeMinutes: study.uptakeMinutes, model: study.model, reconstruction: study.reconstruction, glucoseMmol: study.glucoseMmol },
    lesions: lesions.map(lesion => ({ id: lesion.id, center: moved(lesion.center, study.shift), radius: lesion.radius, suv: lesion.suv[study.name] })),
    liver: { center: moved(liver.center, study.shift), semiAxes: liver.size, suv: liver.suv },
    bloodPool: { center: moved([aorta.center[0], aorta.center[1], -150], study.shift), radius: aorta.radius, zRange: [aorta.from + study.shift[2], aorta.to + study.shift[2]], suv: aorta.suv } });
}
await writeFile(path.join(destination, 'manifest.json'), JSON.stringify({ generator: 'veacom-pet-followup-v2', synthetic: true, studies,
  suv: { weightKg, heightM, sex: 'M', doseBq, decayCorrection: 'ADMIN', bqPerSuv }, transferSyntax, sha256: hashes }, null, 2) + '\n');
console.log(`Generated a synthetic PET/CT follow-up (${studies.length} studies, ${Object.keys(hashes).length} files) in ${destination}`);
