// End-to-end release check: synthetic fixture, fresh isolated profile, explicit consent.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {execFileSync} = require('node:child_process');
const { _electron: electron } = require('playwright');
const { ignoreOutsideInput } = require('./lib/outside-input.cjs');
(async () => {
  const [exe, fixture, result] = process.argv.slice(2);
  if (!exe || !fixture || !result) throw Error('Usage: check-resource-spikes.cjs <packaged-executable> <synthetic-ct-small> <result.json>');
  execFileSync(process.execPath, [path.join(__dirname, 'check-golden-study.mjs'), fixture]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'veacom-spike-'));
  let app;
  try {
    app = await electron.launch({executablePath:exe,args:[],env:{...process.env,VEACOM_USER_DATA:dir,VEACOM_TELEMETRY_ENVIRONMENT:'lab'},timeout:90000});
    const page = await app.firstWindow();
    // A click or key press from the computer would be recorded as use, or could answer the consent prompt.
    await ignoreOutsideInput(app);
    await page.getByTestId('usage-consent-share').waitFor();
    assert(!fs.existsSync(path.join(dir,'usage')), 'Usage exists before consent');
    // This run sends to the real collector: it must not count as real use.
    assert.equal((await page.evaluate(()=>window.veacom.usageStatus())).environment,'lab','Release check is not labelled lab');
    await page.getByTestId('usage-consent-share').click();
    await page.getByTestId('usage-consent').waitFor({state:'detached'});
    await app.evaluate(({dialog}, folder)=>{ dialog.showOpenDialog = async()=>({canceled:false,filePaths:[folder]}); },path.join(fixture,'S01'));
    await page.getByTestId('welcome-open-folder').click();
    await page.waitForFunction(()=>window.__VEACOM_TEST__?.state().fullVolumeLoaded,undefined,{timeout:90000});
    await page.waitForTimeout(2300); // establish pre-spike CPU and RSS
    const sampleCost=await app.evaluate(({app})=>{
      const samples=[];for(let i=0;i<12;i++){const start=performance.now(); app.getAppMetrics();samples.push(performance.now()-start);}
      return samples.sort((a,b)=>a-b)[6];
    });
    // Commit 320 MiB of disposable renderer memory and keep one renderer core busy.
    await page.evaluate(()=>{
      const bytes=new Uint8Array(320*1024*1024);
      for(let i=0;i<bytes.length;i+=4096) bytes[i]=17;
      const end=performance.now()+5000; let j=0;
      while(performance.now()<end) {j=(j+4096)%bytes.length;bytes[j]^=1;}
      return bytes[j];
    });
    await page.waitForTimeout(1550);
    await app.close(); app=null;
    const files=fs.readdirSync(path.join(dir,'usage')).filter(n=>n.endsWith('.jsonl'));
    const events=files.flatMap(n=>fs.readFileSync(path.join(dir,'usage',n),'utf8').trim().split('\n').map(JSON.parse));
    const first=events.find(e=>e.name==='ux.study.first_image'),roles=events.filter(e=>e.name==='perf.resources');
    assert(first,'missing synthetic first image');
    const asked=events.find(e=>e.attributes['veacom.action']==='welcome-open-folder');
    assert(asked?.attributes['veacom.changed']?.split(',').includes('dialog'),'Opening the native dialog was not reported as a change');
    const renderer=roles.find(e=>e.attributes['veacom.perf.role']==='renderer' && e.attributes['veacom.perf.signal']==='cpu-ram');
    assert(renderer,'missing controlled renderer CPU and RAM spike: '+JSON.stringify(roles.map(e=>e.attributes)));
    assert(roles.some(e=>e.attributes['veacom.perf.role']==='engine' && e.attributes['veacom.perf.ram_mib']>0),'missing engine sample');
    const proof={platform:process.platform,version:'0.1.0-beta.1',first:{trace:first.trace,span:first.span},renderer:{trace:renderer.trace,span:renderer.span,...renderer.attributes},roles:roles.map(e=>e.attributes['veacom.perf.role']),medianElectronPollMs:Number(sampleCost.toFixed(3))};
    fs.writeFileSync(result,JSON.stringify(proof,null,2)+'\n');
    console.log('PASS synthetic first image, engine counters and a real renderer CPU/RAM spike.');
  } finally {if(app) await app.close();fs.rmSync(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
