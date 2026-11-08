// Two small deterministic gamma camera (NM) studies of one synthetic patient, for the gamma camera checks and
// screenshots. The phantom is synthetic: a bone scan (Tc-99m MDP) with three hot lesions.
//
// - spect-ct/: a bone SPECT/CT. A CT, a reconstructed SPECT (one NM multi-frame file) in Bq/ml through a Real World
//   Value Mapping, whose slices are stacked toward the feet by a negative Spacing Between Slices as Siemens writes them,
//   and the raw projections of its two detectors. The CT and the SPECT share a frame of reference. Beside them, a gated
//   SPECT (RECON GATED TOMO, one NM file): 8 gates of a generic ellipsoid shell that contracts and thickens through the
//   cycle, stacked toward the head by a positive Spacing Between Slices, each gate with its Time Slot Time. It is
//   numbered before the summed SPECT, so that only the SPECT/CT screen's own ranking keeps it on the summed one.
// - whole-body/: a whole-body bone scan, one NM file whose two frames are the anterior and posterior views of two
//   detectors facing each other, each named by its View Code Sequence.
//
//   node tools/fixtures/make-nm-study.mjs <new-directory>
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [destination, ...rest] = process.argv.slice(2);
if (!destination || rest.length) throw new Error('Usage: node tools/fixtures/make-nm-study.mjs <new-directory>');
await mkdir(destination); // Refuse to replace an existing study.

// DICOM Part 10, Explicit VR Little Endian: the value types these files use, sequences with explicit lengths.
// AT values are [group, element] pairs; US, AT and FD take one value or a list.
const LONG_LENGTH = new Set(['OB', 'OW', 'SQ']);
function element(group, item, vr, value) {
  const values = Array.isArray(value) && vr !== 'SQ' && vr !== 'AT' ? value : [value];
  let body;
  if (vr === 'SQ') body = Buffer.concat(value.map(entries => { const data = dataset(entries), header = Buffer.alloc(8); header.writeUInt16LE(0xfffe); header.writeUInt16LE(0xe000, 2); header.writeUInt32LE(data.length, 4); return Buffer.concat([header, data]); }));
  else if (vr === 'OB' || vr === 'OW') body = Buffer.from(value);
  else if (vr === 'US') { body = Buffer.alloc(2 * values.length); values.forEach((v, i) => body.writeUInt16LE(v, 2 * i)); }
  else if (vr === 'UL') { body = Buffer.alloc(4); body.writeUInt32LE(value); }
  else if (vr === 'FD') { body = Buffer.alloc(8 * values.length); values.forEach((v, i) => body.writeDoubleLE(v, 8 * i)); }
  else if (vr === 'AT') { body = Buffer.alloc(4 * value.length); value.forEach(([g, e], i) => { body.writeUInt16LE(g, 4 * i); body.writeUInt16LE(e, 4 * i + 2); }); }
  else body = Buffer.from(Array.isArray(value) ? value.join('\\') : String(value), 'latin1');
  if (body.length % 2) body = Buffer.concat([body, Buffer.from(vr === 'UI' || vr === 'OB' ? [0] : [0x20])]);
  const header = Buffer.alloc(LONG_LENGTH.has(vr) ? 12 : 8);
  header.writeUInt16LE(group); header.writeUInt16LE(item, 2); header.write(vr, 4, 'latin1');
  if (LONG_LENGTH.has(vr)) header.writeUInt32LE(body.length, 8); else header.writeUInt16LE(body.length, 6);
  return Buffer.concat([header, body]);
}
function dataset(elements) {
  const sorted = [...elements].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return Buffer.concat(sorted.map(([group, item, vr, value]) => element(group, item, vr, value)));
}

