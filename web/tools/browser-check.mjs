// Opens the browser build as viewer.veacom.app serves it, and again as a host without its cross-origin isolation
// headers would, in Chromium. Each time the engine must start (the threads build where the page is isolated and the
// computer has the cores, the single-thread build elsewhere), open a small synthetic CT and hand over a slice and the
// whole series, with no error on the page. A PNG, a JPEG and a BMP made in the page must open as one series where the
// page is isolated (its picture decoder needs the threads build), and be refused in one sentence elsewhere.
//
// The landmark model (docs/landmark-model.md) must load from the site's models/ through the bridge, checked and kept in
// Cache Storage, and run in its Worker under the site's content policy: on several threads where the page is isolated,
// on one elsewhere.
//
// The site's files (web/site/public, from prepare.mjs) go through the site's own Worker (web/site/worker.js), so the
// page gets the headers and content policy it gets in production; the study is served beside them.
//   pwsh -NoProfile -File web/build.ps1; pnpm run build:browser; node web/site/prepare.mjs; node web/tools/browser-check.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import site from '../site/worker.js';
import { zipStored } from '../../src/web/zip.ts';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const publicFolder = path.join(repository, 'web/site/public');
if (!statSync(path.join(publicFolder, 'index.html'), { throwIfNoEntry: false })) {
  throw new Error('web/site/public has no index.html: run pnpm run build:browser and node web/site/prepare.mjs first.');
}

const scratch = mkdtempSync(path.join(tmpdir(), 'veacom-browser-check-'));
const study = path.join(scratch, 'study'), mrStudy = path.join(scratch, 'mr.zip');
const makeStudy = path.join(repository, 'tools/fixtures/make-smoke-study.mjs');
execFileSync(process.execPath, [makeStudy, study], { stdio: 'inherit' });
execFileSync(process.execPath, [makeStudy, mrStudy, '--modality', 'MR', '--other-patient'], { stdio: 'inherit' });
const studyFiles = readdirSync(path.join(study, 'S01')).sort().map(name => `S01/${name}`);
const [columns, rows, slices] = [128, 128, studyFiles.length];

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm', '.css': 'text/css',
  '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8' };
