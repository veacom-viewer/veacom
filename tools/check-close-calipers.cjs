// Desktop check of the CLOSE calipers on the synthetic sinus CT of tools/fixtures/make-sinus-study.mjs. Each caliper is
// started from the pre-operative checklist, measured by clicking the fixture's landmarks on the plane it needs (a point
// clicked in the air moves onto the bone), and writes its answer and value into the side it measured. Moving a point
// measures again and undo takes it back; a caliper is unavailable on the wrong plane and says why; Esc ends one; "Copy
// for the report" gives every value with its side and slice. Screenshots in English and Turkish.
// usage: node tools/check-close-calipers.cjs SINUS_STUDY [OUTPUT_DIR]
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const os = require('node:os');
const { ignoreOutsideInput } = require('./lib/outside-input.cjs');

async function main() {
  const study = path.resolve(process.argv[2]);
  const output = path.resolve(process.argv[3] || 'test-results/close-calipers');
  const manifest = JSON.parse(await fs.readFile(path.join(study, 'manifest.json'), 'utf8'));
  assert.equal(manifest.generator, 'veacom-sinus-v1', 'Run on the study made by tools/fixtures/make-sinus-study.mjs.');
  const { grid, landmarks, expected } = manifest;
  await fs.mkdir(output, { recursive: true });
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'veacom-close-calipers-'));
  const desktop = await electron.launch({ args: [path.resolve(__dirname, '..'), '--study', study], timeout: 90_000,
    env: { ...process.env, VEACOM_USER_DATA: userData, VEACOM_LOCALE: 'en', VEACOM_TELEMETRY_CONSENT: 'denied', VEACOM_USAGE_CHECK_LOCAL: '1', VEACOM_TEST_MODE: '1' } });
  const errors = [], checks = [];
  let page;
  const check = (name, detail) => { checks.push({ name, detail }); console.log(`PASS ${name}`); };
  try {
    page = await desktop.firstWindow();
    // Keep the person at the machine from typing into the window or clicking it, and keep it drawing while covered.
    await ignoreOutsideInput(desktop);
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.waitForFunction(() => window.__VEACOM_TEST__?.state().fullVolumeLoaded && window.__VEACOM_TEST__.state().pendingLoads === 0, undefined, { timeout: 120_000 });
    // The report goes to a clipboard in memory, so the check neither reads nor changes the machine's own.
    await desktop.evaluate(({ clipboard }) => {
      const memory = { text: '' };
      clipboard.writeText = text => { memory.text = String(text); };
      clipboard.readText = () => memory.text;
    });
    const settled = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const pane = page.locator('.viewport-cell.is-active [data-testid="dicom-viewport"]');
    const checklist = page.getByTestId('preop-checklist');
    await page.getByTestId('tool-assessment').click();
    await checklist.waitFor();
    assert.equal(await checklist.locator('.preop-kind-name').textContent(), 'Sinus CT · before surgery', 'The sinus CT opens the CLOSE checklist.');

    // A plane through the fixture: coronal at y, or sagittal at x; the image fills the pane, centred.
    const show = async (plane, at) => {
      const slice = plane === 'coronal' ? Math.round((at - grid.origin[1]) / grid.spacing) : Math.round((grid.origin[0] + (grid.dimensions[0] - 1) * grid.spacing - at) / grid.spacing);
      await page.evaluate(view => window.__VEACOM_TEST__.setView(view), { plane, mode: 'mpr', slice, oblique: [0, 0], zoom: 1, pan: [0, 0], rotation: 0, flipX: false, flipY: false });
      await page.waitForFunction(({ plane, slice }) => {
        const canvas = document.querySelector('.viewport-cell.is-active canvas[data-renderer]');
        return canvas?.dataset.plane === plane && canvas.dataset.slice === String(slice) && canvas.dataset.mode === 'mpr';
      }, { plane, slice });
      await settled();
      return plane;
    };
    /** The screen point of a landmark (x or y, then z, in patient mm) on the plane shown. */
    const screen = async (plane, [across, z]) => {
      const box = await pane.boundingBox(), axis = plane === 'coronal' ? 0 : 1;
      const centre = axis => grid.origin[axis] + (grid.dimensions[axis] - 1) * grid.spacing / 2;
      const scale = Math.min(box.width / (grid.dimensions[axis] * grid.spacing), box.height / (grid.dimensions[2] * grid.spacing));
      return [box.x + box.width / 2 + (across - centre(axis)) * scale, box.y + box.height / 2 - (z - centre(2)) * scale];
    };
    const side = (item, which) => checklist.locator(`[data-item="${item}"] [data-side="${which}"]`);
    const caliperButton = (item, which) => side(item, which).locator('[data-action="checklist-caliper"]');
    const answer = async (item, which) => {
      const chosen = side(item, which).locator('[data-action="checklist-answer"][aria-checked="true"]');
      return await chosen.count() ? chosen.textContent() : null;
    };
    const value = async (item, which) => {
      const seen = side(item, which).locator('.preop-seen');
      return await seen.count() ? (await seen.textContent()).trim() : null;
    };
    const numbers = text => [...text.matchAll(/-?\d+(?:\.\d+)?/g)].map(match => Number(match[0]));
    const near = (actual, wanted, tolerance, what) => assert(Math.abs(actual - wanted) <= tolerance, `${what}: ${actual}, not ${wanted} ± ${tolerance}`);
    /** Starts the caliper of an item's side and clicks its points; the record shows on `recorded` (the septum's side
     * follows the septum). */
    const measure = async (item, which, plane, points, recorded = which) => {
      await caliperButton(item, which).click();
      assert.equal(await caliperButton(item, which).getAttribute('aria-pressed'), 'true', `${item} ${which}: the caliper is under way.`);
      const hint = page.getByTestId('caliper-hint');
      await hint.waitFor();
      for (const [index, point] of points.entries()) {
        assert.match(await hint.textContent(), new RegExp(`\\(${index + 1}/${points.length}\\)`), `${item} ${which}: the hint asks for point ${index + 1}.`);
        await page.mouse.click(...await screen(plane, point));
        await page.waitForTimeout(150);
      }
      await hint.waitFor({ state: 'detached' });
      await page.waitForFunction(({ item, recorded }) => document.querySelector(`[data-item="${item}"] [data-side="${recorded}"] .preop-seen`), { item, recorded });
      return value(item, recorded);
    };

    // Keros and Gera, on the coronal plane through the olfactory fossae.
    const coronal = await show('coronal', landmarks.keros.y);
    for (const which of ['right', 'left']) {
      const text = await measure('keros', which, coronal, landmarks.keros[which]), [depth, gera] = numbers(text), wanted = expected.keros[which];
      near(depth, wanted.depth, 0.15, `Keros ${which} depth`);
      near(gera, wanted.gera, 1.5, `Gera ${which}`);
      assert.equal(await answer('keros', which), wanted.type, `Keros ${which}: type ${wanted.type} is marked.`);
      assert.equal(await side('keros', which).locator('.preop-limit').count(), wanted.nearLimit ? 1 : 0, `Keros ${which}: near a type limit only at ${wanted.depth} mm.`);
    }
    const labels = await pane.locator('[data-annotation-id] .annotation-label').allTextContents();
    assert(labels.some(label => /Keros right 3\.2 mm/.test(label)) && labels.some(label => /Keros left 6\.0 mm/.test(label)), `The drawings name their values: ${labels.join(' | ')}`);
    check('Keros and Gera: each side measured on the coronal plane, its type marked and a value near a type limit said so', { right: await value('keros', 'right'), left: await value('keros', 'left') });

    // Moving the lamella's top 1 mm up measures again: 4.2 mm is type 2, and the answer follows the drawing it came from.
    // Undo puts the drawing and the answer back.
    const [topX, topZ] = landmarks.keros.right[2];
    const from = await screen(coronal, [topX, topZ]), to = await screen(coronal, [topX, topZ + 1]);
    await page.mouse.move(...from); await page.mouse.down(); await page.mouse.move(...to, { steps: 6 }); await page.mouse.up();
    await page.waitForFunction(() => (document.querySelector('[data-item="keros"] [data-side="right"] .preop-seen')?.textContent ?? '').startsWith('4.2 mm'));
    assert.equal(await answer('keros', 'right'), '2', 'The edited caliper gives type 2.');
    await pane.focus();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
    await page.waitForFunction(() => (document.querySelector('[data-item="keros"] [data-side="right"] .preop-seen')?.textContent ?? '').startsWith('3.2 mm'));
    assert.equal(await answer('keros', 'right'), '1', 'Undo brings back the first measurement and its answer.');
    check('Moving a caliper point measures again and its answer follows; undo takes both back');

    // The anterior ethmoidal artery: in the right roof (type 1: no answer, a dehiscence is the reader's call) and 3 mm
    // below the left one, whose roof point was clicked in the air and moved onto the bone.
    await show('coronal', landmarks.aea.y);
    for (const which of ['right', 'left']) {
      const text = await measure('ethmoid-artery', which, coronal, [landmarks.aea[which].canal, landmarks.aea[which].roof]), wanted = expected.aea[which];
      near(numbers(text)[0], wanted.distance, 0.2, `AEA ${which}`);
      assert.equal(await answer('ethmoid-artery', which), wanted.answer === 'yes' ? 'Yes' : null, `AEA ${which}: answer.`);
    }
    check('Ethmoid artery: its distance below the roof, yes from 2 mm, nothing marked at the skull base; a roof point moves onto the bone', { right: await value('ethmoid-artery', 'right'), left: await value('ethmoid-artery', 'left') });

    // The septum, started from the right side, bows to the left: the left side records it.
    await show('coronal', landmarks.septum.y);
    const septum = await measure('septum', 'right', coronal, [landmarks.septum.crest, landmarks.septum.crista, landmarks.septum.deviated], expected.septum.side);
    near(numbers(septum)[0], expected.septum.angle, 0.5, 'Septal angle');
    assert.equal(await answer('septum', 'left'), 'Yes', 'The side the septum bows to is marked.');
    assert.equal(await answer('septum', 'right'), null, 'The other side is left to the reader.');
    // A caliper item's side can still be noted by hand: the slice on screen.
    await side('septum', 'right').locator('[data-action="checklist-note"]').click();
    assert.match(await value('septum', 'right'), /^Slice \d+\/\d+$/, 'The right side has its slice noted.');
    check('Septal angle: measured at the crista galli and recorded on the side the septum bows to; the other side noted by hand', { septum });

    // The sella lines on the midsagittal plane; there the coronal calipers say why they cannot measure.
    const sagittal = await show('sagittal', landmarks.sella.x);
    assert.equal(await caliperButton('keros', 'right').getAttribute('aria-disabled'), 'true', 'Keros cannot be measured on a sagittal plane.');
    assert.equal(await caliperButton('keros', 'right').getAttribute('aria-description'), 'Show an upright coronal plane to measure');
    const sella = await measure('pneumatisation', 'both', sagittal, [landmarks.sella.tuberculum, landmarks.sella.dorsum, landmarks.sella.wall]);
    assert.match(sella, /^\d+\.\d mm behind tuberculum line$/);
    assert.equal(await answer('pneumatisation', 'both'), 'Sellar', 'A sinus wall between the lines is sellar.');
    await page.screenshot({ path: path.join(output, '2-sella-en.png') });
    check('Sella lines: the sinus wall placed between the tuberculum and dorsum lines on the midsagittal plane; a coronal caliper says it needs a coronal plane', { sella });

    // Esc ends a caliper before it is drawn, and the left button gets its tool back.
    await show('coronal', landmarks.keros.y);
    await caliperButton('keros', 'right').click();
    await page.getByTestId('caliper-hint').waitFor();
    await page.keyboard.press('Escape');
    await page.getByTestId('caliper-hint').waitFor({ state: 'detached' });
    assert.equal(await caliperButton('keros', 'right').getAttribute('aria-pressed'), 'false');
    assert.equal(await page.getByTestId('tool-quick-window').getAttribute('aria-pressed'), 'true', 'The left button has its window tool back.');
    check('Esc ends a caliper under way and gives the left button its tool back');

    // Copy for the report: each side with its answer, its measurement and the slice.
    await page.mouse.move(5, 5);
    await page.screenshot({ path: path.join(output, '1-keros-en.png') });
    const copied = async label => {
      await checklist.locator('[data-action="checklist-copy"]').click();
      await checklist.locator('[data-action="checklist-copy"]').getByText(label).waitFor();
      return desktop.evaluate(({ clipboard }) => clipboard.readText());
    };
    const report = await copied('Copied');
    for (const part of [/Cribriform plate \(Keros\): Right 1 \(3\.2 mm, type 1, near limit; Gera 70\.0°, class II; slice \d+\/\d+\), Left 2 \(6\.0 mm, type 2; Gera 40\.0°, class III; slice \d+\/\d+\); right–left difference 2\.8 mm/,
      /Anterior ethmoid artery: Right – \(1\.0 mm below roof, type 1; slice \d+\/\d+\), Left Yes \(2\.8 mm below roof, type 2; slice \d+\/\d+\)/,
      /Sphenoid pneumatisation: Sellar \(\d+\.\d mm behind tuberculum line; slice \d+\/\d+\)/,
      /Septal deviation \/ spur: Right – \(slice \d+\/\d+\), Left Yes \(12\.6°, moderate; slice \d+\/\d+\)/]) assert.match(report, part);
    check('Copy for the report gives every caliper value with its side and slice', { report });

    // The same in Turkish.
    await page.getByTestId('tool-language').press('Enter');
    await page.getByTestId('language-tr').press('Enter');
    await checklist.getByText('Ameliyat öncesi kontrol').waitFor();
    assert.equal(await side('keros', 'right').locator('.preop-limit').textContent(), 'sınırda');
    const turkish = await copied('Kopyalandı');
    assert.match(turkish, /Kribriform plate \(Keros\): Sağ 1 \(3\.2 mm, tip 1, sınırda; Gera 70\.0°, sınıf II; kesit \d+\/\d+\)/);
    assert.match(turkish, /sağ–sol fark 2\.8 mm/);
    await page.screenshot({ path: path.join(output, '1-keros-tr.png') });
    await show('sagittal', landmarks.sella.x);
    await page.mouse.move(5, 5);
    await page.screenshot({ path: path.join(output, '2-sella-tr.png') });
    check('In Turkish: the checklist, its limit word and the report', { report: turkish });

    assert.deepEqual(errors, [], 'No page errors.');
    await fs.writeFile(path.join(output, 'close-calipers-checks.json'), JSON.stringify({ checks, errors }, null, 2));
    console.log(`All ${checks.length} CLOSE caliper checks passed.`);
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    await fs.writeFile(path.join(output, 'close-calipers-checks.json'), JSON.stringify({ checks, errors, failure: String(error.stack || error) }, null, 2));
    throw error;
  } finally {
    await desktop.close().catch(() => {});
    await fs.rm(userData, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