const root = '2.25.302617644913925066835652647005517224101.30', transferSyntax = '1.2.840.10008.1.2.1';
const NM = '1.2.840.10008.5.1.4.1.1.20', CT = '1.2.840.10008.5.1.4.1.1.2';
const hashes = {};
async function write(file, sopClass, uid, elements) {
  const meta = dataset([
    [0x0002, 0x0001, 'OB', [0, 1]], [0x0002, 0x0002, 'UI', sopClass], [0x0002, 0x0003, 'UI', uid],
    [0x0002, 0x0010, 'UI', transferSyntax], [0x0002, 0x0012, 'UI', `${root}.9`],
  ]);
  const bytes = Buffer.concat([Buffer.alloc(128), Buffer.from('DICM'), element(0x0002, 0x0000, 'UL', meta.length), meta,
    dataset([[0x0008, 0x0016, 'UI', sopClass], [0x0008, 0x0018, 'UI', uid], ...elements])]);
  await mkdir(path.dirname(path.join(destination, file)), { recursive: true });
  await writeFile(path.join(destination, file), bytes);
  hashes[file] = createHash('sha256').update(bytes).digest('hex');
}
const patient = [
  [0x0010, 0x0010, 'PN', 'SYNTHETIC^NM'], [0x0010, 0x0020, 'LO', 'SYNTHETIC-NM'], [0x0010, 0x0040, 'CS', 'F'], [0x0010, 0x1030, 'DS', 64],
  [0x0008, 0x0020, 'DA', '20000102'], [0x0008, 0x0021, 'DA', '20000102'], [0x0008, 0x0022, 'DA', '20000102'], [0x0008, 0x0070, 'LO', 'SYNTHETIC'],
];
const pixelModule = (rows, columns) => [
  [0x0028, 0x0002, 'US', 1], [0x0028, 0x0004, 'CS', 'MONOCHROME2'], [0x0028, 0x0010, 'US', rows], [0x0028, 0x0011, 'US', columns],
  [0x0028, 0x0100, 'US', 16], [0x0028, 0x0101, 'US', 16], [0x0028, 0x0102, 'US', 15],
];
// The NM Isotope Module: the dose in MBq, as NM records it (PET records Bq).
const isotope = [
  [0x0054, 0x0011, 'US', 1],
  [0x0054, 0x0012, 'SQ', [[[0x0054, 0x0013, 'SQ', [[[0x0054, 0x0014, 'DS', 126], [0x0054, 0x0015, 'DS', 154]]]], [0x0054, 0x0018, 'SH', 'TC99M']]]],
  [0x0054, 0x0016, 'SQ', [[[0x0018, 0x0031, 'LO', 'Tc-99m MDP'], [0x0018, 0x1072, 'TM', '090000'], [0x0018, 0x1074, 'DS', 740], [0x0018, 0x1075, 'DS', 21624]]]],
];
const VECTORS = { energyWindow: [0x0054, 0x0010], detector: [0x0054, 0x0020], rotation: [0x0054, 0x0050], rrInterval: [0x0054, 0x0060], timeSlot: [0x0054, 0x0070],
  angularView: [0x0054, 0x0090], slice: [0x0054, 0x0080] };
/** Repeatable texture in [-1, 1] for (x, y, z) of one image. */
const noise = (x, y, z, salt) => { let h = (x * 374761393 + y * 668265263 + z * 1274126177 + salt * 2246822519) >>> 0; h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0; return ((h ^ (h >>> 16)) >>> 0) / 2 ** 31 - 1; };
/** How far inside an ellipsoid a point is: below 1 inside. */
const inside = (p, c, r) => Math.hypot((p[0] - c[0]) / r[0], (p[1] - c[1]) / r[1], (p[2] - c[2]) / r[2]);
const toUint16 = values => { const buffer = Buffer.alloc(values.length * 2); values.forEach((v, i) => buffer.writeUInt16LE(Math.max(0, Math.min(65535, Math.round(v))), 2 * i)); return buffer; };

