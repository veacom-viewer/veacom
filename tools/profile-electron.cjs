// Built-app startup resources, process-tree RSS, and repeated 2D slice updates.
// node tools/profile-electron.cjs --study=PATH --output=FILE.json [--runs=3] [--app=PATH]
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const assert = require('node:assert/strict');
const { ignoreOutsideInput, launchDesktop } = require('./lib/outside-input.cjs');
const exec = promisify(execFile);

const options = Object.fromEntries(process.argv.slice(2).map(argument => {
  const equal = argument.indexOf('='); return [argument.slice(2, equal), argument.slice(equal + 1)];
}));
assert(options.study && options.output, 'Pass --study=PATH and --output=FILE.json.');
const repo = path.resolve(options.app || path.join(__dirname, '..'));
const study = path.resolve(options.study);
const runs = Number(options.runs || 3);
assert(Number.isInteger(runs) && runs > 0);
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)];

async function memory(rootPid) {
  if (process.platform === 'win32') return null;
  const { stdout } = await exec('ps', ['-axo', 'pid=,ppid=,rss=,comm=']);
  const rows = stdout.split('\n').flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), rssKiB: Number(match[3]), name: path.basename(match[4]) }] : [];
  });
  const owned = new Set([rootPid]);
  for (let size = 0; size !== owned.size;) {
    size = owned.size;
    for (const row of rows) if (owned.has(row.parent)) owned.add(row.pid);
  }
  const processes = rows.filter(row => owned.has(row.pid));
  assert(processes.some(row => row.pid === rootPid), 'The test process must still be alive.');
  return { summedRssMiB: processes.reduce((total, row) => total + row.rssKiB, 0) / 1024, processes };
}

async function run(index, withStudy) {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'veacom-perf-'));
  let desktop;
  const started = performance.now();
  try {
    desktop = await launchDesktop({ args: [repo, ...(withStudy ? ['--study', study] : [])],
      env: { ...process.env, VEACOM_USER_DATA: profile, VEACOM_TEST_MODE: '1' }, timeout: 90_000 });
    const page = await desktop.firstWindow();
    // Real input from the computer would change what is measured; the window shows without taking it.
    await ignoreOutsideInput(desktop);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForFunction(() => document.querySelector('[data-testid="veacom-app"]')?.getAttribute('data-ready') === 'true');
    const readyMs = performance.now() - started;
    if (withStudy) await page.waitForFunction(() => window.__VEACOM_TEST__?.state().seriesReady, undefined, { timeout: 90_000 });
    const loadedMs = withStudy ? performance.now() - started : null;
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => document.fonts.ready);
    const cdp = await page.context().newCDPSession(page);
    // Chromium does not expose Resource Timing for this custom protocol. Ask for parsed scripts
    // and measure their built files instead; these are loaded module bytes, not network traffic.
    const scripts = new Set();
    cdp.on('Debugger.scriptParsed', script => {
      if (/^veacom:\/\/app\/assets\/[\w.-]+\.js$/.test(script.url)) scripts.add(new URL(script.url).pathname);
    });
    await cdp.send('Debugger.enable');
    await cdp.send('Debugger.disable');
    const resources = await Promise.all([...scripts].sort().map(async name => ({ name, bytes: (await fs.stat(path.join(repo, 'dist', name))).size })));
    assert(resources.length > 0, 'The profiler must observe the app entry module.');
    const snapshot = await memory(desktop.process().pid);
    await cdp.send('Performance.enable');
    const heap = await cdp.send('Runtime.getHeapUsage');
    let scroll = null;
    if (withStudy) {
      // Only on Windows, where ignoreOutsideInput does nothing: elsewhere the window is already shown and drawing, and on
      // macOS focus() would make the app the active one, which the helper answers by hiding it.
      if (process.platform === 'win32') await desktop.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.show(); window.focus(); });
      const before = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(metric => [metric.name, metric.value]));
      scroll = await page.evaluate(async () => {
        let tabIndexWrites = 0;
        const observer = new MutationObserver(records => { tabIndexWrites += records.length; });
        observer.observe(document.querySelector('[role="toolbar"]'), { attributes: true, subtree: true, attributeFilter: ['tabindex'] });
        const samples = [], renderSubmitMs = [];
        const frame = event => { if (Number.isFinite(event.detail.renderSubmitMs)) renderSubmitMs.push(event.detail.renderSubmitMs); };
        document.addEventListener('veacom:frame', frame);
        try {
          const count = window.__VEACOM_TEST__.state().dimensions[2];
          for (let i = 0; i < 120; i++) {
            const slice = (i + 1) % count;
            const start = performance.now();
            window.__VEACOM_TEST__.setView({ slice });
            await new Promise((resolve, reject) => {
              const check = () => {
                if (Number(document.querySelector('canvas[data-slice]')?.dataset.slice) === slice) resolve();
                else if (performance.now() - start > 5000) reject(new Error('Slice did not render.'));
                else requestAnimationFrame(check);
              };
              requestAnimationFrame(check);
            });
            samples.push(performance.now() - start);
          }
          tabIndexWrites += observer.takeRecords().length;
          return { samples, renderSubmitMs, tabIndexWrites };
        } finally { observer.disconnect(); document.removeEventListener('veacom:frame', frame); }
      });
      const after = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(metric => [metric.name, metric.value]));
      scroll.scriptMs = (after.ScriptDuration - before.ScriptDuration) * 1000;
      scroll.taskMs = (after.TaskDuration - before.TaskDuration) * 1000;
      scroll.layoutMs = (after.LayoutDuration - before.LayoutDuration) * 1000;
      scroll.p50Ms = percentile(scroll.samples, .5);
      scroll.p95Ms = percentile(scroll.samples, .95);
      scroll.renderSubmitP95Ms = percentile(scroll.renderSubmitMs, .95);
    }
    assert.deepEqual(errors, []);
    return { index, scenario: withStudy ? 'study-2d' : 'empty', readyMs, loadedMs, resources,
      jsBytes: resources.reduce((sum, entry) => sum + entry.bytes, 0), rendererHeapUsedMiB: heap.usedSize / 1024 ** 2,
      memory: snapshot, scroll, errors };
  } finally {
    if (desktop) await desktop.close();
    await fs.rm(profile, { recursive: true, force: true });
  }
}

(async () => {
  const results = [];
  for (let index = 1; index <= runs; index++) for (const withStudy of [false, true]) {
    const result = await run(index, withStudy); results.push(result);
    console.log(JSON.stringify({ scenario: result.scenario, run: index, readyMs: Math.round(result.readyMs),
      jsBytes: result.jsBytes, summedRssMiB: result.memory?.summedRssMiB, scrollP95Ms: result.scroll?.p95Ms,
      toolbarWrites: result.scroll?.tabIndexWrites }));
  }
  const report = { platform: process.platform, arch: process.arch, repo, study, capturedAt: new Date().toISOString(),
    notes: ['Fresh app profile per launch; OS file cache is not cleared.',
      'Summed RSS includes the Rust engine and Electron children, can count shared pages repeatedly, and is not unique physical RAM.',
      'Slice timings observe canvas submission on animation frames, not physical screen presentation or human input latency.',
      'Parsed JavaScript modules are observed through CDP after network idle and sized from the build; this is not transferred network data.',
      'Memory is a snapshot, not a peak.'], results };
  await fs.mkdir(path.dirname(path.resolve(options.output)), { recursive: true });
  await fs.writeFile(path.resolve(options.output), JSON.stringify(report, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
