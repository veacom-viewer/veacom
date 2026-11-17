// Usage: node tools/check-packaged-parity.cjs <packaged executable> <new evidence directory>
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const { ignoreOutsideInput } = require('./lib/outside-input.cjs');
const { closeDesktop } = require('./lib/close-desktop.cjs');
const { decodePng } = require('./lib/png.cjs');
const { toggleMpr } = require('./lib/mpr.cjs');

const state = page => page.evaluate(() => window.__VEACOM_TEST__.state());
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sliceScope = page => page.locator('input[name=scope][value=slice]');

async function withStudy(executablePath, study, destination, run) {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'veacom-parity-profile-'));
  let app, page;
  try {
    await fs.mkdir(destination);
    await fs.writeFile(path.join(profile, 'export-folder.json'), JSON.stringify({ folder: destination }));
    const env = { ...process.env, VEACOM_USER_DATA: profile, VEACOM_USAGE_CHECK_LOCAL: '1' };
    delete env.VEACOM_CORE_PATH;
    app = await electron.launch({ executablePath,
      ...(path.basename(study) === 'linked' ? { recordVideo: { dir: path.join(destination, 'video'), size: { width: 960, height: 640 } } } : {}),
      args: ['--study', study], env, timeout: 90_000 });
    const runtime = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, resources: process.resourcesPath, electron: process.versions.electron }));
    assert.equal(runtime.packaged, true);
    const engine = path.join(runtime.resources, 'native', process.platform === 'win32' ? 'veacom-core.exe' : 'veacom-core');
    runtime.engineSha256 = sha(await fs.readFile(engine));
    page = await app.firstWindow();
    await ignoreOutsideInput(app);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 800));
    await page.waitForFunction(() => window.__VEACOM_TEST__?.state().fullVolumeLoaded, undefined, { timeout: 90_000 });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const result = await run(page);
    assert.deepEqual(errors, []);
    return { runtime, renderer: await page.locator('canvas[data-renderer]').first().getAttribute('data-renderer'), ...result };
  } catch (error) {
    if (page) {
      await page.screenshot({ path: path.join(destination, 'failure.png') }).catch(() => {});
      console.error('Viewer notice:', await page.getByTestId('notice').allTextContents().catch(() => []));
    }
    throw error;
  } finally {
    try { await closeDesktop(app); } finally { await fs.rm(profile, { recursive: true, force: true }); }
  }
}

