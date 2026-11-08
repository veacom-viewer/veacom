// Read-only check of the receipt from tools/check-crash-reporting.cjs --live. Start telemetry/tunnel.sh first.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setTimeout: delay } = require('node:timers/promises');
const { validReport } = require('../../electron/crash-schema.cjs');
async function main() {
  const receipt = JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
  assert.equal(receipt.live,true); assert.equal(receipt.usageConsent,'denied'); assert.equal(receipt.localUsageRequests,0);
  assert.equal(receipt.usageControlAccepted,0); assert.match(receipt.usageControlId,/^[0-9a-f]{32}$/);
  assert.ok(receipt.reports.length >= 3 && receipt.reports.every(r=>validReport(r) && r.environment==='lab'));
  const secret = fs.readFileSync(path.join(os.homedir(),'.config/veacom/clickhouse-agent'),'utf8').trim();
  async function query(sql) {
    const res = await fetch('http://127.0.0.1:18123/',{method:'POST',headers:{Authorization:'Basic '+Buffer.from('agent:'+secret).toString('base64')},
      body:sql+' FORMAT JSONEachRow',signal:AbortSignal.timeout(10000)});
    if (!res.ok) throw new Error('Read-only ClickHouse query returned ' + res.status);
    const text = (await res.text()).trim();
    return text ? text.split('\n').map(line=>JSON.parse(line)) : [];
  }
  const ids = receipt.reports.map(r => "'" + r.id + "'").join(',');
  const sql = [
    'SELECT TraceId, SpanName, StatusCode, StatusMessage, ScopeName, ResourceAttributes, SpanAttributes,',
    'length(`Events.Name`) AS events, length(`Links.TraceId`) AS links FROM otel.otel_traces',
    "WHERE ServiceName='veacom-crash' AND TraceId IN (" + ids + ')',
  ].join(' ');
  const end = Date.now()+90000;
  let seen = new Set();
  do {
    const rows = await query(sql);
    seen = new Set();
    for (const row of rows) {
      const r = receipt.reports.find(r=>r.id===row.TraceId);
      assert.equal(row.SpanName,'crash.'+r.process); assert.equal(row.ScopeName,'veacom.crash');
      assert.equal(row.StatusCode,'Error');
      assert.equal(row.StatusMessage,[r.signal,r.code===null?null:'exit '+r.code].filter(Boolean).join(', '));
      assert.deepEqual(row.SpanAttributes,{'veacom.error_kind':r.reason,'veacom.result':r.recovery});
      assert.deepEqual(row.ResourceAttributes,{'service.name':'veacom-crash','service.version':r.version,
        'deployment.environment':'lab','os.type':r.platform,'host.arch':r.arch,
        ...(r.build && r.build !== 'unknown' ? {'veacom.commit':r.build} : {})});
      assert.equal(Number(row.events),0); assert.equal(Number(row.links),0); seen.add(r.id);
    }
    if (seen.size===receipt.reports.length) {
      const [usage] = await query("SELECT count() AS n FROM otel.otel_traces WHERE ServiceName='veacom' AND TraceId='" + receipt.usageControlId + "'");
      assert.equal(Number(usage.n),0,'the usage opt-out control must be absent from ClickHouse');
      for (const r of receipt.reports) console.log([r.id,r.process,r.reason,r.signal??r.code??'',r.recovery].join('\t'));
      console.log('Opted-out usage control ' + receipt.usageControlId + ': zero rows');
      return;
    }
    await delay(2000);
  } while (Date.now()<end);
  throw new Error('Missing crash IDs in ClickHouse: '+receipt.reports.filter(r=>!seen.has(r.id)).map(r=>r.id).join(', '));
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
