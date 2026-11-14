// A deterministic synthetic standing long-leg radiograph (DX, AP, both legs), for the deformity planning checks and
// screenshots. Nothing here comes from a patient: the bones are drawn from chosen joint angles, and the manifest gives
// every landmark, in image pixels, with the values those angles imply, worked out here in closed form.
//
// - The right leg has a proximal tibia vara: the tibial shaft bends 8° at 90 mm below the knee centre (the CORA), so
//   MPTA is low and the knee is in varus. The left leg has a valgus distal femur (mLDFA 83°).
// - Bones, a 25.0 mm ball and a ruler marked every 10 mm all sit at one depth, magnified 1.1 times on the detector.
//   The detector's pixels are 0.33 mm, so 0.3 mm in that plane.
// - One series per calibration variant: the same pixels with different spacing tags (PS3.3 10.7.1.1, C.8.11.4,
//   C.8.11.5), a mirrored film (Patient Orientation R\F), and one without Patient Orientation.
//
//   node tools/fixtures/make-longleg-study.mjs <new-directory> [--variants=ips-only,none,...]
//
// Pixel coordinates in the manifest follow DICOM's image-relative coordinates (PS3.3 C.18.6.1.1, as SR SCOORDs use):
// x to the right and y down, (0, 0) at the top left corner of the top left pixel, so the first pixel's centre is
// (0.5, 0.5). Its column index is x - 0.5 and its row index y - 0.5.
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { dataset, element } from './dicom-elements.mjs';

const GENERATOR = 'veacom-longleg-v1';
const DETECTOR_MM = 0.33, MAGNIFICATION = 1.1, OBJECT_MM = 0.3;
const WIDTH_MM = 390, HEIGHT_MM = 1050;
const COLUMNS = Math.round(WIDTH_MM / OBJECT_MM), ROWS = Math.round(HEIGHT_MM / OBJECT_MM);
const BALL_MM = 25;

/** The spacing tags of each variant, and what the viewer must make of them. `mmPerPixel` is the spacing a measurement
 * uses, `state` the calibration it names (src/imaging/radiograph.ts). */
const VARIANTS = {
  'ps-only': { description: 'Pixel Spacing only', tags: { ps: OBJECT_MM }, state: 'unstated', mmPerPixel: OBJECT_MM },
  'ips-only': { description: 'Imager Pixel Spacing only', tags: { ips: DETECTOR_MM }, state: 'detector', mmPerPixel: DETECTOR_MM },
  'ips-ermf': { description: 'Imager Pixel Spacing and ERMF', tags: { ips: DETECTOR_MM, ermf: MAGNIFICATION }, state: 'magnification', mmPerPixel: OBJECT_MM },
  'ips-equal': { description: 'Pixel Spacing equal to Imager', tags: { ps: DETECTOR_MM, ips: DETECTOR_MM }, state: 'detector', mmPerPixel: DETECTOR_MM },
  'geometry': { description: 'Calibrated GEOMETRY', tags: { ps: OBJECT_MM, ips: DETECTOR_MM, type: 'GEOMETRY', text: 'Magnification assumed at the femur' }, state: 'calibrated', mmPerPixel: OBJECT_MM },
  'fiducial': { description: 'Calibrated FIDUCIAL', tags: { ps: OBJECT_MM, ips: DETECTOR_MM, type: 'FIDUCIAL', text: '25 mm ball at the thigh' }, state: 'calibrated', mmPerPixel: OBJECT_MM },
  'ps-differs': { description: 'Pixel Spacing differs, no type', tags: { ps: OBJECT_MM, ips: DETECTOR_MM }, state: 'calibrated', mmPerPixel: OBJECT_MM },
  'none': { description: 'No spacing', tags: {}, state: 'pixels', mmPerPixel: null },
  'mirrored': { description: 'Mirrored R-F', tags: { ips: DETECTOR_MM }, orientation: ['R', 'F'], state: 'detector', mmPerPixel: DETECTOR_MM },
  'no-orientation': { description: 'No Patient Orientation', tags: { ips: DETECTOR_MM }, orientation: null, state: 'detector', mmPerPixel: DETECTOR_MM },
};

