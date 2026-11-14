// Desktop check of the lower-limb deformity plan on the synthetic long-leg films of tools/fixtures/make-longleg-study.mjs.
// It opens each spacing variant and checks the calibration the kit names and the lengths it gives; on the film with
// only Imager Pixel Spacing it places every landmark of both legs with real clicks and checks each angle to 0.1° and
// each length to 0.5 mm against the generator's closed-form values, then the malalignment test, the tibial CORA, an
// 8° opening wedge HTO measured again live and its fragment drawn moved, Undo and Redo, saving and opening the plan,
// and the report. On the film without spacing it calibrates on the ball; on the mirrored film the angles keep their
// names; on the film without Patient Orientation the kit asks where the patient's right is.
// usage: node tools/check-deformity-plan.cjs LONGLEG_STUDY [OUTPUT_DIR]
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const os = require('node:os');
const { ignoreOutsideInput } = require('./lib/outside-input.cjs');
const { closeDesktop } = require('./lib/close-desktop.cjs');
const { decodePng } = require('./lib/png.cjs');

const ANGLE = 0.1, LENGTH = 0.5;
const ORDER = ['femoralHeadContour', 'greaterTrochanterTip', 'femoralShaftProximal', 'femoralShaftDistal', 'kneeCentre', 'femoralCondyleMedial', 'femoralCondyleLateral',
  'tibialPlateauMedial', 'tibialPlateauLateral', 'tibialShaftProximal', 'tibialShaftDistal', 'plafondMedial', 'plafondLateral', 'ankleCentre'];
const ANGLES = ['mLPFA', 'mLDFA', 'aLDFA', 'MPTA', 'LDTA', 'JLCA', 'HKA'], LENGTHS = ['MAD', 'femurLength', 'tibiaLength', 'limbLength'];

