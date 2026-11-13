// A small deterministic sinus CT for the CLOSE caliper check (tools/check-close-calipers.cjs): 0.5 mm voxels over the
// anterior skull base, the nasal cavity and the sphenoid, with landmarks at known places. It is a synthetic phantom made
// of plates and boxes, not anatomy: olfactory fossae of 3.2 mm (right, lamella at 70°) and 6.0 mm (left, at 40°),
// anterior ethmoidal artery canals in the right ethmoid roof and 3 mm below the left one, a septum bowed to the left, and
// a sphenoid sinus reaching under the sella between the tuberculum and dorsum lines. Thin bone has partial volume, as a
// scanner blurs it. The manifest gives the grid and each landmark in patient coordinates (LPS, mm).
//
//   node tools/fixtures/make-sinus-study.mjs <new-directory>
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { dataset, element } from './dicom-elements.mjs';

const [destination, ...rest] = process.argv.slice(2);
if (!destination || rest.length) throw new Error('Usage: node tools/fixtures/make-sinus-study.mjs <new-directory>');
await mkdir(destination); // Refuse to replace an existing study.
const series = path.join(destination, 'S01');
await mkdir(series);

// LPS: x to the patient's left, y to the back, z to the head. Voxel centres every 0.5 mm, 0 on a centre in each axis.
const spacing = 0.5, origin = [-30, -35, -25], dimensions = [121, 141, 101];
const AIR = -1000, SOFT = 40, FAT = -90, BONE = 1000, BODY = 800;
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
/** How much of a voxel a plate covers, from the distance of its centre to the plate's middle (a one-voxel ramp). */
const plate = (distance, half) => clamp((half + spacing / 2 - distance) / spacing, 0, 1);
/** Distance from (px, pz) to the segment a–b in one plane. */
function segment(px, pz, [ax, az], [bx, bz]) {
  const dx = bx - ax, dz = bz - az, t = clamp(((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz || 1), 0, 1);
  return Math.hypot(px - ax - t * dx, pz - az - t * dz);
}
const mix = (value, target, share) => value + (target - value) * share;

// The skull base, per side: the cribriform plate at z = 10 from the crista galli to the lamella's foot at |x| = 5, the
// lateral lamella up to the fovea ethmoidalis, the ethmoid roof out to the lamina papyracea at |x| = 26.
const CRIBRIFORM = 10, foot = { right: [-5, CRIBRIFORM], left: [5, CRIBRIFORM] };
const lamellaTop = (side, depth, degrees) => [foot[side][0] + (side === 'right' ? -1 : 1) * depth / Math.tan(degrees * Math.PI / 180), CRIBRIFORM + depth];
const top = { right: lamellaTop('right', 3.2, 70), left: lamellaTop('left', 6, 40) };
const LAMINA = 26, MAXILLARY_ROOF = -2, PALATE = -18, CREST = -17.5;
// The septum from the cribriform plate to the maxillary crest, bowed to the left at z = -4.
const crista = [0, 17], crest = [0, -17.75], deviated = [22 * Math.tan(12 * Math.PI / 180), -4];
// Anterior ethmoidal artery canals (y from -14 to -6): right inside the roof's bone, left hanging 3 mm below its roof.
const canals = { right: [-14, top.right[1] - 1], left: [16, top.left[1] - 3] }, CANAL_Y = [-14, -6];
// Sphenoid (y from 2 to 30): the sinus up to its back wall at y = 17, the pituitary fossa from the tuberculum (y = 11)
// to the dorsum (y = 21 to 23, top at z = 17).
const SINUS = { y: [3, 17], z: [-12, 6], x: 12 }, FOSSA = { y: 16, z: 14, radius: 5, x: 7 }, DORSUM = { y: 22, z: [14, 17], x: 7 };

function ethmoidAir(x, z) {
  const side = x < 0 ? 'right' : 'left', ax = Math.abs(x), roof = top[side][1];
  if (ax <= 8 && z > PALATE && z < CRIBRIFORM - 0.3) return true; // nasal cavity
  if (ax >= 8 && ax <= LAMINA && z > PALATE + 1 && z < MAXILLARY_ROOF) return true; // maxillary sinus
  if (ax > 0.75 && ax <= LAMINA && z >= MAXILLARY_ROOF && z < CRIBRIFORM) return true; // lower ethmoid
  if (ax <= LAMINA && z >= CRIBRIFORM && z < roof) {
    // Above the plate only lateral to the lamella: medially lies the olfactory fossa.
    const lamella = foot[side][0] + (top[side][0] - foot[side][0]) * (z - CRIBRIFORM) / (roof - CRIBRIFORM);
    return ax > Math.abs(lamella);
  }
  return false;
}

function anteriorBone(x, y, z) {
  const side = x < 0 ? 'right' : 'left', ax = Math.abs(x), roof = top[side][1];
  const parts = [
    plate(segment(x, z, [0, CRIBRIFORM - 0.3], [0, 18]), 0.75), // crista galli
    plate(segment(ax, z, [0.75, CRIBRIFORM], [5, CRIBRIFORM]), 0.3), // cribriform plate
    plate(segment(x, z, foot[side], top[side]), 0.3), // lateral lamella
    plate(segment(x, z, top[side], [side === 'right' ? -LAMINA : LAMINA, roof]), 0.3), // ethmoid roof
    plate(segment(ax, z, [LAMINA, MAXILLARY_ROOF], [LAMINA, roof]), 0.3), // lamina papyracea
    plate(segment(ax, z, [8, MAXILLARY_ROOF], [LAMINA, MAXILLARY_ROOF]), 0.3), // orbital floor
    plate(segment(ax, z, [8, MAXILLARY_ROOF], [8, PALATE + 1]), 0.3), // medial maxillary wall
    plate(Math.min(segment(x, z, [0, CRIBRIFORM - 0.3], deviated), segment(x, z, deviated, [0, CREST])), 0.4), // septum
    plate(segment(x, z, [-LAMINA, -19.5], [LAMINA, -19.5]), 1.5), // hard palate
    plate(segment(x, z, [0, PALATE], [0, CREST]), 0.6), // maxillary crest
  ];
  if (y >= CANAL_Y[0] && y <= CANAL_Y[1]) {
    const canal = canals[side];
    parts.push(plate(Math.abs(Math.hypot(x - canal[0], z - canal[1]) - 0.95), 0.2));
    // The left artery hangs from the roof on a bony mesentery.
    if (side === 'left') parts.push(plate(segment(x, z, [canal[0], canal[1] + 1.15], [canal[0], roof]), 0.3));
  }
  return Math.max(...parts);
}

function value(x, y, z) {
  let hu = SOFT;
  if (y >= -33 && y <= -1) {
    if (Math.abs(x) > LAMINA + 0.3 && z > MAXILLARY_ROOF && z < top[x < 0 ? 'right' : 'left'][1] + 4) hu = FAT; // orbit
    else if (ethmoidAir(x, z)) hu = AIR;
    const canal = canals[x < 0 ? 'right' : 'left'];
    if (y >= CANAL_Y[0] && y <= CANAL_Y[1] && Math.hypot(x - canal[0], z - canal[1]) < 0.75) hu = SOFT; // the artery
    hu = mix(hu, BONE, anteriorBone(x, y, z));
  } else if (Math.abs(x) <= 14 && y >= 1.5 && y <= 30.5) {
    // The sphenoid body, its sinus, the pituitary fossa cut into its top and the dorsum rising behind it.
    const outside = Math.max(2 - y, y - 30, -16 - z, z - 14);
    hu = mix(hu, BODY, clamp((spacing / 2 - outside) / spacing, 0, 1));
    const inSinus = Math.max(SINUS.y[0] - y, y - SINUS.y[1], SINUS.z[0] - z, z - SINUS.z[1], Math.abs(x) - SINUS.x);
    hu = mix(hu, AIR, clamp((spacing / 2 - inSinus) / spacing, 0, 1));
    if (Math.abs(x) <= FOSSA.x) {
      const inFossa = Math.hypot(y - FOSSA.y, z - FOSSA.z) - FOSSA.radius;
      hu = mix(hu, SOFT, clamp((spacing / 2 - inFossa) / spacing, 0, 1));
      hu = mix(hu, BONE, plate(segment(y, z, [DORSUM.y, DORSUM.z[0]], [DORSUM.y, DORSUM.z[1]]), 1));
    }
  }
  return Math.round(hu);
}

const root = '2.25.302617644913925066835652647005517224101.30', sopClass = '1.2.840.10008.5.1.4.1.1.2', transferSyntax = '1.2.840.10008.1.2.1';
const [nx, ny, nz] = dimensions, hashes = {};
for (let k = 0; k < nz; k++) {
  const z = origin[2] + k * spacing, uid = `${root}.3.${k + 1}`, pixels = Buffer.alloc(nx * ny * 2);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) pixels.writeInt16LE(value(origin[0] + i * spacing, origin[1] + j * spacing, z), (j * nx + i) * 2);
  const meta = dataset([
    [0x0002, 0x0001, 'OB', [0, 1]], [0x0002, 0x0002, 'UI', sopClass], [0x0002, 0x0003, 'UI', uid],
    [0x0002, 0x0010, 'UI', transferSyntax], [0x0002, 0x0012, 'UI', `${root}.4`],
  ]);
  const bytes = Buffer.concat([Buffer.alloc(128), Buffer.from('DICM'), element(0x0002, 0x0000, 'UL', meta.length), meta, dataset([
    [0x0008, 0x0016, 'UI', sopClass], [0x0008, 0x0018, 'UI', uid], [0x0008, 0x0020, 'DA', '20000101'], [0x0008, 0x0030, 'TM', '120000'],
    [0x0008, 0x0060, 'CS', 'CT'], [0x0008, 0x1030, 'LO', 'Synthetic paranasal sinus CT'], [0x0008, 0x103e, 'LO', 'Synthetic sinus CT bone'],
    [0x0010, 0x0010, 'PN', 'SYNTHETIC^SINUS'], [0x0010, 0x0020, 'LO', 'SYNTHETIC-SINUS'], [0x0018, 0x0050, 'DS', spacing],
    [0x0020, 0x000d, 'UI', `${root}.1`], [0x0020, 0x000e, 'UI', `${root}.2`], [0x0020, 0x0011, 'IS', 1], [0x0020, 0x0013, 'IS', k + 1],
    [0x0020, 0x0032, 'DS', [origin[0], origin[1], z]], [0x0020, 0x0037, 'DS', [1, 0, 0, 0, 1, 0]], [0x0020, 0x0052, 'UI', `${root}.5`],
    [0x0028, 0x0002, 'US', 1], [0x0028, 0x0004, 'CS', 'MONOCHROME2'], [0x0028, 0x0010, 'US', ny], [0x0028, 0x0011, 'US', nx],
    [0x0028, 0x0030, 'DS', [spacing, spacing]], [0x0028, 0x0100, 'US', 16], [0x0028, 0x0101, 'US', 16], [0x0028, 0x0102, 'US', 15],
    [0x0028, 0x0103, 'US', 1], [0x0028, 0x1050, 'DS', 400], [0x0028, 0x1051, 'DS', 2000], [0x0028, 0x1052, 'DS', 0], [0x0028, 0x1053, 'DS', 1],
    [0x7fe0, 0x0010, 'OW', pixels],
  ])]);
  const name = `IM${String(k + 1).padStart(4, '0')}.dcm`;
  await writeFile(path.join(series, name), bytes);
  hashes[name] = createHash('sha256').update(bytes).digest('hex');
}

