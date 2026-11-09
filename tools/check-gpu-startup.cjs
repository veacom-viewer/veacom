// node tools/check-gpu-startup.cjs SYNTHETIC_STUDY OUTPUT.json
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const privileged = require('./privileged-imaging.cjs');
const { ignoreOutsideInput } = require('./lib/outside-input.cjs');
const { closeDesktop } = require('./lib/close-desktop.cjs');

async function main() {
  assert(process.argv[2] && process.argv[3], 'Pass a synthetic study folder and output JSON path.');
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'veacom-gpu-startup-'));
  let desktop;
  try {
    desktop = await electron.launch({ args: [path.resolve(__dirname, '..')],
      env: { ...process.env, VEACOM_USER_DATA: profile, VEACOM_TEST_MODE: '1' }, timeout: 90_000 });
    const page = await desktop.firstWindow(), errors = [], checks = [];
    // A click or key press from the computer would change the panes this check counts.
    await ignoreOutsideInput(desktop);
    page.setDefaultTimeout(10_000);
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForFunction(() => document.querySelector('[data-testid="veacom-app"]')?.getAttribute('data-ready') === 'true');
    await page.evaluate(() => {
      const proof = window.__gpuStartup = { hold: true, polls: 0, frames: [] };
      const original = WebGL2RenderingContext.prototype.getProgramParameter;
      WebGL2RenderingContext.prototype.getProgramParameter = function (program, parameter) {
        if (parameter === 0x91B1) { proof.polls++; if (proof.hold) return false; }
        return original.call(this, program, parameter);
      };
      document.addEventListener('veacom:frame', event => proof.frames.push(event.detail.seriesId));
    });
    await privileged.importPaths(desktop, page, [path.resolve(process.argv[2])]);
    await page.waitForFunction(() => window.__gpuStartup.polls > 0);
    assert.equal(await page.locator('canvas[data-renderer]').count(), 0);
    checks.push('Pixel publication waits for shader readiness.');
    await page.getByTestId('tool-layout').click();
    await page.locator('[data-layout="1x2"]').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="viewport-cell"]').length === 2);
    assert.equal(await page.evaluate(() => window.__gpuStartup.frames.length), 0);
    checks.push('Layout controls remain usable while shader compilation is pending.');
    // A single pane has no Close control in the current UI; close the loaded pane beside an empty one.
    await page.locator('.viewport-cell:not([data-series-id=""])').getByTestId('viewport-close').focus();
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-testid')), 'viewport-close');
    assert.equal(await page.evaluate(() => window.__gpuStartup.frames.length), 0);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__VEACOM_TEST__.state().activeSeriesId === null);
    await page.evaluate(() => { window.__gpuStartup.hold = false; });
    await page.waitForFunction(() => {
      const state = window.__VEACOM_TEST__.state(); return state.loadedSeriesIds.length === 1 && state.pendingLoads === 0;
    });
    assert.equal(await page.locator('canvas[data-renderer]').count(), 0);
    assert.equal(await page.evaluate(() => window.__gpuStartup.frames.length), 0);
    checks.push('Finishing preparation does not reopen a closed pane or draw a stale image.');
    const id = await page.evaluate(() => window.__VEACOM_TEST__.state().series[0].id);
    await page.evaluate(id => window.__VEACOM_TEST__.selectSeries(id), id);
    await page.waitForFunction(id => document.querySelector('canvas[data-renderer]')?.dataset.seriesId === id, id);
    assert(await page.evaluate(id => window.__gpuStartup.frames.length > 0 && window.__gpuStartup.frames.every(value => value === id), id));
    checks.push('Reopening draws the requested study with the prepared program.');
    assert.deepEqual(errors, []);
    const output = path.resolve(process.argv[3]); await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, JSON.stringify({ passed: true, checks, errors, note: 'Completion status is deliberately held pending; this is a race/reliability check, not a timing benchmark.' }, null, 2));
    console.log(JSON.stringify({ passed: true, checks }));
  } finally {
    await closeDesktop(desktop);
    await fs.rm(profile, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
