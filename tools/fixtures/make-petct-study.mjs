// A small deterministic PET/CT for the arrangement checks and screenshots: one CT, an attenuation-corrected PET in
// Bq/ml with what SUV needs (weight, dose, decay correction to administration) and what its acquisition panel shows (FDG
// by name and code, the injection's date and time, blood glucose), and the same PET without attenuation correction. The three share a frame of reference and a slice grid. The phantom is synthetic: a body with lungs, heart,
// liver, kidneys, bladder, spine and four hot lesions.
//
//   node tools/fixtures/make-petct-study.mjs <new-directory>
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [destination, ...rest] = process.argv.slice(2);
if (!destination || rest.length) throw new Error('Usage: node tools/fixtures/make-petct-study.mjs <new-directory>');
await mkdir(destination); // Refuse to replace an existing study.

// DICOM Part 10, Explicit VR Little Endian: just the value types this study uses, sequences with explicit lengths.
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

const root = '2.25.302617644913925066835652647005517224101.20', transferSyntax = '1.2.840.10008.1.2.1';
const slices = 90, sliceGap = 4; // mm, head to feet
const weightKg = 70, doseBq = 200e6, bqPerSuv = doseBq / (weightKg * 1000);
// Injected at 11:00, scanned from 12:00 (Series Time): an uptake time of 60 min. Glucose as DICOM CP-1229 records it.
const injected = '110000', glucoseMmol = 5.4;
const code = (value, scheme, meaning) => [[0x0008, 0x0100, 'SH', value], [0x0008, 0x0102, 'SH', scheme], [0x0008, 0x0104, 'LO', meaning]];

// Patient coordinates (LPS, mm): x to the left, y to the back, z to the head. Slice k lies at z = -k * 4.
const lerp = (points, z) => {
  for (let i = 1; i < points.length; i++) if (z >= points[i][0]) { const [z0, v0] = points[i - 1], [z1, v1] = points[i]; return v0 + (v1 - v0) * (z0 - z) / (z0 - z1); }
  return points.at(-1)[1];
};
const width = z => lerp([[0, 62], [-40, 75], [-60, 168], [-200, 158], [-290, 148], [-356, 160]], z);
const depth = z => lerp([[0, 58], [-40, 66], [-60, 112], [-200, 108], [-290, 102], [-356, 100]], z);
/** How far inside an ellipsoid a point is: below 1 inside. */
const inside = (p, c, r) => Math.hypot((p[0] - c[0]) / r[0], (p[1] - c[1]) / r[1], (p[2] - c[2]) / r[2]);
const lungs = [[75, -5, -112], [-75, -5, -112]], lungSize = [52, 68, 82];
const kidneys = [[68, 45, -252], [-68, 45, -252]], kidneySize = [24, 21, 44];
// Hot lesions: a right lung nodule, a mediastinal node, a liver lesion and a spine lesion (SUV, CT HU, radius mm).
const lesions = [
  { at: [-82, -12, -96], radius: 9, suv: 9, hu: 30 }, { at: [12, 8, -124], radius: 7, suv: 6, hu: 42 },
  { at: [-58, -36, -228], radius: 11, suv: 7, hu: 44 }, { at: [0, 72, -272], radius: 6, suv: 8, hu: 900 },
];
/** Repeatable texture in [-1, 1] for voxel (x, y, z) of one series. */
const noise = (x, y, z, salt) => { let h = (x * 374761393 + y * 668265263 + z * 1274126177 + salt * 2246822519) >>> 0; h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0; return ((h ^ (h >>> 16)) >>> 0) / 2 ** 31 - 1; };
/** CT value (HU) and PET uptake (SUV) at a point. PET edges are soft, as a scanner blurs them. */
function tissue(p) {
  const body = Math.hypot(p[0] / width(p[2]), p[1] / depth(p[2]));
  if (body > 1) return { hu: -1000, suv: 0, body };
  let hu = body > 0.9 ? -90 : 40, suv = body > 0.9 ? 0.4 : 0.9;
  if (Math.hypot(p[0], p[1] - 72) < 16) { hu = 700; suv = 1.1; }
  if (p[2] < -60 && p[2] > -175) for (const c of lungs) if (inside(p, c, lungSize) < 1) { hu = -820; suv = 0.35; }
  const heart = inside(p, [18, -30, -150], [48, 44, 44]);
  if (heart < 1) { hu = 40; suv = heart > 0.62 ? 5 : 1.8; }
  if (inside(p, [-80, -10, -218], [74, 64, 54]) < 1) { hu = 60; suv = 2.3; }
  for (const c of kidneys) if (inside(p, c, kidneySize) < 1) { hu = 35; suv = 4; }
  if (inside(p, [0, -20, -332], [40, 34, 26]) < 1) { hu = 10; suv = 14; }
  for (const lesion of lesions) if (Math.hypot(p[0] - lesion.at[0], p[1] - lesion.at[1], p[2] - lesion.at[2]) < lesion.radius) { hu = lesion.hu; suv = lesion.suv; }
  return { hu, suv, body };
}

