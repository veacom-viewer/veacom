import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { cpus, tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { makeStudy } from './make-study.mjs';
import { serveVeacom } from './lib/serve.mjs';

const [dist,output]=process.argv.slice(2);
const dir=await mkdtemp(path.join(tmpdir(),'veacom-wire-')),browser=await chromium.launch();
const site=await serveVeacom(path.resolve(dist));
const report={platform:process.platform,processor:cpus()[0].model,browser:browser.version(),studies:{}};
await mkdir(output,{recursive:true});
const workerText=`
let json;
onmessage=({data})=>{
  if(data.json){json=data.json;postMessage({ready:true});return;}
  const start=performance.timeOrigin+performance.now();
  const value=data.mode==='object'?JSON.parse(json):json;
  const encoded=performance.timeOrigin+performance.now();
  postMessage({start,encoded,value});
};`;
const neutral=createServer((request,response)=>{
  const script=request.url==='/__catalog.js';
  response.writeHead(200,{'Content-Type':script?'text/javascript':'text/html','Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'});
  response.end(script?workerText:'<!doctype html><title>Catalog transport</title>');
});
await new Promise(resolve=>neutral.listen(0,'127.0.0.1',resolve));
try{
  for(const study of ['ct-300','ct-1000']){
    const depth=Number(study.slice(3)),folder=path.join(dir,study);
    await makeStudy(study,folder);
    const viewer=await browser.newPage();
    let json;
    try{
      await viewer.addInitScript(()=>{
        window.Worker=class extends Worker{
          constructor(...args){super(...args);this.addEventListener('message',({data})=>{
            if(data.ok&&Array.isArray(data.value?.series)&&data.value.series.length) window.actualCatalog=JSON.stringify(data.value);
          });}
        };
      });
      await viewer.goto(site.url);
      const cdp=await viewer.context().newCDPSession(viewer);
      await viewer.getByTestId('welcome-open-files').waitFor();
      for(const type of ['dragEnter','dragOver','drop'])await cdp.send('Input.dispatchDragEvent',{type,x:200,y:220,data:{items:[],files:[folder],dragOperationsMask:1}});
      await viewer.waitForFunction(()=>window.actualCatalog,undefined,{timeout:60000});
      json=await viewer.evaluate(()=>window.actualCatalog);
    }finally{await viewer.close();}
    const {series:[series]}=JSON.parse(json);
    const root='2.25.'+BigInt('0x'+createHash('sha256').update(study).digest('hex').slice(0,24));
    assert.equal(series.patientId,'BENCH-'+study);
    assert.deepEqual(series.dimensions,[512,512,depth]);
    const uids=new Set(series.frameMetadata.map(f=>f.sopInstanceUid));assert.equal(uids.size,depth);
    for(let i=0;i<depth;i++)assert.ok(uids.has(root+'.3.'+(i+1)));
    const page=await browser.newPage();
    try {
      await page.goto('http://127.0.0.1:'+neutral.address().port+'/');
      const timing=await page.evaluate(async json=>{
        const worker=new Worker('/__catalog.js');
        const ask=data=>new Promise((resolve,reject)=>{
          worker.onmessage=e=>resolve(e.data);
          worker.onerror=e=>reject(new Error(e.message));
          worker.postMessage(data);
        });
        await ask({json});
        const trials=[];
        try{
          for(let round=-2;round<36;round++){
            const modes=round%2?['json','object']:['object','json'];
            for(const mode of modes){
              const before=performance.timeOrigin+performance.now();
              const {value,start,encoded}=await ask({mode});
              const arrived=performance.timeOrigin+performance.now();
              const catalog=mode==='json'?JSON.parse(value):value;
              const ready=performance.timeOrigin+performance.now();
              if(JSON.stringify(catalog)!==json)throw Error('Catalog contents changed');
              if(round>=0)trials.push({round,mode,slot:modes.indexOf(mode),elapsedMs:ready-before,workerParseMs:encoded-start,deliveryMs:arrived-encoded,pageParseMs:ready-arrived});
            }
          }
        }finally{worker.terminate();}
        return trials;
      },json);
      report.studies[study]={sourceFrames:depth,jsonBytes:Buffer.byteLength(json),jsonSha256:createHash('sha256').update(json).digest('hex'),timing};
    }finally{await page.close();}
  }
  await writeFile(path.join(output,'wire.json'),JSON.stringify(report,null,2));
}finally{await browser.close();neutral.close();await site.close();await rm(dir,{recursive:true,force:true});}
