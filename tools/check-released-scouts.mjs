import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright';
import {dataset,element} from './fixtures/dicom-elements.mjs';
import {serveVeacom} from './browser-bench/lib/serve.mjs';

const output='evidence/scouts'; await mkdir(output,{recursive:true});
const root='2.25.21863449599830000566814011457', sopClass='1.2.840.10008.5.1.4.1.1.2';
function frames(type){
  return [0,1,2].map(i=>{
    const series=root+(type==='AXIAL'?'.2':'.3'),sop=series+'.'+(i+1),pixels=Buffer.alloc(2048);
    for(let j=0;j<1024;j++)pixels.writeInt16LE(j+i*50,j*2);
    const meta=dataset([[2,1,'OB',[0,1]],[2,2,'UI',sopClass],[2,3,'UI',sop],[2,0x10,'UI','1.2.840.10008.1.2.1'],[2,0x12,'UI',root+'.4']]);
    const tags=dataset([[8,8,'CS',['ORIGINAL','PRIMARY',type]],[8,0x16,'UI',sopClass],[8,0x18,'UI',sop],[8,0x20,'DA','20000101'],[8,0x60,'CS','CT'],[8,0x103e,'LO',type],[0x10,0x10,'PN','PHANTOM^SCOUT'],[0x10,0x20,'LO','SYNTHETIC-SCOUT'],[0x18,0x50,'DS',2],[0x20,0xd,'UI',root+'.1'],[0x20,0xe,'UI',series],[0x20,0x11,'IS',1],[0x20,0x13,'IS',i+1],[0x20,0x32,'DS',[0,0,2*i]],[0x20,0x37,'DS',[1,0,0,0,1,0]],[0x20,0x52,'UI',root+'.5'],[0x28,2,'US',1],[0x28,4,'CS','MONOCHROME2'],[0x28,0x10,'US',32],[0x28,0x11,'US',32],[0x28,0x30,'DS',[1,1]],[0x28,0x100,'US',16],[0x28,0x101,'US',16],[0x28,0x102,'US',15],[0x28,0x103,'US',1],[0x28,0x1050,'DS',550],[0x28,0x1051,'DS',1100],[0x7fe0,0x10,'OW',pixels]]);
    return {sop,sha:createHash('sha256').update(pixels).digest('hex'),file:{name:'projection-'+i+'.dcm',mimeType:'application/dicom',buffer:Buffer.concat([Buffer.alloc(128),Buffer.from('DICM'),element(2,0,'UL',meta.length),meta,tags])}};
  });
}
const browser=await chromium.launch({channel:'chrome',args:['--enable-unsafe-swiftshader','--use-angle=swiftshader']});
const report=[];
try {
  for(const build of ['old','released']) for(const isolated of [true,false]){
    const site=await serveVeacom(path.resolve('sites/'+build),{isolation:isolated});
    try{
      for(const type of ['LOCALIZER','AXIAL']){
        const source=frames(type), page=await browser.newPage({viewport:{width:1200,height:800}});
        try{
          await page.goto(site.url);
          const event=page.waitForEvent('filechooser');await page.getByTestId('welcome-open-files').click();await (await event).setFiles(source.map(x=>x.file));
          await page.waitForFunction(()=>window.__VEACOM_TEST__?.state().series[0]?.dimensions[2]===3&&document.querySelector('canvas[data-series-id][data-slice]'));
          const reading=await page.evaluate(async()=>{
            const b=window.veacom,{generation}=await b.getCoreState(),{series:[s]}=await b.listSeries(),frames=[];
            for(let index=0;index<3;index++){
              const result=await b.fetchPixels({seriesId:s.id,generation,revision:s.catalogRevision,index});
              const bytes=await result.arrayBuffer(), hash=await crypto.subtle.digest('SHA-256',bytes);
              frames.push({sop:result.headers.get('X-SOP-Instance-UID'),sha:Array.from(new Uint8Array(hash),v=>v.toString(16).padStart(2,'0')).join('')});
            }
            return {dimensions:s.dimensions,patient:s.patientId,spacing:s.spacing,canReconstruct:s.canReconstruct,frames,isolated:self.crossOriginIsolated};
          });
          const shouldReconstruct=build==='old'||type==='AXIAL';
          assert.equal(reading.isolated,isolated);assert.equal(reading.patient,'SYNTHETIC-SCOUT');assert.deepEqual(reading.dimensions,[32,32,3]);assert.deepEqual(reading.spacing,[1,1,2]);
          assert.deepEqual(reading.frames,source.map(({sop,sha})=>({sop,sha})));assert.equal(reading.canReconstruct,shouldReconstruct);
          await page.waitForFunction(disabled=>document.querySelector('[data-testid="tool-mpr"]')?.disabled===disabled,!shouldReconstruct);
          await page.getByTestId('dicom-viewport').first().focus();await page.keyboard.press('m');
          if(shouldReconstruct)await page.waitForFunction(()=>document.querySelectorAll('canvas[data-renderer][data-plane]').length===3);
          await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
          const planes=await page.locator('canvas[data-renderer][data-plane]').evaluateAll(items=>items.map(x=>x.dataset.plane).sort());
          assert.deepEqual(planes,shouldReconstruct?['axial','coronal','sagittal']:['axial']);
          await page.screenshot({path:output+'/'+build+'-'+isolated+'-'+type+'.png'});
          report.push({build,type,...reading,planes});console.log(build,isolated,type,planes);
        }finally{await page.close();}
      }
    }finally{await site.close();}
  }
}finally{await writeFile(output+'/results.json',JSON.stringify(report,null,2));await browser.close();}
