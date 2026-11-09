// Compare two production desktop builds on one host. Run with BASE_APP and HEAD_APP pointing at source checkouts
// containing dist/ and their own release engines, and an output directory as the first argument.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const { authorizeImportPaths } = require('./privileged-imaging.cjs');
const { ignoreOutsideInput } = require('./lib/outside-input.cjs');
const { temporaryExportFolder } = require('./lib/export-folder.cjs');
const { prepareCounter, readCounts } = require('./lib/io-count.cjs');
const { compareRounds, median } = require('./lib/open-speed.cjs');
const { decodePng, encodePng } = require('./lib/png.cjs');

const [directory, repetitions = '7'] = process.argv.slice(2);
assert(directory && process.env.BASE_APP && process.env.HEAD_APP, 'Pass output directory and set BASE_APP and HEAD_APP');
const rounds = Number(repetitions);
assert(Number.isInteger(rounds) && rounds >= 5);
const output = path.resolve(directory), studies = path.join(output, 'studies');
const roots = { base: path.resolve(process.env.BASE_APP), head: path.resolve(process.env.HEAD_APP) };
const binary = root => path.join(root, 'native/target/release/veacom-core');
const fixtures = path.join(__dirname, 'fixtures');

function generate() {
  fs.mkdirSync(studies, { recursive: true });
  const generateStudy = (script, folder, ...args) => execFileSync(process.execPath,
    [path.join(fixtures, script), path.join(studies, folder), ...args], { stdio: 'inherit' });
  generateStudy('make-smoke-study.mjs', 'ct-1000', '--pipe-volume');
  generateStudy('make-smoke-study.mjs', 'video', '--video-ct');
  generateStudy('make-smoke-study.mjs', 'ct-small');
  const jpeg = path.join(studies, 'ct-jpeg', 'S01');
  fs.mkdirSync(jpeg, {recursive:true});
  const source = path.join(studies, 'ct-1000', 'S01');
  const slices = fs.readdirSync(source).filter(file => file.endsWith('.dcm'));
  assert.equal(slices.length, 1000);
  for (const file of slices) execFileSync('dcmcjpeg', ['+e1', path.join(source,file),path.join(jpeg,file)], {stdio:'pipe'});
  fs.mkdirSync(path.join(studies, 'mr'));
  for (let n = 1; n <= 8; n++) generateStudy('make-smoke-study.mjs', 'mr/' + n, '--modality', 'MR', '--series-index=' + n);
  generateStudy('make-petct-study.mjs', 'pet');
  const width = 512, data = Buffer.alloc(width * width * 4);
  for (let i = 0; i < width * width; i++) {
    const v = (i % width * 5 + Math.floor(i / width) * 3) & 255;
    data.set([v, (v + 30) & 255, (v + 12) & 255, 255], i * 4);
  }
  fs.writeFileSync(path.join(studies, 'single.png'), encodePng({ width, height: width, data }));
}