// ---- The SPECT/CT. Patient coordinates (LPS, mm): x to the left, y to the back, z to the head; the chest and abdomen
// from z = 0 down to z = -282.
const lungs = [[-80, -5, -70], [80, -5, -70]], kidneys = [[-70, 50, -205], [70, 50, -205]];
// Hot lesions: a vertebral metastasis, a right rib and the sternum (uptake relative to soft tissue, radius mm).
const lesions = [{ at: [0, 62, -130], radius: 11, uptake: 40 }, { at: [-150, 25, -95], radius: 9, uptake: 32 }, { at: [0, -98, -60], radius: 8, uptake: 26 }];
function tissue(p) {
  const body = Math.hypot(p[0] / 165, p[1] / 108);
  if (body > 1) return { hu: -1000, uptake: 0, body };
  let hu = body > 0.9 ? -90 : 40, uptake = 1;
  if (p[2] > -165) for (const c of lungs) if (inside(p, c, [58, 70, 95]) < 1) { hu = -830; uptake = 0.25; }
  if (p[0] < 30 && inside(p, [-70, -15, -185], [80, 70, 50]) < 1) { hu = 60; uptake = 1.4; }
  for (const c of kidneys) if (inside(p, c, [25, 22, 45]) < 1) { hu = 35; uptake = 5; }
  // Ribs: a thin shell under the skin, one rib every 25 mm down the chest.
  if (p[2] > -190 && body > 0.84 && body < 0.9 && Math.cos((p[2] + 10) * 2 * Math.PI / 25) > 0.55) { hu = 550; uptake = 6; }
  if (p[2] > -150 && Math.abs(p[0]) < 14 && p[1] > -106 && p[1] < -88) { hu = 450; uptake = 6; }
  const vertebra = Math.hypot(p[0], p[1] - 62);
  if (vertebra < 18) { hu = vertebra > 15 ? 900 : 300; uptake = 9; }
  for (const lesion of lesions) if (Math.hypot(p[0] - lesion.at[0], p[1] - lesion.at[1], p[2] - lesion.at[2]) < lesion.radius) uptake = lesion.uptake;
  return { hu, uptake, body };
}
const study1 = `${root}.1`, frame = `${root}.5`, bqPerUnit = 1500; // Soft tissue at 1.5 kBq/ml.
const ct = { size: 128, spacing: 3, slices: 95, gap: 3 };
for (let k = 0; k < ct.slices; k++) {
  const z = -k * ct.gap, origin = -(ct.size - 1) / 2 * ct.spacing, values = [];
  for (let j = 0; j < ct.size; j++) for (let i = 0; i < ct.size; i++) {
    const { hu } = tissue([origin + i * ct.spacing, origin + j * ct.spacing, z]);
    values.push(hu + 1024 + (hu > -1000 ? 10 * noise(i, j, k, 1) : 0));
  }
  await write(`spect-ct/CT/IM${String(k).padStart(5, '0')}.dcm`, CT, `${root}.11.${k + 1}`, [...patient,
    [0x0008, 0x0030, 'TM', '100000'], [0x0008, 0x0031, 'TM', '101500'], [0x0008, 0x0060, 'CS', 'CT'], [0x0008, 0x103e, 'LO', 'Synthetic SPECT/CT · CT'],
    [0x0018, 0x0050, 'DS', ct.gap], [0x0020, 0x000d, 'UI', study1], [0x0020, 0x000e, 'UI', `${root}.2.1`], [0x0020, 0x0011, 'IS', 1], [0x0020, 0x0013, 'IS', k + 1],
    [0x0020, 0x0032, 'DS', [origin, origin, z]], [0x0020, 0x0037, 'DS', [1, 0, 0, 0, 1, 0]], [0x0020, 0x0052, 'UI', frame],
    ...pixelModule(ct.size, ct.size), [0x0028, 0x0030, 'DS', [ct.spacing, ct.spacing]], [0x0028, 0x0103, 'US', 0],
    [0x0028, 0x1050, 'DS', 40], [0x0028, 0x1051, 'DS', 400], [0x0028, 0x1052, 'DS', -1024], [0x0028, 0x1053, 'DS', 1],
    [0x7fe0, 0x0010, 'OW', toUint16(values)]]);
}

