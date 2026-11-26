import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { serveVeacom } from './lib/serve.mjs';

const [dist, out, host] = process.argv.slice(2);
const root = '2.25.302617644913925066835652647005517224101';
assert(process.env.GITHUB_ACTIONS === 'true' && process.platform === 'linux');
await mkdir(out, { recursive: true });
const scratch = await mkdtemp(path.join(os.tmpdir(), 'study-drop-'));
execFileSync(process.execPath, ['tools/fixtures/make-smoke-study.mjs', path.join(scratch, 'generated')]);
const folder = path.join(scratch, 'one'), file = path.join(folder, 'one.dcm');
await mkdir(folder);
await copyFile(path.join(scratch, 'generated', 'S01', 'IM00000.dcm'), file);
const source = await readFile(file);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const expected = { patient: 'SYNTHETIC-SMOKE', uid: root + '.3.1', depth: 1, sha256: sha(source.subarray(-128 * 128 * 2)) };
const html = await readFile(path.join(dist, 'index.html'), 'utf8');
const entry = html.match(/<script\b[^>]*type="module"[^>]*src="([^"]+)"/)?.[1];
assert(entry);
const server = await serveVeacom(path.resolve(dist));
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const rows = [];
const natural = [];

function observe() {
  const clock = window.startupClock = { events: [], seen: {} };
  for (const type of ['dragenter', 'dragover', 'drop']) {
    window.addEventListener(type, event => clock.events.push({ event, time: performance.now(),
      types: Array.from(event.dataTransfer.types), names: Array.from(event.dataTransfer.files, f => f.name) }),
    { capture: true, passive: true });
  }
  function see() {
    const seen = clock.seen, now = performance.now();
    if (document.getElementById('root')) seen.root ??= now;
    if (window.veacom?.web) seen.bridge ??= now;
    if (document.querySelector('[data-testid="welcome-open-files"]:not(:disabled)')) seen.opener ??= now;
    if (!seen.opener) requestAnimationFrame(see);
  }
  requestAnimationFrame(see);
}

async function readCurrent(page) {
  return page.evaluate(async () => {
    const bridge = window.veacom, { series } = await bridge.listSeries();
    if (!series.length) return null;
    if (series.length !== 1) throw Error('Expected one series');
    const item = series[0];
    const original = Worker.prototype.postMessage;
    const got = Promise.withResolvers();
    Worker.prototype.postMessage = function (req, ...args) {
      if (req.op === 'frame') {
        this.addEventListener('message', async function received(event) {
          if (event.data.id !== req.id) return;
          this.removeEventListener('message', received);
          if (!event.data.ok) { got.reject(Error('Frame request failed')); return; }
          const bytes = event.data.value.bytes;
          const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
          got.resolve(Array.from(hash, b => b.toString(16).padStart(2, '0')).join(''));
        });
      }
      return original.call(this, req, ...args);
    };
    try {
      const frame = await bridge.fetchPixels({ seriesId: item.id, generation: item.engineGeneration,
        revision: item.catalogRevision, index: 0 });
      return { patient: item.patientId, uid: frame.headers.get('X-SOP-Instance-UID'),
        depth: item.dimensions[2], sha256: await got.promise };
    } finally { Worker.prototype.postMessage = original; }
  });
}

