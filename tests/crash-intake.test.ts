import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { afterEach, it } from 'node:test';
const require = createRequire(import.meta.url);
const { createServer } = require('../telemetry/crashes/server.cjs');
const record = { id: 'a'.repeat(32), at: Date.now(), version:'1.2.3-beta.1', platform:'win32', arch:'x64', environment:'lab',
  process:'engine', reason:'signal', code:null, signal:'SIGABRT', recovery:'restarted' };
const servers: ReturnType<typeof createServer>[] = [];
async function setup(upstream: typeof fetch) {
  const server = createServer({ token:'local-test-token', fetchImpl:upstream });
  servers.push(server); server.listen(0,'127.0.0.1'); await once(server,'listening');
  const url = 'http://127.0.0.1:' + server.address().port + '/v1/crashes';
  return (body: unknown) => fetch(url, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
}
afterEach(async()=>{ for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(done=>server.close(done)); } });
it('sends one fixed-shape crash trace to the existing collector, acknowledging only acceptance',async()=>{
  let payload: any;
  const send = await setup(async (_url, options)=>{ payload=JSON.parse(String(options?.body)); return Response.json({}); });
  const build = 'abcd'.repeat(10);
  assert.equal((await send({...record,build})).status,204);
  const resource=payload.resourceSpans[0], scope=resource.scopeSpans[0], span=scope.spans[0];
  assert.deepEqual(resource.resource.attributes.map((a:any)=>a.key).sort(),['deployment.environment','host.arch','os.type','service.name','service.version','veacom.commit']);
  assert.equal(resource.resource.attributes.find((a:any)=>a.key==='veacom.commit').value.stringValue,build);
  assert.equal(scope.scope.name,'veacom.crash'); assert.equal(span.name,'crash.engine'); assert.equal(span.traceId,record.id);
  assert.equal(span.status.message,'SIGABRT');
  assert.deepEqual(span.attributes.map((a:any)=>[a.key,a.value.stringValue]),[['veacom.error_kind','signal'],['veacom.result','restarted']]);
});
it('rejects extra fields, arbitrary strings, unsafe numbers and large bodies before export',async()=>{
  let forwarded = 0; const send = await setup(async ()=>{ forwarded++; return Response.json({}); });
  for (const patch of [{stderr:'SYNTHETIC-PRIVATE'},{stack:{path:'SYNTHETIC-PRIVATE'}},{reason:'SYNTHETIC-PRIVATE'},{code:4294967296},{build:'SYNTHETIC-PRIVATE'},
    {signal:'SIGABRT\\nSYNTHETIC-PRIVATE'},{recovery:'pending'},{environment:'SYNTHETIC-PRIVATE'},
    {version:'1.0.0-SYNTHETIC-PRIVATE'},{process:'SYNTHETIC-PRIVATE'},{id:'0'.repeat(32)}]) {
    assert.equal((await send({...record,...patch})).status,400);
  }
  assert.equal((await send({...record,log:'x'.repeat(2048)})).status,413);
  assert.equal(forwarded,0);
});
it('leaves a report retryable on upstream error or partial rejection',async()=>{
  const responses=[new Response(null,{status:503}),Response.json({partialSuccess:{rejectedSpans:'1'}}),Response.json({})];
  const send=await setup(async()=>responses.shift()!);
  assert.equal((await send(record)).status,503); assert.equal((await send(record)).status,503); assert.equal((await send(record)).status,204);
});
