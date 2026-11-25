// Read frame numbers from the compositor while the real playback control drives three synthetic DICOM clips.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright';
import { startTrace, readTrace } from './browser-bench/lib/trace.mjs';
import { median } from './browser-bench/lib/stats.mjs';
import { ignoreOutsideInput } from './lib/outside-input.cjs';
import { closeDesktop } from './lib/close-desktop.cjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { jpegjs } = require(path.join(path.dirname(require.resolve('playwright-core/package.json')), 'lib/utilsBundle.js'));
const output = path.resolve(process.argv[2] || 'test-results/cine-timing');
const dir = await mkdtemp(path.join(tmpdir(), 'veacom-cine-check-'));
const study = path.join(dir, 'clips');
const results = [], failures = [];

function check(ok, label) {
  if (!ok) failures.push(label);
}

function cadence(samples, start, end, label, refreshMs) {
  const readable = samples.filter(f => f.index !== null && f.at >= start && f.at <= end);
  const changes = readable.filter((f, i) => i === 0 || f.index !== readable[i - 1].index);
  const moves = changes.slice(1).map((f, i) => ({ to: f.index, steps: (f.index - changes[i].index + 60) % 60, ms: f.at - changes[i].at }));
  const elapsed = changes.length > 1 ? (changes.at(-1).at - changes[0].at) / 1000 : 0;
  const advanced = moves.reduce((n, m) => n + m.steps, 0);
  const summary = { elapsed, sourceFps: elapsed ? advanced / elapsed : null, shownFps: elapsed ? moves.length / elapsed : null,
    advances: advanced, skipped: advanced - moves.length, inOrder: moves.every(m => m.steps > 0 && m.steps < 30) };
  const fps = label === '40-fps' ? 40 : 20;
  const variable = label.startsWith('variable') && !label.endsWith('override');
  // The source defines forward intervals. The last-to-first loop boundary has no recorded interval.
  const adjacent = moves.filter(m => m.steps === 1 && m.to !== 0);
  const errors = adjacent.map(m => Math.abs(m.ms - (variable ? (m.to % 2 ? 25 : 75) : 1000 / fps))).sort((a, b) => a - b);
  summary.adjacent = adjacent.length;
  summary.withinOneRefresh = errors.filter(e => e <= refreshMs + 0.5).length;
  summary.absoluteErrorP95Ms = errors[Math.ceil(errors.length * 0.95) - 1] ?? null;
  summary.absoluteErrorMaxMs = errors.at(-1) ?? null;
  summary.groups = [1, 0].map(parity => {
    const times = adjacent.filter(m => m.to % 2 === parity).map(m => m.ms);
    return { nominalMs: variable ? (parity ? 25 : 75) : 1000 / fps, count: times.length, medianMs: median(times) };
  });
  return summary;
}

