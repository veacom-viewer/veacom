// Engine check of rigid registration (native/src/registration.rs) on the synthetic follow-up from
// tools/fixtures/make-pet-followup.mjs, through the engine's pipes as the app reaches it, without Electron.
// The prior was scanned at another table position, in its own frame of reference: the same anatomy lies `shift` mm
// further along in its patient coordinates (manifest.json), with no rotation. So:
// - the prior's CT laid over this study's CT maps every prior point p to p − shift, within 1 mm and 0.5°;
// - the same registration asked again gives the same bits (it is deterministic);
// - the prior's PET laid over this study's CT (a PET over a CT acquired apart) lands within 1 mm and 0.5° too;
// - a series the engine no longer holds, or one replaced since, is refused.
//
// Usage: node tools/check-registration.cjs FOLLOWUP_DIR [report.json]
// The core is VEACOM_CORE_PATH, or native/target/release/veacom-core.
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { registrationError } = require('./lib/registration-error.cjs');
const { EngineProcess } = require('../electron/engine-process.cjs');

const [root, output] = process.argv.slice(2).map(value => path.resolve(value));
if (!root) {
  console.error('Usage: node tools/check-registration.cjs FOLLOWUP_DIR [report.json]');
  process.exit(2);
}
const executable = process.platform === 'win32' ? 'veacom-core.exe' : 'veacom-core';
const binary = process.env.VEACOM_CORE_PATH || path.resolve(__dirname, '../native/target/release', executable);
const MAX_MM = 1, MAX_DEGREES = 0.5;

async function main() {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
  assert.equal(manifest.generator, 'veacom-pet-followup-v2', 'Run on the studies made by tools/fixtures/make-pet-followup.mjs.');
  const [prior, current] = ['prior', 'current'].map(name => manifest.studies.find(study => study.name === name));
  // The prior shows the anatomy `shift` further along: its point p is this study's p − shift.
  const shift = prior.shift.map((value, axis) => value - current.shift[axis]);
  const engine = new EngineProcess({ binary, restartDelaysMs: [] });
  const connection = await engine.start();
  const call = async (op, body) => {
    const response = await connection.request(op, body);
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  const report = { fixture: root, shift, checks: [] };
  const check = (name, detail) => { report.checks.push({ name, ...detail }); console.log(`PASS ${name}${detail ? ` ${JSON.stringify(detail)}` : ''}`); };
  try {
    const imported = {};
    for (const study of [prior, current]) {
      const result = await call('import', { paths: [path.join(root, study.folder)] });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      imported[study.name] = Object.fromEntries(result.body.series.map(series => [series.modality, series]));
    }
    const register = async (fixed, moving) => {
      const started = performance.now();
      const result = await call('register', { fixedId: fixed.id, movingId: moving.id, fixedRevision: fixed.sourceRevision, movingRevision: moving.sourceRevision });
      return { ...result, ms: Math.round(performance.now() - started) };
    };
    const measured = (registration, moving) => {
      return { ...registrationError(registration.matrix, moving, shift),
        similarity: Number(registration.similarity.toFixed(3)), before: Number(registration.similarityBefore.toFixed(3)), overlap: Number(registration.overlap.toFixed(3)) };
    };
    assert.notEqual(imported.prior.CT.frameOfReferenceUid, imported.current.CT.frameOfReferenceUid, 'The two visits lie in frames of their own.');

    const ct = await register(imported.current.CT, imported.prior.CT);
    assert.equal(ct.status, 200, JSON.stringify(ct.body));
    const ctResult = measured(ct.body, imported.prior.CT);
    assert.ok(ctResult.worstMm < MAX_MM && ctResult.degrees < MAX_DEGREES, `CT to CT: ${JSON.stringify(ctResult)}`);
    assert.ok(ct.body.similarity > ct.body.similarityBefore, 'Aligned, the CTs match better than in their own coordinates.');
    check('The prior CT lies over this study\'s CT within 1 mm and 0.5°', { ...ctResult, ms: ct.ms });

    const again = await register(imported.current.CT, imported.prior.CT);
    assert.deepEqual(again.body, ct.body, 'The same registration gives the same result.');
    check('Asked again, the registration gives the same bits');

    const pet = await register(imported.current.CT, imported.prior.PT);
    assert.equal(pet.status, 200, JSON.stringify(pet.body));
    const petResult = measured(pet.body, imported.prior.PT);
    assert.ok(petResult.worstMm < MAX_MM && petResult.degrees < MAX_DEGREES, `PET to CT: ${JSON.stringify(petResult)}`);
    check('The prior PET lies over this study\'s CT within 1 mm and 0.5°', { ...petResult, ms: pet.ms });

    const stale = await call('register', { fixedId: imported.current.CT.id, movingId: imported.prior.CT.id, fixedRevision: imported.current.CT.sourceRevision + 1, movingRevision: imported.prior.CT.sourceRevision });
    assert.equal(stale.status, 409);
    const missing = await call('register', { fixedId: 'gone', movingId: imported.prior.CT.id, fixedRevision: 1, movingRevision: imported.prior.CT.sourceRevision });
    assert.equal(missing.status, 404);
    check('A replaced or unknown series is refused');
  } finally {
    await engine.stop();
  }
  if (output) {
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
  }
  console.log('Registration checks passed.');
}

main().catch(error => { console.error(error); process.exit(1); });
