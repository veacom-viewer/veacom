// Desktop check of the comparison screen (docs/arrangements.md).
// On the synthetic patient of tools/fixtures/make-comparison-studies.mjs (an earlier and a current brain MR, an earlier
// and a current chest CT):
// - Layout offers "Compare with the earlier study" for the series in the active pane. Its counterpart in the earlier
//   study comes on the left, found by what the series is, not its name; the reader's pane goes to the right as it was.
// - The two page, zoom and pan together. An MR keeps its own window on each side; CT beside CT takes one.
// - A series put in one pane changes that pane only; the other offers its counterpart, which one click opens.
// - Ctrl+Left and Ctrl+Right step both panes to the previous and next pair.
// - A series the earlier study has no counterpart of leaves the left side empty.
// - A reconstructed plane is compared with the same plane, and the earlier study with the later one on the right.
// On the synthetic follow-up of tools/fixtures/make-pet-followup.mjs:
// - A fused PET/CT compared with an earlier CT keeps its fusion.
// - Between two PET studies the comparison is not offered: the PET follow-up screen is.
// usage: node tools/check-comparison.cjs COMPARISON_STUDIES PET_FOLLOWUP [OUTPUT_DIR]
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const os = require('node:os');
const privileged = require('./privileged-imaging.cjs');
const { ignoreOutsideInput } = require('./lib/outside-input.cjs');
const { closeDesktop } = require('./lib/close-desktop.cjs');

const checks = [];
const check = name => { checks.push({ name }); console.log(`PASS ${name}`); };
const shownDate = date => `${date.slice(6, 8)}.${date.slice(4, 6)}.${date.slice(0, 4)}`;

/** Opens `study` in a fresh profile and runs `steps` on its window. */
async function withDesktop(study, output, steps) {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'veacom-comparison-'));
  const desktop = await electron.launch({ args: [path.resolve(__dirname, '..'), '--study', study], timeout: 90_000,
    env: { ...process.env, VEACOM_USER_DATA: userData, VEACOM_LOCALE: 'en', VEACOM_TELEMETRY_CONSENT: 'denied', VEACOM_TEST_MODE: '1' } });
  const errors = [];
  let page, failure;
  try {
    page = await desktop.firstWindow();
    await ignoreOutsideInput(desktop);
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    const state = () => page.evaluate(() => window.__VEACOM_TEST__.state());
    const settled = async () => {
      await page.waitForFunction(() => window.__VEACOM_TEST__?.state().fullVolumeLoaded && window.__VEACOM_TEST__.state().pendingLoads === 0, undefined, { timeout: 120_000 });
      await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="viewport-cell"]')].every(cell => !cell.dataset.seriesId || cell.dataset.volumeComplete === 'true'), undefined, { timeout: 120_000 });
      await page.waitForTimeout(400);
    };
    const cells = page.locator('[data-testid="viewport-cell"]');
    const kit = { desktop, page, state, settled, cells,
      shot: name => page.screenshot({ path: path.join(output, `${name}.png`) }),
      image: index => cells.nth(index).locator('[data-testid="dicom-viewport"]'),
      shown: async () => (await state()).panes.map(pane => pane.seriesId),
      listed: count => page.waitForFunction(n => window.__VEACOM_TEST__?.state().series.length === n, count, { timeout: 120_000 }),
      layoutMenu: async () => { if (!await page.locator('.layout-popover').count()) await page.getByTestId('tool-layout').click(); await page.locator('.layout-popover').waitFor(); },
      /** One pane showing `id`, as a reader opens a series. */
      async single(id) {
        if ((await state()).panes.length > 1) { await kit.layoutMenu(); await page.locator('.layout-popover [data-layout="1x1"]').click(); await page.waitForFunction(() => window.__VEACOM_TEST__.state().panes.length === 1); }
        await page.keyboard.press('Escape');
        await page.locator(`[data-testid="series-${id}"]`).click();
        await page.waitForFunction(id => window.__VEACOM_TEST__.state().activeSeriesId === id, id);
        await settled();
      },
      /** Layout's comparison entry: checks what it is called, then asks for it. */
      async compare(label) {
        await kit.layoutMenu();
        assert.equal((await page.locator('[data-action="layout-compare"]').textContent()).trim(), label);
        await page.locator('[data-action="layout-compare"]').click();
        await page.waitForFunction(() => window.__VEACOM_TEST__.state().panes.length === 2);
        await settled();
      },
      /** A series picked in the list goes to the active pane. */
      async pick(id, pane) {
        await page.locator(`[data-testid="series-${id}"]`).click();
        await page.waitForFunction(([id, pane]) => window.__VEACOM_TEST__.state().panes[pane]?.seriesId === id, [id, pane]);
      },
      async pairs(ids) { await page.waitForFunction(ids => JSON.stringify(window.__VEACOM_TEST__.state().panes.map(pane => pane.seriesId)) === JSON.stringify(ids), ids); await settled(); },
    };
    await steps(kit);
    assert.deepEqual(errors, [], 'The page reported errors.');
  } catch (error) {
    failure = error;
    if (page) await page.screenshot({ path: path.join(output, `failure-${path.basename(study)}.png`) }).catch(() => {});
  } finally {
    if (!await closeDesktop(desktop)) failure ??= new Error('The desktop app did not quit, so it was killed.');
    await fs.rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  if (failure) throw failure;
}

