// Reopen real drawings in the same profile after a normal quit and a process kill. Both CTs have the same image
// identifiers, name and pixels. A finding saved for the second patient proves that its own recovery completed.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const { closeDesktop, killTree } = require('./lib/close-desktop.cjs');
const { ignoreOutsideInput } = require('./lib/outside-input.cjs');

const root = path.resolve(__dirname, '..');
const overlay = '[data-testid="annotation-overlay"]';
const mark = '[data-annotation-id]:not([data-annotation-id="draft"])';
const row = '[data-annotation-row]';
const output = path.resolve(process.argv[2] || 'test-results/measurement-recovery');
const tools = ['length', 'angle', 'ellipse', 'rectangle', 'probe', 'text', 'arrow', 'cobb', 'polygon', 'polyline'];
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const saved = page => page.locator('[data-measurement-save="saved"]').waitFor();
const rows = page => page.locator(row).evaluateAll(items => items.map(item => item.dataset.annotationRow));
const source = slice => ({ plane: 'axial', mode: 'source', slice, oblique: [0, 0] });

async function open(profile, study, locale) {
  const packaged = process.env.VEACOM_SMOKE_EXECUTABLE;
  const app = await electron.launch({
    ...(packaged ? { executablePath: packaged } : {}),
    args: [...(packaged ? [] : [root]), '--study', study, ...(process.platform === 'darwin' ? ['-ApplePersistenceIgnoreState', 'YES'] : [])],
    env: { ...process.env, VEACOM_USER_DATA: profile, VEACOM_TEST_MODE: '1', VEACOM_LOCALE: locale, VEACOM_TELEMETRY_CONSENT: 'denied' }, timeout: 90_000,
  });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(10_000);
    await ignoreOutsideInput(app);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1360, 820));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForFunction(() => window.__VEACOM_TEST__?.state().fullVolumeLoaded, undefined, { timeout: 90_000 });
    return { page, close: () => closeDesktop(app), crash: () => killTree(app.process()) };
  } catch (error) { await closeDesktop(app); throw error; }
}

async function show(page, view) {
  await page.evaluate(v => window.__VEACOM_TEST__.setView(v), view);
  await page.waitForFunction(({ view, overlay }) => {
    const shown = document.querySelector(overlay)?.dataset;
    return shown?.mode === view.mode && shown.plane === view.plane && Number(shown.slice) === view.slice;
  }, { view, overlay }, { timeout: 10_000 });
  await settle(page);
}

async function draw(page, view, type, text) {
  await show(page, view);
  const before = new Set(await rows(page));
  await page.evaluate(tool => window.__VEACOM_TEST__.setTool(tool), type);
  await settle(page);
  const bounds = await page.locator(overlay).first().boundingBox();
  const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
  const unit = Math.min(bounds.width, bounds.height) * 0.10;
  const a = [x - unit, y - unit], b = [x + unit, y + unit];
  if (type === 'text' || type === 'probe') {
    await page.mouse.click(...a);
    if (type === 'text') {
      await page.getByTestId('annotation-text-input').fill(text);
      await page.getByTestId('annotation-text-add').click();
    }
  } else if (['angle', 'cobb', 'polygon', 'polyline'].includes(type)) {
    const points = [a, [b[0], a[1]], b];
    if (type === 'cobb' || type === 'polygon') points.push([a[0], b[1]]);
    for (const p of points) await page.mouse.click(...p);
    if (type === 'polygon' || type === 'polyline') await page.keyboard.press('Enter');
  } else {
    await page.mouse.move(...a);
    await page.mouse.down();
    await page.mouse.move(...b, { steps: 3 });
    await page.mouse.up();
  }
  await page.waitForFunction(({ row, n }) => document.querySelectorAll(row).length === n + 1, { row, n: before.size }, { timeout: 5000 });
  const added = (await rows(page)).filter(id => !before.has(id));
  assert.equal(added.length, 1);
  await page.locator(`[data-annotation-id="${added[0]}"]`).waitFor();
  return { id: added[0], view, type };
}

async function onScreen(page, entry) {
  // A calibration or import notice uses one row above the viewport. Compare the drawings at the same physical size.
  const dismiss = page.getByTestId('notice-dismiss');
  if (await dismiss.isVisible()) await dismiss.click();
  await show(page, entry.view);
  return page.locator(`[data-annotation-id="${entry.id}"]`).evaluate(node => ({
    viewport: node.ownerSVGElement.getAttribute('viewBox'),
    geometry: [...node.querySelectorAll('.annotation-casing > *')].map(shape => [shape.tagName,
      ...['points', 'd', 'cx', 'cy', 'r', 'rx', 'ry', 'transform'].map(attr => shape.getAttribute(attr))]),
    label: node.querySelector('.annotation-label')?.textContent ?? '',
  }));
}

