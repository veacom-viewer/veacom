// Paired A/B performance and reliability evaluation suite covering gaps left by
// check-open-speed.cjs, check-beta-performance.cjs, and browser-bench:
//   1. Native engine decode vs pipe transfer split on signed 16-bit CT-1000, clinical unsigned 12-bit CT (-1024),
//      single-file 200-frame multi-frame CT, RLE-compressed CT, and rigid PET/CT registration (all SHA-256 verified).
//   2. Desktop Electron end-to-end opening (veacom:// transfer, preview vs full paint, canvas resize & gl.getError stalls).
//   3. Desktop interactive 2D paging (60 Hz & 120 Hz real mouseWheel), Window/Level drag (60 Hz), 3-pane linked MPR
//      scrolling, 3D VolumeView open & orbit FPS, and multi-process RSS/peak memory.
//
// Usage:
//   node tools/check-performance-suite.cjs --output=<dir> [--head=<appDir>] [--base=<appDir>]
//     [--studies=<cacheDir>] [--rounds=3] [--suite=all|engine|desktop] [--seed=1]
'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const { authorizeImportPaths } = require('./privileged-imaging.cjs');
const { ignoreOutsideInput } = require('./lib/outside-input.cjs');
const { closeDesktop } = require('./lib/close-desktop.cjs');
const { toggleMpr } = require('./lib/mpr.cjs');
const { createRandom, median, compareRounds } = require('./lib/open-speed.cjs');

const args = Object.fromEntries(process.argv.slice(2).map(arg => {
  const match = /^--([^=]+)(?:=(.*))?$/s.exec(arg);
  if (!match) throw new Error(`Unexpected argument: ${arg}`);
  return [match[1], match[2] ?? true];
}));

if (!args.output) {
  console.error('Usage: node tools/check-performance-suite.cjs --output=<dir> [--head=<appDir>] [--base=<appDir>] [--studies=<dir>] [--rounds=3] [--suite=all|engine|desktop]');
  process.exit(2);
}

const repo = path.resolve(__dirname, '..');
const output = path.resolve(args.output);
const studiesDir = path.resolve(args.studies || path.join(output, 'studies'));
const rounds = Number(args.rounds ?? 3);
const suite = String(args.suite ?? 'all');
const seed = Number(args.seed ?? 42);
assert(Number.isInteger(rounds) && rounds >= 1, 'rounds must be a positive integer');
assert(['all', 'engine', 'desktop'].includes(suite), 'suite must be all, engine, or desktop');

const roots = { head: path.resolve(args.head || repo) };
if (args.base) roots.base = path.resolve(args.base);
const buildNames = roots.base ? ['base', 'head'] : ['head'];
const exeName = process.platform === 'win32' ? 'veacom-core.exe' : 'veacom-core';
const coreBinary = root => path.join(root, 'native/target/release', exeName);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function ensureStudies() {
  fs.mkdirSync(studiesDir, { recursive: true });
  const fixtures = path.join(__dirname, 'fixtures');
  const ensure = (rel, script, scriptArgs) => {
    const dir = path.join(studiesDir, rel);
    if (fs.existsSync(path.join(dir, 'manifest.json'))) return dir;
    fs.rmSync(dir, { recursive: true, force: true });
    execFileSync(process.execPath, [path.join(fixtures, script), dir, ...scriptArgs], { stdio: 'inherit' });
    return dir;
  };
  return {
    ct1000: ensure('ct-1000', 'make-smoke-study.mjs', ['--pipe-volume']),
    ct100: ensure('ct-100', 'make-smoke-study.mjs', []),
    ct12bit: ensure('ct-12bit-500', 'make-perf-studies.mjs', ['ct-12bit-500']),
    multiframe: ensure('multiframe-200', 'make-perf-studies.mjs', ['multiframe-200']),
    rle: ensure('rle-100', 'make-perf-studies.mjs', ['rle-100']),
    followup: ensure('pet-followup', 'make-pet-followup.mjs', []),
  };
}