/** The comparison screen on one patient's MR and CT studies. */
async function compareStudies(manifest, { page, state, settled, cells, shot, image, shown, listed, single, compare, pick, pairs }) {
  await listed(manifest.studies.reduce((sum, study) => sum + study.series.length, 0));
  await settled();
  let s = await state();
  // Each series by its study and kind, and each study's date.
  const ids = {}, dates = {};
  for (const study of manifest.studies) {
    dates[study.name] = study.date; ids[study.name] = {};
    for (const item of study.series) {
      const found = s.series.find(value => value.description === item.description && value.studyDate === study.date);
      assert(found, `${study.name} lists ${item.description}`);
      ids[study.name][item.kind] = found;
    }
  }
  const now = ids['mr-current'], before = ids['mr-prior'];
  const view = async index => (await state()).panes[index];
  const level = (slice, from, to) => Math.round(slice / (from.dimensions[2] - 1) * (to.dimensions[2] - 1));
  /** Pages the right pane `steps` slices with the keyboard; the panes once every press has been applied. */
  const pageDown = async (steps, from) => {
    await image(1).focus();
    for (let step = 0; step < steps; step++) await page.keyboard.press('ArrowDown');
    await page.waitForFunction(([slice, steps]) => Math.abs(window.__VEACOM_TEST__.state().panes[1].slice - slice) === steps, [from, steps]);
    return (await state()).panes;
  };

  // The current T2 in one pane, on the reader's own slice, zoom, pan and window.
  await single(now.t2.id);
  const slice = Math.floor(now.t2.dimensions[2] / 2) + 3;
  await page.evaluate(slice => window.__VEACOM_TEST__.setView({ slice, zoom: 1.5, pan: [12, -8], windowCenter: 300, windowWidth: 700 }), slice);
  await page.waitForFunction(slice => window.__VEACOM_TEST__.state().view.slice === slice, slice);
  const mine = (await state()).view;
  await compare('Compare with the earlier study');
  s = await state();
  assert.deepEqual(s.layout, [1, 2]);
  // The earlier T2 is called "AX T2 TSE" and this one "t2_tse_tra"; the chest CT lies between the two in time.
  assert.deepEqual(s.panes.map(pane => pane.seriesId), [before.t2.id, now.t2.id], 'The earlier study\'s T2 is on the left, the current one on the right.');
  assert.equal(s.activeSeriesId, now.t2.id, 'The reader stays in their own pane.');
  assert.deepEqual([s.panes[1].slice, s.panes[1].zoom, s.panes[1].pan, s.panes[1].windowCenter, s.panes[1].windowWidth], [mine.slice, mine.zoom, mine.pan, 300, 700], 'The reader\'s pane keeps its view.');
  assert(Math.abs(s.panes[0].slice - level(slice, now.t2, before.t2)) <= 1, `The earlier T2 opens level with the current one: ${s.panes[0].slice}`);
  assert.deepEqual([s.panes[0].zoom, s.panes[0].pan], [mine.zoom, mine.pan]);
  assert.notDeepEqual([s.panes[0].windowCenter, s.panes[0].windowWidth], [300, 700], 'An MR keeps its own window: its values are not one scale.');
  assert.equal(s.linked, true);
  const note = await page.locator('.pane-toast').allTextContents();
  assert.equal(note.length, 1);
  assert(note[0].includes(`Earlier study on the left: ${shownDate(dates['mr-prior'])}.`), note[0]);
  assert.equal(await cells.nth(0).locator('.pane-toast [data-action="arrangement-undo"]').count(), 1, 'The note is in the pane it is about, with Undo.');
  await shot('1-compared');
  check('Layout puts the earlier study\'s T2 on the left of the current T2, whatever each is called, level with it');

  // Undo gives the single pane back as it was.
  await page.locator('[data-action="arrangement-undo"]').click();
  await page.waitForFunction(() => window.__VEACOM_TEST__.state().panes.length === 1);
  s = await state();
  assert.deepEqual([s.activeSeriesId, s.view.slice, s.view.zoom, s.view.windowCenter], [now.t2.id, mine.slice, mine.zoom, 300]);
  check('Undo puts back the single pane as it was');

  // The two page together by the millimetres gone, and zoom and pan together; each keeps its window.
  await compare('Compare with the earlier study');
  let was = (await state()).panes;
  let is = await pageDown(4, was[1].slice);
  // Four slices of 5 mm are 20 mm: three of the earlier study's 6 mm slices, the same way.
  assert.equal(is[0].slice - was[0].slice, Math.sign(is[1].slice - was[1].slice) * 3, 'The earlier study pages with the current one, by the distance gone.');
  await page.evaluate(() => { const view = window.__VEACOM_TEST__.state().view; window.__VEACOM_TEST__.setView({ zoom: view.zoom * 2, pan: [view.pan[0] + 30, view.pan[1] + 10] }); });
  await page.waitForFunction(zoom => window.__VEACOM_TEST__.state().panes[1].zoom === zoom * 2, is[1].zoom);
  s = await state();
  assert.deepEqual([s.panes[0].zoom, s.panes[0].pan], [s.panes[1].zoom, s.panes[1].pan], 'The panes zoom and pan together.');
  was = s.panes;
  await page.evaluate(() => window.__VEACOM_TEST__.setView({ windowCenter: 420, windowWidth: 900 }));
  await page.waitForFunction(() => window.__VEACOM_TEST__.state().panes[1].windowCenter === 420);
  assert.deepEqual([(await view(0)).windowCenter, (await view(0)).windowWidth], [was[0].windowCenter, was[0].windowWidth], 'Windowing one MR leaves the other as it is.');
  // Unlinked, each pane is on its own again.
  await page.getByTestId('tool-link').click();
  await page.waitForFunction(() => window.__VEACOM_TEST__.state().linked === false);
  was = (await state()).panes;
  await page.evaluate(() => { const view = window.__VEACOM_TEST__.state().view; window.__VEACOM_TEST__.setView({ zoom: view.zoom / 2 }); });
  await page.waitForFunction(zoom => window.__VEACOM_TEST__.state().panes[1].zoom === zoom / 2, was[1].zoom);
  assert.equal((await view(0)).zoom, was[0].zoom, 'Unlinked, the other pane keeps its zoom.');
  await page.getByTestId('tool-link').click();
  await page.waitForFunction(() => window.__VEACOM_TEST__.state().linked === true);
  check('The two page, zoom and pan together, each MR in its own window; unlinked, each is on its own');

  // A series put in the reader's pane changes that pane only. The other pane offers its counterpart.
  const offer = cells.nth(0).locator('.pane-toast');
  await image(1).focus();
  was = (await state()).panes;
  await pick(now.t1.id, 1);
  assert.deepEqual(await shown(), [before.t2.id, now.t1.id], 'The other pane keeps what it showed.');
  // The T1 lies where the T2 did (one study, one frame of reference): the pane stays at the reader's slice.
  assert.deepEqual((await state()).panes.map(pane => pane.slice), was.map(pane => pane.slice), 'Both panes stay at their level.');
  await offer.waitFor();
  assert.match(await offer.textContent(), /^Open the earlier AX T1 SE here\?/);
  await settled();
  await shot('2-offer');
  await offer.locator('[data-action="compare-open"]').click();
  await pairs([before.t1.id, now.t1.id]);
  assert.equal(await page.locator('.pane-toast').count(), 0);
  was = (await state()).panes;
  is = await pageDown(3, was[1].slice);
  assert.notEqual(is[0].slice, was[0].slice, 'The counterpart opened from the offer is linked to the pane it was opened for.');
  check('A series put in one pane changes that pane only; the other offers its counterpart and one click opens it');

  // An offer left alone goes away, and the panes stay as the reader put them: an earlier T1 beside this T1 with contrast.
  await pick(now.t1c.id, 1);
  await offer.waitFor();
  assert.match(await offer.textContent(), /^Open the earlier AX T1 SE GD here\?/);
  await offer.waitFor({ state: 'detached', timeout: 15_000 });
  assert.deepEqual(await shown(), [before.t1.id, now.t1c.id]);
  check('An offer left alone clears itself and changes nothing');

  // Ctrl+Left and Ctrl+Right step both panes to the previous and next pair. The FLAIR, which the earlier study
  // lacks, is passed over, and at either end the panes stay and the window says so.
  const noMore = async () => {
    const bar = page.locator('[data-testid="notice"][data-code="compare.noMorePairs"]');
    await bar.waitFor();
    await bar.locator('[data-testid="notice-dismiss"]').click();
    await bar.waitFor({ state: 'detached' });
  };
  await image(1).focus();
  was = (await state()).panes;
  await page.keyboard.press('Control+ArrowLeft'); await pairs([before.t2.id, now.t2.id]);
  await page.keyboard.press('Control+ArrowLeft'); await pairs([before.t1.id, now.t1.id]);
  assert.deepEqual((await state()).panes.map(pane => pane.slice), was.map(pane => pane.slice), 'Stepping keeps both panes at their level.');
  await image(1).focus();
  await page.keyboard.press('Control+ArrowLeft'); await noMore();
  assert.deepEqual(await shown(), [before.t1.id, now.t1.id]);
  await image(1).focus();
  await page.keyboard.press('Control+ArrowRight'); await pairs([before.t2.id, now.t2.id]);
  await page.keyboard.press('Control+ArrowRight'); await pairs([before.t1c.id, now.t1c.id]);
  await shot('3-stepped');
  await image(1).focus();
  await page.keyboard.press('Control+ArrowRight'); await noMore();
  assert.deepEqual(await shown(), [before.t1c.id, now.t1c.id]);
  check('Ctrl+Left and Ctrl+Right step both panes pair by pair, past a series without a counterpart');

  // The FLAIR has no counterpart in the earlier study: its side stays empty, and nothing of another kind is put there.
  await single(now.flair.id);
  await compare('Compare with the earlier study');
  s = await state();
  assert.deepEqual(s.panes.map(pane => pane.seriesId), [null, now.flair.id]);
  assert.deepEqual(await cells.nth(1).locator('.pane-toast span').allTextContents(), ['No matching series in the earlier study; drag one to the left.']);
  await shot('4-empty');
  // The T2 picked into the reader's pane has one: the empty pane offers it.
  await image(1).focus();
  await pick(now.t2.id, 1);
  await offer.waitFor();
  assert.match(await offer.textContent(), /^Open the earlier AX T2 TSE here\?/);
  await offer.locator('[data-action="compare-open"]').click();
  await pairs([before.t2.id, now.t2.id]);
  check('A series without a counterpart leaves the earlier study\'s side empty; a later pick fills it by offer');

  // CT beside CT: the lung reconstruction finds the earlier lung reconstruction, named and sliced otherwise, and the
  // two take one window.
  const chest = ids['ct-current'], chestBefore = ids['ct-prior'];
  await single(chest.lung.id);
  await compare('Compare with the earlier study');
  s = await state();
  assert.deepEqual(s.panes.map(pane => pane.seriesId), [chestBefore.lung.id, chest.lung.id]);
  assert((await page.locator('.pane-toast').allTextContents())[0].includes(`Earlier study on the left: ${shownDate(dates['ct-prior'])}.`));
  assert.deepEqual([s.panes[0].windowCenter, s.panes[0].windowWidth], [s.panes[1].windowCenter, s.panes[1].windowWidth]);
  await page.evaluate(() => window.__VEACOM_TEST__.setView({ windowCenter: 40, windowWidth: 400 }));
  await page.waitForFunction(() => window.__VEACOM_TEST__.state().panes[1].windowCenter === 40);
  s = await state();
  assert.deepEqual([s.panes[0].windowCenter, s.panes[0].windowWidth], [40, 400], 'CT beside CT takes one window.');
  await shot('5-ct');
  check('A lung reconstruction is compared with the earlier lung reconstruction, in one window');

  // A coronal reconstruction is compared with the earlier study in the same plane.
  await single(chest.soft.id);
  const coronal = Math.floor(chest.soft.dimensions[1] / 2) + 5;
  await page.evaluate(slice => window.__VEACOM_TEST__.setView({ mode: 'mpr', plane: 'coronal', oblique: [0, 0], slice }), coronal);
  await page.waitForFunction(slice => window.__VEACOM_TEST__.state().panes[0].plane === 'coronal' && window.__VEACOM_TEST__.state().view.slice === slice, coronal);
  await settled();
  await compare('Compare with the earlier study');
  s = await state();
  assert.deepEqual(s.panes.map(pane => [pane.seriesId, pane.mode, pane.plane]), [[chestBefore.soft.id, 'mpr', 'coronal'], [chest.soft.id, 'mpr', 'coronal']]);
  assert(Math.abs(s.panes[0].slice - coronal) <= 1, `The earlier study opens at the same depth: ${s.panes[0].slice}`);
  was = s.panes;
  is = await pageDown(3, was[1].slice);
  // Both stacks step 3.125 mm from front to back.
  assert.equal(is[0].slice - was[0].slice, is[1].slice - was[1].slice, 'The two coronal planes page together.');
  await shot('6-coronal');
  check('A reconstructed plane is compared with the same plane of the earlier study');

  // From the earlier study the screen is offered with the later one, which comes on the right.
  await single(before.t2.id);
  await compare('Compare with the later study');
  s = await state();
  assert.deepEqual(s.panes.map(pane => pane.seriesId), [before.t2.id, now.t2.id], 'The earlier study stays on the left and the later one comes on the right.');
  assert.equal(s.activeSeriesId, before.t2.id);
  assert((await page.locator('.pane-toast').allTextContents())[0].startsWith(`Later study on the right: ${shownDate(dates['mr-current'])}.`));
  check('From the earlier study the later study comes on the right');
}

