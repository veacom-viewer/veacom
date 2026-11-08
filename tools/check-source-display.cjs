const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { ignoreOutsideInput, launchDesktop } = require('./lib/outside-input.cjs');

const fixtureRoot = path.resolve(process.argv[2]);
const output = path.resolve(process.argv[3]);
const before = process.argv.includes('--before');
const executablePath = process.env.VEACOM_SMOKE_EXECUTABLE;
const expectedGrey = (value, center, width) => Math.round(255 * Math.max(0, Math.min(1, (value - (center - .5)) / (width - 1) + .5)));

async function main() {
  await fs.mkdir(output, { recursive: true });
  const fixtures = JSON.parse(await fs.readFile(path.join(fixtureRoot, 'expected.json'), 'utf8'));
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'veacom-source-audit-'));
  const desktop = await launchDesktop({ ...(executablePath ? { executablePath } : {}),
    args: executablePath ? [] : [path.resolve(__dirname, '..')],
    env: { ...process.env, VEACOM_USER_DATA: profile, VEACOM_TEST_MODE: '1' }, timeout: 90000 });
  const checks = [], errors = [];
  let page, releaseVolume, releaseFrame, native;
  const check = (name, detail) => { checks.push({ name, passed: true, detail }); console.log(`PASS ${name}`); };
  const importStudy = async study => {
    const capabilities = before ? [study] : await desktop.evaluate(({ app }, paths) => app.__VEACOM_PRIVILEGED_TEST__.authorizeImportPaths(paths), [study]);
    await page.evaluate(capabilities => window.__VEACOM_TEST__.importPaths(capabilities), capabilities);
  };
  const settled = async () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const frame = async index => {
    await page.evaluate(index => window.__VEACOM_TEST__.setView({ slice: index }), index);
    await page.waitForFunction(index => +document.querySelector('canvas[data-slice]')?.dataset.slice === index, index);
    await settled();
  };
  const pixels = () => page.locator('canvas[data-renderer]').first().evaluate(canvas => {
    const context = canvas.getContext('2d');
    const scale = Math.min(canvas.width, canvas.height) / 64;
    return [-10, 0, 10].flatMap(y => [-10, 10].map(x => ({
      side: x < 0 ? 'left' : 'right', row: y,
      rgb: [...context.getImageData(Math.round(canvas.width / 2 + x * scale), Math.round(canvas.height / 2 + y * scale), 1, 1).data].slice(0, 3),
    })));
  });
  try {
    page = await desktop.firstWindow();
    // A key press or scroll from the computer would page or window the frames this check reads.
    await ignoreOutsideInput(desktop);
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForFunction(() => window.__VEACOM_TEST__);
    native = await page.evaluate(() => window.veacom?.nativeRendering === true);
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 800));
    if (!before) {
      const gate = await desktop.evaluate(({ app }) => app.__VEACOM_PRIVILEGED_TEST__.holdPixelRequests('volume'));
      releaseVolume = () => desktop.evaluate(({ app }, gate) => app.__VEACOM_PRIVILEGED_TEST__.releasePixelRequests(gate), gate);
    }
    await importStudy(fixtures.regular.path);
    await page.locator('canvas[data-renderer]').first().waitFor();
    if (!before) {
      await page.waitForFunction(() => document.querySelector('canvas[data-slice]')?.dataset.slice === '0');
      const frameGate = await desktop.evaluate(({ app }, kind) => app.__VEACOM_PRIVILEGED_TEST__.holdPixelRequests(kind, 4), native ? 'render' : 'frame');
      releaseFrame = () => desktop.evaluate(({ app }, gate) => app.__VEACOM_PRIVILEGED_TEST__.releasePixelRequests(gate), frameGate);
      await page.evaluate(() => window.__VEACOM_TEST__.setView({ slice: 4 }));
      await desktop.evaluate(({ app }, gate) => app.__VEACOM_PRIVILEGED_TEST__.waitForHeldPixelRequest(gate), frameGate);
      await settled();
      const waiting = await page.evaluate(() => ({ requested: window.__VEACOM_TEST__.state().view.slice,
        displayed: document.querySelector('canvas[data-slice]')?.dataset.slice,
        labels: [...document.querySelectorAll('.viewport-footer [data-export-label]')].map(node => node.textContent) }));
      assert.equal(waiting.requested, 4); assert.equal(waiting.displayed, '0');
      assert.match(waiting.labels[0], /^1 \/ 8/);
      assert.match(waiting.labels[1], /W 40.*L 100/);
      check('Delayed paging keeps exported labels on the actually displayed frame', waiting);
      await releaseFrame();
      await frame(4);
      const state = await page.evaluate(() => window.__VEACOM_TEST__.state());
      if (native) {
        assert.equal(state.nativeResident, true);
        const counts = await desktop.evaluate(({ app }) => app.__VEACOM_PRIVILEGED_TEST__.pixelRequestCounts());
        assert.equal(counts.volume ?? 0, 0, 'Native browsing must not request a whole volume');
      }
      assert.equal(state.fullVolumeLoaded, false);
      assert.equal(state.view.mode, 'source');
      const sample = await pixels(), truth = fixtures.regular.frames[4];
      for (const pixel of sample) for (const channel of pixel.rgb) assert(Math.abs(channel - expectedGrey(truth[pixel.side + 'Value'], truth.windowCenter, truth.windowWidth)) <= 1, JSON.stringify(pixel));
      check('Paging displays acquired frame4 while complete volume response is held', { state, sample });
      await page.screenshot({ path: path.join(output, 'progressive-source-frame.png') });
      await releaseVolume();
    }
    await page.waitForFunction(() => (window.__VEACOM_TEST__.state().seriesReady ?? window.__VEACOM_TEST__.state().fullVolumeLoaded), undefined, { timeout: 90000 });

    for (const [caseName, fixture] of Object.entries(fixtures)) {
      if (caseName !== 'regular') {
        await importStudy(fixture.path);
        await page.waitForFunction(() => (window.__VEACOM_TEST__.state().seriesReady ?? window.__VEACOM_TEST__.state().fullVolumeLoaded));
      }
      const imported = (await desktop.evaluate(({ app }) => app.__VEACOM_PRIVILEGED_TEST__.coreRequest('series'))).json;
      const metadata = imported.series.find(item => item.uid === fixture.seriesUid);
      assert(metadata, 'Missing imported fixture');
      if (!before) {
        assert.equal(metadata.canReconstruct, fixture.canReconstruct);
        assert.equal(metadata.frameMetadata.length, fixture.frames.length);
        for (let i = 0; i < fixture.frames.length; i++) {
          assert.equal(metadata.frameMetadata[i].windowCenter, fixture.frames[i].windowCenter);
          assert.equal(metadata.frameMetadata[i].windowWidth, fixture.frames[i].windowWidth);
          assert.equal(metadata.frameMetadata[i].instanceNumber, fixture.frames[i].instanceNumber);
          assert.equal(metadata.frameMetadata[i].sopInstanceUid, fixture.seriesUid + '.' + (i + 1));
          assert.deepEqual(metadata.frameMetadata[i].paddingRange, [-32768, -32768]);
          metadata.frameMetadata[i].origin.forEach((value, axis) => assert(Math.abs(value - fixture.frames[i].origin[axis]) < 1e-7));
        }
        check(caseName + ' native per-frame geometry/window/padding matches pydicom fixture');
      }
      for (const index of [0, 4, 7]) {
        await frame(index);
        const state = await page.evaluate(() => window.__VEACOM_TEST__.state());
        const sample = await pixels(), truth = fixture.frames[index];
        if (!before) {
          assert.equal(state.view.mode, 'source');
          assert.equal(state.view.windowCenter, truth.windowCenter);
          assert.equal(state.view.windowWidth, truth.windowWidth);
          for (const pixel of sample) for (const channel of pixel.rgb) assert(Math.abs(channel - expectedGrey(truth[pixel.side + 'Value'], truth.windowCenter, truth.windowWidth)) <= 1, JSON.stringify({ caseName, index, pixel }));
        }
        checks.push({ name: `${caseName} frame${index} acquired pixels and window`, passed: before ? null : true, state, sample });
        if (index === 4) await page.screenshot({ path: path.join(output, `${caseName}-frame4.png`) });
      }
      if (!before) {
        await page.evaluate(() => window.__VEACOM_TEST__.setView({ windowCenter: 555, windowWidth: 777 }));
        await frame(3);
        let state = await page.evaluate(() => window.__VEACOM_TEST__.state());
        assert.equal(state.view.windowCenter, 555); assert.equal(state.view.windowWidth, 777);
        check(caseName + ' manual window persists across acquired frames');
        await page.getByTestId('tool-window-presets').click();
        await page.getByTestId('preset-dicom').click();
        state = await page.evaluate(() => window.__VEACOM_TEST__.state());
        assert.equal(state.view.windowCenter, fixture.frames[3].windowCenter);
        assert.equal(state.view.windowWidth, fixture.frames[3].windowWidth);
        await page.getByTestId('tool-window-presets').click();
        await page.getByTestId('preset-auto').click();
        state = await page.evaluate(() => window.__VEACOM_TEST__.state());
        assert.equal(state.view.windowCenter, fixture.frames[3].autoWindowCenter);
        assert.equal(state.view.windowWidth, fixture.frames[3].autoWindowWidth);
        check(caseName + ' auto window excludes2496 padding pixels');
        if (fixture.canReconstruct) {
          await page.getByTestId('tool-mpr').click();
          await page.waitForFunction(() => document.querySelectorAll('canvas[data-renderer]').length === 3);
          assert.equal((await page.evaluate(() => window.__VEACOM_TEST__.state())).view.mode, 'mpr');
          await page.screenshot({ path: path.join(output, 'explicit-mpr.png') });
          assert.equal(await page.getByTestId('tool-mpr').getAttribute('aria-pressed'), 'true');
          await page.getByTestId('tool-mpr').click();
          assert.equal((await page.evaluate(() => window.__VEACOM_TEST__.state())).view.mode, 'source');
          check('MPR requires explicit selection and restores acquired view');
        } else assert.equal(await page.getByTestId('tool-mpr').isDisabled(), true);
      }
    }
    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(output, 'source-display.json'), JSON.stringify({ passed: before ? null : true, baseline: before, checks, errors }, null, 2));
  } catch (error) {
    await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    await fs.writeFile(path.join(output, 'source-display.json'), JSON.stringify({ passed: false, baseline: before, error: error.stack, checks, errors }, null, 2));
    throw error;
  } finally {
    await Promise.allSettled([releaseFrame?.(), releaseVolume?.()]);
    await desktop.close(); await fs.rm(profile, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