const [destination, ...options] = process.argv.slice(2);
const chosen = options.find(option => option.startsWith('--variants='))?.slice('--variants='.length).split(',') ?? Object.keys(VARIANTS);
if (!destination || options.some(option => !option.startsWith('--variants=')) || chosen.some(name => !Object.hasOwn(VARIANTS, name))) {
  throw new Error(`Usage: node tools/fixtures/make-longleg-study.mjs <new-directory> [--variants=${Object.keys(VARIANTS).join(',')}]`);
}

// Plane geometry in millimetres at the bones' depth: x to the image's right, y down. rot turns from +x towards +y.
const deg = Math.PI / 180;
const add = (a, b) => [a[0] + b[0], a[1] + b[1]], sub = (a, b) => [a[0] - b[0], a[1] - b[1]], mul = (a, s) => [a[0] * s, a[1] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1], cross = (a, b) => a[0] * b[1] - a[1] * b[0], norm = a => Math.hypot(a[0], a[1]);
const unit = a => mul(a, 1 / norm(a));
const rot = (v, degrees) => { const c = Math.cos(degrees * deg), s = Math.sin(degrees * deg); return [v[0] * c - v[1] * s, v[0] * s + v[1] * c]; };
/** The angle between two directions, 0 to 180°. */
const between = (a, b) => Math.acos(Math.max(-1, Math.min(1, dot(unit(a), unit(b))))) / deg;
const round = (value, digits = 4) => Number(value.toFixed(digits));

/**
 * One leg, built from its joint angles. `lateral` is +1 when the leg's lateral side is towards +x. All angles in
 * degrees as Paley defines them: mLPFA and mLDFA lateral, MPTA medial, LDTA lateral; JLCA positive when the joint lines
 * converge medially; the tibia bends by `cora` degrees, apex lateral (varus), `apexMm` below the knee centre.
 */
function leg({ side, lateral, hip, femurMm, adduction, mLPFA, mLDFA, ama, jlca, mpta, ldta, tibiaMm, cora, apexMm }) {
  const H = hip;
  const dF = unit([-lateral * Math.sin(adduction * deg), Math.cos(adduction * deg)]); // hip to knee
  const K = add(H, mul(dF, femurMm)), uF = mul(dF, -1);
  const jF = rot(uF, lateral * mLDFA); // the distal femoral joint line, pointing lateral
  const jT = rot(jF, lateral * jlca);
  // The proximal tibial axis leaves the knee centre at the plateau's angle; past the apex the shaft turns medially.
  const d1 = rot(mul(jT, -1), -lateral * mpta);
  const apex = add(K, mul(d1, apexMm));
  const d2 = rot(d1, lateral * cora);
  const A = add(apex, mul(d2, tibiaMm - apexMm));
  const jA = rot(mul(d2, -1), lateral * ldta); // the plafond, pointing lateral, square to the distal tibia as normal
  const gt = add(H, mul(rot(dF, -lateral * mLPFA), 55));
  const nF = unit(rot(jF, lateral * 90)); // square to the femoral joint line, pointing distally
  const femoralLine = add(K, mul(dF, 5));
  const condyles = { medial: add(femoralLine, mul(jF, -38)), lateral: add(femoralLine, mul(jF, 38)) };
  const nT = unit(rot(jT, lateral * 90));
  const plateauLine = add(K, mul(nT, 9));
  const plateau = { medial: add(plateauLine, mul(jT, -40)), lateral: add(plateauLine, mul(jT, 40)) };
  const plafondLine = add(A, mul(d2, -4));
  const plafond = { medial: add(plafondLine, mul(jA, -17)), lateral: add(plafondLine, mul(jA, 17)) };
  // The femoral anatomic axis: AMA from the mechanical axis, its proximal end lateral, through a point 10 mm medial to
  // the knee centre (Paley). The shaft midpoints lie on it.
  const aF = rot(uF, lateral * ama);
  const femoralAxisPoint = add(K, mul(jF, -10));
  const femoralShaft = [add(femoralAxisPoint, mul(aF, 300)), add(femoralAxisPoint, mul(aF, 110))];
  const tibialShaft = [add(K, mul(d1, 60)), add(apex, mul(d2, 170))];
  const headRadius = 24;
  const headContour = [-75, -20, 35].map(angle => add(H, mul(rot(uF, lateral * angle), headRadius)));
  return { side, lateral, H, K, A, dF, uF, jF, jT, nF, nT, d1, d2, jA, aF, apex, gt, condyles, plateau, plafond, femoralShaft, tibialShaft,
    headRadius, headContour, femurMm, tibiaMm, design: { mLPFA, mLDFA, aLDFA: mLDFA - ama, ama, jlca, cora, apexMm } };
}

