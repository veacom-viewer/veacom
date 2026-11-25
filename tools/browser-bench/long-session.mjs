import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { serveVeacom } from './lib/serve.mjs';
import { makeStudy } from './make-study.mjs';
import { closedBufferPaths } from './closed-buffer-paths.mjs';

const [site, output, cycleText, sourceFile, handleMode] = process.argv.slice(2);
const originalHandle = handleMode === '--original-handle';
const cycles = Number(cycleText);
assert(process.platform === 'linux' && process.env.GITHUB_ACTIONS === 'true');
assert(Number.isInteger(cycles) && cycles >= 3 && cycles <= 150);
const scratch = await mkdtemp(path.join(os.tmpdir(), 'veacom-reading-session-'));
await mkdir(output, { recursive: true });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const root = '2.25.302617644913925066835652647005517224101';
const ct = '2.25.' + BigInt('0x' + sha('ct-1000').slice(0, 24));
const studies = [
  { name: 'ct-1000', patient: 'BENCH-ct-1000', series: [[ct + '.2', 'CT', 1000, ct + '.3.']] },
  { name: 'mr', patient: 'SYNTHETIC-OTHER', series: [[root + '.10.2', 'MR', 100, root + '.10.3.']] },
  { name: 'petct', patient: 'SYNTHETIC-PETCT', series: [1, 2, 3].map(n => [root + '.20.2.' + n, n === 1 ? 'CT' : 'PT', 90, root + '.20.' + n + '.']) },
];
const log = record => appendFile(path.join(output, 'cycles.jsonl'), JSON.stringify(record) + '\n');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Linux resident memory for the browser and all its current descendants. RSS counts shared pages in each process. */
function memory(browserPid, detail = false) {
  const ps = execFileSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8' });
  const children = new Map(), roles = {};
  for (const line of ps.trim().split('\n')) {
    const [pid, parent] = line.trim().split(/\s+/).map(Number);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(pid);
  }
  let rssKiB = 0, totalPssKiB = 0, pssProcesses = 0, processes = 0;
  const visit = pid => {
    try {
      const status = readFileSync('/proc/' + pid + '/status', 'utf8'), rss = /^VmRSS:\s+(\d+) kB$/m.exec(status);
      if (rss) {
        rssKiB += Number(rss[1]); processes++;
        if (detail) {
          const cmd = readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\0');
          const role = cmd.find(arg => arg.startsWith('--type='))?.slice(7) ?? (pid === browserPid ? 'browser' : 'other');
          roles[role] = (roles[role] ?? 0) + Number(rss[1]);
          try {
            const stat = readFileSync('/proc/' + pid + '/smaps_rollup', 'utf8'), pss = /^Pss:\s+(\d+) kB$/m.exec(stat);
            if (pss) { totalPssKiB += Number(pss[1]); pssProcesses++; }
          } catch (error) {
            if (!['EACCES','EPERM','ENOENT','ESRCH'].includes(error.code)) throw error;
          }
        }
      }
    } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error; }
    for (const child of children.get(pid) ?? []) visit(child);
  };
  visit(browserPid);
  assert(processes > 1);
  const result = { rssMiB: Math.round(rssKiB / 1024), processes };
  if (detail) Object.assign(result, { rssByRoleMiB:Object.fromEntries(Object.entries(roles).map(([k,n])=>[k,Math.round(n/1024)])),
    pssProcesses, pssMiB:pssProcesses === processes ? Math.round(totalPssKiB/1024) : null });
  return result;
}

async function heapMetrics(cdp) {
  const [heap, dom] = await Promise.all([cdp.send('Runtime.getHeapUsage'), cdp.send('Memory.getDOMCounters')]);
  return { ...dom, heapMiB: Object.fromEntries(Object.entries(heap).map(([name,bytes]) => [name,Math.round(bytes/2**20)])) };
}

async function verifyCase(page, study) {
  const state = await page.evaluate(async () => {
    const bridge = window.veacom, { series } = await bridge.listSeries(), core = await bridge.getCoreState();
    const sources = [];
    for (const item of series) {
      const frame = await bridge.fetchPixels({ seriesId: item.id, generation: core.generation, revision: item.catalogRevision, index: 0 });
      sources.push({ uid: item.uid, patient: item.patientId, modality: item.modality, depth: item.dimensions[2],
        frame: frame.headers.get('X-Source-Frame-Index'), sop: frame.headers.get('X-SOP-Instance-UID') });
    }
    const drawn = Array.from(document.querySelectorAll('canvas[data-series-id]'), canvas => {
      const item = series.find(s => s.id === canvas.dataset.seriesId);
      return { uid: item?.uid, patient: item?.patientId, plane: canvas.dataset.plane, slice: Number(canvas.dataset.slice) };
    });
    return { sources, drawn, restarts: core.restartCount, renderer: document.querySelector('canvas[data-series-id]')?.dataset.renderer };
  });
  assert.equal(state.restarts, 0);
  assert.equal(state.sources.length, study.series.length);
  for (const [uid, modality, depth, prefix] of study.series) {
    const frame = state.sources.find(source => source.uid === uid);
    assert(frame);
    assert.equal(frame.patient, study.patient);
    assert.equal(frame.modality, modality);
    assert.equal(frame.depth, depth);
    assert.equal(frame.frame, '0');
    assert(frame.sop.startsWith(prefix));
    const n = Number(frame.sop.slice(prefix.length));
    assert(Number.isInteger(n) && n >= 1 && n <= depth && frame.sop === prefix + n);
  }
  assert(state.drawn.length && state.drawn.every(frame => frame.patient === study.patient && Number.isInteger(frame.slice) && study.series.some(([uid]) => uid === frame.uid)));
  return state;
}