const hashes = {};
async function writeSeries({ folder, prefix, number, description, size, spacing, ct, corrected }) {
  await mkdir(path.join(destination, folder));
  const sopClass = ct ? '1.2.840.10008.5.1.4.1.1.2' : '1.2.840.10008.5.1.4.1.1.128', origin = -(size - 1) / 2 * spacing;
  // A PET is blurred over about a centimetre: each voxel averages a few points around it.
  const offsets = ct ? [[0, 0, 0]] : [[0, 0, 0], [3, 0, 0], [-3, 0, 0], [0, 3, 0], [0, -3, 0], [0, 0, 2], [0, 0, -2]];
  for (let k = 0; k < slices; k++) {
    const z = -k * sliceGap, uid = `${root}.${number}.${k + 1}`, pixels = Buffer.alloc(size * size * 2);
    for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
      const p = [origin + i * spacing, origin + j * spacing, z];
      if (ct) {
        const { hu } = tissue(p);
        pixels.writeInt16LE(Math.round(hu + (hu > -1000 ? 12 * noise(i, j, k, number) : 0)), (j * size + i) * 2);
      } else {
        let suv = 0;
        for (const [dx, dy, dz] of offsets) suv += tissue([p[0] + dx, p[1] + dy, p[2] + dz]).suv / offsets.length;
        // Without attenuation correction the middle of the body reads low and the skin high.
        const body = tissue(p).body;
        if (!corrected) suv *= body > 1 ? 0 : 0.35 + 0.9 * body * body;
        const value = suv * bqPerSuv * (1 + 0.08 * noise(i, j, k, number));
        pixels.writeUInt16LE(Math.max(0, Math.min(65535, Math.round(value))), (j * size + i) * 2);
      }
    }
    const meta = dataset([
      [0x0002, 0x0001, 'OB', [0, 1]], [0x0002, 0x0002, 'UI', sopClass], [0x0002, 0x0003, 'UI', uid],
      [0x0002, 0x0010, 'UI', transferSyntax], [0x0002, 0x0012, 'UI', `${root}.4`],
    ]);
    const bytes = Buffer.concat([Buffer.alloc(128), Buffer.from('DICM'), element(0x0002, 0x0000, 'UL', meta.length), meta, dataset([
      [0x0008, 0x0016, 'UI', sopClass], [0x0008, 0x0018, 'UI', uid], [0x0008, 0x0020, 'DA', '20000101'], [0x0008, 0x0021, 'DA', '20000101'],
      [0x0008, 0x0022, 'DA', '20000101'], [0x0008, 0x0030, 'TM', '120000'], [0x0008, 0x0031, 'TM', '120000'], [0x0008, 0x0032, 'TM', '120000'],
      [0x0008, 0x0060, 'CS', ct ? 'CT' : 'PT'], [0x0008, 0x0070, 'LO', 'SYNTHETIC'], [0x0008, 0x103e, 'LO', description],
      [0x0010, 0x0010, 'PN', 'SYNTHETIC^PETCT'], [0x0010, 0x0020, 'LO', 'SYNTHETIC-PETCT'], [0x0010, 0x0040, 'CS', 'M'],
      [0x0010, 0x1020, 'DS', 1.75], [0x0010, 0x1030, 'DS', weightKg], [0x0018, 0x0050, 'DS', sliceGap],
      [0x0020, 0x000d, 'UI', `${root}.1`], [0x0020, 0x000e, 'UI', `${root}.2.${number}`], [0x0020, 0x0011, 'IS', number], [0x0020, 0x0013, 'IS', k + 1],
      [0x0020, 0x0032, 'DS', [origin, origin, z]], [0x0020, 0x0037, 'DS', [1, 0, 0, 0, 1, 0]], [0x0020, 0x0052, 'UI', `${root}.5`],
      [0x0028, 0x0002, 'US', 1], [0x0028, 0x0004, 'CS', 'MONOCHROME2'], [0x0028, 0x0010, 'US', size], [0x0028, 0x0011, 'US', size],
      [0x0028, 0x0030, 'DS', [spacing, spacing]], [0x0028, 0x0100, 'US', 16], [0x0028, 0x0101, 'US', 16], [0x0028, 0x0102, 'US', 15],
      ...(ct ? [[0x0028, 0x0103, 'US', 1], [0x0028, 0x1050, 'DS', 40], [0x0028, 0x1051, 'DS', 400], [0x0028, 0x1052, 'DS', 0], [0x0028, 0x1053, 'DS', 1]]
        : [[0x0028, 0x0051, 'CS', corrected ? ['ATTN', 'DECY'] : ['DECY']], [0x0028, 0x0103, 'US', 0], [0x0028, 0x1052, 'DS', 0], [0x0028, 0x1053, 'DS', 1],
          [0x0040, 0x0555, 'SQ', [[[0x0040, 0x08ea, 'SQ', [code('mmol/l', 'UCUM', 'mmol/l')]], [0x0040, 0xa040, 'CS', 'NUMERIC'],
            [0x0040, 0xa043, 'SQ', [code('14749-6', 'LN', 'Glucose')]], [0x0040, 0xa30a, 'DS', glucoseMmol]]]],
          [0x0054, 0x0016, 'SQ', [[[0x0018, 0x0031, 'LO', 'Fludeoxyglucose F^18^'], [0x0018, 0x1072, 'TM', injected], [0x0018, 0x1074, 'DS', doseBq], [0x0018, 0x1075, 'DS', 6586.2],
            [0x0018, 0x1078, 'DT', `20000101${injected}`], [0x0054, 0x0300, 'SQ', [code('C-111A1', 'SRT', '^18^Fluorine')]],
            [0x0054, 0x0304, 'SQ', [code('C-B1031', 'SRT', 'Fluorodeoxyglucose F^18^')]]]]],
          [0x0054, 0x1000, 'CS', ['WHOLE BODY', 'IMAGE']], [0x0054, 0x1001, 'CS', 'BQML'], [0x0054, 0x1102, 'CS', 'ADMIN']]),
      [0x7fe0, 0x0010, 'OW', pixels],
    ])]);
    const name = `${prefix}${String(k).padStart(5, '0')}.dcm`;
    await writeFile(path.join(destination, folder, name), bytes);
    hashes[`${folder}/${name}`] = createHash('sha256').update(bytes).digest('hex');
  }
  return { folder, description, modality: ct ? 'CT' : 'PT', dimensions: [size, size, slices], spacing: [spacing, spacing, sliceGap] };
}

const series = [
  await writeSeries({ folder: 'S01', prefix: 'IM', number: 1, description: 'Synthetic PET/CT · CT', size: 192, spacing: 2.6, ct: true }),
  await writeSeries({ folder: 'S02', prefix: 'PT', number: 2, description: 'Synthetic PET/CT · PET AC', size: 96, spacing: 5.2, corrected: true }),
  await writeSeries({ folder: 'S03', prefix: 'PT', number: 3, description: 'Synthetic PET/CT · PET NAC', size: 96, spacing: 5.2, corrected: false }),
];
await writeFile(path.join(destination, 'manifest.json'), JSON.stringify({ generator: 'veacom-petct-v1', synthetic: true, series,
  suv: { weightKg, doseBq, decayCorrection: 'ADMIN', bqPerSuv }, pet: { tracer: 'Fludeoxyglucose F^18^', tracerCode: 'C-B1031', injected, scanStart: '120000',
    uptakeMinutes: 60, heightM: 1.75, glucoseMmol }, transferSyntax, sha256: hashes }, null, 2) + '\n');
console.log(`Generated a synthetic PET/CT (${series.length} series, ${Object.keys(hashes).length} files) in ${destination}`);
