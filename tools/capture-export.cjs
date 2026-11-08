const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const reference = require('../tests/golden/ct-small.json');
const { decodePng } = require('./lib/png.cjs');
const { temporaryExportFolder } = require('./lib/export-folder.cjs');
const { ignoreOutsideInput, launchDesktop } = require('./lib/outside-input.cjs');

async function main() {
  const [input, output, app = path.resolve(__dirname, '..')] = process.argv.slice(2);
  if (!input || !output) throw new Error('Usage: node tools/capture-export.cjs <ct-small> <output-directory> [baseline-app]');
  const study = path.resolve(input);
  execFileSync(process.execPath, [path.join(__dirname, 'check-golden-study.mjs'), study], { stdio: 'inherit' });
  await fs.mkdir(output, { recursive: true });
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'veacom-golden-'));
  const profile = path.join(temporary, 'profile');
  const exports = await temporaryExportFolder(profile);
  let desktop;
  try {
    desktop = await launchDesktop({ args: [path.resolve(app), '--force-device-scale-factor=1', '--study', path.join(study, 'S01')],
      env: { ...process.env, VEACOM_USER_DATA: profile }, timeout: 90000 });
    const page = await desktop.firstWindow();
    // A scroll or key press from the computer would move the slice or the window level and fail the golden.
    await ignoreOutsideInput(desktop);
    await page.waitForFunction(() => {
      const state = window.__VEACOM_TEST__?.state();
      return state?.activeSeriesId && state.loadedSeriesIds.includes(state.activeSeriesId);
    }, undefined, { timeout: 90000 });
    await page.waitForFunction(() => Boolean(window.__VEACOM_TEST__?.state().graphics?.renderer), undefined, { timeout: 30000 });
    const renderer = await page.evaluate(() => window.__VEACOM_TEST__.state().graphics.renderer);
    const platform = `${process.platform}-${process.arch}`;
    await fs.writeFile(path.join(output, 'renderer.json'), JSON.stringify({ platform, renderer }, null, 2) + '\n');
    console.log(`Export renderer: ${platform} ${renderer}; reference: ${reference.platform} ${reference.renderer}`);
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1282, 804));
    const [width, height] = reference.viewport;
    await page.addStyleTag({ content: `.viewport-cell.is-active { width:${width}px !important;height:${height}px !important;align-self:start;justify-self:start; }` });
    const view = { slice: reference.slice, windowWidth: reference.windowWidth, windowCenter: reference.windowCenter };
    await page.evaluate(view => window.__VEACOM_TEST__.setView(view), view);
    if (Boolean(await page.getByTestId('image-overlay').count()) !== reference.overlays) {
      await page.getByTestId('dicom-viewport').press('F12');
    }
    await page.waitForFunction(({ view, overlays }) => {
      const current = window.__VEACOM_TEST__.state().view;
      return current.slice === view.slice && current.windowWidth === view.windowWidth && current.windowCenter === view.windowCenter
        && Number(document.querySelector('canvas[data-slice]')?.dataset.slice) === view.slice
        && ['image-overlay', 'patient-overlay'].every(id => Boolean(document.querySelector(`[data-testid="${id}"]`)) === overlays);
    }, { view, overlays: reference.overlays });
    await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
    const dimensions = await page.locator('.viewport-cell.is-active').evaluate(el => {
      const box = el.getBoundingClientRect(); return [box.width, box.height, devicePixelRatio];
    });
    assert.deepEqual(dimensions, [width, height, reference.deviceScaleFactor], 'Export needs the fixed pane size and device scale');
    // The shown image as a picture, as a person exports it: the export window's Pictures, this image, PNG, with the
    // image's own labels. It goes into a new folder in the export folder.
    await page.getByTestId('tool-export').click();
    await page.locator('[data-action="export-kind"][data-kind="images"]').click();
    for (const [action, value] of [['export-scope', 'slice'], ['export-picture-format', 'png'], ['export-annotations', 'full']]) {
      await page.locator(`.export-dialog input[data-action="${action}"][value="${value}"]`).check();
    }
    await page.getByTestId('export-submit').click();
    await page.locator('[data-testid="notice"][data-code="export-complete"]').waitFor({ timeout: 15000 });
    const pictures = (await fs.readdir(exports, { recursive: true })).filter(name => name.endsWith('.png'));
    assert.equal(pictures.length, 1, `Expected one exported PNG, found ${JSON.stringify(pictures)}`);
    const bytes = await fs.readFile(path.join(exports, pictures[0])), png = decodePng(bytes);
    assert.deepEqual([png.width, png.height], [width * reference.deviceScaleFactor, height * reference.deviceScaleFactor]);
    const tones = new Set();
    for (let index = 0; index < png.data.length; index += 4) tones.add(png.data[index]);
    await fs.writeFile(path.join(output, 'current.png'), bytes);
    assert(tones.size > 16 && tones.has(0) && tones.has(255), `Expected a rendered CT at W400/L40; got ${tones.size} tones (${Math.min(...tones)}–${Math.max(...tones)})`);
    console.log(`PASS current-image PNG export: ${png.width}x${png.height}, ${tones.size} tones`);
  } finally {
    if (desktop) await desktop.close();
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
