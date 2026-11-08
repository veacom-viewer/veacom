const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { temporaryExportFolder } = require('./lib/export-folder.cjs');
const { ignoreOutsideInput, launchDesktop } = require('./lib/outside-input.cjs');

async function main() {
  const repo = path.resolve(__dirname, '..');
  const study = path.resolve(process.argv[2]);
  const output = path.resolve(process.argv[3]);
  await fs.mkdir(output, { recursive:true });
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(),'veacom-security-'));
  const chosen = path.join(temporary,'chosen-export'), forbidden = path.join(temporary,'unselected-export');
  await fs.mkdir(chosen);
  // A wrong turn to the remembered export folder fails below without writing onto the real Desktop.
  await temporaryExportFolder(path.join(temporary,'settings'));
  const env = { ...process.env, VEACOM_USER_DATA:path.join(temporary,'settings') };
  delete env.VEACOM_TEST_MODE;
  const desktop = await launchDesktop({ args:[repo,'--study',study], env, timeout:90000 });
  const checks=[],errors=[]; let page;
  const check=(name,detail)=>{checks.push({name,passed:true,detail});console.log(`PASS ${name}`);};
  // A step that waits on another window fails with its reason instead of waiting for ever.
  const within=(promise,ms,reason)=>{let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(reason)),ms);})]).finally(()=>clearTimeout(timer));};
  try {
    page=await desktop.firstWindow();page.on('pageerror',error=>errors.push(error.message));
    // The import window opens after any click or key press in the application window (electron/import-view.cjs), so one
    // from the person at the machine would let the unprompted request below open it, and the check would wait on a
    // window nobody closes. So, except on Windows, the window takes no real mouse or keyboard input (tools/lib/outside-input.cjs).
    await ignoreOutsideInput(desktop);
    await page.waitForFunction(()=>window.__VEACOM_TEST__?.state().seriesReady,undefined,{timeout:90000});
    const state=await page.evaluate(()=>window.__VEACOM_TEST__.state());
    check('Authorized CLI study loads through opaque streamed pixels',state.dimensions);
    assert.equal(await desktop.evaluate(({app})=>Boolean(app.__VEACOM_PRIVILEGED_TEST__)),false);
    const bridge=await page.evaluate(()=>({core:typeof window.veacom.core,rawDrop:typeof window.veacom.getPathForFile,keys:Object.keys(window.veacom)}));
    assert.equal(bridge.core,'undefined');assert.equal(bridge.rawDrop,'undefined');
    assert.equal(JSON.stringify(await page.evaluate(()=>window.veacom.getCoreState())).includes('token'),false);
    check('Production renderer exposes neither core credentials nor privileged test grant',bridge.keys);
    const raw=await page.evaluate(async study=>{try{await window.veacom.importSelected([study]);return 'accepted';}catch(error){return error.message;}},study);
    assert.match(raw,/invalid|expired|selection/i);check('Raw renderer import paths are denied');
    // The import window runs in a view of its own (electron/import-view.cjs): this page can only open it.
    assert(!bridge.keys.some(key=>['browseFolder','browserPlaces','chooseImportPaths'].includes(key)));
    const seen=[];
    const importView=async()=>{const id=await desktop.evaluate(({webContents},seen)=>new Promise((resolve,reject)=>{const started=Date.now();const wait=setInterval(()=>{
      const view=webContents.getAllWebContents().find(item=>!seen.includes(item.id)&&!item.isDestroyed()&&item.getURL().startsWith('veacom://import/'));
      if(view&&!view.isLoading()){clearInterval(wait);resolve(view.id);}else if(Date.now()-started>15000){clearInterval(wait);reject(new Error('The import window did not open.'));}},20);}),seen);seen.push(id);return id;};
    const run=(id,script)=>desktop.evaluate(({webContents},[id,script])=>webContents.fromId(id).executeJavaScript(script),[id,script]);
    const inView=(id,script)=>within(run(id,script),15000,`The import window did not answer: ${script}`);
    // Main closes the window as it answers, so this call may never return.
    const lastInView=(id,script)=>{run(id,script).catch(()=>{});};
    // By then any click or key press, even one from before the window stopped taking real input, has aged out of the gate's 1.5 s.
    await new Promise(resolve=>setTimeout(resolve,1700));
    const unasked=await within(page.evaluate(()=>window.veacom.openImportWindow().then(()=>'opened',error=>error.message)),5000,
      'The import window opened without a click or key press from the check: input from the computer reached the application window, or its gate (electron/import-view.cjs) let the request through.')
      .catch(async error=>{
        await desktop.evaluate(({webContents})=>{for(const item of webContents.getAllWebContents())if(!item.isDestroyed()&&item.getURL().startsWith('veacom://import/'))item.executeJavaScript('window.veacomImport.close()').catch(()=>{});}).catch(()=>{});
        throw error;
      });
    assert.match(unasked,/click or key press/,`The page opened the import window without a click or key press (${unasked}).`);
    // As the user does: a key press in the application window, then the page asks. Gives the window shown and the page's
    // request, which is answered when that window closes.
    const userOpens=async()=>{
      await within(page.keyboard.press('Shift'),10000,'The check\'s key press did not reach the application window.');
      const request=page.evaluate(()=>window.veacom.openImportWindow());request.catch(()=>{});
      const view=await Promise.race([importView(),request.then(answer=>{throw new Error(`The import window did not open; the request was answered with ${JSON.stringify(answer)}.`);})]);
      return {view,request};
    };
    let {view,request:closing}=await userOpens();
    assert.equal(await inView(view,'typeof window.veacom'),'undefined');
    const listed=await inView(view,`window.veacomImport.browse(${JSON.stringify(path.dirname(study))}).then(folder=>folder.items.map(item=>item.path))`);
    assert(listed.includes(study));
    lastInView(view,'window.veacomImport.close()');
    assert.deepEqual(await within(closing,15000,'Closing the import window did not answer the request that opened it.'),[]);
    check('The application page cannot list folders, name import paths or open the import window unprompted; closing it grants nothing');
    let opening;({view,request:opening}=await userOpens());
    lastInView(view,`window.veacomImport.open([${JSON.stringify(study)}])`);
    const opened=await within(opening,30000,'Opening the study in the import window did not answer the request that opened it.');
    assert(opened.length&&opened.every(value=>value.startsWith('import:')&&!value.includes(study)));
    assert((await page.evaluate(caps=>window.veacom.importSelected(caps),opened)).series.length);
    assert.equal(await desktop.evaluate(({webContents})=>webContents.getAllWebContents().some(item=>item.getURL().startsWith('veacom://import/')&&!item.isDestroyed())),false);
    check('What the user opens in the import window reaches the application as one-use capabilities');
    const network=process.platform==='win32'?['\\\\127.0.0.1\\veacom-check']:process.platform==='darwin'?['/net/127.0.0.1','/NET/127.0.0.1']:[];
    if(network.length){
      let waiting;({view,request:waiting}=await userOpens());
      const refused=await inView(view,`Promise.all(${JSON.stringify(network)}.flatMap(path=>[window.veacomImport.browse(path),window.veacomImport.open([path])]).map(call=>call.then(()=>'accepted',error=>error.message)))`);
      assert.deepEqual(refused,network.flatMap(()=>['Invalid folder.','Invalid folder.']));
      lastInView(view,'window.veacomImport.close()');assert.deepEqual(await within(waiting,15000,'Closing the import window did not answer the request that opened it.'),[]);
      check('Network paths are refused in the import window before any connection',network);
    }
    const foreign=await within(desktop.evaluate(async({BrowserWindow},preload)=>{
      const other=new BrowserWindow({show:false,webPreferences:{preload,contextIsolation:true,nodeIntegration:false,sandbox:true}});
      try{await other.loadURL('data:text/html,<title>Untrusted frame</title>');return await other.webContents.executeJavaScript('window.veacomImport.browse("/").then(()=>"accepted",error=>error.message)');}
      finally{other.destroy();}
    },path.join(repo,'electron/import-preload.cjs')),20000,'A frame with the import window\'s preload did not answer.');
    assert.match(foreign,/Untrusted import frame/);check('Only the import window itself can reach the folder browser');
    const fake=await page.evaluate(async()=>{try{await window.veacom.importFiles([new File(['fake'],'invented.dcm')]);return 'accepted';}catch(error){return error.message;}});
    assert.notEqual(fake,'accepted');check('Synthetic File cannot grant filesystem access');
    await desktop.evaluate(({dialog},directory)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[directory]});},study);
    const capabilities=await page.evaluate(()=>window.veacom.openPaths('folder'));
    assert(capabilities.length);assert(capabilities.every(value=>value.startsWith('import:')&&!value.includes(study)));
    await page.evaluate(caps=>window.__VEACOM_TEST__.importPaths(caps),capabilities);
    await page.waitForFunction(()=>window.__VEACOM_TEST__.state().seriesReady);
    const reused=await page.evaluate(async caps=>{try{await window.veacom.importSelected(caps);return 'accepted';}catch(error){return error.message;}},capabilities);
    assert.notEqual(reused,'accepted');check('Native picker returns one-use import capabilities');
    const files=(await fs.readdir(study)).filter(name=>name.endsWith('.dcm'));
    await page.evaluate(()=>{const input=document.createElement('input');input.type='file';input.id='security-file';document.body.append(input);});
    await page.locator('#security-file').setInputFiles(path.join(study,files[0]));
    const dropped=await page.evaluate(()=>window.veacom.importFiles([...document.getElementById('security-file').files]));
    assert(dropped[0].startsWith('import:'));assert(!dropped[0].includes(study));
    const droppedCatalog=await page.evaluate(caps=>window.veacom.importSelected(caps),dropped);
    assert(droppedCatalog.series.length);check('OS-backed File grants a limited import capability');
    const catalog=await page.evaluate(()=>window.veacom.listSeries());
    const item=catalog.series[0];
    const badPixel=await page.evaluate(async item=>{try{await window.veacom.getPixels({seriesId:item.id,generation:item.engineGeneration,path:'/export'});return 'accepted';}catch(error){return error.message;}},item);
    assert.notEqual(badPixel,'accepted');
    const pixel=await page.evaluate(async item=>{
      const capability=await window.veacom.getPixels({seriesId:item.id,generation:item.engineGeneration,index:0});
      const response=await fetch(capability.url),bytes=await response.arrayBuffer();
      const replay=await fetch(capability.url);
      return {url:capability.url,bytes:bytes.byteLength,status:response.status,replay:replay.status,frame:response.headers.get('X-Source-Frame-Index')};
    },item);
    assert.equal(pixel.status,200);assert.equal(pixel.replay,404);assert.equal(pixel.frame,'0');assert(pixel.bytes>0);
    assert(!/127\.0\.0\.1|token/.test(pixel.url));check('Pixel capability is read-only, scoped and one-use',pixel);
    const untrusted=await within(desktop.evaluate(async({BrowserWindow},preload)=>{
      const other=new BrowserWindow({show:false,webPreferences:{preload,contextIsolation:true,nodeIntegration:false,sandbox:true}});
      try{await other.loadURL('data:text/html,<title>Untrusted frame</title>');return await other.webContents.executeJavaScript('window.veacom.listSeries().then(()=>"accepted",error=>error.message)');}
      finally{other.destroy();}
    },path.join(repo,'electron/preload.cjs')),20000,'A frame with the application\'s preload did not answer.');
    assert.match(untrusted,/Untrusted application frame/);check('A different browser frame cannot invoke the broker');
    await desktop.evaluate(({dialog},directory)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[directory]});},chosen);
    const exported=await page.evaluate(({item,directory})=>window.veacom.exportDicom(item.id,{anonymize:false,dicomdir:true,engineGeneration:item.engineGeneration,directory}),{item,directory:forbidden});
    assert(exported.directory.startsWith((await fs.realpath(chosen))+path.sep));
    await assert.rejects(fs.access(forbidden));check('Renderer-supplied export destination is ignored; native picker owns it');
    const blocked=await page.evaluate(async()=>{try{await fetch('http://127.0.0.1:1/series');return false;}catch{return true;}});
    assert(blocked);check('Production CSP blocks direct loopback access');
    assert.deepEqual(errors,[]);
    await page.screenshot({path:path.join(output,'secured-viewer.png')});
    await fs.writeFile(path.join(output,'results.json'),JSON.stringify({passed:true,checks,errors},null,2));
  }catch(error){await page?.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});await fs.writeFile(path.join(output,'results.json'),JSON.stringify({passed:false,error:error.stack,checks,errors},null,2));throw error;}
  finally{await desktop.close();await fs.rm(temporary,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