/** What Cloudflare's static assets would answer for `request` (the Worker's `env.ASSETS`). */
const assets = {
  async fetch(request) {
    const { pathname } = new URL(request.url);
    const file = path.join(publicFolder, pathname.endsWith('/') ? `${pathname}index.html` : pathname);
    if (!file.startsWith(publicFolder + path.sep) || !statSync(file, { throwIfNoEntry: false })?.isFile()) return new Response('Not found', { status: 404 });
    return new Response(request.method === 'HEAD' ? null : readFileSync(file), { headers: { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' } });
  },
};

/** The site on 127.0.0.1, with or without the cross-origin isolation headers, and the study under /__study/. */
function serve(isolated) {
  const server = createServer(async (incoming, outgoing) => {
    const url = new URL(incoming.url, `http://${incoming.headers.host}`);
    if (url.pathname === '/__study/files.json') {
      outgoing.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(studyFiles));
      return;
    }
    if (url.pathname.startsWith('/__study/')) {
      const name = decodeURIComponent(url.pathname.slice('/__study/'.length));
      if (!studyFiles.includes(name)) { outgoing.writeHead(404).end(); return; }
      outgoing.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end(readFileSync(path.join(study, name)));
      return;
    }
    const response = await site.fetch(new Request(url, { method: incoming.method }), { ASSETS: assets });
    const headers = Object.fromEntries(response.headers);
    if (!isolated) for (const name of ['cross-origin-opener-policy', 'cross-origin-embedder-policy']) delete headers[name];
    outgoing.writeHead(response.status, headers).end(Buffer.from(await response.arrayBuffer()));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/** In the page: opens the study's files through the bridge, as a drop does, and asks for one slice and the series. */
async function openStudy() {
  const names = await (await fetch('/__study/files.json')).json();
  const files = await Promise.all(names.map(async name => new File([await (await fetch(`/__study/${name}`)).arrayBuffer()], name.split('/').pop())));
  const bridge = window.veacom;
  const imported = await bridge.importSelected(await bridge.importFiles(files));
  const [series] = imported.series;
  const { generation } = await bridge.getCoreState();
  const frame = await bridge.fetchPixels({ seriesId: series.id, generation, revision: series.catalogRevision, index: 0 });
  const volume = await bridge.fetchPixels({ seriesId: series.id, generation, revision: series.catalogRevision });
  return {
    series: imported.series.length, dimensions: series.dimensions,
    frame: { index: frame.headers.get('X-Source-Frame-Index'), bytes: Number(frame.headers.get('Content-Length')) },
    volume: Number(volume.headers.get('Content-Length')),
    state: await bridge.getCoreState(),
  };
}

/** In the page: makes a PNG, a JPEG and a BMP of one size and colour, opens them together, and asks for each frame's
 * samples. Returns their length, type and components, or the error. */
async function openPictures() {
  const [width, height, colour] = [32, 24, [200, 100, 50]];
  const canvas = new OffscreenCanvas(width, height), context = canvas.getContext('2d');
  context.fillStyle = `rgb(${colour.join(',')})`;
  context.fillRect(0, 0, width, height);
  const encoded = async type => new Uint8Array(await (await canvas.convertToBlob({ type, quality: 1 })).arrayBuffer());
  // 24-bit BMP: rows bottom up, blue green red, each padded to four bytes.
  const row = Math.ceil(width * 3 / 4) * 4, bmp = new Uint8Array(54 + row * height), view = new DataView(bmp.buffer);
  bmp.set([0x42, 0x4d]);
  view.setUint32(2, bmp.length, true); view.setUint32(10, 54, true); view.setUint32(14, 40, true);
  view.setInt32(18, width, true); view.setInt32(22, height, true); view.setUint16(26, 1, true); view.setUint16(28, 24, true);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) bmp.set([colour[2], colour[1], colour[0]], 54 + y * row + x * 3);
  const files = [new File([await encoded('image/png')], '1.png'), new File([await encoded('image/jpeg')], '2.jpg'), new File([bmp], '3.bmp')];
  const bridge = window.veacom;
  try {
    const imported = await bridge.importSelected(await bridge.importFiles(files));
    const [series] = imported.series;
    const { generation } = await bridge.getCoreState();
    const frames = [], checked = new Set();
    window.checkPictureFrame = ({ index, bytes }) => {
      // Files are numbered PNG, JPEG, BMP. Only JPEG may round the samples during encoding.
      const tolerance = index === 1 ? 3 : 0;
      if (bytes.length === width * height * 3 && bytes.every((value, at) => Math.abs(value - colour[at % 3]) <= tolerance)) checked.add(index);
    };
    for (let index = 0; index < series.dimensions[2]; index++) {
      const { headers } = await bridge.fetchPixels({ seriesId: series.id, generation, revision: series.catalogRevision, index });
      frames.push(`${headers.get('Content-Length')} ${headers.get('X-Pixel-Type')} ${headers.get('X-Components')}`);
    }
    return { series: imported.series.length, dimensions: series.dimensions, frames, rgbFrames: [...checked] };
  } catch (error) {
    return { error: String(error?.message ?? error) };
  } finally {
    delete window.checkPictureFrame;
  }
}

async function importPickedFiles(page, files, kind = 'files') {
  const selection = page.waitForEvent('filechooser').then(picker => picker.setFiles(files));
  const [frames] = await Promise.all([page.evaluate(async kind => {
    const bridge = window.veacom;
    const result = await bridge.importSelected(await bridge.openPaths(kind));
    if (kind === 'folder' && result.source !== 'disk') throw new Error('A folder import must report a disk source');
    return result.series.map(series => series.dimensions[2]);
  }, kind), selection]);
  return frames;
}

async function checkFilePicker(page) {
  const frames = await importPickedFiles(page, studyFiles.slice(0, 2).map(name => ({
    name: 'IM0001.dcm', mimeType: 'application/dicom', buffer: readFileSync(path.join(study, name)),
  })));
  assert.deepEqual(frames, [2], 'same-named slices must stay in the same series');
}

/** Hold the real engine requests so a file chooser can finish before startup or import does. */
async function checkChooseDuringStartup(browser, url, fail) {
  const page = await browser.newPage(), offline = Promise.withResolvers();
  try {
    if (fail) await page.route('**/*.wasm', async route => { await offline.promise; await route.abort('failed'); });
    await page.addInitScript(() => {
      const held = new Set(['init', 'import']), send = Worker.prototype.postMessage;
      window.releaseOpeningRequest = {};
      Worker.prototype.postMessage = function (request, ...args) {
        if (!held.delete(request.op)) return send.call(this, request, ...args);
        window.releaseOpeningRequest[request.op] = () => send.call(this, request, ...args);
      };
    });
    await page.goto(url);
    const app = page.getByTestId('veacom-app'), choose = page.getByTestId('welcome-open-files');
    await choose.waitFor();
    await page.waitForFunction(() => typeof window.releaseOpeningRequest.init === 'function');
    assert.equal(await app.getAttribute('data-ready'), 'false');
    for (const kind of ['folder', 'files', 'archive']) assert(await page.getByTestId('welcome-open-' + kind).isEnabled());
    const picked = page.waitForEvent('filechooser');
    await choose.click();
    await (await picked).setFiles(path.join(study, studyFiles[0]));
    await page.waitForFunction(() => document.querySelector('[data-testid="welcome-open-files"]').disabled);
    offline.resolve();
    await page.evaluate(() => window.releaseOpeningRequest.init());
    if (fail) {
      await page.waitForFunction(async () => (await window.veacom.getCoreState()).status === 'failed');
      await page.locator('.connection-error[role="alert"]').waitFor();
      assert.equal(await app.getAttribute('data-ready'), 'false');
      assert.equal(await page.locator('canvas[data-series-id]').count(), 0);
      return;
    }
    await page.waitForFunction(() => typeof window.releaseOpeningRequest.import === 'function');
    await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
    assert(await choose.isDisabled(), 'Completing the catalog read must keep the active import busy.');
    assert.equal(await app.getAttribute('data-ready'), 'false');
    await page.evaluate(() => window.releaseOpeningRequest.import());
    await page.locator('canvas[data-series-id][data-slice="0"]').first().waitFor();
    const result = await page.evaluate(async () => {
      const bridge = window.veacom, { series } = await bridge.listSeries(), { generation } = await bridge.getCoreState();
      const [item] = series, pixels = await bridge.fetchPixels({ seriesId: item.id, generation, revision: item.catalogRevision, index: 0 });
      return [series.length, item.patientId, item.dimensions[2], pixels.headers.get('X-SOP-Instance-UID')];
    });
    assert.deepEqual(result, [1, 'SYNTHETIC-SMOKE', 1, '2.25.302617644913925066835652647005517224101.3.1']);
  } finally { offline.resolve(); await page.close(); }
}

async function checkWelcomeBeforeGraphics(browser, url) {
  const page = await browser.newPage();
  try {
    await page.addInitScript(() => {
      let frames = 0;
      function observeWelcome() {
        const open = document.querySelector('[data-testid="welcome-open-files"]:not(:disabled)');
        if (open?.getClientRects().length) frames++;
        if (window.welcomeFramesAtGraphics === undefined) requestAnimationFrame(observeWelcome);
      }
      requestAnimationFrame(observeWelcome);
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
        if (kind !== 'webgl2') return original.call(this, kind, ...args);
        window.welcomeFramesAtGraphics ??= frames;
        return null;
      };
      window.restoreWelcomeGraphics = () => {
        HTMLCanvasElement.prototype.getContext = original;
        window.dispatchEvent(new Event('veacom-gpu-restored'));
      };
    });
    await page.goto(url);
    const unavailable = page.getByTestId('graphics-unavailable-notice');
    await unavailable.waitFor();
    assert(await page.evaluate(() => window.welcomeFramesAtGraphics >= 2), 'The opener needs a paint opportunity before the graphics check.');
    const selected = page.waitForEvent('filechooser');
    await page.getByTestId('welcome-open-files').click();
    await (await selected).setFiles([]);
    await page.evaluate(() => window.restoreWelcomeGraphics());
    await unavailable.waitFor({ state: 'detached' });
    assert(await page.evaluate(() => Boolean(window.__VEACOM_TEST__.state().graphics)));
  } finally { await page.close(); }
}

/** Closing the last CT must let the browser collect the full pixel buffer while the reader stays open. */
async function checkClosedCTBuffer(browser, url) {
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  const cdp = await page.context().newCDPSession(page);
  try {
    await page.addInitScript(expectedBytes => {
      const observe = ResizeObserver.prototype.observe;
      ResizeObserver.prototype.observe = function (element, ...args) {
        observe.call(this, element, ...args);
        if (!element.matches('[data-testid="dicom-viewport"]') || window.firstPaneFrame) return;
        // Queue after the pane installs its resize observer and requests its initial draw.
        window.firstPaneFrame = new Promise(resolve => queueMicrotask(() => requestAnimationFrame(() => {
          const canvas = element.querySelector('canvas');
          resolve({ series: canvas?.dataset.seriesId, slice: canvas?.dataset.slice });
        })));
      };
      window.Worker = class extends Worker {
        constructor(...args) {
          super(...args);
          this.addEventListener('message', ({ data }) => {
            const bytes = data?.value?.bytes;
            if (bytes instanceof Uint8Array && bytes.byteLength === expectedBytes) window.lastCTBuffer = new WeakRef(bytes.buffer);
          });
        }
      };
    }, columns * rows * slices * 2);
    await page.goto(url);
    async function chooseCT() {
      const selected = page.waitForEvent('filechooser');
      await page.getByTestId('welcome-open-files').click();
      await (await selected).setFiles(studyFiles.map(name => path.join(study, name)));
      await page.waitForFunction(() => Boolean(window.lastCTBuffer?.deref()) && window.__VEACOM_TEST__.state().fullVolumeLoaded);
    }
    async function checkReleased() {
      await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
      await cdp.send('HeapProfiler.collectGarbage');
      assert(await page.evaluate(() => !window.lastCTBuffer.deref()), 'The closed CT pixel buffer is still reachable.');
    }
    await chooseCT();
    const first = await page.evaluate(() => window.firstPaneFrame);
    // The smoke CT has increasing patient Z. Its superior opening slice is the last source in the stack.
    assert.deepEqual(first, { series: await page.evaluate(() => window.__VEACOM_TEST__.state().activeSeriesId), slice: String(slices - 1) },
      'The first animation frame after mounting must draw the opening CT slice.');
    if (hardware) {
      const bitmap = page.locator('canvas[data-series-id]').first(), adapter = await bitmap.getAttribute('data-renderer');
      assert((hardware === 't4' ? /NVIDIA.*T4/i : /Microsoft Basic Render Driver|WARP/i).test(adapter), String(adapter));
      const isolated = await page.evaluate(() => self.crossOriginIsolated);
      await bitmap.screenshot({ path: path.join(output, isolated ? 'threaded-ct.png' : 'single-thread-ct.png') });
      hardwareChecks.push({ isolated, adapter, first, dimensions: [columns, rows, slices], expectFirst: slices - 1 });
    }
    const paging = await page.evaluate(async () => {
      const original = Array.prototype.sort;
      const shown = [];
      let seriesSorts = 0;
      Array.prototype.sort = function (...args) {
        if (this[0]?.dimensions && this[0]?.modality) seriesSorts++;
        return original.apply(this, args);
      };
      try {
        for (const slice of [50, 51, 52]) {
          window.__VEACOM_TEST__.setView({ slice });
          await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(done))));
          shown.push(Number(document.querySelector('canvas[data-series-id]').dataset.slice));
        }
      } finally { Array.prototype.sort = original; }
      return { shown, seriesSorts };
    });
    assert.deepEqual(paging.shown, [50, 51, 52]);
    assert.equal(paging.seriesSorts, 0, 'Paging must preserve the catalog ordering.');
    const more = page.getByTestId('tool-more');
    await more.click();
    if (!await page.getByTestId('inspector-tab-tags').isVisible()) await page.getByTestId('tool-inspector').click();
    await page.getByTestId('inspector-tab-tags').click();
    const tagFilter = page.locator('[data-action="tags-search"]');
    await tagFilter.fill('modality');
    await page.getByTestId('series-find').click();
    const seriesFilter = page.locator('[data-action="series-search"]');
    await seriesFilter.fill('CT');
    await page.locator('[data-action="series-pick"]').first().click({ button: 'right' });
    await page.locator('[data-action="series-clear"]').click();
    await page.getByTestId('series-remove-confirm').click();
    await page.waitForFunction(() => Number(document.documentElement.dataset.engineReleases) > 0 && !document.querySelector('canvas[data-series-id]'));
    assert.deepEqual(await page.evaluate(async () => (await window.veacom.listSeries()).series), []);
    await checkReleased();
    assert.equal(await more.getAttribute('aria-expanded'), 'true');
    assert.equal(await seriesFilter.inputValue(), 'CT');
    assert.equal(await tagFilter.inputValue(), 'modality');

    await seriesFilter.fill('');
    await chooseCT();
    const ct = await page.evaluate(() => window.__VEACOM_TEST__.state().activeSeriesId);
    const files = studyFiles.slice(0, 3).map(name => path.join(mrStudy, name));
    for (const type of ['dragEnter', 'dragOver', 'drop']) {
      await cdp.send('Input.dispatchDragEvent', { type, x: 120, y: 125, data: { items: [], files, dragOperationsMask: 1 } });
    }
    await page.waitForFunction(async () => (await window.veacom.listSeries()).series.length === 2);
    const mr = await page.evaluate(async () => (await window.veacom.listSeries()).series.find(item => item.modality === 'MR').id);
    await page.getByTestId('series-' + mr).click();
    const image = page.locator('canvas[data-series-id="' + mr + '"]');
    await image.waitFor();
    await image.evaluate(canvas => { window.remainingMRCanvas = new WeakRef(canvas); });
    await cdp.send('HeapProfiler.collectGarbage');

    // An operation that already has the pixels can finish reading them even if the reader removes the series.
    async function readCT(finished) {
      const buffer = window.borrowedCT ??= window.lastCTBuffer.deref();
      const digest = await crypto.subtle.digest('SHA-256', buffer);
      if (finished) delete window.borrowedCT;
      return { bytes: buffer.byteLength, sha256: Array.from(new Uint8Array(digest)) };
    }
    const before = await page.evaluate(readCT, false);
    assert.equal(before.bytes, columns * rows * slices * 2);
    await page.getByTestId('series-' + ct).click({ button: 'right' });
    await page.locator('[data-action="series-remove"]').click();
    await page.waitForFunction(async () => (await window.veacom.listSeries()).series.length === 1);
    assert.deepEqual(await page.evaluate(readCT, true), before);
    await checkReleased();
    assert(await image.evaluate(canvas => window.remainingMRCanvas.deref() === canvas), 'Removing the CT must keep the active MR pane.');
    const remaining = await page.evaluate(async () => {
      const bridge = window.veacom, { generation } = await bridge.getCoreState(), [item] = (await bridge.listSeries()).series;
      const frame = await bridge.fetchPixels({ seriesId: item.id, generation, revision: item.catalogRevision, index: 0 });
      return [item.id, item.patientId, frame.headers.get('X-SOP-Instance-UID')];
    });
    assert.deepEqual(remaining, [mr, 'SYNTHETIC-OTHER', '2.25.302617644913925066835652647005517224101.10.3.1']);
  } finally { await cdp.detach(); await page.close(); }
}

