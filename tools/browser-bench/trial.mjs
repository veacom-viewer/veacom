// One trial of the browser benchmark, in a fresh Electron (tools/browser-bench/run.mjs starts one per trial, so no trial inherits
// another's GPU process, caches or memory). It opens the viewer in a new window and profile, hands it the study as a
// user would, and measures from Chromium's own trace what the screen showed: opening, paging at fixed wheel rates and
// window/level dragging. It writes one JSON result to the path its spec names.
//   <electron> tools/browser-bench/trial.mjs <spec.json>
import { app, BrowserWindow, nativeImage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openMetrics, pagingMetrics, perNotch, windowLevelMetrics } from './lib/metrics.mjs';
import { readPicture, readTrace, startTrace } from './lib/trace.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const spec = JSON.parse(fs.readFileSync(process.argv.at(-1), 'utf8'));

// A background window must draw as a foreground one does.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
// A Linux runner has no GPU, and Chromium refuses WebGL on the Mesa software driver there (llvmpipe) unless told to use
// it, as the app's own CI checks do (electron/main.cjs). Every viewer then draws on the same software path.
if (process.platform === 'linux' && process.env.VEACOM_SOFTWARE_GL === 'llvmpipe') app.commandLine.appendSwitch('ignore-gpu-blocklist');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const QUIET_SHARE = 0.2, QUIET_MS = 2000, OPEN_LIMIT_MS = 120_000;
// A marker counts as the main pane when its cells are at least this share of the picture's width (lib/metrics.mjs).
const MAIN = 0.0035;
const WIDTH = spec.width, HEIGHT = spec.height, RATES = spec.rates;
const SCENARIOS = new Set(spec.scenarios);
const decode = base64 => { const image = nativeImage.createFromBuffer(Buffer.from(base64, 'base64')); const { width, height } = image.getSize(); return { width, height, pixels: image.toBitmap() }; };
const processes = () => app.getAppMetrics().filter(metric => metric.type !== 'Browser');
const memoryMB = metrics => Math.round(metrics.reduce((total, m) => total + (m.memory.privateBytes ?? m.memory.workingSetSize), 0) / 1024);

/** What the window shows now: the main marker, in window coordinates. */
async function look(win) {
  const image = await win.webContents.capturePage();
  const { width, height } = image.getSize(), scale = width / win.getContentBounds().width;
  const picture = readPicture({ width, height, pixels: image.toBitmap() });
  return picture.index === null || picture.unit < MAIN * width ? null
    : { index: picture.index, x: (picture.x + picture.bandWidth / 2) / scale, y: (picture.y + 2 * picture.unit) / scale, unit: picture.unit / scale, top: picture.y / scale };
}

function wheel(win, at, direction) {
  win.webContents.sendInputEvent({ type: 'mouseWheel', x: Math.round(at.x), y: Math.round(at.y), deltaX: 0, deltaY: -120 * direction, wheelTicksX: 0, wheelTicksY: -direction, canScroll: true });
}

/** Sends `count` notches `rate` a second, on time however long each send takes. */
async function notches(win, at, direction, count, rate) {
  const started = performance.now();
  for (let i = 0; i < count; i++) {
    const due = started + (i * 1000) / rate, wait = due - performance.now();
    if (wait > 0) await sleep(wait);
    wheel(win, at, direction);
  }
}

/** The study's files, for viewers that take a list rather than a folder. */
const studyFiles = study => fs.readdirSync(path.join(study.folder, 'S01')).filter(name => name.endsWith('.dcm')).sort().map(name => path.join(study.folder, 'S01', name));

/**
 * Hands the study to the viewer the way its user would, and marks `bench:drop` the moment the files are handed over:
 * dropped on the page (a real drag from the browser, with the files' folder entries), set on its file input, or
 * given to the file chooser one of its buttons opens.
 */
