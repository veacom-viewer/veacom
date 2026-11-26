import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { dataset, element } from '../fixtures/dicom-elements.mjs';
import { serveVeacom } from './lib/serve.mjs';

const [site,output,hostLabel]=process.argv.slice(2);
assert(process.env.GITHUB_ACTIONS==='true' && process.platform==='linux');
const scratch=mkdtempSync(path.join(os.tmpdir(),'veacom-next-case-'));
mkdirSync(output,{recursive:true});
const patients = [
  { code: 'A', name: 'PHANTOM^IIIIIIII', shade: 48 },
  { code: 'B', name: 'PHANTOM^WWWWWWWW', shade: 208 },
];
const transferSyntax = '1.2.840.10008.1.2.1';
const size = 128;
function makeSources() {
  const sources = [];
  for (const [patient, { code, name, shade }] of patients.entries()) {
    const modality = code === 'A' ? 'CT' : 'MR';
    const sopClass = '1.2.840.10008.5.1.4.1.1.' + (modality === 'CT' ? '2' : '4');
    const dir = path.join(scratch, code), root = '2.25.20596642642407245701214108061798273412.' + (patient + 1);
    mkdirSync(dir);
    for (let z = 0; z < 3; z++) {
      const uid = root + '.3.' + (z + 1), pixels = Buffer.alloc(size * size * 2);
      for (let y = 25; y < 103; y++) for (let x = 25; x < 103; x++) pixels.writeInt16LE(shade + 5*z, (size * y + x) * 2);
      const meta = dataset([[2,1,'OB',[0,1]],[2,2,'UI',sopClass],[2,3,'UI',uid],[2,0x10,'UI',transferSyntax],[2,0x12,'UI',root+'.4']]);
      const fields = dataset([
        [8,0x16,'UI',sopClass],[8,0x18,'UI',uid],[8,0x20,'DA','20000101'],[8,0x60,'CS',modality],[8,0x103e,'LO','Synthetic switch '+code],
        [0x10,0x10,'PN',name],[0x10,0x20,'LO','SWITCH-'+code],[0x18,0x50,'DS',1],
        [0x20,0xd,'UI',root+'.1'],[0x20,0xe,'UI',root+'.2'],[0x20,0x11,'IS',1],[0x20,0x13,'IS',z+1],
        [0x20,0x32,'DS',[0,0,z]],[0x20,0x37,'DS',[1,0,0,0,1,0]],[0x20,0x52,'UI',root+'.5'],
        [0x28,2,'US',1],[0x28,4,'CS','MONOCHROME2'],[0x28,0x10,'US',size],[0x28,0x11,'US',size],
        [0x28,0x30,'DS',[1,1]],[0x28,0x100,'US',16],[0x28,0x101,'US',16],[0x28,0x102,'US',15],[0x28,0x103,'US',1],
        [0x28,0x1050,'DS',128],[0x28,0x1051,'DS',256],[0x28,0x1052,'DS',0],[0x28,0x1053,'DS',1],[0x7fe0,0x10,'OW',pixels],
      ]);
      const bytes = Buffer.concat([Buffer.alloc(128),Buffer.from('DICM'),element(2,0,'UL',meta.length),meta,fields]);
      const file = path.join(dir,'IM'+(z+1)+'.dcm'); writeFileSync(file,bytes);
      sources.push({code, uid, z, shade:shade+5*z, modality, pixels:createHash('sha256').update(pixels).digest('hex'), sha256:createHash('sha256').update(bytes).digest('hex')});
    }
  }
  return sources;
}