const legs = [
  leg({ side: 'R', lateral: -1, hip: [WIDTH_MM / 2 - 92, 125], femurMm: 440, adduction: 3, mLPFA: 90, mLDFA: 87, ama: 6, jlca: 1.5, mpta: 87, ldta: 89, tibiaMm: 380, cora: 8, apexMm: 90 }),
  leg({ side: 'L', lateral: 1, hip: [WIDTH_MM / 2 + 92, 125], femurMm: 445, adduction: 3, mLPFA: 92, mLDFA: 83, ama: 6, jlca: 0.5, mpta: 88, ldta: 89, tibiaMm: 385, cora: 0, apexMm: 90 }),
];

/** What a leg measures, from its points in closed form: each angle between the two directions that define it. */
function values(l, ankle = l.A, plafond = l.plafond) {
  const tibialAxis = sub(ankle, l.K), limb = sub(ankle, l.H), lateral = [l.lateral, 0];
  const jFemur = sub(l.condyles.lateral, l.condyles.medial), jTibia = sub(l.plateau.lateral, l.plateau.medial);
  const mpta = between(tibialAxis, sub(l.plateau.medial, l.plateau.lateral));
  const ldta = between(mul(tibialAxis, -1), sub(plafond.lateral, plafond.medial));
  // The knee centre's offset from the hip–ankle line: positive when the line passes medial to the knee (varus).
  const offset = cross(limb, sub(l.K, l.H)) / norm(limb);
  const lateralSign = Math.sign(cross(limb, lateral));
  const mad = offset * lateralSign;
  const hkaSize = between(sub(l.K, l.H), tibialAxis);
  // The weight-bearing line crosses the plateau line at this share of its width from the medial edge (Fujisawa).
  const p = l.plateau.medial, r = sub(l.plateau.lateral, l.plateau.medial);
  const t = cross(sub(l.H, p), limb) / cross(r, limb);
  return { mLPFA: between(sub(l.K, l.H), sub(l.gt, l.H)), mLDFA: between(l.uF, sub(l.condyles.lateral, l.condyles.medial)),
    aLDFA: between(l.aF, sub(l.condyles.lateral, l.condyles.medial)), MPTA: mpta, LDTA: ldta,
    JLCA: Math.atan2(cross(jFemur, jTibia), dot(jFemur, jTibia)) / deg * l.lateral, HKA: hkaSize * Math.sign(mad), MAD: mad, WBL: t * 100,
    femurLength: norm(sub(l.K, l.H)), tibiaLength: norm(tibialAxis), limbLength: norm(limb) };
}

// The planned correction of the right leg: an opening wedge HTO at the CORA's level, hinge on the lateral cortex,
// opened 8° towards valgus. The distal fragment turns about the hinge; the plateau stays.
const right = legs[0];
const hinge = add(right.apex, mul([right.lateral, 0], 14));
const cutStart = add(right.apex, mul([-right.lateral, 0], 16));
const opening = 8;
const turn = point => add(hinge, rot(sub(point, hinge), -right.lateral * opening));
const corrected = values(right, turn(right.A), { medial: turn(right.plafond.medial), lateral: turn(right.plafond.lateral) });

