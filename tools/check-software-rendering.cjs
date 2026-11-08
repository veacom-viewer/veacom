// How VEAcom draws on this machine: with a graphics driver, in software (no usable driver), or not at all.
//
//   node tools/check-software-rendering.cjs <study> <output> [--expect software|hardware|any] [--label name] [-- <app switches>]
//
// Set VEACOM_SMOKE_EXECUTABLE to check a packaged app. Switches after `--` go to the app's command line
// (Chromium reads them exactly as if main.cjs appended them before `ready`). It records the renderer,
// Chromium's GPU feature status, whether an image was drawn (pixel statistics and a PNG of the viewport),
// the software-drawing notice and redraw timings, writes software-rendering.json, and fails unless the
// result matches --expect: software = image drawn in software with the notice; hardware = image drawn by
// a graphics driver without the notice. It still writes its evidence when it fails, so it also documents
// builds that predate the notice.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { isSoftwareRenderer } = require('./software-renderer.cjs');
const { ignoreOutsideInput, launchDesktop } = require('./lib/outside-input.cjs');

function parse(argv) {
  const split = argv.indexOf('--');
  const own = split >= 0 ? argv.slice(0, split) : argv, switches = split >= 0 ? argv.slice(split + 1) : [];
  const options = { positional: [], expect: 'software', label: '', switches };
  for (let i = 0; i < own.length; i++) {
    if (own[i] === '--expect') options.expect = own[++i];
    else if (own[i] === '--label') options.label = own[++i];
    else options.positional.push(own[i]);
  }
  if (options.positional.length !== 2 || !['software', 'hardware', 'any'].includes(options.expect)) {
    throw new Error('Usage: check-software-rendering.cjs <study> <output> [--expect software|hardware|any] [--label name] [-- <app switches>]');
  }
  return options;
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const percentile = (values, p) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null; };