async function measure(page, label, refreshMs, control, enter = false) {
  const session = await page.context().newCDPSession(page);
  const debuggerEvents = new EventEmitter();
  // Eleven seconds at 60 Hz. The smaller screenshots fit Chromium's capture memory budget.
  debuggerEvents.sendCommand = (name, params) => session.send(name, name === 'Tracing.start'
    ? { ...params, screenshotMaxSize: 384, screenshotMaxCount: 700 } : params);
  for (const name of ['Tracing.dataCollected', 'Tracing.tracingComplete']) session.on(name, params => debuggerEvents.emit('message', null, name, params));
  try {
    const trace = await startTrace(debuggerEvents);
    // Mark the actual control event and each finished canvas submission on the screenshot trace's clock.
    await control.evaluate((element, eventType) => {
      const submitted = event => performance.mark('bench:submit:' + event.detail.slice);
      window.addEventListener('veacom:frame', submitted);
      window.addEventListener('bench:stop', () => window.removeEventListener('veacom:frame', submitted), { once: true });
      element.addEventListener(eventType, () => {
        performance.mark('bench:command');
        performance.mark('bench:initial:' + document.querySelector('canvas[data-slice]')?.dataset.slice);
      }, { once: true, capture: true });
    }, enter ? 'keydown' : 'click');
    if (enter) await control.press('Enter');
    else await control.click();
    await page.evaluate(async steadyMs => {
      // Keep the first second as startup evidence. Score more than three source loops after it.
      await new Promise(resolve => setTimeout(resolve, 1000));
      performance.mark('bench:motion');
      await new Promise(resolve => setTimeout(resolve, steadyMs));
      performance.mark('bench:end');
      window.dispatchEvent(new Event('bench:stop'));
    }, label === '40-fps' ? 5000 : 10_000);
    const events = await trace.stop();
    const { marks, frames } = readTrace(events, encoded => {
      const { width, height, data } = jpegjs.decode(Buffer.from(encoded, 'base64'), { useTArray: true });
      return { width, height, pixels: data };
    });
    const command = marks['bench:command'], start = marks['bench:motion'] - command, end = marks['bench:end'] - command;
    assert.ok(Number.isFinite(start) && end > start, label + ' control and observation marks');
    const submitted = events.filter(e => e.cat === 'blink.user_timing' && e.name.startsWith('bench:submit:'))
      .map(e => ({ at: e.ts / 1000 - command, index: Number(e.name.slice('bench:submit:'.length)) })).sort((a, b) => a.at - b.at);
    const captures = frames.map(f => ({ at: f.ts - command, index: f.unit / f.width > 0.008 ? f.index : null,
      expectedDisplayTime: f.expectedDisplayTime, sequence: f.sequence }));
    // Chromium's frame sink supplies an estimated display time alongside the screenshot callback. Require a
    // common microsecond clock before using it. Keep callback times and raw fields for independent inspection.
    const hasEstimate = captures.length > 0 && captures.every(f => Number.isFinite(f.expectedDisplayTime)
      && Math.abs(f.expectedDisplayTime / 1000 - command - f.at) < 10_000);
    const clocks = { submitted, captured: captures };
    if (hasEstimate) clocks.estimatedDisplay = captures.map(f => ({ at: f.expectedDisplayTime / 1000 - command, index: f.index })).sort((a, b) => a.at - b.at);
    const initial = Number(Object.keys(marks).find(name => name.startsWith('bench:initial:'))?.slice('bench:initial:'.length));
    assert.ok(Number.isInteger(initial) && initial >= 0 && initial < 60, label + ' initial source frame');
    const report = { label, refreshMs, initial, commandTraceMs: command, start, end, hasEstimate, clocks: {}, submitted, captures };
    results.push(report);
    for (const [clock, samples] of Object.entries(clocks)) {
      const firstChange = samples.find(f => f.at >= 0 && f.index !== null && f.index !== initial);
      const result = cadence(samples, start, end, label, refreshMs);
      report.clocks[clock] = { firstChangeMs: firstChange?.at ?? null, ...result };
      const where = label + ' ' + clock;
      check(result.advances >= 180 && result.inOrder && result.adjacent >= 12, where + ' must cover three complete loops in source order');
      for (const g of result.groups) check(g.count >= 10 && Math.abs(g.medianMs - g.nominalMs) <= refreshMs + 0.5, where + ' expected interval ' + g.nominalMs + ' ms');
      if (label !== 'variable' && label !== 'variable-restored') {
        const fps = label === '40-fps' ? 40 : 20;
        check(Math.abs(result.sourceFps - fps) <= fps * 0.05, where + ' must stay within 5% of ' + fps + ' fps');
      }
    }
    if (label === 'variable' && process.platform === 'linux') {
      // Preserve a recording of the same synthetic frames without adding a video encoder to the timed run.
      const folder = path.join(output, 'recording');
      await mkdir(folder, { recursive: true });
      const shots = frames.filter(f => f.ts >= command && f.ts < command + 3200);
      const sequence = ['ffconcat version 1.0'];
      for (const [i, shot] of shots.entries()) {
        const file = i + '.jpg';
        await writeFile(path.join(folder, file), Buffer.from(shot.jpeg, 'base64'));
        sequence.push('file ' + file, 'option framerate 1000');
        if (i + 1 < shots.length) sequence.push('duration ' + (shots[i + 1].ts - shot.ts) / 1000);
      }
      await writeFile(path.join(folder, 'frames.ffconcat'), sequence.join('\n') + '\n');
    }
    console.log(label, JSON.stringify(report.clocks));
  } finally { await session.detach(); }
}