// Millimetres at the bones' depth to image pixels: x, y with (0, 0) at the first pixel's top left corner.
const toPixel = point => [point[0] / OBJECT_MM, point[1] / OBJECT_MM];
const pixel = point => toPixel(point).map(value => round(value, 4));

// The film. Values 0–4095 (12 bits): air, soft tissue, bone with its marrow, metal.
function film() {
  const pixels = new Uint16Array(COLUMNS * ROWS);
  const capsule = (p, a, b, r) => { const ab = sub(b, a), t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / dot(ab, ab))); return norm(sub(p, add(a, mul(ab, t)))) <= r; };
  const disc = (p, c, r) => norm(sub(p, c)) <= r;
  const inside = (p, polygon) => { let hit = false; for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) { const a = polygon[i], b = polygon[j]; if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) hit = !hit; } return hit; };
  const bones = legs.map(l => {
    const neckBase = add(l.H, mul(sub(l.gt, l.H), 0.62));
    const shaftTop = add(l.femoralShaft[0], mul(l.aF, 40)), shaftEnd = add(l.K, mul(l.uF, 70));
    const condyleCentres = [l.condyles.medial, l.condyles.lateral].map(point => sub(point, mul(l.nF, 21)));
    const plateauBase = [add(l.plateau.lateral, mul(l.nT, 30)), add(l.plateau.medial, mul(l.nT, 30))];
    const distalTop = add(l.A, mul(l.d2, -60));
    return {
      cortex: p => disc(p, l.H, l.headRadius) || capsule(p, l.H, neckBase, 15) || disc(p, add(l.gt, mul(l.dF, 17)), 17)
        || capsule(p, shaftTop, shaftEnd, 14) || capsule(p, neckBase, shaftTop, 16)
        || condyleCentres.some(c => disc(p, c, 21)) || inside(p, [add(shaftEnd, mul(l.jF, -14)), add(shaftEnd, mul(l.jF, 14)), condyleCentres[1], condyleCentres[0]])
        || inside(p, [l.plateau.medial, l.plateau.lateral, ...plateauBase]) || capsule(p, add(l.K, mul(l.d1, 30)), l.apex, 13) || capsule(p, l.apex, distalTop, 12)
        || inside(p, [add(distalTop, mul(l.jA, -11)), add(distalTop, mul(l.jA, 11)), l.plafond.lateral, l.plafond.medial])
        || disc(p, add(l.A, mul(l.d2, 13)), 14)
        // The fibula, lateral to the tibia.
        || capsule(p, add(add(l.K, mul(l.d1, 25)), mul(l.jT, 36)), add(add(l.A, mul(l.d2, -20)), mul(l.jA, 25)), 6),
      marrow: p => capsule(p, shaftTop, shaftEnd, 9) || capsule(p, add(l.K, mul(l.d1, 40)), l.apex, 8) || capsule(p, l.apex, add(distalTop, mul(l.d2, -10)), 7),
      soft: p => capsule(p, add(l.H, [0, -40]), l.K, 78) || capsule(p, l.K, l.A, 50) || capsule(p, l.A, add(l.A, [0, 45]), 42),
    };
  });
  const ball = [WIDTH_MM - 30, 440], ruler = { x: 14, top: 300, bottom: 620 };
  for (let row = 0; row < ROWS; row++) {
    for (let column = 0; column < COLUMNS; column++) {
      const p = [(column + 0.5) * OBJECT_MM, (row + 0.5) * OBJECT_MM];
      let value = 160 + ((column * 7 + row * 3) % 11);
      if (bones.some(bone => bone.soft(p))) value = 900 + ((column * 5 + row * 13) % 23);
      for (const bone of bones) if (bone.cortex(p)) value = bone.marrow(p) ? 1900 : 2700;
      if (disc(p, ball, BALL_MM / 2)) value = 3900;
      // The ruler: a bar with a mark every 10 mm, longer every 50 mm.
      if (p[1] >= ruler.top && p[1] <= ruler.bottom) {
        const along = p[1] - ruler.top, mark = Math.abs(along - Math.round(along / 10) * 10) <= 0.45;
        const reach = Math.round(along / 10) % 5 === 0 ? 12 : 7;
        if ((p[0] >= ruler.x && p[0] <= ruler.x + 2) || (mark && p[0] > ruler.x && p[0] <= ruler.x + reach)) value = 3700;
      }
      pixels[row * COLUMNS + column] = value;
    }
  }
  return { pixels, ball, ruler };
}

