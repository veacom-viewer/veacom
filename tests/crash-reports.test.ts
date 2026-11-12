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
it('keeps a rejected incident while delivering compatible reports to an older intake', async () => {
  const dir = directory();
  const acknowledgements: string[] = [];
  const first = reporter(dir, async (_url, options) => {
    const r = JSON.parse(String(options?.body));
    if (r.reason === 'render-failed') return new Response(null, { status: 400 });
    acknowledgements.push(r.reason);
    return new Response(null, { status: 204 });
  });
  first.record('renderer', 'render-failed', { exception: 'type' });
  first.record('gpu', 'killed', { code: 1 });
  await first.send();
  assert.deepEqual(acknowledgements, ['killed']);
  const [pending] = first.events;
  assert.equal(first.events.length, 1);
  assert.equal(pending.reason, 'render-failed');
  first.finish();
  const next = reporter(dir, async (_url, options) => {
    assert.equal(JSON.parse(String(options?.body)).id, pending.id);
    return new Response(null, { status: 204 });
  });
  await next.send();
  assert.equal(next.events.length, 0);
});
it('reports an interrupted main session once under its original build and never invents a signal', async () => {
  const dir = directory(), first = reporter(dir, async () => new Response(null, {status: 204}));
  const id = first.running.id;
  first.setStage('window-create');
  first.setStage('SYNTHETIC-PRIVATE');
  // Model a process death: no quit handler ran, and no sender is still active.
  const seen: any[] = [];
  const next = reporter(dir, async (_url, options) => { seen.push(JSON.parse(String(options?.body))); return new Response(null, {status: 204}); }, '2.0.0');
  await next.send(); next.finish();
  const third = reporter(dir, async () => { throw new Error('unexpected report'); });
  assert.deepEqual(third.events, []); assert.equal(seen.length, 1);
  assert.deepEqual([seen[0].id, seen[0].reason, seen[0].stage, seen[0].version, seen[0].code, seen[0].signal],
    [id, 'unclean-exit', 'window-create', '1.2.3', null, null]);
});
it('keeps an explicit startup failure across relaunch without also reporting an unclean exit', async () => {
  const dir = directory();
  const first = reporter(dir, async () => new Response(null, { status: 503 }));
  first.setStage('window-create');
  first.startupFailed(new TypeError('SYNTHETIC_PRIVATE_PATH'));
  first.startupFailed(new TypeError('SYNTHETIC_PRIVATE_PATH'));
  await first.flush();
  const seen: any[] = [];
  const next = reporter(dir, async (_url, options) => { seen.push(JSON.parse(String(options?.body))); return new Response(null, { status: 204 }); });
  await next.send();
  assert.deepEqual(seen.map(event => [event.process, event.reason, event.stage, event.exception]), [['main', 'startup-failed', 'window-create', 'type']]);
});
it('reports an engine startup failure once with its more specific cause', async () => {
  const seen: any[] = [];
  const first = reporter(directory(), async (_url, options) => { seen.push(JSON.parse(String(options?.body))); return new Response(null, { status: 204 }); });
  first.setStage('engine-start');
  first.record('engine', 'launch-failed', { recovery: 'pending' });
  first.settleEngine('failed');
  first.startupFailed();
  await first.flush();
  assert.deepEqual(seen.map(event => [event.process, event.reason, event.stage, event.recovery]),
    [['engine', 'launch-failed', 'engine-start', 'failed']]);
  assert.equal(JSON.parse(fs.readFileSync(first.file, 'utf8')).running, null);
});
it('keeps the marker through a shutdown request and clears it when Windows confirms session end', () => {
  const dir = directory();
  const app = Object.assign(new EventEmitter(), { isPackaged: false, getPath: () => dir, getVersion: () => '1.2.3' });
  const r = registerCrashReports(app, { VEACOM_CRASH_ENDPOINT: 'http://127.0.0.1:7711/v1/crashes' });
  try {
    const window = new EventEmitter();
    app.emit('browser-window-created', {}, window);
    r.setStage('running');
    window.emit('query-session-end', {});
    const state = () => JSON.parse(fs.readFileSync(r.file, 'utf8'));
    assert.equal(state().running.stage, 'running');
    r.record('engine', 'signal', { signal: 'SIGABRT', recovery: 'pending' });
    window.emit('session-end', {});
    assert.equal(state().running, null);
    assert.deepEqual(state().events.map((e: { reason: string; recovery: string }) => [e.reason, e.recovery]), [['signal', 'unknown']]);
  } finally { app.emit('quit'); }
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
it('sends only the exception class and lifecycle stage for main JavaScript faults', async () => {
  const initial = process.listeners('uncaughtExceptionMonitor');
  const app = Object.assign(new EventEmitter(), { isPackaged: false, getPath: () => directory(), getVersion: () => '1.2.3' });
  const r = registerCrashReports(app, { VEACOM_CRASH_ENDPOINT: 'http://127.0.0.1:7711/v1/crashes' });
  const seen: Record<string, unknown>[] = [];
  r.fetchImpl = async (_url: string, options: RequestInit) => { seen.push(JSON.parse(String(options.body))); return new Response(null, { status: 204 }); };
  try {
    const monitor = process.listeners('uncaughtExceptionMonitor').find(listener => !initial.includes(listener))!;
    r.setStage('running');
    const error = new TypeError('SYNTHETIC-PRIVATE');
    Object.defineProperty(error, 'stack', { get() { throw new Error('stack must not be read'); } });
    Object.defineProperty(error, 'name', { get() { throw new Error('name must not be read'); } });
    monitor(error, 'unhandledRejection');
    await r.flush();
    assert.deepEqual(seen.map(e => [e.reason, e.exception, e.stage]), [['unhandled-rejection', 'type', 'running']]);
    assert.ok(!JSON.stringify(seen).includes('SYNTHETIC-PRIVATE'));
  } finally { app.emit('quit'); }
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