let app;
try {
  await mkdir(output, { recursive: true });
  execFileSync(process.execPath, [path.join(root, 'tools/fixtures/make-cine-study.mjs'), study]);
  const packaged = process.env.VEACOM_SMOKE_EXECUTABLE;
  app = await _electron.launch({ ...(packaged ? { executablePath: packaged } : {}), args: [...(packaged ? [] : [root]), '--study', study],
    env: { ...process.env, VEACOM_USER_DATA: path.join(dir, 'profile'), VEACOM_TEST_MODE: '1', VEACOM_LOCALE: 'en', VEACOM_TELEMETRY_CONSENT: 'denied' }, timeout: 90_000 });
  const page = await app.firstWindow();
  await ignoreOutsideInput(app);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 820));
  await page.waitForFunction(() => window.__VEACOM_TEST__?.state().series.length === 3);
  const refreshMs = median(await page.evaluate(async () => {
    const times = [];
    for (let i = 0; i < 32; i++) times.push(await new Promise(resolve => requestAnimationFrame(resolve)));
    return times.slice(1).map((t, i) => t - times[i]);
  }));
  assert.ok(refreshMs > 0 && refreshMs < 40, 'Display refresh must resolve the short frame intervals');
  for (const clip of ['20-fps', '40-fps', 'variable']) {
    const id = await page.evaluate(name => {
      const h = window.__VEACOM_TEST__, item = h.state().series.find(s => s.description === name);
      h.selectSeries(item.id);
      return item.id;
    }, clip);
    await page.waitForFunction(id => {
      const s = window.__VEACOM_TEST__.state();
      return s.activeSeriesId === id && s.fullVolumeLoaded && s.dimensions[2] === 60;
    }, id);
    await page.waitForFunction(id => document.querySelector('canvas[data-series-id]')?.dataset.seriesId === id, id);
    await measure(page, clip, refreshMs, page.getByTestId('status-play'));
    const source = page.locator('[data-action="status-dicom-timing"]');
    assert.equal(await source.getAttribute('aria-pressed'), 'true');
    const input = page.getByTestId('status-fps');
    if (clip === 'variable') {
      await page.screenshot({ path: path.join(output, 'recorded-timing-en.png') });
      await page.getByTestId('tool-language').click();
      await page.getByTestId('language-tr').click();
      await page.locator('[data-testid="veacom-app"][data-locale="tr"]').waitFor();
      await page.screenshot({ path: path.join(output, 'recorded-timing-tr.png') });
      await input.fill('20');
      await measure(page, 'variable-override', refreshMs, input, true);
      assert.equal(await source.getAttribute('aria-pressed'), 'false');
      await measure(page, 'variable-restored', refreshMs, source);
      assert.equal(await source.getAttribute('aria-pressed'), 'true');
    } else assert.equal(Number(await input.inputValue()), Number.parseInt(clip, 10));
    await page.getByTestId('status-pause').click();
  }
  assert.deepEqual(failures, [], 'DICOM cine timing');
} finally {
  try {
    const manifest = JSON.parse(await readFile(path.join(study, 'manifest.json'), 'utf8'));
    await writeFile(path.join(output, 'results.json'), JSON.stringify({ manifest, failures, results }, null, 2) + '\n');
  } finally {
    await closeDesktop(app);
    await rm(dir, { recursive: true, force: true });
  }
}