async function setSlice(page, index) {
  await page.evaluate(slice => window.__VEACOM_TEST__.setView({ slice }), index);
  await page.waitForFunction(i => window.__VEACOM_TEST__.state().displayedView?.slice === i, index);
}
async function exportFiles(page, destination, mode, scope, expected) {
  const prior = await fs.readdir(destination);
  if (await page.getByTestId('notice-dismiss').isVisible()) await page.getByTestId('notice-dismiss').click();
  await page.getByTestId('tool-export').click();
  await page.locator('[data-kind="' + mode + '"]').click();
  await page.locator('input[name=scope][value="' + scope + '"]').check();
  if (mode === 'media') await page.locator('input[name=target][value=folder]').check();
  assert.equal(await page.locator('.export-folder-path').getAttribute('title'), destination);
  await page.locator('input[data-action="export-open-after"]').uncheck();
  await page.getByTestId('export-submit').click();
  const notice = page.locator('[data-code="export-complete"], [data-code="export-failed"]');
  await notice.waitFor();
  assert.equal(await notice.getAttribute('data-code'), 'export-complete', await notice.textContent());
  const dirs = (await fs.readdir(destination, { withFileTypes: true })).filter(e => e.isDirectory() && !prior.includes(e.name));
  assert.equal(dirs.length, 1);
  const dir = path.join(destination, dirs[0].name);
  const files = path.join(dir, 'DICOM');
  const actual = await Promise.all((await fs.readdir(files)).map(async name => sha(await fs.readFile(path.join(files, name)))));
  assert.deepEqual(actual.sort(), [...expected].sort());
  return dir;
}
async function checkMpr(page, output) {
  await toggleMpr(page);
  await page.waitForFunction(() => document.querySelectorAll('canvas[data-renderer][data-mode="mpr"]').length === 3);
  const canvases = page.locator('canvas[data-renderer]');
  const planes = await canvases.evaluateAll(nodes => nodes.map(n => n.dataset.plane).sort());
  assert.deepEqual(planes, ['axial', 'coronal', 'sagittal']);
  // The phantom's central voxel is 1000 HU on black in all three planes. Moving by one slice removes it.
  await page.evaluate(() => window.__VEACOM_TEST__.setView({ windowCenter: 500, windowWidth: 1000 }));
  const centers = {};
  for (const plane of planes) {
    const canvas = page.locator('canvas[data-plane="' + plane + '"]');
    await canvas.click({ position: { x: 10, y: 10 } });
    const sample = async index => {
      await setSlice(page, index);
      await page.waitForFunction(({ plane, index }) => Number(document.querySelector('canvas[data-plane="' + plane + '"]').dataset.slice) === index, { plane, index });
      const png = decodePng(await canvas.screenshot({ style: '.annotation-overlay { visibility: hidden !important; }' }));
      return png.data[(Math.floor(png.height / 2) * png.width + Math.floor(png.width / 2)) * 4];
    };
    const center = await sample(4), adjacent = await sample(5);
    assert(center > 220 && adjacent < 30, plane + ' center=' + center + ' adjacent=' + adjacent);
    centers[plane] = { center, adjacent };
    await setSlice(page, 4);
  }
  const sagittal = page.locator('canvas[data-plane="sagittal"]');
  await sagittal.click({ position: { x: 10, y: 10 } });
  await setSlice(page, 4);
  await page.keyboard.press('ArrowDown');
  // The sagittal grid runs towards patient right as its index increases.
  await page.waitForFunction(() => window.__VEACOM_TEST__.state().view.slice === 3);
  await setSlice(page, 4);
  const coronal = page.locator('canvas[data-plane="coronal"]');
  await coronal.click({ position: { x: 10, y: 10 } });
  await page.evaluate(() => window.__VEACOM_TEST__.setView({ windowCenter: 400, windowWidth: 800 }));
  await page.waitForFunction(() => window.__VEACOM_TEST__.state().view.windowWidth === 800);
  await page.keyboard.press('1');
  await page.waitForFunction(() => window.__VEACOM_TEST__.state().view.windowWidth !== 800);
  const { windowCenter, windowWidth } = (await state(page)).view;
  assert.deepEqual([windowCenter, windowWidth], [500, 1000], '3200 HU outside this plane must not widen its range');
  await page.evaluate(() => window.__VEACOM_TEST__.setTool('rectangle'));
  const box = await coronal.boundingBox(), cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx - box.width * .17, cy - box.width * .13);
  await page.mouse.down(); await page.mouse.move(cx + box.width * .17, cy + box.width * .13, { steps: 4 }); await page.mouse.up();
  const roi = page.locator('[data-annotation-id]:not([data-annotation-id="draft"])').filter({ hasText: '1000.0' }).first();
  await roi.waitFor();
  const measured = await roi.textContent();
  await page.screenshot({ path: path.join(output, 'mpr.png') });
  await page.evaluate(() => window.__VEACOM_TEST__.setTool('pan'));
  await page.getByTestId('tool-export').click();
  assert.equal(await sliceScope(page).isDisabled(), true);
  await page.getByTestId('export-close').click();
  return { pixels: centers, window: [windowCenter, windowWidth], roi: measured };
}
async function checkLinked(page, series, output) {
  await page.getByTestId('tool-layout').click();
  await page.locator('[data-layout="1x2"]').click();
  const cells = page.getByTestId('viewport-cell'), ct = series.find(s => !s.description && s.modality === 'CT');
  const pick = async (n, item) => {
    await cells.nth(n).locator('.viewport-content').click({ position: { x: 40, y: 40 } });
    await page.getByTestId('series-' + item.id).click();
    await page.waitForFunction(id => { const s = window.__VEACOM_TEST__.state(); return s.activeSeriesId === id && s.fullVolumeLoaded; }, item.id);
  };
  const wheel = async () => {
    const s = await state(page), box = await cells.first().locator('canvas').boundingBox();
    assert(s.linked);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 120);
    await page.waitForFunction(before => window.__VEACOM_TEST__.state().panes[0].slice !== before, s.panes[0].slice);
    return (await state(page)).panes.map(p => p.slice);
  };
  await pick(1, ct); await pick(0, ct); await setSlice(page, 4);
  const parallel = await wheel();
  assert.equal(parallel[1], parallel[0]); assert.equal(Math.abs(parallel[0] - 4), 1);
  await pick(1, series.find(s => s.description === 'Coronal')); await setSlice(page, 1);
  await pick(0, ct); await setSlice(page, 4);
  const orthogonal = await wheel(); assert.equal(orthogonal[1], 1);
  await page.screenshot({ path: path.join(output, 'linked.png') });
  await pick(1, series.find(s => s.description === 'Scout')); await pick(0, ct); await setSlice(page, 4);
  const line = cells.nth(1).locator('[data-reference-plane] path');
  await line.waitFor({ state: 'attached' });
  assert(await line.evaluate(el => el.getTotalLength()) > 10);
  const visible = decodePng(await cells.nth(1).screenshot({ path: path.join(output, 'scout.png') }));
  const hidden = decodePng(await cells.nth(1).screenshot({ style: '[data-reference-plane] { visibility: hidden !important; }' }));
  assert.equal(visible.data.length, hidden.data.length);
  let changed = 0;
  for (let i = 0; i < visible.data.length; i += 4) {
    if (visible.data[i] - hidden.data[i] > 40 && visible.data[i] - visible.data[i + 2] > 80) changed++;
  }
  assert(changed > 20, 'Scout line missing from rendered pixels');
  return { parallel, orthogonal, scoutLinePixels: changed };
}

