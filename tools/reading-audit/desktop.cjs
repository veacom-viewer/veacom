const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {createRequire} = require('node:module');
const {execFileSync} = require('node:child_process');
const assert = require('node:assert/strict');

const [repo, inputs, output] = process.argv.slice(2,5).map(s=>path.resolve(s));
const req=createRequire(path.join(repo,'package.json'));
const {_electron}=req('playwright');
const {ignoreOutsideInput}=req('./tools/lib/outside-input.cjs');
const {closeDesktop}=req('./tools/lib/close-desktop.cjs');
const {jpegjs, PNG}=req(path.join(path.dirname(req.resolve('playwright-core/package.json')),'lib/utilsBundle.js'));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const fresh=()=>fs.mkdtemp(path.join(os.tmpdir(),'veacom-reading-audit-'));
const tree=execFileSync('git',['-C',repo,'rev-parse','HEAD^{tree}'],{encoding:'utf8'}).trim();
async function launch(profile,study) {
    const app=await _electron.launch({executablePath:req('electron'),args:[repo,'--study',study,...(process.platform==='darwin'?['-ApplePersistenceIgnoreState','YES']:[])],
        env:{...process.env,VEACOM_USER_DATA:profile,VEACOM_TEST_MODE:'1',VEACOM_LOCALE:'en',VEACOM_TELEMETRY_CONSENT:'denied',VEACOM_TELEMETRY_ENVIRONMENT:'lab'},timeout:90000});
    try {
        const page=await app.firstWindow();await ignoreOutsideInput(app);
        await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1280,800));
        await page.waitForFunction(()=>document.querySelector('canvas[data-renderer]') && window.__VEACOM_TEST__?.state().dimensions?.[2]>1,undefined,{timeout:90000});
        return {app,page};
    } catch(error) {await closeDesktop(app);throw error;}
}
async function settle(page) {await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));}
async function setView(page,view) {
    await page.evaluate(view=>window.__VEACOM_TEST__.setView(view),view);
    if ('slice' in view) await page.waitForFunction(z=>Number(document.querySelector('canvas[data-renderer]')?.dataset.slice)===z,view.slice);
    await settle(page);
}
const study = name=>path.join(inputs,name);
const save = (name,data)=>fs.writeFile(path.join(output,name),JSON.stringify(data,null,2)+'\n');
module.exports={repo,inputs,output,req,fs,os,path,assert,sleep,fresh,tree,launch,closeDesktop,settle,setView,study,save,jpegjs,PNG};
