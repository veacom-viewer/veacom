// Compare two built checkouts on the same machine and study; alternate launch order between pairs.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { promisify } = require('node:util');
const { ignoreOutsideInput, launchDesktop } = require('./lib/outside-input.cjs');
const exec = promisify(execFile);
const percentile = (values, q) => [...values].sort((a, b) => a - b)[Math.ceil(q * values.length) - 1];

async function memory(root) {
  const win = process.platform === 'win32';
  const { stdout } = win
    ? await exec('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.WorkingSetSize)" }'])
    : await exec('ps', ['-axo', 'pid=,ppid=,rss=']);
  const rows = stdout.trim().split(/\r?\n/).map(line => line.trim().split(/\s+/).map(Number));
  const owned = new Set([root]);
  for (let n = 0; n !== owned.size;) {
    n = owned.size;
    for (const [pid, parent] of rows) if (owned.has(parent)) owned.add(pid);
  }
  const sum = rows.filter(([pid]) => owned.has(pid)).reduce((total, row) => total + row[2], 0);
  assert(sum > 0);
  return sum / (win ? 1024 ** 2 : 1024);
}

// Capture the central 96 CSS pixels through Chromium's compositor. Reading the bitmap completes the capture.
async function capture(app, bounds) {
  return app.evaluate(async ({ BrowserWindow }, rect) => {
    const web = BrowserWindow.getAllWindows()[0].webContents;
    const until = performance.now() + 3000;
    let image, retries = 0;
    for (;;) {
      try {
        image = await web.capturePage(rect);
        if (!image.isEmpty()) break;
      } catch (error) {
        if (!String(error).includes('UnknownVizError')) throw error;
      }
      if (performance.now() >= until) throw new Error('No compositor frame available after 3 seconds');
      retries++;
      web.invalidate();
      await new Promise(resolve => setTimeout(resolve, 16));
    }
    const bitmap = image.toBitmap();
    let low = 255, high = 0;
    for (let i = 0; i < bitmap.length; i += 4) { low = Math.min(low, bitmap[i]); high = Math.max(high, bitmap[i]); }
    return { low, high, retries };
  }, bounds);
}

function startWindowsCapture() {
  const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'benchmark-screen.ps1')],
    { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
  const lines = createInterface({ input: ps.stdout })[Symbol.asyncIterator]();
  async function read() {
    const next = await lines.next();
    assert(!next.done, 'The Windows desktop capture process stopped');
    return next.value;
  }
  return {
    ready: async () => assert.equal(await read(), 'ready'),
    async sample(point) {
      ps.stdin.write(point.x + ' ' + point.y + '\n');
      const [low, high] = (await read()).split(' ').map(Number);
      assert(Number.isInteger(low) && Number.isInteger(high) && low >= 0 && low <= high && high <= 255);
      return { low, high, retries: 0 };
    },
    close() { ps.stdin.end(); ps.kill(); },
  };
}