async function checkRestartedCatalog(browser, url) {
  const page = await browser.newPage({ locale: 'en-US' });
  try {
    await page.goto(url);
    await page.waitForFunction(() => document.documentElement.dataset.engineThreads && document.querySelector('[data-ready="true"]'));
    assert.deepEqual(await importPickedFiles(page, studyFiles.map(name => path.join(study, name))), [slices]);
    const ctRequest = await page.evaluate(async () => {
      const [ct] = (await window.veacom.listSeries()).series;
      window.ctCatalogFrames = new WeakRef(ct.frameMetadata);
      const generation = ct.engineGeneration;
      window.restartedCatalog = new Promise(resolve => {
        const unsubscribe = window.veacom.onCoreState(state => {
          if (state.status === 'ready' && state.generation > generation) { unsubscribe(); resolve(state.generation); }
        });
      });
      return { seriesId: ct.id, generation: ct.engineGeneration, revision: ct.catalogRevision, index: 0 };
    });
    const devtools = await page.context().newCDPSession(page);
    await devtools.send('HeapProfiler.collectGarbage');
    assert.equal(await page.evaluate(() => window.ctCatalogFrames.deref()?.length), slices);
    const engine = page.workers().find(worker => new URL(worker.url()).pathname.includes('/engine.worker-'));
    assert(engine);
    await engine.evaluate(() => { setTimeout(() => { throw new Error('Simulated engine failure'); }, 0); });
    assert.equal(await page.evaluate(() => window.restartedCatalog), ctRequest.generation + 1);
    assert.equal(await page.evaluate(async () => (await window.veacom.listSeries()).series.length), 0);
    assert.deepEqual(await importPickedFiles(page, [path.join(mrStudy, studyFiles[0])]), [1]);
    const next = await page.evaluate(async () => {
      const bridge = window.veacom, [mr] = (await bridge.listSeries()).series;
      const frame = await bridge.fetchPixels({ seriesId: mr.id, generation: mr.engineGeneration, revision: mr.catalogRevision, index: 0 });
      return [mr.patientId, frame.headers.get('X-SOP-Instance-UID'), Number(frame.headers.get('Content-Length'))];
    });
    assert.deepEqual(next, ['SYNTHETIC-OTHER', '2.25.302617644913925066835652647005517224101.10.3.1', columns * rows * 2]);
    await assert.rejects(page.evaluate(request => window.veacom.fetchPixels(request), ctRequest));
    await assert.rejects(page.evaluate(async request => window.veacom.fetchPixels({
      ...request, generation: (await window.veacom.getCoreState()).generation,
    }), ctRequest));
    await devtools.send('HeapProfiler.collectGarbage');
    assert.equal(await page.evaluate(() => window.ctCatalogFrames.deref()?.length ?? 0), 0, 'The previous engine still holds CT frame metadata.');
  } finally { await page.close(); }
}

