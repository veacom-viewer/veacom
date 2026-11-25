import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { serveVeacom } from './lib/serve.mjs';

const [before, after, destination] = process.argv.slice(2);
const output = path.resolve(destination), scratch = await mkdtemp(path.join(tmpdir(), 'veacom-choice-demo-'));
await mkdir(output, { recursive: true });
const browser = await chromium.launch(), records = [];
try {
  const study = path.join(scratch, 'ct');
  execFileSync(process.execPath, ['tools/fixtures/make-smoke-study.mjs', study]);
  const files = (await readdir(path.join(study, 'S01'))).sort().slice(0, 3).map(name => path.join(study, 'S01', name));
  for (const [build, dist] of [['before', before], ['after', after]]) {
    const server = await serveVeacom(path.resolve(dist));
    try {
      for (const locale of ['en', 'tr']) {
        const viewport = { width: 1280, height: 800 };
        const context = await browser.newContext({ locale, viewport, recordVideo: { dir: scratch, size: viewport } });
        const name = build + '-' + locale;
        let video;
        try {
          await context.addInitScript(lang => {
            if (location.protocol === 'http:') {
              localStorage.setItem('veacom:locale', lang);
              localStorage.setItem('veacom.locale', lang);
            }
            const send = Worker.prototype.postMessage;
            let held = false;
            Worker.prototype.postMessage = function (request, ...args) {
              if (request.op !== 'init' || held) return send.call(this, request, ...args);
              held = true;
              window.releaseEngineForDemo = () => send.call(this, request, ...args);
            };
          }, locale);
          const page = await context.newPage();
          video = page.video();
          await page.goto(server.url);
          const app = page.getByTestId('veacom-app'), choose = page.getByTestId('welcome-open-files');
          await choose.waitFor();
          await page.waitForFunction(() => typeof window.releaseEngineForDemo === 'function');
          assert.equal(await app.getAttribute('data-locale'), locale);
          assert.equal(await app.getAttribute('data-ready'), 'false');
          const enabled = await choose.isEnabled();
          assert.equal(enabled, build === 'after');
          await page.screenshot({ path: path.join(output, name + '-connecting.png') });
          await page.waitForTimeout(650);
          const pick = async () => {
            const event = page.waitForEvent('filechooser');
            await choose.click();
            await (await event).setFiles(files);
          };
          if (enabled) {
            await pick();
            await page.waitForFunction(() => document.querySelector('[data-testid="welcome-open-files"]').disabled);
            await page.screenshot({ path: path.join(output, name + '-selection-queued.png') });
            await page.waitForTimeout(500);
          }
          await page.evaluate(() => window.releaseEngineForDemo());
          if (!enabled) { await choose.click({ trial: true }); await pick(); }
          await page.locator('canvas[data-series-id][data-slice="0"]').first().waitFor();
          const displayed = await page.evaluate(async () => (await window.veacom.listSeries()).series.map(item => [item.patientId, item.dimensions[2]]));
          assert.deepEqual(displayed, [['SYNTHETIC-SMOKE', 3]]);
          await page.screenshot({ path: path.join(output, name + '-opened.png') });
          await page.waitForTimeout(650);
          records.push({ build, locale, enabledDuringConnection: enabled, displayed });
        } finally { await context.close(); }
        await video.saveAs(path.join(output, name + '.webm'));
      }
    } finally { await server.close(); }
  }
  await writeFile(path.join(output, 'verification.json'), JSON.stringify({ source: 'synthetic CT', demonstration: 'Engine initialization was held until the recorded interaction. These videos do not measure speed.', records }, null, 2) + '\n');
} finally { await browser.close(); await rm(scratch, { recursive: true, force: true }); }
