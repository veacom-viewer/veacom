import assert from 'node:assert/strict';
import { launchHarness } from './harness-browser.mjs';

const {page,close}=await launchHarness(), errors=[], checks=[];
page.on('pageerror',error=>errors.push(error.message));
const settle=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
const state=()=>page.evaluate(()=>window.viewportTest.state());
const check=(name,condition)=>{assert.ok(condition,name);checks.push(name);};
const capture=()=>page.evaluate(()=>document.querySelector('[data-testid="dicom-viewport"]').hasPointerCapture(window.lastPointer));
async function prepare(tool='rectangle',mode='source'){
  await page.evaluate(({tool,mode})=>{const h=window.viewportTest;h.restoreVolume();h.clear();h.setTool(tool);h.reset();h.setView({mode,slice:16,plane:'axial',oblique:undefined});},{tool,mode});await settle();
}
async function begin(){await page.mouse.move(200,200);await page.mouse.down();await page.mouse.move(250,250,{steps:3});await settle();assert.equal(await capture(),true);}
async function finish(){await page.mouse.move(300,300,{steps:3});await page.mouse.up();await settle();}
try{
  await page.goto(process.env.VEACOM_TEST_URL??'http://127.0.0.1:5188/tools/viewport-check.html');
  await page.waitForFunction(()=>document.querySelector('canvas')?.dataset.slice==='16');
  await page.evaluate(()=>document.addEventListener('pointerdown',event=>window.lastPointer=event.pointerId,true));
  for(const [name,mode,change] of [
    ['frame','source',()=>window.viewportTest.setView({slice:17})],
    ['series','source',()=>window.viewportTest.setSeriesId('other-series')],
    ['mode','source',()=>window.viewportTest.setView({mode:'mpr'})],
    ['plane','mpr',()=>window.viewportTest.setView({plane:'coronal'})],
    ['oblique','mpr',()=>window.viewportTest.setView({oblique:[15,0]})],
  ]){
    await prepare('rectangle',mode);await begin();await page.evaluate(change);await settle();
    check(`${name} change releases pointer capture`,!await capture());await finish();
    check(`${name} change cancels the unfinished ROI`,(await state()).annotations.length===0);
  }
  await prepare('length');await begin();await page.keyboard.press('ArrowDown');await settle();await finish();
  check('Arrow paging cancels a held length gesture',(await state()).annotations.length===0&&(await state()).view.slice!==16);
  await prepare('text');await page.mouse.click(200,200);await page.getByTestId('annotation-text-input').fill('Old frame');
  await page.evaluate(()=>window.viewportTest.setView({slice:17}));await settle();
  check('Frame changes close an unfinished text prompt',await page.getByTestId('annotation-text-input').count()===0&&(await state()).annotations.length===0);
  await prepare();await page.evaluate(()=>window.viewportTest.setFrameBuffer(16));await settle();await begin();
  await page.evaluate(()=>window.viewportTest.setView({slice:17}));await settle();
  check('Requested frame changes cancel drawing while old pixels are held',!await capture());
  await page.evaluate(()=>window.viewportTest.setFrameBuffer(17));await settle();await finish();
  check('Late frame delivery cannot revive a cancelled drawing',(await state()).annotations.length===0);
  await prepare();await page.evaluate(()=>window.viewportTest.setFrameBuffer(16));await settle();await begin();
  await page.evaluate(()=>window.viewportTest.restoreVolume());await settle();check('Same-frame preview replacement keeps a valid gesture',await capture());await finish();
  check('Same-frame gesture commits to its source frame',(await state()).annotations.length===1&&(await state()).annotations[0].sourceFrame===16);
  await prepare('scroll');await page.mouse.move(200,200);await page.mouse.down();await page.mouse.move(200,220,{steps:8});await settle();await page.mouse.move(200,240,{steps:8});await settle();
  check('Normal scroll dragging survives its own frame changes',await capture()&&Math.abs((await state()).view.slice-16)===8);await page.mouse.up();
  await prepare('window');await page.mouse.move(200,200);await page.mouse.down();await page.mouse.move(240,220,{steps:8});await settle();await page.mouse.move(260,240,{steps:8});await settle();
  check('Window-level dragging survives its own window changes',await capture()&&(await state()).view.windowWidth>256&&(await state()).view.windowCenter<128);await page.mouse.up();
  check('No runtime rendering errors',errors.length===0&&await page.locator('[role="alert"]').count()===0);
  console.log(JSON.stringify({passed:true,count:checks.length,checks},null,2));
}finally{await close();}
