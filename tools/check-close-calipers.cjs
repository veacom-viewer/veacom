// Desktop check of the CLOSE calipers on the synthetic sinus CT of tools/fixtures/make-sinus-study.mjs. Each caliper is
// started from the pre-operative checklist, measured by clicking the fixture's landmarks on the plane it needs (a point
// clicked in the air moves onto the bone), and writes its answer and value into the side it measured. Moving a point
// measures again and undo takes it back. Started off its plane, a caliper turns its pane to that plane and the bone
// window and says so with Undo. Esc ends one; "Copy for the report" gives every value with its side and slice, and the
// theatre card prints them on one A4 page (the print dialog is replaced by Electron's printToPDF of the same page).
// Screenshots in English and Turkish.
// usage: node tools/check-close-calipers.cjs SINUS_STUDY [OUTPUT_DIR]
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { ignoreOutsideInput } = require('./lib/outside-input.cjs');
const { closeDesktop } = require('./lib/close-desktop.cjs');

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
    // An item's notes, measurements and caliper are in the bar under the list, for the row selected.
    const bar = checklist.getByTestId('checklist-detail');
    const select = async item => {
      if (await bar.getAttribute('data-detail-item') !== item) await checklist.locator(`[data-item="${item}"] [data-action="checklist-select"]`).click();
      await checklist.locator(`[data-testid="checklist-detail"][data-detail-item="${item}"]`).waitFor();
    };
    const detail = (item, which) => checklist.locator(`[data-testid="checklist-detail"][data-detail-item="${item}"] [data-detail-side="${which}"]`);
    const caliperButton = (item, which) => detail(item, which).locator('[data-action="checklist-caliper"]');
    const answer = async (item, which) => {
      const chosen = side(item, which).locator('[data-action="checklist-answer"][aria-checked="true"]');
      return await chosen.count() ? chosen.textContent() : null;
    };
    const value = async (item, which) => {
      await select(item);
      const seen = detail(item, which).locator('.preop-seen');
      return await seen.count() ? (await seen.textContent()).trim() : null;
    };
    const numbers = text => [...text.matchAll(/-?\d+(?:\.\d+)?/g)].map(match => Number(match[0]));
    const near = (actual, wanted, tolerance, what) => assert(Math.abs(actual - wanted) <= tolerance, `${what}: ${actual}, not ${wanted} ± ${tolerance}`);
    /** Starts the caliper of an item's side and clicks its points; the record shows on `recorded` (the septum's side
     * follows the septum). */
    const measure = async (item, which, plane, points, recorded = which) => {
      await select(item);
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
      await page.waitForFunction(({ item, recorded }) => document.querySelector(`[data-detail-item="${item}"] [data-detail-side="${recorded}"] .preop-seen`), { item, recorded });
      return value(item, recorded);
    };

    // Keros and Gera, on the coronal plane through the olfactory fossae.
    const coronal = await show('coronal', landmarks.keros.y);
    for (const which of ['right', 'left']) {
      const text = await measure('keros', which, coronal, landmarks.keros[which]), [depth, gera] = numbers(text), wanted = expected.keros[which];
      near(depth, wanted.depth, 0.15, `Keros ${which} depth`);
      near(gera, wanted.gera, 1.5, `Gera ${which}`);
      assert.equal(await answer('keros', which), wanted.type, `Keros ${which}: type ${wanted.type} is marked.`);
      assert.equal(await detail('keros', which).locator('.preop-limit').count(), wanted.nearLimit ? 1 : 0, `Keros ${which}: near a type limit only at ${wanted.depth} mm.`);
    }
    const labels = await pane.locator('[data-annotation-id] .annotation-label').allTextContents();
    assert(labels.some(label => /Keros right 3\.2 mm/.test(label)) && labels.some(label => /Keros left 6\.0 mm/.test(label)), `The drawings name their values: ${labels.join(' | ')}`);
    check('Keros and Gera: each side measured on the coronal plane, its type marked and a value near a type limit said so', { right: await value('keros', 'right'), left: await value('keros', 'left') });

    // Moving the lamella's top 1 mm up measures again: 4.2 mm is type 2, and the answer follows the drawing it came from.
    // Undo puts the drawing and the answer back.
    const [topX, topZ] = landmarks.keros.right[2];
    const from = await screen(coronal, [topX, topZ]), to = await screen(coronal, [topX, topZ + 1]);
    await page.mouse.move(...from); await page.mouse.down(); await page.mouse.move(...to, { steps: 6 }); await page.mouse.up();
    await page.waitForFunction(() => (document.querySelector('[data-detail-item="keros"] [data-detail-side="right"] .preop-seen')?.textContent ?? '').startsWith('4.2 mm'));
    assert.equal(await answer('keros', 'right'), '2', 'The edited caliper gives type 2.');
    await pane.focus();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
    await page.waitForFunction(() => (document.querySelector('[data-detail-item="keros"] [data-detail-side="right"] .preop-seen')?.textContent ?? '').startsWith('3.2 mm'));
    assert.equal(await answer('keros', 'right'), '1', 'Undo brings back the first measurement and its answer.');
    check('Moving a caliper point measures again and its answer follows; undo takes both back');

    // Clear drops the records, so a drawing moved meanwhile writes nothing; ⌘Z in the checklist then undoes the Clear,
    // not the move on the image, and the record it brings back measures the moved drawing again.
    const undoKeys = process.platform === 'darwin' ? 'Meta+z' : 'Control+z';
    await checklist.locator('[data-action="checklist-clear"]').click();
    assert.equal(await value('keros', 'right'), null, 'Clear removes the measurements from the checklist.');
    await page.mouse.move(...from); await page.mouse.down(); await page.mouse.move(...to, { steps: 6 }); await page.mouse.up();
    await page.waitForTimeout(300);
    assert.equal(await value('keros', 'right'), null, 'A drawing whose record was cleared does not write into the checklist.');
    await checklist.locator('[data-action="checklist-clear"]').focus();
    await page.keyboard.press(undoKeys);
    await page.waitForFunction(() => (document.querySelector('[data-detail-item="keros"] [data-detail-side="right"] .preop-seen')?.textContent ?? '').startsWith('4.2 mm'));
    assert.equal(await answer('keros', 'right'), '2', 'The record came back measured again, and its answer follows.');
    assert.match(await value('keros', 'left'), /^6\.0 mm/, 'The other side came back too.');
    await pane.focus();
    await page.keyboard.press(undoKeys);
    await page.waitForFunction(() => (document.querySelector('[data-detail-item="keros"] [data-detail-side="right"] .preop-seen')?.textContent ?? '').startsWith('3.2 mm'));
    assert.equal(await answer('keros', 'right'), '1', '⌘Z on the image undoes the move.');
    check('⌘Z in the checklist undoes Clear, not the image; a drawing moved meanwhile measures again');

    // A calibration changes what the calipers measure, as it changes their labels: a 10 mm line called 20 mm doubles
    // Keros, so the right side's 3.2 mm (type 1) reads 6.4 mm (type 2) in the checklist; removing it reads 3.2 mm again,
    // and takes down the notice that says the series is calibrated. The left side's drawing is deleted first: its record
    // keeps its points, and the calibration measures it again too.
    const calibratedNotice = page.locator('[data-testid="notice"][data-code="notice.calibrated"]');
    const settledValue = (which, start) => page.waitForFunction(([which, start]) => (document.querySelector(`[data-detail-item="keros"] [data-detail-side="${which}"] .preop-seen`)?.textContent ?? '').startsWith(start), [which, start]);
    await detail('keros', 'left').locator('[data-action="checklist-go"]').click();
    await pane.locator('[data-annotation-id][data-selected]').waitFor();
    await pane.focus(); await page.keyboard.press('Delete');
    await page.waitForFunction(() => ![...document.querySelectorAll('.viewport-cell.is-active [data-annotation-id] .annotation-label')].some(label => label.textContent.includes('Keros left')));
    await settledValue('left', '6.0 mm');
    await pane.focus(); await page.keyboard.press('l');
    const lineFrom = await screen(coronal, [-20, -10]), lineTo = await screen(coronal, [-10, -10]);
    await page.mouse.move(...lineFrom); await page.mouse.down(); await page.mouse.move(...lineTo, { steps: 6 }); await page.mouse.up();
    await page.keyboard.press('w');
    await page.getByTestId('tool-measure-menu').click();
    await page.locator('[data-action="toolbar-units-calibration"]').click();
    await page.locator('[data-action="calibration-length"]').fill('20');
    // Cleared before the calibration, the records come back with ⌘Z in the checklist at the calibrated scale.
    await checklist.locator('[data-action="checklist-clear"]').click();
    await page.locator('[data-action="calibrate"]').click();
    assert.equal(await value('keros', 'right'), null);
    await checklist.locator('[data-action="checklist-clear"]').focus();
    await page.keyboard.press(undoKeys);
    await settledValue('right', '6.4 mm');
    assert.equal(await answer('keros', 'right'), '2', 'The answer follows the calibrated depth.');
    await settledValue('left', '12.0 mm');
    assert.equal(await calibratedNotice.count(), 1, 'Calibrating says so.');
    await page.locator('[data-action="calibration-remove"]').click();
    await settledValue('right', '3.2 mm');
    assert.equal(await answer('keros', 'right'), '1');
    await settledValue('left', '6.0 mm');
    assert.equal(await calibratedNotice.count(), 0, 'Removing the calibration takes down the notice that says the series is calibrated.');
    await page.getByTestId('tool-inspector').click();
    await page.locator('.inspector').waitFor({ state: 'hidden' });
    await pane.focus();
    // Undo takes the calibration line away, then brings the left drawing back.
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
    await page.waitForFunction(() => [...document.querySelectorAll('.viewport-cell.is-active [data-annotation-id] .annotation-label')].some(label => label.textContent.includes('Keros left 6.0 mm')));
    check('A calibration changes the caliper values and answers in the checklist, a deleted drawing\'s record and a cleared record brought back too, and removing it changes them back');

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
    await select('septum');
    await detail('septum', 'right').locator('[data-action="checklist-note"]').click();
    assert.match(await value('septum', 'right'), /^Slice \d+\/\d+$/, 'The right side has its slice noted.');
    // A slice note on the measured side replaces the measurement there, says so, and Undo brings the measurement back.
    await detail('septum', 'left').locator('[data-action="checklist-note"]').click();
    assert.match(await value('septum', 'left'), /^Slice \d+\/\d+$/);
    assert.match(await checklist.locator('.preop-undo').textContent(), /^Septal deviation \/ spur · Left: the slice note replaced the measurement\.Undo$/);
    await page.mouse.move(5, 5);
    await page.screenshot({ path: path.join(output, '5-undo-en.png') });
    await checklist.locator('[data-action="checklist-undo"]').click();
    assert.equal(await value('septum', 'left'), septum, 'Undo brings the measurement back.');
    assert.equal(await answer('septum', 'left'), 'Yes');
    check('Septal angle: measured at the crista galli and recorded on the side the septum bows to; the other side noted by hand; a note that replaces the measurement can be undone', { septum });

    // The sella lines on the midsagittal plane.
    const sagittal = await show('sagittal', landmarks.sella.x);
    const sella = await measure('pneumatisation', 'both', sagittal, [landmarks.sella.tuberculum, landmarks.sella.dorsum, landmarks.sella.wall]);
    assert.match(sella, /^\d+\.\d mm behind tuberculum line$/);
    assert.equal(await answer('pneumatisation', 'both'), 'Sellar', 'A sinus wall between the lines is sellar.');
    await page.screenshot({ path: path.join(output, '2-sella-en.png') });
    check('Sella lines: the sinus wall placed between the tuberculum and dorsum lines on the midsagittal plane', { sella });

    // From the sagittal plane in a soft-tissue window, a coronal caliper sets its pane up first: the coronal plane through
    // the pane's middle and the bone window, said in the pane with Undo. Undo puts the pane back and ends the caliper; once
    // a point is placed the note goes, and ending the caliper keeps the pane as it is.
    const view = () => page.evaluate(() => window.__VEACOM_TEST__.state().view);
    const shownPlane = plane => page.waitForFunction(plane => document.querySelector('.viewport-cell.is-active canvas[data-renderer]')?.dataset.plane === plane, plane);
    const softWindow = async () => {
      await page.evaluate(() => window.__VEACOM_TEST__.setView({ windowWidth: 400, windowCenter: 40 }));
      await page.waitForFunction(() => window.__VEACOM_TEST__.state().view.windowWidth === 400);
    };
    const setUp = page.getByTestId('caliper-setup'), sagittalSlice = (await view()).slice;
    await softWindow();
    // A point picked over the olfactory fossae: the coronal plane goes through it.
    await page.evaluate(() => window.__VEACOM_TEST__.setTool('crosshair'));
    await page.mouse.click(...await screen('sagittal', [landmarks.keros.y, landmarks.keros.right[1][1]]));
    await page.evaluate(() => window.__VEACOM_TEST__.setTool('window'));
    const before = await view();
    await select('keros');
    assert.equal(await caliperButton('keros', 'right').getAttribute('aria-disabled'), null, 'Keros starts from a sagittal plane too.');
    assert.equal(await caliperButton('keros', 'right').getAttribute('data-tooltip-hint'), 'Measured on a coronal plane, in a bone window');
    await caliperButton('keros', 'right').click();
    await setUp.waitFor();
    assert.equal(await setUp.locator('span').textContent(), 'Coronal plane and bone window for Keros and Gera');
    await shownPlane('coronal');
    const turned = await view();
    assert.deepEqual([turned.mode, turned.slice, turned.windowWidth, turned.windowCenter], ['mpr', Math.round((landmarks.keros.y - grid.origin[1]) / grid.spacing), 1500, 300],
      'The pane shows the coronal plane through the picked point, in the bone window.');
    await page.mouse.move(5, 5);
    await page.screenshot({ path: path.join(output, '3-set-up-en.png') });
    await setUp.getByRole('button').click();
    await page.getByTestId('caliper-hint').waitFor({ state: 'detached' });
    await shownPlane('sagittal');
    const back = await view();
    assert.deepEqual([back.plane, back.slice, back.windowWidth, back.windowCenter], ['sagittal', sagittalSlice, 400, 40], 'Undo puts the pane back as it was.');
    assert.deepEqual(back, before, 'Undo puts the whole view back.');
    assert.equal(await caliperButton('keros', 'right').getAttribute('aria-pressed'), 'false', 'Undo ends the caliper.');
    await caliperButton('keros', 'right').click();
    await setUp.waitFor();
    await page.mouse.click(...await screen('coronal', landmarks.keros.right[0]));
    await setUp.waitFor({ state: 'detached' });
    await page.keyboard.press('Escape'); // the point placed
    await page.keyboard.press('Escape'); // the caliper
    await page.getByTestId('caliper-hint').waitFor({ state: 'detached' });
    assert.deepEqual([(await view()).plane, (await view()).windowWidth], ['coronal', 1500], 'Ending the caliper keeps the pane set up.');
    check('A caliper turns its pane to its plane and the bone window, says so with Undo, and Undo puts the pane back');

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

    // The rows Copy leaves out are counted above the names, and the count goes to the first of them.
    const unmarkedButton = checklist.locator('[data-action="checklist-unmarked"]');
    const rowCount = await checklist.locator('[data-item]').count(), copiedRows = report.split('\n').length - 1;
    assert.equal(await unmarkedButton.textContent(), `${rowCount - copiedRows} unmarked`, 'The count is the rows the report leaves out.');
    await unmarkedButton.click();
    assert.equal(await page.evaluate(() => { const cell = document.activeElement?.closest('[data-side]'); return cell && `${cell.closest('[data-item]').dataset.item}:${cell.dataset.side}`; }),
      'lamina:right', 'It goes to the first row left out.');
    await unmarkedButton.hover();
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(output, '5-unmarked-en.png') });
    await page.mouse.move(5, 5);
    check('Above the names, the rows Copy leaves out are counted, and the count goes to the first', { unmarked: rowCount - copiedRows });

    // The theatre card: the main process's print dialog is replaced by a PDF of the page as it would print, kept here.
    await desktop.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      globalThis.__theatreCards = [];
      contents.print = (_options, callback) => contents.printToPDF({ preferCSSPageSize: true, printBackground: false })
        .then(data => { globalThis.__theatreCards.push(data.toString('base64')); callback(true, ''); }, error => callback(false, String(error)));
    });
    const card = page.getByTestId('theatre-card');
    /** Prints the card and keeps its PDF (and on macOS a picture of it); returns the card's text. */
    const printCard = async (name, count) => {
      await checklist.locator('[data-action="checklist-print"]').click();
      for (let tries = 0; tries < 100 && (await desktop.evaluate(() => globalThis.__theatreCards.length)) < count; tries++) await page.waitForTimeout(100);
      const pdf = Buffer.from((await desktop.evaluate(() => globalThis.__theatreCards))[count - 1], 'base64');
      assert.equal((pdf.toString('latin1').match(/\/Type\s*\/Page(?!s)/g) ?? []).length, 1, 'The card fits on one page.');
      await fs.writeFile(path.join(output, `${name}.pdf`), pdf);
      if (process.platform === 'darwin') execFileSync('sips', ['-s', 'format', 'png', path.join(output, `${name}.pdf`), '--out', path.join(output, `${name}.png`)], { stdio: 'ignore' });
      assert.equal(await card.isVisible(), false, 'The card is printed, never shown on screen.');
      return card.textContent();
    };
    /** What the card gives for an item's side: its answer, then its measurement and where it was seen. */
    const cardCell = async (item, which) => [await card.locator(`[data-item="${item}"] [data-side="${which}"] strong`).textContent(),
      ...await card.locator(`[data-item="${item}"] [data-side="${which}"] span`).allTextContents()];
    const english = await printCard('4-theatre-card-en', 1);
    assert.equal(await card.locator('h1').textContent(), 'Theatre card · Sinus CT · before surgery');
    assert.match(await card.locator('.theatre-card-identity').textContent(), /^SYNTHETIC SINUS · Study date: 01\.01\.2000/);
    assert.deepEqual(await cardCell('keros', 'right'), ['1', '3.2 mm, type 1, near limit; Gera 70.0°, class II', 'coronal · slice 41/141']);
    assert.deepEqual(await cardCell('lamina', 'left'), ['–'], 'A side not marked says so.');
    assert.equal(await card.locator('[data-item="keros"] th small').textContent(), 'right–left difference 2.8 mm');
    assert.equal(await card.locator('[data-item="pneumatisation"] td').count(), 1, 'An item with one answer spans both sides.');
    assert.match(await card.locator('footer').textContent(), /^16 of 21 sides not marked · Measured on CT: check against the images\./);
    check('The theatre card prints the patient, every item with both sides, measurements and slices, on one A4 page', { card: english });

    // The same in Turkish.
    await page.getByTestId('tool-language').press('Enter');
    await page.getByTestId('language-tr').press('Enter');
    await checklist.getByText('Ameliyat öncesi kontrol').waitFor();
    await select('keros');
    assert.equal(await detail('keros', 'right').locator('.preop-limit').textContent(), 'sınırda');
    const turkish = await copied('Kopyalandı');
    assert.match(turkish, /Kribriform plate \(Keros\): Sağ 1 \(3\.2 mm, tip 1, sınırda; Gera 70\.0°, sınıf II; kesit \d+\/\d+\)/);
    assert.match(turkish, /sağ–sol fark 2\.8 mm/);
    assert.equal(await unmarkedButton.textContent(), `${rowCount - copiedRows} işaretsiz`);
    const turkishCard = await printCard('4-theatre-card-tr', 2);
    assert(turkishCard.includes('Ameliyathane kartı · PNS BT · ameliyat öncesi') && turkishCard.includes('taraftan'), turkishCard);
    await page.screenshot({ path: path.join(output, '1-keros-tr.png') });
    await show('sagittal', landmarks.sella.x);
    await page.mouse.move(5, 5);
    await page.screenshot({ path: path.join(output, '2-sella-tr.png') });
    await softWindow();
    await caliperButton('keros', 'right').click();
    await setUp.waitFor();
    assert.equal(await setUp.locator('span').textContent(), 'Keros ve Gera için koronal kesit ve kemik penceresi');
    await shownPlane('coronal');
    await page.mouse.move(5, 5);
    await page.screenshot({ path: path.join(output, '3-set-up-tr.png') });
    await setUp.getByRole('button').click();
    await shownPlane('sagittal');
    // Clear says so with Undo, and Undo puts every answer and measurement back.
    await checklist.locator('[data-action="checklist-clear"]').click();
    assert.equal(await checklist.locator('.preop-undo').textContent(), 'Kontrol listesi temizlendi.Geri al');
    assert.equal(await answer('keros', 'right'), null);
    await page.mouse.move(5, 5);
    await page.screenshot({ path: path.join(output, '5-undo-tr.png') });
    await checklist.locator('[data-action="checklist-undo"]').click();
    assert.deepEqual([await answer('keros', 'right'), await value('keros', 'right')], ['1', '3.2 mm · 70.0°'], 'Undo puts the cleared checklist back.');
    check('In Turkish: the checklist, its limit word and the report; Clear says so and Undo puts it back', { report: turkish });

    // A full card fits on one page too: every side answered and noted, the measurements kept, in both languages.
    for (const row of await checklist.locator('[data-item]').all()) {
      const item = await row.getAttribute('data-item');
      for (const cell of await row.locator('[data-side]').all()) {
        const which = await cell.getAttribute('data-side');
        if (!await cell.locator('[data-action="checklist-answer"][aria-checked="true"]').count()) await cell.locator('[data-action="checklist-answer"]').first().click();
        await select(item);
        if (!await detail(item, which).locator('.preop-seen').count()) await detail(item, which).locator('[data-action="checklist-note"]').click();
      }
    }
    assert.match(await printCard('6-full-card-tr', 3), /21 taraftan 0 tanesi işaretlenmedi/);
    await page.getByTestId('tool-language').press('Enter');
    await page.getByTestId('language-en').press('Enter');
    await checklist.getByText('Pre-operative check').first().waitFor();
    assert.match(await printCard('6-full-card-en', 4), /0 of 21 sides not marked/);
    assert.equal((await cardCell('keros', 'right'))[1], '3.2 mm, type 1, near limit; Gera 70.0°, class II', 'The measurements stay on the full card.');
    check('A full theatre card, every side answered and noted with the measurements kept, prints on one page in both languages');

    // Show turns the pane to the selected item's plane in the bone window and says so with Undo; its label names the plane
    // it turns to next. Leaving one of an item's planes for the other remembers the slice, and Show goes back to it. (The
    // full card above answered every row on a sagittal pane: Onodi and the pneumatisation remember a sagittal slice, the
    // sphenoid's ICA nothing yet.)
    await checklist.locator('[data-action="checklist-clear"]').click();
    const showButton = bar.locator('[data-action="checklist-show"]'), toast = page.locator('.viewport-cell.is-active .pane-toast');
    await show('coronal', landmarks.keros.y);
    await softWindow();
    const kerosSlice = (await view()).slice;
    await select('sphenoid-ica');
    assert.equal(await showButton.textContent(), 'Show axial', 'On a coronal pane, the ICA offers its other plane.');
    await showButton.click();
    await shownPlane('axial');
    assert.equal(await toast.locator('span').textContent(), 'The axial plane and bone window for Sphenoid: ICA');
    assert.deepEqual([(await view()).windowWidth, (await view()).windowCenter], [1500, 300], 'Show sets the bone window.');
    assert.equal(await showButton.textContent(), 'Show coronal');
    const onAxial = await view();
    await showButton.click();
    await shownPlane('coronal');
    assert.equal((await view()).slice, kerosSlice, 'Back on the coronal plane at the slice it left.');
    assert.equal(await toast.locator('span').textContent(), 'The coronal slice last viewed for Sphenoid: ICA');
    await page.mouse.move(5, 5);
    await page.screenshot({ path: path.join(output, '7-show-en.png') });
    await toast.locator('[data-action="checklist-show-undo"]').click();
    await shownPlane('axial');
    assert.deepEqual(await view(), onAxial, 'Undo puts the pane back exactly.');
    await select('onodi');
    await showButton.click();
    await shownPlane('coronal');
    await showButton.click();
    await shownPlane('sagittal');
    assert.equal(await toast.locator('span').textContent(), 'The sagittal slice last viewed for Onodi cell', 'Where Onodi was answered on a sagittal pane.');
    check('Show turns the pane to the item\'s plane in the bone window with Undo, and back to the slice it left there', { kerosSlice });

    // Yes on a side, with the pane on the item's plane, notes the slice on screen by itself, on that side only; Show from
    // another plane goes to it, and so does Show on another slice of that plane; the note goes again when the answer
    // changes. An axial pane notes nothing for a coronal item.
    const pick = (item, which, label) => side(item, which).locator('[data-action="checklist-answer"]').filter({ hasText: new RegExp(`^${label}$`) }).click();
    const onSlice = slice => page.waitForFunction(slice => window.__VEACOM_TEST__.state().view.slice === slice, slice);
    await show('coronal', landmarks.keros.y);
    await pick('lamina', 'right', 'Yes');
    assert.match(await value('lamina', 'right'), /^Slice \d+\/\d+$/, 'Yes on a coronal pane notes the slice.');
    assert.equal(await detail('lamina', 'right').locator('.preop-seen').getAttribute('data-tooltip-hint'), 'Noted when marked Yes');
    assert.equal(await value('lamina', 'left'), null, 'Only the side answered is noted.');
    await show('sagittal', landmarks.sella.x);
    await showButton.click();
    await shownPlane('coronal');
    assert.equal((await view()).slice, kerosSlice, 'Show goes to the slice noted for the item.');
    assert.equal(await toast.locator('span').textContent(), 'The coronal slice noted for Lamina papyracea');
    await page.evaluate(slice => window.__VEACOM_TEST__.setView({ slice }), kerosSlice + 8);
    await onSlice(kerosSlice + 8);
    assert.equal(await showButton.textContent(), 'Show coronal');
    await showButton.click();
    await onSlice(kerosSlice);
    assert.equal(await toast.locator('span').textContent(), 'The coronal slice noted for Lamina papyracea', 'On the plane already, Show goes to the slice noted.');
    await pick('lamina', 'right', 'No');
    assert.equal(await value('lamina', 'right'), null, 'The note goes when the answer is no longer Yes.');
    await page.evaluate(() => window.__VEACOM_TEST__.setView({ plane: 'axial', mode: 'mpr', oblique: [0, 0] }));
    await shownPlane('axial');
    await pick('haller', 'right', 'Yes');
    assert.equal(await value('haller', 'right'), null, 'An axial pane notes nothing for a coronal item.');
    // Enter on a row's answers shows its item.
    await side('lamina', 'left').locator('.preop-choice').focus();
    await page.keyboard.press('Enter');
    await shownPlane('coronal');
    assert.equal(await bar.getAttribute('data-detail-item'), 'lamina');
    check('Yes notes the slice on the item\'s plane by itself and No takes it away; Show goes to it; Enter on a row shows its item');

    assert.deepEqual(errors, [], 'No page errors.');
    await fs.writeFile(path.join(output, 'close-calipers-checks.json'), JSON.stringify({ checks, errors }, null, 2));
    console.log(`All ${checks.length} CLOSE caliper checks passed.`);
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    await fs.writeFile(path.join(output, 'close-calipers-checks.json'), JSON.stringify({ checks, errors, failure: String(error.stack || error) }, null, 2));
    throw error;
  } finally {
    await closeDesktop(desktop);
    await fs.rm(userData, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
