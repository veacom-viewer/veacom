// Compare frame times for the same synthetic pixels on the same Electron renderer in two checkouts.
// node tools/profile-display-sampling.mjs <reference-checkout> <result.json> [--warp]
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build } from 'vite';
import { _electron as electron } from 'playwright';

const [reference, candidate, destination, option] = process.argv.slice(2);
if (!reference || !candidate || !destination || (option && option !== '--warp')) throw new Error('Expected reference checkout, result.json and optionally --warp');
const temp = await mkdtemp(path.join(os.tmpdir(), 'veacom-sampling-'));
const identifiers = {};
let app;
try {
  for (const [name, checkout] of [['Reference', path.resolve(reference)], ['Candidate', path.resolve(candidate)]]) {
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
  const report = await page.evaluate(() => {
    const renderers = window.renderers;
    const cases = [['MR',256,256,1600,1200,1], ['CT 25 panes',512,512,300,200,25],
      ['DX',3000,3000,1000,1000,1], ['MG',3328,4096,900,1100,1]];
    const timings = [];
    for (const [name,width,height,outWidth,outHeight,frames] of cases) {
      const data = new Uint16Array(width * height * frames);
      for (let i=0;i<data.length;i++) data[i]=(i*17+Math.floor(i/width)*37)%4096;
      const series = { id:name, dimensions:[width,height,frames], spacing:[1,1,1], origin:[0,0,0], direction:[1,0,0,0,1,0,0,0,1],
        modality:name==='CT 25 panes'?'CT':name, photometricInterpretation:'MONOCHROME2', components:1, canReconstruct:frames>1 };
      const volume={series,data}, startView={mode:'source',plane:'axial',slice:0,windowCenter:2048,windowWidth:4096,zoom:1,
        pan:[0,0],rotation:0,flipX:false,flipY:false,inverted:false};
      const panes=renderers.map(()=>Array.from({length:frames},()=>{const canvas=document.createElement('canvas');canvas.width=outWidth;canvas.height=outHeight;return canvas;}));
      function redraw(index,view) {
        const renderer=renderers[index],start=performance.now();
        for(let slice=0;slice<frames;slice++) {
          const canvas=panes[index][slice];
          renderer.render(canvas,volume,{...view,slice});
          canvas.getContext('2d').getImageData(outWidth>>1,outHeight>>1,1,1);
        }
        renderer.gl.finish();
        return performance.now()-start;
      }
      // Compare all RGBA output bytes outside the timed region, including each of the 25 CT panes.
      function compare() {
        let different=0,maximum=0,pixels=0,bright=0,levelMask=new Uint8Array(256);
        for(let slice=0;slice<frames;slice++){
          const [a,b]=panes.map(list=>list[slice].getContext('2d').getImageData(0,0,outWidth,outHeight).data);
          for(let i=0;i<a.length;i+=4){
            pixels++;bright+=a[i]>32;levelMask[a[i]]=1;
            const error=Math.max(Math.abs(a[i]-b[i]),Math.abs(a[i+1]-b[i+1]),Math.abs(a[i+2]-b[i+2]),Math.abs(a[i+3]-b[i+3]));
            maximum=Math.max(maximum,error);if(error)different++;
          }
        }
        return {different,maximum,pixels,bright,levels:levelMask.reduce((x,y)=>x+y,0)};
      }
      const cold=renderers.map((_,i)=>redraw(i,startView));
      const warmShader=renderers.map((renderer,i)=>{renderer.setVisibleViews([]);return redraw(i,startView);});
      const scenarios={};
      for(const mode of ['original','window','pan','fractionalPan','resizeAndWindow']){
        const times=[[],[]],checks=[];
        for(let n=0;n<20;n++) {
          const view={...startView};
          const pan=[n%3,n%5];
          if(mode==='original'){view.windowCenter+=n;view.pan=pan;}
          if(mode==='window'||mode==='resizeAndWindow'){view.windowCenter=1400+(n%7)*170;view.windowWidth=1200+(n%5)*225;}
          if(mode==='pan')view.pan=pan;
          if(mode==='fractionalPan')view.pan=[n%3+0.25*(n%2),n%5+0.375*(n%4)];
          if(mode==='resizeAndWindow')view.zoom=[1.15,0.79,1.05][n%3];
          for(const i of n%2?[1,0]:[0,1]) {
            const ms=redraw(i,view);
            if(n>=2)times[i].push(ms);
          }
          if(n===5||n===14||n===19)checks.push({n,...compare()});
        }
        const median=values=>{const a=values.toSorted((x,y)=>x-y);return (a[8]+a[9])/2;};
        scenarios[mode]={times,medians:times.map(median),checks};
      }
      const guardViews=[{zoom:0.86,rotation:17,pan:[0.3,-2.7],windowWidth:371},{flipX:true,windowCenter:1991,windowWidth:39},
        {inverted:true,windowCenter:1800,windowWidth:904},{windowWidth:1,windowCenter:2048},{voiFunction:'SIGMOID',windowWidth:912},
        {voiFunction:'LINEAR_EXACT',windowWidth:315},{palette:'hot',windowWidth:821}];
      const guards=guardViews.map(patch=>{for(let i=0;i<2;i++)redraw(i,{...startView,...patch});return {patch,...compare()};});
      timings.push({name,width,height,outWidth,outHeight,frames,cold,warmShader,scenarios,guards});
      renderers.forEach(renderer=>renderer.setVisibleViews([]));
    }
    return {renderer:renderers[0].info.renderer,candidateRenderer:renderers[1].info.renderer,
      floatLinear:!!renderers[0].gl.getExtension('OES_texture_float_linear'),floatTarget:!!renderers[0].gl.getExtension('EXT_color_buffer_float'),timings};
  });
  assert.equal(report.renderer, report.candidateRenderer);
  if (option) assert.match(report.renderer,/Microsoft Basic Render Driver|WARP/i);
  await mkdir(path.dirname(path.resolve(destination)), { recursive: true });
  await writeFile(destination, JSON.stringify({revisions:identifiers,cpu:os.cpus()[0]?.model,affinity,...report},null,2)+'\n');
  for (const row of report.timings) {
    for(const [mode,res] of Object.entries(row.scenarios)) {
      console.log(row.name,mode,res.medians.map(t=>t.toFixed(2)).join(' -> '),'ms',res.checks.map(c=>c.different).join('/'),'different pixels');
      assert.ok(res.checks.every(c=>c.levels>=12 && c.bright>0),'Visible multi-level reference image');
    }
  }
  if(identifiers.Reference===identifiers.Candidate)assert.ok(report.timings.every(row=>[...row.guards,...Object.values(row.scenarios).flatMap(s=>s.checks)].every(c=>c.different===0)),'Identical source must match every byte');
} finally {
  if (app) await app.close();
  await rm(temp,{recursive:true,force:true});
}