const round = point => point.map(value => Math.round(value * 1000) / 1000);
await writeFile(path.join(destination, 'manifest.json'), `${JSON.stringify({
  generator: 'veacom-sinus-v1', synthetic: true, grid: { origin, spacing, dimensions },
  // Where the check clicks, in patient mm (x, y, z), on the coronal planes y = -15 (fossae), y = -10 (arteries) and
  // y = -25 (septum), and the midsagittal plane x = 0 (sella), with the values those points give.
  landmarks: {
    // Keros: the olfactory fossa's floor beside the crista galli, and the ethmoid roof at the top of the lateral lamella.
    keros: { y: -15, right: [[-2.5, CRIBRIFORM], top.right].map(round), left: [[2.5, CRIBRIFORM], top.left].map(round) },
    aea: { y: -10, right: { canal: round(canals.right), roof: round([canals.right[0], top.right[1]]) },
      // Clicked in the air below the left roof: the point moves up onto the bone.
      left: { canal: round(canals.left), roof: [18, 15.4] } },
    septum: { y: -25, crest, crista, deviated: round(deviated) },
    sella: { x: 0, tuberculum: [10.8, 13.8], dorsum: [DORSUM.y, DORSUM.z[1]], wall: [SINUS.y[1] - 0.5, 0] },
  },
  expected: {
    keros: { right: { depth: 3.2, type: '1', nearLimit: true }, left: { depth: 6, type: '2', nearLimit: false } },
    aea: { right: { distance: 1, answer: null }, left: { distance: 2.8, answer: 'yes' } },
    septum: { angle: Math.atan2(deviated[0], crista[1] - deviated[1]) * 180 / Math.PI, side: 'left' },
    sella: { answer: 'sellar' },
  },
  files: hashes,
}, null, 2)}\n`);
console.log(`Synthetic sinus CT: ${nz} slices of ${nx} x ${ny} at ${spacing} mm in ${destination}`);
