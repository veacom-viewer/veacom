// Opens the browser build as viewer.veacom.app serves it, and again as a host without its cross-origin isolation
// headers would, in Chromium. Each time the engine must start (the threads build where the page is isolated and the
// computer has the cores, the single-thread build elsewhere), open a small synthetic CT and hand over a slice and the
// whole series, with no error on the page.
//
// The site's files (web/site/public, from prepare.mjs) go through the site's own Worker (web/site/worker.js), so the
// page gets the headers and content policy it gets in production; the study is served beside them.
//   pwsh -NoProfile -File web/build.ps1; pnpm run build:browser; node web/site/prepare.mjs; node web/tools/browser-check.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
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
execFileSync(process.execPath, [makeStudy, mrStudy, '--modality', 'MR'], { stdio: 'inherit' });
const studyFiles = readdirSync(path.join(study, 'S01')).sort().map(name => `S01/${name}`);
const [columns, rows, slices] = [128, 128, studyFiles.length];

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm', '.css': 'text/css',
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

const browser = await chromium.launch();
const failures = [];
try {
  for (const isolated of [true, false]) {
    const server = await serve(isolated);
    const page = await browser.newPage();
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
      await checkFilePicker(page);
      await page.evaluate(checkQueuedImports);
      await page.evaluate(locale => window.veacom.setLocale(locale), isolated ? 'en' : 'tr');
      await checkArchiveLimit(page);
      check(!errors.length, `page errors: ${errors.join(' | ')}`);
      console.log(`${mode}: ${started.threads} thread(s), ${opened.series} series ${opened.dimensions.join('x')}, ${errors.length} errors`);
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
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('The browser build starts and opens a study with and without cross-origin isolation.');
