// One synthetic patient with four small studies, for the comparison screen (docs/arrangements.md): an earlier and a
// current brain MR, and an earlier and a current chest CT, their dates interleaved.
// - The two MRs name their series differently ("AX T2 TSE", "t2_tse_tra") and record the body part differently
//   (BRAIN, HEAD), so a counterpart is found by what the series is, not by what it is called. The current MR has a
//   FLAIR the earlier one lacks.
// - Each CT has a soft-tissue and a lung reconstruction, named differently in the two studies and of other
//   thicknesses.
// - Every study lies in its own frame of reference, at another table position and over another number of slices.
// The brain lesion and the lung nodule are larger in the current studies.
//
//   node tools/fixtures/make-comparison-studies.mjs <new-directory>
//
// The directory gets mr-prior/, ct-prior/, mr-current/ and ct-current/ (a study each) and manifest.json.
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { dataset, element } from './dicom-elements.mjs';

const [destination, ...rest] = process.argv.slice(2);
if (!destination || rest.length) throw new Error('Usage: node tools/fixtures/make-comparison-studies.mjs <new-directory>');
await mkdir(destination); // Refuse to replace an existing study.

const root = '2.25.302617644913925066835652647005517224101.40', transferSyntax = '1.2.840.10008.1.2.1';
const inside = (p, c, r) => Math.hypot((p[0] - c[0]) / r[0], (p[1] - c[1]) / r[1], (p[2] - c[2]) / r[2]);
/** Repeatable texture in [-1, 1] for voxel (x, y, z) of one series. */
const noise = (x, y, z, salt) => { let h = (x * 374761393 + y * 668265263 + z * 1274126177 + salt * 2246822519) >>> 0; h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0; return ((h ^ (h >>> 16)) >>> 0) / 2 ** 31 - 1; };

// The head, in patient coordinates (LPS, mm) centred on the brain: an ellipsoid with scalp, skull, grey and white
// matter, two ventricles, and a lesion in the right hemisphere with a rim that takes contrast.
const lesion = { center: [-28, 12, 14], radius: { prior: 8, current: 13 } };
// Signal of each tissue in each kind of series (arbitrary units).
const SIGNAL = {
  t1: { scalp: 820, skull: 60, grey: 420, white: 560, csf: 120, lesion: 300, rim: 300 },
  t1c: { scalp: 820, skull: 60, grey: 430, white: 570, csf: 120, lesion: 280, rim: 950 },
  t2: { scalp: 560, skull: 50, grey: 520, white: 380, csf: 940, lesion: 820, rim: 820 },
  flair: { scalp: 560, skull: 50, grey: 520, white: 380, csf: 90, lesion: 880, rim: 880 },
};
function brain(p, kind, study) {
  const signal = SIGNAL[kind], head = inside(p, [0, 0, 0], [78, 96, 84]);
  if (head > 1) return 0;
  if (head > 0.93) return signal.scalp;
  if (head > 0.86) return signal.skull;
  const from = Math.hypot(p[0] - lesion.center[0], p[1] - lesion.center[1], p[2] - lesion.center[2]), radius = lesion.radius[study];
  if (from <= radius) return from > radius - 3 ? signal.rim : signal.lesion;
  for (const side of [-1, 1]) if (inside(p, [side * 14, 4, 10], [9, 26, 13]) < 1) return signal.csf;
  return head > 0.72 ? signal.grey : signal.white;
}

// The chest: a body with two lungs, the spine, the heart and a nodule in the right lung.
const nodule = { center: [-80, -20, 10], radius: { prior: 6, current: 10 } };
function chest(p, study) {
  if (Math.hypot(p[0] / 165, p[1] / 115) > 1) return -1000;
  if (Math.hypot(p[0], p[1] - 75) < 16) return 700;
  if (Math.hypot(p[0] - nodule.center[0], p[1] - nodule.center[1], p[2] - nodule.center[2]) <= nodule.radius[study]) return 35;
  for (const side of [-1, 1]) if (inside(p, [side * 85, -5, 0], [50, 70, 105]) < 1) return -820;
  if (inside(p, [15, -25, -40], [45, 40, 45]) < 1) return 45;
  return 40;
}