async function measureWindow(page) {
  await page.getByTestId('tool-mpr').evaluate(button => button.click());
  await page.waitForFunction(() => document.querySelectorAll('canvas[data-mode="mpr"]').length === 3);
  const times = [];
  let value;
  for (let n = 0; n < 3; n++) {
    await page.evaluate(() => window.__VEACOM_TEST__.setView({ windowMode: 'manual', windowWidth: 21, windowCenter: 11 }));
    await page.waitForFunction(() => window.__VEACOM_TEST__.state().view.windowWidth === 21);
    await page.getByTestId('tool-window-presets').evaluate(button => button.click());
    const time = await page.getByTestId('preset-auto').evaluate(async button => {
      const start = performance.now();
      button.click();
      while (window.__VEACOM_TEST__.state().view.windowWidth === 21) {
        if (performance.now() - start > 45_000) throw new Error('Auto Window did not update');
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
      const { mode, plane, windowWidth, windowCenter } = window.__VEACOM_TEST__.state().view;
      return { ms: performance.now() - start, mode, plane, windowWidth, windowCenter };
    });
    assert.equal(time.mode, 'mpr'); assert.equal(time.plane, 'axial');
    times.push(time.ms); value = [time.windowCenter, time.windowWidth];
  }
  return { mprMs: median(times), values: value, commands: times };
}

async function exportMovie(page, folder, build, desktop) {
  const click = locator => locator.evaluate(button => button.click());
  await desktop.evaluate(({dialog}, file) => { dialog.showSaveDialog = async () => ({canceled:false,filePath:file}); }, path.join(folder,'test.mp4'));
  await click(page.getByTestId('tool-export'));
  if (build === 'base') {
    await click(page.getByTestId('export-video'));
    await page.locator('select[data-action="export-size"]').selectOption('720p');
    const overlays=page.locator('[data-action="export-overlays"]');
    if (await overlays.isChecked()) await click(overlays);
  } else {
    await click(page.locator('[data-action="export-kind"][data-kind="video"]'));
    await click(page.locator('input[data-action="export-annotations"][value="none"]'));
    await click(page.locator('[data-action="export-more"]'));
    await click(page.locator('input[data-action="export-size"][value="fit"]'));
    await page.locator('select[data-action="export-size"]').selectOption('0');
  }
  await page.locator('[data-action="export-fps"]').fill('15');
  assert.equal(await page.locator('[data-action="export-last-slice"]').inputValue(),'100');
  const start = performance.now();
  await click(page.getByTestId('export-submit'));
  await page.waitForFunction(() => document.querySelector('[data-code="export-complete"], [data-code="export-failed"], .export-error'), undefined, {timeout:120_000});
  const exportMs = performance.now()-start;
  assert.deepEqual(await page.locator('[data-code="export-failed"], .export-error').allTextContents(),[]);
  const movies=fs.readdirSync(folder).filter(n=>n.endsWith('.mp4'));
  assert.equal(movies.length,1);
  const movie=path.join(folder,movies[0]);
  const stream=JSON.parse(execFileSync('ffprobe',['-v','error','-select_streams','v:0','-count_frames','-show_entries','stream=width,height,nb_read_frames,r_frame_rate','-of','json',movie])).streams[0];
  assert.deepEqual([stream.width,stream.height,stream.nb_read_frames,stream.r_frame_rate],[1280,720,'100','15/1']);
  return {exportMs,videoBytes:fs.statSync(movie).size};
}

async function pageStack(page) {
  const samples=await page.evaluate(async()=>{
    const samples=[];
    for(let slice=1;slice<=32;slice++) {
      const start=performance.now();
      window.__VEACOM_TEST__.setView({slice});
      do {
        await new Promise(requestAnimationFrame);
        if(performance.now()-start>7000) throw new Error('Did not draw slice '+slice);
      } while(Number(document.querySelector('.viewport-cell.is-active canvas[data-series-id]')?.dataset.slice)!==slice);
      samples.push(performance.now()-start);
    }
    return samples;
  });
  return {pageP95Ms:samples.toSorted((a,b)=>a-b)[Math.ceil(.95*samples.length)-1]};
}

async function requestLegacyFusion(page) {
  const ids=await page.evaluate(()=>{ const s=window.__VEACOM_TEST__.state();return {
    act:s.activeSeriesId, ct:s.series.find(i=>i.modality==='CT')?.id,
    pet:s.series.find(i=>i.description.endsWith('PET AC'))?.id
  };});
  assert(ids.ct && ids.pet);
  if(ids.act!==ids.ct) await page.evaluate(id=>window.__VEACOM_TEST__.selectSeries(id),ids.ct);
  await page.waitForFunction(()=>document.querySelector('[data-testid="tool-fusion"]:not(:disabled)'));
  await page.getByTestId('tool-fusion').evaluate(b=>b.click());
  await page.getByTestId('fusion-series').selectOption(ids.pet);
}

async function measure3d(page,desktop) {
  await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1600,900));
  await page.addStyleTag({content:'div:has(>canvas[data-testid="volume-3d-canvas"]) {flex:none!important;width:800px!important;height:512px!important;}'});
  await page.waitForTimeout(200);
  const result=await page.evaluate(async()=>{
    let draw=null;
    for(const method of ['drawArrays','drawElements','drawArraysInstanced','drawElementsInstanced']){
      const original=WebGL2RenderingContext.prototype[method];
      WebGL2RenderingContext.prototype[method]=function(...args){
        const result=original.apply(this,args);
        if(draw && this.canvas.dataset.renderBackend==='webgl2-volume-raymarch')draw();
        return result;
      };
    }
    const activate=async(id)=>{
      const button=document.querySelector('[data-testid="'+id+'"]');
      if(!button || button.disabled)throw new Error('Cannot activate '+id);
      const start=performance.now();
      return new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error('No 3D draw from '+id)),15000);
        draw=()=>{clearTimeout(timer);draw=null;resolve(performance.now()-start);};
        button.click();
      });
    };
    const firstMs=await activate('tool-3d');
    const switches=[];
    for(const camera of ['side','front','top','side','front','top'])switches.push(await activate('volume-view-'+camera));
    const canvas=document.querySelector('canvas[data-render-backend="webgl2-volume-raymarch"]');
    return {firstMs,switches,renderer:canvas.dataset.renderer,raster:[canvas.width,canvas.height]};
  });
  if(result.raster[0]!==800 || result.raster[1]!==512) throw new Error('Unexpected raster '+result.raster);
  return {volume3dMs:result.firstMs,cameraMs:median(result.switches),raster:result.raster};
}

