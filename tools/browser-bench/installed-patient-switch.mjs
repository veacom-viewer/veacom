import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import closeDesktopTools from '../lib/close-desktop.cjs';
import { dataset, element } from '../fixtures/dicom-elements.mjs';


const [executable, destination] = process.argv.slice(2);
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
  return {center,renderer:canvas?.dataset.renderer, name:labelText, labelBox:rect(label), canvasBox:rect(canvas), drawnSeries:canvas?.dataset.seriesId??null,
    active:window.__VEACOM_TEST__?.state().activeSeriesId, engineThreads:Number(document.documentElement.dataset.engineThreads)};
}


mkdirSync(out,{recursive:true});
makeSources();
const profile=mkdtempSync(path.join(tmpdir(),'veacom-cached-switch-user-'));
const app=await electron.launch({executablePath:executable,args:['--study',scratch],env:{...process.env,VEACOM_USER_DATA:profile,VEACOM_TEST_MODE:'1',VEACOM_LOCALE:'en',VEACOM_TELEMETRY_CONSENT:'denied'},timeout:90000});
const report={switches:[]};
let page;
try {
  page=await app.firstWindow();
  await page.waitForFunction(()=>window.__VEACOM_TEST__?.state().series.length===2,null,{timeout:90000});
  const series=await page.evaluate(async()=>(await window.veacom.listSeries()).series.map(s=>({id:s.id,patient:s.patientId,frames:s.frameMetadata.map(f=>f.sopInstanceUid)})));
  const ids={};
  for(const [index,p] of patients.entries()){
    const row=series.find(s=>s.patient==='SWITCH-'+p.code);
    assert.deepEqual(row.frames,[1,2,3].map(z=>'2.25.20596642642407245701214108061798273412.'+(index+1)+'.3.'+z));
    ids[p.code]=row.id;
  }
  report.series=series;
  const choose=code=>page.getByTestId('series-'+ids[code]).click();
  const settle=code=>page.waitForFunction(({id,shade})=>{
    const c=document.querySelector('[data-testid="dicom-canvas"]');if(c?.dataset.seriesId!==id || !window.__VEACOM_TEST__.state().fullVolumeLoaded)return false;
    return Math.abs(c.getContext('2d').getImageData(c.width>>1,c.height>>1,1,1).data[0]-shade)<=1;
  },{id:ids[code],shade:patients.find(p=>p.code===code).shade});
  for(const code of ['A','B','A']){await choose(code);await settle(code);}
  for(const code of ['B','A','B','A','B','A']){
    await page.evaluate(()=>{
      const old=window.requestAnimationFrame, cancel=window.cancelAnimationFrame, held=new Map();let tag=0;
      window.requestAnimationFrame=fn=>{held.set(--tag,fn);return tag;};
      window.cancelAnimationFrame=id=>{if(!held.delete(id))cancel.call(window,id);};
      window.releasePaint=()=>{window.requestAnimationFrame=old;window.cancelAnimationFrame=cancel;for(const fn of held.values())old.call(window,fn);};
    });
    try {
      await choose(code);
      await page.waitForFunction(id=>window.__VEACOM_TEST__.state().activeSeriesId===id,ids[code],{polling:15});
      await page.waitForTimeout(100);
      const state=await page.evaluate(readPane),file='held-'+report.switches.length+'-'+code+'.png';
      await page.screenshot({path:path.join(out,file)});
      report.switches.push({target:code,state,file});
    } finally {await page.evaluate(()=>window.releasePaint());}
    await settle(code);
  }
  report.version=await app.evaluate(({app})=>({version:app.getVersion(),packaged:app.isPackaged}));assert(report.version.packaged);
} catch(e) {
  report.error=e.stack;if(page){report.last=await page.evaluate(readPane).catch(()=>null);await page.screenshot({path:path.join(out,'error.png')}).catch(()=>{});}throw e;
} finally {
  writeFileSync(path.join(out,'native-patient-switch.json'),JSON.stringify(report,null,2));
  await closeDesktopTools.closeDesktop(app);rmSync(scratch,{recursive:true,force:true});rmSync(profile,{recursive:true,force:true});
}
