import assert from 'node:assert/strict';
import { launchHarness } from './harness-browser.mjs';

// VEACOM_BROWSER_ARGS adds browser switches, e.g. --disable-gpu to run the pixel checks on software WebGL.
const {page,close}=await launchHarness();
await page.addInitScript(()=>{window.viewportWindowErrors=[];window.addEventListener('error',event=>window.viewportWindowErrors.push(event.message));});
// The wheel notches the page received, as Chromium counts them (wheelDeltaY, 120 a notch). One Playwright mouse.wheel is
// one notch in Chrome but two in VEAcom's Electron on a 2× screen, where Playwright lays the page out at 1× while the
// input is scaled 2×: the checks expect a slice per notch received.
await page.addInitScript(()=>{window.wheelNotches=0;window.addEventListener('wheel',event=>{window.wheelNotches+=Math.abs(event.wheelDeltaY)/120;},{capture:true,passive:true});});
const errors=[];
page.on('pageerror',error=>errors.push(error.message));
const results=[];
const check=(name,condition)=>{assert.ok(condition,name);results.push(name);};
const state=()=>page.evaluate(()=>window.viewportTest.state());
const settle=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
const notches=()=>page.evaluate(()=>window.wheelNotches);
const tool=async name=>{await page.evaluate(name=>window.viewportTest.setTool(name),name);await settle();};
const drag=async (from,to,button='left')=>{await page.mouse.move(...from);await page.mouse.down({button});await page.mouse.move(...to,{steps:8});await page.mouse.up({button});await settle();};
try {
  const base=process.env.VEACOM_TEST_URL??'http://127.0.0.1:5188/tools/viewport-check.html';
  if(process.env.VEACOM_SKIP_GPU_CHECKS!=='1'){
    await page.goto(new URL('renderer-check.html',base).href);
    await page.waitForFunction(()=>window.rendererCheckResult);
    const gpu=await page.evaluate(()=>window.rendererCheckResult);
    assert.ok(gpu.passed,JSON.stringify(gpu.failures??gpu));
    check(`${gpu.checks} exact GPU shader and pixel checks on ${gpu.renderer.renderer}`,gpu.passed);
  }
  await page.goto(base);
  await page.waitForFunction(()=>document.querySelector('canvas')?.dataset.slice==='16');
  check('GPU image rendered',await page.locator('canvas').getAttribute('data-renderer'));
  await settle();
  const firstFrame = (await state()).frames;
  await tool('pan');
  await page.mouse.move(320, 320); await settle();
  await tool('scroll');
  check('Changing tools and hovering preserves the painted slice', (await state()).frames === firstFrame);
  // This axial stack is stored from the feet up, so down the page (wheel, ↓) goes to lower slice indices, as in
  // VEAcom 1.x (src/imaging/paging.ts).
  // The first wheel after a load can take more than two frames to reach the view (in Electron especially): wait for
  // the slice to change, then check where it went.
  await page.mouse.move(320,320);await settle();const firstNotches=await notches();await page.mouse.wheel(0,100);
  await page.waitForFunction(()=>window.viewportTest.state().view.slice!==16,undefined,{timeout:5000}).catch(()=>{});await settle();
  const firstWheel=await notches()-firstNotches;
  check('Wheel changes slice, one slice a notch',firstWheel>=1&&(await state()).view.slice===16-firstWheel);
  await page.locator('[data-testid="dicom-viewport"]').press('ArrowDown');await settle();
  const slice = (await state()).view.slice;
  check('Keyboard changes one slice', slice === 16 - firstWheel - 1);
  const canvasSlice = await page.locator('canvas').getAttribute('data-slice');
  const overlaySlice = await page.getByTestId('annotation-overlay').getAttribute('data-slice');
  check('Export canvas and annotation overlay show the current slice', canvasSlice === String(slice) && overlaySlice === canvasSlice);
  await tool('window');await drag([280,280],[330,300]);
  check('Window drag right widens and drag down lowers level',(await state()).view.windowWidth>256&&(await state()).view.windowCenter<128);
  await drag([300,300],[300,260],'right');check('Right drag zooms',(await state()).view.zoom>1);
  await drag([300,300],[330,320],'middle');check('Middle drag pans',(await state()).view.pan[0]!==0);
  await page.mouse.dblclick(320,320);await settle();check('Double click resets view',(await state()).view.zoom===1&&(await state()).view.pan[0]===0);
  await tool('length');await drag([200,250],[300,250]);
  check('Length stored in patient coordinates',Math.abs((await state()).annotations[0].points[1][0]-(await state()).annotations[0].points[0][0]-10)<1e-6);
  check('Length label uses calibrated millimetres',(await page.locator('[data-annotation-id]').textContent()).includes('10.0 mm'));
  // Each tool draws on an empty slice: a press on a measurement's handle or line takes hold of that measurement
  // instead (as in VEAcom Next), and these shapes start where the previous one did.
  const empty=async()=>{await page.evaluate(()=>window.viewportTest.clear());await settle();};
  for(const name of ['rectangle','ellipse','arrow']){await empty();await tool(name);await drag([220,220],[340,330]);check(`${name} commits`,(await state()).annotations.at(-1).type===name);
    if(name==='ellipse')check('Ellipse stores four patient-space corners',(await state()).annotations.at(-1).points.length===4);}
  for(const [name,points] of [['angle',[[200,200],[300,300],[400,200]]],['cobb',[[200,200],[300,200],[200,300],[300,400]]],['polygon',[[200,200],[350,200],[350,350],[200,350]]],['polyline',[[200,200],[250,250],[350,250]]]]){
    await empty();await tool(name);for(const point of points){await page.mouse.click(...point);await settle();}if(name==='polygon'||name==='polyline'){await page.keyboard.press('Enter');await settle();}
    check(`${name} multi-click commits`,(await state()).annotations.at(-1).type===name);
  }
  await empty();await tool('polygon');await page.mouse.move(230,230);await page.mouse.down();
  for(const point of [[320,210],[360,270],[320,340],[230,310],[230,230]])await page.mouse.move(...point,{steps:6});
  await page.mouse.up();await settle();
  check('Freehand closed ROI commits on release',(await state()).annotations.at(-1).type==='polygon'&&(await state()).annotations.at(-1).points.length>=5);
  await empty();await tool('probe');await page.mouse.click(400,300);await settle();check('Probe commits quantitative sample',(await state()).annotations.at(-1).type==='probe');
  await empty();await tool('text');await page.mouse.click(400,350);await page.getByTestId('annotation-text-input').fill('Target');await page.getByTestId('annotation-text-add').click();await settle();
  check('Text label commits',(await state()).annotations.at(-1).label==='Target');
  const countBeforeHiding=(await state()).annotations.length;
  // Corner lines that name the patient are marked data-identity; each line repeats its full text in a <title>.
  const identityLines=()=>page.locator('[data-testid="patient-overlay"] [data-identity]').count();
  const cornerTexts=()=>page.getByTestId('patient-overlay').evaluate(group=>[...group.querySelectorAll('text')].map(text=>[...text.childNodes].filter(node=>node.nodeName!=='title').map(node=>node.textContent).join('')));
  const namedBefore=await identityLines();
  await page.evaluate(()=>window.viewportTest.setOptions({hidePatientData:true}));await settle();
  check('Patient-data toggle hides identifying overlay values',namedBefore>0&&await identityLines()===0&&JSON.stringify(await cornerTexts())==='["CT"]');
  await page.evaluate(()=>window.viewportTest.setOptions({showOverlay:false,hideMeasurements:true}));await settle();
  check('Overlay and measurement toggles hide visible layers',await page.getByTestId('patient-overlay').count()===0&&await page.getByTestId('image-overlay').count()===0&&await page.locator('[data-annotation-id]').count()===0);
  check('Hiding measurements preserves their data',(await state()).annotations.length===countBeforeHiding);
  await page.evaluate(()=>window.viewportTest.setOptions({}));await settle();
  await tool('crosshair');await drag([300,300],[320,350]);check('Linked point is in patient space',(await state()).crosshair.length===3);
  await page.evaluate(()=>window.viewportTest.setView({plane:'coronal',slice:32}));await settle();
  check('Coronal MPR renders',await page.locator('canvas').getAttribute('data-plane')==='coronal');
  await page.evaluate(()=>window.viewportTest.setView({oblique:[15,10]}));await settle();check('Oblique MPR renders without errors',await page.locator('[role="alert"]').count()===0);
  await page.evaluate(()=>{window.viewportTest.reset();window.viewportTest.clear();window.viewportTest.setOptions({referencePlanes:window.viewportTest.referencePlanes});});await settle();
  // A plane facing the way the view does (a tilted axial on an axial view) marks nothing, as in VEAcom 1.x.
  const referenceIds=await page.locator('[data-reference-plane]').evaluateAll(lines=>lines.map(line=>line.dataset.referencePlane).sort());
  check('Orthogonal and oblique patient-plane reference lines; none for a plane facing the same way',JSON.stringify(referenceIds)==='["reference-coronal","reference-oblique"]');
  await page.evaluate(()=>window.viewportTest.setOptions({mouseBindings:{left:'pan',right:'window'},touchpadSpeed:2,reverseWheel:true}));await settle();
  await drag([300,300],[330,320]);check('User mouse binding overrides active tool',(await state()).view.pan[0]===30);
  await drag([300,300],[330,320],'right');check('Right button can control window level',(await state()).view.windowWidth>256);
  // A notch pages one slice at any touchpad speed, the other way when reversed.
  const beforeWheel=(await state()).view.slice,notchesBefore=await notches();await page.mouse.wheel(0,100);await settle();
  const notchesReceived=await notches()-notchesBefore;
  check('Wheel direction setting; a notch pages one slice at any touchpad speed',notchesReceived>=1&&(await state()).view.slice===beforeWheel+notchesReceived);
  // A touchpad's swipe pages by its pixels at the touchpad speed: 80 px through Windows' wheel messages (1.2 legacy units a
  // pixel) are five slices at the normal speed (16 px a slice) and ten at 2×, the way the notch went.
  const beforeSwipe=(await state()).view.slice;
  await page.evaluate(async()=>{const canvas=document.querySelector('canvas'),box=canvas.getBoundingClientRect();for(let part=0;part<4;part++){canvas.dispatchEvent(new WheelEvent('wheel',{deltaY:20,wheelDeltaY:-24,clientX:box.x+box.width/2,clientY:box.y+box.height/2,bubbles:true,cancelable:true}));await new Promise(resolve=>setTimeout(resolve,8));}});await settle();
  check('Touchpad speed setting pages a swipe',(await state()).view.slice===beforeSwipe+10);
  await page.evaluate(()=>{window.viewportTest.setOptions({});window.viewportTest.reset();});await settle();
  const cdp=await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:250,y:300,id:1},{x:350,y:300,id:2}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:210,y:320,id:1},{x:410,y:320,id:2}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await settle();
  check('Two-finger touch gesture zooms and pans',Math.abs((await state()).view.zoom-2)<0.01&&(await state()).view.pan[1]!==0);
  await page.evaluate(()=>{window.viewportTest.clear();window.viewportTest.reset();window.viewportTest.setGrid(5);});await settle();
  await page.waitForFunction(()=>document.querySelectorAll('canvas[data-renderer]').length===25);
  check('5×5 grid renders all25 viewports',await page.locator('canvas[data-renderer]').count()===25);
  for(const width of [780,900,640]){await page.setViewportSize({width,height:640});await settle();}
  check('Layout resize has no observer loop errors',(await page.evaluate(()=>window.viewportWindowErrors)).length===0);
  check('No runtime or GPU errors',errors.length===0&&await page.locator('[role="alert"]').count()===0);
  console.log(JSON.stringify({passed:true,checks:results.length,renderer:await page.locator('canvas').first().getAttribute('data-renderer'),results},null,2));
}finally{await close();}
