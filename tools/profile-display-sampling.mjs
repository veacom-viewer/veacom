// Compare frame times for the same synthetic pixels on the same Electron renderer in two checkouts.
// node tools/profile-display-sampling.mjs <reference-checkout> <result.json> [--warp]
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { _electron as electron } from 'playwright';

const [reference, destination, option] = process.argv.slice(2);
if (!reference || !destination || (option && option !== '--warp')) throw new Error('Expected reference checkout, result.json and optionally --warp');
const repo = fileURLToPath(new URL('../', import.meta.url)), temp = await mkdtemp(path.join(os.tmpdir(), 'veacom-sampling-'));
const identifiers = {};
let app;
try {
  for (const [name, checkout] of [['Reference', path.resolve(reference)], ['Candidate', repo]]) {
    identifiers[name] = execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    await build({ configFile: false, root: temp, publicDir: false, logLevel: 'error',
      build: { outDir: temp, emptyOutDir: false, minify: false, lib: { entry: path.join(checkout, 'src/imaging/sliceRenderer.ts'),
        name, formats: ['iife'], fileName: () => name + '.js' } } });
  }
  await writeFile(path.join(temp, 'index.html'), '<!doctype html><meta charset="utf-8"><script>window.loadErrors=[];window.onerror=message=>window.loadErrors.push(String(message))</script><script src="Reference.js"></script><script src="Candidate.js"></script><script>window.renderers=[Reference.sliceRenderer(),Candidate.sliceRenderer()]</script>');
  await writeFile(path.join(temp, 'main.cjs'), [
    "const {app,BrowserWindow}=require('electron');",
    "app.setPath('userData',require('node:path').join(__dirname,'profile'));app.dock?.hide();",
    "app.whenReady().then(()=>{const w=new BrowserWindow({show:false,webPreferences:{sandbox:true,backgroundThrottling:false}});w.loadFile(require('node:path').join(__dirname,'index.html'));});",
  ].join('\n'));
  app = await electron.launch({ args: [path.join(temp, 'main.cjs'), ...(option ? ['--use-angle=d3d11-warp'] : [])] });
  const page = await app.firstWindow();
  await page.waitForURL('**/index.html');
  const errors = await page.evaluate(() => window.loadErrors);
  assert.deepEqual(errors, [], 'Both renderer bundles must load: '+errors?.join(', '));
  let affinity;
  if (option) {
    const pids = await app.evaluate(({ app }) => app.getAppMetrics()
      .filter(p => ['Browser','GPU','Tab'].includes(p.type)).map(p => p.pid));
    const command = [
      "$ErrorActionPreference='Stop'",
      'Get-Process -Id ' + pids.join(',') + ' | ForEach-Object {',
      '  $bits=$_.ProcessorAffinity.ToInt64(); $a=$bits -band (-$bits); $bits=$bits -bxor $a;',
      '  $mask=$a -bor ($bits -band (-$bits)); $_.ProcessorAffinity=[IntPtr]$mask;',
      '  [string]$_.Id + "=" + [string]$_.ProcessorAffinity.ToInt64() }',
    ].join('\n');
    affinity = execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{encoding:'utf8'}).trim().split(/\r?\n/);
  }
  const report = await page.evaluate(async () => {
    const renderers = window.renderers;
    const cases = [['MR',256,256,1600,1200,1], ['CT 25 panes',512,512,300,200,25],
      ['DX',3000,3000,1000,1000,1], ['MG',3328,4096,900,1100,1]];
    const timings = [];
    for (const [name,width,height,outWidth,outHeight,frames] of cases) {
      const data = new Uint16Array(width*height*frames);
      for (let i=0;i<data.length;i++) data[i]=(i*17+Math.floor(i/width)*37)%4096;
      const series = { id:name, dimensions:[width,height,frames], spacing:[1,1,1], origin:[0,0,0], direction:[1,0,0,0,1,0,0,0,1],
        modality:name==='CT 25 panes'?'CT':name, photometricInterpretation:'MONOCHROME2', components:1, canReconstruct:frames>1 };
      const volume={series,data}, view={mode:'source',plane:'axial',slice:0,windowCenter:2048,windowWidth:4096,zoom:1,
        pan:[0,0],rotation:0,flipX:false,flipY:false,inverted:false};
      const panes=renderers.map(()=>Array.from({length:frames},()=>{const c=document.createElement('canvas');c.width=outWidth;c.height=outHeight;return c;}));
      const warm=[[],[]],first=[],cold=[];
      for(let round=0;round<19;round++) {
        for(const index of round%2?[1,0]:[0,1]) {
          const render=renderers[index];
          if(round===1) render.setVisibleViews([]);
          const start=performance.now();
          for(let slice=0;slice<frames;slice++) {
            const canvas=panes[index][slice];
            render.render(canvas,volume,{...view,slice,windowCenter:2048+round,pan:[round%3,round%5]});
            canvas.getContext('2d').getImageData(Math.floor(outWidth/2),Math.floor(outHeight/2),1,1);
          }
          render.gl.finish();
          const ms=performance.now()-start;
          if(!round) first[index]=ms;
          if(round===1) cold[index]=ms;
          if(round>2) warm[index].push(ms);
        }
      }
      const median = values => { const a=values.toSorted((x,y)=>x-y); return (a[7]+a[8])/2; };
      timings.push({name,width,height,outWidth,outHeight,frames,firstMs:first,firstAfterShaderSetupMs:cold,medianRedrawMs:warm.map(median),redrawMs:warm});
      renderers.forEach(render=>render.setVisibleViews([]));
    }
    return {renderer:renderers[0].info.renderer, candidateRenderer:renderers[1].info.renderer,timings};
  });
  assert.equal(report.renderer, report.candidateRenderer);
  if (option) assert.match(report.renderer,/Microsoft Basic Render Driver|WARP/i);
  await mkdir(path.dirname(path.resolve(destination)), { recursive: true });
  await writeFile(destination, JSON.stringify({revisions:identifiers,cpu:os.cpus()[0]?.model,affinity,...report},null,2)+'\n');
  for (const row of report.timings) console.log(row.name, 'median redraw ms', row.medianRedrawMs.map(x=>x.toFixed(2)).join(' -> '),
    'cold texture ms', row.firstAfterShaderSetupMs.map(x=>x.toFixed(1)).join(' -> '), 'including shader setup', row.firstMs.map(x=>x.toFixed(1)).join(' -> '));
} finally {
  if (app) await app.close();
  await rm(temp,{recursive:true,force:true});
}