/** The actual browser file list contains the same basename twice, once for each patient. */
async function checkLooseFileDrop(browser, url) {
  const page = await browser.newPage();
  try {
    await page.goto(url);
    await page.getByTestId('welcome-open-folder').waitFor();
    const devtools = await page.context().newCDPSession(page);
    const files = [study, mrStudy].map(folder => path.join(folder, studyFiles[0]));
    for (const type of ['dragEnter', 'dragOver', 'drop']) {
      await devtools.send('Input.dispatchDragEvent', { type, x: 100, y: 120, data: { items: [], files, dragOperationsMask: 1 } });
    }
    await page.waitForFunction(async () => (await window.veacom.listSeries()).series.length >= 2);
    const results = await page.evaluate(async () => {
      const bridge = window.veacom, { generation } = await bridge.getCoreState();
      const values = [];
      for (const item of (await bridge.listSeries()).series) {
        const pixels = await bridge.fetchPixels({ seriesId: item.id, generation, revision: item.catalogRevision, index: 0 });
        const sopInstanceUid = pixels.headers.get('X-SOP-Instance-UID');
        const corner = await bridge.measure(item.id, generation, item.sourceRevision, { kind: 'sourceRegion', frame: { index: 0, sopInstanceUid },
          shape: 'rectangle', points: [[1, 1, 0], [4, 4, 0]], pixelUnits: false });
        values.push([item.modality, item.patientId, sopInstanceUid, item.dimensions[2], corner.min, corner.max]);
      }
      return values.sort((a, b) => a[0].localeCompare(b[0]));
    });
    const root = '2.25.302617644913925066835652647005517224101';
    assert.deepEqual(results, [
      ['CT', 'SYNTHETIC-SMOKE', root + '.3.1', 1, -1000, -1000],
      ['MR', 'SYNTHETIC-OTHER', root + '.10.3.1', 1, 0, 0],
    ]);
  } finally { await page.close(); }
}

