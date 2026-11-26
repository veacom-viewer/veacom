import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { serveVeacom } from './lib/serve.mjs';

const [reference, candidate, directory] = process.argv.slice(2);
const output = path.resolve(directory);
await mkdir(output, { recursive: true });
const scratch = await mkdtemp(path.join(tmpdir(), 'veacom-graphics-demo-'));
const browser = await chromium.launch();
const results = [];
try {
  const fixture = path.join(scratch, 'study');
  execFileSync(process.execPath, ['tools/fixtures/make-smoke-study.mjs', fixture]);
  const files = (await readdir(path.join(fixture, 'S01'))).sort().slice(0, 3).map(f => path.join(fixture, 'S01', f));
  for (const [build, dist] of [['before', reference], ['after', candidate]]) {
    const server = await serveVeacom(path.resolve(dist));
    try {
      for (const locale of ['en','tr']) {
        const context = await browser.newContext({ locale, viewport: { width: 1280, height: 800 } });
        try {
          await context.addInitScript(lang => {
            if (location.protocol === 'http:') {
              localStorage.setItem('veacom:locale', lang);
              localStorage.setItem('veacom.locale', lang);
            }
            let frames = 0;
            function observe() {
              if (document.querySelector('[data-testid="welcome-open-files"]:not(:disabled)')?.getClientRects().length) frames++;
              if (!window.observedProbe) requestAnimationFrame(observe);
            }
            requestAnimationFrame(observe);
            const original = HTMLCanvasElement.prototype.getContext;
            HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
              if (type !== 'webgl2') return original.call(this, type, ...rest);
              window.observedProbe ??= { frames, at: performance.now() };
              return null;
            };
            window.restoreProbe = () => {
              HTMLCanvasElement.prototype.getContext = original;
              window.dispatchEvent(new Event('veacom-gpu-restored'));
            };
          }, locale);
          const page = await context.newPage();
          const capture = async suffix => {
            await page.mouse.move(1,1);
            await page.evaluate(async () => { await document.fonts.ready; await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))); });
            await page.screenshot({ path: path.join(output, build+'-'+locale+'-'+suffix+'.png'), animations: 'disabled' });
          };
          await page.goto(server.url);
          const app = page.getByTestId('veacom-app');
          const choose = page.getByTestId('welcome-open-files');
          const error = page.getByTestId('graphics-unavailable-notice');
          await error.waitFor();
          assert.equal(await app.getAttribute('data-locale'),locale);
          const warning = await error.innerText();
          const probe = await page.evaluate(() => window.observedProbe);
          assert(await choose.isEnabled() && warning.trim());
          if (build === 'after') assert(probe.frames >= 2);
          await capture('unavailable');
          const empty = page.waitForEvent('filechooser');
          await choose.click();
          await (await empty).setFiles([]);
          await page.evaluate(() => window.restoreProbe());
          await error.waitFor({ state: 'detached' });
          await page.waitForFunction(() => Boolean(window.__VEACOM_TEST__.state().graphics));
          await capture('recovered');
          const choice = page.waitForEvent('filechooser');
          await choose.click(); await (await choice).setFiles(files);
          const canvas = page.locator('canvas[data-series-id][data-slice="2"]').first();
          await canvas.waitFor();
          await page.waitForFunction(() => window.__VEACOM_TEST__.state().fullVolumeLoaded);
          const image = await canvas.evaluate(async el => {
            const bridge=window.veacom, { generation }=await bridge.getCoreState();
            const item=(await bridge.listSeries()).series.find(s => s.id===el.dataset.seriesId);
            const index=Number(el.dataset.slice);
            const frame=await bridge.fetchPixels({seriesId:item.id,generation,revision:item.catalogRevision,index});
            return {patient:item.patientId,slices:item.dimensions[2],index,sop:frame.headers.get('X-SOP-Instance-UID')};
          });
          assert.deepEqual(image,{patient:'SYNTHETIC-SMOKE',slices:3,index:2,sop:'2.25.302617644913925066835652647005517224101.3.3'});
          await capture('ct');
          results.push({build,locale,warning,probe,chooserWhileUnavailable:true,image});
        } finally { await context.close(); }
      }
    } finally { await server.close(); }
  }
  assert.notEqual(results.find(r=>r.locale==='en').warning,results.find(r=>r.locale==='tr').warning);
  await writeFile(path.join(output,'verification.json'),JSON.stringify({note:'WebGL was deliberately unavailable until the explicit recovery event. These captures verify interface states and synthetic image identity.',results},null,2)+'\n');
} finally { await browser.close(); await rm(scratch,{recursive:true,force:true}); }