const { pixels, ball, ruler } = film();
const root = '2.25.118804557219940366285711983047021555003';
await mkdir(destination); // Refuse to replace an existing study.
const hashes = {}, series = {};
let number = 0;
for (const name of chosen) {
  const variant = VARIANTS[name];
  number++;
  const mirrored = name === 'mirrored';
  const data = Buffer.alloc(COLUMNS * ROWS * 2);
  for (let row = 0; row < ROWS; row++) for (let column = 0; column < COLUMNS; column++) {
    data.writeUInt16LE(pixels[row * COLUMNS + (mirrored ? COLUMNS - 1 - column : column)], (row * COLUMNS + column) * 2);
  }
  const uid = `${root}.3.${number}`, sopClass = '1.2.840.10008.5.1.4.1.1.1.1', transferSyntax = '1.2.840.10008.1.2.1';
  const orientation = variant.orientation === undefined ? ['L', 'F'] : variant.orientation;
  const { ps, ips, ermf, type, text } = variant.tags;
  const meta = dataset([[0x0002, 0x0001, 'OB', [0, 1]], [0x0002, 0x0002, 'UI', sopClass], [0x0002, 0x0003, 'UI', uid],
    [0x0002, 0x0010, 'UI', transferSyntax], [0x0002, 0x0012, 'UI', `${root}.4`]]);
  const elements = [
    [0x0008, 0x0008, 'CS', ['DERIVED', 'PRIMARY']], [0x0008, 0x0016, 'UI', sopClass], [0x0008, 0x0018, 'UI', uid],
    [0x0008, 0x0020, 'DA', '20000101'], [0x0008, 0x0030, 'TM', '120000'], [0x0008, 0x0060, 'CS', 'DX'], [0x0008, 0x0068, 'CS', 'FOR PRESENTATION'],
    [0x0008, 0x0070, 'LO', 'VEACOM SYNTHETIC'], [0x0008, 0x103e, 'LO', `Synthetic long leg · ${variant.description}`],
    [0x0010, 0x0010, 'PN', 'SYNTHETIC^LONGLEG'], [0x0010, 0x0020, 'LO', 'SYNTHETIC-LONGLEG'], [0x0018, 0x0015, 'CS', 'LEG'],
    ...(ips === undefined ? [] : [[0x0018, 0x1110, 'DS', 1800], [0x0018, 0x1111, 'DS', round(1800 / MAGNIFICATION, 2)]]),
    ...(ermf === undefined ? [] : [[0x0018, 0x1114, 'DS', ermf]]),
    ...(ips === undefined ? [] : [[0x0018, 0x1164, 'DS', [ips, ips]]]),
    [0x0018, 0x5101, 'CS', 'AP'],
    [0x0020, 0x000d, 'UI', `${root}.1`], [0x0020, 0x000e, 'UI', `${root}.2.${number}`], [0x0020, 0x0011, 'IS', number], [0x0020, 0x0013, 'IS', 1],
    ...(orientation ? [[0x0020, 0x0020, 'CS', orientation]] : []), [0x0020, 0x0062, 'CS', 'B'],
    [0x0028, 0x0002, 'US', 1], [0x0028, 0x0004, 'CS', 'MONOCHROME2'], [0x0028, 0x0010, 'US', ROWS], [0x0028, 0x0011, 'US', COLUMNS],
    ...(ps === undefined ? [] : [[0x0028, 0x0030, 'DS', [ps, ps]]]),
    [0x0028, 0x0100, 'US', 16], [0x0028, 0x0101, 'US', 12], [0x0028, 0x0102, 'US', 11], [0x0028, 0x0103, 'US', 0],
    ...(type === undefined ? [] : [[0x0028, 0x0a02, 'CS', type], [0x0028, 0x0a04, 'LO', text]]),
    [0x0028, 0x1050, 'DS', 2048], [0x0028, 0x1051, 'DS', 4096], [0x0028, 0x1040, 'CS', 'LIN'],
    [0x7fe0, 0x0010, 'OW', data],
  ];
  const bytes = Buffer.concat([Buffer.alloc(128), Buffer.from('DICM'), element(0x0002, 0x0000, 'UL', meta.length), meta, dataset(elements)]);
  const file = `${name}.dcm`;
  await writeFile(path.join(destination, file), bytes);
  hashes[file] = createHash('sha256').update(bytes).digest('hex');
  series[name] = { file, description: `Synthetic long leg · ${variant.description}`, state: variant.state, mmPerPixel: variant.mmPerPixel,
    patientOrientation: orientation, mirrored, tags: variant.tags };
}