/** Save on the same CT in two tabs. Reload it through the normal file-drop entry point to check the shared profile. */
async function checkMeasurementTabs(browser, url) {
  const context = await browser.newContext();
  const selector = '[data-annotation-id]:not([data-annotation-id="draft"])';
  async function open(page) {
    await page.goto(url);
    await page.waitForFunction(() => document.documentElement.dataset.engineThreads && window.__VEACOM_TEST__);
    await page.evaluate(async () => {
      const names = (await (await fetch('/__study/files.json')).json()).slice(0, 3);
      const transfer = new DataTransfer();
      for (const name of names) transfer.items.add(new File([await (await fetch('/__study/' + name)).arrayBuffer()], name.split('/').pop()));
      document.body.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    });
    await page.waitForFunction(() => window.__VEACOM_TEST__.state().fullVolumeLoaded);
    await page.evaluate(() => { window.__VEACOM_TEST__.setView({ slice: 1 }); window.__VEACOM_TEST__.setTool('probe'); });
    await page.locator('[data-testid="annotation-overlay"][data-mode="source"][data-slice="1"]').waitFor();
  }
  async function draw(page, at) {
    const bounds = await page.locator('[data-testid="annotation-overlay"]').boundingBox();
    await page.mouse.click(bounds.x + at * bounds.width, bounds.y + 0.5 * bounds.height);
    await page.locator(selector).waitFor();
    await page.locator('[data-measurement-save="saved"]').waitFor();
    return page.locator(selector).getAttribute('data-annotation-id');
  }
  try {
    const [first, second] = await Promise.all([context.newPage(), context.newPage()]);
    await Promise.all([open(first), open(second)]);
    const ids = await Promise.all([draw(first, 0.42), draw(second, 0.58)]);
    assert.equal(new Set(ids).size, 2);
    await open(first);
    await first.locator(`[data-annotation-id="${ids[1]}"]`).waitFor();
    const displayed = await first.locator(selector).evaluateAll(marks => marks.map(mark => mark.dataset.annotationId));
    assert.deepEqual(displayed.sort(), [...ids].sort());
    await first.locator('[data-measurement-save="saved"]').waitFor();
    console.log('Two browser tabs kept both measurements on the same source image.');
  } finally { await context.close(); }
}