let server, browser, timer;
try {
  const ctFolder = path.join(scratch, 'ct-1000');
  await makeStudy('ct-1000', ctFolder);
  execFileSync(process.execPath, ['tools/fixtures/make-smoke-study.mjs', path.join(scratch,'mr'), '--modality','MR','--other-patient']);
  execFileSync(process.execPath, ['tools/fixtures/make-petct-study.mjs', path.join(scratch,'petct')]);
  server = await serveVeacom(path.resolve(site));
  browser = await chromium.launch();
  const browserSession = await browser.newBrowserCDPSession();
  const { processInfo } = await browserSession.send('SystemInfo.getProcessInfo');
  const pid = processInfo.find(p => p.type.toLowerCase() === 'browser').id;
  const page = await browser.newPage({ viewport:{width:1280,height:800}, deviceScaleFactor:1 });
  const input = await page.context().newCDPSession(page);
  await page.goto(server.url);
  const welcome = page.getByTestId('welcome-open-files');
  await page.waitForFunction(() => document.querySelector('[data-testid="veacom-app"]')?.dataset.ready === 'true');
  await wait(2000);
  const manifests = {};
  for (const study of studies) manifests[study.name] = sha(await readFile(path.join(scratch,study.name,'manifest.json')));
  const setup = { site: JSON.parse(await readFile(sourceFile,'utf8')), browser:browser.version(), cycles, fixtures:manifests,
    cpu:os.cpus()[0].model, cores:os.cpus().length, hostMemoryGiB:os.totalmem()/2**30, initial:memory(pid,true), originalCanvasHandle:originalHandle,
    memory:'Sum of Linux VmRSS of the browser process tree, sampled every 500 ms and at each checkpoint. Shared pages can be counted in more than one process.',
    timing:'First canvas draw submission observed in animation-frame polling after native folder drop. Catalog, pane identities and source SOPs checked after loading.',
    close:'Real Clear list and confirmation, one WebAssembly memory release, empty catalog and no image canvas, then 2 seconds to settle.' };
  await writeFile(path.join(output,'run.json'),JSON.stringify(setup,null,2)+'\n');
  for (let i = 0; i < cycles; i++) {
    const study = studies[i % studies.length], files = [path.join(scratch, study.name)];
    const count = await page.evaluate(() => Number(document.documentElement.dataset.engineReleases || 0));
    await page.evaluate(() => { performance.clearMarks('veacom:volume-done'); });
    let peakMiB = 0, samples = 0;
    const sample = (detail=false) => { const m=memory(pid,detail); peakMiB=Math.max(peakMiB,m.rssMiB); samples++; return m; };
    sample(); timer = setInterval(sample,500);
    const start = performance.now();
    for (const type of ['dragEnter','dragOver','drop']) await input.send('Input.dispatchDragEvent',{type,x:640,y:400,data:{items:[],files,dragOperationsMask:1}});
    if (originalHandle) await page.waitForFunction(() => document.querySelector('canvas[data-series-id][data-slice]'));
    else await (await page.waitForFunction(() => Boolean(document.querySelector('canvas[data-series-id][data-slice]')))).dispose();
    const firstDrawMs = Math.round(performance.now()-start);
    await page.waitForFunction(() => performance.getEntriesByName('veacom:volume-done').length > 0 &&
      !document.querySelector('[data-action="series-pick"][aria-busy="true"]') && document.querySelector('[data-testid="veacom-app"]')?.dataset.ready === 'true', null,{timeout:90000});
    const verification = await verifyCase(page,study);
    const loaded = sample(true);
    if (i < 3 || i >= cycles-3) await page.screenshot({path:path.join(output,'open-'+String(i+1).padStart(3,'0')+'.png')});
    await page.locator('[data-action="series-pick"]').first().click({button:'right'});
    await page.locator('[data-action="series-clear"]').click();
    await page.getByTestId('series-remove-confirm').click();
    await welcome.waitFor();
    await page.waitForFunction(before => Number(document.documentElement.dataset.engineReleases || 0) > before &&
      !document.querySelector('canvas[data-series-id]'),count);
    assert.deepEqual(await page.evaluate(async () => (await window.veacom.listSeries()).series),[]);
    await wait(2000);
    clearInterval(timer);
    const closed = sample(true), heap = await heapMetrics(input);
    await log({cycle:i+1,study:study.name,firstDrawMs,loaded,closed,heap,peakMiB,samples,verification});
  }
  const snapshots = {};
  const snapshot = async () => ({ memory:memory(pid,true), heap:await heapMetrics(input) });
  snapshots.afterLastClose = await snapshot();
  await wait(10000);
  snapshots.tenSecondsLater = await snapshot();
  await input.send('HeapProfiler.collectGarbage');
  await wait(1500);
  snapshots.afterGarbageCollection = await snapshot();
  await writeFile(path.join(output,'buffer-paths.json'),JSON.stringify(await closedBufferPaths(input),null,2)+'\n');
  await page.close();
  await wait(2000);
  snapshots.afterTabClose = { memory:memory(pid,true) };
  await writeFile(path.join(output,'end.json'),JSON.stringify(snapshots,null,2)+'\n');
} finally {
  clearInterval(timer);
  await browser?.close();
  await server?.close();
  await rm(scratch,{recursive:true,force:true});
}
