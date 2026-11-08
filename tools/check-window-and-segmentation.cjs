// Opens a study whose image stores no window and a study with DICOM Segmentation objects
// in the desktop app, checks the pixel-measured window and the segmentation overlay on
// source frames, the three MPR planes and the 3D view, and saves screenshots.
//
// Usage: node tools/check-window-and-segmentation.cjs <no-window-study> <segmentation-study> [output] [--voi-lut=<study>] [--sigmoid=<study>]
// e.g. the CBIS-DDSM mammogram and the LIDC-IDRI chest CT with nodule SEGs. --voi-lut names a study
// whose image has a step-shaped VOI LUT and no window: it must display only black and white. --sigmoid
// names a study whose stored window has VOI LUT Function SIGMOID (tools/make-display-fixtures.py makes both).
// Set VEACOM_SMOKE_EXECUTABLE to check a packaged build; VEACOM_CORE_PATH picks the core.
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { ignoreOutsideInput } = require('./lib/outside-input.cjs');

const positional = process.argv.slice(2).filter(value => !value.startsWith('--'));
const [windowStudy, segmentationStudy] = positional.slice(0, 2).map(value => value && path.resolve(value));
const output = path.resolve(positional[2] || 'test-results/window-and-segmentation');
const voiStudy = process.argv.find(value => value.startsWith('--voi-lut='))?.slice('--voi-lut='.length);
const sigmoidStudy = process.argv.find(value => value.startsWith('--sigmoid='))?.slice('--sigmoid='.length);
if (!windowStudy || !segmentationStudy) {
  console.error('Usage: node tools/check-window-and-segmentation.cjs <no-window-study> <segmentation-study> [output]');
  process.exit(2);
}
const executablePath = process.env.VEACOM_SMOKE_EXECUTABLE;

