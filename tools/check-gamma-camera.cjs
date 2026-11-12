// Desktop check of gamma camera (NM) studies on the synthetic studies of tools/fixtures/make-nm-study.mjs: a SPECT/CT
// opens in one pane as any study does; the nuclear medicine screen in the fusion button's menu lays it out as
// CT · SPECT · fused · MIP, its SPECT reconstructed from the NM detector geometry and fused on its own scale, never in
// SUV; a click on the MIP sends the linked panes to the vertebral lesion; the screen of a whole-body scan shows
// its anterior and posterior views side by side, each frame named by its view and detector, one scale for both,
// each paging on its own; Undo puts the linking back; the projections name their detectors. A gated SPECT in the
// SPECT/CT study opens as one placed volume per gate, in gate order, each named by its gate and the time it counted; the
// SPECT/CT screen keeps the summed SPECT; a gate follows the CT's height, shows its MIP and fuses over the CT; the export
// window says a gate exports with every gate of its file.
// usage: node tools/check-gamma-camera.cjs NM_STUDIES [OUTPUT_DIR]
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const os = require('node:os');
const privileged = require('./privileged-imaging.cjs');
const { ignoreOutsideInput } = require('./lib/outside-input.cjs');
const { closeDesktop } = require('./lib/close-desktop.cjs');