// The reconstructed SPECT: 64 × 64 × 48 at 6 mm. A camera blurs over about 1.5 cm: each voxel averages points around it.
const spect = { size: 64, spacing: 6, slices: 48, rwvSlope: 2 }; // Bq/ml per stored value.
const blur = [[0, 0, 0], [6, 0, 0], [-6, 0, 0], [0, 6, 0], [0, -6, 0], [0, 0, 6], [0, 0, -6], [4, 4, 0], [-4, -4, 0]];
const spectOrigin = -(spect.size - 1) / 2 * spect.spacing, slices = [];
const activity = p => blur.reduce((sum, [dx, dy, dz]) => sum + tissue([p[0] + dx, p[1] + dy, p[2] + dz]).uptake, 0) / blur.length;
for (let k = 0; k < spect.slices; k++) for (let j = 0; j < spect.size; j++) for (let i = 0; i < spect.size; i++) {
  const value = activity([spectOrigin + i * spect.spacing, spectOrigin + j * spect.spacing, -k * spect.spacing]) * bqPerUnit;
  slices.push(value * (1 + 0.06 * noise(i, j, k, 2)) / spect.rwvSlope);
}
await write('spect-ct/SPECT/NM00001.dcm', NM, `${root}.12.1`, [...patient, ...isotope,
  [0x0008, 0x0008, 'CS', ['ORIGINAL', 'PRIMARY', 'RECON TOMO', 'EMISSION']], [0x0008, 0x0030, 'TM', '100000'], [0x0008, 0x0031, 'TM', '100000'],
  [0x0008, 0x0060, 'CS', 'NM'], [0x0008, 0x103e, 'LO', 'Synthetic SPECT/CT · SPECT Bq/ml'],
  [0x0018, 0x0050, 'DS', spect.spacing], [0x0018, 0x0088, 'DS', -spect.spacing],
  [0x0020, 0x000d, 'UI', study1], [0x0020, 0x000e, 'UI', `${root}.2.2`], [0x0020, 0x0011, 'IS', 3], [0x0020, 0x0013, 'IS', 1], [0x0020, 0x0052, 'UI', frame],
  ...pixelModule(spect.size, spect.size), [0x0028, 0x0008, 'IS', spect.slices], [0x0028, 0x0009, 'AT', [VECTORS.slice]],
  [0x0028, 0x0030, 'DS', [spect.spacing, spect.spacing]], [0x0028, 0x0103, 'US', 0],
  [0x0040, 0x9096, 'SQ', [[[0x0040, 0x08ea, 'SQ', [[[0x0008, 0x0100, 'SH', 'Bq/ml'], [0x0008, 0x0102, 'SH', 'UCUM'], [0x0008, 0x0104, 'LO', 'Becquerels/milliliter']]]],
    [0x0040, 0x9210, 'SH', 'BQML'], [0x0040, 0x9211, 'US', 65535], [0x0040, 0x9216, 'US', 0], [0x0040, 0x9224, 'FD', 0], [0x0040, 0x9225, 'FD', spect.rwvSlope]]]],
  [0x0054, 0x0021, 'US', 1], [0x0054, 0x0022, 'SQ', [[[0x0020, 0x0032, 'DS', [spectOrigin, spectOrigin, 0]], [0x0020, 0x0037, 'DS', [1, 0, 0, 0, 1, 0]]]]],
  [0x0054, 0x0080, 'US', Array.from({ length: spect.slices }, (_, k) => k + 1)], [0x0054, 0x0081, 'US', spect.slices],
  [0x7fe0, 0x0010, 'OW', toUint16(slices)]]);