const STUDIES = [
  { name: 'mr-prior', number: 1, date: '19990901', description: 'Brain MR', part: 'BRAIN', model: 'SYNTHETIC MR 1', shift: [0, 0, 12], when: 'prior', series: [
    { description: 'AX T1 SE', kind: 't1', slices: 22, gap: 6, tr: 520, te: 12 },
    { description: 'AX T2 TSE', kind: 't2', slices: 22, gap: 6, tr: 4200, te: 100 },
    { description: 'AX T1 SE GD', kind: 't1c', slices: 22, gap: 6, tr: 520, te: 12, agent: 'Gadolinium' },
  ] },
  { name: 'ct-prior', number: 2, date: '19991101', description: 'Chest CT', part: 'CHEST', model: 'SYNTHETIC CT 1', shift: [0, 0, 20], when: 'prior', series: [
    { description: 'Chest 5.0 B31f', kind: 'soft', slices: 44, gap: 5, window: [40, 400] },
    { description: 'Lung 3.0 B70f', kind: 'lung', slices: 72, gap: 3, window: [-600, 1500] },
  ] },
  { name: 'mr-current', number: 3, date: '20000301', description: 'Head MR', part: 'HEAD', model: 'SYNTHETIC MR 2', shift: [0, 0, 0], when: 'current', series: [
    { description: 't1_se_tra', kind: 't1', slices: 28, gap: 5, tr: 480, te: 10 },
    { description: 't2_tse_tra', kind: 't2', slices: 28, gap: 5, tr: 3800, te: 96 },
    { description: 't1_se_tra_km', kind: 't1c', slices: 28, gap: 5, tr: 480, te: 10, agent: 'Gadolinium' },
    { description: 't2_flair_tra', kind: 'flair', slices: 28, gap: 5, tr: 9000, te: 120, ti: 2500 },
  ] },
  { name: 'ct-current', number: 4, date: '20000501', description: 'Thorax CT', part: 'CHEST', model: 'SYNTHETIC CT 2', shift: [0, 0, 0], when: 'current', series: [
    { description: 'Thorax 5.0 I31f', kind: 'soft', slices: 48, gap: 5, window: [40, 400] },
    { description: 'Thorax 2.5 I70f', kind: 'lung', slices: 96, gap: 2.5, window: [-600, 1500] },
  ] },
];
const hashes = {};

