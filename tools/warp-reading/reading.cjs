const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const {_electron: electron} = require('playwright');
const {closeDesktop} = require('../lib/close-desktop.cjs');
const {EngineProcess} = require('../../electron/engine-process.cjs');
const {jpegjs,PNG} = require(path.join(path.dirname(require.resolve('playwright-core/package.json')), 'lib/utilsBundle.js'));
const [ref,cand,studies,out]=process.argv.slice(2).map(x=>path.resolve(x));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const waitPaint=page=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
const rows=[], expectedImages=new Map();
const report={reference:execFileSync('git',['-C',ref,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),candidate:execFileSync('git',['-C',cand,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),cpu:os.cpus()[0].model,rows};
const save=()=>fs.writeFile(path.join(out,'reading.json'),JSON.stringify(report,null,2)+'\n');
const grey=(value,c,w)=>Math.round(255*Math.max(0,Math.min(1,(value-(c-.5))/(w-1)+.5)));
function level(p,nx,ny) {
  const x=Math.round(nx*(p.width-1)),y=Math.round(ny*(p.height-1));
  let s=0;
  for(let dy=-3;dy<=3;dy++)for(let dx=-3;dx<=3;dx++)s+=p.data[4*((y+dy)*p.width+x+dx)];
  return s/49;
}
async function trace(page){
 const cdp=await page.context().newCDPSession(page),events=[];
 cdp.on('Tracing.dataCollected',p=>events.push(...p.value));
 await cdp.send('Tracing.start',{transferMode:'ReportEvents',traceConfig:{includedCategories:['disabled-by-default-devtools.screenshot','blink.user_timing'],excludedCategories:['*']}});
 return async()=>{
  let timer;
  try {
   const done=new Promise(resolve=>cdp.once('Tracing.tracingComplete',resolve));
   await cdp.send('Tracing.end');
   await Promise.race([done,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Trace did not end')),30000);})]);
   return events;
  } finally {clearTimeout(timer);await cdp.detach();}
 };
}
async function nudge(page) {
 for(let i=0;i<4;i++){await page.evaluate(i=>{let e=document.getElementById('warp-corner');if(!e){e=document.createElement('div');e.id='warp-corner';e.style.cssText='position:fixed;right:0;bottom:0;width:16px;height:16px;z-index:999999;pointer-events:none';document.body.append(e);}e.style.background=i%2?'white':'black';},i);await sleep(45);}
}
async function mgTrial(page,record) {
 const canvas=page.locator('canvas[data-renderer]').first(),value=1600;
 await page.evaluate(()=>{const h=window.__VEACOM_TEST__;h.setTool('window');h.setView({mode:'source',plane:'axial',slice:0,windowCenter:2048,windowWidth:4096,zoom:1,pan:[0,0],inverted:false});});
 await waitPaint(page);
 const geom=await canvas.evaluate(e=>{const r=e.getBoundingClientRect();return {nx:(r.x+r.width/2)/innerWidth,ny:(r.y+r.height/2)/innerHeight,x:Math.round(r.x+r.width*.35),y:Math.round(r.y+r.height*.48),w:r.width,h:r.height};});
 record.canvas=geom;
 const checkPixel=async expected=>{const png=PNG.sync.read(await page.screenshot());const v=level(png,geom.nx,geom.ny);assert.ok(Math.abs(v-expected)<=3,'Screenshot center '+v+' expected '+expected);return v;};
 await checkPixel(grey(value,2048,4096));
 await page.evaluate(()=>window.addEventListener('pointermove',e=>{if(e.buttons===1 && window.__warpMark){performance.mark(window.__warpMark);delete window.__warpMark;}},{capture:true}));
 const stop=await trace(page),tasks=[];
 for(let i=0;i<8;i++){
  await page.evaluate(()=>window.__VEACOM_TEST__.setView({windowCenter:2048,windowWidth:4096}));await waitPaint(page);await nudge(page);
  const dy=i%2?55:-55, target=2048-dy*4096/300;
  await page.mouse.move(geom.x,geom.y);await page.mouse.down();
  await page.evaluate(i=>{window.__warpMark='warp-input-'+i;},i);
  await page.mouse.move(geom.x,geom.y+dy);await page.mouse.up();
  await page.waitForFunction(target=>Math.abs(window.__VEACOM_TEST__.state().panes[0].windowCenter-target)<0.1,target,{timeout:8000});
  await waitPaint(page);await nudge(page);
  await page.evaluate(i=>performance.mark('warp-end-'+i),i);
  tasks.push({i,targetGrey:grey(value,target,4096)});
 }
 const events=await stop(),marks=Object.fromEntries(events.filter(e=>e.name?.startsWith('warp-')).map(e=>[e.name,e.ts/1000]));
 const captures=events.filter(e=>e.name==='Screenshot'&&e.args?.snapshot).map(e=>{
   const pic=jpegjs.decode(Buffer.from(e.args.snapshot,'base64'),{useTArray:true});
   const capture=e.ts/1000,estimate=e.args.expected_display_time/1000;
   return {capture,estimate:Number.isFinite(estimate)&&Math.abs(estimate-capture)<5000?estimate:null,grey:level(pic,geom.nx,geom.ny)};
 }).sort((a,b)=>a.capture-b.capture);
 record.window=tasks.map(({i,targetGrey})=>{
  const mark=marks['warp-input-'+i],end=marks['warp-end-'+i],pre=captures.filter(x=>x.capture<mark).at(-1);
  const after=captures.find(x=>x.capture>=mark && x.capture<=end+100 && (x.estimate===null || x.estimate>=mark) && Math.abs(x.grey-targetGrey)<=4);
  if(!Number.isFinite(mark)||!pre||Math.abs(pre.grey-grey(value,2048,4096))>4||!after)throw new Error(JSON.stringify({i,mark,end,targetGrey,pre,near:captures.filter(x=>x.capture>=mark-220&&x.capture<=end+200).map(x=>[Math.round(x.capture-mark),Math.round(x.grey)])}));
  return {i,targetGrey,preGrey:pre.grey,shownGrey:after.grey,captureMs:after.capture-mark,estimatedMs:after.estimate===null?null:after.estimate-mark};
 });
 await checkPixel(tasks.at(-1).targetGrey);
}
async function ctTrial(app,page,record,centres,build,pair) {
 const cells=page.getByTestId('viewport-cell');
 await page.getByTestId('tool-layout').click();await page.locator('[data-action="layout-5x5"]').click();
 await page.waitForFunction(()=>window.__VEACOM_TEST__.state().panes.length===25);
 if(await page.evaluate(()=>window.__VEACOM_TEST__.state().linked)){
   await page.evaluate(()=>document.querySelector('[data-testid="tool-link"]')?.click());
   await page.waitForFunction(()=>!window.__VEACOM_TEST__.state().linked);
 }
 const series=await page.evaluate(()=>window.__VEACOM_TEST__.state().series[0].id);
 for(let i=0;i<25;i++){
  const cell=cells.nth(i);
  await cell.evaluate((e,id)=>{const data=new DataTransfer();data.setData('application/x-veacom-series',id);e.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data}));},series);
  await cell.locator('canvas[data-renderer]').waitFor();
  await cell.getByTestId('dicom-viewport').focus();
  await page.waitForFunction(i=>document.querySelectorAll('[data-testid="viewport-cell"]')[i]?.classList.contains('is-active'),i,{timeout:5000});
  await page.evaluate(i=>window.__VEACOM_TEST__.setView({mode:'source',plane:'axial',slice:i,windowCenter:2048,windowWidth:4096,zoom:1,pan:[0,0]}),i);
  await page.waitForFunction(i=>Number(document.querySelectorAll('[data-testid="viewport-cell"]')[i]?.querySelector('canvas[data-renderer]')?.dataset.slice)===i,i);
 }
 await waitPaint(page);
 const read=async digest=>page.evaluate(async digest=>{
  return Promise.all([...document.querySelectorAll('[data-testid="viewport-cell"] canvas[data-renderer]')].map(async c=>{
   const ctx=c.getContext('2d'),x=c.width>>1,y=c.height>>1,val=ctx.getImageData(x,y,1,1).data[0];
   let sha;if(digest){const bytes=ctx.getImageData(0,0,c.width,c.height).data,hash=await crypto.subtle.digest('SHA-256',bytes);sha=Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('');}
   return {slice:Number(c.dataset.slice),w:c.width,h:c.height,val,sha};
  }));
 },digest);
 function validate(images){assert.equal(images.length,25);for(const [i,v] of images.entries()){assert.equal(v.slice,i);assert.ok(Math.abs(v.val-grey(centres[i],2048,4096))<=1,'slice '+i+' center='+v.val+' expected='+grey(centres[i],2048,4096));}}
 validate(await read(false));
 await page.evaluate(()=>{
  window.addEventListener('resize',()=>{const r=window.__warpResize;if(r&&r.start===null)r.start=performance.now();},{capture:true});
  const draw=CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage=function(...args){
   const result=draw.apply(this,args),r=window.__warpResize;
   if(r&&r.start!==null&&this.canvas.matches('[data-testid="viewport-cell"] canvas[data-renderer]')){
    r.canvases.add(this.canvas);if(r.canvases.size===25&&r.ms===null)r.ms=performance.now()-r.start;
   }
   return result;
  };
 });
 record.resizes=[];
 for(let i=0;i<8;i++){
  const size=i%2?[1510,1000]:[1290,825];
  await page.evaluate(()=>{window.__warpResize={start:null,canvases:new Set(),ms:null};});
  await app.evaluate(({BrowserWindow},size)=>BrowserWindow.getAllWindows()[0].setContentSize(size[0],size[1]),size);
  await page.waitForFunction(()=>window.__warpResize?.ms!==null,undefined,{timeout:10000});
  await waitPaint(page);
  const images=await read(i>=6);validate(images);
  const row=await page.evaluate(()=>({ms:window.__warpResize.ms,painted:window.__warpResize.canvases.size,inner:[innerWidth,innerHeight]}));row.size=size;
  if(i>=6){row.images=images;const key=size.join('x');if(!expectedImages.has(key))expectedImages.set(key,images);
    else assert.deepEqual(images,expectedImages.get(key),'Wrong pixels or pane size at '+key);}
  record.resizes.push(row);
 }
 if(pair===1)await page.screenshot({path:path.join(out,build+'-25panes.png')});
}
async function main(){
 assert.equal(process.platform,'win32','This benchmark measures the Windows WARP driver');
 await fs.mkdir(out,{recursive:true});const manifest=JSON.parse(await fs.readFile(path.join(out,'study-manifest.json'),'utf8'));
 const engine=new EngineProcess({binary:process.env.VEACOM_CORE_PATH,restartDelaysMs:[]});let centres;
 try {const c=await engine.start();const response=await c.request('import',{paths:[path.join(studies,'CT')]});const j=await response.json();assert.ok(response.ok,j.error);assert.equal(j.series.length,1);
  centres=j.series[0].frameMetadata.map(f=>manifest.studies.CT.centerBySop[f.sopInstanceUid]);assert.equal(new Set(centres).size,25);assert.ok(centres.every(Number.isFinite));}finally{await engine.stop();}
 const pairs=Number(process.env.VEACOM_WARP_PAIRS);assert.ok(Number.isInteger(pairs)&&pairs>=1&&pairs<=12);
 for(let pair=1;pair<=pairs;pair++)for(const modality of ['MG','CT'])for(const build of pair%2?['reference','candidate']:['candidate','reference']){
  const checkout=build==='reference'?ref:cand,profile=await fs.mkdtemp(path.join(os.tmpdir(),'warp-reader-')),record={pair,build,modality};
  let app,page;
  try{
   app=await electron.launch({args:[checkout,'--study',path.join(studies,modality),'--use-angle=d3d11-warp'],env:{...process.env,VEACOM_USER_DATA:profile,VEACOM_LOCALE:'en',VEACOM_TEST_MODE:'1',VEACOM_TELEMETRY_CONSENT:'denied'},timeout:90000});
   page=await app.firstWindow();page.setDefaultTimeout(12000);
   await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1510,1000));
   await page.emulateMedia({reducedMotion:'reduce'});
   await page.waitForFunction(modality=>{const s=window.__VEACOM_TEST__?.state();return s?.dimensions && (modality==='MG'?s.dimensions[2]===1:s.fullVolumeLoaded) && document.querySelector('canvas[data-renderer]');},modality,{timeout:90000});
   record.renderer=await page.locator('canvas[data-renderer]').first().getAttribute('data-renderer');assert.match(record.renderer,/Microsoft Basic Render Driver|WARP/i);
   const ids=await app.evaluate(({app})=>app.getAppMetrics().filter(p=>['Browser','GPU','Tab'].includes(p.type)).map(p=>p.pid));
   const cmd="$ErrorActionPreference='Stop'; Get-Process -Id "+ids.join(',')+" | ForEach-Object { $bits=$_.ProcessorAffinity.ToInt64(); $a=$bits -band (-$bits); $bits=$bits -bxor $a; $mask=$a -bor ($bits -band (-$bits)); $_.ProcessorAffinity=[IntPtr]$mask; [string]$_.ProcessorAffinity.ToInt64() }";
   record.affinity=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',cmd],{encoding:'utf8'}).trim().split(/\s+/).map(Number);
   assert.ok(record.affinity.length>=3&&record.affinity.every(n=>n.toString(2).replaceAll('0','').length===2));
   if(modality==='MG')await mgTrial(page,record);else await ctTrial(app,page,record,centres,build,pair);
   console.log(pair,build,modality,modality==='MG'?record.window.map(v=>v.captureMs.toFixed(1)):record.resizes.map(v=>v.ms.toFixed(1)));
  }catch(e){
   record.error=String(e.stack||e);if(page){record.state=await page.evaluate(()=>{const s=window.__VEACOM_TEST__?.state();return {active:s?.activeSlotId,layout:s?.layout,panes:s?.panes,cell:document.querySelector('[data-testid="viewport-cell"]')?.className};}).catch(()=>null);await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});}
   throw e;
  }finally{rows.push(record);await save();if(app)await closeDesktop(app);await fs.rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:150});}
 }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
