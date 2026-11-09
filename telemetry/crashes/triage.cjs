// Read-only through telemetry/tunnel.sh. Exit 0: no matching incidents, 1: incidents found, 2: check failed.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { REASONS, SIGNALS, STAGES, ENGINE_WORK, JS_EXCEPTIONS } = require('../../electron/crash-schema.cjs');

function knownValue(column, values) {
  const allowed = values.map(value => `'${value}'`).join(', ');
  return `if(${column} IN (${allowed}), ${column}, 'unknown')`;
}

const statusPattern = `^(?:(?:${[...SIGNALS].join('|')})(?:, exit -?[0-9]{1,10})?|exit -?[0-9]{1,10})$`;
const sql = `
SELECT
  if(match(ResourceAttributes['service.version'], '^[0-9]{1,4}[.][0-9]{1,4}[.][0-9]{1,4}(-(alpha|beta|rc)[.][0-9]{1,4})?$'), ResourceAttributes['service.version'], 'unknown') AS version,
  if(match(ResourceAttributes['veacom.commit'], '^[a-f0-9]{40}$'), ResourceAttributes['veacom.commit'], 'unknown') AS build,
  ${knownValue("ResourceAttributes['os.type']", ['win32', 'darwin', 'linux', 'other'])} AS os,
  ${knownValue('substring(SpanName, 7)', ['main', 'renderer', 'gpu', 'utility', 'helper', 'engine'])} AS process,
  ${knownValue("SpanAttributes['veacom.error_kind']", REASONS)} AS reason,
  ${knownValue("SpanAttributes['veacom.crash.stage']", STAGES)} AS stage,
  ${knownValue("SpanAttributes['veacom.crash.work']", ENGINE_WORK)} AS work,
  ${knownValue("SpanAttributes['veacom.crash.exception']", JS_EXCEPTIONS)} AS exception,
  ${knownValue("SpanAttributes['veacom.result']", ['restarted', 'failed', 'unknown'])} AS recovery,
  if(match(StatusMessage, '${statusPattern}'), StatusMessage, '') AS os_status,
  uniqExact(TraceId) AS incidents,
  toString(min(Timestamp), 'UTC') AS first_utc,
  toString(max(Timestamp), 'UTC') AS last_utc
FROM otel.otel_traces
WHERE ServiceName = 'veacom-crash' AND ScopeName = 'veacom.crash'
  AND startsWith(SpanName, 'crash.') AND ResourceAttributes['deployment.environment'] = {env:String}
  AND Timestamp >= now64(9) - toIntervalHour({hours:UInt16}) AND Timestamp <= now64(9)
GROUP BY ALL
ORDER BY incidents DESC, last_utc DESC
FORMAT JSON`;

async function main() {
  const { values } = parseArgs({ options: {
    hours: { type: 'string', default: '24' }, lab: { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('Usage: node telemetry/crashes/triage.cjs [--hours 1..744] [--lab]');
    return 0;
  }
  if (!/^\d{1,3}$/.test(values.hours) || Number(values.hours) < 1 || Number(values.hours) > 744) {
    throw new Error('Invalid time window');
  }

  const environment = values.lab ? 'lab' : 'field';
  const url = new URL('http://127.0.0.1:18123/');
  url.searchParams.set('param_env', environment);
  url.searchParams.set('param_hours', values.hours);
  url.searchParams.set('wait_end_of_query', '1');
  const password = fs.readFileSync(path.join(os.homedir(), '.config/veacom/clickhouse-agent'), 'utf8').trim();
  const response = await fetch(url, {
    method: 'POST', body: sql, redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { Authorization: 'Basic ' + Buffer.from('agent:' + password).toString('base64') },
  });
  if (!response.ok) throw new Error('Query failed');
  const { data, rows, exception } = await response.json();
  if (exception || !Array.isArray(data) || rows !== data.length) throw new Error('Incomplete query result');
  if (!data.length) {
    console.log(`No ${environment} incidents in the last ${values.hours} hours.`);
    return 0;
  }
  for (const row of data) console.log(JSON.stringify(row));
  return 1;
}

main().then(code => { process.exitCode = code; }).catch(() => {
  console.error('Crash check failed. Check the arguments, read-only credential and ClickHouse tunnel.');
  process.exitCode = 2;
});