async function writeSeries(study, item, number) {
  const mr = study.name.startsWith('mr'), size = mr ? 96 : 128, spacing = mr ? 2.2 : 3.125;
  const folder = `S${String(number).padStart(2, '0')}`, directory = path.join(destination, study.name, folder);
  await mkdir(directory, { recursive: true });
  const sopClass = mr ? '1.2.840.10008.5.1.4.1.1.4' : '1.2.840.10008.5.1.4.1.1.2', origin = -(size - 1) / 2 * spacing;
  // Slices from the head down, centred on the anatomy and moved with the study's table position.
  const top = (item.slices - 1) / 2 * item.gap + study.shift[2];
  for (let k = 0; k < item.slices; k++) {
    const z = top - k * item.gap, uid = `${root}.${study.number}.3.${number}.${k + 1}`, pixels = Buffer.alloc(size * size * 2);
    for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
      const p = [origin + i * spacing - study.shift[0], origin + j * spacing - study.shift[1], z - study.shift[2]];
      if (mr) {
        const value = brain(p, item.kind, study.when);
        pixels.writeUInt16LE(Math.max(0, Math.round(value + (value ? 18 : 6) * (noise(i, j, k, number + study.number * 7) + 1))), (j * size + i) * 2);
      } else {
        const hu = chest(p, study.when);
        pixels.writeInt16LE(Math.round(hu + (hu > -1000 ? (item.kind === 'lung' ? 25 : 10) * noise(i, j, k, number + study.number * 7) : 0)), (j * size + i) * 2);
      }
    }
    const meta = dataset([
      [0x0002, 0x0001, 'OB', [0, 1]], [0x0002, 0x0002, 'UI', sopClass], [0x0002, 0x0003, 'UI', uid],
      [0x0002, 0x0010, 'UI', transferSyntax], [0x0002, 0x0012, 'UI', `${root}.4`],
    ]);
    const bytes = Buffer.concat([Buffer.alloc(128), Buffer.from('DICM'), element(0x0002, 0x0000, 'UL', meta.length), meta, dataset([
      [0x0008, 0x0016, 'UI', sopClass], [0x0008, 0x0018, 'UI', uid], [0x0008, 0x0020, 'DA', study.date], [0x0008, 0x0021, 'DA', study.date],
      [0x0008, 0x0030, 'TM', '120000'], [0x0008, 0x0031, 'TM', '120000'],
      [0x0008, 0x0060, 'CS', mr ? 'MR' : 'CT'], [0x0008, 0x0070, 'LO', 'SYNTHETIC'], [0x0008, 0x1030, 'LO', study.description], [0x0008, 0x103e, 'LO', item.description],
      [0x0008, 0x1090, 'LO', study.model],
      [0x0010, 0x0010, 'PN', 'SYNTHETIC^COMPARISON'], [0x0010, 0x0020, 'LO', 'SYNTHETIC-COMPARISON'], [0x0010, 0x0021, 'LO', 'SYNTHETIC-SITE'], [0x0010, 0x0040, 'CS', 'F'],
      ...(item.agent ? [[0x0018, 0x0010, 'LO', item.agent]] : []), [0x0018, 0x0015, 'CS', study.part],
      ...(mr ? [[0x0018, 0x0020, 'CS', item.ti ? ['SE', 'IR'] : 'SE'], [0x0018, 0x0021, 'CS', 'SK'], [0x0018, 0x0023, 'CS', '2D']] : []),
      [0x0018, 0x0050, 'DS', item.gap],
      ...(mr ? [[0x0018, 0x0080, 'DS', item.tr], [0x0018, 0x0081, 'DS', item.te], ...(item.ti ? [[0x0018, 0x0082, 'DS', item.ti]] : []), [0x0018, 0x0087, 'DS', 1.5]] : []),
      [0x0020, 0x000d, 'UI', `${root}.${study.number}.1`], [0x0020, 0x000e, 'UI', `${root}.${study.number}.2.${number}`], [0x0020, 0x0011, 'IS', number], [0x0020, 0x0013, 'IS', k + 1],
      [0x0020, 0x0032, 'DS', [origin, origin, z]], [0x0020, 0x0037, 'DS', [1, 0, 0, 0, 1, 0]], [0x0020, 0x0052, 'UI', `${root}.${study.number}.5`],
      [0x0028, 0x0002, 'US', 1], [0x0028, 0x0004, 'CS', 'MONOCHROME2'], [0x0028, 0x0010, 'US', size], [0x0028, 0x0011, 'US', size],
      [0x0028, 0x0030, 'DS', [spacing, spacing]], [0x0028, 0x0100, 'US', 16], [0x0028, 0x0101, 'US', 16], [0x0028, 0x0102, 'US', 15],
      ...(mr ? [[0x0028, 0x0103, 'US', 0], [0x0028, 0x1050, 'DS', 500], [0x0028, 0x1051, 'DS', 1000]]
        : [[0x0028, 0x0103, 'US', 1], [0x0028, 0x1050, 'DS', item.window[0]], [0x0028, 0x1051, 'DS', item.window[1]], [0x0028, 0x1052, 'DS', 0], [0x0028, 0x1053, 'DS', 1]]),
      [0x7fe0, 0x0010, 'OW', pixels],
    ])]);
    const name = `IM${String(k).padStart(5, '0')}.dcm`;
    await writeFile(path.join(directory, name), bytes);
    hashes[`${study.name}/${folder}/${name}`] = createHash('sha256').update(bytes).digest('hex');
  }
  return { folder, description: item.description, kind: item.kind, modality: mr ? 'MR' : 'CT', dimensions: [size, size, item.slices], spacing: [spacing, spacing, item.gap] };
}

const studies = [];
for (const study of STUDIES) {
  const series = [];
  for (const [index, item] of study.series.entries()) series.push(await writeSeries(study, item, index + 1));
  studies.push({ name: study.name, folder: study.name, date: study.date, description: study.description, bodyPart: study.part, shift: study.shift, series });
}
await writeFile(path.join(destination, 'manifest.json'), JSON.stringify({ generator: 'veacom-comparison-v1', synthetic: true, studies, transferSyntax, sha256: hashes }, null, 2) + '\n');
console.log(`Generated a synthetic comparison patient (${studies.length} studies, ${Object.keys(hashes).length} files) in ${destination}`);