async function measure(repo, study, steps) {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'veacom-ab-'));
  const screen = process.platform === 'win32' ? startWindowsCapture() : null;
  let app, stage = 'launch', timedOut = false;
  const limit = setTimeout(() => { timedOut = true; app?.process().kill('SIGKILL'); }, 180_000);
  try {
    if (screen) await screen.ready();
    const start = performance.now();
    app = await launchDesktop({ args: [repo, '--study', study], cwd: repo,
      env: { ...process.env, VEACOM_USER_DATA: profile, VEACOM_TEST_MODE: '1', VEACOM_TELEMETRY_CONSENT: 'denied' }, timeout: 120_000 });
    stage = 'first window';
    const page = await app.firstWindow({ timeout: 60_000 });
    await ignoreOutsideInput(app);
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.setContentSize(1000, 700);
      if (process.platform === 'win32') { win.setAlwaysOnTop(true); win.show(); }
    });
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(e.message));
    const canvas = page.locator('canvas[data-series-id][data-slice]').first();
    await canvas.waitFor({ timeout: 120_000 });
    const bounds = await canvas.boundingBox();
    assert(bounds && bounds.width >= 96 && bounds.height >= 96);
    const rect = { x: Math.round(bounds.x + (bounds.width - 96) / 2), y: Math.round(bounds.y + (bounds.height - 96) / 2), width: 96, height: 96 };
    const point = screen && await app.evaluate(({ BrowserWindow, screen }, rect) => {
      const bounds = BrowserWindow.getAllWindows()[0].getContentBounds();
      return screen.dipToScreenPoint({ x: bounds.x + rect.x, y: bounds.y + rect.y });
    }, rect);
    let captureRetries = 0;
    const grab = async () => {
      if (screen) {
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        return screen.sample(point);
      }
      const result = await capture(app, rect);
      captureRetries += result.retries;
      return result;
    };
    stage = 'first image';
    await grab();
    const firstFrameMs = performance.now() - start;
    // The end slices of the large CT fixture contain only air. Open the middle slice for a visible-tissue comparison.
    const middle = await page.evaluate(() => {
      const api = window.__VEACOM_TEST__, slice = Math.floor(api.state().dimensions[2] / 2);
      api.setView({ mode: 'source', plane: 'axial', slice });
      return slice;
    });
    await page.waitForFunction(slice => {
      const c = document.querySelector('canvas[data-series-id][data-slice]');
      return c?.dataset.slice === String(slice) && (!c.dataset.nativeRevision || c.dataset.nativePresented === c.dataset.nativeRevision);
    }, middle, { timeout: 60_000 });
    const firstFrameDeadline = performance.now() + 30_000;
    while ((await grab()).high === 0) {
      assert(performance.now() < firstFrameDeadline, 'Study pixels never appeared in the central compositor capture');
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    }
    const firstImageMs = performance.now() - start;
    await page.waitForFunction(() => {
      const s = window.__VEACOM_TEST__.state(); return s.loadedSeriesIds.includes(s.activeSeriesId);
    }, undefined, { timeout: 120_000 });
    const { dimensions, cachedBytes } = await page.evaluate(() => window.__VEACOM_TEST__.state());
    const timings = {};
    for (const [label, mode, plane, length] of [['source', 'source', 'axial', dimensions[2]], ['mpr', 'mpr', 'coronal', dimensions[1]]]) {
      stage = label;
      const times = [];
      let firstPlaneMs;
      // Time the first draw separately so reconstruction setup is visible.
      const offset = Math.max(0, Math.floor((length - steps - 1) / 2));
      for (let i = 0; i <= steps; i++) {
        const slice = (offset + i) % length, requested = performance.now();
        await page.evaluate(view => window.__VEACOM_TEST__.setView(view), { slice, mode, plane });
        await page.waitForFunction(({ slice, plane, mode }) => {
          const c = document.querySelector('canvas[data-series-id][data-slice]');
          return c?.dataset.slice === String(slice) && c.dataset.plane === plane && c.dataset.mode === mode &&
            (!c.dataset.nativeRevision || c.dataset.nativePresented === c.dataset.nativeRevision);
        }, { slice, plane, mode }, { timeout: 60_000 });
        await grab();
        const elapsed = performance.now() - requested;
        if (i === 0) firstPlaneMs = elapsed; else times.push(elapsed);
      }
      timings[label] = { firstPlaneMs, p50Ms: percentile(times, .5), p95Ms: percentile(times, .95), maxMs: Math.max(...times), samplesMs: times };
    }
    const renderer = await page.evaluate(async () => window.veacom.nativeRendering ? (await window.veacom.rendererInfo()).renderer : 'Chromium WebGL');
    const transport = await canvas.evaluate(c => c.dataset.nativeTransport || 'Chromium');
    const rssMiB = await memory(app.process().pid);
    assert.deepEqual(pageErrors, []);
    return { dimensions, firstFrameMs, firstImageMs, captureRetries, cachedVoxelMiB: cachedBytes / 1024 ** 2, rssMiB, renderer, transport, timings };
  } catch (error) {
    throw new Error((timedOut ? 'Benchmark timeout at ' : 'Benchmark failed at ') + stage + ': ' + error.message, { cause: error });
  } finally {
    clearTimeout(limit);
    screen?.close();
    if (app) {
      const stopping = setTimeout(() => app.process().kill('SIGKILL'), 10_000);
      try { await app.close(); } finally { clearTimeout(stopping); }
    }
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map(arg => {
    const eq = arg.indexOf('='); assert(eq >= 3 && arg.startsWith('--')); return [arg.slice(2, eq), arg.slice(eq + 1)];
  }));
  assert(args.before && args.after && args.study && args.output, 'Pass --before=DIR --after=DIR --study=DIR --output=FILE');
  const runs = Number(args.runs || 4), steps = Number(args.steps || 30);
  assert(Number.isInteger(runs) && runs > 0 && Number.isInteger(steps) && steps > 0);
  const paths = { before: path.resolve(args.before), after: path.resolve(args.after) };
  const revision = async dir => (await exec('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim();
  let report = { failures: [], platform: process.platform, release: os.release(), arch: os.arch(), cpu: os.cpus()[0].model,
    capture: process.platform === 'win32' ? 'Windows desktop pixels after two animation frames' : 'Chromium compositor pixels',
    study: path.basename(path.dirname(path.resolve(args.study))), runs, steps,
    commits: { before: await revision(paths.before), after: await revision(paths.after) }, samples: [] };
  if (args.resume === 'true') {
    const saved = JSON.parse(await fs.readFile(args.output, 'utf8'));
    for (const key of ['commits', 'study', 'runs', 'steps', 'platform', 'capture']) assert.deepEqual(saved[key], report[key]);
    report = { failures: [], ...saved };
  }
  for (let pair = 0; pair < runs; pair++) {
    for (const build of pair % 2 ? ['after', 'before'] : ['before', 'after']) {
      if (report.samples.some(sample => sample.pair === pair + 1 && sample.build === build)) continue;
      let result;
      try { result = await measure(paths[build], path.resolve(args.study), steps); }
      catch (error) {
        report.failures.push({ pair: pair + 1, build, error: error.message });
        await fs.writeFile(args.output, JSON.stringify(report, null, 2) + '\n');
        throw error;
      }
      const sample = { pair: pair + 1, build, ...result };
      report.samples.push(sample);
      await fs.writeFile(args.output, JSON.stringify(report, null, 2) + '\n');
      console.log(build, pair + 1, Math.round(sample.firstImageMs), Math.round(sample.timings.source.p95Ms), Math.round(sample.timings.mpr.p95Ms), Math.round(sample.rssMiB));
    }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