async function calibrate(page, entry, mm = 80) {
  await page.getByTestId('inspector-tab-display').click();
  const toggle = page.locator('#section-units-toggle');
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await page.locator('[data-action="calibration-line"]').selectOption(entry.id);
  await page.locator('[data-action="calibration-length"]').fill(String(mm));
  await page.locator('[data-action="calibrate"]').click();
  await page.getByTestId('inspector-tab-measurements').click();
  await saved(page);
  assert.match((await onScreen(page, entry)).label, new RegExp(mm + '[.,]0\\s*mm|' + mm / 10 + '[.,]0\\s*cm'));
}

async function selectAcquisition(page, number) {
  const id = await page.evaluate(number => {
    const h = window.__VEACOM_TEST__, series = h.state().series;
    if (series.length !== 2) throw new Error('Expected two acquisitions');
    const item = series.find(s => s.description.endsWith('(' + number + '/2)'));
    if (!item) throw new Error('Missing acquisition ' + number);
    h.selectSeries(item.id);
    return item.id;
  }, number);
  await page.waitForFunction(id => {
    const s = window.__VEACOM_TEST__.state();
    return s.activeSeriesId === id && s.fullVolumeLoaded && s.dimensions[2] === 6;
  }, id);
  await saved(page);
  return id;
}

async function runTrial(dir, mode, locale, openStudy) {
  const profile = path.join(dir, mode);
  const study = name => path.join(dir, name, 'S01');
  let active;
  const start = async name => {
    active = await openStudy(profile, study(name), locale);
    const { page } = active, tab = page.getByTestId('inspector-tab-measurements');
    if (!await tab.isVisible()) await page.getByTestId('tool-inspector').click();
    await tab.click();
    await settle(page);
    return page;
  };
  const stop = async () => { assert.ok(await active.close()); active = undefined; };
  try {
    let page = await start('other');
    const control = await draw(page, source(81), 'text', 'Second patient');
    await saved(page);
    await stop();

    page = await start('regrouped');
    await selectAcquisition(page, 2);
    const second = await draw(page, source(2), 'length');
    const secondBefore = await onScreen(page, second);
    await saved(page);
    await stop();

    page = await start('first');
    const firstId = await page.evaluate(() => window.__VEACOM_TEST__.state().activeSeriesId);
    assert.deepEqual(await rows(page), []);
    await page.evaluate(() => {
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args) {
        if (this.name !== 'measurements') return put.apply(this, args);
        IDBObjectStore.prototype.put = put;
        throw new DOMException('Simulated full test profile', 'QuotaExceededError');
      };
    });
    const entries = [];
    for (let i = 0; i < 50; i++) {
      const view = i < 30 ? source(i + 12) : { mode: 'mpr', plane: i < 40 ? 'coronal' : 'sagittal', slice: 20 + i,
        oblique: i >= 45 ? [10, -5] : [0, 0] };
      const type = i === 49 ? 'sphere' : tools[i % tools.length];
      try { entries.push(await draw(page, view, type, 'Synthetic ' + i)); }
      catch (error) { throw new Error(`Drawing ${i + 1}, ${type} on ${view.mode} ${view.plane} ${view.slice}`, { cause: error }); }
      if (i === 0) {
        await page.locator('[data-measurement-save="failed"]').waitFor();
        await page.screenshot({ path: path.join(output, mode + '-save-failed.png') });
        await page.locator('[data-action="retry-measurements"]').click();
        await saved(page);
        await calibrate(page, entries[0]);
      }
    }
    const disposable = await draw(page, source(91), 'length');
    const disposableRow = page.locator(`[data-annotation-row="${disposable.id}"]`);
    await disposableRow.locator('[data-action="measurement-delete"]').click();
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.keyboard.press(mod + '+z');
    await disposableRow.waitFor();
    await page.keyboard.press(mod + '+Shift+z');
    await disposableRow.waitFor({ state: 'detached' });
    assert.deepEqual(await rows(page), entries.map(e => e.id));
    for (const entry of entries) entry.before = await onScreen(page, entry);
    // Put the last finding back immediately before stopping the process. The transaction acknowledgement is sufficient.
    const lastRow = page.locator(`[data-annotation-row="${entries.at(-1).id}"]`);
    await lastRow.locator('[data-action="measurement-delete"]').click();
    await lastRow.waitFor({ state: 'detached' });
    await page.keyboard.press(mod + '+z');
    await lastRow.waitFor();
    await saved(page);
    if (mode === 'crash') { await active.crash(); active = undefined; }
    else await stop();

    page = await start('other');
    await page.locator(`[data-annotation-row="${control.id}"]`).waitFor();
    assert.deepEqual(await rows(page), [control.id], 'Only this patient’s control finding should return');
    assert.equal((await onScreen(page, control)).label, 'Second patient');
    await stop();

    page = await start('first');
    await page.waitForFunction(({ row, n }) => document.querySelectorAll(row).length >= n, { row, n: entries.length }, { timeout: 10_000 });
    assert.deepEqual(await rows(page), entries.map(e => e.id), 'Finding numbers, deleted marks and patient identity after restart');
    for (const entry of entries) assert.deepEqual(await onScreen(page, entry), entry.before, `${mode} ${entry.type} on ${JSON.stringify(entry.view)}`);
    await show(page, source(91));
    const extra = await page.locator(mark).evaluateAll(items => items.map(item => item.dataset.annotationId));
    assert.ok(extra.every(id => entries.some(e => e.id === id && e.type === 'sphere')), 'Only a volume sphere may intersect this unmarked source frame');
    await show(page, entries[0].view);
    await page.screenshot({ path: path.join(output, mode + '-recovered.png') });
    await stop();
    page = await start('subset');
    const expectedSubset = entries.filter(e => e.view.mode === 'source' && e.view.slice >= 10 && e.view.slice <= 15);
    await page.locator(`[data-annotation-row="${entries[0].id}"]`).waitFor();
    assert.deepEqual(await rows(page), expectedSubset.map(e => e.id), 'Only drawings from the six acquired images belong in a partial import');
    const subsetRuler = { ...entries[0], view: source(2) };
    assert.deepEqual(await onScreen(page, subsetRuler), entries[0].before, 'A six-image import keeps the original 80 mm calibration');
    const oblique = await draw(page, { mode: 'mpr', plane: 'axial', slice: 2, oblique: [2, -3] }, 'text', 'Six-image landmark');
    const obliqueBefore = await onScreen(page, oblique);
    await saved(page);
    if (mode === 'crash') { await active.crash(); active = undefined; }
    else await stop();
    page = await start('regrouped');
    assert.notEqual(await selectAcquisition(page, 1), firstId);
    await page.locator(`[data-annotation-row="${subsetRuler.id}"]`).waitFor();
    assert.deepEqual(await rows(page), [...expectedSubset.map(e => e.id), oblique.id]);
    assert.deepEqual(await onScreen(page, oblique), obliqueBefore, 'The oblique note follows the same ordered six-image reconstruction');
    const regrouped = await onScreen(page, subsetRuler);
    assert.deepEqual(regrouped, entries[0].before, 'The original acquisition keeps its 80 mm ruler after regrouping');
    await selectAcquisition(page, 2);
    await page.locator(`[data-annotation-row="${second.id}"]`).waitFor();
    assert.deepEqual(await rows(page), [second.id]);
    assert.deepEqual(await onScreen(page, second), secondBefore, 'The second acquisition keeps its own ruler and scale');
    let recalibratedLabel;
    if (mode === 'normal') {
      await selectAcquisition(page, 1);
      await calibrate(page, subsetRuler, 60);
      await stop();
      page = await start('first');
      await page.locator(`[data-annotation-row="${entries[0].id}"]`).waitFor();
      recalibratedLabel = (await onScreen(page, entries[0])).label;
      assert.match(recalibratedLabel, /60[.,]0\s*mm|6[.,]0\s*cm/, 'The recalibrated images keep their new scale in the full study');
      assert.deepEqual(await onScreen(page, entries[10]), entries[10].before, 'An image outside that acquisition keeps its original scale');
      assert.ok(!(await rows(page)).includes(oblique.id), 'The full reconstruction has different source images');
    }
    return { mode, locale, recovered: entries.length, wrongPatient: 0, partialImport: expectedSubset.length,
      regroupedLabel: regrouped.label, regroupedOblique: obliqueBefore.label, secondAcquisitionLabel: secondBefore.label, recalibratedLabel, entries };
  } finally { if (active) await active.close(); }
}

