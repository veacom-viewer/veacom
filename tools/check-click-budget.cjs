// Canonical tasks on one study, driven with real mouse and keyboard input. The app's usage timings
// count each task's actions; tools/click-budgets.json holds today's counts, and a longer path fails
// (tools/click-budget.cjs). Run it on the synthetic CT fixture:
//
//   node tools/check-click-budget.cjs ~/veacom-bench/studies/ct-small [output-folder]
//
// VEACOM_RECORD_BUDGETS=1 writes the counts observed as the new budgets. Events stay on this computer
// unless the collector is configured: for a lab baseline in ClickHouse, run through
// telemetry/with-collector.sh with VEACOM_TELEMETRY_ENVIRONMENT=lab (telemetry/TELEMETRY.md).
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { ClickBudget } = require('./click-budget.cjs');
const { ignoreOutsideInput } = require('./lib/outside-input.cjs');
const { temporaryExportFolder } = require('./lib/export-folder.cjs');

// Only synthetic, fingerprinted fixtures can enter this lab run or supply its label.
async function main() {
  const study = path.resolve(process.argv[2]);
  execFileSync(process.execPath, [path.join(__dirname, 'check-golden-study.mjs'), study]);
  const name = 'ct-small';
  const output = path.resolve(process.argv[3] || path.join('test-results', 'click-budget'));
  await fs.mkdir(output, { recursive: true });
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'veacom-budget-'));
  const exports = await temporaryExportFolder(userData);
  const env = { ...process.env, VEACOM_USAGE_CHECK_LOCAL: '1', VEACOM_USER_DATA: userData, VEACOM_TELEMETRY_CONSENT: process.env.VEACOM_TELEMETRY_CONSENT || 'granted' };
  if (env.VEACOM_TELEMETRY_ENVIRONMENT === 'lab') { env.VEACOM_TELEMETRY_STUDY_NAME ||= name; env.VEACOM_TELEMETRY_SCENARIO ||= 'click-budget'; }
  const packaged = process.env.VEACOM_SMOKE_EXECUTABLE;
  const desktop = await electron.launch({ ...(packaged ? { executablePath: packaged } : {}), args: [...(packaged ? [] : [path.resolve(__dirname, '..')]), '--study', study], env, timeout: 90_000 });
  const errors = [];
  let page, budget;
  try {
    page = await desktop.firstWindow();
    // Input from the computer would count as actions and fail the budgets.
    await ignoreOutsideInput(desktop);
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 800));
    budget = new ClickBudget(page);
    const state = () => page.evaluate(() => window.__VEACOM_TEST__.state());
    const enabled = testId => page.evaluate(id => { const element = document.querySelector(`[data-testid="${id}"]`); return Boolean(element && !element.disabled); }, testId);
    const waitEnabled = (testId, timeout = 90_000) => page.waitForFunction(id => { const element = document.querySelector(`[data-testid="${id}"]`); return Boolean(element && !element.disabled); }, testId, { timeout });
    const usageEvent = (event, action) => page.waitForFunction(([name, id]) => window.__VEACOM_TEST__?.usage().some(item => item.name === name && (!id || item.attributes['veacom.action'] === id)), [event, action], { timeout: 120_000 });
    const canvasCenter = async () => {
      const bounds = await page.locator('.viewport-cell.is-active canvas[data-renderer]').first().boundingBox();
      return [bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, bounds];
    };
    const ui = {
      async scrollToMiddle() {
        const [x, y] = await canvasCenter();
        await page.mouse.move(x, y);
        const count = (await state()).dimensions?.[2] ?? 1, target = Math.floor((count - 1) / 2);
        for (let step = 0; step < count * 2 && (await state()).view.slice < target; step += 10) {
          for (let tick = 0; tick < 10; tick++) { await page.mouse.wheel(0, 100); await page.waitForTimeout(8); }
        }
      },
      async preset(key) { await page.getByTestId('tool-window-presets').click(); await page.getByTestId(`preset-${key}`).click(); },
      async pickSeries(pattern) {
        const target = (await state()).series.find(item => !item.segmentation && pattern.test(item.description));
        if (!target) throw new Error(`No series matching ${pattern}`);
        await page.locator(`[data-testid="series-${target.id}"]`).click();
        await page.waitForFunction(id => document.querySelector('.viewport-cell.is-active canvas[data-renderer]')?.dataset.seriesId === id, target.id);
      },
      async fusePet() {
        await waitEnabled('tool-fusion');
        await page.getByTestId('tool-fusion').click();
        const pet = (await state()).series.find(item => item.modality === 'PT');
        await page.getByTestId('fusion-series').selectOption(pet.id);
        await page.waitForFunction(id => document.querySelector('[data-testid="fusion-series"]')?.value === id, pet.id, { timeout: 90_000 });
      },
    };

    // Opening: no action between the study opening and its first image.
    await usageEvent('ux.study.first_image');
    const opened = await budget.events();
    const first = opened.find(event => event.name === 'ux.study.first_image');
    budget.count('open-to-first-image', opened.filter(event => event.name === 'ux.action' && event.trace === first.trace && event.start <= first.start), first.attributes['veacom.t_ms']);
    // Nothing has been pressed yet: an action now would be the app reporting input that never happened.
    budget.count('actions-before-input', opened.filter(event => event.name === 'ux.action'));

    // The wanted view, started as soon as the first image is up (as a surgeon would; a control that needs
    // the whole series, like fusion, waits for it), then a hold longer than the kept view's 3 s.
    const wanted = async view => { await view.scrollToMiddle(); await view.preset('lung'); };
    const studyStart = opened.find(event => event.name === 'ux.study.open');
    await wanted(ui);
    const fromOpen = (await budget.events()).filter(event => event.name === 'ux.action' && event.trace === studyStart.trace);
    budget.count(`kept-view:${name}`, fromOpen, Math.round((await page.evaluate(() => performance.timeOrigin + performance.now())) - studyStart.start));
    await page.waitForTimeout(4000);
    await page.waitForFunction(() => window.__VEACOM_TEST__.state().fullVolumeLoaded, undefined, { timeout: 90_000 });

    if (await enabled('tool-window-presets')) await budget.task('window-preset', () => ui.preset('thorax'));

    const [x, y, bounds] = await canvasCenter();
    await budget.task('measure-length', async () => {
      await page.keyboard.press('l');
      await page.mouse.move(bounds.x + bounds.width * 0.4, bounds.y + bounds.height * 0.45);
      await page.mouse.down(); await page.mouse.move(bounds.x + bounds.width * 0.6, bounds.y + bounds.height * 0.5, { steps: 8 }); await page.mouse.up();
    }, { until: () => page.locator('[data-annotation-id]').first().waitFor() });
    await budget.task('undo', () => page.keyboard.press('ControlOrMeta+z'), { until: () => page.waitForFunction(() => !document.querySelector('[data-annotation-id]')) });
    // The same measurement by two clicks: the first shows the start point, so it is not a click without effect.
    await page.keyboard.press('w');
    await budget.task('measure-length-clicks', async () => {
      await page.keyboard.press('l');
      await page.mouse.click(bounds.x + bounds.width * 0.4, bounds.y + bounds.height * 0.45);
      await page.mouse.click(bounds.x + bounds.width * 0.6, bounds.y + bounds.height * 0.5);
    }, { until: () => page.locator('[data-annotation-id]:not([data-annotation-id="draft"])').first().waitFor() });
    // Choosing it in the list answers even when it is already selected on this slice.
    await page.getByTestId('tool-inspector').click();
    await page.getByTestId('inspector-tab-measurements').click();
    await budget.task('measurement-go', () => page.locator('[data-action="measurement-go"]').first().click());
    await page.getByTestId('tool-inspector').click();
    await page.keyboard.press('ControlOrMeta+z');
    await page.waitForFunction(() => !document.querySelector('[data-annotation-id]'));
    await page.keyboard.press('w');

    await page.waitForTimeout(500);
    if (await enabled('tool-mpr')) {
      await budget.task('mpr', () => page.getByTestId('tool-mpr').click(), { until: () => page.waitForFunction(() => document.querySelectorAll('canvas[data-renderer]').length === 3) });
      await budget.task('mpr-restore', () => page.getByTestId('tool-mpr').click(), { until: () => page.waitForFunction(() => document.querySelectorAll('canvas[data-renderer]').length === 1) });
    }

    if (await enabled('tool-3d')) {
      await budget.task('open-3d', () => page.getByTestId('tool-3d').click(), { until: () => usageEvent('ux.milestone', 'view3d-ready') });
      const volume = await page.getByTestId('volume-3d-canvas').boundingBox();
      // The burr needs a bone or tissue surface under the pointer: CT and MR (a PET has none at the centre).
      const shown = await state(), modality = shown.series.find(item => item.id === shown.activeSeriesId)?.modality;
      if (['CT', 'MR'].includes(modality)) await budget.task('burr', async () => {
        await page.getByTestId('volume-mode-burr').click();
        await page.getByTestId('volume-burr-diameter').selectOption('8');
        await page.mouse.click(volume.x + volume.width / 2, volume.y + volume.height / 2);
      }, { until: () => page.waitForFunction(() => Number(document.querySelector('[data-testid="volume-removed"]')?.dataset.removedVoxels) > 0) });
      await budget.task('close-3d', () => page.getByTestId('volume-close').click(), { until: () => page.getByTestId('volume-view').waitFor({ state: 'detached' }) });
    }

    // Video of the shown stack, into the export folder. The window closes when the export is done.
    await page.mouse.move(x, y);
    await budget.task('export-video', async () => {
      await page.getByTestId('tool-export').click();
      await page.locator('[data-action="export-kind"][data-kind="video"]').click();
      await page.getByTestId('export-submit').click();
    }, { until: () => usageEvent('ux.milestone', 'export-video-done') });
    // The app's own encoder, in the app's own page, wrote a real MP4.
    const videos = (await fs.readdir(exports)).filter(file => file.endsWith('.mp4'));
    if (videos.length !== 1) throw new Error(`The video export should write one MP4 into the export folder, found ${videos.length}.`);
    const written = await fs.readFile(path.join(exports, videos[0]));
    if (written.subarray(4, 8).toString() !== 'ftyp' || !written.includes('avcC')) throw new Error('The video export did not write an MP4 file.');

    await budget.task('language-switch', async () => { await page.getByTestId('tool-language').click(); await page.getByTestId('language-en').click(); },
      { until: () => page.waitForFunction(() => document.querySelector('[data-testid="veacom-app"]')?.dataset.locale === 'en') });
    await page.getByTestId('tool-language').click(); await page.getByTestId('language-tr').click();

    // The golden study has one series: a generated synthetic MR comes in through the real menu (the native
    // dialog answers with its folder), which also measures opening a study, choosing a series and the assessment,
    // which is for MR (a CT's assessment button opens the pre-op checklist: desktop-smoke.cjs). Not in a lab
    // run, which would name this study as the golden one.
    // The MR's lesion pre-diagnosis is switched off while its knowledge base is out of the repository
    // (src/domain/clinical.ts): its button is disabled and says why, so the assessment's two tasks are not run and
    // have no budget. When it is back they run again and fail as having no budget until VEACOM_RECORD_BUDGETS=1.
    if (env.VEACOM_TELEMETRY_ENVIRONMENT !== 'lab') {
      const second = path.join(userData, 'second-study');
      execFileSync(process.execPath, [path.join(__dirname, 'fixtures', 'make-smoke-study.mjs'), second, '--modality', 'MR']);
      await desktop.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, path.join(second, 'S01'));
      const seriesBefore = (await state()).series.length;
      await budget.task('open-folder', async () => { await page.getByTestId('tool-open').click(); await page.locator('[data-action="toolbar-open-folder"]').click(); },
        { until: () => page.waitForFunction(count => window.__VEACOM_TEST__.state().series.length > count, seriesBefore, { timeout: 90_000 }) });
      const asked = (await budget.events()).filter(event => event.attributes['veacom.action'] === 'toolbar-open-folder').at(-1);
      if (!String(asked?.attributes['veacom.changed']).split(',').includes('dialog')) throw new Error('Opening the native dialog was not reported as a change.');

      const images = (await state()).series.filter(item => !item.segmentation);
      if (images.length > 1) {
        const activeId = (await state()).activeSeriesId, other = images.find(item => item.id !== activeId);
        await budget.task('series-pick', () => page.locator(`[data-testid="series-${other.id}"]`).click(),
          { until: () => page.waitForFunction(id => window.__VEACOM_TEST__.state().activeSeriesId === id && window.__VEACOM_TEST__.state().fullVolumeLoaded, other.id, { timeout: 90_000 }) });
      }

      // The assessment, on the MR (shown again first if the pick above went to the CT).
      const mr = (await state()).series.find(item => item.modality === 'MR');
      if (!mr) throw new Error('The generated MR study did not open.');
      if ((await state()).activeSeriesId !== mr.id) {
        await page.locator(`[data-testid="series-${mr.id}"]`).click();
        await page.waitForFunction(id => window.__VEACOM_TEST__.state().activeSeriesId === id && window.__VEACOM_TEST__.state().fullVolumeLoaded, mr.id, { timeout: 90_000 });
      }
      const assessment = page.getByTestId('tool-assessment');
      if (await assessment.getAttribute('aria-disabled') === 'true') {
        // As in check-interface.cjs, which also checks that pressing it opens nothing.
        if (!await assessment.getAttribute('data-tooltip-hint')) throw new Error('The switched-off pre-diagnosis button does not say why.');
        console.log('SKIP click budgets assessment-open, assessment-close: the MR pre-diagnosis is switched off');
      } else {
        await waitEnabled('tool-assessment');
        await budget.task('assessment-open', () => assessment.click(), { until: () => page.getByTestId('assessment-panel').waitFor() });
        await budget.task('assessment-close', () => page.getByTestId('assessment-close').click(), { until: () => page.getByTestId('assessment-panel').waitFor({ state: 'detached' }) });
      }
    }

    // Let the window hand its last events to the main process before closing.
    await page.waitForTimeout(2500);
    if (errors.length) throw new Error(`Renderer errors: ${errors.join('; ')}`);
    await fs.writeFile(path.join(output, `${name}.json`), JSON.stringify({ study: name, platform: process.platform, results: budget.results }, null, 2));
    budget.assert();
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(output, `${name}-failure.png`) }).catch(() => {});
    if (budget) await fs.writeFile(path.join(output, `${name}.json`), JSON.stringify({ study: name, error: error.stack, results: budget.results, errors }, null, 2)).catch(() => {});
    throw error;
  } finally { await desktop.close(); await fs.rm(userData, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