async function checkArchiveLimit(page) {
  async function zipSlice(file) {
    const name = path.basename(file);
    const zip = zipStored([{ name, bytes: readFileSync(file) }]);
    return { name: name + '.ZIP', mimeType: 'application/zip', buffer: Buffer.from(await zip.arrayBuffer()) };
  }
  const ct = await Promise.all(studyFiles.slice(0, 23).map(name => zipSlice(path.join(study, name))));
  const mrFolder = path.join(mrStudy, 'S01');
  const mr = await zipSlice(path.join(mrFolder, path.basename(studyFiles[0])));
  assert.deepEqual(await importPickedFiles(page, ct), [23]);
  await assert.rejects(importPickedFiles(page, [ct[0], mr]), /24 ZIP/);
  const retained = await page.evaluate(async () => (await window.veacom.listSeries()).series.map(series => series.dimensions[2]));
  assert.deepEqual(retained, [23]);
  assert.deepEqual(await importPickedFiles(page, [mr]), [1]);
  await assert.rejects(importPickedFiles(page, [ct[0]]), /24 ZIP/);

  // Choose the MR folder through the directory input. Replacing its archived series frees one slot.
  await page.evaluate(() => { window.showDirectoryPicker = undefined; });
  assert.deepEqual(await importPickedFiles(page, mrStudy, 'folder'), [slices]);
  assert.deepEqual(await importPickedFiles(page, [mr]), [1]);
  assert.deepEqual(await importPickedFiles(page, [path.join(study, studyFiles[0])]), [1]);
}

/** In the page: the landmark model's graphs through the bridge, then one run of its Worker on a synthetic film. */
async function runLandmarkModel(workerUrl) {
  const bridge = window.veacom;
  const [stageA, stageB] = await Promise.all(['stageA', 'stageB'].map(part => bridge.landmarkModel(part)));
  const kept = (await (await caches.open('veacom-landmark-model')).keys()).length;
  const columns = 1300, rows = 3500, pixels = new Uint16Array(columns * rows);
  for (let i = 0; i < pixels.length; i++) pixels[i] = (i % columns) * 3 + Math.floor(i / columns) % 500;
  const worker = new Worker(workerUrl, { type: 'module' });
  try {
    const reply = await new Promise((resolve, reject) => {
      worker.onmessage = ({ data }) => resolve(data);
      worker.onerror = event => reject(new Error(event.message || 'the landmark Worker did not start'));
      worker.postMessage({ id: 1, models: { stageA, stageB }, film: { pixels, columns, rows, mm: [0.3, 0.3], invert: false }, leg: 'left' });
    });
    const points = reply.ok ? Object.values(reply.channels) : [];
    return { ok: reply.ok, error: reply.error, threads: reply.threads, channels: points.length, finite: points.every(item => item.point.every(Number.isFinite)),
      bytes: [stageA.byteLength, stageB.byteLength], kept, expected: self.crossOriginIsolated ? Math.min(4, Math.ceil((navigator.hardwareConcurrency || 1) / 2)) : 1 };
  } finally { worker.terminate(); }
}

async function checkQueuedImports() {
  const bridge = window.veacom;
  const names = await (await fetch('/__study/files.json')).json();
  const file = new File([await (await fetch(`/__study/${names[0]}`)).arrayBuffer()], 'slice.dcm');
  const firstSelection = await bridge.importFiles([file]), secondSelection = await bridge.importFiles([file]);
  const first = bridge.importSelected(firstSelection);
  const second = bridge.importSelected(secondSelection);
  const firstJob = await bridge.getProgress();
  await first;
  const nextJob = await bridge.getProgress();
  const stale = await bridge.cancelOperation(firstJob.id);
  await second;
  if (!firstJob.running || !nextJob.running || firstJob.id === nextJob.id || stale.requested) {
    throw new Error('A queued import lost its progress or accepted the previous job’s Cancel');
  }
  const selection = await bridge.importFiles([file]);
  const queued = bridge.importSelected(selection).then(() => false, () => true);
  const shown = await bridge.getProgress();
  const cancelled = await bridge.cancelOperation(shown.id);
  if (!cancelled.requested || !await queued) throw new Error('The queued import did not cancel');
}

function waitForWorker(worker, event) {
  return worker.evaluate(event => Promise.race([self[event], new Promise((_, reject) => {
    setTimeout(() => reject(new Error('Timed out waiting for ' + event)), 30_000);
  })]), event);
}