async function main() {
  await fs.mkdir(output, { recursive: true });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'veacom-measurements-'));
  let browser;
  try {
    if (process.argv[3] === '--browser-site') {
      const { measurementBrowser } = await import('../web/tools/measurement-browser.mjs');
      browser = await measurementBrowser(path.resolve(process.argv[4]));
    }
    const fixture = path.join(__dirname, 'fixtures/make-smoke-study.mjs');
    execFileSync(process.execPath, [fixture, path.join(dir, 'first')]);
    execFileSync(process.execPath, [fixture, path.join(dir, 'other'), '--other-patient']);
    execFileSync(process.execPath, [fixture, path.join(dir, 'second'), '--second-acquisition']);
    const subset = path.join(dir, 'subset', 'S01');
    const regrouped = path.join(dir, 'regrouped', 'S01');
    await fs.mkdir(subset, { recursive: true });
    await fs.mkdir(regrouped, { recursive: true });
    for (let z = 10; z <= 15; z++) {
      const file = 'IM' + String(z).padStart(5, '0') + '.dcm';
      await fs.copyFile(path.join(dir, 'first', 'S01', file), path.join(subset, file));
      for (const part of ['first', 'second']) await fs.copyFile(path.join(dir, part, 'S01', file), path.join(regrouped, part + file));
    }
    const results = [];
    for (const [mode, locale] of [['normal', 'en'], ['crash', 'tr']]) {
      results.push(await runTrial(dir, mode, locale, browser?.open || open));
      console.log(`PASS ${mode}: 50 ordered findings, matching geometry and labels, zero wrong-patient findings`);
    }
    await fs.writeFile(path.join(output, 'recovery.json'), JSON.stringify(results, null, 2) + '\n');
  } finally {
    if (browser) await browser.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