function loadEngineProcess(root) {
  return require(path.join(root, 'electron/engine-process.cjs')).EngineProcess;
}

async function benchEngineDataset(build, studyDir, expectedSha) {
  const root = roots[build];
  const EngineProcess = loadEngineProcess(root);
  const engine = new EngineProcess({
    binary: coreBinary(root),
    restartDelaysMs: [],
    spawnImpl: (file, list, opts) => spawn(file, list, { ...opts, env: { ...process.env, VEACOM_CACHE_MIB: '768' } }),
  });
  try {
    const conn = await engine.start();
    const t0 = performance.now();
    const impResp = await conn.request('import', { paths: [studyDir] });
    assert.equal(impResp.status, 200, `import failed on ${studyDir}`);
    const imported = await impResp.json();
    const importMs = performance.now() - t0;
    const series = imported.series[0];
    assert(series, `no series in ${studyDir}`);

    const t1 = performance.now();
    const frameResp = await conn.request('frame', { id: series.id, index: 0 });
    assert.equal(frameResp.status, 200, `frame failed on ${studyDir}`);
    let frameBytes = 0;
    for await (const chunk of frameResp.body) frameBytes += chunk.byteLength;
    const firstFrameMs = performance.now() - t1;
    assert(frameBytes > 0);

    const t2 = performance.now();
    const volResp = await conn.request('volume', { id: series.id });
    assert.equal(volResp.status, 200, `volume failed on ${studyDir}`);
    const volumeDecodeMs = performance.now() - t2;

    const t3 = performance.now();
    const chunks = [];
    let volumeBytes = 0;
    for await (const chunk of volResp.body) {
      chunks.push(chunk);
      volumeBytes += chunk.byteLength;
    }
    const volumePipeMs = performance.now() - t3;
    const hash = createHash('sha256');
    for (const chunk of chunks) hash.update(chunk);
    const sha256 = hash.digest('hex');
    if (expectedSha) assert.equal(sha256, expectedSha, `${build} pixel SHA-256 mismatch for ${studyDir}`);
    const volumeTotalMs = volumeDecodeMs + volumePipeMs;
    const pipeMiBs = (volumeBytes / (1024 * 1024)) / Math.max(volumePipeMs / 1000, 1e-6);
    return { importMs, firstFrameMs, volumeDecodeMs, volumePipeMs, volumeTotalMs, pipeMiBs, volumeBytes, sha256 };
  } finally {
    await engine.stop().catch(() => {});
  }
}

async function benchRegistration(build, followupDir) {
  const root = roots[build];
  const manifest = JSON.parse(fs.readFileSync(path.join(followupDir, 'manifest.json'), 'utf8'));
  const [prior, current] = ['prior', 'current'].map(name => manifest.studies.find(s => s.name === name));
  const EngineProcess = loadEngineProcess(root);
  const engine = new EngineProcess({ binary: coreBinary(root), restartDelaysMs: [] });
  try {
    const conn = await engine.start();
    const call = async (op, body) => {
      const resp = await conn.request(op, body);
      assert.equal(resp.status, 200, `${op} failed`);
      return resp.json();
    };
    const impPrior = await call('import', { paths: [path.join(followupDir, prior.folder)] });
    const impCurrent = await call('import', { paths: [path.join(followupDir, current.folder)] });
    const byMod = list => Object.fromEntries(list.series.map(s => [s.modality, s]));
    const p = byMod(impPrior), c = byMod(impCurrent);

    const t0 = performance.now();
    const ct = await call('register', { fixedId: c.CT.id, movingId: p.CT.id, fixedRevision: c.CT.sourceRevision, movingRevision: p.CT.sourceRevision });
    const ctRegisterMs = performance.now() - t0;

    const t1 = performance.now();
    const pet = await call('register', { fixedId: c.CT.id, movingId: p.PT.id, fixedRevision: c.CT.sourceRevision, movingRevision: p.PT.sourceRevision });
    const petRegisterMs = performance.now() - t1;

    return {
      ctRegisterMs,
      petRegisterMs,
      ctMatrixHash: createHash('sha256').update(JSON.stringify(ct.matrix)).digest('hex').slice(0, 16),
      petMatrixHash: createHash('sha256').update(JSON.stringify(pet.matrix)).digest('hex').slice(0, 16),
    };
  } finally {
    await engine.stop().catch(() => {});
  }
}

