// Desktop check of PET quantification (docs/pet-quantification.md) on the current study of the synthetic follow-up from
// tools/fixtures/make-pet-followup.mjs, whose PET has no noise, so every value is known:
// - a sphere VOI dragged on the lung lesion gives its SUVmax, SUVpeak, mean and volume, in the image and in the list;
// - spheres marked as the liver and blood pool references (the liver made 3 cm across) give the lesion's Deauville
//   suggestion and its basis, which the reader confirms;
// - the same sphere drawn on the fused CT also gives the PET's values;
// - at 41% of its SUVmax the lesion gives MTV and TLG, drawn as the voxels it counts, and the lesion table lists it;
// - in a new session on the same computer, the study's references and lesion table come back;
// - opened after its prior, the study lays out as the PET follow-up screen; linked by hand, the two page together, and
//   the lesion table gives each value's change against the prior's lesion selected by the reader, live and as kept;
// - the prior was scanned 72 min after its injection, 12 min more than this study, on another scanner with another
//   reconstruction (EANM 2025, Supplemental File 3): every change is marked, and the table and the acquisition panel
//   say why, live and as kept; the box saying why has a dismiss button, which hides it in both and keeps the marks;
// - Copy for the report puts the technique, the references, the lesion with its changes and the reasons on the
//   clipboard as text, in English and in Turkish, and says when the clipboard refuses it (on a clipboard in memory);
// - the follow-up screen keeps one SUV scale: SUV 0–10 on this study's PET is SUV 0–10 on the prior's;
// - in SUL, SULglu (EANM 2025, section 13) follows SUL in the table and the sphere's values: this study's with the
//   glucose in its file, and its change once the prior's glucose is typed, live and as kept.
// usage: node tools/check-pet-voi.cjs FOLLOWUP_DIR [OUTPUT_DIR]
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const path = require('node:path');
const assert = require('node:assert/strict');
const os = require('node:os');
const privileged = require('./privileged-imaging.cjs');
const { ignoreOutsideInput } = require('./lib/outside-input.cjs');
const { choosePetLayout } = require('./lib/pet-layout.cjs');

