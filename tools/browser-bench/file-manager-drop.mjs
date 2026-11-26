import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { makeStudy } from './make-study.mjs';
import { serveVeacom } from './lib/serve.mjs';

const [previous,changed,out] = process.argv.slice(2);
assert(process.env.GITHUB_ACTIONS==='true' && process.platform==='linux');
const dir=await mkdtemp(path.join(tmpdir(),'veacom-native-drag-')), input=path.join(dir,'files');
await mkdir(input); await mkdir(out,{recursive:true}); await makeStudy('ct-300',path.join(input,'STUDYFOLDER'));
const run=promisify(execFile), command=async (name,...args)=>(await run(name,args.map(String),{timeout:12000})).stdout.trim();
const fileManager=spawn('thunar',[input],{stdio:['ignore','inherit','inherit']});
const browser=await chromium.launch({headless:false,args:['--window-position=510,30','--window-size=1100,800']});
const results=[];
async function windowId(pattern){
  for(let i=0;i<40;i++){
    const line=(await command('wmctrl','-lx')).split('\n').find(l=>pattern.test(l));
    if(line)return line.split(/\s+/)[0];
    await delay(150);
  }
  throw Error('Missing '+pattern+' in '+await command('wmctrl','-lx')+' '+(await command('xwininfo','-root','-tree')).slice(0,1500));
}
try {
  const source=await windowId(/thunar/i);
  await command('wmctrl','-i','-r',source,'-e','0,5,70,460,650');
  await command('wmctrl','-i','-a',source);
  await command('xdotool','key','ctrl+2');
  let point;
  for(let i=0;i<6&&!point;i++){
    await delay(300);
    const picture=path.join(out,'file-manager.png');
    await command('import','-window',source,picture);
    const tsv=await command('tesseract',picture,'stdout','--psm','11','tsv');
    const line=tsv.split('\n').map(l=>l.split('\t')).find(r=>r[11]?.replace(/[^A-Z]/g,'')==='STUDYFOLDER');
    if(line){
      const info=await command('xwininfo','-id',source);
      const xy=['X','Y'].map(a=>Number(info.match(new RegExp('Absolute upper-left '+a+':\\s*(\\d+)'))[1]));
      point=[Math.round(xy[0]+Number(line[6])+Number(line[8])/2),Math.round(xy[1]+Number(line[7])+Number(line[9])/2)];
    }
  }
  assert.ok(point,'The study folder must be visible in the file manager');
  async function drag(){
    await command('wmctrl','-i','-a',source);
    await delay(150);
    await command('xdotool','mousemove','--sync',...point);
    await command('xdotool','mousedown',1);
    try{
      await delay(90);
      for(const fraction of [0.012,0.025,0.08,0.2,0.4,0.6,0.8,1]){
        await command('xdotool','mousemove',Math.round(point[0]+(1000-point[0])*fraction),Math.round(point[1]+(420-point[1])*fraction));
        await delay(45);
      }
      await delay(100);
    }finally{await command('xdotool','mouseup',1);}
    await delay(100);
  }
  for(const [label,dist]of [['before',previous],['after',changed]])for(const isolated of [true,false]){
    const site=await serveVeacom(path.resolve(dist),{isolation:isolated}),page=await browser.newPage({viewport:{width:1080,height:700}});
    const hold=Promise.withResolvers(), prefix=label+'-'+(isolated?'isolated':'single');
    try{
      await page.addInitScript(()=>{
        window.nativeDrags=[];
        for(const type of ['dragenter','dragover','drop']) addEventListener(type,e=>{
          const row={type,trusted:e.isTrusted,files:e.dataTransfer.files.length,types:[...e.dataTransfer.types],x:e.clientX,y:e.clientY};
          queueMicrotask(()=>window.nativeDrags.push({...row,prevented:e.defaultPrevented}));
        });
      });
      await page.route(/\/assets\/web-[^/]+\.js(?:\?.*)?$/,async r=>{await hold.promise;await r.continue();});
      await page.goto(site.url,{waitUntil:'commit'});
      await page.waitForFunction(()=>document.getElementById('root') && !window.veacom);
      assert.equal(await page.getByTestId('welcome-open-files').count(),0);
      const target=await windowId(/chrom(e|ium).*VEAcom/i);
      await command('wmctrl','-i','-r',target,'-b','remove,maximized_vert,maximized_horz');
      await command('wmctrl','-i','-r',target,'-e','0,510,30,1100,800');
      console.log('Source point',point,'Windows',await command('wmctrl','-lxG'));
      await command('import','-window','root',path.join(out,prefix+'-desktop.png'));
      await drag();
      hold.resolve();
      await page.waitForFunction(()=>window.__VEACOM_TEST__&&document.documentElement.dataset.engineThreads);
      const early=await page.evaluate(()=>window.nativeDrags);
      const afterFirst={visibility:await page.evaluate(()=>document.visibilityState),pages:page.context().pages().length};
      if(label==='before'){
        await page.getByTestId('welcome-open-files').waitFor();
        assert.equal((await page.evaluate(()=>window.veacom.listSeries())).series.length,0);
        await page.screenshot({path:path.join(out,prefix+'-early.png')});
        await page.bringToFront();
        await page.waitForFunction(()=>document.visibilityState==='visible');
        await drag();
      }
      await page.waitForFunction(()=>window.__VEACOM_TEST__.state().fullVolumeLoaded,undefined,{timeout:18000});
      const receipt=await page.evaluate(async()=>{
        const s=(await window.veacom.listSeries()).series[0],index=Number(document.querySelector('canvas[data-series-id][data-slice]').dataset.slice);
        const {generation}=await window.veacom.getCoreState();
        const frame=await window.veacom.fetchPixels({seriesId:s.id,revision:s.catalogRevision,generation,index});
        return {patient:s.patientId,depth:s.dimensions[2],index,uid:frame.headers.get('X-SOP-Instance-UID'),events:window.nativeDrags};
      });
      const uid='2.25.'+BigInt('0x'+createHash('sha256').update('ct-300').digest('hex').slice(0,24))+'.3.1';
      assert.equal(receipt.uid,uid);assert.equal(receipt.patient,'BENCH-ct-300');assert.equal(receipt.depth,300);assert.equal(receipt.index,299);
      assert.equal(early.filter(e=>e.type==='drop'&&e.trusted).length,Number(label==='after'));
      await page.locator('canvas[data-series-id][data-slice]').first().screenshot({path:path.join(out,prefix+'-ct.png')});
      results.push({label,isolated,early,afterFirst,...receipt});
    }catch(e){
      console.log('Observed events',await page.evaluate(()=>window.nativeDrags),'layout',await command('wmctrl','-lxG'));
      await command('import','-window','root',path.join(out,prefix+'-failure.png'));
      throw e;
    }finally{hold.resolve();await page.close();await site.close();}
  }
}finally{
  await writeFile(path.join(out,'native.json'),JSON.stringify(results,null,2));
  await browser.close();fileManager.kill();await rm(dir,{recursive:true,force:true});
}