async function openStudy(open, { devtools, js, mark, study }) {
  if (open.type === 'drop') {
    const at = open.at ?? { x: WIDTH / 2, y: HEIGHT / 2 };
    // A folder, or (for a viewer that takes only files) the study's files selected together and dragged in.
    const files = open.files === 'list' ? studyFiles(study) : [study.folder];
    await mark('bench:drop');
    for (const type of ['dragEnter', 'dragOver', 'drop']) await devtools.sendCommand('Input.dispatchDragEvent', { type, x: at.x, y: at.y, data: { items: [], files, dragOperationsMask: 1 } });
    return open.files === 'list' ? 'drop files' : 'drop folder';
  }
  const files = open.folder ? [study.folder] : studyFiles(study);
  if (open.type === 'input') {
    const { root } = await devtools.sendCommand('DOM.getDocument', { depth: 0 });
    const { nodeId } = await devtools.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: open.selector });
    if (!nodeId) throw new Error(`No ${open.selector} on the page.`);
    await mark('bench:drop');
    await devtools.sendCommand('DOM.setFileInputFiles', { nodeId, files });
    return `input ${open.selector}`;
  }
  if (open.type === 'chooser') {
    await devtools.sendCommand('Page.enable');
    await devtools.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true });
    const opened = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${open.click ?? open.clickText} opened no file chooser.`)), 10_000);
      const listener = (_event, method, params) => { if (method === 'Page.fileChooserOpened') { clearTimeout(timer); devtools.removeListener('message', listener); resolve(params); } };
      devtools.on('message', listener);
    });
    // A button by its selector, or the element showing a text (VolView's "Click to open local files.").
    // As a user's click: a page may open a file chooser only during one.
    await js(open.click ? `document.querySelector(${JSON.stringify(open.click)}).click(); 0`
      : `[...document.querySelectorAll('body *')].find(e => !e.childElementCount && e.textContent.trim() === ${JSON.stringify(open.clickText)}).click(); 0`, true);
    const { backendNodeId } = await opened;
    await mark('bench:drop');
    await devtools.sendCommand('DOM.setFileInputFiles', { backendNodeId, files });
    return `chooser ${open.click ?? open.clickText}`;
  }
  throw new Error(`Unknown way to open: ${open.type}`);
}

async function trial({ viewer, served, study, round, order, outDir, machine, idle }) {
  const line = { viewer: viewer.id, version: viewer.adapter.version ?? null, study: study.name, round, warmup: round <= 0, order,
    started: new Date().toISOString(), machine, idle, ...(served.build ? { liveBuild: served.build, liveBuildPinned: served.pinned } : {}) };
  const win = new BrowserWindow({ show: false, x: 40, y: 60, width: WIDTH, height: HEIGHT, useContentSize: true, resizable: false, focusable: false, skipTaskbar: true,
    webPreferences: { backgroundThrottling: false, partition: `bench-${process.pid}-${Date.now()}` } });
  // On top and deaf to the real mouse: nothing else covers it, and a hand on the trackpad cannot reach it.
  win.setAlwaysOnTop(true, 'floating'); win.setIgnoreMouseEvents(true); win.showInactive();
  win.webContents.on('will-prevent-unload', event => event.preventDefault());
  const requests = [], js = (code, gesture = false) => win.webContents.executeJavaScript(code, gesture), mark = name => js(`performance.mark(${JSON.stringify(name)}); 0`);
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url);
    requests.push({ at: Date.now(), method: details.method, host: url.host, path: url.pathname.slice(0, 80), upload: (details.uploadData ?? []).reduce((t, p) => t + (p.bytes?.length ?? 0), 0) });
    callback({});
  });
  const devtools = win.webContents.debugger;
  try {
    const loadStart = performance.now();
    await win.loadURL(served.url + (viewer.adapter.path ?? ''));
    for (let last = requests.length, still = performance.now(); performance.now() - still < 1500 && performance.now() - loadStart < 30_000; await sleep(100)) {
      if (requests.length !== last) { last = requests.length; still = performance.now(); }
    }
    line.pageMs = Math.round(performance.now() - loadStart - 1500);
    devtools.attach('1.3');
    await viewer.adapter.ready?.({ win, js, devtools, sleep });
    line.display = await js('({ dpr: devicePixelRatio, width: innerWidth, height: innerHeight })');
    // What draws the pictures: a GPU, or a software rasterizer on a machine without one.
    line.renderer = await js(`(() => { try { const gl = document.createElement('canvas').getContext('webgl2');
      const info = gl && gl.getExtension('WEBGL_debug_renderer_info');
      return gl ? String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER)) : 'no WebGL2'; } catch { return 'unknown'; } })()`);
    await sleep(500);

    // Opening: drop the folder and wait until the window's processes have been quiet for two seconds.
    const firstRequest = requests.length, before = new Map(processes().map(m => [m.pid, m.cpu.cumulativeCPUUsage]));
    let trace = await startTrace(devtools);
    line.openedBy = await openStudy(viewer.adapter.open ?? { type: 'drop' }, { devtools, js, mark, study });
    const dropped = performance.now();
    // What a user does next, if anything (NiiVue's demo: pick the converted volume), runs alongside the measuring.
    const afterOpen = Promise.resolve(viewer.adapter.afterOpen?.({ js })).catch(error => { line.afterOpenError = String(error?.message ?? error); });
    let peakMB = 0, quietSince = null, lastCpu = before, lastAt = performance.now(), seen = null, lastLook = 0;
    while (performance.now() - dropped < OPEN_LIMIT_MS) {
      await sleep(250);
      const now = performance.now(), metrics = processes();
      const cores = metrics.reduce((total, m) => total + (m.cpu.cumulativeCPUUsage - (lastCpu.get(m.pid) ?? m.cpu.cumulativeCPUUsage)), 0) / ((now - lastAt) / 1000);
      peakMB = Math.max(peakMB, memoryMB(metrics));
      lastCpu = new Map(metrics.map(m => [m.pid, m.cpu.cumulativeCPUUsage])); lastAt = now;
      quietSince = cores < QUIET_SHARE ? quietSince ?? now : null;
      if (!seen && now - lastLook > 1000) { lastLook = now; seen = await look(win); }
      if (seen && quietSince !== null && now - quietSince >= QUIET_MS) { line.doneMs = Math.round(quietSince - dropped); break; }
    }
    await afterOpen;
    const after = processes();
    line.cpuSeconds = +after.reduce((total, m) => total + (m.cpu.cumulativeCPUUsage - (before.get(m.pid) ?? 0)), 0).toFixed(2);
    line.peakMB = peakMB; line.loadedMB = memoryMB(after);
    let { marks, frames } = readTrace(await trace.stop(), decode);
    Object.assign(line, openMetrics(marks, frames, MAIN));
    // VEAcom marks its steps of opening (files listed, import, first frame, first image): each one's time after the drop.
    const steps = Object.entries(marks).filter(([name]) => name.startsWith('veacom:')).map(([name, at]) => [name.slice(7), Math.round(at - marks['bench:drop'])]);
    if (steps.length) line.openSteps = Object.fromEntries(steps.sort((a, b) => a[1] - b[1]));
    const first = frames.find(f => f.index !== null && f.unit >= MAIN * f.width && f.ts >= marks['bench:drop']);
    if (first) fs.writeFileSync(path.join(outDir, 'shots', `${line.viewer}-${study.name}-r${round}-first.jpg`), Buffer.from(first.jpeg, 'base64'));
    // The window showed a slice but the trace's small screenshots never read it: keep the last one to see why.
    else if (frames.length) fs.writeFileSync(path.join(outDir, 'shots', `${line.viewer}-${study.name}-r${round}-unread.jpg`), Buffer.from(frames.at(-1).jpeg, 'base64'));
    if (!seen) throw new Error('No slice marker appeared on screen.');
    // The window showed a slice that no trace screenshot read: the opening was not measured, so the trial fails.
    if (line.firstImageMs === null) throw new Error('The trace screenshots never read the slice marker the window showed (picture kept as -unread.jpg).');

    if (SCENARIOS.has('paging')) {
      // How this viewer pages: slices per notch and which way, from notches sent one at a time.
      let at = await look(win);
      win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(at.x), y: Math.round(at.y) });
      await sleep(300);
      trace = await startTrace(devtools);
      for (let i = 0; i < 4; i++) { await mark(`bench:calibrate:${i}`); wheel(win, at, 1); await sleep(400); }
      await mark('bench:calibrate:end');
      ({ marks, frames } = readTrace(await trace.stop(), decode));
      const step = perNotch(marks, frames, MAIN, 4), now = await look(win);
      const sign = Math.sign(now.index - at.index) || 1;
      line.paging = { perNotch: step, downIs: sign > 0 ? 'higher' : 'lower', rates: {} };
      if (!step) throw new Error('The wheel did not page this viewer.');
      const middle = Math.floor(study.slices / 2);
      const recenter = async () => {
        const current = await look(win), need = middle - current.index;
        if (Math.abs(need) > step) { await notches(win, current, Math.sign(need) * sign, Math.round(Math.abs(need) / step), 20); await sleep(1500); }
        return look(win);
      };
      at = await recenter();
      for (const rate of RATES) {
        const count = rate, travel = count * step;
        if (Math.max(at.index, study.slices - 1 - at.index) < travel) at = await recenter();
        const towards = study.slices - 1 - at.index >= at.index ? 1 : -1;
        trace = await startTrace(devtools);
        await mark(`bench:page${rate}:start`);
        await notches(win, at, towards * sign, count, rate);
        await mark(`bench:page${rate}:end`);
        await sleep(1500);
        await mark(`bench:page${rate}:settled`);
        ({ marks, frames } = readTrace(await trace.stop(), decode));
        line.paging.rates[rate] = pagingMetrics(marks, frames, MAIN, `page${rate}`, count, step);
        at = await look(win);
      }
    }

    if (SCENARIOS.has('wl') && viewer.adapter.windowLevel === null) line.wl = { unavailable: 'this viewer has no window/level drag' };
    else if (SCENARIOS.has('wl')) {
      const tool = viewer.adapter.windowLevel ?? {}, button = tool.button ?? 'left';
      // Pick the viewer's window/level tool first where it is not the default.
      if (tool.select) await js(`document.querySelector(${JSON.stringify(tool.select)}).click(); 0`);
      if (tool.key) for (const type of ['keyDown', 'char', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: tool.key });
      await sleep(300);
      const at = await look(win);
      const start = { x: Math.round(at.x), y: Math.round(at.top - 4.5 * at.unit) };
      trace = await startTrace(devtools);
      win.webContents.sendInputEvent({ type: 'mouseMove', x: start.x, y: start.y });
      await sleep(200);
      await mark('bench:wl:start');
      win.webContents.sendInputEvent({ type: 'mouseDown', x: start.x, y: start.y, button, clickCount: 1 });
      const held = [`${button}ButtonDown`], began = performance.now();
      for (let i = 1; i <= 90; i++) {
        const wait = began + (i * 1000) / 60 - performance.now();
        if (wait > 0) await sleep(wait);
        win.webContents.sendInputEvent({ type: 'mouseMove', x: start.x + i * 3, y: start.y + i, modifiers: held });
      }
      await mark('bench:wl:end');
      win.webContents.sendInputEvent({ type: 'mouseUp', x: start.x + 270, y: start.y + 90, button, clickCount: 1 });
      await sleep(1000);
      await mark('bench:wl:settled');
      ({ marks, frames } = readTrace(await trace.stop(), decode));
      line.wl = windowLevelMetrics(marks, frames, MAIN);
      if (process.env.BENCH_DEBUG) line.wlFrames = frames.map(f => [Math.round(f.ts - marks['bench:wl:start']), f.index, f.unit && +f.unit.toFixed(1), f.grey && +f.grey.toFixed(1)]);
    }

    line.endMB = memoryMB(processes());
    const sent = requests.slice(firstRequest), origin = new URL(served.url).host;
    line.requestsAfterDrop = sent.length;
    line.sentElsewhere = sent.filter(r => r.host !== origin || r.upload > 0).map(r => `${r.method} ${r.host}${r.path}${r.upload ? ` (${r.upload} B)` : ''}`);
  } catch (error) {
    line.error = String(error?.stack ?? error);
  } finally {
    // The last screen of every trial, failed ones included, for checking by eye.
    try { fs.writeFileSync(path.join(outDir, 'shots', `${line.viewer}-${study.name}-r${round}-end.png`), (await win.webContents.capturePage()).toPNG()); } catch { /* the window is gone */ }
    if (devtools.isAttached()) devtools.detach();
    win.destroy();
  }
  return line;
}

app.on('window-all-closed', () => {});
// Whatever fails outside the trial's own error handling (loading the adapter, writing the result) still ends this
// Electron with a result, so the run never waits on a trial that cannot finish.
void app.whenReady().then(async () => {
  let line;
  try {
    const adapter = (await import(pathToFileURL(path.join(here, 'viewers', `${spec.viewer.adapter}.mjs`)).href)).default;
    line = await trial({ ...spec, viewer: { ...spec.viewer, adapter } });
  } catch (error) {
    line = { viewer: spec.viewer.id, study: spec.study.name, round: spec.round, warmup: spec.round <= 0, order: spec.order, error: String(error?.stack ?? error) };
  }
  try { fs.writeFileSync(spec.result, `${JSON.stringify(line)}\n`); } finally { app.exit(0); }
});