async function main() {
  const root = path.resolve(process.argv[2]);
  const output = path.resolve(process.argv[3] || 'test-results/pet-voi');
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
  assert.equal(manifest.generator, 'veacom-pet-followup-v2', 'Run on the studies made by tools/fixtures/make-pet-followup.mjs.');
  const current = manifest.studies.find(study => study.name === 'current'), study = path.join(root, current.folder);
  const prior = manifest.studies.find(study => study.name === 'prior'), priorStudy = path.join(root, prior.folder);
  const petGrid = current.series.find(series => series.modality === 'PT'), priorGrid = prior.series.find(series => series.modality === 'PT');
  const [lesion] = current.lesions, [priorLesion] = prior.lesions;
  // The lesion's voxels on the PET grid: MTV at 41% of its SUVmax counts exactly these (the lung around it is far lower).
  const lesionVoxels = (() => {
    let count = 0;
    const [nx, ny, nz] = petGrid.dimensions, [sx, sy, sz] = petGrid.spacing, [ox, oy] = petGrid.origin;
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      if (Math.hypot(ox + i * sx - lesion.center[0], oy + j * sy - lesion.center[1], -k * sz - lesion.center[2]) <= lesion.radius) count++;
    }
    return count;
  })();
  const mtv = lesionVoxels * petGrid.spacing.reduce((volume, side) => volume * side, 1) / 1000;
  await fs.mkdir(output, { recursive: true });
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'veacom-pet-voi-'));
  const errors = [], checks = [];
  const check = (name, detail) => { checks.push({ name, detail }); console.log(`PASS ${name}`); };
  let desktop, page;

  const launch = async (opened = study) => {
    desktop = await electron.launch({ args: [path.resolve(__dirname, '..'), '--study', opened], timeout: 90_000,
      env: { ...process.env, VEACOM_USER_DATA: userData, VEACOM_LOCALE: 'en', VEACOM_TELEMETRY_CONSENT: 'denied', VEACOM_USAGE_CHECK_LOCAL: '1', VEACOM_TEST_MODE: '1' } });
    page = await desktop.firstWindow();
    // Keep the person at the machine from typing into the window or clicking it, and keep it drawing while covered.
    await ignoreOutsideInput(desktop);
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await settled();
    await choosePetLayout(page);
  };
  const state = () => page.evaluate(() => window.__VEACOM_TEST__.state());
  const settled = async () => {
    await page.waitForFunction(() => window.__VEACOM_TEST__?.state().fullVolumeLoaded && window.__VEACOM_TEST__.state().pendingLoads === 0, undefined, { timeout: 120_000 });
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="viewport-cell"]')].every(cell => !cell.dataset.seriesId || cell.dataset.volumeComplete === 'true'), undefined, { timeout: 120_000 });
    await page.waitForTimeout(600);
  };
  const shot = name => page.screenshot({ path: path.join(output, `${name}.png`) });
  const cells = () => page.locator('[data-testid="viewport-cell"]');
  const canvas = index => cells().nth(index).locator('canvas[data-renderer]');
  const location = async index => Number((await cells().nth(index).locator('[data-testid="image-overlay"] .slice-detail').textContent()).match(/Loc: (-?[\d.]+)/)?.[1]);
  /** Makes pane `index` the active one with a click in its top left corner, where no tool does anything. */
  const activate = async index => {
    if (await cells().nth(index).evaluate(cell => cell.classList.contains('is-active'))) return;
    await canvas(index).click({ position: { x: 24, y: 70 } });
    await page.waitForFunction(i => document.querySelectorAll('[data-testid="viewport-cell"]')[i]?.classList.contains('is-active'), index);
  };
  /** Pages the active pane (and the panes linked to it) to the axial slice at `z`, whichever way its slices run. */
  const goTo = async (index, z, grid = petGrid) => {
    const step = grid.spacing[2], k = Math.round(-z / step), last = grid.dimensions[2] - 1;
    for (const slice of [k, last - k]) {
      await page.evaluate(slice => window.__VEACOM_TEST__.setView({ slice }), slice);
      await page.waitForFunction(([i, slice]) => document.querySelectorAll('[data-testid="viewport-cell"]')[i]?.querySelector('canvas[data-renderer]')?.dataset.slice === String(slice), [index, slice]);
      await page.waitForTimeout(250);
      if (Math.abs(await location(index) - z) <= step / 2) return;
    }
    throw new Error(`Pane ${index + 1} did not reach z = ${z}.`);
  };
  /** The screen point of patient point (x, y) in an axial pane at its first zoom: the image fills the pane, centred. */
  const screenPoint = async (index, [x, y]) => {
    const box = await canvas(index).boundingBox(), size = petGrid.dimensions[0] * petGrid.spacing[0];
    const scale = Math.min(box.width / size, box.height / size);
    return { x: box.x + box.width / 2 + x * scale, y: box.y + box.height / 2 + y * scale, scale };
  };
  /** Drags a sphere in pane `index` from patient point `center` out `radius` mm to the right. */
  const drawSphere = async (index, center, radius) => {
    const at = await screenPoint(index, center);
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await page.mouse.move(at.x + radius * at.scale, at.y, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(400);
  };
  // A label's lines, and a row's values, as the summary reads: parts joined by " · ".
  const labels = index => cells().nth(index).locator('[data-testid="annotation-overlay"] [data-annotation-id] .annotation-label')
    .evaluateAll(nodes => nodes.map(node => [...node.querySelectorAll('tspan')].map(line => line.textContent).join(' · ')));
  const rows = () => page.locator('[data-annotation-row]');
  const values = index => rows().nth(index).locator('.annotation-values').evaluate(node => [...node.children].map(part => part.textContent).join(' · '));
  const openFindings = async () => {
    if (!await page.getByTestId('inspector-tab-measurements').isVisible()) await page.getByTestId('tool-inspector').click();
    await page.getByTestId('inspector-tab-measurements').click();
  };
  const chooseSphere = async () => {
    await page.getByTestId('tool-measure-menu').click();
    await page.getByRole('menuitemradio', { name: /Sphere VOI/ }).click();
  };
  /** The lesion table's cells for a lesion: each value with its change under it. */
  const tableRow = name => page.locator(`[data-lesion-table] tr[data-lesion="${name}"] td`).evaluateAll(cells => cells.map(cell => [cell.firstChild?.textContent ?? '', cell.querySelector('small')?.textContent ?? '']));
  /** The SULglu row under a lesion: max and peak, each with its change. */
  const sulGluRow = name => page.locator(`[data-lesion-table] tr[data-lesion-sulglu="${name}"] td`).evaluateAll(cells => cells.slice(0, 2).map(cell => [cell.firstChild?.textContent ?? '', cell.querySelector('small')?.textContent ?? '']));
  /** Shows PET values in SUVbw (bw) or SUL (lbm), as the Units panel sets them, and comes back to Findings. */
  const showPetValues = async value => {
    await page.getByTestId('inspector-tab-display').click();
    const toggle = page.locator('#section-units-toggle');
    if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
    await page.locator('select[data-action="pet-values"]').selectOption(value);
    await page.getByTestId('inspector-tab-measurements').click();
  };
  const panelRow = key => page.getByTestId('pet-acquisition').locator(`[data-pet-row="${key}"]`).textContent();
  const priorRow = key => page.getByTestId('pet-prior').locator(`[data-prior-row="${key}"]`).evaluate(node => node.firstChild?.textContent ?? '');
  // What limits the comparison with the prior, as the table and the panel say it.
  const flagged = ['Uptake differs by 12 min from 01.10.1999. EANM limit 10 min.',
    'Scanner model differs from 01.10.1999.',
    'Reconstruction differs from 01.10.1999.'];
  // SUL per SUVbw for the fixture's man (Janmahasatian lean body mass, as EANM 2025 gives it), and SULglu with 5.0 mmol/l.
  const sulPerBw = 9270 / (6680 + 216 * manifest.suv.weightKg / manifest.suv.heightM ** 2);
  const typedPrior = 10.9, nowSul = 7 * sulPerBw, priorSul = 10 * sulPerBw;
  const nowGlu = nowSul * current.pet.glucoseMmol / 5, priorGlu = priorSul * typedPrior / 5;
  const volumeText = millilitres => millilitres.toFixed(millilitres < 10 ? 2 : 1);

  try {
    // A prior can be useful even if no reference or lesion was ever drawn on it.
    await launch(priorStudy);
    await page.waitForFunction(() => Object.values(JSON.parse(localStorage.getItem('veacom:pet-studies:v1') ?? '{}'))
      .some(study => Object.values(study.series).some(series => series.acquisition && !series.lesions)));
    await desktop.close();
    await launch();
    let s = await state();
    const ct = s.series.find(item => item.modality === 'CT'), pet = s.series.find(item => item.modality === 'PT');
    assert.deepEqual(s.panes.map(pane => pane.seriesId), [ct.id, pet.id, ct.id, pet.id], 'The follow-up opens as the PET/CT screen.');

    // The lung lesion: a sphere dragged 20 mm out from its centre on the PET.
    await activate(1);
    await goTo(1, lesion.center[2]);
    await chooseSphere();
    await drawSphere(1, lesion.center, 20);
    let label = (await labels(1)).join(' ');
    const lesionValues = new RegExp(`SUVbw max ${lesion.suv.toFixed(2)} · SUVpeak ${lesion.suv.toFixed(2)} · mean [\\d.]+ · ([\\d.]+) mL · ⌀ ([\\d.]+) mm`);
    const [, volume, diameter] = label.match(lesionValues) ?? assert.fail(`The sphere reads its SUVmax and SUVpeak: ${label}`);
    assert(Math.abs(Number(diameter) - 40) <= 1, `A 20 mm radius is 40 mm across: ${diameter}`);
    assert(Math.abs(Number(volume) - 4 / 3 * Math.PI * (Number(diameter) / 2) ** 3 / 1000) < 0.2, `Its volume is the sphere's: ${volume} mL`);
    // Through the volume: the MIP pane of the same PET shows it too.
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="viewport-cell"]')[3]?.querySelectorAll('[data-annotation-id]').length === 1);
    await openFindings();
    assert.equal(await rows().count(), 1);
    assert.match(await values(0), lesionValues);
    const peakCircle = cells().nth(1).locator('[data-peak-sphere]');
    for (const dz of [-4, 4, -8, 8, -12, 12]) {
      if (await peakCircle.count()) break;
      await goTo(1, lesion.center[2] + dz);
    }
    assert.equal(await peakCircle.count(), 1, 'A slice through the sampled 1 cm³ sphere shows its outline.');
    await goTo(1, lesion.center[2]);
    assert.equal(await rows().nth(0).locator('[data-deauville="helper"]').count(), 0);
    await rows().nth(0).locator('[data-action="deauville-context"]').check();
    assert.match(await rows().nth(0).locator('[data-deauville="problem"]').textContent(), /Mark the liver and blood pool reference spheres/);
    await shot('1-lesion-sphere');
    check('A sphere dragged on the lesion gives SUVmax, SUVpeak, mean and volume, and shows on the MIP', { volume: Number(volume), diameter: Number(diameter) });

    // On a reconstructed coronal plane: away from the sphere nothing shows; its row sends the pane to its centre, where
    // it reads the same.
    const plane = () => page.evaluate(() => document.querySelectorAll('[data-testid="viewport-cell"]')[1]?.querySelector('canvas[data-renderer]')?.dataset.plane);
    await page.evaluate(() => window.__VEACOM_TEST__.setView({ mode: 'mpr', plane: 'coronal', oblique: [0, 0], slice: 0 }));
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="viewport-cell"]')[1]?.querySelector('canvas[data-renderer]')?.dataset.plane === 'coronal');
    await page.waitForTimeout(300);
    assert.deepEqual(await labels(1), [], 'The front of the body is far from the sphere.');
    await rows().nth(0).locator('[data-action="measurement-go"]').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="viewport-cell"]')[1]?.querySelectorAll('[data-annotation-id]').length === 1);
    assert.equal(await plane(), 'coronal');
    assert.match((await labels(1)).join(' '), lesionValues);
    await shot('1b-coronal');
    check('On a coronal reconstruction the sphere reads the same, and its row goes to it');
    await page.evaluate(() => window.__VEACOM_TEST__.setView({ mode: 'source', plane: 'axial', oblique: undefined }));
    await goTo(1, lesion.center[2]);

    // The liver reference: drawn small, then marked, it becomes a 3 cm sphere about its centre.
    const liverAt = [current.liver.center[0], current.liver.center[1], current.liver.center[2]];
    await goTo(1, liverAt[2]);
    await drawSphere(1, liverAt, 8);
    await rows().nth(1).locator('select[data-action="sphere-role"]').selectOption('liver');
    await page.waitForFunction(() => /⌀ 30\.0 mm/.test(document.querySelectorAll('[data-annotation-row]')[1]?.textContent ?? ''));
    assert.match(await values(1), /SUVbw max 2\.00 · SUVpeak 2\.00 · mean 2\.00 · 14\.1 mL · ⌀ 30\.0 mm/);
    assert.match((await labels(1)).join(' '), /^Liver reference · SUVbw max 2\.00/);
    // The blood pool reference, inside the descending aorta.
    await goTo(1, current.bloodPool.center[2]);
    await drawSphere(1, current.bloodPool.center, 6);
    await rows().nth(2).locator('select[data-action="sphere-role"]').selectOption('bloodPool');
    assert.match(await values(2), /SUVbw max 1\.50 · SUVpeak unavailable.* · mean 1\.50/);
    check('Spheres marked as the liver (3 cm) and blood pool references read 2.00 and 1.50');

    // The lesion's Deauville suggestion, with its basis, confirmed by the reader.
    const helper = rows().nth(0).locator('[data-deauville="helper"]');
    const ratio = (lesion.suv / current.liver.suv).toFixed(2);
    assert.equal(await helper.locator('[data-deauville="suggestion"]').textContent(), 'Suggests 5');
    assert.equal(await helper.locator('[data-deauville="basis"]').textContent(), `max ${lesion.suv.toFixed(2)} SUVbw = ${ratio} × liver max 2.00 (at least 2×)`);
    await helper.locator('[data-action="deauville-confirm"]').click();
    await page.waitForFunction(() => document.querySelector('[data-annotation-row] [data-deauville="helper"] strong')?.textContent === 'Deauville 5, confirmed');
    assert.equal(await helper.locator('select[data-action="deauville-score"]').inputValue(), '5');
    assert.equal(await helper.locator('[data-action="deauville-confirm"]').count(), 0, 'A confirmed score is not offered again.');
    await goTo(1, lesion.center[2]);
    assert.match((await labels(1)).join(' '), /· Deauville 5$/);
    await shot('2-deauville');
    check('The lesion\'s Deauville suggestion (5) shows its basis and is confirmed by the reader', { ratio });

    // On the fused CT the sphere measures the CT, and the PET's own voxels inside it.
    await activate(2);
    await drawSphere(2, lesion.center, 20);
    label = (await labels(2)).join(' ');
    assert.match(label, /^HU max/);
    assert.match(label, new RegExp(`PET SUVbw max ${lesion.suv.toFixed(2)}, SUVpeak ${lesion.suv.toFixed(2)}, mean`));
    await shot('3-fused-ct');
    check('A sphere on the fused CT also gives the PET\'s SUVmax and SUVpeak');

    // MTV and TLG at 41% of the lesion's SUVmax: exactly the lesion's voxels; drawn on its slices; in the lesion table.
    await activate(1);
    await goTo(1, lesion.center[2]);
    const nameField = rows().nth(0).locator('input[data-action="lesion-name"]');
    assert.equal(await nameField.inputValue(), 'L1');
    await nameField.fill('Discard'); await nameField.press('Escape');
    assert.equal(await nameField.inputValue(), 'L1');
    await nameField.fill('Target'); await nameField.press('Enter');
    await page.locator('[data-lesion-table] th[scope="row"]').filter({ hasText: 'Target' }).waitFor();
    await nameField.fill('L1'); await nameField.press('Enter');
    await rows().nth(0).locator('select[data-action="sphere-threshold"]').selectOption('max41');
    const metabolic = `MTV 41% ${volumeText(mtv)} mL · TLG ${(mtv * lesion.suv).toFixed(1)} SUVbw·mL`;
    await page.waitForFunction(text => document.querySelectorAll('[data-testid="viewport-cell"]')[1]?.querySelector('.annotation-label')?.textContent?.includes(text.split(' · ')[0]), metabolic);
    label = (await labels(1)).join(' ');
    assert(label.startsWith('L1 · SUVbw max 7.00') && label.includes(metabolic), `The lesion reads ${metabolic}: ${label}`);
    assert(await cells().nth(1).locator('[data-metabolic-volume] [data-metabolic]').count() > 0, 'The voxels counted are drawn.');
    assert.deepEqual((await tableRow('L1')).map(([value]) => value), ['7.00', '7.00', volumeText(mtv), (mtv * lesion.suv).toFixed(1), '5']);
    assert.match(await page.locator('[data-lesion-table] [data-lesion-prior]').textContent(), /No earlier study/);
    await shot('3b-mtv');
    check('At 41% of its SUVmax the lesion gives MTV and TLG, drawn and listed in the lesion table', { voxels: lesionVoxels, mtv });

    // What was kept, and how: digests only, no UID.
    const stored = await page.evaluate(() => localStorage.getItem('veacom:pet-studies:v1'));
    const records = JSON.parse(stored);
    assert.equal(Object.keys(records).length, 2);
    const record = Object.values(records).find(item => item.date === current.date), [kept] = Object.values(record.series);
    assert.equal(await priorRow('uptake'), `${prior.pet.uptakeMinutes} min`);
    assert.match(await page.getByTestId('pet-prior').locator('thead').textContent(), /Saved prior01.10.1999/);
    check('An unmarked prior keeps its acquisition for the next study');
    assert.match(Object.keys(records)[0], /^[0-9a-f]{64}$/);
    assert.deepEqual(Object.keys(kept.references).sort(), ['bloodPool', 'liver']);
    assert.equal(kept.references.liver.radius, 15);
    assert(!stored.includes('2.25.'), 'No UID is kept.');
    const actions = (await page.evaluate(() => window.__VEACOM_TEST__.usage())).filter(event => event.name === 'ux.action').map(event => event.attributes?.['veacom.action']);
    for (const id of ['draw-sphere', 'sphere-role', 'deauville-confirm', 'sphere-threshold']) assert(actions.includes(id), `${id} is recorded: ${[...new Set(actions)].join(', ')}`);
    assert(!actions.includes('other'), 'Every action has an id.');
    check('The references are kept by digest, and the actions are recorded by id', { actions: [...new Set(actions)] });

    // Reopen the same findings as an installation upgraded from the previous reconstruction keys.
    const { catalog } = await privileged.readCatalog(desktop);
    const selectedPet = catalog.series.find(series => series.id === pet.id);
    assert.ok(selectedPet.previousPetId && selectedPet.previousPetId !== pet.id);
    const digest = value => createHash('sha256').update(value).digest('hex');
    delete records[digest(JSON.stringify([selectedPet.patientKey, selectedPet.studyUid]))];
    const legacyStudy = digest(selectedPet.studyUid);
    const legacySeries = digest(JSON.stringify([selectedPet.uid, selectedPet.previousPetId]));
    records[legacyStudy] = { ...record, patient: digest(selectedPet.patientId.trim() + '\u0000' + selectedPet.patientName.trim().toUpperCase()), series: { [legacySeries]: kept } };
    await page.evaluate(records => localStorage.setItem('veacom:pet-studies:v1', JSON.stringify(records)), records);
    await desktop.close();

    // A new session on this computer: the references and the lesion table are back, the lesion with its name, threshold
    // and confirmed score.
    await launch();
    await openFindings();
    await activate(1);
    const recover = page.locator('[data-action="sphere-restore-references"]');
    await recover.waitFor();
    assert.equal(await rows().count(), 0, 'Prior measurements require confirmation');
    await recover.click();
    await page.waitForFunction(key => !JSON.parse(localStorage.getItem('veacom:pet-studies:v1'))[key], legacyStudy);
    check('An upgrade recovers the existing reconstruction only after the reader confirms it');
    await page.waitForFunction(() => document.querySelectorAll('[data-annotation-row]').length === 3);
    assert.deepEqual(await rows().locator('select[data-action="sphere-role"]').evaluateAll(selects => selects.map(select => select.value)), ['liver', 'bloodPool', 'lesion']);
    assert.equal(await rows().nth(2).locator('input[data-action="lesion-name"]').inputValue(), 'L1');
    assert.equal(await rows().nth(2).locator('select[data-action="sphere-threshold"]').inputValue(), 'max41');
    assert.equal(await rows().nth(2).locator('[data-deauville="helper"] strong').textContent(), 'Deauville 5, confirmed');
    assert.deepEqual((await tableRow('L1')).map(([value]) => value), ['7.00', '7.00', volumeText(mtv), (mtv * lesion.suv).toFixed(1), '5']);
    await goTo(1, lesion.center[2]);
    await shot('4-reopened');
    check('In a new session the study\'s references and lesion table come back');
    await desktop.close();

    // Opened after its prior: the PET follow-up screen, this study's PET and the prior's, each over its MIP.
    await launch(priorStudy);
    await privileged.importPaths(desktop, page, [study]);
    await settled();
    await choosePetLayout(page, 'arrangement.petFollowUp');
    s = await state();
    const now = s.series.find(item => item.modality === 'PT' && item.dimensions[2] === petGrid.dimensions[2]);
    const before = s.series.find(item => item.modality === 'PT' && item.dimensions[2] === priorGrid.dimensions[2]);
    assert.deepEqual(s.panes.map(pane => pane.seriesId), [now.id, before.id, now.id, before.id]);
    assert.deepEqual(s.panes.map(pane => pane.projection), [null, null, 'mip', 'mip']);
    assert.deepEqual(await page.locator('.pane-toast').allTextContents(), ['PET follow-up on one SUV scale: this study · prior · their MIPs. Bring both to one level, then link them.Undo']);
    // Linked by hand at the lesion: the studies' frames and slice counts differ, so they page together only once linked.
    await activate(0);
    await goTo(0, lesion.center[2]);
    await activate(1);
    await goTo(1, priorLesion.center[2], priorGrid);
    assert.equal(await location(0), lesion.center[2], 'The prior pages alone before it is linked.');
    await page.getByTestId('tool-link').click();
    await activate(0);
    const [from, fromPrior] = [await location(0), await location(1)];
    await page.evaluate(() => { const view = window.__VEACOM_TEST__.state().view; window.__VEACOM_TEST__.setView({ slice: view.slice + 5 }); });
    await page.waitForFunction(([a, b]) => { const loc = i => Number(document.querySelectorAll('[data-testid="viewport-cell"]')[i]?.querySelector('.slice-detail')?.textContent?.match(/Loc: (-?[\d.]+)/)?.[1]); return loc(0) !== a && loc(1) !== b; }, [from, fromPrior]);
    assert.equal(await location(1) - fromPrior, await location(0) - from, 'Linked by hand, the prior follows slice for slice from where it was.');
    await goTo(0, lesion.center[2]);
    assert.equal(await location(1), priorLesion.center[2]);
    check('Opened after its prior, the study lays out as the PET follow-up; linked by hand, the two page together');

    // The lesion on the prior, named L1 as it lands, at the same threshold: the table gives each change against it.
    await activate(1);
    await chooseSphere();
    await drawSphere(1, priorLesion.center, 20);
    await openFindings();
    await rows().nth(0).locator('select[data-action="sphere-threshold"]').selectOption('max41');
    await activate(0);
    await page.waitForFunction(() => document.querySelector('[data-lesion-table] [data-lesion-prior]')?.textContent?.includes('01.10.1999'));
    const match = page.locator('[data-lesion="L1"] select[data-action="lesion-match"]');
    assert.equal(await match.inputValue(), '', 'Labels alone never match a prior lesion.');
    assert.ok((await tableRow('L1')).every(([, change]) => change === ''));
    await match.selectOption({ label: 'L1' });
    const change = (now, then) => `${now < then ? '−' : now > then ? '+' : ''}${Math.abs((now - then) / then * 100).toFixed(0)}%`;
    const expected = [['7.00', change(7, 10)], ['7.00', change(7, 10)], [volumeText(mtv), '0%'], [(mtv * 7).toFixed(1), change(7, 10)], ['5', '']];
    assert.deepEqual(await tableRow('L1'), expected);
    assert.equal(await page.locator('[data-lesion-table] [data-lesion-prior]').textContent(), 'Changes use reader-matched lesions from 01.10.1999.');
    const selector = rows().nth(2).locator('select[data-action="sphere-threshold"]');
    await selector.selectOption('suv2.5');
    const changed = await tableRow('L1');
    assert.equal(changed[0][1], expected[0][1]);
    assert.equal(changed[2][1], '');
    assert.equal(changed[3][1], '');
    await selector.selectOption('max41');
    await shot('5-follow-up');
    check('The lesion table gives each value\'s change against the prior\'s lesion selected by the reader', { maxChange: expected[0][1] });

    // Against its prior: uptake times 12 min apart, another scanner and reconstruction. Every change is marked, and the
    // table and the acquisition panel say why; the panel shows what the prior recorded.
    assert.deepEqual(await page.getByTestId('lesion-cautions').locator('p').allTextContents(), flagged);
    assert.equal(await page.locator('[data-lesion="L1"] [data-change] [data-caution]').count(), 4, 'Every change is marked.');
    assert.deepEqual([await panelRow('uptake'), await panelRow('scanner'), await panelRow('reconstruction'), await panelRow('glucose')],
      [`${current.pet.uptakeMinutes} min`, current.pet.model, current.pet.reconstruction, '5.4 mmol/l (97 mg/dl)']);
    assert.equal(await page.locator('[data-testid="pet-acquisition"] [data-glucose-source]').textContent(), 'From the file');
    assert.match(await page.getByTestId('pet-prior').locator('thead').textContent(), /This PET01.01.2000Prior PET01.10.1999/);
    assert.equal(await page.locator('[data-action="pet-glucose"]').count(), 0, 'DICOM glucose is authoritative.');
    assert.deepEqual([await priorRow('uptake'), await priorRow('scanner'), await priorRow('reconstruction'), await priorRow('glucose')],
      [`${prior.pet.uptakeMinutes} min`, prior.pet.model, prior.pet.reconstruction, 'Not recorded']);
    assert.deepEqual(await page.getByTestId('pet-compare-flags').locator('p').allTextContents(), flagged);
    await page.getByTestId('pet-prior').scrollIntoViewIfNeeded();
    await shot('7-comparability');
    check('Against a prior 12 min apart in uptake, on another scanner and reconstruction, every change is marked and the reasons are given', { flags: flagged.length });

    // Copy for the report: the technique, the references, the lesion with its changes and their caution, and the reasons,
    // as text in the interface language, every number as the table and the panel show it. The app's clipboard is swapped
    // for one in memory first, so the check never reads or overwrites the computer's.
    const isolated = await desktop.evaluate(({ clipboard }) => {
      const memory = globalThis.veacomCheckClipboard = { text: '', refuse: false };
      const write = text => { if (memory.refuse) throw new Error('The clipboard refused the text.'); memory.text = String(text); };
      clipboard.writeText = write;
      clipboard.readText = () => memory.text;
      return clipboard.writeText === write;
    });
    assert(isolated, 'The app writes to a clipboard in memory.');
    const held = () => desktop.evaluate(() => globalThis.veacomCheckClipboard.text);
    const copyReport = async label => {
      await desktop.evaluate(() => { globalThis.veacomCheckClipboard.text = ''; });
      await page.locator('[data-action="pet-report-copy"]').click();
      await page.waitForFunction(text => document.querySelector('[data-action="pet-report-copy"]')?.textContent === text, label);
      return held();
    };
    const mtvText = volumeText(mtv), tlgText = (mtv * 7).toFixed(1), dose = manifest.suv.doseBq;
    assert.equal(await copyReport('Copied'), [
      'PET findings · 01.01.2000', '',
      'Technique', 'Tracer: Fludeoxyglucose F¹⁸', `Injected activity: ${Math.round(dose / 1e5) / 10} MBq (${Math.round(dose / 3.7e7 * 100) / 100} mCi)`,
      `Uptake time: ${current.pet.uptakeMinutes} min`, `Weight: ${manifest.suv.weightKg} kg`, `Height: ${manifest.suv.heightM} m`,
      'Blood glucose: 5.4 mmol/l (97 mg/dl)', 'PET values: SUVbw · body weight', '',
      'Reference regions', 'Liver reference (3 cm sphere): max 2.00 SUVbw, mean 2.00 SUVbw.', 'Mediastinal blood pool reference: max 1.50 SUVbw, mean 1.50 SUVbw.', '',
      'Lesions', `L1: max 7.00 SUVbw (${change(7, 10)}), peak 7.00 SUVbw (${change(7, 10)}), MTV ${mtvText} mL (0%), TLG ${tlgText} SUVbw·mL (${change(7, 10)}), `
        + 'threshold 41% of SUVmax, Deauville 5. Change from L1 on 01.10.1999 to 01.01.2000. May not be comparable.', '',
      'Cautions', ...flagged,
    ].join('\n'));
    await page.locator('[data-lesion-table]').scrollIntoViewIfNeeded();
    await shot('7b-report-copied');
    // A clipboard that refuses the text: the button says so, and what the clipboard held stays there.
    await desktop.evaluate(() => Object.assign(globalThis.veacomCheckClipboard, { text: 'held before', refuse: true }));
    await page.locator('[data-action="pet-report-copy"]').click();
    await page.locator('#pet-report-error').waitFor();
    assert.equal(await page.locator('#pet-report-error').textContent(), 'Not copied: the clipboard still holds what it held before.');
    assert.equal(await page.locator('[data-action="pet-report-copy"]').textContent(), 'Copy for the report');
    assert.equal(await held(), 'held before');
    await shot('7c-report-not-copied');
    await desktop.evaluate(() => { globalThis.veacomCheckClipboard.refuse = false; });
    await page.getByTestId('tool-language').click();
    await page.getByTestId('language-tr').click();
    const turkish = (await copyReport('Kopyalandı')).split('\n');
    assert.equal(turkish[0], 'PET bulguları · 01.01.2000');
    assert(turkish.includes(`L1: maks 7.00 SUVbw (−%30), tepe 7.00 SUVbw (−%30), MTV ${mtvText} mL (%0), TLG ${tlgText} SUVbw·mL (−%30), eşik SUVmax değerinin %41’i, `
      + 'Deauville 5. 01.10.1999 tarihli L1 lezyonundan 01.01.2000 tarihine değişim. Karşılaştırılamayabilir.'), turkish.join('\n'));
    assert(turkish.includes('Rekonstrüksiyon 01.10.1999 tarihli çekimden farklı.'), turkish.join('\n'));
    assert.equal(await page.locator('#pet-report-error').count(), 0, 'A copy that works clears the error.');
    await shot('7d-report-copied-tr');
    await desktop.evaluate(() => { globalThis.veacomCheckClipboard.refuse = true; });
    await page.locator('[data-action="pet-report-copy"]').click();
    assert.equal(await page.locator('#pet-report-error').textContent(), 'Kopyalanamadı: panoda önceki içerik duruyor.');
    await shot('7e-report-not-copied-tr');
    await desktop.evaluate(() => { globalThis.veacomCheckClipboard.refuse = false; });
    await page.getByTestId('tool-language').click();
    await page.getByTestId('language-en').click();
    const copies = (await page.evaluate(() => window.__VEACOM_TEST__.usage())).filter(event => event.name === 'ux.action' && event.attributes?.['veacom.action'] === 'pet-report-copy');
    assert.equal(copies.length, 4, 'Each copy is recorded by its id.');
    check('Copy for the report gives the technique, references, the lesion with its changes and the cautions, in English and Turkish, and says when the clipboard refuses it');

    // Each warning box has a dismiss button at its top right. The table and the panel say the same, so dismissing one
    // dismisses both; the marks beside the changes stay. A new session shows them again (checked below, with the prior kept).
    await page.getByTestId('lesion-cautions').locator('[data-action="warning-dismiss"]').click();
    await page.getByTestId('lesion-cautions').waitFor({ state: 'detached' });
    assert.equal(await page.getByTestId('pet-compare-flags').count(), 0, 'The panel\'s box, saying the same, is dismissed with it.');
    assert.equal(await page.locator('[data-lesion="L1"] [data-change] [data-caution]').count(), 4, 'The marks beside the changes stay.');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('role')), 'tabpanel', 'Focus stays in the panel.');
    check('A warning box\'s dismiss button hides it, and the same box in the panel, and leaves the marks beside the changes');

    // One SUV scale on the follow-up screen: SUV 0–10 on this study's PET is SUV 0–10 on the prior's, and on both MIPs.
    assert((await cells().allTextContents()).every(text => text.includes('SUV 0–10')), 'Both PETs open on the inverted 0–10 scale.');
    await page.getByTestId('tool-window-presets').click();
    await page.getByTestId('preset-suv7').click();
    const windowLine = index => cells().nth(index).locator('[data-testid="image-overlay"]').textContent();
    await page.waitForFunction(() => /SUV 0–7/.test(document.querySelectorAll('[data-testid="viewport-cell"]')[1]?.querySelector('[data-testid="image-overlay"]')?.textContent ?? ''));
    for (const index of [0, 1, 2, 3]) assert.match(await windowLine(index), /SUV 0–7/, `Pane ${index + 1} is on the same SUV scale.`);
    await page.getByTestId('tool-window-presets').click();
    await page.getByTestId('preset-suv10').click();
    check('All four follow-up panes share the same SUV window after a preset change');

    // SULglu in SUL: this study's from the glucose in its file; no change until the prior has a glucose.
    await showPetValues('lbm');
    await page.waitForFunction(() => document.querySelector('[data-lesion-table] tr[data-lesion-sulglu="L1"]'));
    assert.deepEqual((await tableRow('L1')).slice(0, 2), [[nowSul.toFixed(2), change(nowSul, priorSul)], [nowSul.toFixed(2), change(nowSul, priorSul)]]);
    assert.deepEqual(await sulGluRow('L1'), [[nowGlu.toFixed(2), ''], [nowGlu.toFixed(2), '']]);
    assert.equal(await page.locator('[data-sulglu-note]').textContent(), 'SULglu = SUL × glucose / 5.0 mmol/l, here 5.4 mmol/l from the file. No glucose for 01.10.1999: no SULglu change.');
    assert.match(await values(2), new RegExp(`^SUL max ${nowSul.toFixed(2)} · SULpeak ${nowSul.toFixed(2)} · mean .* · SULglu max ${nowGlu.toFixed(2)}, peak ${nowGlu.toFixed(2)} · `));
    // The prior's glucose, typed in its own panel, gives SULglu's change.
    const unnamed = async () => (await page.evaluate(() => window.__VEACOM_TEST__.usage())).filter(event => event.name === 'ux.action' && event.attributes?.['veacom.action'] === 'other').length;
    const unnamedBefore = await unnamed();
    await activate(1);
    const glucose = page.locator('input[data-action="pet-glucose"]');
    assert.equal(await page.locator('[data-lesion-sulglu]').count(), 0, 'No SULglu without measured glucose.');
    await glucose.fill(String(typedPrior));
    await glucose.press('Enter');
    await page.waitForFunction(() => document.querySelector('[data-testid="pet-acquisition"] [data-glucose-source]')?.textContent === 'Typed');
    assert.equal(await panelRow('glucose'), '10.9 mmol/l (196 mg/dl)');
    await activate(0);
    await page.waitForFunction(() => document.querySelector('[data-lesion-table] tr[data-lesion-sulglu="L1"] small[data-change]'));
    const sulGluChange = change(nowGlu, priorGlu);
    assert.deepEqual(await sulGluRow('L1'), [[nowGlu.toFixed(2), sulGluChange], [nowGlu.toFixed(2), sulGluChange]]);
    assert.equal(await page.locator('[data-sulglu-note]').textContent(), 'SULglu = SUL × glucose / 5.0 mmol/l, here 5.4 mmol/l from the file. 01.10.1999: 10.9 mmol/l typed.');
    assert.equal(await priorRow('glucose'), '10.9 mmol/l (196 mg/dl)');
    const limits = page.locator('[data-action="pet-limited-view"]');
    await limits.check();
    const allFlags = [flagged[0].replace('limit 10 min', 'limit 5 min'), ...flagged.slice(1),
      'Glucose changed from 10.9 to 5.4 mmol/l. UPICT flags fasting changes over 50%.'];
    assert.deepEqual(await page.getByTestId('lesion-cautions').locator('p').allTextContents(), allFlags);
    assert.deepEqual(await page.getByTestId('pet-compare-flags').locator('p').allTextContents(), allFlags);
    check('A lesion-region follow-up uses five minutes, and both panels flag the glucose change');
    await page.locator('[data-lesion-table]').scrollIntoViewIfNeeded();
    await shot('8-sulglu');
    const typedActions = (await page.evaluate(() => window.__VEACOM_TEST__.usage())).filter(event => event.name === 'ux.action').map(event => event.attributes?.['veacom.action']);
    assert(typedActions.includes('pet-glucose'), `pet-glucose is recorded: ${[...new Set(typedActions)].join(', ')}`);
    assert.equal(await unnamed(), unnamedBefore, 'Typing the glucose records no action without an id.');
    check('In SUL, SULglu follows SUL: this study\'s from its file, and its change once the prior\'s glucose is typed', { sulGlu: Number(nowGlu.toFixed(2)), change: sulGluChange });
    await showPetValues('bw');
    await desktop.close();

    // The current study alone, in a new session: the change comes from what was kept for the prior.
    await launch();
    await openFindings();
    await activate(1);
    await page.waitForFunction(() => document.querySelector('[data-lesion-table] [data-lesion-prior]')?.textContent?.includes('kept'));
    assert.deepEqual(await tableRow('L1'), expected);
    await goTo(1, lesion.center[2]);
    await shot('6-kept-prior');
    check('Without the prior open, the change comes from what was kept for it on this computer');

    // With the prior kept: the reasons still stand, and SULglu's change uses the glucose typed for it.
    assert.deepEqual(await page.getByTestId('lesion-cautions').locator('p').allTextContents(), allFlags);
    assert.equal(await page.locator('[data-action="pet-limited-view"]').isChecked(), true);
    assert.match(await page.getByTestId('pet-prior').locator('thead').textContent(), /Saved prior01.10.1999/);
    assert.deepEqual([await priorRow('uptake'), await priorRow('glucose')], [`${prior.pet.uptakeMinutes} min`, '10.9 mmol/l (196 mg/dl)']);
    assert.deepEqual(await page.getByTestId('pet-compare-flags').locator('p').allTextContents(), allFlags);
    await showPetValues('lbm');
    await page.waitForFunction(() => document.querySelector('[data-lesion-table] tr[data-lesion-sulglu="L1"] small[data-change]'));
    assert.deepEqual(await sulGluRow('L1'), [[nowGlu.toFixed(2), change(nowGlu, priorGlu)], [nowGlu.toFixed(2), change(nowGlu, priorGlu)]]);
    await shot('9-kept-comparison');
    await showPetValues('bw');
    check('With the prior kept, the comparison\'s limits and SULglu\'s change come from what was kept for it');

    const reading = rows().nth(2).locator('[data-deauville="helper"]');
    const dragHandle = async (row, handle, dx, dy) => {
      const id = await rows().nth(row).getAttribute('data-annotation-row');
      const box = await cells().nth(1).locator(`[data-annotation-id="${id}"] > circle:not([fill="none"])`).nth(handle).boundingBox();
      assert.ok(box, 'The sphere handle is visible.');
      const { scale } = await screenPoint(1, [0, 0]);
      const x = box.x + box.width / 2, y = box.y + box.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + dx * scale, y + dy * scale, { steps: 12 });
      await page.mouse.up();
      await page.waitForTimeout(350);
    };
    await dragHandle(2, 0, 0, 65);
    assert.equal(await reading.locator('[data-deauville="suggestion"]').textContent(), 'Suggests 2');
    assert.equal(await reading.locator('strong').textContent(), 'Deauville');
    assert.doesNotMatch((await labels(1)).join(' '), /Deauville 5/);
    check('Moving a confirmed lesion clears its score on the image and in Findings');
    await goTo(1, current.liver.center[2]);
    await dragHandle(0, 1, 8, 0);
    assert.match(await values(0), /⌀ 30\.0 mm/);
    check('The liver reference keeps its 30 mm diameter when its edge is dragged');
    assert.deepEqual(errors, [], 'No page errors.');
    await fs.writeFile(path.join(output, 'pet-voi-checks.json'), JSON.stringify({ checks, errors }, null, 2));
    console.log(`All ${checks.length} PET quantification checks passed.`);
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    await fs.writeFile(path.join(output, 'pet-voi-checks.json'), JSON.stringify({ checks, errors, failure: String(error.stack || error) }, null, 2));
    throw error;
  } finally {
    await desktop?.close().catch(() => {});
    await fs.rm(userData, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