async function main() {
  const study = path.resolve(process.argv[2]);
  const output = path.resolve(process.argv[3] || 'test-results/deformity-plan');
  const manifest = JSON.parse(await fs.readFile(path.join(study, 'manifest.json'), 'utf8'));
  assert.equal(manifest.generator, 'veacom-longleg-v1', 'Run on the films made by tools/fixtures/make-longleg-study.mjs.');
  await fs.mkdir(output, { recursive: true });
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'veacom-deformity-'));
  const desktop = await electron.launch({ args: [path.resolve(__dirname, '..'), '--study', study], timeout: 90_000,
    env: { ...process.env, VEACOM_USER_DATA: userData, VEACOM_LOCALE: 'en', VEACOM_TELEMETRY_CONSENT: 'denied', VEACOM_USAGE_CHECK_LOCAL: '1', VEACOM_TEST_MODE: '1' } });
  const errors = [], checks = [];
  const check = (name, detail) => { checks.push({ name, detail }); console.log(`PASS ${name}`); };
  try {
    const page = await desktop.firstWindow();
    await ignoreOutsideInput(desktop);
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.waitForFunction(() => window.__VEACOM_TEST__?.state().series.length >= 1, undefined, { timeout: 120_000 });
    const shot = name => page.screenshot({ path: path.join(output, `${name}.png`) });
    const panel = page.getByTestId('deformity-panel');
    const open = async description => {
      const s = await page.evaluate(() => window.__VEACOM_TEST__.state());
      const target = s.series.find(item => item.description === description);
      assert(target, `The study has ${description}.`);
      await page.evaluate(id => window.__VEACOM_TEST__.selectSeries(id), target.id);
      await page.waitForFunction(id => window.__VEACOM_TEST__.state().activeSeriesId === id && window.__VEACOM_TEST__.state().pendingLoads === 0, target.id, { timeout: 120_000 });
      await page.waitForFunction(() => document.querySelector('.viewport-cell.is-active canvas[data-renderer]'), undefined, { timeout: 60_000 });
      if (!(await panel.count())) await page.getByTestId('tool-assessment').click();
      await page.getByTestId('deformity-drawing').waitFor({ state: 'attached' });
      await page.waitForTimeout(300);
    };
    // A click on an image pixel point (DICOM image-relative), where the plan's drawing says it is on screen.
    const click = async point => {
      const map = JSON.parse(await page.getByTestId('deformity-drawing').getAttribute('data-to-screen'));
      const box = await page.locator('.viewport-cell.is-active svg[data-testid="annotation-overlay"]').boundingBox();
      const x = map[0][0] + point[0] * (map[1][0] - map[0][0]) + point[1] * (map[2][0] - map[0][0]);
      const y = map[0][1] + point[0] * (map[1][1] - map[0][1]) + point[1] * (map[2][1] - map[0][1]);
      await page.mouse.click(box.x + x, box.y + y);
    };
    const placeAll = async landmarks => {
      await panel.locator('[data-action="deformity-place-start"]').click();
      for (const name of ORDER) {
        await page.waitForFunction(expected => document.querySelector('[data-testid="deformity-next"]')?.dataset.landmark === expected, name, { timeout: 5_000 });
        for (const point of Array.isArray(landmarks[name][0]) ? landmarks[name] : [landmarks[name]]) await click(point);
      }
      await page.waitForFunction(() => !document.querySelector('[data-testid="deformity-next"]'), undefined, { timeout: 5_000 });
    };
    const values = selector => page.$$eval(`${selector} tbody tr`, rows => Object.fromEntries(rows.map(row => [row.dataset.valueKey, row.dataset.value === undefined ? null : Number(row.dataset.value)])));
    const near = (actual, expected, tolerance, what) => assert(actual !== null && Math.abs(actual - expected) <= tolerance, `${what}: ${actual} against ${expected} (±${tolerance})`);
    const compare = (measured, expected, lengthScale, label) => {
      for (const key of ANGLES) near(measured[key], expected[key], ANGLE, `${label} ${key}`);
      for (const key of LENGTHS) near(measured[key], expected[key] * lengthScale, LENGTH, `${label} ${key}`);
      near(measured.WBL, expected.WBL, 0.1, `${label} WBL %`);
    };
    const calibration = () => panel.getByTestId('deformity-calibration');

    // 1. Imager Pixel Spacing only: the detector plane, named; both legs in full; lengths magnified 1.1 times.
    const ips = manifest.series['ips-only'];
    await open(ips.description);
    assert.match(await calibration().textContent(), /Both sides · Detector plane, not corrected/);
    assert.equal(await calibration().getAttribute('data-state'), 'detector');
    assert.match(await page.locator('.viewport-cell.is-active .slice-detail').textContent(), /Detector plane/);
    const orientation = await page.locator('.viewport-cell.is-active .orientation-labels').textContent();
    assert.equal(orientation.replace(/\s/g, ''), 'RLSI', 'Patient Orientation L\\F gives R on the left edge and L on the right.');
    await shot('1-kit-open');
    const scale = ips.mmPerPixel / manifest.objectMm;
    const [right, left] = manifest.legs;
    await placeAll(right.landmarks);
    let measured = await values('.deformity-values:not(.deformity-compare)');
    compare(measured, right.expected, scale, 'Right leg');
    assert.match(await panel.locator('tr[data-value-key="femurLength"]').textContent(), /mm · detector plane/);
    const steps = await panel.locator('.deformity-steps li').evaluateAll(items => items.map(item => [item.dataset.step, item.dataset.result]));
    assert.deepEqual(steps, [['mad', 'varus'], ['femur', 'normal'], ['tibia', 'varus'], ['joint', 'normal'], ['subluxation', 'normal']]);
    near(Number(await panel.locator('[data-cora="tibia"]').getAttribute('data-magnitude')), right.cora.magnitude, ANGLE, 'Tibial CORA');
    await shot('2-right-leg-landmarks');
    check('Right leg: every angle within 0.1°, every length within 0.5 mm, at the detector plane', measured);
    check('Malalignment test: varus from the tibia; tibial CORA 8°', { steps });

    await panel.locator('[role="tab"]', { hasText: 'Left leg' }).click();
    await placeAll(left.landmarks);
    measured = await values('.deformity-values:not(.deformity-compare)');
    compare(measured, left.expected, scale, 'Left leg');
    const leftSteps = await panel.locator('.deformity-steps li').evaluateAll(items => items.map(item => [item.dataset.step, item.dataset.result]));
    assert.deepEqual(leftSteps, [['mad', 'valgus'], ['femur', 'valgus'], ['tibia', 'normal'], ['joint', 'normal'], ['subluxation', 'normal']]);
    check('Left leg: valgus from the femur, every value within tolerance', measured);

    // 2. The HTO of the right leg: cut, hinge, 8° opening towards valgus; measured again, fragment drawn moved.
    await panel.locator('[role="tab"]', { hasText: 'Right leg' }).click();
    await panel.locator('[data-action="deformity-bone"]', { hasText: 'Tibia' }).click();
    await panel.locator('[data-action="deformity-cut"]').click();
    await click(manifest.osteotomy.cut[0]); await click(manifest.osteotomy.cut[1]);
    await panel.getByTestId('deformity-osteotomy').waitFor();
    await panel.locator('[data-action="deformity-angle"]').fill(String(manifest.osteotomy.angle));
    await panel.getByTestId('deformity-planned').waitFor();
    await page.waitForTimeout(400);
    const planned = await values('[data-testid="deformity-planned"]');
    for (const key of ['MPTA', 'LDTA', 'JLCA', 'HKA']) near(planned[key], manifest.osteotomy.expected[key], ANGLE, `After HTO ${key}`);
    for (const key of ['MAD', 'limbLength']) near(planned[key], manifest.osteotomy.expected[key] * scale, LENGTH, `After HTO ${key}`);
    near(Number(await panel.getByTestId('deformity-wedge').getAttribute('data-wedge')), manifest.osteotomy.wedgeHeightMm * scale, LENGTH, 'Wedge height');
    assert.equal(await page.getByTestId('deformity-simulated').count(), 1, 'The pane says the picture is simulated.');
    const fragment = page.getByTestId('deformity-fragment');
    assert.equal(await fragment.count(), 1, 'The fragment is drawn as a layer.');
    await page.waitForTimeout(300);
    // The moved talus is bone where the fragment put it; where it was, the pane is dimmed.
    const pane = await page.locator('.viewport-cell.is-active [data-testid="dicom-viewport"]').boundingBox();
    const map = JSON.parse(await page.getByTestId('deformity-drawing').getAttribute('data-to-screen'));
    const toScreen = point => [map[0][0] + point[0] * (map[1][0] - map[0][0]) + point[1] * (map[2][0] - map[0][0]), map[0][1] + point[0] * (map[1][1] - map[0][1]) + point[1] * (map[2][1] - map[0][1])];
    const talus = [right.landmarks.ankleCentre[0], right.landmarks.ankleCentre[1] + 40];
    const hinge = manifest.osteotomy.hinge, turn = -(-1) * manifest.osteotomy.angle * Math.PI / 180; // the right leg's lateral side is −x
    const movedTalus = [hinge[0] + (talus[0] - hinge[0]) * Math.cos(turn) - (talus[1] - hinge[1]) * Math.sin(turn), hinge[1] + (talus[0] - hinge[0]) * Math.sin(turn) + (talus[1] - hinge[1]) * Math.cos(turn)];
    const picture = decodePng(await page.screenshot({ clip: pane }));
    const grey = point => {
      const [x, y] = toScreen(point).map(Math.round), scaleX = picture.width / pane.width;
      const offset = (Math.round(y * scaleX) * picture.width + Math.round(x * scaleX)) * 4;
      return picture.data[offset];
    };
    const movedGrey = grey(movedTalus), leftBehind = grey(talus);
    assert(movedGrey > 120, `The moved talus shows bone (${movedGrey}).`);
    assert(leftBehind < movedGrey * 0.6, `Where the talus was is dimmed (${leftBehind} against ${movedGrey}).`);
    await shot('3-hto-simulated');
    check('Opening wedge HTO 8°: MPTA, LDTA, HKA, MAD, limb length and wedge height measured again; the fragment drawn moved', planned);

    // Undo takes the angle back and Redo restores it, through the viewer's own ⌘Z.
    const undoKeys = process.platform === 'darwin' ? 'Meta+z' : 'Control+z', redoKeys = process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+Shift+z';
    await page.locator('.viewport-cell.is-active [data-testid="dicom-viewport"]').focus();
    await page.keyboard.press(undoKeys);
    await page.waitForFunction(() => Number(document.querySelector('[data-action="deformity-angle"]')?.value) !== 8, undefined, { timeout: 5_000 });
    await page.keyboard.press(redoKeys);
    await page.waitForFunction(() => Number(document.querySelector('[data-action="deformity-angle"]')?.value) === 8, undefined, { timeout: 5_000 });
    check('Undo and Redo take the plan\'s last step back and forth');

    // Solve for MAD 0.
    await panel.locator('[data-action="deformity-solve-mad"]').click();
    await page.waitForTimeout(200);
    near((await values('[data-testid="deformity-planned"]')).MAD, 0, 0.05, 'Solved MAD');
    check('Solving the angle for MAD 0 brings the weight-bearing line through the knee centre');

    // 3. Save the plan, open it again on the same film, and save the report: files only where the reader chose.
    const planPath = path.join(output, 'plan.json'), reportPath = path.join(output, 'report.png');
    await desktop.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, planPath);
    const before = await values('.deformity-values:not(.deformity-compare)');
    await panel.locator('[data-action="deformity-save"]').click();
    await page.waitForFunction(() => /Plan saved/.test(document.querySelector('[data-testid="deformity-status"]')?.textContent ?? ''), undefined, { timeout: 10_000 });
    const saved = JSON.parse(await fs.readFile(planPath, 'utf8'));
    assert.equal(saved.schema, 'veacom.deformity-plan'); assert.equal(saved.version, 1);
    assert.equal(saved.plans.length, 2);
    const label = saved.plans[0].landmarks.find(item => item.name === 'kneeCentre');
    assert.deepEqual(Object.keys(label).sort(), ['confidence', 'name', 'points', 'provenance', 'side', 'software', 'spacing', 'suggestionShown']);
    assert.equal(label.confidence, 'manual'); assert.equal(label.spacing, 'detector'); assert.equal(label.side, 'R');
    assert(Math.hypot(label.points[0][0] - right.landmarks.kneeCentre[0], label.points[0][1] - right.landmarks.kneeCentre[1]) < 0.05, 'The knee centre is stored in image pixels where it was clicked.');
    assert.doesNotMatch(JSON.stringify(saved), /SYNTHETIC|LONGLEG|2\.25\./, 'The plan names no patient and no UID.');
    // Clearing the right leg's landmarks, then opening the file, brings them back.
    await panel.locator('[data-action="deformity-plan-add"]').click();
    await panel.locator('[data-action="deformity-open-file"]').setInputFiles(planPath);
    await page.waitForFunction(() => /Plan opened/.test(document.querySelector('[data-testid="deformity-status"]')?.textContent ?? ''), undefined, { timeout: 10_000 });
    await panel.locator('[role="tab"]', { hasText: 'Right leg' }).click();
    const reopened = await values('.deformity-values:not(.deformity-compare)');
    for (const key of [...ANGLES, ...LENGTHS]) near(reopened[key], before[key], 1e-6, `Reopened ${key}`);
    await desktop.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, reportPath);
    await panel.locator('[data-action="deformity-report"]').click();
    await page.waitForFunction(() => /Report saved/.test(document.querySelector('[data-testid="deformity-status"]')?.textContent ?? ''), undefined, { timeout: 30_000 });
    const report = decodePng(await fs.readFile(reportPath));
    assert.deepEqual([report.width, report.height], [2480, 3508]);
    check('The plan saves as versioned JSON with image-pixel labels and no identifiers, opens again identically, and the report saves as an A4 PNG', { planPath, reportPath });

    // 4. The other spacing variants: the calibration each names, and the femur's length it gives.
    for (const [name, variant] of Object.entries(manifest.series)) {
      if (name === 'ips-only' || name === 'mirrored' || name === 'no-orientation') continue;
      await open(variant.description);
      assert.equal(await calibration().getAttribute('data-state'), variant.state === 'pixels' ? 'none' : variant.state, `${name} names its calibration.`);
      await panel.locator('[data-landmark="femoralHeadContour"] [data-action="deformity-place"]').click();
      for (const point of right.landmarks.femoralHeadContour) await click(point);
      await panel.locator('[data-landmark="kneeCentre"] [data-action="deformity-place"]').click();
      await click(right.landmarks.kneeCentre);
      await panel.locator('[data-action="deformity-place-stop"]').click().catch(() => {});
      const femur = (await values('.deformity-values:not(.deformity-compare)')).femurLength;
      if (variant.mmPerPixel) near(femur, right.expected.femurLength * variant.mmPerPixel / manifest.objectMm, LENGTH, `${name} femur length`);
      else near(femur, right.expected.femurLength / manifest.objectMm, 2, `${name} femur length in pixels`);
      check(`${variant.description}: ${variant.state}, femur ${femur.toFixed(1)}`);
    }

    // 5. No spacing: the ball calibrates the film at the bones' depth; lengths become true millimetres.
    await open(manifest.series.none.description);
    await panel.locator('[data-action="deformity-ball"]').click();
    for (const point of manifest.ball.edge) await click(point);
    await panel.locator('[data-action="deformity-ball"]').click();
    near(Number(await panel.getByTestId('deformity-marker-fit').getAttribute('data-mm-per-pixel')), manifest.objectMm, 0.0005, 'Ball mm per pixel');
    await panel.locator('[data-action="deformity-ball-depth"]').check();
    await panel.locator('[data-action="deformity-calibrate"]').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="deformity-calibration"]')?.dataset.state === 'manual', undefined, { timeout: 5_000 });
    assert.match(await calibration().textContent(), /Ball 25\.0 mm/);
    near((await values('.deformity-values:not(.deformity-compare)')).femurLength, right.expected.femurLength, LENGTH, 'Ball-calibrated femur length');
    assert.match(await panel.locator('tr[data-value-key="femurLength"]').textContent(), /ball 25\.0 mm/);
    await shot('4-ball-calibration');
    check('A 25.0 mm ball calibrates the film without spacing; the femur measures its true 440 mm');

    // 6. The mirrored film (Patient Orientation R\F): the same angles, the same names.
    await open(manifest.series.mirrored.description);
    assert.equal((await page.locator('.viewport-cell.is-active .orientation-labels').textContent()).replace(/\s/g, ''), 'LRSI');
    await placeAll(right.mirroredLandmarks);
    compare(await values('.deformity-values:not(.deformity-compare)'), right.expected, scale, 'Mirrored right leg');
    check('On the mirrored film the right leg gives the same angles with the same names');

    // 7. No Patient Orientation: medial and lateral wait for the reader to say where the patient's right is.
    await open(manifest.series['no-orientation'].description);
    assert.equal(await panel.locator('[data-action="deformity-patient-right"]').count(), 2);
    await placeAll(right.landmarks);
    assert.equal((await values('.deformity-values:not(.deformity-compare)')).MPTA, null, 'MPTA waits for the side.');
    assert.match(await panel.locator('tr[data-value-key="MPTA"]').textContent(), /Needs the patient's right/);
    await panel.locator('[data-action="deformity-patient-right"]', { hasText: 'Image left' }).click();
    compare(await values('.deformity-values:not(.deformity-compare)'), right.expected, scale, 'Right leg once the side is given');
    await shot('5-no-orientation');
    check('Without Patient Orientation the kit asks where the patient\'s right is before any medial or lateral value');

    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(output, 'deformity-plan.json'), JSON.stringify({ checks }, null, 2) + '\n');
    console.log(`All ${checks.length} deformity plan checks passed.`);
  } finally {
    await closeDesktop(desktop);
    await fs.rm(userData, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