/** PET studies: a fused PET/CT keeps its fusion beside an earlier CT; two PET studies are left to the PET follow-up. */
async function petStudies(folder, { desktop, page, state, settled, shot, listed, layoutMenu, compare }) {
  await listed(2);
  await settled();
  let s = await state();
  const ct = s.series.find(item => item.modality === 'CT'), pet = s.series.find(item => item.modality === 'PT');
  const open = async id => {
    await page.keyboard.press('Escape');
    await page.locator(`[data-testid="series-${id}"]`).click();
    await page.waitForFunction(id => window.__VEACOM_TEST__.state().activeSeriesId === id, id);
    await settled();
  };
  // With the earlier study's CT alone, the comparison is offered, and the reader's pane stays fused.
  await privileged.importPaths(desktop, page, [path.join(folder, 'prior', 'S01')]);
  await listed(3);
  await settled();
  s = await state();
  const priorCt = s.series.find(item => item.modality === 'CT' && item.id !== ct.id);
  await open(ct.id);
  // The current CT with its PET over it in one pane, as the study opens.
  await layoutMenu();
  await page.locator('[data-action="layout-pet-fused"]').click();
  await page.waitForFunction(([ct, pet]) => { const s = window.__VEACOM_TEST__.state(); return s.panes.length === 1 && s.panes[0].seriesId === ct && s.fusionId === pet && !s.panes[0].unfused; }, [ct.id, pet.id]);
  await settled();
  await compare('Compare with the earlier study');
  s = await state();
  assert.deepEqual(s.panes.map(pane => [pane.seriesId, pane.unfused]), [[priorCt.id, true], [ct.id, false]], 'The reader\'s pane keeps its fusion; the earlier CT is plain.');
  assert.equal(s.fusionId, pet.id);
  await shot('7-fused');
  await page.locator('[data-action="arrangement-undo"]').click();
  await page.waitForFunction(() => window.__VEACOM_TEST__.state().panes.length === 1);
  s = await state();
  assert.deepEqual([s.panes[0].seriesId, s.panes[0].unfused, s.fusionId], [ct.id, false, pet.id]);
  check('A fused PET/CT compared with an earlier CT keeps its fusion, and Undo keeps it too');

  // With the earlier study's PET loaded as well, the two are PET studies: Layout offers the PET follow-up, not the comparison.
  await privileged.importPaths(desktop, page, [path.join(folder, 'prior', 'S02')]);
  await listed(4);
  await settled();
  for (const id of [ct.id, pet.id]) {
    await open(id);
    await layoutMenu();
    assert.equal(await page.locator('[data-action="layout-pet-follow-up"]').count(), 1);
    assert.equal(await page.locator('[data-action="layout-compare"]').count(), 0);
  }
  check('Between two PET studies Layout offers the PET follow-up, not the comparison');
}