/** A threaded engine whose helpers start but never get the file batch must still decode all the loose slices. */
async function checkUnacknowledgedFiles(page) {
  const folder = path.join(scratch, 'many-small');
  execFileSync(process.execPath, [makeStudy, folder, '--many-small']);
  const seriesDir = path.join(folder, 'S01');
  const paths = readdirSync(seriesDir).map(name => path.join(seriesDir, name));

  await page.addInitScript(() => {
    window.withheldFiles = 0;
    window.forgottenFiles = new Set();
    const send = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, ...args) {
      if (!(message.files instanceof MessagePort)) return send.call(this, message, ...args);
      message.files.onmessage = ({ data }) => {
        if (data.files) window.withheldFiles = Math.max(window.withheldFiles, data.files.length);
        for (const id of data.forget ?? []) window.forgottenFiles.add(id);
      };
      const { port1, port2 } = new MessageChannel();
      port1.close();
      return send.call(this, { ...message, files: port2 }, [port2]);
    };
  });
  await page.reload();
  await page.waitForFunction(() => Number(document.documentElement.dataset.engineThreads) > 1);
  const worker = page.workers().find(worker => new URL(worker.url()).pathname.includes('/engine.worker-'));
  assert(worker, 'The engine Worker is running.');
  await worker.evaluate(() => {
    const read = File.prototype.arrayBuffer;
    let release, notify;
    const gate = new Promise(resolve => { release = resolve; });
    self.releaseReads = release;
    self.readsPending = new Promise(resolve => { notify = resolve; });
    self.reads = 0;
    File.prototype.arrayBuffer = async function () {
      // The ninth read starts after the first file was held. Leave the rest in flight until after Cancel.
      self.reads++;
      if (self.reads === 9) notify();
      if (self.reads > 1) await gate;
      return read.call(this);
    };
    const readSync = FileReaderSync.prototype.readAsArrayBuffer;
    self.syncReads = 0;
    FileReaderSync.prototype.readAsArrayBuffer = function (blob) { self.syncReads++; return readSync.call(this, blob); };
  });
  assert.deepEqual(await importPickedFiles(page, paths), [1024]);
  const name = path.basename(studyFiles[0]);
  const zip = zipStored([{ name, bytes: readFileSync(path.join(mrStudy, 'S01', name)) }]);
  assert.deepEqual(await importPickedFiles(page, [{ name: 'mr.zip', mimeType: 'application/zip', buffer: Buffer.from(await zip.arrayBuffer()) }]), [1]);

  const volume = await page.evaluate(async () => {
    const bridge = window.veacom;
    const { series } = await bridge.listSeries();
    const { id, catalogRevision } = series.find(item => item.dimensions[2] === 1024);
    return { seriesId: id, generation: (await bridge.getCoreState()).generation, revision: catalogRevision };
  });
  await worker.evaluate(() => {
    self.syncReads = 0;
    self.volumeDispatched = new Promise(resolve => {
      self.addEventListener('message', ({ data }) => { if (data.op === 'volume') setTimeout(resolve, 0); }, { once: true });
    });
  });
  await page.evaluate(volume => {
    window.cancelledVolume = window.veacom.fetchPixels(volume).then(() => 'decoded', error => error.message);
  }, volume);
  await waitForWorker(worker, 'volumeDispatched');
  assert.equal(await worker.evaluate(() => self.reads), 0, 'The ZIP import must not bypass the earlier helper transfer.');
  await waitForWorker(worker, 'readsPending');
  const cancelled = await page.evaluate(async () => {
    const bridge = window.veacom;
    const { id } = await bridge.getProgress();
    const { requested } = await bridge.cancelOperation(id);
    const message = await window.cancelledVolume;
    return { requested, message, restarted: (await bridge.getCoreState()).restartCount };
  });
  assert.deepEqual(cancelled, { requested: true, message: 'Operation cancelled', restarted: 0 });
  assert.equal(await worker.evaluate(() => self.syncReads), 0, 'Cancel must skip the synchronous fallback.');
  await worker.evaluate(() => self.releaseReads());
  const before = await worker.evaluate(() => self.reads);
  const result = await page.evaluate(async volume => {
    const pixels = await window.veacom.fetchPixels(volume);
    return { withheld: window.withheldFiles, bytes: Number(pixels.headers.get('Content-Length')) };
  }, volume);
  assert.deepEqual(result, { withheld: 1024, bytes: 16 * 16 * 1024 * 2 });
  assert.equal(await worker.evaluate(() => self.reads) - before, 1024, 'The retry must reload every file held by the cancelled request.');

  // Fail registration of the second file after both file headers were read.
  await worker.evaluate(() => {
    const slice = File.prototype.slice;
    File.prototype.slice = function (...args) {
      if (this.name === 'bad.dcm') Object.defineProperty(this, 'size', { get() { throw new Error('Cannot register bad.dcm'); } });
      return slice.apply(this, args);
    };
  });
  const forgotten = await page.evaluate(() => window.forgottenFiles.size);
  const files = ['good.dcm', 'bad.dcm'].map(name => ({ name, mimeType: 'application/dicom', buffer: readFileSync(path.join(study, studyFiles[0])) }));
  await assert.rejects(importPickedFiles(page, files), /Cannot register bad.dcm/);
  await page.waitForFunction(before => window.forgottenFiles.size === before + 1, forgotten);
  assert.equal(await page.evaluate(async () => (await window.veacom.listSeries()).series.length), 2);

  // The helpers still withhold every batch for five seconds. The large cached volume needs none of these MR files.
  await importPickedFiles(page, [path.join(mrStudy, 'S01', name)]);
  const cachedBytes = await page.evaluate(async volume => {
    const pixels = await window.veacom.fetchPixels(volume, AbortSignal.timeout(4000));
    return Number(pixels.headers.get('Content-Length'));
  }, volume);
  assert.equal(cachedBytes, result.bytes, 'A cache hit must return while an unrelated helper transfer is pending.');
}

