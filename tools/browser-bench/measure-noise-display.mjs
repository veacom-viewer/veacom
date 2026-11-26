import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { serveVeacom } from './lib/serve.mjs';
import { makeNoiseSeries, patient, root } from './noise-study.mjs';

const [sites, destination] = process.argv.slice(2);
const evidence = path.resolve(destination);
const sources = path.join(evidence, 'sources');
const indices = [0, 1, 2, 3, 4, 5, 6];
const geometry = await makeNoiseSeries(sources, indices);
const files = indices.map(i => path.join(sources, 'S01', 'IM' + String(i).padStart(5, '0') + '.dcm'));
const expected = await Promise.all(files.map(async (file, i) => {
  const pixels = (await readFile(file)).subarray(-512 * 512 * 2);
  return { index: i, uid: root + '.3.' + (i + 1), hash: createHash('sha256').update(pixels).digest('hex') };
}));
await writeFile(path.join(evidence, 'sources.json'), JSON.stringify({ geometry, expected }, null, 2));
const browser = await chromium.launch();

try {
  for (const role of ['previous', 'released']) {
    const directory = path.join(evidence, role);
    await mkdir(directory, {recursive: true});
    const site = await serveVeacom(path.resolve(sites, role), {isolation: true});
    const page = await browser.newPage({viewport: {width: 1280, height: 800}, deviceScaleFactor: 1});
    const receipt = { browser: browser.version(), captures: [] };
    try {
      await page.addInitScript(() => {
        window.decoded = new Map();
        window.Worker = class extends Worker {
          constructor(...args) {
            super(...args);
            this.addEventListener('message', ({data}) => {
              const frame = data?.value;
              if (frame?.sopInstanceUid && frame.bytes) window.decoded.set(frame.sopInstanceUid, crypto.subtle.digest('SHA-256', frame.bytes));
            });
          }
        };
      });
      await page.goto(site.url);
      const choose = page.waitForEvent('filechooser');
      await page.getByTestId('welcome-open-files').click();
      await (await choose).setFiles(files);
      await page.waitForFunction(() => window.__VEACOM_TEST__?.state().fullVolumeLoaded);
      const frames = await page.evaluate(async () => {
        const { generation } = await window.veacom.getCoreState();
        const { series: [series] } = await window.veacom.listSeries();
        const frames = [];
        for (let i = 0; i < series.dimensions[2]; i++) {
          const response = await window.veacom.fetchPixels({seriesId: series.id, generation, revision: series.catalogRevision, index: i});
          const uid = response.headers.get('X-SOP-Instance-UID');
          const bytes = await window.decoded.get(uid);
          if (!bytes) throw Error('Missing decoded instance ' + uid);
          frames.push({uid, hash: Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('')});
        }
        return {frames, patient: series.patientId, isolated: crossOriginIsolated, threads: Number(document.documentElement.dataset.engineThreads)};
      });
      assert.equal(frames.patient, patient);
      assert(frames.isolated && frames.threads >= 1);
      assert.deepEqual(frames.frames.map(f => f.uid).sort(), expected.map(f => f.uid).sort());
      const pane = page.locator('canvas[data-series-id][data-slice]').first();
      const labels = page.locator('.orientation-labels').first();
      await labels.waitFor();
      await page.keyboard.press('F12');
      await labels.waitFor({state: 'hidden'});
      receipt.frames = frames;
      for (const height of [512, 640, 256]) {
        for (let attempt = 0; attempt < 5; attempt++) {
          const bounds = await pane.boundingBox();
          const change = height - Math.round(bounds.height);
          if (!change) break;
          const view = page.viewportSize();
          await page.setViewportSize({width: view.width, height: view.height + change});
          await delay(150);
        }
        await page.waitForFunction(h => {
          const c = document.querySelector('canvas[data-series-id][data-slice]');
          return devicePixelRatio === 1 && c?.height === h && Math.abs(c.getBoundingClientRect().height - h) < 0.01;
        }, height);
        for (const [slice, decoded] of frames.frames.entries()) {
          const source = expected.find(item => item.uid === decoded.uid);
          assert.equal(decoded.hash, source.hash);
          await page.evaluate(index => window.__VEACOM_TEST__.setView({slice: index}), slice);
          await page.waitForFunction(index => Number(document.querySelector('canvas[data-series-id][data-slice]')?.dataset.slice) === index, slice);
          await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(done)))));
          const file = 'frame-' + source.index + '-size-' + height + '.png';
          await pane.screenshot({path: path.join(directory, file)});
          receipt.captures.push({file, slice, sourceIndex: source.index, uid: decoded.uid, height});
        }
      }
    } finally {
      await writeFile(path.join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2));
      await page.close();
      await site.close();
    }
  }
} finally {
  await browser.close();
}