async function main() {
  await fs.mkdir(output, { recursive: true });
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'veacom-window-segmentation-'));
  const desktop = await electron.launch({ ...(executablePath ? { executablePath } : {}),
    args: executablePath ? [] : [path.resolve(__dirname, '..')],
    env: { ...process.env, VEACOM_USER_DATA: profile, VEACOM_TEST_MODE: '1' }, timeout: 90_000 });
  const checks = [], errors = [];
  let page;
  const check = (name, detail) => { checks.push({ name, passed: true, detail }); console.log(`PASS ${name}`); };
  const settled = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const state = () => page.evaluate(() => window.__VEACOM_TEST__.state());
  const importStudy = async study => {
    const previous = (await state()).activeSeriesId;
    const capabilities = await desktop.evaluate(({ app }, paths) => app.__VEACOM_PRIVILEGED_TEST__.authorizeImportPaths(paths), [study]);
    await page.evaluate(capabilities => window.__VEACOM_TEST__.importPaths(capabilities), capabilities);
    // The study's first image series replaces the one shown before and loads completely.
    await page.waitForFunction(previous => {
      const current = window.__VEACOM_TEST__.state();
      return current.activeSeriesId !== previous && current.fullVolumeLoaded && current.displayedView;
    }, previous, { timeout: 90_000 });
    await settled();
  };
  // Grey levels of the drawn image, from the viewport's own canvas.
  const greyLevels = () => page.locator('canvas[data-renderer]').first().evaluate(canvas => {
    const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    const counts = new Array(256).fill(0);
    for (let i = 0; i < data.length; i += 4) counts[Math.round((data[i] + data[i + 1] + data[i + 2]) / 3)]++;
    return counts;
  });
  try {
    page = await desktop.firstWindow();
    // A key press or scroll from the computer would change the image this check measures. capturePage below still reads
    // the current frame if the helper has hidden the app (measured on macOS: identical pixels inactive, covered or hidden).
    await ignoreOutsideInput(desktop);
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.waitForFunction(() => window.__VEACOM_TEST__ && document.querySelector('[data-testid="veacom-app"]')?.getAttribute('data-ready') === 'true', undefined, { timeout: 60_000 });
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 860));

    await importStudy(windowStudy);
    let current = await state();
    const image = current.series.find(item => item.id === current.activeSeriesId);
    assert(image.windowFromPixels, `The opened series should carry a window measured from its pixels: ${JSON.stringify(image)}`);
    assert.equal(current.displayedView.windowCenter, image.windowCenter);
    assert.equal(current.displayedView.windowWidth, image.windowWidth);
    const levels = await greyLevels();
    const lit = levels.slice(1).reduce((sum, n) => sum + n, 0), white = levels[255];
    const mid = levels.slice(32, 224).reduce((sum, n) => sum + n, 0);
    assert(lit > 0 && white / lit < 0.1, `Image saturates: ${white} of ${lit} lit pixels are white`);
    assert(mid / lit > 0.5, `Image lacks mid-grey detail: ${mid} of ${lit} lit pixels`);
    await page.screenshot({ path: path.join(output, 'no-window-image.png') });
    check('An image without a stored window opens with a window measured from its pixels', {
      series: image.description, window: [image.windowWidth, image.windowCenter], whiteFraction: white / lit, midGreyFraction: mid / lit });

    await importStudy(segmentationStudy);
    current = await state();
    const segmentations = current.series.filter(item => item.segmentation);
    assert(segmentations.length > 0, 'The study should list segmentations');
    assert(!current.series.find(item => item.id === current.activeSeriesId).segmentation, 'Import opens an image series, not a segmentation');
    const cards = page.locator('.series-card.is-segmentation');
    assert.equal(await cards.count(), segmentations.length);
    check('Segmentations list as segmentations, and import opens an image series', { segmentations: segmentations.length });

    const first = segmentations[0];
    const card = page.getByTestId(`series-${first.id}`);
    const before = current.view.slice;
    await card.click();
    await page.locator(`[data-testid="segmentation-overlay"] [data-segmentation="${first.id}"]`).first().waitFor({ timeout: 30_000 });
    await settled();
    current = await state();
    assert.deepEqual(current.shownSegmentations, [first.id]);
    assert.equal(await card.getAttribute('aria-pressed'), 'true');
    assert(current.segmentationFrames[first.id] > 0);
    assert.notEqual(current.view.slice, before, 'Showing a segmentation opens the image at the segmented region');
    const viewport = await page.locator('[data-testid="dicom-viewport"]').first().boundingBox();
    const outline = await page.locator(`[data-segmentation="${first.id}"] path`).nth(1).boundingBox();
    assert(outline.width > 0 && outline.x >= viewport.x && outline.x + outline.width <= viewport.x + viewport.width, 'The outline lies on the image');
    await page.screenshot({ path: path.join(output, 'segmentation.png') });
    const margin = 70;
    await page.screenshot({ path: path.join(output, 'segmentation-detail.png'), clip: {
      x: Math.max(viewport.x, outline.x - margin), y: Math.max(viewport.y, outline.y - margin),
      width: Math.min(outline.width + 2 * margin, viewport.width), height: Math.min(outline.height + 2 * margin, viewport.height) } });
    check('A segmentation draws over its image at the segmented region', { segmentation: first.description, slice: current.view.slice, frames: current.segmentationFrames[first.id] });

    await page.getByTestId('tool-mpr').click();
    await page.waitForFunction(() => document.querySelectorAll('canvas[data-renderer]').length === 3);
    for (const plane of ['axial', 'coronal', 'sagittal']) {
      await page.locator(`svg[data-testid="annotation-overlay"][data-plane="${plane}"] [data-segmentation="${first.id}"]`).first().waitFor({ timeout: 30_000 });
    }
    await settled();
    await page.screenshot({ path: path.join(output, 'segmentation-mpr.png') });
    for (const plane of ['axial', 'coronal', 'sagittal']) {
      const shape = await page.locator(`svg[data-testid="annotation-overlay"][data-plane="${plane}"] [data-segmentation="${first.id}"] path`).nth(1).boundingBox();
      await page.screenshot({ path: path.join(output, `segmentation-mpr-${plane}.png`), clip: { x: shape.x + shape.width / 2 - 70, y: shape.y + shape.height / 2 - 70, width: 140, height: 140 } });
    }
    check('The segmentation outlines its region in the axial, coronal and sagittal planes through it');
    await page.getByTestId('tool-mpr').click();
    await page.waitForFunction(() => document.querySelectorAll('canvas[data-renderer]').length === 1);

    await page.getByTestId('tool-3d').click();
    const view3d = page.getByTestId('volume-view');
    await page.waitForFunction(() => document.querySelector('[data-testid="volume-3d-canvas"]')?.width > 10, undefined, { timeout: 60_000 });
    await view3d.getByTestId('volume-segment-legend').waitFor();
    await view3d.getByTestId('volume-crop').click();
    await view3d.getByTestId('volume-crop-around-point').click();
    await view3d.getByTestId('volume-view-side').click();
    await page.waitForTimeout(800);
    assert.equal(await view3d.getByRole('alert').count(), 0, 'The 3D view reports no error');
    // The crop is framed around the segmentation: count pixels in its colour (any shade) near the centre.
    // The linked-point marker's translucent dark disc keeps that hue; its bright ring does not.
    const canvas3d = await view3d.getByTestId('volume-3d-canvas').boundingBox();
    const center3d = [canvas3d.x + canvas3d.width / 2, canvas3d.y + canvas3d.height / 2];
    const capture = await desktop.evaluate(async ({ BrowserWindow }, rect) => {
      const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage(rect);
      return { ...image.getSize(), data: image.toBitmap().toString('base64') };
    }, { x: Math.round(center3d[0] - 120), y: Math.round(center3d[1] - 120), width: 240, height: 240 });
    const rgb = first.segmentation.segments[0].color ?? [128, 174, 128], bitmap = Buffer.from(capture.data, 'base64');
    const scale = capture.width / 240;
    let coloured = 0;
    for (let y = 0; y < capture.height; y++) for (let x = 0; x < capture.width; x++) {
      // Shading scales all three channels alike; the bitmap is BGRA or RGBA, so compare channel ratios both ways.
      const at = (y * capture.width + x) * 4, pixel = [bitmap[at], bitmap[at + 1], bitmap[at + 2]];
      const like = order => order.every((channel, index) => Math.abs(pixel[index] * rgb[1] - rgb[channel] * pixel[1]) <= 0.08 * rgb[1] * Math.max(pixel[1], 1));
      if (pixel[1] > 30 && (like([0, 1, 2]) || like([2, 1, 0]))) coloured++;
    }
    assert(coloured / (scale * scale) >= 20, `The segmentation colour shows in 3D: ${coloured} pixels`);
    await page.screenshot({ path: path.join(output, 'segmentation-3d.png'), clip: { x: center3d[0] - 260, y: center3d[1] - 200, width: 520, height: 400 } });
    check('The 3D view draws the segmentation in its colour and lists it', { legend: await view3d.getByTestId('volume-segment-legend').textContent(), colouredPixels: Math.round(coloured / (scale * scale)) });
    await page.getByTestId('volume-close').click();

    await card.click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="segmentation-overlay"]'));
    assert.equal(await card.getAttribute('aria-pressed'), 'false');
    check('Selecting a shown segmentation hides it');

    if (voiStudy) {
      await importStudy(path.resolve(voiStudy));
      current = await state();
      assert.equal(current.displayedView.voiLut, 0, 'The frame displays with its VOI LUT');
      assert.match(await page.locator('[data-testid="image-overlay"]').first().textContent(), /VOI LUT/);
      let greys = await greyLevels();
      const between = greys.slice(4, 252).reduce((sum, n) => sum + n, 0);
      assert.equal(between, 0, `A step VOI LUT displays only black and white, not ${between} grey pixels`);
      assert(greys[255] > 0, 'The step VOI LUT shows white where values reach it');
      await page.screenshot({ path: path.join(output, 'voi-lut.png') });
      await page.evaluate(() => window.__VEACOM_TEST__.setView({ windowWidth: 30000 }));
      await settled();
      greys = await greyLevels();
      current = await state();
      assert.equal(current.displayedView.voiLut, undefined, 'A manual window replaces the VOI LUT');
      assert(greys.slice(4, 252).reduce((sum, n) => sum + n, 0) > 0, 'A manual window shows mid-greys');
      check('A VOI LUT displays exactly in DICOM window mode and gives way to a manual window');
    }

    if (sigmoidStudy) {
      await importStudy(path.resolve(sigmoidStudy));
      current = await state();
      assert.equal(current.displayedView.voiFunction, 'SIGMOID', 'The stored window follows its SIGMOID curve');
      assert.match(await page.locator('[data-testid="image-overlay"]').first().textContent(), /SIGMOID/);
      // The sigmoid never reaches black: the image's background (stored 0) shows 255 / (1 + exp(4c / w)),
      // grey 9 for this window, where a linear window draws it black.
      const { windowCenter: c, windowWidth: w } = current.displayedView;
      const background = Math.round(255 / (1 + Math.exp(4 * c / w)));
      const greys = await greyLevels(), total = greys.reduce((sum, n) => sum + n, 0);
      const atBackground = greys.slice(background - 1, background + 2).reduce((sum, n) => sum + n, 0);
      assert(background > 1 && atBackground > 0.1 * total, `The background shows grey ${background} through the SIGMOID curve: ${atBackground} of ${total} pixels`);
      await page.screenshot({ path: path.join(output, 'sigmoid-window.png') });
      await page.evaluate(() => window.__VEACOM_TEST__.setView({ windowWidth: 20000 }));
      await settled();
      current = await state();
      assert.equal(current.displayedView.windowMode, 'manual');
      assert.equal(current.displayedView.voiFunction, 'SIGMOID', 'Dragging the window keeps its curve');
      check('A SIGMOID window displays with its curve, also after a manual change');
    }

    assert.deepEqual(errors, [], `Renderer errors: ${errors.join('; ')}`);
    check('No renderer errors');
    await fs.writeFile(path.join(output, 'window-and-segmentation.json'), JSON.stringify({ passed: true, checks, errors }, null, 2));
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    await fs.writeFile(path.join(output, 'window-and-segmentation.json'), JSON.stringify({ passed: false, error: error.stack, checks, errors }, null, 2));
    throw error;
  } finally { await desktop.close(); await fs.rm(profile, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
