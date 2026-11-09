// Runs only against the isolated synthetic profile it creates. --live explicitly sends these lab faults to VEAcom.
'use strict';
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { _electron: electron } = require('playwright');
const { ENDPOINT } = require('../electron/crash-reports.cjs');
const { validReport } = require('../electron/crash-schema.cjs');
const { createServer } = require('../telemetry/crashes/server.cjs');
const { ignoreOutsideInput } = require('./lib/outside-input.cjs');
const { closeDesktop } = require('./lib/close-desktop.cjs');
const root = path.resolve(__dirname,'..');
const sentinel = 'SYNTHETIC_PRIVATE_STUDY';
async function waitFor(read, description, timeout = 20000) {
  for (const until = Date.now() + timeout; Date.now() < until; ) {
    const value = await read(); if (value) return value;
    await delay(20);
  }
  throw new Error('Timed out waiting for ' + description);
}
function enginePid(parent) {
  let found;
  if (process.platform === 'win32') {
    const cmd = 'Get-CimInstance Win32_Process -Filter "ParentProcessId = ' + parent +
      ' AND Name = \'veacom-core.exe\'" | Select-Object -ExpandProperty ProcessId';
    found = execFileSync('powershell.exe',['-NoProfile','-Command',cmd],{encoding:'utf8'}).trim().split(/\s+/).filter(Boolean).map(Number);
  } else {
    found = execFileSync('ps',['-axo','pid=,ppid=,comm='],{encoding:'utf8'}).split('\n').flatMap(row=>{
      const m = row.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      return m && Number(m[2]) === parent && path.basename(m[3]) === 'veacom-core' ? [Number(m[1])] : [];
    });
  }
  assert.equal(found.length,1,'expected exactly one Rust engine belonging to the test viewer');
  return found[0];
}
async function listen(server) { server.listen(0,'127.0.0.1'); await once(server,'listening'); return 'http://127.0.0.1:' + server.address().port; }
async function main() {
  const out = process.argv[2], live = process.argv.includes('--live');
  if (!out || out.startsWith('--')) throw new Error('Usage: node tools/check-crash-reporting.cjs evidence.json [--live]');
  const executablePath = process.env.VEACOM_SMOKE_EXECUTABLE;
  if (executablePath && !live) throw new Error('A packaged executable uses the real intake; select --live explicitly.');
  if (live && !executablePath) throw new Error('--live requires VEACOM_SMOKE_EXECUTABLE pointing to a release package.');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(),'veacom-crash-check-'));
  const profile = path.join(temp,sentinel);
  fs.mkdirSync(profile); fs.writeFileSync(path.join(profile,'preferences.json'),JSON.stringify({usageConsent:'denied'}));
  const queue = path.join(profile,'crash-reports','queue.json');
  const events = new Map(), accepted = new Map();
  const usageControlId = randomBytes(16).toString('hex');
  const sample = () => {
    try { for (const r of JSON.parse(fs.readFileSync(queue,'utf8')).events) events.set(r.id,r); } catch { /* Before first launch. */ }
  };
  let usageRequests = 0;
  const usage = http.createServer((_req,res)=>{ usageRequests++; res.writeHead(200);res.end('{}'); });
  const intake = createServer({ storageUrl:'https://storage.invalid', getToken:async ()=>'local-test-token', fetchImpl:async (_url,options)=>{
    const trace = JSON.parse(options.body).resourceSpans[0].scopeSpans[0].spans[0];
    assert.ok(!options.body.includes(sentinel));
    accepted.set(trace.traceId,trace);
    await delay(50); // Give the independent observer time to read the on-disk queue.
    return Response.json({});
  } });
  let desktop, monitor;
  try {
    const usageUrl = await listen(usage);
    const endpoint = live ? ENDPOINT : await listen(intake) + '/v1/crashes';
    const env = {...process.env, VEACOM_USER_DATA:profile, VEACOM_TELEMETRY_ENDPOINT:usageUrl,
      VEACOM_TELEMETRY_TOKEN:'local-usage-test-token', VEACOM_TELEMETRY_CONSENT:'', VEACOM_CRASH_ENDPOINT:endpoint,
      VEACOM_CRASH_ENVIRONMENT:'lab', VEACOM_DEV_URL:'', VEACOM_TEST_MODE:'0', TMPDIR:temp, TMP:temp, TEMP:temp };
    // A live packaged check must exercise the binary inside the package.
    if (executablePath) delete env.VEACOM_CORE_PATH;
    async function launch() {
      desktop = await electron.launch({ cwd:root, executablePath:executablePath || require('electron'),
        args:[...(executablePath ? [] : [root]), ...(process.platform === 'darwin' ? ['-ApplePersistenceIgnoreState','YES'] : [])], env, timeout:60000 });
      const page = await desktop.firstWindow({timeout:90000}); await ignoreOutsideInput(desktop);
      await page.waitForFunction(async()=>(await window.veacom?.getCoreState())?.status === 'ready');
      const status = await page.evaluate(()=>window.veacom.usageStatus());
      assert.equal(status.consent,'denied'); assert.equal(status.sending,false);
      return page;
    }
    const page = await launch();
    // The release ignores environment collector overrides. Check the packaged configuration without exposing
    // its token, and try a real, valid usage span whose absence can be checked by ID in ClickHouse.
    const usageCollectorConfigured = await desktop.evaluate(({app})=>{
      const requireApp = process.getBuiltinModule('module').createRequire(app.getAppPath()+'/package.json');
      const folder = requireApp('node:path').join(app.getAppPath(),'electron');
      const config = requireApp('./electron/usage.cjs').collectorConfig(app.isPackaged ? {} : process.env,folder);
      return Boolean(config) && (!app.isPackaged || config.url === 'https://otel-collector-5phqzw3wxq-nw.a.run.app/v1/traces');
    });
    if (live) {
      assert.equal(await desktop.evaluate(({app})=>app.isPackaged),true,'Live checks require the packaged viewer.');
      assert.equal(usageCollectorConfigured,true,'The release package must include the usage collector.');
    }
    const usageControlAccepted = await page.evaluate(id=>window.veacom.usageRecord([{name:'ux.action',
      trace:id,span:id.slice(0,16),start:Date.now(),duration:1,attributes:{'veacom.action':'annotation-delete'}}]),usageControlId);
    assert.equal(usageControlAccepted,0,'a valid usage event must be rejected with sharing off');
    monitor = fs.watch(path.dirname(queue),sample);
    const mainId = JSON.parse(fs.readFileSync(queue,'utf8')).running.id;
    await page.evaluate(text=>{document.title=text;},sentinel);
    const find = (role, recovery, reason) => waitFor(()=>{
      sample(); return [...events.values()].find(r=>r.process===role && r.recovery===recovery && (!reason || r.reason===reason));
    },role + ' report');
    await page.evaluate(text=>{
      window.veacom.reportRendererFailure('render-failed',text);
      window.veacom.reportRendererFailure('render-failed','type');
      window.veacom.reportRendererFailure('render-failed','type');
    }, sentinel);
    const failedRender = await find('renderer','unknown','render-failed');
    assert.equal(failedRender.exception,'type');
    await page.evaluate(text=>{
      setTimeout(()=>{ throw new TypeError(text); },0);
      void Promise.reject(new RangeError(text));
    }, sentinel);
    assert.equal((await find('renderer','unknown','uncaught-exception')).exception,'type');
    assert.equal((await find('renderer','unknown','unhandled-rejection')).exception,'range');
    // On Windows the Playwright launcher can have a different PID from Electron main.
    const mainPid = await desktop.evaluate(()=>process.pid);
    process.kill(enginePid(mainPid),process.platform === 'win32' ? 'SIGKILL' : 'SIGABRT');
    await page.waitForFunction(async()=>{
      const state = await window.veacom.getCoreState(); return state.status==='ready' && state.generation===2;
    });
    const engine = await find('engine','restarted');
    if (process.platform === 'win32') assert.ok(engine.code !== null || engine.signal);
    else { assert.equal(engine.reason,'signal'); assert.equal(engine.signal,'SIGABRT'); }

    const gpu = await desktop.evaluate(({app})=>new Promise((resolve,reject)=>{
      const target = app.getAppMetrics().find(p=>p.type==='GPU');
      if (!target) { resolve(null); return; }
      const timeout = setTimeout(()=>{ app.removeListener('child-process-gone',gone); reject(new Error('GPU exit timed out')); },10000);
      function gone(_event,d) {
        if (d.type !== 'GPU') return;
        app.removeListener('child-process-gone',gone); clearTimeout(timeout); resolve({reason:d.reason, code:d.exitCode});
      }
      app.on('child-process-gone',gone); process.kill(target.pid,'SIGKILL');
    }));
    if (gpu) { const report = await find('gpu','unknown'); assert.deepEqual([report.reason,report.code],[gpu.reason,gpu.code]); }
    const renderer = await desktop.evaluate(({BrowserWindow})=>new Promise(resolve=>{
      const contents=BrowserWindow.getAllWindows()[0].webContents;
      contents.once('render-process-gone',(_event,d)=>resolve({reason:d.reason,code:d.exitCode})); contents.forcefullyCrashRenderer();
    }));
    const rendered = await find('renderer','unknown',renderer.reason);
    assert.deepEqual([rendered.reason,rendered.code],[renderer.reason,renderer.code]);

    const exiting = once(desktop.process(),'exit');
    // macOS records this crash a few seconds later and would then hold the app's next start with its "reopen windows?"
    // alert; electron/main.cjs turns that alert off, so the checks that follow this one start.
    void desktop.evaluate(()=>process.crash()).catch(()=>{});
    let watchdog;
    let exit;
    try {
      exit = await Promise.race([exiting, new Promise((_resolve,reject)=>{
        watchdog = setTimeout(()=>{
          desktop.process().kill('SIGKILL'); reject(new Error('Main-process crash timed out'));
        },20000);
      })]);
    } finally { clearTimeout(watchdog); }
    const [code,signal] = exit; desktop = null;
    assert.ok(signal || code !== 0,'the test main process must really crash');
    await launch();
    const unclean = await find('main','unknown');
    assert.equal(unclean.stage,'running');
    assert.equal(unclean.id,mainId); assert.equal(unclean.reason,'unclean-exit'); assert.equal(unclean.signal,null);
    await waitFor(()=>JSON.parse(fs.readFileSync(queue,'utf8')).events.length===0,'delivery acknowledgements',60000);
    assert.equal(await closeDesktop(desktop),true,'the viewer must quit by itself'); desktop = null;
    assert.equal(JSON.parse(fs.readFileSync(queue,'utf8')).running,null,'normal quit must leave no crash marker');
    assert.equal(usageRequests,0,'usage opt-out still applies');
    const reports = [...events.values()];
    assert.ok(reports.every(r=>validReport(r) && r.environment==='lab'));
    assert.equal(reports.filter(r=>r.reason==='render-failed').length,1);
    assert.ok(!JSON.stringify(reports).includes(sentinel));
    if (!live) for (const r of reports) {
      const span = accepted.get(r.id);
      assert.equal(span?.name,'crash.' + r.process);
      assert.ok(span.attributes.some(a=>a.key==='veacom.error_kind' && a.value.stringValue===r.reason));
    }
    fs.mkdirSync(path.dirname(path.resolve(out)),{recursive:true});
    fs.writeFileSync(out,JSON.stringify({live,packaged:Boolean(executablePath),usageConsent:'denied',usageCollectorConfigured,
      usageControlId,usageControlAccepted,localUsageRequests:usageRequests,mainExit:{code,signal},reports},null,2)+'\n');
    console.log('Verified ' + reports.length + ' crash incidents, native recovery, main-process relaunch, and rejection of a valid usage event.');
  } finally {
    monitor?.close();
    await closeDesktop(desktop);
    intake.close(); usage.close();
    await fs.promises.rm(temp,{recursive:true,force:true,maxRetries:4,retryDelay:100});
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
