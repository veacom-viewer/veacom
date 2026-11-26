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
  const dir = path.join(output,isolated?'threaded':'single'); mkdirSync(dir,{recursive:true});
  const page = await browser.newPage({viewport:{width:1250,height:800},deviceScaleFactor:1, permissions:['clipboard-read','clipboard-write'],
    ...(!hardware ? {recordVideo:{dir:path.join(output,'recording'),size:{width:1250,height:800}}} : {})});
  const video = page.video();
  const report = { isolated, cases:[] };
  try {
    await page.goto(site.url);
    const open = page.waitForEvent('filechooser'); await page.getByTestId('welcome-open-files').click();
    await (await open).setFiles(fixtures.map(s=>s.file));
    await page.waitForFunction(n=>window.__VEACOM_TEST__?.state().series.length===n, fixtures.length);
    const language=isolated?'en':'tr';
    for(const choice of [isolated?'tr':'en',language]) {
      await page.getByTestId('tool-language').click();
      await page.getByTestId('language-'+choice).click();
    }
    assert.equal(await page.locator('html').getAttribute('lang'),language);
    report.language=language;
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
        const sop=frame.headers.get('X-SOP-Instance-UID'), sourceValues=[];
        for(let i=0;i<9;i++){
          const x=i*16+8,y=Math.floor(size*.58);
          const stats=await bridge.measure(id,generation,s.sourceRevision,{kind:'sourceRegion',frame:{index:0,sopInstanceUid:sop},shape:'rectangle',points:[[x-1,y-1,0],[x+1,y+1,0]],pixelUnits:false});
          if(!Number.isFinite(stats.min)||stats.min!==stats.max)throw new Error('The source band is not constant.');
          sourceValues.push(stats.min);
        }
        const pixels=document.querySelector('[data-testid="dicom-canvas"]');
        const view=window.__VEACOM_TEST__.state().displayedView;
        const thumbnail=document.querySelector('[data-testid="series-'+id+'"] canvas');
        const bands=canvas=>{
          const side=Math.min(canvas.width,canvas.height),context=canvas.getContext('2d');
          return Array.from({length:9},(_,i)=>context.getImageData(Math.floor(canvas.width/2+side*((i+.5)/9-.5)),Math.floor(canvas.height/2+.08*side),1,1).data[0]);
        };
        return {uid:s.uid,sop:frame.headers.get('X-SOP-Instance-UID'),kind,frameWidth:meta.windowWidth,frameCenter:meta.windowCenter,frameCurve:meta.voiFunction,
          volumeWidth:s.windowWidth,volumeCenter:s.windowCenter,selectedCanvas:pixels.dataset.seriesId,view,adapter:pixels.dataset.renderer,threads:Number(document.documentElement.dataset.engineThreads),
          sourceValues,rawPane:bands(pixels),rawThumbnail:bands(thumbnail),
          overlay:document.querySelector('[data-testid="image-overlay"]').textContent,canvas:[pixels.width,pixels.height],thumbnail:[thumbnail.width,thumbnail.height]};
      },{id,size});
      assert.equal(row.sop,entry.sop);assert.equal(row.selectedCanvas,id);assert.equal(row.view.mode,'source');
      if(hardware) assert.match(row.adapter,hardware==='t4'?/NVIDIA.*T4/i:/Microsoft Basic Render Driver|WARP/i);
      await page.getByTestId('dicom-canvas').screenshot({path:path.join(dir,entry.name+'-pane.png')});
      await card.locator('canvas').first().screenshot({path:path.join(dir,entry.name+'-thumbnail.png')});
      report.cases.push({...row,name:entry.name});console.log(entry.name,row.frameWidth,row.frameCurve,row.rawPane,row.rawThumbnail);
    }
    if(!hardware) {
      const sel=catalog.find(s=>s.name==='exact-narrow');
      await page.getByTestId('series-'+sel.id).click();
      await page.waitForFunction(id=>document.querySelector('[data-testid="dicom-canvas"]')?.dataset.seriesId===id,sel.id);
      if(!await page.locator('.inspector').isVisible())await page.getByTestId('tool-inspector').click();
      await page.getByTestId('inspector-tab-display').click();
      const width=page.locator('[data-action="window-width-input"]'),level=page.locator('[data-action="window-level-input"]');
      const pane=page.getByTestId('dicom-viewport').first();
      const inspect=async key=>{
        await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
        const state=await page.evaluate(()=>{
          const canvas=document.querySelector('[data-testid="dicom-canvas"]'), overlay=document.querySelector('[data-testid="image-overlay"]');
          const c=canvas.getBoundingClientRect(), v=canvas.closest('.viewport-cell').getBoundingClientRect();
          return {view:window.__VEACOM_TEST__.state().displayedView,overlay:overlay.textContent,
            paneInCopy:[c.x-v.x,c.y-v.y,c.width,c.height], paneOnScreen:[c.x,c.y,c.width,c.height]};
        });
        await page.screenshot({path:path.join(dir,'manual-'+key+'.png')});
        return {...state,widthInput:await width.inputValue(),levelInput:await level.inputValue()};
      };
      report.manual={before:await inspect('before')};
      await width.fill(''); await width.pressSequentially('0.0625'); await width.press('Tab');
      await level.fill('0.484375'); await level.press('Tab');
      report.manual.typed=await inspect('typed');
      await pane.focus();await page.evaluate(()=>navigator.clipboard.writeText('Synthetic grayscale test'));await page.keyboard.press('Control+c');
      const copied=await page.evaluate(async()=>{
        const expires=performance.now()+6000;
        while(performance.now()<expires){
          const item=(await navigator.clipboard.read()).find(x=>x.types.includes('image/png'));
          if(item){
            const blob=await item.getType('image/png');
            return await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result.split(',')[1]);r.onerror=()=>reject(r.error);r.readAsDataURL(blob);});
          }
          await new Promise(r=>setTimeout(r,50));
        }
        throw new Error('Copy did not write a PNG');
      });
      writeFileSync(path.join(dir,'manual-copy.png'),Buffer.from(copied,'base64'));
      await pane.focus();await page.keyboard.press('w');
      const box=await pane.boundingBox(),x=box.x+box.width*.55,y=box.y+box.height*.61;
      await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+30,y,{steps:4});await page.mouse.up();
      report.manual.dragged=await inspect('dragged');
      await page.getByTestId('tool-window-presets').click();await page.getByTestId('preset-dicom').click();
      report.manual.restored=await inspect('restored');
      const fieldValues=async()=>({width:await width.inputValue(),level:await level.inputValue()});
      for(const [name,key] of [['exact-narrow','curved'],['linear-control','linear']]) {
        await page.getByTestId('series-'+catalog.find(s=>s.name===name).id).click();
        const initial=await fieldValues();
        await width.focus();await width.press('ArrowUp');const up=await fieldValues();
        await width.press('ArrowDown');const down=await fieldValues();
        report.manual[key+'Arrows']={initial,up,down};
      }
    }
  } catch(error) {
    report.error=String(error?.stack??error);await page.screenshot({path:path.join(dir,'error.png')}).catch(()=>{});throw error;
  } finally {
    writeFileSync(path.join(dir,'capture.json'),JSON.stringify(report,null,2));
    await page.close();
    if(video){await video.saveAs(path.join(dir,'window-controls.webm'));await video.delete();}
    await site.close();
  }
}
mkdirSync(path.join(output,'sources'),{recursive:true});
const fixtures=cases.map(makeFile);
writeFileSync(path.join(output,'sources.json'),JSON.stringify(fixtures.map(({file,...other})=>({...other,file:path.basename(file)})),null,2));
const browser=await chromium.launch(hardware?{channel:'msedge',headless:false,args:['--enable-gpu',hardware==='t4'?'--use-angle=d3d11':'--use-angle=d3d11-warp']}: {});
try { for(const isolated of [true,false]) await observe(browser,fixtures,isolated); } finally {await browser.close();}