function watchEngine() {
  const send=Worker.prototype.postMessage, clock=window.handoffClock={starting:false,prepared:0,starts:0};
  Worker.prototype.postMessage=function(request,...args) {
    if(request.op==='init'){
      const generation=++clock.starts;clock.starting=true;
      const ready=event=>{
        if(event.data.id!==request.id)return;
        this.removeEventListener('message',ready);
        if(generation===clock.starts)clock.starting=false;
      };
      this.addEventListener('message',ready);
      if(clock.holdNext){
        clock.holdNext=false;clock.release=()=>{delete clock.release;send.call(this,request,...args);};
        return;
      }
    }
    if('prepareImport' in request)clock.prepared++;
    if(request.op==='frame' && clock.captureSource){
      const take=clock.captureSource;delete clock.captureSource;
      const capture=async event=>{
        if(event.data.id!==request.id)return;
        this.removeEventListener('message',capture);
        if(!event.data.ok){take(null);return;}
        const f=event.data.value, digest=await crypto.subtle.digest('SHA-256',f.bytes);
        take({uid:f.sopInstanceUid,index:f.index,bytes:f.bytes.byteLength,type:f.pixelType,
          sha256:Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('')});
      };
      this.addEventListener('message',capture);
    }
    return send.call(this,request,...args);
  };
}

function observePane(){
  document.addEventListener('drop',()=>{
    const r=window.nextHandoff;
    if(r){r.drop=performance.now();r.startingAtDrop=window.handoffClock.starting;}
  },true);
  const see=()=>{
    const r=window.nextHandoff;
    if(!r?.drop || r.correct)return;
    const canvas=document.querySelector('canvas[data-series-id][data-slice]'), now=performance.now();
    const text=document.querySelector('[data-testid="patient-overlay"] text')?.textContent??'';
    const label=text.includes(r.name);
    const value=canvas ? [...canvas.getContext('2d').getImageData(canvas.width>>1,canvas.height>>1,1,1).data] : null;
    const frame={ms:now-r.drop,rgb:value?.slice(0,3)??null,alpha:value?.[3]??0,id:canvas?.dataset.seriesId,index:canvas?Number(canvas.dataset.slice):null};
    if(label && !r.firstLabel)r.firstLabel=frame;
    if(canvas && !r.firstPaint)r.firstPaint=frame;
    if(label && value && value[3]===255 && Math.abs(value[0]-r.shade)<=1)r.correct=frame;
  };
  const observer=new MutationObserver(see);
  observer.observe(document.documentElement,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['data-slice','data-series-id']});
}

