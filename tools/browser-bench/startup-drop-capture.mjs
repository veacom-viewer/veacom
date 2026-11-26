import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { makeStudy } from './make-study.mjs';
import { serveVeacom } from './lib/serve.mjs';

const [previous, changed, destination] = process.argv.slice(2);
const out = path.resolve(destination), temp = await mkdtemp(path.join(tmpdir(), 'veacom-folder-movie-'));
const study = path.join(temp, 'ct-300'), size = { width: 1280, height: 800 };
await makeStudy('ct-300', study);
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const records = [];
try {
  for (const [label, dist] of [['before', previous], ['after', changed]]) {
    const server = await serveVeacom(path.resolve(dist));
    try {
      for (const locale of ['en', 'tr']) {
        const context = await browser.newContext({ locale, viewport: size, recordVideo: { dir: temp, size } });
        let page, video;
        try {
          await context.addInitScript(language => {
            if (location.protocol === 'http:') {
              localStorage.setItem('veacom:locale', language);
              localStorage.setItem('veacom.locale', language);
            }
          }, locale);
          page = await context.newPage();
          video = page.video();
          const hold = Promise.withResolvers();
          await page.route(/\/assets\/main-[^/]+\.js(?:\?.*)?$/, async route => { await hold.promise; await route.continue(); });
          await page.goto(server.url, { waitUntil: 'commit' });
          await page.waitForFunction(() => window.veacom?.web);
          assert.equal(await page.getByTestId('welcome-open-folder').count(), 0);
          const cdp = await context.newCDPSession(page);
          const drop = async () => {
            for (const type of ['dragEnter', 'dragOver', 'drop']) {
              await cdp.send('Input.dispatchDragEvent', { type, x: 640, y: 400, data: { items: [], files: [study], dragOperationsMask: 1 } });
            }
          };
          await drop();
          hold.resolve();
          await page.waitForFunction(() => window.__VEACOM_TEST__ && document.documentElement.dataset.engineThreads);
          if (label === 'before') {
            await page.getByTestId('welcome-open-folder').waitFor();
            await page.waitForFunction(() => document.fonts.status === 'loaded');
            assert.deepEqual((await page.evaluate(() => window.veacom.listSeries())).series, []);
            await page.screenshot({ path: path.join(out, label + '-' + locale + '-early.png') });
            await page.waitForTimeout(850);
            await drop();
          }
          await page.locator('canvas[data-series-id][data-slice]').first().waitFor();
          await page.waitForFunction(() => window.__VEACOM_TEST__.state().fullVolumeLoaded);
          const result = await page.evaluate(async () => {
            const [series] = (await window.veacom.listSeries()).series;
            const { generation } = await window.veacom.getCoreState();
            const index = Number(document.querySelector('canvas[data-series-id][data-slice]').dataset.slice);
            const frame = await window.veacom.fetchPixels({ seriesId: series.id, generation, revision: series.catalogRevision, index });
            return { locale: document.querySelector('[data-testid="veacom-app"]').dataset.locale, patient: series.patientId,
              slices: series.dimensions[2], index, first: frame.headers.get('X-SOP-Instance-UID') };
          });
          const id = BigInt('0x'+createHash('sha256').update('ct-300').digest('hex').slice(0,24)).toString();
          assert.deepEqual(result, { locale, patient:'BENCH-ct-300', slices:300, index:299, first:'2.25.'+id+'.3.1' });
          await page.waitForFunction(() => document.fonts.status === 'loaded');
          await page.screenshot({ path: path.join(out, label + '-' + locale + (label === 'before' ? '-retry.png' : '-early.png')) });
          await page.waitForTimeout(500);
          records.push({ label, necessaryDrops: label === 'before' ? 2 : 1, ...result });
        } finally { await context.close(); }
        await video.saveAs(path.join(out, label + '-' + locale + '.webm'));
      }
    } finally { await server.close(); }
  }
  await writeFile(path.join(out,'sources.json'),JSON.stringify(records,null,2)+'\n');
} finally { await browser.close(); await rm(temp,{recursive:true,force:true}); }
