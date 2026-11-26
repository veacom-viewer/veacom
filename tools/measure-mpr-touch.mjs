import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';
const server = await createServer({server:{host:'127.0.0.1',port:0}});
await server.listen();
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-webgl','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try {
  const page=await browser.newPage({viewport:{width:640,height:640}});
  page.on('pageerror',e=>console.error(e.message));
  await page.goto(new URL('tools/viewport-check.html',server.resolvedUrls.local[0]).href);
  await page.waitForFunction(()=>document.querySelector('canvas')?.dataset.slice==='16');
  await page.evaluate(()=>{window.touchLog=[];for(const type of ['pointerdown','pointermove','pointerup','pointercancel']) document.addEventListener(type,e=>{if(e.pointerType==='touch') window.touchLog.push([type,e.pointerId,e.clientX,e.clientY,e.target.tagName]);},true);});
  const cdp=await page.context().newCDPSession(page);
  const state=()=>page.evaluate(()=>window.viewportTest.state());
  const settle=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const check=(name,ok)=>{console.log(name,ok);assert.ok(ok,name);};
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
  console.log('after first',middle,await held.count(),await page.evaluate(()=>({touch:window.touchLog,hit:document.elementFromPoint(325,325)?.outerHTML.slice(0,130),lines:[...document.querySelectorAll('[data-reference-plane] path')].map(p=>[p.getAttribute('d'),p.getBoundingClientRect().toJSON()]),box:document.querySelector('svg').getBoundingClientRect().toJSON(),view:window.viewportTest.state()})));
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
  console.log('event sequence',await page.evaluate(()=>window.touchLog));
} finally { await browser.close(); await server.close(); }
