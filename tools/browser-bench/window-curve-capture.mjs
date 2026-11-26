import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { dataset, element } from '../fixtures/dicom-elements.mjs';
import { serveVeacom } from './lib/serve.mjs';

const [siteFolder, output, hardware] = process.argv.slice(2);
const root = '2.25.187661561909761364227719337832610900704', size = 144, band = 16;
const codes = [-8, -4, -2, -1, 0, 1, 2, 4, 8];
const cases = [
  ['linear-control', 'LINEAR', 0.5, 3, 0.25, 0],
  ['threshold', null, 0.5, 1, 0.25, 0],
  ['linear-fraction', 'LINEAR', 0.5, 1.5, 0.125, 0],
  ['exact-control', 'LINEAR_EXACT', 0.5, 1, 0.0625, 0.5],
  ['sigmoid-control', 'SIGMOID', 0.5, 1, 0.0625, 0.5],
  ['exact-narrow', 'LINEAR_EXACT', 0.5, 0.125, 0.015625, 0.5],
  ['sigmoid-narrow', 'SIGMOID', 0.5, 0.125, 0.015625, 0.5],
  ['exact-small-units', 'LINEAR_EXACT', 0.01, 0.005, 0.00125, 0.01],
];
function makeFile([name, curve, center, width, slope, intercept], index) {
  const sop = root + '.3.' + (index + 1), series = root + '.2.' + (index + 1), ct = '1.2.840.10008.5.1.4.1.1.2';
  const pixels = Buffer.alloc(size * size * 2);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) pixels.writeInt16LE(codes[Math.floor(x / band)], (y * size + x) * 2);
  const meta = dataset([[2,1,'OB',[0,1]], [2,2,'UI',ct], [2,3,'UI',sop], [2,0x10,'UI','1.2.840.10008.1.2.1'], [2,0x12,'UI',root+'.4']]);
  const fields = dataset([
    [8,0x16,'UI',ct], [8,0x18,'UI',sop], [8,0x20,'DA','20000101'], [8,0x60,'CS','CT'], [8,0x103e,'LO',name],
    [0x10,0x10,'PN','PHANTOM^GREYSCALE'], [0x10,0x20,'LO','SYNTHETIC-WINDOW'], [0x18,0x50,'DS',1],
    [0x20,0xd,'UI',root+'.1'], [0x20,0xe,'UI',series], [0x20,0x11,'IS',index+1], [0x20,0x13,'IS',1],
    [0x20,0x32,'DS',[0,0,0]], [0x20,0x37,'DS',[1,0,0,0,1,0]], [0x20,0x52,'UI',root+'.5'],
    [0x28,2,'US',1], [0x28,4,'CS','MONOCHROME2'], [0x28,0x10,'US',size], [0x28,0x11,'US',size], [0x28,0x30,'DS',[1,1]],
    [0x28,0x100,'US',16], [0x28,0x101,'US',16], [0x28,0x102,'US',15], [0x28,0x103,'US',1],
    [0x28,0x1050,'DS',center], [0x28,0x1051,'DS',width], [0x28,0x1052,'DS',intercept], [0x28,0x1053,'DS',slope],
    ...(curve ? [[0x28,0x1056,'CS',curve]] : []), [0x7fe0,0x10,'OW',pixels],
  ]);
  const file = path.join(output, 'sources', name + '.dcm');
  const contents = Buffer.concat([Buffer.alloc(128),Buffer.from('DICM'),element(2,0,'UL',meta.length),meta,fields]);
  writeFileSync(file,contents);
  return { name, sop, series, file, sha256:createHash('sha256').update(contents).digest('hex') };
}

