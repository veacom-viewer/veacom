import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { dataset, element } from '../fixtures/dicom-elements.mjs';
import { serveVeacom } from './lib/serve.mjs';

const [siteDirectory, destination, hardware] = process.argv.slice(2);
const out = path.resolve(destination);
const scratch = mkdtempSync(path.join(tmpdir(), 'veacom-switch-'));
const patients = [
  { code: 'A', name: 'PHANTOM^IIIIIIII', shade: 48 },
  { code: 'B', name: 'PHANTOM^WWWWWWWW', shade: 208 },
];
const sopClass = '1.2.840.10008.5.1.4.1.1.2', transferSyntax = '1.2.840.10008.1.2.1';
const size = 128;
function makeSources() {
  const sources = [];
  for (const [patient, { code, name, shade }] of patients.entries()) {
    const dir = path.join(scratch, code), root = '2.25.20596642642407245701214108061798273412.' + (patient + 1);
    mkdirSync(dir);
    for (let z = 0; z < 3; z++) {
      const uid = root + '.3.' + (z + 1), pixels = Buffer.alloc(size * size * 2);
      for (let y = 25; y < 103; y++) for (let x = 25; x < 103; x++) pixels.writeInt16LE(shade, (size * y + x) * 2);
      const meta = dataset([[2,1,'OB',[0,1]],[2,2,'UI',sopClass],[2,3,'UI',uid],[2,0x10,'UI',transferSyntax],[2,0x12,'UI',root+'.4']]);
      const fields = dataset([
        [8,0x16,'UI',sopClass],[8,0x18,'UI',uid],[8,0x20,'DA','20000101'],[8,0x60,'CS','CT'],[8,0x103e,'LO','Synthetic switch '+code],
        [0x10,0x10,'PN',name],[0x10,0x20,'LO','SWITCH-'+code],[0x18,0x50,'DS',1],
        [0x20,0xd,'UI',root+'.1'],[0x20,0xe,'UI',root+'.2'],[0x20,0x11,'IS',1],[0x20,0x13,'IS',z+1],
        [0x20,0x32,'DS',[0,0,z]],[0x20,0x37,'DS',[1,0,0,0,1,0]],[0x20,0x52,'UI',root+'.5'],
        [0x28,2,'US',1],[0x28,4,'CS','MONOCHROME2'],[0x28,0x10,'US',size],[0x28,0x11,'US',size],
        [0x28,0x30,'DS',[1,1]],[0x28,0x100,'US',16],[0x28,0x101,'US',16],[0x28,0x102,'US',15],[0x28,0x103,'US',1],
        [0x28,0x1050,'DS',128],[0x28,0x1051,'DS',256],[0x28,0x1052,'DS',0],[0x28,0x1053,'DS',1],[0x7fe0,0x10,'OW',pixels],
      ]);
      const bytes = Buffer.concat([Buffer.alloc(128),Buffer.from('DICM'),element(2,0,'UL',meta.length),meta,fields]);
      const file = path.join(dir,'IM'+(z+1)+'.dcm'); writeFileSync(file,bytes);
      sources.push({file, code, uid, shade, sha256:createHash('sha256').update(bytes).digest('hex')});
    }
  }
  return sources;
}

function readPane() {
  const canvas=document.querySelector('[data-testid="dicom-canvas"]');
  const label=document.querySelector('[data-testid="patient-overlay"] text');
  const labelText=label?.textContent ?? '';
  const rect=el=>{ if(!el)return null;const {x,y,width,height}=el.getBoundingClientRect();return {x,y,width,height}; };
  let center=null;
  if(canvas?.width && canvas.height) center=Array.from(canvas.getContext('2d').getImageData(Math.floor(canvas.width/2),Math.floor(canvas.height/2),1,1).data);
  return {center, renderer:canvas?.dataset.renderer, name:labelText, labelBox:rect(label), canvasBox:rect(canvas), drawnSeries:canvas?.dataset.seriesId??null,
    active:window.__VEACOM_TEST__?.state().activeSeriesId, engineThreads:Number(document.documentElement.dataset.engineThreads)};
}