async function session(mode,files){
  const server=await serveVeacom(path.resolve(site),{isolation:mode==='isolated'});
  const browser=await chromium.launch({headless:true,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const context=await browser.newContext({viewport:{width:1100,height:760},deviceScaleFactor:1});
  const page=await context.newPage(),cdp=await context.newCDPSession(page);page.setDefaultTimeout(20000);
  const rows=[];
  try{
    await page.addInitScript(watchEngine);await page.goto(server.url);
    await page.getByTestId('welcome-open-files').waitFor();await page.evaluate(observePane);
    await cdp.send('Input.setInterceptDrags',{enabled:true});
    for(let i=-2;i<27;i++){
      const p=patients[(i+2)%2],expected=files.find(f=>f.code===p.code&&f.z===2);
      const forced=i>=25, immediate=(i+Number(hostLabel)+4)%4<2;
      let priorStarts=0;
      if(i!==-2){
        const before=await page.evaluate(hold=>{
          delete window.nextHandoff;window.handoffClock.holdNext=hold;
          return {releases:Number(document.documentElement.dataset.engineReleases||0),starts:window.handoffClock.starts};
        },forced);
        await page.locator('[data-action="series-pick"]').first().click({button:'right'});
        await page.locator('[data-action="series-clear"]').click();await page.getByTestId('series-remove-confirm').click();
        priorStarts=before.starts;
        await page.waitForFunction(n=>Number(document.documentElement.dataset.engineReleases||0)>n && !document.querySelector('canvas[data-series-id]'),before.releases);
        if(forced)await page.waitForFunction(()=>typeof window.handoffClock.release==='function');
      }
      if(!immediate && !forced)await page.waitForFunction(old=>window.handoffClock.starts>old && !window.handoffClock.starting,priorStarts);
      const prepared=await page.evaluate(info=>{
        window.nextHandoff=info;return window.handoffClock.prepared;
      },{name:p.name.replace('^',' '),shade:expected.shade});
      for(const type of ['dragEnter','dragOver','drop'])
        await cdp.send('Input.dispatchDragEvent',{type,x:550,y:380,data:{items:[],files:[path.join(scratch,p.code)],dragOperationsMask:1}});
      if(forced){
        await page.waitForFunction(async()=> (await window.veacom.getProgress()).running);
        await page.evaluate(()=>window.handoffClock.release());
      }
      await page.waitForFunction(()=>Boolean(window.nextHandoff.correct));
      const info=await page.evaluate(async()=>{
        const r=window.nextHandoff,b=window.veacom,{series}=await b.listSeries(),{generation,restartCount}=await b.getCoreState();
        if(series.length!==1)throw Error('Wrong catalog size '+series.length);
        const item=series[0], id=r.correct.index, probe=Promise.withResolvers();window.handoffClock.captureSource=probe.resolve;
        const res=await b.fetchPixels({seriesId:item.id,generation,revision:item.catalogRevision,index:id});
        return {opening:r,patient:item.patientId,seriesId:item.id,modality:item.modality,depth:item.dimensions[2],sop:res.headers.get('X-SOP-Instance-UID'),
          native:await probe.promise,restartCount,preparedCount:window.handoffClock.prepared};
      });
      writeFileSync(path.join(output,mode+'-latest.json'),JSON.stringify({trial:i,expected,info},null,2));
      assert.equal(info.patient,'SWITCH-'+p.code);assert.equal(info.modality,expected.modality);assert.equal(info.depth,3);
      assert.equal(info.sop,expected.uid);assert.equal(info.native.uid,expected.uid);assert.equal(info.native.sha256,expected.pixels);assert.equal(info.native.bytes,128*128*2);
      assert.equal(info.opening.correct.id,info.seriesId);assert.equal(info.opening.firstPaint.id,info.seriesId);assert.equal(info.restartCount,0);
      assert(info.opening.firstPaint.rgb.every(v=>Math.abs(v-expected.shade)<=1),'unexpected first painted pixels: '+JSON.stringify(info));
      if(info.opening.firstLabel.rgb && info.opening.firstLabel.alpha)assert(info.opening.firstLabel.rgb.every(v=>v===0||Math.abs(v-expected.shade)<=1),'previous patient under new label');
      rows.push({trial:i,forced,immediate,mode,prepared:info.preparedCount-prepared,...info});
      writeFileSync(path.join(output,mode+'.json'),JSON.stringify(rows,null,2));
      if(i===0||i===1)await page.screenshot({path:path.join(output,mode+'-'+p.code+'.png')});
    }
  } catch(error) {
    const state=await page.evaluate(()=>({observation:window.nextHandoff,clock:{starting:window.handoffClock?.starting,starts:window.handoffClock?.starts},
      label:document.querySelector('[data-testid="patient-overlay"]')?.textContent,pane:document.querySelector('canvas[data-series-id]')?.dataset.seriesId})).catch(()=>null);
    writeFileSync(path.join(output,mode+'-failure.json'),JSON.stringify({message:String(error),state},null,2));
    await page.screenshot({path:path.join(output,mode+'-failure.png')}).catch(()=>{});throw error;
  } finally{await browser.close();await server.close();}
  console.log(mode,rows.filter(r=>r.trial>=0&&!r.forced).length,'ordinary handoffs',rows.filter(r=>r.forced).length,'held engine checks');
}
try{
  const files=makeSources();writeFileSync(path.join(output,'sources.json'),JSON.stringify(files,null,2));
  for(const mode of ['isolated','single'])await session(mode,files);
} finally{rmSync(scratch,{recursive:true,force:true});}