function linuxProcMemMiB(pid) {
  if (process.platform !== 'linux') return null;
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const field = name => Number(status.match(new RegExp(`^${name}:\\s+(\\d+) kB`, 'm'))?.[1] ?? 0) / 1024;
    return { rssMiB: field('VmRSS'), peakMiB: field('VmHWM') };
  } catch {
    return null;
  }
}

function findChildEnginePid(browserPid) {
  if (process.platform === 'win32') return null;
  const out = execFileSync('ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8' });
  const row = out.split('\n')
    .map(line => line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/))
    .find(m => m && Number(m[2]) === browserPid && /(?:^|\/)veacom-core$/.test(m[3]));
  return row ? Number(row[1]) : null;
}

async function benchDesktopInteractive(build, studies) {
  const root = roots[build];
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), `veacom-eval-${build}-`));
  let desktop;
  try {
    const env = { ...process.env, VEACOM_USER_DATA: profile, VEACOM_TEST_MODE: '1', VEACOM_CACHE_MIB: '512', VEACOM_CORE_PATH: coreBinary(root) };
    desktop = await electron.launch({ args: [root, '--force-device-scale-factor=1'], env, timeout: 90_000 });
    const page = await desktop.firstWindow();
    await ignoreOutsideInput(desktop);
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 800));
    await page.waitForFunction(() => document.querySelector('[data-testid="veacom-app"]')?.dataset.ready === 'true' && window.__VEACOM_TEST__, undefined, { timeout: 60_000 });
    await page.evaluate(() => document.fonts.ready);

    const errors = [];
    page.on('pageerror', error => errors.push(error.message));

    // Install instrumentation before opening ct-1000.
    await page.evaluate(() => {
      const perf = {
        started: 0, importReturned: 0,
        requests: [], bodyReads: [], frames: [], longTasks: [], rafGaps: [],
        canvasResizeMs: 0, getErrorMs: 0, domMutations: 0,
      };
      window.__EVAL__ = perf;
      const now = () => performance.now();
      const origFetch = window.fetch;
      window.fetch = async function (...a) {
        const started = now();
        const url = typeof a[0] === 'string' ? a[0] : a[0].url || String(a[0]);
        const rec = { path: new URL(url, location.href).pathname, started };
        perf.requests.push(rec);
        const resp = await origFetch.apply(this, a);
        rec.headers = now();
        return resp;
      };
      for (const prop of ['width', 'height']) {
        const desc = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, prop);
        Object.defineProperty(HTMLCanvasElement.prototype, prop, {
          ...desc,
          set(v) {
            const t = now();
            try { desc.set.call(this, v); } finally { perf.canvasResizeMs += now() - t; }
          },
        });
      }
      const origGetError = WebGL2RenderingContext.prototype.getError;
      WebGL2RenderingContext.prototype.getError = function (...a) {
        const t = now();
        try { return origGetError.apply(this, a); } finally { perf.getErrorMs += now() - t; }
      };
      document.addEventListener('veacom:frame', event => {
        const s = window.__VEACOM_TEST__.state();
        perf.frames.push({
          at: now(), slice: event.detail.slice, mode: event.detail.mode, plane: event.detail.plane,
          renderSubmitMs: event.detail.renderSubmitMs, fullVolumeLoaded: s.fullVolumeLoaded,
        });
      });
      const ltObs = new PerformanceObserver(list => {
        for (const e of list.getEntries()) perf.longTasks.push({ started: e.startTime, duration: e.duration });
      });
      ltObs.observe({ type: 'longtask', buffered: false });
      const mutObs = new MutationObserver(list => { perf.domMutations += list.length; });
      mutObs.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
      let prev;
      function tick(at) {
        if (prev !== undefined) perf.rafGaps.push({ at, gap: at - prev });
        prev = at;
        requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    });

    // 1. Open ct-1000 and wait for preview + full volume.
    const caps = await authorizeImportPaths(desktop, [studies.ct1000]);
    await page.evaluate(c => {
      window.__EVAL__.started = performance.now();
      window.__VEACOM_TEST__.importPaths(c).then(() => { window.__EVAL__.importReturned = performance.now(); });
    }, caps);
    await page.waitForFunction(() => window.__EVAL__.frames.some(f => f.fullVolumeLoaded), undefined, { timeout: 120_000 });
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));

    const openStats = await page.evaluate(() => {
      const p = window.__EVAL__;
      const previewFrame = p.frames.find(f => !f.fullVolumeLoaded) ?? p.frames[0];
      const fullFrame = p.frames.find(f => f.fullVolumeLoaded);
      const volReq = p.requests.find(r => r.path.startsWith('/_imaging/volume/'));
      const canvas = document.querySelector('canvas[data-testid="dicom-canvas"]');
      return {
        indexReadyMs: p.importReturned - p.started,
        firstPreviewSubmitMs: previewFrame ? previewFrame.at - p.started : null,
        fullHeadersMs: volReq ? volReq.headers - p.started : null,
        fullBodyReadMs: volReq && fullFrame ? fullFrame.at - volReq.headers : null,
        fullSubmitMs: fullFrame ? fullFrame.at - p.started : null,
        canvasResizeStallMs: p.canvasResizeMs,
        getErrorStallMs: p.getErrorMs,
        largestRafGapMs: Math.max(0, ...p.rafGaps.filter(g => g.at >= p.started).map(g => g.gap)),
        longTaskTotalMs: p.longTasks.filter(t => t.started >= p.started).reduce((s, t) => s + t.duration, 0),
        png: canvas ? canvas.toDataURL() : '',
      };
    });
    const openPixelHash = createHash('sha256').update(openStats.png).digest('hex').slice(0, 16);

    // Helper: run a timed real-input burst via Electron webContents.sendInputEvent.
    const canvasBox = await page.locator('canvas[data-testid="dicom-canvas"]').first().boundingBox();
    assert(canvasBox && canvasBox.width > 100 && canvasBox.height > 100, 'canvas box missing');
    const cx = Math.round(canvasBox.x + canvasBox.width / 2);
    const cy = Math.round(canvasBox.y + canvasBox.height / 2);

    async function measureWheelBurst(rate, count) {
      await page.evaluate(() => {
        window.__VEACOM_TEST__.setView({ slice: 500 });
      });
      await page.waitForFunction(() => window.__VEACOM_TEST__.state().view.slice === 500);
      await sleep(150);
      await page.evaluate(() => {
        window.__EVAL__.frames.length = 0;
        window.__EVAL__.longTasks.length = 0;
        window.__EVAL__.domMutations = 0;
        window.__EVAL__.burstStart = performance.now();
      });
      const sendStart = performance.now();
      for (let i = 0; i < count; i++) {
        const due = sendStart + (i * 1000) / rate;
        const wait = due - performance.now();
        if (wait > 0) await sleep(wait);
        await desktop.evaluate(({ BrowserWindow }, pt) => {
          BrowserWindow.getAllWindows()[0].webContents.sendInputEvent({
            type: 'mouseWheel', x: pt.x, y: pt.y, deltaX: 0, deltaY: -120, wheelTicksX: 0, wheelTicksY: -1, canScroll: true,
          });
        }, { x: cx, y: cy });
      }
      const lastInputAt = await page.evaluate(() => performance.now());
      // Wait for scrolling to settle (no new frame for 200 ms, up to 5 s).
      for (const deadline = performance.now() + 5000; performance.now() < deadline;) {
        const settled = await page.evaluate(() => {
          const f = window.__EVAL__.frames;
          return f.length > 0 && performance.now() - f[f.length - 1].at > 200;
        });
        if (settled) break;
        await sleep(30);
      }
      return page.evaluate(endAt => {
        const frames = window.__EVAL__.frames;
        const gaps = [];
        for (let i = 1; i < frames.length; i++) gaps.push(frames[i].at - frames[i - 1].at);
        const durationS = Math.max((endAt - window.__EVAL__.burstStart) / 1000, 0.01);
        const during = frames.filter(f => f.at <= endAt + 30);
        const distinct = new Set(during.map(f => f.slice)).size;
        const lastAt = frames.length ? frames[frames.length - 1].at : endAt;
        const submits = frames.map(f => f.renderSubmitMs);
        return {
          framesDelivered: frames.length,
          slicesPerSec: Number((distinct / durationS).toFixed(1)),
          settleLagMs: Number(Math.max(0, lastAt - endAt).toFixed(1)),
          p95SubmitGapMs: gaps.length ? Number(gaps.sort((a, b) => a - b)[Math.floor((gaps.length - 1) * 0.95)].toFixed(1)) : 0,
          maxSubmitGapMs: gaps.length ? Number(Math.max(...gaps).toFixed(1)) : 0,
          avgSubmitMs: submits.length ? Number((submits.reduce((a, b) => a + b, 0) / submits.length).toFixed(2)) : 0,
          longTasks: window.__EVAL__.longTasks.length,
          domMutations: window.__EVAL__.domMutations,
        };
      }, lastInputAt);
    }

    const paging60 = await measureWheelBurst(60, 60);
    const paging120 = await measureWheelBurst(120, 120);

    // 3. Interactive Window/Level drag at 60 Hz (left mouse drag).
    await page.evaluate(() => {
      window.__VEACOM_TEST__.setView({ windowMode: 'manual', windowWidth: 400, windowCenter: 40 });
    });
    await sleep(150);
    await page.evaluate(() => {
      window.__EVAL__.frames.length = 0;
      window.__EVAL__.longTasks.length = 0;
      window.__EVAL__.domMutations = 0;
      window.__EVAL__.burstStart = performance.now();
    });
    const dragSteps = 60, dragRate = 60;
    await desktop.evaluate(({ BrowserWindow }, pt) => {
      const wc = BrowserWindow.getAllWindows()[0].webContents;
      wc.sendInputEvent({ type: 'mouseMove', x: pt.x, y: pt.y });
      wc.sendInputEvent({ type: 'mouseDown', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
    }, { x: cx - 100, y: cy });
    const dragStart = performance.now();
    for (let i = 1; i <= dragSteps; i++) {
      const due = dragStart + (i * 1000) / dragRate;
      const wait = due - performance.now();
      if (wait > 0) await sleep(wait);
      await desktop.evaluate(({ BrowserWindow }, pt) => {
        BrowserWindow.getAllWindows()[0].webContents.sendInputEvent({
          type: 'mouseMove', x: pt.x, y: pt.y, button: 'left', modifiers: ['leftButtonDown'],
        });
      }, { x: cx - 100 + i * 3, y: cy + Math.round(Math.sin(i / 5) * 20) });
    }
    await desktop.evaluate(({ BrowserWindow }, pt) => {
      BrowserWindow.getAllWindows()[0].webContents.sendInputEvent({ type: 'mouseUp', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
    }, { x: cx - 100 + dragSteps * 3, y: cy });
    const wlEndAt = await page.evaluate(() => performance.now());
    for (const deadline = performance.now() + 3000; performance.now() < deadline;) {
      const settled = await page.evaluate(() => {
        const f = window.__EVAL__.frames;
        return f.length > 0 && performance.now() - f[f.length - 1].at > 200;
      });
      if (settled) break;
      await sleep(30);
    }
    const wl60 = await page.evaluate(endAt => {
      const frames = window.__EVAL__.frames;
      const gaps = [];
      for (let i = 1; i < frames.length; i++) gaps.push(frames[i].at - frames[i - 1].at);
      const durationS = Math.max((endAt - window.__EVAL__.burstStart) / 1000, 0.01);
      const during = frames.filter(f => f.at <= endAt + 30);
      const lastAt = frames.length ? frames[frames.length - 1].at : endAt;
      const submits = frames.map(f => f.renderSubmitMs);
      return {
        updatesPerSec: Number((during.length / durationS).toFixed(1)),
        settleLagMs: Number(Math.max(0, lastAt - endAt).toFixed(1)),
        p95SubmitGapMs: gaps.length ? Number(gaps.sort((a, b) => a - b)[Math.floor((gaps.length - 1) * 0.95)].toFixed(1)) : 0,
        avgSubmitMs: submits.length ? Number((submits.reduce((a, b) => a + b, 0) / submits.length).toFixed(2)) : 0,
        longTasks: window.__EVAL__.longTasks.length,
        domMutations: window.__EVAL__.domMutations,
      };
    }, wlEndAt);

    // 4. Memory snapshot after ct-1000 loaded and paged.
    const runtime = await desktop.evaluate(({ app, BrowserWindow }) => ({
      browserPid: process.pid,
      rendererPid: BrowserWindow.getAllWindows()[0].webContents.getOSProcessId(),
      metrics: app.getAppMetrics(),
    }));
    const enginePid = findChildEnginePid(runtime.browserPid);
    const engineMem = enginePid ? linuxProcMemMiB(enginePid) : null;
    const rendererMem = linuxProcMemMiB(runtime.rendererPid);
    const knownMems = [...runtime.metrics.map(m => linuxProcMemMiB(m.pid)), engineMem].filter(Boolean);
    const totalRssMiB = knownMems.length > 0 ? knownMems.reduce((sum, m) => sum + m.rssMiB, 0) : null;

    // 5. 3-Pane Linked MPR switch & 60 Hz scrolling.
    const mprT0 = performance.now();
    await toggleMpr(page);
    await page.waitForFunction(() => document.querySelectorAll('canvas[data-mode="mpr"]').length === 3, undefined, { timeout: 60_000 });
    const mprSwitchMs = performance.now() - mprT0;
    await sleep(200);
    const mprBox = await page.locator('canvas[data-mode="mpr"]').first().boundingBox();
    const mx = Math.round(mprBox.x + mprBox.width / 2), my = Math.round(mprBox.y + mprBox.height / 2);
    await page.evaluate(() => {
      window.__EVAL__.frames.length = 0;
      window.__EVAL__.longTasks.length = 0;
      window.__EVAL__.burstStart = performance.now();
    });
    const mprScrollStart = performance.now();
    for (let i = 0; i < 45; i++) {
      const due = mprScrollStart + (i * 1000) / 60;
      const wait = due - performance.now();
      if (wait > 0) await sleep(wait);
      await desktop.evaluate(({ BrowserWindow }, pt) => {
        BrowserWindow.getAllWindows()[0].webContents.sendInputEvent({
          type: 'mouseWheel', x: pt.x, y: pt.y, deltaX: 0, deltaY: -120, wheelTicksX: 0, wheelTicksY: -1, canScroll: true,
        });
      }, { x: mx, y: my });
    }
    const mprEndAt = await page.evaluate(() => performance.now());
    for (const deadline = performance.now() + 4000; performance.now() < deadline;) {
      const settled = await page.evaluate(() => {
        const f = window.__EVAL__.frames;
        return f.length > 0 && performance.now() - f[f.length - 1].at > 200;
      });
      if (settled) break;
      await sleep(30);
    }
    const mpr60 = await page.evaluate(endAt => {
      const frames = window.__EVAL__.frames.filter(f => f.plane === 'axial');
      const gaps = [];
      for (let i = 1; i < frames.length; i++) gaps.push(frames[i].at - frames[i - 1].at);
      const durationS = Math.max((endAt - window.__EVAL__.burstStart) / 1000, 0.01);
      const distinct = new Set(frames.filter(f => f.at <= endAt + 30).map(f => f.slice)).size;
      const lastAt = frames.length ? frames[frames.length - 1].at : endAt;
      return {
        slicesPerSec: Number((distinct / durationS).toFixed(1)),
        settleLagMs: Number(Math.max(0, lastAt - endAt).toFixed(1)),
        p95SubmitGapMs: gaps.length ? Number(gaps.sort((a, b) => a - b)[Math.floor((gaps.length - 1) * 0.95)].toFixed(1)) : 0,
        longTasks: window.__EVAL__.longTasks.length,
      };
    }, mprEndAt);

    assert.deepEqual(errors, [], `Page errors during desktop eval: ${errors.join('; ')}`);
    return {
      open: {
        indexReadyMs: Number(openStats.indexReadyMs.toFixed(1)),
        firstPreviewSubmitMs: openStats.firstPreviewSubmitMs !== null ? Number(openStats.firstPreviewSubmitMs.toFixed(1)) : null,
        fullHeadersMs: openStats.fullHeadersMs !== null ? Number(openStats.fullHeadersMs.toFixed(1)) : null,
        fullBodyReadMs: openStats.fullBodyReadMs !== null ? Number(openStats.fullBodyReadMs.toFixed(1)) : null,
        fullSubmitMs: openStats.fullSubmitMs !== null ? Number(openStats.fullSubmitMs.toFixed(1)) : null,
        canvasResizeStallMs: Number(openStats.canvasResizeStallMs.toFixed(1)),
        getErrorStallMs: Number(openStats.getErrorStallMs.toFixed(1)),
        largestRafGapMs: Number(openStats.largestRafGapMs.toFixed(1)),
        longTaskTotalMs: Number(openStats.longTaskTotalMs.toFixed(1)),
        pixelHash: openPixelHash,
      },
      paging60,
      paging120,
      wl60,
      mpr: { switchMs: Number(mprSwitchMs.toFixed(1)), ...mpr60 },
      memory: {
        engineRssMiB: engineMem ? Number(engineMem.rssMiB.toFixed(1)) : null,
        enginePeakMiB: engineMem ? Number(engineMem.peakMiB.toFixed(1)) : null,
        rendererRssMiB: rendererMem ? Number(rendererMem.rssMiB.toFixed(1)) : null,
        rendererPeakMiB: rendererMem ? Number(rendererMem.peakMiB.toFixed(1)) : null,
        totalRssMiB: totalRssMiB !== null ? Number(totalRssMiB.toFixed(1)) : null,
      },
    };
  } finally {
    if (desktop) await closeDesktop(desktop);
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

function flattenMetrics(obj, prefix = '') {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, flattenMetrics(v, key));
    else if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
  }
  return out;
}

const HIGHER_IS_BETTER = /PerSec$|MiBs$/;

function summarize(allRounds) {
  const keys = Object.keys(flattenMetrics(allRounds[0].head));
  const rows = [];
  for (const key of keys) {
    const headVals = allRounds.map(r => flattenMetrics(r.head)[key]).filter(Number.isFinite);
    const row = { metric: key, head: Number(median(headVals).toFixed(2)) };
    if (roots.base) {
      const baseVals = allRounds.map(r => flattenMetrics(r.base)[key]).filter(Number.isFinite);
      row.base = Number(median(baseVals).toFixed(2));
      const higherBetter = HIGHER_IS_BETTER.test(key);
      if (row.base === 0 && row.head === 0) {
        row.changePct = 0;
        row.verdict = 'same';
      } else if (row.base === 0) {
        row.changePct = null;
        row.verdict = Math.abs(row.head) >= 0.5 ? (higherBetter ? 'faster' : 'slower') : 'same';
      } else if (row.head === 0) {
        row.changePct = -100;
        row.verdict = Math.abs(row.base) >= 0.5 ? (higherBetter ? 'slower' : 'faster') : 'same';
      } else {
        row.changePct = Number((((row.head - row.base) / row.base) * 100).toFixed(1));
        const cmp = compareRounds(allRounds.map(r => ({ base: flattenMetrics(r.base)[key], head: flattenMetrics(r.head)[key] })), { threshold: 0.03, minMs: 0.5, seed });
        row.verdict = cmp.verdict;
        if (higherBetter && cmp.verdict === 'faster') row.verdict = 'slower';
        else if (higherBetter && cmp.verdict === 'slower') row.verdict = 'faster';
      }
    }
    rows.push(row);
  }
  return rows;
}

function formatMarkdown(summary) {
  const lines = [
    '# VEAcom Performance Evaluation',
    '',
    'Desktop frame metrics (`*SubmitMs`, `*SubmitGapMs`) measure `veacom:frame` CPU render submission (`cpu-render-submit-and-composite`), not display presentation.',
    '',
  ];
  if (roots.base) {
    lines.push('| Metric | Base median | Head median | Change | Verdict |');
    lines.push('| --- | ---: | ---: | ---: | --- |');
    for (const r of summary) {
      const change = r.changePct === null ? `n/a (+${r.head})` : `${r.changePct > 0 ? '+' : ''}${r.changePct}%`;
      lines.push(`| \`${r.metric}\` | ${r.base} | ${r.head} | ${change} | ${r.verdict} |`);
    }
  } else {
    lines.push('| Metric | Head median |');
    lines.push('| --- | ---: |');
    for (const r of summary) lines.push(`| \`${r.metric}\` | ${r.head} |`);
  }
  return lines.join('\n') + '\n';
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const studies = ensureStudies();
  const manifests = {
    ct1000: JSON.parse(fs.readFileSync(path.join(studies.ct1000, 'manifest.json'), 'utf8')),
    ct12bit: JSON.parse(fs.readFileSync(path.join(studies.ct12bit, 'manifest.json'), 'utf8')),
    multiframe: JSON.parse(fs.readFileSync(path.join(studies.multiframe, 'manifest.json'), 'utf8')),
    rle: JSON.parse(fs.readFileSync(path.join(studies.rle, 'manifest.json'), 'utf8')),
  };
  const random = createRandom(seed);
  const results = [];

  for (let round = 1; round <= rounds; round++) {
    const order = buildNames.length === 2 && random() < 0.5 ? ['head', 'base'] : [...buildNames];
    const entry = { round, order };
    for (const build of order) {
      const measured = {};
      if (suite === 'all' || suite === 'engine') {
        measured.engine = {
          ct1000: await benchEngineDataset(build, studies.ct1000, manifests.ct1000.pixelSha256),
          ct12bit: await benchEngineDataset(build, studies.ct12bit, manifests.ct12bit.pixelSha256),
          multiframe: await benchEngineDataset(build, studies.multiframe, manifests.multiframe.pixelSha256),
          rle: await benchEngineDataset(build, studies.rle, manifests.rle.pixelSha256),
          registration: await benchRegistration(build, studies.followup),
        };
      }
      if (suite === 'all' || suite === 'desktop') {
        measured.desktop = await benchDesktopInteractive(build, studies);
      }
      entry[build] = measured;
      console.log(`Round ${round}/${rounds} [${build}] complete`);
    }
    if (roots.base) {
      if (entry.base.engine && entry.head.engine) {
        assert.equal(entry.head.engine.registration.ctMatrixHash, entry.base.engine.registration.ctMatrixHash, 'CT registration hash diverged');
        assert.equal(entry.head.engine.registration.petMatrixHash, entry.base.engine.registration.petMatrixHash, 'PET registration hash diverged');
      }
      if (entry.base.desktop && entry.head.desktop) {
        assert.equal(entry.head.desktop.open.pixelHash, entry.base.desktop.open.pixelHash, 'Rendered CT-1000 pixel hash diverged between base and head');
      }
    }
    results.push(entry);
  }

  const summary = summarize(results);
  const report = { createdAt: new Date().toISOString(), rounds, suite, roots, summary, results };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  const md = formatMarkdown(summary);
  fs.writeFileSync(path.join(output, 'report.md'), md);
  console.log('\n' + md);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
