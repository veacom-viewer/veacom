// Run on macOS or Windows, with an optional packaged executable as the first argument.
const { mkdtemp, rm } = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { ignoreOutsideInput, launchDesktop } = require('./lib/outside-input.cjs');

async function check() {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'veacom-surface-'));
  const executable = process.argv[2];
  let app;
  try {
    app = await launchDesktop({ ...(executable ? { executablePath: executable, args: [] } : {args:[path.resolve(__dirname,'..')]}),
      env:{...process.env,VEACOM_TEST_MODE:'1',VEACOM_TELEMETRY_CONSENT:'denied',VEACOM_USER_DATA:profile}, timeout:90000 });
    const page = await app.firstWindow();
    await ignoreOutsideInput(app);
    page.on('console', log => { if (log.type()==='error') console.error(log.text()); });
    await page.waitForFunction(()=>window.veacom);
    const target='test-native-texture';
    await page.evaluate(target=>{
      const canvas=document.createElement('canvas');
      canvas.id=target;
      canvas.style.cssText='position:fixed;left:0;top:0;z-index:2147483647';
      document.body.append(canvas);
    },target);
    const draw=(revision,width,height,bitmap=false)=>app.evaluate(({app}, args)=>app.__VEACOM_PRIVILEGED_TEST__.renderPattern(...args),[target,revision,width,height,bitmap]);
    let last;
    for (let revision=1;revision<=24;revision++) {
      const width=revision%2 ? 192 : 256, height=revision%3 ? 128 : 96;
      await page.evaluate(([target,revision,width,height])=>{
        const c=document.getElementById(target); c.width=width; c.height=height; c.dataset.nativeRevision=String(revision);
      },[target,revision,width,height]);
      last=await draw(revision,width,height);
      await page.waitForFunction(([target,revision])=>document.getElementById(target).dataset.nativePresented===String(revision),[target,revision],{timeout:5000});
      const samples=await page.evaluate(target=>{
        const ctx=document.getElementById(target).getContext('2d');
        const rgb=(x,y)=>Array.from(ctx.getImageData(x,y,1,1).data).slice(0,3);
        return {red:rgb(1,33),green:rgb(17,33),bit:rgb(1,1)};
      },target);
      assert(samples.red[0]>220 && samples.red[1]<30 && samples.green[1]>220 && samples.green[0]<30, JSON.stringify(samples));
      assert.equal(samples.bit[0]>127,Boolean(last.lease&1));
    }
    const before=await page.locator('#'+target).getAttribute('data-native-presented');
    await draw(0,256,96);
    assert.equal(await page.locator('#'+target).getAttribute('data-native-presented'),before);
    const observed=await app.evaluate(async ({BrowserWindow})=>{
      const win=BrowserWindow.getAllWindows()[0];
      const capture=await win.webContents.capturePage({x:0,y:0,width:64,height:64});
      const {width,height}=capture.getSize();
      const bitmap=capture.toBitmap(), i=4*(Math.floor(33*height/64)*width+Math.floor(width/64));
      return [...bitmap.subarray(i,i+4)];
    });
    assert(observed[2]>200 && observed[1]<50 && observed[0]<50, 'Composited checkerboard: '+observed);
    const transport = last.transport;
    assert(['shared','bitmap'].includes(transport));
    const expectedTransport = process.argv[3] ?? process.env.VEACOM_EXPECT_NATIVE_TRANSPORT;
    if (expectedTransport) assert.equal(transport, expectedTransport);
    console.log('PASS 24 resized Rust frames, frame numbers, stale frame disposal and compositor capture', transport, last.adapter);
    await page.locator('#'+target).evaluate(canvas => { canvas.width=193; canvas.height=97; canvas.dataset.nativeRevision='25'; });
    const bitmap = await draw(25,193,97,true);
    const sample = await page.locator('#'+target).evaluate(canvas => [...canvas.getContext('2d').getImageData(17,33,1,1).data]);
    assert.equal(bitmap.transport,'bitmap'); assert(sample[1]>220 && sample[0]<30, 'RGBA row padding or channel order changed');
    console.log('PASS padded GPU readback and RGBA presentation');

    if (transport === 'shared') {
      await app.evaluate(({sharedTexture}) => {
        const original = sharedTexture.importSharedTexture.bind(sharedTexture);
        sharedTexture.importSharedTexture = (...args) => {
          sharedTexture.importSharedTexture = original;
          throw new Error('Injected shared texture import failure');
        };
      });
      for (const revision of [26, 27]) {
        await page.locator('#'+target).evaluate((canvas, stamp) => { canvas.dataset.nativeRevision = String(stamp); }, revision);
        assert.equal((await draw(revision,193,97)).transport, 'bitmap');
        const pixel = await page.locator('#'+target).evaluate(canvas => [...canvas.getContext('2d').getImageData(17,33,1,1).data]);
        assert(pixel[1] > 220 && pixel[0] < 30);
      }
      console.log('PASS compositor import failure recovers through bitmap on this engine generation');
    }

  } finally {
    if(app) await app.close();
    await rm(profile,{recursive:true,force:true});
  }
}
check().catch(error=>{console.error(error);process.exitCode=1;});