const hardware = process.argv[2], output = process.argv[3], hardwareChecks = [];
if (hardware) {
  assert(['t4', 'warp'].includes(hardware) && output);
  mkdirSync(output, { recursive: true });
}
const browser = await chromium.launch(hardware ? { channel: 'msedge', headless: false, args: ['--enable-gpu', hardware === 'warp' ? '--use-angle=d3d11-warp' : '--use-angle=d3d11'] } : {});
const failures = [];
try {
  for (const isolated of [true, false]) {
    const server = await serve(isolated);
    const page = await browser.newPage();
    await page.addInitScript(() => {
      // The bridge hands the transferred buffer to the viewer outside the Response body. Read it at the Worker boundary.
      window.Worker = class extends Worker {
        constructor(...args) {
          super(...args);
          this.addEventListener('message', ({ data }) => {
            if (data.ok && data.value?.bytes && data.value.components === 3) window.checkPictureFrame?.(data.value);
          });
        }
      };
    });
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    const mode = isolated ? 'isolated' : 'not isolated';
    try {
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      await page.waitForFunction(() => document.documentElement.dataset.engineThreads, null, { timeout: 60_000 });
      const started = await page.evaluate(() => ({
        isolated: self.crossOriginIsolated,
        threads: Number(document.documentElement.dataset.engineThreads),
        expected: self.crossOriginIsolated ? Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency || 2) / 2))) : 1,
      }));
      if (hardware) {
        await checkClosedCTBuffer(browser, page.url());
        await checkRestartedCatalog(browser, page.url());
        continue;
      }
      await checkChooseDuringStartup(browser, page.url(), false);
      if (isolated) await checkChooseDuringStartup(browser, page.url(), true);
      await checkWelcomeBeforeGraphics(browser, page.url());
      await checkClosedCTBuffer(browser, page.url());
      await checkRestartedCatalog(browser, page.url());
      await checkLooseFileDrop(browser, page.url());
      await checkMeasurementTabs(browser, page.url());
      const opened = await page.evaluate(openStudy);
      const check = (ok, what) => { if (!ok) failures.push(`${mode}: ${what}`); };
      check(started.isolated === isolated, `crossOriginIsolated is ${started.isolated}`);
      check(started.threads === started.expected, `the engine runs on ${started.threads} threads, expected ${started.expected}`);
      // Isolated, the threads build (and its helpers) must really run: a computer of 2 cores would pass on one thread.
      check(!isolated || started.expected > 1, `only ${started.expected} thread here, too few to check the threads build`);
      check(opened.series === 1, `${opened.series} series`);
      check(opened.dimensions.join('x') === `${columns}x${rows}x${slices}`, `dimensions ${opened.dimensions.join('x')}`);
      check(opened.frame.index === '0' && opened.frame.bytes === columns * rows * 2, `slice ${JSON.stringify(opened.frame)}`);
      check(opened.volume === columns * rows * slices * 2, `series of ${opened.volume} bytes`);
      check(opened.state.status === 'ready' && opened.state.restartCount === 0, `engine ${JSON.stringify(opened.state)}`);
      const workerFile = readdirSync(path.join(publicFolder, 'assets')).find(name => /^suggest\.worker-.*\.js$/.test(name));
      const model = await page.evaluate(runLandmarkModel, `/assets/${workerFile}`);
      check(model.ok && model.channels === 26 && model.finite, `landmark model: ${JSON.stringify(model)}`);
      check(model.threads === model.expected && model.kept === 2, `landmark model threads and cache: ${JSON.stringify(model)}`);
      await checkFilePicker(page);
      await page.evaluate(checkQueuedImports);
      await page.evaluate(locale => window.veacom.setLocale(locale), isolated ? 'en' : 'tr');
      await checkArchiveLimit(page);
      const pictures = await page.evaluate(openPictures);
      if (isolated) {
        check(pictures.series === 1 && pictures.dimensions?.join('x') === '32x24x3', `pictures: ${JSON.stringify(pictures)}`);
        check(pictures.rgbFrames?.join(',') === '0,1,2', `incorrect decoded RGB: ${JSON.stringify(pictures)}`);
        check(pictures.frames?.every(frame => frame === `${32 * 24 * 3} uint8 3`), `picture samples: ${JSON.stringify(pictures.frames)}`);
      } else {
        check(pictures.error === 'Desteklenen görüntü bulunamadı. 3 dosya okunamadı: PNG, JPEG ve BMP resimleri bu tarayıcıda açılamıyor.',
          `pictures without isolation: ${JSON.stringify(pictures)}`);
      }
      if (isolated) await checkUnacknowledgedFiles(page);
      check(!errors.length, `page errors: ${errors.join(' | ')}`);
      console.log(`${mode}: ${started.threads} thread(s), ${opened.series} series ${opened.dimensions.join('x')}, landmark model on ${model.threads} thread(s), ${errors.length} errors`);
    } catch (error) {
      failures.push(`${mode}: ${error.message}${errors.length ? ` (page errors: ${errors.join(' | ')})` : ''}`);
    } finally {
      await page.close();
      server.close();
    }
  }
} finally {
  await browser.close();
  rmSync(scratch, { recursive: true, force: true });
}
if (hardware) {
  writeFileSync(path.join(output, 'first-frame.json'), JSON.stringify({ hardware, hardwareChecks, failures }, null, 2));
  assert.deepEqual(hardwareChecks.map(r => r.isolated).sort(), [false, true]);
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('The browser build starts, opens a study and runs the landmark model with and without cross-origin isolation.');
