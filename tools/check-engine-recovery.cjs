const { _electron: electron } = require('playwright');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const privileged = require('./privileged-imaging.cjs');
const { ignoreOutsideInput } = require('./lib/outside-input.cjs');
const { messages } = require('../electron/i18n.cjs');
const hash = value => createHash('sha256').update(value).digest('hex');

async function main() {
  if (process.platform === 'win32') throw new Error('This local crash probe uses POSIX process ownership checks.');
  const study = path.resolve(process.argv[2]);
  const output = path.resolve(process.argv[3] || 'test-results/engine-recovery');
  await fs.mkdir(output, { recursive: true });
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'veacom-recovery-'));
  const checks = [], errors = [];
  const nativeSha256 = hash(await fs.readFile(process.env.VEACOM_CORE_PATH || path.resolve(__dirname, '../native/target/release/veacom-core')));
  // The preceding crash test can trigger macOS's restore-windows prompt before Electron is ready.
  const restoreArgs = process.platform === 'darwin' ? ['-ApplePersistenceIgnoreState', 'YES'] : [];
  const desktop = await electron.launch({ args: [path.resolve(__dirname, '..'), '--study', study, ...restoreArgs],
    env: { ...process.env, VEACOM_USER_DATA: profile, VEACOM_TEST_MODE: '1' }, timeout: 90_000 });
  let page;
  const check = (name, detail) => { checks.push({ name, passed: true, detail }); console.log(`PASS ${name}`); };
  try {
    page = await desktop.firstWindow();
    // A scroll or key press from the person at the computer would move the slice off the measurement drawn below.
    await ignoreOutsideInput(desktop);
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForFunction(() => window.__VEACOM_TEST__?.state().fullVolumeLoaded, undefined, { timeout: 60_000 });
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 800));
    const canvas = page.locator('canvas[data-renderer]').first();
    await canvas.waitFor();
    await page.evaluate(() => window.__VEACOM_TEST__.setView({ slice: 10 }));
    await page.waitForFunction(() => +document.querySelector('canvas[data-renderer]').dataset.slice === 10);
    await page.getByTestId('tool-measure').click();
    await page.locator('[data-testid="tool-measure"][aria-pressed="true"]').waitFor();
    const bounds = await canvas.boundingBox();
    await page.mouse.move(bounds.x + bounds.width * 0.4, bounds.y + bounds.height * 0.45);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width * 0.6, bounds.y + bounds.height * 0.55, { steps: 5 });
    await page.mouse.up();
    // The measurement being drawn is shown as data-annotation-id="draft"; wait for the saved one.
    await page.locator('[data-annotation-id]:not([data-annotation-id="draft"])').first().waitFor();
    const dismiss = page.getByTestId('notice-dismiss');
    if (await dismiss.count()) await dismiss.click();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const before = await page.evaluate(() => ({ state: window.__VEACOM_TEST__.state(),
      annotationIds: [...document.querySelectorAll('[data-annotation-id]')].map(node => node.dataset.annotationId),
      canvasSize: [document.querySelector('canvas[data-renderer]').width, document.querySelector('canvas[data-renderer]').height], pixels: document.querySelector('canvas[data-renderer]').toDataURL() }));
    assert.equal(before.annotationIds.length, 1, 'The drawn measurement must still be shown before the engine is stopped.');
    await page.screenshot({ path: path.join(output, 'before-crash.png') });
    const processRows = execFileSync('ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8' }).split('\n');
    const owned = processRows.flatMap(row => {
      const match = row.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      return match && Number(match[2]) === desktop.process().pid && /(?:^|\/)veacom-core$/.test(match[3]) ? [Number(match[1])] : [];
    });
    assert.equal(owned.length, 1, 'Expected exactly one engine child owned by this isolated Electron process.');
    await page.evaluate(() => { window.__engineStates = []; window.veacom.onCoreState(state => window.__engineStates.push(state)); });
    process.kill(owned[0], 'SIGKILL');
    await page.waitForFunction(() => window.__engineStates.some(state => state.status === 'ready' && state.generation === 2), undefined, { timeout: 15_000 });
    // The main process's restart message, in whichever language the interface is using.
    const locale = await page.getByTestId('veacom-app').getAttribute('data-locale');
    const restartMessage = messages[locale]['engine.restartedEmpty'];
    await page.waitForFunction(text => document.querySelector('[data-testid="notice"][data-code="engine-restarted"]')?.textContent.includes(text), restartMessage);
    await page.screenshot({ path: path.join(output, 'recovery-notice.png') });
    await dismiss.click();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.waitForFunction(expected => document.querySelector('canvas[data-renderer]').toDataURL() === expected, before.pixels, { timeout: 3000 });
    const recoveredCatalog = await privileged.readCatalog(desktop);
    const after = await page.evaluate(({ catalog, generation }) => {
      return { state: window.__VEACOM_TEST__.state(),
        annotationIds: [...document.querySelectorAll('[data-annotation-id]')].map(node => node.dataset.annotationId),
        canvasSize: [document.querySelector('canvas[data-renderer]').width, document.querySelector('canvas[data-renderer]').height], pixels: document.querySelector('canvas[data-renderer]').toDataURL(), catalogCount: catalog.series.length,
        core: { generation }, states: window.__engineStates };
    }, recoveredCatalog);
    assert.equal(after.core.generation, 2); assert.equal(after.catalogCount, 0);
    check('Engine restarts with an empty catalog and no automatic reimport', { generation: after.core.generation, catalogCount: after.catalogCount });
    assert.deepEqual(after.state.loadedSeriesIds, before.state.loadedSeriesIds);
    assert.deepEqual(after.state.series, before.state.series);
    assert.equal(after.state.cachedBytes, before.state.cachedBytes);
    await fs.writeFile(path.join(output, 'pixel-comparison.json'), JSON.stringify({ before: { state: before.state, canvasSize: before.canvasSize, hash: hash(before.pixels) }, after: { state: after.state, canvasSize: after.canvasSize, hash: hash(after.pixels) } }, null, 2));
    assert.equal(hash(after.pixels), hash(before.pixels), 'Rendered pixels changed at identical canvas size after notice was dismissed.');
    assert.deepEqual(after.annotationIds, before.annotationIds);
    check('Loaded pixels, studies and annotations survive the crash', { cachedBytes: after.state.cachedBytes, annotationCount: after.annotationIds.length, renderedPngSha256: hash(after.pixels) });
    await page.screenshot({ path: path.join(output, 'after-recovery.png') });
    await page.keyboard.press('ControlOrMeta+z');
    await page.waitForFunction(() => !document.querySelector('[data-annotation-id]'));
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await page.locator('[data-annotation-id]').first().waitFor();
    await page.evaluate(() => window.__VEACOM_TEST__.setView({ slice: 11 }));
    await page.waitForFunction(() => +document.querySelector('canvas[data-renderer]').dataset.slice === 11);
    assert.notEqual(hash(await canvas.evaluate(node => node.toDataURL())), hash(before.pixels));
    check('Retained images still page and annotation undo/redo still works');
    await privileged.importPaths(desktop, page, [study]);
    await page.waitForFunction(() => window.__VEACOM_TEST__.state().fullVolumeLoaded && !window.__VEACOM_TEST__.state().pendingLoads);
    const freshCatalogCount = (await privileged.readCatalog(desktop)).catalog.series.length;
    assert(freshCatalogCount > 0);
    check('A fresh user import works after recovery', { catalogCount: freshCatalogCount });
    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(output, 'engine-recovery.json'), JSON.stringify({ passed: true, nativeSha256, nativeScope: 'Lifecycle recovery; binary hash identifies the exact build exercised.', checks, states: after.states, errors }, null, 2));
  } catch (error) {
    await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    await fs.writeFile(path.join(output, 'engine-recovery.json'), JSON.stringify({ passed: false, nativeSha256, checks, error: error.stack, errors }, null, 2));
    throw error;
  } finally { await desktop.close(); await fs.rm(profile, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
