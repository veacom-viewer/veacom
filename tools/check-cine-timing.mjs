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
const results = [];

async function measure(page, label, refreshMs) {
  const session = await page.context().newCDPSession(page);
  // startTrace also serves the Electron benchmark, which gets CDP events on its debugger's "message" channel.
  const debuggerEvents = new EventEmitter();
  debuggerEvents.sendCommand = (name, params) => session.send(name, params);
  for (const name of ['Tracing.dataCollected', 'Tracing.tracingComplete']) session.on(name, params => debuggerEvents.emit('message', null, name, params));
  try {
    const trace = await startTrace(debuggerEvents);
    await page.evaluate(async () => {
      performance.mark('bench:motion');
      await new Promise(resolve => setTimeout(resolve, 4000));
      performance.mark('bench:end');
    });
    const { marks, frames } = readTrace(await trace.stop(), encoded => {
      const { width, height, data } = jpegjs.decode(Buffer.from(encoded, 'base64'), { useTArray: true });
      return { width, height, pixels: data };
    });
    const readable = frames.filter(f => f.ts >= marks['bench:motion'] && f.ts <= marks['bench:end'] && f.index !== null && f.unit / f.width > 0.008);
    const changes = readable.filter((f, i) => i === 0 || f.index !== readable[i - 1].index);
    assert.ok(changes.length >= 12, label + ' needs at least 12 readable frame changes');
    const moves = changes.slice(1).map((f, i) => ({ to: f.index, steps: (f.index - changes[i].index + 60) % 60, ms: f.ts - changes[i].ts }));
    assert.ok(moves.every(m => m.steps > 0 && m.steps < 30), label + ' must play in source order');
    const elapsed = (changes.at(-1).ts - changes[0].ts) / 1000;
    const advanced = moves.reduce((n, m) => n + m.steps, 0);
    const summary = { label, refreshMs, elapsed, sourceFps: advanced / elapsed, shownFps: moves.length / elapsed, skipped: advanced - moves.length, moves };
    results.push(summary);
    if (label.startsWith('variable') && !label.endsWith('override')) {
      const adjacent = moves.filter(m => m.steps === 1 && m.to !== 0);
      const errors = adjacent.map(m => Math.abs(m.ms - (m.to % 2 ? 25 : 75))).sort((a, b) => a - b);
      for (const [parity, nominal] of [[1, 25], [0, 75]]) {
        const times = adjacent.filter(m => m.to % 2 === parity).map(m => m.ms);
        assert.ok(times.length >= 10, label + ' needs at least ten intervals of each duration');
        summary['median' + nominal + 'Ms'] = median(times);
      }
      summary.withinOneRefresh = errors.filter(e => e <= refreshMs + 0.5).length;
      summary.adjacentIntervals = errors.length;
      summary.absoluteErrorP95Ms = errors[Math.ceil(errors.length * 0.95) - 1];
      summary.absoluteErrorMaxMs = errors.at(-1);
    }
    console.log(label, JSON.stringify({ ...summary, moves: moves.length }));
    return summary;
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
    await page.getByTestId('status-play').click();
    const source = page.locator('[data-action="status-dicom-timing"]');
    assert.equal(await source.getAttribute('aria-pressed'), 'true');
    await page.getByTestId('status-fps').waitFor();
    // Exclude the first compilation and the panel opening from steady-state playback.
    await page.waitForTimeout(500);
    const native = await measure(page, clip, refreshMs);
    if (clip === 'variable') {
      assert.ok(Math.abs(native.median25Ms - 25) <= refreshMs + 0.5 && Math.abs(native.median75Ms - 75) <= refreshMs + 0.5, 'Recorded 25 and 75 ms intervals');
      await page.screenshot({ path: path.join(output, 'recorded-timing-en.png') });
      await page.getByTestId('tool-language').click();
      await page.getByTestId('language-tr').click();
      await page.locator('[data-testid="veacom-app"][data-locale="tr"]').waitFor();
      await page.screenshot({ path: path.join(output, 'recorded-timing-tr.png') });
      const input = page.getByTestId('status-fps');
      await input.fill('20'); await input.press('Enter');
      assert.equal(await source.getAttribute('aria-pressed'), 'false');
      const manual = await measure(page, 'variable-override', refreshMs);
      assert.ok(Math.abs(manual.sourceFps - 20) <= 1, '20 fps manual override');
      const adjacent = manual.moves.filter(m => m.steps === 1 && m.to !== 0);
      for (const parity of [0, 1]) {
        const group = adjacent.filter(m => m.to % 2 === parity).map(m => m.ms);
        assert.ok(group.length >= 10 && Math.abs(median(group) - 50) <= refreshMs + 0.5, 'Manual speed spaces both frame groups equally');
      }
      await source.click();
      assert.equal(await source.getAttribute('aria-pressed'), 'true');
      const restored = await measure(page, 'variable-restored', refreshMs);
      assert.ok(Math.abs(restored.median25Ms - 25) <= refreshMs + 0.5 && Math.abs(restored.median75Ms - 75) <= refreshMs + 0.5);
    } else {
      const fps = Number.parseInt(clip, 10);
      assert.equal(Number(await page.getByTestId('status-fps').inputValue()), fps);
      assert.ok(Math.abs(native.sourceFps - fps) <= fps * 0.05, 'Fixed DICOM playback within 5% of ' + fps);
    }
    await page.getByTestId('status-pause').click();
  }
} finally {
  try {
    const manifest = JSON.parse(await readFile(path.join(study, 'manifest.json'), 'utf8'));
    await writeFile(path.join(output, 'results.json'), JSON.stringify({ manifest, results }, null, 2) + '\n');
  } finally {
    await closeDesktop(app);
    await rm(dir, { recursive: true, force: true });
  }
}