/** A leg's landmarks in image pixels, mirrored for the mirrored film. */
function landmarks(l, mirrored) {
  const at = point => { const [x, y] = pixel(point); return mirrored ? [round(COLUMNS - x, 4), y] : [x, y]; };
  return {
    femoralHeadContour: l.headContour.map(at), hipCentre: at(l.H), greaterTrochanter: at(l.gt), kneeCentre: at(l.K), ankleCentre: at(l.A),
    femoralCondyleMedial: at(l.condyles.medial), femoralCondyleLateral: at(l.condyles.lateral),
    tibialPlateauMedial: at(l.plateau.medial), tibialPlateauLateral: at(l.plateau.lateral),
    plafondMedial: at(l.plafond.medial), plafondLateral: at(l.plafond.lateral),
    femoralShaft: l.femoralShaft.map(at), tibialShaft: l.tibialShaft.map(at), tibialCora: at(l.apex),
  };
}
const rounded = object => Object.fromEntries(Object.entries(object).map(([key, value]) => [key, round(value)]));
await writeFile(path.join(destination, 'manifest.json'), JSON.stringify({
  generator: GENERATOR, synthetic: true, modality: 'DX', columns: COLUMNS, rows: ROWS, transferSyntax: '1.2.840.10008.1.2.1',
  coordinates: 'DICOM image-relative pixels: (0, 0) is the top left corner of the top left pixel (PS3.3 C.18.6.1.1)',
  detectorMm: DETECTOR_MM, magnification: MAGNIFICATION, objectMm: OBJECT_MM, ballDiameterMm: BALL_MM,
  ball: { centre: pixel(ball), radiusPixels: round(BALL_MM / 2 / OBJECT_MM),
    edge: [0, 70, 150, 230].map(angle => pixel(add(ball, mul(rot([1, 0], angle), BALL_MM / 2)))) },
  ruler: { from: pixel([ruler.x + 1, ruler.top + 50]), to: pixel([ruler.x + 1, ruler.top + 250]), lengthMm: 200 },
  series,
  // True millimetres at the bones' depth. A variant measures them times its mmPerPixel / objectMm.
  legs: legs.map(l => ({ side: l.side, design: l.design, landmarks: landmarks(l, false), mirroredLandmarks: landmarks(l, true), expected: rounded(values(l)),
    cora: l.design.cora ? { at: pixel(l.apex), magnitude: l.design.cora } : null })),
  osteotomy: { side: 'R', bone: 'tibia', wedge: 'opening', hinge: pixel(hinge), cut: [pixel(cutStart), pixel(hinge)], angle: opening, direction: 'valgus',
    wedgeHeightMm: round(2 * norm(sub(hinge, cutStart)) * Math.sin(opening / 2 * deg)), expected: rounded(corrected) },
  sha256: hashes,
}, null, 2) + '\n');
console.log(`Generated ${chosen.length} synthetic long-leg films (${COLUMNS} × ${ROWS}) in ${destination}`);