async function main() {
  const options = parse(process.argv.slice(2));
  const [study, output] = options.positional.map(value => path.resolve(value));
  await fs.mkdir(output, { recursive: true });
  const packaged = process.env.VEACOM_SMOKE_EXECUTABLE;
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'veacom-software-'));
  const result = { label: options.label, expect: options.expect, switches: options.switches, executable: packaged ?? 'unpackaged',
    platform: process.platform, started: new Date().toISOString(), passed: false, failures: [], observations: {}, console: [], errors: [] };
  const observations = result.observations;
  const launched = performance.now();
  // VEACOM_ELECTRON runs this source tree on another Electron binary (diagnostics only).
  const executablePath = packaged ?? process.env.VEACOM_ELECTRON;
  const desktop = await launchDesktop({ ...(executablePath ? { executablePath } : {}),
    args: [...(packaged ? [] : [path.resolve(__dirname, '..')]), ...options.switches, '--study', study],
    env: { ...process.env, VEACOM_USER_DATA: userData }, timeout: 90_000 });
  let page;
  try {
    page = await desktop.firstWindow();
    // A scroll from the computer would move the slice while the redraws are timed.
    await ignoreOutsideInput(desktop);
    page.on('pageerror', error => result.errors.push(error.message));
    page.on('console', message => { if (['error', 'warning'].includes(message.type())) result.console.push(`${message.type()}: ${message.text()}`); });
    await page.waitForFunction(() => window.__VEACOM_TEST__, undefined, { timeout: 60_000 });
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 800));
    await page.waitForFunction(() => window.__VEACOM_TEST__.state().seriesReady, undefined, { timeout: 120_000 });
    observations.seriesReadyMs = Math.round(performance.now() - launched);
    // Wait for the viewport to draw (its canvas reports a renderer). Errors it shows meanwhile are kept: a
    // lost context can recover and draw later, so only an error still there after 30 s means no image.
    const drawn = await page.waitForFunction(() => {
      const alert = document.querySelector('.viewport-content [role="alert"]')?.textContent;
      if (alert) { const seen = (window.__veacomAlertsSeen ??= []); if (!seen.includes(alert)) seen.push(alert); }
      return Boolean(document.querySelector('canvas[data-renderer]'));
    }, undefined, { timeout: 30_000 }).then(() => true, () => false);
    observations.drawn = drawn;
    observations.viewportAlertsSeen = await page.evaluate(() => window.__veacomAlertsSeen ?? []);
    if (!drawn) observations.viewportError = await page.evaluate(() => document.querySelector('.viewport-content [role="alert"]')?.textContent ?? null);
    const outcome = { drawn };
    observations.firstImageMs = Math.round(performance.now() - launched);
    // Give the asynchronous graphics status a moment to arrive, so a missing notice is really missing.
    await pause(1500);
    observations.graphicsNotice = await page.evaluate(() => {
      const notice = document.querySelector('[data-testid="software-rendering-notice"]');
      const unavailable = document.querySelector('[data-testid="graphics-unavailable-notice"]');
      const marker = document.querySelector('[data-testid="software-rendering-status"]');
      return { softwareNotice: notice?.textContent ?? null, unavailableNotice: unavailable?.textContent ?? null, statusMarker: marker?.textContent ?? null,
        harness: window.__VEACOM_TEST__.state().graphics ?? null, harnessError: window.__VEACOM_TEST__.state().graphicsError ?? null,
        locale: document.querySelector('[data-testid="veacom-app"]')?.dataset.locale ?? null };
    });
    // The window as the user sees it, notice included.
    await page.screenshot({ path: path.join(output, 'window.png') });
    // Dismissing the notice must keep the status-bar marker. It also gives the viewport the same size as
    // on a machine without the notice, so its pixels compare directly with a hardware run.
    const dismiss = page.getByTestId('software-rendering-notice').getByTestId('graphics-notice-dismiss');
    if (await dismiss.count()) {
      await dismiss.click();
      await pause(300);
      observations.graphicsNotice.dismissed = await page.getByTestId('software-rendering-notice').count() === 0;
      observations.graphicsNotice.statusMarkerAfterDismiss = await page.getByTestId('software-rendering-status').count() ? await page.getByTestId('software-rendering-status').textContent() : null;
    }
    if (outcome.drawn) {
      await page.evaluate(() => window.__VEACOM_TEST__.setView({ slice: Math.floor(window.__VEACOM_TEST__.state().dimensions[2] / 2) }));
      await page.waitForFunction(() => +document.querySelector('canvas[data-slice]')?.dataset.slice === window.__VEACOM_TEST__.state().view.slice);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const canvas = page.locator('canvas[data-renderer]').first();
      Object.assign(observations, await canvas.evaluate(node => ({ renderer: node.dataset.renderer, appSoftwareRenderer: node.dataset.softwareRenderer ?? null })));
      const pixels = await canvas.evaluate(async node => {
        const { data } = node.getContext('2d').getImageData(0, 0, node.width, node.height);
        let lit = 0, sum = 0, squares = 0; const levels = new Set();
        for (let i = 0; i < data.length; i += 4) {
          const grey = (data[i] + data[i + 1] + data[i + 2]) / 3;
          if (Math.max(data[i], data[i + 1], data[i + 2]) > 8) lit++;
          sum += grey; squares += grey * grey; levels.add(data[i]);
        }
        const count = data.length / 4, mean = sum / count;
        const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map(byte => byte.toString(16).padStart(2, '0')).join('');
        return { width: node.width, height: node.height, slice: Number(node.dataset.slice), litFraction: lit / count, mean,
          standardDeviation: Math.sqrt(Math.max(0, squares / count - mean * mean)), distinctRedLevels: levels.size, sha256: digest, png: node.toDataURL('image/png') };
      });
      await fs.writeFile(path.join(output, 'viewport.png'), Buffer.from(pixels.png.split(',')[1], 'base64'));
      delete pixels.png;
      observations.pixels = pixels;
      observations.imageVisible = pixels.litFraction > 0.01 && pixels.distinctRedLevels >= 8;
      // Redraw cost: page through 20 slices, each awaited until displayed.
      observations.redraw = await page.evaluate(async () => {
        const test = window.__VEACOM_TEST__, canvas = document.querySelector('canvas[data-renderer]');
        const submit = []; const record = event => submit.push(event.detail.renderSubmitMs);
        canvas.addEventListener('veacom:frame', record);
        const steps = [], start = test.state().view.slice, count = test.state().dimensions[2];
        try {
          for (let i = 1; i <= 20; i++) {
            const slice = (start + i) % count, began = performance.now();
            test.setView({ slice });
            await new Promise((resolve, reject) => {
              const deadline = performance.now() + 15000;
              const poll = () => +canvas.dataset.slice === slice ? resolve() : performance.now() > deadline ? reject(new Error(`Slice ${slice} was not drawn`)) : requestAnimationFrame(poll);
              poll();
            });
            steps.push(performance.now() - began);
          }
        } finally { canvas.removeEventListener('veacom:frame', record); }
        return { stepsMs: steps, renderSubmitMs: submit };
      });
      for (const key of ['stepsMs', 'renderSubmitMs']) {
        const values = observations.redraw[key];
        observations.redraw[key.replace('Ms', 'Summary')] = { median: percentile(values, 0.5), p95: percentile(values, 0.95), max: Math.max(...values) };
      }
    }
    // getGPUInfo rejects when Chromium has no GPU process at all (for example --disable-gpu on macOS).
    observations.gpu = await desktop.evaluate(async ({ app }) => ({ features: app.getGPUFeatureStatus(), info: await app.getGPUInfo('basic').catch(error => ({ unavailable: error.message })) }));
    observations.toolSoftwareRenderer = observations.renderer ? isSoftwareRenderer(observations.renderer) : null;

    const software = observations.appSoftwareRenderer === 'true' || observations.toolSoftwareRenderer === true;
    const failures = result.failures;
    if (!observations.drawn) failures.push(`No image was drawn: ${observations.viewportError ?? 'no renderer reported'}`);
    else if (!observations.imageVisible) failures.push('The viewport stayed blank');
    if (options.expect === 'software') {
      if (observations.drawn && !software) failures.push(`Expected software drawing, got ${observations.renderer}`);
      if (!observations.graphicsNotice.softwareNotice) failures.push('The software-drawing notice was not shown');
      if (!observations.graphicsNotice.statusMarker) failures.push('The status bar does not say drawing is in software');
      else if (!observations.graphicsNotice.dismissed || !observations.graphicsNotice.statusMarkerAfterDismiss) failures.push('Dismissing the notice failed or removed the status-bar marker');
    } else if (options.expect === 'hardware') {
      if (software) failures.push(`Expected a graphics driver, got software drawing: ${observations.renderer}`);
      if (observations.graphicsNotice.softwareNotice || observations.graphicsNotice.statusMarker) failures.push('The software-drawing notice appeared with a graphics driver');
    }
    if (result.errors.length) failures.push(`Renderer errors: ${result.errors.join('; ')}`);
    result.passed = failures.length === 0;
  } catch (error) {
    result.failures.push(error.stack || error.message);
    if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  } finally {
    result.finished = new Date().toISOString();
    await fs.writeFile(path.join(output, 'software-rendering.json'), JSON.stringify(result, null, 2));
    await desktop.close().catch(() => {});
    await fs.rm(userData, { recursive: true, force: true }).catch(() => {});
  }
  const o = result.observations;
  console.log(`${result.passed ? 'PASS' : 'FAIL'} ${options.label || options.expect}: drawn=${o.drawn ?? false} renderer=${o.renderer ?? '-'} webgl=${o.gpu?.features?.webgl ?? '-'} notice=${Boolean(o.graphicsNotice?.softwareNotice)} redraw median=${o.redraw?.stepsSummary?.median?.toFixed?.(1) ?? '-'} ms`);
  for (const failure of result.failures) console.log(`  ${failure.split('\n')[0]}`);
  if (!result.passed) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
