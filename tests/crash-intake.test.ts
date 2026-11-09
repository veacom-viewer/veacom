import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { afterEach, it } from 'node:test';
const require = createRequire(import.meta.url);
const { createServer } = require('../telemetry/crashes/server.cjs');
const record = { id: 'a'.repeat(32), at: Date.now(), version:'1.2.3-beta.1', platform:'win32', arch:'x64', environment:'lab',
  process:'engine', reason:'signal', code:null, signal:'SIGABRT', recovery:'restarted' };
const servers: ReturnType<typeof createServer>[] = [];
async function setup(upstream: typeof fetch, getToken = async (audience: string) => {
  assert.equal(audience, 'https://crash-storage.example');
  return 'local-test-token';
}, log?: (entry: string) => void) {
  const server = createServer({ storageUrl:'https://crash-storage.example', getToken, fetchImpl:upstream, log });
  servers.push(server); server.listen(0,'127.0.0.1'); await once(server,'listening');
  const url = 'http://127.0.0.1:' + server.address().port + '/v1/crashes';
  return (body: unknown) => fetch(url, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
}
afterEach(async()=>{ for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(done=>server.close(done)); } });
it('accepts earlier report formats and constructs a fixed-shape trace for private storage',async()=>{
  let payload: any;
  const send = await setup(async (url, options)=>{
    assert.equal(String(url), 'https://crash-storage.example/v1/traces');
    assert.equal(new Headers(options?.headers).get('Authorization'), 'Bearer local-test-token');
    assert.equal(options?.redirect,'error');
    payload=JSON.parse(String(options?.body)); return Response.json({});
  });
  const build = 'abcd'.repeat(10);
  assert.equal((await send({...record,build})).status,204);
  const resource=payload.resourceSpans[0], scope=resource.scopeSpans[0], span=scope.spans[0];
  assert.deepEqual(resource.resource.attributes.map((a:any)=>a.key).sort(),['deployment.environment','host.arch','os.type','service.name','service.version','veacom.commit']);
  assert.equal(resource.resource.attributes.find((a:any)=>a.key==='veacom.commit').value.stringValue,build);
  assert.equal(scope.scope.name,'veacom.crash'); assert.equal(span.name,'crash.engine'); assert.equal(span.traceId,record.id);
  assert.equal(span.status.message,'SIGABRT');
  assert.deepEqual(span.attributes.map((a:any)=>[a.key,a.value.stringValue]),[['veacom.error_kind','signal'],['veacom.result','restarted']]);
});
it('exports bounded diagnostic fields only when the report contains them',async()=>{
  const spans: any[]=[];
  const send=await setup(async (_url, options)=>{
    spans.push(JSON.parse(String(options?.body)).resourceSpans[0].scopeSpans[0].spans[0]);
    return Response.json({});
  });
  assert.equal((await send({...record,stage:'running',work:'pixels'})).status,204);
  assert.equal((await send({...record,process:'renderer',reason:'render-failed',code:null,signal:null,recovery:'unknown',
    stage:'running',exception:'type'})).status,204);
  const attrs = spans.map(span=>Object.fromEntries(span.attributes.map((a:any)=>[a.key,a.value.stringValue])));
  assert.deepEqual(attrs[0],{'veacom.error_kind':'signal','veacom.result':'restarted','veacom.crash.stage':'running','veacom.crash.work':'pixels'});
  assert.deepEqual(attrs[1],{'veacom.error_kind':'render-failed','veacom.result':'unknown','veacom.crash.stage':'running','veacom.crash.exception':'type'});
});
it('rejects extra fields, arbitrary strings, unsafe numbers and large bodies before export',async()=>{
  let forwarded = 0; const send = await setup(async ()=>{ forwarded++; return Response.json({}); },async ()=>{forwarded++; return 'test';});
  for (const patch of [{stage:'SYNTHETIC-PRIVATE'}, {work:'SYNTHETIC-PRIVATE'}, {exception:'SYNTHETIC-PRIVATE'}, {stderr:'SYNTHETIC-PRIVATE'},{stack:{path:'SYNTHETIC-PRIVATE'}},{reason:'SYNTHETIC-PRIVATE'},{code:4294967296},{build:'SYNTHETIC-PRIVATE'},
    {signal:'SIGABRT\\nSYNTHETIC-PRIVATE'},{recovery:'pending'},{environment:'SYNTHETIC-PRIVATE'},
    {version:'1.0.0-SYNTHETIC-PRIVATE'},{process:'SYNTHETIC-PRIVATE'},{id:'0'.repeat(32)}]) {
    assert.equal((await send({...record,...patch})).status,400);
  }
  assert.equal((await send({...record,log:'x'.repeat(2048)})).status,413);
  assert.equal(forwarded,0);
});
it('leaves a report retryable on upstream error or partial rejection',async()=>{
  const responses=[new Response(null,{status:503}),new Response(null,{status:202}),Response.json([]),
    Response.json({partialSuccess:{rejectedSpans:'1'}}),Response.json({})];
  const send=await setup(async()=>responses.shift()!);
  for (let i=0;i<4;i++) assert.equal((await send(record)).status,503);
  assert.equal((await send(record)).status,204);
});
it('leaves an incident retryable if the intake cannot authenticate to private storage',async()=>{
  let forwarded = false;
  const send = await setup(async ()=>{forwarded=true;return Response.json({});},async ()=>{throw new Error('identity unavailable');});
  assert.equal((await send(record)).status,503);
  assert.equal(forwarded,false);
});

it('emits a fixed alert marker only after storage accepts a field incident', async () => {
  const entries: string[] = [];
  let stored = false;
  const send = await setup(async () => stored ? Response.json({}) : new Response(null, {status:503}),
    undefined, entry => entries.push(entry));
  const field = { ...record, environment:'field' };
  assert.equal((await send(field)).status, 503);
  stored = true;
  assert.equal((await send({ ...field, message:'SYNTHETIC-PRIVATE' })).status, 400);
  assert.equal((await send(record)).status, 204);
  assert.equal((await send({ ...record, environment:'dev' })).status, 204);
  assert.deepEqual(entries, []);
  assert.equal((await send(field)).status, 204);
  assert.deepEqual(entries, ['{"event":"veacom.field_fault_stored"}']);
});