// The projections it was reconstructed from: two detectors 180° apart, 16 stops each over half a turn.
const stops = 16, projections = [];
for (let detector = 0; detector < 2; detector++) for (let stop = 0; stop < stops; stop++) {
  const angle = (detector * 180 + stop * 180 / stops) * Math.PI / 180, [c, s] = [Math.cos(angle), Math.sin(angle)];
  for (let row = 0; row < spect.slices; row++) for (let column = 0; column < spect.size; column++) {
    const u = spectOrigin + column * spect.spacing, z = -row * spect.spacing;
    let sum = 0;
    for (let t = -180; t <= 180; t += 6) sum += tissue([u * c - t * s, u * s + t * c, z]).uptake;
    projections.push(sum * 3 * (1 + 0.05 * noise(column, row, detector * stops + stop, 3)));
  }
}
await write('spect-ct/PROJECTIONS/NM00001.dcm', NM, `${root}.13.1`, [...patient, ...isotope,
  [0x0008, 0x0008, 'CS', ['ORIGINAL', 'PRIMARY', 'TOMO', 'EMISSION']], [0x0008, 0x0030, 'TM', '100000'], [0x0008, 0x0031, 'TM', '093000'],
  [0x0008, 0x0060, 'CS', 'NM'], [0x0008, 0x103e, 'LO', 'Synthetic SPECT/CT · projections'],
  [0x0020, 0x000d, 'UI', study1], [0x0020, 0x000e, 'UI', `${root}.2.3`], [0x0020, 0x0011, 'IS', 4], [0x0020, 0x0013, 'IS', 1], [0x0020, 0x0052, 'UI', frame],
  ...pixelModule(spect.slices, spect.size), [0x0028, 0x0008, 'IS', 2 * stops],
  [0x0028, 0x0009, 'AT', [VECTORS.energyWindow, VECTORS.detector, VECTORS.rotation, VECTORS.angularView]],
  [0x0028, 0x0030, 'DS', [spect.spacing, spect.spacing]], [0x0028, 0x0103, 'US', 0],
  [0x0054, 0x0010, 'US', Array(2 * stops).fill(1)], [0x0054, 0x0020, 'US', Array.from({ length: 2 * stops }, (_, f) => f < stops ? 1 : 2)],
  [0x0054, 0x0021, 'US', 2], [0x0054, 0x0022, 'SQ', [[[0x0018, 0x1180, 'SH', 'LEHR']], [[0x0018, 0x1180, 'SH', 'LEHR']]]],
  [0x0054, 0x0050, 'US', Array(2 * stops).fill(1)], [0x0054, 0x0051, 'US', 1],
  [0x0054, 0x0052, 'SQ', [[[0x0018, 0x1140, 'CS', 'CW'], [0x0018, 0x1142, 'DS', 250], [0x0018, 0x1143, 'DS', 180], [0x0018, 0x1144, 'DS', 180 / stops], [0x0054, 0x0053, 'US', stops]]]],
  [0x0054, 0x0090, 'US', Array.from({ length: 2 * stops }, (_, f) => f % stops + 1)],
  [0x7fe0, 0x0010, 'OW', toUint16(projections)]]);

