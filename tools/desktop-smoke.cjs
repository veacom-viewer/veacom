const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const os = require('node:os');
const { ClickBudget } = require('./click-budget.cjs');
const { ignoreOutsideInput } = require('./lib/outside-input.cjs');
const { isSoftwareRenderer } = require('./software-renderer.cjs');
// hardware (default): a graphics driver must draw. software: the PC has no usable driver, so drawing must
// run in software and the app must say so.
const expectedRenderer = process.env.VEACOM_SMOKE_RENDERER || 'hardware';

async function main() {
  const study = path.resolve(process.argv[2]);
  const output = path.resolve(process.argv[3] || 'test-results/desktop');
  await fs.mkdir(output, { recursive: true });
  const errors = [];
  const checks = [];
  const started = performance.now();
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'veacom-smoke-'));
  const packaged = process.env.VEACOM_SMOKE_EXECUTABLE;
  const restoreArgs = process.platform === 'darwin' ? ['-ApplePersistenceIgnoreState', 'YES'] : [];
  const desktop = await electron.launch({ ...(packaged ? { executablePath: packaged } : {}), args: [...(packaged ? [] : [path.resolve(__dirname, '..')]), '--study', study, ...restoreArgs], env: { ...process.env, VEACOM_USAGE_CHECK_LOCAL: '1', VEACOM_USER_DATA: userData, VEACOM_TELEMETRY_ENVIRONMENT: 'lab' }, timeout: 90_000 });
  let page;
  const screenshot = async name => {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.screenshot({ path: path.join(output, name) });
  };
  const check = (name, detail) => { checks.push({ name, passed: true, detail }); console.log(`PASS ${name}`); };
  try {
    page = await desktop.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await ignoreOutsideInput(desktop);
    // Each step's actions, counted by the app's usage timings, against tools/click-budgets.json.
    const budget = new ClickBudget(page);
    await page.waitForFunction(() => window.__VEACOM_TEST__?.state().fullVolumeLoaded, undefined, { timeout: 90_000 });
    await page.locator('canvas[data-renderer]').first().waitFor({ state: 'visible' });
    const state = await page.evaluate(() => window.__VEACOM_TEST__.state());
    check('CLI study import and full decode', { elapsedMs: performance.now() - started, state });
    const renderer = await page.locator('canvas[data-renderer]').first().getAttribute('data-renderer');
    const software = isSoftwareRenderer(renderer) || await page.locator('canvas[data-renderer]').first().getAttribute('data-software-renderer') === 'true';
    if (expectedRenderer === 'software') {
      assert(software, `Expected software drawing: ${renderer}`);
      await page.getByTestId('software-rendering-notice').waitFor();
      check('Software drawing with its notice', renderer);
    } else {
      assert(!software, `Software renderer: ${renderer}`);
      check('Hardware GPU rendering', renderer);
    }
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 800));
    await page.evaluate(() => window.__VEACOM_TEST__.setView({ slice: Math.floor(window.__VEACOM_TEST__.state().dimensions[2] / 2) }));
    await page.waitForFunction(() => +document.querySelector('canvas[data-slice]').dataset.slice === window.__VEACOM_TEST__.state().view.slice);
    await screenshot('after-window.png');

    const canvas = page.locator('canvas[data-renderer]').first();
    const bounds = await canvas.boundingBox();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    const beforeScroll = await page.evaluate(() => window.__VEACOM_TEST__.state().view.slice);
    await budget.task('wheel-scroll', () => page.mouse.wheel(0, 120),
      { until: () => page.waitForFunction(before => window.__VEACOM_TEST__.state().view.slice !== before, beforeScroll) });
    check('Physical wheel input changes slice');
    const beforeWindow = await page.evaluate(() => window.__VEACOM_TEST__.state().view.windowWidth);
    // Another tool first, so that pressing W is a real step of the task.
    await page.evaluate(() => window.__VEACOM_TEST__.setTool('pan'));
    await page.waitForFunction(() => window.__VEACOM_TEST__.usage().some(event => event.attributes['veacom.tool'] === 'pan'));
    await budget.task('window-drag', async () => {
      await page.keyboard.press('w');
      await page.mouse.down(); await page.mouse.move(bounds.x + bounds.width / 2 + 90, bounds.y + bounds.height / 2 + 30, { steps: 8 }); await page.mouse.up();
    }, { until: () => page.waitForFunction(before => window.__VEACOM_TEST__.state().view.windowWidth !== before, beforeWindow) });
    check('Window and level drag');

    await budget.task('measure-length', async () => {
      await page.keyboard.press('l');
      await page.mouse.move(bounds.x + bounds.width * .35, bounds.y + bounds.height * .45);
      await page.mouse.down(); await page.mouse.move(bounds.x + bounds.width * .65, bounds.y + bounds.height * .5, { steps: 8 }); await page.mouse.up();
    }, { until: () => page.locator('[data-annotation-id]:not([data-annotation-id="draft"])').first().waitFor() });
    check('Length annotation renders');
    await budget.task('undo-redo', async () => {
      await page.keyboard.press('ControlOrMeta+z');
      await page.waitForFunction(() => !document.querySelector('[data-annotation-id]'));
      await page.keyboard.press('ControlOrMeta+Shift+z');
    }, { until: () => page.locator('[data-annotation-id]').first().waitFor() });
    check('Annotation undo and redo');
    await screenshot('after-measurement.png');

    await budget.task('mpr', () => page.getByTestId('tool-mpr').click(), { until: () => page.waitForFunction(() => document.querySelectorAll('canvas[data-renderer]').length === 3) });
    const planes = await page.locator('canvas[data-renderer]').evaluateAll(nodes => nodes.map(node => node.dataset.plane).sort());
    assert.deepEqual(planes, ['axial', 'coronal', 'sagittal']);
    check('Three-plane MPR');
    await screenshot('after-mpr.png');

    await budget.task('open-3d', () => page.getByTestId('tool-3d').click(), { until: async () => {
      await page.getByTestId('volume-view').waitFor();
      await page.getByTestId('volume-3d-canvas').waitFor();
      await page.waitForFunction(() => document.querySelector('[data-testid="volume-3d-canvas"]')?.width > 10);
    } });
    await screenshot('after-3d.png');
    check('3D surgical view opens');
    const volumeCanvas = await page.getByTestId('volume-3d-canvas').boundingBox();
    const center = [volumeCanvas.x + volumeCanvas.width / 2, volumeCanvas.y + volumeCanvas.height / 2];
    await budget.task('3d-pick', async () => { await page.getByTestId('volume-mode-pick').click(); await page.mouse.click(...center); },
      { until: () => page.getByTestId('volume-linked-marker').waitFor({ state: 'visible' }) });
    const marker = await page.getByTestId('volume-linked-marker').boundingBox();
    assert(marker.x >= volumeCanvas.x && marker.x < volumeCanvas.x + volumeCanvas.width);
    assert(marker.y >= volumeCanvas.y && marker.y < volumeCanvas.y + volumeCanvas.height);
    check('3D linked point is visible');
    await budget.task('burr', async () => {
      await page.getByTestId('volume-mode-burr').click();
      await page.getByTestId('volume-burr-diameter').selectOption('8');
      await page.mouse.click(...center);
    }, { until: () => page.waitForFunction(() => Number(document.querySelector('[data-testid="volume-removed"]')?.dataset.removedVoxels) > 0) });
    await screenshot('after-burr.png');
    check('Virtual burr removes voxels');
    await budget.task('burr-undo', () => page.locator('[data-testid="volume-undo"][data-undo-count="1"]').click(),
      { until: () => page.waitForFunction(() => document.querySelector('[data-testid="volume-removed"]')?.dataset.removedVoxels === '0') });
    check('Burr undo restores the volume');
    await budget.task('close-3d', () => page.getByTestId('volume-close').click(), { until: () => page.getByTestId('volume-view').waitFor({ state: 'detached' }) });
    // On a CT the assessment button opens the pre-op checklist; the MR assessment is checked by check-click-budget.cjs.
    await budget.task('checklist-open', () => page.getByTestId('tool-assessment').click(), { until: () => page.getByTestId('preop-checklist').waitFor() });
    await screenshot('after-checklist.png');
    check('Pre-op checklist opens on a CT');
    await budget.task('checklist-close', () => page.locator('[data-action="checklist-close"]').click(), { until: () => page.getByTestId('preop-checklist').waitFor({ state: 'detached' }) });

    // A fresh profile starts in Turkish; the switch changes the interface and is saved for the next start.
    const app = page.getByTestId('veacom-app');
    assert.equal(await app.getAttribute('data-locale'), process.env.VEACOM_LOCALE || 'tr');
    assert.equal(await page.evaluate(() => document.documentElement.lang), process.env.VEACOM_LOCALE || 'tr');
    await page.getByTestId('tool-language').click();
    await page.getByTestId('language-en').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="veacom-app"]')?.dataset.locale === 'en');
    // Toolbar names are the accessible names (aria-label); the visual tooltip repeats them.
    assert.equal(await page.getByTestId('tool-3d').getAttribute('aria-label'), 'Open 3D surgical view');
    const saved = async () => { try { return JSON.parse(await fs.readFile(path.join(userData, 'preferences.json'), 'utf8')).locale; } catch { return null; } };
    for (let attempt = 0; attempt < 50 && await saved() !== 'en'; attempt++) await page.waitForTimeout(100);
    assert.equal(await saved(), 'en');
    await page.getByTestId('tool-language').click();
    await page.getByTestId('language-tr').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="veacom-app"]')?.dataset.locale === 'tr');
    assert.equal(await page.getByTestId('tool-3d').getAttribute('aria-label'), '3D cerrahi görünümü aç');
    for (let attempt = 0; attempt < 50 && await saved() !== 'tr'; attempt++) await page.waitForTimeout(100);
    assert.equal(await saved(), 'tr');
    check('Turkish by default; the language switch updates the interface and is saved');

    // Usage timings: a fresh profile is asked once (a strip, not a modal); the answer is saved, and the
    // settings switch turns sharing on and off (off deletes the local copy).
    const preferences = async () => { try { return JSON.parse(await fs.readFile(path.join(userData, 'preferences.json'), 'utf8')); } catch { return {}; } };
    const waitPreference = async value => { for (let attempt = 0; attempt < 50 && (await preferences()).usageConsent !== value; attempt++) await page.waitForTimeout(100); assert.equal((await preferences()).usageConsent, value); };
    if (!process.env.VEACOM_TELEMETRY_CONSENT) {
      await page.getByTestId('usage-consent').waitFor();
      await budget.task('usage-consent-answer', () => page.getByTestId('usage-consent-decline').click(), { until: () => page.getByTestId('usage-consent').waitFor({ state: 'detached' }) });
      await waitPreference('denied');
      if (!await page.getByTestId('inspector-tab-display').isVisible()) await page.getByTestId('tool-inspector').click();
      await page.getByTestId('inspector-tab-display').click();
      const sharing = page.getByTestId('usage-sharing');
      assert.equal(await sharing.isChecked(), false);
      await budget.task('usage-setting', () => sharing.click(), { until: () => waitPreference('granted') });
      await page.waitForTimeout(2500);
      await sharing.click(); await waitPreference('denied');
      await fs.access(path.join(userData, 'usage')).then(() => { throw new Error('The local usage copy was kept after sharing was turned off.'); }, () => {});
      await page.getByTestId('tool-inspector').click();
      check('Usage timings consent: asked once, saved, and switched off in settings');
    }
    budget.assert();
    check('Click budgets', budget.results);
    const gpu = await desktop.evaluate(async ({ app }) => ({ features: app.getGPUFeatureStatus(), info: await app.getGPUInfo('basic'), metrics: app.getAppMetrics() }));
    if (expectedRenderer !== 'software') {
      assert.equal(await page.getByTestId('software-rendering-notice').count(), 0, 'Software-drawing notice shown with a graphics driver');
      check('No software-drawing notice', gpu.features.webgl);
    }
    assert.deepEqual(errors, [], `Renderer errors: ${errors.join('; ')}`);
    check('No renderer errors');
    await fs.writeFile(path.join(output, 'desktop-smoke.json'), JSON.stringify({ passed: true, expectedRenderer, checks, errors, gpu, study, platform: process.platform }, null, 2));
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    await fs.writeFile(path.join(output, 'desktop-smoke.json'), JSON.stringify({ passed: false, expectedRenderer, error: error.stack, checks, errors, study }, null, 2));
    throw error;
  } finally { await desktop.close(); await fs.rm(userData, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