async function observe(browser, sources, isolated) {
  const dir=path.join(out,isolated?'threaded':'single');mkdirSync(dir,{recursive:true});
  const site=siteDirectory==='live' ? {url:'https://viewer.veacom.app/',close:async()=>{}} : await serveVeacom(path.resolve(siteDirectory),{isolation:isolated});
  const page=await browser.newPage({viewport:{width:1120,height:760}, deviceScaleFactor:1, locale:'en-US'});
  const cdp=await page.context().newCDPSession(page);
  const report={isolated, references:{}, naturalFrames:[], held:[], switches:[]};
  try {
    await page.addInitScript(()=>{
      const nativeRequest=requestAnimationFrame.bind(window), nativeCancel=cancelAnimationFrame.bind(window);
      let block=false, sequence=0;
      const waiting=new Map();
      window.requestAnimationFrame=cb=>{
        if(!block)return nativeRequest(cb);
        const id=--sequence;waiting.set(id,cb);return id;
      };
      window.cancelAnimationFrame=id=>{if(!waiting.delete(id))nativeCancel(id);};
      window.holdSwitchPaint=()=>{block=true;};
      window.releaseSwitchPaint=()=>{
        block=false;const n=waiting.size;
        for(const cb of waiting.values())nativeRequest(cb);
        waiting.clear();return n;
      };
    });
    await page.goto(site.url);
    const picker=page.waitForEvent('filechooser');
    await page.getByTestId('welcome-open-files').click();
    await (await picker).setFiles(sources.map(s=>s.file));
    await page.waitForFunction(()=>window.__VEACOM_TEST__?.state().series.length===2);
    const series=await page.evaluate(async()=>(await window.veacom.listSeries()).series.map(s=>({id:s.id,patient:s.patientId,name:s.patientName,frames:s.frameMetadata.map(f=>f.sopInstanceUid)})));
    const ids={};
    for(const {code,name} of patients) {
      const item=series.find(s=>s.patient==='SWITCH-'+code);assert(item);
      assert.equal(item.name,name);assert.deepEqual(item.frames,sources.filter(s=>s.code===code).map(s=>s.uid));ids[code]=item.id;
    }
    report.series=series;
    async function choose(code) { await page.getByTestId('series-'+ids[code]).click(); }
    async function settled(code) {
      await page.waitForFunction(({id,shade,name})=>{
        const canvas=document.querySelector('[data-testid="dicom-canvas"]');
        if(!canvas?.width||canvas.dataset.seriesId!==id||!window.__VEACOM_TEST__.state().fullVolumeLoaded)return false;
        const rgba=canvas.getContext('2d').getImageData(canvas.width>>1,canvas.height>>1,1,1).data;
        return Math.abs(rgba[0]-shade)<=1 && rgba[3]===255 && document.querySelector('[data-testid="patient-overlay"] text')?.textContent.includes(name);
      },{id:ids[code],shade:patients.find(p=>p.code===code).shade,name:patients.find(p=>p.code===code).name.replace('^',' ')});
    }
    for(const code of ['A','B','A']) {
      await choose(code);await settled(code);await page.evaluate(()=>document.fonts.ready.then(()=>true));
      report.references[code]=await page.evaluate(readPane);
      await page.screenshot({path:path.join(dir,'reference-'+code+'.png')});
    }
    const cdpFrames=[];
    cdp.on('Page.screencastFrame',ev=>{
      cdpFrames.push({data:ev.data, time:ev.metadata.timestamp});
      void cdp.send('Page.screencastFrameAck',{sessionId:ev.sessionId}).catch(()=>{});
    });
    await cdp.send('Page.startScreencast',{format:'jpeg',quality:90,maxWidth:1120,maxHeight:760,everyNthFrame:1});
    for(let index=0;index<24;index++) {
      const code=index%2===0?'B':'A';
      const start=Date.now(); await choose(code);await settled(code); await page.waitForTimeout(32);
      report.switches.push({code,start,finish:Date.now()});
    }
    await cdp.send('Page.stopScreencast');
    for(const [index,frame] of cdpFrames.entries()){
      const name='natural-'+String(index).padStart(3,'0')+'.jpg';writeFileSync(path.join(dir,name),Buffer.from(frame.data,'base64'));
      report.naturalFrames.push({name,time:frame.time});
    }
    assert(cdpFrames.length>=12,'At least 12 compositor frames must be captured.');
    for(let i=0;i<6;i++) {
      const code=i%2===0?'B':'A';
      await page.evaluate(()=>window.holdSwitchPaint());
      try {
        // A reader click commits the new series while the next animation callback is held.
        await choose(code);
        await page.waitForFunction(id=>window.__VEACOM_TEST__.state().activeSeriesId===id,ids[code],{polling:15,timeout:4000});
        await page.waitForTimeout(100);
        const state=await page.evaluate(readPane);
        const file='delayed-'+i+'-'+code+'.png';await page.screenshot({path:path.join(dir,file),timeout:5000});
        report.held.push({target:code,state,file});
        if(hardware) {
          assert.equal(hardware,'t4');assert.match(state.renderer,/NVIDIA.*T4/i);
          const patient=patients.find(p=>p.code===code);
          assert.equal(state.drawnSeries,ids[code]);assert(state.name.includes(patient.name.replace('^',' ')));
          assert(Math.abs(state.center[0]-patient.shade)<=1 && state.center[3]===255);
        }
      } finally { await page.evaluate(()=>window.releaseSwitchPaint()); }
      await settled(code);
    }
    console.log(isolated?'threaded':'single',cdpFrames.length,'composited frames',report.held.map(h=>[h.target,h.state.center?.[0],h.state.name]));
  } catch(error) {
    report.error=String(error?.stack??error);
    report.lastPane=await page.evaluate(readPane).catch(()=>null);
    await page.screenshot({path:path.join(dir,'error.png'),timeout:3000}).catch(()=>{});
    throw error;
  } finally {
    writeFileSync(path.join(dir,'summary.json'),JSON.stringify(report,null,2)+'\n');
    await cdp.detach();await page.close();await site.close();
  }
}

mkdirSync(out,{recursive:true});
const browser=await chromium.launch(hardware ? {channel:'msedge',headless:false,args:['--enable-gpu','--use-angle=d3d11']} : {});
try{
  const sources=makeSources();
  writeFileSync(path.join(out,'sources.json'),JSON.stringify(sources.map(({file,...s})=>({...s,file:path.basename(file)})),null,2)+'\n');
  for(const isolated of siteDirectory==='live' ? [true] : [true,false])await observe(browser,sources,isolated);
} finally {await browser.close();rmSync(scratch,{recursive:true,force:true});}