async function sample(condition, kind) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 750 }, acceptDownloads: true });
  const gate = Promise.withResolvers(), requested = Promise.withResolvers(), navigations = [], downloads = [];
  try {
    await page.addInitScript(observe);
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations.push(frame.url()); });
    page.on('download', item => downloads.push(item.suggestedFilename()));
    const stage = condition === 'entry' ? new URL(entry, server.url).href
      : condition === 'reader' ? /\/assets\/main-[^/]+\.js(?:\?.*)?$/ : null;
    if (stage) await page.route(stage, async route => { requested.resolve(); await gate.promise; await route.continue().catch(() => {}); });
    await page.goto(server.url, { waitUntil: 'commit' });
    if (stage) await requested.promise;
    if (condition === 'entry') await page.waitForFunction(() => document.getElementById('root') && !window.veacom);
    if (condition === 'reader') await page.waitForFunction(() => window.veacom?.web);
    if (condition === 'ready') await page.getByTestId('welcome-open-files').waitFor();
    const before = await page.evaluate(() => ({ time: performance.now(), bridge: Boolean(window.veacom),
      hasOpener: Boolean(document.querySelector('[data-testid="welcome-open-files"]')), title: document.title,
      bodyText: document.body.innerText.trim().slice(0, 150), visibility: document.visibilityState,
      paint: performance.getEntriesByType('paint').map(p => [p.name, p.startTime]) }));
    assert.equal(before.bridge, condition !== 'entry');
    assert.equal(before.hasOpener, condition === 'ready');
    if (kind === 'folder') await page.screenshot({ path: path.join(out, condition + '-before.png'), timeout: 5000 });
    const cdp = await page.context().newCDPSession(page);
    for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp.send('Input.dispatchDragEvent', {
      type, x: 500, y: 350, data: { items: [], files: [kind === 'folder' ? folder : file], dragOperationsMask: 1 },
    });
    let drag = [];
    try { drag = await page.evaluate(() => (window.startupClock?.events ?? []).map(({ event: e, time, types, names }) =>
      ({ type: e.type, accepted: e.defaultPrevented, trusted: e.isTrusted, time, types, names }))); } catch { /* A native drop may navigate the tab. */ }
    gate.resolve();
    let image = false, actual = null;
    if (page.url() === server.url) {
      await page.locator('[data-ready="true"]').first().waitFor({ timeout: 20000 }).catch(error => {
        if (page.url() === server.url) throw error;
      });
      if (page.url() === server.url) {
        image = await page.locator('canvas[data-series-id][data-slice]').first().waitFor({ timeout: 3000 }).then(() => true, () => false);
        actual = await readCurrent(page);
      }
    }
    const now = page.url();
    const row = { condition, kind, before, drag, navigations, downloads, urlAfter: now, image, actual };
    rows.push(row); await writeFile(path.join(out, 'trials.json'), JSON.stringify({ expected, entry, rows, natural }, null, 2));
    if (actual) assert.deepEqual(actual, expected);
    if (condition !== 'entry') { assert(image); assert.deepEqual(actual, expected); }
    await page.screenshot({ path: path.join(out, condition + '-' + kind + '-after.png'), timeout: 5000 });
  } finally { gate.resolve(); await page.close(); }
}

try {
  for (const condition of (host === '1' ? ['entry', 'reader', 'ready'] : ['ready', 'reader', 'entry'])) {
    for (const kind of ['folder', 'file']) await sample(condition, kind);
  }
  for (const network of ['local', '4Mbps-80ms']) {
    for (let i = 0; i < 3; i++) {
      const page = await browser.newPage();
      try {
        await page.addInitScript(observe);
        if (network !== 'local') {
          const cdp = await page.context().newCDPSession(page);
          await cdp.send('Network.enable');
          await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 80, downloadThroughput: 500000, uploadThroughput: 500000 });
        }
        await page.goto(server.url, { waitUntil: 'commit' });
        await page.waitForFunction(() => window.startupClock?.seen.opener);
        natural.push({ network, ...await page.evaluate(() => ({ seen: window.startupClock.seen,
          paint: performance.getEntriesByType('paint').map(p => [p.name, p.startTime]) })) });
      } finally { await page.close(); }
    }
  }
  await writeFile(path.join(out, 'trials.json'), JSON.stringify({ expected, entry, rows, natural }, null, 2));
  for (const row of rows) console.log(row.condition, row.kind, 'image', row.image, 'catalog', row.actual?.patient, 'url', row.urlAfter);
} finally { await browser.close(); await server.close(); await rm(scratch, { recursive: true, force: true }); }