async function main() {
  const studies = path.resolve(process.argv[2]);
  const output = path.resolve(process.argv[3] || 'test-results/gamma-camera');
  const manifest = JSON.parse(await fs.readFile(path.join(studies, 'manifest.json'), 'utf8'));
  assert.equal(manifest.generator, 'veacom-nm-v2', 'Run on the studies made by tools/fixtures/make-nm-study.mjs.');
  const spectCt = path.join(studies, manifest.studies.spectCt), wholeBody = path.join(studies, manifest.studies.wholeBody);
  await fs.mkdir(output, { recursive: true });
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'veacom-gamma-camera-'));
  const desktop = await electron.launch({ args: [path.resolve(__dirname, '..'), '--study', spectCt], timeout: 90_000,
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
    const state = () => page.evaluate(() => window.__VEACOM_TEST__.state());
    const settled = async () => {
      await page.waitForFunction(() => window.__VEACOM_TEST__?.state().fullVolumeLoaded && window.__VEACOM_TEST__.state().pendingLoads === 0, undefined, { timeout: 120_000 });
      await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="viewport-cell"]')].every(cell => !cell.dataset.seriesId || cell.dataset.volumeComplete === 'true'), undefined, { timeout: 120_000 });
      await page.waitForTimeout(600);
    };
    const shot = name => page.screenshot({ path: path.join(output, `${name}.png`) });
    const cells = page.locator('[data-testid="viewport-cell"]');
    const overlay = index => cells.nth(index).locator('[data-testid="image-overlay"]').textContent();
    // The top corners: who, and what the image is (modality, phase, a gamma camera frame's view and detector).
    const corner = index => cells.nth(index).locator('[data-testid="patient-overlay"]').textContent();
    const notice = () => page.locator('.pane-toast').allTextContents();
    const named = (s, pattern) => s.series.find(item => pattern.test(item.description));
    const location = async index => Number((await cells.nth(index).locator('[data-testid="image-overlay"] .slice-detail').textContent()).match(/Loc: (-?[\d.]+)/)?.[1]);
    // The nuclear medicine screen of the active pane's study, asked for in the menu beside the fusion button.
    const openScreen = async () => {
      await page.getByTestId('tool-fusion-menu').click();
      await page.locator('[data-action="nm-screen"]').click();
      await page.locator('[data-action="arrangement-undo"]').waitFor();
      await settled();
    };
    await settled();

    // The SPECT/CT opens in one pane; its screen, asked for, has the reconstructed SPECT (not its projections) fused
    // over the CT.
    let s = await state();
    const ct = named(s, /· CT$/), spect = named(s, /· SPECT Bq\/ml$/), projections = named(s, /· projections$/);
    assert(ct && spect && projections, 'The SPECT/CT study has its CT, SPECT and projections.');
    assert.deepEqual(spect.dimensions, [64, 64, 48]);
    assert.deepEqual(s.layout, [1, 1], 'A SPECT/CT opens as any other study.');
    assert.deepEqual(await notice(), []);
    await openScreen();
    s = await state();
    assert.deepEqual(s.layout, [2, 2]);
    assert.deepEqual(s.panes.map(pane => pane.seriesId), [ct.id, spect.id, ct.id, spect.id]);
    assert.deepEqual(s.panes.map(pane => pane.projection), [null, null, null, 'mip']);
    assert.deepEqual(s.panes.map(pane => pane.unfused), [true, true, false, true], 'Only the third pane shows the fusion.');
    assert.deepEqual(s.panes.map(pane => pane.inverted), [false, true, false, true], 'SPECT panes are inverted grey.');
    assert.equal(s.fusionId, spect.id);
    assert.equal(s.linked, true);
    assert(Math.abs(await location(0) - await location(1)) <= 3, 'The CT and the SPECT open at one height.');
    assert.deepEqual(await notice(), ['SPECT/CT: CT · SPECT · fusion · MIPUndo']);
    const spectText = await overlay(1), fusedText = await overlay(2);
    assert.match(spectText, /W \d+ \/ L \d+ Bq\/ml/, 'The SPECT window reads in its own Bq/ml.');
    // The fused series' name sits with the patient corners: with patient details hidden it is named by its modality.
    assert.match(await corner(2), /Fusion: Synthetic SPECT\/CT · SPECT Bq\/ml/);
    assert.match(fusedText, /On its own values/);
    for (const index of [1, 2, 3]) assert.doesNotMatch(await overlay(index) + await corner(index), /SUV/, `Nothing on pane ${index + 1} is called SUV.`);
    assert.match(await overlay(3), /MIP · 0°/);
    assert.equal((await page.getByTestId('fusion-strip').locator('.strip-label').textContent()).trim(), 'Fusion');
    assert.match(await page.getByTestId('fusion-strip').textContent(), /Scale max/);
    assert.doesNotMatch(await page.getByTestId('fusion-strip').textContent(), /SUV|Scanner look/);
    const actions = (await page.evaluate(() => window.__VEACOM_TEST__.usage())).filter(event => event.name === 'ux.action').map(event => event.attributes?.['veacom.action']);
    assert.deepEqual(actions.slice(-2), ['tool-fusion-menu', 'nm-screen']);
    await shot('1-spect-ct');
    check('The SPECT/CT screen: CT · SPECT · fused · MIP, its SPECT reconstructed and fused on its own scale, never in SUV', { panes: s.panes.length });

    // A click on the vertebral lesion in the MIP (x = 0, z = -130 mm): the axial panes go to it, the MIP keeps its turn.
    const box = await cells.nth(3).locator('canvas[data-renderer]').boundingBox();
    const scale = Math.min(box.width / (64 * 6), box.height / (48 * 6)), middle = -141;
    const [, , lesionZ] = manifest.lesions.spect[0];
    await cells.nth(3).locator('canvas[data-renderer]').click({ position: { x: box.width / 2, y: box.height / 2 + (middle - lesionZ) * scale } });
    await page.waitForFunction(() => window.__VEACOM_TEST__.state().panes[3].slice === 0 && document.querySelectorAll('[data-crosshair-marker]').length >= 3, undefined, { timeout: 120_000 });
    await page.waitForTimeout(400);
    for (const index of [0, 1, 2]) assert(Math.abs(await location(index) - lesionZ) <= 4, `Pane ${index + 1} is at the lesion (${await location(index)} mm).`);
    assert.deepEqual(await notice(), [], 'The note goes with the first action.');
    await shot('2-mip-click');
    check('A click on the SPECT MIP sends the linked panes to the hottest voxel there', { location: await location(1) });

    // The whole body opens in the active pane; its screen shows the two views side by side, named in the corner,
    // inverted grey, not linked. The series list is long enough to scroll here, so it is scrolled to its end first:
    // the study opened second leads the list, and the list comes to its top with it.
    const seriesList = page.locator('.series-browser-scroll');
    await seriesList.evaluate(list => { list.scrollTop = list.scrollHeight; });
    assert.ok(await seriesList.evaluate(list => list.scrollTop) > 0, 'The series list scrolls with the SPECT/CT in it.');
    await privileged.importPaths(desktop, page, [wholeBody]);
    await page.waitForFunction(() => (window.__VEACOM_TEST__.state().series.find(item => item.id === document.querySelector('.viewport-cell.is-active canvas[data-renderer]')?.dataset.seriesId)?.description ?? '').endsWith('whole body'), undefined, { timeout: 120_000 });
    await settled();
    assert.equal(await page.locator('.series-study').first().locator(`[data-testid="series-${named(await state(), /whole body$/).id}"]`).count(), 1, 'The study just opened is the first in the series list.');
    assert.equal(await seriesList.evaluate(list => list.scrollTop), 0, 'The series list shows its top, where the new study is.');
    check('A study opened second leads the series list, and the list comes to its top');
    assert.equal((await state()).layout.join('x'), '2x2', 'Opening the whole body leaves the screen as it is.');
    await openScreen();
    await page.waitForFunction(() => window.__VEACOM_TEST__.state().layout.join('x') === '1x2', undefined, { timeout: 120_000 });
    s = await state();
    const body = named(s, /whole body$/);
    assert.deepEqual(s.panes.map(pane => [pane.seriesId, pane.slice, pane.inverted]), [[body.id, 0, true], [body.id, 1, true]]);
    assert.equal(s.linked, false, 'The views page on their own.');
    assert.deepEqual(await notice(), ['Whole body: ANT · POSTUndo']);
    assert.match(await corner(0), /NM · ANT · Detector 1/);
    assert.match(await corner(1), /NM · POST · Detector 2/);
    assert.match(await overlay(0), /1 \/ 2/);
    assert.doesNotMatch(await overlay(0), /Axial|Coronal|Sagittal/, 'A planar view lies in no plane of the patient.');
    await shot('3-whole-body');
    check('The whole-body screen shows ANT and POST side by side, each frame named by its view and detector');

    // Undo: the screen from before, with the linking it had.
    await page.locator('[data-action="arrangement-undo"]').click();
    await page.waitForFunction(() => window.__VEACOM_TEST__.state().linked === true && window.__VEACOM_TEST__.state().layout.join('x') === '2x2', undefined, { timeout: 30_000 });
    check('Undo puts back the screen and the linking the whole body turned off');
    await openScreen();
    await page.waitForFunction(() => window.__VEACOM_TEST__.state().layout.join('x') === '1x2', undefined, { timeout: 120_000 });

    // One scale for both views, and each pane pages on its own.
    await page.evaluate(() => window.__VEACOM_TEST__.setView({ windowCenter: 400, windowWidth: 800 }));
    await page.waitForFunction(() => window.__VEACOM_TEST__.state().panes.every(pane => pane.windowCenter === 400 && pane.windowWidth === 800));
    const first = await cells.nth(0).boundingBox();
    await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
    await page.mouse.wheel(0, 100);
    await page.waitForFunction(() => window.__VEACOM_TEST__.state().panes[0].slice === 1);
    await page.waitForTimeout(300);
    assert.equal((await state()).panes[1].slice, 1, 'The posterior pane stays where it was.');
    assert.match(await corner(0), /NM · POST · Detector 2/);
    await page.mouse.wheel(0, -100);
    await page.waitForFunction(() => window.__VEACOM_TEST__.state().panes[0].slice === 0);
    check('The two views share one window and page on their own');

    // The projections opened by hand: each frame names its detector.
    await page.locator(`[data-testid="series-${projections.id}"]`).click();
    await page.waitForFunction(id => document.querySelector('.viewport-cell.is-active canvas[data-renderer]')?.dataset.seriesId === id, projections.id);
    await settled();
    assert.match(await page.locator('.viewport-cell.is-active [data-testid="patient-overlay"]').textContent(), /NM · Detector 1/);
    await shot('4-projections');
    check('SPECT projections name their detector');

    // The gated SPECT: one placed volume per gate, in gate order, named by its gate and the time it counted (its Time
    // Slot Time, not a delay after the R wave), all on one window. Listed before the summed SPECT, which the SPECT/CT
    // screen still took above.
    const gated = manifest.series.find(item => item.imageType === 'RECON GATED TOMO');
    s = await state();
    const gates = s.series.filter(item => item.phase?.kind === 'timeSlot');
    assert.equal(gates.length, gated.gates, 'One series per gate.');
    assert.deepEqual(gates.map(item => item.phase.order), gated.slotTimes.map((_, index) => index + 1), 'Listed in gate order.');
    const acquired = time => String(Number((time / 1000).toPrecision(3)));
    assert.deepEqual(gates.map(item => item.phase.label), gated.slotTimes.map((time, index) => `Gate ${index + 1}/${gated.gates} · ${acquired(time)} s acquired`));
    assert(s.series.indexOf(gates.at(-1)) < s.series.findIndex(item => item.id === spect.id), 'The gates are listed before the summed SPECT.');
    for (const item of gates) {
      assert.equal(item.description, gated.description);
      assert.equal(item.canReconstruct, true, 'Each gate is a placed volume.');
      assert.deepEqual(item.dimensions, gated.dimensions);
      assert.deepEqual([item.origin, item.spacing, item.direction], [gated.firstSlice, gated.spacing, [1, 0, 0, 0, 1, 0, 0, 0, 1]],
        'Placed from the detector geometry, its slices toward the head by the positive Spacing Between Slices.');
      assert.deepEqual([item.windowCenter, item.windowWidth], [gates[0].windowCenter, gates[0].windowWidth], 'The gates share one window.');
    }
    check('A gated SPECT opens as one placed volume per gate, in gate order, each named by its gate and the time it counted', { gates: gates.length });

    // On the SPECT/CT screen again: gate 5 in the SPECT pane follows the CT's height; gate 1 in the MIP pane is a MIP.
    await privileged.importPaths(desktop, page, [spectCt]);
    await settled();
    await openScreen();
    await page.waitForFunction(() => window.__VEACOM_TEST__.state().layout.join('x') === '2x2', undefined, { timeout: 120_000 });
    s = await state();
    assert.deepEqual(s.panes.map(pane => pane.seriesId), [ct.id, spect.id, ct.id, spect.id], 'The SPECT/CT screen keeps the summed SPECT.');
    const [gateOne, , , , fifth] = gates;
    const show = async (index, item) => {
      await cells.nth(index).locator('[data-testid="dicom-viewport"]').focus();
      await page.locator(`[data-testid="series-${item.id}"]`).click();
      await page.waitForFunction(([index, id]) => document.querySelectorAll('[data-testid="viewport-cell"]')[index]?.querySelector('canvas[data-renderer]')?.dataset.seriesId === id, [index, item.id]);
      await settled();
    };
    await show(1, fifth);
    assert.match(await corner(1), new RegExp(`NM · Gate 5/8 · ${acquired(gated.slotTimes[4])} s acquired`));
    // Paging the CT through the gated volume's range: the gate, placed in the CT's frame of reference, goes with it to
    // its nearest slice (6 mm apart).
    await cells.nth(0).locator('[data-testid="dicom-viewport"]').focus();
    const top = gated.firstSlice[2] + (gated.dimensions[2] - 1) * gated.spacing[2], heights = [];
    const ctSeries = s.series.find(item => item.id === ct.id);
    // The CT's axial slice at a height, from its own geometry: near the shell's middle, then 20 mm above it.
    const ctSlice = z => Math.round((z - ctSeries.origin[2]) / (ctSeries.direction[8] * ctSeries.spacing[2]));
    for (const slice of [ctSlice(gated.shellCenter[2]), ctSlice(gated.shellCenter[2] + 20)]) {
      await page.evaluate(slice => window.__VEACOM_TEST__.setView({ slice }), slice);
      await page.waitForFunction(slice => window.__VEACOM_TEST__.state().panes[0].slice === slice, slice);
      await page.waitForTimeout(400);
      const [ctHeight, gateHeight] = [await location(0), await location(1)];
      assert(gateHeight >= gated.firstSlice[2] && gateHeight <= top, `Gate 5 shows its own slices (${gateHeight} mm).`);
      assert(Math.abs(ctHeight - gateHeight) <= gated.spacing[2] / 2, `The gate follows the CT (${ctHeight} / ${gateHeight} mm).`);
      heights.push([ctHeight, gateHeight]);
    }
    assert.notEqual(heights[0][1], heights[1][1], 'The gate moved with the CT.');
    await show(3, gateOne);
    await page.evaluate(() => window.__VEACOM_TEST__.setView({ mode: 'mpr', plane: 'coronal', oblique: undefined, slab: undefined, projection: 'mip', slice: 0 }));
    await page.waitForFunction(() => window.__VEACOM_TEST__.state().panes[3].projection === 'mip');
    await settled();
    assert.match(await overlay(3), /MIP · 0°/);
    assert.match(await corner(3), /NM · Gate 1\/8/);
    check('A gate follows the CT\'s height on the SPECT/CT screen and shows its MIP', { heights });

    // Gate 5 fused over the CT, chosen by its name in the fusion strip.
    await cells.nth(2).locator('[data-testid="dicom-viewport"]').focus();
    const option = page.getByTestId('fusion-series').locator(`option[value="${fifth.id}"]`);
    assert.equal((await option.textContent()).trim(), `${gated.description} · ${fifth.phase.label}`, 'The fusion menu names each gate.');
    await page.getByTestId('fusion-series').selectOption(fifth.id);
    await page.waitForFunction(id => window.__VEACOM_TEST__.state().fusionId === id, fifth.id, { timeout: 60_000 });
    await settled();
    s = await state();
    assert.deepEqual([s.panes[2].seriesId, s.panes[2].unfused], [ct.id, false]);
    const fused = await overlay(2), fusedName = await corner(2);
    assert.match(fusedName, new RegExp(`Fusion: Synthetic SPECT/CT · gated SPECT · Gate 5/8 · ${acquired(gated.slotTimes[4])} s acquired`));
    assert.match(fused, /On its own values/);
    assert.equal((await page.getByTestId('notice').textContent()).trim(), `Fusion: ${gated.description} · ${fifth.phase.label} + ${ct.description}`, 'The notice names the gate.');
    assert.doesNotMatch(fused + fusedName + await corner(1) + await overlay(1), /SUV/, 'Nothing on a gate is called SUV.');
    await shot('gated-1-spect-ct');
    check('A gate fuses over the CT, named in the fusion strip and the pane, never in SUV');

    // Exporting a gate as DICOM copies its file whole, with every gate in it, and the export window says so.
    await cells.nth(1).locator('[data-testid="dicom-viewport"]').focus();
    await page.keyboard.press('ControlOrMeta+e');
    await page.locator('.export-dialog').waitFor();
    await page.getByTestId('export-gates').waitFor();
    await page.locator('input[data-action="export-scope"][value="picked"]').check();
    const row = page.locator('.export-series-row', { hasText: fifth.phase.label });
    assert.equal((await row.locator('small').textContent()).trim(), `NM · ${gated.dimensions[2] * gated.gates} images: all ${gated.gates} gates of its file`);
    // With one series left out, the box over the list shows a dash; a click on it then picks every series.
    const listBox = page.locator('.export-dialog [data-action="export-select-all"]');
    await row.locator('input').uncheck();
    assert.equal(await listBox.evaluate(box => box.indeterminate), true, 'With one series left out the box over the list shows a dash.');
    await listBox.click();
    assert.equal(await page.locator('.export-dialog [data-action="export-series"]:not(:checked)').count(), 0, 'A click on the dash picks every series.');
    assert.equal(await listBox.isChecked(), true, 'With every series picked the box over the list is ticked.');
    // The list is longer than its frame. Scrolled to its end, the row with the list's own box is still at its top.
    const stuck = await page.locator('.export-series-list').evaluate(list => {
      list.scrollTop = list.scrollHeight;
      return { scrolled: list.scrollTop, gap: Math.round(list.querySelector('.export-pick-all').getBoundingClientRect().top - list.getBoundingClientRect().top) };
    });
    assert.ok(stuck.scrolled > 0 && Math.abs(stuck.gap) <= 2, `The box over the list stays in view while the list scrolls: ${JSON.stringify(stuck)}`);
    await page.locator('input[data-action="export-scope"][value="all"]').check();
    assert.equal(await page.getByTestId('export-gates').count(), 0, 'Every series exported needs no note.');
    await page.getByTestId('export-close').click();
    await page.locator('.export-dialog').waitFor({ state: 'detached' });
    check('The export window says a gate goes with every gate of its file', { images: gated.dimensions[2] * gated.gates });

    assert.deepEqual(errors, [], 'No page errors.');
    await fs.writeFile(path.join(output, 'gamma-camera-checks.json'), JSON.stringify({ checks, errors }, null, 2));
    console.log(`All ${checks.length} gamma camera checks passed.`);
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    await fs.writeFile(path.join(output, 'gamma-camera-checks.json'), JSON.stringify({ checks, errors, failure: String(error.stack || error) }, null, 2));
    throw error;
  } finally {
    await closeDesktop(desktop);
    await fs.rm(userData, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
