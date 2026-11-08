// Desktop check of the PET reading kit on the synthetic PET/CT of tools/fixtures/make-petct-study.mjs: the value under the
// pointer in every pane of the PET/CT screen (CT in HU, PET in SUV, both on the fused pane, the hottest voxel on a MIP's
// ray), read as a probe reads it and drawn without drawing the image again; it follows PET values (SUL) and the overlay
// switch. Then the PET acquisition panel in the inspector's Findings: tracer, activity, times, uptake, patient, glucose.
// usage: node tools/check-pet-reading.cjs PETCT_STUDY [OUTPUT_DIR]
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const os = require('node:os');
const { ignoreOutsideInput } = require('./lib/outside-input.cjs');

async function main() {
  const study = path.resolve(process.argv[2]);
  const output = path.resolve(process.argv[3] || 'test-results/pet-reading');
  const manifest = JSON.parse(await fs.readFile(path.join(study, 'manifest.json'), 'utf8'));
  assert.equal(manifest.generator, 'veacom-petct-v1', 'Run on the study made by tools/fixtures/make-petct-study.mjs.');
  assert(manifest.pet, 'The study records its tracer fields (tools/fixtures/make-petct-study.mjs).');
  await fs.mkdir(output, { recursive: true });
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'veacom-pet-reading-'));
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
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="viewport-cell"]')].every(cell => !cell.dataset.seriesId || cell.dataset.volumeComplete === 'true'), undefined, { timeout: 120_000 });
    await page.waitForTimeout(600);
    const shot = name => page.screenshot({ path: path.join(output, `${name}.png`) });
    const cells = page.locator('[data-testid="viewport-cell"]');
    const s = await page.evaluate(() => window.__VEACOM_TEST__.state());
    assert.deepEqual(s.panes.map(pane => pane.projection), [null, null, null, 'mip'], 'The PET/CT screen: CT · PET · fused · MIP.');

    // The panes go to the right lung nodule by a click on it in the MIP (as tools/check-arrangements.cjs does).
    const mip = cells.nth(3).locator('canvas[data-renderer]'), box = await mip.boundingBox();
    const scale = Math.min(box.width / (96 * 5.2), box.height / (90 * 4));
    await mip.click({ position: { x: box.width / 2 - 82 * scale, y: box.height / 2 + (-178 + 96) * scale } });
    await page.waitForFunction(() => document.querySelectorAll('[data-crosshair-marker]').length >= 4, undefined, { timeout: 60_000 });
    await page.waitForTimeout(400);
    /** Where the linked point is drawn in pane `index`: the nodule's hottest voxel. */
    const marker = async index => { const b = await cells.nth(index).locator('[data-crosshair-marker]').boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2]; };
    const lines = index => cells.nth(index).locator('[data-testid="pointer-readout"] text').allTextContents();
    /** Moves the pointer to (x, y) and waits for pane `index` to show lines matching `pattern`. */
    const hover = async (index, [x, y], pattern) => {
      await page.mouse.move(x, y, { steps: 2 });
      for (let tries = 0; tries < 50; tries++) {
        const shown = await lines(index);
        if (pattern.test(shown.join('\n'))) return shown;
        await page.waitForTimeout(50);
      }
      throw new Error(`Pane ${index + 1} shows ${JSON.stringify(await lines(index))}, not ${pattern}`);
    };
    const number = line => Number(/(-?\d+\.\d+) /.exec(line)[1]);

    // PET: its value in SUVbw, two decimals; the nodule (SUV 9, blurred) reads hot.
    const petAt = await marker(1);
    const [pet] = await hover(1, petAt, /^PET -?\d+\.\d\d SUVbw$/);
    assert(number(pet) > 5 && number(pet) < 10.5, `The nodule's hottest voxel reads ${pet}.`);
    assert.deepEqual(await lines(0), [], 'Only the pane under the pointer shows a value.');
    // CT: HU, one decimal (the nodule is about 30 HU).
    const [ct] = await hover(0, await marker(0), /^CT -?\d+\.\d HU$/);
    assert(Math.abs(number(ct) - 30) <= 20, `The nodule reads ${ct} on the CT.`);
    assert.deepEqual(await lines(1), [], 'Leaving a pane clears its value.');
    // Fused: the CT's value, then the PET's at the same point (the PET pane's own reading).
    const fused = await hover(2, await marker(2), /^CT -?\d+\.\d HU\nPET -?\d+\.\d\d SUVbw$/);
    assert.equal(fused[1], pet, 'The fused pane gives the PET value the PET pane gives at that point.');
    // MIP: the hottest voxel on the pointer's ray, at least the nodule's.
    const [ray] = await hover(3, await marker(3), /^PET ray voxel max -?\d+\.\d\d SUVbw$/);
    assert(number(ray) >= number(pet) - 1e-9, `The MIP's ray reads ${ray}, the nodule ${pet}.`);
    // Use the keyboard so the pointer stays on the same voxel while the language changes.
    const language = async lang => {
      await page.getByTestId('tool-language').press('Enter');
      await page.getByTestId(`language-${lang}`).press('Enter');
    };
    await language('tr');
    await cells.nth(3).getByText(/PET ışın boyunca voksel maks/).waitFor();
    await language('en');
    await cells.nth(3).getByText(ray, { exact: true }).waitFor();
    await page.mouse.move(...await marker(2), { steps: 2 });
    await hover(2, await marker(2), /SUVbw$/);
    await shot('1-readout-fused');
    check('Every pane gives the value under the pointer in its own quantity: HU, SUVbw, both when fused, the MIP ray\'s hottest voxel', { pet, ct, fused, ray });

    // Read as the probe reads it: a probe placed at the same point says the same.
    await page.evaluate(() => window.__VEACOM_TEST__.setTool('probe'));
    await page.mouse.click(...petAt);
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="viewport-cell"]')[1].querySelector('.annotation-label text'), undefined, { timeout: 10_000 });
    const probe = (await cells.nth(1).locator('.annotation-label text').textContent()).trim();
    assert.equal(`PET ${probe}`, (await hover(1, petAt, /^PET /))[0], 'The probe and the readout read the same voxel.');
    await page.keyboard.press('Delete');
    await page.evaluate(() => window.__VEACOM_TEST__.setTool('scroll'));
    check('The readout reads the voxel a probe reads', { probe });

    // Moving over the image draws only the readout: no frame of the image is drawn again.
    await page.waitForTimeout(500);
    const frames = await page.evaluate(() => { window.__petReadingFrames = 0; document.addEventListener('veacom:frame', () => { window.__petReadingFrames++; }); return window.__petReadingFrames; });
    const shown = new Set();
    for (let step = 0; step < 12; step++) {
      await page.mouse.move(petAt[0] - 60 + step * 10, petAt[1] + step * 4);
      await page.waitForTimeout(30);
      shown.add((await lines(1)).join(' | '));
    }
    assert(shown.size > 2, `The value follows the pointer: ${[...shown].join(', ')}`);
    assert.equal(await page.evaluate(() => window.__petReadingFrames), frames, 'No image frame is drawn while the pointer moves.');
    // Paged under a still pointer, the value follows the slice, and comes back with it.
    const [before] = await hover(1, petAt, /^PET /);
    const originalSlice = await cells.nth(1).locator('canvas').getAttribute('data-slice');
    const page4 = async delta => { for (let step = 0; step < 4; step++) { await page.mouse.wheel(0, delta); await page.waitForTimeout(60); } };
    const waitForReading = returned => page.waitForFunction(({ originalSlice, before, returned }) => {
      const cell = document.querySelectorAll('[data-testid="viewport-cell"]')[1];
      const slice = cell.querySelector('canvas').dataset.slice;
      const reading = cell.querySelector('[data-testid="pointer-readout"] text')?.textContent;
      return /^PET /.test(reading ?? '') && (returned ? slice === originalSlice && reading === before : slice !== originalSlice && reading !== before);
    }, { originalSlice, before, returned });
    await page4(100);
    await waitForReading(false);
    await page4(-100);
    await waitForReading(true);
    check('The readout follows the pointer and the slice without drawing the image again', { values: shown.size });

    // PET values: SUL (the fixture records height and sex) reads in SUL on the PET and the fused pane.
    await page.mouse.move(...await marker(2));
    if (!await page.getByTestId('inspector-tab-display').isVisible()) await page.getByTestId('tool-inspector').click();
    await page.getByTestId('inspector-tab-display').click();
    if (await page.locator('#section-units-toggle').getAttribute('aria-expanded') !== 'true') await page.locator('#section-units-toggle').click();
    await page.locator('[data-action="pet-values"]').selectOption('lbm');
    const sul = await hover(2, await marker(2), /^CT -?\d+\.\d HU\nPET -?\d+\.\d\d SUL$/);
    assert(number(sul[1]) < number(fused[1]), 'SUL is below SUVbw for this patient.');
    await page.locator('[data-action="pet-values"]').selectOption('bw');
    await hover(2, await marker(2), /SUVbw$/);
    check('The readout follows PET values: SUL when chosen', { sul: sul[1] });

    // The overlay switch takes the readout with it; hiding patient data leaves it (a value identifies no one).
    await page.getByTestId('tool-overlay').click();
    await page.mouse.move(...await marker(2));
    await page.waitForTimeout(200);
    assert.equal(await cells.nth(2).locator('[data-testid="pointer-readout"]').count(), 0, 'No readout without the overlay.');
    await page.getByTestId('tool-overlay').click();
    await hover(2, await marker(2), /SUVbw$/);
    assert.equal(await cells.nth(2).locator('[data-testid="pointer-readout"][data-export-exclude]').count(), 1, 'Exports leave the readout out.');
    check('The overlay switch shows and hides the readout, and exports leave it out');

    // The PET acquisition panel, under the series details in Findings, for the PET pane and for the fused CT pane.
    await page.mouse.move(5, 5);
    await page.getByTestId('inspector-tab-measurements').click();
    // A pane is made the active one by focus, as the keyboard does: no click on the image.
    const activate = index => cells.nth(index).getByTestId('dicom-viewport').focus();
    await activate(1);
    const panel = page.getByTestId('pet-acquisition');
    await panel.waitFor();
    const row = key => panel.locator(`[data-pet-row="${key}"]`).textContent();
    const rows = Object.fromEntries(await Promise.all(['tracer', 'activity', 'injection', 'scanStart', 'uptake', 'weight', 'height', 'glucose'].map(async key => [key, await row(key)])));
    assert.deepEqual(rows, { tracer: 'Fludeoxyglucose F¹⁸', activity: `${manifest.suv.doseBq / 1e6} MBq (5.41 mCi)`, injection: '11:00', scanStart: '12:00',
      uptake: `${manifest.pet.uptakeMinutes} min`, weight: `${manifest.suv.weightKg} kg`, height: `${manifest.pet.heightM} m`, glucose: `${manifest.pet.glucoseMmol} mmol/l (97 mg/dl)` });
    assert.equal(await page.getByTestId('pet-flags').count(), 0, 'Nothing to check: a 60 min FDG uptake with weight, activity and times.');
    await panel.scrollIntoViewIfNeeded();
    await shot('2-acquisition-panel');
    await activate(0);
    await page.waitForTimeout(200);
    assert.equal(await row('uptake'), '60 min', 'The CT pane of the PET/CT shows its PET.');
    await language('tr');
    await panel.getByText('60 dk', { exact: true }).waitFor();
    await language('en');
    await panel.getByText('60 min', { exact: true }).waitFor();
    check('The Findings tab shows the PET acquisition: tracer, activity, times, uptake, weight, height, glucose', rows);

    assert.deepEqual(errors, [], 'No page errors.');
    await fs.writeFile(path.join(output, 'pet-reading-checks.json'), JSON.stringify({ checks, errors }, null, 2));
    console.log(`All ${checks.length} PET reading checks passed.`);
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    await fs.writeFile(path.join(output, 'pet-reading-checks.json'), JSON.stringify({ checks, errors, failure: String(error.stack || error) }, null, 2));
    throw error;
  } finally {
    await desktop.close().catch(() => {});
    await fs.rm(userData, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
