// The two input files of tools/pet-validation.cjs for the synthetic follow-up of tools/fixtures/make-pet-followup.mjs,
// worked out from its manifest: the spheres (liver, blood pool in the descending aorta, the two lesions) in each study's
// own patient coordinates, and the values a perfect workstation would read there, in the vendor file's format. The PET
// has no noise or blur, so these are the known values: liver 2, blood pool 1.5, lesions 10 then 7, and 4.5 then 3.
//
//   node tools/fixtures/make-pet-validation-inputs.mjs <follow-up-directory>
//
// Writes pet-validation-spheres.json and pet-validation-expected.json into that directory, and refuses to replace them.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [directory, ...rest] = process.argv.slice(2);
if (!directory || rest.length) throw new Error('Usage: node tools/fixtures/make-pet-validation-inputs.mjs <follow-up-directory>');
const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
if (manifest.generator !== 'veacom-pet-followup-v2') throw new Error('Run on the studies made by tools/fixtures/make-pet-followup.mjs.');

const { weightKg, heightM, sex, doseBq, bqPerSuv } = manifest.suv;
// SUL per SUVbw for this patient: lean body mass by Janmahasatian et al. 2005, as VEAcom computes it.
const sulPerBw = (sex === 'M' ? 9270 / (6680 + 216 * weightKg / heightM ** 2) : 9270 / (8780 + 244 * weightKg / heightM ** 2));
const two = value => Number(value.toFixed(2));
// A lesion's voxels on the PET grid: those whose centres lie inside it. At 41% of its SUVmax, MTV counts exactly these.
const lesionMtv = (grid, lesion) => {
  const [nx, ny, nz] = grid.dimensions, [sx, sy, sz] = grid.spacing, [ox, oy] = grid.origin;
  let count = 0;
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (Math.hypot(ox + i * sx - lesion.center[0], oy + j * sy - lesion.center[1], -k * sz - lesion.center[2]) <= lesion.radius) count++;
  }
  return count * sx * sy * sz / 1000;
};

const spheres = { studies: [] }, expected = {
  software: 'Known values of the synthetic follow-up (tools/fixtures/make-pet-followup.mjs)',
  tolerances: { max: 0, peak: 0, mean: 0, mtv: 0, tlg: 0, factor: 0, sameVoxel: 0 },
  studies: [],
};
for (const study of manifest.studies) {
  const grid = study.series.find(series => series.modality === 'PT');
  spheres.studies.push({ study: study.folder, spheres: [
    { name: 'liver', role: 'liver', center: study.liver.center },
    // Inside the descending aorta (12 mm across its radius), clear of its wall.
    { name: 'blood pool', role: 'bloodPool', center: study.bloodPool.center, radius: 7.5 },
    // Each lesion with 5 mm around it: nothing else inside reaches 41% of its SUVmax.
    ...study.lesions.map(lesion => ({ name: lesion.id, center: lesion.center, radius: lesion.radius + 5 })),
  ] });
  const readings = {
    liver: { SUVbw: { max: study.liver.suv, peak: study.liver.suv, mean: study.liver.suv }, SUL: { mean: two(study.liver.suv * sulPerBw) } },
    'blood pool': { SUVbw: { max: study.bloodPool.suv, mean: study.bloodPool.suv }, SUL: { mean: two(study.bloodPool.suv * sulPerBw) } },
  };
  for (const lesion of study.lesions) {
    const mtv = lesionMtv(grid, lesion);
    readings[lesion.id] = { SUVbw: { max: lesion.suv, peak: lesion.suv, mtv: Number(mtv.toFixed(mtv < 10 ? 2 : 1)), tlg: Number((mtv * lesion.suv).toFixed(1)) },
      SUL: { max: two(lesion.suv * sulPerBw), peak: two(lesion.suv * sulPerBw) },
      // Stored as whole Bq/ml (the fixture writes 16-bit values with a rescale slope of 1).
      maxBqml: Math.round(lesion.suv * bqPerSuv) };
  }
  const [hours, minutes, seconds] = [0, 2, 4].map(at => study.pet.injection.slice(at, at + 2));
  expected.studies.push({ study: study.folder,
    // Decay corrected to the administration (ADMIN), so SUVbw is weight / injected activity, whatever the uptake time.
    suv: { factor: weightKg * 1000 / doseBq, weightKg, heightM, sex, doseMBq: doseBq / 1e6, injectionTime: `${hours}:${minutes}:${seconds}` },
    spheres: readings });
}
await writeFile(path.join(directory, 'pet-validation-spheres.json'), `${JSON.stringify(spheres, null, 2)}\n`, { flag: 'wx' });
await writeFile(path.join(directory, 'pet-validation-expected.json'), `${JSON.stringify(expected, null, 2)}\n`, { flag: 'wx' });
console.log(`Wrote pet-validation-spheres.json and pet-validation-expected.json (${manifest.studies.length} studies) in ${directory}`);
