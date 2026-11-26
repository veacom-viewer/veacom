import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { serveVeacom } from './lib/serve.mjs';

const [dist, directory] = process.argv.slice(2);
const scratch = await mkdtemp(path.join(tmpdir(), 'veacom-early-drops-'));
const output = path.resolve(directory);
await mkdir(output, { recursive: true });
const ct = path.join(scratch, 'ct'), mr = path.join(scratch, 'mr');
const generator = 'tools/fixtures/make-smoke-study.mjs';
execFileSync(process.execPath, [generator, ct]);
execFileSync(process.execPath, [generator, mr, '--modality', 'MR', '--other-patient']);
const ctFolder = path.join(ct, 'S01'), mrFolder = path.join(mr, 'S01');
const mrFile = path.join(mrFolder, (await readdir(mrFolder)).sort()[0]);
const scenarios = [
  { name: 'folder', items: [[ctFolder]], modalities: ['CT'] },
  { name: 'file', items: [[mrFile]], modalities: ['MR'] },
  { name: 'two-folders', items: [[ctFolder], [mrFolder]], modalities: ['CT', 'MR'] },
];
const browser = await chromium.launch(), results = [];
async function check(url, isolated, scenario, early, enter, paced, round) {
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  const hold = Promise.withResolvers();
  const activity = [];
  try {
    await page.exposeFunction('recordDrop', record => activity.push(record));
    await page.addInitScript(enter => {
      if (enter) addEventListener('dragenter', e => {
        if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect='copy'; }
      }, true);
      for (const type of ['dragenter','dragover','dragleave','drop']) {
        addEventListener(type, e => {
          const event = { type, t:performance.now(), target:e.target?.tagName, trusted:e.isTrusted, files: e.dataTransfer?.files.length ?? 0, kinds: Array.from(e.dataTransfer?.types ?? []) };
          setTimeout(() => { void window.recordDrop({ ...event, prevented: e.defaultPrevented }); });
        }, true);
      }
    }, enter);
    if (early) await page.route(/\/assets\/main-[^/]+\.js(?:\?.*)?$/, async route => {
      await hold.promise; await route.continue().catch(() => {});
    });
    const downloads = [];
    page.on('download', download => { downloads.push(download.suggestedFilename()); void download.cancel().catch(() => {}); });
    await page.goto(url, { waitUntil: 'commit' });
    await page.waitForFunction(() => window.veacom?.web, undefined, { timeout: 20_000 });
    if (early) assert.equal(await page.getByTestId('welcome-open-folder').count(), 0);
    else await page.getByTestId('welcome-open-folder').waitFor();
    const cdp = await page.context().newCDPSession(page);
    for (const files of scenario.items) for (const type of ['dragEnter', 'dragOver', 'drop']) {
      if (paced && type==='drop') await page.waitForTimeout(100);
      await cdp.send('Input.dispatchDragEvent', { type, x: 320, y: 260, data: { items: [], files, dragOperationsMask: 1 } });
    }
    hold.resolve();
    const onViewer = new URL(page.url()).origin === new URL(url).origin;
    if (onViewer) {
      await page.waitForFunction(() => Boolean(window.__VEACOM_TEST__ && document.documentElement.dataset.engineThreads), undefined, { timeout: 25_000 }).catch(() => {});
      await page.waitForFunction(n => window.__VEACOM_TEST__?.state().series.length === n, scenario.modalities.length, { timeout: early ? 3000 : 20_000 }).catch(() => {});
    }
    const catalog = onViewer ? await page.evaluate(async () => {
      if (!window.veacom || !window.__VEACOM_TEST__) return [];
      const core = await window.veacom.getCoreState(), { series } = await window.veacom.listSeries();
      const result = [];
      for (const s of series) {
        const frame = await window.veacom.fetchPixels({ generation: core.generation, revision: s.catalogRevision, seriesId: s.id, index: 0 });
        result.push({ modality: s.modality, patient: s.patientId, depth: s.dimensions[2], source: frame.headers.get('X-SOP-Instance-UID') });
      }
      return result.sort((a,b) => a.modality.localeCompare(b.modality));
    }).catch(() => []) : [];
    const root = '2.25.302617644913925066835652647005517224101';
    const expected = scenario.modalities.map(m => m === 'CT'
      ? { modality:'CT', patient:'SYNTHETIC-SMOKE', depth:100, source:root+'.3.1' }
      : { modality:'MR', patient:'SYNTHETIC-OTHER', depth:scenario.name === 'file' ? 1 : 100, source:root+'.10.3.1' });
    const row = { isolated, scenario: scenario.name, early, enter, paced, round, onViewer, activity, downloads, catalog, expected, correct: JSON.stringify(catalog)===JSON.stringify(expected) };
    results.push(row);
    console.log(JSON.stringify(row));
    if (!early) assert.deepEqual(catalog,expected);
  } finally { hold.resolve(); await page.close(); }
}
try {
  for (const isolated of [false,true]) {
    const site = await serveVeacom(path.resolve(dist), { isolation: isolated });
    try {
      await check(site.url,isolated,scenarios[0],false,false,false,0);
      const variants=[[false,false],[true,true],[true,false],[false,true]];
      for(let round=0;round<8;round++) for(let n=0;n<4;n++){
        const [enter,paced]=variants[(n+round)%4];
        await check(site.url,isolated,scenarios[0],true,enter,paced,round);
      }
    } finally { await site.close(); }
  }
} finally {
  await writeFile(path.join(output,'drops.json'),JSON.stringify(results,null,2)+'\n');
  await browser.close();
  await rm(scratch,{recursive:true,force:true});
}
