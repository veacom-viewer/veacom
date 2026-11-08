import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, it } from 'node:test';
const require = createRequire(import.meta.url);
const { CrashReports, ENDPOINT, crashEndpoint, registerCrashReports } = require('../electron/crash-reports.cjs');
const { buildInfo, validReport } = require('../electron/crash-schema.cjs');
const { Usage } = require('../electron/usage.cjs');
const dirs: string[] = [];
const reporters: InstanceType<typeof CrashReports>[] = [];
function directory() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crash-test-')); dirs.push(dir); return dir; }
function reporter(dir: string, fetchImpl: typeof fetch, version = '1.2.3') {
  const r = new CrashReports({ userData: dir, info: buildInfo(version, 'darwin', 'arm64', 'lab'), endpoint: ENDPOINT, fetchImpl });
  reporters.push(r); r.start(); return r;
}
afterEach(() => {
  for (const r of reporters.splice(0)) r.finish();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
it('pins the packaged endpoint and permits loopback for source tests', () => {
  const local = 'http://127.0.0.1:8200/v1/crashes';
  assert.equal(crashEndpoint(true, { VEACOM_CRASH_ENDPOINT: local }), ENDPOINT);
  assert.equal(crashEndpoint(false, { VEACOM_CRASH_ENDPOINT: local }), local);
  for (const url of ['https://other.test/v1/crashes', local + '?patient=name', 'http://localhost@evil.test/v1/crashes']) {
    assert.equal(crashEndpoint(false, { VEACOM_CRASH_ENDPOINT: url }), null);
  }
});
it('keeps a failed send across restart and usage opt-out, with the original incident ID and build', async () => {
  const dir = directory(), bodies: Record<string, unknown>[] = [];
  const first = reporter(dir, async (_url, options) => { bodies.push(JSON.parse(String(options?.body))); return new Response(null, { status: 503 }); });
  first.record('engine', 'signal', { signal: 'SIGABRT', recovery: 'pending', path: 'SYNTHETIC-PRIVATE' });
  await first.send(); assert.equal(bodies.length, 0);
  first.settleEngine('restarted'); await first.send();
  const usage = new Usage({ userData: dir, packaged: false, version: '1.2.3', env: {} });
  usage.setConsent('denied'); assert.equal(usage.status().consent, 'denied');
  first.finish();
  const next = reporter(dir, async (_url, options) => { bodies.push(JSON.parse(String(options?.body))); return new Response(null, { status: 204 }); }, '2.0.0');
  await next.send();
  assert.equal(bodies.length, 2); assert.deepEqual(bodies[0], bodies[1]);
  assert.equal(bodies[0].version, '1.2.3'); assert.equal(bodies[0].recovery, 'restarted'); assert.equal(bodies[0].signal, 'SIGABRT');
  assert.equal(JSON.stringify(bodies).includes('SYNTHETIC-PRIVATE'), false);
  assert.deepEqual(next.events, []);
});
it('reports an interrupted main session once under its original build and never invents a signal', async () => {
  const dir = directory(), first = reporter(dir, async () => new Response(null, {status: 204}));
  const id = first.running.id;
  // Model a process death: no quit handler ran, and no sender is still active.
  const seen: any[] = [];
  const next = reporter(dir, async (_url, options) => { seen.push(JSON.parse(String(options?.body))); return new Response(null, {status: 204}); }, '2.0.0');
  await next.send(); next.finish();
  const third = reporter(dir, async () => { throw new Error('unexpected report'); });
  assert.deepEqual(third.events, []); assert.equal(seen.length, 1);
  assert.deepEqual([seen[0].id, seen[0].reason, seen[0].version, seen[0].code, seen[0].signal], [id, 'unclean-exit', '1.2.3', null, null]);
});
it('checks the disk queue again before sending and bounds it during a prolonged outage', async () => {
  const dir = directory(), first = reporter(dir, async () => new Response(null,{status:503}));
  for (let i = 0; i < 70; i++) first.record('renderer','crashed',{code:i});
  assert.equal(first.events.length,64);
  const forged = {...first.events[0], stack:'SYNTHETIC-PRIVATE'};
  first.finish(); fs.writeFileSync(first.file, JSON.stringify({ events:[forged,{...forged,reason:'SYNTHETIC-PRIVATE'}], running:forged }));
  const next = reporter(dir, async () => { throw new Error('invalid data reached the sender'); });
  assert.deepEqual(next.events,[]);
  assert.equal(validReport(forged),false);
});
it('preserves a fatal JS reason without adding an unclean-exit report for the same failure', async () => {
  const dir = directory(), first = reporter(dir, async () => new Response(null,{status:503}));
  first.mainException('uncaught-exception');
  assert.equal(JSON.parse(fs.readFileSync(first.file,'utf8')).running,null);
  const seen: string[] = [];
  const next = reporter(dir, async (_url,options) => { seen.push(JSON.parse(String(options?.body)).reason); return new Response(null,{status:204}); });
  await next.send(); assert.deepEqual(seen,['uncaught-exception']);
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(first.running.reason,'unclean-exit');
});
it('records only Electron process and reason enums; ignores normal exits and free text', async () => {
  const app = Object.assign(new EventEmitter(), { isPackaged:false, getPath:()=>directory(), getVersion:()=>'1.2.3' });
  const r = registerCrashReports(app,{VEACOM_CRASH_ENDPOINT:'http://127.0.0.1:7711/v1/crashes'});
  const seen: any[] = [];
  r.fetchImpl = async (_url: string, options: RequestInit) => { seen.push(JSON.parse(String(options.body))); return new Response(null,{status:204}); };
  app.emit('render-process-gone',{}, {},{reason:'oom',exitCode:9,name:'SYNTHETIC-PRIVATE'});
  app.emit('child-process-gone',{}, {type:'GPU',reason:'crashed',exitCode:-1,serviceName:'SYNTHETIC-PRIVATE'});
  app.emit('child-process-gone',{}, {type:'SYNTHETIC-PRIVATE',reason:'SYNTHETIC-PRIVATE',exitCode:'SYNTHETIC-PRIVATE'});
  app.emit('child-process-gone',{}, {type:'Utility',reason:'clean-exit',exitCode:0});
  await r.send(); app.emit('quit');
  assert.deepEqual(seen.map(x=>[x.process,x.reason,x.code]),[['renderer','oom',9],['gpu','crashed',-1],['helper','unknown',null]]);
  assert.ok(!JSON.stringify(seen).includes('SYNTHETIC-PRIVATE'));
});
