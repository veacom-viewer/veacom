// Runs the exact WebGL pixel checks of tools/renderer-check.html inside the desktop app, so they use the
// app's own Chromium and graphics path: the GPU, or software drawing on a PC without a usable driver.
//
//   pnpm exec vite --host 127.0.0.1 --port 5188 --strictPort     (in another terminal)
//   node tools/check-renderer-suite.cjs <output> [-- <app switches>]
//
// VEACOM_SMOKE_EXECUTABLE selects a packaged app; VEACOM_TEST_URL overrides the page.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { ignoreOutsideInput, launchDesktop } = require('./lib/outside-input.cjs');

async function main() {
  const split = process.argv.indexOf('--');
  const switches = split >= 0 ? process.argv.slice(split + 1) : [];
  const output = path.resolve((split >= 0 ? process.argv.slice(2, split) : process.argv.slice(2))[0] ?? 'test-results/renderer-suite');
  const url = process.env.VEACOM_TEST_URL ?? 'http://127.0.0.1:5188/tools/renderer-check.html';
  const packaged = process.env.VEACOM_SMOKE_EXECUTABLE;
  await fs.mkdir(output, { recursive: true });
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'veacom-renderer-suite-'));
  const desktop = await launchDesktop({ ...(packaged ? { executablePath: packaged } : {}), args: [...(packaged ? [] : [path.resolve(__dirname, '..')]), ...switches],
    env: { ...process.env, VEACOM_DEV_URL: url, VEACOM_USER_DATA: userData }, timeout: 90_000 });
  let report = { passed: false, url, switches, executable: packaged ?? 'unpackaged' };
  try {
    const page = await desktop.firstWindow();
    // Leave the computer's own mouse and keyboard to the person at it, and keep drawing while the window is covered.
    await ignoreOutsideInput(desktop);
    await page.waitForFunction(() => window.rendererCheckResult, undefined, { timeout: 120_000 });
    const result = await page.evaluate(() => window.rendererCheckResult);
    const gpu = await desktop.evaluate(({ app }) => app.getGPUFeatureStatus());
    report = { ...report, passed: result.passed === true, checks: result.checks, renderer: result.renderer, suites: result.suites,
      failures: result.failures, results: result.results, error: result.error, webgl: gpu.webgl, gpuCompositing: gpu.gpu_compositing };
  } catch (error) { report.error = error.stack || error.message; }
  finally {
    await fs.writeFile(path.join(output, 'renderer-suite.json'), JSON.stringify(report, null, 2));
    await desktop.close().catch(() => {});
    await fs.rm(userData, { recursive: true, force: true }).catch(() => {});
  }
  console.log(`${report.passed ? 'PASS' : 'FAIL'} ${report.checks ?? 0} exact pixel checks on ${report.renderer?.renderer ?? 'no renderer'} (webgl ${report.webgl ?? '-'})`);
  for (const failure of report.failures ?? []) console.log(`  ${failure.name}`);
  if (report.error) console.log(`  ${String(report.error).split('\n')[0]}`);
  if (!report.passed) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