async function main() {
  if (process.argv.length < 4) throw new Error('usage: node tools/check-comparison.cjs COMPARISON_STUDIES PET_FOLLOWUP [OUTPUT_DIR]');
  const studies = path.resolve(process.argv[2]), followUp = path.resolve(process.argv[3]);
  const output = path.resolve(process.argv[4] || 'test-results/comparison');
  const manifest = JSON.parse(await fs.readFile(path.join(studies, 'manifest.json'), 'utf8'));
  assert.equal(manifest.generator, 'veacom-comparison-v1', 'Run on the studies made by tools/fixtures/make-comparison-studies.mjs.');
  const petManifest = JSON.parse(await fs.readFile(path.join(followUp, 'manifest.json'), 'utf8'));
  assert.equal(petManifest.generator, 'veacom-pet-followup-v2', 'Run on the follow-up made by tools/fixtures/make-pet-followup.mjs.');
  await fs.mkdir(output, { recursive: true });
  let failure;
  try {
    await withDesktop(studies, output, kit => compareStudies(manifest, kit));
    await withDesktop(path.join(followUp, 'current'), output, kit => petStudies(followUp, kit));
  } catch (error) { failure = error; }
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ passed: !failure, platform: process.platform, checks, error: failure?.stack }, null, 2));
  if (failure) throw failure;
  console.log(`All ${checks.length} comparison checks passed.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
