import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createServer} from 'vite';
import {chromium} from 'playwright';
import {decodePng} from './lib/png.cjs';

const output=process.argv[2];
await mkdir(output,{recursive:true});
const server=await createServer({server:{host:'127.0.0.1',port:0}});
await server.listen();
const browser=await chromium.launch({channel:'msedge',headless:false,args:['--enable-gpu','--use-angle=d3d11','--disable-renderer-backgrounding','--disable-background-timer-throttling']});
const checks=[],samples=[],report={checks,samples};
try {
  const page=await browser.newPage({viewport:{width:640,height:640}});
  const url=new URL('tools/viewport-check.html',server.resolvedUrls.local[0]).href;
  const ready=async()=>{await page.goto(url);await page.waitForFunction(()=>document.querySelector('canvas[data-renderer]')?.dataset.slice==='16');};
  await ready();
  const before=await page.locator('canvas').first().getAttribute('data-renderer');
  assert.match(before,/NVIDIA.*T4/i);report.renderer=before;report.edge=browser.version();
  const cdp=await page.context().newCDPSession(page);
  const settle=()=>page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
  const state=()=>page.evaluate(()=>window.viewportTest.state());
  const check=(name,ok)=>{assert.ok(ok,name);checks.push(name);};
  await page.addStyleTag({content:'.sr-only{position:absolute;clip-path:inset(50%)}'});
  await page.evaluate(() => {
    const harness = window.viewportTest, [coronal, sagittal] = harness.referencePlanes;
    harness.reset(); harness.clear(); harness.setCrosshair([32, 32, 32]);
    harness.setOptions({ onRotateReference() {}, referencePlanes: [
      coronal, { ...sagittal, view: { ...sagittal.view, plane: 'sagittal', oblique: undefined, slice: 32 } },
    ] });
  });
  await settle();
  const middle = await page.getByTestId('annotation-overlay').evaluate(overlay => {
    const horizontal = overlay.querySelector('[data-reference-plane="reference-coronal"] path').getBoundingClientRect();
    const vertical = overlay.querySelector('[data-reference-plane="reference-oblique"] path').getBoundingClientRect();
    return { x: vertical.x + vertical.width / 2, y: horizontal.y + horizontal.height / 2, id: 1 };
  });
  const touch = (type, touchPoints) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
  const held = page.locator('[data-reference-plane] path[stroke-width="3"]');
  const initialPoint = (await state()).crosshair;
  await touch('touchStart', [middle]); await settle();
  check('One finger takes hold of the MPR crossing', await held.count() === 2);
  const second = { x: middle.x + 45, y: middle.y, id: 2 };
  await touch('touchStart', [second]);
  const moved = { ...second, x: second.x + 40 };
  await touch('touchMove', [moved]);
  await page.waitForFunction(() => window.viewportTest.state().view.zoom > 1.25);
  check('Pinching releases both MPR lines', await held.count() === 0);
  await touch('touchEnd', [moved]);
  await touch('touchMove', [{ ...middle, y: middle.y + 30 }]);
  await touch('touchEnd', []); await settle();
  check('The remaining finger leaves the MPR crosshair in place',
    JSON.stringify((await state()).crosshair) === JSON.stringify(initialPoint));
  await page.evaluate(() => window.viewportTest.setOptions({}));
  await ready();
  await page.addStyleTag({content:'.sr-only{position:absolute;clip-path:inset(50%)}'});
  await page.evaluate(()=>{
    const root=document.getElementById('root');
    Object.assign(root.style,{position:'absolute',left:'3px',top:'5px',width:'333px',height:'267px'});
    const series={...window.viewportTest.referencePlanes[0].series,id:'display-bars',dimensions:[64,64,1],canReconstruct:false};
    const volume={series,data:Uint8Array.from({length:64*64},(_,i)=>i%2?224:32)};
    window.viewportTest.clear();window.viewportTest.setGrid(1);
    window.viewportTest.setOptions({volume,showOverlay:false,hideMeasurements:true,crosshair:null});
    window.viewportTest.setView({mode:'source',plane:'axial',slice:0,zoom:1,pan:[0,0]});
  });
  for(const scale of [1.25,1.5]){
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:scale===1.25?640:641,height:480,deviceScaleFactor:scale,mobile:false});
    await page.waitForFunction(scale=>{
      const c=document.querySelector('canvas[data-series-id="display-bars"]');
      return c && c.width===Math.round(c.getBoundingClientRect().width*scale);
    },scale);
    await settle();
    const pane = await page.getByTestId('dicom-viewport').boundingBox();
    const fit = Math.min(pane.width, pane.height) * scale / 64;
    const midpoint = (pane.x + pane.width / 2) * scale;
    const y = Math.round((pane.y + pane.height / 2) * scale);
    const start = Math.round(midpoint) - 16, count = 32;
    for (const magnification of [1, fit]) {
      const native = magnification === 1;
      const centre = native ? Math.round(midpoint) : midpoint;
      const frames = await page.evaluate(({ zoom, pan }) => {
        const before = window.viewportTest.state().frames;
        window.viewportTest.setView({ zoom, pan: [pan, 0] });
        return before;
      }, { zoom: magnification / fit, pan: (centre - midpoint) / scale });
      await page.waitForFunction(before => window.viewportTest.state().frames > before, frames);
      await settle();
      const bounds = await page.locator('canvas').boundingBox();
      const surface = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
      const shot = decodePng(Buffer.from(surface.data, 'base64'));
      const backing = await page.locator('canvas').evaluate((canvas, { x, y, count }) => {
        const rgba = canvas.getContext('2d').getImageData(x, y, count, 1).data;
        return Array.from({ length: count }, (_, i) => rgba[4 * i]);
      }, { x: start - Math.round(bounds.x * scale), y: y - Math.round(bounds.y * scale), count });
      const bar = x => x % 2 ? 224 : 32;
      const reference = backing.map((_, i) => {
        // The 64-column image is centred at source index 31.5; measure at the centre of each physical screen pixel.
        const x = 31.5 + (start + i + 0.5 - centre) / magnification;
        const left = Math.floor(x), fraction = x - left;
        return native ? bar(Math.round(x)) : Math.round(bar(left) * (1 - fraction) + bar(left + 1) * fraction);
      });
      const mode = native ? 'native' : 'magnified';
      await writeFile(path.join(output,mode+'-'+scale+'.png'),Buffer.from(surface.data,'base64'));
      samples.push({mode,scale,magnification,raw:backing,reference,screen:Array.from({length:count},(_,i)=>shot.data[(y*shot.width+start+i)*4])});
      check('Acquired ' + mode + ' bars match the source at ' + scale + 'x desktop scale',
        backing.every((value, i) => Math.abs(value - reference[i]) <= (native ? 0 : 1)));
      check('Desktop surface preserves every ' + mode + ' bar pixel at ' + scale + 'x',
        backing.every((value, i) => shot.data[(y * shot.width + start + i) * 4] === value));
    }
  }
  const after=await page.locator('canvas').first().getAttribute('data-renderer');
  assert.equal(after,before);
  report.passed=true;
} catch(error) {report.error=String(error?.stack??error);throw error;}
finally {
  await writeFile(path.join(output,'measurements.json'),JSON.stringify(report,null,2));
  await browser.close();
  await server.close();
}