// The gated SPECT: 8 gates of 64 × 64 × 24 at 6 mm, its first slice at z = -160 and the next ones toward the head
// (Spacing Between Slices +6). One R-R window of beats from 640 to 960 ms, 100 ms a gate. The shell shrinks to 82% of its
// size and thickens from 10 to 14 mm by gate 5 and comes back; the last gates counted fewer beats (Time Slot Time), as
// an irregular rhythm leaves them, and count less.
const gated = { size: 64, spacing: 6, slices: 24, slots: 8, bottom: -160, slotTimes: [120000, 120000, 120000, 120000, 119000, 117000, 113000, 104000] };
const shell = { center: [30, -30, -95], radii: [42, 36, 50], uptake: 12, countsPerUnit: 40 };
function heart(p, slot) {
  const beat = Math.sin(Math.PI * slot / gated.slots) ** 2, scale = 1 - 0.18 * beat, wall = 10 + 4 * beat;
  const outer = shell.radii.map(r => r * scale), inner = outer.map(r => Math.max(1, r - wall));
  if (inside(p, shell.center, outer) < 1 && inside(p, shell.center, inner) >= 1) return shell.uptake;
  const { body } = tissue(p);
  if (body > 1) return 0;
  return p[2] > -165 && lungs.some(c => inside(p, c, [58, 70, 95]) < 1) ? 0.25 : 1;
}
const gatedFrames = [];
for (let slot = 0; slot < gated.slots; slot++) {
  const counted = gated.slotTimes[slot] / Math.max(...gated.slotTimes);
  for (let k = 0; k < gated.slices; k++) for (let j = 0; j < gated.size; j++) for (let i = 0; i < gated.size; i++) {
    const p = [spectOrigin + i * gated.spacing, spectOrigin + j * gated.spacing, gated.bottom + k * gated.spacing];
    const value = blur.reduce((sum, [dx, dy, dz]) => sum + heart([p[0] + dx, p[1] + dy, p[2] + dz], slot), 0) / blur.length;
    gatedFrames.push(value * shell.countsPerUnit * counted * (1 + 0.08 * noise(i, j, slot * gated.slices + k, 5)));
  }
}
const gatedCount = gated.slots * gated.slices;
await write('spect-ct/GATED/NM00001.dcm', NM, `${root}.15.1`, [...patient, ...isotope,
  [0x0008, 0x0008, 'CS', ['ORIGINAL', 'PRIMARY', 'RECON GATED TOMO', 'EMISSION']], [0x0008, 0x0030, 'TM', '100000'], [0x0008, 0x0031, 'TM', '100000'],
  [0x0008, 0x0060, 'CS', 'NM'], [0x0008, 0x103e, 'LO', 'Synthetic SPECT/CT · gated SPECT'],
  [0x0018, 0x0050, 'DS', gated.spacing], [0x0018, 0x0088, 'DS', gated.spacing],
  // The NM Multi-gated Acquisition Module: one R-R window, its beats, and each gate's Time Slot Time.
  [0x0018, 0x1061, 'LO', 'EKG'], [0x0018, 0x1080, 'CS', 'Y'], [0x0018, 0x1088, 'IS', 75],
  [0x0054, 0x0062, 'SQ', [[[0x0018, 0x1064, 'LO', 'FORW'], [0x0054, 0x0063, 'SQ', [[[0x0018, 0x1062, 'IS', 800], [0x0018, 0x1063, 'DS', 100],
    [0x0018, 0x1081, 'IS', 640], [0x0018, 0x1082, 'IS', 960], [0x0018, 0x1083, 'IS', 1200], [0x0018, 0x1084, 'IS', 37],
    [0x0054, 0x0072, 'SQ', gated.slotTimes.map(time => [[0x0054, 0x0073, 'DS', time]])]]]]]]],
  [0x0020, 0x000d, 'UI', study1], [0x0020, 0x000e, 'UI', `${root}.2.5`], [0x0020, 0x0011, 'IS', 2], [0x0020, 0x0013, 'IS', 1], [0x0020, 0x0052, 'UI', frame],
  ...pixelModule(gated.size, gated.size), [0x0028, 0x0008, 'IS', gatedCount], [0x0028, 0x0009, 'AT', [VECTORS.rrInterval, VECTORS.timeSlot, VECTORS.slice]],
  [0x0028, 0x0030, 'DS', [gated.spacing, gated.spacing]], [0x0028, 0x0103, 'US', 0],
  [0x0054, 0x0021, 'US', 1], [0x0054, 0x0022, 'SQ', [[[0x0020, 0x0032, 'DS', [spectOrigin, spectOrigin, gated.bottom]], [0x0020, 0x0037, 'DS', [1, 0, 0, 0, 1, 0]]]]],
  [0x0054, 0x0051, 'US', 1],
  [0x0054, 0x0060, 'US', Array(gatedCount).fill(1)], [0x0054, 0x0061, 'US', 1],
  [0x0054, 0x0070, 'US', Array.from({ length: gatedCount }, (_, f) => Math.floor(f / gated.slices) + 1)], [0x0054, 0x0071, 'US', gated.slots],
  [0x0054, 0x0080, 'US', Array.from({ length: gatedCount }, (_, f) => f % gated.slices + 1)], [0x0054, 0x0081, 'US', gated.slices],
  [0x7fe0, 0x0010, 'OW', toUint16(gatedFrames)]]);