async function observe(browser, fixtures, isolated) {
  const site = await serveVeacom(path.resolve(siteFolder),{isolation:isolated});
  const page = await browser.newPage({viewport:{width:1250,height:800},deviceScaleFactor:1});
  const dir = path.join(output,isolated?'threaded':'single'); mkdirSync(dir,{recursive:true});
  const report = { isolated, cases:[] };
  try {
    await page.goto(site.url);
    const open = page.waitForEvent('filechooser'); await page.getByTestId('welcome-open-files').click();
    await (await open).setFiles(fixtures.map(s=>s.file));
    await page.waitForFunction(n=>window.__VEACOM_TEST__?.state().series.length===n, fixtures.length);
    const catalog = await page.evaluate(async()=>(await window.veacom.listSeries()).series.map(s=>({id:s.id,uid:s.uid,name:s.description})));
    for(const entry of fixtures) {
      const selected=catalog.find(s=>s.uid===entry.series); assert.equal(selected?.name,entry.name);
      const id=selected.id, card=page.getByTestId('series-'+id); await card.click();
      await page.waitForFunction(id=>document.querySelector('[data-testid="dicom-canvas"]')?.dataset.seriesId===id && window.__VEACOM_TEST__.state().activeSeriesId===id, id);
      await card.locator('canvas').first().waitFor();
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      const row=await page.evaluate(async({id,size})=>{
        const bridge=window.veacom;const s=(await bridge.listSeries()).series.find(s=>s.id===id),meta=s.frameMetadata[0];
        const {generation}=await bridge.getCoreState();
        const frame=await bridge.fetchPixels({seriesId:id,generation,revision:s.catalogRevision,index:0});
        const kind=frame.headers.get('X-Pixel-Type');
        const type={float32:Float32Array,float64:Float64Array,int16:Int16Array,uint16:Uint16Array,uint8:Uint8Array}[kind];
        const values=new type(await frame.arrayBuffer());
        const pixels=document.querySelector('[data-testid="dicom-canvas"]');
        const view=window.__VEACOM_TEST__.state().displayedView;
        const thumbnail=document.querySelector('[data-testid="series-'+id+'"] canvas');
        const bands=canvas=>{
          const side=Math.min(canvas.width,canvas.height),context=canvas.getContext('2d');
          return Array.from({length:9},(_,i)=>context.getImageData(Math.floor(canvas.width/2+side*((i+.5)/9-.5)),Math.floor(canvas.height/2+.08*side),1,1).data[0]);
        };
        return {uid:s.uid,sop:frame.headers.get('X-SOP-Instance-UID'),kind,frameWidth:meta.windowWidth,frameCenter:meta.windowCenter,frameCurve:meta.voiFunction,
          volumeWidth:s.windowWidth,volumeCenter:s.windowCenter,selectedCanvas:pixels.dataset.seriesId,view,adapter:pixels.dataset.renderer,threads:Number(document.documentElement.dataset.engineThreads),
          sourceValues:Array.from({length:9},(_,i)=>values[Math.floor(size*.58)*size+i*16+8]),rawPane:bands(pixels),rawThumbnail:bands(thumbnail),
          overlay:document.querySelector('[data-testid="image-overlay"]').textContent,canvas:[pixels.width,pixels.height],thumbnail:[thumbnail.width,thumbnail.height]};
      },{id,size});
      assert.equal(row.sop,entry.sop);assert.equal(row.selectedCanvas,id);assert.equal(row.view.mode,'source');
      if(hardware) assert.match(row.adapter,hardware==='t4'?/NVIDIA.*T4/i:/Microsoft Basic Render Driver|WARP/i);
      await page.getByTestId('dicom-canvas').screenshot({path:path.join(dir,entry.name+'-pane.png')});
      await card.locator('canvas').first().screenshot({path:path.join(dir,entry.name+'-thumbnail.png')});
      report.cases.push({...row,name:entry.name});console.log(entry.name,row.frameWidth,row.frameCurve,row.rawPane,row.rawThumbnail);
    }
  } catch(error) {
    report.error=String(error?.stack??error);await page.screenshot({path:path.join(dir,'error.png')}).catch(()=>{});throw error;
  } finally {writeFileSync(path.join(dir,'capture.json'),JSON.stringify(report,null,2));await page.close();await site.close();}
}
mkdirSync(path.join(output,'sources'),{recursive:true});
const fixtures=cases.map(makeFile);
writeFileSync(path.join(output,'sources.json'),JSON.stringify(fixtures.map(({file,...other})=>({...other,file:path.basename(file)})),null,2));
const browser=await chromium.launch(hardware?{channel:'msedge',headless:false,args:['--enable-gpu',hardware==='t4'?'--use-angle=d3d11':'--use-angle=d3d11-warp']}: {});
try { for(const isolated of [true,false]) await observe(browser,fixtures,isolated); } finally {await browser.close();}
