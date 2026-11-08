// Desktop check of arrangements (docs/arrangements.md) on the synthetic PET/CT of tools/fixtures/make-petct-study.mjs:
// the study opens as any other, in one pane; the nuclear medicine screen in the fusion button's menu lays it out as
// CT · PET · fused · MIP with a note naming it; a click on the MIP sends the linked panes to the lesion; a pane moved
// and kept makes the next screen open so; Undo puts back the screen from before; Forget brings VEAcom's own screen
// back; a PET opened by hand is inverted grey with its window in SUV.
// usage: node tools/check-arrangements.cjs PETCT_STUDY [OUTPUT_DIR]
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const os = require('node:os');
const privileged = require('./privileged-imaging.cjs');
const { ignoreOutsideInput } = require('./lib/outside-input.cjs');

async function main() {
  const study = path.resolve(process.argv[2]);
  const output = path.resolve(process.argv[3] || 'test-results/arrangements');
  const manifest = JSON.parse(await fs.readFile(path.join(study, 'manifest.json'), 'utf8'));
  assert.equal(manifest.generator, 'veacom-petct-v1', 'Run on the study made by tools/fixtures/make-petct-study.mjs.');
  await fs.mkdir(output, { recursive: true });
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'veacom-arrangements-'));
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
    const state = () => page.evaluate(() => window.__VEACOM_TEST__.state());
    const settled = async () => {
      await page.waitForFunction(() => window.__VEACOM_TEST__?.state().fullVolumeLoaded && window.__VEACOM_TEST__.state().pendingLoads === 0, undefined, { timeout: 120_000 });
      await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="viewport-cell"]')].every(cell => !cell.dataset.seriesId || cell.dataset.volumeComplete === 'true'), undefined, { timeout: 120_000 });
      await page.waitForTimeout(600);
    };
    const shot = name => page.screenshot({ path: path.join(output, `${name}.png`) });
    const cells = page.locator('[data-testid="viewport-cell"]');
    const notice = () => page.locator('.pane-toast').allTextContents();
    const reopen = async () => { await privileged.importPaths(desktop, page, [study]); await settled(); };
    const named = (s, pattern) => s.series.find(item => pattern.test(item.description));
    const location = async index => Number((await cells.nth(index).locator('[data-testid="image-overlay"] .slice-detail').textContent()).match(/Loc: (-?[\d.]+)/)?.[1]);
    const actionIds = async () => (await page.evaluate(() => window.__VEACOM_TEST__.usage())).filter(event => event.name === 'ux.action').map(event => event.attributes?.['veacom.action']);
    // The nuclear medicine screen, asked for in the menu beside the fusion button.
    const openScreen = async () => {
      await page.getByTestId('tool-fusion-menu').click();
      await page.locator('[data-action="nm-screen"]').click();
      await page.locator('[data-action="arrangement-undo"]').waitFor();
      await settled();
    };
    await settled();

    // Opening: one pane, as any study opens, with nothing arranged and no note.
    let s = await state();
    const ct = named(s, /· CT$/), pet = named(s, /PET AC$/);
    assert.deepEqual(s.layout, [1, 1], 'A PET/CT opens as any other study.');
    assert.equal(s.fusionId, null);
    assert.deepEqual(await notice(), []);
    await shot('0-opened-plain');
    check('A PET/CT opens in one pane, as any other study does');

    // The nuclear medicine screen from the fusion button's menu: CT · PET · fused · MIP, with the attenuation-corrected PET.
    await page.getByTestId('tool-fusion-menu').click();
    assert.match(await page.locator('[data-action="nm-screen"]').textContent(), /Nuclear medicine screen\s*PET\/CT/);
    await shot('1-fusion-menu');
    await page.locator('[data-action="nm-screen"]').click();
    await page.waitForFunction(() => window.__VEACOM_TEST__.state().panes.length === 4);
    await settled();
    s = await state();
    assert.deepEqual(s.layout, [2, 2]);
    assert.deepEqual(s.panes.map(pane => pane.seriesId), [ct.id, pet.id, ct.id, pet.id]);
    assert.deepEqual(s.panes.map(pane => pane.projection), [null, null, null, 'mip']);
    assert.deepEqual(s.panes.map(pane => pane.unfused), [true, true, false, true], 'Only the third pane shows the fusion.');
    assert.deepEqual(s.panes.map(pane => pane.inverted), [false, true, false, true], 'PET panes are inverted grey.');
    assert.equal(s.fusionId, pet.id);
    assert.equal(s.linked, true);
    assert.equal(new Set(s.panes.slice(0, 3).map(pane => pane.slice)).size, 1, 'The axial panes open at one place.');
    assert.deepEqual(await notice(), ['PET/CT: CT · PET · fusion · MIPUndo']);
    assert.match(await cells.nth(1).locator('[data-testid="image-overlay"]').textContent(), /SUV 0–5/);
    assert.match(await cells.nth(3).locator('[data-testid="image-overlay"]').textContent(), /MIP · 0°/);
    assert.deepEqual((await actionIds()).slice(-2), ['tool-fusion-menu', 'nm-screen']);
    await shot('2-screen');
    check('The nuclear medicine screen lays a PET/CT out as CT · PET · fused · MIP, linked, with a note naming it', { panes: s.panes.length });

    // A click on the lung nodule in the MIP: the axial panes go to it (-96 mm), the MIP keeps its turn.
    const box = await cells.nth(3).locator('canvas[data-renderer]').boundingBox();
    const scale = Math.min(box.width / (96 * 5.2), box.height / (90 * 4));
    await cells.nth(3).locator('canvas[data-renderer]').click({ position: { x: box.width / 2 - 82 * scale, y: box.height / 2 + (-178 + 96) * scale } });
    await page.waitForFunction(() => new Set(window.__VEACOM_TEST__.state().panes.slice(0, 3).map(pane => pane.slice)).size === 1
      && window.__VEACOM_TEST__.state().panes[3].slice === 0 && document.querySelectorAll('[data-crosshair-marker]').length >= 3, undefined, { timeout: 120_000 });
    await page.waitForTimeout(400);
    for (const index of [0, 1, 2]) assert(Math.abs(await location(index) + 96) <= 4, `Pane ${index + 1} is at the nodule.`);
    assert.deepEqual(await notice(), [], 'The note goes with the first action.');
    await shot('2-mip-click');
    check('A click on the MIP sends the linked panes to the hottest voxel there', { location: await location(0) });

    // The PET pane moved onto the CT pane by its grip: Keep this keeps the order for the next PET/CT screen.
    await cells.nth(1).getByTestId('viewport-move').dragTo(cells.nth(0).locator('canvas[data-renderer]'));
    await page.locator('[data-action="arrangement-keep"]').waitFor();
    assert.match((await notice()).join(' '), /Always open the PET\/CT screen like this\?/);
    await shot('3-keep-offer');
    await page.locator('[data-action="arrangement-keep"]').click();
    const stored = JSON.parse(await page.evaluate(() => localStorage.getItem('veacom:arrangements:v1')));
    assert.deepEqual(stored['pet-ct'].panes.map(pane => [pane.role, pane.show]), [['pet', 'plain'], ['ct', 'plain'], ['ct', 'fused'], ['pet', 'mip']]);
    assert.deepEqual(stored['pet-ct'].panes[0].display.window, { unit: 'SUV', from: 0, to: 5 });

    // Undo puts back the screen from before: one pane here, with what it showed. Nothing is offered to keep, since the
    // screen opens only when asked for.
    await page.getByTestId('tool-layout').click();
    await page.locator('[data-action="layout-1x1"]').click();
    await page.waitForFunction(() => window.__VEACOM_TEST__.state().panes.length === 1);
    await reopen();
    s = await state();
    assert.equal(s.panes.length, 1, 'Opened again, the study stays in one pane.');
    const shownBefore = s.panes[0].seriesId;
    await openScreen();
    s = await state();
    assert.deepEqual(s.panes.map(pane => pane.seriesId), [pet.id, ct.id, ct.id, pet.id], 'The kept screen opens as kept.');
    assert.deepEqual(await notice(), ['Your PET/CT layoutUndo']);
    await shot('4-kept-screen');
    check('A pane moved and kept: the next nuclear medicine screen opens so', { stored: stored['pet-ct'].panes.length });
    await page.locator('[data-action="arrangement-undo"]').click();
    await page.waitForFunction(id => { const s = window.__VEACOM_TEST__.state(); return s.panes.length === 1 && s.panes[0].seriesId === id; }, shownBefore);
    assert.deepEqual(await notice(), ['PET/CT layout undone']);
    assert.equal(await page.locator('[data-action="arrangement-keep-plain"]').count(), 0);
    assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem('veacom:arrangements:v1')))['pet-ct'].panes.length, 4, 'Undo keeps the kept screen.');
    await shot('5-undone');
    check('Undo puts back the screen from before, with what it showed');

    // A PET opened by hand: inverted grey, its window in SUV.
    await page.locator(`[data-testid="series-${pet.id}"]`).click();
    await page.waitForFunction(id => document.querySelector('.viewport-cell.is-active canvas[data-renderer]')?.dataset.seriesId === id, pet.id);
    await settled();
    assert.equal((await state()).panes[0].inverted, true);
    assert.match(await cells.nth(0).locator('[data-testid="image-overlay"]').textContent(), /SUV 0–5/);
    await shot('6-pet-alone');
    check('A PET opened by hand is inverted grey with its window in SUV');

    // Forget: VEAcom's own PET/CT screen again.
    if (!await page.getByTestId('inspector-tab-display').isVisible()) await page.getByTestId('tool-inspector').click();
    await page.getByTestId('inspector-tab-display').click();
    if (await page.locator('#section-workspace-toggle').getAttribute('aria-expanded') !== 'true') await page.locator('#section-workspace-toggle').click();
    await page.locator('[data-action="arrangement-forget"]').scrollIntoViewIfNeeded();
    await shot('7-workspace-kept');
    await page.locator('[data-action="arrangement-forget"]').click();
    assert.equal(await page.evaluate(() => localStorage.getItem('veacom:arrangements:v1')), '{}');
    await openScreen();
    s = await state();
    assert.deepEqual(s.panes.map(pane => pane.seriesId), [ct.id, pet.id, ct.id, pet.id]);
    check('Forget brings VEAcom\'s own PET/CT screen back');

    // Paged while its PET is read again (a preview frame stands in for it), the MIP stays a MIP.
    await privileged.importPaths(desktop, page, [study]);
    const mipBox = await cells.nth(3).boundingBox();
    await page.mouse.move(mipBox.x + mipBox.width / 2, mipBox.y + mipBox.height / 2);
    for (let step = 0; step < 6; step++) { await page.mouse.wheel(0, 100); await page.waitForTimeout(30); }
    await settled();
    s = await state();
    assert.equal(s.panes[3].projection, 'mip');
    assert.equal(s.panes[3].mode, 'mpr', 'The MIP pane is still a reconstruction.');
    assert.match(await cells.nth(3).locator('[data-testid="image-overlay"]').textContent(), /MIP · \d+°/);
    check('A MIP paged while its volume loads stays a MIP', { turn: s.panes[3].slice });

    assert.deepEqual(errors, [], 'No page errors.');
    await fs.writeFile(path.join(output, 'arrangement-checks.json'), JSON.stringify({ checks, errors }, null, 2));
    console.log(`All ${checks.length} arrangement checks passed.`);
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    await fs.writeFile(path.join(output, 'arrangement-checks.json'), JSON.stringify({ checks, errors, failure: String(error.stack || error) }, null, 2));
    throw error;
  } finally {
    await desktop.close().catch(() => {});
    await fs.rm(userData, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
