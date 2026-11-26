import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, firefox, webkit } from 'playwright';
import { makeStudy } from './make-study.mjs';
import { serveVeacom } from './lib/serve.mjs';

const [engine, dist, evidence] = process.argv.slice(2);
const scratch = await mkdtemp(path.join(tmpdir(), 'veacom-ct-picker-'));
const folder = path.join(scratch, 'ct-300'), sourceNumbers = [17];
const root = '2.25.' + BigInt('0x' + createHash('sha256').update('ct-300').digest('hex').slice(0,24));
await mkdir(evidence, { recursive:true });
await makeStudy('ct-300', folder);
const files = sourceNumbers.map(n => path.join(folder, 'S01', 'IM' + String(n).padStart(5,'0') + '.dcm'));
const expected = await Promise.all(files.map(async (file, i) => ({
  uid: root + '.3.' + (sourceNumbers[i]+1),
  hash: createHash('sha256').update((await readFile(file)).subarray(-512*512*2)).digest('hex'),
})));
const browser = await ({ chromium, firefox, webkit }[engine]).launch(engine === 'firefox'
  ? {headless:false,firefoxUserPrefs:{'webgl.force-enabled':true,'gfx.webrender.software':true,'widget.use-xdg-desktop-portal.file-picker':0}} : {});
const rows = [];
const command = promisify(execFile);
async function fillDialog(file,row) {
  let listed='';
  for(let i=0;i<40;i++){
    listed=(await command('xwininfo',['-root','-tree'])).stdout;
    const match=listed.match(/^\s*(0x[\da-f]+) "([^"]*(?:File Upload|Open File|Choose File|Select File|File Chooser)[^"]*)"/im);
    if(match){
      row.nativeDialog=match[2];
      await command('xdotool',['windowfocus','--sync',match[1]]);
      await command('xdotool',['key','--clearmodifiers','ctrl+l']);
      await delay(200);
      await command('xdotool',['type','--clearmodifiers','--',file]);
      await command('xdotool',['key','--clearmodifiers','Return']);
      return;
    }
    await delay(150);
  }
  throw Error('Native dialog missing. Visible window names: '+listed.split('\n').filter(s=>s.includes('"')).map(s=>s.trim()).slice(0,18).join(' '));
}
try {
  for (const isolated of [true, false]) {
    const site = await serveVeacom(path.resolve(dist), { isolation:isolated });
    const page = await browser.newPage({ viewport:{ width:1280,height:800 } });
    const row = { engine, version:browser.version(), isolated, errors:[], failedRequests:[] };
    page.on('pageerror', error => row.errors.push([error.message,error.stack]));
    page.on('requestfailed', r => row.failedRequests.push([new URL(r.url()).pathname,r.failure()?.errorText]));
    try {
      await page.addInitScript(() => {
        window.decodedFrames = new Map();
        window.Worker = class extends Worker {
          constructor(...args) {
            super(...args);
            this.addEventListener('message', ({data}) => {
              const frame = data?.value;
              if (frame?.sopInstanceUid && frame.bytes) window.decodedFrames.set(frame.sopInstanceUid,crypto.subtle.digest('SHA-256',frame.bytes));
            });
          }
        };
      });
      await page.goto(site.url);
      await Promise.all([page.getByTestId('welcome-open-files').click(),fillDialog(files[0],row)]);
      await page.waitForFunction(() => window.__VEACOM_TEST__?.state().series.length === 1, undefined, {timeout:20000});
      const data = await page.evaluate(async () => {
        const { generation } = await window.veacom.getCoreState(), { series:[s] } = await window.veacom.listSeries();
        const frames = [];
        for(let i=0;i<s.dimensions[2];i++) {
          const response = await window.veacom.fetchPixels({ seriesId:s.id, generation, revision:s.catalogRevision, index:i });
          const uid=response.headers.get('X-SOP-Instance-UID');
          if (!window.decodedFrames.has(uid)) throw Error('Missing worker frame '+uid);
          const digest = await window.decodedFrames.get(uid);
          frames.push({uid,hash:Array.from(new Uint8Array(digest), b=>b.toString(16).padStart(2,'0')).join('')});
        }
        return { isolation:self.crossOriginIsolated, threads:Number(document.documentElement.dataset.engineThreads), frames, patient:s.patientId, dimensions:s.dimensions };
      });
      Object.assign(row,data);
      const byUid = (a,b) => a.uid.localeCompare(b.uid);
      assert.equal(row.isolation,isolated);
      assert.equal(row.patient,'BENCH-ct-300');
      assert.deepEqual(row.dimensions,[512,512,1]);
      assert.deepEqual([...row.frames].sort(byUid),[...expected].sort(byUid));
      const pane = page.locator('canvas[data-series-id][data-slice]').first();
      await pane.waitFor();
      await page.waitForFunction(() => window.__VEACOM_TEST__.state().fullVolumeLoaded);
      row.displayedIndex = Number(await pane.getAttribute('data-slice'));
      assert.equal(row.frames[row.displayedIndex].uid,root+'.3.18');
      await page.evaluate(() => new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
      await pane.screenshot({ path:path.join(evidence, isolated?'isolated.png':'single.png') });
    } catch (e) {
      row.failure=e.message;
      row.status=await page.evaluate(() => ({bridge:!!window.veacom,app:!!window.__VEACOM_TEST__,notice:document.body.innerText.slice(-1200)})).catch(()=>null);
      await page.screenshot({path:path.join(evidence, isolated?'isolated-failure.png':'single-failure.png'),timeout:3000}).catch(()=>{});
    } finally {
      rows.push(row);
      await page.close();
      await site.close();
    }
  }
} finally {
  await writeFile(path.join(evidence,'picker.json'),JSON.stringify({expected,rows},null,2));
  await browser.close();
  await rm(scratch,{recursive:true,force:true});
}
for(const row of rows) if(row.failure) throw Error(engine+' '+row.isolated+' '+row.failure);