async function main() {
  const { makeParityStudies, fingerprints } = await import('./fixtures/make-parity-studies.mjs');
  assert.equal(process.argv.length, 4, 'Pass a packaged executable and a new evidence directory');
  const exe = path.resolve(process.argv[2]), output = path.resolve(process.argv[3]);
  await fs.mkdir(output);
  const fixture = path.join(output, 'studies'), hashes = await makeParityStudies(fixture);
  const results = { platform: process.platform, arch: process.arch, fingerprints, studies: {} };
  for (const [name, files] of Object.entries(hashes)) {
    const destination = path.join(output, name + '-exports'), expected = name === 'linked' ? 6 : 4;
    let dicomdir;
    const opened = await withStudy(exe, path.join(fixture, name), destination, async page => {
      await page.waitForFunction(count => window.__VEACOM_TEST__.state().series.length === count, expected);
      const { series } = await state(page);
      assert.deepEqual(series.filter(s => !s.dimensions[2]).map(s => s.modality).sort(), ['KO', 'PR', 'SR']);
      await setSlice(page, 4);
      await exportFiles(page, destination, 'dicom', 'slice', [files['4.dcm']]);
      dicomdir = path.join(await exportFiles(page, destination, 'media', 'all', Object.values(files)), 'DICOMDIR');
      const mpr = await checkMpr(page, destination);
      const sr = series.find(s => s.modality === 'SR');
      await page.getByTestId('series-' + sr.id).click();
      await page.waitForFunction(id => window.__VEACOM_TEST__.state().activeSeriesId === id, sr.id);
      assert.equal((await state(page)).pendingLoads, 0);
      await page.keyboard.press('ControlOrMeta+Alt+t');
      await page.locator('.tag-row').filter({ hasText: '2.25.9100012' }).first().waitFor();
      await page.getByTestId('tool-export').click(); assert(await sliceScope(page).isDisabled()); await page.getByTestId('export-close').click();
      const ct = series.find(s => s.modality === 'CT' && !s.description);
      await page.getByTestId('series-' + ct.id).click();
      await page.waitForFunction(() => window.__VEACOM_TEST__.state().fullVolumeLoaded);
      const linked = name === 'linked' ? await checkLinked(page, series, output) : undefined;
      return { files: Object.keys(files).length, mpr, linked };
    });
    const reopened = await withStudy(exe, dicomdir, path.join(output, name + '-readback'), async page => {
      await page.waitForFunction(count => window.__VEACOM_TEST__.state().series.length === count, expected);
      const { series } = await state(page);
      return { series: series.map(s => [s.modality, s.dimensions[2]]) };
    });
    results.studies[name] = { ...opened, reopened: reopened.series, dicomdir: path.relative(output, dicomdir) };
    await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2) + '\n');
    console.log('PASS', name, JSON.stringify(results.studies[name]));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