// ---- The whole-body scan: 512 × 128 at 4 mm, head at the top. Coordinates of the patient seen from the front: x to
// the patient's left, h down from the top of the head (mm).
const wb = { rows: 512, columns: 128, spacing: 4, countsPerUnit: 45 };
const segment = (x, h, [x0, h0], [x1, h1], radius) => {
  const dx = x1 - x0, dh = h1 - h0, t = Math.max(0, Math.min(1, ((x - x0) * dx + (h - h0) * dh) / (dx * dx + dh * dh)));
  return Math.hypot(x - x0 - t * dx, h - h0 - t * dh) < radius;
};
const sides = [-1, 1];
/** Bone uptake as the camera sees it from the front (`front`) or the back; sternum and anterior ribs nearer the front
 * camera, spine and kidneys nearer the back. */
function planar(x, h, front) {
  const near = front ? 1.25 : 0.8, far = front ? 0.75 : 1.35;
  const half = h < 260 ? 80 * Math.sqrt(Math.max(0, 1 - ((h - 130) / 130) ** 2)) : h < 300 ? 55 : h < 1000 ? 175 - Math.max(0, h - 700) * 0.05 : h < 1900 ? 150 : 90;
  if (Math.abs(x) > half && !(h > 300 && h < 1060 && Math.abs(x) < 240)) return 0;
  let uptake = 0.5;
  const skull = Math.hypot(x / 82, (h - 125) / 110);
  if (skull < 1 && skull > 0.86) uptake = 5;
  if (h > 260 && h < 900 && Math.abs(x) < 15) uptake = 6 * far; // spine
  if (h > 330 && h < 640) for (let rib = 0; rib < 11; rib++) for (const side of sides) {
    if (segment(x, h, [side * 18, 350 + rib * 27], [side * (130 + rib * 3), 330 + rib * 31], 4.5)) uptake = Math.max(uptake, 4 * (front ? 0.8 : 1.1));
  }
  if (h > 320 && h < 560 && Math.abs(x) < 13) uptake = Math.max(uptake, 5 * near); // sternum, in front of the spine
  for (const side of sides) {
    if (segment(x, h, [side * 40, 320], [side * 175, 330], 6)) uptake = Math.max(uptake, 4); // clavicles
    if (segment(x, h, [side * 190, 360], [side * 215, 700], 9)) uptake = Math.max(uptake, 4.5); // humeri
    if (segment(x, h, [side * 215, 710], [side * 232, 1000], 7)) uptake = Math.max(uptake, 3.5); // forearms
    if (Math.hypot((x - side * 75) / 85, (h - 950) / 80) < 1 && Math.hypot((x - side * 75) / 85, (h - 950) / 80) > 0.82) uptake = Math.max(uptake, 6); // iliac wings
    if (segment(x, h, [side * 95, 1060], [side * 80, 1480], 13)) uptake = Math.max(uptake, 4.5); // femora
    if (segment(x, h, [side * 78, 1510], [side * 70, 1900], 11)) uptake = Math.max(uptake, 4); // tibiae
    if (Math.hypot((x - side * 75) / 34, (h - 1495) / 26) < 1) uptake = Math.max(uptake, 6.5); // knees
    if (Math.hypot((x - side * 62) / 30, (h - 820) / 55) < 1) uptake = Math.max(uptake, 3.5 * far); // kidneys
  }
  if (Math.hypot(x / 55, (h - 1010) / 45) < 1) uptake = 28; // bladder
  // Lesions: the right seventh rib, the second lumbar vertebra and the left femur.
  if (Math.hypot(x + 128, h - 545) < 11) uptake = 24 * (front ? 0.8 : 1);
  if (Math.hypot(x, h - 790) < 12) uptake = 22 * far;
  if (Math.hypot(x - 92, h - 1230) < 12) uptake = 20;
  return uptake;
}
const views = [];
for (const front of [true, false]) for (let row = 0; row < wb.rows; row++) for (let column = 0; column < wb.columns; column++) {
  // The anterior view shows the patient's right on the left of the image; the posterior one, seen from behind, the left.
  const across = (column + 0.5 - wb.columns / 2) * wb.spacing, x = front ? across : -across, h = (row + 0.5) * wb.spacing;
  const counts = planar(x, h, front) * wb.countsPerUnit;
  views.push(counts + Math.sqrt(counts) * 1.4 * noise(column, row, front ? 1 : 2, 4));
}
const view = (code, meaning) => [[0x0054, 0x0220, 'SQ', [[[0x0008, 0x0100, 'SH', code], [0x0008, 0x0102, 'SH', 'SCT'], [0x0008, 0x0104, 'LO', meaning]]]], [0x0018, 0x1180, 'SH', 'LEHR']];
await write('whole-body/NM00001.dcm', NM, `${root}.14.1`, [...patient, ...isotope,
  [0x0008, 0x0008, 'CS', ['ORIGINAL', 'PRIMARY', 'WHOLE BODY', 'EMISSION']], [0x0008, 0x0030, 'TM', '120000'], [0x0008, 0x0031, 'TM', '120000'],
  [0x0008, 0x0060, 'CS', 'NM'], [0x0008, 0x103e, 'LO', 'Synthetic bone scan · whole body'],
  [0x0018, 0x1301, 'CS', '2PS'], [0x0018, 0x1302, 'IS', 2000], [0x0018, 0x1300, 'DS', 15],
  [0x0020, 0x000d, 'UI', `${root}.3`], [0x0020, 0x000e, 'UI', `${root}.2.4`], [0x0020, 0x0011, 'IS', 1], [0x0020, 0x0013, 'IS', 1],
  ...pixelModule(wb.rows, wb.columns), [0x0028, 0x0008, 'IS', 2], [0x0028, 0x0009, 'AT', [VECTORS.energyWindow, VECTORS.detector]],
  [0x0028, 0x0030, 'DS', [wb.spacing, wb.spacing]], [0x0028, 0x0103, 'US', 0],
  [0x0054, 0x0010, 'US', [1, 1]], [0x0054, 0x0020, 'US', [1, 2]], [0x0054, 0x0021, 'US', 2],
  [0x0054, 0x0022, 'SQ', [view('399321004', 'Anterior projection'), view('399001007', 'Posterior projection')]],
  [0x7fe0, 0x0010, 'OW', toUint16(views)]]);