async function run(build, study, counter) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'veacom-perf-'));
  const folder = await temporaryExportFolder(profile);
  const core = binary(roots[build]);
  const countsFile = path.join(profile, 'reads');
  let desktop, page;
  const errors=[];
  try {
    const env = { ...process.env, VEACOM_USER_DATA: profile, VEACOM_TEST_MODE: '1', VEACOM_CACHE_MIB: '256', VEACOM_CORE_PATH: core };
    if (counter) {
      // Insert the counter only in the engine, leaving Electron and the timer runs uninstrumented.
      env.VEACOM_CORE_PATH = path.join(profile, 'counted-core');
      env.TEST_ENGINE = core; env.TEST_COUNTER = counter.library; env.IOCOUNT_FILE = countsFile; env.IOCOUNT_ROOTS = fs.realpathSync(path.join(studies, study));
      fs.writeFileSync(env.VEACOM_CORE_PATH, '#!/bin/sh\nexport ' + counter.variable + '="$TEST_COUNTER"\nexec "$TEST_ENGINE" "$@"\n', { mode: 0o700 });
    }
    const start = performance.now();
    const exe=require(path.join(roots[build],'node_modules/electron'));
    const args=[roots[build], '--force-device-scale-factor=1'];
    if (process.platform==='linux') args.push('--ignore-gpu-blocklist');
    desktop = await electron.launch({ executablePath:exe,args,env,timeout:90_000 });
    page = await desktop.firstWindow();


    await page.waitForFunction(() => document.querySelector('[data-testid="veacom-app"]')?.dataset.ready === 'true' && window.__VEACOM_TEST__);
    const readyMs=performance.now()-start;
    await ignoreOutsideInput(desktop);
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 800));
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    const requests = { frame: 0, volume: 0 }, pixelPaths = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('requestfailed', req => console.log('Request failed',build,study,new URL(req.url()).pathname,req.failure()?.errorText));
    page.on('response', response => {
      const type = new URL(response.url()).pathname.match(/^\/_imaging\/(frame|volume)\//)?.[1];
      if (type) {
        requests[type]++;
        pixelPaths.push(new URL(response.url()).pathname);
        if (!response.ok()) errors.push('Pixel response '+response.status());
      }
    });
    await page.evaluate(study => {
      window.__firstDraw = null;
      if (study === 'pet') {
        // Both renderers set uPetOpacity only for a real PET overlay. Time the submitted CT canvas after that draw.
        const glProto=WebGL2RenderingContext.prototype, draw=glProto.drawArrays;
        glProto.drawArrays=function(...args) {
          const program=this.getParameter(this.CURRENT_PROGRAM);
          const loc=program && this.getUniformLocation(program,'uPetOpacity');
          window.__usedPet=Boolean(loc && this.getUniform(program,loc)>0);
          return draw.apply(this,args);
        };
      }
      // A volume can finish loading just after its last canvas draw. Poll the same ready state on both releases.
      const ready=()=>{
        if(window.__fullDraw) return;
        const s=window.__VEACOM_TEST__.state();
        const cell=document.querySelector('.viewport-cell.is-active');
        if(window.__firstDraw && s.fullVolumeLoaded && cell?.querySelector('canvas[data-series-id]')?.dataset.seriesId===s.activeSeriesId){
          window.__fullDraw=performance.now(); window.__fullMarker='ready-and-drawn';
        } else requestAnimationFrame(ready);
      };
      requestAnimationFrame(ready);
      document.addEventListener('veacom:frame',event=>{
        const time=performance.now(), s=window.__VEACOM_TEST__.state();
        window.__firstDraw ??= time;
        if(!window.__fullDraw && s.fullVolumeLoaded && s.activeSeriesId===event.detail.seriesId){window.__fullDraw=time;window.__fullMarker='full-frame';}
        if(study==='pet' && window.__usedPet && window.__VEACOM_TEST__.state().series.some(i=>i.id===event.detail.seriesId && i.modality==='CT'))
          window.__fusedDraw ??= time;
      });
      window.__openStarted = performance.now();
    }, study);
    if (study === 'picture-picker') {
      await desktop.evaluate(({ app, BrowserWindow, dialog }, file) => {
        dialog.showOpenDialog = async () => {
          // Give both builds the same time in the picker. Measure from its confirmation.
          await new Promise(resolve => setTimeout(resolve, 750));
          const decoders = app.__VEACOM_PRIVILEGED_TEST__.pictureDecoderProcesses?.()?.length ?? 0;
          await BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
            'window.__chooserDecoders = '+decoders+'; window.__openStarted = performance.now()');
          return { canceled: false, filePaths: [file] };
        };
      }, path.join(studies, 'single.png'));
      await page.getByTestId('welcome-open-files').evaluate(button => button.click());
    } else {
      const caps = await authorizeImportPaths(desktop, [path.join(studies, study)]);
      await page.evaluate(c => window.__VEACOM_TEST__.importPaths(c), caps);
    }
    await page.waitForFunction(() => window.__firstDraw && window.__fullDraw && window.__VEACOM_TEST__.state().fullVolumeLoaded, undefined, { timeout: 45000 });
    const firstMs = await page.evaluate(() => window.__firstDraw - window.__openStarted);
    const fullMs=await page.evaluate(()=>window.__fullDraw-window.__openStarted);
    const row={readyMs,firstMs,fullMs,requests,fullMarker:await page.evaluate(()=>window.__fullMarker)};
    if (!counter && ['ct-small','ct-1000','ct-jpeg'].includes(study)) Object.assign(row,await pageStack(page));
    if (study === 'picture-picker') row.preparedDecoders = await page.evaluate(() => window.__chooserDecoders);
    if (study === 'ct-1000') {
      await page.waitForTimeout(300);
      let before, pid;
      if (counter) {
        const children = execFileSync('ps', ['-axo','pid=,ppid=,comm='], { encoding: 'utf8' });
        const child = children.split('\n').map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
          .find(m => m && Number(m[2]) === desktop.process().pid && path.basename(m[3]) === 'veacom-core');
        assert(child && fs.existsSync(countsFile), 'Engine counter unavailable');
        pid = Number(child[1]); before = await readCounts(pid, countsFile, 0);
      }
      Object.assign(row, await measureWindow(page));
      if (counter) {
        const after = await readCounts(pid, countsFile, before.sequence);
        row.mprReads = { bytes: after.bytes - before.bytes, files: after.opened - before.opened };
      }
    } else if (study === 'mr') {
      await page.waitForFunction(() => document.querySelectorAll('.series-preview canvas').length === 8);
      await page.waitForLoadState('networkidle');
      row.pixelPaths = pixelPaths;
    } else if (study === 'pet') {
      if (build==='base') await requestLegacyFusion(page);
      await page.waitForFunction(() => {
        const s = window.__VEACOM_TEST__.state();
        return window.__fusedDraw && (s.fusionId || document.querySelector('[data-testid="fusion-series"]')?.value) && s.pendingLoads === 0 && [...document.querySelectorAll('[data-testid="viewport-cell"]')].every(c => c.dataset.volumeComplete === 'true');
      });
      row.fusionMs = await page.evaluate(() => window.__fusedDraw - window.__openStarted);
      const state=await page.evaluate(()=>{
        const s=window.__VEACOM_TEST__.state();
        const id=s.fusionId || document.querySelector('[data-testid="fusion-series"]')?.value;
        const overlay=s.series.find(x=>x.id===id);
        return {panes:document.querySelectorAll('[data-testid="viewport-cell"]').length,overlay:overlay?.description};
      });
      assert(state.overlay?.endsWith('PET AC'));assert.equal(state.panes,1);Object.assign(row,state);
      await page.waitForTimeout(1500);
      const rendererPid = await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getOSProcessId());
      row.rendererRssMiB = Number(execFileSync('ps', ['-o', 'rss=', '-p', String(rendererPid)], { encoding: 'utf8' }).trim()) / 1024;
      assert(row.rendererRssMiB > 0);
    } else if (study === 'video') Object.assign(row, await exportMovie(page,folder,build,desktop));
    else if(study==='ct-small') Object.assign(row,await measure3d(page,desktop));
    else if(study==='ct-jpeg') assert.deepEqual(await page.evaluate(()=>window.__VEACOM_TEST__.state().dimensions),[512,512,1000]);
    else {
      const dims = await page.evaluate(() => window.__VEACOM_TEST__.state().dimensions);
      assert.deepEqual(dims, [512, 512, 1]);
      await page.waitForLoadState('networkidle');
    }
    assert.deepEqual(errors, []);
    return row;
  } catch(error) {
    if(page && !page.isClosed()) {
      const status=await page.evaluate(()=>{ const s=window.__VEACOM_TEST__?.state(), cell=document.querySelector('.viewport-cell.is-active');
        return {marks:[window.__firstDraw,window.__fullDraw,window.__fusedDraw],active:s?.activeSeriesId,full:s?.fullVolumeLoaded,graphicsError:s?.graphicsError,
          loaded:s?.loadedSeriesIds,count:s?.series?.length,pending:s?.pendingLoads,canvases:[...document.querySelectorAll('canvas[data-series-id]')].map(el=>[el.dataset.renderer,el.dataset.slice]),
          complete:cell?.dataset.volumeComplete,cellText:cell?.textContent?.slice(0,450),notices:[...document.querySelectorAll('[role="alert"],.viewport-error,.notice')].map(el=>el.textContent?.slice(0,300))};
      }).catch(()=>null);
      console.error('Probe failed',build,study,counter?'counted':'timed',JSON.stringify({status,errors}));
    }
    throw error;
  } finally {
    if (desktop) await desktop.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

async function main() {
  generate();
  const report = { platform: process.platform, arch: process.arch, release: os.release(), cpu: os.cpus()[0].model,
    rounds, versions: {}, engines: {}, samples: [], comparisons: [], failures: [], regressions: [] };
  for (const [build, root] of Object.entries(roots)) {
    report.versions[build] = build==='base' ? 'c6956d95424e5862236378b0a5862b874407d39a' : execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
    report.engines[build] = createHash('sha256').update(fs.readFileSync(binary(root))).digest('hex');
  }
  const save = () => fs.writeFileSync(path.join(output, 'desktop.json'), JSON.stringify(report, null, 2));
  const counter = prepareCounter(output);
  assert(counter.library, counter.reason);
  report.counts = {}; save();
  for (const study of ['ct-1000','mr','pet','single.png','picture-picker','video','ct-small','ct-jpeg']) {
    for (let round = -1; round < rounds; round++) {
      const pair = {};
      try {
        for (const build of round % 2 === 0 ? ['base','head'] : ['head','base']) pair[build] = await run(build, study);
      } catch (error) {
        report.failures.push(study+' round '+(round+1)+': '+error.message); console.error(error); save(); break;
      }
      if (round < 0) continue;
      report.samples.push({ study, round, ...pair }); save();
      console.log(study, round + 1, JSON.stringify(pair));
      const check = (ok, reason) => { if (!ok) report.failures.push(study+' round '+(round+1)+': '+reason); };
      if (study === 'ct-1000') check(pair.head.values.every((value, i) => Math.abs(value - pair.base.values[i]) < 1e-5), 'MPR result changed');
      if (study === 'mr') check(pair.head.requests.volume === 1 && pair.head.requests.frame <= 8, 'Duplicate MR reads');
      if (study === 'pet') check(pair.base.panes === 1 && pair.head.panes === 1, 'Incorrect PET layout');
      if (study === 'single.png' || study === 'picture-picker') check(pair.head.requests.volume === 1 && pair.head.requests.frame === 0, 'Duplicate picture reads');
      if (study === 'picture-picker') check(pair.base.preparedDecoders === 0 && pair.head.preparedDecoders === 1, 'File chooser did not prepare one decoder');

    }
    const rows = report.samples.filter(row => row.study === study);
    if (!rows.length) continue;
    const metrics=['firstMs','fullMs'];
    if(study==='ct-1000') metrics.push('readyMs','mprMs','pageP95Ms');
    if(study==='ct-small') metrics.push('volume3dMs','cameraMs','pageP95Ms');
    if(study==='ct-jpeg') metrics.push('pageP95Ms');
    if(study==='video') metrics.push('exportMs','videoBytes');
    if(study==='pet') metrics.push('fusionMs','rendererRssMiB');
    for (const metric of metrics) {
      const paired = rows.map(row => ({ base: row.base[metric], head: row.head[metric] }));
      const comparison = compareRounds(paired, { threshold: .15, minMs: metric === 'videoBytes' ? 1 : metric === 'rendererRssMiB' ? 10 : ['pageP95Ms','cameraMs','mprMs'].includes(metric) ? 2 : 20, seed: 4109 });
      report.comparisons.push({ study, metric, ...comparison });
      if (comparison.verdict === 'slower') report.regressions.push(study+' '+metric);
    }
    save();
  }
  for(const build of ['base','head']) {
    try {report.counts[build]=await run(build,'ct-1000',counter);}
    catch(error) { report.counts[build]={countError:error.message}; }
    save();
  }
  const table = ['| Study | Metric | Beta 1 median | Candidate median | Change (95% interval) |','|---|---|---:|---:|---|'];
  for (const row of report.comparisons) table.push('| '+[row.study,row.metric,row.base.toFixed(1),row.head.toFixed(1),
    [row.change,row.low,row.high].map(n=>(100*n).toFixed(1)+'%').join(' / ')].join(' | ')+' |');
  save();
  fs.writeFileSync(path.join(output, 'desktop.md'),table.join('\n')+'\n');
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,table.join('\n')+'\n');
  assert.deepEqual(report.failures, []);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