const series = [
  { folder: 'spect-ct/CT', description: 'Synthetic SPECT/CT · CT', modality: 'CT', dimensions: [ct.size, ct.size, ct.slices], spacing: [ct.spacing, ct.spacing, ct.gap] },
  { folder: 'spect-ct/SPECT', description: 'Synthetic SPECT/CT · SPECT Bq/ml', modality: 'NM', imageType: 'RECON TOMO', dimensions: [spect.size, spect.size, spect.slices],
    spacing: [spect.spacing, spect.spacing, spect.spacing], spacingBetweenSlices: -spect.spacing, realWorldValueSlope: spect.rwvSlope },
  { folder: 'spect-ct/GATED', description: 'Synthetic SPECT/CT · gated SPECT', modality: 'NM', imageType: 'RECON GATED TOMO', dimensions: [gated.size, gated.size, gated.slices],
    spacing: [gated.spacing, gated.spacing, gated.spacing], spacingBetweenSlices: gated.spacing, firstSlice: [spectOrigin, spectOrigin, gated.bottom], gates: gated.slots,
    slotTimes: gated.slotTimes, shellCenter: shell.center },
  { folder: 'spect-ct/PROJECTIONS', description: 'Synthetic SPECT/CT · projections', modality: 'NM', imageType: 'TOMO', dimensions: [spect.size, spect.slices, 2 * stops] },
  { folder: 'whole-body', description: 'Synthetic bone scan · whole body', modality: 'NM', imageType: 'WHOLE BODY', dimensions: [wb.columns, wb.rows, 2], views: ['ANT', 'POST'] },
];
await writeFile(path.join(destination, 'manifest.json'), JSON.stringify({ generator: 'veacom-nm-v2', synthetic: true,
  studies: { spectCt: 'spect-ct', wholeBody: 'whole-body' }, series,
  lesions: { spect: lesions.map(lesion => lesion.at), wholeBody: { rightRib: [-128, 545], l2: [0, 790], leftFemur: [92, 1230] } },
  transferSyntax, sha256: hashes }, null, 2) + '\n');
console.log(`Generated two synthetic NM studies (${series.length} series, ${Object.keys(hashes).length} files) in ${destination}`);
